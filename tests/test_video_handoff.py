"""Owned video-result handoff tests using a local Comfy protocol mock."""

import hashlib
import json
import re
import threading
import unittest
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from frameweave.backend import Backend
from frameweave.server import output_identity
import test_service as service_fixture


def mp4_bytes(payload=b"video-payload"):
    return (20).to_bytes(4, "big") + b"ftypisom" + b"\x00\x00\x02\x00" + b"mp42" + b"mdat" + payload


def mov_bytes(payload=b"movie-payload"):
    return (20).to_bytes(4, "big") + b"ftypqt  " + b"\x00\x00\x02\x00" + b"qt  " + b"mdat" + payload


class VideoHandoffTests(unittest.TestCase):
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post

    def setUp(self):
        service_fixture.ServiceHTTPTests.setUp(self)
        self.view = {"status": 200, "headers": {}, "contents": {"result.mp4": mp4_bytes()}, "omit_length": False}
        self.view_gate = threading.Event()
        self.view_gate.set()
        self.view_started = threading.Event()
        original = self.backend.server.RequestHandlerClass
        state = self

        class MediaHandler(original):
            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path != "/view":
                    return super().do_GET()
                query = urllib.parse.parse_qs(parsed.query)
                state.backend.calls.append(("GET", "/view", query))
                filename = query.get("filename", [""])[0]
                content = state.view["contents"].get(filename)
                if content is None:
                    self.send_json({"error": "unknown media"}, 404)
                    return
                state.view_started.set()
                if not state.view_gate.wait(5):
                    self.send_json({"error": "view gate timeout"}, 504)
                    return
                headers = state.view["headers"]
                self.send_response(state.view["status"])
                self.send_header("Content-Type", state.view.get("mime", "video/mp4"))
                if not state.view["omit_length"] and "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(content)))
                for key, value in headers.items():
                    self.send_header(key, str(value))
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                try:
                    self.wfile.write(content)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.backend.server.RequestHandlerClass = MediaHandler
        self.backend.info = {"LoadVideo": {
            "input": {"required": {"file": ["COMBO", {"options": [], "video_upload": True}]}},
            "output": ["VIDEO"],
        }}
        self.app.info = {}
        self.job_id = "owned-video-job"
        self.package = self.make_package()
        self.set_outputs([("result.mp4", "video")])
        self.addCleanup(self.view_gate.set)

    def make_package(self, *, fields=None, prompt=None):
        return self.app.packages.save({
            "name": "video input fixture", "description": "",
            "prompt": prompt or {"7": {"class_type": "LoadVideo", "inputs": {"file": ""}}},
            "fields": fields or [{"id": "clip", "node_id": "7", "input": "file", "type": "video",
                                  "label": "Reference video", "default": ""}],
        })

    def output(self, filename, kind="video", subfolder="results"):
        return {"type": kind, "filename": filename, "subfolder": subfolder,
                "url": self.app.register_media(filename, subfolder, "output")}

    def set_outputs(self, entries):
        self.job = {"id": self.job_id, "status": "completed", "kind": "api", "backend": self.backend.url,
                    "created_at": 1, "outputs": [self.output(filename, kind) for filename, kind in entries]}
        self.app.jobs[self.job_id] = self.job

    def handoff(self, data=None, job_id=None, **kwargs):
        body = {"output_index": 0, "package_id": self.package["id"], "field_id": "clip"} if data is None else data
        return self.post(f"/api/jobs/{job_id or self.job_id}/media-input", body, **kwargs)

    def uploads(self):
        return [call for call in self.backend.calls if call[:2] == ("POST", "/upload/image")]

    def views(self):
        return [call for call in self.backend.calls if call[:2] == ("GET", "/view")]

    def assert_no_generation(self):
        self.assertFalse(any(call[:2] == ("POST", "/prompt") for call in self.backend.calls))

    def test_owned_video_output_is_cached_locally_and_bound_to_the_selected_video_field(self):
        content = mp4_bytes()
        status, _, result = self.handoff()
        self.assertEqual(status, 200, result)
        self.assertEqual(result["backend"], self.backend.url)
        self.assertEqual(result["media_type"], "video")
        self.assertEqual(result["package_id"], self.package["id"])
        self.assertEqual(result["field_id"], "clip")
        self.assertEqual(result["source_job"], self.job_id)
        self.assertEqual(result["output_index"], 0)
        self.assertRegex(result["name"], r"^prismcanvas-[0-9a-f]{32}\.mp4$")
        self.assertRegex(result["url"], r"^/api/media/[0-9a-f]{32}$")
        asset_id = hashlib.sha256(content).hexdigest()
        self.assertEqual(result["asset_id"], asset_id)
        local_path = self.root / "data" / "local-assets-media" / asset_id
        self.assertEqual(local_path.read_bytes(), content)
        self.assertEqual(self.request("GET", f"/api/assets/media/{asset_id}")[2], content)
        self.assertEqual(self.views()[0][2], {"filename": ["result.mp4"], "subfolder": ["results"], "type": ["output"]})
        self.assertEqual(self.app.media[result["url"].rsplit("/", 1)[-1]][1]["type"], "input")
        upload = self.uploads()[0]
        self.assertIn(content, upload[2])
        self.assertIn(b"Content-Type: video/mp4", upload[2])
        self.assertIn(result["name"].encode("ascii"), upload[2])
        self.assert_no_generation()

    def test_mixed_output_index_is_relative_to_video_outputs(self):
        video_b = mp4_bytes(b"second-video")
        self.view["contents"]["video-b.mp4"] = video_b
        self.set_outputs([("image-a.png", "image"), ("video-b.mp4", "video")])
        status, _, result = self.handoff({"output_index": 0, "package_id": self.package["id"], "field_id": "clip"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.views()[0][2]["filename"], ["video-b.mp4"])
        self.assertEqual(result["asset_id"], hashlib.sha256(video_b).hexdigest())
        self.assertIn(video_b, self.uploads()[0][2])
        self.assert_no_generation()

    def test_video_identity_selects_original_file_after_reorder_and_retains_legacy_default(self):
        self.set_outputs([("other.mp4", "video"), ("result.mp4", "video")])
        chosen = self.job["outputs"][1]
        chosen["node_id"] = "video-sink"
        identity = output_identity(self.job_id, chosen)
        self.job["outputs"].reverse()
        status, _, result = self.handoff({"output_index": 1, "output_id": identity,
                                         "package_id": self.package["id"], "field_id": "clip"})
        self.assertEqual(status, 200, result)
        self.assertEqual(result["output_id"], identity)
        self.assertEqual(result["media_type"], "video")
        self.assertEqual(self.views()[0][2]["filename"], ["result.mp4"])
        self.assert_no_generation()

    def test_repeated_handoff_reuses_local_output_and_backend_upload(self):
        self.package = self.make_package(
            prompt={"7": {"class_type": "LoadVideo", "inputs": {"file": ""}},
                    "8": {"class_type": "LoadVideo", "inputs": {"file": ""}}},
            fields=[{"id": "clip", "node_id": "7", "input": "file", "type": "video",
                     "label": "Reference video A", "default": ""},
                    {"id": "clip2", "node_id": "8", "input": "file", "type": "video",
                     "label": "Reference video B", "default": ""}],
        )
        first_status, _, first = self.handoff()
        second_status, _, second = self.handoff(
            {"output_index": 0, "package_id": self.package["id"], "field_id": "clip2"})
        self.assertEqual((first_status, second_status), (200, 200))
        self.assertEqual(first["asset_id"], second["asset_id"])
        self.assertEqual(first["name"], second["name"])
        self.assertEqual((first["field_id"], second["field_id"]), ("clip", "clip2"))
        self.assertEqual(len(self.views()), 1)
        self.assertEqual(len(self.uploads()), 1)
        self.assert_no_generation()

    def test_package_and_live_video_schema_are_validated_before_fetch(self):
        invalid_package = self.make_package(fields=[{"id": "other", "node_id": "7", "input": "file",
                                                     "type": "video", "label": "Reference video", "default": ""}])
        status, _, _ = self.handoff({"output_index": 0, "package_id": invalid_package["id"], "field_id": "clip"})
        self.assertEqual(status, 400)
        self.backend.info["LoadVideo"]["input"]["required"]["file"][1].pop("video_upload")
        self.app.info_at = 0
        status, _, _ = self.handoff()
        self.assertEqual(status, 400)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_only_owned_completed_results_on_original_backend_can_be_fetched(self):
        for status in ("queued", "running", "failed", "cancelled"):
            self.job["status"] = status
            self.assertEqual(self.handoff()[0], 400)
        self.job["status"] = "completed"
        self.app.jobs.pop(self.job_id)
        self.assertEqual(self.handoff()[0], 400)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])
        self.app.jobs[self.job_id] = self.job
        self.app.save_settings({"backend_url": "http://127.0.0.1:1", "model_roots": []})
        self.assertEqual(self.handoff()[0], 400)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_output_indices_fields_and_unregistered_media_are_strict(self):
        bad_bodies = (
            {}, {"output_index": True, "package_id": self.package["id"], "field_id": "clip"},
            {"output_index": 0.0, "package_id": self.package["id"], "field_id": "clip"},
            {"output_index": -1, "package_id": self.package["id"], "field_id": "clip"},
            {"output_index": 1, "package_id": self.package["id"], "field_id": "clip"},
            {"output_index": 0, "package_id": self.package["id"], "field_id": "clip", "url": "http://127.0.0.1/private"},
            {"output_index": 0, "package_id": self.package["id"], "field_id": ""},
        )
        for body in bad_bodies:
            with self.subTest(body=body):
                self.assertEqual(self.handoff(body)[0], 400)
        original_url = self.job["outputs"][0]["url"]
        self.job["outputs"][0]["url"] = "/api/media/" + "0" * 32
        self.assertEqual(self.handoff()[0], 400)
        self.job["outputs"][0]["url"] = original_url
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_video_media_registration_must_match_output_name_folder_and_kind(self):
        output = self.job["outputs"][0]
        original = output["url"]
        replacements = (
            self.app.register_media("other.mp4", "results", "output"),
            self.app.register_media("result.mp4", "other-folder", "output"),
            self.app.register_media("result.mp4", "results", "input"),
        )
        for url in replacements:
            with self.subTest(url=url):
                output["url"] = url
                self.assertEqual(self.handoff()[0], 400)
        output["url"] = original
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_media_download_rejects_redirect_partial_encoding_and_bad_signature(self):
        variants = [
            ({"status": 302, "headers": {"Location": "http://example.invalid/private.mp4"}}, mp4_bytes()),
            ({"status": 200, "headers": {"Content-Range": "bytes 0-10/99"}}, mp4_bytes()),
            ({"status": 200, "headers": {"Content-Encoding": "gzip"}}, mp4_bytes()),
            ({"status": 200, "headers": {}}, b"not a video file"),
        ]
        for settings, content in variants:
            with self.subTest(settings=settings):
                self.view.update(settings)
                self.view["contents"]["result.mp4"] = content
                status, _, _ = self.handoff()
                self.assertEqual(status, 502)
                self.assertEqual(self.uploads(), [])
                self.view.update(status=200, headers={})
                self.view["contents"]["result.mp4"] = mp4_bytes()

    def test_video_download_size_is_bounded_with_and_without_content_length(self):
        over = mp4_bytes(b"x")
        self.view["contents"]["result.mp4"] = over
        with patch("frameweave.server.MAX_LOCAL_VIDEO_BYTES", len(over) - 1):
            self.view["headers"] = {"Content-Length": str(len(over))}
            self.assertEqual(self.handoff()[0], 502)
            self.view["headers"] = {}
            self.view["omit_length"] = True
            self.assertEqual(self.handoff()[0], 502)
        self.assertEqual(self.uploads(), [])
        self.assertEqual(self.app.video_output_assets, {})
        self.view["omit_length"] = False

    def test_media_route_requires_csrf_and_never_generates(self):
        self.assertEqual(self.handoff(csrf=False)[0], 403)
        self.assertEqual(self.handoff(headers={"Origin": "http://example.invalid"})[0], 403)
        self.assertEqual(self.request("GET", f"/api/jobs/{self.job_id}/media-input")[0], 404)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])
        self.assert_no_generation()

    def test_mov_history_output_is_classified_as_video_and_can_be_handed_off(self):
        content = mov_bytes()
        self.view["contents"]["result.mov"] = content
        self.view["mime"] = "video/quicktime"
        self.job["status"] = "running"
        self.job["outputs"] = []  # Replace the unrelated completed-MP4 fixture with a fresh run.
        self.backend.history[self.job_id] = {
            "status": {"status_str": "success", "completed": True},
            "outputs": {"9": {"videos": [{"filename": "result.mov", "subfolder": "results", "type": "output"}]}}
        }

        self.app.update_jobs()

        self.assertEqual(self.job["status"], "completed")
        self.assertEqual([item["type"] for item in self.job["outputs"]], ["video"])
        status, _, result = self.handoff()
        self.assertEqual(status, 200, result)
        self.assertTrue(result["name"].endswith(".mov"))
        self.assertEqual(result["asset_id"], hashlib.sha256(content).hexdigest())
        self.assertIn(b"Content-Type: video/quicktime", self.uploads()[0][2])
        self.assert_no_generation()

    def test_blocked_video_download_does_not_block_jobs_or_backend_switch(self):
        self.view_gate.clear()
        with ThreadPoolExecutor(max_workers=3) as pool:
            handoff = pool.submit(self.handoff)
            try:
                self.assertTrue(self.view_started.wait(2), "video request did not reach the blocked backend view")
                listed = pool.submit(self.request, "GET", "/api/jobs")
                self.assertEqual(listed.result(timeout=1)[0], 200)
                cancelled = pool.submit(self.post, f"/api/jobs/{self.job_id}/cancel")
                self.assertEqual(cancelled.result(timeout=1)[0], 200)
                switched = pool.submit(self.app.save_settings,
                                       {"backend_url": "http://127.0.0.1:1", "model_roots": []})
                switched.result(timeout=1)
            finally:
                self.view_gate.set()
            status, _, _ = handoff.result(timeout=5)

        self.assertEqual(status, 400)
        self.assertEqual(len(self.views()), 1)
        self.assertEqual(self.uploads(), [], "a stale transfer must never upload to the newly selected backend")

    def test_blocked_video_upload_does_not_hold_global_job_lock(self):
        upload_started = threading.Event()
        upload_gate = threading.Event()
        original_upload = Backend.upload

        def blocked_upload(backend, name, content, mime):
            upload_started.set()
            if not upload_gate.wait(5):
                raise TimeoutError("test upload gate timed out")
            return original_upload(backend, name, content, mime)

        with patch.object(Backend, "upload", blocked_upload):
            with ThreadPoolExecutor(max_workers=3) as pool:
                handoff = pool.submit(self.handoff)
                try:
                    self.assertTrue(upload_started.wait(2), "video request did not reach the blocked upload")
                    listed = pool.submit(self.request, "GET", "/api/jobs")
                    self.assertEqual(listed.result(timeout=1)[0], 200)
                    cancelled = pool.submit(self.post, f"/api/jobs/{self.job_id}/cancel")
                    self.assertEqual(cancelled.result(timeout=1)[0], 200)
                finally:
                    upload_gate.set()
                status, _, result = handoff.result(timeout=5)

        self.assertEqual(status, 200, result)
        self.assertEqual(len(self.uploads()), 1)
        self.assert_no_generation()

    def test_concurrent_handoffs_share_one_job_download_and_asset_upload(self):
        self.view_gate.clear()
        entered = threading.Event()
        entered_guard = threading.Lock()
        entered_count = 0
        original_media_input = self.app.media_input

        def tracked_media_input(job_id, data):
            nonlocal entered_count
            with entered_guard:
                entered_count += 1
                if entered_count == 2:
                    entered.set()
            return original_media_input(job_id, data)

        with patch.object(self.app, "media_input", tracked_media_input):
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(self.handoff)
                try:
                    self.assertTrue(self.view_started.wait(2), "first request did not reach the blocked backend view")
                    second = pool.submit(self.handoff)
                    self.assertTrue(entered.wait(2), "second request did not enter the transfer path")
                finally:
                    self.view_gate.set()
                first_result = first.result(timeout=5)
                second_result = second.result(timeout=5)

        self.assertEqual((first_result[0], second_result[0]), (200, 200))
        self.assertEqual(first_result[2]["asset_id"], second_result[2]["asset_id"])
        self.assertEqual(len(self.views()), 1)
        self.assertEqual(len(self.uploads()), 1)
        self.assert_no_generation()

    def test_backend_switch_during_upload_keeps_transfer_bound_to_source_backend(self):
        upload_started = threading.Event()
        upload_gate = threading.Event()
        original_upload = Backend.upload

        def blocked_upload(backend, name, content, mime):
            upload_started.set()
            if not upload_gate.wait(5):
                raise TimeoutError("test upload gate timed out")
            return original_upload(backend, name, content, mime)

        with patch.object(Backend, "upload", blocked_upload):
            with ThreadPoolExecutor(max_workers=1) as pool:
                handoff = pool.submit(self.handoff)
                try:
                    self.assertTrue(upload_started.wait(2), "video request did not reach the blocked upload")
                    self.app.save_settings({"backend_url": "http://127.0.0.1:1", "model_roots": []})
                finally:
                    upload_gate.set()
                status, _, _ = handoff.result(timeout=5)

        self.assertEqual(status, 400)
        self.assertEqual(len(self.uploads()), 1, "the transfer must remain pinned to its captured source backend")
        self.assertFalse(any(call[:2] == ("POST", "/prompt") for call in self.backend.calls))

