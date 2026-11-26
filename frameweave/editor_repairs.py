"""Private, exact-source overlays for explicitly chosen missing scalar inputs.

The original native document stays authoritative and unchanged. These records
are never execution/session credentials or package export data. Reuse requires
a current native session at the service boundary and fresh formal schemas here.
"""

from __future__ import annotations

import copy
import hashlib
import json
import re

from .input_contracts import MAX_CONTRACT_BYTES, MAX_CONTRACT_FIELDS, _encoded, _name
from .native_input_contracts import _GraphIndex, _execution_path

_HASH = re.compile(r"[0-9a-f]{64}\Z")


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     allow_nan=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _native_fingerprint(document, node_id, class_type, graph_index=None):
    try:
        if graph_index is False:
            return None
        path = _execution_path(node_id)
        node, _ = (graph_index or _GraphIndex(document)).resolve(path)
        if node.get("type") != class_type:
            return None
        return fingerprint({"instance_path": path, "node": node})
    except (ValueError, KeyError, TypeError):
        # Explicit repair audit remains useful for old unsupported mappings,
        # but absence of a mapping never authorizes automatic reuse.
        return None


def normalize_repair_overlay(overlay):
    if overlay is None:
        return None
    if (not isinstance(overlay, dict)
            or set(overlay) != {"version", "backend_url", "document_sha256", "source_sha256", "entries"}
            or type(overlay.get("version")) is not int or overlay["version"] != 1):
        raise ValueError("缺项补参来源记录结构或版本无效")
    if len(_encoded(overlay)) > MAX_CONTRACT_BYTES:
        raise ValueError("缺项补参来源记录最大为 2 MiB")
    from .backend import local_url
    local_url(overlay["backend_url"])
    for key in ("document_sha256", "source_sha256"):
        if not isinstance(overlay[key], str) or not _HASH.fullmatch(overlay[key]):
            raise ValueError("缺项补参来源摘要无效")
    entries = overlay["entries"]
    if not isinstance(entries, list) or len(entries) > MAX_CONTRACT_FIELDS:
        raise ValueError("缺项补参来源最多包含 4096 项")
    seen = set()
    for entry in entries:
        required = {"id", "node_id", "input", "class_type", "value",
                    "inputs_sha256", "schema_sha256", "native_sha256", "origin_revision"}
        if (not isinstance(entry, dict) or not required <= set(entry)
                or set(entry) - required - {"origin_workflow_id"}):
            raise ValueError("缺项补参绑定来源结构无效")
        for key, maximum in (("id", 100), ("node_id", 100), ("input", 256), ("class_type", 256)):
            _name(entry[key], maximum, "补参绑定")
        binding = (entry["node_id"], entry["input"])
        if binding in seen:
            raise ValueError("缺项补参来源绑定重复")
        seen.add(binding)
        if entry["id"] != "f_" + hashlib.sha256((entry["node_id"] + "\0" + entry["input"]).encode()).hexdigest()[:16]:
            raise ValueError("缺项补参来源字段 ID 与绑定不一致")
        if type(entry["value"]) not in (str, int, float, bool) and entry["value"] is not None:
            raise ValueError("缺项补参来源仅支持正式标量选择")
        for key in ("inputs_sha256", "schema_sha256"):
            if not isinstance(entry[key], str) or not _HASH.fullmatch(entry[key]):
                raise ValueError("缺项补参来源绑定摘要无效")
        if entry["native_sha256"] is not None and (not isinstance(entry["native_sha256"], str)
                                                   or not _HASH.fullmatch(entry["native_sha256"])):
            raise ValueError("缺项补参原生实例摘要无效")
        if type(entry["origin_revision"]) is not int or entry["origin_revision"] < 1:
            raise ValueError("缺项补参来源修订无效")
        if 'origin_workflow_id' in entry and (not isinstance(entry['origin_workflow_id'], str)
                                             or not re.fullmatch(r'e-[0-9a-f]{24}', entry['origin_workflow_id'])):
            raise ValueError("缺项补参来源工作流标识无效")
    return copy.deepcopy(overlay)


def repair_sources(overlay, status="saved", reason=None):
    """Safe UI audit: no user values, backend URL, source hashes or credentials."""
    normalized = normalize_repair_overlay(overlay)
    return [{"id": entry["id"], "node_id": entry["node_id"], "input": entry["input"],
             "source": "explicit_missing_input", "origin_revision": entry["origin_revision"],
             **({"origin_workflow_id": entry["origin_workflow_id"]} if 'origin_workflow_id' in entry else {}),
             "status": status, **({"reason": reason} if reason else {})}
            for entry in normalized["entries"]] if normalized else []


