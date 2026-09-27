"""Validate flattened inputs in ComfyUI's nested SaveVideo dynamic combos."""

import unittest

from frameweave.packages import inspect_document
from frameweave.workflows import compile_workflow, validate_prompt
from test_workflows import fixture as workflow_fixture


def _option(key, inputs):
    return {"key": key, "inputs": inputs}


def _dynamic(options):
    return ["COMFY_DYNAMICCOMBO_V3", {"options": options}]


def save_video_schema():
    crf = ["FLOAT", {"default": 23.0, "min": 0.0, "max": 63.0, "step": 1.0}]
    encoding = _dynamic([
        _option("auto", {"required": {}}),
        _option("re-encode", {"required": {"crf": crf}}),
    ])

    def codec_options(include_h264=True):
        options = [_option("auto", {"required": {}})]
        if include_h264:
            options.append(_option("h264", {"required": {}, "optional": {"encoding": encoding}}))
        options.append(_option("av1", {"required": {}, "optional": {"encoding": encoding}}))
        return _dynamic(options)

    format_options = []
    for name in ("auto", "mp4", "mkv"):
        format_options.append(_option(name, {"required": {"codec": codec_options()}}))
    format_options.append(_option("webm", {"required": {"codec": codec_options(include_h264=False)}}))
    return {
        "input": {
            "required": {
                "video": ["VIDEO"],
                "filename_prefix": ["STRING", {"default": "video/ComfyUI"}],
                "format": _dynamic(format_options),
            },
            # Current ComfyUI also declares this independent compatibility field.
            "optional": {"codec": codec_options()},
        },
        "output": ["VIDEO"],
        "output_node": True,
    }


def video_prompt(**inputs):
    return {
        "1": {"class_type": "VideoSource", "inputs": {}},
        "2": {"class_type": "SaveVideo", "inputs": {
            "video": ["1", 0], "filename_prefix": "video/test", **inputs,
        }},
    }


class SaveVideoDynamicTests(unittest.TestCase):
    def setUp(self):
        self.info = {
            "VideoSource": {"input": {"required": {}}, "output": ["VIDEO"]},
            "SaveVideo": save_video_schema(),
        }

    def test_accepts_flattened_required_codec_under_selected_format(self):
        validate_prompt(video_prompt(**{"format": "mp4", "format.codec": "h264"}), self.info)

    def test_nested_required_codec_is_not_satisfied_by_root_compatibility_field(self):
        with self.assertRaisesRegex(ValueError, r"SaveVideo 缺少必填输入：.*format\.codec"):
            validate_prompt(video_prompt(format="mp4", codec="h264"), self.info)

    def test_reencode_branch_requires_flattened_crf(self):
        base = {"format": "mp4", "format.codec": "h264",
                "format.codec.encoding": "re-encode"}
        with self.assertRaisesRegex(ValueError, "format.codec.encoding.crf"):
            validate_prompt(video_prompt(**base), self.info)
        validate_prompt(video_prompt(**{**base, "format.codec.encoding.crf": 21.5}), self.info)

    def test_rejects_fields_from_unselected_nested_branch(self):
        with self.assertRaisesRegex(ValueError, "不支持输入 format.codec.encoding.crf"):
            validate_prompt(video_prompt(**{
                "format": "mp4", "format.codec": "h264",
                "format.codec.encoding": "auto", "format.codec.encoding.crf": 21.0,
            }), self.info)

    def test_rejects_unsupported_branch_choices_and_unknown_inputs(self):
        for inputs in (
            {"format": "unknown", "format.codec": "h264"},
            {"format": "mp4", "format.codec": "vp9"},
            {"format": "webm", "format.codec": "h264"},
            {"format": "mp4", "format.codec": "h264", "manual_codec": "h264"},
        ):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                validate_prompt(video_prompt(**inputs), self.info)

    def test_reencode_numeric_value_uses_selected_branch_bounds(self):
        inputs = {"format": "mp4", "format.codec": "h264",
                  "format.codec.encoding": "re-encode"}
        for crf in (-1.0, 64.0, "23"):
            with self.subTest(crf=crf), self.assertRaises(ValueError):
                validate_prompt(video_prompt(**{**inputs, "format.codec.encoding.crf": crf}), self.info)

    def test_inspection_exposes_dynamic_combo_keys_and_preserves_selected_defaults(self):
        prompt = video_prompt(**{
            "format": "mp4", "format.codec": "h264",
            "format.codec.encoding": "re-encode", "format.codec.encoding.crf": 21.5,
        })
        result = inspect_document(prompt, self.info)
        fields = {field["input"]: field for field in result["fields"] if field["node_id"] == "2"}
        for name, choices, selected in (
            ("format", ["auto", "mp4", "mkv", "webm"], "mp4"),
            ("format.codec", ["auto", "h264", "av1"], "h264"),
            ("format.codec.encoding", ["auto", "re-encode"], "re-encode"),
        ):
            with self.subTest(name=name):
                self.assertEqual(fields[name]["type"], "select")
                self.assertEqual(fields[name]["options"], choices)
                self.assertEqual(fields[name]["default"], selected)

    def test_inspection_refreshes_nested_options_for_the_selected_format(self):
        mp4 = inspect_document(video_prompt(**{"format": "mp4", "format.codec": "h264"}), self.info)
        webm = inspect_document(video_prompt(**{"format": "webm", "format.codec": "av1"}), self.info)
        fields = lambda result: {field["input"]: field for field in result["fields"] if field["node_id"] == "2"}
        self.assertIn("h264", fields(mp4)["format.codec"]["options"])
        self.assertNotIn("h264", fields(webm)["format.codec"]["options"])
        self.assertEqual(fields(webm)["format.codec"]["options"], ["auto", "av1"])

    def test_inspection_preserves_unknown_dynamic_default_without_whitelisting_it(self):
        result = inspect_document(video_prompt(format="unknown"), self.info)
        field = next(field for field in result["fields"]
                     if field["node_id"] == "2" and field["input"] == "format")
        self.assertEqual(field["type"], "select")
        self.assertEqual(field["default"], "unknown")
        self.assertEqual(field["options"], ["auto", "mp4", "mkv", "webm"])

    def test_inspection_keeps_legacy_root_codec_separate_from_nested_codec(self):
        result = inspect_document(video_prompt(format="mp4", codec="h264"), self.info)
        fields = {field["input"]: field for field in result["fields"] if field["node_id"] == "2"}
        self.assertIn("codec", fields)
        self.assertEqual(fields["codec"]["default"], "h264")
        self.assertNotIn("format.codec", fields)

    def test_h3_compiler_emits_the_backend_declared_flattened_codec_field(self):
        info = workflow_fixture()
        info["SaveVideo"] = save_video_schema()
        result = compile_workflow({"kind": "h3_t2v", "positive": "A blue paper bird."}, info)
        save_video = next(node["inputs"] for node in result["prompt"].values()
                          if node["class_type"] == "SaveVideo")
        self.assertEqual(save_video["format"], "mp4")
        self.assertEqual(save_video["format.codec"], "h264")
        self.assertNotIn("codec", save_video)


if __name__ == "__main__":
    unittest.main()
