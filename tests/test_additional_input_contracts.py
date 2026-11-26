"""Native additional links preserve strict schema and topology validation."""

import copy
import unittest

from frameweave.input_contracts import (AdditionalInputContractRequired, contract_schema_digest, crop_additional_inputs,
                                      normalize_additional_inputs, resolved_inputs)
from frameweave.workflows import compile_workflow, validate_editor_prompt, validate_prompt


def fixture(kind="STRING"):
    info = {
        "Literal": {"input": {"required": {"value": [kind]}}, "output": [kind]},
        "SyntheticMerge": {"input": {"required": {"left": ["STRING"], "count": ["INT", {"min": 1, "max": 4}]},
                                      "optional": {"mode": [["a", "b"]]}, "hidden": {"private": "PROMPT"}},
                           "output": ["STRING"]},
        "Sink": {"input": {"required": {"text": ["STRING"]}}, "output": [], "output_node": True},
    }
    prompt = {"A": {"class_type": "Literal", "inputs": {"value": "A" if kind == "STRING" else ["A", 0]}},
              "merge": {"class_type": "SyntheticMerge", "inputs": {"left": "B", "count": 3, "tail": ["A", 0]}},
              "out": {"class_type": "Sink", "inputs": {"text": ["merge", 0]}}}
    contract = {"version": 1, "nodes": {"merge": {"class_type": "SyntheticMerge", "inputs": {
        "tail": {"type": "STRING", "accept": "link", "source": ["A", 0]},
    }}}}
    return prompt, info, contract


