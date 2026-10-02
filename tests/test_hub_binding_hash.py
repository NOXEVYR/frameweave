"""Declarations bind the local native template before any execution can start."""

import copy
import tempfile
import unittest
from pathlib import Path

from frameweave.hub_execution import Worker
from frameweave.hub_execution_contract import (BINDING_PREFIX, ContractError, EnabledCapability,
                                               bind_declaration, binding_fingerprint, canonical, sha)
from frameweave.hub_execution_store import WorkerStore
from test_hub_execution import FakeHub, FakeNative


BACKEND = "http://127.0.0.1:8188"
TEMPLATE = {"kind": "package", "package_id": "p-fixed",
            "values": {"text": "default", "steps": 20}, "seed": 42}
BINDINGS = {"text": ["values", "text"]}
DECLARATION = {"key": "prism.test", "inputs": {"type": "object", "properties": {
    "text": {"type": "string", "maxLength": 200}}, "required": ["text"]}}


class BindingHashTests(unittest.TestCase):
    def claim(self, declaration):
        text, raw = canonical(declaration).decode(), '{ "text": "test image" }'
        return {"capability_id": "b" * 32, "declaration_text": text,
                "declaration_sha256": sha(text.encode()), "input_json": raw,
                "input_sha256": sha(raw.encode())}

    def prepare(self, declaration, *, backend=BACKEND, template=None, bindings=None):
        claim = self.claim(declaration)
        return EnabledCapability(claim["capability_id"], claim["declaration_text"], backend,
                                 copy.deepcopy(TEMPLATE if template is None else template),
                                 copy.deepcopy(BINDINGS if bindings is None else bindings)).prepare(claim)

    def bound(self):
        return bind_declaration(DECLARATION, BACKEND, TEMPLATE, BINDINGS)

    def test_equivalent_backend_key_order_and_tuple_bindings_are_stable(self):
        other = {"seed": 42, "values": {"steps": 20, "text": "default"},
                 "package_id": "p-fixed", "kind": "package"}
        expected = binding_fingerprint(BACKEND, TEMPLATE, BINDINGS)
        self.assertEqual(expected, binding_fingerprint("http://localhost:8188/", other,
                                                      {"text": ("values", "text")}))
        self.assertEqual(len(expected), 64)

    def test_each_binding_component_and_unused_defaults_change_fingerprint(self):
        base = binding_fingerprint(BACKEND, TEMPLATE, BINDINGS)
        changed_template = copy.deepcopy(TEMPLATE)
        changed_template["values"]["steps"] = 30
        for backend, template, bindings in (
                ("http://127.0.0.1:8189", TEMPLATE, BINDINGS),
                (BACKEND, changed_template, BINDINGS),
                (BACKEND, TEMPLATE, {"text": ["values", "steps"]}),
                (BACKEND, TEMPLATE, {**BINDINGS, "unused": ["seed"]})):
            with self.subTest(backend=backend, bindings=bindings):
                self.assertNotEqual(base, binding_fingerprint(backend, template, bindings))

    def test_json_scalar_type_differences_are_not_equal(self):
        first, second = copy.deepcopy(TEMPLATE), copy.deepcopy(TEMPLATE)
        first["seed"], second["seed"] = 1, True
        self.assertNotEqual(binding_fingerprint(BACKEND, first, BINDINGS),
                            binding_fingerprint(BACKEND, second, BINDINGS))

    def test_bind_returns_deep_copy_replaces_all_old_markers_and_is_idempotent(self):
        source = copy.deepcopy(DECLARATION)
        source["constraints"] = ["keep-one", BINDING_PREFIX + "stale", "keep-two",
                                  BINDING_PREFIX + "0" * 64]
        saved = copy.deepcopy(source)
        bound = bind_declaration(source, BACKEND, TEMPLATE, BINDINGS)
        self.assertEqual(bound["constraints"][:2], ["keep-one", "keep-two"])
        self.assertEqual(len(bound["constraints"]), 3)
        self.assertEqual(bound, bind_declaration(bound, BACKEND, TEMPLATE, BINDINGS))
        bound["inputs"]["properties"]["text"]["maxLength"] = 1
        self.assertEqual(source, saved)

    def test_binding_shape_and_nonlocal_backend_refused(self):
        for backend, template, bindings in (("https://example.com", TEMPLATE, BINDINGS),
                (BACKEND, [], BINDINGS), (BACKEND, TEMPLATE, []),
                (BACKEND, TEMPLATE, {"text": "values.text"}),
                (BACKEND, TEMPLATE, {"text": []}),
                (BACKEND, TEMPLATE, {"text": ["values", 0]}),
                (BACKEND, TEMPLATE, {"": ["seed"]})):
            with self.subTest(bindings=bindings), self.assertRaisesRegex(ContractError, "capability_binding_invalid"):
                binding_fingerprint(backend, template, bindings)

    def test_invalid_declaration_constraints_do_not_get_silently_replaced(self):
        for declaration in ([], {**DECLARATION, "constraints": None},
                            {**DECLARATION, "constraints": "old"},
                            {**DECLARATION, "constraints": [1]}):
            with self.subTest(declaration=declaration), self.assertRaisesRegex(ContractError, "capability_binding_required"):
                bind_declaration(declaration, BACKEND, TEMPLATE, BINDINGS)

    def test_bound_prepare_applies_inputs_without_mutating_native_template(self):
        request, backend = self.prepare(self.bound())
        self.assertEqual(request["values"], {"text": "test image", "steps": 20})
        self.assertEqual(request["package_id"], "p-fixed")
        self.assertEqual(backend, BACKEND)
        self.assertEqual(TEMPLATE["values"]["text"], "default")

    def test_unmarked_declaration_requires_republication(self):
        with self.assertRaisesRegex(ContractError, "capability_binding_required"):
            self.prepare(DECLARATION)

    def test_duplicate_or_malformed_markers_rejected(self):
        bound = self.bound()
        marker = bound["constraints"][0]
        for constraints in ([marker, marker], [marker, BINDING_PREFIX + "broken"],
                            [BINDING_PREFIX + "f" * 63], [BINDING_PREFIX + "F" * 64],
                            [BINDING_PREFIX + "f" * 64 + " "], "not-an-array", [marker, None]):
            with self.subTest(constraints=constraints), self.assertRaisesRegex(ContractError, "capability_binding_required"):
                self.prepare({**bound, "constraints": constraints})

    def test_stale_local_template_backend_or_mapping_refused(self):
        bound = self.bound()
        changed = copy.deepcopy(TEMPLATE)
        changed["package_id"] = "p-replaced"
        variants = ({"template": changed}, {"backend": "http://127.0.0.1:8189"},
                    {"bindings": {"text": ["values", "steps"]}})
        for variant in variants:
            with self.subTest(variant=variant), self.assertRaisesRegex(ContractError, "capability_binding_changed"):
                self.prepare(bound, **variant)

    def test_rebound_declaration_has_new_digest_and_old_claim_is_rejected(self):
        original = self.bound()
        changed = copy.deepcopy(TEMPLATE)
        changed["values"]["steps"] = 30
        rebound = bind_declaration(original, BACKEND, changed, BINDINGS)
        before, after = self.claim(original), self.claim(rebound)
        self.assertNotEqual(before["declaration_sha256"], after["declaration_sha256"])
        cap = EnabledCapability("b" * 32, after["declaration_text"], BACKEND, changed, BINDINGS)
        with self.assertRaisesRegex(ContractError, "declaration_changed"):
            cap.prepare(before)
        request, _ = cap.prepare(after)
        self.assertEqual(request["values"]["steps"], 30)

    def test_bound_hash_does_not_relax_forbidden_target_validation(self):
        bindings = {"text": ["package_id"]}
        declaration = bind_declaration(DECLARATION, BACKEND, TEMPLATE, bindings)
        with self.assertRaisesRegex(ContractError, "invalid_binding"):
            self.prepare(declaration, bindings=bindings)

    def test_stale_binding_worker_claim_never_observes_or_attempts_native(self):
        with tempfile.TemporaryDirectory() as temp:
            hub, native = FakeHub(), FakeNative()
            declared = self.claim(self.bound())
            hub.raw = declared["input_json"]
            hub.receipt.update({key: declared[key] for key in ("declaration_sha256", "input_sha256")})
            claim_original = hub.claim

            def claim(execution_id, claim_request_id):
                result = claim_original(execution_id, claim_request_id)
                result["declaration_text"] = declared["declaration_text"]
                return result

            hub.claim = claim
            changed = copy.deepcopy(TEMPLATE)
            changed["values"]["steps"] = 99
            capability = EnabledCapability("b" * 32, declared["declaration_text"], BACKEND, changed, BINDINGS)
            store = WorkerStore(Path(temp) / "worker.sqlite3", hub.binding)
            execution_id = hub.receipt["execution_id"]
            with self.assertRaisesRegex(ContractError, "capability_binding_changed"):
                Worker(store, hub, native, [capability]).step(execution_id)
            self.assertFalse(store.get(execution_id)["native_attempted"])
            self.assertIsNone(store.get(execution_id)["claim"])
            self.assertEqual(native.submissions, [])
            self.assertEqual(hub.observations, {})


if __name__ == "__main__":
    unittest.main()
