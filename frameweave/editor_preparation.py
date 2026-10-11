"""Prepare complete editor sources with bounded, explicitly mapped overlays.

This is a pure data boundary. It does not compile, prune, upload, resolve files,
contact a backend, or certify generation readiness. Invalid/unproven overlays
remain pending and leave their original source literals intact.
"""

from __future__ import annotations

import copy
import math

from .backend import local_url
from .media_contract import MEDIA_TYPES, media_input_contract
from .packages import (FORMAT, ID, MAX_BYTES, MAX_INSPECTION_FIELDS, RESERVED, TYPES,
                       api_prompt, encoded, is_link, normalize_prompt, scalar,
                       validate_value)
from .workflows import _expanded_inputs, _spec


MAX_ITEMS = MAX_INSPECTION_FIELDS
_MESSAGES = {
    "mapping_unavailable": "外层字段映射不可确认，已保留原始输入。",
    "ambiguous_mapping": "外层字段映射重复，未覆盖原始输入。",
    "invalid_value": "外层参数不符合明确字段合同，已保留原始输入。",
    "schema_unavailable": "缺少当前节点声明；原始图保留供编辑修复。",
    "schema_invalid": "当前节点声明无法可靠解析，未覆盖输入。",
    "inactive_input": "此字段不在当前活动输入中，未覆盖输入。",
    "type_mismatch": "当前节点声明与外层字段类型不同，未覆盖输入。",
    "link_only": "此输入需要内部连线，未用外层字面值覆盖。",
    "owner_unknown": "参考素材的后端归属尚未确认。",
    "other_backend": "参考素材属于其他后端，未投影到编辑工作流。",
    "missing_media": "参考素材尚未设置，可在工作流中补齐。",
    "missing_input": "当前声明的必填输入尚未设置，可进入工作流修复。",
    "missing_value": "必填文本尚未设置，可进入工作流修复。",
    "source_value_unverified": "原始字面值与当前声明不一致；未替换或填写默认值。",
    "source_link_unverified": "原图包含待修复的连接，已完整保留。",
    "payload_limit": "此投影会超过完整图数据上限，已保留原始输入。",
    "input_pending": "此字段仍有待处理的来源或素材事务，未覆盖原始输入。",
    "dynamic_dependencies_unproven": "此节点的最终活动声明无法证明整批投影；已恢复原始输入供编辑修复。",
    "enum_unavailable": "当前下拉目录没有可用选项或原值已不可用；保留原始值供编辑，未自动选择或写入新值。",
}


def _items(value, label):
    if value is None:
        return []
    encoded(value)
    if not isinstance(value, list) or len(value) > MAX_ITEMS:
        raise ValueError(f"{label}须为最多 {MAX_ITEMS} 项的列表")
    if any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{label}条目须为对象")
    return copy.deepcopy(value)


def _field_valid(field, prompt):
    field_id, node_id, name, kind = (field.get(key) for key in ("id", "node_id", "input", "type"))
    if (not isinstance(field_id, str) or not ID.fullmatch(field_id) or field_id in RESERVED
            or not isinstance(node_id, str) or node_id not in prompt
            or not isinstance(name, str) or name not in prompt[node_id]["inputs"]
            or is_link(prompt[node_id]["inputs"][name])
            or not isinstance(kind, str) or kind not in TYPES):
        return False
    if "label" in field and (not isinstance(field["label"], str) or len(field["label"]) > 120):
        return False
    if "required" in field and type(field["required"]) is not bool:
        return False
    if kind == "select":
        options = field.get("options")
        if (not isinstance(options, list) or len(options) > 512
                or any(not scalar(value) or isinstance(value, str) and len(value) > 2048 for value in options)):
            return False
    for bound in ("min", "max"):
        if bound in field and (type(field[bound]) not in (int, float)
                              or not math.isfinite(field[bound]) or abs(field[bound]) > 9007199254740991):
            return False
    return field.get("min", -math.inf) <= field.get("max", math.inf)


