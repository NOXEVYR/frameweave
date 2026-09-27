"""Pure interface discovery, reconciliation, and output selection tests."""

import copy
import unittest

from frameweave.editor_interfaces import (inspect_interface, reconcile_interface,
                                          select_outputs)
from frameweave.packages import inspect_document


def param_info():
    return {
        "Params": {"input": {"required": {
            "text": ["STRING"],
            "seed": ["INT", {"min": 0, "max": 100}],
            "mode": [["fast", "quality"]],
            "ckpt_name": [["base.safetensors", "other.safetensors"]],
            "clip_name": [["encoder.safetensors"]],
            "lora_name": [["style.safetensors", "none"]],
        }}, "output": [], "output_node": False},
        "LoadImage": {"input": {"required": {
            "image": [["input.png", "other.png"]],
        }}, "output": ["IMAGE"], "output_node": False},
        "Text": {"input": {"required": {"text": ["STRING"]}},
                 "output": ["STRING"], "output_node": False},
        "Pass": {"input": {"required": {"value": ["STRING"]}},
                 "output": ["STRING"], "output_node": False},
        "Sink": {"input": {"required": {"value": ["STRING"]}},
                 "output": [], "output_node": True},
        "NotSink": {"input": {"required": {"value": ["STRING"]}},
                    "output": ["STRING"], "output_node": False},
        "SaveImage": {"input": {"required": {"images": ["IMAGE"]}},
                       "output": [], "output_node": True},
        "VHS_VideoCombine": {"input": {"required": {"images": ["IMAGE"]}},
                              "output": [], "output_node": True},
        "SaveAudio": {"input": {"required": {"audio": ["AUDIO"]}},
                      "output": [], "output_node": True},
        "UnknownOutput": {"input": {"required": {"value": ["STRING"]}},
                          "output": ["CUSTOM"], "output_node": True},
    }


def params_prompt(text="hello", seed=10, mode="fast"):
    return {"1": {"class_type": "Params", "inputs": {
        "text": text, "seed": seed, "mode": mode,
        "ckpt_name": "base.safetensors", "clip_name": "encoder.safetensors",
        "lora_name": "style.safetensors",
    }}}


