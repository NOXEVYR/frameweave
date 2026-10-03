"""Derive audio workflow-package availability from the live backend schema."""

from __future__ import annotations

import copy
import math
import re

from .media_contract import MEDIA_TYPES
from .workflows import (_check_json_limits, _editor_resource_input, _expanded_inputs,
                        _input_fields, _match_type_resolver, _spec, _type_names,
                        validate_editor_prompt)


MAX_AUDIO_DIAGNOSTICS = 20
_PRIVATE_SUFFIXES = (".wav", ".mp3", ".flac", ".ogg", ".aac", ".m4a", ".wma",
                     ".mp4", ".webm", ".mov", ".mkv", ".avi", ".png", ".jpg",
                     ".jpeg", ".webp", ".gif", ".safetensors", ".gguf", ".ckpt",
                     ".pt", ".pth", ".bin", ".onnx", ".json", ".txt")
_DIAGNOSTIC_MESSAGES = {
    "invalid_graph": "工作流包没有有效的 API 图，或图连接结构不合法",
    "missing_node": "当前后端缺少此节点类型",
    "invalid_node": "节点缺少有效的 inputs 对象",
    "invalid_schema": "当前后端的节点或输入定义无效",
    "unsupported_api_node": "本地模式不支持此云端 API 节点",
    "missing_input": "缺少必填输入",
    "unsupported_input": "当前后端不支持此输入",
    "enum_unavailable": "当前后端的下拉选项目录为空",
    "invalid_selection": "所选项已不在当前后端目录中，请重新选择",
    "missing_model": "模型未选择或已不在当前后端目录中，请重新选择",
    "missing_media": "媒体未上传或已不在当前后端目录中，请重新上传或选择",
    "unsafe_resource": "资源名称不符合本地安全输入规则，请重新选择",
    "invalid_value_type": "输入值类型与当前后端定义不符",
    "value_out_of_range": "数值超出当前后端允许范围",
    "missing_connection": "此输入必须连接节点输出",
    "invalid_connection": "连接的上游节点或输出插槽无效",
    "connection_type_mismatch": "连接的上游输出类型与此输入不匹配",
    "schema_incompatible": "节点或参数与当前后端定义不兼容",
    "no_audio_output": "工作流包没有连接到 AUDIO 输入的后端输出节点",
}


class _Diagnostics:
    """Keep an exact count while retaining only the public bounded sample."""

    def __init__(self, items=()):
        self.items = []
        self.total = 0
        for item in items:
            self.append(item)

    def append(self, item):
        self.total += 1
        if len(self.items) < MAX_AUDIO_DIAGNOSTICS:
            self.items.append(item)

    def __bool__(self):
        return self.total > 0


def _diagnostic(code, *, node_id=None, class_type=None, input=None, resource_type=None):
    """Publish identifiers only; never exception messages, values or catalogs.

    Paths, media/model filenames, controls and overlong identifiers are omitted.
    Dotted dynamic inputs and colon-separated subgraph IDs retain their targets.
    """
    result = {"code": code if code in _DIAGNOSTIC_MESSAGES else "schema_incompatible"}
    for key, value in (("node_id", node_id), ("class_type", class_type), ("input", input)):
        pattern = (r"[A-Za-z0-9_:-]+" if key == "node_id" else
                   r"[A-Za-z_][A-Za-z0-9_:+-]*(?:\.[A-Za-z_][A-Za-z0-9_:+-]*)*" if key == "input" else
                   r"[A-Za-z_][A-Za-z0-9_ :+-]*")
        if (isinstance(value, str) and len(value) <= 128 and
                not value.casefold().endswith(_PRIVATE_SUFFIXES) and re.fullmatch(pattern, value)):
            result[key] = value
    if resource_type in {"model", "image", "audio", "video"}:
        result["resource_type"] = resource_type
    return result


