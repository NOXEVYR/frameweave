"""Portable data-only workflow packages with explicit, typed input bindings."""

import copy
import hashlib
import json
import math
import os
import re
import tempfile
import threading
import time
import stat
from itertools import islice
from collections import deque
from pathlib import Path

from .diagnostics import safe_relative
from .media_contract import MEDIA_TYPES, media_input_contract
from .workflows import _check_json_limits, _expanded_inputs, _spec, api_carriers_equal

FORMAT = "frameweave-workflow"
MAX_BYTES = 2 * 1024 * 1024
TYPES = {"text", "integer", "number", "boolean", "select", "image", "audio", "video"}
ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
RESERVED = {"__proto__", "prototype", "constructor"}
MODEL_INPUTS = {"ckpt_name", "unet_name", "clip_name", "vae_name", "lora_name", "clip_name1", "clip_name2"}
PACKAGE_ID = re.compile(r"p-[0-9a-f]{24}\Z")
METADATA_FIELDS = {"favorite", "archived"}
MAX_METADATA_BYTES = 64 * 1024
MAX_INTERFACE_FIELDS = 4096
MAX_INSPECTION_FIELDS = MAX_INTERFACE_FIELDS


def encoded(value):
    _check_json_limits(value)
    pending = [value]
    while pending:
        current = pending.pop()
        if type(current) is int and abs(current) > 9007199254740991:
            raise ValueError("JSON 整数超过浏览器的精确范围；请将随机种子等数值设为 0–9007199254740991")
        if isinstance(current, dict):
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
    content = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    if len(content) > MAX_BYTES:
        raise ValueError("工作流包最大为 2 MiB；请只包含工作流与参数，不嵌入媒体或模型")
    return content


def parse_source_json(source):
    """Keep numeric tokens intact across clients whose JSON numbers lose .0."""
    if not isinstance(source, str):
        raise ValueError("source_json 须为 JSON 原文字符串")
    try:
        if len(source) > MAX_BYTES or len(source.encode("utf-8")) > MAX_BYTES:
            raise ValueError("工作流包原文最大为 2 MiB")
    except UnicodeEncodeError:
        raise ValueError("工作流包原文须为有效 Unicode 文本") from None

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("工作流包 JSON 不能包含重复键")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("工作流包 JSON 数字必须有限")

    try:
        document = json.loads(source, object_pairs_hook=pairs, parse_constant=constant)
        encoded(document)
    except (UnicodeError, RecursionError):
        raise ValueError("工作流包 JSON 文本无效或嵌套过深") from None
    if not isinstance(document, dict):
        raise ValueError("工作流包原文须包含 JSON 对象")
    return document


def transport_document(payload, *, allow_bare=False):
    """Read the explicit raw carrier, preserving legacy object entry points."""
    if not isinstance(payload, dict):
        raise ValueError("工作流包请求须为 JSON 对象")
    if "source_json" in payload:
        if set(payload) != {"source_json"}:
            raise ValueError("source_json 须单独提供，不能同时提供 document 或其他字段")
        return parse_source_json(payload["source_json"])
    if allow_bare:
        return payload
    if set(payload) != {"document"}:
        raise ValueError("请提供 document 或 source_json，且只选择一种")
    return payload["document"]


def api_prompt(document, *, _depth=0):
    """Read API carriers without confusing real prompt/workflow node IDs."""
    if not isinstance(document, dict) or _depth > 32:
        raise ValueError("API 工作流载体须为对象，且不能嵌套过深")
    if document and all(isinstance(node, dict) and isinstance(node.get("class_type"), str)
                        and isinstance(node.get("inputs"), dict) for node in document.values()):
        return document
    carriers = [api_prompt(document[key], _depth=_depth + 1)
                for key in ("prompt", "workflow") if key in document]
    if len(carriers) == 2 and not api_carriers_equal(carriers[0], carriers[1]):
        raise ValueError("prompt 与 workflow 载体冲突，请只保留明确导出的一个 API 工作流载体")
    return carriers[0] if carriers else document


