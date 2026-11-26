"""Exact-instance proof boundaries; fixtures are data, not a real native session."""

import copy
import unittest

from frameweave.native_input_contracts import verify_native_additional_inputs
from frameweave.workflows import validate_prompt


def fixture():
    document = {"nodes": [
        {"id": 1, "type": "Text", "inputs": [],
         "outputs": [{"name": "value", "type": "STRING", "links": [7]}]},
        {"id": 2, "type": "Merge", "inputs": [{"name": "tail", "type": "STRING", "link": 7}],
         "outputs": [{"name": "value", "type": "STRING", "links": []}]},
    ], "links": [[7, 1, 0, 2, 0, "STRING"]]}
    prompt = {"1": {"class_type": "Text", "inputs": {"value": "A"}},
              "2": {"class_type": "Merge", "inputs": {"base": "B", "tail": ["1", 0]}}}
    info = {"Text": {"input": {"required": {"value": ["STRING"]}}, "output": ["STRING"]},
            "Merge": {"input": {"required": {"base": ["STRING"]}}, "output": ["STRING"]}}
    contract = {"version": 1, "nodes": {"2": {"class_type": "Merge", "inputs": {
        "tail": {"type": "STRING", "accept": "link", "source": ["1", 0]}}}}}
    observations = {"version": 1, "nodes": {"2": {"class_type": "Merge", "instance_path": ["2"],
        "inputs": {"tail": {"name": "tail", "type": "STRING", "native_slot_index": 0,
                            "workflow_slot_index": 0, "link_id": 7, "source": ["1", 0],
                            "native_source_id": "1", "native_source_slot": 0}}}}, "opaque_inputs": []}
    return document, prompt, info, contract, observations


def nest(data, *, inline=False, twice=False):
    document, prompt, info, contract, observations = copy.deepcopy(data)
    child = {**document, "id": "shared-child"}
    host = {"id": 10, "type": "shared-child", "inputs": [], "outputs": []}
    if inline:
        host["subgraph"] = child
        document = {"nodes": [host], "links": []}
    else:
        document = {"nodes": [host], "links": [], "definitions": {"subgraphs": [child]}}
    if twice:
        document["nodes"].append({"id": 11, "type": "shared-child", "inputs": [], "outputs": []})
    prompt = {"10:" + node_id: node for node_id, node in prompt.items()}
    prompt["10:2"]["inputs"]["tail"] = ["10:1", 0]
    contract["nodes"] = {"10:2": contract["nodes"]["2"]}
    contract["nodes"]["10:2"]["inputs"]["tail"]["source"] = ["10:1", 0]
    observations["nodes"] = {"10:2": observations["nodes"]["2"]}
    observations["nodes"]["10:2"]["instance_path"] = ["10", "2"]
    observations["nodes"]["10:2"]["inputs"]["tail"]["source"] = ["10:1", 0]
    return document, prompt, info, contract, observations


