"""Opt-in summary transport is separate from authoritative detail/compile."""
import json
import hashlib
import os
import unittest
from unittest.mock import patch

import test_editor_integration as native_tests
from test_packages import sample


class PackageSummaryHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def test_legacy_get_detail_and_opt_in_query_shapes_remain_separate(self):
        saved = self.app.packages.save(sample())
        for path in ("/api/packages", "/api/packages?summary=0", "/api/packages?old-query=anything"):
            status, _, payload = self.request("GET", path)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload), {"packages": self.app.packages.list()})
        with patch("frameweave.packages.normalize_fields", side_effect=AssertionError("full hydrate")):
            for path in ("/api/packages?summary=1", "/api/packages?summary=1&refresh=1"):
                status, _, payload = self.request("GET", path)
                self.assertEqual(status, 200, payload)
                body = json.loads(payload)
                self.assertTrue(body["summary"])
                self.assertEqual(body["packages"][0]["field_count"], 2)
                self.assertNotIn("fields", body["packages"][0])
                self.assertNotIn("prompt", body["packages"][0])
        status, _, payload = self.request("GET", "/api/packages/" + saved["id"])
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(payload), {"package": saved})
        for query in ("summary=2", "summary=1&summary=1", "refresh=1", "summary=1&refresh=", "summary=true"):
            status, _, payload = self.request("GET", "/api/packages?" + query)
            self.assertEqual(status, 400, payload)
        self.assertEqual(self.backend.next_id, 0)

    def test_stale_summary_cannot_authorize_detail_or_compile_and_force_clears_it(self):
        saved = self.app.packages.save({**sample(), "name": "ModelAlpha"})
        path = self.app.packages.directory / (saved["id"] + ".json")
        with patch.object(self.app.packages, "_summary_identity", side_effect=lambda info: (info.st_size, info.st_mtime_ns)):
            self.request("GET", "/api/packages?summary=1")
            info, raw = path.stat(), path.read_bytes()
            path.write_bytes(raw.replace(b"ModelAlpha", b"ModelBravo"))
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
            status, _, payload = self.request("GET", "/api/packages?summary=1")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload)["packages"][0]["name"], "ModelAlpha")
            status, _, payload = self.request("GET", "/api/packages/" + saved["id"])
            self.assertEqual(status, 400)
            self.assertIn("变化", json.loads(payload)["error"])
            status, _, payload = self.post("/api/compile", {"kind": "package", "package_id": saved["id"], "values": {}})
            self.assertEqual(status, 400)
            self.assertIn("变化", payload["error"])
            status, _, payload = self.request("GET", "/api/packages?summary=1&refresh=1")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload), {"summary": True, "packages": []})
        self.assertEqual(self.backend.next_id, 0)

    def test_one_escaped_surrogate_row_does_not_break_valid_summary_response(self):
        saved = self.app.packages.save(sample())
        for key in ("name", "description"):
            document = self.app.packages.export(saved["id"])
            document[key] = "\ud800"
            raw = json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode()
            ident = "p-" + hashlib.sha256(raw).hexdigest()[:24]
            (self.app.packages.directory / (ident + ".json")).write_bytes(raw)
        status, _, payload = self.request("GET", "/api/packages?summary=1")
        self.assertEqual(status, 200, payload)
        self.assertEqual([row["id"] for row in json.loads(payload)["packages"]], [saved["id"]])
        self.assertEqual(self.backend.next_id, 0)


if __name__ == "__main__":
    unittest.main()
