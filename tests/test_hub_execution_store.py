"""Private worker journal tests. No Hub, HTTP listener, or native generation."""

import copy
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from frameweave import hub_execution_store as module
from frameweave.hub_execution_store import StoreBusy, StoreError, WorkerStore


def new_id():
    return str(uuid.uuid4())


class WorkerStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "worker.sqlite3"
        self.binding = {"execution_authority_id": new_id(), "ledger_epoch": new_id(),
                        "workspace_binding_revision": "a" * 64, "client_id": "prism-worker"}
        self.execution_id = new_id()
        self.identity = {"protocol": "aihub-execution/1", "execution_id": self.execution_id,
                         **{key: value for key, value in self.binding.items() if key != "client_id"},
                         "request_id": new_id(), "queue_task_id": new_id(),
                         "origin": {"authority_id": "source", "run_id": "run"},
                         "executor": {"client_id": self.binding["client_id"], "tool": "fw_generate"},
                         "input_sha256": "b" * 64, "capability_id": "c" * 32, "declaration_sha256": "d" * 64}
        self.store = WorkerStore(self.path, self.binding)
        self.addCleanup(self.store.close)
        self.claim_id = new_id()

    def reserve(self):
        return self.store.reserve(self.execution_id, self.identity)

    def claim(self, **changes):
        self.reserve()
        claim = {**copy.deepcopy(self.identity), "lease_token": "private-lease-not-for-output",
                 "lease_rotated": False, "provider_state": "not_started", "cancel_requested": False,
                 "task": {"id": self.identity["queue_task_id"], "updated_at": 1,
                          "report_contract": {"claim_id": self.claim_id}},
                 "input_json": '{ "positive": "灯光", "seed": 42 }\n',
                 "declaration_text": '{"tool":"fw_generate"}'}
        claim.update(changes)
        self.store.save_claim(self.execution_id, claim, {"kind": "sdxl", "positive": "灯光", "seed": 42}, "http://127.0.0.1:8188")
        return claim

    def observation(self, state="submitting", **extra):
        return {"provider_state": state, "provider_request_id": self.store.get(self.execution_id)["provider_request_id"],
                "results": [], **extra}

    def ack(self, payload):
        pending = self.store.queue_observation(self.execution_id, payload)
        receipt = {**copy.deepcopy(self.identity), **copy.deepcopy(payload), "cancel_requested": False}
        if "error_code" in receipt or "cancel_evidence" in receipt:
            receipt["outcome"] = {key: receipt.pop(key) for key in ("error_code", "cancel_evidence") if key in receipt}
        self.store.ack_observation(self.execution_id, pending["observation_id"], receipt)
        return pending, receipt

    def submitted(self):
        self.claim()
        pending, receipt = self.ack(self.observation())
        self.assertTrue(self.store.begin_native(self.execution_id))
        return pending, receipt

    def success(self):
        self.submitted()
        return self.ack(self.observation("succeeded", results=[{"result_id": "result-one", "kind": "image",
                         "media_type": "image/png", "bytes": 64, "locator": "pc-result-one", "sha256": "e" * 64}]))

    def test_reserve_full_identity_stable_ids_and_defensive_copies(self):
        first = self.reserve()
        again = self.store.reserve(self.execution_id, dict(reversed(list(self.identity.items()))))
        self.assertEqual(first, again)
        for key in ("claim_request_id", "provider_request_id", "report_submission_id"):
            self.assertEqual(str(uuid.UUID(first[key])), first[key])
        first["identity"]["origin"]["run_id"] = "mutated"
        self.assertEqual(self.store.get(self.execution_id)["identity"], self.identity)
        exposed = self.store.binding
        exposed["client_id"] = "not-persisted"
        self.assertEqual(self.store.binding, self.binding)
        self.assertIsNone(self.store.get(new_id()))

    def test_concurrent_reserve_returns_one_atomic_identity(self):
        def reserve(_):
            with WorkerStore(self.path, self.binding) as store:
                return store.reserve(self.execution_id, self.identity)
        with ThreadPoolExecutor(max_workers=8) as pool:
            records = list(pool.map(reserve, range(20)))
        self.assertTrue(all(record == records[0] for record in records))
        with closing(sqlite3.connect(self.path)) as db, db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM executions").fetchone()[0], 1)

    def test_concurrent_first_open_publishes_only_a_complete_database(self):
        target = self.path.with_name("simultaneous.sqlite3")
        def open_store(_):
            with WorkerStore(target, self.binding) as store:
                return store.reserve(self.execution_id, self.identity)
        with ThreadPoolExecutor(max_workers=6) as pool:
            records = list(pool.map(open_store, range(12)))
        self.assertTrue(all(record == records[0] for record in records))
        self.assertEqual(list(self.path.parent.glob(".hub-worker-*.tmp")), [])

    def test_identity_changes_including_boolean_number_are_not_equal(self):
        self.reserve()
        for mutate in (lambda value: value["origin"].update(run_id="other"),
                       lambda value: value.update(title="new"), lambda value: value["executor"].update(client_id="other")):
            changed = copy.deepcopy(self.identity)
            mutate(changed)
            with self.assertRaises(StoreError):
                self.store.reserve(self.execution_id, changed)
        other_id = new_id()
        self.store.reserve(other_id, {"x": 1})
        with self.assertRaises(StoreError):
            self.store.reserve(other_id, {"x": True})

    def test_close_reopen_preserves_all_ids_and_unknown_is_none(self):
        claim = self.claim()
        pending = self.store.queue_observation(self.execution_id, self.observation())
        before = self.store.get(self.execution_id)
        self.store.close()
        with self.assertRaises(StoreError):
            self.store.get(self.execution_id)
        with WorkerStore(self.path, self.binding) as store:
            self.assertEqual(store.get(self.execution_id), before)
            self.assertEqual(store.get(self.execution_id)["claim"]["input_json"], claim["input_json"])
            self.assertEqual(store.get(self.execution_id)["observation"], pending)

    def test_binding_mismatch_never_rewrites_file(self):
        self.reserve()
        before = self.path.read_bytes()
        for key in self.binding:
            changed = {**self.binding, key: "different"}
            with self.assertRaises(StoreError):
                WorkerStore(self.path, changed)
            self.assertEqual(self.path.read_bytes(), before)

    def test_empty_garbage_and_unknown_database_are_not_initialized(self):
        for data in (b"", b"not a database\0private-value"):
            target = self.path.with_name(new_id() + ".db")
            target.write_bytes(data)
            with self.assertRaises(StoreError) as error:
                WorkerStore(target, self.binding)
            self.assertEqual(target.read_bytes(), data)
            self.assertNotIn("private-value", str(error.exception))
        target = self.path.with_name("unknown.db")
        with closing(sqlite3.connect(target)) as db, db:
            db.execute("CREATE TABLE user_data(value TEXT)")
        before = target.read_bytes()
        with self.assertRaises(StoreError):
            WorkerStore(target, self.binding)
        self.assertEqual(target.read_bytes(), before)

    def test_invalid_record_shape_is_rejected_without_repair(self):
        self.reserve()
        with closing(sqlite3.connect(self.path)) as db, db:
            text = json.dumps({"lease_token": "private-corruption"})
            db.execute("UPDATE executions SET record=?, bytes=?", (text, len(text)))
        before = self.path.read_bytes()
        with self.assertRaises(StoreError) as error:
            WorkerStore(self.path, self.binding)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn("private-corruption", str(error.exception))

    def test_record_size_corruption_is_detected_by_an_already_open_store(self):
        self.reserve()
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE executions SET bytes=1")
        before = self.path.read_bytes()
        with self.assertRaises(StoreError):
            self.store.get(self.execution_id)
        with self.assertRaises(StoreError):
            self.reserve()
        self.assertEqual(self.path.read_bytes(), before)

    def test_external_removal_does_not_create_a_fresh_journal(self):
        self.reserve()
        self.path.unlink()
        with self.assertRaises(StoreError):
            self.store.get(self.execution_id)
        self.assertFalse(self.path.exists())

    def test_claim_rotation_preserves_intent_but_accepts_dynamic_task_and_provider_fields(self):
        claim = self.claim()
        rotated = copy.deepcopy(claim)
        rotated.update(lease_token="new-private-lease", lease_rotated=True, provider_state="running", cancel_requested=True)
        rotated["task"]["updated_at"] = 99
        self.store.save_claim(self.execution_id, rotated, {"seed": 42, "positive": "灯光", "kind": "sdxl"}, "http://127.0.0.1:8188")
        current = self.store.get(self.execution_id)
        self.assertEqual(current["claim"]["lease_token"], "new-private-lease")
        self.assertEqual(current["claim_guard"]["input_json"], claim["input_json"])
        self.assertFalse(current["native_attempted"])

    def test_claim_cannot_change_raw_text_native_backend_or_claim_identity(self):
        claim = self.claim()
        before = self.store.get(self.execution_id)
        for change in ("input", "declaration", "native", "backend", "task", "claim", "receipt"):
            with self.subTest(change=change):
                changed = copy.deepcopy(claim)
                native = copy.deepcopy(before["native_request"])
                backend = before["backend"]
                if change == "input": changed["input_json"] = changed["input_json"].strip()
                if change == "declaration": changed["declaration_text"] += " "
                if change == "native": native["seed"] = 43
                if change == "backend": backend = "http://127.0.0.1:8189"
                if change == "task": changed["task"]["id"] = new_id()
                if change == "claim": changed["task"]["report_contract"]["claim_id"] = new_id()
                if change == "receipt": changed["request_id"] = new_id()
                with self.assertRaises(StoreError) as error:
                    self.store.save_claim(self.execution_id, changed, native, backend)
                self.assertNotIn(claim["lease_token"], str(error.exception))
                self.assertEqual(self.store.get(self.execution_id), before)

    def test_actual_report_submission_claim_id_is_frozen_and_legacy_alias_is_compatible(self):
        claim = self.claim()
        claim["task"]["report_submission"] = claim["task"].pop("report_contract")
        native = self.store.get(self.execution_id)["native_request"]
        self.store.save_claim(self.execution_id, claim, native, "http://127.0.0.1:8188")
        claim["task"]["report_submission"]["updated_at"] = 20
        self.store.save_claim(self.execution_id, claim, native, "http://127.0.0.1:8188")
        changed = copy.deepcopy(claim)
        changed["task"]["report_submission"]["claim_id"] = new_id()
        with self.assertRaises(StoreError):
            self.store.save_claim(self.execution_id, changed, native, "http://127.0.0.1:8188")
        claim["task"]["report_contract"] = {"claim_id": new_id()}
        with self.assertRaises(StoreError):
            self.store.save_claim(self.execution_id, claim, native, "http://127.0.0.1:8188")

    def test_raw_input_utf8_limit_and_record_limits_fail_atomically(self):
        self.reserve()
        with self.assertRaises(StoreError):
            self.claim(input_json='"' + "图" * 6000 + '"')
        self.assertIsNone(self.store.get(self.execution_id)["claim"])
        with self.assertRaises(StoreError):
            self.claim(declaration_text="x" * module.MAX_RECORD_BYTES)
        self.assertIsNone(self.store.get(self.execution_id)["claim"])

    def test_capacity_does_not_delete_previous_records(self):
        first = self.reserve()
        with patch.object(module, "MAX_EXECUTIONS", 1):
            with self.assertRaises(StoreError):
                self.store.reserve(new_id(), {"intent": "new"})
        with patch.object(module, "MAX_TOTAL_BYTES", len(module._canonical(first).encode()) + len(module._canonical(self.binding).encode()) + 1):
            with self.assertRaises(StoreError):
                self.store.reserve(new_id(), {"intent": "new"})
        self.assertEqual(self.store.get(self.execution_id), first)

    def test_pending_observation_stays_same_through_reopen_and_different_payload_rejected(self):
        self.claim()
        payload = self.observation()
        first = self.store.queue_observation(self.execution_id, payload)
        with WorkerStore(self.path, self.binding) as store:
            self.assertEqual(store.queue_observation(self.execution_id, payload), first)
            with self.assertRaises(StoreError):
                store.queue_observation(self.execution_id, {**payload, "provider_state": "running"})
        payload["provider_state"] = "failed"
        first["provider_state"] = "failed"
        self.assertEqual(self.store.get(self.execution_id)["observation"]["provider_state"], "submitting")

    def test_bad_ack_does_not_clear_outbox_or_allow_native_call(self):
        self.claim()
        pending = self.store.queue_observation(self.execution_id, self.observation())
        for change in ("id", "execution", "provider", "state", "results"):
            receipt = {**self.identity, **self.observation()}
            observation_id = pending["observation_id"]
            if change == "id": observation_id = new_id()
            if change == "execution": receipt["execution_id"] = new_id()
            if change == "provider": receipt["provider_request_id"] = new_id()
            if change == "state": receipt["provider_state"] = "running"
            if change == "results": receipt["results"] = [{"result_id": "wrong"}]
            with self.assertRaises(StoreError):
                self.store.ack_observation(self.execution_id, observation_id, receipt)
            self.assertEqual(self.store.get(self.execution_id)["observation"], pending)
            with self.assertRaises(StoreError):
                self.store.begin_native(self.execution_id)

    def test_old_ack_is_idempotent_and_cannot_clear_the_next_pending_observation(self):
        old, receipt = self.submitted()
        pending = self.store.queue_observation(self.execution_id, self.observation("running"))
        repeated = {**receipt, "cancel_requested": True, "dispatch_state": "active"}
        self.assertEqual(self.store.ack_observation(self.execution_id, old["observation_id"], repeated), receipt)
        self.assertEqual(self.store.get(self.execution_id)["observation"], pending)

    def test_begin_native_once_across_competing_instances_and_restart(self):
        self.claim()
        with self.assertRaises(StoreError):
            self.store.begin_native(self.execution_id)
        self.ack(self.observation())
        def begin(_):
            with WorkerStore(self.path, self.binding) as store:
                return store.begin_native(self.execution_id)
        with ThreadPoolExecutor(max_workers=8) as pool:
            attempted = list(pool.map(begin, range(16)))
        self.assertEqual(attempted.count(True), 1)
        with WorkerStore(self.path, self.binding) as store:
            self.assertFalse(store.begin_native(self.execution_id))
            self.assertTrue(store.get(self.execution_id)["native_attempted"])

    def test_separate_processes_share_reserved_identity_and_only_one_native_attempt(self):
        self.claim()
        self.ack(self.observation())
        script = """
import json, sys
from frameweave.hub_execution_store import WorkerStore
with WorkerStore(sys.argv[1], json.loads(sys.argv[2])) as store:
    record = store.reserve(sys.argv[3], json.loads(sys.argv[4]))
    print(json.dumps({'claim_request_id': record['claim_request_id'],
                      'provider_request_id': record['provider_request_id'],
                      'attempt': store.begin_native(sys.argv[3])}))
"""
        command = [sys.executable, "-c", script, str(self.path), json.dumps(self.binding), self.execution_id, json.dumps(self.identity)]
        processes = [subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(3)]
        try:
            results = []
            for process in processes:
                out, err = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, err)
                results.append(json.loads(out))
            self.assertEqual(sum(result["attempt"] for result in results), 1)
            self.assertEqual(len({result["claim_request_id"] for result in results}), 1)
            self.assertEqual(len({result["provider_request_id"] for result in results}), 1)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=10)

    def test_job_id_is_immutable(self):
        self.submitted()
        first = self.store.save_job(self.execution_id, "native-job")
        self.assertEqual(self.store.save_job(self.execution_id, "native-job"), first)
        with self.assertRaises(StoreError):
            self.store.save_job(self.execution_id, "another-native-job")

    def test_terminal_results_cannot_change_or_regress(self):
        pending, receipt = self.success()
        payload = {key: value for key, value in pending.items() if key != "observation_id"}
        self.assertEqual(self.store.queue_observation(self.execution_id, payload), pending)
        self.assertEqual(self.store.ack_observation(self.execution_id, pending["observation_id"], receipt), receipt)
        for state in ("running", "submitting", "uncertain"):
            with self.assertRaises(StoreError):
                self.store.queue_observation(self.execution_id, self.observation(state))
        changed = copy.deepcopy(payload)
        changed["results"][0]["bytes"] += 1
        with self.assertRaises(StoreError):
            self.store.queue_observation(self.execution_id, changed)
        with self.assertRaises(StoreError):
            self.store.ack_observation(self.execution_id, pending["observation_id"], {**receipt, "results": changed["results"]})

    def test_result_reordering_is_not_a_new_success_and_outcome_is_frozen(self):
        self.submitted()
        payload = self.observation("succeeded", results=[{"result_id": "z", "bytes": 2}, {"result_id": "a", "bytes": 1}])
        pending, receipt = self.ack(payload)
        payload["results"].reverse()
        self.assertEqual(self.store.queue_observation(self.execution_id, payload), pending)
        receipt["results"].reverse()
        self.store.ack_observation(self.execution_id, pending["observation_id"], receipt)

    def test_failure_and_cancel_require_matching_evidence_and_never_contain_leases(self):
        self.submitted()
        for payload in (self.observation("failed"), self.observation("cancelled"), self.observation("succeeded"),
                        self.observation("running", error_code="wrong"), self.observation(lease_token="private-value"),
                        self.observation(["invalid-state"])):
            with self.assertRaises(StoreError) as error:
                self.store.queue_observation(self.execution_id, payload)
            self.assertNotIn("private-value", str(error.exception))
        _, receipt = self.ack(self.observation("failed", error_code="backend_failed"))
        self.assertEqual(receipt["outcome"], {"error_code": "backend_failed"})

    def test_reports_and_completion_require_terminal_and_stable_saved_body(self):
        self.claim()
        with self.assertRaises(StoreError): self.store.save_report(self.execution_id, {"body": "early"})
        with self.assertRaises(StoreError): self.store.mark_reported(self.execution_id)
        with self.assertRaises(StoreError): self.store.mark_finished(self.execution_id)
        self.ack(self.observation())
        self.store.begin_native(self.execution_id)
        self.ack(self.observation("cancelled", cancel_evidence={"kind": "native_terminal", "reference": "native-job"}))
        record = self.store.get(self.execution_id)
        payload = {"submission_id": record["report_submission_id"], "category": "cancelled", "body": "Cancelled", "memory_candidates": []}
        self.assertEqual(self.store.save_report(self.execution_id, payload), payload)
        self.assertEqual(self.store.save_report(self.execution_id, dict(reversed(list(payload.items())))), payload)
        with self.assertRaises(StoreError): self.store.save_report(self.execution_id, {**payload, "body": "different"})
        with self.assertRaises(StoreError): self.store.save_report(self.execution_id, {**payload, "lease_token": "private"})
        with self.assertRaises(StoreError): self.store.mark_finished(self.execution_id)
        self.store.mark_reported(self.execution_id)
        self.assertTrue(self.store.mark_finished(self.execution_id)["finished"])
        with WorkerStore(self.path, self.binding) as store:
            self.assertTrue(store.get(self.execution_id)["reported"])
            self.assertTrue(store.mark_finished(self.execution_id)["finished"])

    def test_failed_write_rolls_back_instead_of_consuming_native_attempt(self):
        self.claim()
        self.ack(self.observation())
        with patch.object(self.store, "_write", side_effect=OSError("private-path-or-token")):
            with self.assertRaises(StoreError) as error:
                self.store.begin_native(self.execution_id)
        self.assertNotIn("private-path-or-token", str(error.exception))
        self.assertFalse(self.store.get(self.execution_id)["native_attempted"])
        self.assertTrue(self.store.begin_native(self.execution_id))

    def test_json_invalid_and_nested_secret_data_are_bounded_without_echo(self):
        for identity in ({"bad": float("nan")}, {"bad": (1, 2)}, {"bad": {1: "x"}}, {"nested": {"token": "do-not-echo"}}):
            with self.assertRaises(StoreError) as error:
                self.store.reserve(new_id(), identity)
            self.assertNotIn("do-not-echo", str(error.exception))
        cyclic = {}
        cyclic["cycle"] = cyclic
        with self.assertRaises(StoreError): self.store.reserve(new_id(), cyclic)

    def test_cross_process_execution_lock_nonblocking_and_file_retained(self):
        script = """
import json, sys
from frameweave.hub_execution_store import WorkerStore, StoreBusy
with WorkerStore(sys.argv[1], json.loads(sys.argv[2])) as store:
    try:
        with store.execution_lock(sys.argv[3]):
            print('acquired')
    except StoreBusy:
        print('busy')
"""
        command = [sys.executable, "-c", script, str(self.path), json.dumps(self.binding), self.execution_id]
        with self.store.execution_lock(self.execution_id):
            result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=True)
            self.assertEqual(result.stdout.strip(), "busy")
            with self.assertRaises(StoreBusy):
                with self.store.execution_lock(self.execution_id): pass
        lock = self.path.with_name(self.path.name + ".locks") / (self.execution_id + ".lock")
        self.assertTrue(lock.is_file())
        before = lock.stat()
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=True)
        self.assertEqual(result.stdout.strip(), "acquired")
        self.assertEqual(lock.stat().st_ino, before.st_ino)
        self.assertTrue(lock.is_file())

    def test_execution_lock_does_not_reclassify_native_or_network_exceptions(self):
        failure = OSError("simulated-native-unknown")
        with self.assertRaises(OSError) as result:
            with self.store.execution_lock(self.execution_id):
                raise failure
        self.assertIs(result.exception, failure)
        with self.store.execution_lock(self.execution_id):
            pass

    def test_corrupt_terminal_record_is_rejected_as_store_error_without_repair(self):
        record = self.reserve()
        record["finished"] = True
        record["reported"] = True
        text = module._canonical(record)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE executions SET record=?, bytes=?", (text, len(text.encode())))
        before = self.path.read_bytes()
        with self.assertRaises(StoreError):
            WorkerStore(self.path, self.binding)
        self.assertEqual(self.path.read_bytes(), before)

    def test_connection_is_full_durable_and_transaction_is_not_held_between_calls(self):
        self.reserve()
        with self.store._connect() as db:
            self.assertEqual(db.execute("PRAGMA synchronous").fetchone()[0], 2)
            self.assertEqual(db.execute("PRAGMA busy_timeout").fetchone()[0], module.BUSY_TIMEOUT_MS)
        with closing(sqlite3.connect(self.path, timeout=.1)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            db.rollback()
        if os.name != "nt":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
