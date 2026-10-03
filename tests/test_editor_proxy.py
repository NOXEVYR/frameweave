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
from unittest.mock import patch

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
        elif path in {"/settings", "/api/settings"}:
            self._respond(200, b'{"Comfy.TutorialCompleted":false,"theme":"backend theme","plugin":{"enabled":false}}')
        elif path == "/system_stats":
            self._respond(200, b'{"system":{}}')
        elif path in {"/queue", "/prompt", "/api/queue", "/api/prompt", "/api/system_stats",
                      "/api/object_info", "/api/users", "/api/i18n", "/api/node_replacements"}:
            self._respond(200, b"{}")
        elif path in {"/view", "/api/view"}:
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

    def test_first_entry_sets_cookie_and_injects_session_media_protocol_without_secrets(self):
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
        self.assertEqual(config, {"parentOrigin": PARENT_ORIGIN, "bridgeNonce": self.info["bridgeNonce"],
                                  "backendUrl": self.backend_url, "mediaProtocol": 1, "promotedAudioProtocol": 1})
        self.assertNotIn(bootstrap_secret, text)
        self.assertNotIn("session", config)

    def test_exact_media_modules_are_local_authenticated_reads_without_upstream_requests(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        for path, export in [("/prism-editor-media.mjs", b"createNativeEditorMedia"),
                             ("/native-editor-vhs-preview.mjs", b"export "),
                             ("/prism-editor-media-preview.mjs", b"createEditorMediaPreview")]:
            status, headers, body = self._get(path, cookie)
            self.assertEqual(status, 200)
            self.assertIn(export, body)
            self.assertTrue(any(name.lower() == "content-type" and "javascript" in value for name, value in headers))
            status, _, _ = self._raw_request("GET", path)
            self.assertEqual(status, 403)
            status, _, _ = self._raw_request("POST", path, cookie=cookie,
                                            headers={"Origin": self.origin}, body=b"{}")
            self.assertEqual(status, 403)
        self.assertEqual(len(self.backend_server.records), before)
        status, _, _ = self._raw_request("GET", "/prism-editor-media.mjs")
        self.assertEqual(status, 403)
        status, _, _ = self._raw_request("POST", "/prism-editor-media.mjs", cookie=cookie,
                                        headers={"Origin": self.origin}, body=b"{}")
        self.assertEqual(status, 403)

    def test_media_modules_do_not_open_vhs_transcode_query_or_arbitrary_files(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        for path in ["/vhs/viewvideo?filename=x.mp4&type=input", "/vhs/queryvideo?filename=x.mp4",
                     "/api/vhs/queryvideo?filename=x.mp4", "/native-editor-vhs-preview.mjs/other.mjs",
                     "/native-editor-vhs-preview.mjs.bak",
                     "/prism-editor-media.mjs/other.mjs", "/prism-editor-media-preview.mjs.bak",
                     "/prism-editor-media.mjs%2f..%2fsettings"]:
            status, _, _ = self._get(path, cookie)
            self.assertIn(status, {400, 403})
        self.assertEqual(len(self.backend_server.records), before)

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

    def test_embedded_editor_skips_onboarding_without_changing_backend_settings(self):
        cookie = self._bootstrap()
        for path in ("/settings", "/api/settings"):
            status, _, body = self._get(path, cookie)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"Comfy.TutorialCompleted": True,
                                               "theme": "backend theme", "plugin": {"enabled": False}})
        for path in ("/settings", "/api/settings"):
            status, _, _ = self._raw_request("PUT", path, cookie=cookie,
                                             headers={"Origin": self.origin, "Content-Type": "application/json"},
                                             body=b'{"Comfy.TutorialCompleted":false,"theme":"session theme"}')
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(self._get(path, cookie)[2]),
                             {"Comfy.TutorialCompleted": True, "theme": "session theme",
                              "plugin": {"enabled": False}})
        for path in ("/settings/Comfy.TutorialCompleted", "/api/settings/Comfy.TutorialCompleted"):
            self.assertEqual(self._get(path, cookie)[2], b"true")
        self.assertFalse(any(method in {"PUT", "POST"} for method, _, _ in self.backend_server.records))

    def test_editor_settings_ignore_conditional_requests_and_disable_caching(self):
        cookie = self._bootstrap()
        status, headers, body = self._raw_request("GET", "/api/settings?version=2", cookie=cookie,
                                                headers={"If-None-Match": "old", "If-Modified-Since": "yesterday",
                                                         "Range": "bytes=0-4"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["Comfy.TutorialCompleted"])
        self.assertEqual(dict(headers)["Cache-Control"], "no-store")
        upstream = next(record for record in self.backend_server.records if record[1] == "/api/settings?version=2")
        self.assertFalse(any(key in upstream[2] for key in ("If-None-Match", "If-Modified-Since", "Range")))
        _, headers, _ = self._get("/settings/Comfy.TutorialCompleted?version=2", cookie)
        self.assertEqual(dict(headers)["Cache-Control"], "no-store")

    def test_editor_settings_overlay_preserves_unknown_and_malformed_responses(self):
        for target, body, content_type in (("/settings", b"[]", "application/json"),
                                            ("/settings", b"not json", "application/json"),
                                            ("/settings", b"{}", "text/plain"),
                                            ("/object_info", b"{}", "application/json")):
            self.assertEqual(EditorProxy._editor_settings(target, body, content_type), (body, content_type))

    def test_settings_and_userdata_writes_are_scoped_to_proxy_session(self):
        cookie = self._bootstrap()
        for path in ("/userdata", "/userdata/", "/api/userdata", "/api/userdata/"):
            status, _, listing = self._get(path, cookie)
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

    def test_frontend_post_settings_merge_and_share_reads_with_legacy_put(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        cases = (("POST", "/api/settings", b'{"theme":"dark","custom":7}'),
                 ("POST", "/api/settings/theme", b'"light"'),
                 ("PUT", "/settings/custom", b'8'))
        for method, path, body in cases:
            status, _, _ = self._raw_request(method, path, cookie=cookie,
                                             headers={"Origin": self.origin,
                                                      "Content-Type": "application/json"}, body=body)
            self.assertEqual(status, 200, (method, path))
        for path in ("/settings", "/api/settings"):
            status, headers, body = self._get(path, cookie)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"Comfy.TutorialCompleted": True, "theme": "light",
                                               "plugin": {"enabled": False}, "custom": 8})
            self.assertEqual(dict(headers)["Cache-Control"], "no-store")
        self.assertEqual(json.loads(self._get("/api/settings/custom", cookie)[2]), 8)
        self.assertEqual(json.loads(self._get("/settings/theme", cookie)[2]), "light")
        self.assertFalse(any(method in {"POST", "PUT"}
                             for method, _, _ in self.backend_server.records[before:]))

    def test_frontend_post_encoded_userdata_round_trips_in_session_only(self):
        cookie = self._bootstrap()
        file = "workflows/nested/测试.json"
        encoded = urllib.parse.quote(file, safe="")
        body = b'{"nodes":[],"version":0.4}'
        before = len(self.backend_server.records)
        target = "/api/userdata/" + encoded + "?overwrite=true&full_info=false"
        status, _, _ = self._raw_request("POST", target, cookie=cookie,
                                         headers={"Origin": self.origin,
                                                  "Content-Type": "application/json"}, body=body)
        self.assertEqual(status, 200)
        for prefix in ("/api/userdata/", "/userdata/"):
            self.assertEqual(self._get(prefix + encoded, cookie)[::2], (200, body))
        status, _, _ = self._raw_request("PUT", "/userdata/" + encoded, cookie=cookie,
                                         headers={"Origin": self.origin}, body=b"legacy")
        self.assertEqual(status, 200)
        self.assertEqual(self._get("/api/userdata/" + encoded, cookie)[::2], (200, b"legacy"))
        self.assertEqual(len(self.backend_server.records), before)

    def test_frontend_post_still_requires_session_and_trusted_origin(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        for path in ("/api/settings", "/api/userdata/workflows%2Ftest.json"):
            for request_cookie, headers in ((None, {"Origin": self.origin}),
                                            (cookie, {}),
                                            (cookie, {"Origin": "http://evil.example"})):
                status, _, _ = self._raw_request("POST", path, cookie=request_cookie,
                                                 headers=headers, body=b"{}")
                self.assertEqual(status, 403)
        self.assertFalse(self.proxy._session_data)
        self.assertEqual(len(self.backend_server.records), before)

    def test_deep_media_subfolder_query_allows_single_encoded_slash(self):
        cookie = self._bootstrap()
        query = urllib.parse.urlencode({"filename": "frame.png", "subfolder": "a/b/c", "type": "input"})
        target = "/view?" + query
        before = len(self.backend_server.records)
        self.assertEqual(self._get(target, cookie)[::2], (200, b"image bytes"))
        self.assertEqual(self.backend_server.records[before][1], target)

    def test_encoded_paths_and_queries_cannot_escape_userdata_or_media(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        targets = ("/api/userdata/%2Fsettings", "/api/userdata/workflows%2F..%2Fsecret.json",
                   "/api/userdata/%252e%252e%252fsecret", "/api/userdata/x%255cy",
                   "/api/userdata/x%5Cy", "/api/userdata/C%3A%2Fsecret",
                   "/api/userdata/x%2F%2Fy", "/api/userdata/..%20%2Fsecret",
                   "/api/userdata/x%00.json", "/api/userdata/x%0A.json",
                   "/api/userdata/x%2520.json", "/api/userdata/x%23y",
                   "/api%2Fuserdata%2Fx", "/api/userdata%2Fx", "/api%2Fprompt",
                   "/assets/test.js%2F..%2Fsettings", "/assets/test%0A.js",
                   "/view?filename=frame.png&subfolder=a%2F..%2Fsecret",
                   "/view?filename=frame.png&subfolder=a%252Fb",
                   "/view?filename=frame.png&subfolder=a%5Cb",
                   "/view?filename=frame.png&subfolder=..%20%2Fsecret",
                   "/view?filename=%2Fsecret&subfolder=",
                   "/view?filename=frame.png&subfolder=C%3A%2Fsecret",
                   "/view?filename=frame.png&subfolder=a%0Ab")
        for target in targets:
            for method, body in (("GET", None), ("POST", b"{}")):
                status, _, _ = self._raw_request(method, target, cookie=cookie,
                                                 headers={"Origin": self.origin}, body=body)
                self.assertEqual(status, 400, (method, target))
        self.assertFalse(self.proxy._session_data)
        self.assertEqual(len(self.backend_server.records), before)

    def test_native_asset_hash_and_literal_percent_media_names(self):
        cookie = self._bootstrap()
        for filename in ("blake3:" + "a" * 64, "50%AB.png", "画面 50%.png"):
            for route in ("/view", "/api/view"):
                target = route + "?" + urllib.parse.urlencode({"filename": filename, "subfolder": "nested/images", "type": "input"})
                before = len(self.backend_server.records)
                status, _, _ = self._get(target, cookie)
                self.assertEqual(status, 200, filename)
                self.assertEqual(self.backend_server.records[before][1], target)
        before = len(self.backend_server.records)
        for filename in ("blake3:../secret", "blake3:" + "g" * 64, "C:/secret.png", "file:secret.png", "50%2fsecret.png", "x%250asecret.png"):
            target = "/view?" + urllib.parse.urlencode({"filename": filename})
            self.assertEqual(self._get(target, cookie)[0], 400, filename)
        self.assertEqual(len(self.backend_server.records), before)

    def test_encoded_view_alias_keeps_media_validation_and_generic_query_is_not_a_path(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        for route in ("/%76iew", "/api/%76iew"):
            for value in ("C:/secret.png", "/secret", "../secret", "a/../secret"):
                target = route + "?" + urllib.parse.urlencode({"filename": value})
                self.assertEqual(self._get(target, cookie)[0], 400, target)
        self.assertEqual(len(self.backend_server.records), before)
        self.assertEqual(self._get("/system_stats?display=.&label=50%25AB", cookie)[0], 200)

    def test_post_session_limits_and_invalid_settings_leave_data_unchanged(self):
        cookie = self._bootstrap()
        before = len(self.backend_server.records)
        for path, body in (("/api/settings", b"[]"), ("/api/settings/theme", b"bad json")):
            status, _, _ = self._raw_request("POST", path, cookie=cookie,
                                             headers={"Origin": self.origin}, body=body)
            self.assertEqual(status, 400)
        with patch("frameweave.editor_proxy.MAX_REQUEST_BYTES", 4):
            status, _, _ = self._raw_request("POST", "/api/userdata/x.json", cookie=cookie,
                                             headers={"Origin": self.origin}, body=b"12345")
            self.assertEqual(status, 413)
        with patch("frameweave.editor_proxy.MAX_SESSION_WRITE_BYTES", 4):
            status, _, _ = self._raw_request("POST", "/api/userdata/x.json", cookie=cookie,
                                             headers={"Origin": self.origin}, body=b"12345")
            self.assertEqual(status, 413)
        status, _, _ = self._raw_request("POST", "/api/userdata/x.json", cookie=cookie,
                                         headers={"Origin": self.origin, "Transfer-Encoding": "chunked"},
                                         body=b"{}")
        self.assertEqual(status, 413)
        self.assertFalse(self.proxy._session_data)
        self.assertEqual(self.proxy._session_data_bytes, 0)
        self.assertEqual(len(self.backend_server.records), before)

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

    def test_manager_component_loads_allows_only_empty_body_post(self):
        cookie = self._bootstrap()
        for path in ("/manager/component/loads", "/api/manager/component/loads"):
            before = len(self.backend_server.records)
            status, _, body = self._raw_request(
                "POST", path, cookie=cookie,
                headers={"Origin": self.origin}, body=b"")
            self.assertEqual(status, 200, path)
            self.assertEqual(json.loads(body), {"accepted": 0})
            self.assertEqual(len(self.backend_server.records), before + 1)
            method, forwarded_path, headers = self.backend_server.records[-1]
            self.assertEqual((method, forwarded_path), ("POST", path))
            self.assertEqual(headers.get("Content-Length", "0"), "0")

        denied = (
            ("POST", "/manager/component/loads?path=components.json", b"" , {}),
            ("POST", "/api/manager/component/loads?path=components.json", b"", {}),
            ("POST", "/manager/component/loads", b"{}", {}),
            ("POST", "/api/manager/component/loads", b"{}", {}),
            ("POST", "/manager/component/loads", None, {"Transfer-Encoding": "chunked"}),
            ("PUT", "/manager/component/loads", b"", {}),
            ("POST", "/manager/component/save", b"", {}),
        )
        forwarded = len(self.backend_server.records)
        for method, path, request_body, extra_headers in denied:
            status, _, _ = self._raw_request(
                method, path, cookie=cookie,
                headers={"Origin": self.origin, **extra_headers}, body=request_body)
            self.assertIn(status, {400, 403}, (method, path, status))
        self.assertEqual(len(self.backend_server.records), forwarded)

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
            chunk = client.recv(4096)
            self.assertTrue(chunk, "WebSocket closed before the upgrade response")
            response.extend(chunk)
        headers, remainder = response.split(b"\r\n\r\n", 1)
        self.assertIn(b"101 Switching Protocols", headers)
        received = bytearray(remainder)
        while len(received) < 4:
            chunk = client.recv(4 - len(received))
            self.assertTrue(chunk, "WebSocket closed before the first frame")
            received.extend(chunk)
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
