"""HTTP coverage for read-only native workflow engine compatibility discovery."""

import http.client
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from frameweave.server import App, make_server


class BackendFixture:
    """A tiny ComfyUI-compatible probe target; never queues inference."""

    def __init__(self, info, extensions):
        self.info = info
        self.extensions = extensions
        self.calls = []
        state = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                state.calls.append(("GET", self.path))
                if self.path == "/object_info":
                    value = state.info
                elif self.path == "/extensions":
                    value = state.extensions
                else:
                    value = {"error": "not found"}
                    self.send_json(value, 404)
                    return
                self.send_json(value)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                state.calls.append(("POST", self.path, self.rfile.read(length)))
                self.send_json({"error": "not found"}, 404)

            def send_json(self, value, status=200):
                payload = json.dumps(value).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


class EditorBackendHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        web = root / "web"
        web.mkdir()
        (web / "index.html").write_text("test", encoding="utf-8")

        info = {"KSampler": {"input": {"required": {}}, "output": [],
                             "output_node": False}}
        extensions = ["/extensions/setgetnodes.js",
                      "/extensions/rgthree/fast_groups_bypasser.js"]
        self.current = BackendFixture(info, extensions)
        self.addCleanup(self.current.stop)
        self.registered = BackendFixture(info, extensions)
        self.addCleanup(self.registered.stop)
        self.unregistered = BackendFixture(info, extensions)
        self.addCleanup(self.unregistered.stop)

        self.app = App(root / "data", web, self.current.url)
        # Use only already registered profiles. The start spy makes an accidental
        # lifecycle action fail immediately instead of launching a process.
        self.app.engines.registered_endpoints = lambda: [
            {"id": "other", "name": "Registered engine", "base_url": self.registered.url},
            {"id": "offline", "name": "Offline engine", "base_url": "http://127.0.0.1:1"},
        ]
        self.app.engines.start = Mock(side_effect=AssertionError("discovery must not start engines"))

        self.server = make_server(self.app)
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.addCleanup(self.stop_client)

        status, _, body = self.request("GET", "/api/bootstrap")
        self.assertEqual(status, 200)
        self.token = json.loads(body)["csrf"]
        status, _, imported = self.post("/api/editor-workflows", {
            "name": "Compatibility probe",
            "document": {"version": 0.4, "nodes": [
                {"id": 1, "type": "GetNode", "mode": 4},
                {"id": 2, "type": "SetNode", "mode": 4},
                {"id": 3, "type": "Fast Groups Bypasser (rgthree)", "mode": 4},
                {"id": 4, "type": "KSampler", "mode": 0},
            ], "links": []},
        })
        self.assertEqual(status, 200, imported)
        self.workflow_id = imported["id"]

    def stop_client(self):
        if getattr(self, "server", None) is None:
            return
        self.app.closed.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.server = None

    def request(self, method, path, data=None, csrf=True):
        headers = {"Host": f"127.0.0.1:{self.port}"}
        body = None
        if method == "POST":
            headers["Content-Type"] = "application/json"
            if csrf and hasattr(self, "token"):
                headers["X-FW-Token"] = self.token
            body = json.dumps({} if data is None else data).encode("utf-8")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def post(self, path, data=None, **kwargs):
        status, headers, body = self.request("POST", path, data, **kwargs)
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = body
        return status, headers, parsed

    def test_backend_discovery_requires_csrf_and_has_no_probe_or_engine_side_effects(self):
        before = (list(self.current.calls), list(self.registered.calls),
                  list(self.unregistered.calls))
        status, _, rejected = self.post(
            f"/api/editor-workflows/{self.workflow_id}/backends", {}, csrf=False)
        self.assertEqual(status, 403, rejected)
        self.assertEqual((self.current.calls, self.registered.calls,
                          self.unregistered.calls), before)
        self.app.engines.start.assert_not_called()
        self.assertFalse(any(call[0] == "POST" and call[1] == "/prompt"
                             for backend in (self.current, self.registered,
                                             self.unregistered)
                             for call in backend.calls))

    def test_discovery_probes_only_current_and_registered_engines_and_reports_offline(self):
        status, _, report = self.post(
            f"/api/editor-workflows/{self.workflow_id}/backends", {})
        self.assertEqual(status, 200, report)
        self.assertEqual(report["current"], self.current.url)
        candidates = {item["base_url"]: item for item in report["candidates"]}
        self.assertEqual(set(candidates), {
            self.current.url, self.registered.url, "http://127.0.0.1:1",
        })
        self.assertTrue(candidates[self.current.url]["online"])
        self.assertTrue(candidates[self.registered.url]["online"])
        self.assertEqual(candidates[self.current.url]["matched"], [
            "Fast Groups Bypasser (rgthree)", "GetNode", "KSampler", "SetNode",
        ])
        self.assertEqual(candidates[self.current.url]["counts"]["unresolved"], 0)
        self.assertFalse(candidates["http://127.0.0.1:1"]["online"])
        self.assertEqual(candidates["http://127.0.0.1:1"]["score"], -1)
        self.assertTrue(candidates["http://127.0.0.1:1"]["error"])

        for backend in (self.current, self.registered):
            self.assertCountEqual(backend.calls, [
                ("GET", "/object_info"), ("GET", "/extensions"),
            ])
        self.assertEqual(self.unregistered.calls, [])
        self.app.engines.start.assert_not_called()
        self.assertFalse(any(call[0] == "POST" and call[1] == "/prompt"
                             for backend in (self.current, self.registered,
                                             self.unregistered)
                             for call in backend.calls))
        self.assertEqual(self.app.jobs, {})
        self.assertFalse(self.app.packages.list())

    def test_all_registered_profiles_are_preserved_without_extra_health_probes(self):
        profiles = [{"name": f"Engine {index}", "base_url": f"http://127.0.0.1:{19000+index}"}
                    for index in range(32)]
        self.app.engines.registered_endpoints = lambda: profiles
        self.app.engines.status = Mock(side_effect=AssertionError("No duplicate health scan"))
        with patch('frameweave.server.Backend') as backend:
            backend.return_value.request.side_effect = lambda path, **kwargs: {} if path == '/object_info' else []
            report = self.app.editor_backends(self.workflow_id)
        self.assertEqual(len(report['candidates']), 33)
        self.assertIn(profiles[-1]['base_url'], {item['base_url'] for item in report['candidates']})


if __name__ == "__main__":
    unittest.main()
