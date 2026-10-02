"""Explicitly driven worker candidate; no discovery loop or automatic opt-in.

One step holds a per-execution file lock, never a database transaction over network
I/O. Native submission is attempted once. Every recovery asks the original request.
"""

import copy
from urllib.parse import quote

from . import automation
from .backend import BackendError
from .hub_execution_contract import (TERMINAL, canonical, fail, identity,
                                     observation_matches)
from .hub_results import owned_manifest
from .job_lifecycle import has_terminal_evidence, history_outcome


class NativeApp:
    """Narrow facade over existing Prism ownership, compilation and submission ledger."""

    def __init__(self, app):
        self.app = app

    def check_backend(self, backend):
        if self.app.backend.url != backend:
            fail("native_backend_changed")

    def submit(self, request_id, request, backend):
        with self.app.lock:
            self.check_backend(backend)
            return automation.generate(self.app, request_id, request)

    def query(self, request_id, backend):
        result = automation.request_status(self.app, request_id)
        job = result.get("job")
        if job and job.get("backend") != backend:
            fail("native_job_scope")
        # Old native job records also use failed for missing queue/history. This is
        # not proof of failure. Require an actual original-backend error history.
        if job and job.get("status") in {"failed", "cancelled"} and not has_terminal_evidence(job):
            with self.app.lock:
                self.check_backend(backend)
                history = self.app.backend.request("/history/" + quote(job["id"], safe=""), timeout=5)
            entry = history.get(job["id"], {}) if isinstance(history, dict) else {}
            # A legacy cancelled record may actually have completed naturally.
            outcome = history_outcome(job["id"], entry)
            job["status"] = outcome if outcome in {"failed", "cancelled"} else "unknown"
        return result

    def cancel(self, job_id, backend):
        with self.app.lock:
            self.check_backend(backend)
            job = self.app.jobs.get(job_id)
            if not job or job.get("backend") != backend:
                fail("native_job_scope")
        # The same durable intent and original-job terminal evidence apply to
        # canvas, studio, MCP and the Hub worker. Never hold the app lock over I/O.
        return self.app.cancel(job_id)

    def results(self, execution_id, job_id, backend):
        return owned_manifest(self.app, execution_id, job_id, backend)


