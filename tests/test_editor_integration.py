"""Loopback integration coverage for the native ComfyUI editor bridge."""

import copy
import http.client
import json
import os
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path

from frameweave.server import App, make_server
from frameweave.packages import apply_editor_values
from test_service import MockComfy


def editor_document():
    return {
        "id": "native-flow",
        "version": 0.4,
        "revision": 0,
        "last_node_id": 2,
        "last_link_id": 1,
        "nodes": [
            {"id": 1, "type": "LoadImage", "mode": 0,
             "pos": [40.5, 60], "size": [315, 110], "flags": {}, "order": 0,
             "inputs": [], "outputs": [{"name": "IMAGE", "type": "IMAGE",
                                            "links": [1]}],
             "properties": {"Node name for S&R": "LoadImage"},
             "widgets_values": ["incoming/portrait.png"]},
            {"id": 2, "type": "Note", "mode": 4, "pos": [440, 60],
             "size": [240, 120], "flags": {}, "order": 1, "inputs": [],
             "outputs": [], "properties": {},
             "widgets_values": ["Keep this user note"]},
        ],
        "links": [[1, 1, 0, 2, 0, "IMAGE"]],
        "groups": [{"title": "Editor controls", "bounding": [0, 0, 760, 280],
                    "color": "#3f5268", "font_size": 24}],
        "config": {"links_ontop": True},
        "extra": {"ue_links": [[1, 2]], "workflowRendererVersion": "LG",
                  "subgraphs": [{"id": "nested-a", "nodes": [], "links": []}]},
        "definitions": {"subgraphs": [{"id": "nested-b", "nodes": [], "links": [],
                                         "widgets": [{"name": "strength", "value": 0.75}]}]},
    }


def compiled_prompt(image="incoming/portrait.png", text="A soft portrait",
                    seed=37, steps=18, clip_name="encoder-a.safetensors"):
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": image}},
        "2": {"class_type": "TestOutput", "inputs": {
            "image": ["1", 0], "text": text, "seed": seed, "steps": steps,
            "clip_name": clip_name}},
        "3": {"class_type": "TestOutput", "inputs": {
            "image": ["1", 0], "text": "Unselected branch", "seed": 88, "steps": 9,
            "clip_name": "encoder-b.safetensors"}},
    }


def selected_fields(interface, *bindings):
    wanted = set(bindings)
    return [field for field in interface["fields"]
            if (field["node_id"], field["input"]) in wanted]


class EditorIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = MockComfy()
        self.addCleanup(self.backend.stop)
        self.backend.info = {
            "LoadImage": {
                "input": {"required": {"image": [["incoming/portrait.png", "other.png"]]}},
                "output": ["IMAGE", "MASK"], "output_node": False,
            },
            "TestOutput": {
                "input": {"required": {
                    "image": ["IMAGE"],
                    "text": ["STRING"], "seed": ["INT", {"min": 0, "max": 2**32}],
                    "steps": ["INT", {"min": 1, "max": 50}],
                    "clip_name": [["encoder-a.safetensors", "encoder-b.safetensors",
                                   "encoder-internal.safetensors"]],
                }},
                "output": [], "output_node": True,
            },
        }
        web_dir = Path(__file__).resolve().parents[1] / "web"
        self.app = App(self.root / "data", web_dir, self.backend.url)
        self.server = make_server(self.app)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.addCleanup(self.stop_client)
        status, _, payload = self.request("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        self.token = json.loads(payload)["csrf"]

    def stop_client(self):
        if getattr(self, "server", None) is None:
            return
        # Close each editor session through the public endpoint before stopping
        # the app so both proxy threads and App's shutdown waiter are released.
        for session_id in list(self.app.editor_sessions):
            try:
                self.post("/api/editor-sessions/close", {"session_id": session_id})
            except (OSError, http.client.HTTPException):
                session = self.app.editor_sessions.pop(session_id, None)
                if session:
                    session["proxy"].close()
        self.app.closed.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        for session in list(self.app.editor_sessions.values()):
            session["proxy"].close()
        self.app.editor_sessions.clear()
        self.server = None

    def request(self, method, path, data=None, headers=None, raw=None, csrf=True):
        outgoing = {"Host": f"127.0.0.1:{self.port}"}
        body = raw
        if method == "POST":
            outgoing["Content-Type"] = "application/json"
            if csrf and hasattr(self, "token"):
                outgoing["X-FW-Token"] = self.token
            if body is None:
                body = json.dumps({} if data is None else data,
                                 ensure_ascii=False).encode("utf-8")
        outgoing.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        try:
            connection.request(method, path, body=body, headers=outgoing)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post(self, path, data=None, **kwargs):
        status, headers, body = self.request("POST", path, data, **kwargs)
        return status, headers, json.loads(body)

    def import_document(self, document=None, source_json=None, name="Native graph"):
        body = {"name": name}
        if document is not None:
            body["document"] = document
        if source_json is not None:
            body["source_json"] = source_json
        return self.post("/api/editor-workflows", body)

    def test_native_and_bom_import_roundtrip_preserves_original_editor_json_offline(self):
        document = editor_document()
        source = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        self.assertEqual(imported["name"], "Native graph")
        self.assertEqual((imported["nodes"], imported["links"]), (2, 1))

        status, _, loaded = self.request("GET", f"/api/editor-workflows/{ident}")
        self.assertEqual(status, 200)
        loaded = json.loads(loaded)
        self.assertEqual(loaded["source_json"], source)
        self.assertEqual(loaded["document"]["nodes"][1]["widgets_values"],
                         ["Keep this user note"])
        self.assertEqual(loaded["document"]["extra"], document["extra"])
        self.assertEqual(loaded["document"]["definitions"], document["definitions"])
        status, _, exported = self.post(f"/api/editor-workflows/{ident}/export")
        self.assertEqual(status, 200, exported)
        self.assertEqual(exported["source_json"], source)

        bom_source = "\ufeff" + source
        status, _, bom_imported = self.import_document(
            source_json=bom_source, name="BOM graph")
        self.assertEqual(status, 200, bom_imported)
        status, _, bom_exported = self.post(
            f"/api/editor-workflows/{bom_imported['id']}/export")
        self.assertEqual(status, 200, bom_exported)
        self.assertEqual(bom_exported["source_json"], bom_source)
        status, _, listing = self.request("GET", "/api/editor-workflows")
        self.assertEqual(status, 200)
        listing = json.loads(listing)
        self.assertEqual(listing["total"], 2)
        self.assertTrue(all("document" not in item for item in listing["workflows"]))
        self.assertFalse(any(call[:2] == ("POST", "/prompt")
                             for call in self.backend.calls))
        self.assertEqual(self.backend.next_id, 0)

    def test_editor_inspect_has_no_storage_or_generation_side_effects(self):
        source = json.dumps(editor_document(), ensure_ascii=False,
                            separators=(",", ":"))
        status, _, inspected = self.post(
            "/api/editor-workflows/inspect", {"source_json": source})
        self.assertEqual(status, 200, inspected)
        self.assertEqual(inspected, {"nodes": 2, "links": 1})
        self.assertFalse(self.app.editor_workflows.directory.exists())
        self.assertFalse(self.app.packages.list())
        self.assertFalse(any(call[:2] == ("POST", "/prompt")
                             for call in self.backend.calls))
        self.assertEqual(self.backend.next_id, 0)

    def test_editor_import_and_inspect_report_specific_unsafe_integer(self):
        document = editor_document()
        document['nodes'][0]['widgets_values'] = [{'image_hash': 492469318636598500}]
        source = json.dumps(document)
        for route in ('/api/editor-workflows/inspect', '/api/editor-workflows'):
            status, _, response = self.post(route, {'name': 'Invalid fixture', 'document': document, 'source_json': source})
            self.assertEqual(status, 400, response)
            self.assertIn('浏览器的精确范围', response['error'])
            self.assertIn('原文件未修改', response['error'])
            self.assertNotIn('492469318636598500', response['error'])
        self.assertFalse(self.app.editor_workflows.directory.exists())
        self.assertEqual(self.backend.next_id, 0)

    def test_draft_revision_conflicts_and_identical_document_is_a_noop(self):
        document = editor_document()
        source = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        status, _, imported = self.import_document(document=document,
                                                   source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        draft_path = f"/api/editor-workflows/{ident}/draft"

        status, _, unchanged = self.post(draft_path, {
            "document": document, "base_revision": imported["revision"],
        })
        self.assertEqual(status, 200, unchanged)
        self.assertEqual(unchanged["revision"], imported["revision"])

        draft = copy.deepcopy(document)
        draft["nodes"][1]["widgets_values"] = ["Concurrent edit"]
        status, _, saved = self.post(draft_path, {
            "document": draft, "base_revision": imported["revision"],
        })
        self.assertEqual(status, 200, saved)
        self.assertEqual(saved["revision"], imported["revision"] + 1)

        conflicting = copy.deepcopy(document)
        conflicting["nodes"][1]["widgets_values"] = ["Stale edit"]
        status, _, rejected = self.post(draft_path, {
            "document": conflicting, "base_revision": imported["revision"],
        })
        self.assertEqual(status, 400, rejected)
        self.assertIn("另一窗口已保存", rejected["error"])
        current = self.app.editor_workflows.get(ident)
        self.assertEqual(current["revision"], saved["revision"])
        self.assertEqual(current["document"], draft)
        revisions = self.app.editor_workflows.directory / ident / "revisions"
        self.assertEqual(sorted(path.name for path in revisions.iterdir()), [
            "revision-00000001.json", "revision-00000002.json",
        ])
        self.assertFalse(any(call[:2] == ("POST", "/prompt")
                             for call in self.backend.calls))
        self.assertEqual(self.backend.next_id, 0)

    def test_session_apply_validation_values_and_draft_do_not_replace_package(self):
        document = editor_document()
        source = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]

        status, _, session = self.post(f"/api/editor-workflows/{ident}/session")
        self.assertEqual(status, 200, session)
        session_id = session["session_id"]
        self.assertEqual(session["backend_url"], self.backend.url)
        self.assertTrue(session["url"].startswith(session["origin"] + "/?session="))
        self.assertIn(session_id, self.app.editor_sessions)

        invalid = compiled_prompt()
        invalid["2"]["class_type"] = "NotInstalled"
        status, _, rejected = self.post(
            f"/api/editor-workflows/{ident}/apply",
            {"session_id": session_id, "document": document, "prompt": invalid,
             "output_nodes": ["2"]})
        self.assertEqual(status, 400, rejected)
        self.assertFalse(self.app.packages.list())
        self.assertFalse(any(call[:2] == ("POST", "/prompt")
                             for call in self.backend.calls))

        prompt = compiled_prompt()
        status, _, interface = self.post(
            f"/api/editor-workflows/{ident}/interface", {"prompt": prompt})
        self.assertEqual(status, 200, interface)
        self.assertEqual([output["id"] for output in interface["outputs"]], ["2", "3"])
        fields = selected_fields(interface, ("1", "image"), ("2", "text"),
                                 ("2", "seed"), ("2", "steps"))
        self.assertEqual({(field["node_id"], field["input"]) for field in fields}, {
            ("1", "image"), ("2", "text"), ("2", "seed"), ("2", "steps"),
        })
        status, _, applied = self.post(
            f"/api/editor-workflows/{ident}/apply",
            {"session_id": session_id, "document": document, "prompt": prompt,
             "base_revision": imported["revision"], "fields": fields,
             "output_nodes": ["2"]})
        self.assertEqual(status, 200, applied)
        package = applied["package"]
        package_id = package["id"]
        self.assertEqual(applied["workflow"]["revision"], 2)
        self.assertEqual(applied["backend_url"], self.backend.url)

        fields = {field["input"]: field for field in package["fields"]}
        expected_values = {
            fields["image"]["id"]: "incoming/portrait.png",
            fields["text"]["id"]: "A soft portrait",
            fields["seed"]["id"]: 37,
            fields["steps"]["id"]: 18,
        }
        self.assertEqual(applied["values"], expected_values)
        saved_package = self.app.packages.get(package_id)
        self.assertEqual(saved_package["prompt"]["1"]["inputs"]["image"], "")
        self.assertEqual(saved_package["prompt"]["2"]["inputs"],
                         {"image": ["1", 0], "text": "A soft portrait", "seed": 37,
                          "steps": 18, "clip_name": "encoder-a.safetensors"})
        status, _, rehydrated = self.post(
            f"/api/packages/{package_id}/apply", {"values": applied["values"]})
        self.assertEqual(status, 200, rehydrated)
        self.assertEqual(rehydrated["prompt"], prompt)

        resolved = self.app.resolve_request({
            "kind": "package", "package_id": package_id,
            "values": applied["values"], "editor_backend": self.backend.url,
            "output_nodes": applied["output_nodes"],
        })
        self.assertEqual({key: resolved[key] for key in ('kind', 'prompt')}, {"kind": "api", "prompt": {
            "1": prompt["1"], "2": prompt["2"],
        }})
        self.assertEqual(resolved['execution']['selected_outputs'], ['2'])
        self.assertEqual(resolved['execution']['ignored_node_ids'], ['3'])

        status, _, generated = self.post("/api/generate", {
            "request_id": "editor-flow-generate-01",
            "request": {
                "kind": "package", "package_id": package_id,
                "values": applied["values"],
                "editor_backend": applied["backend_url"],
                "output_nodes": applied["output_nodes"],
            },
        })
        self.assertEqual(status, 200, generated)
        self.assertEqual(generated["id"], "job-1")
        self.assertEqual(generated["request_id"], "editor-flow-generate-01")
        self.assertFalse(generated["replayed"])
        prompt_calls = [call for call in self.backend.calls
                        if call[:2] == ("POST", "/prompt")]
        self.assertEqual(len(prompt_calls), 1)
        self.assertEqual(prompt_calls[0][2]["prompt"], {
            "1": prompt["1"], "2": prompt["2"],
        })
        self.assertEqual(self.backend.next_id, 1)

        package_export = self.app.packages.export_transport(package_id)
        draft = copy.deepcopy(document)
        draft["nodes"][1]["widgets_values"] = ["Draft-only note"]
        draft["extra"]["draft_change"] = True
        status, _, draft_result = self.post(
            f"/api/editor-workflows/{ident}/draft", {"document": draft})
        self.assertEqual(status, 200, draft_result)
        self.assertEqual(draft_result["revision"], 3)
        self.assertTrue(draft_result["summary"]["stale"])
        self.assertEqual(self.app.packages.list()[0]["id"], package_id)
        self.assertEqual(self.app.packages.export_transport(package_id), package_export)
        current = self.app.editor_workflows.get(ident)
        self.assertEqual(current["document"]["nodes"][1]["widgets_values"],
                         ["Draft-only note"])
        compiled = self.app.editor_workflows.get_compiled(ident)
        self.assertEqual(compiled["prompt"], prompt)
        self.assertTrue(compiled["stale"])

        status, _, closed = self.post("/api/editor-sessions/close",
                                      {"session_id": session_id})
        self.assertEqual(status, 200, closed)
        self.assertNotIn(session_id, self.app.editor_sessions)

    def test_switching_backend_rejects_old_editor_session_and_package_request(self):
        document = editor_document()
        source = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        status, _, session = self.post(f"/api/editor-workflows/{ident}/session")
        self.assertEqual(status, 200, session)
        session_id = session["session_id"]
        original_backend = session["backend_url"]

        status, _, settings = self.post("/api/settings", {
            "backend_url": "http://127.0.0.1:1", "performance_profile": "auto",
            "auto_start_engine": False, "auto_update": False,
            "model_roots": [], "comfy_roots": [],
        })
        self.assertEqual(status, 200, settings)
        self.assertEqual(self.app.backend.url, "http://127.0.0.1:1")

        status, _, rejected = self.post(f"/api/editor-workflows/{ident}/apply", {
            "session_id": session_id, "document": document,
            "prompt": compiled_prompt(),
        })
        self.assertEqual(status, 400, rejected)
        self.assertIn("后端已变化", rejected["error"])
        with self.assertRaisesRegex(ValueError, "另一推理后端"):
            self.app.resolve_request({
                "kind": "package", "package_id": "p-" + "0" * 24,
                "values": {}, "editor_backend": original_backend,
            })
        self.assertFalse(any(call[:2] == ("POST", "/prompt")
                             for call in self.backend.calls))
        status, _, closed = self.post("/api/editor-sessions/close",
                                      {"session_id": session_id})
        self.assertEqual(status, 200, closed)
        self.assertNotIn(session_id, self.app.editor_sessions)

    def test_configure_preserves_internal_baseline_and_apply_requires_conflict_resolution(self):
        document = editor_document()
        source = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        status, _, session = self.post(f"/api/editor-workflows/{ident}/session")
        self.assertEqual(status, 200, session)
        session_id = session["session_id"]

        original_prompt = compiled_prompt()
        status, _, interface = self.post(
            f"/api/editor-workflows/{ident}/interface", {"prompt": original_prompt})
        self.assertEqual(status, 200, interface)
        original_fields = selected_fields(
            interface, ("1", "image"), ("2", "text"), ("2", "seed"), ("2", "steps"))
        status, _, applied = self.post(f"/api/editor-workflows/{ident}/apply", {
            "session_id": session_id, "document": document, "prompt": original_prompt,
            "base_revision": imported["revision"], "fields": original_fields,
            "output_nodes": ["2"],
        })
        self.assertEqual(status, 200, applied)
        previous_package = applied["package"]
        seed_id = next(field["id"] for field in previous_package["fields"]
                       if field["node_id"] == "2" and field["input"] == "seed")
        outer_values = copy.deepcopy(applied["values"])
        outer_values[seed_id] = 41

        status, _, config_interface = self.post(
            f"/api/editor-workflows/{ident}/interface", {
                "package_id": previous_package["id"], "values": outer_values,
                "previous_baseline": applied["baseline"],
            })
        self.assertEqual(status, 200, config_interface)
        new_fields = selected_fields(
            config_interface, ("1", "image"), ("2", "text"), ("2", "seed"),
            ("2", "clip_name"))
        encoder = next(field for field in new_fields if field["input"] == "clip_name")
        self.assertEqual((encoder["node_id"], encoder["type"]), ("2", "select"))
        status, _, configured = self.post(f"/api/editor-workflows/{ident}/configure", {
            "package_id": previous_package["id"], "values": outer_values,
            "backend_url": self.backend.url, "fields": new_fields,
            "output_nodes": ["2"], "previous_package_id": previous_package["id"],
            "previous_values": outer_values, "previous_baseline": applied["baseline"],
        })
        self.assertEqual(status, 200, configured)
        configured_seed = next(field["id"] for field in configured["package"]["fields"]
                               if field["node_id"] == "2" and field["input"] == "seed")
        configured_encoder = next(field for field in configured["package"]["fields"]
                                  if field["node_id"] == "2" and field["input"] == "clip_name")
        self.assertEqual((configured_encoder["input"], configured_encoder["type"]),
                         ("clip_name", "select"))
        self.assertEqual(configured["baseline"][configured_seed], 37)
        self.assertEqual(configured["values"][configured_seed], 41)
        self.assertEqual(configured["values"][configured_encoder["id"]],
                         "encoder-a.safetensors")
        self.assertIn("steps", [field["input"] for field in configured["changes"]["removed"]])
        self.assertIn("clip_name", [field["input"] for field in configured["changes"]["new"]])

        edited_prompt = compiled_prompt(seed=22, clip_name="encoder-internal.safetensors")
        status, _, edited_interface = self.post(
            f"/api/editor-workflows/{ident}/interface", {"prompt": edited_prompt})
        self.assertEqual(status, 200, edited_interface)
        edited_fields = selected_fields(
            edited_interface, ("1", "image"), ("2", "text"), ("2", "seed"),
            ("2", "clip_name"))
        apply_payload = {
            "session_id": session_id, "document": document, "prompt": edited_prompt,
            "base_revision": configured["workflow"]["revision"], "fields": edited_fields,
            "output_nodes": ["2"], "previous_package_id": configured["package"]["id"],
            "previous_values": configured["values"],
            "previous_baseline": configured["baseline"],
        }
        status, _, unresolved = self.post(f"/api/editor-workflows/{ident}/apply", apply_payload)
        self.assertEqual(status, 200, unresolved)
        self.assertTrue(unresolved["requires_resolution"])
        conflicts = unresolved["changes"]["conflicts"]
        self.assertEqual(len(conflicts), 1)
        conflict = conflicts[0]
        self.assertEqual(conflict["id"], configured_seed)
        self.assertEqual(conflict["field_id"], configured_seed)
        self.assertEqual((conflict["old_baseline"], conflict["outer"], conflict["inner"]),
                         (37, 41, 22))

        status, _, resolved = self.post(f"/api/editor-workflows/{ident}/apply", {
            **apply_payload, "resolutions": {configured_seed: "outer"},
        })
        self.assertEqual(status, 200, resolved)
        self.assertFalse(resolved.get("requires_resolution", False))
        self.assertEqual(resolved["values"][configured_seed], 41)
        self.assertEqual(resolved["baseline"][configured_seed], 22)
        self.assertEqual(resolved["output_nodes"], ["2"])

        invalid_payload = {**apply_payload,
                           "base_revision": resolved["workflow"]["revision"],
                           "previous_package_id": resolved["package"]["id"],
                           "previous_values": {**resolved["values"], configured_seed: -1},
                           "previous_baseline": resolved["baseline"]}
        for resolutions in ({}, {configured_seed: "outer"}):
            status, _, invalid = self.post(f"/api/editor-workflows/{ident}/apply", {
                **invalid_payload, "resolutions": resolutions})
            self.assertEqual(status, 200, invalid)
            self.assertTrue(invalid["requires_resolution"])
            self.assertEqual(invalid["changes"]["conflicts"][0]["allowed"], ["inner"])
            self.assertEqual(self.app.editor_workflows.get(ident)["revision"],
                             resolved["workflow"]["revision"])
        status, _, accepted = self.post(f"/api/editor-workflows/{ident}/apply", {
            **invalid_payload, "resolutions": {configured_seed: "inner"}})
        self.assertEqual(status, 200, accepted)
        self.assertFalse(accepted.get("requires_resolution", False))
        self.assertEqual(accepted["values"][configured_seed], 22)

    def _transaction_fixture(self):
        document = editor_document()
        status, _, imported = self.import_document(
            document=document, source_json=json.dumps(document, ensure_ascii=False, indent=3))
        self.assertEqual(status, 200, imported)
        ident = imported['id']
        status, _, session = self.post(f'/api/editor-workflows/{ident}/session')
        self.assertEqual(status, 200, session)
        payload = {'session_id': session['session_id'], 'document': document,
                   'prompt': compiled_prompt(), 'output_nodes': ['2']}
        status, _, applied = self.post(f'/api/editor-workflows/{ident}/apply', payload)
        self.assertEqual(status, 200, applied)
        package = applied['package']
        self.app.packages.update_metadata(package['id'], {'favorite': True, 'archived': True})
        # Preserve noncanonical but equivalent stored JSON exactly as well as ID.
        package_path = self.app.packages._path(package['id'])
        package_path.write_text(json.dumps(json.loads(package_path.read_bytes()),
                                           ensure_ascii=False, indent=3), encoding='utf-8')
        record_dir = self.app.editor_workflows.directory / ident
        before = {
            'meta': (record_dir / 'meta.json').read_bytes(),
            'source': self.app.editor_workflows.export(ident),
            'compiled': self.app.editor_workflows.get_compiled(ident),
            'packages': {path.name: path.read_bytes()
                         for path in self.app.packages.directory.glob('*.json')},
        }
        modified = copy.deepcopy(document)
        modified['nodes'][1]['widgets_values'] = ['Keep the edited note']
        return ident, payload, {**payload, 'document': modified, 'prompt': compiled_prompt(seed=42),
                                'base_revision': applied['workflow']['revision']}, before

    def _assert_transaction_preserved(self, ident, before):
        record_dir = self.app.editor_workflows.directory / ident
        self.assertEqual((record_dir / 'meta.json').read_bytes(), before['meta'])
        self.assertEqual(self.app.editor_workflows.export(ident), before['source'])
        self.assertEqual(self.app.editor_workflows.get_compiled(ident), before['compiled'])
        self.assertEqual({path.name: path.read_bytes()
                          for path in self.app.packages.directory.glob('*.json')}, before['packages'])
        self.assertEqual(list(self.app.packages.directory.glob('.editor-package-*')), [])
        self.assertEqual(list(record_dir.glob('.apply-meta-*')), [])
        self.assertFalse(any(call[:2] == ('POST', '/prompt') for call in self.backend.calls))

    def test_native_apply_stage_and_revision_failures_preserve_both_stores(self):
        ident, original, payload, before = self._transaction_fixture()
        store = self.app.editor_workflows
        real_write = store._write_new_atomic

        def compiled_failure(path, raw):
            if path.parent.name == 'compiled':
                raise OSError('injected compiled write failure')
            return real_write(path, raw)

        cases = [
            ('package stage', patch('frameweave.server.os.fsync',
                                    side_effect=OSError('injected stage write failure'))),
            ('save revision', patch.object(store, 'save_revision',
                                          side_effect=OSError('injected revision write failure'))),
            ('compiled file', patch.object(store, '_write_new_atomic', side_effect=compiled_failure)),
            ('meta commit', patch.object(store, '_write_atomic',
                                        side_effect=OSError('injected meta commit failure'))),
        ]
        for name, failure in cases:
            with self.subTest(failure=name), failure:
                status, _, result = self.post(f'/api/editor-workflows/{ident}/apply', payload)
            self.assertEqual(status, 502, result)
            self._assert_transaction_preserved(ident, before)
        # An already installed package may be shared by other canvases. Failure
        # while reusing it must preserve raw bytes, content ID and organization.
        with patch.object(store, 'save_revision', side_effect=OSError('reuse failed')):
            status, _, result = self.post(f'/api/editor-workflows/{ident}/apply', original)
        self.assertEqual(status, 502, result)
        self._assert_transaction_preserved(ident, before)

    def test_native_apply_package_publish_failure_restores_exact_visible_revision(self):
        ident, _, payload, before = self._transaction_fixture()
        real_link = os.link

        def publish_failure(source, target):
            if Path(target).name.startswith('p-'):
                raise OSError('injected package publication failure')
            return real_link(source, target)

        with patch('frameweave.server.os.link', side_effect=publish_failure):
            status, _, result = self.post(f'/api/editor-workflows/{ident}/apply', payload)
        self.assertEqual(status, 502, result)
        self._assert_transaction_preserved(ident, before)
        # Failed immutable revisions can remain on disk. Retry skips them and
        # commits a usable package and the complete editor graph.
        status, _, applied = self.post(f'/api/editor-workflows/{ident}/apply', payload)
        self.assertEqual(status, 200, applied)
        self.assertGreater(applied['workflow']['revision'], payload['base_revision'])
        self.assertEqual(self.app.editor_workflows.get(ident)['document'], payload['document'])
        self.assertEqual(self.app.editor_workflows.get_compiled(ident)['prompt'], payload['prompt'])
        self.assertEqual(apply_editor_values(self.app.packages.get(applied['package']['id']),
                                            applied['baseline']), payload['prompt'])
        for name, raw in before['packages'].items():
            self.assertEqual((self.app.packages.directory / name).read_bytes(), raw)

    def test_native_apply_reports_and_keeps_original_meta_if_rollback_also_fails(self):
        ident, _, payload, before = self._transaction_fixture()
        real_link, real_replace = os.link, os.replace

        def publish_failure(source, target):
            if Path(target).name.startswith('p-'):
                raise OSError('injected package publication failure')
            return real_link(source, target)

        def rollback_failure(source, target):
            if Path(source).suffix == '.backup':
                raise OSError('injected rollback failure')
            return real_replace(source, target)

        with patch('frameweave.server.os.link', side_effect=publish_failure), \
                patch('frameweave.editor_workflows.os.replace', side_effect=rollback_failure):
            status, _, result = self.post(f'/api/editor-workflows/{ident}/apply', payload)
        self.assertEqual(status, 502, result)
        self.assertIn('publication failure', result['error'])
        self.assertIn('rollback failure', result['error'])
        self.assertIn('原meta完整备份已保留', result['error'])
        record_dir = self.app.editor_workflows.directory / ident
        backups = list(record_dir.glob('.apply-meta-*.backup'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before['meta'])
        self.assertEqual({path.name: path.read_bytes()
                          for path in self.app.packages.directory.glob('*.json')}, before['packages'])
        # Recover using the retained exact metadata; original immutable files
        # remain intact even when the first restore operation was refused.
        real_replace(backups[0], record_dir / 'meta.json')
        self._assert_transaction_preserved(ident, before)

    def test_configure_rebinding_requires_resolution_before_package_or_revision_write(self):
        document = editor_document()
        source = json.dumps(document, ensure_ascii=False, separators=(",", ":"))
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        ident = imported["id"]
        status, _, session = self.post(f"/api/editor-workflows/{ident}/session")
        self.assertEqual(status, 200, session)

        original_prompt = compiled_prompt()
        status, _, interface = self.post(
            f"/api/editor-workflows/{ident}/interface", {"prompt": original_prompt})
        self.assertEqual(status, 200, interface)
        old_fields = selected_fields(
            interface, ("1", "image"), ("2", "seed"), ("2", "steps"))
        status, _, applied = self.post(f"/api/editor-workflows/{ident}/apply", {
            "session_id": session["session_id"], "document": document,
            "prompt": original_prompt, "base_revision": imported["revision"],
            "fields": old_fields, "output_nodes": ["2"],
        })
        self.assertEqual(status, 200, applied)
        previous = applied["package"]
        source_seed = next(field for field in previous["fields"]
                           if field["node_id"] == "2" and field["input"] == "seed")
        source_steps = next(field for field in previous["fields"]
                            if field["node_id"] == "2" and field["input"] == "steps")
        outer_values = copy.deepcopy(applied["values"])
        outer_values[source_seed["id"]] = 41

        status, _, config_interface = self.post(
            f"/api/editor-workflows/{ident}/interface", {
                "package_id": previous["id"], "values": outer_values,
                "previous_baseline": applied["baseline"],
            })
        self.assertEqual(status, 200, config_interface)
        new_fields = selected_fields(config_interface, ("1", "image"), ("3", "seed"))
        target_seed = next(field for field in new_fields if field["input"] == "seed")
        revision = self.app.editor_workflows.get(ident)["revision"]
        package_count = len(self.app.packages.list())
        configure_payload = {
            "package_id": previous["id"], "values": outer_values,
            "backend_url": self.backend.url, "fields": new_fields,
            "output_nodes": ["3"], "previous_package_id": previous["id"],
            "previous_values": outer_values,
            "previous_baseline": applied["baseline"],
        }

        status, _, duplicate = self.post(
            f"/api/editor-workflows/{ident}/configure", {
                **configure_payload,
                "rebindings": {source_seed["id"]: target_seed["id"],
                               source_steps["id"]: target_seed["id"]},
            })
        self.assertEqual(status, 400, duplicate)
        self.assertEqual(len(self.app.packages.list()), package_count)
        self.assertEqual(self.app.editor_workflows.get(ident)["revision"], revision)

        rebindings = {source_seed["id"]: target_seed["id"]}
        removed_prompt = copy.deepcopy(original_prompt)
        del removed_prompt["2"]
        status, _, missing_mapping = self.post(f"/api/editor-workflows/{ident}/apply", {
            **configure_payload, "session_id": session["session_id"],
            "document": document, "prompt": removed_prompt, "rebindings": {},
        })
        self.assertEqual(status, 400, missing_mapping)
        self.assertIn("明确重绑", str(missing_mapping))
        self.assertEqual(len(self.app.packages.list()), package_count)
        self.assertEqual(self.app.editor_workflows.get(ident)["revision"], revision)
        status, _, unresolved = self.post(
            f"/api/editor-workflows/{ident}/configure", {
                **configure_payload, "rebindings": rebindings,
            })
        self.assertEqual(status, 200, unresolved)
        self.assertTrue(unresolved["requires_resolution"])
        conflict = unresolved["changes"]["conflicts"][0]
        self.assertEqual(conflict["field_id"], target_seed["id"])
        self.assertEqual((conflict["old_baseline"], conflict["outer"], conflict["inner"]),
                         (37, 41, 88))
        self.assertEqual(len(self.app.packages.list()), package_count)
        self.assertEqual(self.app.editor_workflows.get(ident)["revision"], revision)

        for choice, expected in (("outer", 41), ("inner", 88)):
            status, _, resolved = self.post(
                f"/api/editor-workflows/{ident}/configure", {
                    **configure_payload, "rebindings": rebindings,
                    "resolutions": {target_seed["id"]: choice},
                })
            self.assertEqual(status, 200, resolved)
            self.assertFalse(resolved.get("requires_resolution", False))
            self.assertEqual(resolved["values"][target_seed["id"]], expected)
            self.assertEqual(resolved["baseline"][target_seed["id"]], 88)
            self.assertEqual(self.app.editor_workflows.get(ident)["revision"], revision)


if __name__ == "__main__":
    unittest.main()