def build_repair_overlay(document, source_json, base_prompt, repaired_prompt, info, repairs,
                         backend_url, origin_revision, *, origins=None, workflow_id=None):
    if not repairs:
        return None
    origins = origins or {}
    entries = []
    try:
        graph_index = _GraphIndex(document)
    except (ValueError, KeyError, TypeError):
        graph_index = False
    schema_hashes, input_hashes = {}, {}
    for repair in repairs:
        node_id, name = repair["node_id"], repair["input"]
        node = base_prompt[node_id]
        if node_id not in input_hashes:
            input_hashes[node_id] = fingerprint(node["inputs"])
        if node["class_type"] not in schema_hashes:
            schema_hashes[node["class_type"]] = fingerprint(info[node["class_type"]])
        origin = origins.get(repair['id'])
        origin = origin if isinstance(origin, dict) else {'revision': origin or origin_revision}
        origin_workflow = origin.get('workflow_id') or workflow_id
        entries.append({"id": repair["id"], "node_id": node_id, "input": name,
                        "class_type": node["class_type"],
                        "value": copy.deepcopy(repaired_prompt[node_id]["inputs"][name]),
                        "inputs_sha256": input_hashes[node_id],
                        "schema_sha256": schema_hashes[node["class_type"]],
                        "native_sha256": _native_fingerprint(document, node_id, node["class_type"], graph_index),
                        "origin_revision": origin['revision'],
                        **({'origin_workflow_id': origin_workflow} if origin_workflow else {})})
    return normalize_repair_overlay({"version": 1, "backend_url": backend_url,
                                     "document_sha256": fingerprint(document),
                                     "source_sha256": hashlib.sha256(source_json.encode("utf-8")).hexdigest(),
                                     "entries": entries})


def restore_repair_overlay(document, source_json, prompt, info, overlay, backend_url, *,
                           output_nodes=None, explicit_values=None, additional_inputs=None,
                           context_error=None):
    """Restore only still-missing exact formal bindings, with fresh validation."""
    from .editor_interfaces import apply_missing_interface_values, output_closure
    normalized = normalize_repair_overlay(overlay)
    result = {"prompt": copy.deepcopy(prompt), "repairs": [], "repair_sources": [], "origins": {}}
    if normalized is None:
        return result
    if context_error is None and (normalized["backend_url"] != backend_url
                                  or normalized["document_sha256"] != fingerprint(document)
                                  or normalized["source_sha256"] != hashlib.sha256(source_json.encode("utf-8")).hexdigest()):
        context_error = "source_or_backend_changed"
    if context_error:
        result["repair_sources"] = repair_sources(normalized, "stale", context_error)
        return result
    explicit_values = explicit_values or {}
    active = set(output_closure(prompt, output_nodes, info, allow_no_outputs=True)["node_ids"])
    values, sources, candidates = {}, [], []
    try:
        graph_index = _GraphIndex(document)
    except (ValueError, KeyError, TypeError):
        graph_index = False
    summaries = {item["id"]: item for item in repair_sources(normalized)}
    for entry in normalized["entries"]:
        summary = summaries[entry["id"]]
        node = prompt.get(entry["node_id"])
        reason = None
        if entry["id"] in explicit_values:
            summary["status"] = "explicit_override"
        elif not isinstance(node, dict) or node.get("class_type") != entry["class_type"]:
            reason = "instance_or_class_changed"
        elif entry["node_id"] not in active:
            summary["status"] = "inactive"
        elif entry["input"] in node["inputs"]:
            summary["status"] = "native_value_present"
        elif (entry["native_sha256"] is None
              or _native_fingerprint(document, entry["node_id"], entry["class_type"], graph_index) != entry["native_sha256"]):
            reason = "native_instance_unproven"
        elif not isinstance(info.get(entry["class_type"]), dict) or fingerprint(info[entry["class_type"]]) != entry["schema_sha256"]:
            reason = "live_schema_changed"
        elif fingerprint(node["inputs"]) != entry["inputs_sha256"]:
            reason = "native_inputs_changed"
        else:
            values[entry["id"]] = copy.deepcopy(entry["value"])
            candidates.append((entry, summary))
            summary["status"] = "restored"
        if reason:
            summary.update(status="stale", reason=reason)
        sources.append(summary)
    if values:
        try:
            restored = apply_missing_interface_values(prompt, info, values, output_nodes=output_nodes,
                                                     additional_inputs=additional_inputs)
        except ValueError:
            # Keep the source and require a new explicit choice. Never let an
            # outdated selector, enum, bound or inactive branch become a pass.
            for _, summary in candidates:
                summary.update(status="stale", reason="live_binding_invalid")
        else:
            result["prompt"], result["repairs"] = restored["prompt"], restored["repairs"]
            result["origins"] = {entry["id"]: {'revision': entry["origin_revision"],
                                               'workflow_id': entry.get('origin_workflow_id')}
                                 for entry, _ in candidates}
    result["repair_sources"] = sources
    return result
