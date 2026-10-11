"""Build independent ComfyUI API graphs from live, public node schemas."""

from __future__ import annotations

import copy
import math
import re
from collections import deque

from .media_contract import media_input_contract


def _spec(value):
    if isinstance(value, str):
        return value, {}
    if not isinstance(value, (list, tuple)) or not value:
        raise ValueError("无效的后端节点输入定义")
    return value[0], value[1] if len(value) > 1 and isinstance(value[1], dict) else {}


def _options(schema, name):
    for group in ("required", "optional"):
        value = schema.get("input", {}).get(group, {}).get(name)
        if value is not None:
            kind, meta = _spec(value)
            return list(kind) if isinstance(kind, list) else list(meta.get("options", []))
    return []


def _filenames(info, node, field):
    return [x for x in _options(info.get(node, {}), field) if isinstance(x, str)]


def _input_fields(schema):
    result = {}
    if not isinstance(schema, dict):
        return result
    inputs = schema.get("input", {})
    if not isinstance(inputs, dict):
        return result
    for group in ("required", "optional"):
        values = inputs.get(group, {})
        if isinstance(values, dict):
            result.update(values)
    return result


def _sdxl_clip_options(object_info):
    schema = object_info.get("DualCLIPLoader", {})
    fields = _input_fields(schema)
    missing = []
    for field in ("clip_name1", "clip_name2", "type"):
        if field not in fields:
            missing.append(f"DualCLIPLoader.{field}")
    types = _options(schema, "type")
    if "sdxl" not in types:
        missing.append("DualCLIPLoader.type=sdxl")
    if "CLIP" not in schema.get("output", []):
        missing.append("DualCLIPLoader.output:CLIP")
    clip_name1 = _filenames(object_info, "DualCLIPLoader", "clip_name1")
    clip_name2 = _filenames(object_info, "DualCLIPLoader", "clip_name2")
    if not clip_name1:
        missing.append("DualCLIPLoader.clip_name1.options")
    if not clip_name2:
        missing.append("DualCLIPLoader.clip_name2.options")
    return {"available": not missing, "types": types,
            "clip_name1": clip_name1, "clip_name2": clip_name2,
            **({"reason": "缺少兼容的 SDXL 双编码器加载器：" + ", ".join(missing)} if missing else {})}


def _refine_capability(object_info):
    specs = {
        "LatentUpscale": ({"samples": "LATENT", "width": "INT", "height": "INT",
                           "upscale_method": "COMBO", "crop": "COMBO"}, "LATENT"),
        "KSampler": ({"model": "MODEL", "seed": "INT", "steps": "INT", "cfg": "FLOAT",
                      "sampler_name": "COMBO", "scheduler": "COMBO", "positive": "CONDITIONING",
                      "negative": "CONDITIONING", "latent_image": "LATENT", "denoise": "FLOAT"}, "LATENT"),
        "VAEDecode": ({"samples": "LATENT", "vae": "VAE"}, "IMAGE"),
        "SaveImage": ({"images": "IMAGE"}, None),
    }
    missing = []
    for node, (required, output_type) in specs.items():
        schema = object_info.get(node)
        if not isinstance(schema, dict):
            missing.append(node)
            continue
        fields = _input_fields(schema)
        missing.extend(f"{node}.{field}" for field in sorted(required.keys() - fields.keys()))
        for field, expected in required.items():
            if field not in fields:
                continue
            try:
                kind, meta = _spec(fields[field])
                actual = _type_names(kind)
                if kind == "COMFY_MATCHTYPE_V3":
                    actual = _type_names(meta.get("template", {}).get("allowed_types", "*"))
                supported = (bool(actual & {"COMBO", "COMFY_DYNAMICCOMBO_V3"}) if expected == "COMBO"
                             else expected in actual or "*" in actual)
            except (TypeError, ValueError):
                supported = False
            if not supported:
                missing.append(f"{node}.{field}:{expected}")
        if output_type and output_type not in schema.get("output", []):
            missing.append(f"{node}.output:{output_type}")
    upscale = object_info.get("LatentUpscale", {})
    methods = _options(upscale, "upscale_method")
    crops = _options(upscale, "crop")
    if not methods:
        missing.append("LatentUpscale.upscale_method.options")
    if not crops:
        missing.append("LatentUpscale.crop.options")
    save = object_info.get("SaveImage", {})
    if save and save.get("output_node") is not True:
        missing.append("SaveImage.output_node")
    return {"available": not missing, "missing": sorted(set(missing)),
            "upscale_methods": methods, "crop_options": crops}


def _known_family(filename, role):
    name = filename.replace("\\", "/").lower()
    base = name.rsplit("/", 1)[-1]
    if role in {"sdxl_clip_l", "sdxl_clip_g"}:
        if "clip_l" in base:
            return "sdxl_clip_l"
        if "clip_g" in base:
            return "sdxl_clip_g"
        if re.search(r"qwen[-_]?3[-_]?vl[-_]?8b", base):
            return "qwen21"
        if re.search(r"qwen[-_]?3[-_]?vl[-_]?4b", base):
            return "krea"
        if "minimax_h3" in name:
            return "h3"
    if "minimax_h3" in name or "/minimaxh3/" in name:
        return "h3"
    if role in {"dit", "vae", "lora"} and re.search(r"qwen[-_]?image[-_]?2[._]1", base):
        return "qwen21"
    if role == "text_encoder" and re.search(r"qwen[-_]?3[-_]?vl[-_]?8b", base):
        return "qwen21"
    if role == "text_encoder":
        if re.search(r"qwen[-_]?3[-_]?vl[-_]?4b", base):
            return "krea"
        if any(token in base for token in ("qwen", "t5", "clip_l", "clip_g", "clip-vit")):
            return "other_encoder"
    if role in {"vae", "audio_vae"} and "qwen_image_vae" in base:
        return "qwen_image"
    if "krea2" in name:
        return "krea"
    if re.search(r"(?:^|[/_.-])(?:sd1[._-]?5|sd15|v1[-_]5)(?:[_.-]|$)", name):
        return "sd15"
    if "sdxl" in name or any(token in base for token in ("illustrious", "pony", "illust")):
        return "sdxl"
    if "flux" in name or (role in {"vae", "audio_vae"} and base == "ae.safetensors"):
        return "flux"
    if re.search(r"(?:^|[/_.-])anima(?:[0-9/_.-]|$)", name):
        return "anima"
    for marker, family in (("wan2", "wan"), ("wan_2", "wan"),
                           ("hunyuan", "hunyuan"), ("ltx", "ltx"), ("qwen_image", "qwen_image"),
                           ("qwenimage", "qwen_image"), ("chroma", "chroma"),
                           ("pixart", "pixart"), ("z_image", "z_image"), ("z-image", "z_image")):
        if marker in name:
            return family
    return None


def _check_family(filename, role, kind):
    known = _known_family(filename, role)
    expected = (role if role in {"sdxl_clip_l", "sdxl_clip_g"} else
                "h3" if kind.startswith("h3_") else "sdxl" if kind in {"sdxl", "sdxl_i2i"}
                else "qwen21" if kind in {"qwen21_t2i", "qwen21_edit"} else kind)
    compatible = {expected}
    if kind == "krea" and role == "vae":
        compatible.add("qwen_image")
    if known is not None and known not in compatible:
        raise ValueError(f"{kind} 的 {role} 与已知 {known} 模型架构不相容")
    if expected == "h3" and role == "dit":
        name = filename.lower()
        if (kind == "h3_ref" and "fl2va" in name) or (kind != "h3_ref" and "ref2va" in name):
            raise ValueError(f"{kind} 需要 {'ref2va' if kind == 'h3_ref' else 'fl2va'} 模型")


def catalog(object_info: dict) -> dict:
    """Return selectable model names by role, without treating presence as integrity."""
    info = object_info
    sources = {
        "checkpoint": _filenames(info, "CheckpointLoaderSimple", "ckpt_name"),
        "dit": _filenames(info, "UNETLoader", "unet_name"),
        "text_encoder": _filenames(info, "CLIPLoader", "clip_name"),
        "sdxl_clip_l": _filenames(info, "DualCLIPLoader", "clip_name1"),
        "sdxl_clip_g": _filenames(info, "DualCLIPLoader", "clip_name2"),
        "vae": _filenames(info, "VAELoader", "vae_name"),
        "lora": [name for node in ("LoraLoader", "LoraLoaderModelOnly", "LoraLoaderBypassModelOnly")
                 for name in _filenames(info, node, "lora_name")],
    }
    folder_roles = {
        "checkpoint": {"checkpoint", "checkpoints"},
        "dit": {"diffusion", "diffusion_models", "unet"},
        "text_encoder": {"textencoder", "text_encoders", "clip"},
        "sdxl_clip_l": {"textencoder", "text_encoders", "clip"},
        "sdxl_clip_g": {"textencoder", "text_encoders", "clip"},
        "vae": {"vae"},
        "lora": {"lora", "loras"},
    }
    known_folders = set().union(*folder_roles.values())

    def plausible(filename, role):
        parts = filename.replace("\\", "/").lower().split("/")
        folders = set(parts[:-1])
        if folders & {"embeddings", "embedding", "clip_vision", "controlnet", "upscale_models", "background_removal"}:
            return False
        base = parts[-1]
        if role == "sdxl_clip_l" and "clip_g" in base:
            return False
        if role == "sdxl_clip_g" and "clip_l" in base:
            return False
        found = folders & known_folders
        if found:
            return bool(found & folder_roles[role])
        if "vae" in base or base in {"ae.safetensors", "taesd", "taesdxl"}:
            return role == "vae"
        if any(token in base for token in ("qwen3vl", "text_encoder", "t5xxl", "umt5", "clip_l", "clip_g")):
            return role in {"text_encoder", "sdxl_clip_l", "sdxl_clip_g"}
        if any(token in base for token in ("lora", "turbo_4step", "turbo_8step")):
            return role == "lora"
        if any(token in base for token in ("minimax_h3_fl2va", "minimax_h3_ref2va", "krea2", "flux1", "flux2", "wan2")):
            return role == "dit"
        # A custom filename does not establish an architecture. Keep the backend's
        # declared role usable, and let the user explicitly select unknown names.
        return True

    result = {}
    for role, names in sources.items():
        # Preserve backend names exactly; aliases can refer to distinct files.
        result[role] = sorted({name for name in names if plausible(name, role)}, key=str.casefold)
    result["audio_vae"] = [n for n in result["vae"] if "audio" in n.lower()
                           or (_known_family(n, "vae") is None and "video" not in n.lower())]
    result["vae"] = [n for n in result["vae"] if "audio" not in n.lower()]
    return result


