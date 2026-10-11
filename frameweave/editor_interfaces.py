"""Pure helpers for exposing editable API inputs and selecting editor outputs.

These functions inspect and reshape data only. They never contact a ComfyUI
backend or submit a generation request.
"""

from __future__ import annotations

import copy
import hashlib
import math

from .media_contract import media_input_contract
from .packages import (ID, RESERVED, TYPES, MAX_INTERFACE_FIELDS, MAX_INSPECTION_FIELDS, MODEL_INPUTS, encoded, inspect_document,
                       is_link, normalize_fields, normalize_prompt, scalar, validate_value, validate_inspection_result)
from .workflows import (_check_json_limits, _expanded_inputs, _spec,
                        validate_editor_prompt, validate_prompt)


_KNOWN_OUTPUTS = {
    "SaveImage": "image",
    "SaveVideo": "video",
    "VHS_VideoCombine": "video",
    "SaveAudio": "audio",
}
_TYPE_GROUPS = {
    "prompt": "提示词",
    "seed": "随机种子",
    "model": "模型",
    "encoder": "编码器",
    "lora": "LoRA",
    "sampling": "采样参数",
    "size": "尺寸与时长",
    "custom": "其他参数",
    "media": "参考素材",
}


def _role(field, node_type, node_title="", *, schema=None):
    if field.get("type") == "video":
        return "video_reference", _TYPE_GROUPS["media"]
    if field.get("type") in {"image", "audio"}:
        return field["type"] + "_reference", _TYPE_GROUPS["media"]
    name = field["input"].lower()
    label = field.get("label", "")
    node_name = node_type.lower()
    title = node_title.lower()
    if (name in {"negative", "negative_prompt"} or
            label.startswith("负向提示词") or "negative" in title or "负向" in title):
        return "negative_prompt", "提示词"
    if (name in {"positive", "positive_prompt"} or
            label.startswith("正向提示词") or "positive" in title or "正向" in title):
        return "positive_prompt", "提示词"
    if name in {"text", "prompt", "prompt_text"} or "prompt" in name:
        return "prompt", "提示词"
    # Music/image conditioning can use caption or lyrics instead of prompt.
    # Require the live conditioning contract, so subtitle/export metadata and
    # arbitrary labels do not turn into prompt ports merely by their name.
    if (name in {"caption", "lyrics"} and field.get("type") == "text"
            and isinstance(schema, dict) and schema.get("output_node") is not True
            and "CONDITIONING" in _schema_outputs(schema)):
        return "prompt", "提示词"
    if "lora" in name or "lora" in node_name:
        return "lora", "LoRA"
    if any(token in name for token in ("clip", "encoder", "t5", "tokenizer")):
        return "encoder", "编码器"
    if name in MODEL_INPUTS or any(token in name for token in ("checkpoint", "ckpt", "unet", "vae", "model")):
        return "model", "模型"
    if name in {"seed", "noise_seed", "random_seed"} or name.endswith("_seed"):
        return "seed", "随机种子"
    if name in {"width", "height", "batch_size", "length", "frames", "seconds", "fps", "duration", "max_duration"}:
        return "size", "尺寸与时长"
    if name in {"steps", "cfg", "sampler", "sampler_name", "scheduler", "denoise", "eta"}:
        return "sampling", "采样参数"
    return "custom", _TYPE_GROUPS["custom"]


def _schema_outputs(schema):
    outputs = schema.get("output") if isinstance(schema, dict) else None
    if not isinstance(outputs, (list, tuple)):
        return []
    return [value.upper() for value in outputs if isinstance(value, str)]


def _media_type(node_type, schema):
    recognized = set()
    for output_type in _schema_outputs(schema):
        for media in ("image", "video", "audio"):
            if media.upper() in output_type:
                recognized.add(media)
    if len(recognized) == 1:
        return next(iter(recognized))
    if len(recognized) > 1:
        return "unknown"
    return _KNOWN_OUTPUTS.get(node_type, "unknown")


