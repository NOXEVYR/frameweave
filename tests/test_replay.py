"""Job recipe and explicit replay contracts against a loopback mock backend.

These tests exercise HTTP, persistence and failure boundaries, never GPU inference.
"""

import copy
import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import test_service as service_fixture
from frameweave.backend import BackendError
from frameweave.server import atomic_json


class ReplayHTTPTests(unittest.TestCase):
    # Reuse only fixture helpers; inheriting the fixture would run all its tests twice.
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post
    submit = service_fixture.ServiceHTTPTests.submit
    complete = service_fixture.ServiceHTTPTests.complete

    def terminal_job(self, request=None):
        if request is None:
            job = self.submit()
        else:
            status, _, job = self.post("/api/jobs", request)
            self.assertEqual(status, 200, job)
        self.complete(job)
        return job

    def prompt_calls(self):
        return [call for call in self.backend.calls if call[:2] == ("POST", "/prompt")]

    def retry(self, job, request_id="retry-request-001"):
        return self.post(f"/api/jobs/{job['id']}/retry", {"request_id": request_id})

    def recipe(self, job):
        status, _, body = self.request("GET", f"/api/jobs/{job['id']}/recipe")
        return status, json.loads(body)

    def restart_client(self):
        self.stop_client()
        self.start_client()

    def test_recipe_read_is_side_effect_free_and_retains_exact_request(self):
        job = self.terminal_job()
        before = len(self.prompt_calls())
        status, recipe = self.recipe(job)
        self.assertEqual(status, 200, recipe)
        self.assertEqual(recipe["request"], service_fixture.API_JOB)
        self.assertTrue(recipe["replayable"])
        self.assertIsInstance(recipe["summary"], dict)
        self.assertIsInstance(recipe["warnings"], list)
        self.assertEqual(len(self.prompt_calls()), before)

    def test_recipe_and_retry_cannot_access_unowned_job(self):
        status, _ = self.recipe({"id": "foreign-job"})
        self.assertGreaterEqual(status, 400)
        status, _, _ = self.retry({"id": "foreign-job"})
        self.assertGreaterEqual(status, 400)
        self.assertEqual(self.prompt_calls(), [])

    def test_retry_requires_csrf_and_bounded_idempotency_key(self):
        job = self.terminal_job()
        endpoint = f"/api/jobs/{job['id']}/retry"
        status, _, _ = self.post(endpoint, {"request_id": "retry-valid-001"}, csrf=False)
        self.assertEqual(status, 403)
        for value in (None, "short", "../bad-id", "x" * 101, 42, {}):
            with self.subTest(value=value):
                data = {} if value is None else {"request_id": value}
                status, _, result = self.post(endpoint, data)
                self.assertEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)

    def test_active_source_cannot_be_retried(self):
        job = self.submit()
        status, _, result = self.retry(job)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)

    def test_legacy_run_without_request_recovers_as_api_graph(self):
        job = self.terminal_job()
        run = self.app.data_dir / "runs" / f"{job['id']}.json"
        legacy = {"prompt": copy.deepcopy(service_fixture.API_JOB["prompt"]), "summary": job["summary"]}
        run.write_text(json.dumps(legacy), encoding="utf-8")
        self.restart_client()
        status, recipe = self.recipe(job)
        self.assertEqual(status, 200, recipe)
        self.assertEqual(recipe["request"], service_fixture.API_JOB)
        self.assertTrue(recipe["warnings"], "legacy editable restoration must be identified")
        self.assertTrue(recipe["replayable"])
        status, _, result = self.retry(job)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.prompt_calls()[-1][2]["prompt"], legacy["prompt"])

    def test_missing_package_falls_back_to_recorded_api_graph(self):
        status, _, inspection = self.post("/api/packages/inspect", {"document": service_fixture.API_JOB["prompt"]})
        self.assertEqual(status, 200, inspection)
        field = inspection["fields"][0]
        status, _, saved = self.post("/api/packages", {**inspection, "name": "Replay package"})
        self.assertEqual(status, 200, saved)
        package_id = saved["package"]["id"]
        job = self.terminal_job({"kind": "package", "package_id": package_id,
                                 "values": {field["id"]: "a different recorded scene"}})
        exact = copy.deepcopy(self.prompt_calls()[-1][2]["prompt"])
        (self.app.data_dir / "workflow-packages" / f"{package_id}.json").unlink()
        self.restart_client()
        status, recipe = self.recipe(job)
        self.assertEqual(status, 200, recipe)
        self.assertEqual(recipe["request"], {"kind": "api", "prompt": exact})
        self.assertTrue(recipe["warnings"])
        status, _, result = self.retry(job)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.prompt_calls()[-1][2]["prompt"], exact)

    def test_exact_replay_does_not_recompile_stored_controls(self):
        self.backend.info["TestOutput"]["input"]["required"]["seed"] = ["INT", {"min": 0, "max": 2**64 - 1}]
        request = copy.deepcopy(service_fixture.API_JOB)
        request["prompt"]["1"]["inputs"]["seed"] = 2**53 - 1
        job = self.terminal_job(request)
        exact = copy.deepcopy(self.prompt_calls()[-1][2]["prompt"])
        with patch.object(self.app, "compile", side_effect=AssertionError("exact replay must not recompile controls")):
            status, _, result = self.retry(job)
        self.assertEqual(status, 200, result)
        self.assertEqual(self.prompt_calls()[-1][2]["prompt"], exact)

    def test_retry_refreshes_schema_and_blocks_removed_node(self):
        job = self.terminal_job()
        self.assertIn("TestOutput", self.app.info)
        self.backend.info = {}
        status, _, result = self.retry(job)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)

    def test_deleted_reference_image_is_blocked_by_fresh_schema(self):
        self.backend.info.update({
            "LoadImage": {"input": {"required": {"image": [["reference.png"]]}}, "output": ["IMAGE"]},
            "TestImageOutput": {"input": {"required": {"images": ["IMAGE"]}}, "output": [], "output_node": True},
        })
        job = self.terminal_job({"kind": "api", "prompt": {
            "1": {"class_type": "LoadImage", "inputs": {"image": "reference.png"}},
            "2": {"class_type": "TestImageOutput", "inputs": {"images": ["1", 0]}},
        }})
        self.backend.info["LoadImage"]["input"]["required"]["image"] = [[]]
        status, _, result = self.retry(job)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)

    def test_changed_backend_keeps_recipe_readable_but_blocks_replay(self):
        job = self.terminal_job()
        status, _, result = self.post("/api/settings", {"backend_url": "http://127.0.0.1:9"})
        self.assertEqual(status, 200, result)
        status, recipe = self.recipe(job)
        self.assertEqual(status, 200, recipe)
        self.assertEqual(recipe["request"], service_fixture.API_JOB)
        self.assertFalse(recipe["replayable"])
        self.assertTrue(recipe["warnings"])
        status, _, result = self.retry(job)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)

    def test_same_key_survives_child_completion_and_service_restart(self):
        source = self.terminal_job()
        status, _, child = self.retry(source)
        self.assertEqual(status, 200, child)
        self.complete(child)
        self.restart_client()
        status, _, again = self.retry(source)
        self.assertEqual(status, 200, again)
        self.assertEqual(again["id"], child["id"])
        self.assertEqual(len(self.prompt_calls()), 2)

    def test_old_key_still_identifies_first_child_after_later_retry_completes(self):
        source = self.terminal_job()
        status, _, first = self.retry(source, "retry-first-key")
        self.assertEqual(status, 200, first)
        self.complete(first)
        status, _, second = self.retry(source, "retry-second-key")
        self.assertEqual(status, 200, second)
        self.complete(second)
        self.restart_client()
        status, _, again = self.retry(source, "retry-first-key")
        self.assertEqual(status, 200, again)
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(len(self.prompt_calls()), 3)

    def test_key_coalesced_into_active_child_remains_idempotent_after_completion(self):
        source = self.terminal_job()
        status, _, first = self.retry(source, "retry-first-key")
        self.assertEqual(status, 200, first)
        status, _, coalesced = self.retry(source, "retry-second-key")
        self.assertEqual(status, 200, coalesced)
        self.assertEqual(coalesced["id"], first["id"])
        self.complete(first)
        self.restart_client()
        status, _, again = self.retry(source, "retry-second-key")
        self.assertEqual(status, 200, again)
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(len(self.prompt_calls()), 2)

    def test_different_keys_share_an_active_child_but_allow_later_explicit_run(self):
        source = self.terminal_job()
        status, _, child = self.retry(source, "retry-first-key")
        self.assertEqual(status, 200, child)
        status, _, same = self.retry(source, "retry-second-key")
        self.assertEqual(status, 200, same)
        self.assertEqual(same["id"], child["id"])
        self.assertEqual(len(self.prompt_calls()), 2)
        self.complete(child)
        status, _, later = self.retry(source, "retry-third-key")
        self.assertEqual(status, 200, later)
        self.assertNotEqual(later["id"], child["id"])
        self.assertEqual(len(self.prompt_calls()), 3)

    def test_concurrent_retry_clicks_submit_one_child(self):
        source = self.terminal_job()
        gate = threading.Barrier(2)

        def click(index):
            gate.wait(timeout=3)
            return self.retry(source, f"concurrent-key-{index}")

        with ThreadPoolExecutor(max_workers=2) as workers:
            results = list(workers.map(click, range(2)))
        self.assertEqual([result[0] for result in results], [200, 200], results)
        self.assertEqual(results[0][2]["id"], results[1][2]["id"])
        self.assertEqual(len(self.prompt_calls()), 2)

    def test_disk_failure_before_attempt_never_submits_to_backend(self):
        source = self.terminal_job()
        with patch("frameweave.server.atomic_json", side_effect=OSError("test disk unavailable")):
            status, _, result = self.retry(source)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)

    def test_pending_run_write_failure_can_recover_without_uncertain_outcome(self):
        source = self.terminal_job()

        def fail_pending_run(path, value):
            if path.name.startswith("pending-"):
                raise OSError("test failed preparing private run snapshot")
            return atomic_json(path, value)

        with patch("frameweave.server.atomic_json", side_effect=fail_pending_run):
            status, _, result = self.retry(source)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 1)
        status, _, child = self.retry(source)
        self.assertEqual(status, 200, child)
        self.assertEqual(len(self.prompt_calls()), 2)

    def test_explicit_backend_rejection_does_not_lock_future_retry(self):
        source = self.terminal_job()
        self.backend.rejections = True
        status, _, result = self.retry(source)
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(self.backend.pending, [])
        self.backend.rejections = False
        status, _, child = self.retry(source)
        self.assertEqual(status, 200, child)
        self.assertEqual(self.backend.pending, [child["id"]])

    def test_unsafe_legacy_seed_blocks_browser_editing_but_exact_retry_preserves_it(self):
        self.backend.info["TestOutput"]["input"]["required"]["seed"] = ["INT", {"min": 0, "max": 2**64 - 1}]
        request = copy.deepcopy(service_fixture.API_JOB)
        request["prompt"]["1"]["inputs"]["seed"] = 2**64 - 1
        source = self.terminal_job(request)
        status, recipe = self.recipe(source)
        self.assertGreaterEqual(status, 400, recipe)
        status, _, child = self.retry(source)
        self.assertEqual(status, 200, child)
        self.assertEqual(self.prompt_calls()[-1][2]["prompt"]["1"]["inputs"]["seed"], 2**64 - 1)

    def test_oversized_snapshot_is_rejected_before_any_backend_submission(self):
        request = copy.deepcopy(service_fixture.API_JOB)
        request["prompt"]["1"]["inputs"]["text"] = "x" * (5 * 1024 * 1024)
        status, _, result = self.post("/api/jobs", request)
        self.assertEqual(status, 400, result)
        self.assertEqual(self.prompt_calls(), [])

    def test_disk_failure_after_acceptance_returns_known_job_with_warning(self):
        source = self.terminal_job()

        def fail_after_acceptance(path, value):
            if len(self.prompt_calls()) > 1:
                raise OSError("test disk full after backend acceptance")
            return atomic_json(path, value)

        with patch("frameweave.server.atomic_json", side_effect=fail_after_acceptance):
            status, _, child = self.retry(source)
        self.assertEqual(status, 200, child)
        self.assertTrue(child.get("storage_warning"), child)
        self.assertIn(child["id"], self.backend.pending)
        status, _, same = self.retry(source)
        self.assertEqual(status, 200, same)
        self.assertEqual(same["id"], child["id"])
        self.assertEqual(len(self.prompt_calls()), 2)

    def test_unknown_submission_outcome_is_not_resent_even_after_restart(self):
        source = self.terminal_job()
        original = self.app.backend.request

        def lose_response(path, *args, **kwargs):
            response = original(path, *args, **kwargs)
            if path == "/prompt":
                raise BackendError("test connection lost after acceptance")
            return response

        with patch.object(self.app.backend, "request", side_effect=lose_response):
            status, _, result = self.retry(source, "uncertain-first-key")
        self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 2)
        self.restart_client()
        for key in ("uncertain-first-key", "uncertain-second-key"):
            status, _, result = self.retry(source, key)
            self.assertGreaterEqual(status, 400, result)
        self.assertEqual(len(self.prompt_calls()), 2)


if __name__ == "__main__":
    unittest.main()
