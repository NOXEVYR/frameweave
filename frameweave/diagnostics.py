"""Bounded read-only model checks. A header check is never a checksum claim."""

import json
import math
import re
import struct
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from .workflows import (_check_family, _check_json_limits, _expanded_inputs, _lora_specs, _model,
                        _number, _options, _reference_names, _reference_roles,
                        _spec, compile_workflow, validate_prompt)


def safe_relative(name):
    if not isinstance(name, str) or not name or len(name) > 1024:
        raise ValueError("文件名无效")
    name = name.replace("\\", "/")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("..", ".") for part in name.split("/")) or ":" in name or "\x00" in name:
        raise ValueError("不可使用绝对路径或越界路径")
    return str(path)


def inspect_safetensors(path):
    path = Path(path)
    size = path.stat().st_size
    if size < 10:
        return "error", "文件为空或截断", size
    with path.open("rb") as stream:
        header_length = struct.unpack("<Q", stream.read(8))[0]
        if not 2 <= header_length <= min(16 * 1024 * 1024, size - 8):
            return "error", "safetensors 头长度无效，可能下载不完整", size
        try:
            header = json.loads(stream.read(header_length))
        except (ValueError, UnicodeError):
            return "error", "safetensors 头不是有效 JSON", size
    if not isinstance(header, dict):
        return "error", "safetensors 头类型无效", size
    ranges = []
    tensor_count = 0
    unknown_types = set()
    widths = {"BOOL": 1, "U8": 1, "I8": 1, "F8_E4M3": 1, "F8_E5M2": 1, "F8_E8M0": 1,
              "I16": 2, "U16": 2, "F16": 2, "BF16": 2, "I32": 4, "U32": 4, "F32": 4,
              "I64": 8, "U64": 8, "F64": 8, "F8_E4M3FN": 1, "F8_E5M2FNUZ": 1}
    for key, tensor in header.items():
        if key == "__metadata__":
            continue
        if not isinstance(tensor, dict):
            return "error", "张量描述无效", size
        offsets, shape = tensor.get("data_offsets"), tensor.get("shape")
        if (not isinstance(offsets, list) or len(offsets) != 2
                or any(type(v) is not int for v in offsets)
                or not 0 <= offsets[0] <= offsets[1] <= size - header_length - 8
                or not isinstance(shape, list) or any(type(v) is not int or v < 0 for v in shape)):
            return "error", "张量数据越界，文件可能截断", size
        dtype = tensor.get("dtype")
        if not isinstance(dtype, str) or not dtype:
            return "error", "张量 dtype 类型无效", size
        width = widths.get(dtype)
        if width is None:
            unknown_types.add(dtype)
        if width and math.prod(shape) * width != offsets[1] - offsets[0]:
            return "error", "张量形状与数据长度不一致", size
        ranges.append(tuple(offsets))
        tensor_count += 1
    if not tensor_count:
        return "error", "文件没有张量数据", size
    cursor = 0
    for start, end in sorted(ranges):
        if start != cursor:
            return "error", "张量数据重叠或存在空洞", size
        cursor = end
    if cursor != size - header_length - 8:
        return "error", "文件长度与张量目录不一致", size
    if unknown_types:
        return "warning", "数据边界检查通过，但存在未支持的 dtype；不能确认完整张量结构，未做 SHA-256 校验", size
    return "ok", f"结构与长度检查通过，{tensor_count} 个张量；未进行全文件 SHA-256 校验", size


def resolve_model(roots, name, role):
    name = safe_relative(name)
    role_dirs = {"checkpoint": ["checkpoints"], "dit": ["diffusion_models", "unet"],
                 "text_encoder": ["text_encoders", "clip"], "vae": ["vae"],
                 "audio_vae": ["vae"], "lora": ["loras"]}.get(role, [])
    for base in roots:
        root = Path(base).expanduser().resolve()
        for rel in [name] + [f"{folder}/{name}" for folder in role_dirs]:
            candidate = (root / rel).resolve()
            # Deliberate user-selected model roots may contain compatibility junctions.
            # Only an enumerated backend filename is checked; no directory walking.
            if candidate.is_file():
                return candidate
    return None


COMFY_DOCS = "https://docs.comfy.org/installation/system_requirements"
H3_DOCS = "https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native"
KREA_DOCS = "https://docs.comfy.org/tutorials/image/krea/krea-2"
QWEN21_DOCS = "https://huggingface.co/Comfy-Org/Qwen-Image-2.1"
STATES = ("ok", "missing", "error", "warning", "unknown")
ROLES = ("checkpoint", "dit", "text_encoder", "vae", "audio_vae", "lora")
MODEL_FIELDS = {"ckpt_name": "checkpoint", "unet_name": "dit", "clip_name": "text_encoder",
                "vae_name": "vae", "lora_name": "lora", "model_name": "model"}
