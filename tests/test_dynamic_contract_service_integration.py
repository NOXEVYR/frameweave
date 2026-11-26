"""Real loopback HTTP/launch integration with an independent CPU graph executor.

This is deliberately a synthetic backend, not ComfyUI, KJ or GPU inference. It
executes every submitted scalar/link graph rather than returning canned success.
Native compiler observations below are explicit fixture evidence; browser bridge
mapping itself is exercised separately by the native-editor JavaScript tests.
"""

import copy
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse


SOURCE = Path(__file__).resolve().parents[1]


def synthetic_schema():
    return {
        "SyntheticText": {
            "input": {"required": {"value": ["STRING"]}},
            "output": ["STRING"], "output_node": False,
        },
        "SyntheticMerge": {
            "input": {"required": {"left": ["STRING"], "right": ["STRING"],
                                    "port_count": ["INT", {"min": 2, "max": 3}]}},
            "output": ["STRING"], "output_node": False,
        },
        "SyntheticTextOutput": {
            "input": {"required": {"text": ["STRING"]}},
            "output": [], "output_node": True,
        },
        "TextSource": {
            "input": {"required": {"text": ["STRING"]}},
            "output": ["STRING"], "output_node": False,
        },
        "GenericDynamic": {
            "input": {"required": {"width": ["INT"]}},
            "output": [], "output_node": True,
        },
    }


def synthetic_prompt(c="C", *, dynamic=True):
    prompt = {
        "1": {"class_type": "SyntheticText", "inputs": {"value": "A"}},
        "2": {"class_type": "SyntheticText", "inputs": {"value": "B"}},
        "3": {"class_type": "SyntheticText", "inputs": {"value": c}},
        "4": {"class_type": "SyntheticMerge", "inputs": {
            "left": ["1", 0], "right": ["2", 0], "port_count": 3 if dynamic else 2}},
        "5": {"class_type": "SyntheticTextOutput", "inputs": {"text": ["4", 0]}},
    }
    if dynamic:
        prompt["4"]["inputs"]["tail"] = ["3", 0]
    return prompt


def synthetic_document(c="C", *, dynamic=True):
    names = [(1, "left"), (2, "right")]
    if dynamic:
        names.append((3, "tail"))
    nodes = [{"id": n, "type": "SyntheticText", "mode": 0,
              "inputs": [], "outputs": [{"name": "text", "type": "STRING", "links": [n]}],
              "widgets_values": [value], "properties": {}}
             for n, value in ((1, "A"), (2, "B"), (3, c))]
    nodes.extend([
        {"id": 4, "type": "SyntheticMerge", "mode": 0,
         "inputs": [{"name": name, "type": "STRING", "link": n} for n, name in names],
         "outputs": [{"name": "text", "type": "STRING", "links": [4]}],
         "widgets_values": [3 if dynamic else 2], "properties": {}},
        {"id": 5, "type": "SyntheticTextOutput", "mode": 0,
         "inputs": [{"name": "text", "type": "STRING", "link": 4}],
         "outputs": [], "widgets_values": [], "properties": {}},
    ])
    return {"id": "synthetic-dynamic-strings", "version": 0.4,
            "last_node_id": 5, "last_link_id": 4, "nodes": nodes,
            "links": [[n, n, 0, 4, i, "STRING"] for i, (n, _) in enumerate(names)]
                     + [[4, 4, 0, 5, 0, "STRING"]],
            "groups": [], "config": {}, "extra": {}}


def synthetic_native_evidence():
    contract = {"version": 1, "nodes": {"4": {"class_type": "SyntheticMerge", "inputs": {
        "tail": {"type": "STRING", "accept": "link", "source": ["3", 0]},
    }}}}
    observations = {"version": 1, "nodes": {"4": {
        "class_type": "SyntheticMerge", "instance_path": ["4"], "inputs": {
            "tail": {"name": "tail", "type": "STRING", "native_slot_index": 2,
                     "workflow_slot_index": 2, "link_id": 3, "source": ["3", 0],
                     "native_source_id": "3", "native_source_slot": 0},
        },
    }}, "opaque_inputs": []}
    return contract, observations