def _diagnostic_message(item):
    target = item.get("class_type", "")
    if item.get("node_id"):
        target = f"节点 {item['node_id']}" + (f" ({target})" if target else "")
    if item.get("input"):
        target += f".{item['input']}"
    message = _DIAGNOSTIC_MESSAGES[item["code"]]
    return f"{target}：{message}" if target else message


def _readiness_diagnostics(issues, prompt, object_info, pending):
    result = _Diagnostics()
    for issue in issues:
        if (issue.get("code") == "missing_media" and
                (issue.get("node_id"), issue.get("input"), issue.get("resource_type")) in pending):
            continue
        node_id, name = issue.get("node_id"), issue.get("input")
        node = prompt.get(node_id, {})
        class_type = node.get("class_type") if isinstance(node, dict) else None
        resource = issue.get("resource_type")
        if issue.get("code") == "enum_unavailable":
            try:
                fields, required = _expanded_inputs(object_info[class_type], node["inputs"])
                resource = _editor_resource_input(class_type, name, fields[name], required=name in required)
            except (KeyError, TypeError, ValueError):
                pass
        result.append(_diagnostic(issue.get("code"), node_id=node_id,
                                  class_type=class_type, input=name, resource_type=resource))
    return result


def _validation_failure_diagnostics(prompt, object_info, pending):
    """Locate common hard failures using the same live schema helpers.

    This is diagnostic explanation only. The full validator's failure always
    keeps schema_supported false, including failures this scan cannot locate.
    """
    if len(prompt) > 1000 or any(not isinstance(key, str) or not key for key in prompt):
        return _Diagnostics([_diagnostic("invalid_graph")])
    try:
        _check_json_limits(prompt)
    except ValueError:
        return _Diagnostics([_diagnostic("invalid_graph")])
    resolve_output, resolve_input = _match_type_resolver(prompt, object_info)
    result = _Diagnostics()
    for node_id, node in prompt.items():
        class_type = node.get("class_type") if isinstance(node, dict) else None
        def add(code, name=None, resource=None):
            result.append(_diagnostic(code, node_id=node_id, class_type=class_type,
                                      input=name, resource_type=resource))
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            add("invalid_node")
            continue
        if not isinstance(class_type, str) or class_type not in object_info:
            add("missing_node")
            continue
        schema = object_info[class_type]
        if not isinstance(schema, dict):
            add("invalid_schema")
            continue
        if schema.get("api_node") is True:
            add("unsupported_api_node")
            continue
        try:
            fields, required = _expanded_inputs(schema, node["inputs"])
        except (TypeError, ValueError):
            add("invalid_schema")
            continue
        for name in sorted(required - node["inputs"].keys()):
            add("missing_input", name)
        for name, value in node["inputs"].items():
            if name not in fields:
                add("unsupported_input", name)
                continue
            try:
                kind, meta = _spec(fields[name])
                is_link = (isinstance(value, list) and len(value) == 2 and
                           isinstance(value[0], str) and type(value[1]) is int)
                if is_link:
                    source, slot = value
                    if source not in prompt:
                        add("invalid_connection", name)
                        continue
                    upstream = prompt.get(source, {})
                    upstream_schema = object_info.get(upstream.get("class_type")) if isinstance(upstream, dict) else None
                    if not isinstance(upstream_schema, dict):
                        # The upstream node has its own missing/invalid schema
                        # diagnostic. Unknown outputs are not absent outputs.
                        continue
                    outputs = upstream_schema.get("output", []) if isinstance(upstream_schema, dict) else []
                    if slot < 0 or slot >= len(outputs):
                        add("invalid_connection", name)
                        continue
                    expected = resolve_input(node_id, meta) if kind == "COMFY_MATCHTYPE_V3" else _type_names(kind)
                    actual = resolve_output(source, slot)
                    if "*" not in expected | actual and not expected & actual:
                        add("connection_type_mismatch", name)
                    continue
                options = (kind if isinstance(kind, list) else
                           meta.get("options", []) if kind in {"COMBO", "COMFY_DYNAMICCOMBO_V3"} else None)
                resource = (_editor_resource_input(class_type, name, fields[name], required=name in required)
                            if (kind == "STRING" or (options is not None and
                                kind != "COMFY_DYNAMICCOMBO_V3" and not meta.get("multiselect"))) else None)
                if resource is not None:
                    if not isinstance(value, str):
                        add("invalid_value_type", name, resource)
                        continue
                    if value:
                        from .diagnostics import safe_relative
                        try:
                            safe_relative(value)
                        except ValueError:
                            add("unsafe_resource", name, resource)
                            continue
                if options is not None:
                    if not isinstance(options, list):
                        add("invalid_schema", name)
                        continue
                    if kind == "COMFY_DYNAMICCOMBO_V3":
                        options = [option["key"] for option in options]
                    if not options and kind != "COMFY_DYNAMICCOMBO_V3" and not any(meta.get(key) for key in ("multiselect", "forceInput", "rawLink")):
                        add("enum_unavailable", name, resource)
                    elif resource and not meta.get("multiselect") and kind != "COMFY_DYNAMICCOMBO_V3":
                        if (resource in MEDIA_TYPES and name not in required and not value):
                            continue
                        if not value.strip() or value not in options:
                            if (node_id, name, resource) not in pending:
                                add("missing_model" if resource == "model" else "missing_media", name, resource)
                    elif ((not isinstance(value, list) or any(item not in options for item in value))
                          if meta.get("multiselect") else value not in options):
                        add("invalid_selection", name)
                elif kind in {"INT", "FLOAT", "BOOLEAN", "STRING"}:
                    valid = {"INT": type(value) is int,
                             "FLOAT": type(value) is int or (type(value) is float and math.isfinite(value)),
                             "BOOLEAN": type(value) is bool, "STRING": isinstance(value, str)}[kind]
                    if not valid:
                        add("invalid_value_type", name, resource)
                    elif kind in {"INT", "FLOAT"} and (("min" in meta and value < meta["min"]) or ("max" in meta and value > meta["max"])):
                        add("value_out_of_range", name)
                    elif resource and not value.strip() and (name in required or resource not in MEDIA_TYPES) and (node_id, name, resource) not in pending:
                        add("missing_model" if resource == "model" else "missing_media", name, resource)
                else:
                    add("missing_connection", name)
            except (KeyError, TypeError, ValueError, OverflowError):
                add("schema_incompatible", name)
    return result or _Diagnostics([_diagnostic("invalid_graph")])