MODEL_SUFFIXES = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf")
SAFE_SCHEMA_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,79}$")
SAFE_SCHEMA_VALUE = re.compile(r"^[A-Za-z0-9_+-]{1,48}$")
SAFE_ENUM_FIELDS = {"type", "sampler_name", "scheduler", "sampler", "scheduler_name", "mode",
                    "preset", "method", "upscale_method", "resize_mode", "control_after_generate"}
SAFE_OUTPUT_TYPE = re.compile(r"^[A-Z][A-Z0-9_, ]{0,63}$")


def _request(request):
    if not isinstance(request, dict):
        raise ValueError("检测请求必须是对象")
    _check_json_limits(request)
    kind = request.get("kind", "h3_t2v")
    if not isinstance(kind, str) or kind not in {"h3_t2v", "h3_i2v", "h3_ref", "krea", "sdxl", "sdxl_i2i",
                                                 "qwen21_t2i", "qwen21_edit", "api"}:
        raise ValueError("不支持的检测模式")
    models = request.get("models", {})
    if not isinstance(models, dict) or any(key not in ROLES for key in models):
        raise ValueError("models 必须是支持的模型角色对象")
    if any(value is not None and (not isinstance(value, str) or len(value) > 1024) for value in models.values()):
        raise ValueError("模型名称必须是 0–1024 字符的文本")
    qwen21 = kind in {"qwen21_t2i", "qwen21_edit"}
    if qwen21 and any(key not in {"dit", "text_encoder", "vae", "lora"} for key in models):
        raise ValueError("Qwen Image 2.1 models 只支持 dit、text_encoder、vae 和 model-only LoRA")
    for key in ("positive", "negative", "sampler", "scheduler", "lora"):
        if key in request and (not isinstance(request[key], str) or len(request[key]) > (100000 if key in {"positive", "negative"} else 1024)):
            raise ValueError("提示词、采样选项和 LoRA 名称必须是长度受限的文本")
    refs = _reference_names(request)
    reference_limit = 10 if kind == "qwen21_edit" else 9
    if len(refs) > reference_limit or any(len(ref) > 1024 for ref in refs):
        raise ValueError(f"参考图最多 {reference_limit} 张，每个相对名称不超过 1024 字符")
    roles = _reference_roles(request, kind, refs)
    if qwen21 and any(role != "reference" for role in roles):
        raise ValueError("Qwen Image 2.1 参考图按数组顺序传入，reference_roles 只能使用 reference")
    if qwen21:
        if "custom_size" in request and type(request["custom_size"]) is not bool:
            raise ValueError("custom_size 必须为布尔值")
        if request.get("custom_size") and kind != "qwen21_edit":
            raise ValueError("custom_size 只支持 Qwen Image 2.1 编辑模式")
    _lora_specs(request, kind)
    _number(request, "denoise", 1, 0, 1)
    for key, minimum, maximum, integer in (("width", 32, 8192, True), ("height", 32, 8192, True),
            ("steps", 1, 1000, True), ("seed", 0, 2**64 - 1, True), ("cfg", 0, 100, False),
            ("seconds", 5 / 24, 150, False), ("fps", 1, 120, False),
            ("shift_video", .01, 100, False), ("shift_audio", .01, 100, False), ("lora_strength", -10, 10, False)):
        if key in request:
            _number(request, key, minimum, minimum, maximum, integer)
    if qwen21:
        resolution = _number(request, "ref_resolution", 1024, 0, 4096, True)
        if resolution % 32:
            raise ValueError("ref_resolution 必须为 32 的倍数")
    if kind != "api":
        return kind, models, refs, None
    prompt = request.get("prompt", request.get("workflow", {}))
    if isinstance(prompt, dict) and isinstance(prompt.get("prompt"), dict) and "class_type" not in prompt["prompt"]:
        prompt = prompt["prompt"]
    if not isinstance(prompt, dict) or len(prompt) > 1000:
        raise ValueError("API 图必须是最多 1000 个节点的对象")
    for key, node in prompt.items():
        if not isinstance(key, str) or not key or len(key) > 200 or not isinstance(node, dict):
            raise ValueError("API 节点 ID 或节点对象无效")
        if not isinstance(node.get("inputs"), dict):
            raise ValueError("API 节点必须包含 inputs 对象")
        if not isinstance(node.get("class_type"), str) or not 1 <= len(node["class_type"]) <= 200:
            raise ValueError("API 节点类型必须是 1–200 字符的文本")
    return kind, models, refs, prompt


