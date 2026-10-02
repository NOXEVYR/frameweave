"""Optional upload ports must keep engine semantics through portable packages."""

import copy
import unittest

from frameweave.editor_interfaces import inspect_interface
from frameweave.packages import apply_editor_values, apply_values, normalize_document
from frameweave.workflows import validate_editor_prompt, validate_prompt


class OptionalMediaTests(unittest.TestCase):
    def setUp(self):
        self.info = {"OptionalAudio": {
            "input": {"required": {"text": ["STRING"]}, "optional": {
                "audio": ["COMBO", {"audio_upload": True, "options": ["sample.wav"]}]}},
            "output": [], "output_node": True}}
        self.prompt = {"1": {"class_type": "OptionalAudio", "inputs": {
            "text": "local test", "audio": "sample.wav"}}}

    def test_optional_audio_stays_optional_and_blank_is_omitted_at_execution(self):
        original = copy.deepcopy(self.prompt)
        inspected = inspect_interface(self.prompt, self.info)
        audio = next(field for field in inspected["fields"] if field["input"] == "audio")
        self.assertFalse(audio["required"])
        package = normalize_document({**inspected, "name": "Optional input"})
        saved = next(field for field in package["fields"] if field["input"] == "audio")
        self.assertFalse(saved["required"])
        self.assertEqual(saved["default"], "")
        self.assertEqual(apply_editor_values(package, {})["1"]["inputs"]["audio"], "")
        self.assertEqual(validate_editor_prompt(apply_editor_values(package, {}), self.info)["issues"], [])
        executed = apply_values(package, {})
        self.assertNotIn("audio", executed["1"]["inputs"])
        validate_prompt(executed, self.info)
        with_value = apply_values(package, {audio["id"]: "sample.wav"})
        validate_prompt(with_value, self.info)
        self.assertEqual(with_value["1"]["inputs"]["audio"], "sample.wav")
        self.assertEqual(self.prompt, original)

    def test_package_cannot_override_live_required_input(self):
        package = {**inspect_interface(self.prompt, self.info), "name": "Optional input"}
        live_required = copy.deepcopy(self.info)
        inputs = live_required["OptionalAudio"]["input"]
        inputs["required"]["audio"] = inputs["optional"].pop("audio")
        with self.assertRaisesRegex(ValueError, "缺少必填输入"):
            validate_prompt(apply_values(package, {}), live_required)

    def test_legacy_required_media_normalization_remains_stable(self):
        for media, node_type, input_name in (("image", "LoadImage", "image"),
                                             ("audio", "LoadAudio", "audio"),
                                             ("video", "LoadVideo", "file")):
            with self.subTest(media=media):
                document = {"name": "Portable media", "prompt": {
                    "1": {"class_type": node_type, "inputs": {input_name: ""}}},
                    "fields": [{"id": "media", "node_id": "1", "input": input_name,
                                "label": "Media", "type": media}]}
                normalized = normalize_document(document)
                self.assertTrue(normalized["fields"][0]["required"])
                self.assertEqual(normalize_document(normalized), normalized)
                with self.assertRaises(ValueError):
                    apply_values(normalized, {})
                document["fields"][0]["required"] = False
                self.assertFalse(normalize_document(document)["fields"][0]["required"])


if __name__ == "__main__":
    unittest.main()