def capabilities(object_info: dict) -> dict:
    present = set(object_info)
    image_common = {"KSampler", "VAEDecode", "SaveImage", "CLIPTextEncode"}
    h3_common = {"UNETLoader", "CLIPLoader", "VAELoader", "MiniMaxH3ImageToVideo",
                 "MiniMaxH3SigmaShift", "KSampler", "ConditioningZeroOut", "CreateVideo", "SaveVideo"}
    h3_decode = "MiniMaxH3AVDecodeT8" in present or {
        "LTXVSeparateAVLatent", "VAEDecode", "VAEDecodeAudio"} <= present
    qwen21_common = {"UNETLoader", "CLIPLoader", "VAELoader", "TextEncodeQwenImage21",
                     "KSampler", "VAEDecode", "SaveImage"}
    qwen21_clip = "qwen_image" in _options(object_info.get("CLIPLoader", {}), "type")
    return {
        "h3": h3_common <= present and h3_decode and "minimax" in _options(object_info.get("CLIPLoader", {}), "type"),
        "sdxl": image_common | {"CheckpointLoaderSimple", "EmptyLatentImage"} <= present,
        "sdxl_i2i": image_common | {"CheckpointLoaderSimple", "LoadImage", "ImageScale", "VAEEncode"} <= present,
        "krea": image_common | {"UNETLoader", "CLIPLoader", "VAELoader", "EmptySD3LatentImage", "ConditioningZeroOut"} <= present
        and "krea2" in _options(object_info.get("CLIPLoader", {}), "type"),
        "qwen21_t2i": qwen21_common | {"EmptyLatentImage"} <= present and qwen21_clip,
        "qwen21_edit": qwen21_common | {"LoadImage", "EmptyLatentImage"} <= present and qwen21_clip,
    }


def generation_options(object_info: dict) -> dict:
    """Only expose options actually declared by this backend, never invented files."""
    result = {"samplers": _options(object_info.get("KSampler", {}), "sampler_name"),
              "schedulers": _options(object_info.get("KSampler", {}), "scheduler"),
              "lora_loaders": {}, "model_families": {}}
    from .h3_reference import h3_reference_capability
    result["h3_reference"] = h3_reference_capability(object_info)
    result["sdxl_clip"] = _sdxl_clip_options(object_info)
    result["refine"] = _refine_capability(object_info)
    for node in ("LoraLoader", "LoraLoaderModelOnly", "LoraLoaderBypassModelOnly"):
        if node not in object_info:
            continue
        result["lora_loaders"][node] = {"names": _filenames(object_info, node, "lora_name"),
                                        "strength_clip": node == "LoraLoader"}
    dual = object_info.get("MiniMaxH3DualClockSamplerT8", {})
    result["h3_dual_clock"] = {"samplers": _options(dual, "sampler_name"),
                                "schedulers": _options(dual, "scheduler")}
    for role, names in catalog(object_info).items():
        result["model_families"][role] = {name: _known_family(name, role) or "unknown" for name in names}
    qwen = object_info.get("TextEncodeQwenImage21", {})
    resolution = qwen.get("input", {}).get("required", {}).get("resolution")
    resolution_meta = _spec(resolution)[1] if resolution is not None else {}
    image_spec = qwen.get("input", {}).get("required", {}).get("images")
    image_kind, image_meta = _spec(image_spec) if image_spec is not None else (None, {})
    template = image_meta.get("template", {}) if image_kind == "COMFY_AUTOGROW_V3" else {}
    names = template.get("names")
    backend_limit = len(names) if isinstance(names, list) else template.get("max", 0)
    result["qwen21"] = {
        "modes": {key: value for key, value in capabilities(object_info).items() if key.startswith("qwen21_")},
        "clip_types": [value for value in _options(object_info.get("CLIPLoader", {}), "type") if value == "qwen_image"],
        "reference_limit": min(10, backend_limit) if type(backend_limit) is int and backend_limit >= 0 else 0,
        "ref_resolution": {key: resolution_meta[key] for key in ("default", "min", "max", "step") if key in resolution_meta},
    }
    return result


def _expanded_inputs(schema, values):
    """Expand declared dynamic-combo, autogrow and video-format inputs."""
    fields, required = {}, set()

    def add(groups, prefix="", depth=0):
        if depth > 32:
            raise ValueError("后端动态输入定义嵌套过深")
        if not isinstance(groups, dict):
            raise ValueError("后端动态输入定义无效")
        for group in ("required", "optional"):
            group_inputs = groups.get(group, {})
            if not isinstance(group_inputs, dict):
                raise ValueError("后端动态输入定义无效")
            for name, definition in group_inputs.items():
                if not isinstance(name, str) or not name:
                    raise ValueError("后端动态输入名称无效")
                key = prefix + name
                kind, meta = _spec(definition)
                if kind == "COMFY_AUTOGROW_V3":
                    template = meta.get("template", {})
                    if not isinstance(template, dict):
                        raise ValueError("后端动态输入模板无效")
                    minimum = template.get("min", 0)
                    if type(minimum) is not int or not 0 <= minimum <= 1000:
                        raise ValueError("后端动态输入数量不合法")
                    names = template.get("names")
                    if names is None:
                        maximum = template.get("max", 0)
                        item_prefix = template.get("prefix", "item_")
                        if (type(maximum) is not int or not 0 <= maximum <= 1000
                                or not isinstance(item_prefix, str) or not item_prefix):
                            raise ValueError("后端动态输入数量不合法")
                        names = [item_prefix + str(i) for i in range(maximum)]
                    if (not isinstance(names, list) or len(names) > 1000
                            or any(not isinstance(item, str) or not item for item in names)
                            or len(set(names)) != len(names)):
                        raise ValueError("后端动态输入定义不合法")
                    nested = template.get("input", {})
                    if (not isinstance(nested, dict) or set(nested) - {"required", "optional"}
                            or any(not isinstance(inputs, dict) for inputs in nested.values())):
                        raise ValueError("后端动态输入模板无效")
                    template_definition, template_required = None, False
                    # V3 uses the first nonempty template group, in schema
                    # order. Only a required template enforces min; the outer
                    # Autogrow group's required/optional placement is unrelated.
                    for template_group, inputs in nested.items():
                        if inputs:
                            template_definition = next(iter(inputs.values()))
                            template_required = template_group == "required"
                            break
                    if template_definition is None:
                        raise ValueError("后端动态输入缺少类型")
                    template_kind, _ = _spec(template_definition)
                    if template_kind in ("COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3"):
                        raise ValueError("后端动态输入模板不能包含动态输入")
                    for index, item in enumerate(names):
                        child = key + "." + item
                        fields[child] = template_definition
                        if template_required and index < minimum:
                            required.add(child)
                    continue
                fields[key] = definition
                if group == "required":
                    required.add(key)
                if kind == "COMFY_DYNAMICCOMBO_V3":
                    selection = values.get(key)
                    options = meta.get("options")
                    if not isinstance(options, list):
                        raise ValueError("后端动态组合输入定义无效")
                    option_keys, selected = set(), None
                    for option in options:
                        if (not isinstance(option, dict) or not isinstance(option.get("key"), str)
                                or not isinstance(option.get("inputs"), dict)
                                or option["key"] in option_keys):
                            raise ValueError("后端动态组合输入定义无效")
                        option_keys.add(option["key"])
                        if option["key"] == selection:
                            selected = option
                    if selected is not None:
                        # ComfyUI serializes nested dynamic-combo values as flat
                        # dotted input names, for example format.codec.encoding.
                        add(selected["inputs"], key + ".", depth + 1)
                elif isinstance(kind, list) and isinstance(meta.get("formats"), dict):
                    selection = values.get(key)
                    if not isinstance(selection, str) or selection not in kind:
                        continue
                    widgets = meta["formats"].get(selection, [])
                    if isinstance(widgets, dict):
                        # A format profile can be opaque processing metadata
                        # (for example frame/dimension constraints), rather
                        # than a list of API widget declarations. Keep the
                        # selector's enum contract; never invent kwargs from it.
                        _check_json_limits(widgets)
                        continue
                    if not isinstance(widgets, list):
                        raise ValueError("后端视频格式输入定义不合法")
                    for widget in widgets:
                        if (not isinstance(widget, (list, tuple)) or len(widget) < 2 or
                                not isinstance(widget[0], str) or not widget[0]):
                            raise ValueError("后端视频格式输入定义不合法")
                        # VHS sends these as flat kwargs and supplies omitted defaults.
                        # Later entries can contain FFmpeg substitutions, not input specs.
                        child = prefix + widget[0]
                        if any(widget[0] in groups.get(group_name, {})
                               for group_name in ("required", "optional")):
                            continue
                        fields.setdefault(child, widget[1:3])

    add(schema.get("input", {}))
    return fields, required


def _type_names(kind):
    if isinstance(kind, list):
        return {"COMBO", "STRING"}
    return {name.strip() for name in str(kind).split(",") if name.strip()}