class NativeInputContractProofTests(unittest.TestCase):
    def test_root_exact_link_proves_and_originals_are_unchanged(self):
        data = fixture()
        original = copy.deepcopy(data)
        result = verify_native_additional_inputs(*data)
        self.assertEqual(result, data[3])
        self.assertEqual(data, original)
        self.assertIsNot(result["nodes"], data[3]["nodes"])
        validate_prompt(data[1], data[2], result)

    def test_both_serialized_object_link_forms(self):
        for as_mapping in (False, True):
            with self.subTest(as_mapping=as_mapping):
                data = fixture()
                link = {"origin_id": 1, "origin_slot": 0, "target_id": 2, "target_slot": 0, "type": "STRING"}
                data[0]["links"] = {"7": link} if as_mapping else [{"id": 7, **link}]
                self.assertEqual(verify_native_additional_inputs(*data), data[3])

    def test_workflow_slot_index_can_differ_after_official_widget_compaction(self):
        data = fixture()
        data[4]["nodes"]["2"]["inputs"]["tail"]["native_slot_index"] = 3
        self.assertEqual(verify_native_additional_inputs(*data), data[3])

    def test_legacy_single_slot_observation(self):
        data = fixture()
        field = data[4]["nodes"]["2"]["inputs"]["tail"]
        del field["native_slot_index"], field["workflow_slot_index"]
        field["slot_index"] = 0
        self.assertEqual(verify_native_additional_inputs(*data), data[3])

    def test_root_and_inline_or_defined_nested_instances(self):
        for inline in (False, True):
            with self.subTest(inline=inline):
                data = nest(fixture(), inline=inline)
                self.assertEqual(verify_native_additional_inputs(*data), data[3])
                validate_prompt(data[1], data[2], data[3])

    def test_nested_definition_lookup_and_three_level_instance_path(self):
        data = nest(fixture())
        outer = {**data[0], "id": "outer-child"}
        data = list(data)
        data[0] = {"nodes": [{"id": 20, "type": "outer-child"}], "links": [],
                   "definitions": {"subgraphs": [outer]}}
        data[1] = {"20:" + node_id: node for node_id, node in data[1].items()}
        data[1]["20:10:2"]["inputs"]["tail"] = ["20:10:1", 0]
        data[3]["nodes"] = {"20:10:2": data[3]["nodes"]["10:2"]}
        data[3]["nodes"]["20:10:2"]["inputs"]["tail"]["source"] = ["20:10:1", 0]
        data[4]["nodes"] = {"20:10:2": data[4]["nodes"]["10:2"]}
        observed = data[4]["nodes"]["20:10:2"]
        observed["instance_path"] = ["20", "10", "2"]
        observed["inputs"]["tail"]["source"] = ["20:10:1", 0]
        self.assertEqual(verify_native_additional_inputs(*data), data[3])

    def test_same_definition_instances_cannot_borrow_source_or_path(self):
        for forged_path in (False, True):
            with self.subTest(forged_path=forged_path):
                data = nest(fixture(), twice=True)
                data[1]["11:1"] = copy.deepcopy(data[1]["10:1"])
                if forged_path:
                    data[4]["nodes"]["10:2"]["instance_path"] = ["11", "2"]
                else:
                    data[1]["10:2"]["inputs"]["tail"] = ["11:1", 0]
                    data[3]["nodes"]["10:2"]["inputs"]["tail"]["source"] = ["11:1", 0]
                    data[4]["nodes"]["10:2"]["inputs"]["tail"]["source"] = ["11:1", 0]
                with self.assertRaises(ValueError):
                    verify_native_additional_inputs(*data)

    def test_promoted_cross_layer_origin_is_not_authorized(self):
        data = fixture()
        data[0]["links"] = [{"id": 7, "origin_id": 1, "origin_slot": 0, "target_id": 2,
                             "target_slot": 0, "type": "STRING", "originIsIoNode": True}]
        with self.assertRaisesRegex(ValueError, "直连"):
            verify_native_additional_inputs(*data)

    def test_reroute_or_changed_origin_endpoint_cannot_use_compiled_source(self):
        data = fixture()
        data[0]["nodes"].append({"id": 9, "type": "Reroute", "inputs": [], "outputs": [{}]})
        data[0]["links"][0][1] = 9
        with self.assertRaisesRegex(ValueError, "端点"):
            verify_native_additional_inputs(*data)

    def test_missing_evidence_or_scalar_cannot_create_authority(self):
        data = fixture()
        with self.assertRaises(ValueError):
            verify_native_additional_inputs(*data[:4], None)
        data[1]["2"]["inputs"]["tail"] = "untrusted literal"
        with self.assertRaises(ValueError):
            verify_native_additional_inputs(*data)

    def test_same_type_second_node_gets_no_contract(self):
        data = fixture()
        data[1]["3"] = {"class_type": "Merge", "inputs": {"base": "B", "tail": ["1", 0]}}
        result = verify_native_additional_inputs(*data)
        self.assertNotIn("3", result["nodes"])
        with self.assertRaises(ValueError):
            validate_prompt(data[1], data[2], result)

    def test_changed_instance_class_name_type_slot_or_link_rejects(self):
        changes = [
            lambda d: d[0]["nodes"][1].update(type="AnotherMerge"),
            lambda d: d[4]["nodes"]["2"].update(class_type="AnotherMerge"),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(name="other"),
            lambda d: d[0]["nodes"][1]["inputs"][0].update(type="IMAGE"),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(type="IMAGE"),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(workflow_slot_index=1),
            lambda d: d[0]["nodes"][1]["inputs"][0].update(link=8),
            lambda d: d[0]["links"][0].__setitem__(3, 1),
            lambda d: d[0]["links"][0].__setitem__(4, 1),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(native_source_slot=1),
        ]
        for change in changes:
            data = fixture()
            change(data)
            with self.subTest(change=changes.index(change)), self.assertRaises(ValueError):
                verify_native_additional_inputs(*data)

    def test_changed_source_class_and_missing_output_slot_reject(self):
        for change in (lambda d: d[0]["nodes"][0].update(type="AnotherText"),
                       lambda d: d[0]["nodes"][0].update(outputs=[])):
            data = fixture()
            change(data)
            with self.assertRaisesRegex(ValueError, "来源执行映射"):
                verify_native_additional_inputs(*data)

    def test_duplicate_names_nodes_links_and_definitions_are_ambiguous(self):
        changes = [
            lambda d: d[0]["nodes"][1]["inputs"].append(copy.deepcopy(d[0]["nodes"][1]["inputs"][0])),
            lambda d: d[0]["nodes"].append(copy.deepcopy(d[0]["nodes"][1])),
            lambda d: d[0]["links"].append(copy.deepcopy(d[0]["links"][0])),
        ]
        for change in changes:
            data = fixture()
            change(data)
            with self.assertRaises(ValueError):
                verify_native_additional_inputs(*data)
        data = nest(fixture())
        data[0]["definitions"]["subgraphs"].append(copy.deepcopy(data[0]["definitions"]["subgraphs"][0]))
        with self.assertRaisesRegex(ValueError, "歧义子图"):
            verify_native_additional_inputs(*data)

    def test_official_compatible_field_migrates_and_metadata_remains(self):
        data = fixture()
        definition = ["STRING", {"forceInput": True, "default": "server default"}]
        data[2]["Merge"]["input"]["required"]["tail"] = definition
        original = copy.deepcopy(data[2])
        self.assertIsNone(verify_native_additional_inputs(*data))
        self.assertEqual(data[2], original)

    def test_official_type_conflict_and_hidden_field_reject(self):
        for hidden in (False, True):
            data = fixture()
            if hidden:
                data[2]["Merge"]["input"]["hidden"] = {"tail": "PROMPT"}
            else:
                data[2]["Merge"]["input"]["required"]["tail"] = ["INT", {"min": 0, "max": 4}]
            with self.subTest(hidden=hidden), self.assertRaises(ValueError):
                verify_native_additional_inputs(*data)

    def test_official_autogrow_expansion_is_not_retained_as_extra(self):
        data = fixture()
        for fields in (data[1]["2"]["inputs"], data[3]["nodes"]["2"]["inputs"],
                       data[4]["nodes"]["2"]["inputs"]):
            fields["items.tail"] = fields.pop("tail")
        data[0]["nodes"][1]["inputs"][0]["name"] = "items.tail"
        data[4]["nodes"]["2"]["inputs"]["items.tail"]["name"] = "items.tail"
        data[2]["Merge"]["input"]["optional"] = {"items": ["COMFY_AUTOGROW_V3", {
            "template": {"names": ["tail"], "min": 0, "input": {"optional": {"value": ["STRING"]}}}}]}
        self.assertIsNone(verify_native_additional_inputs(*data))

    def test_target_union_is_observed_instead_of_inferred_from_source(self):
        data = fixture()
        data[2]["Text"]["output"] = ["IMAGE"]
        for field in (data[0]["nodes"][1]["inputs"][0], data[3]["nodes"]["2"]["inputs"]["tail"],
                      data[4]["nodes"]["2"]["inputs"]["tail"]):
            field["type"] = "IMAGE, MASK"
        data[0]["nodes"][0]["outputs"][0]["type"] = "IMAGE"
        data[0]["links"][0][5] = "IMAGE"
        result = verify_native_additional_inputs(*data)
        self.assertEqual(result["nodes"]["2"]["inputs"]["tail"]["type"], "IMAGE,MASK")
        validate_prompt(data[1], data[2], result)
        data[2]["Text"]["output"] = ["STRING"]
        with self.assertRaises(ValueError):
            validate_prompt(data[1], data[2], result)

    def test_bounded_inputs_and_diagnostics_never_carry_values(self):
        data = fixture()
        data[4]["opaque_inputs"] = [{"node_id": "2", "input": "unknown", "reason": "unproven", "value": "private"}]
        with self.assertRaisesRegex(ValueError, "诊断只能") as raised:
            verify_native_additional_inputs(*data)
        self.assertNotIn("private", str(raised.exception))
        data = fixture()
        data[4]["nodes"] = {str(i): {} for i in range(1001)}
        with self.assertRaisesRegex(ValueError, "1000"):
            verify_native_additional_inputs(*data)
        data = fixture()
        data[4]["opaque_inputs"] = [{"node_id": "2", "input": "unknown", "reason": "x" * (2 * 1024 * 1024)}]
        with self.assertRaisesRegex(ValueError, "2 MiB"):
            verify_native_additional_inputs(*data)

    def test_observation_fields_and_serialized_node_count_are_bounded(self):
        data = fixture()
        fields = data[4]["nodes"]["2"]["inputs"]
        field = fields.pop("tail")
        fields.update({"field_" + str(i): {**field, "name": "field_" + str(i)} for i in range(4097)})
        with self.assertRaisesRegex(ValueError, "4096"):
            verify_native_additional_inputs(*data)
        data = fixture()
        data[0]["nodes"].extend({"id": i, "type": "Text"} for i in range(3, 1002))
        with self.assertRaisesRegex(ValueError, "1000"):
            verify_native_additional_inputs(*data)

    def test_inactive_instances_and_inexact_slot_indices_cannot_prove(self):
        changes = [
            lambda d: d[0]["nodes"][1].update(mode=4),
            lambda d: d[0]["nodes"][0].update(mode=2),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(native_slot_index=True),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(workflow_slot_index=0.0),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(native_source_slot=2 ** 53),
            lambda d: d[4]["nodes"]["2"]["inputs"]["tail"].update(native_source_id="9"),
        ]
        for change in changes:
            data = fixture()
            change(data)
            with self.assertRaises(ValueError):
                verify_native_additional_inputs(*data)

    def test_proved_extra_fields_keep_only_portable_data(self):
        data = fixture()
        data[3]["provenance"] = {"kind": "native_compiled", "token": "private session metadata"}
        result = verify_native_additional_inputs(*data)
        self.assertEqual(set(result), {"version", "nodes"})
        self.assertEqual(result["nodes"], data[3]["nodes"])

    def test_no_contract_remains_legacy_and_audit_provenance_cannot_authorize(self):
        data = fixture()
        self.assertIsNone(verify_native_additional_inputs(data[0], data[1], data[2], None, None))
        data[3]["provenance"] = {"kind": "native_compiled", "token": "user assertion"}
        data[4]["nodes"] = {}
        with self.assertRaisesRegex(ValueError, "缺少"):
            verify_native_additional_inputs(*data)


if __name__ == "__main__":
    unittest.main()
