"""Bounded, exact-instance contracts for native-observed additional links.

These helpers validate portable data, not the origin of that data. Callers must
independently establish the current native compilation/backend authorization
before passing a contract into an executable validation path.
"""

from __future__ import annotations

import copy
import hashlib
import json


MAX_CONTRACT_BYTES = 2 * 1024 * 1024
MAX_CONTRACT_NODES = 1000
MAX_CONTRACT_FIELDS = 4096
_RESERVED = {"__proto__", "prototype", "constructor"}
_DYNAMIC_TYPES = {"COMFY_AUTOGROW_V3", "COMFY_DYNAMICCOMBO_V3", "COMFY_MATCHTYPE_V3"}


class AdditionalInputContractRequired(ValueError):
    """A structurally valid link still lacks a proven target input contract."""

    code = "additional_input_contract_required"


def _name(value, maximum, label):
    if (not isinstance(value, str) or not 1 <= len(value) <= maximum
            or not value.strip() or value in _RESERVED or any(ord(char) < 32 for char in value)):
        raise ValueError(f"附加输入契约的{label}无效")
    return value


def _encoded(value):
    # Import lazily: workflows uses this module's resolver and remains the
    # authority for official V3 expansion and shared JSON depth checks.
    from .workflows import _check_json_limits

    _check_json_limits(value)
    try:
        data = json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                          separators=(",", ":")).encode("utf-8")
    except (UnicodeError, TypeError, ValueError, RecursionError):
        raise ValueError("附加输入契约必须为有效的 JSON 数据") from None
    return data


def _link(value):
    return (isinstance(value, list) and len(value) == 2
            and isinstance(value[0], str) and type(value[1]) is int and value[1] >= 0)


def normalize_additional_inputs(contract, prompt=None):
    """Copy an exact link-only sidecar, optionally checking its prompt binding.

    No node class, field prefix or upstream output can manufacture a missing
    contract entry. Optional provenance is retained solely as bounded audit data.
    """
    if contract is None:
        return None
    if not isinstance(contract, dict) or set(contract) - {"version", "nodes", "provenance"}:
        raise ValueError("附加输入契约须包含 version 和 nodes")
    if type(contract.get("version")) is not int or contract["version"] != 1:
        raise ValueError("不支持的附加输入契约版本")
    if len(_encoded(contract)) > MAX_CONTRACT_BYTES:
        raise ValueError("附加输入契约最大为 2 MiB")
    nodes = contract.get("nodes")
    if not isinstance(nodes, dict) or len(nodes) > MAX_CONTRACT_NODES:
        raise ValueError("附加输入契约最多包含 1000 个节点")
    if prompt is not None and not isinstance(prompt, dict):
        raise ValueError("附加输入契约需要 API 图对象")
    result = {"version": 1, "nodes": {}}
    count = 0
    for node_id, entry in nodes.items():
        _name(node_id, 100, "节点 ID")
        if not isinstance(entry, dict) or set(entry) != {"class_type", "inputs"}:
            raise ValueError(f"节点 {node_id} 的附加输入契约结构无效")
        node_type = _name(entry.get("class_type"), 256, "节点类型")
        fields = entry.get("inputs")
        if not isinstance(fields, dict) or not fields:
            raise ValueError(f"节点 {node_id} 的附加输入契约须列出准确输入")
        count += len(fields)
        if count > MAX_CONTRACT_FIELDS:
            raise ValueError("附加输入契约最多包含 4096 个输入")
        node = prompt.get(node_id) if prompt is not None else None
        if prompt is not None and (not isinstance(node, dict) or node.get("class_type") != node_type
                                   or not isinstance(node.get("inputs"), dict)):
            raise ValueError(f"节点 {node_id} 的附加输入契约已失效：实例或类型改变")
        normalized_fields = {}
        for name, definition in fields.items():
            _name(name, 256, "输入名称")
            if not isinstance(definition, dict) or set(definition) != {"type", "accept", "source"}:
                raise ValueError(f"节点 {node_id}.{name} 的附加输入定义无效")
            kind = _name(definition.get("type"), 256, "端口类型")
            parts = [part.strip() for part in kind.split(",")]
            if (any(not part or part in _DYNAMIC_TYPES for part in parts)
                    or len(set(parts)) != len(parts)):
                raise ValueError(f"节点 {node_id}.{name} 的附加输入类型无效")
            if definition.get("accept") != "link":
                raise ValueError("第一版附加输入契约只支持 link，不能授权纯值")
            source = definition.get("source")
            if not _link(source):
                raise ValueError(f"节点 {node_id}.{name} 的附加输入连接须为节点 ID 与非负整数插槽")
            _name(source[0], 100, "来源节点 ID")
            if prompt is not None:
                value = node["inputs"].get(name)
                if not _link(value) or value != source:
                    raise ValueError(f"节点 {node_id}.{name} 的附加输入契约已失效：准确连接改变")
                if source[0] not in prompt:
                    raise ValueError(f"节点 {node_id}.{name} 连接到不存在的节点 {source[0]}")
            normalized_fields[name] = {"type": ",".join(parts), "accept": "link", "source": list(source)}
        result["nodes"][node_id] = {"class_type": node_type, "inputs": normalized_fields}
    if "provenance" in contract:
        if not isinstance(contract["provenance"], dict):
            raise ValueError("附加输入契约 provenance 须为审计对象")
        result["provenance"] = copy.deepcopy(contract["provenance"])
    return result


