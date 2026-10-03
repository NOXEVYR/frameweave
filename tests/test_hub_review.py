"""Independent adapter review regressions; isolated objects, no service or GPU."""

import copy
import io
import tempfile
import threading
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from frameweave.backend import BackendError
from frameweave.hub_execution import NativeApp, Worker
from frameweave.hub_execution_contract import ContractError, EnabledCapability
from frameweave.hub_execution_store import WorkerStore
from frameweave.hub_execution_transport import HubUnavailable
from frameweave.hub_results import read_result
from frameweave.server import App, output_identity
from test_hub_execution import DECLARATION, FakeHub, FakeNative, sha, uid


class CompletedDuringQueueDelete:
    """The pending job finishes between the old queue read and deletion."""

    url = "http://127.0.0.1:8188"

    def __init__(self, job_id):
        self.job_id = job_id
        self.queue_reads = 0
        self.calls = []

    def request(self, path, body=None, **kwargs):
        self.calls.append((path, body))
        if path.endswith("/cancel"):
            raise BackendError("HTTP 404")
        if path == "/queue":
            if body is not None:
                return {}
            self.queue_reads += 1
            return {"queue_pending": [[0, self.job_id]] if self.queue_reads == 1 else [],
                    "queue_running": []}
        if path == "/history/" + self.job_id:
            return {self.job_id: {"status": {"status_str": "success", "completed": True},
                                  "outputs": {"1": {"images": [{"filename": "result.png"}]}}}}
        raise AssertionError("unexpected isolated request")


def legacy_app(job):
    app = types.SimpleNamespace(lock=threading.RLock(), jobs={job["id"]: job},
                                backend=CompletedDuringQueueDelete(job["id"]), persist_jobs=lambda: None)
    app.cancel = types.MethodType(App.cancel, app)
    app.public_job = lambda value: copy.deepcopy(value)
    app._queue_ids = App._queue_ids
    return app


class LegacyCancellingNative(FakeNative):
    def __init__(self):
        super().__init__()
        self.app = legacy_app(self.job)

    def cancel(self, job_id, backend):
        return NativeApp(self.app).cancel(job_id, backend)


class DispatchedInterruptBackend(CompletedDuringQueueDelete):
    """Comfy's atomic API confirms dispatch, while the running job can finish."""

    def __init__(self, job_id):
        super().__init__(job_id)
        self.history = {}

    def request(self, path, body=None, **kwargs):
        self.calls.append((path, body))
        if path.endswith("/cancel"):
            return {"cancelled": True}
        if path == "/queue":
            return {"queue_pending": [], "queue_running": [[0, self.job_id]]}
        if path == "/history/" + self.job_id:
            return copy.deepcopy(self.history)
        if path == "/api/jobs/" + self.job_id:
            return {"id": self.job_id, "status": "running"}
        raise AssertionError("unexpected isolated request")


class AtomicRequestNative(LegacyCancellingNative):
    def __init__(self):
        super().__init__()
        self.job["status"] = "running"
        self.app.backend = DispatchedInterruptBackend(self.job["id"])

    def query(self, request_id, backend):
        with patch("frameweave.hub_execution.automation.request_status", return_value={
                "state": "accepted", "job": copy.deepcopy(self.job)}):
            return NativeApp(self.app).query(request_id, backend)