def _match_type_resolver(prompt, info):
    """Resolve V3 type-linked templates using actual upstream connections.

    Official schemas expose output_matchtypes[slot] and input.template with
    template_id/allowed_types. A MatchType marker alone is not an Any type.
    """
    inputs_cache, group_cache, visiting = {}, {}, set()

    def inputs(node_id):
        if node_id not in inputs_cache:
            node = prompt.get(node_id)
            if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
                raise ValueError(f"节点 {node_id} 缺少 inputs 对象")
            schema = info.get(node.get("class_type"))
            if not isinstance(schema, dict):
                raise ValueError(f"节点 {node_id} 缺少后端类型定义")
            inputs_cache[node_id] = _expanded_inputs(schema, node["inputs"])[0]
        return inputs_cache[node_id]

    def template(meta):
        value = meta.get("template")
        if (not isinstance(value, dict) or not isinstance(value.get("template_id"), str)
                or not value["template_id"].strip() or len(value["template_id"]) > 128):
            raise ValueError("MatchType 输入缺少有效的模板标识")
        allowed = value.get("allowed_types", "*")
        if (not isinstance(allowed, str) or not allowed.strip()
                or any(not part.strip() for part in allowed.split(","))
                or "COMFY_MATCHTYPE_V3" in _type_names(allowed)):
            raise ValueError("MatchType 模板的 allowed_types 定义无效")
        return value["template_id"], _type_names(allowed)

    def intersect(current, other, node_id, template_id):
        if "*" in other:
            return current
        if current is None or "*" in current:
            return set(other)
        common = current & other
        if not common:
            raise ValueError(f"节点 {node_id} 的 MatchType 模板 {template_id} 连接类型不一致")
        return common

    def group_types(node_id, template_id):
        key = node_id, template_id
        if key in group_cache:
            return group_cache[key]
        if key in visiting or len(visiting) >= 256:
            raise ValueError("MatchType 依赖存在循环或超过 256 层")
        visiting.add(key)
        try:
            members, resolved = [], None
            for name, definition in inputs(node_id).items():
                kind, meta = _spec(definition)
                if kind != "COMFY_MATCHTYPE_V3":
                    continue
                member_id, allowed = template(meta)
                if member_id == template_id:
                    members.append(name)
                    resolved = intersect(resolved, allowed, node_id, template_id)
            if not members:
                raise ValueError(f"节点 {node_id} 的 MatchType 输出模板未绑定到输入")
            linked = False
            for name in members:
                value = prompt[node_id]["inputs"].get(name)
                if (isinstance(value, list) and len(value) == 2
                        and isinstance(value[0], str) and type(value[1]) is int):
                    linked = True
                    resolved = intersect(resolved, output_types(value[0], value[1]), node_id, template_id)
            if not linked:
                raise ValueError(f"节点 {node_id} 的 MatchType 模板 {template_id} 没有可解析的上游连接")
            group_cache[key] = resolved if resolved is not None else {"*"}
            return group_cache[key]
        finally:
            visiting.remove(key)

    def output_types(node_id, slot):
        node = prompt.get(node_id)
        schema = info.get(node.get("class_type")) if isinstance(node, dict) else None
        outputs = schema.get("output") if isinstance(schema, dict) else None
        if not isinstance(outputs, (list, tuple)) or slot < 0 or slot >= len(outputs):
            raise ValueError(f"节点 {node_id} 的输出插槽无效")
        if outputs[slot] != "COMFY_MATCHTYPE_V3":
            return _type_names(outputs[slot])
        mappings = schema.get("output_matchtypes")
        if (not isinstance(mappings, list) or len(mappings) != len(outputs)
                or not isinstance(mappings[slot], str) or not mappings[slot].strip()):
            raise ValueError(f"节点 {node_id} 的 MatchType 输出缺少模板映射")
        return group_types(node_id, mappings[slot])

    def match_input_types(node_id, meta):
        return group_types(node_id, template(meta)[0])

    return output_types, match_input_types


def _check_json_limits(value):
    pending, items = [(value, 0)], 0
    while pending:
        current, depth = pending.pop()
        items += 1
        if depth > 64 or items > 100000:
            raise ValueError("API 图 JSON 超过 64 层嵌套或 100000 个数据项")
        if isinstance(current, dict):
            if any(not isinstance(key, str) for key in current):
                raise ValueError("API 图 JSON 对象的键必须为字符串")
            pending.extend((item, depth + 1) for item in current.values())
        elif isinstance(current, list):
            pending.extend((item, depth + 1) for item in current)
        elif type(current) is float and not math.isfinite(current):
            raise ValueError("API 图 JSON 不能包含非有限数值")
        elif current is not None and type(current) not in (str, int, float, bool):
            raise ValueError("API 图包含非 JSON 类型")


def validate_prompt(prompt: dict, object_info: dict) -> None:
    """Check graph shape, connections, literal values and cycles without inference."""
    _validate_prompt(prompt, object_info)


def validate_editor_prompt(prompt: dict, object_info: dict) -> dict:
    """Check the same graph contract while reporting repairable resource inputs.

    Known model/upload resources and schema-proven empty static enums may be
    unavailable. This is a schema check, not disk/GPU acceptance; a clean
    result is therefore unverified, never a promise that execution succeeds.
    """
    issues = []
    _validate_prompt(prompt, object_info, editor_issues=issues)
    return {"status": "blocked" if issues else "unverified", "issues": issues}


def _editor_resource_input(node_type, name, definition, *, required=True):
    contract = media_input_contract(node_type, name, definition, required=required)
    if contract["supported"]:
        return contract["media_type"]
    # Names describe model loader contracts, not workflow-specific templates.
    if name in {"ckpt_name", "unet_name", "clip_name", "vae_name", "lora_name",
                "clip_name1", "clip_name2"}:
        return "model"
    return None


def _validate_prompt(prompt, object_info, *, editor_issues=None):
    if not isinstance(prompt, dict) or not prompt or len(prompt) > 1000:
        raise ValueError("API 图必须包含 1–1000 个节点")
    if any(not isinstance(key, str) or not key for key in prompt):
        raise ValueError("API 节点 ID 必须是非空字符串")
    _check_json_limits(prompt)
    resolve_output_types, resolve_match_input_types = _match_type_resolver(prompt, object_info)
    dependencies = {key: set() for key in prompt}
    dependents = {key: set() for key in prompt}
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise ValueError(f"节点 {node_id} 缺少 inputs 对象")
        node_type = node.get("class_type")
        if not isinstance(node_type, str) or node_type not in object_info:
            raise ValueError(f"节点 {node_id} 缺少后端类型 {node_type}")
        schema = object_info[node_type]
        if not isinstance(schema, dict):
            raise ValueError(f"节点 {node_id} 的后端类型定义无效")
        if schema.get("api_node") is True:
            raise ValueError(f"初版本地模式不支持云端 API 节点 {node_type}")
        fields, required = _expanded_inputs(schema, node["inputs"])
        missing = required - node["inputs"].keys()
        if missing:
            raise ValueError(f"{node_type} 缺少必填输入：{', '.join(sorted(missing))}")
        for name, value in node["inputs"].items():
            if name not in fields:
                raise ValueError(f"{node_type} 不支持输入 {name}")
            kind, meta = _spec(fields[name])
            label = f"{node_type}.{name}"
            is_link = isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and type(value[1]) is int
            if is_link:
                source, slot = value
                if source not in prompt:
                    raise ValueError(f"{label} 连接到不存在的节点 {source}")
                source_type = prompt[source].get("class_type") if isinstance(prompt[source], dict) else None
                if not isinstance(source_type, str) or source_type not in object_info:
                    raise ValueError(f"{label} 上游节点类型不存在")
                outputs = object_info[source_type].get("output", [])
                if slot < 0 or slot >= len(outputs):
                    raise ValueError(f"{label} 输出插槽 {slot} 越界")
                expected = _type_names(kind)
                actual = resolve_output_types(source, slot)
                if kind == "COMFY_MATCHTYPE_V3":
                    expected = resolve_match_input_types(node_id, meta)
                if "*" not in expected | actual and not expected & actual:
                    raise ValueError(f"{label} 需要 {kind}，上游输出为 {outputs[slot]}")
                dependencies[node_id].add(source)
                dependents[source].add(node_id)
                continue
            contract = media_input_contract(node_type, name, fields[name],
                                            required=name in required)
            if contract["supported"] and editor_issues is None:
                if not isinstance(value, str):
                    raise ValueError(f"{label} 的资源名称必须为字符串")
                if not value.strip():
                    if name in required:
                        raise ValueError(f"{label} 尚未填写资源")
                    continue
                from .diagnostics import safe_relative
                safe_relative(value)
            if isinstance(kind, list):
                options = kind
            elif kind in {"COMBO", "COMFY_DYNAMICCOMBO_V3"}:
                options = meta.get("options", [])
                if kind == "COMFY_DYNAMICCOMBO_V3":
                    options = [x["key"] for x in options]
            else:
                options = None
            if options is not None:
                if editor_issues is not None and not isinstance(options, list):
                    raise ValueError(f"{label} 的后端选项定义无效")
                resource = (_editor_resource_input(node_type, name, fields[name], required=name in required)
                            if editor_issues is not None and kind != "COMFY_DYNAMICCOMBO_V3"
                            and not meta.get("multiselect") else None)
                if (editor_issues is not None and options == [] and kind != "COMFY_DYNAMICCOMBO_V3"
                        and not any(meta.get(key) for key in ("multiselect", "forceInput", "rawLink"))):
                    # A real static catalog with no choices is repairable
                    # editing data, never an executable enum. Preserve the
                    # literal without inventing a choice or modifying schema.
                    from .packages import validate_value
                    field = {"type": "select", "label": label, "options": []}
                    if resource is not None:
                        if not isinstance(value, str):
                            raise ValueError(f"{label} 的资源名称必须为字符串")
                        if value:
                            from .diagnostics import safe_relative
                            safe_relative(value)
                    validate_value(field, value, editing_enum_preservation=True)
                    editor_issues.append({"node_id": node_id, "input": name, "code": "enum_unavailable",
                                          "message": f"{label} 当前下拉目录为空，原始值保留供编辑"})
                    continue
                if resource is not None:
                    if not isinstance(value, str) or any(not isinstance(option, str) for option in options):
                        raise ValueError(f"{label} 的资源名称必须为字符串")
                    if resource in {"image", "audio", "video"} and name not in required and not value:
                        continue
                    if value:
                        # Local import avoids diagnostics -> workflows import cycle.
                        from .diagnostics import safe_relative
                        safe_relative(value)
                    if not value.strip() or value not in options:
                        editor_issues.append({
                            "node_id": node_id, "input": name,
                            "code": "missing_model" if resource == "model" else "missing_media",
                            "resource_type": resource,
                            "message": f"{label} 需要重新选择当前后端的资源" if value.strip()
                                       else f"{label} 尚未填写资源",
                        })
                    continue
                if meta.get("multiselect"):
                    if not isinstance(value, list) or any(v not in options for v in value):
                        raise ValueError(f"{label} 包含不支持的选项")
                elif value not in options:
                    raise ValueError(f"{label} 的选项不在当前后端中：{value}")
            elif kind == "INT":
                if type(value) is not int:
                    raise ValueError(f"{label} 必须为整数")
            elif kind == "FLOAT":
                if type(value) not in (int, float) or (type(value) is float and not math.isfinite(value)):
                    raise ValueError(f"{label} 必须为有限数值")
            elif kind == "BOOLEAN":
                if type(value) is not bool:
                    raise ValueError(f"{label} 必须为布尔值")
            elif kind == "STRING":
                if not isinstance(value, str):
                    raise ValueError(f"{label} 必须为字符串")
                resource = (_editor_resource_input(node_type, name, fields[name], required=name in required)
                            if editor_issues is not None else None)
                if resource is not None:
                    if value:
                        from .diagnostics import safe_relative
                        safe_relative(value)
                    if not value.strip() and (name in required or resource not in {"image", "audio", "video"}):
                        editor_issues.append({"node_id": node_id, "input": name,
                                              "code": "missing_model" if resource == "model" else "missing_media",
                                              "resource_type": resource,
                                              "message": f"{label} 尚未填写资源"})
            else:
                raise ValueError(f"{label} 必须连接 {kind} 类型的节点输出")
            if kind in ("INT", "FLOAT"):
                if ("min" in meta and value < meta["min"]) or ("max" in meta and value > meta["max"]):
                    raise ValueError(f"{label} 超出后端允许的数值范围")
    ready = deque(key for key, upstream in dependencies.items() if not upstream)
    levels = {key: 1 for key in prompt}
    count = 0
    while ready:
        current = ready.popleft()
        count += 1
        for next_node in dependents[current]:
            levels[next_node] = max(levels[next_node], levels[current] + 1)
            if levels[next_node] > 256:
                raise ValueError("API 图依赖链不能超过 256 层")
            dependencies[next_node].remove(current)
            if not dependencies[next_node]:
                ready.append(next_node)
    if count != len(prompt):
        raise ValueError("API 图存在循环连接")


