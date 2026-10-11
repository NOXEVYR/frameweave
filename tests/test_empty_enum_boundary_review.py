"""Independent boundary checks: editor preservation grants no execution rights."""
import copy
import unittest

from frameweave.editor_preparation import prepare_editor_document
from frameweave.packages import (apply_editor_values, apply_planning_values,
    apply_values, normalize_document, validate_planning_fields)
from frameweave.workflows import _validate_prompt, validate_editor_prompt


def boundary(value="OLD", options=None):
    document = {"name": "Boundary", "prompt": {
        "1": {"class_type": "PrivateSelector", "inputs": {"choice": value, "caption": "OWN"}},
        "2": {"class_type": "EmptyImage", "inputs": {}},
    }, "fields": [{"id": "choice", "label": "Choice", "node_id": "1", "input": "choice",
                   "type": "select", "options": [] if options is None else options}]}
    info = {"PrivateSelector": {"input": {"required": {"choice": [[]], "caption": ["STRING"]}}, "output": ["IMAGE"]},
            "EmptyImage": {"input": {"required": {}}, "output": ["IMAGE"]}}
    return document, info


class IndependentEmptyEnumBoundaryReview(unittest.TestCase):
    def test_stored_membership_never_authorizes_fresh_active_empty_directory(self):
        document, info = boundary(options=["OLD"])
        original = copy.deepcopy(document)
        prompt = apply_values(document, {})
        self.assertEqual(prompt["1"]["inputs"]["choice"], "OLD")
        with self.assertRaisesRegex(ValueError, "当前后端可选值"):
            validate_planning_fields(document["fields"], prompt, info, {"1"})
        with self.assertRaises(ValueError):
            _validate_prompt({"1": prompt["1"]}, info)
        self.assertEqual(document, original)

    def test_inactive_historical_enum_preserves_literal_without_poisoning_other_scope(self):
        for options in ([], ["OLD"]):
            document, info = boundary(options=options)
            info["PrivateSelector"]["input"]["required"]["choice"] = [["NEW"]]
            original = copy.deepcopy(document)
            prompt = apply_planning_values(document, {})
            validate_planning_fields(document["fields"], prompt, info, {"2"})
            execution = apply_values(document, {}, active_nodes={"2"})
            _validate_prompt({"2": execution["2"]}, info)
            self.assertEqual(execution["1"]["inputs"]["choice"], "OLD")
            self.assertEqual(document, original)

    def test_empty_default_identity_distinguishes_boolean_from_number(self):
        document, _ = boundary(value=0)
        document["fields"][0]["default"] = False
        with self.assertRaisesRegex(ValueError, "原始节点字面值"):
            normalize_document(document)
        document["fields"][0]["default"] = 0.0
        normalized = normalize_document(document)
        self.assertEqual(normalized["fields"][0]["default"], 0.0)
        self.assertNotIn("enum_state", normalized["fields"][0])

    def test_generic_static_empty_combo_is_repairable_but_execution_remains_strict(self):
        for declaration in ([[]], ["COMBO", {"options": []}]):
            document, info = boundary()
            info["PrivateSelector"]["input"]["required"]["choice"] = declaration
            original = copy.deepcopy(document)
            prompt = apply_editor_values(document, {})
            readiness = validate_editor_prompt(prompt, info)
            self.assertTrue(any(item["code"] == "enum_unavailable" for item in readiness["issues"]))
            with self.assertRaises(ValueError):
                _validate_prompt(prompt, info)
            with self.assertRaises(ValueError):
                apply_values(document, {})
            self.assertEqual(document, original)

    def test_invalid_enum_overlay_cannot_erase_valid_same_node_text_overlay_or_original_source(self):
        document, info = boundary()
        caption = {"id": "caption", "label": "Caption", "node_id": "1", "input": "caption", "type": "text"}
        document["fields"].append(caption)
        original = copy.deepcopy(document)
        result = prepare_editor_document(document, source_kind="package", info=info,
            overrides=[{"field_id": "choice", "value": "FORGED", "origin": "outer"},
                       {"field_id": "caption", "value": "EDITED", "origin": "outer"}])
        self.assertEqual(result["source_document"], original)
        self.assertEqual(result["prompt"]["1"]["inputs"], {"choice": "OLD", "caption": "EDITED"})
        self.assertEqual([item["field_id"] for item in result["overrides"]], ["caption"])
        self.assertTrue(any(item.get("field_id") == "choice" and item["reason"] == "enum_unavailable" for item in result["pending"]))
        self.assertEqual(document, original)


if __name__ == "__main__":
    unittest.main()