def _compatible_editor_literal(value, definition):
    """Conservative leaf-value check for dynamic-input name migrations."""
    kind, meta = _spec(definition)
    if kind == "COMFY_DYNAMICCOMBO_V3" or meta.get("multiselect"):
        return False
    options = kind if isinstance(kind, list) else meta.get("options") if kind == "COMBO" else None
    if options is not None:
        return isinstance(options, list) and any(type(value) is type(option) and value == option for option in options)
    if kind == "STRING":
        return isinstance(value, str)
    if kind == "BOOLEAN":
        return type(value) is bool
    if kind in ("INT", "FLOAT"):
        allowed = (int,) if kind == "INT" else (int, float)
        return (type(value) in allowed and math.isfinite(value)
                and ("min" not in meta or value >= meta["min"])
                and ("max" not in meta or value <= meta["max"]))
    return False


def normalize_editor_inputs(prompt, info):
    """Migrate unambiguous legacy scalar names into an active dynamic branch.

    An undeclared input ``codec`` may map to the sole missing active
    ``format.codec`` when its literal is legal in the live target schema.
    Existing declared names, linked inputs, ambiguous leaves, invalid values
    and dynamic selectors are never guessed. The caller still validates the
    whole resulting graph and handles changed public binding IDs explicitly.
    """
    normalize_prompt(prompt, check_dependencies=False)
    if not isinstance(info, dict):
        raise ValueError("后端节点信息须为对象")
    result, migrations = copy.deepcopy(prompt), []
    for node_id, node in result.items():
        schema = info.get(node["class_type"])
        if not isinstance(schema, dict):
            continue
        values = node["inputs"]
        specs, _ = _expanded_inputs(schema, values)
        dynamic = [name for name, definition in specs.items()
                   if _spec(definition)[0] == "COMFY_DYNAMICCOMBO_V3"]
        for old_name in list(values):
            value = values[old_name]
            if old_name in specs or type(value) not in (str, int, float, bool):
                continue
            matches = [name for name in specs if name.rsplit(".", 1)[-1] == old_name
                       and any(name.startswith(prefix + ".") for prefix in dynamic)]
            if len(matches) != 1:
                continue
            target = matches[0]
            if target in values:
                continue
            if not _compatible_editor_literal(value, specs[target]):
                continue
            values[target] = values.pop(old_name)
            migrations.append({"node_id": node_id, "input": old_name, "target_input": target,
                               "code": "dynamic_input_name",
                               "message": f"节点 {node_id} 的输入 {old_name} 已映射到当前接口 {target}"})
    return {"prompt": result, "migrations": migrations}


def _missing_input_field(node_id, node_type, name, definition):
    """Describe a missing scalar without synthesizing a graph value.

    A descriptor is deliberately separate from v1 package fields, whose
    binding and default must already exist in the graph. The optional default
    here is only a strictly valid, explicit live-schema suggestion.
    """
    kind, meta = _spec(definition)
    contract = media_input_contract(node_type, name, definition)
    if contract["supported"] or any(key in meta for key in
            ("image_upload", "audio_upload", "video_upload")):
        return None, "media_input"
    if meta.get("hidden") is True:
        return None, "hidden"
    if meta.get("forceInput") is True or meta.get("rawLink") is True:
        return None, "link_only"
    if meta.get("multiselect"):
        return None, "multiselect"

    options = None
    if kind == "COMFY_DYNAMICCOMBO_V3":
        # _expanded_inputs has already checked option keys and branch shapes.
        options = [option["key"] for option in meta["options"]]
    elif isinstance(kind, list):
        options = kind
    elif kind == "COMBO":
        options = meta.get("options")
        if not isinstance(options, list):
            return None, "invalid_options"
    if options is not None:
        if not options:
            return None, "empty_options"
        if (not isinstance(options, list) or len(options) > 512 or any(
                not scalar(option) or isinstance(option, str) and len(option) > 2048
                or type(option) in (int, float) and abs(option) > 9007199254740991
                for option in options)):
            return None, "invalid_options"
        field_type = "select"
    else:
        field_type = {"STRING": "text", "INT": "integer", "FLOAT": "number",
                      "BOOLEAN": "boolean"}.get(kind) if isinstance(kind, str) else None
        if field_type is None:
            return None, "unsupported_type"

    field = {"id": "f_" + hashlib.sha256((node_id + "\0" + name).encode()).hexdigest()[:16],
             "label": f"{name} · {node_id}", "node_id": node_id, "input": name,
             "type": field_type, "required": True, "missing": True}
    if options is not None:
        field["options"] = copy.deepcopy(options)
    if field_type in {"integer", "number"}:
        for bound in ("min", "max"):
            if bound in meta:
                value = meta[bound]
                if (type(value) not in (int, float) or not math.isfinite(value)
                        or abs(value) > 9007199254740991):
                    return None, "invalid_bounds"
                field[bound] = value
        if field.get("min", -math.inf) > field.get("max", math.inf):
            return None, "invalid_bounds"
    if "default" in meta and scalar(meta["default"]):
        try:
            validate_value(field, meta["default"], template=True)
        except ValueError:
            pass
        else:
            field["default"] = copy.deepcopy(meta["default"])
    return field, None


