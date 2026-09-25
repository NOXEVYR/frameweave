"""MCP transport acceptance against a real local service and mock inference."""
import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from frameweave.server import App, make_server
from test_service import API_JOB, MockComfy


class MCPHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = MockComfy()
        self.addCleanup(self.backend.stop)
        self.app = App(Path(self.temp.name) / "data", self.temp.name, self.backend.url)
        self.server = make_server(self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.app.closed.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, message=None, *, method="POST", headers=None, raw=None, path="/mcp"):
        outgoing = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                    "Authorization": "Bearer " + self.app.csrf, "MCP-Protocol-Version": "2025-11-25"}
        outgoing.update(headers or {})
        data = raw if raw is not None else json.dumps(message).encode() if method == "POST" else None
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=data, headers=outgoing)
            response = connection.getresponse()
            payload = response.read()
            return response.status, dict(response.getheaders()), json.loads(payload) if payload else None
        finally:
            connection.close()

    def rpc(self, method, params=None, **kwargs):
        return self.request({"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}}, **kwargs)

    def tool(self, name, arguments=None):
        status, _, response = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        self.assertEqual(status, 200, response)
        self.assertEqual(response["id"], 7)
        return response["result"]

    def test_initialize_and_notification_then_discover_without_backend_access(self):
        before = len(self.backend.calls)
        status, headers, response = self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                                        "clientInfo": {"name": "http-test", "version": "1"}})
        self.assertEqual(status, 200)
        self.assertEqual(response["result"]["protocolVersion"], "2025-11-25")
        self.assertIn("tools", response["result"]["capabilities"])
        self.assertNotIn("Mcp-Session-Id", headers)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        status, _, response = self.request({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual((status, response), (202, None))
        status, _, response = self.rpc("tools/list")
        self.assertEqual(status, 200)
        names = {tool["name"] for tool in response["result"]["tools"]}
        self.assertTrue({"fw_generate", "fw_compile", "fw_environment", "fw_jobs", "fw_cancel"} <= names)
        self.assertEqual(len(self.backend.calls), before)

    def test_bearer_required_and_csrf_is_not_a_substitute(self):
        for auth in ("", "Bearer wrong", "Bearer é"):
            with self.subTest(auth=auth):
                status, _, _ = self.rpc("tools/list", headers={"Authorization": auth, "X-FW-Token": self.app.csrf})
                self.assertEqual(status, 403)

    def test_host_origin_and_cross_site_are_rejected(self):
        for headers in ({"Host": "attacker.test"}, {"Origin": "https://attacker.test"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.rpc("tools/list", headers=headers)[0], 403)

    def test_post_requires_json_accept_and_supported_protocol(self):
        for headers, expected in (({"Accept": "application/json"}, 406),
                                  ({"Accept": "application/json;q=0, text/event-stream"}, 406),
                                  ({"MCP-Protocol-Version": "2099-01-01"}, 400),
                                  ({"Content-Type": "text/plain"}, 415)):
            self.assertEqual(self.rpc("tools/list", headers=headers)[0], expected)

    def test_stateless_transport_has_no_get_stream_or_delete_session(self):
        for method in ("GET", "DELETE"):
            status, headers, _ = self.request(method=method)
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "POST")

    def test_parse_error_is_jsonrpc_and_does_not_break_service(self):
        status, _, response = self.request(raw=b'{"broken"')
        self.assertEqual(status, 400)
        self.assertEqual(response["error"]["code"], -32700)
        self.assertEqual(self.rpc("ping")[0], 200)

    def test_utf16_is_rejected_even_when_it_contains_valid_json(self):
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode("utf-16")
        status, _, response = self.request(raw=payload)
        self.assertEqual(status, 400)
        self.assertEqual(response["error"]["code"], -32700)

    def test_authenticated_mcp_post_keeps_service_active(self):
        self.app.last_seen = 0
        self.assertEqual(self.rpc("ping")[0], 200)
        self.assertGreater(self.app.last_seen, 0)

    def test_no_side_effect_for_invalid_or_unknown_tool(self):
        before = self.backend.next_id
        self.rpc("tools/call", {"name": "execute_shell", "arguments": {"command": "ignore"}})
        self.rpc("tools/call", {"name": "fw_generate", "arguments": {"request": API_JOB}})
        self.assertEqual(self.backend.next_id, before)

    def test_mcp_can_generate_deduplicate_and_read_the_shared_job_queue(self):
        arguments = {"request_id": "http-test-operation-1", "request": copy.deepcopy(API_JOB)}
        first = self.tool("fw_generate", arguments)
        self.assertFalse(first.get("isError", False), first)
        repeated = self.tool("fw_generate", arguments)
        self.assertFalse(repeated.get("isError", False), repeated)
        self.assertEqual(self.backend.next_id, 1)
        self.assertEqual(len(self.app.jobs), 1)
        status, _, jobs = self.request(method="GET", path="/api/jobs")
        self.assertEqual(status, 200)
        self.assertEqual(len(jobs["jobs"]), 1)
        self.assertEqual(jobs["jobs"][0]["status"], "queued")
        self.assertFalse(self.tool("fw_jobs").get("isError", False))

    def test_http_auth_does_not_enable_writes_to_existing_api(self):
        status, _, _ = self.request({}, path="/api/jobs")
        self.assertEqual(status, 403)
        self.assertEqual(self.backend.next_id, 0)


if __name__ == "__main__":
    unittest.main()