def _audio_output_inputs(object_info):
    """Find schema-declared output nodes that consume a real AUDIO connection."""
    result = []
    for class_type, schema in object_info.items():
        if not isinstance(schema, dict) or schema.get("output_node") is not True:
            continue
        try:
            fields, _ = _expanded_inputs(schema, {})
        except (TypeError, ValueError):
            fields = _input_fields(schema)
        for name, definition in fields.items():
            try:
                kind, meta = _spec(definition)
            except ValueError:
                continue
            types = _type_names(kind)
            if kind == "COMFY_MATCHTYPE_V3":
                types = _type_names(meta.get("template", {}).get("allowed_types", "*"))
            if "AUDIO" in types:
                result.append({"class_type": class_type, "input": name, "type": "AUDIO"})
    return sorted(result, key=lambda item: (item["class_type"].casefold(), item["input"].casefold()))


def _pending_upload_fields(package, prompt):
    """Identify only explicitly exposed, empty media-upload placeholders."""
    fields = package.get("fields", [])
    if not isinstance(fields, list):
        return set()
    pending = set()
    for field in fields:
        if not isinstance(field, dict) or field.get("type") not in MEDIA_TYPES:
            continue
        node_id, input_name = field.get("node_id"), field.get("input")
        node = prompt.get(node_id) if isinstance(node_id, str) else None
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        if not isinstance(input_name, str) or node["inputs"].get(input_name) != "":
            continue
        pending.add((node_id, input_name, field["type"]))
    return pending


