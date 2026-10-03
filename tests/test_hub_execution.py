"""Fault recovery is tested using real worker storage and observable fake endpoints."""
import copy
import tempfile
import unittest
import uuid
from dataclasses import replace
from pathlib import Path

from frameweave.automation import SubmissionRejected
from frameweave.hub_execution import Worker
from frameweave.hub_execution_contract import (ContractError, EnabledCapability, PROTOCOL,
                                               bind_declaration, canonical, sha, strict_json)
from frameweave.hub_execution_store import WorkerStore
from frameweave.hub_execution_transport import HubUnavailable


def uid():
    return str(uuid.uuid4())


DECLARATION = canonical(bind_declaration({"key": "prism.image", "inputs": {"type": "object", "properties": {
    "text": {"type": "string", "maxLength": 200}}, "required": ["text"]}},
    "http://127.0.0.1:8188", {"kind": "sdxl", "positive": "", "seed": 42}, {"text": ["positive"]})).decode()


class FakeHub:
    def __init__(self):
        self.binding = dict(execution_authority_id=uid(), ledger_epoch=uid(),
                            workspace_binding_revision="a" * 64, client_id="test-worker")
        self.raw = '{ "text": "test image" }'
        self.declaration = DECLARATION
        self.receipt = dict(protocol=PROTOCOL, **{k: v for k, v in self.binding.items() if k != "client_id"},
                            execution_id=uid(), request_id=uid(), queue_task_id=uid(),
                            origin={key: "test" for key in ("authority_id", "project_id", "task_id", "run_id", "call_id", "input_revision")},
                            capability_id="b" * 32, declaration_sha256=sha(DECLARATION.encode()),
                            executor={"client_id": "test-worker", "tool": "codex"}, input_sha256=sha(self.raw.encode()),
                            provider_state="not_started", provider_request_id=None, results=[], outcome={},
                            results_manifest_sha256=None, dispatch_state="queued_ready", cancel_requested=False)
        self.observations, self.reports = {}, {}
        self.claim_id = uid()
        self.claim_key = None
        self.drop = set()
        self.report_calls = 0

    def describe(self):
        return {}

    def approve(self, capability):
        self.declaration = canonical(bind_declaration(strict_json(capability.declaration_text),
            capability.backend, capability.template, capability.bindings)).decode()
        self.receipt["declaration_sha256"] = sha(self.declaration.encode())
        return replace(capability, declaration_text=self.declaration)

    def status(self, execution_id):
        return copy.deepcopy(self.receipt)

    def claim(self, execution_id, claim_request_id):
        if self.claim_key is not None:
            assert claim_request_id == self.claim_key
        self.claim_key = claim_request_id
        self.receipt["dispatch_state"] = "claimed"
        result = dict(copy.deepcopy(self.receipt), lease_token=uid(), lease_rotated=True,
                      input_json=self.raw, declaration_text=self.declaration,
                      task={"id": self.receipt["queue_task_id"], "report_submission": {"claim_id": self.claim_id}})
        self.lose("claim")
        return result

    def lose(self, where):
        if where in self.drop:
            self.drop.remove(where)
            raise HubUnavailable("dropped_test_reply")

    def observe(self, execution_id, lease_token, observation):
        observation = copy.deepcopy(observation)
        identifier = observation.pop("observation_id")
        if identifier in self.observations:
            old, receipt = self.observations[identifier]
            assert observation == old
            return copy.deepcopy(receipt)
        for key in ("provider_state", "provider_request_id", "results"):
            self.receipt[key] = observation[key]
        self.receipt["outcome"] = {k: observation[k] for k in ("error_code", "cancel_evidence") if k in observation}
        self.receipt["results_manifest_sha256"] = sha(canonical(observation["results"])) if observation["provider_state"] == "succeeded" else None
        self.observations[identifier] = (observation, copy.deepcopy(self.receipt))
        self.lose(observation["provider_state"])
        return copy.deepcopy(self.receipt)

    def report(self, payload, lease_token):
        self.report_calls += 1
        key = payload["submission_id"]
        if key in self.reports:
            assert payload == self.reports[key]
        self.reports[key] = copy.deepcopy(payload)
        self.lose("report")
        return {"submission_id": key, "memory_candidate_count": 0}

    def finish(self, task_id, client_id, lease_token):
        self.receipt["dispatch_state"] = "completed"
        self.lose("finish")
        return {"id": task_id, "status": "completed"}


