"""Data-only, opt-in AI Hub worker contract. Nothing here submits a job."""

import copy
import hashlib
import json
import re
import uuid
from dataclasses import dataclass

from .backend import local_url

PROTOCOL = "aihub-execution/1"
BINDING_PREFIX = "prismcanvas-binding-sha256:"
TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
IDENTITY_FIELDS = ("protocol", "execution_authority_id", "ledger_epoch", "execution_id",
                   "request_id", "origin", "input_sha256", "workspace_binding_revision",
                   "capability_id", "declaration_sha256", "executor", "queue_task_id")


class ContractError(ValueError):
    """Only stable codes cross this boundary; never include raw inputs or credentials."""


def fail(code):
    raise ContractError(code)


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                          allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        fail("invalid_json")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def binding_fingerprint(backend, template, bindings):
    """Digest a locally approved native target, before applying source inputs."""
    if not isinstance(template, dict) or not isinstance(bindings, dict):
        fail("capability_binding_invalid")
    normalized = {}
    for key, path in bindings.items():
        if (not isinstance(key, str) or not key or not isinstance(path, (list, tuple))
                or not 1 <= len(path) <= 3
                or any(not isinstance(part, str) or not part for part in path)):
            fail("capability_binding_invalid")
        normalized[key] = list(path)
    try:
        address = local_url(backend)
    except (ValueError, TypeError):
        fail("capability_binding_invalid")
    return sha(canonical({"backend": address, "template": template, "bindings": normalized}))


def bind_declaration(declaration, backend, template, bindings):
    """Return a new Hub-compatible declaration containing one binding digest.

    Call this before publishing the declaration. Changing a native binding needs
    a newly published declaration; prepare never silently repairs an old claim.
    """
    if not isinstance(declaration, dict):
        fail("capability_binding_required")
    constraints = declaration.get("constraints", [])
    if not isinstance(constraints, list) or any(not isinstance(item, str) for item in constraints):
        fail("capability_binding_required")
    result = copy.deepcopy(declaration)
    result["constraints"] = [item for item in constraints if not item.startswith(BINDING_PREFIX)]
    result["constraints"].append(BINDING_PREFIX + binding_fingerprint(backend, template, bindings))
    canonical(result)
    return result


def strict_json(text, limit=16000):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail("duplicate_json_key")
            result[key] = value
        return result

    try:
        if not isinstance(text, str) or len(text.encode("utf-8")) > limit:
            fail("json_limit")
        result = json.loads(text, object_pairs_hook=pairs,
                            parse_constant=lambda _: fail("nonfinite_json"))
        # Reject escaped surrogates, huge exponent overflow and unreasonable depth.
        canonical(result)
        stack = [(result, 0)]
        while stack:
            item, depth = stack.pop()
            if depth > 32:
                fail("json_depth")
            children = item.values() if isinstance(item, dict) else item if isinstance(item, list) else []
            stack.extend((child, depth + 1) for child in children)
        return result
    except ContractError:
        raise
    except (ValueError, TypeError, UnicodeError, RecursionError):
        fail("invalid_json")


def require_uuid(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            fail("invalid_identity")
    except (ValueError, AttributeError):
        fail("invalid_identity")
    return value


def require_hash(value):
    if not isinstance(value, str) or not re.fullmatch("[0-9a-f]{64}", value):
        fail("invalid_digest")
    return value


def identity(receipt, binding, execution_id):
    if not isinstance(receipt, dict) or receipt.get("protocol") != PROTOCOL:
        fail("receipt_protocol")
    for key in ("execution_authority_id", "ledger_epoch", "workspace_binding_revision"):
        if receipt.get(key) != binding[key]:
            fail("receipt_scope")
    if receipt.get("execution_id") != require_uuid(execution_id):
        fail("receipt_execution")
    for key in ("execution_id", "request_id", "queue_task_id"):
        require_uuid(receipt.get(key))
    for key in ("input_sha256", "declaration_sha256"):
        require_hash(receipt.get(key))
    executor = receipt.get("executor")
    if (not isinstance(executor, dict) or executor.get("client_id") != binding["client_id"]
            or not isinstance(executor.get("tool"), str) or not executor["tool"]):
        fail("receipt_executor")
    if not re.fullmatch("[0-9a-f]{32}", str(receipt.get("capability_id", ""))):
        fail("receipt_capability")
    origin = receipt.get("origin")
    if not isinstance(origin, dict) or set(origin) != {
            "authority_id", "project_id", "task_id", "run_id", "call_id", "input_revision"}:
        fail("receipt_origin")
    if any(not isinstance(value, str) or not value for value in origin.values()):
        fail("receipt_origin")
    return copy.deepcopy({key: receipt[key] for key in IDENTITY_FIELDS})


def validate_inputs(value, schema):
    """Small closed schema dialect; unsupported constraints fail instead of being ignored."""
    if not isinstance(schema, dict):
        fail("input_schema")
    allowed = {"type", "properties", "required", "additionalProperties", "items", "enum",
               "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
               "description", "title", "default"}
    if set(schema) - allowed or schema.get("additionalProperties", False) is not False:
        fail("unsupported_input_schema")
    kind = schema.get("type")
    matches = {"object": isinstance(value, dict), "array": isinstance(value, list),
               "string": isinstance(value, str), "integer": type(value) is int,
               "number": type(value) in (int, float), "boolean": type(value) is bool}
    if not matches.get(kind, False):
        fail("input_type")
    if "enum" in schema and not any(type(value) is type(v) and value == v for v in schema["enum"]):
        fail("input_enum")
    if kind == "object":
        properties = schema.get("properties", {})
        if set(value) - set(properties) or set(schema.get("required", [])) - set(value):
            fail("input_fields")
        for key, child in value.items():
            validate_inputs(child, properties[key])
    elif kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 64):
            fail("input_length")
        for child in value:
            validate_inputs(child, schema.get("items"))
    elif kind == "string":
        if not schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", 16000):
            fail("input_length")
    elif kind in {"integer", "number"}:
        if not schema.get("minimum", -float("inf")) <= value <= schema.get("maximum", float("inf")):
            fail("input_range")


