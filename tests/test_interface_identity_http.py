"""Stored public field identity is shared by native, API and package endpoints."""
import copy
import unittest

from frameweave.editor_interfaces import inspect_interface
import test_editor_integration as native_tests
from test_editor_integration import compiled_prompt, editor_document


class InterfaceIdentityHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def existing(self, *, cross_collision=False):
        self.backend.info["SaveImage"] = {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}},
                                          "output": [], "output_node": True}
        prompt = compiled_prompt()
        prompt["3"] = {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "FrameWeave"}}
        fields = inspect_interface(prompt, self.backend.info)["fields"]
        prefix = next(f for f in fields if f["node_id"] == "3" and f["input"] == "filename_prefix")
        prefix.update(id="prefix", label="输出名称测试", presentation="port")
        if cross_collision:
            prefix["id"] = next(f["id"] for f in fields if f["node_id"] == "2" and f["input"] == "seed")
        selected = [f for f in fields if f["type"] == "image"] + [prefix]
        package = self.app.packages.save({"name": "Original custom identity", "prompt": prompt, "fields": selected})
        raw = self.app.packages.export_transport(package["id"])
        baseline = {f["id"]: f["default"] for f in package["fields"]}
        return prompt, package, baseline, raw

    def native(self):
        status, _, workflow = self.post("/api/editor-workflows", {"name": "Native identity", "document": editor_document()})
        self.assertEqual(status, 200, workflow)
        return workflow

    def assert_prefix(self, fields):
        field = next(f for f in fields if f["node_id"] == "3" and f["input"] == "filename_prefix")
        self.assertEqual((field["id"], field["label"], field["presentation"]), ("prefix", "输出名称测试", "port"))

    def test_native_api_and_package_inspections_share_the_stored_identity_without_writes(self):
        prompt, package, baseline, raw = self.existing()
        workflow = self.native()
        scenarios = [("/api/interfaces/inspect", {"document": {"prompt": prompt}, "previous_package_id": package["id"]}),
                     ("/api/interfaces/inspect", {"package_id": package["id"]}),
                     (f"/api/editor-workflows/{workflow['id']}/interface", {"prompt": prompt, "previous_package_id": package["id"]}),
                     (f"/api/editor-workflows/{workflow['id']}/interface", {"package_id": package["id"]})]
        before = copy.deepcopy(prompt)
        for path, data in scenarios:
            with self.subTest(path=path, data=data):
                status, _, result = self.post(path, data)
                self.assertEqual(status, 200, result)
                self.assert_prefix(result["fields"])
        self.assertEqual(prompt, before)
        self.assertEqual(self.app.packages.export_transport(package["id"]), raw)
        self.assertEqual(len(self.app.packages.list()), 1)
        self.assertEqual(self.app.editor_workflows.get(workflow["id"])["revision"], workflow["revision"])
        self.assertEqual(self.backend.next_id, 0)

    def test_api_apply_preserves_custom_id_and_bidirectional_value_sync(self):
        prompt, package, baseline, raw = self.existing()
        for origin in ("inside", "outside"):
            changed = copy.deepcopy(prompt)
            values = dict(baseline)
            if origin == "inside":
                changed["3"]["inputs"]["filename_prefix"] = "inside-output"
            else:
                values["prefix"] = "outside-output"
            status, _, inspected = self.post("/api/interfaces/inspect", {
                "document": {"prompt": changed}, "previous_package_id": package["id"]})
            self.assertEqual(status, 200, inspected)
            selected = [f for f in inspected["fields"] if f["id"] in baseline]
            status, _, applied = self.post("/api/interfaces/apply", {
                "prompt": changed, "previous_package_id": package["id"], "previous_values": values,
                "previous_baseline": baseline, "fields": selected, "output_nodes": ["3"],
                "backend_url": self.backend.url, "name": "Stable identity"})
            self.assertEqual(status, 200, applied)
            self.assertFalse(applied.get("requires_resolution"))
            self.assert_prefix(applied["package"]["fields"])
            self.assertEqual(applied["values"]["prefix"], origin + "-output")
            self.assertEqual(applied["baseline"]["prefix"], changed["3"]["inputs"]["filename_prefix"])
        self.assertEqual(self.app.packages.export_transport(package["id"]), raw)
        self.assertEqual(self.backend.next_id, 0)

    def test_native_apply_and_package_configure_accept_retained_ids(self):
        prompt, package, baseline, raw = self.existing()
        workflow = self.native()
        status, _, inspected = self.post(f"/api/editor-workflows/{workflow['id']}/interface", {
            "prompt": prompt, "previous_package_id": package["id"]})
        self.assertEqual(status, 200, inspected)
        fields = [f for f in inspected["fields"] if f["id"] in baseline]
        status, _, session = self.post(f"/api/editor-workflows/{workflow['id']}/session")
        self.assertEqual(status, 200, session)
        common = {"previous_values": {**baseline, "prefix": "outside-output"}, "previous_baseline": baseline,
                  "fields": fields, "output_nodes": ["3"], "backend_url": self.backend.url}
        status, _, native = self.post(f"/api/editor-workflows/{workflow['id']}/apply", {
            **common, "previous_package_id": package["id"], "session_id": session["session_id"],
            "base_revision": workflow["revision"], "document": editor_document(), "prompt": prompt})
        self.assertEqual(status, 200, native)
        self.assert_prefix(native["package"]["fields"])
        self.assertEqual(native["values"]["prefix"], "outside-output")
        for path in ("/api/interfaces/apply", f"/api/editor-workflows/{workflow['id']}/configure"):
            status, _, configured = self.post(path, {**common, "package_id": package["id"],
                "base_revision": native["workflow"]["revision"], "name": "Configured identity"})
            self.assertEqual(status, 200, configured)
            self.assert_prefix(configured["package"]["fields"])
            self.assertEqual(configured["values"]["prefix"], "outside-output")
        self.assertEqual(self.app.packages.export_transport(package["id"]), raw)
        self.assertEqual(self.backend.next_id, 0)

    def test_candidate_cross_id_conflict_is_rejected_by_every_inspect_and_apply_entry(self):
        prompt, package, baseline, raw = self.existing(cross_collision=True)
        workflow = self.native()
        for path, payload in (("/api/interfaces/inspect", {"document": {"prompt": prompt}, "previous_package_id": package["id"]}),
                              (f"/api/editor-workflows/{workflow['id']}/interface", {"prompt": prompt, "previous_package_id": package["id"]}),
                              ("/api/interfaces/apply", {"prompt": prompt, "previous_package_id": package["id"], "backend_url": self.backend.url}),
                              (f"/api/editor-workflows/{workflow['id']}/configure", {"package_id": package["id"], "backend_url": self.backend.url})):
            status, _, rejected = self.post(path, payload)
            self.assertEqual(status, 400, rejected)
            self.assertIn("冲突", rejected["error"])
        self.assertEqual(len(self.app.packages.list()), 1)
        self.assertEqual(self.app.packages.export_transport(package["id"]), raw)
        self.assertEqual(self.backend.next_id, 0)

    def test_no_previous_preset_keeps_hash_ids_and_arbitrary_claimed_custom_ids_are_rejected(self):
        prompt, package, baseline, raw = self.existing()
        status, _, inspected = self.post("/api/interfaces/inspect", {"document": {"prompt": prompt}})
        self.assertEqual(status, 200, inspected)
        prefix = next(f for f in inspected["fields"] if f["input"] == "filename_prefix")
        self.assertEqual(prefix["id"], "f_b635470637a431b4")
        status, _, first = self.post("/api/interfaces/apply", {"prompt": prompt, "fields": inspected["fields"],
            "output_nodes": ["3"], "name": "Preset", "backend_url": self.backend.url})
        self.assertEqual(status, 200, first)
        self.assertIn(prefix["id"], first["values"])
        forged = copy.deepcopy(inspected["fields"])
        next(f for f in forged if f["input"] == "filename_prefix")["id"] = "unproved-custom"
        before = len(self.app.packages.list())
        status, _, rejected = self.post("/api/interfaces/apply", {"prompt": prompt, "fields": forged,
            "name": "Unproved", "backend_url": self.backend.url})
        self.assertEqual(status, 400, rejected)
        self.assertEqual(len(self.app.packages.list()), before)
        self.assertEqual(self.app.packages.export_transport(package["id"]), raw)
        self.assertEqual(self.backend.next_id, 0)


if __name__ == "__main__":
    unittest.main()