class FakeNative:
    def __init__(self):
        self.backend = "http://127.0.0.1:8188"
        self.submissions = []
        self.job = {"id": uid(), "status": "queued", "backend": self.backend}
        self.drop_submit = False
        self.reject = False
        self.query_state = "accepted"
        self.can_cancel = False
        self.cancels = []
        self.missing_results = False

    def check_backend(self, backend):
        if backend != self.backend:
            raise ContractError("native_backend_changed")

    def submit(self, request_id, request, backend):
        self.check_backend(backend)
        self.submissions.append((request_id, copy.deepcopy(request)))
        if self.reject:
            raise SubmissionRejected("synthetic rejection")
        if self.drop_submit:
            raise OSError("synthetic lost reply")
        return copy.deepcopy(self.job)

    def query(self, request_id, backend):
        return {"state": self.query_state, "job": copy.deepcopy(self.job)}

    def cancel(self, job_id, backend):
        self.check_backend(backend)
        self.cancels.append(job_id)
        if not self.can_cancel:
            raise ValueError("targeted cancel unavailable")
        self.job["status"] = "cancelled"
        return copy.deepcopy(self.job)

    def results(self, execution_id, job_id, backend):
        if self.missing_results:
            raise ValueError("not available")
        return [{"result_id": "o-" + "c" * 64, "kind": "image", "media_type": "image/png",
                 "bytes": 5, "sha256": sha(b"image"), "locator": "pc-result-" + job_id}]


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.hub, self.native = FakeHub(), FakeNative()
        self.path = Path(self.temp.name) / "worker.sqlite3"
        self.store = WorkerStore(self.path, self.hub.binding)
        self.cap = EnabledCapability("b" * 32, DECLARATION, self.native.backend,
                                     {"kind": "sdxl", "positive": "", "seed": 42}, {"text": ["positive"]})
        self.worker = Worker(self.store, self.hub, self.native, [self.cap])
        self.eid = self.hub.receipt["execution_id"]

    def step(self):
        return self.worker.step(self.eid)

    def reopen(self):
        self.store = WorkerStore(self.path, self.hub.binding)
        self.worker = Worker(self.store, self.hub, self.native, [self.cap])

    def test_complete_one_submission_and_no_raw_input_in_report(self):
        self.assertEqual(self.step()["state"], "running")
        self.native.job["status"] = "completed"
        self.assertEqual(self.step()["state"], "completed")
        self.reopen()
        self.assertEqual(self.step()["state"], "completed")
        self.assertEqual(len(self.native.submissions), 1)
        report = next(iter(self.hub.reports.values()))
        self.assertEqual(report["memory_candidates"], [])
        self.assertNotIn("test image", report["content"])
        self.assertNotIn("127.0.0.1", report["content"])

    def test_lost_claim_reply_reuses_claim_id(self):
        self.hub.drop.add("claim")
        with self.assertRaises(HubUnavailable): self.step()
        original = self.store.get(self.eid)["claim_request_id"]
        self.reopen()
        self.step()
        self.assertEqual(self.hub.claim_key, original)
        self.assertEqual(len(self.native.submissions), 1)

    def test_submitting_reply_lost_never_calls_native_before_ack(self):
        self.hub.drop.add("submitting")
        with self.assertRaises(HubUnavailable): self.step()
        self.assertEqual(self.native.submissions, [])
        observation = self.store.get(self.eid)["observation"]["observation_id"]
        self.reopen()
        self.step()
        self.assertIn(observation, self.hub.observations)
        self.assertEqual(len(self.native.submissions), 1)

    def test_lost_native_reply_queries_original_id(self):
        self.native.drop_submit = True
        self.assertEqual(self.step()["state"], "uncertain")
        self.reopen()
        self.assertEqual(self.step()["state"], "running")
        self.assertEqual(len(self.native.submissions), 1)

    def test_not_found_after_attempt_is_not_permission_to_resubmit(self):
        self.native.drop_submit = True
        self.step()
        self.native.query_state = "not_found"
        for _ in range(3):
            self.reopen()
            self.assertEqual(self.step()["state"], "uncertain")
        self.assertEqual(len(self.native.submissions), 1)

    def test_crash_after_attempt_marker_before_native_call(self):
        self.hub.drop.add("submitting")
        with self.assertRaises(HubUnavailable): self.step()
        self.worker._flush(self.eid)
        self.store.begin_native(self.eid)
        self.native.query_state = "not_found"
        self.reopen()
        self.assertEqual(self.step()["state"], "uncertain")
        self.assertEqual(self.native.submissions, [])

    def test_backend_changed_before_submit_preserves_intent(self):
        self.native.backend = "http://127.0.0.1:8189"
        with self.assertRaisesRegex(ContractError, "native_backend_changed"): self.step()
        self.assertFalse(self.store.get(self.eid)["native_attempted"])
        self.native.backend = self.cap.backend
        self.step()
        self.assertEqual(len(self.native.submissions), 1)

    def test_cancel_before_submit_proof(self):
        self.hub.drop.add("submitting")
        with self.assertRaises(HubUnavailable): self.step()
        self.hub.receipt["cancel_requested"] = True
        self.assertEqual(self.step()["state"], "completed")
        self.assertEqual(self.native.submissions, [])
        self.assertEqual(self.hub.receipt["outcome"]["cancel_evidence"]["kind"], "never_submitted")

    def test_running_cancel_is_not_terminal_until_confirmed(self):
        self.step()
        self.hub.receipt["cancel_requested"] = True
        self.assertEqual(self.step()["state"], "running")
        self.native.can_cancel = True
        self.assertEqual(self.step()["state"], "completed")
        self.assertEqual(self.hub.receipt["provider_state"], "cancelled")
        self.assertEqual(len(self.native.submissions), 1)

    def test_missing_results_remains_uncertain(self):
        self.native.job["status"] = "completed"
        self.native.missing_results = True
        self.assertEqual(self.step()["reason"], "results_not_verifiable")
        self.native.missing_results = False
        self.assertEqual(self.step()["state"], "completed")

    def test_preflight_rejection_has_explicit_terminal(self):
        self.native.reject = True
        self.assertEqual(self.step()["state"], "completed")
        self.assertEqual(self.hub.receipt["outcome"], {"error_code": "native_preflight_rejected"})

    def test_terminal_outbox_does_not_reinspect_changed_media(self):
        self.native.job["status"] = "completed"
        self.hub.drop.add("succeeded")
        with self.assertRaises(HubUnavailable): self.step()
        self.native.missing_results = True
        self.reopen()
        self.assertEqual(self.step()["state"], "completed")
        self.assertEqual(len(self.native.submissions), 1)

    def test_report_reply_lost_reuses_report_id_and_payload(self):
        self.native.job["status"] = "completed"
        self.hub.drop.add("report")
        with self.assertRaises(HubUnavailable): self.step()
        self.reopen()
        self.assertEqual(self.step()["state"], "completed")
        self.assertEqual(len(self.hub.reports), 1)
        self.assertEqual(self.hub.report_calls, 2)

    def test_finish_reply_lost_recovers_without_new_claim(self):
        self.native.job["status"] = "completed"
        self.hub.drop.add("finish")
        with self.assertRaises(HubUnavailable): self.step()
        self.reopen()
        self.assertEqual(self.step()["state"], "completed")
        self.assertTrue(self.store.get(self.eid)["finished"])

    def test_scope_drift_stops_before_claim_and_native(self):
        self.hub.receipt["ledger_epoch"] = uid()
        with self.assertRaises(ContractError): self.step()
        self.assertEqual(self.native.submissions, [])

    def test_raw_input_changed_without_digest_is_rejected(self):
        self.hub.raw = '{"text":"changed"}'
        with self.assertRaisesRegex(ContractError, "input_digest"): self.step()
        self.assertEqual(self.native.submissions, [])

    def test_completed_ledger_rollback_detected(self):
        self.native.job["status"] = "completed"
        self.step()
        self.hub.receipt["dispatch_state"] = "claimed"
        with self.assertRaisesRegex(ContractError, "hub_ledger_reverted"): self.step()

    def test_unknown_remote_terminal_never_adopted(self):
        self.hub.receipt["provider_state"] = "succeeded"
        self.assertEqual(self.step()["state"], "not_owned")
        self.assertIsNone(self.store.get(self.eid))

    def test_disabled_capability_does_not_claim(self):
        self.worker.capabilities.clear()
        with self.assertRaisesRegex(ContractError, "capability_disabled"): self.step()
        self.assertIsNone(self.hub.claim_key)


if __name__ == "__main__":
    unittest.main()
