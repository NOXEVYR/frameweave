"""Pure helpers for exposing editable API inputs and selecting editor outputs.

These functions inspect and reshape data only. They never contact a ComfyUI
backend or submit a generation request.
"""

from __future__ import annotations

import copy

from .packages import (MODEL_INPUTS, encoded, inspect_document, is_link,
                       normalize_fields, normalize_prompt, validate_value)
from .workflows import _check_json_limits, validate_prompt


_KNOWN_OUTPUTS = {
    "SaveImage": "image",
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
}


def _role(field, node_type, node_title=""):
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
    if "lora" in name or "lora" in node_name:
        return "lora", "LoRA"
    if any(token in name for token in ("clip", "encoder", "t5", "tokenizer")):
        return "encoder", "编码器"
    if name in MODEL_INPUTS or any(token in name for token in ("checkpoint", "ckpt", "unet", "vae", "model")):
        return "model", "模型"
    if name in {"seed", "noise_seed", "random_seed"} or name.endswith("_seed"):
        return "seed", "随机种子"
    if name in {"width", "height", "batch_size", "length", "frames", "seconds", "fps"}:
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


def inspect_interface(prompt, info):
    """Return the normalized API graph and all bounded outer-interface candidates.

    The returned prompt retains internal image/audio literals. Inspection uses a
    separate copy because portable package templates intentionally blank them.
    """
    normalized = normalize_prompt(prompt)
    if not isinstance(info, dict):
        raise ValueError("后端节点信息须为对象")
    inspected = inspect_document({"prompt": copy.deepcopy(normalized)}, info,
                                 field_limit=None)
    fields = copy.deepcopy(inspected["fields"])
    for field in fields:
        node = normalized[field["node_id"]]
        if field["type"] in {"image", "audio"}:
            field["default"] = copy.deepcopy(node["inputs"][field["input"]])
        meta = prompt.get(field["node_id"], {}).get("_meta", {}) if isinstance(prompt, dict) else {}
        title = meta.get("title", "") if isinstance(meta, dict) else ""
        role, group = _role(field, node["class_type"], title if isinstance(title, str) else "")
        field["role"] = role
        field["group"] = group

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
    return {"prompt": normalized, "fields": fields, "outputs": outputs}


def select_outputs(prompt, output_nodes, info):
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

    pruned = {node_id: copy.deepcopy(node) for node_id, node in prompt.items()
              if node_id in included}
    normalized = normalize_prompt(pruned)
    validate_prompt(normalized, info)
    return normalized


def _field_key(field):
    return field["node_id"], field["input"], field["type"]


def _same_value(left, right):
    return type(left) is type(right) and left == right


def _field_changes(previous, current, old_baseline, inner_value):
    keys = ("label", "options", "min", "max", "required", "role", "group")
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
    if not isinstance(previous_fields, list) or len(previous_fields) > 64:
        raise ValueError("旧接口字段须为最多 64 项的数组")
    if not isinstance(selected_fields, list) or len(selected_fields) > 64:
        raise ValueError("外层最多选择 64 个接口字段")
    if not isinstance(previous_values, dict):
        raise ValueError("旧外层参数须为对象")
    encoded(previous_values)
    if previous_baseline is not None:
        if not isinstance(previous_baseline, dict):
            raise ValueError("旧内部基线须为对象")
        encoded(previous_baseline)
    if rebindings is not None:
        if not isinstance(rebindings, dict) or len(rebindings) > 64:
            raise ValueError("接口重绑映射须为最多 64 项的对象")
        encoded(rebindings)

    normalized_prompt = normalize_prompt(new_prompt)
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
                field.get("type") not in {"text", "integer", "number", "boolean", "select", "image", "audio"}):
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
            validate_value(current, outer_value)
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
