"""Portable workflow integrity, binding safety and offline library tests."""

import copy
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from frameweave.packages import (MAX_BYTES, MAX_METADATA_BYTES, PackageStore, apply_values,
                                inspect_document, normalize_document, parse_source_json, transport_document)


def sample():
    return {"name": "影像试样", "description": "图片与视频都使用 API 图",
            "prompt": {"1": {"class_type": "Text", "inputs": {"text": "morning light", "seed": 42}},
                       "2": {"class_type": "Output", "inputs": {"text": ["1", 0]}}},
            "fields": [{"id": "prompt", "node_id": "1", "input": "text", "type": "text", "label": "画面提示词", "default": "morning light", "required": True},
                       {"id": "seed", "node_id": "1", "input": "seed", "type": "integer", "label": "种子", "default": 42, "min": 0, "max": 1000}]}


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = PackageStore(self.root / "library")

    def test_create_export_import_has_stable_identity_and_retains_graph(self):
        first = self.store.save(sample())
        document = self.store.export(first["id"])
        another = PackageStore(self.root / "another")
        second = another.save(document)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(document["prompt"], sample()["prompt"])
        self.assertNotIn("id", document)
        self.assertNotIn("created_at", document)
        self.assertNotIn("prompt", self.store.list()[0])

    def test_raw_transport_preserves_existing_float_identity_across_client_json_roundtrip(self):
        document = sample()
        document["prompt"]["1"]["inputs"].update(cfg=7.0, denoise=1.0, offset=-0.0)
        first = self.store.save(document)
        original_bytes = (self.store.directory / (first["id"] + ".json")).read_bytes()
        exported = self.store.export_transport(first["id"])
        self.assertIn('"cfg":7.0', exported["source_json"])
        # Transport serialization only escapes the string; it never parses its numbers.
        carrier = json.loads(json.dumps({"source_json": exported["source_json"]}))
        another = PackageStore(self.root / "another")
        imported = another.save(transport_document(carrier))
        self.assertEqual(imported["id"], first["id"])
        self.assertEqual((another.directory / (first["id"] + ".json")).read_bytes(), original_bytes)
        changed = copy.deepcopy(exported["document"])
        changed["prompt"]["1"]["inputs"].update(cfg=7, denoise=1, offset=0)
        self.assertNotEqual(another.save(changed)["id"], first["id"])
        self.assertEqual(self.store.get(first["id"])["id"], first["id"])

    def test_raw_export_omits_local_metadata_and_image_defaults(self):
        draft = inspect_document({"1": {"class_type": "LoadImage", "inputs": {"image": "private-image.png"}}})
        package = self.store.save(draft)
        self.store.update_metadata(package["id"], {"favorite": True, "archived": True})
        exported = self.store.export_transport(package["id"])
        self.assertEqual(json.loads(exported["source_json"]), exported["document"])
        for value in ("created_at", "updated_at", "favorite", "archived", "private-image.png", str(self.root)):
            self.assertNotIn(value, exported["source_json"])

    def test_raw_input_checks_utf8_byte_length_before_parse(self):
        for value in ('{"x":"' + "a" * MAX_BYTES + '"}', '{"x":"' + "图" * (MAX_BYTES // 2) + '"}'):
            with self.assertRaisesRegex(ValueError, "2 MiB"):
                parse_source_json(value)
        self.assertEqual(parse_source_json('{"x":"图"}'), {"x": "图"})

    def test_raw_input_rejects_ambiguous_invalid_and_excessive_json(self):
        for value in (None, {}, "", "[]", "null", '{"a":1,"a":2}', '{"a":NaN}',
                      '{"a":1e400}', '{"a":9007199254740992}', '{"a":"\\ud800"}',
                      '{"a":"\ud800"}', '{"a":' + "[" * 70 + "0" + "]" * 70 + "}"):
            with self.subTest(value=repr(value)[:80]), self.assertRaises(ValueError):
                parse_source_json(value)

    def test_raw_carrier_is_exclusive_and_legacy_objects_are_preserved(self):
        document = sample()
        self.assertIs(transport_document({"document": document}), document)
        self.assertIs(transport_document(document, allow_bare=True), document)
        for payload in ({}, {"source_json": "{}", "document": document},
                        {"source_json": "{}", "name": "ambiguous"}, {"other": document}):
            with self.assertRaises(ValueError):
                transport_document(payload)

    def test_raw_export_still_rejects_tampered_stored_content(self):
        package = self.store.save(sample())
        path = self.store.directory / (package["id"] + ".json")
        document = json.loads(path.read_text(encoding="utf-8"))
        document["prompt"]["1"]["inputs"]["seed"] = 43
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "内容已变化"):
            self.store.export_transport(package["id"])

    def test_user_values_modify_only_bound_inputs_without_mutating_template(self):
        document = sample()
        original = copy.deepcopy(document)
        result = apply_values(document, {"prompt": "a green teapot", "seed": 123})
        self.assertEqual(result["1"]["inputs"], {"text": "a green teapot", "seed": 123})
        self.assertEqual(result["2"], original["prompt"]["2"])
        self.assertEqual(document, original)

    def test_invalid_user_values_are_not_coerced(self):
        for values in ({"seed": True}, {"seed": 1.5}, {"seed": 1001}, {"seed": float("nan")},
                       {"prompt": ""}, {"prompt": {}}, {"unexpected": "value"}, []):
            with self.subTest(values=values):
                with self.assertRaises(ValueError):
                    apply_values(sample(), values)

    def test_cannot_bind_nonexistent_input_link_or_same_field_twice(self):
        for change in ({"node_id": "absent"}, {"input": "absent"}, {"node_id": "2", "input": "text"}):
            document = sample()
            document["fields"][0].update(change)
            with self.assertRaises(ValueError):
                normalize_document(document)
        document = sample()
        document["fields"].append({**document["fields"][0], "id": "other"})
        with self.assertRaises(ValueError):
            normalize_document(document)

    def test_reject_reserved_or_duplicate_parameter_ids(self):
        for value in ("__proto__", "constructor", "../x", "seed", ""):
            document = sample()
            document["fields"][0]["id"] = value
            with self.assertRaises(ValueError):
                normalize_document(document)

    def test_graph_cycles_broken_links_and_ui_format_rejected(self):
        document = sample()
        for link in (["missing", 0], ["2", 0], ["1", -1]):
            graph = copy.deepcopy(document["prompt"])
            graph["1"]["inputs"]["text"] = link
            with self.assertRaises(ValueError):
                inspect_document(graph)
        with self.assertRaisesRegex(ValueError, "API"):
            inspect_document({"nodes": [], "links": []})

    def test_package_format_and_limits_are_enforced_before_saving(self):
        for change in ({"version": 2}, {"format": "script"}, {"name": ""}, {"description": "x" * 2001}):
            with self.assertRaises(ValueError):
                self.store.save({**sample(), **change})
        with self.assertRaises(ValueError):
            inspect_document({"payload": "x" * (2 * 1024 * 1024)})
        self.assertFalse(self.store.directory.exists())

    def test_image_bindings_are_portable_and_require_new_input(self):
        graph = {"9": {"class_type": "LoadImage", "inputs": {"image": "private-image.png"}}}
        inspection = inspect_document(graph)
        image = inspection["fields"][0]
        self.assertEqual(image["type"], "image")
        document = {**inspection, "name": "图片参考"}
        package = self.store.save(document)
        self.assertNotIn("private-image", json.dumps(self.store.export(package["id"])))
        with self.assertRaises(ValueError):
            apply_values(package, {})
        for invalid in ("../image.png", "C:/private/image.png", "/root/image.png"):
            with self.assertRaises(ValueError):
                apply_values(package, {image["id"]: invalid})
        result = apply_values(package, {image["id"]: "frameweave/safe.png"})
        self.assertEqual(result["9"]["inputs"]["image"], "frameweave/safe.png")

    def test_select_values_preserve_type_and_boolean_is_not_integer(self):
        document = sample()
        field = document["fields"][1]
        field.update(type="select", options=[42, 123])
        self.assertEqual(apply_values(document, {"seed": 123})["1"]["inputs"]["seed"], 123)
        for value in ("42", True, 99):
            with self.assertRaises(ValueError):
                apply_values(document, {"seed": value})

    def test_inspection_uses_schema_bounds_and_labels_positive_negative(self):
        graph = {"1": {"class_type": "Text", "inputs": {"text": "yes"}},
                 "2": {"class_type": "Text", "inputs": {"text": "no"}},
                 "3": {"class_type": "Sampler", "inputs": {"positive": ["1", 0], "negative": ["2", 0], "steps": 8}}}
        info = {"Sampler": {"input": {"required": {"steps": ["INT", {"min": 1, "max": 200}]}}}}
        result = inspect_document(graph, info)
        fields = {field["node_id"]: field for field in result["fields"]}
        self.assertIn("正向", fields["1"]["label"])
        self.assertIn("负向", fields["2"]["label"])
        self.assertEqual(fields["3"]["max"], 200)
        self.assertTrue(all(field["recommended"] for field in fields.values()))

    def test_unknown_custom_nodes_can_be_imported_offline_but_are_not_executed(self):
        graph = {"node": {"class_type": "MyPlugin", "inputs": {"text": "data only"}, "_meta": {"title": "private title"}}}
        result = inspect_document({"prompt": graph, "extra_data": {"private": "omit"}})
        self.assertEqual(result["requirements"]["nodes"], ["MyPlugin"])
        self.assertNotIn("_meta", result["prompt"]["node"])
        self.assertNotIn("extra_data", result)

    def test_library_detects_tampering_and_recovers_other_packages(self):
        package = self.store.save(sample())
        path = self.store.directory / (package["id"] + ".json")
        document = json.loads(path.read_text(encoding="utf-8"))
        document["prompt"]["1"]["inputs"]["text"] = "tampered"
        path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "变化"):
            self.store.get(package["id"])
        self.assertEqual(self.store.list(), [])
        with self.assertRaises(ValueError):
            self.store.get("../../outside")
        with self.assertRaisesRegex(ValueError, "导入"):
            self.store.get("p-" + "0" * 24)

    def test_corrupt_deep_json_does_not_break_library(self):
        package = self.store.save(sample())
        path = self.store.directory / (package["id"] + ".json")
        path.write_bytes(b"[" * 2000 + b"0" + b"]" * 2000)
        with self.assertRaises(ValueError):
            self.store.get(package["id"])
        self.assertEqual(self.store.list(), [])

    def test_large_bounds_and_select_integers_rejected_without_overflow(self):
        for value in (10 ** 400, -10 ** 400, 9007199254740993):
            document = sample()
            document["fields"][1]["min"] = value
            with self.assertRaises(ValueError):
                normalize_document(document)
            document = sample()
            document["fields"][1].update(type="select", default=value, options=[value])
            with self.assertRaises(ValueError):
                normalize_document(document)

    def test_unexposed_image_cannot_produce_nonportable_package(self):
        document = inspect_document({"9": {"class_type": "LoadImage", "inputs": {"image": "local.png"}}})
        document["fields"] = []
        with self.assertRaisesRegex(ValueError, "上传参数"):
            normalize_document(document)

    def test_organizing_library_is_persistent_without_changing_identity_or_export(self):
        package = self.store.save(sample())
        package_id = package["id"]
        self.assertFalse(package["favorite"])
        self.assertFalse(package["archived"])
        original = self.store.export(package_id)
        path = self.store.directory / (package_id + ".json")
        original_bytes, original_mtime = path.read_bytes(), path.stat().st_mtime_ns
        updated = self.store.update_metadata(package_id, {"favorite": True})
        self.assertTrue(updated["favorite"])
        self.assertFalse(updated["archived"])
        reopened = PackageStore(self.store.directory)
        self.assertTrue(reopened.get(package_id)["favorite"])
        self.assertTrue(reopened.list()[0]["favorite"])
        self.assertTrue(reopened.save(original)["favorite"])
        self.assertEqual(reopened.export(package_id), original)
        self.assertEqual(path.read_bytes(), original_bytes)
        self.assertEqual(path.stat().st_mtime_ns, original_mtime)
        elsewhere = PackageStore(self.root / "elsewhere").save(original)
        self.assertEqual(elsewhere["id"], package_id)
        self.assertFalse(elsewhere["favorite"])
        self.assertFalse(elsewhere["archived"])

    def test_archive_is_reversible_and_existing_canvas_can_still_run_package(self):
        package_id = self.store.save(sample())["id"]
        self.store.update_metadata(package_id, {"favorite": True, "archived": True})
        archived = self.store.get(package_id)
        self.assertTrue(archived["archived"])
        self.assertEqual(self.store.list()[0]["id"], package_id)
        self.assertEqual(apply_values(archived, {"seed": 123})["1"]["inputs"]["seed"], 123)
        restored = self.store.update_metadata(package_id, {"archived": False})
        self.assertFalse(restored["archived"])
        self.assertTrue(restored["favorite"])
        self.assertFalse(self.store.update_metadata(package_id, {"favorite": False})["favorite"])

    def test_metadata_patch_requires_known_boolean_fields_and_installed_valid_package(self):
        package_id = self.store.save(sample())["id"]
        self.store.update_metadata(package_id, {"favorite": True})
        metadata_path = self.store.directory / "metadata.json"
        before = metadata_path.read_bytes()
        for invalid in (None, [], True, {}, {"favorite": 1}, {"favorite": "false"},
                        {"archived": None}, {"archived": []}, {"name": "renamed"},
                        {"favorite": True, "unexpected": False}, {1: False}):
            with self.subTest(patch=invalid), self.assertRaises(ValueError):
                self.store.update_metadata(package_id, invalid)
        for invalid_id in (None, "../outside", "p-" + "0" * 24):
            with self.subTest(package_id=invalid_id), self.assertRaises(ValueError):
                self.store.update_metadata(invalid_id, {"favorite": False})
        package_path = self.store.directory / (package_id + ".json")
        changed = sample()
        changed["name"] = "Changed on disk"
        package_path.write_text(json.dumps(changed), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "变化"):
            self.store.update_metadata(package_id, {"favorite": False})
        self.assertEqual(metadata_path.read_bytes(), before)

    def test_damaged_metadata_defaults_to_visible_without_changing_package_data(self):
        package_id = self.store.save(sample())["id"]
        before = self.store.export(package_id)
        metadata_path = self.store.directory / "metadata.json"
        cases = (b"not json", b"\xff", b"x" * (MAX_METADATA_BYTES + 1),
                 b"[" * 2000 + b"0" + b"]" * 2000, b"[]", b"null",
                 b'{"version": true, "packages": {}}', b'{"version": 2, "packages": {}}',
                 b'{"version": 1, "packages": []}')
        for content in cases:
            with self.subTest(content=content[:60]):
                metadata_path.write_bytes(content)
                package = self.store.get(package_id)
                self.assertFalse(package["favorite"])
                self.assertFalse(package["archived"])
                self.assertEqual(len(self.store.list()), 1)
                self.assertEqual(self.store.export(package_id), before)
                self.assertEqual(metadata_path.read_bytes(), content)
        self.assertTrue(self.store.update_metadata(package_id, {"favorite": True})["favorite"])
        self.assertTrue(PackageStore(self.store.directory).get(package_id)["favorite"])

    def test_one_damaged_metadata_entry_does_not_discard_other_package_state(self):
        first = self.store.save(sample())["id"]
        second = self.store.save({**sample(), "name": "另一个包"})["id"]
        metadata_path = self.store.directory / "metadata.json"
        for broken in ({"favorite": "true"}, {"archived": 1}, {"favorite": True, "name": "unexpected"}, []):
            metadata_path.write_text(json.dumps({"version": 1, "packages": {
                first: {"favorite": True, "archived": True}, second: broken,
                "../outside": {"archived": True}}}), encoding="utf-8")
            self.assertTrue(self.store.get(first)["favorite"])
            self.assertTrue(self.store.get(first)["archived"])
            self.assertFalse(self.store.get(second)["favorite"])
            self.assertFalse(self.store.get(second)["archived"])
        self.store.update_metadata(second, {"favorite": True})
        self.assertTrue(self.store.get(first)["archived"])
        self.assertTrue(self.store.get(second)["favorite"])

    def test_concurrent_partial_updates_preserve_both_fields(self):
        package_id = self.store.save(sample())["id"]
        barrier = threading.Barrier(2)

        def update(field):
            barrier.wait(timeout=3)
            return self.store.update_metadata(package_id, {field: True})

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(update, ("favorite", "archived")))
        self.assertEqual({result["id"] for result in results}, {package_id})
        restored = PackageStore(self.store.directory).get(package_id)
        self.assertTrue(restored["favorite"])
        self.assertTrue(restored["archived"])

    def test_failed_atomic_metadata_replace_preserves_previous_state_and_cleans_temp(self):
        package_id = self.store.save(sample())["id"]
        self.store.update_metadata(package_id, {"favorite": True})
        metadata_path = self.store.directory / "metadata.json"
        before = metadata_path.read_bytes()
        with patch.object(Path, "replace", side_effect=PermissionError("write blocked")):
            with self.assertRaises(PermissionError):
                self.store.update_metadata(package_id, {"archived": True})
        self.assertEqual(metadata_path.read_bytes(), before)
        self.assertTrue(self.store.get(package_id)["favorite"])
        self.assertFalse(self.store.get(package_id)["archived"])
        self.assertEqual(list(self.store.directory.glob(".metadata-*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