class EditorInterfaceTests(unittest.TestCase):
    def test_inspection_includes_model_encoder_lora_and_prompt_roles(self):
        prompt = params_prompt()
        prompt["2"] = {"class_type": "Text", "inputs": {"text": "positive"},
                       "_meta": {"title": "Positive prompt"}}
        prompt["3"] = {"class_type": "Sink", "inputs": {"value": ["2", 0]}}
        info = param_info()
        info["Sink"]["input"]["required"]["value"] = ["STRING"]

        result = inspect_interface(prompt, info)
        self.assertEqual(result["prompt"]["1"]["inputs"]["text"], "hello")
        by_input = {(field["node_id"], field["input"]): field
                    for field in result["fields"]}
        self.assertEqual(by_input[("1", "ckpt_name")]["role"], "model")
        self.assertEqual(by_input[("1", "ckpt_name")]["group"], "模型")
        self.assertEqual(by_input[("1", "clip_name")]["role"], "encoder")
        self.assertEqual(by_input[("1", "clip_name")]["group"], "编码器")
        self.assertEqual(by_input[("1", "lora_name")]["role"], "lora")
        self.assertEqual(by_input[("1", "lora_name")]["group"], "LoRA")
        self.assertEqual(by_input[("2", "text")]["role"], "positive_prompt")
        self.assertEqual(by_input[("2", "text")]["group"], "提示词")
        self.assertEqual(result["outputs"], [{
            "id": "3", "label": "Sink · 3", "mediaType": "unknown",
        }])

    def test_inspection_allows_graphs_without_output_candidates(self):
        result = inspect_interface(
            {"1": {"class_type": "Text", "inputs": {"text": "draft"}}},
            param_info(),
        )
        self.assertEqual(result["outputs"], [])

    def test_inspection_reports_known_and_schema_inferred_output_media(self):
        prompt = {
            "1": {"class_type": "SaveImage", "inputs": {"images": ["4", 0]},
                  "_meta": {"title": "Still frame"}},
            "2": {"class_type": "VHS_VideoCombine", "inputs": {"images": ["4", 0]}},
            "3": {"class_type": "SaveAudio", "inputs": {"audio": ["4", 0]}},
            "4": {"class_type": "UnknownOutput", "inputs": {"value": "asset"}},
            "5": {"class_type": "NotSink", "inputs": {"value": "skip"}},
        }
        result = inspect_interface(prompt, param_info())
        self.assertEqual(result["outputs"], [
            {"id": "1", "label": "Still frame", "mediaType": "image"},
            {"id": "2", "label": "VHS_VideoCombine · 2", "mediaType": "video"},
            {"id": "3", "label": "SaveAudio · 3", "mediaType": "audio"},
            {"id": "4", "label": "UnknownOutput · 4", "mediaType": "unknown"},
        ])

    def test_video_loader_file_widgets_are_exposed_as_video_reference_fields(self):
        prompt = {
            "1": {"class_type": "LoadVideo", "inputs": {"file": "existing.mp4"}},
            "2": {"class_type": "VHS_LoadVideo", "inputs": {"video": "existing.mov"}},
        }
        info = {
            "LoadVideo": {"input": {"required": {"file": ["COMBO", {
                "options": ["existing.mp4"], "video_upload": True,
            }]}}, "output": ["VIDEO"]},
            "VHS_LoadVideo": {"input": {"required": {"video": [["existing.mov"]]}},
                              "output": ["IMAGE", "AUDIO"]},
        }
        result = inspect_interface(prompt, info)
        by_binding = {(field["node_id"], field["input"]): field for field in result["fields"]}
        for binding, value in ((('1', 'file'), 'existing.mp4'), (('2', 'video'), 'existing.mov')):
            with self.subTest(binding=binding):
                field = by_binding[binding]
                self.assertEqual(field["type"], "video")
                self.assertEqual(field["default"], value)
                self.assertEqual(field["role"], "video_reference")
                self.assertEqual(field["group"], "参考素材")
        self.assertEqual(result["prompt"]["1"]["inputs"]["file"], "existing.mp4")

    def test_inspect_document_field_limits_keep_required_media_first(self):
        prompt = {"1": {"class_type": "LoadImage", "inputs": {"image": "input.png"}},
                  "2": {"class_type": "Params", "inputs": {
                      **{f"custom_{index}": index for index in range(70)},
                      "mode": "fast",
                  }}}
        info = param_info()

        default_fields = inspect_document(prompt, info)["fields"]
        all_fields = inspect_document(prompt, info, field_limit=None)["fields"]
        limited = inspect_document(prompt, info, field_limit=1)["fields"]
        self.assertEqual(len(default_fields), 64)
        self.assertGreater(len(all_fields), 64)
        self.assertEqual(len(limited), 1)
        self.assertEqual(limited[0]["type"], "image")

        oversized = {"1": {"class_type": "Params", "inputs": {
            f"value_{index}": index for index in range(4097)
        }}}
        with self.assertRaisesRegex(ValueError, "4096"):
            inspect_document(oversized, info, field_limit=None)
        with self.assertRaisesRegex(ValueError, "field_limit"):
            inspect_document(prompt, info, field_limit=4097)

    def test_output_selection_keeps_only_selected_outputs_and_ancestors(self):
        info = param_info()
        prompt = {
            "1": {"class_type": "Text", "inputs": {"text": "source"}},
            "2": {"class_type": "Pass", "inputs": {"value": ["1", 0]}},
            "3": {"class_type": "Sink", "inputs": {"value": ["2", 0]}},
            "4": {"class_type": "Sink", "inputs": {"value": ["1", 0]}},
            "5": {"class_type": "Text", "inputs": {"text": "unused branch"}},
            "editor_extension": {"vendor": "preserve me"},
        }
        unchanged = select_outputs(prompt, None, info)
        self.assertEqual(unchanged, prompt)
        self.assertIsNot(unchanged, prompt)
        self.assertIsNot(unchanged["1"], prompt["1"])
        selected = select_outputs(prompt, ["3"], info)
        self.assertEqual(list(selected), ["1", "2", "3"])
        self.assertNotIn("4", selected)
        self.assertNotIn("5", selected)
        both = select_outputs(prompt, ["3", "4"], info)
        self.assertEqual(set(both), {"1", "2", "3", "4"})

    def test_output_selection_rejects_invalid_duplicates_cycles_and_non_outputs(self):
        info = param_info()
        prompt = {
            "1": {"class_type": "Text", "inputs": {"text": "source"}},
            "2": {"class_type": "Sink", "inputs": {"value": ["1", 0]}},
            "3": {"class_type": "NotSink", "inputs": {"value": "x"}},
        }
        for outputs in ([], ["missing"], ["2", "2"], ["3"], ["2"] * 65):
            with self.subTest(outputs=outputs[:3]), self.assertRaises(ValueError):
                select_outputs(prompt, outputs, info)

        cyclic = {
            "1": {"class_type": "Pass", "inputs": {"value": ["2", 0]}},
            "2": {"class_type": "Pass", "inputs": {"value": ["1", 0]}},
            "3": {"class_type": "Sink", "inputs": {"value": ["1", 0]}},
        }
        with self.assertRaisesRegex(ValueError, "循环"):
            select_outputs(cyclic, ["3"], info)

    def test_reconcile_three_way_preserves_valid_outer_values_and_reports_conflicts(self):
        info = param_info()
        baseline_prompt = params_prompt()
        old_fields = inspect_interface(baseline_prompt, info)["fields"]
        old_by_input = {field["input"]: field for field in old_fields}
        selected_old = [old_by_input["seed"], old_by_input["mode"]]
        previous_baseline = {field["id"]: field["default"] for field in selected_old}

        # The outer value changed while the editor retained its baseline.
        outer_only = reconcile_interface(
            selected_old,
            {old_by_input["seed"]["id"]: 22, old_by_input["mode"]["id"]: "fast"},
            inspect_interface(baseline_prompt, info)["fields"],
            baseline_prompt, previous_baseline,
        )
        self.assertEqual(outer_only["values"][old_by_input["seed"]["id"]], 22)

        # An internal-only edit flows through when the outer value stayed at baseline.
        inner_prompt = params_prompt(seed=20)
        inner_fields = inspect_interface(inner_prompt, info)["fields"]
        inner_only = reconcile_interface(selected_old, previous_baseline, inner_fields,
                                          inner_prompt, previous_baseline)
        self.assertEqual(inner_only["values"][old_by_input["seed"]["id"]], 20)
        self.assertTrue(any(item["previous"]["input"] == "seed"
                            for item in inner_only["changes"]["changed"]))

        # Independent edits to both sides require a UI choice and are not silently applied.
        conflict = reconcile_interface(
            selected_old,
            {old_by_input["seed"]["id"]: 22, old_by_input["mode"]["id"]: "fast"},
            inner_fields, inner_prompt, previous_baseline,
        )
        self.assertNotIn(old_by_input["seed"]["id"], conflict["values"])
        self.assertEqual(conflict["changes"]["conflicts"], [{
            "id": old_by_input["seed"]["id"],
            "field_id": old_by_input["seed"]["id"],
            "label": inner_only["changes"]["changed"][0]["current"]["label"],
            "field": conflict["changes"]["conflicts"][0]["field"],
            "old_baseline": 10, "outer": 22, "inner": 20,
        }])
        self.assertFalse(conflict["changes"]["legacy"])

    def test_reconcile_reports_invalid_values_removed_new_and_legacy_mode(self):
        info = param_info()
        old_prompt = params_prompt(seed=10)
        old_fields = inspect_interface(old_prompt, info)["fields"]
        old_seed = next(field for field in old_fields if field["input"] == "seed")
        previous_baseline = {old_seed["id"]: 10}

        changed_prompt = params_prompt(seed=20)
        new_prompt = copy.deepcopy(changed_prompt)
        new_prompt["2"] = {"class_type": "Params", "inputs": {"seed": 5}}
        # Reuse an ID from a different binding: identity is the full binding tuple.
        new_seed = {**old_seed, "node_id": "2", "input": "seed", "default": 5}
        rebound = reconcile_interface([old_seed], {old_seed["id"]: 99}, [new_seed],
                                      new_prompt, previous_baseline)
        self.assertEqual(rebound["values"][old_seed["id"]], 5)
        self.assertEqual(len(rebound["changes"]["removed"]), 1)
        self.assertEqual(len(rebound["changes"]["new"]), 1)

        fresh_fields = inspect_interface(changed_prompt, info)["fields"]
        current_seed = next(field for field in fresh_fields if field["input"] == "seed")
        invalid = reconcile_interface([old_seed], {old_seed["id"]: 999},
                                      [current_seed], changed_prompt,
                                      previous_baseline)
        self.assertNotIn(current_seed["id"], invalid["values"])
        self.assertEqual(invalid["changes"]["invalid_value"][0]["value"], 999)
        self.assertEqual(invalid["changes"]["conflicts"][0]["allowed"], ["inner"])
        self.assertEqual(invalid["changes"]["conflicts"][0]["inner"], 20)

        legacy = reconcile_interface([old_seed], {old_seed["id"]: 30},
                                     [current_seed], changed_prompt)
        self.assertTrue(legacy["changes"]["legacy"])
        self.assertEqual(legacy["values"][current_seed["id"]], 30)

    def test_reconcile_explicit_rebinding_moves_old_value_and_reports_target_conflicts(self):
        info = param_info()
        old_prompt = params_prompt(seed=10)
        old_fields = inspect_interface(old_prompt, info)["fields"]
        old_seed = next(field for field in old_fields if field["input"] == "seed")
        baseline = {old_seed["id"]: 10}

        new_prompt = copy.deepcopy(old_prompt)
        new_prompt["2"] = copy.deepcopy(old_prompt["1"])
        new_prompt["2"]["inputs"]["seed"] = 12
        new_fields = inspect_interface(new_prompt, info)["fields"]
        target_seed = next(field for field in new_fields
                           if field["node_id"] == "2" and field["input"] == "seed")
        rebindings = {old_seed["id"]: target_seed["id"]}

        migrated = reconcile_interface(
            [old_seed], {old_seed["id"]: 12}, [target_seed], new_prompt,
            baseline, rebindings,
        )
        self.assertEqual(migrated["values"][target_seed["id"]], 12)
        self.assertEqual(migrated["changes"]["removed"], [])
        self.assertEqual(migrated["changes"]["new"], [])

        conflict = reconcile_interface(
            [old_seed], {old_seed["id"]: 14}, [target_seed], new_prompt,
            baseline, rebindings,
        )
        self.assertNotIn(target_seed["id"], conflict["values"])
        self.assertEqual(len(conflict["changes"]["conflicts"]), 1)
        self.assertEqual(conflict["changes"]["conflicts"][0]["field_id"],
                         target_seed["id"])
        self.assertEqual((conflict["changes"]["conflicts"][0]["outer"],
                          conflict["changes"]["conflicts"][0]["inner"]), (14, 12))

        invalid = reconcile_interface(
            [old_seed], {old_seed["id"]: -1}, [target_seed], new_prompt,
            baseline, rebindings,
        )
        self.assertEqual(invalid["changes"]["conflicts"][0]["allowed"], ["inner"])
        self.assertEqual(invalid["changes"]["conflicts"][0]["inner"], 12)

    def test_reconcile_rebinding_null_discards_and_invalid_mappings_are_rejected(self):
        info = param_info()
        old_prompt = params_prompt()
        old_prompt["2"] = copy.deepcopy(old_prompt["1"])
        old_fields = inspect_interface(old_prompt, info)["fields"]
        old_seed = next(field for field in old_fields
                        if field["node_id"] == "1" and field["input"] == "seed")
        old_second_seed = next(field for field in old_fields
                               if field["node_id"] == "2" and field["input"] == "seed")
        new_prompt = copy.deepcopy(old_prompt)
        new_prompt["3"] = copy.deepcopy(old_prompt["1"])
        new_fields = inspect_interface(new_prompt, info)["fields"]
        target_seed = next(field for field in new_fields
                           if field["node_id"] == "3" and field["input"] == "seed")
        target_text = next(field for field in new_fields
                           if field["node_id"] == "3" and field["input"] == "text")

        discarded = reconcile_interface(
            [old_seed], {old_seed["id"]: 99}, [old_seed], old_prompt,
            {old_seed["id"]: 10}, {old_seed["id"]: None},
        )
        self.assertEqual(discarded["values"][old_seed["id"]], 10)
        self.assertEqual([field["id"] for field in discarded["changes"]["removed"]],
                         [old_seed["id"]])
        self.assertEqual([field["id"] for field in discarded["changes"]["new"]],
                         [old_seed["id"]])

        invalid_mappings = [
            ({"missing-old": target_seed["id"]}, [target_seed]),
            ({old_seed["id"]: "missing-target"}, [target_seed]),
            ({old_seed["id"]: target_seed["id"]}, [target_text]),
            ({old_seed["id"]: target_seed["id"],
              old_second_seed["id"]: target_seed["id"]}, [target_seed]),
        ]
        for mapping, selected in invalid_mappings:
            with self.subTest(mapping=mapping), self.assertRaises(ValueError):
                reconcile_interface([old_seed, old_second_seed], {}, selected,
                                    new_prompt, {}, mapping)

    def test_deep_output_dependency_is_a_user_error(self):
        prompt = {"0": {"class_type": "Text", "inputs": {"text": "start"}}}
        for index in range(1, 999):
            prompt[str(index)] = {"class_type": "Pass", "inputs": {"value": [str(index - 1), 0]}}
        prompt["999"] = {"class_type": "Sink", "inputs": {"value": ["998", 0]}}
        with self.assertRaisesRegex(ValueError, "256"):
            select_outputs(prompt, ["999"], param_info())


if __name__ == "__main__":
    unittest.main()
