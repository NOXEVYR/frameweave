"""Validate VHS format widgets against the selected backend declaration."""

import copy
import unittest

from frameweave.editor_interfaces import inspect_interface
from frameweave.workflows import validate_prompt


def video_info():
    return {
        "ImageSource": {"input": {"required": {}}, "output": ["IMAGE"]},
        "VHS_VideoCombine": {
            "input": {"required": {
                "images": ["IMAGE"],
                "format": [["video/h264-mp4", "image/webp", "image/gif"], {
                    "formats": {
                        "video/h264-mp4": [
                            ["pix_fmt", ["yuv420p", "yuv420p10le"]],
                            ["crf", "INT", {"default": 19, "min": 0, "max": 100, "step": 1}],
                            ["save_metadata", "BOOLEAN", {"default": True}],
                            ["trim_to_audio", "BOOLEAN", {"default": False}],
                        ],
                        "image/webp": [["lossless", "BOOLEAN", {"default": True}]],
                    },
                }],
                "save_output": ["BOOLEAN", {"default": True}],
            }},
            "output": ["VHS_FILENAMES"],
            "output_node": True,
        },
    }


def video_prompt(format_name="video/h264-mp4", **widgets):
    return {
        "1": {"class_type": "ImageSource", "inputs": {}},
        "2": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["1", 0], "format": format_name, "save_output": True, **widgets,
        }},
    }


class VideoFormatInputTests(unittest.TestCase):
    def test_accepts_selected_format_widgets_without_mutating_inputs(self):
        info = video_info()
        prompt = video_prompt(pix_fmt="yuv420p", crf=19,
                              save_metadata=False, trim_to_audio=False)
        before = copy.deepcopy((info, prompt))
        validate_prompt(prompt, info)
        self.assertEqual((info, prompt), before)

    def test_allows_omitted_widgets_with_backend_defaults(self):
        for format_name in ("video/h264-mp4", "image/webp", "image/gif"):
            with self.subTest(format=format_name):
                validate_prompt(video_prompt(format_name), video_info())

    def test_rejects_undeclared_kwargs(self):
        for name in ("unknown", "manual_format_widgets", "no_preview"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "不支持输入"):
                validate_prompt(video_prompt(**{name: True}), video_info())

    def test_rejects_wrong_widget_values_and_types(self):
        for widgets in ({"pix_fmt": "rgb48le"}, {"crf": -1}, {"crf": 101},
                        {"crf": "19"}, {"crf": True}, {"save_metadata": "false"},
                        {"trim_to_audio": 0}):
            with self.subTest(widgets=widgets), self.assertRaises(ValueError):
                validate_prompt(video_prompt(**widgets), video_info())

    def test_rejects_widgets_from_other_formats(self):
        for format_name, widgets in (
            ("video/h264-mp4", {"lossless": True}),
            ("image/webp", {"crf": 19}),
            ("image/gif", {"pix_fmt": "yuv420p"}),
        ):
            with self.subTest(format=format_name), self.assertRaisesRegex(ValueError, "不支持输入"):
                validate_prompt(video_prompt(format_name, **widgets), video_info())

    def test_format_metadata_does_not_add_selector_choices(self):
        info = video_info()
        info["VHS_VideoCombine"]["input"]["required"]["format"][1]["formats"]["unknown"] = [
            ["extra", "INT"],
        ]
        with self.assertRaisesRegex(ValueError, "选项不在当前后端"):
            validate_prompt(video_prompt("unknown", extra=1), info)

    def test_inspection_exposes_selected_options_and_numeric_bounds(self):
        prompt = video_prompt(pix_fmt="yuv420p10le", crf=21, save_metadata=False)
        result = inspect_interface(prompt, video_info())
        fields = {field["input"]: field for field in result["fields"] if field["node_id"] == "2"}
        self.assertEqual(fields["pix_fmt"]["type"], "select")
        self.assertEqual(fields["pix_fmt"]["options"], ["yuv420p", "yuv420p10le"])
        self.assertEqual(fields["pix_fmt"]["default"], "yuv420p10le")
        self.assertEqual(fields["crf"]["type"], "integer")
        self.assertEqual({key: fields["crf"][key] for key in ("min", "max")},
                         {"min": 0, "max": 100})
        self.assertEqual(fields["crf"]["default"], 21)
        self.assertEqual(fields["save_metadata"]["type"], "boolean")
        self.assertNotIn("lossless", fields)

    def test_widget_substitutions_are_not_treated_as_input_definitions(self):
        info = video_info()
        widgets = info["VHS_VideoCombine"]["input"]["required"]["format"][1]["formats"]["video/h264-mp4"]
        widgets.append(["filter", ["none", "soft"], {"default": "none"}, "filter=$val"])
        validate_prompt(video_prompt(filter="soft"), info)
        with self.assertRaises(ValueError):
            validate_prompt(video_prompt(filter="undeclared"), info)

    def test_format_widgets_cannot_override_static_input_validation(self):
        info = video_info()
        widgets = info["VHS_VideoCombine"]["input"]["required"]["format"][1]["formats"]["video/h264-mp4"]
        widgets.append(["save_output", "STRING"])
        with self.assertRaisesRegex(ValueError, "必须为布尔值"):
            validate_prompt(video_prompt(save_output="yes"), info)


if __name__ == "__main__":
    unittest.main()