def preserve_interface_identity(fields, previous_fields=None):
    """Keep public identities only for unique exact live node/input/type bindings.

    Prior fields come from a validated stored package, never from a claimed
    client-side mapping. Only ID, label and explicit presentation are retained;
    defaults, options, ranges and all other live contracts remain fresh.
    """
    previous_fields = [] if previous_fields is None else previous_fields
    if (not isinstance(fields, list) or len(fields) > MAX_INSPECTION_FIELDS
            or not isinstance(previous_fields, list) or len(previous_fields) > MAX_INTERFACE_FIELDS):
        raise ValueError(f"接口身份候选和旧接口须为最多 {MAX_INTERFACE_FIELDS} 项")
    encoded(fields)
    encoded(previous_fields)

    def index(items):
        by_id, by_binding = {}, {}
        for field in items:
            if not isinstance(field, dict):
                raise ValueError("接口身份字段须为对象")
            field_id, node_id, name, kind = (field.get(key) for key in ("id", "node_id", "input", "type"))
            if (not isinstance(field_id, str) or not ID.fullmatch(field_id) or field_id in RESERVED
                    or not isinstance(node_id, str) or not node_id
                    or not isinstance(name, str) or not name
                    or not isinstance(kind, str) or kind not in TYPES):
                raise ValueError("接口身份 ID 或绑定无效")
            if field_id in by_id or (node_id, name) in by_binding:
                raise ValueError("接口身份 ID 或节点输入重复，不能安全保留")
            if "label" in field and (not isinstance(field["label"], str) or not field["label"].strip()
                                      or len(field["label"]) > 120):
                raise ValueError("接口身份名称无效")
            if "presentation" in field and field["presentation"] not in ("port", "control"):
                raise ValueError("接口身份展示方式无效")
            by_id[field_id] = field
            by_binding[(node_id, name)] = field
        return by_id, by_binding

    fresh_ids, _ = index(fields)
    old_ids, old_bindings = index(previous_fields)
    for field_id, field in fresh_ids.items():
        old = old_ids.get(field_id)
        if old is not None and (old["node_id"], old["input"]) != (field["node_id"], field["input"]):
            raise ValueError("候选接口 ID 与其他旧节点输入冲突，请明确重新配置")
    result, assigned_ids = [], set()
    for field in fields:
        current = copy.deepcopy(field)
        binding = (field["node_id"], field["input"])
        old = old_bindings.get(binding)
        if old is not None and old["type"] == field["type"]:
            current["id"] = old["id"]
            for key in ("label", "presentation"):
                if key in old:
                    current[key] = copy.deepcopy(old[key])
        previous_id_owner = old_ids.get(current["id"])
        if (current["id"] in assigned_ids or previous_id_owner is not None
                and (previous_id_owner["node_id"], previous_id_owner["input"]) != binding):
            raise ValueError("保留后的接口 ID 与其他节点输入冲突，请明确重新配置")
        assigned_ids.add(current["id"])
        result.append(current)
    return result


