"""Official V3 Autogrow min belongs to the template input's group."""

import copy
import unittest

from frameweave.workflows import _expanded_inputs, validate_editor_prompt, validate_prompt


def autogrow(nested, *, outer="required", names=None, minimum=1):
    template = {"names": ["a", "b"] if names is None else names,
                "min": minimum, "input": nested}
    return {"input": {outer: {"items": ["COMFY_AUTOGROW_V3", {"template": template}]}},
            "output": ["STRING"]}


class AutogrowOptionalTests(unittest.TestCase):
    def test_optional_template_ignores_min_and_validates_present_values(self):
        schema = autogrow({"required": {}, "optional": {"value": ["INT"]}}, minimum=2)
        info = {"Items": schema}
        prompt = {"1": {"class_type": "Items", "inputs": {}}}
        validate_prompt(prompt, info)
        self.assertEqual(validate_editor_prompt(prompt, info)["issues"], [])
        prompt["1"]["inputs"] = {"items.b": 7}
        validate_prompt(prompt, info)
        prompt["1"]["inputs"]["items.b"] = "wrong type"
        with self.assertRaises(ValueError):
            validate_editor_prompt(prompt, info)
        prompt["1"]["inputs"] = {"items.unknown": 7}
        with self.assertRaisesRegex(ValueError, "不支持输入"):
            validate_prompt(prompt, info)

    def test_template_group_and_order_determine_required_members(self):
        for outer in ("required", "optional"):
            with self.subTest(outer=outer):
                schema = autogrow({"required": {"value": ["INT"]}, "optional": {}}, outer=outer)
                fields, required = _expanded_inputs(schema, {})
                self.assertEqual(required, {"items.a"})
                self.assertEqual(fields["items.b"], ["INT"])
                prompt = {"1": {"class_type": "Items", "inputs": {}}}
                with self.assertRaisesRegex(ValueError, "缺少必填输入"):
                    validate_prompt(prompt, {"Items": schema})
        schema = autogrow({"optional": {"value": ["STRING"]}, "required": {"unused": ["INT"]}})
        fields, required = _expanded_inputs(schema, {})
        self.assertEqual(required, set())
        self.assertEqual(fields["items.a"], ["STRING"])

    def test_installed_optional_calculator_template_accepts_zero_or_one_variable(self):
        # The installed node advertises min=2 for frontend initial sockets,
        # while its actual variable template is optional in object_info.
        schema = {"input": {"required": {
            "expression": ["STRING", {"default": "a + b", "multiline": True}],
            "variables": ["COMFY_AUTOGROW_V3", {"template": {
                "input": {"required": {}, "optional": {"var": ["INT,FLOAT,BOOLEAN", {}]}},
                "names": list("abcdefghijk"), "min": 2,
            }}],
        }}, "output": ["FLOAT", "INT", "BOOLEAN"]}
        info = {"SimpleCalculatorKJ": schema,
                "IntegerSource": {"input": {"required": {}}, "output": ["INT"]},
                "ImageSource": {"input": {"required": {}}, "output": ["IMAGE"]}}
        prompt = {"1": {"class_type": "SimpleCalculatorKJ", "inputs": {"expression": "1 + 2"}}}
        validate_prompt(prompt, info)
        prompt["2"] = {"class_type": "IntegerSource", "inputs": {}}
        prompt["1"]["inputs"] = {"expression": "b", "variables.b": ["2", 0]}
        validate_prompt(prompt, info)
        prompt["2"]["class_type"] = "ImageSource"
        with self.assertRaisesRegex(ValueError, "需要 INT,FLOAT,BOOLEAN"):
            validate_editor_prompt(prompt, info)

    def test_current_stringformat_names_and_concatenatevideo_prefix_contracts(self):
        # Reduced snapshots of the local installed official object_info schemas.
        string_schema = {"input": {"required": {
            "values": ["COMFY_AUTOGROW_V3", {"template": {
                "input": {"required": {"value": ["*", {}]}},
                "names": list("abcdefghijklmnopqrstuvwxyz"), "min": 0,
            }}], "f_string": ["STRING", {"default": "{a}", "multiline": True}],
        }}, "output": ["STRING"]}
        video_schema = {"input": {"required": {
            "videos": ["COMFY_AUTOGROW_V3", {"template": {
                "input": {"required": {"video": ["VIDEO", {}]}},
                "prefix": "video", "min": 1, "max": 100,
            }}], "codec": ["COMBO", {"options": ["auto", "h264", "av1"]}],
        }}, "output": ["VIDEO"], "is_input_list": True}
        info = {"StringFormat": string_schema, "ConcatenateVideo": video_schema,
                "TextSource": {"input": {"required": {}}, "output": ["STRING"]},
                "VideoSource": {"input": {"required": {}}, "output": ["VIDEO"]}}
        prompt = {"1": {"class_type": "TextSource", "inputs": {}},
                  "2": {"class_type": "StringFormat", "inputs": {"values.a": ["1", 0], "f_string": "{a}"}},
                  "3": {"class_type": "VideoSource", "inputs": {}},
                  "4": {"class_type": "ConcatenateVideo", "inputs": {
                      "videos.video0": ["3", 0], "videos.video1": ["3", 0], "codec": "h264"}}}
        before = copy.deepcopy((prompt, info))
        validate_prompt(prompt, info)
        self.assertEqual(validate_editor_prompt(prompt, info)["issues"], [])
        self.assertEqual((prompt, info), before)
        self.assertEqual(_expanded_inputs(string_schema, {})[1], {"f_string"})
        self.assertEqual(_expanded_inputs(video_schema, {})[1], {"videos.video0", "codec"})

    def test_malformed_template_shape_names_and_counts_raise_value_errors(self):
        baseline = autogrow({"optional": {"value": ["INT"]}})
        template = baseline["input"]["required"]["items"][1]["template"]
        mutations = [
            ("template", []), ("template", None),
            ("input", []), ("input", {"required": []}),
            ("input", {"optional": []}), ("input", {"hidden": {"value": ["INT"]}}),
            ("input", {"required": {}, "optional": {}}),
            ("input", {"optional": {"value": []}}),
            ("input", {"optional": {"value": ["COMFY_DYNAMICCOMBO_V3", {}]}}),
            ("input", {"optional": {"value": ["COMFY_AUTOGROW_V3", {}]}}),
            ("min", True), ("min", -1), ("min", 1.5), ("min", "1"), ("min", 1001),
            ("names", ["a", "a"]), ("names", [""]), ("names", [7]), ("names", "ab"),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                schema = copy.deepcopy(baseline)
                if key == "template":
                    schema["input"]["required"]["items"][1]["template"] = value
                else:
                    schema["input"]["required"]["items"][1]["template"][key] = value
                with self.assertRaises(ValueError):
                    _expanded_inputs(schema, {})
        for maximum, prefix in ((True, "v"), (-1, "v"), (1001, "v"), (2, 7), (2, "")):
            with self.subTest(maximum=maximum, prefix=prefix):
                schema = copy.deepcopy(baseline)
                target = schema["input"]["required"]["items"][1]["template"]
                target.pop("names")
                target.update(max=maximum, prefix=prefix)
                with self.assertRaises(ValueError):
                    _expanded_inputs(schema, {})
        self.assertEqual(template["names"], ["a", "b"])


if __name__ == "__main__":
    unittest.main()
