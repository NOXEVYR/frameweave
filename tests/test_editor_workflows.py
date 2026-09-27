import json
import os
import tempfile
import unittest
from pathlib import Path

from frameweave.editor_workflows import (
    MAX_BYTES,
    EditorWorkflowStore,
)


def editor_document(version=0.4):
    return {
        "id": "editor-workflow-id",
        "version": version,
        "revision": 0,
        "last_node_id": 2,
        "last_link_id": 1,
        "nodes": [
            {"id": 1, "type": "LoadImage", "pos": [12.5, 20],
             "size": [315, 110], "flags": {}, "order": 0, "mode": 0,
             "inputs": [], "outputs": [{"name": "IMAGE", "type": "IMAGE",
                                            "links": [1]}],
             "properties": {"Node name for S&R": "LoadImage"},
             "widgets_values": ["input.png"]},
            {"id": 2, "type": "Note", "pos": [400, 20], "size": [220, 120],
             "flags": {}, "order": 1, "mode": 0, "inputs": [], "outputs": [],
             "properties": {}, "widgets_values": ["keep this note"]},
        ],
        "links": [[1, 1, 0, 2, 0, "IMAGE"]],
        "groups": [{"title": "Edit controls", "bounding": [0, 0, 500, 300],
                    "color": "#445566", "font_size": 24}],
        "config": {"links_ontop": True},
        "extra": {"ue_links": [], "ds": {"scale": 0.8}},
        "subgraphs": [{"id": "subgraph-a", "nodes": [], "links": [],
                       "widgets": [{"name": "strength", "value": 0.7}]}],
    }


def compiled_prompt():
    return {"11": {"class_type": "LoadImage", "inputs": {"image": "input.png"}}}


class EditorWorkflowStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name) / "editor-workflows"
        self.store = EditorWorkflowStore(self.directory)

    def tearDown(self):
        self.temp.cleanup()

    def create(self, document=None, source_json=None):
        document = document or editor_document()
        return self.store.create("  Native editor graph  ", document, source_json)

    def test_create_keeps_source_json_and_editor_only_fields(self):
        document = editor_document()
        source = '{\n  "version": 0.4, "nodes": ' + json.dumps(document["nodes"]) + \
                 ', "links": ' + json.dumps(document["links"]) + \
                 ', "id": "editor-workflow-id", "revision": 0, "last_node_id": 2,' + \
                 ' "last_link_id": 1, "groups": ' + json.dumps(document["groups"]) + \
                 ', "config": {"links_ontop": true}, "extra": ' + \
                 json.dumps(document["extra"]) + ', "subgraphs": ' + \
                 json.dumps(document["subgraphs"]) + ' }\n'
        result = self.store.create("Graph", document, source)

        self.assertRegex(result["id"], r"\Ae-[0-9a-f]{24}\Z")
        self.assertEqual(result["name"], "Graph")
        self.assertEqual((result["nodes"], result["links"], result["revision"]), (2, 1, 1))
        loaded = self.store.get(result["id"])
        self.assertEqual(loaded["source_json"], source)
        self.assertEqual(loaded["document"]["extra"], document["extra"])
        self.assertEqual(loaded["document"]["subgraphs"], document["subgraphs"])
        self.assertEqual(loaded["document"]["nodes"][1]["widgets_values"], ["keep this note"])
        self.assertEqual(loaded["compiled"], {"available": False, "revision": None, "stale": False})
        self.assertIsNone(self.store.get_compiled(result["id"]))
        listing = self.store.list()
        self.assertEqual(listing["total"], 1)
        self.assertNotIn("document", listing["workflows"][0])

    def test_revisions_are_append_only_and_compiled_prompt_becomes_stale(self):
        created = self.create()
        ident = created["id"]
        original_path = self.directory / ident / "revisions" / "revision-00000001.json"
        original_bytes = original_path.read_bytes()

        second = editor_document(version=1)
        second["nodes"].append({"id": 3, "type": "Note", "widgets_values": ["draft"]})
        saved = self.store.save_revision(ident, second, compiled_prompt())
        self.assertEqual(saved["revision"], 2)
        compiled = self.store.get_compiled(ident)
        self.assertEqual(compiled["revision"], 2)
        self.assertFalse(compiled["stale"])
        self.assertEqual(compiled["prompt"], compiled_prompt())

        third = editor_document(version=1)
        third["nodes"][1]["widgets_values"] = ["unsaved prompt draft"]
        saved = self.store.save_revision(ident, third)
        self.assertEqual(saved["revision"], 3)
        self.assertTrue(saved["summary"]["stale"])
        compiled = self.store.get_compiled(ident)
        self.assertTrue(compiled["stale"])
        self.assertEqual(compiled["revision"], 2)
        self.assertEqual(compiled["prompt"], compiled_prompt())
        self.assertEqual(original_path.read_bytes(), original_bytes)
        self.assertEqual(self.store.get(ident)["document"]["nodes"][1]["widgets_values"],
                         ["unsaved prompt draft"])

    def test_empty_editor_prompt_saves_as_stale_draft_without_erasing_compiled(self):
        ident = self.store.create("Graph", editor_document(), source_json=None)["id"]
        self.store.save_revision(ident, editor_document(version=1), compiled_prompt())
        result = self.store.save_revision(ident, editor_document(version=1), prompt={})
        compiled = self.store.get_compiled(ident)
        self.assertEqual(result["revision"], 3)
        self.assertTrue(compiled["stale"])
        self.assertEqual(compiled["revision"], 2)

    def test_bad_compiled_prompt_does_not_advance_revision(self):
        created = self.create()
        with self.assertRaises(ValueError):
            self.store.save_revision(created["id"], editor_document(version=1),
                                     {"1": {"class_type": "NoInputs"}})
        self.assertEqual(self.store.get(created["id"])["revision"], 1)
        self.assertIsNone(self.store.get_compiled(created["id"]))

    def test_supports_editor_version_point_four_and_v1_but_rejects_other_versions(self):
        for version in (0.4, 1, 1.0, 1.1, 1.5):
            with self.subTest(version=version):
                result = self.create(editor_document(version))
                self.assertEqual(self.store.get(result["id"])["document"]["version"], version)
        for version in (0.3, 0.5, 2, True, "1"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                self.store.create("bad", editor_document(version))

    def test_graph_count_json_size_depth_and_number_limits(self):
        too_many_nodes = editor_document()
        too_many_nodes["nodes"] = [{"id": index} for index in range(10_001)]
        with self.assertRaisesRegex(ValueError, "10000"):
            self.store.create("large nodes", too_many_nodes)

        too_many_links = editor_document()
        too_many_links["links"] = [[index, 1, 0, 2, 0, "IMAGE"]
                                    for index in range(50_001)]
        with self.assertRaisesRegex(ValueError, "50000"):
            self.store.create("large links", too_many_links)

        unsafe_integer = editor_document()
        unsafe_integer["extra"]["large"] = 2**53
        with self.assertRaisesRegex(ValueError, "浏览器的精确范围"):
            self.store.create("unsafe int", unsafe_integer)

        too_deep = editor_document()
        nested = None
        for _ in range(90):
            nested = [nested]
        too_deep["extra"]["nested"] = nested
        with self.assertRaisesRegex(ValueError, "过深"):
            self.store.create("deep", too_deep)

        oversized_source = ('{"version":0.4,"nodes":[],"links":[],"padding":"'
                            + "x" * MAX_BYTES + '"}')
        with self.assertRaisesRegex(ValueError, "16 MiB"):
            self.store.create("oversize", {}, oversized_source)

    def test_source_parser_rejects_duplicate_keys_nonfinite_and_unsafe_integer(self):
        for source in (
            '{"version":0.4,"version":0.4,"nodes":[],"links":[]}',
            '{"version":0.4,"nodes":[],"links":[],"x":NaN}',
            '{"version":0.4,"nodes":[],"links":[],"x":9007199254740992}',
        ):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.store.create("bad source", {}, source)

    def test_bad_or_escaped_ids_and_symlink_records_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "ID 无效"):
            self.store.get("../../outside")
        self.directory.mkdir(parents=True)
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        link = self.directory / ("e-" + "0" * 24)
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"当前 Windows 环境不允许创建测试符号链接：{exc}")
        with self.assertRaisesRegex(ValueError, "符号链接"):
            self.store.get(link.name)
        self.assertEqual(self.store.list()["unreadable"][0]["id"], link.name)

    def test_corrupt_record_reports_reason_and_preserves_file(self):
        created = self.create()
        meta_path = self.directory / created["id"] / "meta.json"
        meta_path.write_text("{broken", encoding="utf-8")
        damaged = meta_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "记录损坏.*原文件已保留"):
            self.store.get(created["id"])
        listing = self.store.list()
        self.assertEqual(listing["unreadable"][0]["id"], created["id"])
        self.assertIn("损坏", listing["unreadable"][0]["reason"])
        self.assertEqual(meta_path.read_bytes(), damaged)


if __name__ == "__main__":
    unittest.main()
