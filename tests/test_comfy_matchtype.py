"""Official V3 MatchType template constraints and upstream inference."""

import copy
import unittest

from frameweave.workflows import validate_editor_prompt, validate_prompt


def match(template_id="switch", allowed="*"):
    return ["COMFY_MATCHTYPE_V3", {"template": {"template_id": template_id, "allowed_types": allowed}}]


def fixture():
    info = {
        "AudioSource": {"input": {"required": {}}, "output": ["AUDIO"]},
        "ImageSource": {"input": {"required": {}}, "output": ["IMAGE"]},
        "CustomSource": {"input": {"required": {}}, "output": ["CUSTOM"]},
        "Switch": {"input": {"required": {"switch": ["BOOLEAN"]},
                             "optional": {"on_false": match(), "on_true": match()}},
                   "output": ["COMFY_MATCHTYPE_V3"], "output_matchtypes": ["switch"]},
        "SaveAudio": {"input": {"required": {"audio": ["AUDIO"]}}, "output": [], "output_node": True},
        "SaveImage": {"input": {"required": {"image": ["IMAGE"]}}, "output": [], "output_node": True},
    }
    graph = {"1": {"class_type": "AudioSource", "inputs": {}},
             "2": {"class_type": "Switch", "inputs": {"switch": True, "on_true": ["1", 0]}},
             "3": {"class_type": "SaveAudio", "inputs": {"audio": ["2", 0]}}}
    return graph, info


class ComfyMatchTypeTests(unittest.TestCase):
    def test_audio_switch_output_is_inferred_from_connected_template(self):
        graph, info = fixture()
        before = copy.deepcopy((graph, info))
        validate_prompt(graph, info)
        self.assertEqual(validate_editor_prompt(graph, info)["issues"], [])
        self.assertEqual((graph, info), before)

    def test_chained_generic_outputs_propagate_concrete_type(self):
        graph, info = fixture()
        graph["4"] = {"class_type": "Switch", "inputs": {"switch": False, "on_false": ["2", 0]}}
        graph["3"]["inputs"]["audio"] = ["4", 0]
        validate_prompt(graph, info)

    def test_incompatible_switch_branches_fail_even_if_not_selected(self):
        graph, info = fixture()
        graph["4"] = {"class_type": "ImageSource", "inputs": {}}
        graph["2"]["inputs"]["on_false"] = ["4", 0]
        with self.assertRaisesRegex(ValueError, "连接类型不一致"):
            validate_editor_prompt(graph, info)

    def test_resolved_audio_cannot_connect_to_image_or_unknown_types(self):
        graph, info = fixture()
        graph["3"] = {"class_type": "SaveImage", "inputs": {"image": ["2", 0]}}
        with self.assertRaises(ValueError):
            validate_prompt(graph, info)
        graph, info = fixture()
        graph["1"]["class_type"] = "CustomSource"
        with self.assertRaises(ValueError):
            validate_editor_prompt(graph, info)

    def test_allowed_types_restrict_both_generic_inputs_and_output(self):
        graph, info = fixture()
        info["Switch"]["input"]["optional"] = {"on_true": match(allowed="IMAGE, LATENT")}
        with self.assertRaisesRegex(ValueError, "连接类型不一致"):
            validate_prompt(graph, info)
        info["Switch"]["input"]["optional"] = {"on_true": match(allowed="AUDIO, IMAGE")}
        validate_prompt(graph, info)

    def test_independent_templates_on_one_node_do_not_mix(self):
        graph, info = fixture()
        info["TwoTemplates"] = {"input": {"required": {"left": match("audio"), "right": match("image")}},
                                "output": ["COMFY_MATCHTYPE_V3", "COMFY_MATCHTYPE_V3"],
                                "output_matchtypes": ["audio", "image"]}
        graph["4"] = {"class_type": "ImageSource", "inputs": {}}
        graph["2"] = {"class_type": "TwoTemplates", "inputs": {"left": ["1", 0], "right": ["4", 0]}}
        graph["5"] = {"class_type": "SaveImage", "inputs": {"image": ["2", 1]}}
        validate_prompt(graph, info)
        graph["3"]["inputs"]["audio"] = ["2", 1]
        with self.assertRaises(ValueError):
            validate_prompt(graph, info)

    def test_autogrow_matchtype_members_share_the_output_template(self):
        graph, info = fixture()
        info["List"] = {"input": {"required": {"items": ["COMFY_AUTOGROW_V3", {"template": {
            "prefix": "item_", "max": 3, "min": 1, "input": {"required": {"value": match("item", "AUDIO,IMAGE")}},
        }}]}}, "output": ["COMFY_MATCHTYPE_V3"], "output_matchtypes": ["item"]}
        graph["2"] = {"class_type": "List", "inputs": {"items.item_0": ["1", 0]}}
        validate_prompt(graph, info)
        graph["4"] = {"class_type": "ImageSource", "inputs": {}}
        graph["2"]["inputs"]["items.item_1"] = ["4", 0]
        with self.assertRaises(ValueError):
            validate_prompt(graph, info)

    def test_generic_marker_without_valid_metadata_never_becomes_any(self):
        for mappings in (None, [], [None], ["absent"], ["switch", "extra"]):
            graph, info = fixture()
            info["Switch"]["output_matchtypes"] = mappings
            with self.subTest(mappings=mappings), self.assertRaises(ValueError):
                validate_editor_prompt(graph, info)
        for metadata in ({}, {"template_id": ""}, {"template_id": "switch", "allowed_types": []},
                         {"template_id": "switch", "allowed_types": ""},
                         {"template_id": "switch", "allowed_types": "AUDIO,,IMAGE"},
                         {"template_id": "switch", "allowed_types": "COMFY_MATCHTYPE_V3"}):
            graph, info = fixture()
            info["Switch"]["input"]["optional"]["on_true"][1]["template"] = metadata
            with self.subTest(metadata=metadata), self.assertRaises(ValueError):
                validate_prompt(graph, info)

    def test_unbound_generic_and_generic_cycles_are_rejected(self):
        graph, info = fixture()
        graph["2"]["inputs"].pop("on_true")
        with self.assertRaisesRegex(ValueError, "没有可解析的上游"):
            validate_prompt(graph, info)
        graph, info = fixture()
        graph["2"]["inputs"]["on_true"] = ["2", 0]
        with self.assertRaisesRegex(ValueError, "循环"):
            validate_prompt(graph, info)


if __name__ == "__main__":
    unittest.main()
