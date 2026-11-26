import copy
import hashlib
import io
import json
import tempfile
import threading
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from frameweave.hub_execution import NativeApp, Worker
from frameweave.hub_execution_contract import (ContractError, EnabledCapability, canonical,
                                               sha, strict_json, validate_inputs)
from frameweave.hub_execution_store import WorkerStore
from frameweave.hub_execution_transport import HubTransport, HubRejected
from frameweave.hub_results import owned_manifest, read_result, result_manifest
from frameweave.server import App
from test_hub_execution import DECLARATION, FakeHub, uid
from test_service import MockComfy


class ContractTests(unittest.TestCase):
    def test_strict_json_boundaries(self):
        for raw in ('{"a":1,"a":2}', 'NaN', '1e9999', '"\\ud800"', '[]' * 9000, '[' * 34 + '0' + ']' * 34):
            with self.subTest(case=raw[:20]), self.assertRaises(ContractError): strict_json(raw)

    def test_schema_unknown_fields_and_unsupported_constraints(self):
        schema = {"type": "object", "properties": {"prompt": {"type": "string"}}, "required": ["prompt"]}
        for value in ({}, {"prompt": 4}, {"prompt": "ok", "url": "ignored"}):
            with self.assertRaises(ContractError): validate_inputs(value, schema)
        with self.assertRaisesRegex(ContractError, "unsupported_input_schema"):
            validate_inputs("word", {"type": "string", "pattern": "[a-z]+"})

    def test_boolean_is_not_number(self):
        with self.assertRaises(ContractError): validate_inputs(True, {"type": "integer"})

    def test_binding_cannot_change_graph_or_backend(self):
        hub = FakeHub()
        claim = dict(hub.receipt, input_json=hub.raw, declaration_text=DECLARATION)
        for path in (["kind"], ["backend"], ["package_id"], ["prompt", "1"]):
            cap = EnabledCapability("b" * 32, DECLARATION, "http://127.0.0.1:8188",
                                    {"kind": "package", "package_id": "p-fixed"}, {"text": path})
            with self.assertRaises(ContractError): cap.prepare(claim)

    def test_raw_whitespace_digest_distinct(self):
        self.assertNotEqual(sha(b'{"a":1}'), sha(b'{ "a": 1 }'))
        self.assertEqual(strict_json('{"a":1}'), strict_json('{ "a": 1 }'))

    def test_package_scalar_binding_keeps_identity(self):
        hub = FakeHub()
        cap = EnabledCapability("b" * 32, DECLARATION, "http://127.0.0.1:8188",
                                {"kind": "package", "package_id": "p-fixed", "values": {"text": "old"}},
                                {"text": ["values", "text"]})
        cap = hub.approve(cap)
        request, backend = cap.prepare(dict(hub.receipt, input_json=hub.raw, declaration_text=cap.declaration_text))
        self.assertEqual(request["values"], {"text": "test image"})
        self.assertEqual(request["package_id"], "p-fixed")
        self.assertEqual(cap.template["values"], {"text": "old"})


class Stream(io.BytesIO):
    def __init__(self, content=b"image", mime="image/png", length=None, status=200):
        super().__init__(content)
        self.headers = {"Content-Type": mime, "Content-Length": str(len(content)) if length is None else length}
        self.status = status


