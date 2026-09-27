"""Offline local image assets and explicit backend-sync API tests."""

import base64
import hashlib
import json
import re
import stat
import unittest
import urllib.parse
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frameweave.backend import Backend, BackendError
from frameweave.local_assets import (LocalImageAssets, LocalMediaAssets, MAX_LOCAL_IMAGE_BYTES,
                                     MAX_LOCAL_VIDEO_BYTES)
import test_service as service_fixture


PNG = service_fixture.PNG


def mp4_bytes(payload=b"video-payload"):
    return (20).to_bytes(4, "big") + b"ftypisom" + b"\x00\x00\x02\x00" + b"mp42" + b"mdat" + payload


class LocalImageAssetHTTPTests(unittest.TestCase):
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post

    def import_image(self, data=PNG, name="canvas.png"):
        return self.post("/api/assets/images", {"name": name, "data": base64.b64encode(data).decode("ascii")})

    def post_media(self, data, name="reference.mp4", mime="video/mp4", *, csrf=True, content_length=None):
        path = "/api/assets/media?" + urllib.parse.urlencode({"name": name})
        headers = {"Content-Type": mime,
                   "Content-Length": str(len(data) if content_length is None else content_length)}
        return self.request("POST", path, raw=data, headers=headers, csrf=csrf)

    def upload_video(self, content=None, name="reference.mp4", mime="video/mp4"):
        content = mp4_bytes() if content is None else content
        status, headers, raw = self.post_media(content, name, mime)
        try:
            result = json.loads(raw)
        except ValueError:
            result = {}
        return status, headers, result

    def assert_no_generation(self):
        self.assertFalse(any(call[:2] == ("POST", "/prompt") for call in self.backend.calls))

    def test_offline_import_preview_and_restart_use_content_addressed_local_bytes(self):
        with patch.object(self.app.backend, "upload", side_effect=AssertionError("import must stay local")) as upload:
            status, _, asset = self.import_image(name=r"C:\fakepath\portrait.png")
            self.assertEqual(status, 200, asset)
            self.assertEqual(set(asset), {"asset_id", "url", "filename", "mime"})
            self.assertEqual(asset["asset_id"], hashlib.sha256(PNG).hexdigest())
            self.assertEqual(asset["url"], f"/api/assets/images/{asset['asset_id']}")
            self.assertEqual(asset["filename"], "portrait.png")
            self.assertEqual(asset["mime"], "image/png")
            status, headers, content = self.request("GET", asset["url"])
            self.assertEqual((status, content), (200, PNG))
            self.assertEqual(headers["Content-Type"], "image/png")
            upload.assert_not_called()

        stored = self.root / "data" / "local-assets-images" / asset["asset_id"]
        self.assertEqual(stored.read_bytes(), PNG)
        status, _, repeated = self.import_image(name="renamed.png")
        self.assertEqual(status, 200)
        self.assertEqual(repeated["asset_id"], asset["asset_id"])
        self.assertEqual(repeated["filename"], "renamed.png")
        self.assertEqual(list(stored.parent.iterdir()), [stored])

        self.stop_client()
        self.start_client()
        status, _, content = self.request("GET", asset["url"])
        self.assertEqual((status, content), (200, PNG))
        self.assert_no_generation()

    def test_webp_is_stored_and_served_with_sniffed_mime(self):
        webp = b"RIFF" + (12).to_bytes(4, "little") + b"WEBP" + b"VP8 " + b"1234"
        status, _, asset = self.import_image(webp, "frame.webp")
        self.assertEqual(status, 200, asset)
        self.assertEqual(asset["mime"], "image/webp")
        self.assertEqual(self.request("GET", asset["url"])[1]["Content-Type"], "image/webp")
        self.assertEqual(self.request("GET", asset["url"])[2], webp)

    def test_typed_video_upload_signature_mime_persistence_and_bounded_ranges(self):
        content = mp4_bytes()
        status, headers, asset = self.upload_video(content, r"C:\fakepath\scene.mp4")
        self.assertEqual(status, 200, asset)
        self.assertEqual(asset["media_type"], "video")
        self.assertEqual(asset["mime"], "video/mp4")
        self.assertEqual(asset["filename"], "scene.mp4")
        self.assertEqual(asset["url"], f"/api/assets/media/{asset['asset_id']}")
        self.assertFalse(self.backend.calls)
        stored = self.root / "data" / "local-assets-media" / asset["asset_id"]
        self.assertEqual(stored.read_bytes(), content)

        status, headers, body = self.request("GET", asset["url"], headers={"Range": "bytes=4-15"})
        self.assertEqual(status, 206)
        self.assertEqual(headers["Content-Type"], "video/mp4")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertEqual(headers["Content-Range"], f"bytes 4-15/{len(content)}")
        self.assertEqual(body, content[4:16])
        status, headers, body = self.request("GET", asset["url"], headers={"Range": "bytes=-5"})
        self.assertEqual((status, body), (206, content[-5:]))
        status, headers, body = self.request("GET", asset["url"], headers={"Range": "bytes=999-"})
        self.assertEqual((status, body), (416, b""))
        self.assertEqual(headers["Content-Range"], f"bytes */{len(content)}")

        self.stop_client()
        self.start_client()
        self.assertEqual(self.request("GET", asset["url"])[2], content)
        self.assertFalse(self.backend.calls)

    def test_mp4_webm_mov_and_image_media_mime_follow_signatures(self):
        webm = b"\x1a\x45\xdf\xa3\x87\x42\x82\x84webm" + b"\x18\x53\x80\x67payload"
        mov = (20).to_bytes(4, "big") + b"ftypqt  " + b"\x00\x00\x02\x00" + b"qt  " + b"mdatmovie"
        fixtures = ((mp4_bytes(), "video/mp4", "clip.mp4"),
                    (webm, "video/webm", "clip.webm"),
                    (mov, "video/quicktime", "clip.mov"),
                    (PNG, "image/png", "still.png"))
        for content, mime, name in fixtures:
            with self.subTest(mime=mime):
                status, _, asset = self.upload_video(content, name, mime)
                self.assertEqual(status, 200, asset)
                self.assertEqual(asset["mime"], mime)
                self.assertEqual(asset["media_type"], "image" if mime.startswith("image/") else "video")
                status, headers, returned = self.request("GET", asset["url"])
                self.assertEqual((status, headers["Content-Type"], returned), (200, mime, content))

    def test_typed_media_enforces_signature_content_type_csrf_and_per_type_size(self):
        for content, mime in ((b"not a video file", "video/mp4"), (mp4_bytes(), "video/webm"),
                              (PNG, "video/mp4"), (b"bad image", "image/png")):
            with self.subTest(mime=mime, content=content[:8]):
                status, _, _ = self.post_media(content, mime=mime)
                self.assertEqual(status, 400)
        self.assertEqual(self.post_media(mp4_bytes(), csrf=False)[0], 403)
        self.assertEqual(self.post_media(b"x" * 8, mime="application/octet-stream")[0], 415)
        status, _, _ = self.post_media(b"", content_length=MAX_LOCAL_VIDEO_BYTES + 1)
        self.assertEqual(status, 413)
        status, _, _ = self.post_media(b"", mime="image/png", content_length=MAX_LOCAL_IMAGE_BYTES + 1)
        self.assertEqual(status, 413)
        media_dir = self.root / "data" / "local-assets-media"
        self.assertTrue(not media_dir.exists() or list(media_dir.iterdir()) == [])

    def test_media_ranges_and_ids_do_not_escape_the_local_store(self):
        private = self.root / "outside.mov"
        private.write_bytes(mp4_bytes())
        for path in ("/api/assets/media/../outside.mov", "/api/assets/media/%2e%2e%2foutside.mov",
                     "/api/assets/media/" + "F" * 64,
                     "/api/assets/media/" + __import__("hashlib").sha256(mp4_bytes()).hexdigest()):
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(private.read_bytes(), mp4_bytes())

    def test_import_requires_csrf_exact_fields_and_complete_supported_image(self):
        encoded = base64.b64encode(PNG).decode("ascii")
        self.assertEqual(self.post("/api/assets/images", {"name": "x.png", "data": encoded}, csrf=False)[0], 403)
        self.assertEqual(self.post("/api/assets/images", {"name": "x.png", "data": encoded, "path": "ignored"})[0], 400)
        for name, data in (("", PNG), ("x.png", b"not image bytes"), ("x.png", PNG[:-8])):
            with self.subTest(name=name, size=len(data)):
                status, _, _ = self.import_image(data, name)
                self.assertEqual(status, 400)
        self.assertFalse((self.root / "data" / "local-assets-images").exists())

    def test_oversized_local_image_is_rejected_over_http(self):
        content = b"x" * (MAX_LOCAL_IMAGE_BYTES + 1)
        status, _, result = self.import_image(content)
        self.assertEqual(status, 400, result)
        self.assertFalse((self.root / "data" / "local-assets-images").exists())

    def test_unsafe_or_unknown_asset_ids_cannot_read_other_files(self):
        outside = self.root / "private.png"
        outside.write_bytes(PNG)
        unsafe_paths = [
            "/api/assets/images/../private.png",
            "/api/assets/images/%2e%2e%2fprivate.png",
            "/api/assets/images/" + "A" * 64,
            "/api/assets/images/" + hashlib.sha256(PNG).hexdigest(),
        ]
        for path in unsafe_paths:
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 404)
        self.assertEqual(outside.read_bytes(), PNG)

    def test_backend_sync_is_explicit_uses_current_backend_and_never_generates(self):
        status, _, asset = self.import_image()
        self.assertEqual(status, 200, asset)
        with patch.object(self.app.backend, "upload") as upload:
            missing = self.post(f"/api/assets/images/{'f' * 64}/backend-input", {})
            unsafe = self.post("/api/assets/images/../outside/backend-input", {})
            self.assertEqual(missing[0], 404)
            self.assertEqual(unsafe[0], 404)
            upload.assert_not_called()
        self.app.backend = Backend("http://127.0.0.1:8189")
        request_path = f"/api/assets/images/{asset['asset_id']}/backend-input"
        with patch.object(self.app.backend, "upload", return_value={"name": "local-image.png", "type": "input"}) as upload:
            self.assertEqual(self.post(request_path, {}, csrf=False)[0], 403)
            status, _, result = self.post(request_path, {"unexpected": True})
            self.assertEqual(status, 400, result)
            status, _, result = self.post(request_path, {})
            self.assertEqual(status, 200, result)
            self.assertEqual(result["name"], "local-image.png")
            self.assertEqual(result["backend"], "http://127.0.0.1:8189")
            self.assertEqual(result["asset_id"], asset["asset_id"])
            self.assertRegex(result["url"], r"^/api/media/[0-9a-f]{32}$")
            self.assertRegex(upload.call_args.args[0], r"^frameweave-[0-9a-f]{32}\.png$")
            self.assertEqual(upload.call_args.args[1:], (PNG, "image/png"))
            self.assertIn(result["name"], self.app.uploaded)
            self.assertEqual(self.app.media[result["url"].rsplit("/", 1)[-1]][0], "http://127.0.0.1:8189")
        self.assert_no_generation()

    def test_backend_sync_failure_keeps_local_preview_available(self):
        status, _, asset = self.import_image()
        self.assertEqual(status, 200, asset)
        with patch.object(self.app.backend, "upload", side_effect=BackendError("offline")):
            status, _, _ = self.post(f"/api/assets/images/{asset['asset_id']}/backend-input", {})
        self.assertEqual(status, 502)
        self.assertEqual(self.request("GET", asset["url"])[2], PNG)
        self.assert_no_generation()

    def test_raw_media_image_sync_accepts_empty_object_without_package_schema(self):
        status, _, raw = self.post_media(PNG, name="reference.png", mime="image/png")
        self.assertEqual(status, 200, raw)
        asset = json.loads(raw)
        self.assertEqual(asset["media_type"], "image")
        path = f"/api/assets/media/{asset['asset_id']}/backend-input"
        with (patch.object(self.app, "object_info", side_effect=AssertionError("image sync must not need package schema")) as schema,
              patch.object(self.app.backend, "upload", return_value={"name": "reference.png", "type": "input"}) as upload):
            status, _, result = self.post(path, {})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["asset_id"], asset["asset_id"])
        self.assertEqual(result["media_type"], "image")
        self.assertNotIn("package_id", result)
        self.assertNotIn("field_id", result)
        schema.assert_not_called()
        self.assertRegex(upload.call_args.args[0], r"^frameweave-[0-9a-f]{32}\.png$")
        self.assertEqual(upload.call_args.args[1:], (PNG, "image/png"))
        self.assert_no_generation()

    def test_video_sync_requires_current_package_field_schema_and_preserves_backend_name(self):
        status, _, asset = self.upload_video()
        self.assertEqual(status, 200, asset)
        package = self.app.packages.save({
            "name": "video source", "description": "",
            "prompt": {"7": {"class_type": "LoadVideo", "inputs": {"file": ""}}},
            "fields": [{"id": "clip", "node_id": "7", "input": "file", "type": "video",
                        "label": "Reference video", "default": ""}],
        })
        self.backend.info["LoadVideo"] = {"input": {"required": {"file": ["COMBO", {
            "options": [], "video_upload": True,
        }]}}, "output": ["VIDEO"]}
        self.app.info_at = 0
        path = f"/api/assets/media/{asset['asset_id']}/backend-input"
        request_body = {"package_id": package["id"], "field_id": "clip"}
        with patch.object(self.app.backend, "upload", return_value={
                "name": "server-renamed.mp4", "subfolder": "refs", "type": "input"}) as upload:
            status, _, result = self.post(path, request_body)
            self.assertEqual(status, 200, result)
            self.assertEqual(result["name"], "refs/server-renamed.mp4")
            self.assertEqual(result["asset_id"], asset["asset_id"])
            self.assertEqual(result["media_type"], "video")
            self.assertEqual(result["package_id"], package["id"])
            self.assertEqual(result["field_id"], "clip")
            self.assertEqual(result["backend"], self.backend.url)
            self.assertEqual(upload.call_args.args[1], mp4_bytes())
            self.assertEqual(upload.call_args.args[2], "video/mp4")
            self.assertRegex(upload.call_args.args[0], r"^prismcanvas-[0-9a-f]{32}\.mp4$")
            self.assertIn("refs/server-renamed.mp4", self.app.uploaded)
        self.assert_no_generation()

    def test_video_sync_rejects_wrong_field_unavailable_node_and_bad_upload_ack(self):
        status, _, asset = self.upload_video()
        self.assertEqual(status, 200, asset)
        package = self.app.packages.save({
            "name": "video source", "description": "",
            "prompt": {"7": {"class_type": "LoadVideo", "inputs": {"file": ""}}},
            "fields": [{"id": "clip", "node_id": "7", "input": "file", "type": "video",
                        "label": "Reference video", "default": ""}],
        })
        path = f"/api/assets/media/{asset['asset_id']}/backend-input"
        with patch.object(self.app.backend, "upload") as upload:
            self.assertEqual(self.post(path, {})[0], 400)
            self.assertEqual(self.post(path, {"package_id": package["id"], "field_id": "absent"})[0], 400)
            self.assertEqual(self.post(path, {"package_id": package["id"], "field_id": "clip"})[0], 400)
            self.backend.info["LoadVideo"] = {"input": {"required": {"file": ["COMBO", {"options": []}]}},
                                               "output": ["VIDEO"]}
            self.app.info_at = 0
            self.assertEqual(self.post(path, {"package_id": package["id"], "field_id": "clip"})[0], 400)
            upload.assert_not_called()

        self.backend.info["LoadVideo"] = {"input": {"required": {"file": ["COMBO", {"video_upload": True}]}},
                                           "output": ["VIDEO"]}
        self.app.info_at = 0
        with patch.object(self.app.backend, "upload", return_value={}) as upload:
            status, _, _ = self.post(path, {"package_id": package["id"], "field_id": "clip"})
        self.assertEqual(status, 502)
        self.assertEqual(self.app.media, {})
        self.assertEqual(self.app.uploaded, set())
        self.assertEqual(upload.call_count, 1)
        self.assert_no_generation()

    def test_all_image_upload_paths_reject_invalid_backend_acknowledgements(self):
        status, _, asset = self.import_image()
        self.assertEqual(status, 200, asset)
        invalid = ({}, [], {"name": "", "type": "input"}, {"name": "image.png", "type": "output"}, {"name": 1, "type": "input"})
        initial_media = dict(self.app.media)
        initial_uploaded = set(self.app.uploaded)
        for acknowledgement in invalid:
            with self.subTest(acknowledgement=acknowledgement), patch.object(self.app.backend, "upload", return_value=acknowledgement):
                legacy_status, _, _ = self.post("/api/upload", {"data": base64.b64encode(PNG).decode("ascii")})
                sync_status, _, _ = self.post(f"/api/assets/images/{asset['asset_id']}/backend-input", {})
                self.assertEqual(legacy_status, 502)
                self.assertEqual(sync_status, 502)
                self.assertEqual(self.app.media, initial_media)
                self.assertEqual(self.app.uploaded, initial_uploaded)
        with patch.object(self.app.backend, "upload", return_value={"name": "implicit-input.png"}):
            status, _, result = self.post("/api/upload", {"data": base64.b64encode(PNG).decode("ascii")})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["name"], "implicit-input.png")
        self.assert_no_generation()

    def test_store_rejects_symlink_directory_and_asset_files(self):
        data_dir = self.root / "symlink-root-data"
        data_dir.mkdir()
        outside = self.root / "outside-assets"
        outside.mkdir()
        directory_link = data_dir / "local-assets-images"
        try:
            directory_link.symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"此 Windows 环境不允许创建测试符号链接：{exc}")
        store = LocalImageAssets(data_dir)
        with self.assertRaises(ValueError):
            store.create("x.png", base64.b64encode(PNG).decode("ascii"))
        directory_link.unlink()

        asset = store.create("x.png", base64.b64encode(PNG).decode("ascii"))
        asset_path = store.root / asset["asset_id"]
        asset_path.unlink()
        target = self.root / "outside-image.png"
        target.write_bytes(PNG)
        try:
            asset_path.symlink_to(target)
        except OSError as exc:
            self.skipTest(f"此 Windows 环境不允许创建测试符号链接：{exc}")
        with self.assertRaises(ValueError):
            store.read(asset["asset_id"])

    def test_failed_temp_write_cleans_its_file_and_same_image_can_be_retried(self):
        data_dir = self.root / "retry-data"
        data_dir.mkdir()
        store = LocalImageAssets(data_dir)
        encoded = base64.b64encode(PNG).decode("ascii")
        with patch("frameweave.local_assets.os.fsync", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                store.create("retry.png", encoded)
        self.assertEqual(list(store.root.iterdir()), [])
        saved = store.create("retry.png", encoded)
        self.assertEqual(store.read(saved["asset_id"]), (PNG, "image/png"))
        self.assertEqual([path.name for path in store.root.iterdir()], [saved["asset_id"]])

    def test_store_checks_symlink_attributes_even_when_host_cannot_create_symlinks(self):
        data_dir = self.root / "mock-symlink-data"
        data_dir.mkdir()
        store = LocalImageAssets(data_dir)
        with patch("frameweave.local_assets._is_reparse_or_symlink", return_value=True):
            with self.assertRaises(ValueError):
                store.create("x.png", base64.b64encode(PNG).decode("ascii"))

        asset = store.create("x.png", base64.b64encode(PNG).decode("ascii"))
        asset_path = store.root / asset["asset_id"]
        original_lstat = Path.lstat

        def symlink_asset_lstat(path):
            if path == asset_path:
                return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
            return original_lstat(path)

        with patch.object(Path, "lstat", symlink_asset_lstat):
            with self.assertRaises(ValueError):
                store.read(asset["asset_id"])


if __name__ == "__main__":
    unittest.main()
