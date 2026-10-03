"""Interface capacity is distinct from recommendation, output and byte budgets."""

import copy
import hashlib
import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frameweave.editor_interfaces import inspect_interface, preserve_interface_identity, reconcile_interface
from frameweave.packages import (MAX_BYTES, MAX_INTERFACE_FIELDS, MAX_INSPECTION_FIELDS, PackageStore,
                                 apply_values, encoded, inspect_document, normalize_document,
                                 validate_inspection_result)
from frameweave.server import App


def bulk(count):
    prompt, info = {}, {}
    for start in range(0, count, 512):
        node_id, node_type = str(start // 512), "Bulk" + str(start // 512)
        values = {f"value_{index}": index for index in range(start, min(start + 512, count))}
        prompt[node_id] = {"class_type": node_type, "inputs": values}
        info[node_type] = {"input": {"required": {key: ["INT"] for key in values}},
                           "output": [], "output_node": True}
    return prompt, info


class InterfaceCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = PackageStore(Path(self.temp.name) / "packages")
        # Pure App methods; do not initialize any service or process manager.
        self.app = App.__new__(App)
        self.app.packages = self.store
        self.app.backend = SimpleNamespace(url="http://127.0.0.1:8188")
        self.app.lock = threading.RLock()
        self.info = {}
        self.app.object_info = lambda refresh=False: self.info
        self.app._object_info_for_backend = lambda backend: self.info

    def test_full_capacity_store_read_inspect_values_identity_reconcile_and_app_apply(self):
        self.assertEqual(MAX_INTERFACE_FIELDS, 4096)
        self.assertEqual(MAX_INSPECTION_FIELDS, MAX_INTERFACE_FIELDS)
        for count in (64, 65, 256, 1024, 4096):
            with self.subTest(count=count):
                prompt, self.info = bulk(count)
                original = copy.deepcopy(prompt)
                inspection = inspect_interface(prompt, self.info)
                fields = inspection["fields"]
                self.assertEqual(len(fields), count)
                document = {"name": f"Capacity {count}", "prompt": prompt, "fields": fields}
                saved = self.store.save(document)
                loaded = self.store.get(saved["id"])
                self.assertEqual(len(loaded["fields"]), count)
                transport = self.store.export_transport(saved["id"])
                another = PackageStore(Path(self.temp.name) / f"roundtrip-{count}")
                self.assertEqual(another.save(json.loads(transport["source_json"]))["id"], saved["id"])
                self.assertEqual(len(inspect_document(loaded)["fields"]), count)
                values = {field["id"]: 0 for field in fields}
                updated = apply_values(loaded, values)
                self.assertTrue(all(value == 0 for node in updated.values() for value in node["inputs"].values()))
                renamed = [{**field, "label": "Kept " + field["id"], "presentation": "control"} for field in loaded["fields"]]
                retained = preserve_interface_identity(fields, renamed)
                self.assertEqual([f["label"] for f in retained], [f["label"] for f in renamed])
                baseline = {f["id"]: prompt[f["node_id"]]["inputs"][f["input"]] for f in fields}
                merged = reconcile_interface(loaded["fields"], values, fields, prompt, baseline)
                self.assertEqual(merged["values"], values)
                self.assertFalse(merged["changes"]["conflicts"])
                explicit = reconcile_interface(loaded["fields"], baseline, fields, prompt, baseline,
                                               {f["id"]: f["id"] for f in fields})
                self.assertEqual(explicit["values"], baseline)
                with patch("frameweave.backend.Backend.request", side_effect=AssertionError("backend call")), \
                        patch("frameweave.workflows.compile_workflow", side_effect=AssertionError("compile/submit")):
                    result = self.app.apply_interface(prompt, {"fields": fields}, f"Applied {count}")
                    _, execution = self.app._package_execution(result["package"], {"values": result["values"]}, self.info,
                                                                planning=True)
                self.assertEqual(len(result["package"]["fields"]), count)
                self.assertEqual(len(execution["active_field_ids"]), count)
                self.assertEqual(prompt, original)

    def test_all_65_media_remain_exposed_by_default_and_only_active_branch_is_checked(self):
        self.info = {
            "LoadImage": {"input": {"required": {"image": [["ready.png"], {"image_upload": True}]}}, "output": ["IMAGE"]},
            "SaveImage": {"input": {"required": {"images": ["IMAGE"]}}, "output": [], "output_node": True},
        }
        prompt = {str(i): {"class_type": "LoadImage", "inputs": {"image": "ready.png"}} for i in range(65)}
        prompt["save"] = {"class_type": "SaveImage", "inputs": {"images": ["0", 0]}}
        candidates = inspect_interface(prompt, self.info, output_nodes=["save"])["fields"]
        self.assertEqual(len(inspect_document(prompt, self.info)["fields"]), 65)
        with patch("frameweave.backend.Backend.request", side_effect=AssertionError("submit")):
            result = self.app.apply_interface(prompt, {"output_nodes": ["save"]}, "65 media")
            _, execution = self.app._package_execution(result["package"], {
                "values": {f["id"]: "ready.png" for f in candidates}, "output_nodes": ["save"]}, self.info)
        self.assertEqual([f["id"] for f in result["package"]["fields"]], [f["id"] for f in candidates])
        self.assertEqual(execution["node_ids"], ["0", "save"])
        with self.assertRaisesRegex(ValueError, "素材输入必须保留"):
            self.app.apply_interface(prompt, {"fields": candidates[:1], "output_nodes": ["save"]}, "Still mandatory")

    def test_default_soft_budget_keeps_media_then_original_recommended_order(self):
        prompt = {str(i): {"class_type": "Text", "inputs": {"text": str(i)}} for i in range(70)}
        prompt.update({"image-a": {"class_type": "LoadImage", "inputs": {"image": "ready.png"}},
                       "image-b": {"class_type": "LoadImage", "inputs": {"image": "ready.png"}},
                       "sink": {"class_type": "Sink", "inputs": {"text": ["0", 0]}}})
        self.info = {"Text": {"input": {"required": {"text": ["STRING"]}}, "output": ["STRING"]},
                     "Sink": {"input": {"required": {"text": ["STRING"]}}, "output": [], "output_node": True},
                     "LoadImage": {"input": {"required": {"image": [["ready.png"], {"image_upload": True}]}}, "output": ["IMAGE"]}}
        fields = inspect_interface(prompt, self.info)["fields"]
        media = [f for f in fields if f["type"] == "image"]
        recommended = [f for f in fields if f["type"] != "image" and f["recommended"]]
        result = self.app.apply_interface(prompt, {}, "Recommendation")
        self.assertEqual([f["id"] for f in result["package"]["fields"]], [f["id"] for f in media + recommended[:62]])

    def test_128_scalar_union_hides_old_64_without_losing_outer_edits(self):
        prompt, self.info = bulk(128)
        fields = inspect_interface(prompt, self.info)["fields"]
        first = self.app.apply_interface(prompt, {"fields": fields[:64]}, "Old controls")
        outer = {f["id"]: first["values"][f["id"]] + 1000 for f in fields[:64]}
        result = self.app.apply_interface(prompt, {
            "fields": fields[64:], "previous_package_id": first["package"]["id"],
            "previous_values": outer, "previous_baseline": first["baseline"],
        }, "New controls")
        self.assertFalse(result.get("requires_resolution"))
        self.assertEqual(len(result["package"]["fields"]), 64)
        self.assertEqual(len(result["hidden_updates"]), 64)
        for record in result["hidden_updates"]:
            field = record["field"]
            self.assertEqual(record["value"], outer[field["id"]])
            self.assertEqual(result["package"]["prompt"][field["node_id"]]["inputs"][field["input"]], outer[field["id"]])
        self.assertEqual(self.store.get(first["package"]["id"])["fields"], first["package"]["fields"])

    def test_4096_scalar_hidden_sync_records_keep_exact_binding_and_values(self):
        prompt, self.info = bulk(4096)
        fields = inspect_interface(prompt, self.info)["fields"]
        first = self.app.apply_interface(prompt, {"fields": fields}, "All controls")
        outer = {field["id"]: 1 for field in fields}
        hidden = self.app.apply_interface(prompt, {
            "fields": [], "previous_package_id": first["package"]["id"],
            "previous_values": outer, "previous_baseline": first["baseline"],
        }, "Hidden controls")
        self.assertEqual(hidden["package"]["fields"], [])
        self.assertEqual(hidden["values"], {})
        self.assertEqual(len(hidden["hidden_updates"]), 4096)
        self.assertEqual({item["field"]["id"] for item in hidden["hidden_updates"]}, set(outer))
        self.assertTrue(all(item["value"] == 1 for item in hidden["hidden_updates"]))
        self.assertTrue(all(value == 1 for node in hidden["package"]["prompt"].values() for value in node["inputs"].values()))
        _, execution = self.app._package_execution(hidden["package"], {}, self.info)
        self.assertEqual(execution["active_field_ids"], [])

    def test_4097_duplicates_unsafe_numbers_and_bytes_are_rejected_without_storage(self):
        prompt, self.info = bulk(4096)
        fields = inspect_interface(prompt, self.info)["fields"]
        for invalid in ([*fields, {**fields[0], "id": "extra"}], [fields[0], fields[0]],
                        [fields[0], {**fields[0], "id": "other"}],
                        [{**fields[0], "default": 9007199254740992}],
                        [{**fields[0], "min": float("nan")}],
                        [{**fields[0], "label": "x" * MAX_BYTES}]):
            with self.subTest(kind=str(invalid[0].get("id"))), self.assertRaises(ValueError):
                self.store.save({"name": "Rejected", "prompt": prompt, "fields": invalid})
        oversized_prompt, info = bulk(4097)
        with self.assertRaisesRegex(ValueError, "4096"):
            inspect_document(oversized_prompt, info)
        with self.assertRaisesRegex(ValueError, "4096"):
            reconcile_interface(fields + [fields[0]], {}, fields, prompt)
        with self.assertRaisesRegex(ValueError, "4096"):
            reconcile_interface(fields, {}, fields + [fields[0]], prompt)
        with self.assertRaisesRegex(ValueError, "4096"):
            reconcile_interface(fields, {}, fields, prompt, rebindings={str(i): None for i in range(4097)})
        self.assertEqual(self.store.list(), [])

    def test_small_source_large_options_response_rejects_without_truncating_or_mutating_source(self):
        options = [str(i) + "x" * 2040 for i in range(512)]
        prompt = {"1": {"class_type": "Options", "inputs": {"a": options[0], "b": options[0], "c": options[0]}}}
        info = {"Options": {"input": {"required": {key: [options] for key in ("a", "b", "c")}},
                            "output": [], "output_node": True}}
        original = copy.deepcopy(prompt)
        self.assertLess(len(encoded(prompt)), 10000)
        for inspect in (inspect_document, inspect_interface):
            with self.subTest(inspect=inspect.__name__), self.assertRaisesRegex(ValueError, "接口检查结果.*2 MiB"):
                inspect(prompt, info)
        self.assertEqual(prompt, original)
        with self.assertRaisesRegex(ValueError, "接口检查结果.*2 MiB"):
            validate_inspection_result({"fields": [], "repairs": ["x" * MAX_BYTES]})
        self.assertEqual(self.store.list(), [])

    def test_final_interface_route_metadata_is_included_in_response_budget(self):
        prompt, self.info = bulk(1)
        self.app.editor_workflows = SimpleNamespace(get=lambda ident: {"id": ident})
        with patch("frameweave.server.normalize_editor_inputs", return_value={
                "prompt": prompt, "migrations": [{"detail": "x" * MAX_BYTES}]}), \
                patch("frameweave.backend.Backend.request", side_effect=AssertionError("submit")), \
                self.assertRaisesRegex(ValueError, "接口检查结果.*2 MiB"):
            self.app.editor_interface("editor-1", {"prompt": prompt})
        self.assertEqual(self.store.list(), [])

    def test_legacy_near_limit_package_keeps_raw_hash_read_and_export(self):
        document = normalize_document({"name": "Legacy", "prompt": {"1": {"class_type": "Legacy", "inputs": {
            "seed": 42, "cfg": 7.0, "offset": -0.0, "padding": ""}}}, "fields": [
                {"id": "seed", "node_id": "1", "input": "seed", "type": "integer", "label": "Seed"}]})
        document["prompt"]["1"]["inputs"]["padding"] = "x" * (MAX_BYTES - len(encoded(document)) - 1)
        raw = encoded(document)
        self.assertEqual(len(raw), MAX_BYTES - 1)
        ident = "p-" + hashlib.sha256(raw).hexdigest()[:24]
        self.store.directory.mkdir(parents=True)
        path = self.store.directory / (ident + ".json")
        path.write_bytes(raw)
        self.assertEqual(self.store.get(ident)["id"], ident)
        exported = self.store.export_transport(ident)
        self.assertEqual(exported["source_json"].encode(), raw)
        self.assertEqual(self.store.save(exported["document"])["id"], ident)
        self.assertEqual(path.read_bytes(), raw)
        self.assertNotIn("presentation", exported["document"]["fields"][0])
        self.assertIn('"cfg":7.0', exported["source_json"])
        self.assertIn('"offset":-0.0', exported["source_json"])
        another = PackageStore(Path(self.temp.name) / "legacy-reimport")
        self.assertEqual(another.save(json.loads(exported["source_json"]))["id"], ident)
        self.assertEqual((another.directory / (ident + ".json")).read_bytes(), raw)
        excessive = copy.deepcopy(document)
        excessive["prompt"]["1"]["inputs"]["padding"] += "xx"
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            another.save(excessive)
        self.info = {"Legacy": {"input": {"required": {"seed": ["INT"], "cfg": ["FLOAT"],
                    "offset": ["FLOAT"], "padding": ["STRING"]}}, "output": [], "output_node": True}}
        before = copy.deepcopy(document)
        prepared = self.app.prepare_editor({"package_id": ident, "backend_url": self.app.backend.url})
        self.assertEqual(prepared["source_document"], document)
        self.assertEqual(prepared["source_revision"], ident)
        self.assertEqual(self.app._editor_package_prompt({"package_id": ident}), document["prompt"])
        stored = self.store.get(ident)
        for planning in (True, False):
            result, execution = self.app._package_execution(stored, {}, self.info, planning=planning)
            self.assertEqual(result, document["prompt"])
            self.assertEqual(execution["active_field_ids"], ["seed"])
        self.assertEqual(document, before)
        self.assertEqual(path.read_bytes(), raw)
        # Only explicit trusted storage views drop local envelope keys. An
        # external payload cannot evade the complete document byte budget.
        external = {**document, "claimed_metadata": "x" * 2000}
        for operation in (normalize_document, lambda value: apply_values(value, {}),
                          lambda value: self.app.prepare_editor({"document": value, "backend_url": self.app.backend.url})):
            with self.assertRaisesRegex(ValueError, "2 MiB"):
                operation(external)


if __name__ == "__main__":
    unittest.main()
