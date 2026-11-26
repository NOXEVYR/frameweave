"""Live input discovery preserves undeclared data without granting writes."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from frameweave.editor_interfaces import inspect_interface
from frameweave.input_contracts import AdditionalInputContractRequired
from frameweave.packages import (MAX_INSPECTION_FIELDS, PackageStore, inspect_document,
                                normalize_document)
from frameweave.workflows import validate_editor_prompt, validate_prompt


def scalar_fixture():
    prompt = {"1": {"class_type": "CustomInputs", "inputs": {
        "text": "declared text", "extra_text": "PRIVATE /path/token/example",
        "extra_integer": 791842630, "extra_number": 37.125, "extra_boolean": True,
    }}}
    info = {"CustomInputs": {"input": {"required": {"text": ["STRING"]}},
                             "output": ["STRING"], "output_node": True}}
    return prompt, info


class OpaqueInputTests(unittest.TestCase):
    def test_all_undeclared_scalar_types_are_preserved_and_not_writable(self):
        prompt, info = scalar_fixture()
        original = copy.deepcopy(prompt)
        result = inspect_document(prompt, info)
        self.assertEqual([field["input"] for field in result["fields"]], ["text"])
        self.assertEqual(result["prompt"], original)
        self.assertEqual(prompt, original)
        diagnostics = result["opaque_inputs"]
        self.assertEqual({item["input"]: item["type_summary"] for item in diagnostics}, {
            "extra_text": "string", "extra_integer": "integer",
            "extra_number": "number", "extra_boolean": "boolean",
        })
        for item in diagnostics:
            self.assertEqual(set(item), {"node_id", "input", "code", "reason", "type_summary", "message"})
            self.assertEqual(item["node_id"], "1")
            self.assertEqual(item["code"], "undeclared_scalar_input")
            self.assertEqual(item["reason"], "missing_live_input_contract")
        encoded_diagnostics = json.dumps(diagnostics)
        for private_value in ("PRIVATE", "/path/token/example", "791842630", "37.125"):
            self.assertNotIn(private_value, encoded_diagnostics)

    def test_interface_keeps_value_free_diagnostics_and_strict_execution_boundary(self):
        prompt, info = scalar_fixture()
        original = copy.deepcopy(prompt)
        result = inspect_interface(prompt, info)
        self.assertEqual([field["input"] for field in result["fields"]], ["text"])
        self.assertEqual(result["prompt"], original)
        self.assertEqual(result["opaque_inputs"], inspect_document(prompt, info)["opaque_inputs"])
        self.assertEqual(result["warnings"], result["opaque_inputs"])
        self.assertEqual(prompt, original)
        for validate in (validate_prompt, validate_editor_prompt):
            with self.subTest(validate=validate.__name__), self.assertRaisesRegex(ValueError, "不支持输入"):
                validate(result["prompt"], info)

    def test_declared_and_official_dynamic_fields_keep_their_real_contracts(self):
        info = {"DynamicInputs": {"input": {"required": {
            "text": ["STRING"], "count": ["INT", {"min": 0, "max": 20}],
            "rate": ["FLOAT", {"min": 0, "max": 10}], "enabled": ["BOOLEAN"],
            "choice": [["a", "b"]],
            "branch": ["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "on", "inputs": {
                "optional": {"strength": ["FLOAT", {"min": 0, "max": 1}]},
            }}]}],
            "items": ["COMFY_AUTOGROW_V3", {"template": {
                "names": ["a", "b"], "min": 0, "input": {"optional": {"value": ["STRING"]}},
            }}],
        }}, "output": ["STRING"], "output_node": True}}
        prompt = {"1": {"class_type": "DynamicInputs", "inputs": {
            "text": "ok", "count": 3, "rate": 1, "enabled": False, "choice": "a",
            "branch": "on", "branch.strength": 0.5, "items.b": "official optional member",
        }}}
        original = copy.deepcopy(prompt)
        for inspect in (inspect_document, inspect_interface):
            with self.subTest(inspect=inspect.__name__):
                result = inspect(prompt, info)
                fields = {field["input"]: field for field in result["fields"]}
                self.assertEqual(set(fields), set(prompt["1"]["inputs"]))
                self.assertEqual(fields["rate"]["type"], "number")
                self.assertEqual(fields["count"]["max"], 20)
                self.assertEqual(fields["branch"]["options"], ["on"])
                self.assertEqual(fields["branch.strength"]["max"], 1)
                self.assertEqual(fields["items.b"]["type"], "text")
                self.assertNotIn("opaque_inputs", result)
                self.assertEqual(result["prompt"], original)
        validate_prompt(prompt, info)
        self.assertEqual(prompt, original)

    def test_offline_and_missing_node_discovery_retain_historical_candidates(self):
        prompt, info = scalar_fixture()
        for offline_info in (None, {}, {"OtherNode": info["CustomInputs"]}):
            with self.subTest(info=offline_info):
                result = inspect_document(prompt, offline_info)
                self.assertEqual({field["input"] for field in result["fields"]}, set(prompt["1"]["inputs"]))
                self.assertNotIn("opaque_inputs", result)
                self.assertEqual(result["prompt"], prompt)

    def test_explicit_legacy_package_and_content_identity_are_unchanged(self):
        prompt, info = scalar_fixture()
        document = {"name": "Legacy explicit fields", "description": "", "prompt": prompt,
                    "fields": [{"id": "legacy-extra", "node_id": "1", "input": "extra_text",
                                "type": "text", "label": "Saved field", "default": prompt["1"]["inputs"]["extra_text"]}]}
        original = copy.deepcopy(document)
        inspected = inspect_document(document, info)
        self.assertEqual(inspected["fields"], [])
        self.assertEqual(inspected["prompt"], prompt)
        self.assertEqual([(item["input"], item["code"]) for item in inspected["opaque_inputs"]],
                         [("extra_text", "undeclared_scalar_input")])
        self.assertNotIn("PRIVATE", json.dumps(inspected["opaque_inputs"]))
        offline = inspect_document(document)
        self.assertEqual(offline["fields"][0]["id"], "legacy-extra")
        self.assertNotIn("opaque_inputs", offline)
        self.assertEqual(normalize_document(offline), normalize_document(document))
        with tempfile.TemporaryDirectory() as temporary:
            store = PackageStore(Path(temporary))
            stored = store.save(document)
            before = (store.directory / (stored["id"] + ".json")).read_bytes()
            self.assertEqual(store.save(offline)["id"], stored["id"])
            exported = store.export_transport(stored["id"])
            self.assertEqual(exported["document"], normalize_document(document))
            self.assertEqual(exported["source_json"].encode("utf-8"), before)
            self.assertEqual(exported["document"]["prompt"], prompt)
            self.assertEqual(exported["document"]["fields"][0]["id"], "legacy-extra")
            self.assertEqual((store.directory / (stored["id"] + ".json")).read_bytes(), before)
        self.assertEqual(document, original)

    def test_unknown_link_is_preserved_but_never_granted_a_scalar_contract(self):
        prompt, info = scalar_fixture()
        prompt["1"]["inputs"] = {"text": "ok", "extra_link": ["2", 0]}
        prompt["2"] = {"class_type": "CustomInputs", "inputs": {"text": "upstream"}}
        original = copy.deepcopy(prompt)
        result = inspect_document(prompt, info)
        self.assertEqual(result["prompt"], original)
        self.assertEqual(result["opaque_inputs"][0]["input"], "extra_link")
        self.assertEqual(result["opaque_inputs"][0]["code"], "additional_input_contract_required")
        self.assertEqual(result["opaque_inputs"][0]["type_summary"], "link")
        self.assertNotIn("extra_link", [field["input"] for field in result["fields"]])
        with self.assertRaisesRegex(AdditionalInputContractRequired, "不支持输入 extra_link") as rejected:
            validate_prompt(result["prompt"], info)
        self.assertEqual(rejected.exception.code, "additional_input_contract_required")
        self.assertEqual(prompt, original)

    def test_opaque_diagnostics_are_bounded_even_without_writable_candidates(self):
        prompt = {"1": {"class_type": "CustomInputs", "inputs": {
            f"extra_{index}": "preserved" for index in range(MAX_INSPECTION_FIELDS + 1)
        }}}
        info = {"CustomInputs": {"input": {"required": {}}, "output": ["STRING"]}}
        original = copy.deepcopy(prompt)
        with self.assertRaisesRegex(ValueError, "未声明输入超过 4096"):
            inspect_document(prompt, info, field_limit=1)
        self.assertEqual(prompt, original)

    def test_declared_and_opaque_inputs_share_the_response_budget(self):
        count = MAX_INSPECTION_FIELDS - 6
        values = {f"declared_{index}": 1 for index in range(count)}
        definitions = {name: ["INT"] for name in values}
        values.update({f"extra_{index}": "preserved" for index in range(6)})
        prompt = {"1": {"class_type": "CustomInputs", "inputs": values}}
        info = {"CustomInputs": {"input": {"required": definitions}, "output": ["STRING"]}}
        result = inspect_document(prompt, info)
        self.assertEqual(len(result["fields"]) + len(result["opaque_inputs"]), MAX_INSPECTION_FIELDS)
        values["extra_over_budget"] = "preserved"
        original = copy.deepcopy(prompt)
        with self.assertRaisesRegex(ValueError, "候选输入超过 4096"):
            inspect_document(prompt, info)
        limited = inspect_document(prompt, info, field_limit=1)
        self.assertEqual(len(limited["fields"]), 1)
        self.assertEqual(len(limited["opaque_inputs"]), 7)
        self.assertEqual(prompt, original)

    def test_missing_interface_candidates_share_the_opaque_budget(self):
        count = MAX_INSPECTION_FIELDS - 1
        values = {f"declared_{index}": 1 for index in range(count)}
        definitions = {name: ["INT"] for name in values}
        values["extra"] = "preserved"
        definitions["missing_text"] = ["STRING"]
        prompt = {"1": {"class_type": "CustomInputs", "inputs": values}}
        info = {"CustomInputs": {"input": {"required": definitions},
                                 "output": ["STRING"], "output_node": True}}
        original = copy.deepcopy(prompt)
        self.assertEqual(len(inspect_document(prompt, info)["fields"]), count)
        with self.assertRaisesRegex(ValueError, "候选输入超过 4096"):
            inspect_interface(prompt, info)
        self.assertEqual(prompt, original)


if __name__ == "__main__":
    unittest.main()