def _specs(schema, values):
    """Reject ambiguous/system-injected bindings before using expanded fields."""
    specs, required = _expanded_inputs(schema, values)
    if len(specs) > MAX_ITEMS:
        raise ValueError("节点声明输入过多")
    forbidden, declared = set(), set()

    def declare(key):
        if key in declared:
            raise ValueError("节点声明存在重复的活动输入路径")
        declared.add(key)
        if len(declared) > MAX_ITEMS:
            raise ValueError("节点声明输入过多")

    def visit(groups, prefix="", depth=0):
        if not isinstance(groups, dict) or depth > 32:
            raise ValueError("节点声明无效")
        left, right, hidden = (groups.get(key, {}) for key in ("required", "optional", "hidden"))
        if any(not isinstance(group, dict) for group in (left, right, hidden)) or set(left) & set(right):
            raise ValueError("节点声明存在重复或无效输入")
        # A flat dotted name and an active V3 child can address the same API
        # input. Expansion uses a dictionary, so it would silently keep the
        # last declaration. Check the original active declarations instead;
        # required/optional/hidden placement must not authorize that ambiguity.
        for group in (left, right, hidden):
            for name in group:
                if not isinstance(name, str) or not name:
                    raise ValueError("节点声明输入名称无效")
                declare(prefix + name)
        forbidden.update(prefix + key for key in hidden)
        for name, definition in {**left, **right}.items():
            kind, meta = _spec(definition)
            key = prefix + name
            if kind == "COMFY_DYNAMICCOMBO_V3":
                for option in meta["options"]:
                    if option["key"] == values.get(key):
                        visit(option["inputs"], key + ".", depth + 1)
            elif kind == "COMFY_AUTOGROW_V3":
                # _expanded_inputs has already validated this exact template,
                # including its names/prefix/max and first nonempty input.
                template = meta["template"]
                names = template.get("names")
                if names is None:
                    names = [template.get("prefix", "item_") + str(index)
                             for index in range(template.get("max", 0))]
                for name in names:
                    declare(key + "." + name)
            elif isinstance(kind, list) and isinstance(meta.get("formats"), dict):
                selection = values.get(key)
                if not isinstance(selection, str) or selection not in kind:
                    continue
                widgets = meta["formats"].get(selection, [])
                if isinstance(widgets, dict):
                    continue  # Opaque processing metadata is not API inputs.
                for widget in widgets:
                    # Keep the official format-widget precedence of an
                    # explicit declaration in this same group. Other qualified
                    # collisions (V3/autogrow/another format) are ambiguous.
                    if widget[0] not in left and widget[0] not in right:
                        declare(prefix + widget[0])

    visit(schema.get("input", {}))
    return specs, required, forbidden


def _live_field(field, node, schema, *, expanded=None):
    try:
        specs, required, forbidden = expanded if expanded is not None else _specs(schema, node["inputs"])
        name = field["input"]
        if name not in specs:
            return None, "inactive_input"
        kind, meta = _spec(specs[name])
        if name in forbidden or meta.get("forceInput") or meta.get("rawLink"):
            return None, "link_only"
        if meta.get("multiselect"):
            return None, "type_mismatch"
        contract = media_input_contract(node["class_type"], name, specs[name], required=name in required)
        result = {**field, "label": field.get("label") or field["id"]}
        if field["type"] in MEDIA_TYPES:
            return (result, None) if contract["supported"] and contract["media_type"] == field["type"] else (None, "type_mismatch")
        if contract["supported"] or any(key in meta for key in ("image_upload", "audio_upload", "video_upload")):
            return None, "type_mismatch"
        if field["type"] == "select":
            options = kind if isinstance(kind, list) else meta.get("options") if kind in ("COMBO", "COMFY_DYNAMICCOMBO_V3") else None
            if kind == "COMFY_DYNAMICCOMBO_V3":
                options = [item["key"] for item in options]
            if not isinstance(options, list) or any(not scalar(option) for option in options):
                return None, "type_mismatch"
            result["options"] = options
        elif not isinstance(kind, str) or kind not in {
                "text": {"STRING"}, "integer": {"INT", "FLOAT"},
                "number": {"FLOAT"}, "boolean": {"BOOLEAN"}}[field["type"]]:
            return None, "type_mismatch"
        for bound in ("min", "max"):
            if bound in meta:
                value = meta[bound]
                if type(value) not in (int, float) or not math.isfinite(value):
                    return None, "schema_invalid"
                result[bound] = value
        return result, None
    except (ValueError, TypeError, KeyError):
        return None, "schema_invalid"