class AdditionalInputContractTests(unittest.TestCase):
    def test_exact_observed_link_validates_without_changing_inputs_or_info(self):
        prompt, info, contract = fixture()
        before = copy.deepcopy((prompt, info, contract))
        validate_prompt(prompt, info, contract)
        self.assertEqual(validate_editor_prompt(prompt, info, contract), {"status": "unverified", "issues": []})
        compiled = compile_workflow({"kind": "api", "prompt": prompt}, info, contract)
        self.assertEqual(compiled["prompt"], prompt)
        self.assertEqual(compiled["additional_inputs"], contract)
        self.assertEqual((prompt, info, contract), before)

    def test_request_sidecar_and_provenance_do_not_authorize_compile(self):
        prompt, info, contract = fixture()
        contract["provenance"] = {"kind": "native_compiled", "source_revision": 1}
        with self.assertRaisesRegex(ValueError, "不支持输入 tail"):
            compile_workflow({"kind": "api", "prompt": prompt, "additional_inputs": contract}, info)
        with self.assertRaisesRegex(ValueError, "不支持输入 tail"):
            validate_prompt(prompt, info)

    def test_bare_api_unknown_valid_link_has_contract_required_code(self):
        prompt, info, _ = fixture()
        with self.assertRaisesRegex(AdditionalInputContractRequired, "不支持输入 tail") as caught:
            compile_workflow({"kind": "api", "prompt": prompt}, info)
        self.assertEqual(caught.exception.code, "additional_input_contract_required")
        prompt["merge"]["inputs"]["tail"] = "unproven scalar"
        with self.assertRaisesRegex(ValueError, "不支持输入 tail") as scalar:
            validate_prompt(prompt, info)
        self.assertIsNone(getattr(scalar.exception, "code", None))

    def test_bare_api_unknown_link_reports_source_and_slot_errors_first(self):
        for value, message in ((["missing", 0], "不存在"), (["A", 1], "越界"),
                               (["A", -1], "越界"), (["A", True], "非负整数"),
                               (["A", 0.0], "非负整数")):
            prompt, info, _ = fixture()
            prompt["merge"]["inputs"]["tail"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, message) as caught:
                validate_prompt(prompt, info)
            self.assertIsNone(getattr(caught.exception, "code", None))

    def test_bare_api_unknown_link_topology_errors_precede_missing_contract(self):
        prompt, info, _ = fixture()
        prompt["merge"]["inputs"]["tail"] = ["merge", 0]
        with self.assertRaisesRegex(ValueError, "循环") as caught:
            validate_prompt(prompt, info)
        self.assertIsNone(getattr(caught.exception, "code", None))
        prompt = {"A": prompt["A"]}
        for index in range(256):
            node_id, source = str(index), "A" if index == 0 else str(index - 1)
            prompt[node_id] = {"class_type": "SyntheticMerge", "inputs": {"left": "B", "count": 3, "tail": [source, 0]}}
        with self.assertRaisesRegex(ValueError, "256 层") as caught:
            validate_prompt(prompt, info)
        self.assertIsNone(getattr(caught.exception, "code", None))

    def test_same_class_second_instance_cannot_inherit_port(self):
        prompt, info, contract = fixture()
        prompt["other"] = copy.deepcopy(prompt["merge"])
        with self.assertRaisesRegex(ValueError, "不支持输入 tail"):
            validate_prompt(prompt, info, contract)

    def test_instance_class_name_and_source_edge_must_match(self):
        for change in ("class", "instance", "name", "source", "missing"):
            prompt, info, contract = fixture()
            if change == "class":
                contract["nodes"]["merge"]["class_type"] = "Other"
            elif change == "instance":
                contract["nodes"]["other"] = contract["nodes"].pop("merge")
            elif change == "name":
                contract["nodes"]["merge"]["inputs"]["another"] = contract["nodes"]["merge"]["inputs"].pop("tail")
            elif change == "source":
                prompt["merge"]["inputs"]["tail"] = ["out", 0]
            else:
                prompt["merge"]["inputs"].pop("tail")
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "已失效"):
                validate_prompt(prompt, info, contract)

    def test_source_slot_and_types_remain_strict(self):
        for source_kind, slot, message in (("IMAGE", 0, "上游输出"), ("STRING", 1, "越界")):
            prompt, info, contract = fixture()
            info["Literal"]["output"] = [source_kind]
            prompt["merge"]["inputs"]["tail"][1] = slot
            contract["nodes"]["merge"]["inputs"]["tail"]["source"][1] = slot
            with self.subTest(source_kind=source_kind, slot=slot), self.assertRaisesRegex(ValueError, message):
                validate_prompt(prompt, info, contract)
        prompt, info, contract = fixture()
        prompt.pop("A")
        with self.assertRaisesRegex(ValueError, "不存在"):
            validate_prompt(prompt, info, contract)

    def test_union_and_wildcard_port_types_use_actual_source(self):
        for output, expected in (("IMAGE", "IMAGE,MASK"), ("MASK", "IMAGE, MASK"),
                                 ("CUSTOM", "*"), ("*", "STRING")):
            prompt, info, contract = fixture()
            info["Literal"]["output"] = [output]
            contract["nodes"]["merge"]["inputs"]["tail"]["type"] = expected
            with self.subTest(output=output, expected=expected):
                validate_prompt(prompt, info, contract)
        prompt, info, contract = fixture()
        info["Literal"]["output"] = ["AUDIO"]
        contract["nodes"]["merge"]["inputs"]["tail"]["type"] = "IMAGE,MASK"
        with self.assertRaisesRegex(ValueError, "上游输出"):
            validate_prompt(prompt, info, contract)

    def test_scalar_or_malformed_link_is_never_authorized(self):
        for value in ("literal", ["A", True], ["A", 0.0], ["A", -1], ["A"], {"source": "A"}):
            prompt, info, contract = fixture()
            prompt["merge"]["inputs"]["tail"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_prompt(prompt, info, contract)
        prompt, info, contract = fixture()
        contract["nodes"]["merge"]["inputs"]["tail"]["accept"] = "scalar"
        with self.assertRaisesRegex(ValueError, "只支持 link"):
            validate_prompt(prompt, info, contract)

    def test_hidden_inputs_cannot_be_promoted(self):
        prompt, info, contract = fixture()
        prompt["merge"]["inputs"]["private"] = prompt["merge"]["inputs"].pop("tail")
        fields = contract["nodes"]["merge"]["inputs"]
        fields["private"] = fields.pop("tail")
        with self.assertRaisesRegex(ValueError, "hidden"):
            validate_prompt(prompt, info, contract)

    def test_new_compatible_declared_field_preserves_official_spec(self):
        prompt, info, contract = fixture()
        official = ["STRING", {"forceInput": True, "other_constraint": "retained"}]
        info["SyntheticMerge"]["input"]["required"]["tail"] = official
        fields, required = resolved_inputs("merge", prompt["merge"], info["SyntheticMerge"], contract)
        self.assertEqual(fields["tail"], official)
        self.assertIn("tail", required)
        validate_prompt(prompt, info, contract)

    def test_new_incompatible_declared_field_is_stale(self):
        prompt, info, contract = fixture()
        info["SyntheticMerge"]["input"]["optional"]["tail"] = ["IMAGE"]
        with self.assertRaisesRegex(ValueError, "stale"):
            validate_prompt(prompt, info, contract)

    def test_contract_cannot_weaken_required_enum_or_numeric_limits(self):
        for change, message in (("required", "必填"), ("enum", "选项"), ("limit", "数值范围")):
            prompt, info, contract = fixture()
            if change == "required":
                prompt["merge"]["inputs"].pop("count")
            elif change == "enum":
                prompt["merge"]["inputs"]["mode"] = "bad"
            else:
                prompt["merge"]["inputs"]["count"] = 99
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                validate_prompt(prompt, info, contract)

    def test_official_autogrow_migrates_and_container_is_reserved(self):
        prompt, info, contract = fixture()
        info["SyntheticMerge"]["input"]["optional"]["grow"] = ["COMFY_AUTOGROW_V3", {"template": {
            "names": ["item"], "input": {"optional": {"value": ["STRING"]}},
        }}]
        fields = contract["nodes"]["merge"]["inputs"]
        fields["grow.item"] = fields.pop("tail")
        prompt["merge"]["inputs"]["grow.item"] = prompt["merge"]["inputs"].pop("tail")
        validate_prompt(prompt, info, contract)
        fields["grow"] = fields.pop("grow.item")
        prompt["merge"]["inputs"]["grow"] = prompt["merge"]["inputs"].pop("grow.item")
        with self.assertRaisesRegex(ValueError, "正式动态输入"):
            validate_prompt(prompt, info, contract)

    def test_inactive_formal_dynamic_branch_cannot_be_promoted(self):
        prompt, info, contract = fixture()
        info["SyntheticMerge"]["input"]["optional"]["choice"] = ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "on", "inputs": {"optional": {"extra": ["STRING"]}}}, {"key": "off", "inputs": {}},
        ]}]
        prompt["merge"]["inputs"]["choice"] = "off"
        prompt["merge"]["inputs"]["choice.extra"] = prompt["merge"]["inputs"].pop("tail")
        fields = contract["nodes"]["merge"]["inputs"]
        fields["choice.extra"] = fields.pop("tail")
        with self.assertRaisesRegex(ValueError, "正式动态输入"):
            validate_prompt(prompt, info, contract)

    def test_additional_dependency_cycle_is_rejected(self):
        prompt, info, contract = fixture()
        prompt["merge"]["inputs"]["tail"] = ["merge", 0]
        contract["nodes"]["merge"]["inputs"]["tail"]["source"] = ["merge", 0]
        with self.assertRaisesRegex(ValueError, "循环"):
            validate_prompt(prompt, info, contract)

    def test_additional_dependency_depth_is_rejected(self):
        prompt, info, contract = fixture()
        prompt = {"A": prompt["A"]}
        contract["nodes"] = {}
        for index in range(256):
            node_id, source = str(index), "A" if index == 0 else str(index - 1)
            prompt[node_id] = {"class_type": "SyntheticMerge", "inputs": {"left": "B", "count": 3, "tail": [source, 0]}}
            contract["nodes"][node_id] = {"class_type": "SyntheticMerge", "inputs": {
                "tail": {"type": "STRING", "accept": "link", "source": [source, 0]},
            }}
        with self.assertRaisesRegex(ValueError, "256 层"):
            validate_prompt(prompt, info, contract)

    def test_maximum_graph_size_with_sidecar_is_validated(self):
        prompt, info, contract = fixture()
        prompt = {"A": prompt["A"]}
        contract["nodes"] = {}
        for index in range(999):
            node_id = str(index)
            prompt[node_id] = {"class_type": "SyntheticMerge", "inputs": {"left": "B", "count": 3, "tail": ["A", 0]}}
            contract["nodes"][node_id] = {"class_type": "SyntheticMerge", "inputs": {
                "tail": {"type": "STRING", "accept": "link", "source": ["A", 0]},
            }}
        validate_prompt(prompt, info, contract)
        prompt["998"]["inputs"]["count"] = 99
        with self.assertRaisesRegex(ValueError, "数值范围"):
            validate_prompt(prompt, info, contract)

    def test_malformed_source_output_schema_is_rejected_cleanly(self):
        for schema in ([], {"input": {"required": {"value": ["STRING"]}}, "output": None},
                       {"input": {"required": {"value": ["STRING"]}}, "output": "STRING"}):
            prompt, info, contract = fixture()
            # Put the contract destination first to test the additional-link
            # source path before the source node's own validation visit.
            prompt = {"merge": prompt["merge"], "A": prompt["A"], "out": prompt["out"]}
            info["Literal"] = schema
            with self.subTest(schema=schema), self.assertRaisesRegex(ValueError, "输出定义无效"):
                validate_prompt(prompt, info, contract)

    def test_resolved_matchtype_output_remains_concrete_for_additional_input(self):
        prompt, info, contract = fixture()
        info["Pass"] = {"input": {"required": {"value": ["COMFY_MATCHTYPE_V3", {"template": {
            "template_id": "same", "allowed_types": "STRING,IMAGE",
        }}]}}, "output": ["COMFY_MATCHTYPE_V3"], "output_matchtypes": ["same"]}
        prompt["pass"] = {"class_type": "Pass", "inputs": {"value": ["A", 0]}}
        prompt["merge"]["inputs"]["tail"] = ["pass", 0]
        contract["nodes"]["merge"]["inputs"]["tail"]["source"] = ["pass", 0]
        validate_prompt(prompt, info, contract)
        contract["nodes"]["merge"]["inputs"]["tail"]["type"] = "IMAGE"
        with self.assertRaisesRegex(ValueError, "上游输出"):
            validate_prompt(prompt, info, contract)

    def test_crop_is_independent_and_retains_exact_sources(self):
        prompt, info, contract = fixture()
        before = copy.deepcopy(contract)
        self.assertIsNone(crop_additional_inputs(contract, {"A", "out"}))
        cropped = crop_additional_inputs(contract, {"A", "merge"})
        self.assertEqual(cropped, contract)
        cropped["nodes"]["merge"]["inputs"]["tail"]["source"][1] = 4
        self.assertEqual(contract, before)

    def test_schema_digest_tracks_instances_edges_and_live_definitions(self):
        prompt, info, contract = fixture()
        digest = contract_schema_digest(contract, prompt, info)
        self.assertEqual(len(digest), 64)
        prompt["A"]["inputs"]["value"] = "Changed upstream text"
        self.assertEqual(contract_schema_digest(contract, prompt, info), digest)
        info["Literal"]["output"] = ["STRING", "IMAGE"]
        self.assertNotEqual(contract_schema_digest(contract, prompt, info), digest)
        info["Literal"]["output"] = ["STRING"]
        info["Unused"] = {"output": ["IMAGE"]}
        self.assertEqual(contract_schema_digest(contract, prompt, info), digest)
        prompt["other"] = {"class_type": "Literal", "inputs": {"value": "X"}}
        self.assertNotEqual(contract_schema_digest(contract, prompt, info), digest)

    def test_normalization_has_strict_structural_bounds(self):
        _, _, base = fixture()
        mutations = [dict(base, version=True), dict(base, version=2), dict(base, wildcard="tail_*"),
                     dict(base, nodes=[]), dict(base, provenance="native")]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                normalize_additional_inputs(mutation)
        for key in ("__proto__", "constructor", "prototype", "", "x" * 257):
            contract = copy.deepcopy(base)
            contract["nodes"]["merge"]["inputs"][key] = contract["nodes"]["merge"]["inputs"].pop("tail")
            with self.subTest(key=key), self.assertRaises(ValueError):
                normalize_additional_inputs(contract)
        for kind in ("", "IMAGE,,MASK", "IMAGE,IMAGE", "COMFY_MATCHTYPE_V3"):
            contract = copy.deepcopy(base)
            contract["nodes"]["merge"]["inputs"]["tail"]["type"] = kind
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                normalize_additional_inputs(contract)

    def test_contract_node_field_byte_and_json_depth_limits(self):
        _, _, contract = fixture()
        contract["nodes"] = {str(index): {"class_type": "SyntheticMerge", "inputs": {
            "tail": {"type": "STRING", "accept": "link", "source": ["A", 0]},
        }} for index in range(1001)}
        with self.assertRaisesRegex(ValueError, "1000"):
            normalize_additional_inputs(contract)
        _, _, contract = fixture()
        contract["nodes"]["merge"]["inputs"] = {str(index): {
            "type": "STRING", "accept": "link", "source": ["A", 0],
        } for index in range(4097)}
        with self.assertRaisesRegex(ValueError, "4096"):
            normalize_additional_inputs(contract)
        _, _, contract = fixture()
        contract["provenance"] = {"note": "x" * (2 * 1024 * 1024)}
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            normalize_additional_inputs(contract)
        nested = {}
        for _ in range(65):
            nested = {"nested": nested}
        contract["provenance"] = nested
        with self.assertRaisesRegex(ValueError, "64 层"):
            normalize_additional_inputs(contract)


if __name__ == "__main__":
    unittest.main()
