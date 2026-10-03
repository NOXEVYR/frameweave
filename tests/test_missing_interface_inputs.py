"""Live-schema missing inputs stay explicit and separate from v1 fields."""

import copy
import hashlib
import unittest

from frameweave.editor_interfaces import apply_missing_interface_values, inspect_interface
from frameweave.packages import apply_values, encoded, normalize_document, normalize_fields, validate_value
from frameweave.workflows import validate_prompt
from test_savevideo_dynamic import save_video_schema, video_prompt


def inspect_required(definitions, values=None):
    prompt = {"1": {"class_type": "Params", "inputs": values or {}}}
    info = {"Params": {"input": {"required": definitions}, "output": []}}
    return inspect_interface(prompt, info)


def field_id(node_id, name):
    return "f_" + hashlib.sha256((node_id + "\0" + name).encode()).hexdigest()[:16]


class MissingInterfaceInputTests(unittest.TestCase):
    def test_missing_savevideo_codec_does_not_guess_legacy_value_or_first_option(self):
        prompt = video_prompt(format="mp4", codec="h264")
        original = copy.deepcopy(prompt)
        info = {"VideoSource": {"input": {"required": {}}, "output": ["VIDEO"]},
                "SaveVideo": save_video_schema()}
        result = inspect_interface(prompt, info)
        field, = result["missing_fields"]
        self.assertEqual((field["node_id"], field["input"], field["type"]),
                         ("2", "format.codec", "select"))
        self.assertEqual(field["options"], ["auto", "h264", "av1"])
        self.assertTrue(field["required"])
        self.assertTrue(field["missing"])
        self.assertNotIn("default", field)
        self.assertNotIn("format.codec", result["prompt"]["2"]["inputs"])
        self.assertEqual(result["prompt"]["2"]["inputs"]["codec"], "h264")
        self.assertEqual(prompt, original)
        self.assertEqual(result["missing_issues"], [])
        self.assertNotIn("format.codec", [f["input"] for f in result["fields"]])
        with self.assertRaisesRegex(ValueError, r"format\.codec"):
            validate_prompt(prompt, info)

    def test_fresh_inspection_tracks_only_user_selected_active_branch(self):
        info = {"VideoSource": {"input": {"required": {}}, "output": ["VIDEO"]},
                "SaveVideo": save_video_schema()}
        prompt = video_prompt()
        result = inspect_interface(prompt, info)
        self.assertEqual([f["input"] for f in result["missing_fields"]], ["format"])
        prompt["2"]["inputs"]["format"] = "webm"
        result = inspect_interface(prompt, info)
        field, = result["missing_fields"]
        self.assertEqual(field["input"], "format.codec")
        self.assertEqual(field["options"], ["auto", "av1"])
        prompt["2"]["inputs"].update({"format.codec": "av1",
                                      "format.codec.encoding": "re-encode"})
        result = inspect_interface(prompt, info)
        crf, = result["missing_fields"]
        self.assertEqual(crf["input"], "format.codec.encoding.crf")
        self.assertEqual((crf["type"], crf["min"], crf["max"], crf["default"]),
                         ("number", 0.0, 63.0, 23.0))
        self.assertNotIn(crf["input"], result["prompt"]["2"]["inputs"])
        with self.assertRaisesRegex(ValueError, "crf"):
            validate_prompt(prompt, info)
        prompt["2"]["inputs"][crf["input"]] = 21.5
        self.assertEqual(inspect_interface(prompt, info)["missing_fields"], [])
        validate_prompt(prompt, info)
        # Changing the actual selector removes the old active descendant.
        prompt["2"]["inputs"].pop(crf["input"])
        prompt["2"]["inputs"]["format.codec.encoding"] = "auto"
        self.assertEqual(inspect_interface(prompt, info)["missing_fields"], [])

    def test_explicit_dynamic_default_does_not_activate_its_branch(self):
        result = inspect_required({"mode": ["COMFY_DYNAMICCOMBO_V3", {
            "default": "fast", "options": [{"key": "fast", "inputs": {
                "required": {"count": ["INT", {"default": 3}]},
            }}],
        }]})
        field, = result["missing_fields"]
        self.assertEqual((field["input"], field["default"]), ("mode", "fast"))
        self.assertEqual(result["prompt"]["1"]["inputs"], {})
        self.assertEqual(result["fields"], [])

    def test_missing_scalar_types_and_metadata_have_stable_binding_ids(self):
        result = inspect_required({"text": ["STRING"], "seed": ["INT", {"min": 0, "max": 9}],
                                   "seconds": ["FLOAT"], "enabled": ["BOOLEAN"],
                                   "choice": [[False, 1, 1.5, "fine"]]})
        fields = {f["input"]: f for f in result["missing_fields"]}
        self.assertEqual({name: f["type"] for name, f in fields.items()}, {
            "text": "text", "seed": "integer", "seconds": "number",
            "enabled": "boolean", "choice": "select"})
        for name, field in fields.items():
            self.assertNotIn("default", field)
            self.assertEqual(field["id"], "f_" + hashlib.sha256(("1\0" + name).encode()).hexdigest()[:16])
        self.assertEqual(fields["text"]["presentation"], "port")
        self.assertTrue(fields["seed"]["recommended"])
        result["prompt"]["1"]["inputs"]["seed"] = 3
        current = inspect_required({"seed": ["INT", {"min": 0, "max": 9}]}, {"seed": 3})
        self.assertEqual(current["fields"][0]["id"], fields["seed"]["id"])
        self.assertEqual(current["missing_fields"], [])

    def test_only_explicit_strictly_valid_schema_defaults_are_returned(self):
        result = inspect_required({
            "integer": ["INT", {"default": 0}], "number": ["FLOAT", {"default": 1}],
            "boolean": ["BOOLEAN", {"default": False}], "text": ["STRING", {"default": ""}],
            "choice": [["first", "second"], {"default": "second"}],
            "absent": [["first", "second"]],
        })
        fields = {f["input"]: f for f in result["missing_fields"]}
        self.assertEqual({name: f["default"] for name, f in fields.items() if "default" in f},
                         {"integer": 0, "number": 1, "boolean": False, "text": "", "choice": "second"})
        self.assertNotIn("default", fields["absent"])
        self.assertEqual(result["prompt"]["1"]["inputs"], {})

    def test_invalid_defaults_are_never_coerced_or_replaced(self):
        definitions = {"boolean_int": ["INT", {"default": True}],
                       "float_int": ["INT", {"default": 1.0}],
                       "string_number": ["FLOAT", {"default": "1"}],
                       "number_bool": ["BOOLEAN", {"default": 1}],
                       "null": ["STRING", {"default": None}],
                       "object": ["STRING", {"default": {}}],
                       "unsafe": ["INT", {"default": 9007199254740992}],
                       "infinite": ["FLOAT", {"default": float("inf")}],
                       "huge": ["FLOAT", {"default": 1e30}],
                       "range": ["FLOAT", {"min": 0, "max": 1, "default": 2}],
                       "wrong_choice_type": [[1], {"default": True}],
                       "wrong_choice": [["first"], {"default": "other"}]}
        result = inspect_required(definitions)
        self.assertEqual(len(result["missing_fields"]), len(definitions))
        self.assertTrue(all("default" not in f for f in result["missing_fields"]))

    def test_link_media_and_hidden_inputs_are_diagnostics_not_scalar_repairs(self):
        result = inspect_required({
            "tensor": ["IMAGE"], "linked": ["INT", {"forceInput": True}],
            "raw": ["STRING", {"rawLink": True}], "hidden": ["STRING", {"hidden": True}],
            "image": [["input.png"], {"image_upload": True}],
            "audio": ["STRING", {"audio_upload": True}],
            "custom_media": [["input.mp4"], {"video_upload": True, "upload_route": "/custom"}],
            "many": [["one"], {"multiselect": True}],
        })
        self.assertEqual(result["missing_fields"], [])
        self.assertEqual({issue["input"]: issue["reason"] for issue in result["missing_issues"]}, {
            "tensor": "unsupported_type", "linked": "link_only", "raw": "link_only", "hidden": "hidden",
            "image": "media_input", "audio": "media_input", "custom_media": "media_input", "many": "multiselect"})
        self.assertTrue(all(issue["code"] == "missing_input_uneditable" for issue in result["missing_issues"]))

    def test_present_links_and_optional_missing_inputs_do_not_become_repairs(self):
        prompt = {"1": {"class_type": "Source", "inputs": {}},
                  "2": {"class_type": "Params", "inputs": {"count": ["1", 0]}}}
        info = {"Source": {"input": {"required": {}}, "output": ["INT"]},
                "Params": {"input": {"required": {"count": ["INT"]},
                                     "optional": {"text": ["STRING"]}}, "output": []}}
        result = inspect_interface(prompt, info)
        self.assertEqual(result["fields"], [])
        self.assertEqual(result["missing_fields"], [])
        self.assertEqual(result["missing_issues"], [])
        self.assertEqual(result["prompt"], prompt)

    def test_empty_and_unsafe_enums_are_diagnosed(self):
        for options in ([], [None], [{}], [["1", 0]], [9007199254740992],
                        [float("nan")], [1e30], ["x" * 2049], list(range(513))):
            with self.subTest(options=options):
                result = inspect_required({"choice": [options]})
                self.assertEqual(result["missing_fields"], [])
                self.assertEqual(result["missing_issues"][0]["reason"],
                                 "empty_options" if not options else "invalid_options")
        result = inspect_required({"mode": ["COMFY_DYNAMICCOMBO_V3", {"options": []}]})
        self.assertEqual(result["missing_issues"][0]["reason"], "empty_options")
        self.assertEqual(inspect_required({"choice": ["COMBO"]})["missing_issues"][0]["reason"], "invalid_options")

    def test_invalid_numeric_bounds_are_not_clamped_into_fake_contracts(self):
        for meta in ({"min": True}, {"max": float("inf")}, {"min": "0"},
                     {"min": -9007199254740992}, {"min": 2, "max": 1}):
            with self.subTest(meta=meta):
                result = inspect_required({"count": ["INT", meta]})
                self.assertEqual(result["missing_fields"], [])
                self.assertEqual(result["missing_issues"][0]["reason"], "invalid_bounds")

    def test_missing_candidates_and_diagnostics_share_existing_inspection_budget(self):
        definitions = {f"count_{index}": ["INT"] for index in range(4096)}
        self.assertEqual(len(inspect_required(definitions)["missing_fields"]), 4096)
        definitions["tensor"] = ["IMAGE"]
        with self.assertRaisesRegex(ValueError, "4096"):
            inspect_required(definitions)

    def test_legacy_package_bytes_and_missing_binding_contract_are_unchanged(self):
        document = {"format": "frameweave-workflow", "version": 1, "name": "Legacy", "description": "",
                    "prompt": {"1": {"class_type": "Params", "inputs": {"text": "original"}}},
                    "fields": [{"id": "text", "label": "Text", "node_id": "1", "input": "text",
                                "type": "text", "required": False, "default": "original"}]}
        before = encoded(document)
        info = {"Params": {"input": {"required": {"text": ["STRING"], "seed": ["INT"]}}, "output": []}}
        result = inspect_interface(document["prompt"], info)
        self.assertEqual(encoded(document), before)
        self.assertEqual(encoded(normalize_document(document)), before)
        with self.assertRaisesRegex(ValueError, "输入不存在"):
            normalize_fields(result["missing_fields"], copy.deepcopy(result["prompt"]))
        # Mutating a response descriptor must not modify backend schema.
        enum_info = {"Params": {"input": {"required": {"mode": [["one", "two"]]}}, "output": []}}
        result = inspect_interface({"1": {"class_type": "Params", "inputs": {}}}, enum_info)
        result["missing_fields"][0]["options"].append("other")
        self.assertEqual(enum_info["Params"]["input"]["required"]["mode"][0], ["one", "two"])

    def test_repairs_apply_explicit_values_through_multiple_dynamic_levels(self):
        prompt = video_prompt(codec="h264")
        original = copy.deepcopy(prompt)
        info = {"VideoSource": {"input": {"required": {}}, "output": ["VIDEO"]},
                "SaveVideo": save_video_schema()}
        # Required inner selectors are introduced by each selected branch.
        codec_options = info["SaveVideo"]["input"]["required"]["format"][1]["options"]
        for format_option in codec_options:
            for codec_option in format_option["inputs"]["required"]["codec"][1]["options"]:
                optional = codec_option["inputs"].pop("optional", {})
                codec_option["inputs"]["required"].update(optional)
        values = {field_id("2", "format.codec.encoding.crf"): 19.5,
                  field_id("2", "format.codec.encoding"): "re-encode",
                  field_id("2", "format.codec"): "h264", field_id("2", "format"): "mp4"}
        result = apply_missing_interface_values(prompt, info, values)
        self.assertEqual([repair["input"] for repair in result["repairs"]],
                         ["format", "format.codec", "format.codec.encoding", "format.codec.encoding.crf"])
        self.assertEqual(result["prompt"]["2"]["inputs"]["format.codec.encoding.crf"], 19.5)
        self.assertEqual(result["prompt"]["2"]["inputs"]["codec"], "h264")
        self.assertEqual(prompt, original)
        self.assertEqual(values[field_id("2", "format.codec.encoding.crf")], 19.5)
        validate_prompt(result["prompt"], info)

    def test_repairs_never_apply_defaults_or_overwrite_existing_inputs(self):
        prompt = {"1": {"class_type": "Params", "inputs": {"text": "original"}}}
        info = {"Params": {"input": {"required": {"text": ["STRING"],
                                                  "seed": ["INT", {"default": 3}]}}, "output": [], "output_node": True}}
        empty = apply_missing_interface_values(prompt, info, {})
        self.assertEqual(empty, {"prompt": prompt, "repairs": []})
        self.assertIsNot(empty["prompt"], prompt)
        with self.assertRaisesRegex(ValueError, "已存在"):
            apply_missing_interface_values(prompt, info, {field_id("1", "text"): "new"})
        repaired = apply_missing_interface_values(prompt, info, {field_id("1", "seed"): 0})
        self.assertEqual(repaired["prompt"]["1"]["inputs"]["seed"], 0)
        self.assertNotIn("seed", prompt["1"]["inputs"])
        with self.assertRaises(ValueError):
            apply_missing_interface_values(repaired["prompt"], info, {field_id("1", "seed"): 1})

    def test_empty_and_explicit_repairs_preserve_all_allowed_source_metadata(self):
        prompt = {"1": {"class_type": "Params", "inputs": {},
                        "_meta": {"title": "Original user title", "notes": ["Keep", {"kind": "note"}]},
                        "properties": {"renderer": "custom", "revision": 1.0},
                        "flags": {"collapsed": False}}}
        original = copy.deepcopy(prompt)
        info = {"Params": {"input": {"required": {"count": ["INT"]}},
                           "output": [], "output_node": True}}
        for values in ({}, {field_id("1", "count"): 0}):
            with self.subTest(values=values):
                result = apply_missing_interface_values(prompt, info, values)
                for key in ("_meta", "properties", "flags"):
                    self.assertEqual(result["prompt"]["1"][key], original["1"][key])
                expected = copy.deepcopy(original)
                if values:
                    expected["1"]["inputs"]["count"] = 0
                self.assertEqual(result["prompt"], expected)
                self.assertEqual(prompt, original)
                result["prompt"]["1"]["_meta"]["notes"].append("response edit")
                self.assertEqual(prompt, original)

    def test_repairs_reject_unknown_inactive_optional_and_uneditable_bindings_atomically(self):
        prompt = {"1": {"class_type": "Params", "inputs": {}}}
        info = {"Params": {"input": {"required": {
            "mode": ["COMFY_DYNAMICCOMBO_V3", {"options": [
                {"key": "fast", "inputs": {"required": {"count": ["INT"]}}},
                {"key": "slow", "inputs": {"required": {"quality": ["FLOAT"]}}}]}],
            "image": [["input.png"], {"image_upload": True}],
        }, "optional": {"optional": ["INT"]}}, "output": [], "output_node": True}}
        for binding in ("unknown", "mode.quality", "optional", "image"):
            with self.subTest(binding=binding), self.assertRaises(ValueError):
                apply_missing_interface_values(prompt, info, {field_id("1", "mode"): "fast",
                                                            field_id("1", binding): 1})
            self.assertEqual(prompt["1"]["inputs"], {})

    def test_repairs_validate_types_options_ranges_and_json_safety(self):
        prompt = {"1": {"class_type": "Params", "inputs": {}}}
        info = {"Params": {"input": {"required": {
            "count": ["INT", {"min": 0, "max": 5}], "enabled": ["BOOLEAN"],
            "text": ["STRING"], "choice": [[1, "one"]],
        }}, "output": [], "output_node": True}}
        for name, value in (("count", True), ("count", 1.0), ("count", -1), ("count", 6),
                            ("count", 9007199254740992), ("count", float("nan")),
                            ("enabled", 1), ("text", ""), ("text", {}),
                            ("choice", True), ("choice", "unknown"), ("choice", ["1", 0])):
            with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                apply_missing_interface_values(prompt, info, {field_id("1", name): value})
            self.assertEqual(prompt["1"]["inputs"], {})
        for values in (None, [], {1: 0}, {"": 0}, {str(index): 0 for index in range(4097)}):
            with self.subTest(values=type(values).__name__), self.assertRaises(ValueError):
                apply_missing_interface_values(prompt, info, values)

    def test_repairs_are_limited_to_selected_output_ancestry(self):
        prompt = {"A": {"class_type": "Output", "inputs": {}},
                  "B": {"class_type": "Output", "inputs": {}}}
        original = copy.deepcopy(prompt)
        info = {"Output": {"input": {"required": {"count": ["INT"]}},
                           "output": [], "output_node": True}}
        inspected = inspect_interface(prompt, info, output_nodes=["B"])
        self.assertEqual({field["node_id"] for field in inspected["missing_fields"]}, {"A", "B"})
        self.assertEqual(inspected["execution"]["node_ids"], ["B"])
        with self.assertRaisesRegex(ValueError, "不参与所选输出"):
            apply_missing_interface_values(prompt, info, {field_id("A", "count"): 1}, output_nodes=["B"])
        self.assertEqual(prompt, original)
        applied = apply_missing_interface_values(prompt, info, {field_id("A", "count"): 0}, output_nodes=["A"])
        self.assertEqual(applied["prompt"]["A"]["inputs"], {"count": 0})
        self.assertEqual(applied["prompt"]["B"]["inputs"], {})
        validate_prompt({"A": applied["prompt"]["A"]}, info)
        both = apply_missing_interface_values(prompt, info,
            {field_id("A", "count"): 1, field_id("B", "count"): 2})
        validate_prompt(both["prompt"], info)
        self.assertEqual(prompt, original)

    def test_selected_scope_includes_upstream_inputs_but_never_arbitrary_terminals(self):
        prompt = {"params": {"class_type": "Params", "inputs": {}},
                  "island": {"class_type": "Params", "inputs": {}},
                  "out": {"class_type": "Sink", "inputs": {"value": ["params", 0]}}}
        info = {"Params": {"input": {"required": {"count": ["INT"]}}, "output": ["INT"]},
                "Sink": {"input": {"required": {"value": ["INT"]}}, "output": [], "output_node": True}}
        result = apply_missing_interface_values(prompt, info, {field_id("params", "count"): 3}, output_nodes=["out"])
        self.assertEqual(result["prompt"]["params"]["inputs"], {"count": 3})
        with self.assertRaises(ValueError):
            apply_missing_interface_values(prompt, info, {field_id("island", "count"): 3})
        info["Sink"]["output_node"] = False
        with self.assertRaises(ValueError):
            apply_missing_interface_values(prompt, info, {field_id("params", "count"): 3})

    def test_numeric_selects_follow_json_number_semantics_without_boolean_coercion(self):
        prompt = {"1": {"class_type": "Output", "inputs": {}}}
        info = {"Output": {"input": {"required": {"choice": [[1.0, 2.5]]}},
                           "output": [], "output_node": True}}
        result = apply_missing_interface_values(prompt, info, {field_id("1", "choice"): 1})
        self.assertIs(type(result["prompt"]["1"]["inputs"]["choice"]), int)
        inspected = inspect_interface(result["prompt"], info)
        document = {"name": "Numeric JSON enum", "description": "", "prompt": result["prompt"],
                    "fields": inspected["fields"]}
        self.assertEqual(apply_values(document, {field_id("1", "choice"): 1})["1"]["inputs"]["choice"], 1)
        field = inspected["fields"][0]
        self.assertEqual(validate_value({**field, "options": [1]}, 1.0), 1.0)
        for value in (True, "1", None, {}, [], float("nan"), float("inf"), 9007199254740992):
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_value(field, value)
        for value in (1, 1.0, "true"):
            with self.subTest(boolean_option=value), self.assertRaises(ValueError):
                validate_value({**field, "options": [True]}, value)
        self.assertTrue(validate_value({**field, "options": [True]}, True))
        for unsafe in (9007199254740992, float("inf"), float("nan"), 1e30):
            with self.subTest(unsafe=unsafe), self.assertRaises(ValueError):
                validate_value({**field, "options": [unsafe]}, unsafe)
        self.assertEqual(prompt["1"]["inputs"], {})


if __name__ == "__main__":
    unittest.main()