class IndependentHubReviewTests(unittest.TestCase):
    def worker(self, native=None):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        hub, native = FakeHub(), native or FakeNative()
        store = WorkerStore(Path(temp.name) / "worker.sqlite3", hub.binding)
        cap = EnabledCapability("b" * 32, DECLARATION, native.backend,
                                {"kind": "sdxl", "positive": "", "seed": 42}, {"text": ["positive"]})
        return Worker(store, hub, native, [cap]), hub, native, store

    def test_queue_disappearance_is_not_confirmed_native_cancellation(self):
        worker, hub, native, store = self.worker(LegacyCancellingNative())
        execution_id = hub.receipt["execution_id"]
        self.assertEqual(worker.step(execution_id)["state"], "running")
        hub.receipt["cancel_requested"] = True
        result = worker.step(execution_id)
        self.assertNotEqual(hub.receipt["provider_state"], "cancelled")
        self.assertNotEqual(result["state"], "completed")
        self.assertFalse(store.get(execution_id)["finished"])
        self.assertEqual(len(native.submissions), 1)

    def test_legacy_cancelled_record_without_native_evidence_is_not_terminal(self):
        native = FakeNative()
        native.job["status"] = "cancelled"
        app = legacy_app(native.job)
        with patch("frameweave.hub_execution.automation.request_status", return_value={
                "state": "accepted", "job": copy.deepcopy(native.job)}):
            result = NativeApp(app).query("test-request", native.backend)
        self.assertNotEqual(result["job"]["status"], "cancelled")

    def test_disabled_capability_after_lost_initial_claim_is_controlled(self):
        worker, hub, native, store = self.worker()
        execution_id = hub.receipt["execution_id"]
        hub.drop.add("claim")
        with self.assertRaises(HubUnavailable):
            worker.step(execution_id)
        self.assertIsNone(store.get(execution_id)["claim"])
        worker.capabilities.clear()
        with self.assertRaisesRegex(ContractError, "capability_disabled"):
            worker.step(execution_id)
        self.assertEqual(native.submissions, [])

    def test_atomic_interrupt_dispatch_is_not_running_job_terminal(self):
        worker, hub, native, store = self.worker(AtomicRequestNative())
        execution_id = hub.receipt["execution_id"]
        self.assertEqual(worker.step(execution_id)["state"], "running")
        hub.receipt["cancel_requested"] = True
        result = worker.step(execution_id)
        self.assertNotEqual(result["state"], "completed")
        self.assertNotEqual(hub.receipt["provider_state"], "cancelled")
        self.assertFalse(store.get(execution_id)["finished"])
        # The interrupt flag may be unconsumed when native execution finishes.
        native.job["status"] = "completed"
        self.assertEqual(worker.step(execution_id)["state"], "completed")
        self.assertEqual(hub.receipt["provider_state"], "succeeded")
        self.assertEqual(len(native.submissions), 1)

    def test_cancel_dispatch_persist_failure_does_not_leave_false_terminal_in_memory(self):
        worker, hub, native, store = self.worker(AtomicRequestNative())
        execution_id = hub.receipt["execution_id"]
        self.assertEqual(worker.step(execution_id)["state"], "running")
        hub.receipt["cancel_requested"] = True
        native.app.persist_jobs = lambda: (_ for _ in ()).throw(OSError("synthetic disk failure"))
        self.assertNotEqual(worker.step(execution_id)["state"], "completed")
        self.assertNotEqual(native.job["status"], "cancelled")
        self.assertNotEqual(worker.step(execution_id)["state"], "completed")
        self.assertFalse(store.get(execution_id)["finished"])
        self.assertEqual(len(native.submissions), 1)

    def test_known_native_terminal_is_not_cancelled(self):
        worker, hub, native, store = self.worker(AtomicRequestNative())
        execution_id = hub.receipt["execution_id"]
        self.assertEqual(worker.step(execution_id)["state"], "running")
        native.job["status"] = "completed"
        hub.receipt["cancel_requested"] = True
        self.assertEqual(worker.step(execution_id)["state"], "completed")
        self.assertEqual(hub.receipt["provider_state"], "succeeded")
        self.assertFalse(any(path.endswith("/cancel") for path, _ in native.app.backend.calls))
        self.assertEqual(len(native.submissions), 1)

    def test_cancellation_requires_error_history_for_exact_original_prompt(self):
        native = AtomicRequestNative()
        job_id = native.job["id"]
        for state, prompt_id, expected in (("error", job_id, "cancelled"),
                                            ("error", "another-job", "failed"),
                                            ("success", job_id, "unknown")):
            for legacy_status in ("failed", "cancelled"):
                with self.subTest(history=state, prompt=prompt_id, original=legacy_status):
                    native.job["status"] = legacy_status
                    native.app.backend.history = {job_id: {"status": {"status_str": state,
                        "messages": [["execution_interrupted", {"prompt_id": prompt_id}]]}}}
                    result = native.query("test-request", native.backend)
                    self.assertEqual(result["job"]["status"], expected)
                    self.assertEqual(native.job["status"], legacy_status)

    def test_verified_cancel_outbox_survives_lost_ack_without_resubmitting(self):
        worker, hub, native, store = self.worker(AtomicRequestNative())
        execution_id = hub.receipt["execution_id"]
        self.assertEqual(worker.step(execution_id)["state"], "running")
        native.job["status"] = "failed"
        native.app.backend.history = {native.job["id"]: {"status": {"status_str": "error",
            "messages": [["execution_interrupted", {"prompt_id": native.job["id"]}]]}}}
        hub.receipt["cancel_requested"] = True
        hub.drop.add("cancelled")
        with self.assertRaises(HubUnavailable):
            worker.step(execution_id)
        pending = store.get(execution_id)["observation"]
        self.assertEqual(pending["provider_state"], "cancelled")
        self.assertFalse(store.get(execution_id)["finished"])
        # A restart need not reconstruct evidence already frozen in the outbox.
        native.app.backend.history.clear()
        worker = Worker(WorkerStore(store.path, hub.binding), hub, native, [])
        self.assertEqual(worker.step(execution_id)["state"], "completed")
        self.assertIsNone(store.get(execution_id)["observation"])
        self.assertEqual(store.get(execution_id)["last_observation"]["observation_id"], pending["observation_id"])
        self.assertEqual(len(native.submissions), 1)
        self.assertFalse(any(path.endswith("/cancel") for path, _ in native.app.backend.calls))


