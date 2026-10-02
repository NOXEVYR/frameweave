"""Large interfaces round-trip through public routes without executing inactive branches."""
import copy
import json
import unittest

import test_editor_integration as native_tests


class InterfaceCapacityHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def graph(self, count):
        self.backend.info = {
            "Source": {"input": {"required": {"value": ["INT"]}}, "output": ["INT"]},
            "Sink": {"input": {"required": {"value": ["INT"], "prefix": ["STRING"]}},
                     "output": [], "output_node": True},
        }
        prompt = {"source": {"class_type": "Source", "inputs": {"value": 12}},
                  "sink": {"class_type": "Sink", "inputs": {"value": ["source", 0], "prefix": "capacity"}}}
        for start in range(0, count - 2, 512):
            node_type = "Inactive" + str(start)
            inputs = {"value_" + str(i): i for i in range(start, min(start + 512, count - 2))}
            self.backend.info[node_type] = {"input": {"required": {name: ["INT"] for name in inputs}}, "output": ["INT"]}
            prompt["unused-" + str(start)] = {"class_type": node_type, "inputs": inputs}
        return prompt

    def test_large_public_roundtrip_keeps_all_fields_and_only_runs_selected_dependencies(self):
        for count in (65, 4096):
            with self.subTest(count=count):
                prompt = self.graph(count)
                original = copy.deepcopy(prompt)
                status, _, inspection = self.post("/api/interfaces/inspect", {
                    "document": {"prompt": prompt}, "output_nodes": ["sink"]})
                self.assertEqual(status, 200, inspection)
                self.assertEqual(len(inspection["fields"]), count)
                status, _, applied = self.post("/api/interfaces/apply", {
                    "prompt": prompt, "fields": inspection["fields"], "output_nodes": ["sink"],
                    "backend_url": self.backend.url, "name": f"Capacity {count}"})
                self.assertEqual(status, 200, applied)
                package = applied["package"]
                self.assertEqual(package["prompt"], original)
                self.assertEqual(len(package["fields"]), count)
                self.assertEqual(set(applied["execution"]["node_ids"]), {"source", "sink"})
                status, _, exported = self.post(f"/api/packages/{package['id']}/export")
                self.assertEqual(status, 200, exported)
                self.assertEqual(len(exported["document"]["fields"]), count)
                self.assertEqual(exported["document"]["prompt"], original)
                status, _, imported = self.post("/api/packages", {"source_json": exported["source_json"]})
                self.assertEqual(status, 200, imported)
                self.assertEqual(imported["package"]["id"], package["id"])
                request = {"kind": "package", "package_id": package["id"],
                           "values": applied["values"], "output_nodes": ["sink"]}
                status, _, planned = self.post("/api/execution-plan", {
                    "backend_url": self.backend.url, "request": request})
                self.assertEqual(status, 200, planned)
                self.assertEqual(len(planned["execution"]["active_field_ids"]), 2)
                status, _, compiled = self.post("/api/compile", request)
                self.assertEqual(status, 200, compiled)
                self.assertEqual(set(compiled["prompt"]), {"source", "sink"})
                self.assertEqual(prompt, original)
                self.assertEqual(self.backend.next_id, 0)
                status, _, jobs = self.request("GET", "/api/jobs")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(jobs)["jobs"], [])

    def test_capacity_rejections_do_not_partially_save(self):
        prompt = self.graph(4097)
        status, _, rejected = self.post("/api/interfaces/inspect", {"document": {"prompt": prompt}})
        self.assertEqual(status, 400, rejected)
        self.assertIn("4096", rejected["error"])
        self.assertEqual(self.app.packages.list(), [])
        self.assertEqual(self.backend.next_id, 0)


if __name__ == "__main__":
    unittest.main()