class SyntheticCPUBackend:
    """Bounded independent executor for three known synthetic node classes."""

    def __init__(self):
        self.info = synthetic_schema()
        self.history = {}
        self.submissions = []
        self.next_id = 0
        self.prompt_attempts = 0
        state = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def reply(self, value, status=200):
                encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(encoded)
                self.close_connection = True

            def do_GET(self):
                path = urllib.parse.urlsplit(self.path).path
                if path == "/object_info":
                    self.reply(state.info)
                elif path == "/system_stats":
                    self.reply({"system": {"comfyui_version": "synthetic-cpu-v1"}, "devices": []})
                elif path == "/extensions":
                    self.reply([])
                elif path == "/queue":
                    self.reply({"queue_running": [], "queue_pending": []})
                elif path.startswith("/history/"):
                    key = urllib.parse.unquote(path.rsplit("/", 1)[-1])
                    self.reply({key: state.history[key]} if key in state.history else {})
                else:
                    self.reply({"error": "not found"}, 404)

            def do_POST(self):
                if self.path == "/prompt":
                    state.prompt_attempts += 1
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if size <= 0 or size > 2 * 1024 * 1024:
                        raise ValueError("invalid body size")
                    data = json.loads(self.rfile.read(size))
                    if self.path != "/prompt":
                        self.reply({"error": "not found"}, 404)
                        return
                    prompt = data["prompt"]
                    outputs = state.execute(prompt)
                except (ValueError, KeyError, TypeError, RecursionError) as exc:
                    self.reply({"error": str(exc), "node_errors": {"fixture": {"message": str(exc)}}}, 400)
                    return
                state.next_id += 1
                key = "cpu-job-" + str(state.next_id)
                state.submissions.append(copy.deepcopy(prompt))
                state.history[key] = {"status": {"status_str": "success", "completed": True},
                                      "outputs": outputs}
                self.reply({"prompt_id": key, "number": state.next_id, "node_errors": {}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": .02}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    @staticmethod
    def execute(prompt):
        if not isinstance(prompt, dict) or not 1 <= len(prompt) <= 20:
            raise ValueError("synthetic graph size")
        cache, visiting = {}, set()

        def resolve(value):
            if isinstance(value, list):
                if len(value) != 2 or not isinstance(value[0], str) or type(value[1]) is not int or value[1] != 0:
                    raise ValueError("invalid synthetic link")
                return node(value[0])
            if not isinstance(value, str):
                raise ValueError("synthetic executor accepts text only")
            return value

        def node(node_id):
            if node_id in cache:
                return cache[node_id]
            if node_id in visiting:
                raise ValueError("synthetic cycle")
            visiting.add(node_id)
            spec = prompt[node_id]
            inputs = spec["inputs"]
            kind = spec["class_type"]
            if kind == "SyntheticText":
                if set(inputs) != {"value"}:
                    raise ValueError("SyntheticText unknown input")
                result = resolve(inputs["value"])
            elif kind == "TextSource":
                if set(inputs) != {"text"}:
                    raise ValueError("TextSource unknown input")
                result = resolve(inputs["text"])
            elif kind == "GenericDynamic":
                if set(inputs) != {"width", "branch-z"} or type(inputs["width"]) is not int:
                    raise ValueError("GenericDynamic exact ports required")
                result = resolve(inputs["branch-z"])
            elif kind == "SyntheticMerge":
                if not {"left", "right", "port_count"} <= set(inputs) or set(inputs) - {"left", "right", "tail", "port_count"}:
                    raise ValueError("SyntheticMerge exact ports required")
                if type(inputs["port_count"]) is not int or inputs["port_count"] != (3 if "tail" in inputs else 2):
                    raise ValueError("SyntheticMerge port_count differs from exact connected ports")
                result = "|".join(resolve(inputs[name]) for name in ("left", "right", "tail") if name in inputs)
            elif kind == "SyntheticTextOutput":
                if set(inputs) != {"text"}:
                    raise ValueError("SyntheticTextOutput unknown input")
                result = resolve(inputs["text"])
            else:
                raise ValueError("unsupported synthetic class")
            visiting.remove(node_id)
            cache[node_id] = result
            return result

        return {node_id: {"text": [node(node_id)]} for node_id, spec in prompt.items()
                if spec["class_type"] in {"SyntheticTextOutput", "GenericDynamic"}}

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)


class LaunchHTTPClient:
    """Start the actual public launch.py entrypoint with source-external data."""

    def __init__(self, data, backend):
        self.data = Path(data)
        self.port = None
        self.token = None
        # Temporary data contains no private user configuration; token stays in
        # memory and is never written to stdout, fixture logs or test evidence.
        self.process = subprocess.Popen(
            [sys.executable, str(SOURCE / "launch.py"), "--port", "0", "--backend", backend,
             "--data-dir", str(self.data), "--no-browser"], cwd=SOURCE,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("formal launch exited: " + self.process.stderr.read()[:3000])
                metadata = self.data / "last-url.txt"
                if metadata.is_file():
                    self.port = urllib.parse.urlsplit(metadata.read_text()).port
                    try:
                        status, boot = self.request("GET", "/api/bootstrap")
                    except (OSError, http.client.HTTPException):
                        pass
                    else:
                        if status == 200:
                            self.token = boot["csrf"]
                            break
                time.sleep(.03)
            if not self.token:
                raise RuntimeError("formal launch bootstrap timeout")
        except BaseException:
            self.stop()
            raise

    def request(self, method, path, body=None, *, headers=None):
        outgoing = {"Host": f"127.0.0.1:{self.port}"}
        encoded = None
        if method == "POST":
            outgoing.update({"Content-Type": "application/json", "X-FW-Token": self.token or ""})
            encoded = json.dumps({} if body is None else body, ensure_ascii=False).encode("utf-8")
        outgoing.update(headers or {})
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(method, path, body=encoded, headers=outgoing)
            response = connection.getresponse()
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
        finally:
            connection.close()

    def post(self, path, body=None):
        return self.request("POST", path, body)

    def tool(self, name, arguments=None):
        status, response = self.request("POST", "/mcp", {
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        }, headers={"Authorization": "Bearer " + self.token,
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2025-11-25"})
        if status != 200:
            raise AssertionError((status, response))
        return response["result"]

    def stop(self):
        if self.process.poll() is None:
            if self.token:
                try:
                    self.post("/api/shutdown")
                    self.process.wait(timeout=4)
                except (OSError, http.client.HTTPException, subprocess.TimeoutExpired):
                    pass
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
        if self.process.stderr:
            self.process.stderr.close()


class DynamicContractLaunchIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prism-contract-cpu-")
        self.addCleanup(self.temp.cleanup)
        self.backend = SyntheticCPUBackend()
        self.addCleanup(self.backend.stop)
        self.client = LaunchHTTPClient(Path(self.temp.name) / "runtime-data", self.backend.url)
        self.addCleanup(self.client.stop)

    def ok(self, path, body=None):
        status, result = self.client.post(path, body)
        self.assertEqual(status, 200, result)
        return result

    def complete(self, job):
        result = self.ok(f"/api/jobs/{job['id']}/refresh")
        self.assertEqual(result["status"], "completed", result)
        return self.backend.history[job["id"]]["outputs"]["5"]["text"][0]

    def native_flow(self, *, c="C"):
        document, prompt = synthetic_document(c), synthetic_prompt(c)
        imported = self.ok("/api/editor-workflows", {"name": "Native synthetic dynamic strings",
                                                    "document": document})
        session = self.ok(f"/api/editor-workflows/{imported['id']}/session")
        contract, observations = synthetic_native_evidence()
        evidence = {"session_id": session["session_id"], "base_revision": imported["revision"],
                    "document": document, "prompt": prompt, "additional_inputs": contract,
                    "native_input_observations": observations, "output_nodes": ["5"]}
        return imported, evidence

    def apply_native(self, imported, evidence):
        interface = self.ok(f"/api/editor-workflows/{imported['id']}/interface", evidence)
        self.assertEqual({(field["node_id"], field["input"]) for field in interface["fields"]},
                         {("1", "value"), ("2", "value"), ("3", "value"), ("4", "port_count")})
        applied = self.ok(f"/api/editor-workflows/{imported['id']}/apply",
                          {**evidence, "fields": interface["fields"]})
        self.assertEqual(applied["package"]["additional_inputs"], evidence["additional_inputs"])
        return applied

    def test_native_additional_link_runs_three_texts_changes_c_and_replays_over_http_mcp(self):
        imported, evidence = self.native_flow()
        applied = self.apply_native(imported, evidence)
        package = applied["package"]
        request = {"kind": "package", "package_id": package["id"], "values": applied["values"],
                   "output_nodes": ["5"], "editor_backend": self.backend.url}
        compiled = self.ok("/api/compile", request)
        self.assertEqual(compiled["prompt"]["4"]["inputs"]["tail"], ["3", 0])
        mcp_compile = self.client.tool("fw_compile", {"request": request})
        self.assertFalse(mcp_compile["isError"], mcp_compile)
        self.assertEqual(mcp_compile["structuredContent"]["prompt"], compiled["prompt"])
        self.assertEqual(self.backend.prompt_attempts, 0, "data-only operations must not submit")
        job = self.ok("/api/generate", {"request_id": "native-cpu-three-texts", "request": request})
        self.assertEqual(self.complete(job), "A|B|C")
        duplicate = self.client.tool("fw_generate", {"request_id": "native-cpu-three-texts", "request": request})
        self.assertFalse(duplicate["isError"], duplicate)
        self.assertEqual(duplicate["structuredContent"]["id"], job["id"])
        self.assertEqual(self.backend.next_id, 1)

        status, loaded = self.client.request("GET", f"/api/editor-workflows/{imported['id']}")
        self.assertEqual(status, 200, loaded)
        self.assertEqual(loaded["document"], evidence["document"])
        # A fresh session/recompile after leaving the editor builds new evidence.
        self.ok("/api/editor-sessions/close", {"session_id": evidence["session_id"]})
        session = self.ok(f"/api/editor-workflows/{imported['id']}/session")
        refreshed = self.apply_native(imported, {**evidence, "session_id": session["session_id"],
                                                "base_revision": loaded["revision"]})
        self.assertEqual(refreshed["package"]["id"], package["id"])
        c_field = next(field["id"] for field in package["fields"]
                       if (field["node_id"], field["input"]) == ("3", "value"))
        changed = {**request, "values": {**request["values"], c_field: "C changed"}}
        changed_compile = self.ok("/api/compile", changed)
        self.assertEqual(changed_compile["prompt"]["3"]["inputs"]["value"], "C changed")
        changed_job = self.ok("/api/generate", {"request_id": "native-cpu-changed-c", "request": changed})
        self.assertEqual(self.complete(changed_job), "A|B|C changed")
        internal_evidence = {**evidence, "session_id": session["session_id"],
                             "base_revision": refreshed["workflow"]["revision"],
                             "document": synthetic_document("C inner"), "prompt": synthetic_prompt("C inner")}
        internal = self.apply_native(imported, internal_evidence)
        self.assertNotEqual(internal["package"]["id"], package["id"])
        internal_request = {**request, "package_id": internal["package"]["id"], "values": internal["values"]}
        internal_job = self.ok("/api/generate", {"request_id": "native-cpu-inner-c", "request": internal_request})
        self.assertEqual(self.complete(internal_job), "A|B|C inner")
        status, current = self.client.request("GET", f"/api/editor-workflows/{imported['id']}")
        self.assertEqual(status, 200, current)
        self.assertEqual(current["document"]["nodes"][2]["widgets_values"], ["C inner"])
        replay = self.client.tool("fw_retry", {"job_id": job["id"], "request_id": "native-cpu-original-replay"})
        self.assertFalse(replay["isError"], replay)
        self.assertEqual(self.complete(replay["structuredContent"]), "A|B|C")
        self.assertEqual(self.backend.submissions[0], self.backend.submissions[-1])
        exported = self.ok(f"/api/packages/{package['id']}/export")
        self.assertEqual(exported["document"]["additional_inputs"], evidence["additional_inputs"])
        serialized = json.dumps(exported)
        self.assertTrue(self.client.token not in serialized, "export contains startup secret")
        self.assertTrue(evidence["session_id"] not in serialized, "export contains editor session secret")

    def test_restart_requires_new_native_proof_then_runs_saved_package(self):
        imported, evidence = self.native_flow()
        applied = self.apply_native(imported, evidence)
        request = {"kind": "package", "package_id": applied["package"]["id"], "values": {}, "output_nodes": ["5"]}
        self.ok("/api/compile", request)
        original = self.ok("/api/generate", {"request_id": "native-cpu-before-restart", "request": request})
        self.assertEqual(self.complete(original), "A|B|C")
        self.client.stop()
        self.client = LaunchHTTPClient(Path(self.temp.name) / "runtime-data", self.backend.url)
        self.addCleanup(self.client.stop)
        status, blocked = self.client.post("/api/compile", request)
        self.assertEqual(status, 400, blocked)
        self.assertEqual(self.backend.prompt_attempts, 1)
        known = self.client.tool("fw_generate", {"request_id": "native-cpu-before-restart", "request": request})
        self.assertFalse(known["isError"], known)
        self.assertEqual(known["structuredContent"]["id"], original["id"])
        self.assertEqual(self.backend.prompt_attempts, 1)
        no_proof_retry = self.client.tool("fw_retry", {"job_id": original["id"],
                                                       "request_id": "native-cpu-restart-replay"})
        self.assertTrue(no_proof_retry["isError"], no_proof_retry)
        self.assertEqual(self.backend.prompt_attempts, 1)
        status, loaded = self.client.request("GET", f"/api/editor-workflows/{imported['id']}")
        self.assertEqual(status, 200, loaded)
        self.assertEqual(loaded["document"], evidence["document"])
        session = self.ok(f"/api/editor-workflows/{imported['id']}/session")
        self.apply_native(imported, {**evidence, "session_id": session["session_id"],
                                     "base_revision": loaded["revision"]})
        self.ok("/api/compile", request)
        job = self.ok("/api/generate", {"request_id": "native-cpu-after-restart", "request": request})
        self.assertEqual(self.complete(job), "A|B|C")
        replay = self.client.tool("fw_retry", {"job_id": original["id"],
                                              "request_id": "native-cpu-restart-replay"})
        self.assertFalse(replay["isError"], replay)
        self.assertEqual(self.complete(replay["structuredContent"]), "A|B|C")
        self.assertEqual(self.backend.submissions[0], self.backend.submissions[-1])
        again = self.client.tool("fw_retry", {"job_id": original["id"],
                                             "request_id": "native-cpu-restart-replay"})
        self.assertFalse(again["isError"], again)
        self.assertEqual(again["structuredContent"]["id"], replay["structuredContent"]["id"])
        self.assertEqual(self.backend.prompt_attempts, 3)

    def test_unknown_scalar_and_bare_sidecar_cannot_self_authorize_http_or_mcp(self):
        prompt = synthetic_prompt()
        prompt["4"]["inputs"]["tail"] = "unknown scalar"
        inspection = self.ok("/api/packages/inspect", {"document": {"prompt": prompt}})
        self.assertNotIn(("4", "tail"), {(field["node_id"], field["input"]) for field in inspection["fields"]})
        self.assertTrue(any(item["node_id"] == "4" and item["input"] == "tail"
                            for item in inspection["opaque_inputs"]), inspection)
        status, blocked = self.client.post("/api/compile", {"kind": "api", "prompt": prompt})
        self.assertEqual(status, 400, blocked)
        status, blocked = self.client.post("/api/generate", {
            "request_id": "reject-unknown-scalar", "request": {"kind": "api", "prompt": prompt}})
        self.assertEqual(status, 400, blocked)
        mcp_blocked = self.client.tool("fw_compile", {"request": {"kind": "api", "prompt": prompt}})
        self.assertTrue(mcp_blocked["isError"], mcp_blocked)

        contract, _ = synthetic_native_evidence()
        contract["provenance"] = {"kind": "native_compiled", "source_revision": 1}
        document = {"name": "Untrusted portable evidence", "prompt": synthetic_prompt(),
                    "fields": [], "additional_inputs": contract}
        raw_request = {"kind": "api", "prompt": synthetic_prompt(), "additional_inputs": contract}
        status, rejected = self.client.post("/api/compile", raw_request)
        self.assertEqual(status, 400, rejected)
        status, rejected = self.client.post("/api/generate", {"request_id": "reject-bare-api", "request": raw_request})
        self.assertEqual(status, 400, rejected)
        self.assertTrue(self.client.tool("fw_compile", {"request": raw_request})["isError"])
        http_package = self.ok("/api/packages", document)["package"]
        http_request = {"kind": "package", "package_id": http_package["id"], "values": {}}
        status, rejected = self.client.post("/api/compile", http_request)
        self.assertEqual(status, 400, rejected)
        imported = self.client.tool("fw_package_import", {"document": document})
        self.assertFalse(imported["isError"], imported)
        self.assertEqual(imported["structuredContent"]["id"], http_package["id"])
        request = {"kind": "package", "package_id": imported["structuredContent"]["id"], "values": {}}
        status, rejected = self.client.post("/api/compile", request)
        self.assertEqual(status, 400, rejected)
        self.assertTrue(self.client.tool("fw_compile", {"request": request})["isError"])
        generated = self.client.tool("fw_generate", {"request_id": "reject-bare-sidecar", "request": request})
        self.assertTrue(generated["isError"], generated)
        self.assertEqual(self.backend.prompt_attempts, 0)

    def test_stale_schema_changed_port_connection_and_backend_reject_before_submission(self):
        imported, evidence = self.native_flow()
        applied = self.apply_native(imported, evidence)
        request = {"kind": "package", "package_id": applied["package"]["id"], "values": {}}
        self.ok("/api/compile", request)
        count_field = next(field["id"] for field in applied["package"]["fields"]
                           if (field["node_id"], field["input"]) == ("4", "port_count"))
        status, rejected = self.client.post("/api/compile", {**request, "values": {count_field: 2}})
        self.assertEqual(status, 400, rejected)
        status, rejected = self.client.post("/api/generate", {
            "request_id": "reject-changed-count", "request": {**request, "values": {count_field: 2}}})
        self.assertEqual(status, 400, rejected)
        status, loaded = self.client.request("GET", f"/api/editor-workflows/{imported['id']}")
        self.assertEqual(status, 200, loaded)
        current = {**evidence, "base_revision": loaded["revision"]}
        for mutation in ("port", "connection", "observation"):
            changed = copy.deepcopy(current)
            if mutation == "port":
                changed["document"]["nodes"][3]["inputs"][2]["name"] = "tail_replaced"
            elif mutation == "connection":
                changed["prompt"]["4"]["inputs"]["tail"] = ["2", 0]
            else:
                changed["native_input_observations"]["nodes"]["4"]["inputs"]["tail"]["type"] = "INT"
            with self.subTest(mutation=mutation):
                status, rejected = self.client.post(f"/api/editor-workflows/{imported['id']}/interface", changed)
                self.assertEqual(status, 400, rejected)
        original = copy.deepcopy(self.backend.info)
        self.backend.info["SyntheticText"]["output"] = ["INT"]
        status, rejected = self.client.post("/api/compile", request)
        self.assertEqual(status, 400, rejected)
        status, rejected = self.client.post("/api/generate", {"request_id": "reject-stale-schema", "request": request})
        self.assertEqual(status, 400, rejected)
        self.backend.info = original
        other = SyntheticCPUBackend()
        self.addCleanup(other.stop)
        self.ok("/api/settings", {"backend_url": other.url})
        status, rejected = self.client.post(f"/api/editor-workflows/{imported['id']}/interface", current)
        self.assertEqual(status, 400, rejected)
        status, rejected = self.client.post("/api/compile", request)
        self.assertEqual(status, 400, rejected)
        rejected = self.client.tool("fw_generate", {"request_id": "reject-other-backend", "request": request})
        self.assertTrue(rejected["isError"], rejected)
        self.assertEqual((self.backend.prompt_attempts, other.prompt_attempts), (0, 0))

    def test_formal_launch_legacy_package_executes_and_mcp_replays_exact_saved_graph(self):
        prompt = synthetic_prompt(dynamic=False)
        inspected = self.ok("/api/packages/inspect", {"document": {"prompt": prompt}})
        package = self.ok("/api/packages", {**inspected, "name": "Legacy synthetic text"})["package"]
        request = {"kind": "package", "package_id": package["id"], "values": {}, "output_nodes": ["5"]}
        compiled = self.ok("/api/compile", request)
        self.assertNotIn("additional_inputs", package)
        self.assertEqual(compiled["prompt"]["4"]["inputs"], prompt["4"]["inputs"])
        self.assertEqual(self.backend.prompt_attempts, 0)
        job = self.ok("/api/generate", {"request_id": "legacy-cpu-original", "request": request})
        self.assertEqual(self.complete(job), "A|B")
        replay = self.client.tool("fw_retry", {"job_id": job["id"], "request_id": "legacy-cpu-replay"})
        self.assertFalse(replay["isError"], replay)
        self.assertEqual(self.complete(replay["structuredContent"]), "A|B")
        self.assertEqual(self.backend.submissions[0], self.backend.submissions[1])
        again = self.client.tool("fw_retry", {"job_id": job["id"], "request_id": "legacy-cpu-replay"})
        self.assertEqual(again["structuredContent"]["id"], replay["structuredContent"]["id"])
        self.assertEqual(self.backend.next_id, 2)

    def test_actual_native_bridge_collector_direct_and_shared_instances_run_through_http(self):
        emitter = """
import { fixture } from './helpers/native-input-contracts-harness.mjs';
const direct = (await (await fixture()).request('compile')).result;
const shared = (await (await fixture({ nested: true, shared: true })).request('compile')).result;
process.stdout.write(JSON.stringify({ direct, shared }));
"""
        generated = subprocess.run(["node", "--input-type=module", "-e", emitter], cwd=SOURCE / "tests",
                                   capture_output=True, text=True, timeout=10, check=True)
        fixtures = json.loads(generated.stdout)
        for name, compiled in fixtures.items():
            with self.subTest(name=name):
                output_nodes = [node_id for node_id, node in compiled["output"].items()
                                if node["class_type"] == "GenericDynamic"]
                imported = self.ok("/api/editor-workflows", {"name": "Bridge CPU " + name,
                                                            "document": compiled["workflow"]})
                session = self.ok(f"/api/editor-workflows/{imported['id']}/session")
                evidence = {"session_id": session["session_id"], "base_revision": imported["revision"],
                            "document": compiled["workflow"], "prompt": compiled["output"],
                            "additional_inputs": compiled["additional_inputs"],
                            "native_input_observations": compiled["native_input_observations"],
                            "output_nodes": output_nodes}
                if name == "shared":
                    crossed = copy.deepcopy(evidence)
                    crossed["prompt"]["6:2"]["inputs"]["branch-z"] = ["7:1", 0]
                    crossed["additional_inputs"]["nodes"]["6:2"]["inputs"]["branch-z"]["source"] = ["7:1", 0]
                    crossed["native_input_observations"]["nodes"]["6:2"]["inputs"]["branch-z"]["source"] = ["7:1", 0]
                    before = self.backend.prompt_attempts
                    status, rejected = self.client.post(f"/api/editor-workflows/{imported['id']}/interface", crossed)
                    self.assertEqual(status, 400, rejected)
                    self.assertEqual(self.backend.prompt_attempts, before)
                self.ok(f"/api/editor-workflows/{imported['id']}/interface", evidence)
                applied = self.ok(f"/api/editor-workflows/{imported['id']}/apply", {**evidence, "fields": []})
                request = {"kind": "package", "package_id": applied["package"]["id"], "values": {},
                           "output_nodes": output_nodes}
                validated = self.ok("/api/compile", request)
                self.assertEqual(validated["prompt"], compiled["output"])
                before = self.backend.prompt_attempts
                job = self.ok("/api/generate", {"request_id": "actual-bridge-cpu-" + name, "request": request})
                completed = self.ok(f"/api/jobs/{job['id']}/refresh")
                self.assertEqual(completed["status"], "completed", completed)
                self.assertEqual(self.backend.prompt_attempts, before + 1)
                actual = self.backend.history[job["id"]]["outputs"]
                self.assertEqual({node_id: entry["text"] for node_id, entry in actual.items()},
                                 {node_id: ["A"] for node_id in output_nodes})


if __name__ == "__main__":
    unittest.main()