class _Graph:
    def __init__(self, info, editor=None):
        self.info = info
        self.editor = editor
        self.nodes = {}
        self.receipt = {}

    def add(self, node_type, **inputs):
        if self.editor:
            self.editor.schema(self.info, node_type)
        if node_type not in self.info:
            error = _RecipeBlocked if self.editor else ValueError
            raise error(f"后端缺少节点 {node_type}")
        node_id = str(len(self.nodes) + 1)
        self.nodes[node_id] = {"class_type": node_type, "inputs": inputs}
        return [node_id, 0]


    def bind(self, reference, input_name, logical_id, field_type):
        """Record real graph locations; no candidate IDs or widget indices."""
        if self.editor is None:
            return
        node_id = reference[0]
        if node_id not in self.nodes or input_name not in self.nodes[node_id]["inputs"]:
            raise RuntimeError("预设绑定回执与实际构图不一致")
        item = self.receipt.setdefault(logical_id, {"logical_id": logical_id,
                                      "type": field_type, "targets": []})
        if item["type"] != field_type:
            raise RuntimeError("预设逻辑绑定类型冲突")
        target = {"node_id": node_id, "input": input_name, "type": field_type}
        if target not in item["targets"]:
            item["targets"].append(target)
        if logical_id in {"positive", "negative"}:
            item["composition"] = {"separator": "\n\n" if logical_id == "positive" else ", ",
                                   "own_position": "last"}


def _number(request, name, default, minimum, maximum, integer=False):
    value = request.get(name, default)
    if type(value) not in (int, float):
        raise ValueError(f"{name} 必须为有限数值")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} 必须在 {minimum}–{maximum} 之间")
    if not math.isfinite(value):
        raise ValueError(f"{name} 必须为有限数值")
    if integer and value != int(value):
        raise ValueError(f"{name} 必须在 {minimum}–{maximum} 之间" + ("并且为整数" if integer else ""))
    return int(value) if integer else float(value)


def _reference_names(request):
    references = request.get("references", [])
    if not isinstance(references, list) or any(not isinstance(name, str) or not name for name in references):
        raise ValueError("references 必须是已上传图片名称列表")
    for name in references:
        path = name.replace("\\", "/")
        if path.startswith("/") or ":" in path or ".." in path.split("/") or "\x00" in path:
            raise ValueError("参考图必须使用后端上传返回的相对名称")
    return references


def _lora_specs(request, kind, *, allow_empty=False):
    """Normalize legacy single LoRA and explicit, ordered multi-LoRA requests."""
    sdxl = kind in {"sdxl", "sdxl_i2i"}
    if "loras" in request:
        values = request["loras"]
        if not isinstance(values, list) or len(values) > 4:
            raise ValueError("loras 必须为最多 4 项的列表")
    else:
        name = request.get("lora") or request.get("models", {}).get("lora")
        strength = request.get("lora_strength", 1.0)
        values = [{"name": name, "strength_model": strength,
                   "strength_clip": strength if sdxl else 0}] if name else []
    result = []
    for item in values:
        if not isinstance(item, dict) or set(item) - {"name", "strength_model", "strength_clip"}:
            raise ValueError("LoRA 项只支持 name、strength_model、strength_clip")
        name = item.get("name")
        if not isinstance(name, str) or (not name.strip() and not (allow_empty and name == "")) or len(name) > 1024:
            raise ValueError("LoRA name 必须为 1–1024 字符的名称")
        model_strength = _number(item, "strength_model", 1, -10, 10)
        clip_strength = _number(item, "strength_clip", 1 if sdxl else 0, -10, 10)
        if not sdxl and clip_strength != 0:
            raise ValueError("H3 / Krea / Qwen Image 2.1 当前仅支持 model-only LoRA；strength_clip 必须省略或为 0")
        result.append({"name": name, "strength_model": model_strength, "strength_clip": clip_strength})
    return result


def _reference_roles(request, kind, references):
    roles = request.get("reference_roles")
    if roles is None:
        return ["start", "end"][:len(references)] if kind == "h3_i2v" else ["reference"] * len(references)
    if not isinstance(roles, list) or len(roles) != len(references):
        raise ValueError("reference_roles 必须与 references 一一对应")
    if any(not isinstance(role, str) or not role or len(role) > 64 for role in roles):
        raise ValueError("参考图角色必须为 1–64 字符的标签")
    if kind == "h3_i2v":
        aliases = {"start": "start", "first_frame": "start", "start_frame": "start", "first": "start",
                   "end": "end", "last_frame": "end", "end_frame": "end", "last": "end", "reference": None}
        if any(role not in aliases for role in roles):
            raise ValueError("H3 图生视频的参考角色只能是 start/first_frame 或 end/last_frame")
        roles = [aliases[role] for role in roles]
        explicit = [role for role in roles if role is not None]
        if len(set(explicit)) != len(explicit):
            raise ValueError("H3 图生视频不能重复指定首帧或尾帧")
        remaining = [role for role in ("start", "end") if role not in explicit]
        for index, role in enumerate(roles):
            if role is None:
                if not remaining:
                    raise ValueError("H3 图生视频最多指定首帧和尾帧两张图片")
                roles[index] = remaining.pop(0)
    return list(roles)


def _model(models, role, available, tokens=(), preferred=()):
    selected = models.get(role)
    if selected:
        if not isinstance(selected, str) or selected not in available[role]:
            raise ValueError(f"所选 {role} 未被后端列出或与模型角色不符")
        return selected
    candidates = available[role]
    if tokens:
        candidates = [name for name in candidates if any(token in name.lower() for token in tokens)]
    if not candidates:
        raise ValueError(f"缺少 {role} 模型，请先选择或安装所需模型")
    # Canonical Library entries are preferred, but never remapped into invented paths.
    return min(candidates, key=lambda name: (
        not any(token in name.lower() for token in preferred) if preferred else False,
        "pruned" in name.lower(), "library/" not in name.replace("\\", "/").lower(), len(name), name.lower()))


def _normalize_refine(request, kind, object_info, width, height, steps, *, editor=None):
    if "refine" not in request:
        return None
    value = request["refine"]
    if not isinstance(value, dict):
        raise ValueError("refine 必须为对象")
    allowed = {"enabled", "width", "height", "steps", "denoise", "upscale_method"}
    if set(value) - allowed:
        raise ValueError("refine 只支持 enabled、width、height、steps、denoise、upscale_method")
    enabled = value.get("enabled", False)
    if type(enabled) is not bool:
        raise ValueError("refine.enabled 必须为布尔值")
    if not enabled:
        return None
    if kind not in {"sdxl", "sdxl_i2i"}:
        raise ValueError("二次重绘目前只支持 SDXL 文生图和图生图")
    try:
        capability = _refine_capability(object_info)
    except (AttributeError, TypeError, ValueError) as error:
        if editor:
            raise _RecipeBlocked("高清二次重绘后端节点定义无效") from error
        raise
    if not capability["available"] and editor is None:
        raise ValueError("当前后端缺少高清二次重绘所需节点或字段：" + ", ".join(capability["missing"]))
    refine_width = _number(value, "width", min(width * 2, 8192), 32, 8192, True)
    refine_height = _number(value, "height", min(height * 2, 8192), 32, 8192, True)
    if refine_width % 8 or refine_height % 8:
        raise ValueError("二次重绘宽高必须为 8 的倍数")
    refine_steps = _number(value, "steps", min(steps, 20), 1, 1000, True)
    refine_denoise = _number(value, "denoise", 0.3, 0, 1)
    if not capability["available"]:
        raise _RecipeBlocked("当前后端缺少高清二次重绘所需节点或字段：" + ", ".join(capability["missing"]))
    methods = capability["upscale_methods"]
    method = value.get("upscale_method", "bislerp" if "bislerp" in methods else methods[0])
    if editor and method == "":
        raise _RecipeBlocked("二次重绘放大方法尚未选择；完整请求已保留，未代选算法", code="missing_input")
    if not isinstance(method, str) or method not in methods:
        raise ValueError("refine.upscale_method 不在当前后端支持列表中")
    crops = capability["crop_options"]
    crop = "disabled" if "disabled" in crops else crops[0]
    return {"enabled": True, "width": refine_width, "height": refine_height,
            "steps": refine_steps, "denoise": refine_denoise,
            "upscale_method": method, "crop": crop}


