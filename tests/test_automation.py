"""AI tools with a real local HTTP mock; no environment scan or GPU inference."""

import base64
import copy
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from frameweave import automation
from frameweave.backend import BackendError
from frameweave.server import App
from test_service import API_JOB, MockComfy, PNG
from test_workflows import fixture, nodes


class AutomationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = MockComfy()
        self.addCleanup(self.backend.stop)
        self.app = App(self.root / "data", self.root / "web", self.backend.url)

    def rpc(self, method, params=None, *, request_id=1):
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        return automation.dispatch(self.app, message)

    def call(self, name, args=None):
        status, response = self.rpc("tools/call", {"name": name, "arguments": args or {}})
        self.assertEqual(status, 200)
        self.assertNotIn("error", response)
        result = response["result"]
        self.assertEqual(json.loads(result["content"][0]["text"]), result["structuredContent"])
        return result

    def generate(self, key="generation-0001", request=None):
        return self.call("fw_generate", {"request_id": key, "request": request or copy.deepcopy(API_JOB)})

    def prompts(self):
        return [entry for entry in self.backend.calls if entry[:2] == ("POST", "/prompt")]

    def restart(self):
        self.app = App(self.root / "data", self.root / "web", self.backend.url)

    def test_discovery_initialization_and_ping_are_offline(self):
        status, response = self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                                    "clientInfo": {"name": "test", "version": "1"}})
        self.assertEqual(status, 200)
        self.assertEqual(response["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(response["result"]["capabilities"], {"tools": {"listChanged": False}})
        status, response = self.rpc("tools/list")
        self.assertEqual(len(response["result"]["tools"]), 14)
        for item in response["result"]["tools"]:
            self.assertFalse(item["inputSchema"]["additionalProperties"])
            self.assertFalse(item["annotations"]["openWorldHint"])
        self.assertEqual(self.rpc("ping")[1]["result"], {})
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(list((self.root / "data").iterdir()), [])

    def test_version_negotiation_uses_client_version_or_latest(self):
        for version in (*automation.SUPPORTED_VERSIONS, "2040-01-01"):
            with self.subTest(version=version):
                _, result = self.rpc("initialize", {"protocolVersion": version, "capabilities": {},
                                                    "clientInfo": {"name": "test", "version": "1"}})
                self.assertEqual(result["result"]["protocolVersion"], version if version in automation.SUPPORTED_VERSIONS else automation.PROTOCOL_VERSION)

    def test_notification_has_no_body_and_never_executes_a_tool(self):
        self.assertEqual(automation.dispatch(self.app, {"jsonrpc": "2.0", "method": "notifications/initialized"}), (202, None))
        self.assertEqual(automation.dispatch(self.app, {"jsonrpc": "2.0", "method": "notifications/unknown"}), (202, None))
        status, _ = automation.dispatch(self.app, {"jsonrpc": "2.0", "method": "tools/call",
                                                   "params": {"name": "fw_generate", "arguments": {"request_id": "bad-notification", "request": API_JOB}}})
        self.assertEqual(status, 400)
        self.assertEqual(self.backend.calls, [])

    def test_protocol_rejects_batch_invalid_ids_and_malformed_params(self):
        invalid = [[], {}, {"jsonrpc": "2.0", "id": None, "method": "ping"},
                   {"jsonrpc": "2.0", "id": True, "method": "ping"},
                   {"jsonrpc": "2.0", "id": 1.5, "method": "ping"},
                   {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": []},
                   {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"_meta": "invalid"}},
                   {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "fw_jobs", "arguments": []}}]
        for message in invalid:
            with self.subTest(message=message):
                status, result = automation.dispatch(self.app, message)
                self.assertEqual(status, 400)
                self.assertIn(result["error"]["code"], (-32600, -32602))
        self.assertEqual(self.backend.calls, [])

    def test_unknown_methods_and_tools_are_protocol_errors(self):
        self.assertEqual(self.rpc("shell/execute")[1]["error"]["code"], -32601)
        self.assertEqual(self.rpc("tools/call", {"name": "run_shell"})[1]["error"]["code"], -32602)
        self.assertEqual(self.rpc("initialize", {})[1]["error"]["code"], -32602)
        self.assertEqual(self.rpc("tools/list", {"cursor": "arbitrary"})[1]["error"]["code"], -32602)

    def test_arguments_are_strict_and_do_not_coerce_numbers(self):
        invalid = [("fw_status", {"shell": "anything"}), ("fw_cancel", {"job_id": "../../private"}),
                   ("fw_generate", {"request_id": "short", "request": API_JOB}),
                   ("fw_compile", {"request": {"kind": "sdxl", "seed": True}}),
                   ("fw_compile", {"request": {"kind": "sdxl", "steps": "20"}}),
                   ("fw_compile", {"request": {"kind": "sdxl", "models": {"execute": "file"}}}),
                   ("fw_upload_image", {"path": "C:/private.png"})]
        for name, args in invalid:
            with self.subTest(name=name, args=args):
                result = self.call(name, args)
                self.assertTrue(result["isError"])
                self.assertEqual(result["structuredContent"]["error"], "invalid_arguments")
        self.assertEqual(self.backend.calls, [])

    def test_nonfinite_or_excessively_deep_json_is_rejected(self):
        for value in (float("nan"), float("inf")):
            status, result = self.rpc("tools/call", {"name": "fw_compile", "arguments": {"request": {"kind": "sdxl", "cfg": value}}})
            self.assertEqual(status, 400)
            self.assertEqual(result["error"]["code"], -32602)
        data = {}
        for _ in range(70):
            data = {"nested": data}
        self.assertEqual(self.rpc("ping", {"_meta": data})[0], 400)

    def test_invalid_unicode_cannot_break_response_encoding(self):
        for message in ({"jsonrpc": "2.0", "id": "\ud800", "method": "ping"},
                        {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"_meta": {"\ud800": "value"}}},
                        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "fw_generate", "arguments": {"request_id": "generation-0001", "request": {"kind": "sdxl", "positive": "\ud800"}}}}):
            status, result = automation.dispatch(self.app, message)
            self.assertEqual(status, 400)
            json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.assertEqual(self.backend.calls, [])

    def test_structural_size_limit_applies_before_a_tool_is_called(self):
        status, response = self.rpc("ping", {"_meta": {"entries": [None] * 100001}})
        self.assertEqual(status, 400)
        self.assertEqual(response["error"]["code"], -32602)
        self.assertEqual(self.backend.calls, [])

    def test_reinitialization_does_not_reset_generation_idempotency(self):
        first = self.generate()["structuredContent"]
        self.rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {},
                                "clientInfo": {"name": "test", "version": "1"}})
        self.assertEqual(self.generate()["structuredContent"]["id"], first["id"])
        self.assertEqual(len(self.prompts()), 1)

    def test_compile_is_read_only_and_checks_current_backend_schema(self):
        result = self.call("fw_compile", {"request": API_JOB})
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["prompt"], API_JOB["prompt"])
        self.backend.info = {}
        self.assertTrue(self.call("fw_compile", {"request": API_JOB})["isError"])
        self.assertEqual(self.prompts(), [])

    def test_native_h3_krea_and_sdxl_requests_compile_through_mcp(self):
        self.backend.info = fixture()
        cases = [
            ({"kind": "h3_t2v", "seconds": 5, "shift_video": 12, "shift_audio": 3}, "MiniMaxH3ImageToVideo"),
            ({"kind": "h3_i2v", "references": ["first.png", "last.png"], "reference_roles": ["start", "end"]}, "MiniMaxH3ImageToVideo"),
            ({"kind": "h3_ref", "references": ["style.png"], "ref_image_size": "max"}, "MiniMaxH3ReferenceToVideo"),
            ({"kind": "h3_t2v", "sampler": "dual_clock_euler", "lora": "loras/turbo.safetensors", "steps": 4}, "MiniMaxH3DualClockSamplerT8"),
            ({"kind": "krea"}, "EmptySD3LatentImage"),
            ({"kind": "krea", "references": ["first.png", "style.png"], "denoise": .7}, "TextEncodeKrea2OstrisEdit"),
            ({"kind": "sdxl"}, "CheckpointLoaderSimple"),
            ({"kind": "sdxl", "references": ["first.png"], "denoise": .6}, "VAEEncode"),
        ]
        for request, expected_node in cases:
            with self.subTest(request=request):
                result = self.call("fw_compile", {"request": {**request, "positive": "A teal paper bird.", "seed": 42}})
                self.assertFalse(result["isError"], result)
                compiled = result["structuredContent"]
                self.assertTrue(nodes(compiled, expected_node))
                self.assertEqual(compiled["summary"]["kind"], request["kind"])
                if request["kind"] == "h3_ref":
                    self.assertEqual(nodes(compiled, expected_node)[0]["ref_image_size"], "max")
        for invalid in (512, "unsupported"):
            result = self.call("fw_compile", {"request": {"kind": "h3_ref", "positive": "A bird.", "references": ["style.png"], "ref_image_size": invalid}})
            self.assertTrue(result["isError"])
        self.assertEqual(self.prompts(), [])

    def test_generate_is_idempotent_across_restart(self):
        first = self.generate()["structuredContent"]
        self.assertFalse(first["replayed"])
        self.restart()
        second = self.generate()["structuredContent"]
        self.assertEqual(second["id"], first["id"])
        self.assertTrue(second["replayed"])
        self.assertEqual(len(self.prompts()), 1)

    def test_parallel_same_key_submits_only_one_job(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.generate(), range(8)))
        self.assertTrue(all(not item["isError"] for item in results))
        self.assertEqual(len({item["structuredContent"]["id"] for item in results}), 1)
        self.assertEqual(len(self.prompts()), 1)

    def test_two_client_instances_cannot_race_the_same_durable_key(self):
        another = App(self.root / "data", self.root / "web", self.backend.url)
        entered, release = threading.Event(), threading.Event()
        original = self.app.submit

        def gated_submit(request):
            entered.set()
            self.assertTrue(release.wait(3))
            return original(request)

        message = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "fw_generate", "arguments": {"request_id": "generation-0001", "request": API_JOB}}}
        with patch.object(self.app, "submit", side_effect=gated_submit), ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(self.generate)
            try:
                self.assertTrue(entered.wait(3))
                _, response = automation.dispatch(another, message)
                self.assertTrue(response["result"]["isError"])
                self.assertIn("保留原 request_id", response["result"]["structuredContent"]["message"])
            finally:
                release.set()
            self.assertFalse(first.result()["isError"])
        _, response = automation.dispatch(another, message)
        self.assertFalse(response["result"]["isError"])
        self.assertTrue(response["result"]["structuredContent"]["replayed"])
        self.assertEqual(len(self.prompts()), 1)

    def test_same_key_with_changed_content_is_refused(self):
        self.generate()
        request = copy.deepcopy(API_JOB)
        request["prompt"]["1"]["inputs"]["text"] = "different shot"
        self.assertTrue(self.generate(request=request)["isError"])
        self.assertEqual(len(self.prompts()), 1)

    def test_invalid_preflight_can_be_corrected_with_same_key(self):
        invalid = {"kind": "api", "prompt": {"1": {"class_type": "Missing", "inputs": {}}}}
        self.assertTrue(self.generate(request=invalid)["isError"])
        self.assertFalse((self.root / "data" / "automation-requests.json").exists())
        self.assertFalse(self.generate()["isError"])
        self.assertEqual(len(self.prompts()), 1)

    def test_explicit_backend_rejection_does_not_consume_key(self):
        self.backend.rejections = True
        self.assertTrue(self.generate()["isError"])
        self.backend.rejections = False
        self.assertFalse(self.generate()["isError"])
        self.assertEqual(len(self.prompts()), 2)

    def test_lost_acceptance_response_never_resubmits_after_restart(self):
        original = self.app.backend.request

        def lost_response(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == "/prompt":
                raise BackendError("response disconnected")
            return result

        with patch.object(self.app.backend, "request", side_effect=lost_response):
            first = self.generate()
        self.assertEqual(first["structuredContent"]["error"], "submission_uncertain")
        self.assertTrue(first["structuredContent"]["do_not_resubmit"])
        self.restart()
        self.assertEqual(self.generate()["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(len(self.prompts()), 1)

    def test_interrupted_process_leaves_guard_before_any_submission(self):
        with patch.object(self.app, "submit", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                self.generate()
        self.restart()
        result = self.generate()
        self.assertEqual(result["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(self.prompts(), [])

    def test_unknown_exception_blocks_key_and_hides_internal_details(self):
        with patch.object(self.app, "submit", side_effect=RuntimeError("PRIVATE_IMPLEMENTATION_DETAIL")):
            _, response = self.rpc("tools/call", {"name": "fw_generate", "arguments": {"request_id": "generation-0001", "request": API_JOB}})
        self.assertEqual(response["error"]["code"], -32603)
        self.assertNotIn("PRIVATE_IMPLEMENTATION_DETAIL", json.dumps(response))
        self.restart()
        self.assertEqual(self.generate()["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(self.prompts(), [])

    def test_preflight_storage_failure_prevents_backend_submission(self):
        with patch.object(automation, "_write_ledger", side_effect=OSError("C:/private-data")):
            result = self.generate()
        self.assertEqual(result["structuredContent"]["error"], "storage_error")
        self.assertNotIn("private-data", json.dumps(result))
        self.assertEqual(self.prompts(), [])
        self.assertFalse(self.generate()["isError"])

    def test_failed_acceptance_storage_returns_job_and_retains_durable_guard(self):
        original = automation._write_ledger
        writes = 0

        def fail_second(app, records):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError("disk full")
            return original(app, records)

        with patch.object(automation, "_write_ledger", side_effect=fail_second):
            result = self.generate()
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["id"], "job-1")
        self.assertIn("storage_warning", result["structuredContent"])
        self.restart()
        self.assertEqual(self.generate()["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(len(self.prompts()), 1)

    def test_corrupt_ledger_stops_generation(self):
        path = self.root / "data" / "automation-requests.json"
        for content in ("truncated", '{"version":1,"requests":{"key":{"state":"accepted"}}}', '{"version":true,"requests":{}}'):
            path.write_text(content, encoding="utf-8")
            self.assertTrue(self.generate()["isError"])
        self.assertEqual(self.prompts(), [])

    def test_ledger_limit_never_discards_old_keys(self):
        with patch.object(automation, "MAX_REQUESTS", 1):
            self.assertFalse(self.generate()["isError"])
            self.assertTrue(self.generate("generation-0002")["isError"])
            self.assertFalse(self.generate()["isError"])
        self.assertEqual(len(self.prompts()), 1)

    def test_pruned_job_and_backend_change_do_not_reuse_accepted_key(self):
        original = self.generate()["structuredContent"]
        self.app.jobs.clear()
        self.app.backend.url = "http://127.0.0.1:1"
        result = self.generate()["structuredContent"]
        self.assertEqual(result["id"], original["id"])
        self.assertEqual(result["status"], "unknown")
        self.assertTrue(result["replayed"])
        self.assertEqual(len(self.prompts()), 1)

    def test_matching_job_id_on_another_backend_cannot_impersonate_original_job(self):
        original = self.generate()["structuredContent"]
        self.app.jobs[original["id"]].update(backend="http://127.0.0.1:1", status="completed",
                                            outputs=[{"url": "/api/media/different-backend"}])
        result = self.generate()["structuredContent"]
        self.assertEqual(result["id"], original["id"])
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["outputs"], [])
        self.assertTrue(result["replayed"])
        self.assertEqual(len(self.prompts()), 1)

    def test_workflow_package_inspect_import_export_and_apply(self):
        draft = self.call("fw_package_inspect", {"document": API_JOB["prompt"]})["structuredContent"]
        self.assertEqual(draft["fields"][0]["input"], "text")
        package = self.call("fw_package_import", {"document": draft})["structuredContent"]
        self.assertEqual(self.prompts(), [])
        self.assertEqual(self.call("fw_packages")["structuredContent"]["packages"][0]["id"], package["id"])
        exported = self.call("fw_package_export", {"package_id": package["id"]})["structuredContent"]
        self.assertNotIn("id", exported)
        self.assertEqual(self.call("fw_package_import", {"document": exported})["structuredContent"]["id"], package["id"])
        request = {"kind": "package", "package_id": package["id"], "values": {draft["fields"][0]["id"]: "a teal scene"}}
        result = self.generate(request=request)
        self.assertFalse(result["isError"])
        self.assertEqual(self.prompts()[0][2]["prompt"]["1"]["inputs"]["text"], "a teal scene")
        self.app.packages.update_metadata(package["id"], {"archived": True})
        self.assertEqual(self.call("fw_packages")["structuredContent"]["packages"], [])
        self.assertEqual(len(self.call("fw_packages", {"include_archived": True})["structuredContent"]["packages"]), 1)
        self.assertEqual(self.call("fw_packages", {"package_id": package["id"]})["structuredContent"]["id"], package["id"])

    def test_package_import_validates_nested_boolean_and_version_types(self):
        draft = self.call("fw_package_inspect", {"document": API_JOB["prompt"]})["structuredContent"]
        invalid_version = {**draft, "version": True}
        self.assertTrue(self.call("fw_package_import", {"document": invalid_version})["isError"])
        draft["fields"][0]["required"] = "true"
        self.assertTrue(self.call("fw_package_import", {"document": draft})["isError"])
        self.assertEqual(self.app.packages.list(), [])
        self.assertEqual(self.prompts(), [])

    def test_job_query_recipe_retry_and_owned_cancel(self):
        job = self.generate()["structuredContent"]
        self.assertEqual(self.call("fw_jobs", {"job_id": job["id"]})["structuredContent"]["id"], job["id"])
        recipe = self.call("fw_job_recipe", {"job_id": job["id"]})["structuredContent"]
        self.assertEqual(recipe["request"]["prompt"], API_JOB["prompt"])
        self.assertTrue(self.call("fw_cancel", {"job_id": "foreign-job"})["isError"])
        self.assertEqual(self.call("fw_cancel", {"job_id": job["id"]})["structuredContent"]["status"], "cancelled")
        args = {"job_id": job["id"], "request_id": "retry-key-0001"}
        first = self.call("fw_retry", args)["structuredContent"]
        self.assertEqual(self.call("fw_retry", args)["structuredContent"]["id"], first["id"])
        self.assertEqual(len(self.prompts()), 2)
        self.assertFalse(any(entry[:2] == ("POST", "/interrupt") for entry in self.backend.calls))

    def terminal_job(self, key="source-operation-0001"):
        job = self.generate(key)["structuredContent"]
        self.assertEqual(self.call("fw_cancel", {"job_id": job["id"]})["structuredContent"]["status"], "cancelled")
        return job

    @staticmethod
    def retry_message(job_id, key="retry-operation-0001"):
        return {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "fw_retry", "arguments": {"job_id": job_id, "request_id": key}}}

    def test_two_stale_instances_deduplicate_concurrent_and_later_retry(self):
        source = self.terminal_job()
        another = App(self.root / "data", self.root / "web", self.backend.url)
        entered, release = threading.Event(), threading.Event()
        original = self.app.retry

        def gated_retry(job_id, data):
            entered.set()
            self.assertTrue(release.wait(3))
            return original(job_id, data)

        message = self.retry_message(source["id"])
        with patch.object(self.app, "retry", side_effect=gated_retry), ThreadPoolExecutor(max_workers=1) as pool:
            first = pool.submit(automation.dispatch, self.app, message)
            try:
                self.assertTrue(entered.wait(3))
                _, concurrent = automation.dispatch(another, message)
                self.assertTrue(concurrent["result"]["isError"])
                self.assertIn("保留原 request_id", concurrent["result"]["structuredContent"]["message"])
            finally:
                release.set()
            _, accepted = first.result()
        self.assertFalse(accepted["result"]["isError"])
        child = accepted["result"]["structuredContent"]["id"]
        self.assertNotIn(child, another.jobs)  # Deliberately retain its stale snapshot.
        _, repeated = automation.dispatch(another, message)
        self.assertFalse(repeated["result"]["isError"])
        self.assertEqual(repeated["result"]["structuredContent"]["id"], child)
        self.assertTrue(repeated["result"]["structuredContent"]["replayed"])
        self.restart()
        _, restarted = automation.dispatch(self.app, message)
        self.assertEqual(restarted["result"]["structuredContent"]["id"], child)
        self.assertEqual(len(self.prompts()), 2)

    def test_generate_and_retry_have_independent_request_namespaces(self):
        key = "shared-request-id-0001"
        source = self.terminal_job(key)
        child = self.call("fw_retry", {"job_id": source["id"], "request_id": key})["structuredContent"]
        self.assertNotEqual(child["id"], source["id"])
        self.assertEqual(self.generate(key)["structuredContent"]["id"], source["id"])
        self.assertEqual(self.call("fw_retry", {"job_id": source["id"], "request_id": key})["structuredContent"]["id"], child["id"])
        ledger = automation._read_ledger(self.app)
        self.assertEqual({entry["operation"] for entry in ledger.values()}, {"generate", "retry"})
        self.assertEqual(len(self.prompts()), 2)

    def test_retry_request_namespace_is_scoped_to_source_job(self):
        source_a = self.terminal_job("source-operation-0001")
        source_b = self.terminal_job("source-operation-0002")
        children = [self.call("fw_retry", {"job_id": source["id"], "request_id": "shared-retry-key-1"})["structuredContent"]
                    for source in (source_a, source_b)]
        self.assertNotEqual(children[0]["id"], children[1]["id"])
        self.assertEqual(len(self.prompts()), 4)

    def test_uncertain_retry_blocks_the_same_key_in_a_stale_instance(self):
        source = self.terminal_job()
        another = App(self.root / "data", self.root / "web", self.backend.url)
        original = self.app.backend.request

        def lost_response(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if path == "/prompt":
                raise BackendError("lost retry acceptance")
            return result

        message = self.retry_message(source["id"])
        with patch.object(self.app.backend, "request", side_effect=lost_response):
            _, first = automation.dispatch(self.app, message)
        self.assertEqual(first["result"]["structuredContent"]["error"], "submission_uncertain")
        _, second = automation.dispatch(another, message)
        self.assertEqual(second["result"]["structuredContent"]["error"], "submission_uncertain")
        self.restart()
        _, third = automation.dispatch(self.app, message)
        self.assertEqual(third["result"]["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(len(self.prompts()), 2)

    def test_retry_preflight_storage_failure_does_not_dispatch(self):
        source = self.terminal_job()
        args = {"job_id": source["id"], "request_id": "retry-operation-0001"}
        with patch.object(automation, "_write_ledger", side_effect=OSError("full")):
            result = self.call("fw_retry", args)
        self.assertEqual(result["structuredContent"]["error"], "storage_error")
        self.assertEqual(len(self.prompts()), 1)
        self.assertFalse(self.call("fw_retry", args)["isError"])
        self.assertEqual(len(self.prompts()), 2)

    def test_retry_acceptance_storage_failure_preserves_cross_instance_guard(self):
        source = self.terminal_job()
        another = App(self.root / "data", self.root / "web", self.backend.url)
        original = automation._write_ledger
        writes = 0

        def fail_second(app, records):
            nonlocal writes
            writes += 1
            if writes == 2:
                raise OSError("full")
            return original(app, records)

        message = self.retry_message(source["id"])
        with patch.object(automation, "_write_ledger", side_effect=fail_second):
            _, accepted = automation.dispatch(self.app, message)
        self.assertFalse(accepted["result"]["isError"])
        self.assertIn("storage_warning", accepted["result"]["structuredContent"])
        _, repeated = automation.dispatch(another, message)
        self.assertEqual(repeated["result"]["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(len(self.prompts()), 2)

    def test_interrupted_retry_leaves_a_cross_instance_pending_guard(self):
        source = self.terminal_job()
        another = App(self.root / "data", self.root / "web", self.backend.url)
        message = self.retry_message(source["id"])
        with patch.object(self.app, "retry", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                automation.dispatch(self.app, message)
        _, repeated = automation.dispatch(another, message)
        self.assertEqual(repeated["result"]["structuredContent"]["error"], "submission_uncertain")
        self.assertEqual(len(self.prompts()), 1)

    def test_legacy_generation_records_remain_compatible(self):
        original = self.generate()["structuredContent"]
        records = automation._read_ledger(self.app)
        records["generation-0001"].pop("operation")
        automation._write_ledger(self.app, records)
        self.restart()
        self.assertEqual(self.generate()["structuredContent"]["id"], original["id"])
        self.assertEqual(len(self.prompts()), 1)

    def test_upload_accepts_image_content_but_not_arbitrary_file_content(self):
        result = self.call("fw_upload_image", {"data": base64.b64encode(PNG).decode()})
        self.assertFalse(result["isError"])
        self.assertTrue(result["structuredContent"]["name"].startswith("frameweave-"))
        self.assertTrue(result["structuredContent"]["url"].startswith("/api/media/"))
        self.assertTrue(self.call("fw_upload_image", {"data": base64.b64encode(b"not an image file").decode()})["isError"])

    def test_environment_and_diagnostics_use_existing_bounded_service(self):
        with patch.object(self.app, "environment", return_value={"backends": [], "test": True}) as method:
            self.assertTrue(self.call("fw_environment")["structuredContent"]["test"])
            method.assert_called_once_with()
        with patch.object(self.app, "diagnostics", return_value={"ready": False, "unknown": True}) as method:
            self.assertTrue(self.call("fw_diagnostics", {"request": API_JOB})["structuredContent"]["unknown"])
            method.assert_called_once_with(API_JOB)
        self.assertEqual(self.backend.calls, [])


if __name__ == "__main__":
    unittest.main()