def text(value, label, maximum, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        raise ValueError(f"{label}须为不超过 {maximum} 字符的文本")
    return value.strip()


def is_link(value):
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and type(value[1]) is int


def normalize_prompt(prompt, *, check_dependencies=True):
    """Normalize bounded API data; topology is checked on execution graphs.

    The default retains the historical full-graph topology check. Portable
    source documents may keep unfinished islands by opting out, but must still
    pass every JSON, node shape, identifier and input-name check.
    """
    encoded(prompt)
    if not isinstance(prompt, dict) or not 1 <= len(prompt) <= 1000:
        raise ValueError("请导入包含 1–1000 个节点的 ComfyUI API 工作流")
    if isinstance(prompt.get("nodes"), list):
        raise ValueError("这是 ComfyUI 画布格式；请在 ComfyUI 开启开发者模式并选择导出 API 格式")
    result = {}
    dependencies = {}
    for node_id, node in prompt.items():
        if (not isinstance(node_id, str) or not 1 <= len(node_id) <= 100 or node_id in RESERVED
                or not isinstance(node, dict) or not isinstance(node.get("inputs"), dict)):
            raise ValueError("API 节点需要有效 ID、class_type 和 inputs 对象")
        node_type = text(node.get("class_type"), "节点类型", 256)
        inputs = copy.deepcopy(node["inputs"])
        if any(not isinstance(key, str) or key in RESERVED or not key or len(key) > 256 for key in inputs):
            raise ValueError("节点输入名称无效")
        result[node_id] = {"class_type": node_type, "inputs": inputs}
        dependencies[node_id] = set()
        if not check_dependencies:
            continue
        for value in inputs.values():
            if is_link(value):
                if value[0] not in prompt or value[1] < 0:
                    raise ValueError("工作流连接到不存在的节点或无效输出插槽")
                dependencies[node_id].add(value[0])
    if not check_dependencies:
        return result
    pending = deque((node_id, 1) for node_id, deps in dependencies.items() if not deps)
    levels, count = {}, 0
    downstream = {key: [] for key in result}
    for key, deps in dependencies.items():
        for parent in deps:
            downstream[parent].append(key)
    while pending:
        key, level = pending.popleft()
        if level > 256:
            raise ValueError("工作流依赖链不能超过 256 层")
        count += 1
        for child in downstream[key]:
            dependencies[child].remove(key)
            levels[child] = max(levels.get(child, 1), level + 1)
            if not dependencies[child]:
                pending.append((child, levels[child]))
    if count != len(result):
        raise ValueError("工作流包含循环连接")
    return result


def scalar(value):
    return (type(value) in (str, int, float, bool)
            and (type(value) is not int or abs(value) <= 9007199254740991)
            and (type(value) is not float or math.isfinite(value)))


def validate_value(field, value, *, template=False, editing_enum_preservation=False):
    kind, label = field["type"], field["label"]
    if kind in {"text", "image", "audio", "video"}:
        if not isinstance(value, str) or len(value) > (1024 if kind in {"image", "audio", "video"} else 64000):
            raise ValueError(f"{label} 的文本类型或长度无效")
        if not value.strip() and field.get("required") and not template:
            raise ValueError(f"请填写 {label}")
        if kind in {"image", "audio", "video"} and value:
            safe_relative(value)
    elif kind == "boolean":
        if type(value) is not bool:
            raise ValueError(f"{label} 必须是布尔值")
    elif kind in {"integer", "number"}:
        if (type(value) not in ((int,) if kind == "integer" else (int, float))
                or (type(value) is float and not math.isfinite(value))):
            raise ValueError(f"{label} 的数值类型无效")
        if abs(value) > 9007199254740991:
            raise ValueError(f"{label} 超出浏览器可精确表示的数值范围")
        if ("min" in field and value < field["min"]) or ("max" in field and value > field["max"]):
            raise ValueError(f"{label} 超出工作流包允许的范围")
    elif kind == "select":
        # JSON has one number type; browser transport can serialize 1.0 as 1.
        # Keep booleans distinct and reject unsafe/nonfinite numeric options.
        def safe_option(candidate):
            return scalar(candidate) and (type(candidate) not in (int, float)
                                          or abs(candidate) <= 9007199254740991)

        # Explicitly preserving an editor's existing literal is not evidence
        # that the current backend can execute it. Do not overload template:
        # required-value deferral must never relax enum membership globally.
        if editing_enum_preservation:
            if not safe_option(value) or isinstance(value, str) and len(value) > 64000:
                raise ValueError(f"{label} 的原始下拉值不是安全基础值")
            if field.get("role") in {"model", "encoder", "lora"} and isinstance(value, str) and value:
                safe_relative(value)
            return value
        if not safe_option(value) or not any(
                safe_option(option) and api_carriers_equal(value, option)
                for option in field["options"]):
            raise ValueError(f"{label} 不在可选值中")
    return value


def normalize_fields(fields, prompt):
    if not isinstance(fields, list) or len(fields) > MAX_INTERFACE_FIELDS:
        raise ValueError(f"工作流包最多开放 {MAX_INTERFACE_FIELDS} 个输入参数")
    result, ids, bindings = [], set(), set()
    for item in fields:
        if not isinstance(item, dict):
            raise ValueError("参数定义必须为对象")
        field_id = item.get("id")
        if not isinstance(field_id, str) or not ID.fullmatch(field_id) or field_id in RESERVED or field_id in ids:
            raise ValueError("参数 ID 无效或重复")
        node_id, name = item.get("node_id"), item.get("input")
        if not isinstance(node_id, str) or not isinstance(name, str) or node_id not in prompt or name not in prompt[node_id]["inputs"]:
            raise ValueError("参数绑定的节点输入不存在")
        if (node_id, name) in bindings or is_link(prompt[node_id]["inputs"][name]):
            raise ValueError("不能重复绑定输入或覆盖节点连线")
        kind = item.get("type")
        if not isinstance(kind, str) or kind not in TYPES:
            raise ValueError("工作流包不支持此参数类型")
        field = {"id": field_id, "label": text(item.get("label"), "参数名称", 120),
                 "node_id": node_id, "input": name, "type": kind,
                 "required": item.get("required", kind in {"image", "audio", "video"}) is True}
        # Optional display metadata is preserved only when supplied. Inserting
        # defaults into old packages would change their content-addressed ID.
        if "presentation" in item:
            if item["presentation"] not in ("port", "control"):
                raise ValueError("参数展示方式须为 port 或 control")
            field["presentation"] = item["presentation"]
        if "role" in item:
            role = item["role"]
            if not isinstance(role, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", role):
                raise ValueError("参数角色须为最多 64 字符的小写标识")
            field["role"] = role
        if "group" in item:
            field["group"] = text(item["group"], "参数分组", 80)
        if kind == "select":
            options = item.get("options")
            if not isinstance(options, list) or len(options) > 512 or any(not scalar(v) or (isinstance(v, str) and len(v) > 2048) for v in options):
                raise ValueError("下拉选项须为 0–512 个基础值")
            field["options"] = copy.deepcopy(options)
        if kind in {"integer", "number"}:
            for bound in ("min", "max"):
                if bound in item:
                    value = item[bound]
                    if type(value) not in (int, float) or abs(value) > 9007199254740991 or not math.isfinite(value):
                        raise ValueError("数值边界须为有限数字")
                    field[bound] = value
            if field.get("min", -math.inf) > field.get("max", math.inf):
                raise ValueError("数值下限不能大于上限")
        default = item.get("default", prompt[node_id]["inputs"][name])
        if kind in {"image", "audio", "video"}:
            default = ""
            prompt[node_id]["inputs"][name] = ""
        empty_enum = kind == "select" and not field["options"]
        if empty_enum and not api_carriers_equal(default, prompt[node_id]["inputs"][name]):
            raise ValueError("空下拉目录的默认值必须保留原始节点字面值")
        field["default"] = validate_value(field, default, template=True,
                                         editing_enum_preservation=empty_enum)
        result.append(field)
        ids.add(field_id)
        bindings.add((node_id, name))
    return result


def normalize_document(document):
    encoded(document)
    if not isinstance(document, dict):
        raise ValueError("工作流包须为 JSON 对象")
    if document.get("format", FORMAT) != FORMAT or document.get("version", 1) != 1:
        raise ValueError("工作流包格式或版本不支持")
    prompt = normalize_prompt(document.get("prompt"), check_dependencies=False)
    fields = normalize_fields(document.get("fields", []), prompt)
    for node_id, node in prompt.items():
        if node["class_type"] in {"LoadImage", "LoadImageMask"} and "image" in node["inputs"]:
            if not any(field["node_id"] == node_id and field["input"] == "image" and field["type"] == "image" for field in fields):
                raise ValueError("参考图节点必须开放图片上传参数，才能在其他设备上使用工作流包")
        if node["class_type"] == "LoadAudio" and "audio" in node["inputs"]:
            if not any(field["node_id"] == node_id and field["input"] == "audio" and field["type"] == "audio" for field in fields):
                raise ValueError("参考音频节点必须开放音频上传参数，才能在其他设备上使用工作流包")
        if node["class_type"] == "LoadVideo" and "file" in node["inputs"]:
            if not any(field["node_id"] == node_id and field["input"] == "file" and field["type"] == "video" for field in fields):
                raise ValueError("LoadVideo 节点必须开放视频上传参数，才能在其他设备上使用工作流包")
        if node["class_type"] == "VHS_LoadVideo" and "video" in node["inputs"]:
            if not any(field["node_id"] == node_id and field["input"] == "video" and field["type"] == "video" for field in fields):
                raise ValueError("VHS_LoadVideo 节点必须开放视频上传参数，才能在其他设备上使用工作流包")
    result = {"format": FORMAT, "version": 1, "name": text(document.get("name"), "工作流包名称", 120),
              "description": text(document.get("description", ""), "说明", 2000, empty=True),
              "prompt": prompt, "fields": fields}
    encoded(result)
    return result


def _limit_inspection_fields(fields, field_limit):
    if field_limit is not None and (type(field_limit) is not int or
                                    not 1 <= field_limit <= MAX_INSPECTION_FIELDS):
        raise ValueError("field_limit 须为 1–4096 之间的整数或 None")
    limit = MAX_INSPECTION_FIELDS if field_limit is None else field_limit
    if field_limit is None and len(fields) > MAX_INSPECTION_FIELDS:
        raise ValueError("工作流候选输入超过 4096 项，请拆分工作流后检查")
    if len(fields) <= limit:
        return fields
    media = [field for field in fields if field['type'] in {'image', 'audio', 'video'}]
    if len(media) > limit:
        raise ValueError(f'工作流有超过 {limit} 个独立媒体输入，请在内部拆分工作流后应用')
    ranked = sorted(fields, key=lambda field: (field['type'] not in {'image', 'audio', 'video'}, not field['recommended']))
    keep = {field['id'] for field in ranked[:limit]}
    return [field for field in fields if field['id'] in keep]


def validate_inspection_result(result):
    """Bound the complete candidate response without trimming its authority."""
    try:
        encoded(result)
    except ValueError as exc:
        if "2 MiB" in str(exc):
            raise ValueError("接口检查结果（含候选默认值/选项）超过 2 MiB；原始工作流仍可编辑或导出，请缩减外部接口数据") from None
        raise
    return result


def inspect_document(document, info=None, *, field_limit=None, check_dependencies=True):
    encoded(document)
    if not isinstance(document, dict):
        raise ValueError("请导入 JSON 工作流对象")
    if "format" in document or "fields" in document:
        result = normalize_document(document)
        fields = [{**field, "recommended": True} for field in result["fields"]]
        return validate_inspection_result({**result, "fields": _limit_inspection_fields(fields, field_limit)})
    source = api_prompt(document)
    prompt = normalize_prompt(source, check_dependencies=check_dependencies)
    fields, info = [], info or {}
    labels = {"text": "提示词", "prompt": "画面提示词", "positive": "正向提示词", "negative": "负向提示词", "seed": "随机种子",
              "noise_seed": "随机种子", "steps": "采样步数", "cfg": "提示词引导", "width": "宽度",
              "height": "高度", "image": "参考图片", "file": "参考视频", "video": "参考视频",
              "denoise": "重绘强度", "batch_size": "生成数量", "length": "帧数"}
    polarity = {}
    for node in prompt.values():
        for key in ("positive", "negative"):
            link = node["inputs"].get(key)
            if is_link(link):
                polarity[link[0]] = labels[key]
    for node_id, node in prompt.items():
        schema = info.get(node["class_type"], {})
        specs, required = _expanded_inputs(schema, node["inputs"]) if isinstance(schema, dict) else ({}, set())
        for name, value in node["inputs"].items():
            if not scalar(value) or (type(value) is int and abs(value) > 9007199254740991):
                continue
            kind = "boolean" if type(value) is bool else "integer" if type(value) is int else "number" if type(value) is float else "text"
            spec, meta = _spec(specs[name]) if name in specs else (None, {})
            # JSON serializes 1.0 as 1 in the browser; the live FLOAT contract
            # must still allow fractional values such as a video duration.
            if spec == "FLOAT" and type(value) in (int, float):
                kind = "number"
            dynamic_combo = spec == "COMFY_DYNAMICCOMBO_V3"
            if dynamic_combo:
                definitions = meta.get("options")
                if not isinstance(definitions, list) or not 1 <= len(definitions) <= 512:
                    raise ValueError("动态组合选项须为 1–512 项")
                options = [definition["key"] for definition in definitions]
            else:
                options = spec if isinstance(spec, list) else meta.get("options") if spec == "COMBO" else None
            if isinstance(options, list) and len(options) <= 512 and all(scalar(v) for v in options):
                kind = "select"
            contract = media_input_contract(node["class_type"], name, specs.get(name),
                                            required=name in required)
            media_type = contract["media_type"] if contract["supported"] else None
            # Offline inspection retains historical draft recognition only.
            # Live execution and upload never use this schema-free fallback.
            if node["class_type"] not in info:
                media_type = _OFFLINE_MEDIA_INPUTS.get((node["class_type"], name))
            if media_type is not None:
                kind, value = media_type, ""
                prompt[node_id]["inputs"][name] = ""
            label = polarity.get(node_id, labels.get(name, name)) if name == "text" else labels.get(name, name)
            field = {"id": "f_" + hashlib.sha256((node_id + "\0" + name).encode()).hexdigest()[:16],
                     "label": f"{label} · {node_id}", "node_id": node_id, "input": name,
                     "type": kind, "default": value,
                     "required": kind in {"image", "audio", "video"} and (name not in specs or name in required),
                     "recommended": kind in MEDIA_TYPES or name in labels and name not in MODEL_INPUTS}
            if kind == "select":
                field["options"] = options
                if options and value not in options and not dynamic_combo:
                    field["options"] = [value, *options][:512]
                if not options:
                    validate_value(field, value, editing_enum_preservation=True)
            if kind in {"integer", "number"}:
                for bound in ("min", "max"):
                    if type(meta.get(bound)) in (int, float):
                        clamped = max(-9007199254740991, min(9007199254740991, meta[bound]))
                        if math.isfinite(clamped):
                            field[bound] = clamped
            fields.append(field)
    fields = _limit_inspection_fields(fields, field_limit)
    return validate_inspection_result({"name": "我的生成工作流", "description": "", "prompt": prompt, "fields": fields,
                                      "requirements": {"nodes": sorted({node["class_type"] for node in prompt.values()})}})


_OFFLINE_MEDIA_INPUTS = {("LoadImage", "image"): "image",
                        ("LoadImageMask", "image"): "image",
                        ("LoadAudio", "audio"): "audio",
                        ("LoadVideo", "file"): "video",
                        ("VHS_LoadVideo", "video"): "video"}


def _media_input_schema_supported(node_type, input_name, schema, media_type, *, values=None):
    """Check the expanded live standard filename contract, including audio."""
    if media_type not in MEDIA_TYPES or not isinstance(schema, dict):
        return False
    try:
        specs, required = _expanded_inputs(schema, values or {})
    except ValueError:
        return False
    contract = media_input_contract(node_type, input_name, specs.get(input_name),
                                    required=input_name in required)
    return contract["supported"] and contract["media_type"] == media_type


def validate_package_media_field(package, field_id, info, media_type, *, values=None):
    """Resolve a stored package field against its node and the current live schema."""
    if media_type not in MEDIA_TYPES or not isinstance(info, dict):
        raise ValueError("媒体类型或当前后端节点信息无效")
    normalized = normalize_document(package)
    field = next((item for item in normalized["fields"] if item["id"] == field_id), None)
    if field is None or field["type"] != media_type:
        raise ValueError("工作流包字段与上传媒体类型不一致")
    node = normalized["prompt"][field["node_id"]]
    node_type = node["class_type"]
    schema = info.get(node_type)
    live_values = (apply_editor_values(package, values)[field["node_id"]]["inputs"]
                   if values is not None else node["inputs"])
    if (node["inputs"].get(field["input"]) != ""
            or not _media_input_schema_supported(node_type, field["input"], schema, media_type,
                                                 values=live_values)):
        raise ValueError("当前工作流包字段未绑定到后端声明的兼容媒体上传节点")
    return field, node


def apply_values(document, values, *, active_nodes=None):
    """Apply safe package values, requiring only fields in an execution closure.

    Callers must compute active_nodes from validated output ancestry. This
    changes only empty required-value checks, never IDs, types, ranges, enums
    or relative-path checks, and never mutates the saved source document.
    """
    return _apply_values(document, values, editing=False, active_nodes=active_nodes)


def apply_editor_values(document, values):
    """Build an editor view; media and unavailable enum literals may remain.

    This does not certify execution readiness. Empty static enum directories
    preserve safe literals; nonempty enums, ranges, paths and unknown keys
    retain normal checks. Live editing preparation still rejects new invalid
    values before any native control patch.
    """
    return _apply_values(document, values, editing=True)


def apply_planning_values(document, values):
    """Build a scope-only view, deferring empty text/media without inventing values.

    All field IDs, types, bounds, options and paths retain their normal checks.
    Empty optional media stays present for live schema validation; execution
    applies its usual omission rules only when compiling the final request.
    """
    return _apply_values(document, values, editing=False, planning=True)


def validate_planning_fields(fields, prompt, info, active_nodes):
    """Check active stored bindings against expanded live input contracts."""
    specs_by_node = {}
    kinds = {"text": {"STRING"}, "integer": {"INT", "FLOAT"},
             "number": {"FLOAT"}, "boolean": {"BOOLEAN"}}
    for field in fields:
        node_id, name = field["node_id"], field["input"]
        if node_id not in active_nodes:
            continue
        node = prompt[node_id]
        if node_id not in specs_by_node:
            schema = info.get(node["class_type"])
            if not isinstance(schema, dict):
                raise ValueError(f"参数 {field['id']} 缺少当前后端节点定义")
            specs_by_node[node_id] = _expanded_inputs(schema, node["inputs"])
        specs, required = specs_by_node[node_id]
        if name not in specs:
            raise ValueError(f"参数 {field['id']} 已不在当前动态输入接口中，请重新应用接口")
        kind, meta = _spec(specs[name])
        contract = media_input_contract(node["class_type"], name, specs[name],
                                        required=name in required)
        if field["type"] in MEDIA_TYPES:
            compatible = contract["supported"] and contract["media_type"] == field["type"]
        elif field["type"] == "select":
            compatible = (isinstance(kind, list) or kind in {"COMBO", "COMFY_DYNAMICCOMBO_V3"}) and not contract["supported"]
            if compatible:
                options = kind if isinstance(kind, list) else meta.get("options", [])
                if kind == "COMFY_DYNAMICCOMBO_V3":
                    options = [option["key"] for option in options]
                value = node["inputs"][name]
                if not isinstance(options, list):
                    raise ValueError(f"参数 {field['id']} 不在当前后端可选值中")
                try:
                    validate_value({**field, "options": options}, value)
                except ValueError:
                    raise ValueError(f"参数 {field['id']} 不在当前后端可选值中") from None
        else:
            compatible = isinstance(kind, str) and kind in kinds[field["type"]] and not contract["supported"]
        if not compatible:
            raise ValueError(f"参数 {field['id']} 与当前后端输入类型不兼容，请重新应用接口")


def _apply_values(document, values, *, editing, active_nodes=None, planning=False):
    normalized = normalize_document(document)
    encoded(values)
    if not isinstance(values, dict) or set(values) - {field["id"] for field in normalized["fields"]}:
        raise ValueError("输入包含工作流包没有定义的参数")
    if active_nodes is not None and (not isinstance(active_nodes, (set, frozenset))
                                    or not active_nodes <= normalized["prompt"].keys()):
        raise ValueError("执行节点范围无效")
    prompt = copy.deepcopy(normalized["prompt"])
    for field in normalized["fields"]:
        empty_enum = field["type"] == "select" and not field["options"]
        preserve_enum = empty_enum and (editing or planning or
                        active_nodes is not None and field["node_id"] not in active_nodes)
        value = validate_value(field, values.get(field["id"], field["default"]),
                               template=(planning or editing and field["type"] in {"image", "audio", "video"}
                                         or active_nodes is not None and field["node_id"] not in active_nodes),
                               editing_enum_preservation=preserve_enum)
        # An unfilled optional upload means no input, not an empty filename.
        # Execution still validates required inputs against the live schema,
        # so package metadata cannot make an engine-required input optional.
        if not editing and not planning and field["type"] in {"image", "audio", "video"} and not field["required"] and not value:
            prompt[field["node_id"]]["inputs"].pop(field["input"], None)
            continue
        prompt[field["node_id"]]["inputs"][field["input"]] = value
    return prompt


def _stored_package_document(stored):
    """Document view of a PackageStore-verified record, never external input."""
    return {key: stored[key] for key in ("format", "version", "name", "description", "prompt", "fields")}


class PackageStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.RLock()
        # Presentation only. Detail, export and execution never consult this cache.
        self._summary_cache = {}

    def _path(self, package_id):
        if not isinstance(package_id, str) or not PACKAGE_ID.fullmatch(package_id):
            raise ValueError("工作流包 ID 无效")
        return self.directory / (package_id + ".json")

    def _read_metadata(self):
        """Recover valid entries independently; damaged organization never hides a package."""
        try:
            with (self.directory / "metadata.json").open("rb") as stream:
                data = stream.read(MAX_METADATA_BYTES + 1)
            if len(data) > MAX_METADATA_BYTES:
                return {}
            document = json.loads(data)
        except (OSError, ValueError, RecursionError):
            return {}
        if (not isinstance(document, dict) or type(document.get("version")) is not int
                or document["version"] != 1 or not isinstance(document.get("packages"), dict)):
            return {}
        result = {}
        for package_id, values in document["packages"].items():
            if (not isinstance(package_id, str) or not PACKAGE_ID.fullmatch(package_id)
                    or not isinstance(values, dict) or set(values) - METADATA_FIELDS
                    or any(type(value) is not bool for value in values.values())):
                continue
            result[package_id] = {key: values.get(key, False) for key in METADATA_FIELDS}
        return result

    def _write_metadata(self, metadata):
        data = encoded({"version": 1, "packages": metadata})
        if len(data) > MAX_METADATA_BYTES:
            raise ValueError("工作流包整理信息超过大小上限")
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("wb", prefix=".metadata-", suffix=".tmp",
                                             dir=self.directory, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(self.directory / "metadata.json")
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def save(self, document):
        normalized = normalize_document(document)
        package_id = "p-" + hashlib.sha256(encoded(normalized)).hexdigest()[:24]
        with self.lock:
            self.directory.mkdir(exist_ok=True, parents=True)
            path = self._path(package_id)
            if path.is_file():
                return self.get(package_id)
            if sum(1 for _ in self.directory.glob("p-*.json")) >= 200:
                raise ValueError("当前工作流包库最多保存 200 个包")
            temp = path.with_suffix(".tmp")
            temp.write_bytes(encoded(normalized))
            temp.replace(path)
            return self.get(package_id)

    def _get(self, package_id, metadata):
        path = self._path(package_id)
        try:
            with path.open("rb") as stream:
                data = stream.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError("工作流包文件超过大小上限")
            try:
                document = normalize_document(json.loads(data))
            except RecursionError:
                raise ValueError("工作流包 JSON 嵌套过深") from None
        except FileNotFoundError:
            raise ValueError("工作流包未在本机安装，请先导入对应工作流包") from None
        if "p-" + hashlib.sha256(encoded(document)).hexdigest()[:24] != package_id:
            raise ValueError("工作流包内容已变化，请重新导入")
        return {**document, "id": package_id, "created_at": path.stat().st_mtime,
                "updated_at": path.stat().st_mtime,
                "favorite": metadata.get(package_id, {}).get("favorite", False),
                "archived": metadata.get(package_id, {}).get("archived", False),
                "requirements": {"nodes": sorted({node["class_type"] for node in document["prompt"].values()})}}

    def get(self, package_id):
        with self.lock:
            return self._get(package_id, self._read_metadata())

    def update_metadata(self, package_id, patch):
        if (not isinstance(patch, dict) or not patch or set(patch) - METADATA_FIELDS
                or any(type(value) is not bool for value in patch.values())):
            raise ValueError("整理信息只接受 favorite、archived 布尔值，且至少提供一个字段")
        with self.lock:
            metadata = self._read_metadata()
            package = self._get(package_id, metadata)
            metadata[package_id] = {key: patch.get(key, package[key]) for key in METADATA_FIELDS}
            self._write_metadata(metadata)
            return {**package, **metadata[package_id]}

    def list(self):
        packages = []
        with self.lock:
            metadata = self._read_metadata()
            for path in list(self.directory.glob("p-*.json"))[:200]:
                try:
                    package = self._get(path.stem, metadata)
                    package.pop("prompt")
                    packages.append(package)
                except (ValueError, OSError):
                    continue
        return sorted(packages, key=lambda item: item["updated_at"], reverse=True)

    @staticmethod
    def _summary_identity(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)

    @staticmethod
    def _summary_row(document, package_id, modified):
        """Bound presentation data; this is deliberately not an execution validator."""
        if (not isinstance(document, dict) or document.get("format") != FORMAT
                or type(document.get("version")) is not int or document["version"] != 1):
            raise ValueError("工作流包摘要格式无效")
        name = text(document.get("name"), "工作流包名称", 120)
        description = text(document.get("description"), "说明", 2000, empty=True)
        # Escaped lone surrogates parse as Python strings but cannot cross the
        # UTF-8 HTTP boundary. One damaged display row must not break the list.
        name.encode("utf-8")
        description.encode("utf-8")
        fields, prompt = document.get("fields"), document.get("prompt")
        if not isinstance(fields, list) or len(fields) > MAX_INTERFACE_FIELDS:
            raise ValueError("工作流包摘要参数数量无效")
        if not isinstance(prompt, dict) or not 1 <= len(prompt) <= 1000:
            raise ValueError("工作流包摘要节点数量无效")
        for node_id, node in prompt.items():
            if (not isinstance(node_id, str) or not 1 <= len(node_id) <= 100 or node_id in RESERVED
                    or not isinstance(node, dict) or not isinstance(node.get("inputs"), dict)
                    or any(not key or len(key) > 256 or key in RESERVED for key in node["inputs"])):
                raise ValueError("工作流包摘要节点定义无效")
            text(node.get("class_type"), "节点类型", 256)
        media_types, ids, bindings = set(), set(), set()
        for field in fields:
            if (not isinstance(field, dict) or not isinstance(field.get("id"), str)
                    or not ID.fullmatch(field["id"]) or field["id"] in RESERVED
                    or field["id"] in ids or not isinstance(field.get("type"), str)
                    or field["type"] not in TYPES):
                raise ValueError("工作流包摘要参数定义无效")
            ids.add(field["id"])
            text(field.get("label"), "参数名称", 120)
            node_id, input_name = field.get("node_id"), field.get("input")
            if (not isinstance(node_id, str) or not isinstance(input_name, str) or node_id not in prompt
                    or input_name not in prompt[node_id]["inputs"] or (node_id, input_name) in bindings
                    or is_link(prompt[node_id]["inputs"][input_name])):
                raise ValueError("工作流包摘要参数绑定无效")
            bindings.add((node_id, input_name))
            if field["type"] == "select":
                options = field.get("options")
                if (not isinstance(options, list) or not 1 <= len(options) <= 512
                        or any(not scalar(value) or isinstance(value, str) and len(value) > 2048 for value in options)):
                    raise ValueError("工作流包摘要选项数量或类型无效")
            if field["type"] in MEDIA_TYPES:
                media_types.add(field["type"])
        return {"id": package_id, "name": name, "description": description,
                "format": FORMAT, "version": 1, "created_at": modified, "updated_at": modified,
                "summary": True, "field_count": len(fields), "node_count": len(prompt),
                "media_types": sorted(media_types)}

    def _read_summary(self, path, info, metadata):
        identity = self._summary_identity(info)
        cached = self._summary_cache.get(path.stem)
        if cached is not None and cached[0] == identity:
            return copy.deepcopy(cached[1])
        with path.open("rb") as stream:
            if self._summary_identity(os.fstat(stream.fileno())) != identity:
                raise ValueError("工作流包在摘要读取期间已变化")
            data = stream.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("工作流包文件超过大小上限")
        if "p-" + hashlib.sha256(data).hexdigest()[:24] == path.stem:
            def pairs(items):
                result = {}
                for key, value in items:
                    if key in result:
                        raise ValueError("工作流包 JSON 不能包含重复键")
                    result[key] = value
                return result

            document = json.loads(data, object_pairs_hook=pairs,
                                  parse_constant=lambda _: (_ for _ in ()).throw(ValueError("数字无效")))
            _check_json_limits(document)
            row = self._summary_row(document, path.stem, info.st_mtime)
        else:
            # Historical pretty/noncanonical sources are valid when the old
            # normalized-content identity matches. Retain their bytes verbatim.
            stored = self._get(path.stem, metadata)
            row = self._summary_row(stored, path.stem, info.st_mtime)
        if self._summary_identity(path.stat(follow_symlinks=False)) != identity:
            raise ValueError("工作流包在摘要读取期间已变化")
        self._summary_cache[path.stem] = (identity, copy.deepcopy(row))
        return row

    def list_summaries(self, *, refresh=False):
        """Opt-in bounded sequential cold reads and cheap display-only warm reads."""
        if type(refresh) is not bool:
            raise ValueError("摘要刷新参数须为布尔值")
        packages = []
        with self.lock:
            if refresh:
                self._summary_cache.clear()
            metadata = self._read_metadata()
            paths = list(islice(self.directory.glob("p-*.json"), 200))
            present = {path.stem for path in paths}
            for ident in list(self._summary_cache):
                if ident not in present:
                    del self._summary_cache[ident]
            for path in paths:
                try:
                    if not PACKAGE_ID.fullmatch(path.stem):
                        raise ValueError("工作流包 ID 无效")
                    info = path.stat(follow_symlinks=False)
                    if not stat.S_ISREG(info.st_mode) or not 1 <= info.st_size <= MAX_BYTES:
                        raise ValueError("工作流包文件类型或大小无效")
                    row = self._read_summary(path, info, metadata)
                    row.update({key: metadata.get(path.stem, {}).get(key, False) for key in METADATA_FIELDS})
                    packages.append(row)
                except (ValueError, OSError, RecursionError):
                    self._summary_cache.pop(path.stem, None)
        return sorted(packages, key=lambda item: item["updated_at"], reverse=True)

    def export(self, package_id):
        stored = self.get(package_id)
        # get() already verifies the stored canonical content and ID. Runtime
        # timestamps/organization metadata are not part of its document budget.
        return normalize_document(_stored_package_document(stored))

    def export_transport(self, package_id):
        document = self.export(package_id)
        return {"document": document, "source_json": encoded(document).decode("utf-8")}
