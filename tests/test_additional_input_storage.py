"""Portable dynamic-link observations and private compiled revision regressions."""

import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from frameweave.automation import ADDITIONAL_INPUTS_SCHEMA, PACKAGE_SCHEMA, REQUEST_SCHEMA, _validate
from frameweave.editor_interfaces import (apply_missing_interface_values, inspect_interface,
                                          select_outputs)
from frameweave.editor_workflows import EditorWorkflowStore
from frameweave.packages import (PackageStore, encoded, inspect_document, normalize_document,
                                transport_document, validate_planning_fields)


def fixture():
    prompt = {
        "text": {"class_type": "Text", "inputs": {"value": "third"}},
        "first": {"class_type": "Text", "inputs": {"value": "first"}},
        "join": {"class_type": "SyntheticExtension", "inputs": {
            "base": ["first", 0], "arbitrary_port": ["text", 0]}},
        "out": {"class_type": "Sink", "inputs": {"value": ["join", 0]}},
    }
    info = {
        "Text": {"input": {"required": {"value": ["STRING"]}}, "output": ["STRING"]},
        "SyntheticExtension": {"input": {"required": {"base": ["STRING"]}}, "output": ["STRING"]},
        "Sink": {"input": {"required": {"value": ["STRING"]}}, "output": [], "output_node": True},
    }
    sidecar = {"version": 1, "nodes": {"join": {"class_type": "SyntheticExtension", "inputs": {
        "arbitrary_port": {"type": "STRING", "accept": "link", "source": ["text", 0]},
    }}}}
    return prompt, info, sidecar


def document():
    prompt, info, sidecar = fixture()
    draft = inspect_document({"prompt": prompt, "additional_inputs": sidecar}, info)
    return {**draft, "name": "Dynamic join"}