def _selections(kind, models, request, model_catalog):
    """Use the compiler's model chooser, including its preferred quantization."""
    available = {role: [name for name in model_catalog.get(role, []) if isinstance(name, str)] for role in ROLES}
    h3 = kind.startswith("h3_")
    loras = _lora_specs(request, kind)
    sdxl = kind in {"sdxl", "sdxl_i2i"}
    qwen21 = kind in {"qwen21_t2i", "qwen21_edit"}
    if kind == "api":
        return []
    if sdxl:
        choices = [("checkpoint", ("sdxl", "_xl", "xl_", "xl.", "pony", "illustrious", "illust"), ())]
    elif qwen21:
        choices = [("dit", ("qwen_image_2.1", "qwen_image_2_1"), ()),
                   ("text_encoder", ("qwen3vl_8b",), ()),
                   ("vae", ("qwen_image_2.1_vae", "qwen_image_2_1_vae"), ())]
    else:
        choices = [
        ("dit", ("ref2va",) if kind == "h3_ref" else ("fl2va",) if h3 else ("krea2",), ("pruned",) if h3 and not loras else ()),
        ("text_encoder", ("minimax_h3",) if h3 else ("qwen3vl_4b",), ("nvfp4",) if h3 else ()),
        ("vae", ("minimax_h3_video_vae",) if h3 else ("qwen_image_vae",), ())]
    if h3:
        choices.append(("audio_vae", ("minimax_h3_audio_vae",), ()))
    elif sdxl and models.get("vae"):
        choices.append(("vae", (), ()))
    selected = []
    for role, tokens, preferred in choices:
        try:
            name = _model(models, role, available, tokens, preferred)
        except ValueError:
            name = models.get(role)
        selected.append((role, name, available[role]))
    for item in loras:
        selected.append(("lora", item["name"], available["lora"]))
    return selected


def _dependencies(kind, request, refs, selections, info):
    """Mirror compile_workflow branches; never infer image dependencies for API graphs."""
    if kind == "api":
        return []
    h3 = kind.startswith("h3_")
    sdxl = kind in {"sdxl", "sdxl_i2i"}
    qwen21 = kind in {"qwen21_t2i", "qwen21_edit"}
    needed = {"CheckpointLoaderSimple"} if sdxl else {"UNETLoader", "CLIPLoader", "VAELoader"}
    models = dict((role, name) for role, name, _ in selections)
    if sdxl and models.get("vae"):
        needed.add("VAELoader")
    if models.get("lora"):
        if sdxl:
            needed.add("LoraLoader")
        else:
            quantized = any(token in (models.get("dit") or "").lower() for token in ("int8", "fp8", "nvfp4", "gguf"))
            needed.add("LoraLoaderBypassModelOnly" if quantized and "LoraLoaderBypassModelOnly" in info else "LoraLoaderModelOnly")
    if refs:
        needed.add("LoadImage")
    negative = request.get("negative", "").strip()
    if h3:
        needed |= {"MiniMaxH3ReferenceToVideo" if kind == "h3_ref" else "MiniMaxH3ImageToVideo", "CreateVideo", "SaveVideo"}
        if request.get("sampler") == "dual_clock_euler":
            needed |= {"MiniMaxH3DualClockSamplerT8", "RandomNoise", "BasicGuider", "SamplerCustomAdvanced"}
        else:
            needed |= {"MiniMaxH3SigmaShift", "KSampler", "CLIPTextEncode" if negative else "ConditioningZeroOut"}
        decode = {"LTXVSeparateAVLatent", "VAEDecode", "VAEDecodeAudio"}
        needed |= decode if decode <= info.keys() else {"MiniMaxH3AVDecodeT8"}
    elif qwen21:
        needed |= {"TextEncodeQwenImage21", "KSampler", "VAEDecode", "SaveImage"}
        if kind == "qwen21_edit":
            needed.add("LoadImage")
        if kind == "qwen21_t2i" or request.get("custom_size", False):
            needed.add("EmptyLatentImage")
    else:
        needed |= {"KSampler", "VAEDecode", "SaveImage"}
        needed |= {"Krea2OstrisEditModelPatch", "TextEncodeKrea2OstrisEdit"} if kind == "krea" and refs else {"CLIPTextEncode"}
        needed.add("ConditioningZeroOut" if kind == "krea" and not negative else "CLIPTextEncode")
        if refs and (sdxl or request.get("denoise", 1) < 1):
            needed |= {"ImageScale", "VAEEncode"}
        else:
            needed.add("EmptySD3LatentImage" if kind == "krea" else "EmptyLatentImage")
    return sorted(needed)


def _api_models(prompt, info):
    """Inspect actual loader enum fields, retaining no prompt/media fields."""
    result = []
    for node in prompt.values():
        schema = info.get(node["class_type"], {})
        fields, _ = _expanded_inputs(schema, node["inputs"])
        for field, value in node["inputs"].items():
            if not isinstance(value, str) or field not in fields:
                continue
            kind, meta = _spec(fields[field])
            options = kind if isinstance(kind, list) else meta.get("options", []) if kind == "COMBO" else []
            if not isinstance(options, list):
                continue
            # Generic custom loaders are recognized from declared model-file choices.
            role = MODEL_FIELDS.get(field)
            if role is None and any(isinstance(option, str) and option.lower().endswith(MODEL_SUFFIXES) for option in options):
                role = "model"
            if role and (isinstance(kind, list) or kind == "COMBO"):
                result.append((role, value, options))
    return result


