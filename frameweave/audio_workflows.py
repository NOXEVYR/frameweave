"""Derive audio workflow-package availability from the live backend schema."""

from __future__ import annotations

import copy

from .media_contract import MEDIA_TYPES
from .workflows import _expanded_inputs, _input_fields, _spec, _type_names, validate_editor_prompt


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
        return False, [], ["工作流包没有可校验的 API 图"]
    prompt = copy.deepcopy(source_prompt)
    try:
        readiness = validate_editor_prompt(prompt, object_info)
    except (TypeError, ValueError):
        return False, [], ["节点或参数与当前后端定义不兼容"]
    pending = _pending_upload_fields(package, prompt)
    if any(issue.get("code") != "missing_media" or
           (issue.get("node_id"), issue.get("input"), issue.get("resource_type")) not in pending
           for issue in readiness["issues"]):
        return False, [], ["节点或参数与当前后端定义不兼容"]

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
        return True, [], ["工作流包没有连接到 AUDIO 输入的后端输出节点"]
    return True, found, []


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
        schema_supported, audio_outputs, issues = _package_audio_outputs(package, info, schemas)
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