@dataclass(frozen=True)
class EnabledCapability:
    """Locally approved declaration and request template; source cannot choose a graph/path."""

    capability_id: str
    declaration_text: str
    backend: str
    template: dict
    bindings: dict

    def prepare(self, claim):
        if claim.get("capability_id") != self.capability_id:
            fail("capability_disabled")
        if (claim.get("declaration_text") != self.declaration_text
                or sha(self.declaration_text.encode("utf-8")) != claim.get("declaration_sha256")):
            fail("declaration_changed")
        raw = claim.get("input_json")
        inputs = strict_json(raw)
        if sha(raw.encode("utf-8")) != claim.get("input_sha256"):
            fail("input_digest")
        declaration = strict_json(self.declaration_text, 256000)
        constraints = declaration.get("constraints", []) if isinstance(declaration, dict) else None
        if not isinstance(constraints, list) or any(not isinstance(item, str) for item in constraints):
            fail("capability_binding_required")
        markers = [item for item in constraints if item.startswith(BINDING_PREFIX)]
        if len(markers) != 1 or not re.fullmatch(re.escape(BINDING_PREFIX) + "[0-9a-f]{64}", markers[0]):
            fail("capability_binding_required")
        if markers[0] != BINDING_PREFIX + binding_fingerprint(self.backend, self.template, self.bindings):
            fail("capability_binding_changed")
        validate_inputs(inputs, declaration.get("inputs"))
        if set(inputs) - set(self.bindings):
            fail("unbound_input")
        request = copy.deepcopy(self.template)
        if request.get("kind") in {None, "api"}:
            fail("unbounded_template")
        targets = set()
        for key, value in inputs.items():
            path = self.bindings[key]
            if (not isinstance(path, (list, tuple)) or not 1 <= len(path) <= 3
                    or any(not isinstance(part, str) or not part for part in path)):
                fail("invalid_binding")
            # Identity, graph selection and filesystem/backend fields are never source inputs.
            allowed = {"positive", "negative", "seed", "steps", "cfg", "width", "height",
                       "denoise", "fps", "seconds", "values", "refine", "models"}
            if path[0] not in allowed or tuple(path) in targets:
                fail("invalid_binding")
            if isinstance(value, (list, dict)) or value is None:
                fail("unsupported_binding_value")
            targets.add(tuple(path))
            target = request
            for part in path[:-1]:
                target = target.get(part) if isinstance(target, dict) else None
            if not isinstance(target, dict) or path[-1] not in target:
                fail("binding_target_missing")
            target[path[-1]] = value
        canonical(request)
        return request, local_url(self.backend)


def observation_matches(receipt, payload):
    outcome = {key: payload[key] for key in ("error_code", "cancel_evidence") if key in payload}
    if (receipt.get("provider_state") != payload["provider_state"]
            or receipt.get("provider_request_id") != payload["provider_request_id"]
            or sorted(receipt.get("results", []), key=lambda v: v["result_id"])
            != sorted(payload.get("results", []), key=lambda v: v["result_id"])
            or receipt.get("outcome", {}) != outcome):
        fail("observation_receipt_mismatch")
    if payload["provider_state"] == "succeeded":
        expected = sha(canonical(sorted(payload["results"], key=lambda v: v["result_id"])))
        if receipt.get("results_manifest_sha256") != expected:
            fail("results_manifest_mismatch")