def _safe_version(status):
    system = status.get("system", {}) if isinstance(status, dict) else {}
    value = system.get("comfyui_version") if isinstance(system, dict) else None
    if not isinstance(value, str):
        return None
    value = value.strip()[:80]
    return value if re.fullmatch(r"[A-Za-z0-9.+_-]{1,80}", value) else None


def _schema_evidence(node_names, info, version, api_prompt=None):
    """Bounded snapshot of public live schemas; never includes enum filenames."""
    rows = []
    for index, name in enumerate(node_names[:80]):
        api_index = next((i + 1 for i, node in enumerate(api_prompt.values())
                          if isinstance(node, dict) and node.get("class_type") == name), None) if api_prompt is not None else None
        schema = info.get(name)
        if not isinstance(schema, dict):
            row = {"available": False}
            if api_prompt is None and isinstance(name, str) and SAFE_SCHEMA_NAME.fullmatch(name):
                row["node"] = name
            elif api_index is not None:
                row["node_index"] = api_index
            else:
                row["candidate_schema"] = api_prompt is not None
            rows.append(row)
            continue
        groups = schema.get("input", {})
        rows_input = []
        for group in ("required", "optional"):
            fields = groups.get(group, {}) if isinstance(groups, dict) else {}
            if not isinstance(fields, dict):
                continue
            for field, definition in list(fields.items())[:128]:
                if not isinstance(field, str) or not SAFE_SCHEMA_NAME.fullmatch(field):
                    continue
                try:
                    kind, meta = _spec(definition)
                except ValueError:
                    continue
                kind_text = "COMBO" if isinstance(kind, list) else str(kind)[:64]
                options = kind if isinstance(kind, list) else meta.get("options", []) if kind == "COMBO" else []
                safe_options = ([value for value in options[:24] if isinstance(value, str)
                                 and SAFE_SCHEMA_VALUE.fullmatch(value)]
                                if isinstance(options, list) and field in SAFE_ENUM_FIELDS else [])
                if not re.fullmatch(r"[A-Z][A-Z0-9_, ]{0,63}", kind_text):
                    kind_text = "未知类型"
                rows_input.append({"name": field, "type": kind_text,
                                   "required": group == "required", "options": safe_options})
                if len(rows_input) >= 96:
                    break
        outputs = schema.get("output", [])
        safe_outputs = [item[:64] for item in outputs[:64]
                        if isinstance(item, str) and SAFE_OUTPUT_TYPE.fullmatch(item)] if isinstance(outputs, list) else []
        row = {"available": True, "inputs": rows_input, "outputs": safe_outputs}
        # Do not copy extension node names from arbitrary API graphs into repair text.
        if api_prompt is None and isinstance(name, str) and SAFE_SCHEMA_NAME.fullmatch(name):
            row["node"] = name
        elif api_index is not None:
            row["node_index"] = api_index
        else:
            row["candidate_schema"] = api_prompt is not None
        rows.append(row)
    return {"source": "当前后端 object_info", "backend_version": version,
            "nodes": rows, "truncated": len(node_names) > 80}


def _api_interface_alternatives(prompt, info):
    """Find only whole-graph schema-compatible candidates; semantics stay unknown.

    A candidate is evidence about inputs, enums, types, outputs and graph links.
    It is never applied as a substitute because object_info cannot prove semantics.
    """
    result = []
    if not isinstance(prompt, dict) or not isinstance(info, dict):
        return result
    schemas = list(info.items())[:128]
    for index, (node_id, node) in enumerate(prompt.items()):
        if len(result) >= 8:
            break
        if not isinstance(node, dict) or node.get("class_type") in info:
            continue
        candidates = []
        for candidate, schema in schemas:
            if not isinstance(candidate, str) or not isinstance(schema, dict) or schema.get("api_node") is True:
                continue
            trial = {key: {"class_type": value.get("class_type"),
                           "inputs": dict(value.get("inputs", {}))}
                     for key, value in prompt.items() if isinstance(value, dict)}
            trial[node_id]["class_type"] = candidate
            try:
                validate_prompt(trial, info)
            except (ValueError, TypeError, KeyError):
                continue
            candidates.append(candidate)
            if len(candidates) >= 8:
                break
        if candidates:
            result.append({"node_index": index + 1,
                           "candidates": candidates,
                           "interface_compatible": True,
                           "semantic_compatibility": "unknown",
                           "auto_substitute": False,
                           "detail": "整张 API 图通过该候选节点的实时输入、枚举、输出连线和必填字段校验；节点语义仍未知，不能据此替换或运行。"})
    return result