def inspect_interface(prompt, info, *, output_nodes=None, previous_fields=None):
    """Return the normalized API graph and all bounded outer-interface candidates.

    The returned prompt retains internal image/audio literals. Inspection uses a
    separate copy because portable package templates intentionally blank them.
    Missing required scalars are separate suggestions, not v1 package fields;
    neither their explicit schema defaults nor dynamic branches are applied.
    """
    normalized = normalize_prompt(prompt, check_dependencies=False)
    if not isinstance(info, dict):
        raise ValueError("后端节点信息须为对象")
    inspected = inspect_document({"prompt": copy.deepcopy(normalized)}, info,
                                 field_limit=None, check_dependencies=False)
    fields = copy.deepcopy(inspected["fields"])
    input_specs, missing_fields, missing_issues = {}, [], []
    for node_id, node in normalized.items():
        schema = info.get(node["class_type"])
        specs, required = (_expanded_inputs(schema, node["inputs"])
                           if isinstance(schema, dict) else ({}, set()))
        input_specs[node_id] = specs
        for name, definition in specs.items():
            if name not in required or name in node["inputs"]:
                continue
            field, reason = _missing_input_field(node_id, node["class_type"], name, definition)
            if field is not None:
                missing_fields.append(field)
            else:
                missing_issues.append({"node_id": node_id, "input": name,
                                       "code": "missing_input_uneditable", "reason": reason,
                                       "message": f"{node['class_type']}.{name} 缺少必填输入，无法通过标量参数修复"})
            if len(fields) + len(missing_fields) + len(missing_issues) > MAX_INSPECTION_FIELDS:
                raise ValueError("工作流候选输入超过 4096 项，请拆分工作流后检查")
    for field in fields + missing_fields:
        node = normalized[field["node_id"]]
        if field["type"] in {"image", "audio", "video"}:
            field["default"] = copy.deepcopy(node["inputs"][field["input"]])
        meta = prompt.get(field["node_id"], {}).get("_meta", {}) if isinstance(prompt, dict) else {}
        title = meta.get("title", "") if isinstance(meta, dict) else ""
        clean_title = title.strip() if isinstance(title, str) else ""
        schema = info.get(node["class_type"], {})
        stock_titles = {node["class_type"]}
        for key in ("display_name", "name"):
            stock_title = schema.get(key) if isinstance(schema, dict) else None
            if isinstance(stock_title, str):
                stock_titles.add(stock_title.strip())
        named_media = (field["type"] in {"image", "audio", "video"}
                       and clean_title not in stock_titles)
        if clean_title and (field["input"] == "value" or named_media):
            field["label"] = f"{clean_title[:100]} · {field['node_id']}"
        role, group = _role(field, node["class_type"], title if isinstance(title, str) else "", schema=schema)
        field["role"] = role
        field["group"] = group
        field["presentation"] = ("port" if field["type"] in {"image", "audio", "video"}
                                  or role in {"prompt", "positive_prompt", "negative_prompt"}
                                  and field["type"] == "text" else "control")
        specs = input_specs[field["node_id"]]
        kind, _ = _spec(specs[field["input"]]) if field["input"] in specs else (None, {})
        common = {"seed", "noise_seed", "random_seed", "steps", "cfg", "denoise",
                  "width", "height", "batch_size", "length", "frames", "seconds", "fps", "duration", "max_duration"}
        field["recommended"] = (field["type"] in {"image", "audio", "video"}
                                or kind == "STRING" and role in {"prompt", "positive_prompt", "negative_prompt"}
                                or kind in ("INT", "FLOAT") and (field["input"] in common or role == "lora")
                                or field["type"] == "select" and (role in {"model", "encoder", "lora"}
                                    or field["input"] in {"sampler", "sampler_name", "scheduler"}))

    outputs = []
    for node_id, node in normalized.items():
        node_type = node["class_type"]
        schema = info.get(node_type)
        if not isinstance(schema, dict) or schema.get("output_node") is not True:
            continue
        meta = prompt.get(node_id, {}).get("_meta", {}) if isinstance(prompt, dict) else {}
        title = meta.get("title") if isinstance(meta, dict) else None
        title = title.strip() if isinstance(title, str) else ""
        display_name = schema.get("display_name") or schema.get("name")
        label = title or (display_name if isinstance(display_name, str) and display_name.strip()
                          else f"{node_type} · {node_id}")
        outputs.append({"id": node_id, "label": label,
                        "mediaType": _media_type(node_type, schema)})
    execution = output_closure(normalized, output_nodes, info, allow_no_outputs=True)
    return validate_inspection_result({"prompt": normalized, "fields": preserve_interface_identity(fields, previous_fields), "missing_fields": missing_fields,
                                      "missing_issues": missing_issues, "outputs": outputs,
                                      "execution": execution, "warnings": execution["warnings"]})


