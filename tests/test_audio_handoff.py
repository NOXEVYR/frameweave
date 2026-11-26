"""Owned audio HTTP handoff and stable media identity against isolated mocks.

WAV is written by wave. Other audio vectors exercise bounded container framing,
not codec playback, decoder compatibility or generation quality.
"""
import base64
import copy
import hashlib
import http.client
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from frameweave.backend import Backend
from frameweave.server import output_identity
import test_service as service_fixture
from test_local_audio_assets import VECTORS, wav_bytes
import test_video_handoff as video_fixture


class AudioHandoffTests(unittest.TestCase):
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post
    output = video_fixture.VideoHandoffTests.output
    set_outputs = video_fixture.VideoHandoffTests.set_outputs
    make_package = video_fixture.VideoHandoffTests.make_package
    uploads = video_fixture.VideoHandoffTests.uploads
    views = video_fixture.VideoHandoffTests.views
    assert_no_generation = video_fixture.VideoHandoffTests.assert_no_generation

    def setUp(self):
        video_fixture.VideoHandoffTests.setUp(self)
        self.backend.info["StandardAudioLoader"] = {
            "input": {"required": {"sound": ["COMBO", {"options": [], "audio_upload": True}]}},
            "output": ["AUDIO"]}
        self.package = self.audio_package()
        self.view.update(mime="audio/wav", contents={"result.wav": wav_bytes()})
        self.set_outputs([("result.wav", "audio")])

    def audio_package(self, two_fields=False):
        ids = ("7", "8") if two_fields else ("7",)
        return self.app.packages.save({
            "name": "standard audio handoff", "description": "",
            "prompt": {key: {"class_type": "StandardAudioLoader", "inputs": {"sound": ""}} for key in ids},
            "fields": [{"id": "voice" + ("2" if key == "8" else ""), "node_id": key,
                        "input": "sound", "type": "audio", "label": "Audio", "default": ""} for key in ids]})

    def body(self, **extra):
        return {"media_type": "audio", "output_index": 0,
                "package_id": self.package["id"], "field_id": "voice", **extra}

    def handoff(self, data=None, **kwargs):
        return self.post(f"/api/jobs/{self.job_id}/media-input", self.body() if data is None else data, **kwargs)

    def local_upload(self, content=None, mime="audio/wav", **kwargs):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request("POST", "/api/assets/media?name=reference.wav",
                               wav_bytes() if content is None else content,
                               {"Content-Type": mime, "X-FW-Token": self.app.csrf, **kwargs})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_local_audio_canonical_mimes_roundtrip_and_input_upload(self):
        for factory, mime, extension in VECTORS:
            with self.subTest(mime=mime):
                content = factory()
                status, _, raw = self.local_upload(content, mime)
                self.assertEqual(status, 200, raw)
                saved = json.loads(raw)
                self.assertEqual(saved["media_type"], "audio")
                self.assertEqual(saved["asset_id"], hashlib.sha256(content).hexdigest())
                self.assertEqual(self.request("GET", saved["url"])[2], content)
                status, _, result = self.post(saved["url"] + "/backend-input",
                                               {"package_id": self.package["id"], "field_id": "voice"})
                self.assertEqual(status, 200, result)
                self.assertTrue(result["name"].endswith(extension))
                self.assertEqual(result["backend"], self.backend.url)
                self.assertIn(content, self.uploads()[-1][2])
                self.assertIn(b'name="type"\r\n\r\ninput', self.uploads()[-1][2])
                self.assertIn(b'name="overwrite"\r\n\r\nfalse', self.uploads()[-1][2])
        self.assert_no_generation()

    def test_local_audio_requires_live_field_even_with_cached_upload(self):
        self.package = self.audio_package(two_fields=True)
        saved = json.loads(self.local_upload()[2])
        route = saved["url"] + "/backend-input"
        self.assertEqual(self.post(route, {})[0], 400)
        self.assertEqual(self.post(route, {"package_id": self.package["id"], "field_id": "absent"})[0], 400)
        self.assertEqual(self.post(route, {"package_id": self.package["id"], "field_id": "voice"})[0], 200)
        self.backend.info["StandardAudioLoader"]["input"]["required"]["sound"][1]["audio_folder"] = "output"
        self.app.info_at = 0
        self.assertEqual(self.post(route, {"package_id": self.package["id"], "field_id": "voice2"})[0], 400)
        self.assertEqual(len(self.uploads()), 1)

    def test_local_audio_size_mime_and_csrf_boundaries(self):
        content = wav_bytes()
        self.assertEqual(self.local_upload(content, "audio/x-wav")[0], 415)
        self.assertEqual(self.local_upload(content, "audio/mpeg")[0], 400)
        self.assertEqual(self.local_upload(content[:-1])[0], 400)
        self.assertEqual(self.local_upload(content, **{"X-FW-Token": ""})[0], 403)
        with patch("frameweave.server.MAX_AUDIO_BYTES", len(content) - 1):
            self.assertEqual(self.local_upload(content)[0], 413)
        self.assertEqual(self.uploads(), [])

    def test_owned_audio_handoff_caches_and_binds_each_target(self):
        self.package = self.audio_package(two_fields=True)
        status, _, first = self.handoff()
        self.assertEqual(status, 200, first)
        status, _, second = self.handoff(self.body(field_id="voice2"))
        self.assertEqual(status, 200, second)
        self.assertEqual(first["media_type"], "audio")
        self.assertEqual(first["backend"], self.backend.url)
        self.assertEqual(first["output_id"], output_identity(self.job_id, self.job["outputs"][0]))
        self.assertEqual(first["asset_id"], hashlib.sha256(wav_bytes()).hexdigest())
        self.assertEqual(first["name"], second["name"])
        self.assertEqual(len(self.views()), 1)
        self.assertEqual(len(self.uploads()), 1)
        self.assertIn(wav_bytes(), self.uploads()[0][2])
        self.assert_no_generation()

    def test_audio_result_handoff_uses_canonical_format_checked_bytes(self):
        for factory, mime, extension in VECTORS:
            with self.subTest(mime=mime):
                name = "result" + extension
                self.view.update(mime=mime, contents={name: factory()})
                self.set_outputs([(name, "audio")])
                status, _, result = self.handoff()
                self.assertEqual(status, 200, result)
                self.assertTrue(result["name"].endswith(extension))
                self.assertIn(factory(), self.uploads()[-1][2])
                self.assertIn(("Content-Type: " + mime).encode(), self.uploads()[-1][2])
        self.assert_no_generation()

    def test_audio_index_remains_relative_to_audio_group(self):
        self.set_outputs([("pic.png", "image"), ("clip.mp4", "video"),
                          ("other.wav", "audio"), ("result.wav", "audio")])
        status, _, result = self.handoff(self.body(output_index=1))
        self.assertEqual(status, 200, result)
        self.assertEqual(self.views()[0][2]["filename"], ["result.wav"])
        self.assertEqual(result["output_index"], 1)

    def test_output_identity_selects_same_file_after_history_reorder(self):
        self.set_outputs([("other.wav", "audio"), ("result.wav", "audio")])
        chosen = self.job["outputs"][1]
        chosen.update(node_id="audio-sink", history_channel="audio", entry_index=1)
        selected_id = output_identity(self.job_id, chosen)
        self.job["outputs"].reverse()
        chosen["entry_index"] = 0
        status, _, result = self.handoff(self.body(output_index=1, output_id=selected_id))
        self.assertEqual(status, 200, result)
        self.assertEqual(result["output_id"], selected_id)
        self.assertEqual(self.views()[0][2]["filename"], ["result.wav"])
        self.assertEqual(self.handoff(self.body(output_id="missing"))[0], 400)

    def test_duplicate_identity_and_identity_type_change_never_fallback_to_index(self):
        chosen = self.job["outputs"][0]
        selected_id = output_identity(self.job_id, chosen)
        self.job["outputs"].append(copy.deepcopy(chosen))
        self.assertEqual(self.handoff(self.body(output_id=selected_id))[0], 400)
        self.job["outputs"].pop()
        chosen["type"] = "video"
        self.assertEqual(self.handoff(self.body(output_id=selected_id))[0], 400)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_audio_live_field_guard_runs_before_download_and_cache_reuse(self):
        self.assertEqual(self.handoff(self.body(field_id="absent"))[0], 400)
        self.backend.info["StandardAudioLoader"]["input"]["required"]["sound"][1]["audio_upload"] = False
        self.app.info_at = 0
        self.assertEqual(self.handoff()[0], 400)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_audio_ownership_status_registration_and_storage_guards(self):
        for status in ("queued", "running", "failed", "cancelled"):
            self.job["status"] = status
            self.assertEqual(self.handoff()[0], 400)
        self.job["status"] = "completed"
        self.job["outputs"][0]["storage_type"] = "temp"
        self.assertEqual(self.handoff()[0], 400)
        self.job["outputs"][0].pop("storage_type")
        self.job["outputs"][0]["url"] = self.app.register_media("other.wav", "results", "output")
        self.assertEqual(self.handoff()[0], 400)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_audio_protocol_rejects_arbitrary_sources_and_invalid_types(self):
        for extra in ({"url": "http://127.0.0.1/private"}, {"path": "C:/private.wav"},
                      {"media_type": "image"}, {"media_type": []}, {"output_id": None},
                      {"output_id": ""}, {"output_index": True}, {"output_index": -1}):
            with self.subTest(extra=extra):
                self.assertEqual(self.handoff(self.body(**extra))[0], 400)
        self.assertEqual(self.handoff(csrf=False)[0], 403)
        self.assertEqual(self.handoff(headers={"Origin": "http://example.invalid"})[0], 403)
        self.assertEqual(self.views(), [])
        self.assertEqual(self.uploads(), [])

    def test_audio_download_rejects_bad_container_mime_partial_redirect_and_encoding(self):
        cases = [(wav_bytes()[:-1], {}), (b"ID3" + b"x" * 32, {}), (video_fixture.mp4_bytes(), {}),
                 (wav_bytes(), {"Content-Range": "bytes 0-3/99"}),
                 (wav_bytes(), {"Content-Encoding": "gzip"}),
                 (wav_bytes(), {"Content-Length": "bad"}),
                 (wav_bytes(), {"Content-Length": str(len(wav_bytes()) + 10)}),
                 (wav_bytes(), {"Transfer-Encoding": "gzip"})]
        for content, headers in cases:
            with self.subTest(headers=headers, content=content[:12]):
                self.view.update(headers=headers, contents={"result.wav": content})
                self.assertEqual(self.handoff()[0], 502)
        self.view.update(status=302, headers={"Location": "http://example.invalid/private.wav"})
        self.assertEqual(self.handoff()[0], 502)
        self.assertEqual(self.uploads(), [])

    def test_audio_download_limit_is_20mib_declared_and_streamed(self):
        content = wav_bytes()
        with patch("frameweave.server.MAX_AUDIO_BYTES", len(content) - 1):
            self.assertEqual(self.handoff()[0], 502)
            self.view["omit_length"] = True
            self.assertEqual(self.handoff()[0], 502)
        self.assertEqual(self.app.video_output_assets, {})
        self.assertEqual(self.uploads(), [])

    def test_non_input_or_unsafe_ack_never_registers_audio(self):
        for ack, code in (({}, 502), ({"name": "a.wav", "type": "output"}, 502),
                          ({"name": "../a.wav", "type": "input"}, 400)):
            with patch.object(self.app.backend, "upload", return_value=ack):
                self.assertEqual(self.handoff()[0], code)
        self.assertEqual(self.app.uploaded, set())
        self.assertEqual(self.app.local_media_upload_cache, {})

    def test_audio_upload_api_checks_full_container_instead_of_magic(self):
        for content in (b"ID3" + b"x" * 32, b"fLaC" + b"x" * 32,
                        b"RIFF\x04\x00\x00\x00WAVE", wav_bytes()[:-1]):
            self.assertEqual(self.post("/api/upload-audio", {"data": base64.b64encode(content).decode()})[0], 400)
        self.assertEqual(self.uploads(), [])
        status, _, result = self.post("/api/upload-audio", {"data": base64.b64encode(wav_bytes()).decode()})
        self.assertEqual(status, 200, result)
        self.assertTrue(result["name"].endswith(".wav"))

    def blocked_handoff(self, mutate, *, identity=True):
        self.view_gate.clear()
        extra = {"output_id": output_identity(self.job_id, self.job["outputs"][0])} if identity else {}
        with ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(self.handoff, self.body(**extra))
            try:
                self.assertTrue(self.view_started.wait(2))
                self.assertEqual(pool.submit(self.request, "GET", "/api/jobs").result(timeout=1)[0], 200)
                mutate()
            finally:
                self.view_gate.set()
            return pending.result(timeout=5)

    def test_identity_survives_reorder_during_audio_download(self):
        def reorder():
            self.job["outputs"].insert(0, self.output("other.wav", "audio"))
        status, _, result = self.blocked_handoff(reorder)
        self.assertEqual(status, 200, result)
        self.assertIn(wav_bytes(), self.uploads()[0][2])

    def test_old_index_detects_source_replacement_during_download(self):
        status, _, _ = self.blocked_handoff(
            lambda: self.job["outputs"].insert(0, self.output("other.wav", "audio")), identity=False)
        self.assertEqual(status, 400)
        self.assertEqual(self.uploads(), [])

    def test_job_deletion_and_status_change_during_download_prevent_upload(self):
        for mutate in (lambda: self.app.jobs.pop(self.job_id), lambda: self.job.update(status="failed")):
            self.view_started.clear()
            self.app.jobs[self.job_id] = self.job
            self.job["status"] = "completed"
            self.assertEqual(self.blocked_handoff(mutate)[0], 400)
        self.assertEqual(self.uploads(), [])

    def test_backend_a_b_a_during_download_is_rejected_by_instance(self):
        def switch():
            self.app.save_settings({"backend_url": "http://127.0.0.1:1", "model_roots": []})
            self.app.save_settings({"backend_url": self.backend.url, "model_roots": []})
        self.assertEqual(self.blocked_handoff(switch)[0], 400)
        self.assertEqual(self.uploads(), [])

    def test_concurrent_audio_handoffs_share_download_and_upload(self):
        self.view_gate.clear()
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.handoff)
            try:
                self.assertTrue(self.view_started.wait(2))
                second = pool.submit(self.handoff)
            finally:
                self.view_gate.set()
            a, b = first.result(timeout=5), second.result(timeout=5)
        self.assertEqual((a[0], b[0]), (200, 200))
        self.assertEqual(a[2]["name"], b[2]["name"])
        self.assertEqual(len(self.views()), 1)
        self.assertEqual(len(self.uploads()), 1)

    def test_history_output_ids_are_order_independent_and_restart_preserves_id(self):
        def history(entries):
            return {"status": {"status_str": "success", "completed": True},
                    "outputs": {"sink-a": {"audio": entries}, "sink-b": {"images": [
                        {"filename": "pic.png", "subfolder": "results", "type": "output"}]}}}
        entries = [{"filename": name, "subfolder": "results", "type": "output"}
                   for name in ("result.wav", "other.wav")]
        self.job["status"] = "running"
        self.job["outputs"] = []  # This case starts before any history has been observed.
        self.backend.history[self.job_id] = history(entries)
        self.app.update_jobs()
        first = {item["filename"]: item["output_id"] for item in self.job["outputs"]}
        self.job["status"] = "running"
        self.backend.history[self.job_id] = history(list(reversed(entries)))
        self.app.update_jobs()
        self.assertEqual(first, {item["filename"]: item["output_id"] for item in self.job["outputs"]})
        self.assertEqual(self.job["outputs"][0]["entry_index"], 0)
        self.assertEqual(self.job["outputs"][0]["history_channel"], "audio")
        self.app.persist_jobs()
        old_bytes = (self.root / "data" / "jobs.json").read_bytes()
        self.stop_client()
        self.start_client()
        self.assertEqual(old_bytes, (self.root / "data" / "jobs.json").read_bytes())
        self.assertEqual(first, {item["filename"]: item["output_id"]
                                for item in self.app.jobs[self.job_id]["outputs"]})

    def test_legacy_saved_job_gains_deterministic_id_without_disk_rewrite(self):
        self.app.persist_jobs()
        old_bytes = (self.root / "data" / "jobs.json").read_bytes()
        chosen = copy.deepcopy(self.job["outputs"][0])
        self.stop_client()
        self.start_client()
        new = self.app.jobs[self.job_id]["outputs"][0]
        self.assertEqual(new["output_id"], output_identity(self.job_id, chosen))
        self.assertEqual(old_bytes, (self.root / "data" / "jobs.json").read_bytes())
        self.assertEqual(self.handoff(self.body(output_id=new["output_id"]))[0], 200)


if __name__ == "__main__":
    unittest.main()
