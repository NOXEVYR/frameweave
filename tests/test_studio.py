"""Studio submission and durable lookup against a local mock; never runs a GPU."""

import copy
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from frameweave import automation
from frameweave.backend import BackendError
from frameweave.server import SubmissionUncertain
import test_service as service_fixture
from test_workflows import fixture

API_JOB = service_fixture.API_JOB


class StudioHTTPTests(unittest.TestCase):
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post

    def submit_guarded(self, request=None, key="studio-00000001"):
        return self.post("/api/generate", {"request_id": key, "request": request or copy.deepcopy(API_JOB)})

    def lookup(self, key="studio-00000001"):
        return self.post("/api/requests/query", {"request_id": key})

    def prompt_count(self):
        return sum(call[:2] == ("POST", "/prompt") for call in self.backend.calls)

    def test_studio_retry_same_key_survives_client_restart(self):
        status, _, first = self.submit_guarded()
        self.assertEqual(status, 200, first)
        self.assertFalse(first["replayed"])
        self.stop_client()
        self.start_client()
        status, _, replay = self.submit_guarded()
        self.assertEqual(status, 200, replay)
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["id"], first["id"])
        self.assertEqual(self.prompt_count(), 1)
        status, _, found = self.lookup()
        self.assertEqual(status, 200, found)
        self.assertEqual(found["state"], "accepted")
        self.assertEqual(found["job_id"], first["id"])
        self.assertEqual(found["job"]["id"], first["id"])
        self.assertNotIn("backend", found)
        changed = copy.deepcopy(API_JOB)
        changed["prompt"]["1"]["inputs"]["text"] = "another scene"
        self.assertEqual(self.submit_guarded(changed)[0], 400)
        self.assertEqual(self.prompt_count(), 1)

    def test_request_query_is_authenticated_and_read_only(self):
        self.assertEqual(self.post("/api/requests/query", {"request_id": "studio-00000001"}, csrf=False)[0], 403)
        self.assertEqual(self.request("GET", "/api/requests/query?request_id=studio-00000001")[0], 404)
        status, _, result = self.lookup()
        self.assertEqual(status, 200)
        self.assertEqual(result["state"], "not_found")
        self.assertEqual(self.prompt_count(), 0)
        self.assertFalse((self.root / "data" / "automation-requests.json").exists())
        self.assertEqual(self.lookup("bad")[0], 400)
        self.assertEqual(self.post("/api/generate", API_JOB)[0], 400)

    def test_invalid_preflight_does_not_consume_request_id(self):
        status, _, failure = self.submit_guarded({"kind": "sdxl_i2i", "positive": "scene", "references": []})
        self.assertEqual(status, 400)
        self.assertEqual(failure["submission_state"], "rejected")
        self.assertEqual(self.lookup()[2]["state"], "not_found")
        self.assertEqual(self.submit_guarded()[0], 200)
        self.assertEqual(self.prompt_count(), 1)

    def test_uncertain_submit_can_be_looked_up_without_repeating(self):
        with patch.object(self.app, "submit", side_effect=SubmissionUncertain("mock timeout")):
            status, _, failure = self.submit_guarded()
            self.assertEqual(status, 502)
            self.assertNotIn("submission_state", failure)
        self.assertEqual(self.lookup()[2]["state"], "unknown")
        self.assertEqual(self.submit_guarded()[0], 502)
        self.assertEqual(self.prompt_count(), 0)

    def test_only_definite_preflight_and_backend_rejections_have_marker(self):
        with patch.object(self.app, "object_info", side_effect=BackendError("mock offline before submit")):
            status, _, failure = self.submit_guarded()
            self.assertEqual(status, 400)
            self.assertEqual(failure["submission_state"], "rejected")
        self.backend.rejections = True
        status, _, failure = self.submit_guarded()
        self.assertEqual(status, 400)
        self.assertEqual(failure["submission_state"], "rejected")
        self.assertEqual(self.lookup()[2]["state"], "not_found")
        self.backend.rejections = False
        self.assertEqual(self.submit_guarded()[0], 200)

    def test_conflicts_ledger_corruption_lock_and_storage_are_not_rejected(self):
        self.assertEqual(self.submit_guarded()[0], 200)
        changed = copy.deepcopy(API_JOB)
        changed["prompt"]["1"]["inputs"]["text"] = "different"
        self.assertNotIn("submission_state", self.submit_guarded(changed)[2])
        with patch.object(automation, "_read_ledger", side_effect=ValueError("mock corrupt ledger")):
            self.assertNotIn("submission_state", self.submit_guarded()[2])
        with patch.object(automation, "_ledger_lock", side_effect=ValueError("mock busy lock")):
            self.assertNotIn("submission_state", self.submit_guarded()[2])
        with patch.object(automation, "_write_ledger", side_effect=OSError("mock storage unavailable")):
            status, _, failure = self.submit_guarded(key="studio-new-storage")
            self.assertEqual(status, 502)
            self.assertNotIn("submission_state", failure)
        self.assertEqual(self.prompt_count(), 1)

    def test_rejection_cleanup_failure_keeps_pending_guard_and_no_marker(self):
        original_write = automation._write_ledger
        writes = 0

        def fail_cleanup(app, records):
            nonlocal writes
            writes += 1
            if writes > 1:
                raise OSError("mock ledger cleanup unavailable")
            return original_write(app, records)

        self.backend.rejections = True
        with patch.object(automation, "_write_ledger", side_effect=fail_cleanup):
            status, _, failure = self.submit_guarded()
        self.assertEqual(status, 502)
        self.assertNotIn("submission_state", failure)
        self.assertEqual(self.lookup()[2]["state"], "pending")
        self.backend.rejections = False
        self.assertEqual(self.submit_guarded()[0], 502)
        self.assertEqual(self.prompt_count(), 1)

    def test_not_found_during_preflight_can_only_retry_same_key_once(self):
        entered, release = threading.Event(), threading.Event()
        original = self.app.object_info

        def delayed(*args, **kwargs):
            if not entered.is_set():
                entered.set()
                release.wait(2)
            return original(*args, **kwargs)

        with patch.object(self.app, "object_info", side_effect=delayed), ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(automation.generate, self.app, "studio-preflight", API_JOB)
            self.assertTrue(entered.wait(1))
            try:
                self.assertEqual(automation.request_status(self.app, "studio-preflight")["state"], "not_found")
                second = executor.submit(automation.generate, self.app, "studio-preflight", API_JOB)
                self.assertEqual(self.prompt_count(), 0)
            finally:
                release.set()
            original_result, repeated_result = first.result(), second.result()
        self.assertEqual(original_result["id"], repeated_result["id"])
        self.assertTrue(repeated_result["replayed"])
        self.assertEqual(self.prompt_count(), 1)

    def test_query_observes_pending_while_generation_is_waiting(self):
        entered, release = threading.Event(), threading.Event()
        original = self.app.submit

        def delayed(request):
            entered.set()
            release.wait(2)
            return original(request)

        with patch.object(self.app, "submit", side_effect=delayed), ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(automation.generate, self.app, "studio-pending01", API_JOB)
            self.assertTrue(entered.wait(1))
            try:
                state = automation.request_status(self.app, "studio-pending01")
                self.assertEqual(state["state"], "pending")
            finally:
                release.set()
            self.assertTrue(future.result()["id"])
        self.assertEqual(self.prompt_count(), 1)

    def test_live_options_and_i2i_lora_recipe_are_preserved(self):
        self.backend.info = fixture()
        self.app.info = {}
        status, _, body = self.request("GET", "/api/status")
        self.assertEqual(status, 200)
        options = json.loads(body)["generation_options"]
        self.assertEqual(options["samplers"], ["euler", "heun"])
        self.assertTrue(options["lora_loaders"]["LoraLoader"]["strength_clip"])
        request = {"kind": "sdxl_i2i", "positive": "scene", "references": ["first.png"], "denoise": 0.4,
                   "loras": [{"name": "loras/turbo.safetensors", "strength_model": 0.6, "strength_clip": 0.2}]}
        status, _, job = self.submit_guarded(request)
        self.assertEqual(status, 200, job)
        recipe = self.app.recipe(job["id"])["request"]
        self.assertEqual(recipe["kind"], "sdxl_i2i")
        self.assertEqual(recipe["loras"], request["loras"])
        self.assertEqual(recipe["denoise"], 0.4)
        self.assertEqual(self.prompt_count(), 1)

    def test_mcp_can_query_the_studio_request_without_resubmission(self):
        self.assertEqual(self.submit_guarded()[0], 200)
        status, response = automation.dispatch(self.app, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "fw_jobs", "arguments": {"request_id": "studio-00000001"}}})
        self.assertEqual(status, 200)
        self.assertEqual(response["result"]["structuredContent"]["state"], "accepted")
        self.assertEqual(self.prompt_count(), 1)


if __name__ == "__main__":
    unittest.main()
