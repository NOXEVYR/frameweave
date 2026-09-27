"""Boundary tests for local canvas snapshots and workspace helpers."""

import json
import math
import os
from pathlib import Path
import tempfile
import unittest

from frameweave.canvas_store import CanvasStore
from frameweave.workspace_services import performance_plan, result_location


def bundle(name="Daily board"):
    return {"schema": "prismcanvas.project.v1", "version": 1, "name": name,
            "canvas": {"nodes": [{"id": "n1", "type": "prompt", "data": {"text": "local"}}],
                       "edges": []},
            "packages": []}


class CanvasStoreTests(unittest.TestCase):
    def test_older_canvases_remain_searchable_and_pageable(self):
        for i in range(203):
            self.store.save(bundle(f'版本 {i:03d}'))
        first = self.store.list()
        second = self.store.list(offset=first['next_offset'])
        self.assertEqual(len(first['canvases']), 200)
        self.assertEqual(len(second['canvases']), 3)
        self.assertEqual(len({item['id'] for item in first['canvases'] + second['canvases']}), 203)
        oldest = self.store.list(query='版本 000')
        self.assertEqual(oldest['matched'], 1)
        self.assertEqual(oldest['canvases'][0]['name'], '版本 000')
        for values in ({'offset': -1}, {'limit': 201}, {'offset': True}, {'query': 'x' * 121}):
            with self.assertRaises(ValueError):
                self.store.list(**values)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "canvases"
        self.store = CanvasStore(self.root)

    def test_named_snapshot_round_trip_is_data_only(self):
        document = bundle("  Main canvas  ")
        saved = self.store.save(document)
        record = self.store.get(saved["id"])
        self.assertEqual(record["name"], "Main canvas")
        self.assertEqual(record["document"], document)
        listing = self.store.list()
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["canvases"][0]["id"], saved["id"])
        self.assertFalse(any("model" in path.name.lower() for path in self.root.iterdir()))

    def test_rejects_boolean_schema_version_invalid_nodes_and_nonfinite_payload(self):
        cases = []
        bad_version = bundle(); bad_version["version"] = True; cases.append(bad_version)
        bad_nodes = bundle(); bad_nodes["canvas"]["nodes"] = [None]; cases.append(bad_nodes)
        bad_edge = bundle(); bad_edge["canvas"]["edges"] = ["edge"]; cases.append(bad_edge)
        bad_package = bundle(); bad_package["packages"] = [{"id": "../../bad"}]; cases.append(bad_package)
        nonfinite = bundle(); nonfinite["canvas"]["nodes"][0]["data"]["scale"] = math.nan; cases.append(nonfinite)
        for document in cases:
            with self.subTest(document=document), self.assertRaises(ValueError):
                self.store.save(document)
        self.assertFalse(self.root.exists())

    def test_rejects_excessive_json_depth_and_cycles_before_writing(self):
        deep = bundle()
        value = {}
        deep["canvas"]["nodes"][0]["data"]["deep"] = value
        for _ in range(70):
            value["next"] = {}
            value = value["next"]
        cyclic = bundle()
        cyclic["canvas"]["nodes"][0]["data"]["cycle"] = cyclic
        for document in (deep, cyclic):
            with self.subTest(document="deep" if document is deep else "cycle"), self.assertRaises(ValueError):
                self.store.save(document)
        self.assertFalse(self.root.exists())

    def test_corrupt_record_metadata_is_counted_and_preserved(self):
        saved = self.store.save(bundle())
        valid_sibling = self.store.save(bundle("valid sibling"))
        path = self.root / f"{saved['id']}.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record["created_at"] = "not-a-timestamp"
        original = json.dumps(record, ensure_ascii=False)
        path.write_text(original, encoding="utf-8")
        with self.assertRaises(ValueError):
            self.store.get(saved["id"])
        result = self.store.list()
        self.assertEqual(result["unreadable"], 1)
        self.assertEqual([item["id"] for item in result["canvases"]], [valid_sibling["id"]])
        self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_corrupt_json_and_symlink_records_are_not_followed_or_removed(self):
        ident = "a" * 32
        self.root.mkdir(parents=True)
        corrupt = self.root / f"{ident}.json"
        corrupt.write_text("{", encoding="utf-8")
        with self.assertRaises(ValueError):
            self.store.get(ident)
        self.assertEqual(corrupt.read_text(encoding="utf-8"), "{")
        target = self.root / "target.json"
        target.write_text("{}", encoding="utf-8")
        link = self.root / ("b" * 32 + ".json")
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest("当前 Windows 权限不允许创建符号链接")
        with self.assertRaises(ValueError):
            self.store.get("b" * 32)
        self.assertTrue(link.is_symlink())


