"""Display-only opt-in summaries never replace fresh package authority."""
import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frameweave.packages import MAX_BYTES, PackageStore, encoded, normalize_document
from test_packages import sample


class PackageSummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / "packages"
        self.store = PackageStore(self.directory)

    def raw_file(self, document, raw=None):
        raw = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode() if raw is None else raw
        ident = "p-" + hashlib.sha256(raw).hexdigest()[:24]
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / (ident + ".json")
        path.write_bytes(raw)
        return path

    def test_canonical_cold_path_skips_full_normalization_and_old_list_is_unchanged(self):
        package = self.store.save(sample())
        before = self.store.list()
        with patch("frameweave.packages.normalize_fields", side_effect=AssertionError("full fields")), \
                patch.object(self.store, "_get", side_effect=AssertionError("full get")):
            rows = self.store.list_summaries()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["id"], package["id"])
        self.assertEqual(row["field_count"], 2)
        self.assertEqual(row["node_count"], 2)
        self.assertTrue(row["summary"])
        self.assertEqual(row["media_types"], [])
        self.assertEqual(set(row), {"id", "name", "description", "format", "version", "created_at",
                                   "updated_at", "favorite", "archived", "summary", "field_count",
                                   "node_count", "media_types"})
        self.assertEqual(self.store.list(), before)
        with patch("frameweave.packages.normalize_fields", wraps=__import__("frameweave.packages", fromlist=["normalize_fields"]).normalize_fields) as normalize:
            self.assertEqual(self.store.get(package["id"]), package)
            self.assertEqual(normalize.call_count, 1)

    def test_warm_cache_rechecks_metadata_and_refresh_reads_package_without_aliasing_rows(self):
        package = self.store.save(sample())
        first = self.store.list_summaries()[0]
        first["name"] = "caller mutation"
        first["media_types"].append("invalid")
        self.store.update_metadata(package["id"], {"favorite": True, "archived": True})
        original_open = Path.open
        def no_package_reads(path, *args, **kwargs):
            if path.name.startswith("p-"):
                raise AssertionError("warm summary read full package")
            return original_open(path, *args, **kwargs)
        with patch.object(Path, "open", no_package_reads):
            warm = self.store.list_summaries()[0]
        self.assertEqual(warm["name"], package["name"])
        self.assertEqual(warm["media_types"], [])
        self.assertTrue(warm["favorite"])
        self.assertTrue(warm["archived"])
        with patch.object(self.store, "_summary_row", wraps=self.store._summary_row) as reader:
            self.store.list_summaries()
            self.assertEqual(reader.call_count, 0)
            self.store.list_summaries(refresh=True)
            self.assertEqual(reader.call_count, 1)
        self.assertEqual(self.store.get(package["id"])["fields"], package["fields"])

    def test_new_deleted_and_changed_files_invalidate_display_rows(self):
        first = self.store.save(sample())
        self.store.list_summaries()
        second = self.store.save({**sample(), "name": "Second"})
        self.assertEqual({row["id"] for row in self.store.list_summaries()}, {first["id"], second["id"]})
        path = self.directory / (first["id"] + ".json")
        path.unlink()
        self.assertEqual([row["id"] for row in self.store.list_summaries()], [second["id"]])
        self.assertNotIn(first["id"], self.store._summary_cache)
        path = self.directory / (second["id"] + ".json")
        path.write_bytes(b"bad json")
        self.assertEqual(self.store.list_summaries(), [])
        self.assertEqual(self.store._summary_cache, {})

    def test_historical_pretty_and_noncanonical_documents_fall_back_without_changing_bytes(self):
        document = normalize_document(sample())
        ident = self.store.save(document)["id"]
        path = self.directory / (ident + ".json")
        for historical in (document, sample()):
            raw = json.dumps(historical, ensure_ascii=False, indent=2).encode()
            path.write_bytes(raw)
            with patch.object(self.store, "_get", wraps=self.store._get) as original:
                rows = self.store.list_summaries(refresh=True)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], ident)
            self.assertEqual(original.call_count, 1)
            self.assertEqual(path.read_bytes(), raw)
            exported = self.store.export_transport(ident)
            other = PackageStore(Path(self.temp.name) / "other")
            self.assertEqual(other.save(json.loads(exported["source_json"]))["id"], ident)
            self.assertEqual(path.read_bytes(), raw)

    def test_same_size_mtime_stale_display_never_authorizes_fresh_detail(self):
        package = self.store.save({**sample(), "name": "ModelAlpha"})
        path = self.directory / (package["id"] + ".json")
        # Deliberately weaker identity to simulate filesystems with insufficient
        # change evidence. Production also compares inode and ctime_ns.
        with patch.object(self.store, "_summary_identity", side_effect=lambda info: (info.st_size, info.st_mtime_ns)):
            self.assertEqual(self.store.list_summaries()[0]["name"], "ModelAlpha")
            info, raw = path.stat(), path.read_bytes()
            changed = raw.replace(b"ModelAlpha", b"ModelBravo")
            self.assertEqual(len(changed), len(raw))
            path.write_bytes(changed)
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
            self.assertEqual(self.store.list_summaries()[0]["name"], "ModelAlpha")
            with self.assertRaisesRegex(ValueError, "变化"):
                self.store.get(package["id"])
            with self.assertRaises(ValueError):
                self.store.export(package["id"])
            self.assertEqual(self.store.list_summaries(refresh=True), [])

    def test_raw_matching_bad_shapes_bounds_duplicates_and_deep_sources_are_not_exposed(self):
        valid = normalize_document(sample())
        invalid = []
        for key, value in (("name", "x" * 121), ("description", "x" * 2001),
                           ("version", True), ("fields", [copy.deepcopy(valid["fields"][0]) for _ in range(4097)]),
                           ("prompt", {str(i): {"class_type": "X", "inputs": {}} for i in range(1001)}),
                           ("prompt", {"1": None})):
            invalid.append({**valid, key: value})
        invalid.append({**valid, "fields": [{**valid["fields"][0], "type": "select", "options": list(range(513))}]})
        for document in invalid:
            self.raw_file(document)
        self.raw_file({}, b'{"name":"PRIVATE_PAYLOAD","name":"again"}')
        self.raw_file({}, b"[" * 2000 + b"0" + b"]" * 2000)
        self.raw_file({}, b"x" * (MAX_BYTES + 1))
        deep = copy.deepcopy(valid)
        value = deep
        for _ in range(65):
            value["nested"] = {}
            value = value["nested"]
        self.raw_file(deep)
        self.assertEqual(self.store.list_summaries(), [])
        self.assertEqual(self.store._summary_cache, {})

    def test_maximum_200_display_entries_are_cached_and_force_is_typed(self):
        document = normalize_document(sample())
        for i in range(201):
            self.raw_file({**document, "name": f"Entry {i}"})
        self.assertEqual(len(self.store.list_summaries()), 200)
        self.assertEqual(len(self.store._summary_cache), 200)
        for value in (1, None, "1"):
            with self.assertRaises(ValueError):
                self.store.list_summaries(refresh=value)

    def test_large_scalar_and_option_definitions_have_bounded_payload_without_hydration(self):
        prompt, fields = {}, []
        for index in range(4096):
            node_id, name = str(index // 512), f"value_{index}"
            prompt.setdefault(node_id, {"class_type": "Bulk", "inputs": {}})["inputs"][name] = index
            fields.append({"id": f"f{index}", "node_id": node_id, "input": name,
                           "type": "integer", "label": f"Parameter {index}"})
        large = self.store.save({"name": "4096 scalars", "prompt": prompt, "fields": fields})
        with patch("frameweave.packages.normalize_fields", side_effect=AssertionError("hydrate")):
            row = self.store.list_summaries()[0]
        self.assertEqual(row["field_count"], 4096)
        self.assertEqual(row["node_count"], 8)
        self.assertLess(len(json.dumps(row).encode()), 1000)
        self.assertEqual(len(self.store.get(large["id"])["fields"]), 4096)
        option_rows = []
        for count in (1, 512):
            options = [f"PRIVATE_OPTION_{index:04d}" for index in range(count)]
            inputs = {f"v{index}": options[0] for index in range(128)}
            fields = [{"id": name, "node_id": "1", "input": name, "type": "select", "label": name,
                       "options": options} for name in inputs]
            saved = self.store.save({"name": "Options", "prompt": {"1": {"class_type": "Bulk", "inputs": inputs}}, "fields": fields})
            with patch("frameweave.packages.normalize_fields", side_effect=AssertionError("hydrate")):
                option_rows.append(next(row for row in self.store.list_summaries() if row["id"] == saved["id"]))
        for row in option_rows:
            for key in ("id", "created_at", "updated_at"):
                row.pop(key)
            self.assertNotIn("PRIVATE_OPTION", json.dumps(row))
        self.assertEqual(option_rows[0], option_rows[1])

    def test_media_types_are_a_bounded_set_and_output_unicode_damage_is_isolated(self):
        media = self.store.save({"name": "Media", "prompt": {
            "1": {"class_type": "LoadImage", "inputs": {"image": ""}},
            "2": {"class_type": "LoadAudio", "inputs": {"audio": ""}},
            "3": {"class_type": "LoadVideo", "inputs": {"file": ""}}}, "fields": [
                {"id": "image", "node_id": "1", "input": "image", "type": "image", "label": "Image"},
                {"id": "audio", "node_id": "2", "input": "audio", "type": "audio", "label": "Audio"},
                {"id": "video", "node_id": "3", "input": "file", "type": "video", "label": "Video"}]})
        for key in ("name", "description"):
            bad = {**normalize_document(sample()), key: "\ud800"}
            raw = json.dumps(bad, ensure_ascii=True, separators=(",", ":")).encode()
            self.raw_file(bad, raw)
        rows = self.store.list_summaries()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["id"], media["id"])
        self.assertEqual(rows[0]["media_types"], ["audio", "image", "video"])
        self.assertNotIn("fields", rows[0])
        json.dumps({"packages": rows}, ensure_ascii=False).encode("utf-8")


if __name__ == "__main__":
    unittest.main()