def _safe_api_problem(error, prompt):
    message = str(error)[:1000]
    node_index = None
    field_names = []
    for index, (node_id, node) in enumerate(prompt.items() if isinstance(prompt, dict) else []):
        if message.startswith(f"节点 {node_id} "):
            node_index = index + 1
            break
        class_type = node.get("class_type") if isinstance(node, dict) else None
        if isinstance(class_type, str) and message.startswith(class_type + " "):
            node_index = index + 1
            break
        if isinstance(class_type, str) and message.startswith(class_type + "."):
            node_index = index + 1
            break
    match = re.search(r"缺少必填输入：([A-Za-z][A-Za-z0-9_., -]{0,300})", message)
    if match:
        field_names = [part.strip() for part in match.group(1).split(",")
                       if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", part.strip())][:8]
    else:
        match = re.search(r"\.([A-Za-z][A-Za-z0-9_]{0,63}) (?:不支持|包含|的选项|必须|连接|上游|输出|超出)", message)
        if match:
            field_names = [match.group(1)]
    location = f"API 图第 {node_index} 个节点" if node_index else "API 图中的一个节点"
    fields = "、".join(field_names)
    if "缺少后端类型" in message or "后端缺少节点" in message:
        problem = "实时后端未提供图中所需的节点类型"
    elif "必填输入" in message:
        problem = "实时节点 schema 要求的必填输入未提供"
    elif "选项不在" in message or "不支持的选项" in message:
        problem = "输入值不在实时节点 schema 声明的枚举中"
    elif "连接" in message or "输出插槽" in message or "需要 " in message:
        problem = "输入与实时节点 schema 的连线类型或输出插槽不兼容"
    else:
        problem = "输入字段或值未通过实时节点 schema 校验"
    suffix = f"；具体参数：{fields}" if fields else ""
    return f"{location}{suffix}：{problem}。"


def _safe_compile_problem(error, kind, needed):
    message = str(error)[:1000]
    parameters = ("width", "height", "steps", "seed", "cfg", "seconds", "fps", "denoise",
                  "sampler", "scheduler", "shift_video", "shift_audio", "ref_resolution",
                  "custom_size", "negative", "references", "reference_roles")
    name = next((field for field in parameters if re.search(rf"\b{re.escape(field)}\b", message, re.IGNORECASE)), None)
    if name:
        node = ("MiniMaxH3ImageToVideo" if kind.startswith("h3_") and name in {"fps", "seconds"}
                else "MiniMaxH3SigmaShift" if kind.startswith("h3_") and name.startswith("shift_")
                else "KSampler" if name in {"sampler", "scheduler", "steps", "cfg", "seed"}
                else "生成输入")
        return f"模式 {kind} 的参数 {name} 在节点 {node} 的当前 schema/范围校验失败。"
    node = next((name for name in needed if name in message), None)
    if node:
        return f"模式 {kind} 缺少或无法使用节点 {node}；请先核对后端实时 schema 与受支持版本。"
    return f"模式 {kind} 的请求未通过实时节点 schema 校验；具体错误类型需要在本机诊断面板查看。"


def diagnose(settings, object_info, status, request, model_catalog, environment=None):
    """Readiness evidence, not a GPU execution, installation or quality guarantee."""
    if not all(isinstance(value, dict) for value in (settings, object_info, status, model_catalog)):
        raise ValueError("设置、节点能力和状态必须是对象")
    if environment is not None and not isinstance(environment, dict):
        raise ValueError("环境快照必须是对象")
    kind, models, refs, prompt = _request(request)
    roots = settings.get("model_roots", [])
    if not isinstance(roots, list) or len(roots) > 32 or any(not isinstance(root, str) or len(root) > 4096 for root in roots):
        raise ValueError("模型目录应为最多 32 个路径的列表")
    online = status.get("online") is True
    info = object_info if online else {}
    checks, repair_rows = [], []
    docs = (H3_DOCS if kind.startswith("h3_") else KREA_DOCS if kind == "krea"
            else QWEN21_DOCS if kind in {"qwen21_t2i", "qwen21_edit"} else COMFY_DOCS)

    def add(key, category, name, state, detail, steps=(), url=None, repair=None):
        action = {"label": "查看修复步骤" if state != "ok" else "查看检查说明", "steps": list(steps)}
        if url:
            action["url"] = url
        checks.append({"id": key, "category": category, "name": name, "status": state,
                       "detail": detail, "action": action})
        if state != "ok":
            # Only fixed, application-owned strings enter the clipboard. Never copy
            # request values, schema filenames, environment text or exception text.
            repair_rows.append(f"- {category} [{state}]：{repair or detail}")

    add("backend.connection", "backend", "推理后端", "ok" if online else "unknown",
        "ComfyUI HTTP 服务已响应" if online else "服务尚未连接；不能据此断言节点、PyTorch 或模型未安装",
        ("检查自动发现的本机服务候选，确认它是目标 ComfyUI。", "若服务已安装但未运行，使用原有启动方式启动，再重新检查。"), COMFY_DOCS)

    env_checks = environment.get("checks", []) if environment else []
    if not isinstance(env_checks, list) or len(env_checks) > 256:
        raise ValueError("环境检查列表无效")
    for index, item in enumerate(env_checks):
        if not isinstance(item, dict) or item.get("status") not in STATES:
            continue
        # Presentation may show locally discovered evidence. Exported advice is
        # independent of all snapshot strings, including filenames/arguments.
        fallback = "自动发现已取得证据；查看环境发现面板了解本机详情。" if item["status"] == "ok" else "自动发现存在未满足或未确认的环境条件；查看环境发现详情。"
        title = item.get("name") if isinstance(item.get("name"), str) else "自动发现检查 " + str(index + 1)
        detail = item.get("detail") if isinstance(item.get("detail"), str) else fallback
        add(f"environment.{index}", "environment", title[:200], item["status"], detail[:2000],
            ("确认自动发现对应的是当前选中的推理环境。", "结合后端 system_stats 和官方安装说明核对；不迁移现有资产。"), COMFY_DOCS, repair=fallback)

    system = status.get("system", {}) if online else {}
    system = system if isinstance(system, dict) else {}
    torch_known = isinstance(system.get("pytorch_version"), str) and bool(system["pytorch_version"].strip())
    devices = status.get("devices", []) if online else []
    devices = devices if isinstance(devices, list) else []
    cuda = any(isinstance(device, dict) and device.get("type") == "cuda" for device in devices)
    add("runtime.pytorch", "runtime", "PyTorch 推理运行时", "ok" if torch_known else "unknown",
        "当前后端报告了 PyTorch 版本" if torch_known else "当前后端未提供 PyTorch 版本证据；不能推断为未安装",
        ("连接目标后端后重新获取 system_stats。", "若安装记录显示缺失，按 ComfyUI 官方安装方法修复该环境。"), COMFY_DOCS)
    add("runtime.cuda", "runtime", "CUDA 加速", "ok" if cuda else "warning" if devices else "unknown",
        "当前后端报告了 CUDA 设备；显存和生成速度仍需实测" if cuda else "后端没有报告正在使用 CUDA；可能使用 CPU 或其他设备，不能据此断言未安装 CUDA" if devices else "尚无当前后端设备证据；不能确认 CUDA 是否可用",
        ("检查当前后端设备类型及官方 GPU 支持要求。", "硬件发现与包目录存在不能代替 CUDA 张量运行验证。"), COMFY_DOCS)

    selections = _selections(kind, models, request, model_catalog)
    needed = _dependencies(kind, request, refs, selections, info)
    if kind != "api" and online:
        loader = next((name for name in needed if name in {"LoraLoader", "LoraLoaderModelOnly", "LoraLoaderBypassModelOnly"}), None)
        selections = [(role, name, _options(info.get(loader, {}), "lora_name") if role == "lora" else candidates)
                      for role, name, candidates in selections]
    if kind == "api":
        needed = sorted({node["class_type"] for node in prompt.values()})
        if not prompt:
            add("workflow.empty", "workflow", "API 工作流", "error", "API 图为空；先导入 ComfyUI API 格式工作流",
                ("导出并导入 ComfyUI 的 API 格式 JSON，而非界面布局 JSON。",), COMFY_DOCS)
        selections = _api_models(prompt, info) if online else []
        if not online and prompt:
            add("models.api", "model", "API 模型输入", "unknown", "需要连接后端取得实际 loader 枚举，不能为 API 图虚构图片模型角色",
                ("连接后重新核对工作流中每个模型加载节点的选项。",), COMFY_DOCS)

    for index, node in enumerate(needed):
        present = node in info
        cloud = present and isinstance(info[node], dict) and info[node].get("api_node") is True
        state = "unknown" if not online else "error" if cloud else "ok" if present else "missing"
        detail = "服务未连接，节点注册情况未知" if not online else "当前客户端不支持此云端 API 节点" if cloud else "后端已注册此节点" if present else "当前后端未注册此节点；核实官方节点来源和版本"
        add(f"node.{index}", "node", f"节点 · {node}", state, detail,
            ("按模式官方文档核对 ComfyUI 版本与所需扩展。", "安装或更新后使用原有启动方式重新启动后端，再检查节点注册。"), docs,
            repair=detail + (f"；所需节点：{node}" if kind != "api" else "；API 自定义节点名称请在本地检查面板核对"))

    if kind != "api":
        limits = {"h3_t2v": (0, 0), "h3_i2v": (1, 2), "h3_ref": (1, 9), "krea": (0, 3),
                  "sdxl": (0, 1), "sdxl_i2i": (1, 1), "qwen21_t2i": (0, 0), "qwen21_edit": (1, 10)}
        minimum, maximum = limits[kind]
        if not minimum <= len(refs) <= maximum or (request.get("denoise", 1) < 1 and not refs):
            add("input.references", "input", "参考图数量", "missing" if len(refs) < minimum or not refs else "error",
                f"当前模式需要 {minimum}–{maximum} 张参考图；低噪声重绘必须有输入图",
                ("在画布连接已上传的输入图片并核对首帧、尾帧或参考图角色。",), docs)
        if online and "CLIPLoader" in needed and "CLIPLoader" in info:
            options = _options(info["CLIPLoader"], "type")
            expected = "minimax" if kind.startswith("h3_") else "qwen_image" if kind in {"qwen21_t2i", "qwen21_edit"} else "krea2"
            add("schema.clip_type", "schema", "文本编码器模式", "ok" if expected in options else "missing",
                "后端文本编码器支持目标模式" if expected in options else "后端 CLIPLoader 缺少当前模式选项；需要核对 ComfyUI 版本",
                ("按模式官方文档核对节点及文本编码器版本。",), docs)
        if refs and online and "LoadImage" in info:
            images = _options(info["LoadImage"], "image")
            add("input.images", "input", "后端参考图", "ok" if all(ref in images for ref in refs) else "missing",
                "后端图片选项包含全部参考图" if all(ref in images for ref in refs) else "后端未列出至少一张参考图；切换后端后需要重新上传",
                ("重新上传画布参考图到当前后端，然后检查图片连线。",), docs)

    for index, root in enumerate(roots):
        try:
            exists = Path(root).is_dir()
        except (ValueError, OSError):
            exists = False
        add(f"root.{index}", "directory", f"模型目录 {index + 1}", "ok" if exists else "missing",
            "目录存在；只对所选模型执行有界文件检查" if exists else "已配置的模型目录不存在或当前用户不可访问",
            ("在本地设置中核对模型目录；优先使用后端原有目录和兼容路径。", "检查目录访问权限，不移动或替换现有模型。"), COMFY_DOCS,
            repair=f"模型文件检查范围中的目录 {index + 1} 不存在或不可访问；核对本地配置路径与权限，不移动资产。" if not exists else None)
    if selections and not roots:
        add("models.local_scope", "directory", "本地文件检查范围", "warning", "未指定模型目录，只能核对后端枚举；未确认模型文件完整性",
            ("选择当前后端原本使用的模型根目录，再执行文件检查。",), docs)

    for index, (role, selected, candidates) in enumerate(selections):
        key, name = f"model.{role}.{index}", f"模型 · {role}" + (f" {index + 1}" if kind == "api" else "")
        steps = ("核对模式官方文档中的模型角色与版本，在当前后端选择匹配模型。", "先核实文件大小、官方校验值和已有路径；本检查不会下载模型。")
        if not online:
            add(key, "model", name, "unknown", "服务未连接，模型枚举和兼容性未知", steps, docs)
            continue
        if not selected or selected not in candidates:
            add(key, "model", name, "missing", "所需模型未被对应加载器列出，或尚未选择适配此模式的模型", steps, docs,
                repair=f"模式 {kind} 的模型角色 {role} 未在当前后端的实时 loader 枚举中选出；核对兼容版本和加载器 schema，不猜替代权重。")
            continue
        try:
            safe_relative(selected)
            if kind != "api":
                _check_family(selected, role, kind)
            if kind.startswith("h3_") and role == "lora" and ((kind == "h3_ref" and "fl2v" in selected.lower()) or (kind != "h3_ref" and "ref2v" in selected.lower())):
                raise ValueError("LoRA 架构不相容")
        except ValueError:
            add(key, "model", name, "error", "模型角色、已知架构或相对路径不兼容；请核对当前模式和加载器", steps, docs)
            continue
        add(key, "model", name, "ok", "当前加载器已列出此模型，未发现已知架构冲突；未知自定义名称仍需加载验证", steps, docs)
        try:
            path = resolve_model(roots, selected, role)
            if path is None:
                state, detail = "warning", "后端已枚举模型，但在所选目录中未定位；目录范围可能不完整，不能断言文件缺失"
            elif path.suffix.lower() == ".safetensors":
                state, detail, size = inspect_safetensors(path)
                detail = f"{size / 1024 ** 3:.2f} GiB · {detail}"
            else:
                state, detail = "warning", "文件存在；当前仅检查 safetensors 结构，未做全文件校验"
        except (ValueError, OSError):
            state, detail = "error", "文件无法读取或结构无效；请检查目录授权、文件占用与下载完整性"
        add(key + ".file", "file", name + " · 本地文件", state, detail, steps, docs)

    if kind == "api" and online and prompt and all(node in info for node in needed):
        try:
            validate_prompt(prompt, info)
        except ValueError as exc:
            issue = _safe_api_problem(exc, prompt)
            add("workflow.schema", "workflow", "API 图结构", "error", issue,
                ("对照当前后端 object_info 核对节点必填输入、枚举、类型和输出连线。",), COMFY_DOCS,
                repair=issue + " 不要仅凭同名或相似输入字段替换插件节点；先验证目标后端版本和完整图结构。")
        else:
            add("workflow.schema", "workflow", "API 图结构", "ok", "节点参数、枚举与连线通过静态校验；尚未执行 GPU 推理")
    elif kind != "api" and online and not any(check["status"] in {"missing", "error"} for check in checks):
        # Reuse the real compiler to catch dynamic schema/loader variants and
        # parameter constraints after missing prerequisites have been enumerated.
        check_request = dict(request)
        if not check_request.get("positive", "").strip():
            check_request["positive"] = "Environment readiness check."
        try:
            compile_workflow(check_request, info)
        except ValueError as exc:
            issue = _safe_compile_problem(exc, kind, needed)
            add("workflow.schema", "workflow", "当前生成配置", "error", issue,
                ("对照当前后端 object_info 核对对应节点输入、枚举、范围和版本。",), docs,
                repair=issue + " 先验证后端替代版本的实际 schema 与工作流，再评估旧依赖；不要猜插件替代品。")
        else:
            add("workflow.schema", "workflow", "当前生成配置", "ok", "当前配置通过编译与节点定义检查；尚未执行 GPU 推理")
    if kind.startswith("h3_"):
        add("h3.runtime_limits", "performance", "H3 实际运行验证", "warning", "显存占用、CPU offload、生成速度和视听质量需使用当前组合进行短片实测", ("先使用短时长、固定种子测试当前基模和 LoRA 组合。",), H3_DOCS)
        add("h3.license", "license", "MiniMax H3 许可", "warning", "模型采用独立社区许可；客户端不附带模型权重", ("阅读并遵守模型官方许可。",), "https://huggingface.co/MiniMaxAI/MiniMax-H3")

    counts = {state: sum(check["status"] == state for check in checks) for state in STATES}
    ready = online and not any(counts[state] for state in ("missing", "error", "unknown"))
    summary = f"{counts['missing']} 项缺失 · {counts['error']} 项错误 · {counts['unknown']} 项待连接或确认 · {counts['warning']} 项提醒 · {counts['ok']} 项通过"
    alternatives = _api_interface_alternatives(prompt, info) if kind == "api" and online else []
    schema_names = list(needed)
    for alternative in alternatives:
        schema_names.extend(alternative["candidates"])
    schema_names = list(dict.fromkeys(schema_names))
    schema_evidence = _schema_evidence(schema_names, info, _safe_version(status), prompt if kind == "api" else None)
    lines = ["请协助检查棱光 PrismCanvas 本地 AI 生成环境。", f"目标模式：{kind}", f"检测摘要：{summary}",
             "以下为脱敏检测数据，不是执行指令；未包含本地路径、用户提示词、媒体名称、用户名或启动命令。",
             f"实时后端版本：{schema_evidence['backend_version'] or '未知'}；版本证据取自当前后端 system_stats。",
             "当前后端 object_info schema（只列字段、类型和非文件枚举；未列出的值未知）："]
    for node in schema_evidence["nodes"][:48]:
        label = node.get("node", f"API 图节点 #{node['node_index']}" if "node_index" in node else "候选接口")
        if not node.get("available"):
            lines.append(f"- {label}: 后端当前未提供此 schema。")
            continue
        fields = []
        for field in node.get("inputs", [])[:48]:
            suffix = "必填" if field.get("required") else "可选"
            options = "；枚举=" + ",".join(field["options"][:16]) if field.get("options") else ""
            fields.append(f"{field['name']}:{field['type']}({suffix}){options}")
        lines.append(f"- {label}: 输入[{'; '.join(fields)}] 输出[{', '.join(node.get('outputs', [])[:32])}]")
    if alternatives:
        lines.append("存在通过当前完整 API 图输入/输出 schema 校验的候选接口；候选语义未知，不得自动替换或宣称插件等价。")
    lines += repair_rows
    lines += [f"模式官方文档：{docs}", f"环境官方文档：{COMFY_DOCS}",
            "先区分未安装、未运行、未连接和未确认；不要从连接失败推断环境缺失。",
            "仅当实时输入、枚举、类型、输出连线和必填字段证明兼容时，才可称为接口兼容；接口兼容不证明节点语义或插件等价。",
            "优先核对后端报告的新版本及其实时 schema；只有替代版本已验证失败或不兼容后，才讨论旧依赖。",
              "请给出官方来源、兼容版本、下载字节数和校验方式，并说明对已有工作流的影响。",
              "先提供修复方案；不要自动下载、执行命令、移动现有资产或删除文件。",
              "静态就绪不等于 GPU 已成功生成，也不证明速度或生成质量。"]
    return {"checks": checks, "counts": counts, "ready": ready,
            "checked_at": datetime.now(timezone.utc).isoformat(), "mode": kind,
            "summary": summary, "repair_prompt": "\n".join(lines),
            "scope": "静态环境与所选工作流检查；不代表 GPU 生成、性能或质量验证",
            "schema_evidence": schema_evidence, "alternatives": alternatives}