def apply_missing_interface_values(prompt, info, values, *, output_nodes=None):
    """Apply explicit repairs only to current missing required scalar inputs.

    Missing selectors can activate additional submitted repairs on the next
    pass. Existing, inactive and unknown bindings are never overwritten or
    inferred; any leftover submission makes the whole operation fail. Repairs
    are limited to selected output ancestry, or all declared outputs by default.
    """
    # Validate the graph without replacing its complete editable source.
    # normalize_prompt intentionally strips editor metadata for execution.
    normalize_prompt(prompt, check_dependencies=False)
    result = copy.deepcopy(prompt)
    if not isinstance(info, dict):
        raise ValueError("后端节点信息须为对象")
    if (not isinstance(values, dict) or len(values) > MAX_INSPECTION_FIELDS
            or any(not isinstance(key, str) or not key for key in values)):
        raise ValueError("缺失参数修复值须为最多 4096 项的字段 ID 对象")
    encoded(values)
    scope = set(output_closure(result, output_nodes, info,
                               allow_no_outputs=True)["node_ids"])
    pending, repairs = copy.deepcopy(values), []
    while pending:
        candidates = inspect_interface(result, info, output_nodes=output_nodes)["missing_fields"]
        active = [field for field in candidates
                  if field["id"] in pending and field["node_id"] in scope]
        if not active:
            raise ValueError("缺失参数接口已改变、输入已存在或不参与所选输出，请重新检查后明确选择")
        for field in active:
            value = validate_value(field, pending[field["id"]])
            result[field["node_id"]]["inputs"][field["input"]] = copy.deepcopy(value)
            pending.pop(field["id"])
            repairs.append({"id": field["id"], "node_id": field["node_id"],
                            "input": field["input"]})
    encoded(result)
    return {"prompt": result, "repairs": repairs}


def output_closure(prompt, output_nodes, info, *, allow_no_outputs=False):
    """Describe output ancestry without changing the complete editable source.

    Explicit selections are authoritative. Otherwise only schema-declared
    output nodes are roots; arbitrary terminals are never inferred. Missing
    dependencies/cycles inside ancestry fail, while inactive islands remain.
    """
    source = normalize_prompt(prompt, check_dependencies=False)
    if not isinstance(info, dict):
        raise ValueError("后端节点信息须为对象")
    roots = output_nodes
    if roots is None:
        roots = [node_id for node_id, node in source.items()
                 if isinstance(info.get(node["class_type"]), dict)
                 and info[node["class_type"]].get("output_node") is True]
        if not roots and not allow_no_outputs:
            raise ValueError("工作流没有当前后端声明的输出节点，请在内部连接保存或预览输出")
    if not roots and output_nodes is None and allow_no_outputs:
        included = set()
    else:
        included = _output_ancestry(source, roots, info)
    ignored = [node_id for node_id in source if node_id not in included]
    warnings = [{"node_id": node_id, "class_type": source[node_id]["class_type"],
                 "code": "inactive_node" if isinstance(info.get(source[node_id]["class_type"]), dict)
                         else "inactive_unknown_node",
                 "message": "节点不参与当前输出执行，完整源图仍保留"}
                for node_id in ignored]
    if not roots:
        warnings.insert(0, {"code": "no_output_nodes", "message": "当前后端未声明可执行输出节点，请在内部补齐输出"})
    return {"output_nodes": list(roots), "selected_outputs": list(roots),
            "node_ids": [node_id for node_id in source if node_id in included],
            "ignored_node_ids": ignored, "warnings": warnings}