class ResultsTests(unittest.TestCase):
    def setUp(self):
        self.eid = uid()
        self.outputs = [{"output_id": "o-" + "b" * 64, "type": "image"},
                        {"output_id": "o-" + "a" * 64, "type": "image"}]

    def test_order_hash_and_locator_stable(self):
        first = result_manifest(self.eid, "job-one", self.outputs, lambda _: Stream())
        second = result_manifest(self.eid, "job-one", list(reversed(self.outputs)), lambda _: Stream())
        self.assertEqual(first, second)
        self.assertEqual(first[0]["bytes"], 5)
        self.assertEqual(first[0]["sha256"], hashlib.sha256(b"image").hexdigest())
        self.assertTrue(first[0]["locator"].startswith("pc-result-"))
        self.assertNotEqual(first[0]["locator"], result_manifest(uid(), "job-one", self.outputs, lambda _: Stream())[0]["locator"])

    def test_mime_mismatch_empty_truncated_partial_and_oversize_rejected(self):
        factories = [lambda _: Stream(mime="video/mp4"), lambda _: Stream(b""),
                     lambda _: Stream(length="6"), lambda _: Stream(status=206),
                     lambda _: Stream(length="9999999999"), lambda _: Stream(length="-1")]
        for factory in factories:
            with self.assertRaises(ContractError): result_manifest(self.eid, "job", self.outputs, factory)

    def test_chunked_body_bounded_even_without_content_length(self):
        def open_stream(_):
            stream = Stream(b"a" * 100)
            stream.headers.pop("Content-Length")
            return stream
        with self.assertRaisesRegex(ContractError, "output_size_limit"):
            result_manifest(self.eid, "job", self.outputs, open_stream, limit=10)

    def test_duplicate_outputs_and_timeout_rejected(self):
        with self.assertRaises(ContractError):
            result_manifest(self.eid, "job", [self.outputs[0]] * 2, lambda _: Stream())
        with self.assertRaisesRegex(ContractError, "output_time_limit"):
            result_manifest(self.eid, "job", self.outputs, lambda _: Stream(), seconds=-1)


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.comfy = MockComfy()
        self.addCleanup(self.comfy.stop)
        self.app = App(self.root / "native", self.root / "web", self.comfy.url)
        self.addCleanup(self.app.closed.set)
        ensure = patch.object(self.app.progress, "ensure")
        ensure.start()
        self.addCleanup(ensure.stop)
        package = self.app.packages.save({"name": "Synthetic output", "prompt": {
            "1": {"class_type": "TestOutput", "inputs": {"text": "test"}}}, "fields": [
                {"id": "text", "node_id": "1", "input": "text", "type": "text", "label": "Text",
                 "default": "test", "required": True}]})
        self.hub = FakeHub()
        self.eid = self.hub.receipt["execution_id"]
        self.cap = EnabledCapability("b" * 32, DECLARATION, self.comfy.url,
                                     {"kind": "package", "package_id": package["id"], "values": {"text": ""}},
                                     {"text": ["values", "text"]})
        self.cap = self.hub.approve(self.cap)
        self.native = NativeApp(self.app)
        self.store = WorkerStore(self.root / "worker.sqlite3", self.hub.binding)
        self.worker = Worker(self.store, self.hub, self.native, [self.cap])

    def complete(self):
        self.worker.step(self.eid)
        job_id = self.store.get(self.eid)["job_id"]
        self.comfy.pending.clear()
        self.comfy.history[job_id] = {"status": {"completed": True}, "outputs": {
            "1": {"videos": [{"filename": "result.mp4", "type": "output", "subfolder": ""}]}}}
        self.app.update_jobs()
        return job_id

    def test_actual_native_compile_ledger_and_registered_stream(self):
        self.complete()
        self.assertEqual(self.worker.step(self.eid)["state"], "completed")
        self.assertEqual(len([c for c in self.comfy.calls if c[:2] == ("POST", "/prompt")]), 1)
        result = self.hub.receipt["results"][0]
        self.assertEqual(result["bytes"], len(self.comfy.content))
        self.assertEqual(result["sha256"], sha(self.comfy.content))
        self.assertEqual(result["kind"], "video")

    def test_missing_native_history_is_uncertain_not_failed(self):
        self.worker.step(self.eid)
        record = self.store.get(self.eid)
        self.app.jobs[record["job_id"]]["status"] = "failed"
        query = self.native.query(record["provider_request_id"], self.comfy.url)
        self.assertEqual(query["job"]["status"], "unknown")
        self.comfy.history[record["job_id"]] = {"status": {"status_str": "error"}}
        query = self.native.query(record["provider_request_id"], self.comfy.url)
        self.assertEqual(query["job"]["status"], "failed")

    def test_foreign_backend_and_unregistered_media_do_not_stream(self):
        job_id = self.complete()
        with self.assertRaises(ContractError): owned_manifest(self.app, self.eid, job_id, "http://127.0.0.1:1")
        self.app.media.clear()
        with self.assertRaises(ContractError): owned_manifest(self.app, self.eid, job_id, self.comfy.url)
        self.assertFalse(any(call[:2] == ("GET", "/view") for call in self.comfy.calls))

    def test_read_result_opaque_locator_actual_bytes_and_changes(self):
        self.complete()
        self.worker.step(self.eid)
        locator = self.hub.receipt["results"][0]["locator"]
        value = read_result(self.store, self.app, self.eid, locator)
        self.assertEqual(value["data"], self.comfy.content)
        self.assertEqual(value["sha256"], sha(value["data"]))
        with self.assertRaises(ContractError): read_result(self.store, self.app, self.eid, "../result.mp4")
        with self.assertRaises(ContractError): read_result(self.store, self.app, uid(), locator)
        with self.assertRaises(ContractError): read_result(self.store, self.app, self.eid, locator, max_bytes=1)
        self.comfy.content = b"changed" + self.comfy.content[7:]
        with self.assertRaisesRegex(ContractError, "result_content_changed"):
            read_result(self.store, self.app, self.eid, locator)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.response = {}
        self.code = 200
        fixture = self
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self): self.reply()
            def do_POST(self): self.reply()
            def reply(self):
                size = int(self.headers.get("Content-Length", "0"))
                fixture.requests.append((self.path, self.headers.get("Authorization"), self.rfile.read(size)))
                raw = json.dumps(fixture.response).encode()
                self.send_response(fixture.code)
                if fixture.code == 302: self.send_header("Location", "http://127.0.0.1:1/never-follow")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.grant = {"schema": "ai-hub-execution-grant/1", "protocol": "aihub-execution/1",
                      "role": "worker", "subject": "test-worker", "grant_id": uid(), "token": "a" * 43,
                      "workspace_root": str(Path.cwd()), "workspace_binding_revision": "b" * 64,
                      "execution_authority_id": uid(), "ledger_epoch": uid(), "connection": {
                          "scheme": "http", "host": "127.0.0.1", "port": self.server.server_address[1],
                          "app": "ai-hub", "install_root": str(Path.cwd()), "service_instance_id": uuid.uuid4().hex,
                          "connection_revision": "c" * 64, "control_protocol": "ai-hub-local-control-v1"}}

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def test_redirect_refused_no_error_body_leak(self):
        self.code, self.response = 302, {"error": "private credential text"}
        with self.assertRaisesRegex(HubRejected, "^hub_http_302$"):
            HubTransport(self.grant).status(uid())
        self.assertEqual(len(self.requests), 1)

    def test_worker_grant_scope_and_endpoint(self):
        for field, value in (("role", "source"), ("token", "bad\nheader")):
            grant = copy.deepcopy(self.grant)
            grant[field] = value
            with self.assertRaises(ContractError): HubTransport(grant)
        grant = copy.deepcopy(self.grant)
        grant["connection"]["host"] = "example.com"
        with self.assertRaises(ContractError): HubTransport(grant)
        self.assertEqual(self.requests, [])

    def test_credential_only_in_execution_header(self):
        hub = HubTransport(self.grant)
        hub.status(uid())
        hub.report({"task_id": uid(), "memory_candidates": []}, "test-lease")
        self.assertEqual(self.requests[0][1], "Bearer " + self.grant["token"])
        self.assertNotIn(self.grant["token"].encode(), self.requests[0][2])
        self.assertIsNone(self.requests[1][1])

    def test_descriptor_epoch_and_workspace_cannot_drift(self):
        hub = HubTransport(self.grant)
        remote = dict(self.grant["connection"], status="available")
        value = {"protocol": "aihub-execution/1", "schema_version": 1, "identity": remote,
                 "workspace": {"status": "available", "binding_revision": self.grant["workspace_binding_revision"]},
                 "workspace_root": self.grant["workspace_root"], "connection_revision": "d" * 64,
                 "execution_authority_id": self.grant["execution_authority_id"], "ledger_epoch": self.grant["ledger_epoch"]}
        hub.validate_descriptor(value)
        remote["service_instance_id"] = uuid.uuid4().hex
        hub.validate_descriptor(value)
        value["ledger_epoch"] = uid()
        with self.assertRaises(ContractError): hub.validate_descriptor(value)


if __name__ == "__main__":
    unittest.main()