def _declared_names(schema):
    """Reserve formal fields, including unselected dynamic-combo branches."""
    from .workflows import _expanded_inputs, _spec

    names, hidden = set(), set()

    def visit(groups, prefix="", depth=0):
        if depth > 32 or not isinstance(groups, dict):
            raise ValueError("后端动态输入定义嵌套过深或无效")
        # Autogrow's finite exact child names remain formally reserved even
        # inside a dynamic-combo branch that is currently unselected.
        local_fields, _ = _expanded_inputs({"input": groups}, {})
        names.update(prefix + key for key in local_fields)
        for group in ("required", "optional", "hidden"):
            values = groups.get(group, {})
            if not isinstance(values, dict):
                raise ValueError("后端动态输入定义无效")
            for name, definition in values.items():
                if not isinstance(name, str) or not name:
                    raise ValueError("后端动态输入名称无效")
                key = prefix + name
                names.add(key)
                if group == "hidden":
                    hidden.add(key)
                    continue
                kind, meta = _spec(definition)
                if kind == "COMFY_DYNAMICCOMBO_V3":
                    options = meta.get("options")
                    if not isinstance(options, list):
                        raise ValueError("后端动态输入定义无效")
                    for option in options:
                        if not isinstance(option, dict):
                            raise ValueError("后端动态输入定义无效")
                        # Every branch uses the same declared input prefix.
                        visit(option.get("inputs", {}), key + ".", depth + 1)
                elif isinstance(kind, list) and isinstance(meta.get("formats"), dict):
                    for widgets in meta["formats"].values():
                        if isinstance(widgets, dict):
                            continue  # Opaque processing profiles declare no fields.
                        if not isinstance(widgets, list):
                            raise ValueError("后端视频格式输入定义不合法")
                        for widget in widgets:
                            if (not isinstance(widget, (list, tuple)) or len(widget) < 2
                                    or not isinstance(widget[0], str) or not widget[0]):
                                raise ValueError("后端视频格式输入定义不合法")
                            names.add(prefix + widget[0])

    visit(schema.get("input", {}))
    return names, hidden


def resolved_inputs(node_id, node, schema, additional_inputs=None):
    """Merge observed exact links with official definitions without overrides.

    A field newly declared by the backend migrates to its official definition
    only if the observed type remains compatible. Official bounds, enums and
    required flags are always preserved. Hidden and inactive formal fields may
    never be promoted by a sidecar.
    """
    return _resolved_inputs_normalized(node_id, node, schema,
                                       normalize_additional_inputs(additional_inputs))


def _resolved_inputs_normalized(node_id, node, schema, additional_inputs):
    """Internal merge after the caller has normalized the whole bounded graph.

    Keeping normalization outside each node avoids repeatedly serializing and
    copying a potentially 2 MiB contract during a 1000-node validation pass.
    """
    from .workflows import _expanded_inputs, _spec, _type_names

    if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
        raise ValueError(f"节点 {node_id} 缺少 inputs 对象")
    fields, required = _expanded_inputs(schema, node["inputs"])
    if additional_inputs is None:
        return fields, required
    entry = additional_inputs["nodes"].get(node_id)
    if entry is None:
        return fields, required
    if node.get("class_type") != entry["class_type"]:
        raise ValueError(f"节点 {node_id} 的附加输入契约已失效：实例类型改变")
    reserved, hidden = _declared_names(schema)
    for name, definition in entry["inputs"].items():
        value = node["inputs"].get(name)
        if not _link(value) or value != definition["source"]:
            raise ValueError(f"节点 {node_id}.{name} 的附加输入契约已失效：准确连接改变")
        if name in hidden:
            raise ValueError(f"节点 {node_id}.{name} 的附加输入契约不能覆盖 hidden 输入")
        if name in fields:
            kind, meta = _spec(fields[name])
            expected = _type_names(kind)
            if kind == "COMFY_MATCHTYPE_V3":
                template = meta.get("template")
                allowed = template.get("allowed_types", "*") if isinstance(template, dict) else None
                if not isinstance(allowed, str):
                    raise ValueError("MatchType 输入模板无效")
                expected = _type_names(allowed)
            observed = _type_names(definition["type"])
            if "*" not in expected | observed and not expected & observed:
                raise ValueError(f"节点 {node_id}.{name} 的附加输入契约已失效：正式类型不相容 (stale)")
            continue
        if name in reserved:
            raise ValueError(f"节点 {node_id}.{name} 的附加输入契约不能覆盖正式动态输入")
        fields[name] = [definition["type"], {"forceInput": True, "additional_input": True, "accept": "link"}]
    return fields, required


def crop_additional_inputs(contract, node_ids):
    """Crop destination instances with an execution closure; retain exact edges."""
    normalized = normalize_additional_inputs(contract)
    if normalized is None:
        return None
    wanted = set(node_ids)
    normalized["nodes"] = {key: entry for key, entry in normalized["nodes"].items() if key in wanted}
    return normalized if normalized["nodes"] else None


def contract_schema_digest(contract, prompt, info):
    """Fingerprint exact contract/instance identities and all used live schemas.

    Literal edits do not alter a schema fingerprint. Callers needing a frozen
    compilation identity must additionally hash the canonical prompt itself.
    """
    normalized = normalize_additional_inputs(contract, prompt)
    if not isinstance(prompt, dict) or not isinstance(info, dict):
        raise ValueError("契约指纹需要 API 图与后端类型定义")
    identities, schemas = {}, {}
    for node_id, node in prompt.items():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str):
            raise ValueError(f"节点 {node_id} 缺少后端类型")
        kind = node["class_type"]
        if kind not in info or not isinstance(info[kind], dict):
            raise ValueError(f"节点 {node_id} 缺少后端类型 {kind}")
        _resolved_inputs_normalized(node_id, node, info[kind], normalized)
        identities[node_id] = kind
        schemas[kind] = info[kind]
    return hashlib.sha256(_encoded({"additional_inputs": normalized,
                                   "nodes": identities, "schemas": schemas})).hexdigest()