class AdditionalInputStorageTests(unittest.TestCase):
    def test_package_save_export_raw_transport_retains_exact_sidecar(self):
        original = document()
        before = copy.deepcopy(original)
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory) / "one")
            saved = store.save(original)
            self.assertEqual(saved["additional_inputs"], fixture()[2])
            exported = store.export_transport(saved["id"])
            self.assertEqual(exported["document"]["additional_inputs"], fixture()[2])
            other = PackageStore(Path(directory) / "two")
            restored = other.save(transport_document({"source_json": exported["source_json"]}))
            self.assertEqual(restored["id"], saved["id"])
            self.assertEqual((store.directory / (saved["id"] + ".json")).read_bytes(),
                             (other.directory / (saved["id"] + ".json")).read_bytes())
        self.assertEqual(original, before)

    def test_provenance_and_runtime_proof_are_excluded_from_portable_export(self):
        candidate = document()
        candidate["additional_inputs"]["provenance"] = {
            "backend_url": "http://127.0.0.1:18181", "token": "DO_NOT_EXPORT_TOKEN",
            "receipt": "DO_NOT_EXPORT_RECEIPT", "backend_path": "/private/backend"}
        candidate["contract_proof"] = {"token": "DO_NOT_EXPORT_PROOF"}
        with self.assertRaisesRegex(ValueError, "私有证明"):
            normalize_document(candidate)
        candidate.pop("contract_proof")
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory))
            saved = store.save(candidate)
            source = store.export_transport(saved["id"])["source_json"]
            self.assertEqual(saved["additional_inputs"], fixture()[2])
            for value in ("provenance", "contract_proof", "DO_NOT_EXPORT", "/private/backend", "18181"):
                self.assertNotIn(value, source)

    def test_http_normalizer_and_mcp_reject_only_reserved_private_top_level_fields(self):
        candidate = document()
        expected = normalize_document(candidate)
        ordinary = {**candidate, "draft_note": "legacy inert metadata", "created_at": 42}
        self.assertEqual(normalize_document(ordinary), expected)
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory) / "packages")
            for name in ("contract_proof", "session_token", "native_input_receipt"):
                private = {**candidate, name: {"claimed": "native"}}
                with self.subTest(name=name):
                    with self.assertRaises(ValueError):
                        normalize_document(private)
                    with self.assertRaises(ValueError):
                        _validate(private, PACKAGE_SCHEMA)
                    with self.assertRaises(ValueError):
                        store.save(private)
            self.assertFalse(store.directory.exists())
            saved = store.save(ordinary)
            self.assertEqual(store.export(saved["id"]), expected)

    def test_legacy_package_without_sidecar_keeps_bytes_and_content_id(self):
        legacy = {"format": "frameweave-workflow", "version": 1, "name": "Legacy", "description": "",
                  "prompt": {"t": {"class_type": "Text", "inputs": {"value": "ok", "cfg": 7.0}}},
                  "fields": []}
        expected = encoded(legacy)
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory))
            saved = store.save(legacy)
            self.assertEqual(saved["id"], "p-" + hashlib.sha256(expected).hexdigest()[:24])
            self.assertEqual((Path(directory) / (saved["id"] + ".json")).read_bytes(), expected)
            self.assertEqual(store.export_transport(saved["id"])["source_json"].encode(), expected)
            self.assertNotIn("additional_inputs", store.export(saved["id"]))
        inspected = inspect_document({"prompt": legacy["prompt"]})
        self.assertNotIn("additional_inputs", inspected)

    def test_live_inspection_only_exposes_declared_upstream_controls(self):
        prompt, info, sidecar = fixture()
        inspected = inspect_interface(prompt, info, additional_inputs=sidecar)
        self.assertEqual(inspected["additional_inputs"], sidecar)
        self.assertEqual({(field["node_id"], field["input"]) for field in inspected["fields"]},
                         {("text", "value"), ("first", "value")})
        self.assertNotIn("opaque_inputs", inspected)
        missing = inspect_interface(prompt, info)
        self.assertEqual([(item["node_id"], item["input"], item["code"]) for item in missing["opaque_inputs"]],
                         [("join", "arbitrary_port", "additional_input_contract_required")])
        self.assertEqual(missing["prompt"], prompt)
        prompt["join"]["inputs"]["unknown_scalar"] = "private literal"
        inspected = inspect_interface(prompt, info, additional_inputs=sidecar)
        self.assertNotIn("private literal", json.dumps(inspected["opaque_inputs"]))
        self.assertNotIn(("join", "unknown_scalar"),
                         {(field["node_id"], field["input"]) for field in inspected["fields"]})

    def test_selected_output_keeps_dynamic_source_and_ignores_inactive_contract(self):
        prompt, info, sidecar = fixture()
        prompt["inactive"] = {"class_type": "SyntheticExtension", "inputs": {"unrelated": ["first", 0]}}
        sidecar["nodes"]["inactive"] = {"class_type": "SyntheticExtension", "inputs": {
            "unrelated": {"type": "STRING", "accept": "link", "source": ["first", 0]}}}
        selected = select_outputs(prompt, ["out"], info, additional_inputs=sidecar)
        self.assertEqual(set(selected), {"first", "text", "join", "out"})
        self.assertEqual(selected["join"]["inputs"]["arbitrary_port"], ["text", 0])
        self.assertEqual(set(prompt), {"first", "text", "join", "out", "inactive"})
        with self.assertRaises(ValueError):
            select_outputs(prompt, ["out"], info)

    def test_live_package_inspection_does_not_promote_historical_unknown_scalar_bindings(self):
        candidate = document()
        candidate["prompt"]["join"]["inputs"]["unknown_scalar"] = "private literal"
        candidate["fields"].append({"id": "legacy_unknown", "label": "Historical field", "node_id": "join",
                                    "input": "unknown_scalar", "type": "text", "default": "private literal"})
        original = copy.deepcopy(candidate)
        inspected = inspect_document(candidate, fixture()[1])
        self.assertNotIn("legacy_unknown", {field["id"] for field in inspected["fields"]})
        self.assertEqual(inspected["prompt"], candidate["prompt"])
        self.assertEqual(inspected["opaque_inputs"][0]["input"], "unknown_scalar")
        self.assertNotIn("private literal", json.dumps(inspected["opaque_inputs"]))
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory))
            saved = store.save(candidate)
            self.assertIn("legacy_unknown", {field["id"] for field in store.export(saved["id"])["fields"]})
        self.assertEqual(candidate, original)

    def test_live_package_inspection_keeps_declared_media_and_v3_dynamic_fields(self):
        info = {
            "LoadImage": {"input": {"required": {"image": [["source.png"]]}}, "output": ["IMAGE"]},
            "Dynamic": {"input": {"required": {"mode": ["COMFY_DYNAMICCOMBO_V3", {
                "options": [{"key": "on", "inputs": {"required": {"count": ["INT"]}}}],
            }]}}, "output": ["INT"]},
        }
        prompt = {"image": {"class_type": "LoadImage", "inputs": {"image": "source.png"}},
                  "dynamic": {"class_type": "Dynamic", "inputs": {"mode": "on", "mode.count": 3}}}
        draft = {**inspect_document({"prompt": prompt}, info), "name": "Formal media and V3"}
        normalized = normalize_document(draft)
        inspected = inspect_document(normalized, info)
        self.assertEqual({(f["node_id"], f["input"], f["type"]) for f in inspected["fields"]},
                         {("image", "image", "image"), ("dynamic", "mode", "select"),
                          ("dynamic", "mode.count", "integer")})
        self.assertNotIn("opaque_inputs", inspected)
        self.assertEqual(inspected["prompt"], normalized["prompt"])

    def test_planning_validates_upstream_binding_and_rejects_scalar_contract_promotion(self):
        prompt, info, sidecar = fixture()
        candidate = inspect_interface(prompt, info, additional_inputs=sidecar)
        validate_planning_fields(candidate["fields"], prompt, info, set(prompt), additional_inputs=sidecar)
        fake = {"id": "fake", "node_id": "join", "input": "arbitrary_port", "type": "text"}
        with self.assertRaisesRegex(ValueError, "连线契约"):
            validate_planning_fields([fake], prompt, info, set(prompt), additional_inputs=sidecar)
        prompt["text"]["inputs"].clear()
        missing = inspect_interface(prompt, info, additional_inputs=sidecar)["missing_fields"]
        repaired = apply_missing_interface_values(prompt, info, {missing[0]["id"]: "repaired"},
                                                  output_nodes=["out"], additional_inputs=sidecar)
        self.assertEqual(repaired["prompt"]["text"]["inputs"]["value"], "repaired")
        self.assertEqual(repaired["prompt"]["join"]["inputs"]["arbitrary_port"], ["text", 0])

    def test_invalid_sidecar_cannot_be_saved_or_authorize_scalar(self):
        base = document()
        for change in (lambda c: c["nodes"]["join"].update(class_type="AnotherClass"),
                       lambda c: c["nodes"]["join"]["inputs"]["arbitrary_port"].update(source=["first", 0]),
                       lambda c: c["nodes"]["join"]["inputs"]["arbitrary_port"].update(accept="scalar")):
            candidate = copy.deepcopy(base)
            change(candidate["additional_inputs"])
            with self.subTest(change=change), self.assertRaises(ValueError):
                normalize_document(candidate)
        base["prompt"]["join"]["inputs"]["arbitrary_port"] = "scalar"
        with self.assertRaises(ValueError):
            normalize_document(base)

    def test_mcp_schema_describes_sidecar_and_checks_nested_types(self):
        package = document()
        _validate(package, PACKAGE_SCHEMA)
        package["additional_inputs"]["provenance"] = {"kind": "native_compiled", "source_revision": 2}
        _validate(package, PACKAGE_SCHEMA)
        self.assertNotIn("provenance", normalize_document(package)["additional_inputs"])
        _validate({"kind": "api", "prompt": package["prompt"], "additional_inputs": package["additional_inputs"]},
                  REQUEST_SCHEMA)
        for value in (["text", True], ["text", -1], ["text"], ["text", 0, "extra"]):
            invalid = copy.deepcopy(package["additional_inputs"])
            invalid["nodes"]["join"]["inputs"]["arbitrary_port"]["source"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                _validate(invalid, ADDITIONAL_INPUTS_SCHEMA)

    def test_mcp_package_schema_matches_current_interface_capacity_and_media(self):
        package = {"name": "Video references", "prompt": {
            f"video_{index}": {"class_type": "LoadVideo", "inputs": {"file": ""}}
            for index in range(65)}}
        package["fields"] = [{"id": f"field_{index}", "node_id": f"video_{index}", "input": "file",
                              "label": "Video", "type": "video", "default": "",
                              "presentation": "port", "role": "video_reference", "group": "参考素材"}
                             for index in range(65)]
        _validate(package, PACKAGE_SCHEMA)
        self.assertEqual(len(normalize_document(package)["fields"]), 65)
        self.assertEqual(PACKAGE_SCHEMA["properties"]["fields"]["maxItems"], 4096)
        for name in ("contract_proof", "session_token", "native_input_receipt"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                _validate({**package, name: {}}, PACKAGE_SCHEMA)


class AdditionalInputCompiledRevisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = EditorWorkflowStore(self.root)
        self.native = {"version": 0.4, "nodes": [], "links": [], "extra": {"keep": "original"}}
        self.workflow_id = self.store.create("Native graph", self.native)["id"]

    def test_compiled_revision_retains_sidecar_and_private_proof_separately_from_source(self):
        prompt, info, sidecar = fixture()
        original_source = self.store.export(self.workflow_id)
        proof = {"schema_digest": "a" * 64, "backend_url": "http://127.0.0.1:18181", "source_revision": 2}
        saved = self.store.save_revision(self.workflow_id, self.native, prompt,
                                         additional_inputs=sidecar, contract_proof=proof)
        compiled = self.store.get_compiled(self.workflow_id)
        self.assertEqual(compiled["additional_inputs"], sidecar)
        self.assertEqual(compiled["contract_proof"], proof)
        self.assertFalse(compiled["stale"])
        source = self.store.export(self.workflow_id)
        self.assertEqual(json.loads(source), self.native)
        self.assertNotIn("additional_inputs", source)
        self.assertNotIn("contract_proof", source)
        self.assertEqual((self.root / self.workflow_id / "revisions" / "revision-00000001.json").read_text(),
                         original_source)
        self.store.save_revision(self.workflow_id, self.native)
        old = self.store.get_compiled(self.workflow_id, revision=saved["revision"])
        self.assertTrue(old["stale"])
        self.assertEqual(old["additional_inputs"], sidecar)
        self.assertEqual(self.store.get_compiled(self.workflow_id)["revision"], saved["revision"])

    def test_legacy_compiled_records_gain_no_sidecar_or_proof_fields(self):
        self.store.save_revision(self.workflow_id, self.native, fixture()[0])
        compiled = self.store.get_compiled(self.workflow_id)
        self.assertEqual(set(compiled), {"prompt", "revision", "updated_at", "stale"})
        for revision in (True, 0, -1, 20, "2"):
            with self.subTest(revision=revision), self.assertRaises(ValueError):
                self.store.get_compiled(self.workflow_id, revision=revision)

    def test_invalid_contract_or_proof_fails_before_revision_advances(self):
        prompt, info, sidecar = fixture()
        sidecar["nodes"]["join"]["inputs"]["arbitrary_port"]["source"] = ["first", 0]
        for kwargs in ({"additional_inputs": sidecar}, {"contract_proof": "bad"}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.store.save_revision(self.workflow_id, self.native, prompt, **kwargs)
            self.assertEqual(self.store.get(self.workflow_id)["revision"], 1)
            self.assertIsNone(self.store.get_compiled(self.workflow_id))
        with self.assertRaises(ValueError):
            self.store.save_revision(self.workflow_id, self.native, additional_inputs=fixture()[2])

    def test_transaction_rollback_preserves_private_compiled_baseline(self):
        prompt, info, sidecar = fixture()
        self.store.save_revision(self.workflow_id, self.native, prompt, additional_inputs=sidecar,
                                 contract_proof={"schema_digest": "old"})
        before = self.store.get_compiled(self.workflow_id)
        with self.assertRaisesRegex(RuntimeError, "package failed"):
            with self.store.revision_transaction(self.workflow_id, self.native, prompt,
                                                 additional_inputs=sidecar,
                                                 contract_proof={"schema_digest": "new"}):
                raise RuntimeError("package failed")
        self.assertEqual(self.store.get_compiled(self.workflow_id), before)
        self.assertEqual(self.store.get(self.workflow_id)["revision"], before["revision"])


if __name__ == "__main__":
    unittest.main()
