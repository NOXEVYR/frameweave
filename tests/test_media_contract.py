"""Live filename contracts must not guess tensor, URL or custom transports."""
import copy
import unittest

from frameweave.media_contract import media_input_contract


class MediaContractTests(unittest.TestCase):
    def contract(self, definition, **kwargs):
        return media_input_contract("ThirdPartyLoader", "source", definition, **kwargs)

    def test_standard_third_party_uploads_and_empty_options(self):
        for media in ("image", "video", "audio"):
            for kind in ("COMBO", [], ["example"]):
                with self.subTest(media=media, kind=kind):
                    result = self.contract([kind, {media + "_upload": True, "options": []}], required=False)
                    self.assertTrue(result["supported"])
                    self.assertEqual(result["media_type"], media)
                    self.assertEqual(result["transport"], "comfy_input_filename")
                    self.assertEqual(result["storage_type"], "input")
                    self.assertEqual(result["cardinality"], "single")
                    self.assertFalse(result["required"])
                    self.assertFalse(result["legacy"])
                    self.assertTrue(all(mime.startswith(media + "/") for mime in result["accept"]))

    def test_string_audio_upload_is_explicit_legacy_compatibility(self):
        result = self.contract(["STRING", {"audio_upload": True}])
        self.assertTrue(result["supported"])
        self.assertTrue(result["legacy"])
        self.assertEqual(result["media_type"], "audio")

    def test_plain_strings_or_tensor_outputs_do_not_infer_media(self):
        for kind in ("STRING", "AUDIO", "IMAGE", "VIDEO", "FLOAT"):
            result = self.contract([kind, {}])
            self.assertFalse(result["supported"])
            self.assertEqual(result["reason"], "not_media")

    def test_non_filename_upload_kinds_are_rejected_with_type_retained(self):
        for kind in ("IMAGE", "AUDIO", "VIDEO", "COMFY_DYNAMICCOMBO_V3", "STRING"):
            result = self.contract([kind, {"image_upload": True}])
            self.assertFalse(result["supported"])
            self.assertEqual(result["reason"], "not_filename_combo")
            self.assertEqual(result["media_type"], "image")

    def test_classic_loader_fallback_is_bounded(self):
        for node, name, media in (("LoadImage", "image", "image"),
                                  ("LoadImageMask", "image", "image"),
                                  ("VHS_LoadVideo", "video", "video"),
                                  ("LoadAudio", "audio", "audio")):
            result = media_input_contract(node, name, [["example"]])
            self.assertTrue(result["supported"])
            self.assertTrue(result["legacy"])
            self.assertEqual(result["media_type"], media)
        self.assertEqual(media_input_contract("LoadVideo", "file", ["COMBO", {}])["reason"], "not_media")
        self.assertEqual(media_input_contract("LoadImage", "other", [["example"]])["reason"], "not_media")

    def test_explicit_false_does_not_enable_legacy_fallback(self):
        result = media_input_contract("LoadImage", "image", [[], {"image_upload": False}])
        self.assertFalse(result["supported"])
        self.assertEqual(result["reason"], "upload_disabled")

    def test_output_folder_and_custom_transports_are_not_input_uploads(self):
        for metadata, reason in (({"image_folder": "output"}, "non_input_storage"),
                                 ({"folder": "temp"}, "non_input_storage"),
                                 ({"storage_type": "output"}, "non_input_storage"),
                                 ({"remote": {"route": "/internal/files/output"}}, "custom_transport_unsupported"),
                                 ({"upload_url": "http://example.invalid"}, "custom_transport_unsupported"),
                                 ({"upload_endpoint": "/special"}, "custom_transport_unsupported"),
                                 ({"custom_upload": True}, "custom_transport_unsupported")):
            result = self.contract(["COMBO", {"image_upload": True, **metadata}])
            self.assertFalse(result["supported"])
            self.assertEqual(result["reason"], reason)
            self.assertEqual(result["media_type"], "image")
        self.assertTrue(self.contract(["COMBO", {"image_upload": True, "image_folder": "input"}])["supported"])

    def test_multiple_or_invalid_flags_and_options_rejected(self):
        cases = (({"audio_upload": True, "video_upload": True}, "conflicting_upload_flags"),
                 ({"audio_upload": "true"}, "invalid_upload_flag"),
                 ({"audio_upload": True, "image_upload": 1}, "invalid_upload_flag"),
                 ({"audio_upload": True, "multiselect": True}, "multiple_files_unsupported"),
                 ({"audio_upload": True, "options": [4]}, "non_filename_options"),
                 ({"audio_upload": True, "options": "file.wav"}, "non_filename_options"))
        for meta, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(self.contract(["COMBO", meta])["reason"], reason)
        conflict = self.contract(["COMBO", {"audio_upload": True, "video_upload": True}])
        self.assertEqual(conflict["media_types"], ["video", "audio"])

    def test_invalid_schema_returns_reason_without_mutation(self):
        for value in (None, {}, [], ["COMBO", 2], ["COMBO", {}, {}]):
            self.assertFalse(self.contract(value)["supported"])
        self.assertEqual(media_input_contract({}, "source", ["COMBO"])["reason"], "invalid_binding")
        definition = ["COMBO", {"audio_upload": True, "options": ["original.wav"]}]
        original = copy.deepcopy(definition)
        first = self.contract(definition)
        first["accept"].append("private/test")
        self.assertEqual(definition, original)
        self.assertNotIn("private/test", self.contract(definition)["accept"])


if __name__ == "__main__":
    unittest.main()
