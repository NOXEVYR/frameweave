"""Explicit missing-input repairs share the API/native/package HTTP contract."""

import copy
import hashlib
import json
import shutil
import subprocess
import unittest

import test_editor_integration as native_tests
from test_savevideo_dynamic import save_video_schema, video_prompt


def field_id(node_id, name):
    return "f_" + hashlib.sha256((node_id + "\0" + name).encode()).hexdigest()[:16]


class MissingInterfaceHTTPTests(unittest.TestCase):
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post
    import_document = native_tests.EditorIntegrationTests.import_document

    def setUp(self):
        native_tests.EditorIntegrationTests.setUp(self)
        self.backend.info = {
            "VideoSource": {"input": {"required": {}}, "output": ["VIDEO"]},
            "SaveVideo": save_video_schema(),
        }

    def tearDown(self):
        self.assertEqual(self.backend.next_id, 0)
        self.assertEqual(self.app.jobs, {})
        self.assertFalse(any(call[:2] == ("POST", "/prompt") for call in self.backend.calls))

    def inspect_api(self, prompt, values=None):
        # Exercise the raw carrier and its exclusion of repair request metadata.
        source = json.dumps({"prompt": prompt}, ensure_ascii=False, indent=2)
        status, _, result = self.post("/api/interfaces/inspect", {
            "source_json": source, "missing_values": values or {}, "output_nodes": ["2"],
        })
        self.assertEqual(status, 200, result)
        return result

    def apply_api(self, prompt, interface, values=None, **extra):
        return self.post("/api/interfaces/apply", {
            "prompt": prompt, "fields": interface["fields"], "name": "Explicit repaired video",
            "backend_url": self.backend.url, "output_nodes": ["2"],
            "missing_values": values or {}, **extra,
        })

    def assert_compiles(self, applied):
        status, _, compiled = self.post("/api/compile", {
            "kind": "package", "package_id": applied["package"]["id"],
            "values": applied["values"], "output_nodes": ["2"],
        })
        self.assertEqual(status, 200, compiled)
        self.assertEqual(compiled["prompt"]["2"]["inputs"]["format.codec"], "h264")

    def test_api_inspect_explicit_choice_reinspect_apply_and_compile(self):
        prompt = video_prompt(format="mp4", codec="auto")
        original = copy.deepcopy(prompt)
        first = self.inspect_api(prompt)
        missing, = first["missing_fields"]
        self.assertEqual(missing["input"], "format.codec")
        self.assertNotIn("default", missing)
        self.assertTrue(missing["missing"])
        self.assertEqual(first["repairs"], [])
        self.assertEqual(self.app.packages.list(), [])
        # Missing required fields remain strict execution blockers.
        status, _, rejected = self.apply_api(prompt, first)
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), [])

        choices = {missing["id"]: "h264"}
        inspected = self.inspect_api(prompt, choices)
        self.assertEqual(inspected["missing_fields"], [])
        self.assertEqual(inspected["repairs"], [{"id": missing["id"], "node_id": "2", "input": "format.codec"}])
        self.assertEqual(inspected["prompt"]["2"]["inputs"]["codec"], "auto")
        self.assertEqual(inspected["prompt"]["2"]["inputs"]["format.codec"], "h264")
        self.assertEqual(next(f for f in inspected["fields"] if f["id"] == missing["id"])["default"], "h264")
        status, _, applied = self.apply_api(prompt, inspected, choices)
        self.assertEqual(status, 200, applied)
        self.assertEqual(applied["repairs"], inspected["repairs"])
        self.assertEqual(len(self.app.packages.list()), 1)
        self.assert_compiles(applied)
        self.assertEqual(prompt, original)

    def test_native_session_saves_repaired_compiled_graph_and_preserves_source_document(self):
        document = native_tests.editor_document()
        source = json.dumps(document, ensure_ascii=False, indent=2)
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        original_revision = self.app.editor_workflows.directory / ident / "revisions" / "revision-00000001.json"
        before = original_revision.read_bytes()
        self.assertEqual(before, source.encode("utf-8"))
        status, _, session = self.post(f"/api/editor-workflows/{ident}/session")
        self.assertEqual(status, 200, session)
        prompt = video_prompt(format="mp4")
        status, _, first = self.post(f"/api/editor-workflows/{ident}/interface", {"prompt": prompt})
        self.assertEqual(status, 200, first)
        choices = {first["missing_fields"][0]["id"]: "h264"}
        status, _, inspected = self.post(f"/api/editor-workflows/{ident}/interface", {
            "prompt": prompt, "missing_values": choices,
        })
        self.assertEqual(status, 200, inspected)
        status, _, applied = self.post(f"/api/editor-workflows/{ident}/apply", {
            "session_id": session["session_id"], "document": document, "prompt": prompt,
            "base_revision": imported["revision"], "fields": inspected["fields"],
            "output_nodes": ["2"], "missing_values": choices,
        })
        self.assertEqual(status, 200, applied)
        self.assertEqual(applied["repairs"], inspected["repairs"])
        self.assertEqual(self.app.editor_workflows.get(ident)["document"], document)
        self.assertEqual(original_revision.read_bytes(), before)
        compiled = self.app.editor_workflows.get_compiled(ident)
        self.assertEqual(compiled["prompt"]["2"]["inputs"]["format.codec"], "h264")
        self.assertNotIn("format.codec", prompt["2"]["inputs"])
        self.assert_compiles(applied)

    def test_package_configure_repairs_new_schema_without_rewriting_old_package_or_native_raw(self):
        # Data-only storage accepts historical packages before live repair.
        document = native_tests.editor_document()
        source = json.dumps(document, ensure_ascii=False, indent=2)
        status, _, imported = self.import_document(source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        old = self.app.packages.save({"name": "Historical video", "description": "",
                                      "prompt": video_prompt(format="mp4"), "fields": []})
        old_path = self.app.packages.directory / (old["id"] + ".json")
        before = old_path.read_bytes()
        status, _, blocked = self.post("/api/compile", {"kind": "package", "package_id": old["id"]})
        self.assertEqual(status, 400, blocked)
        status, _, first = self.post(f"/api/editor-workflows/{ident}/interface", {"package_id": old["id"]})
        self.assertEqual(status, 200, first)
        choices = {first["missing_fields"][0]["id"]: "h264"}
        status, _, inspected = self.post("/api/interfaces/inspect", {
            "package_id": old["id"], "missing_values": choices,
        })
        self.assertEqual(status, 200, inspected)
        status, _, configured = self.post(f"/api/editor-workflows/{ident}/configure", {
            "package_id": old["id"], "previous_package_id": old["id"],
            "previous_values": {}, "previous_baseline": {}, "fields": inspected["fields"],
            "backend_url": self.backend.url, "output_nodes": ["2"], "missing_values": choices,
        })
        self.assertEqual(status, 200, configured)
        self.assertNotEqual(configured["package"]["id"], old["id"])
        self.assertEqual(old_path.read_bytes(), before)
        self.assertNotIn("format.codec", self.app.packages.get(old["id"])["prompt"]["2"]["inputs"])
        current = self.app.editor_workflows.get(ident)
        self.assertEqual(current["revision"], imported["revision"])
        self.assertEqual(current["source_json"], source)
        self.assertEqual(len(self.app.packages.list()), 2)
        self.assert_compiles(configured)

    def test_wrong_enum_existing_binding_and_changed_backend_reject_without_packages(self):
        prompt = video_prompt(format="mp4")
        first = self.inspect_api(prompt)
        for values in ({field_id("2", "format.codec"): "unknown"},
                       {field_id("2", "format"): "webm"},
                       {field_id("2", "format.codec"): True}):
            with self.subTest(values=values):
                status, _, rejected = self.post("/api/interfaces/inspect", {
                    "document": {"prompt": prompt}, "missing_values": values,
                })
                self.assertEqual(status, 400, rejected)
                status, _, rejected = self.apply_api(prompt, first, values)
                self.assertEqual(status, 400, rejected)
                self.assertEqual(self.app.packages.list(), [])
        status, _, rejected = self.apply_api(prompt, first, {field_id("2", "format.codec"): "h264"},
                                            backend_url="http://127.0.0.1:1")
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), [])

    def test_fresh_schema_rejects_stale_choice_and_unselected_dynamic_children(self):
        prompt = video_prompt(format="mp4")
        choices = {field_id("2", "format.codec"): "h264"}
        inspected = self.inspect_api(prompt, choices)
        # Live metadata changes after inspection; cached options cannot authorize apply.
        options = self.backend.info["SaveVideo"]["input"]["required"]["format"][1]["options"]
        for option in options:
            if option["key"] == "mp4":
                codec = option["inputs"]["required"]["codec"][1]
                codec["options"] = [item for item in codec["options"] if item["key"] != "h264"]
        status, _, rejected = self.apply_api(prompt, inspected, choices)
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), [])
        status, _, rejected = self.post("/api/interfaces/inspect", {
            "document": {"prompt": prompt}, "missing_values": {
                field_id("2", "format.codec"): "auto", field_id("2", "format.codec.encoding.crf"): 20,
            },
        })
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), [])

    def test_repairs_reject_unselected_output_and_allow_selected_or_all_declared_outputs(self):
        self.backend.info = {"IndependentOutput": {
            "input": {"required": {"count": ["INT"]}}, "output": [], "output_node": True}}
        prompt = {"A": {"class_type": "IndependentOutput", "inputs": {}},
                  "B": {"class_type": "IndependentOutput", "inputs": {}}}
        original = copy.deepcopy(prompt)
        carrier = {"document": {"prompt": prompt}, "output_nodes": ["B"]}
        status, _, inspection = self.post("/api/interfaces/inspect", carrier)
        self.assertEqual(status, 200, inspection)
        self.assertEqual({field["node_id"] for field in inspection["missing_fields"]}, {"A", "B"})
        self.assertEqual(inspection["execution"]["node_ids"], ["B"])
        repairs_a = {field_id("A", "count"): 1}
        status, _, rejected = self.post("/api/interfaces/inspect", {**carrier, "missing_values": repairs_a})
        self.assertEqual(status, 400, rejected)
        self.assertIn("不参与所选输出", rejected["error"])
        status, _, rejected = self.post("/api/interfaces/apply", {
            "prompt": prompt, "output_nodes": ["B"], "missing_values": repairs_a,
            "fields": [], "backend_url": self.backend.url, "name": "Reject unrelated repairs",
        })
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), [])
        self.assertEqual(prompt, original)

        status, _, inspected_a = self.post("/api/interfaces/inspect", {
            "document": {"prompt": prompt}, "output_nodes": ["A"], "missing_values": repairs_a,
        })
        self.assertEqual(status, 200, inspected_a)
        status, _, applied_a = self.post("/api/interfaces/apply", {
            "prompt": prompt, "output_nodes": ["A"], "missing_values": repairs_a,
            "fields": inspected_a["fields"], "backend_url": self.backend.url, "name": "Selected A",
        })
        self.assertEqual(status, 200, applied_a)
        self.assertEqual(applied_a["package"]["prompt"]["A"]["inputs"], {"count": 1})
        self.assertEqual(applied_a["package"]["prompt"]["B"]["inputs"], {})
        status, _, compiled_a = self.post("/api/compile", {
            "kind": "package", "package_id": applied_a["package"]["id"],
            "values": applied_a["values"], "output_nodes": ["A"],
        })
        self.assertEqual(status, 200, compiled_a)
        self.assertEqual(set(compiled_a["prompt"]), {"A"})

        repairs_both = {**repairs_a, field_id("B", "count"): 2}
        status, _, both = self.post("/api/interfaces/inspect", {
            "document": {"prompt": prompt}, "missing_values": repairs_both,
        })
        self.assertEqual(status, 200, both)
        self.assertEqual(both["missing_fields"], [])
        self.assertEqual(both["execution"]["node_ids"], ["A", "B"])
        status, _, applied_both = self.post("/api/interfaces/apply", {
            "prompt": prompt, "missing_values": repairs_both, "fields": both["fields"],
            "backend_url": self.backend.url, "name": "All declared outputs",
        })
        self.assertEqual(status, 200, applied_both)
        self.assertEqual(applied_both["output_nodes"], ["A", "B"])
        self.assertEqual(prompt, original)

    @unittest.skipUnless(shutil.which("node"), "Node.js is required for the actual browser JSON round trip")
    def test_numeric_enum_survives_browser_integer_transport_through_compile(self):
        self.backend.info = {"NumericOutput": {
            "input": {"required": {"choice": [[1.0]]}}, "output": [], "output_node": True}}
        prompt = {"1": {"class_type": "NumericOutput", "inputs": {}}}
        status, _, initial = self.post("/api/interfaces/inspect", {"document": {"prompt": prompt}})
        self.assertEqual(status, 200, initial)
        browser = self.node_json_roundtrip(initial)
        option = browser["missing_fields"][0]["options"][0]
        self.assertIs(type(option), int)
        choices = {field_id("1", "choice"): option}
        status, _, inspected = self.post("/api/interfaces/inspect", {
            "document": {"prompt": prompt}, "missing_values": choices,
        })
        self.assertEqual(status, 200, inspected)
        self.assertEqual(inspected["missing_fields"], [])
        inspected = self.node_json_roundtrip(inspected)
        status, _, applied = self.post("/api/interfaces/apply", {
            "prompt": prompt, "missing_values": choices, "fields": inspected["fields"],
            "backend_url": self.backend.url, "name": "Numeric enum",
        })
        self.assertEqual(status, 200, applied)
        package_id = applied["package"]["id"]
        status, _, compiled = self.post("/api/compile", {
            "kind": "package", "package_id": package_id, "values": choices,
        })
        self.assertEqual(status, 200, compiled)
        self.assertEqual(compiled["prompt"]["1"]["inputs"]["choice"], 1)
        status, _, plan = self.post("/api/execution-plan", {
            "backend_url": self.backend.url,
            "request": {"kind": "package", "package_id": package_id, "values": choices},
        })
        self.assertEqual(status, 200, plan)
        before = self.app.packages.list()
        status, _, rejected = self.post("/api/interfaces/apply", {
            "prompt": prompt, "missing_values": {field_id("1", "choice"): True},
            "fields": inspected["fields"], "backend_url": self.backend.url, "name": "Invalid bool",
        })
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), before)

    def node_json_roundtrip(self, value):
        result = subprocess.run([shutil.which("node"), "-e",
            "let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>raw+=c);"
            "process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(raw))));"],
            input=json.dumps(value, ensure_ascii=False), capture_output=True, text=True,
            encoding="utf-8", check=True, timeout=5)
        return json.loads(result.stdout)


if __name__ == "__main__":
    unittest.main()