class WorkspaceServiceTests(unittest.TestCase):
    def test_auto_budget_uses_free_backend_vram_and_never_assumes_total_is_free(self):
        plan = performance_plan("auto", {"devices": [
            {"type": "cuda", "name": "GPU", "vram_total": 24 * 1024**3, "vram_free": 5 * 1024**3}]})
        self.assertEqual(plan["detected"]["available_vram_mb"], 5120)
        self.assertEqual(plan["suggested"]["image_width"], 512)
        occupied = performance_plan("auto", {"devices": [
            {"type": "cuda", "name": "GPU", "vram_total": 48 * 1024**3}]})
        self.assertIsNone(occupied["detected"]["available_vram_mb"])
        self.assertEqual(occupied["suggested"]["image_width"], 512)
        self.assertIn("没有实时空闲显存证据", occupied["detail"])

    def test_performance_plan_validates_profile_status_and_impossible_memory(self):
        for profile, status in (("64", {}), (None, {}), ("auto", None),
                                ("auto", {"devices": "not-a-list"})):
            with self.subTest(profile=profile, status=status), self.assertRaises(ValueError):
                performance_plan(profile, status)
        for device in ({"type": "cuda", "vram_total": 1024, "vram_free": 4096},
                       {"type": "cuda", "vram_total": float("inf"), "vram_free": 1},
                       {"type": "cuda", "vram_total": 10**400, "vram_free": 10**399}):
            with self.subTest(device=device):
                result = performance_plan("auto", {"devices": [device]})
                self.assertIsNone(result["detected"]["available_vram_mb"])

    def test_explicit_profile_is_only_a_form_hint_and_does_not_claim_detection(self):
        plan = performance_plan("16", {"devices": []})
        self.assertEqual(plan["profile"], "16")
        self.assertEqual(plan["detected"]["basis"], "unknown")
        self.assertIn("不改变模型", plan["detail"])

    def test_result_location_resolves_only_a_task_output_inside_local_root(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "ComfyUI" / "output" / "nested" / "result.png"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"png")
            job = {"backend": "http://127.0.0.1:8188",
                   "outputs": [{"filename": "result.png", "subfolder": "nested", "type": "image"}]}
            profile = {"base_url": job["backend"], "main_script": str(root / "ComfyUI" / "main.py"),
                       "working_directory": str(root), "arguments": []}
            result = result_location(job, 0, [profile])
            self.assertEqual(Path(result["path"]), target)
            self.assertTrue(result["can_open"] == (os.name == "nt"))
            self.assertIn("已核实", result["detail"])

    def test_result_location_rejects_bad_shapes_and_path_traversal(self):
        cases = [None, {"outputs": [None]}, {"outputs": [{"filename": ".."}]},
                 {"outputs": [{"filename": "C:escape.png"}]},
                 {"outputs": [{"filename": "ok.png", "subfolder": "..\\escape"}]},
                 {"outputs": [{"filename": "ok.png", "subfolder": 3}]},
                 {"outputs": "not-a-list"}]
        for job in cases:
            with self.subTest(job=job), self.assertRaises(ValueError):
                result_location(job, 0, [])
        with self.assertRaises(ValueError):
            result_location({"outputs": [{"filename": "x.png"}]}, True, [])

    def test_result_location_ignores_malformed_profiles_and_non_output_assets(self):
        job = {"backend": "http://127.0.0.1:8188",
               "outputs": [{"filename": "result.png", "subfolder": "", "storage_type": "input"}]}
        result = result_location(job, 0, [{"base_url": job["backend"], "main_script": None,
                                           "arguments": [None]}])
        self.assertIsNone(result["path"])
        self.assertFalse(result["can_open"])
        job["outputs"][0]["storage_type"] = "output"
        result = result_location(job, 0, "malformed profiles")
        self.assertIsNone(result["path"])


if __name__ == "__main__":
    unittest.main()