def _package_audio_outputs(package, object_info, output_schemas):
    source_prompt = package.get("prompt")
    if not isinstance(source_prompt, dict) or not source_prompt:
        return False, [], _Diagnostics([_diagnostic("invalid_graph")])
    prompt = copy.deepcopy(source_prompt)
    pending = _pending_upload_fields(package, prompt)
    try:
        readiness = validate_editor_prompt(prompt, object_info)
    except (TypeError, ValueError):
        try:
            diagnostics = _validation_failure_diagnostics(prompt, object_info, pending)
        except Exception:
            # Explanation is best effort and must not interrupt other packages.
            # Never publish the exception text, even for unexpected schema data.
            diagnostics = _Diagnostics([_diagnostic("schema_incompatible")])
        return False, [], diagnostics
    diagnostics = _readiness_diagnostics(readiness["issues"], prompt, object_info, pending)
    if diagnostics:
        return False, [], diagnostics

    output_fields = {(item["class_type"], item["input"]) for item in output_schemas}
    found = []
    for node_id, node in prompt.items():
        class_type = node.get("class_type")
        inputs = node.get("inputs", {})
        for input_name, value in inputs.items():
            if (class_type, input_name) not in output_fields:
                continue
            if (isinstance(value, list) and len(value) == 2 and isinstance(value[0], str)
                    and type(value[1]) is int):
                found.append({"type": "audio", "node_id": node_id,
                              "class_type": class_type, "input": input_name})
    if not found:
        return True, [], _Diagnostics([_diagnostic("no_audio_output")])
    return True, found, _Diagnostics()


def audio_capabilities(object_info: dict, packages) -> dict:
    """Return all packages with explicit live-schema audio eligibility.

    Package category is organizational metadata, not an inferred model capability.
    Packages without a saved ``voice``/``music`` category are returned as
    ``unclassified`` so the client can keep the user's local classification.
    """
    info = object_info if isinstance(object_info, dict) else {}
    schemas = _audio_output_inputs(info)
    entries = []
    for package in packages if isinstance(packages, (list, tuple)) else ():
        if not isinstance(package, dict):
            continue
        prompt = package.get("prompt")
        schema_supported, audio_outputs, all_diagnostics = _package_audio_outputs(package, info, schemas)
        diagnostics = all_diagnostics.items
        issues = [_diagnostic_message(item) for item in diagnostics]
        requirements = package.get("requirements")
        if not isinstance(requirements, dict):
            nodes = sorted({node.get("class_type") for node in prompt.values()
                            if isinstance(node, dict) and isinstance(node.get("class_type"), str)}) \
                if isinstance(prompt, dict) else []
            requirements = {"nodes": nodes}
        category = package.get("category", package.get("audio_category"))
        if category not in {"voice", "music"}:
            category = "unclassified"
        eligible = schema_supported and bool(audio_outputs)
        entries.append({
            "id": package.get("id"),
            "name": package.get("name", "未命名音频工作流"),
            "category": category,
            "fields": copy.deepcopy(package.get("fields", [])),
            "requirements": copy.deepcopy(requirements),
            "schema_supported": schema_supported,
            "eligible": eligible,
            "available": eligible,
            "reason": None if eligible else (issues[0] if issues else "工作流包当前不可用于音频生成"),
            "issues": issues,
            "diagnostics": diagnostics,
            "diagnostics_total": all_diagnostics.total,
            "diagnostics_truncated": all_diagnostics.total > len(diagnostics),
            "audio_outputs": audio_outputs,
        })
    eligible_count = sum(1 for item in entries if item["eligible"])
    reason = None
    if not schemas:
        reason = "当前后端没有可验证的 AUDIO 输出节点"
    elif not eligible_count:
        reason = "尚无通过当前后端校验的音频工作流包"
    return {"available": eligible_count > 0, "schema_available": bool(schemas),
            "reason": reason, "outputs": schemas, "packages": entries}