def prepare_editor_document(document, *, source_kind="api", fields=None,
                            overrides=None, pending=None, info=None, backend_url=None):
    """Return full source plus a proven session projection and repair diagnostics.

    ``fields`` are complete explicit package-style mappings. ``overrides`` use
    snake_case field_id/node_id/input/value plus inert provenance; optional
    media_owner must prove exact name, backend and media_type. Invalid entries
    become pending. No stored default is ever copied into the prompt.
    """
    encoded(document)
    if source_kind not in ("api", "package") or not isinstance(document, dict):
        raise ValueError("编辑来源须为完整 API 或工作流包对象")
    if source_kind == "package":
        if document.get("format", FORMAT) != FORMAT or document.get("version", 1) != 1:
            raise ValueError("编辑工作流包格式或版本不支持")
        original = document.get("prompt")
        if fields is None:
            fields = document.get("fields", [])
    else:
        original = api_prompt(document)
    # Validation deliberately discards normalization's lossy result.
    normalize_prompt(original, check_dependencies=False)
    source, prompt = copy.deepcopy(document), copy.deepcopy(original)
    # Full source was validated above. Every accepted replacement below is a
    # validated scalar in an existing input slot, so it cannot introduce keys
    # or increase structural depth. Exact encoded-value deltas keep the same
    # UTF-8 JSON budget; a final full encoding validates the whole transaction.
    prompt_bytes = len(encoded(prompt))
    mappings, requested, waiting = _items(fields, "字段映射"), _items(overrides, "会话投影"), _items(pending, "待处理输入")
    if info is not None and not isinstance(info, dict):
        raise ValueError("当前节点声明须为对象或空")
    backend = local_url(backend_url) if backend_url is not None else None
    applied, diagnostics, seen_diagnostics = [], [], set()
    omitted = {"pending": 0, "diagnostics": 0}

    def diagnose(code, item, *, defer=False):
        identity = {key: item[key] for key in ("field_id", "node_id", "input", "source_id", "edge_id")
                    if isinstance(item.get(key), str) and len(item[key]) <= 256}
        key = (code, tuple((name, str(value)) for name, value in identity.items()))
        if key not in seen_diagnostics:
            if len(diagnostics) < MAX_ITEMS:
                diagnostics.append({**identity, "code": code, "message": _MESSAGES[code]})
            else:
                omitted["diagnostics"] += 1
            seen_diagnostics.add(key)
        if defer:
            if len(waiting) < MAX_ITEMS:
                waiting.append({**copy.deepcopy(item), "reason": code})
            else:
                omitted["pending"] += 1

    counts, bindings, lookup = {}, {}, {}
    for field in mappings:
        field_id = field.get("id")
        if isinstance(field_id, str):
            # Invalid records cannot erase the ambiguity of a duplicate ID.
            counts[field_id] = counts.get(field_id, 0) + 1
        binding = (field.get("node_id"), field.get("input"))
        if all(isinstance(value, str) for value in binding):
            bindings[binding] = bindings.get(binding, 0) + 1
        if not _field_valid(field, prompt):
            diagnose("mapping_unavailable", {"field_id": field_id}, defer=False)
            continue
        lookup[field_id] = field
    repeated = {field_id for field_id, field in lookup.items()
                if counts[field_id] > 1 or bindings[(field["node_id"], field["input"])] > 1}
    for field_id in sorted(repeated):
        diagnose("ambiguous_mapping", {"field_id": field_id})
    proven_fields_by_binding = {(field["node_id"], field["input"]): field
                               for field in lookup.values() if field["id"] not in repeated}
    request_counts = {}
    deferred_fields = {item.get("field_id") for item in waiting if isinstance(item.get("field_id"), str)}
    deferred_bindings = {(item["node_id"], item["input"]) for item in waiting
                         if isinstance(item.get("node_id"), str) and isinstance(item.get("input"), str)}
    for item in requested:
        key = item.get("field_id")
        if isinstance(key, str):
            request_counts[key] = request_counts.get(key, 0) + 1
    specs_cache = {}

    def current_specs(node_id, node, schema):
        if node_id not in specs_cache:
            try:
                specs_cache[node_id] = (_specs(schema, node["inputs"]), None)
            except (ValueError, TypeError, KeyError):
                specs_cache[node_id] = (None, "schema_invalid")
        return specs_cache[node_id]
    def ordered_requests():
        selectors, others = {}, []
        for item in requested:
            field = lookup.get(item.get("field_id")) if isinstance(item.get("field_id"), str) else None
            if field is not None and field["type"] == "select":
                selectors.setdefault(field["input"].count("."), []).append(item)
            else:
                others.append(item)

        def parent_rank(item):
            field = lookup[item["field_id"]]
            node = prompt[field["node_id"]]
            schema = info.get(node["class_type"]) if info is not None else None
            if not isinstance(schema, dict):
                return 1
            expanded, reason = current_specs(field["node_id"], node, schema)
            if reason or field["input"] not in expanded[0]:
                return 1
            kind, meta = _spec(expanded[0][field["input"]])
            return 0 if kind == "COMFY_DYNAMICCOMBO_V3" or isinstance(meta.get("formats"), dict) else 1

        # Re-evaluate each depth after shallower parents have been projected.
        # Declared flat format parents precede their enum widgets as well as
        # scalar widgets. Unknown dependencies are caught by the final proof.
        for depth in sorted(selectors):
            yield from sorted(selectors[depth], key=parent_rank)
        yield from others

    for item in ordered_requests():
        field_id = item.get("field_id")
        field = lookup.get(field_id) if isinstance(field_id, str) else None
        if field is None:
            diagnose("mapping_unavailable", item, defer=True)
            continue
        identity = {**item, "node_id": field["node_id"], "input": field["input"]}
        if field_id in deferred_fields or (field["node_id"], field["input"]) in deferred_bindings:
            diagnose("input_pending", identity, defer=True)
            continue
        if field_id in repeated or request_counts[field_id] > 1:
            diagnose("ambiguous_mapping", identity, defer=True)
            continue
        if ("node_id" in item and item["node_id"] != field["node_id"]
                or "input" in item and item["input"] != field["input"] or "value" not in item):
            diagnose("mapping_unavailable", identity, defer=True)
            continue
        value = item["value"]
        declared = {**field, "label": field.get("label") or field_id}
        try:
            validate_value(declared, value, template=True)
        except (ValueError, KeyError, TypeError):
            diagnose("enum_unavailable" if field["type"] == "select" and not field["options"] else "invalid_value", identity, defer=True)
            continue
        node = prompt[field["node_id"]]
        schema = info.get(node["class_type"]) if info is not None else None
        if not isinstance(schema, dict):
            diagnose("schema_unavailable", identity, defer=True)
            continue
        expanded, reason = current_specs(field["node_id"], node, schema)
        live, reason = (None, reason) if reason else _live_field(field, node, schema, expanded=expanded)
        if reason:
            diagnose(reason, identity, defer=True)
            continue
        try:
            validate_value(live, value, template=True)
        except (ValueError, KeyError, TypeError):
            diagnose("invalid_value", identity, defer=True)
            continue
        if field["type"] in MEDIA_TYPES:
            owner = item.get("media_owner")
            reason = "missing_media" if not value.strip() else "owner_unknown"
            if value.strip() and isinstance(owner, dict) and owner.get("name") == value and owner.get("media_type") == field["type"]:
                try:
                    reason = None if backend is not None and local_url(owner.get("backend")) == backend else "other_backend"
                except ValueError:
                    reason = "owner_unknown"
            if reason:
                diagnose(reason, identity, defer=True)
                continue
        baseline = copy.deepcopy(node["inputs"][field["input"]])
        projected_bytes = prompt_bytes - len(encoded(baseline)) + len(encoded(value))
        if projected_bytes > MAX_BYTES:
            diagnose("payload_limit", identity, defer=True)
            continue
        node["inputs"][field["input"]] = copy.deepcopy(value)
        prompt_bytes = projected_bytes
        # All select edits invalidate conservatively. This covers nested V3
        # selectors and extension format-dependent inputs without guessing
        # whether an enum is merely a model selector or changes its schema.
        if field["type"] == "select" and (type(value) is not type(baseline) or value != baseline):
            specs_cache.pop(field["node_id"], None)
        applied.append({**identity, "source_value": baseline})

    # Prove overlays against the final active declaration, not merely the
    # declaration observed when each value was written. If a later selector
    # invalidates one overlay, restore that node's whole batch in one bounded
    # pass; do not chase a fixpoint or invent a dependency/default.
    unproven_nodes = set()
    for item in applied:
        field = lookup[item["field_id"]]
        node = prompt[field["node_id"]]
        schema = info.get(node["class_type"])
        expanded, reason = current_specs(field["node_id"], node, schema)
        live, reason = (None, reason) if reason else _live_field(field, node, schema, expanded=expanded)
        if not reason:
            try:
                validate_value(live, node["inputs"][field["input"]], template=True)
            except (ValueError, KeyError, TypeError):
                reason = "invalid_value"
        if reason:
            unproven_nodes.add(field["node_id"])
    if unproven_nodes:
        proven = []
        for item in applied:
            if item["node_id"] not in unproven_nodes:
                proven.append(item)
                continue
            node = prompt[item["node_id"]]
            current = node["inputs"][item["input"]]
            prompt_bytes += len(encoded(item["source_value"])) - len(encoded(current))
            node["inputs"][item["input"]] = copy.deepcopy(item["source_value"])
            specs_cache.pop(item["node_id"], None)
            diagnose("dynamic_dependencies_unproven", item, defer=True)
        applied = proven

    if prompt_bytes > MAX_BYTES:
        # A shrinking overlay can lend capacity to another node, then fail the
        # final dynamic proof and be restored. Withdraw the entire remaining
        # session projection in that case; a valid source must still be usable
        # for repair. Never optimize/reorder batches or relax the source limit.
        for item in applied:
            diagnose("payload_limit", item, defer=True)
        prompt = copy.deepcopy(original)
        prompt_bytes = len(encoded(prompt))
        applied = []
        specs_cache.clear()

    if len(encoded(prompt)) != prompt_bytes:
        # Abort the entire pure transaction; never return a partially verified
        # list of applied overrides when the complete document cannot be proved.
        raise ValueError("编辑投影的完整 JSON 字节校验失败")
    # Report incomplete source without fixing, pruning or certifying it.
    for node_id, node in prompt.items():
        schema = info.get(node["class_type"]) if info is not None else None
        if not isinstance(schema, dict):
            diagnose("schema_unavailable", {"node_id": node_id})
            continue
        expanded, reason = current_specs(node_id, node, schema)
        if reason:
            diagnose("schema_invalid", {"node_id": node_id})
            continue
        specs, required, _ = expanded
        for name in sorted(required - node["inputs"].keys()):
            diagnose("missing_input", {"node_id": node_id, "input": name}, defer=True)
        for name, value in node["inputs"].items():
            identity = {"node_id": node_id, "input": name}
            if is_link(value):
                if value[0] not in prompt or value[1] < 0:
                    diagnose("source_link_unverified", identity)
                continue
            if name not in specs:
                diagnose("source_value_unverified", identity)
                continue
            contract = media_input_contract(node["class_type"], name, specs[name], required=name in required)
            if contract["supported"]:
                if not isinstance(value, str) or not value.strip():
                    diagnose("missing_media", identity, defer=True)
                continue
            kind, meta = _spec(specs[name])
            if kind == "STRING" and name in required and isinstance(value, str) and not value.strip():
                diagnose("missing_value", identity, defer=True)
            # A stale model/combo value is kept verbatim. The current option
            # list is evidence for a diagnostic, never a replacement value.
            options = kind if isinstance(kind, list) else meta.get("options") if kind in ("COMBO", "COMFY_DYNAMICCOMBO_V3") else None
            if kind == "COMFY_DYNAMICCOMBO_V3" and isinstance(options, list):
                options = [option["key"] for option in options]
            if isinstance(options, list):
                try:
                    validate_value({"type": "select", "label": name, "options": options}, value, template=True)
                except (ValueError, TypeError, KeyError):
                    if kind != "COMFY_DYNAMICCOMBO_V3":
                        bound = proven_fields_by_binding.get((node_id, name))
                        if bound is not None and bound["type"] == "select":
                            identity["field_id"] = bound["id"]
                        diagnose("enum_unavailable", identity, defer=True)
                    else:
                        diagnose("source_value_unverified", identity)
    return {"source_document": source, "prompt": prompt, "overrides": applied,
            "pending": waiting, "diagnostics": diagnostics, "backend_url": backend,
            "status": "unverified", "pending_omitted_count": omitted["pending"],
            "diagnostics_omitted_count": omitted["diagnostics"]}