def api_carriers_equal(first, second):
    """Compare JSON graph semantics without conflating booleans and numbers."""
    _check_json_limits(first)
    _check_json_limits(second)

    def equal(a, b):
        if type(a) in (int, float) and type(b) in (int, float):
            return a == b
        if type(a) is not type(b):
            return False
        if isinstance(a, dict):
            return a.keys() == b.keys() and all(equal(a[key], b[key]) for key in a)
        if isinstance(a, list):
            return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
        return a == b

    return equal(first, second)


class _RecipeBlocked(ValueError):
    """The live schema cannot prove a complete editable preset topology."""

    def __init__(self, message, *, code="schema_topology"):
        super().__init__(message)
        self.code = code


class _PresetEditorRecipe:
    def __init__(self, reference_slots, input_intents, model_intents):
        self.reference_slots = reference_slots
        self.input_intents = self.intents(input_intents, {"positive", "negative"}, "input_intents")
        self.model_intents = self.intents(model_intents, {"sdxl_external_clip", "independent_vae"}, "model_intents")
        self.reference_ids = []
        self.pending = []

    @staticmethod
    def intents(value, allowed, label):
        if value is None:
            return {}
        if not isinstance(value, dict) or set(value) - allowed or any(type(item) is not bool for item in value.values()):
            raise ValueError(f"{label} 必须只包含受支持的布尔意图")
        return dict(value)

    @staticmethod
    def resource_name(value):
        if not isinstance(value, str) or len(value) > 1024:
            raise ValueError("资源名称必须是 0–1024 字符的文本")
        if value:
            from .diagnostics import safe_relative
            safe_relative(value)

    def model(self, models, role, available, tokens=(), preferred=()):
        # Editing must not inherit execution's automatic model selection.
        selected = models.get(role, "")
        self.resource_name(selected)
        return selected

    @staticmethod
    def schema(info, node_type):
        schema = info.get(node_type)
        if (not isinstance(schema, dict) or not isinstance(schema.get("input"), dict)
                or not isinstance(schema.get("output"), (list, tuple))):
            raise _RecipeBlocked(f"后端缺少有效节点定义 {node_type}")
        for group in ("required", "optional", "hidden"):
            if group in schema["input"] and not isinstance(schema["input"][group], dict):
                raise _RecipeBlocked(f"后端节点 {node_type} 的 {group} 输入定义无效")
        return schema

    @staticmethod
    def definition(value, label):
        try:
            return _spec(value)
        except ValueError as error:
            raise _RecipeBlocked(f"{label} 后端输入定义无效") from error

    @staticmethod
    def dynamic_names(template, count, label):
        if not isinstance(template, dict):
            raise _RecipeBlocked(f"{label} 动态参考图模板无效")
        names = template.get("names")
        if names is None:
            maximum, prefix = template.get("max"), template.get("prefix")
            if type(maximum) is not int or not 0 <= maximum <= 1000 or not isinstance(prefix, str):
                raise _RecipeBlocked(f"{label} 缺少明确的动态参考图 names 或 prefix/max")
            names = [prefix + str(index) for index in range(maximum)]
        if (not isinstance(names, list) or len(names) > 1000 or len(names) < count
                or any(not isinstance(name, str) or not name or len(name) > 1024 for name in names)
                or len(set(names)) != len(names)):
            raise _RecipeBlocked(f"{label} 动态参考图名称不唯一、无效或容量不足")
        return names

    def references(self, request, kind):
        limits = {"h3_i2v": 2, "h3_ref": 9, "krea": 3, "sdxl": 1,
                  "sdxl_i2i": 1, "qwen21_edit": 10}
        limit = limits.get(kind, 0)
        refs = request.get("references", [])
        if not isinstance(refs, list) or len(refs) > limit:
            raise ValueError(f"{kind} 参考图数量超出当前预设限制 {limit}")
        for name in refs:
            self.resource_name(name)
        roles = _reference_roles(request, kind, refs)
        if kind in {"qwen21_t2i", "qwen21_edit"} and any(role != "reference" for role in roles):
            raise ValueError("Qwen Image 2.1 有序参考图角色只能使用 reference")
        own = {(0 if role == "start" else 1): name for name, role in zip(refs, roles)} if kind == "h3_i2v" else dict(enumerate(refs))
        own_roles = dict(enumerate(roles))
        slots = self.reference_slots if self.reference_slots is not None else []
        if not isinstance(slots, list) or len(slots) > limit:
            raise ValueError("reference_slots 必须为有界的预设参考槽列表")
        active = set(own)
        declared = set()
        for slot in slots:
            if not isinstance(slot, dict) or set(slot) != {"port_id", "index", "ordinal", "role"}:
                raise ValueError("参考槽只允许 port_id、index、ordinal、role；不能包含连接值")
            index = slot["index"]
            if type(index) is not int or not 0 <= index < limit or type(slot["ordinal"]) is not int or slot["ordinal"] != index + 1:
                raise ValueError("参考槽 index/ordinal 越界或不一致")
            role = ("start" if index == 0 else "end") if kind == "h3_i2v" else "reference"
            port = ("start_image" if index == 0 else "end_image") if kind == "h3_i2v" else f"ref_image_{index}" if kind == "h3_ref" else f"image_{index + 1}"
            if slot["role"] != role or slot["port_id"] != port or index in declared:
                raise ValueError("参考槽端口、角色、序号不匹配或重复")
            declared.add(index)
            active.add(index)
        if not active and kind in {"h3_i2v", "h3_ref", "sdxl_i2i", "qwen21_edit"}:
            active.add(0)
        if (not active and kind in {"sdxl", "krea"}
                and type(request.get("denoise", 1)) in (int, float) and request.get("denoise", 1) < 1):
            active.add(0)
        # Ordered encoders retain holes through the highest intended slot. H3
        # first/last-frame roles are independent, so end-only stays end-only.
        indexes = (list(own) + sorted(active - own.keys()) if kind == "h3_i2v"
                   else list(range(max(active) + 1)) if active else [])
        self.reference_ids = [("start_image" if index == 0 else "end_image") if kind == "h3_i2v"
                              else f"ref_image_{index}" if kind == "h3_ref" else f"image_{index + 1}" for index in indexes]
        return [own.get(index, "") for index in indexes], [("start" if index == 0 else "end") if kind == "h3_i2v" else own_roles.get(index, "reference") for index in indexes]

    def complete_receipt(self, graph, kind, refine):
        """Describe literals emitted by the shared recipe, never guessed slots."""
        positive_nodes, negative_nodes = set(), set()
        for node in graph.nodes.values():
            inputs = node["inputs"]
            if node["class_type"] == "KSampler":
                positive_nodes.add(inputs["positive"][0])
                negative_nodes.add(inputs["negative"][0])
            elif node["class_type"] == "BasicGuider":
                positive_nodes.add(inputs["conditioning"][0])
        sampler_index = lora_index = 0
        for node_id, node in graph.nodes.items():
            name, inputs, ref = node["class_type"], node["inputs"], [node_id, 0]
            mappings = {}
            if name == "CheckpointLoaderSimple":
                mappings["ckpt_name"] = ("models.checkpoint", "select")
            elif name == "UNETLoader":
                mappings["unet_name"] = ("models.dit", "select")
            elif name == "CLIPLoader":
                mappings["clip_name"] = ("models.text_encoder", "select")
            elif name == "DualCLIPLoader":
                mappings.update(clip_name1=("models.sdxl_clip_l", "select"), clip_name2=("models.sdxl_clip_g", "select"))
            elif name == "CLIPTextEncode":
                logical = "positive" if node_id in positive_nodes else "negative" if node_id in negative_nodes else None
                if logical:
                    mappings["text"] = (logical, "text")
            elif name in {"MiniMaxH3ImageToVideo", "MiniMaxH3ReferenceToVideo", "TextEncodeKrea2OstrisEdit", "TextEncodeQwenImage21"}:
                mappings["prompt"] = ("positive", "text")
                for field, logical, field_type in (("negative_prompt", "negative", "text"), ("resolution", "ref_resolution", "integer"),
                        ("width", "width", "integer"), ("height", "height", "integer"), ("length", "frames", "integer"),
                        ("ref_image_size", "ref_image_size", "select")):
                    if field in inputs:
                        mappings[field] = (logical, field_type)
            if name in {"LoraLoader", "LoraLoaderModelOnly", "LoraLoaderBypassModelOnly"}:
                mappings["lora_name"] = (f"loras.{lora_index}.name", "select")
                mappings["strength_model"] = (f"loras.{lora_index}.strength_model", "number")
                if "strength_clip" in inputs:
                    mappings["strength_clip"] = (f"loras.{lora_index}.strength_clip", "number")
                lora_index += 1
            if name == "KSampler":
                mappings.update(seed=("seed", "integer"), cfg=("cfg", "number"),
                                sampler_name=("sampler", "select"), scheduler=("scheduler", "select"))
                mappings["steps"] = ("refine.steps" if sampler_index else "steps", "integer")
                mappings["denoise"] = ("refine.denoise" if sampler_index else "denoise", "number")
                sampler_index += 1
            if name in {"MiniMaxH3SigmaShift", "MiniMaxH3DualClockSamplerT8"}:
                mappings.update(shift_video=("shift_video", "number"), shift_audio=("shift_audio", "number"))
                if "steps" in inputs:
                    mappings.update(steps=("steps", "integer"), sampler_name=("sampler", "select"), scheduler=("scheduler", "select"))
            if name == "RandomNoise":
                mappings["noise_seed"] = ("seed", "integer")
            if name in {"ImageScale", "EmptyLatentImage", "EmptySD3LatentImage", "LatentUpscale"}:
                prefix = "refine." if name == "LatentUpscale" else ""
                mappings.update(width=(prefix + "width", "integer"), height=(prefix + "height", "integer"))
                if name == "LatentUpscale":
                    mappings["upscale_method"] = ("refine.upscale_method", "select")
            if name == "CreateVideo":
                mappings["fps"] = ("fps", "number")
            for field, (logical, field_type) in mappings.items():
                graph.bind(ref, field, logical, field_type)
        by_target = {(target["node_id"], target["input"]): logical for logical, item in graph.receipt.items() for target in item["targets"]}
        for issue in self.pending:
            logical = by_target.get((issue.get("node_id"), issue.get("input")))
            if logical:
                issue["logical_id"] = logical


