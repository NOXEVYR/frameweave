"""Independent regressions for reviewed dynamic-contract service boundaries.

Uses the formal launch entrypoint and the independent synthetic CPU backend.
Native observations are explicit fixtures, not evidence of real Comfy/GPU use.
"""

import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from frameweave.server import App, EditorPrewriteRejected
from test_dynamic_contract_service_integration import (LaunchHTTPClient, SyntheticCPUBackend,
    synthetic_document, synthetic_native_evidence, synthetic_prompt)


SOURCE = Path(__file__).resolve().parents[1]


def two_branches():
    """Two independent extra-link instances in one retained source graph."""
    document, prompt = synthetic_document(), synthetic_prompt()
    other = synthetic_document("other C")
    for node in other["nodes"]:
        node["id"] += 10
        for port in node["inputs"]:
            if port.get("link") is not None:
                port["link"] += 10
        for port in node["outputs"]:
            port["links"] = [link + 10 for link in port.get("links", [])]
    for link in other["links"]:
        for index in (0, 1, 3):
            link[index] += 10
    document["nodes"] += other["nodes"]
    document["links"] += other["links"]
    document.update(last_node_id=15, last_link_id=14)
    for key, node in synthetic_prompt("other C").items():
        node = copy.deepcopy(node)
        for value in node["inputs"].values():
            if isinstance(value, list):
                value[0] = str(int(value[0]) + 10)
        prompt[str(int(key) + 10)] = node
    contract, observations = synthetic_native_evidence()
    contract["nodes"]["14"] = copy.deepcopy(contract["nodes"]["4"])
    contract["nodes"]["14"]["inputs"]["tail"]["source"] = ["13", 0]
    observations["nodes"]["14"] = copy.deepcopy(observations["nodes"]["4"])
    observations["nodes"]["14"]["instance_path"] = ["14"]
    observations["nodes"]["14"]["inputs"]["tail"].update(
        source=["13", 0], link_id=13, native_source_id="13")
    return document, prompt, contract, observations


class DynamicContractReviewHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="prism-contract-review-")
        self.addCleanup(self.temp.cleanup)
        self.backend = SyntheticCPUBackend()
        self.addCleanup(self.backend.stop)
        self.runtime = Path(self.temp.name) / "runtime-data"
        self.client = LaunchHTTPClient(self.runtime, self.backend.url)
        self.addCleanup(self.client.stop)

    def ok(self, path, data=None):
        status, result = self.client.post(path, data)
        self.assertEqual(status, 200, result)
        return result

    def evidence(self, source=None):
        document, prompt, contract, observations = source or (
            synthetic_document(), synthetic_prompt(), *synthetic_native_evidence())
        imported = self.ok("/api/editor-workflows", {"name": "Reviewed native links", "document": document})
        session = self.ok(f"/api/editor-workflows/{imported['id']}/session")
        return imported, {"session_id": session["session_id"], "base_revision": imported["revision"],
                          "document": document, "prompt": prompt, "additional_inputs": contract,
                          "native_input_observations": observations, "output_nodes": ["5"]}

    def apply(self, imported, evidence):
        base = f"/api/editor-workflows/{imported['id']}"
        interface = self.ok(base + "/interface", evidence)
        return self.ok(base + "/apply", {**evidence, "fields": interface["fields"]})

    def test_package_apply_returns_contract_for_exact_api_compile(self):
        imported, evidence = self.evidence()
        applied = self.apply(imported, evidence)
        result = self.ok(f"/api/packages/{applied['package']['id']}/apply", {"values": applied["values"]})
        self.assertEqual(result["additional_inputs"], evidence["additional_inputs"])
        compiled = self.ok("/api/compile", {"kind": "api", "prompt": result["prompt"],
                                          "additional_inputs": result["additional_inputs"]})
        self.assertEqual(compiled["prompt"], result["prompt"])
        serialized = json.dumps(result)
        self.assertNotIn(evidence["session_id"], serialized)
        self.assertNotIn(self.client.token, serialized)
        self.assertNotIn("contract_proof", result)
        self.assertEqual(self.backend.next_id, 0)

    def test_backend_roundtrip_invalidates_old_native_session_and_grants(self):
        imported, evidence = self.evidence()
        applied = self.apply(imported, evidence)
        request = {"kind": "package", "package_id": applied["package"]["id"], "values": {}}
        self.ok("/api/compile", request)
        other = SyntheticCPUBackend()
        self.addCleanup(other.stop)
        self.ok("/api/settings", {"backend_url": other.url})
        self.ok("/api/settings", {"backend_url": self.backend.url})
        old = {**evidence, "base_revision": applied["workflow"]["revision"]}
        base = f"/api/editor-workflows/{imported['id']}"
        for path, data in ((base + "/interface", old), (base + "/apply", old), ("/api/compile", request)):
            with self.subTest(path=path):
                status, rejected = self.client.post(path, data)
                self.assertEqual(status, 400, rejected)
        status, current = self.client.request("GET", base)
        self.assertEqual(status, 200)
        self.assertEqual(current["revision"], applied["workflow"]["revision"])
        session = self.ok(base + "/session")
        fresh = self.apply(imported, {**old, "session_id": session["session_id"]})
        self.assertEqual(fresh["package"]["id"], applied["package"]["id"])
        self.ok("/api/compile", request)
        self.assertEqual((self.backend.next_id, other.next_id), (0, 0))

    def test_configuring_selected_output_preserves_full_source_contract(self):
        imported, evidence = self.evidence(two_branches())
        applied = self.apply(imported, evidence)
        self.assertEqual(set(applied["package"]["additional_inputs"]["nodes"]), {"4", "14"})
        configured = self.ok("/api/interfaces/apply", {
            "backend_url": self.backend.url, "package_id": applied["package"]["id"],
            "values": applied["values"], "previous_values": applied["values"],
            "previous_baseline": applied["baseline"], "output_nodes": ["5"],
        })
        self.assertEqual(configured["package"]["prompt"], applied["package"]["prompt"])
        self.assertEqual(configured["package"]["additional_inputs"], applied["package"]["additional_inputs"])
        for output, instance in (("5", "4"), ("15", "14")):
            with self.subTest(output=output):
                result = self.ok("/api/compile", {"kind": "package", "package_id": configured["package"]["id"],
                                                 "values": {}, "output_nodes": [output]})
                self.assertEqual(set(result["additional_inputs"]["nodes"]), {instance})
                self.assertEqual(len(result["prompt"]), 5)
        self.assertEqual(self.backend.next_id, 0)

    def test_native_formal_only_observations_do_not_persist_raw_sidecar(self):
        self.backend.info["SyntheticMerge"]["input"]["required"]["tail"] = ["STRING"]
        imported, evidence = self.evidence()
        applied = self.apply(imported, evidence)
        self.assertNotIn("additional_inputs", applied["package"])
        compiled = self.ok("/api/compile", {"kind": "package", "package_id": applied["package"]["id"], "values": {}})
        self.assertNotIn("additional_inputs", compiled)
        exported = self.ok(f"/api/packages/{applied['package']['id']}/export")
        self.assertNotIn("additional_inputs", exported["document"])
        private = self.runtime / "editor-workflows" / imported["id"] / "compiled" / (
            f"revision-{applied['workflow']['revision']:08d}.json")
        stored = json.loads(private.read_text(encoding="utf-8"))
        self.assertNotIn("additional_inputs", stored)
        self.assertIn("contract_proof", stored)
        self.assertEqual(self.backend.next_id, 0)

    def test_inactive_unknown_class_remains_in_source_without_blocking_native_apply(self):
        document, prompt = synthetic_document(), synthetic_prompt()
        document["nodes"].append({"id": 99, "type": "UnavailableInactivePlugin", "mode": 0,
                                  "inputs": [], "outputs": [], "widgets_values": ["opaque"], "properties": {}})
        prompt["99"] = {"class_type": "UnavailableInactivePlugin", "inputs": {"unknown_scalar": "opaque"}}
        contract, observations = synthetic_native_evidence()
        imported, evidence = self.evidence((document, prompt, contract, observations))
        applied = self.apply(imported, evidence)
        self.assertEqual(applied["package"]["prompt"]["99"], prompt["99"])
        status, current = self.client.request("GET", f"/api/editor-workflows/{imported['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(current["document"], document)
        result = self.ok("/api/compile", {"kind": "package", "package_id": applied["package"]["id"],
                                         "values": {}, "output_nodes": ["5"]})
        self.assertNotIn("99", result["prompt"])
        self.assertEqual(result["additional_inputs"], contract)
        self.assertEqual(self.backend.next_id, 0)


class DynamicContractPrewriteReviewTests(unittest.TestCase):
    def test_fallible_grant_preparation_rejects_before_package_and_revision_publish(self):
        with tempfile.TemporaryDirectory(prefix="prism-grant-prewrite-") as temporary:
            backend = SyntheticCPUBackend()
            self.addCleanup(backend.stop)
            app = App(Path(temporary), SOURCE / "web", backend_url=backend.url)
            self.addCleanup(app.closed.set)
            document, prompt = synthetic_document(), synthetic_prompt()
            imported = app.editor_workflows.create("Prewrite native links", document)
            session_id = "private-test-session"
            app.editor_sessions[session_id] = {"workflow_id": imported["id"], "backend": backend.url,
                                               "proxy": mock.Mock()}
            contract, observations = synthetic_native_evidence()
            evidence = {"session_id": session_id, "base_revision": imported["revision"],
                        "document": document, "prompt": prompt, "additional_inputs": contract,
                        "native_input_observations": observations, "output_nodes": ["5"]}
            with mock.patch.object(app, "_prepare_input_contract_record", side_effect=ValueError("proof preparation failed")):
                with self.assertRaisesRegex(EditorPrewriteRejected, "proof preparation failed"):
                    app.apply_editor(imported["id"], evidence)
            self.assertEqual(app.editor_workflows.get(imported["id"])["revision"], imported["revision"])
            self.assertEqual(list((Path(temporary) / "workflow-packages").glob("p-*.json")), [])
            self.assertEqual(app.input_contract_grants, [])
            self.assertEqual(backend.next_id, 0)


if __name__ == "__main__":
    unittest.main()