class IndependentResultReadReviewTests(unittest.TestCase):
    def setUp(self):
        self.body, self.mime = b"small-owned-video", "video/mp4"
        self.backend = "http://127.0.0.1:8188"
        self.records = {}
        self.app = types.SimpleNamespace(lock=threading.RLock(), jobs={}, media={})
        self.store = types.SimpleNamespace(get=lambda key: copy.deepcopy(self.records.get(key)))
        self.eid, self.locator = self.add_execution("a" * 32)

    def add_execution(self, token):
        execution_id, job_id = uid(), uid()
        output = {"type": "video", "filename": token + ".mp4", "subfolder": "",
                  "storage_type": "output", "url": "/api/media/" + token}
        output_id = output_identity(job_id, output)
        locator = "pc-result-" + str(uuid.uuid5(uuid.UUID(execution_id), job_id + ":" + output_id))
        manifest = {"result_id": output_id, "kind": "video", "media_type": self.mime,
                    "bytes": len(self.body), "sha256": sha(self.body), "locator": locator}
        self.records[execution_id] = {"job_id": job_id, "backend": self.backend,
                                      "receipt": {"provider_state": "succeeded", "results": [manifest]}}
        self.app.jobs[job_id] = {"id": job_id, "backend": self.backend,
                               "status": "completed", "outputs": [output]}
        self.app.media[token] = (self.backend, {"type": "output", "filename": output["filename"], "subfolder": ""})
        return execution_id, locator

    def test_existing_other_execution_cannot_read_opaque_locator(self):
        other_id, other_locator = self.add_execution("b" * 32)
        with patch("frameweave.hub_results.Backend") as backend:
            for execution_id, locator in ((self.eid, other_locator), (other_id, self.locator)):
                with self.subTest(execution=execution_id), self.assertRaisesRegex(ContractError, "result_locator_unknown"):
                    read_result(self.store, self.app, execution_id, locator)
            backend.assert_not_called()

    def test_scope_and_registration_changes_fail_before_read(self):
        job = self.app.jobs[self.records[self.eid]["job_id"]]
        with patch("frameweave.hub_results.Backend") as backend:
            job["backend"] = "http://127.0.0.1:8189"
            with self.assertRaisesRegex(ContractError, "output_job_scope"):
                read_result(self.store, self.app, self.eid, self.locator)
            job["backend"] = self.backend
            self.app.media["a" * 32][1]["filename"] = "foreign.mp4"
            with self.assertRaisesRegex(ContractError, "output_unregistered"):
                read_result(self.store, self.app, self.eid, self.locator)
            backend.assert_not_called()

    def test_invalid_and_over_cap_limits_do_not_read(self):
        with patch("frameweave.hub_results.Backend") as backend:
            for limit in (True, 1.0, 0, -1, 64 * 1024 * 1024 + 1, len(self.body) - 1):
                with self.subTest(limit=limit), self.assertRaisesRegex(ContractError, "result_read_limit"):
                    read_result(self.store, self.app, self.eid, self.locator, max_bytes=limit)
            backend.assert_not_called()

    def test_exact_manifest_limit_hash_and_media_type_control_return(self):
        class Stream(io.BytesIO):
            status = 200

            def __init__(self, body, mime):
                super().__init__(body)
                self.headers = {"Content-Type": mime}
                self.read_sizes = []

            def read1(self, size):
                self.read_sizes.append(size)
                return self.read(size)

        with patch("frameweave.hub_results.Backend") as backend:
            open_output = backend.return_value.opener.open
            stream = Stream(self.body, self.mime)
            open_output.return_value = stream
            result = read_result(self.store, self.app, self.eid, self.locator, max_bytes=64 * 1024 * 1024)
            self.assertEqual(result["data"], self.body)
            self.assertLessEqual(max(stream.read_sizes), len(self.body) + 1)
            self.assertEqual(open_output.call_args.args[0].get_header("Accept-encoding"), "identity")
            for body, mime in ((self.body[:-1], self.mime), (b"x" * len(self.body), self.mime),
                               (self.body + b"x", self.mime), (self.body, "image/png")):
                open_output.return_value = Stream(body, mime)
                with self.subTest(body_bytes=len(body), mime=mime), self.assertRaisesRegex(ContractError, "result_content_changed"):
                    read_result(self.store, self.app, self.eid, self.locator)


if __name__ == "__main__":
    unittest.main()