def build_preset_editor_recipe(request: dict, object_info: dict, *, reference_slots=None,
                               input_intents=None, model_intents=None) -> dict:
    """Materialize an own-value-only editable graph without uploads or inference.

    Empty/stale resources remain literal holes. Structural schema uncertainty
    returns blocked with the complete original request and no partial graph.
    Intent describes topology only; connected values must be projected later.
    """
    if not isinstance(request, dict) or not isinstance(object_info, dict):
        raise ValueError("请求和节点能力必须是对象")
    from .packages import encoded
    encoded(request)
    source_request = copy.deepcopy(request)
    editor = _PresetEditorRecipe(reference_slots, input_intents, model_intents)
    kind = request.get("kind", "h3_t2v")
    if kind not in {"h3_t2v", "h3_i2v", "h3_ref", "krea", "sdxl", "sdxl_i2i", "qwen21_t2i", "qwen21_edit"}:
        raise ValueError("纯编辑预设只支持 8 种内置生成类型")
    if kind not in {"sdxl", "sdxl_i2i"} and any(editor.model_intents.values()):
        raise ValueError("外置编码器与独立 VAE 意图仅用于 SDXL")
    models = request.get("models", {})
    if not isinstance(models, dict):
        raise ValueError("models 必须是模型角色对象")
    allowed_roles = {"checkpoint", "dit", "text_encoder", "vae", "audio_vae", "lora", "sdxl_clip_l", "sdxl_clip_g"}
    if set(models) - allowed_roles:
        raise ValueError("models 包含不支持的模型角色")
    for value in models.values():
        editor.resource_name(value)
    for item in _lora_specs(request, kind, allow_empty=True):
        editor.resource_name(item["name"])
    editor.references(request, kind)  # Validate all own names and intent before schema failures.
    result = {"source_request": source_request, "prompt": None, "summary": None,
              "receipt": [], "pending": [], "status": "blocked", "blocked": [],
              "intents": {"reference_slots": copy.deepcopy(reference_slots),
                          "input_intents": dict(editor.input_intents),
                          "model_intents": dict(editor.model_intents)}}
    try:
        built = _build_preset_recipe(request, object_info, editor=editor)
    except _RecipeBlocked as error:
        result["blocked"] = [{"code": error.code, "message": str(error)}]
    else:
        result.update(built, status="materialized", pending=editor.pending)
        if not request.get("positive", "").strip():
            result["pending"].append({"logical_id": "positive", "code": "missing_input", "message": "正向提示词尚未填写"})
        if editor.input_intents.get("negative") and not any(item["logical_id"] == "negative" for item in result["receipt"]):
            result["pending"].append({"logical_id": "negative", "code": "unsupported_input",
                                      "message": "当前采样分支不使用负向提示词；未将外部负向连接写入原图"})
    encoded(result)
    return result


def compile_workflow(request: dict, object_info: dict) -> dict:
    """Compile execution through the same recipe used for pure editing."""
    return _build_preset_recipe(request, object_info)


