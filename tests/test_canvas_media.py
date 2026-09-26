"""Owned result-to-input transfers against a local mock; never submits inference."""

import copy
import json
import re
import threading
import time
import unittest
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from frameweave.backend import BackendError
from frameweave.server import App, MAX_IMAGE_BYTES
from frameweave.workflows import compile_workflow
import test_service as service_fixture
from test_workflows import fixture


PNG = service_fixture.PNG


class CanvasMediaTests(unittest.TestCase):
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post

    def setUp(self):
        service_fixture.ServiceHTTPTests.setUp(self)
        self.backend.info = fixture()
        self.app.info = {}
        self.view = {"content": PNG, "status": 200, "headers": {}, "omit_length": False}
        self.view_gate, self.view_started = threading.Event(), threading.Event()
        self.view_gate.set()
        self.addCleanup(self.view_gate.set)
        original = self.backend.server.RequestHandlerClass
        state = self

        class MediaHandler(original):
            def do_GET(self):
                parsed = urllib.parse.urlsplit(self.path)
                if parsed.path != "/view":
                    return super().do_GET()
                state.backend.calls.append(("GET", "/view", urllib.parse.parse_qs(parsed.query)))
                state.view_started.set()
                state.view_gate.wait(3)
                self.send_response(state.view["status"])
                headers = state.view["headers"]
                self.send_header("Content-Type", "image/png")
                if not state.view["omit_length"] and "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(state.view["content"])))
                for key, value in headers.items():
                    self.send_header(key, str(value))
                self.send_header("Connection", "close")
                self.close_connection = True
                self.end_headers()
                try:
                    self.wfile.write(state.view["content"])
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

            def do_POST(self):
                super().do_POST()
                if urllib.parse.urlsplit(self.path).path == "/upload/image":
                    body = next(call[2] for call in reversed(state.backend.calls) if call[:2] == ("POST", "/upload/image"))
                    name = re.search(br'filename="([^"]+)"', body)[1].decode("ascii")
                    state.backend.info["LoadImage"]["input"]["required"]["image"][0].append(name)

        self.backend.server.RequestHandlerClass = MediaHandler
        self.job = {"id": "owned-image-job", "status": "completed", "kind": "sdxl", "backend": self.backend.url,
                    "created_at": 1, "outputs": [self.output("result.png")]}
        self.app.jobs[self.job["id"]] = self.job

    def output(self, filename, kind="image"):
        return {"type": kind, "filename": filename, "subfolder": "canvas-results",
                "url": self.app.register_media(filename, "canvas-results", "output")}

    def transfer(self, data=None, job_id=None, **kwargs):
        return self.post(f"/api/jobs/{job_id or self.job['id']}/image-input",
                         {"output_index": 0} if data is None else data, **kwargs)

    def uploads(self):
        return [call for call in self.backend.calls if call[:2] == ("POST", "/upload/image")]

    def assert_no_generation(self):
        self.assertFalse(any(call[:2] == ("POST", "/prompt") for call in self.backend.calls))

    def test_completed_owned_png_is_copied_without_mutating_source(self):
        old = copy.deepcopy(self.job)
        status, _, result = self.transfer()
        self.assertEqual(status, 200, result)
        self.assertTrue(result["name"].endswith(".png"))
        self.assertRegex(result["url"], r"^/api/media/[0-9a-f]{32}$")
        self.assertEqual(result["backend"], self.backend.url)
        self.assertEqual(result["source_job"], self.job["id"])
        self.assertEqual(result["output_index"], 0)
        self.assertIn(result["name"], self.app.uploaded)
        self.assertEqual(self.app.media[result["url"].rsplit("/", 1)[-1]][1]["type"], "input")
        self.assertEqual(self.job, old)
        self.assertIn(PNG, self.uploads()[0][2])
        self.assert_no_generation()

    def test_repeated_transfer_is_upload_only_and_uses_new_nonoverwriting_names(self):
        first, second = self.transfer()[2], self.transfer()[2]
        self.assertNotEqual(first["name"], second["name"])
        self.assertEqual(len(self.uploads()), 2)
        self.assertTrue(all(b"name=\"overwrite\"\r\n\r\nfalse" in call[2] for call in self.uploads()))
        self.assert_no_generation()

    def test_index_is_relative_to_image_outputs_and_skips_video(self):
        self.job["outputs"] = [self.output("movie.mp4", "video"), self.output("first.png"), self.output("second.png")]
        status, _, result = self.transfer({"output_index": 1})
        self.assertEqual(status, 200, result)
        view_call = next(call for call in self.backend.calls if call[:2] == ("GET", "/view"))
        self.assertEqual(view_call[2]["filename"], ["second.png"])
        self.assertEqual(result["output_index"], 1)
        self.assert_no_generation()

    def test_unknown_and_other_client_jobs_cannot_be_reused(self):
        self.assertEqual(self.transfer(job_id="foreign-job")[0], 400)
        other = App(self.root / "other-client", self.web, self.backend.url)
        with self.assertRaisesRegex(ValueError, "不属于"):
            other.image_input(self.job["id"], {"output_index": 0})
        self.assertEqual(self.uploads(), [])
        self.assert_no_generation()

    def test_failed_pending_and_cancelled_jobs_are_rejected(self):
        for status in ("queued", "running", "failed", "cancelled", "unknown"):
            with self.subTest(status=status):
                self.job["status"] = status
                self.assertEqual(self.transfer()[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_wrong_output_kind_and_unsupported_image_formats_are_rejected(self):
        for filename, kind in (("result.mp4", "video"), ("sound.wav", "audio"), ("motion.gif", "image"), ("vector.svg", "image")):
            with self.subTest(filename=filename):
                self.job["outputs"] = [self.output(filename, kind)]
                self.assertEqual(self.transfer()[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_index_must_be_an_in_range_integer_and_no_arbitrary_source_fields(self):
        for body in ({}, {"output_index": True}, {"output_index": "0"}, {"output_index": 0.0},
                     {"output_index": -1}, {"output_index": 1}, {"output_index": 0, "url": "http://127.0.0.1/private"},
                     {"output_index": 0, "path": "C:/private.png"}):
            with self.subTest(body=body):
                self.assertEqual(self.transfer(body)[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_changed_backend_cannot_reuse_original_media(self):
        self.app.save_settings({"backend_url": "http://127.0.0.1:1", "model_roots": []})
        self.assertEqual(self.transfer()[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_media_must_be_registered_to_the_matching_job_output(self):
        output = self.job["outputs"][0]
        original_url = output["url"]
        for url in ("http://127.0.0.1/view?filename=result.png", "/api/media/" + "0" * 32,
                    self.app.register_media("other.png", "canvas-results", "output"),
                    self.app.register_media("result.png", "canvas-results", "input")):
            with self.subTest(url=url):
                output["url"] = url
                self.assertEqual(self.transfer()[0], 400)
        output["url"] = original_url
        self.assertEqual(self.backend.calls, [])

    def test_image_magic_and_complete_file_boundary_are_required(self):
        for content in (b"<svg>not a raster</svg>", b"\x89PNG\r\n\x1a\ntruncated image", b"\xff\xd8\xffnot-complete",
                        b"RIFF\x30\x00\x00\x00WEBPshort-data"):
            with self.subTest(content=content):
                self.view["content"] = content
                self.assertEqual(self.transfer()[0], 400)
        self.assertEqual(self.uploads(), [])
        self.assert_no_generation()

    def test_jpeg_and_webp_magic_choose_correct_upload_extension(self):
        # Signature/boundary fixtures test transport validation, not pixel decoding.
        for filename, content, extension in (("result.jpeg", b"\xff\xd8\xff\xe0\x00\x02\xff\xd9", ".jpg"),
                ("result.webp", b"RIFF\x0c\x00\x00\x00WEBPVP8 \x00\x00\x00\x00", ".webp")):
            with self.subTest(filename=filename):
                self.job["outputs"] = [self.output(filename)]
                self.view["content"] = content
                status, _, result = self.transfer()
                self.assertEqual(status, 200, result)
                self.assertTrue(result["name"].endswith(extension))
        self.assert_no_generation()

    def test_oversized_declared_or_streamed_response_is_rejected_before_upload(self):
        self.assertEqual(MAX_IMAGE_BYTES, 20 * 1024 * 1024)
        self.view["headers"] = {"Content-Length": str(MAX_IMAGE_BYTES + 1)}
        self.assertEqual(self.transfer()[0], 502)
        self.view["headers"] = {}
        self.view["omit_length"] = True
        self.view["content"] = b"x" * (MAX_IMAGE_BYTES + 1)
        self.assertEqual(self.transfer()[0], 502)
        self.assertEqual(self.uploads(), [])

    def test_truncated_or_partial_and_encoded_responses_do_not_upload(self):
        variants = [({"Content-Length": str(len(PNG) + 8)}, 200), ({"Content-Range": "bytes 0-67/68"}, 206),
                    ({"Content-Encoding": "gzip"}, 200), ({"Content-Length": "bad"}, 200)]
        for headers, status in variants:
            with self.subTest(headers=headers):
                self.view.update(headers=headers, status=status)
                self.assertEqual(self.transfer()[0], 502)
        self.assertEqual(self.uploads(), [])

    def test_missing_media_and_redirects_cannot_upload_or_fetch_arbitrary_urls(self):
        for status, headers in ((404, {}), (302, {"Location": "http://example.invalid/private.png"})):
            with self.subTest(status=status):
                self.view.update(status=status, headers=headers)
                self.assertEqual(self.transfer()[0], 502)
        self.assertEqual(self.uploads(), [])
        self.assert_no_generation()

    def test_invalid_upload_acknowledgement_is_not_claimed_as_a_reusable_input(self):
        for response in ([], {}, {"name": "result.png", "type": "output"}):
            with self.subTest(response=response), patch.object(self.app.backend, "upload", return_value=response):
                status, _, failure = self.transfer()
                self.assertEqual(status, 502, failure)
        self.assertEqual(self.app.uploaded, set())
        self.assert_no_generation()

    def test_owned_transfer_survives_client_restart(self):
        self.app.persist_jobs()
        self.stop_client()
        self.start_client()
        status, _, result = self.transfer()
        self.assertEqual(status, 200, result)
        self.assertEqual(result["source_job"], self.job["id"])
        self.assert_no_generation()

    def test_transferred_name_compiles_downstream_image_workflow_package(self):
        status, _, transferred = self.transfer()
        self.assertEqual(status, 200, transferred)
        # The data package binds only LoadImage.image; applying/compiling never generates.
        graph = compile_workflow({"kind": "sdxl_i2i", "positive": "downstream fixture", "references": ["first.png"]}, self.backend.info)["prompt"]
        source = next(key for key, value in graph.items() if value["class_type"] == "LoadImage")
        package = self.app.packages.save({"name": "下游图片工作流", "prompt": graph,
            "fields": [{"id": "input_image", "label": "输入图", "node_id": source, "input": "image", "type": "image", "required": True}]})
        self.app.object_info(refresh=True)
        result = self.app.compile({"kind": "package", "package_id": package["id"], "values": {"input_image": transferred["name"]}})
        self.assertEqual(result["prompt"][source]["inputs"]["image"], transferred["name"])
        self.assert_no_generation()

    def test_route_requires_csrf_origin_host_and_post(self):
        self.assertEqual(self.transfer(csrf=False)[0], 403)
        self.assertEqual(self.transfer(headers={"Origin": "http://example.invalid"})[0], 403)
        self.assertEqual(self.transfer(headers={"Host": "example.invalid"})[0], 403)
        self.assertEqual(self.request("GET", f"/api/jobs/{self.job['id']}/image-input")[0], 404)
        self.assertEqual(self.backend.calls, [])

    def test_backend_identity_is_locked_through_read_and_upload(self):
        original_backend = self.backend.url
        self.view_gate.clear()
        with ThreadPoolExecutor(max_workers=2) as executor:
            transfer = executor.submit(self.app.image_input, self.job["id"], {"output_index": 0})
            self.assertTrue(self.view_started.wait(1))
            switch = executor.submit(self.app.save_settings, {"backend_url": "http://127.0.0.1:1", "model_roots": []})
            try:
                time.sleep(.03)
                self.assertFalse(switch.done())
            finally:
                self.view_gate.set()
            result = transfer.result(3)
            switch.result(3)
        self.assertEqual(result["backend"], original_backend)
        self.assertEqual(len(self.uploads()), 1)
        self.assertEqual(self.app.backend.url, "http://127.0.0.1:1")
        self.assert_no_generation()


if __name__ == "__main__":
    unittest.main()
