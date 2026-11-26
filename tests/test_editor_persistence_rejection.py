"""Prewrite proof is scoped to editor applies, never inferred from HTTP status."""
import json
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from frameweave.backend import BackendError
import test_editor_integration as native_tests


def image_document(connected=False):
    return {
        "version": 0.4, "last_node_id": 2, "last_link_id": int(connected),
        "nodes": [
            {"id": 1, "type": "EmptyImage", "pos": [0, 0], "size": [300, 150],
             "inputs": [], "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [1] if connected else []}],
             "widgets_values": [64, 64, 1, 0]},
            {"id": 2, "type": "SaveImage", "pos": [400, 0], "size": [300, 150],
             "inputs": [{"name": "images", "type": "IMAGE", "link": 1 if connected else None}],
             "outputs": [], "widgets_values": ["test"]},
        ],
        "links": [[1, 1, 0, 2, 0, "IMAGE"]] if connected else [],
    }


def image_prompt(connected=False):
    return {
        "1": {"class_type": "EmptyImage", "inputs": {"width": 64, "height": 64, "batch_size": 1, "color": 0}},
        "2": {"class_type": "SaveImage", "inputs": {"filename_prefix": "test", **({"images": ["1", 0]} if connected else {})}},
    }


class EditorPersistenceRejectionTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def setup_image(self, connected=False):
        self.backend.info = {
            "EmptyImage": {"input": {"required": {key: ["INT"] for key in ("width", "height", "batch_size", "color")}},
                           "output": ["IMAGE"], "output_node": False},
            "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}},
                          "output": [], "output_node": True},
        }
        source = json.dumps(image_document(), ensure_ascii=False, separators=(",", ":"))
        status, _, workflow = self.post("/api/editor-workflows", {"name": "Repair missing images", "source_json": source})
        self.assertEqual(status, 200, workflow)
        prefix = f"/api/editor-workflows/{workflow['id']}"
        status, _, session = self.post(prefix + "/session")
        self.assertEqual(status, 200, session)
        prompt = image_prompt(connected)
        status, _, info = self.post(prefix + "/interface", {"prompt": prompt})
        self.assertEqual(status, 200, info)
        payload = {"session_id": session["session_id"], "base_revision": workflow["revision"],
                   "document": image_document(connected), "prompt": prompt,
                   "fields": info["fields"], "output_nodes": ["2"]}
        return workflow, prefix, payload, source

    def store_bytes(self):
        roots = (self.app.editor_workflows.directory, self.app.packages.directory)
        return {str(path.relative_to(self.app.data_dir)): path.read_bytes()
                for root in roots for path in root.rglob("*") if path.is_file()}

    def assert_prewrite(self, result):
        self.assertIs(result["persisted"], False)
        self.assertEqual(result["persistence_stage"], "prewrite")

    def assert_unproven(self, result):
        self.assertNotIn("persisted", result)
        self.assertNotIn("persistence_stage", result)

    def test_missing_images_proves_no_write_and_same_session_can_repair_save_apply(self):
        workflow, prefix, payload, source = self.setup_image()
        before = self.store_bytes()
        status, _, rejected = self.post(prefix + "/apply", payload)
        self.assertEqual(status, 400, rejected)
        self.assertIn("images", rejected["error"])
        self.assert_prewrite(rejected)
        self.assertEqual(self.store_bytes(), before)
        self.assertEqual(self.app.editor_workflows.export(workflow["id"]), source)
        self.assertEqual(self.app.packages.list(), [])
        repaired = image_document(True)
        status, _, draft = self.post(prefix + "/draft", {"base_revision": workflow["revision"], "document": repaired})
        self.assertEqual(status, 200, draft)
        status, _, applied = self.post(prefix + "/apply", {
            **payload, "base_revision": draft["revision"], "document": repaired, "prompt": image_prompt(True)})
        self.assertEqual(status, 200, applied)
        self.assertGreater(applied["workflow"]["revision"], draft["revision"])
        self.assertEqual(applied["package"]["prompt"]["2"]["inputs"]["images"], ["1", 0])
        self.assertEqual(self.backend.next_id, 0)
        record = self.app.editor_workflows.directory / workflow["id"]
        self.assertEqual((record / "revisions" / "revision-00000001.json").read_text(encoding="utf-8"), source)

    def test_prewrite_backend_and_validation_errors_keep_original_status(self):
        workflow, prefix, payload, _ = self.setup_image(True)
        before = self.store_bytes()
        for error, expected in ((BackendError("backend unavailable"), 502), (OSError("read failed"), 502),
                                (ValueError("invalid schema"), 400), (KeyError("missing compiled"), 400)):
            with self.subTest(error=type(error).__name__), patch.object(self.app, "apply_interface", side_effect=error):
                status, _, result = self.post(prefix + "/apply", payload)
                self.assertEqual(status, expected, result)
                self.assert_prewrite(result)
                self.assertEqual(self.store_bytes(), before)
        for changes in ({"session_id": "invalid"}, {"base_revision": workflow["revision"] + 1}, {"document": {}}):
            status, _, result = self.post(prefix + "/apply", {**payload, **changes})
            self.assertEqual(status, 400, result)
            self.assert_prewrite(result)
            self.assertEqual(self.store_bytes(), before)

    def test_stage_errors_never_claim_no_write(self):
        _, prefix, payload, _ = self.setup_image(True)
        for error, expected in ((ValueError("stage failed"), 400), (OSError("stage failed"), 502)):
            @contextmanager
            def fail_stage(document):
                raise error
                yield
            with self.subTest(error=type(error).__name__), patch.object(self.app, "_stage_interface_package", fail_stage):
                status, _, result = self.post(prefix + "/apply", payload)
                self.assertEqual(status, expected, result)
                self.assert_unproven(result)

    def test_errors_after_revision_write_never_claim_no_write(self):
        _, prefix, payload, _ = self.setup_image(True)
        original = self.app.editor_workflows.save_revision
        for error, expected in ((ValueError("postwrite validation failed"), 400), (OSError("postwrite failed"), 502)):
            before = self.store_bytes()
            def write_then_fail(*args, **kwargs):
                original(*args, **kwargs)
                raise error
            with self.subTest(error=type(error).__name__), patch.object(self.app.editor_workflows, "save_revision", write_then_fail):
                status, _, result = self.post(prefix + "/apply", payload)
                self.assertEqual(status, expected, result)
                self.assert_unproven(result)
                self.assertNotEqual(self.store_bytes(), before, "immutable revision files can remain after rollback")

    def test_publish_and_generic_draft_errors_do_not_receive_prewrite_proof(self):
        _, prefix, payload, _ = self.setup_image(True)
        with patch("frameweave.server.os.link", side_effect=OSError("publish failed")):
            status, _, result = self.post(prefix + "/apply", payload)
            self.assertEqual(status, 502, result)
            self.assert_unproven(result)
        status, _, result = self.post(prefix + "/draft", {"document": {}})
        self.assertEqual(status, 400, result)
        self.assert_unproven(result)

    def test_conflict_receipt_has_no_write_proof_and_resolution_can_apply(self):
        _, prefix, payload, _ = self.setup_image(True)
        status, _, first = self.post(prefix + "/apply", payload)
        self.assertEqual(status, 200, first)
        field = next(f for f in first["package"]["fields"] if f["input"] == "filename_prefix")
        prompt = image_prompt(True)
        prompt["2"]["inputs"]["filename_prefix"] = "inner"
        next_payload = {**payload, "base_revision": first["workflow"]["revision"], "prompt": prompt,
                        "previous_package_id": first["package"]["id"], "previous_baseline": first["baseline"],
                        "previous_values": {**first["values"], field["id"]: "outer"}}
        before = self.store_bytes()
        status, _, conflict = self.post(prefix + "/apply", next_payload)
        self.assertEqual(status, 200, conflict)
        self.assertTrue(conflict["requires_resolution"])
        self.assert_prewrite(conflict)
        self.assertEqual(self.store_bytes(), before)
        key = conflict["changes"]["conflicts"][0]["id"]
        status, _, resolved = self.post(prefix + "/apply", {**next_payload, "resolutions": {key: "outer"}})
        self.assertEqual(status, 200, resolved)
        self.assertEqual(resolved["values"][field["id"]], "outer")


if __name__ == "__main__":
    unittest.main()