def select_outputs(prompt, output_nodes, info, *, editing=False):
    """Keep selected output nodes and their full dependency ancestry.

    ``None`` preserves an exact deep copy of the entire graph. Explicit output
    selection is bounded to 64 distinct output-node IDs.
    """
    if not isinstance(prompt, dict) or not isinstance(info, dict):
        raise ValueError("API 工作流与后端节点信息须为对象")
    _check_json_limits(prompt)
    if not prompt or len(prompt) > 1000:
        raise ValueError("API 图必须包含 1–1000 个节点")
    if output_nodes is None:
        return copy.deepcopy(prompt)
    included = _output_ancestry(prompt, output_nodes, info)
    pruned = {node_id: copy.deepcopy(node) for node_id, node in prompt.items()
              if node_id in included}
    normalized = normalize_prompt(pruned)
    if editing:
        validate_editor_prompt(normalized, info)
    else:
        validate_prompt(normalized, info)
    return normalized


def _output_ancestry(prompt, output_nodes, info):
    if not isinstance(output_nodes, list) or not output_nodes or len(output_nodes) > 64:
        raise ValueError("请选择 1–64 个输出节点")
    if any(not isinstance(node_id, str) or not node_id for node_id in output_nodes):
        raise ValueError("输出节点 ID 无效")
    if len(set(output_nodes)) != len(output_nodes):
        raise ValueError("输出节点不能重复")

    for node_id in output_nodes:
        node = prompt.get(node_id)
        if not isinstance(node, dict):
            raise ValueError(f"输出节点 {node_id} 不在 API 图中")
        schema = info.get(node.get("class_type"))
        if not isinstance(schema, dict) or schema.get("output_node") is not True:
            raise ValueError(f"节点 {node_id} 不是当前后端声明的输出节点")

    included, visiting = set(), set()

    def include(node_id):
        if node_id in visiting:
            raise ValueError("所选输出依赖中存在循环连接")
        if node_id in included:
            return
        if len(visiting) >= 256:
            raise ValueError("工作流依赖链不能超过 256 层")
        node = prompt.get(node_id)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            raise ValueError(f"API 节点 {node_id} 缺少 inputs 对象")
        visiting.add(node_id)
        for value in node["inputs"].values():
            if is_link(value):
                source_id, slot = value
                if source_id not in prompt or slot < 0:
                    raise ValueError("所选输出依赖到不存在的节点或无效插槽")
                include(source_id)
        visiting.remove(node_id)
        included.add(node_id)

    for node_id in output_nodes:
        include(node_id)

    return included


def _field_key(field):
    return field["node_id"], field["input"], field["type"]


def _same_value(left, right):
    return type(left) is type(right) and left == right


def _field_changes(previous, current, old_baseline, inner_value):
    keys = ("label", "options", "min", "max", "required", "role", "group", "presentation")
    return any(not _same_value(previous.get(key), current.get(key))
               for key in keys) or not _same_value(old_baseline, inner_value)


def _snapshot_field(field):
    return copy.deepcopy(field)


