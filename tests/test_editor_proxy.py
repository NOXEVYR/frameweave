"""Security and routing tests for the embedded ComfyUI editor origin."""

import base64
import hashlib
import http.client
import json
import re
import socket
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from frameweave.editor_proxy import BRIDGE_PATH, EditorProxy


PARENT_ORIGIN = "http://127.0.0.1:9999"


class _ComfyMock(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address):
        super().__init__(address, _ComfyMockHandler)
        self.records = []
        self.record_lock = threading.Lock()
        self.ws_frame_seen = threading.Event()
        self.ws_client_data = b""


class _ComfyMockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _record(self, method):
        with self.server.record_lock:
            self.server.records.append((method, self.path, dict(self.headers.items())))

    def _respond(self, status, body, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if len(self.headers.get_all("Host", [])) > 1:
            self._record("GET")
            self._respond(400, b'{"error":"Duplicate Host"}')
            return
        self._record("GET")
        path = urllib.parse.urlsplit(self.path).path
        if path == "/ws":
            key = self.headers.get("Sec-WebSocket-Key", "")
            digest = hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            accept = base64.b64encode(digest).decode()
            self.close_connection = True
            self.send_response(101, "Switching Protocols")
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            self.connection.sendall(b"\x81\x02hi")
            self.connection.settimeout(4)
            try:
                self.server.ws_client_data = self.connection.recv(4096)
            except OSError:
                self.server.ws_client_data = b""
            self.server.ws_frame_seen.set()
            return
        if path == "/":
            body = b"<!doctype html><html><head><title>Comfy</title></head><body></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Set-Cookie", "backend_secret=must_not_escape; HttpOnly")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif path == "/assets/test.js":
            self._respond(200, b"window.assetLoaded=true;", "application/javascript")
        elif path in {"/api/experiment/models", "/api/experiment/models/checkpoints"}:
            self._respond(200, b'[{"name":"checkpoints"}]')
        elif path in {"/extensions", "/api/extensions"}:
            entries = ["/extensions/demo/main.js", "/extensions/demo.bak_old/main.js",
                       "/extensions/orphan.backup/main.js"]
            payload = entries if path == "/extensions" else {"extensions": entries}
            self._respond(200, json.dumps(payload).encode())
        elif path in {"/rgthree/common/media/svgs.js", "/rgthree/config.js",
                      "/kjweb_async/marked.min.js", "/kjweb_async/purify.min.js"}:
            self._respond(200, b"/* plugin static */", "application/javascript")
        elif path in {"/user.css", "/materialdesignicons.min.css", "/api/userdata/user.css"}:
            self._respond(200, b"body{}", "application/octet-stream")
        elif path == "/userdata/workflow.json":
            self._respond(200, b'{"name":"backend workflow"}')
        elif path == "/settings/theme":
            self._respond(200, b'"backend theme"')
        elif path == "/system_stats":
            self._respond(200, b'{"system":{}}')
        elif path in {"/queue", "/prompt", "/api/queue", "/api/prompt", "/api/system_stats",
                      "/api/object_info", "/api/users", "/api/i18n", "/api/node_replacements"}:
            self._respond(200, b"{}")
        elif path == "/view":
            self._respond(200, b"image bytes", "image/png")
        else:
            self._respond(404, b'{"error":"missing"}')

    def do_PUT(self):
        self._record("PUT")
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self._respond(200, json.dumps({"saved": len(body)}).encode())

    def do_POST(self):
        self._record("POST")
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self._respond(200, json.dumps({"accepted": len(body)}).encode())


class EditorProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend_server = _ComfyMock(("127.0.0.1", 0))
        cls.backend_thread = threading.Thread(target=cls.backend_server.serve_forever, daemon=True)
        cls.backend_thread.start()
        cls.backend_url = f"http://127.0.0.1:{cls.backend_server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.backend_server.shutdown()
        cls.backend_server.server_close()
        cls.backend_thread.join(timeout=2)

    def setUp(self):
        self.proxy = EditorProxy(self.backend_url, PARENT_ORIGIN,
                                 "export function register() { return 'bridge'; }")
        self.info = self.proxy.start()
        self.addCleanup(self.proxy.close)
        self.origin = self.info["origin"]
        self.host = urllib.parse.urlsplit(self.origin).netloc

    def _raw_request(self, method, target, *, cookie=None, headers=None, body=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", int(self.host.rsplit(":", 1)[1]), timeout=5)
        request_headers = {"Host": host or self.host, "Connection": "close"}
        if cookie:
            request_headers["Cookie"] = cookie
        if headers:
            request_headers.update(headers)
        if body is not None:
            request_headers["Content-Length"] = str(len(body))
        conn.request(method, target, body=body, headers=request_headers)
        response = conn.getresponse()
        result = response.status, response.getheaders(), response.read()
        conn.close()
        return result

    def _bootstrap(self):
        target = urllib.parse.urlsplit(self.info["url"])
        status, headers, _ = self._raw_request(
            "GET", target.path + "?" + target.query,
            headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 200)
        cookie_header = next(value for name, value in headers if name.lower() == "set-cookie")
        self.assertEqual(sum(name.lower() == "set-cookie" for name, _ in headers), 1)
        self.assertNotIn("backend_secret", cookie_header)
        self.assertIn("HttpOnly", cookie_header)
        self.assertIn("SameSite=Strict", cookie_header)
        self.assertIn("Path=/", cookie_header)
        return cookie_header.split(";", 1)[0]

    def _get(self, path, cookie, **headers):
        return self._raw_request("GET", path, cookie=cookie, headers=headers)

    def test_backend_and_parent_origin_are_validated_and_start_is_idempotent(self):
        self.assertEqual(self.proxy.start(), self.info)
        self.assertTrue(self.origin.startswith("http://127.0.0.1:"))
        self.assertEqual(self.info["bridgeNonce"], self.proxy.bridgeNonce)
        with self.assertRaises(ValueError):
            EditorProxy("http://example.com:8188", PARENT_ORIGIN, "")
        with self.assertRaises(ValueError):
            EditorProxy(self.backend_url, "http://example.com/path", "")

    def test_first_entry_sets_cookie_and_injects_only_parent_origin_and_nonce(self):
        parsed = urllib.parse.urlsplit(self.info["url"])
        bootstrap_secret = urllib.parse.parse_qs(parsed.query)["session"][0]
        record_start = len(self.backend_server.records)
        cookie = self._bootstrap()
        upstream_paths = [path for method, path, _ in self.backend_server.records[record_start:]
                          if method == "GET"]
        self.assertEqual(upstream_paths, ["/"], "bootstrap secret must stay inside EditorProxy")
        status, _, _ = self._raw_request("GET", "/?session=" + urllib.parse.quote(bootstrap_secret))
        self.assertEqual(status, 403, "bootstrap secret must be one-use and cookie-bound")
        status, _, body = self._get("/", cookie)
        self.assertEqual(status, 200)
        text = body.decode("utf-8")
        match = re.search(r"window\.__PRISM_EDITOR__=(\{.*?\});if", text)
        self.assertIsNotNone(match)
        config = json.loads(match.group(1))
        self.assertEqual(config, {"parentOrigin": PARENT_ORIGIN, "bridgeNonce": self.info["bridgeNonce"]})
        self.assertNotIn(bootstrap_secret, text)
        self.assertNotIn("session", config)

    def test_host_origin_and_cookie_are_checked(self):
        parsed = urllib.parse.urlsplit(self.info["url"])
        status, _, _ = self._raw_request("GET", parsed.path + "?" + parsed.query, host="localhost")
        self.assertEqual(status, 403)
        cookie = self._bootstrap()
        status, _, _ = self._get("/system_stats", cookie, Origin="http://evil.example")
        self.assertEqual(status, 403)
        status, _, _ = self._raw_request("GET", "/system_stats", headers={"Origin": self.origin})
        self.assertEqual(status, 403)

    def test_static_html_bridge_and_extension_routes(self):
        cookie = self._bootstrap()
        status, _, page = self._get("/", cookie)
        self.assertEqual(status, 200)
        self.assertIn(b"window.__PRISM_EDITOR__", page)
        status, headers, script = self._get(BRIDGE_PATH, cookie)
        self.assertEqual(status, 200)
        self.assertEqual(script, self.proxy.bridge_script.encode())
        self.assertIn("application/javascript", dict(headers)["Content-Type"])
        status, _, js = self._get("/assets/test.js", cookie)
        self.assertEqual(status, 200)
        self.assertEqual(js, b"window.assetLoaded=true;")
        for path in ("/api/experiment/models", "/api/experiment/models/checkpoints"):
            status, _, body = self._get(path, cookie)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), [{"name": "checkpoints"}])
        status, _, _ = self._get("/api/experiment/models/checkpoints/unsupported", cookie)
        self.assertEqual(status, 403)
        for path in ("/extensions", "/api/extensions"):
            status, _, body = self._get(path, cookie)
            self.assertEqual(status, 200)
            payload = json.loads(body)
            entries = payload if isinstance(payload, list) else payload["extensions"]
            self.assertIn(BRIDGE_PATH, entries)
            self.assertIn("/extensions/demo/main.js", entries)
            self.assertNotIn("/extensions/demo.bak_old/main.js", entries)
            self.assertIn("/extensions/orphan.backup/main.js", entries)
        for path in ("/rgthree/common/media/svgs.js", "/rgthree/config.js",
                     "/kjweb_async/marked.min.js", "/kjweb_async/purify.min.js"):
            status, _, body = self._get(path, cookie)
            self.assertEqual((status, body), (200, b"/* plugin static */"))
        for path in ("/user.css", "/materialdesignicons.min.css", "/api/userdata/user.css"):
            status, headers, _ = self._get(path, cookie)
            self.assertEqual(status, 200, path)
            self.assertTrue(dict(headers)["Content-Type"].startswith("text/css"), path)
        self.assertFalse(any("Cookie" in record[2] for record in self.backend_server.records))

    def test_settings_and_userdata_writes_are_scoped_to_proxy_session(self):
        cookie = self._bootstrap()
        status, _, listing = self._get("/userdata", cookie)
        self.assertEqual((status, listing), (200, b"[]"))
        status, _, original = self._get("/userdata/workflow.json", cookie)
        self.assertEqual(status, 200)
        self.assertIn(b"backend workflow", original)
        status, _, result = self._raw_request("PUT", "/userdata/workflow.json", cookie=cookie,
                                              headers={"Origin": self.origin,
                                                       "Content-Type": "application/json"},
                                              body=b'{"name":"temporary"}')
        self.assertEqual((status, result), (200, b"{}"))
        status, _, value = self._get("/userdata/workflow.json", cookie)
        self.assertEqual((status, value), (200, b'{"name":"temporary"}'))
        status, _, _ = self._raw_request("PUT", "/settings/theme", cookie=cookie,
                                         headers={"Origin": self.origin, "Content-Type": "application/json"},
                                         body=b'"dark"')
        self.assertEqual(status, 200)
        status, _, value = self._get("/settings/theme", cookie)
        self.assertEqual((status, value), (200, b'"dark"'))
        self.assertFalse(any(method == "PUT" for method, _, _ in self.backend_server.records))

        other = EditorProxy(self.backend_url, PARENT_ORIGIN, "")
        other.start()
        self.addCleanup(other.close)
        other_cookie_info = urllib.parse.urlsplit(other.start()["url"])
        other_host = urllib.parse.urlsplit(other.start()["origin"]).netloc
        other_conn = http.client.HTTPConnection("127.0.0.1", int(other_host.rsplit(":", 1)[1]), timeout=5)
        other_conn.request("GET", other_cookie_info.path + "?" + other_cookie_info.query,
                           headers={"Host": other_host, "Origin": PARENT_ORIGIN, "Connection": "close"})
        other_response = other_conn.getresponse()
        status, headers = other_response.status, other_response.getheaders()
        other_response.read()
        other_conn.close()
        self.assertEqual(status, 200)
        other_cookie = next(value for name, value in headers if name.lower() == "set-cookie").split(";", 1)[0]
        self.assertNotEqual(cookie.split("=", 1)[1], other_cookie.split("=", 1)[1])
        other_conn = http.client.HTTPConnection("127.0.0.1", int(other_host.rsplit(":", 1)[1]), timeout=5)
        other_conn.request("GET", "/userdata/workflow.json", headers={"Host": other_host,
                                                                          "Cookie": other_cookie,
                                                                          "Connection": "close"})
        response = other_conn.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn(b"backend workflow", response.read())
        other_conn.close()

    def test_jobs_uploads_unknown_routes_and_methods_are_denied(self):
        cookie = self._bootstrap()
        for path in ("/queue", "/prompt", "/api/queue", "/api/prompt", "/api/system_stats",
                     "/api/object_info", "/api/users", "/api/i18n", "/api/node_replacements"):
            status, _, _ = self._get(path, cookie)
            self.assertEqual(status, 200, path)
        status, _, body = self._get("/api/global_subgraphs", cookie)
        self.assertEqual((status, body), (200, b"[]"))
        before = len(self.backend_server.records)
        cases = (("POST", "/prompt", b"{}"), ("PUT", "/queue", b"{}"),
                 ("DELETE", "/interrupt", None), ("POST", "/upload/image", b"image"),
                 ("POST", "/api/prompt", b"{}"), ("PUT", "/api/queue", b"{}"),
                 ("POST", "/api/upload/image", b"image"),
                 ("POST", "/not-allowed", b"{}"), ("GET", "/interrupt", None),
                 ("GET", "/not-allowed", None))
        for method, path, body in cases:
            status, _, _ = self._raw_request(method, path, cookie=cookie,
                                             headers={"Origin": self.origin}, body=body)
            self.assertEqual(status, 403, (method, path))
        self.assertEqual(len(self.backend_server.records), before)

    def test_websocket_is_confined_to_ws_and_relays_raw_frames(self):
        cookie = self._bootstrap()
        client = socket.create_connection(("127.0.0.1", int(self.host.rsplit(":", 1)[1])), timeout=5)
        self.addCleanup(client.close)
        key = base64.b64encode(b"0123456789abcdef").decode()
        request = (f"GET /ws?clientId=test-123 HTTP/1.1\r\nHost: {self.host}\r\n"
                   f"Origin: {self.origin}\r\nCookie: {cookie}\r\nUpgrade: websocket\r\n"
                   "Connection: keep-alive, Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                   f"Sec-WebSocket-Key: {key}\r\n\r\n")
        client.sendall(request.encode())
        response = bytearray()
        while b"\r\n\r\n" not in response:
            response.extend(client.recv(4096))
        self.assertIn(b"101 Switching Protocols", response)
        received = bytearray()
        while len(received) < 4:
            received.extend(client.recv(4 - len(received)))
        self.assertEqual(bytes(received), b"\x81\x02hi")
        client.sendall(b"\x81\x02ok")
        self.assertTrue(self.backend_server.ws_frame_seen.wait(3))
        self.assertEqual(self.backend_server.ws_client_data, b"\x81\x02ok")
        self.proxy.close()
        self.assertEqual(self.proxy._active_sockets, set())

    def test_non_ws_paths_cannot_upgrade(self):
        cookie = self._bootstrap()
        status, _, _ = self._raw_request("GET", "/system_stats", cookie=cookie,
                                         headers={"Origin": self.origin, "Upgrade": "websocket",
                                                  "Connection": "Upgrade"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