def _build_preset_recipe(request: dict, object_info: dict, *, editor=None) -> dict:
    if not isinstance(request, dict) or not isinstance(object_info, dict):
        raise ValueError("请求和节点能力必须是对象")
    kind = request.get("kind", "h3_t2v")
    if not isinstance(kind, str):
        raise ValueError("生成类型 kind 必须为文本")
    if kind == "api":
        # Python equality equates True with 1, unlike the browser's JSON model.
        def check_carriers(document):
            if isinstance(document, dict) and "prompt" in document and "workflow" in document:
                if all(isinstance(node, dict) and isinstance(node.get("class_type"), str)
                       and isinstance(node.get("inputs"), dict) for node in document.values()):
                    return
                if not api_carriers_equal(document["prompt"], document["workflow"]):
                    raise ValueError("JSON 同时包含不同的 prompt 和 workflow 内容；请明确所需的单一 API 图")

        check_carriers(request)
        prompt = request.get("prompt", request.get("workflow"))
        check_carriers(prompt)
        if isinstance(prompt, dict) and isinstance(prompt.get("prompt"), dict) and "class_type" not in prompt["prompt"]:
            prompt = prompt["prompt"]
        validate_prompt(prompt, object_info)
        return {"prompt": copy.deepcopy(prompt), "summary": {"kind": kind, "nodes": len(prompt), "warnings": []}}
    qwen21 = kind in {"qwen21_t2i", "qwen21_edit"}
    qwen21_edit = kind == "qwen21_edit"
    if kind not in {"h3_t2v", "h3_i2v", "h3_ref", "krea", "sdxl", "sdxl_i2i", "qwen21_t2i", "qwen21_edit"}:
        raise ValueError("不支持的生成类型")
    positive, negative = request.get("positive", ""), request.get("negative", "")
    if not isinstance(positive, str) or (not positive.strip() and editor is None) or not isinstance(negative, str):
        raise ValueError("请填写非空正向提示词；反向提示词必须为文本")
    if len(positive) > 100000 or len(negative) > 100000:
        raise ValueError("提示词长度不能超过 100000 字符")
    models = request.get("models", {})
    if not isinstance(models, dict):
        raise ValueError("models 必须是模型角色对象")
    h3 = kind.startswith("h3_")
    sdxl = kind in {"sdxl", "sdxl_i2i"}
    external_clip_roles = {"sdxl_clip_l", "sdxl_clip_g"}
    if not sdxl and any(role in models for role in external_clip_roles):
        raise ValueError("外置 SDXL CLIP 只支持 SDXL 文生图和图生图")
    if sdxl and ({"clip_l", "clip_g", "text_encoder"} & models.keys()):
        raise ValueError("SDXL 外置编码器请使用 models.sdxl_clip_l 与 models.sdxl_clip_g 成对选择")
    if qwen21 and any(role not in {"dit", "text_encoder", "vae", "lora"} for role in models):
        raise ValueError("Qwen Image 2.1 models 只支持 dit、text_encoder、vae 和 model-only LoRA")
    width = _number(request, "width", 736 if h3 else 1024, 32, 8192, True)
    height = _number(request, "height", 416 if h3 else 1024, 32, 8192, True)
    alignment = 32 if h3 or qwen21 else 16 if kind == "krea" else 8
    if width % alignment or height % alignment:
        raise ValueError(f"宽高必须为 {alignment} 的倍数")
    seed = _number(request, "seed", 0, 0, 2**64 - 1, True)
    step_default = 40 if kind == "qwen21_t2i" else 25 if qwen21_edit else 20 if kind != "krea" else 8
    steps = _number(request, "steps", step_default, 1, 1000, True)
    cfg = _number(request, "cfg", 7.0 if sdxl else 1.0, 0, 100)
    denoise = _number(request, "denoise", 1.0, 0, 1)
    ref_resolution = _number(request, "ref_resolution", 1024, 0, 4096, True) if qwen21 else 1024
    custom_size = request.get("custom_size", False) if qwen21 else False
    if qwen21:
        if ref_resolution % 32:
            raise ValueError("ref_resolution 必须为 32 的倍数")
        if type(custom_size) is not bool:
            raise ValueError("custom_size 必须为布尔值")
        if custom_size and not qwen21_edit:
            raise ValueError("custom_size 只支持 Qwen Image 2.1 编辑模式")
    if editor is None:
        refs = _reference_names(request)
        roles = _reference_roles(request, kind, refs)
    else:
        refs, roles = editor.references(request, kind)
    available = catalog(object_info) if editor is None else {}
    graph = _Graph(object_info, editor)
    choose_model = editor.model if editor else _model
    summary = {"kind": kind, "width": width, "height": height, "seed": seed,
               "steps": steps, "cfg": cfg, "warnings": [], "models": {}}
    if qwen21:
        summary["ref_resolution"] = ref_resolution
    if qwen21_edit and not custom_size:
        summary.update(width=None, height=None, requested_width=width, requested_height=height,
                       size_mode="first_reference")
    elif qwen21_edit:
        summary["size_mode"] = "custom"
    warnings = summary["warnings"]
    if steps > 100:
        warnings.append("较高步数将显著增加推理计算量，更多步数不保证生成质量更好。")
    if cfg == 0:
        warnings.append("ComfyUI KSampler 的 CFG=0 使用负向条件，不跟随正向提示词。")
    elif cfg == 1 and negative.strip():
        warnings.append("CFG=1 不启用额外负向引导；反向提示词不会参与标准 KSampler 的引导。")
    loras = _lora_specs(request, kind, allow_empty=editor is not None)
    if denoise < 1 and not refs:
        raise ValueError("低于 1 的 denoise 需要输入图片")
    if kind == "h3_t2v" and refs:
        raise ValueError("文生视频不接收参考图，请选择图生视频或参考生视频")
    if kind == "qwen21_t2i" and refs:
        raise ValueError("Qwen Image 2.1 文生图不接收参考图")
    if qwen21_edit and not 1 <= len(refs) <= 10:
        raise ValueError("Qwen Image 2.1 条件编辑需要 1–10 张参考图")
    if qwen21 and denoise != 1:
        raise ValueError("Qwen Image 2.1 条件生成固定使用 denoise=1")
    if qwen21 and any(role != "reference" for role in roles):
        raise ValueError("Qwen Image 2.1 参考图按数组顺序传入，reference_roles 只能使用 reference")
    if kind == "h3_i2v" and not 1 <= len(refs) <= 2:
        raise ValueError("图生视频需要 1–2 张图片，可按角色指定首帧或尾帧")
    if kind == "h3_ref" and not 1 <= len(refs) <= 9:
        raise ValueError("参考生视频需要 1–9 张参考图")
    if kind == "krea" and len(refs) > 3:
        raise ValueError("Krea2 图像编辑最多使用 3 张参考图")
    if kind == "sdxl_i2i" and len(refs) != 1:
        raise ValueError("SDXL 图生图必须提供一张输入图")
    if sdxl and len(refs) > 1:
        raise ValueError("SDXL 图生图只使用一张输入图")
    refine = _normalize_refine(request, kind, object_info, width, height, steps, editor=editor)
    if refine:
        summary["refine"] = {key: value for key, value in refine.items() if key != "crop"}

    if sdxl:
        checkpoint = choose_model(models, "checkpoint", available, ("sdxl", "_xl", "xl_", "xl.", "pony", "illustrious", "illust"))
        _check_family(checkpoint, "checkpoint", kind)
        summary["models"]["checkpoint"] = checkpoint
        model = graph.add("CheckpointLoaderSimple", ckpt_name=checkpoint)
        clip, vae = [model[0], 1], [model[0], 2]
        clip_l = models.get("sdxl_clip_l")
        clip_g = models.get("sdxl_clip_g")
        if editor is None and bool(clip_l) != bool(clip_g):
            raise ValueError("SDXL 外置 CLIP-L 和 CLIP-G 必须成对选择")
        if (clip_l and clip_g) or (editor and (clip_l or clip_g or editor.model_intents.get("sdxl_external_clip"))):
            if editor is None:
                clip_capability = _sdxl_clip_options(object_info)
                if not clip_capability["available"]:
                    raise ValueError(clip_capability["reason"])
            clip_l = choose_model(models, "sdxl_clip_l", available)
            clip_g = choose_model(models, "sdxl_clip_g", available)
            _check_family(clip_l, "sdxl_clip_l", kind)
            _check_family(clip_g, "sdxl_clip_g", kind)
            clip = graph.add("DualCLIPLoader", clip_name1=clip_l, clip_name2=clip_g, type="sdxl")
            summary["models"].update(sdxl_clip_l=clip_l, sdxl_clip_g=clip_g)
        if models.get("vae") or (editor and editor.model_intents.get("independent_vae")):
            vae_name = choose_model(models, "vae", available)
            _check_family(vae_name, "vae", kind)
            vae = graph.add("VAELoader", vae_name=vae_name)
            graph.bind(vae, "vae_name", "models.vae", "select")
            summary["models"]["vae"] = vae_name
    else:
        dit_tokens = (("qwen_image_2.1", "qwen_image_2_1") if qwen21 else
                      ("ref2va",) if kind == "h3_ref" else ("fl2va",) if h3 else ("krea2",))
        encoder_tokens = (("qwen3vl_8b",) if qwen21 else ("minimax_h3",) if h3 else ("qwen3vl_4b",))
        vae_tokens = (("qwen_image_2.1_vae", "qwen_image_2_1_vae") if qwen21 else
                      ("minimax_h3_video_vae",) if h3 else ("qwen_image_vae",))
        dit = choose_model(models, "dit", available, dit_tokens, ("pruned",) if h3 and not loras else ())
        text_encoder = choose_model(models, "text_encoder", available, encoder_tokens, ("nvfp4",) if h3 else ())
        vae_name = choose_model(models, "vae", available, vae_tokens)
        for role, name in (("dit", dit), ("text_encoder", text_encoder), ("vae", vae_name)):
            _check_family(name, role, kind)
            if qwen21 and name and not name.lower().endswith(".safetensors"):
                raise ValueError(f"Qwen Image 2.1 的 {role} 目前只支持标准加载器列出的 safetensors 模型")
        summary["models"].update(dit=dit, text_encoder=text_encoder, vae=vae_name)
        model = graph.add("UNETLoader", unet_name=dit, weight_dtype="default")
        clip = graph.add("CLIPLoader", clip_name=text_encoder,
                         type="minimax" if h3 else "qwen_image" if qwen21 else "krea2")
        vae = graph.add("VAELoader", vae_name=vae_name)
        graph.bind(vae, "vae_name", "models.vae", "select")
    for item in loras:
        lora = item["name"]
        if editor:
            editor.resource_name(lora)
        if editor is None and lora not in available["lora"]:
            raise ValueError("所选 LoRA 未被后端列出")
        _check_family(lora, "lora", kind)
        if sdxl:
            model = graph.add("LoraLoader", model=model, clip=clip, lora_name=lora,
                              strength_model=item["strength_model"], strength_clip=item["strength_clip"])
            clip = [model[0], 1]
        else:
            if editor and not summary["models"]["dit"]:
                raise _RecipeBlocked("主模型尚未选择，无法证明 model-only LoRA 的量化加载分支", code="unresolved_branch")
            quantized = any(token in summary["models"]["dit"].lower() for token in ("int8", "fp8", "nvfp4", "gguf"))
            if h3 and "pruned" in summary["models"]["dit"].lower():
                warnings.append("官方新版模板包含 pruned H3 与配套 Turbo LoRA；所选版本组合仍需当前后端实际加载验证。")
            if h3 and ((kind == "h3_ref" and "fl2v" in lora.lower()) or
                       (kind != "h3_ref" and "ref2v" in lora.lower())):
                raise ValueError("H3 LoRA 与当前 FL2VA / Ref2VA 基模类型不匹配")
            loader = "LoraLoaderBypassModelOnly" if quantized and "LoraLoaderBypassModelOnly" in object_info else "LoraLoaderModelOnly"
            if quantized and loader == "LoraLoaderModelOnly":
                warnings.append("量化基模使用后端原生 LoRA 加载器，具体权重组合需生成验证。")
            model = graph.add(loader, model=model, lora_name=lora, strength_model=item["strength_model"])
    if len(loras) == 1:
        summary["models"]["lora"] = loras[0]["name"]  # Old clients still display one selected LoRA.
    if loras:
        warnings.append("LoRA 文件名与节点校验不能证明权重兼容；多 LoRA 组合的效果和显存需求需实际生成验证。")
    images = []
    for index, name in enumerate(refs):
        image = graph.add("LoadImage", image=name)
        images.append(image)
        logical_id = editor.reference_ids[index] if editor else ""
        graph.bind(image, "image", logical_id, "image")
    sampler = request.get("sampler", "euler")
    scheduler = request.get("scheduler", "simple")
    if not isinstance(sampler, str) or not isinstance(scheduler, str):
        raise ValueError("sampler 和 scheduler 必须为文本选项")

    if h3:
        if denoise != 1:
            raise ValueError("H3 首尾帧/参考条件模式使用 denoise=1；低噪声重绘需要专用 API 工作流")
        if width * height > 1920 * 1088:
            raise ValueError("H3 画布面积不能超过 1920×1088")
        fps = _number(request, "fps", 24, 1, 120)
        if fps != 24:
            raise ValueError("H3 原生生成帧率固定为 24 fps")
        seconds = _number(request, "seconds", 5, 5 / 24, 150)
        frames = max(5, math.ceil((seconds * 24 - 5) / 17) * 17 + 5)
        conditioning_type = "MiniMaxH3ReferenceToVideo" if kind == "h3_ref" else "MiniMaxH3ImageToVideo"
        if editor:
            editor.schema(object_info, conditioning_type)
        length_spec = object_info.get(conditioning_type, {}).get("input", {}).get("required", {}).get("length", ["INT", {}])
        frame_meta = editor.definition(length_spec, conditioning_type + ".length")[1] if editor else _spec(length_spec)[1]
        if editor and (type(frame_meta.get("max", 3600)) not in (int, float) or not math.isfinite(frame_meta.get("max", 3600))):
            raise _RecipeBlocked("H3 后端帧数上限定义无效")
        frame_limit = min(3600, frame_meta.get("max", 3600))
        if frames > frame_limit:
            frames = math.floor((frame_limit - 5) / 17) * 17 + 5
            if frames < 5:
                raise ValueError("当前后端没有可用的 H3 合法帧数")
            warnings.append(f"请求时长触及后端帧数上限，已使用最大合法 {frames} 帧，实际 {frames / 24:.3f} 秒。")
        summary.update(frames=frames, fps=24, seconds=frames / 24, requested_seconds=seconds)
        if not 124 <= frames <= 362:
            warnings.append("H3 帧数超出约 124–362 帧的训练范围，生成质量和显存需求需实测。")
        if width * height > 1344 * 768:
            warnings.append("此画布超过约百万像素，16 GB 显存不保证可运行。")
        if not math.isclose(frames / 24, seconds):
            warnings.append(f"H3 按 17n+5 对齐为 {frames} 帧，实际 {frames / 24:.3f} 秒。")
        if steps < 16 and not loras:
            warnings.append("当前未应用加速 LoRA；低步数仅供预览，画质与音质未保证。")
        audio_name = choose_model(models, "audio_vae", available, ("minimax_h3_audio_vae",))
        _check_family(audio_name, "audio_vae", kind)
        summary["models"]["audio_vae"] = audio_name
        audio_vae = graph.add("VAELoader", vae_name=audio_name)
        graph.bind(audio_vae, "vae_name", "models.audio_vae", "select")
        conditioning_inputs = dict(clip=clip, vae=vae, prompt=positive, width=width, height=height, length=frames)
        if kind == "h3_ref":
            conditioning_inputs.update(audio_vae=audio_vae, ref_image_size=request.get("ref_image_size", "match"))
            ref_schema = object_info.get("MiniMaxH3ReferenceToVideo", {})
            definition = ref_schema.get("input", {}).get("optional", {}).get("ref_images")
            parsed = editor.definition(definition, "MiniMaxH3ReferenceToVideo.ref_images") if editor else _spec(definition) if definition else (None, {})
            if not definition or parsed[0] != "COMFY_AUTOGROW_V3":
                raise (_RecipeBlocked if editor else ValueError)("后端参考图节点没有兼容的动态图片输入")
            template = parsed[1].get("template", {})
            names = (editor.dynamic_names(template, len(images), "MiniMaxH3ReferenceToVideo") if editor else
                     template.get("names") or [template.get("prefix", "ref_image_") + str(i) for i in range(template.get("max", 0))])
            if len(images) > len(names):
                raise (_RecipeBlocked if editor else ValueError)("参考图数量超过当前后端限制")
            for name, image in zip(names, images):
                conditioning_inputs["ref_images." + name] = image
            conditioning = graph.add("MiniMaxH3ReferenceToVideo", **conditioning_inputs)
        else:
            for role, image in zip(roles, images):
                conditioning_inputs["first_frame" if role == "start" else "last_frame"] = image
            conditioning = graph.add("MiniMaxH3ImageToVideo", **conditioning_inputs)
        latent = [conditioning[0], 1]
        shift_video = _number(request, "shift_video", 12, 0.01, 100)
        shift_audio = _number(request, "shift_audio", 3, 0.01, 100)
        if sampler == "dual_clock_euler":
            if cfg != 1:
                raise ValueError("双时钟 BasicGuider 模式要求 cfg=1")
            if negative.strip():
                raise ValueError("双时钟 BasicGuider 不使用反向提示词，请清空或改用原生采样器")
            if scheduler == "simple" and "scheduler" not in request:
                scheduler = "native_flow"
            clocks = graph.add("MiniMaxH3DualClockSamplerT8", model=model, av_latent=latent,
                               steps=steps, shift_video=shift_video, shift_audio=shift_audio,
                               sampler_name=sampler, scheduler=scheduler)
            noise = graph.add("RandomNoise", noise_seed=seed)
            guider = graph.add("BasicGuider", model=clocks, conditioning=conditioning)
            sampled = graph.add("SamplerCustomAdvanced", noise=noise, guider=guider,
                                sampler=[clocks[0], 1], sigmas=[clocks[0], 2], latent_image=latent)
        else:
            shifted = graph.add("MiniMaxH3SigmaShift", model=model, shift_video=shift_video, shift_audio=shift_audio)
            if negative.strip() or (editor and editor.input_intents.get("negative")):
                negative_conditioning = graph.add("CLIPTextEncode", clip=clip, text=negative)
            else:
                negative_conditioning = graph.add("ConditioningZeroOut", conditioning=conditioning)
            sampled = graph.add("KSampler", model=shifted, seed=seed, steps=steps, cfg=cfg,
                                sampler_name=sampler, scheduler=scheduler, positive=conditioning,
                                negative=negative_conditioning, latent_image=latent, denoise=1.0)
        if {"LTXVSeparateAVLatent", "VAEDecode", "VAEDecodeAudio"} <= object_info.keys():
            split = graph.add("LTXVSeparateAVLatent", av_latent=sampled)
            decoded_images = graph.add("VAEDecode", samples=split, vae=vae)
            decoded_audio = graph.add("VAEDecodeAudio", samples=[split[0], 1], vae=audio_vae)
        else:
            decoded_images = graph.add("MiniMaxH3AVDecodeT8", av_latent=sampled, video_vae=vae, audio_vae=audio_vae)
            decoded_audio = [decoded_images[0], 1]
        video = graph.add("CreateVideo", images=decoded_images, fps=24.0, audio=decoded_audio)
        if editor and "SaveVideo" not in object_info:
            raise _RecipeBlocked("后端缺少节点 SaveVideo")
        save_schema = object_info["SaveVideo"]
        if editor:
            editor.schema(object_info, "SaveVideo")
        save_inputs = {"video": video, "filename_prefix": "FrameWeave/video", "format": "mp4"}
        try:
            save_fields, _ = _expanded_inputs(save_schema, save_inputs)
        except (AttributeError, TypeError, ValueError) as error:
            if editor:
                raise _RecipeBlocked(str(error)) from error
            raise
        codec_field = next((name for name in ("format.codec", "codec") if name in save_fields), None)
        if codec_field is not None:
            codec_kind, codec_meta = (editor.definition(save_fields[codec_field], "SaveVideo." + codec_field)
                                      if editor else _spec(save_fields[codec_field]))
            if isinstance(codec_kind, list):
                codec_options = codec_kind
            elif codec_kind == "COMFY_DYNAMICCOMBO_V3":
                codec_options = [option["key"] for option in codec_meta.get("options", [])]
            elif codec_kind == "COMBO":
                codec_options = codec_meta.get("options", [])
            else:
                codec_options = []
            codec = next((option for option in ("h264", "auto") if option in codec_options),
                         codec_options[0] if codec_options else None)
            if codec is not None:
                save_inputs[codec_field] = codec
        graph.add("SaveVideo", **save_inputs)
    elif qwen21:
        encoder_inputs = {"clip": clip, "prompt": positive, "negative_prompt": negative,
                          "resolution": ref_resolution}
        if qwen21_edit:
            if editor:
                editor.schema(object_info, "TextEncodeQwenImage21")
            edit_schema = object_info.get("TextEncodeQwenImage21", {})
            definition = edit_schema.get("input", {}).get("required", {}).get("images")
            parsed = editor.definition(definition, "TextEncodeQwenImage21.images") if editor else _spec(definition) if definition is not None else (None, {})
            if definition is None or parsed[0] != "COMFY_AUTOGROW_V3":
                raise (_RecipeBlocked if editor else ValueError)("TextEncodeQwenImage21 没有兼容的动态图片输入")
            encoder_inputs["vae"] = vae
            template = parsed[1].get("template", {})
            names = editor.dynamic_names(template, len(images), "TextEncodeQwenImage21") if editor else template.get("names")
            if names is None:
                maximum = template.get("max", 0)
                prefix = template.get("prefix", "image_")
                if type(maximum) is not int or not 0 <= maximum <= 1000 or not isinstance(prefix, str):
                    raise (_RecipeBlocked if editor else ValueError)("Qwen Image 2.1 动态图片输入定义无效")
                names = [prefix + str(index) for index in range(maximum)]
            if not isinstance(names, list) or len(names) < len(images):
                raise (_RecipeBlocked if editor else ValueError)("参考图数量超过当前后端 Qwen Image 2.1 限制")
            for name, image in zip(names[:len(images)], images):
                encoder_inputs["images." + name] = image
        conditioning = graph.add("TextEncodeQwenImage21", **encoder_inputs)
        latent = [conditioning[0], 2] if qwen21_edit and not custom_size else graph.add(
            "EmptyLatentImage", width=width, height=height, batch_size=1)
        sampled = graph.add("KSampler", model=model, seed=seed, steps=steps, cfg=cfg,
                            sampler_name=sampler, scheduler=scheduler, positive=[conditioning[0], 0],
                            negative=[conditioning[0], 1], latent_image=latent, denoise=1.0)
        decoded = graph.add("VAEDecode", samples=sampled, vae=vae)
        graph.add("SaveImage", images=decoded, filename_prefix="FrameWeave/image")
    else:
        if kind == "krea" and images:
            model = graph.add("Krea2OstrisEditModelPatch", model=model)
            inputs = {"clip": clip, "prompt": positive, "vae": vae}
            inputs.update({"image" + str(index + 1): image for index, image in enumerate(images)})
            conditioning = graph.add("TextEncodeKrea2OstrisEdit", **inputs)
        else:
            conditioning = graph.add("CLIPTextEncode", clip=clip, text=positive)
        if kind == "krea" and not negative.strip() and not (editor and editor.input_intents.get("negative")):
            negative_conditioning = graph.add("ConditioningZeroOut", conditioning=conditioning)
        else:
            negative_conditioning = graph.add("CLIPTextEncode", clip=clip, text=negative)
        if images and (sdxl or denoise < 1):
            image = graph.add("ImageScale", image=images[0], upscale_method="lanczos", width=width, height=height, crop="center")
            latent = graph.add("VAEEncode", pixels=image, vae=vae)
        else:
            latent = graph.add("EmptySD3LatentImage" if kind == "krea" else "EmptyLatentImage",
                               width=width, height=height, batch_size=1)
        sampled = graph.add("KSampler", model=model, seed=seed, steps=steps, cfg=cfg,
                            sampler_name=sampler, scheduler=scheduler, positive=conditioning,
                            negative=negative_conditioning, latent_image=latent, denoise=denoise)
        if refine:
            upscaled = graph.add("LatentUpscale", samples=sampled, upscale_method=refine["upscale_method"],
                                 width=refine["width"], height=refine["height"], crop=refine["crop"])
            sampled = graph.add("KSampler", model=model, seed=seed, steps=refine["steps"], cfg=cfg,
                                sampler_name=sampler, scheduler=scheduler, positive=conditioning,
                                negative=negative_conditioning, latent_image=upscaled,
                                denoise=refine["denoise"])
            if refine["width"] * refine["height"] > 1024 * 1024:
                warnings.append("二次重绘超过约百万像素，显存与耗时会明显增加；实际可运行性取决于所选模型和后端。")
        decoded = graph.add("VAEDecode", samples=sampled, vae=vae)
        graph.add("SaveImage", images=decoded, filename_prefix="FrameWeave/image")
    if editor is None:
        validate_prompt(graph.nodes, object_info)
    else:
        try:
            issues = validate_editor_prompt(graph.nodes, object_info)["issues"]
        except (AttributeError, TypeError, ValueError) as error:
            if "选项不在当前后端" in str(error) or "超出后端允许的数值范围" in str(error):
                raise
            raise _RecipeBlocked(str(error)) from error
        editor.pending.extend(issues)
        editor.complete_receipt(graph, kind, refine)
    summary.update(nodes=len(graph.nodes), sampler=sampler, scheduler=scheduler,
                   references=len(refs), reference_roles=roles, denoise=denoise, loras=loras)
    result = {"prompt": graph.nodes, "summary": summary}
    if editor:
        result["receipt"] = list(graph.receipt.values())
    return result
