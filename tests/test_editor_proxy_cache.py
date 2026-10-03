"""Conditional/range requests must describe the proxy's actual representation."""

import http.client
import json
import socket
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from frameweave.editor_proxy import BRIDGE_PATH, EditorProxy


ETAG = '"upstream-version"'
MODIFIED = "Wed, 01 Oct 2025 00:00:00 GMT"
CONDITIONAL = {"If-None-Match": ETAG, "If-Modified-Since": MODIFIED,
               "Range": "bytes=0-3", "If-Range": ETAG}


class _CachingHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def do_GET(self):
        self._serve()

    def do_HEAD(self):
        self._serve()

    def _serve(self):
        self.server.records.append((self.command, self.path, dict(self.headers)))
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if path in {"/", "/index.html"}:
            body, content_type = b"<html><head></head><body>editor</body></html>", "text/html"
        elif path in {"/extensions", "/api/extensions"}:
            body, content_type = b'["/extensions/demo.js"]', "application/json"
        elif path in {"/settings", "/api/settings"}:
            body, content_type = b'{"Comfy.TutorialCompleted":false,"theme":"upstream"}', "application/json"
        elif path in {"/settings/theme", "/api/settings/theme"}:
            body, content_type = b'"upstream"', "application/json"
        elif path.startswith(("/userdata/", "/api/userdata/")):
            body, content_type = b'{"name":"upstream"}', "application/json"
        else:
            body, content_type = b"0123456789", "application/javascript"
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        status = int(query.get("status", ["200"])[0])
        if self.headers.get("If-None-Match") == ETAG or self.headers.get("If-Modified-Since") == MODIFIED:
            status = 304
        elif self.command == "GET" and self.headers.get("Range"):
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("ETag", ETAG)
        self.send_header("Last-Modified", MODIFIED)
        self.send_header("Cache-Control", "public, max-age=3600")
        self.send_header("Expires", "Wed, 01 Oct 2031 00:00:00 GMT")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-MD5", "upstream-checksum")
        self.send_header("Content-Digest", "sha-256=:upstream-checksum:")
        self.send_header("Repr-Digest", "sha-256=:upstream-checksum:")
        self.send_header("Digest", "sha-256=upstream-checksum")
        if status in {301, 302, 307, 308}:
            self.send_header("Location", "http://example.invalid/")
        if status == 206:
            self.send_header("Content-Range", f"bytes 0-3/{len(body)}")
            body = body[:4]
        if status == 304:
            # Metadata about a cached representation does not imply a wire body.
            self.send_header("Content-Encoding", "gzip")
        if "no_length" not in query:
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD" and status not in {204, 304}:
            self.wfile.write(body)


class EditorProxyCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = ThreadingHTTPServer(("127.0.0.1", 0), _CachingHandler)
        cls.backend.daemon_threads = True
        cls.backend.records = []
        cls.thread = threading.Thread(target=cls.backend.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.backend.shutdown()
        cls.backend.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.proxy = EditorProxy(f"http://127.0.0.1:{self.backend.server_port}",
                                 "http://127.0.0.1:9999", "bridge();")
        self.info = self.proxy.start()
        self.addCleanup(self.proxy.close)
        self.host = urllib.parse.urlsplit(self.info["origin"]).netloc
        parsed = urllib.parse.urlsplit(self.info["url"])
        status, headers, _ = self.request("GET", parsed.path + "?" + parsed.query)
        self.assertEqual(status, 200)
        self.cookie = headers["set-cookie"].split(";", 1)[0]

    def request(self, method, target, headers=None, body=None):
        conn = http.client.HTTPConnection(self.host, timeout=5)
        request_headers = {"Connection": "close", **(headers or {})}
        if hasattr(self, "cookie"):
            request_headers["Cookie"] = self.cookie
        conn.request(method, target, body=body, headers=request_headers)
        response = conn.getresponse()
        result = response.status, {name.lower(): value for name, value in response.getheaders()}, response.read()
        conn.close()
        return result

    def test_static_conditions_return_bodyless_304_with_validators(self):
        for method in ("GET", "HEAD"):
            for condition in ({"If-None-Match": ETAG}, {"If-Modified-Since": MODIFIED}):
                with self.subTest(method=method, condition=condition):
                    status, headers, body = self.request(method, "/assets/cache.js", condition)
                    self.assertEqual((status, body), (304, b""))
                    self.assertEqual(headers["etag"], ETAG)
                    self.assertEqual(headers["last-modified"], MODIFIED)
                    self.assertEqual(headers["cache-control"], "public, max-age=3600")
                    self.assertNotIn("content-length", headers)

    def test_static_head_preserves_representation_length_and_range_get(self):
        status, headers, body = self.request("HEAD", "/assets/cache.js")
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(headers["content-length"], "10")
        status, headers, body = self.request("HEAD", "/assets/cache.js",
                                             {"Range": "bytes=0-3", "If-Range": ETAG})
        self.assertEqual((status, body), (200, b""))
        self.assertEqual(headers["content-length"], "10")
        self.assertNotIn("Range", self.backend.records[-1][2])
        self.assertNotIn("If-Range", self.backend.records[-1][2])
        status, headers, body = self.request("GET", "/assets/cache.js",
                                             {"Range": "bytes=0-3", "If-Range": ETAG})
        self.assertEqual((status, body), (206, b"0123"))
        self.assertEqual(headers["content-range"], "bytes 0-3/10")
        self.assertEqual(self.backend.records[-1][2]["If-Range"], ETAG)
        _, headers, _ = self.request("HEAD", "/assets/cache.js?no_length=true")
        self.assertNotIn("content-length", headers)

    def test_transformed_routes_ignore_conditions_ranges_and_upstream_validators(self):
        paths = ("/", "/index.html", "/%69ndex.html", "/extensions", "/api/extensions",
                 "/%65xtensions", "/settings", "/api/settings", "/api/%73ettings",
                 "/settings/theme", "/api/settings/theme", "/userdata/file.json",
                 "/api/userdata/workflows%2Ffile.json")
        for path in paths:
            with self.subTest(path=path):
                status, headers, body = self.request("GET", path + "?version=2", CONDITIONAL)
                self.assertEqual(status, 200)
                self.assertEqual(headers["cache-control"], "no-store")
                for name in ("etag", "last-modified", "expires", "accept-ranges", "content-range",
                             "content-md5", "digest", "content-digest", "repr-digest"):
                    self.assertNotIn(name, headers)
                upstream = self.backend.records[-1][2]
                self.assertFalse(set(CONDITIONAL) & upstream.keys())
                canonical = urllib.parse.unquote(path)
                if canonical in {"/", "/index.html"}:
                    self.assertIn(self.info["bridgeNonce"].encode(), body)
                elif canonical in {"/extensions", "/api/extensions"}:
                    self.assertIn(BRIDGE_PATH, json.loads(body))
                elif canonical in {"/settings", "/api/settings"}:
                    self.assertTrue(json.loads(body)["Comfy.TutorialCompleted"])

    def test_transformed_head_matches_get_metadata_without_wire_body(self):
        for path in ("/index.html", "/extensions", "/api/settings"):
            with self.subTest(path=path):
                _, get_headers, get_body = self.request("GET", path)
                status, headers, body = self.request("HEAD", path, CONDITIONAL)
                self.assertEqual((status, body), (200, b""))
                self.assertEqual(headers["content-length"], str(len(get_body)))
                self.assertEqual(headers["content-type"], get_headers["content-type"])
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertEqual(self.backend.records[-1][0], "GET")

    def test_head_and_conditions_read_current_session_overlays(self):
        for path, saved in (("/api/settings/theme", b'"session"'),
                            ("/api/userdata/file.json", b'{"name":"session"}')):
            self.assertEqual(self.request("POST", path, {"Origin": self.info["origin"]}, saved)[0], 200)
            before = len(self.backend.records)
            status, headers, body = self.request("GET", path, CONDITIONAL)
            self.assertEqual((status, body), (200, saved))
            self.assertEqual(headers["cache-control"], "no-store")
            status, headers, body = self.request("HEAD", path, CONDITIONAL)
            self.assertEqual((status, body), (200, b""))
            self.assertEqual(headers["content-length"], str(len(saved)))
            self.assertEqual(headers["cache-control"], "no-store")
            self.assertEqual(len(self.backend.records), before)
        _, _, body = self.request("GET", "/api/settings", CONDITIONAL)
        self.assertEqual(json.loads(body)["theme"], "session")

    def test_same_upstream_validator_cannot_reuse_another_session_nonce(self):
        other = EditorProxy(self.proxy.backend_url, self.proxy.parent_origin, "other_bridge();")
        info = other.start()
        self.addCleanup(other.close)
        parsed = urllib.parse.urlsplit(info["url"])
        conn = http.client.HTTPConnection(urllib.parse.urlsplit(info["origin"]).netloc, timeout=5)
        conn.request("GET", parsed.path + "?" + parsed.query,
                     headers={"Connection": "close", **CONDITIONAL})
        response = conn.getresponse()
        body = response.read()
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        self.assertIsNone(response.getheader("ETag"))
        self.assertIn(info["bridgeNonce"].encode(), body)
        self.assertNotIn(self.info["bridgeNonce"].encode(), body)
        conn.close()
        status, _, own_body = self.request("GET", "/", CONDITIONAL)
        self.assertEqual(status, 200)
        self.assertIn(self.info["bridgeNonce"].encode(), own_body)
        self.assertNotIn(info["bridgeNonce"].encode(), own_body)

    def test_conditional_requests_still_require_cookie_host_origin_and_allowed_path(self):
        before = len(self.backend.records)
        for target, headers in (("/assets/cache.js", {"Cookie": "wrong=value"}),
                                ("/assets/cache.js", {"Host": "evil.invalid"}),
                                ("/assets/cache.js", {"Origin": "http://evil.invalid"}),
                                ("/not-allowed", {})):
            conn = http.client.HTTPConnection(self.host, timeout=5)
            conn.request("GET", target,
                         headers={"Cookie": self.cookie, "Connection": "close", **CONDITIONAL, **headers})
            response = conn.getresponse()
            self.assertEqual(response.status, 403)
            response.read()
            conn.close()
        self.assertEqual(len(self.backend.records), before)

    def test_transformed_head_still_enforces_upstream_size_limit(self):
        with patch("frameweave.editor_proxy.MAX_RESPONSE_BYTES", 4):
            status, _, body = self.request("HEAD", "/index.html")
            self.assertEqual((status, body), (502, b""))

    def test_error_pages_are_not_injected_and_local_lists_disable_caching(self):
        status, headers, body = self.request("GET", "/index.html?status=404", CONDITIONAL)
        self.assertEqual(status, 404)
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn(b"window.__PRISM_EDITOR__", body)
        for path in ("/userdata", "/userdata/", "/api/userdata", "/api/userdata/"):
            for method in ("GET", "HEAD"):
                before = len(self.backend.records)
                status, headers, body = self.request(method, path, CONDITIONAL)
                self.assertEqual((status, body), (200, b"[]" if method == "GET" else b""))
                self.assertEqual(headers["cache-control"], "no-store")
                self.assertEqual(headers["content-length"], "2")
                self.assertEqual(len(self.backend.records), before)

    def test_redirects_remain_denied_and_unsolicited_partial_session_responses_fail(self):
        for status in (301, 302, 303, 307, 308):
            self.assertEqual(self.request("GET", f"/assets/cache.js?status={status}")[0], 502)
        for status in (304, 206):
            self.assertEqual(self.request("GET", f"/index.html?status={status}")[0], 502)

    def test_empty_status_and_head_errors_never_send_wire_body(self):
        status, headers, body = self.request("GET", "/assets/cache.js?status=204")
        self.assertEqual((status, body), (204, b""))
        self.assertNotIn("content-length", headers)
        # http.client suppresses these bodies itself, so inspect actual bytes.
        for method, path, status in (("HEAD", "/not-allowed", 403),
                                     ("HEAD", "/index.html", 200),
                                     ("GET", "/assets/cache.js?status=304", 304),
                                     ("GET", "/assets/cache.js?status=204", 204)):
            with self.subTest(method=method, path=path):
                with socket.create_connection(("127.0.0.1", int(self.host.rsplit(":", 1)[1])), timeout=5) as client:
                    client.sendall((f"{method} {path} HTTP/1.1\r\nHost: {self.host}\r\n"
                                    f"Cookie: {self.cookie}\r\nConnection: close\r\n\r\n").encode())
                    response = bytearray()
                    while chunk := client.recv(4096):
                        response.extend(chunk)
                headers, body = response.split(b"\r\n\r\n", 1)
                self.assertIn(f" {status} ".encode(), headers.split(b"\r\n", 1)[0])
                self.assertEqual(body, b"")


if __name__ == "__main__":
    unittest.main()