class Worker:
    def __init__(self, store, hub, native, capabilities):
        self.store, self.hub, self.native = store, hub, native
        self.binding = copy.deepcopy(hub.binding)
        # Deep-copy local approvals so caller mutations cannot switch a queued run.
        self.capabilities = {cap.capability_id: copy.deepcopy(cap) for cap in capabilities}

    def _verify(self, value, execution_id, expected=None):
        stable = identity(value, self.binding, execution_id)
        if expected is not None and stable != expected:
            fail("execution_identity_changed")
        return stable

    def _summary(self, execution_id, state, *, reason=None):
        # No raw Hub task, paths, input, lease, model list or media URLs escape here.
        result = {"execution_id": execution_id, "state": state}
        if reason:
            result["reason"] = reason
        return result

    def _flush(self, execution_id):
        record = self.store.get(execution_id)
        observation = record["observation"]
        if observation:
            receipt = self.hub.observe(execution_id, record["claim"]["lease_token"], observation)
            self._verify(receipt, execution_id, record["identity"])
            observation_matches(receipt, observation)
            self.store.ack_observation(execution_id, observation["observation_id"], receipt)
        return self.store.get(execution_id)

    def _observe(self, execution_id, state, **extra):
        record = self.store.get(execution_id)
        payload = dict(provider_state=state, provider_request_id=record["provider_request_id"], results=[], **extra)
        if record.get("last_observation"):
            previous = {k: v for k, v in record["last_observation"].items() if k != "observation_id"}
            if previous == payload:
                return record
        self.store.queue_observation(execution_id, payload)
        return self._flush(execution_id)

    def _finish(self, execution_id):
        record = self.store.get(execution_id)
        receipt = record["receipt"]
        if not receipt or receipt["provider_state"] not in TERMINAL:
            fail("terminal_receipt_required")
        content = {key: receipt[key] for key in ("execution_id", "provider_state", "provider_request_id",
                                                 "results", "results_manifest_sha256", "outcome")}
        content["evidence"] = "PrismCanvas worker observation; Hub does not verify native execution."
        payload = {"task_id": receipt["queue_task_id"], "client_id": self.binding["client_id"],
                   "submission_id": record["report_submission_id"], "category": "report",
                   "title": "PrismCanvas execution result", "filename": "prismcanvas-execution.md",
                   "content": "# PrismCanvas execution result\n\n```json\n" + canonical(content).decode() + "\n```\n",
                   "memory_candidates": []}
        self.store.save_report(execution_id, payload)
        if not record["reported"]:
            report = self.hub.report(payload, record["claim"]["lease_token"])
            if (report.get("submission_id") != record["report_submission_id"]
                    or report.get("memory_candidate_count") != 0):
                fail("report_receipt_mismatch")
            self.store.mark_reported(execution_id)
        finished = self.hub.finish(receipt["queue_task_id"], self.binding["client_id"], record["claim"]["lease_token"])
        if finished.get("id") != receipt["queue_task_id"] or finished.get("status") != "completed":
            fail("finish_receipt_mismatch")
        self.store.mark_finished(execution_id)
        return self._summary(execution_id, "completed")

    def step(self, execution_id):
        with self.store.execution_lock(execution_id):
            self.hub.describe()  # Transport validates authority, epoch, workspace, and local identity.
            remote = self.hub.status(execution_id)
            stable = self._verify(remote, execution_id)
            record = self.store.get(execution_id)
            if record:
                self._verify(remote, execution_id, record["identity"])
                if record["finished"]:
                    if remote.get("dispatch_state") != "completed":
                        fail("hub_ledger_reverted")
                    observation_matches(remote, record["last_observation"])
                    return self._summary(execution_id, "completed")
                if remote.get("dispatch_state") == "completed":
                    # Finish response may have been lost after the report was persisted.
                    if not record["reported"] or not record.get("last_observation"):
                        fail("unexpected_remote_completion")
                    observation_matches(remote, record["last_observation"])
                    self.store.mark_finished(execution_id)
                    return self._summary(execution_id, "completed")
            elif remote.get("provider_state") != "not_started":
                return self._summary(execution_id, "not_owned")
            elif remote.get("dispatch_state") != "queued_ready":
                return self._summary(execution_id, "waiting_for_hub")
            capability = self.capabilities.get(remote["capability_id"])
            if (not record or not record.get("claim")) and not capability:
                fail("capability_disabled")
            record = self.store.reserve(execution_id, stable)
            claim = self.hub.claim(execution_id, record["claim_request_id"])
            self._verify(claim, execution_id, stable)
            if not record.get("claim"):
                request, backend = capability.prepare(claim)
            else:
                # Frozen inputs/declaration are checked by store; continued observation
                # does not require a currently published capability or new settings.
                request, backend = record["native_request"], record["backend"]
            self.store.save_claim(execution_id, claim, request, backend)
            record = self._flush(execution_id)
            if record["receipt"] and record["receipt"]["provider_state"] in TERMINAL:
                return self._finish(execution_id)
            if not record["receipt"]:
                record = self._observe(execution_id, "submitting")
            latest = self.hub.status(execution_id)
            self._verify(latest, execution_id, stable)
            # Detect changed Hub ledgers or another actor with the same worker credentials.
            observation_matches(latest, record["last_observation"])
            if not record["native_attempted"]:
                if latest.get("cancel_requested"):
                    self._observe(execution_id, "cancelled", cancel_evidence={
                        "kind": "never_submitted", "reference": record["provider_request_id"]})
                    return self._finish(execution_id)
                # A switched backend leaves the intent unsubmitted and recoverable.
                self.native.check_backend(backend)
                if self.store.begin_native(execution_id):
                    try:
                        job = self.native.submit(record["provider_request_id"], request, backend)
                        if job.get("backend") != backend or not job.get("id"):
                            fail("native_submit_scope")
                        self.store.save_job(execution_id, job["id"])
                    except automation.SubmissionRejected:
                        self._observe(execution_id, "failed", error_code="native_preflight_rejected")
                        return self._finish(execution_id)
                    except (OSError, ValueError, BackendError):
                        # It may already have been accepted; never submit it again.
                        self._observe(execution_id, "uncertain")
                        return self._summary(execution_id, "uncertain", reason="query_original_request")
            record = self.store.get(execution_id)
            try:
                query = self.native.query(record["provider_request_id"], backend)
            except (OSError, ValueError, BackendError):
                query = {}
            job = query.get("job") if query.get("state") == "accepted" else None
            if not job:
                self._observe(execution_id, "uncertain")
                return self._summary(execution_id, "uncertain", reason="query_original_request")
            if job.get("backend") != backend or not job.get("id"):
                fail("native_job_scope")
            self.store.save_job(execution_id, job["id"])
            state = job.get("status")
            if latest.get("cancel_requested") and state not in {"completed", "failed", "cancelled"}:
                try:
                    cancelled = self.native.cancel(job["id"], backend)
                    if cancelled.get("id") == job["id"] and cancelled.get("status") == "cancelled":
                        state = "cancelled"
                except (OSError, ValueError, BackendError):
                    pass  # Requested is not confirmed; no global interrupt or false terminal.
            if state == "completed":
                try:
                    results = self.native.results(execution_id, job["id"], backend)
                    if not results:
                        fail("results_not_verifiable")
                except (OSError, ValueError, BackendError):
                    self._observe(execution_id, "uncertain")
                    return self._summary(execution_id, "uncertain", reason="results_not_verifiable")
                # Freeze results before the first network attempt; outbox replay cannot rehash changed bytes.
                payload = {"provider_state": "succeeded", "provider_request_id": record["provider_request_id"],
                           "results": results}
                self.store.queue_observation(execution_id, payload)
                self._flush(execution_id)
            elif state == "failed":
                self._observe(execution_id, "failed", error_code="native_execution_failed")
            elif state == "cancelled":
                self._observe(execution_id, "cancelled", cancel_evidence={
                    "kind": "native_terminal", "reference": record["provider_request_id"]})
            else:
                state = "running" if state in {"queued", "running"} else "uncertain"
                self._observe(execution_id, state)
                return self._summary(execution_id, state)
            return self._finish(execution_id)