def reconcile_interface(previous_fields, previous_values, selected_fields,
                        new_prompt, previous_baseline=None, rebindings=None):
    """Rebind selected interface fields by node/input/type and reconcile values.

    ``selected_fields`` contains fresh candidate descriptors explicitly selected
    by the UI. ``rebindings`` maps old field IDs to selected field IDs (or
    ``None`` to discard an old field); omitted old IDs retain the old
    node/input/type matching behavior. ``previous_baseline`` maps old field IDs
    to the values originally applied to the native graph. Without it, old
    values are retained in legacy mode and ``changes['legacy']`` is true.
    """
    if not isinstance(previous_fields, list) or len(previous_fields) > MAX_INTERFACE_FIELDS:
        raise ValueError(f"旧接口字段须为最多 {MAX_INTERFACE_FIELDS} 项的数组")
    if not isinstance(selected_fields, list) or len(selected_fields) > MAX_INTERFACE_FIELDS:
        raise ValueError(f"外层最多选择 {MAX_INTERFACE_FIELDS} 个接口字段")
    if not isinstance(previous_values, dict):
        raise ValueError("旧外层参数须为对象")
    encoded(previous_values)
    if previous_baseline is not None:
        if not isinstance(previous_baseline, dict):
            raise ValueError("旧内部基线须为对象")
        encoded(previous_baseline)
    if rebindings is not None:
        if not isinstance(rebindings, dict) or len(rebindings) > MAX_INTERFACE_FIELDS:
            raise ValueError(f"接口重绑映射须为最多 {MAX_INTERFACE_FIELDS} 项的对象")
        encoded(rebindings)

    normalized_prompt = normalize_prompt(new_prompt, check_dependencies=False)
    # normalize_fields applies the same limits and mandatory-media rules used
    # when a portable package is stored. Work on a copy to avoid blanking the
    # internal graph's media defaults in the caller's data.
    validation_prompt = copy.deepcopy(normalized_prompt)
    checked_new = normalize_fields(selected_fields, validation_prompt)
    new_by_binding = {}
    for field, candidate in zip(checked_new, selected_fields):
        field["default"] = copy.deepcopy(
            normalized_prompt[field["node_id"]]["inputs"][field["input"]])
        for key in ("role", "group", "recommended"):
            if key in candidate:
                field[key] = copy.deepcopy(candidate[key])
        key = _field_key(field)
        if key in new_by_binding:
            raise ValueError("外层接口不能重复绑定相同节点输入")
        new_by_binding[key] = field

    old_by_binding = {}
    old_by_id = {}
    for field in previous_fields:
        if not isinstance(field, dict):
            raise ValueError("旧接口字段须为对象")
        field_id = field.get("id")
        if not isinstance(field_id, str) or not field_id:
            raise ValueError("旧接口字段 ID 无效")
        if field_id in old_by_id:
            raise ValueError("旧接口字段 ID 重复，不能安全映射外层参数")
        if (not isinstance(field.get("node_id"), str) or
                not isinstance(field.get("input"), str) or
                field.get("type") not in {"text", "integer", "number", "boolean", "select", "image", "audio", "video"}):
            raise ValueError("旧接口字段绑定无效")
        key = _field_key(field)
        if key in old_by_binding:
            raise ValueError("旧接口字段重复绑定相同节点输入")
        old_by_binding[key] = field
        old_by_id[field_id] = field

    # Explicit mappings override the legacy node/input/type match, including
    # explicit nulls. Build one-to-one assignments so no two old values can
    # silently compete for the same newly selected field.
    explicit = {} if rebindings is None else rebindings
    for old_id, target_id in explicit.items():
        if old_id not in old_by_id:
            raise ValueError("接口重绑映射引用了不存在的旧字段")
        if target_id is not None and not isinstance(target_id, str):
            raise ValueError("接口重绑目标 ID 无效")

    new_by_id = {field["id"]: field for field in new_by_binding.values()}
    assigned_old_by_new_id = {}
    for old_id, target_id in explicit.items():
        if target_id is None:
            continue
        target = new_by_id.get(target_id)
        if target is None:
            raise ValueError("接口重绑目标须为已选择的字段")
        old = old_by_id[old_id]
        if old["type"] != target["type"]:
            raise ValueError("接口重绑字段类型不兼容")
        if target_id in assigned_old_by_new_id:
            raise ValueError("接口重绑目标不能重复")
        assigned_old_by_new_id[target_id] = old

    for old in old_by_id.values():
        old_id = old["id"]
        if old_id in explicit:
            continue
        target = new_by_binding.get(_field_key(old))
        if target is None:
            continue
        if target["id"] in assigned_old_by_new_id:
            raise ValueError("接口重绑目标不能重复")
        assigned_old_by_new_id[target["id"]] = old

    values, changed, removed, new, invalid_value, conflicts = {}, [], [], [], [], []
    legacy = previous_baseline is None
    assigned_old_ids = {old["id"] for old in assigned_old_by_new_id.values()}
    for old in old_by_id.values():
        if old["id"] not in assigned_old_ids:
            removed.append(_snapshot_field(old))
    for new_key, current in new_by_binding.items():
        new_value = normalized_prompt[current["node_id"]]["inputs"][current["input"]]
        old = assigned_old_by_new_id.get(current["id"])
        if old is None:
            new.append(_snapshot_field(current))
            values[current["id"]] = copy.deepcopy(new_value)
            continue

        old_id = old["id"]
        old_baseline = (previous_baseline.get(old_id, old.get("default"))
                        if previous_baseline is not None else old.get("default"))
        if _field_changes(old, current, old_baseline, new_value):
            changed.append({"previous": _snapshot_field(old),
                            "current": _snapshot_field(current),
                            "old_baseline": copy.deepcopy(old_baseline),
                            "inner_value": copy.deepcopy(new_value)})
        if old_id not in previous_values:
            values[current["id"]] = copy.deepcopy(new_value)
            continue
        outer_value = previous_values[old_id]
        try:
            validate_value(current, outer_value,
                           template=current["type"] in {"image", "audio", "video"},
                           editing_enum_preservation=current["type"] == "select" and not current["options"])
        except ValueError as exc:
            invalid_value.append({"field": _snapshot_field(current),
                                  "value": copy.deepcopy(outer_value),
                                  "reason": str(exc)})
            conflicts.append({"id": current["id"], "field_id": current["id"],
                              "label": current["label"], "field": _snapshot_field(current),
                              "old_baseline": copy.deepcopy(old_baseline),
                              "outer": copy.deepcopy(outer_value), "inner": copy.deepcopy(new_value),
                              "allowed": ["inner"], "reason": str(exc)})
            continue

        if old_id in explicit and not _same_value(outer_value, new_value):
            conflicts.append({"id": current["id"], "field_id": current["id"],
                              "label": current["label"],
                              "field": _snapshot_field(current),
                              "old_baseline": copy.deepcopy(old_baseline),
                              "outer": copy.deepcopy(outer_value),
                              "inner": copy.deepcopy(new_value)})
            continue

        if legacy:
            values[current["id"]] = copy.deepcopy(outer_value)
            continue

        baseline = old_baseline
        outer_changed = not _same_value(outer_value, baseline)
        inner_changed = not _same_value(new_value, baseline)
        if outer_changed and inner_changed and not _same_value(outer_value, new_value):
            conflicts.append({"id": current["id"], "field_id": current["id"],
                              "label": current["label"],
                              "field": _snapshot_field(current),
                              "old_baseline": copy.deepcopy(baseline),
                              "outer": copy.deepcopy(outer_value),
                              "inner": copy.deepcopy(new_value)})
            continue
        values[current["id"]] = copy.deepcopy(
            outer_value if outer_changed and not inner_changed else new_value)

    return {"values": values,
            "changes": {"changed": changed, "removed": removed, "new": new,
                        "invalid_value": invalid_value, "conflicts": conflicts,
                        "legacy": legacy}}
