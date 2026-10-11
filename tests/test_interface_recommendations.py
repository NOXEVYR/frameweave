"""Fresh imports expose schema-backed resource selectors without name-only guessing."""
import unittest

from frameweave.editor_interfaces import inspect_interface


class InterfaceRecommendationTests(unittest.TestCase):
    def test_fresh_model_encoder_vae_lora_and_sampling_controls_are_recommended(self):
        definitions = {
            "CheckpointLoaderSimple": {"ckpt_name": [["base.safetensors"]]},
            "DualCLIPLoader": {"clip_name1": [["clip.safetensors"]], "clip_name2": ["COMBO", {"options": ["t5.safetensors"]}]},
            "VAELoader": {"vae_name": [["vae.safetensors"]]},
            "LoraLoader": {"lora_name": [["style.safetensors"]], "strength_model": ["FLOAT"], "strength_clip": ["FLOAT"]},
            "SamplerCustom": {"sampler_name": [["euler", "dpmpp_2m"]], "scheduler": [["normal", "karras"]]},
        }
        info, prompt = {}, {}
        for node_id, (node_type, fields) in enumerate(definitions.items(), 1):
            info[node_type] = {"input": {"required": fields}, "output": [], "output_node": True}
            values = {key: spec[0][0] if isinstance(spec[0], list)
                      else spec[1]["options"][0] if spec[0] == "COMBO" else 0.7 for key, spec in fields.items()}
            prompt[str(node_id)] = {"class_type": node_type, "inputs": values}
        fields = inspect_interface(prompt, info)["fields"]
        self.assertEqual(len(fields), 9)
        self.assertTrue(all(field["recommended"] for field in fields))
        self.assertTrue(all(field["presentation"] == "control" for field in fields))
        self.assertEqual(next(field for field in fields if field["input"] == "strength_clip")["type"], "number")

    def test_unproven_model_names_and_arbitrary_enums_are_not_default_recommendations(self):
        prompt = {"1": {"class_type": "CustomUtility", "inputs": {
            "model_path": "local/path", "model_counter": 5, "mode": "model", "filename_prefix": "model-output"}}}
        info = {"CustomUtility": {"input": {"required": {
            "model_path": ["STRING"], "model_counter": ["INT"], "mode": [["model", "preview"]],
            "filename_prefix": ["STRING"]}}, "output": [], "output_node": True}}
        fields = inspect_interface(prompt, info)["fields"]
        self.assertEqual(len(fields), 4)
        self.assertTrue(all(not field["recommended"] for field in fields))

    def test_generic_conditioning_caption_lyrics_and_duration_are_recommended(self):
        prompt = {"1": {"class_type": "ThirdPartyConditioner", "inputs": {
            "caption": "A relaxed instrumental", "lyrics": "[Instrumental]",
            "max_duration": 15.0, "duration": 12, "top_k": 50}}}
        info = {"ThirdPartyConditioner": {"input": {"required": {
            "caption": ["STRING", {"multiline": True}], "lyrics": ["STRING"],
            "max_duration": ["FLOAT"], "duration": ["INT"], "top_k": ["INT"]}},
            "output": ["CONDITIONING", "FLOAT"]}}
        fields = {f["input"]: f for f in inspect_interface(prompt, info)["fields"]}
        for name in ("caption", "lyrics"):
            self.assertTrue(fields[name]["recommended"])
            self.assertEqual((fields[name]["role"], fields[name]["presentation"]), ("prompt", "port"))
        for name in ("duration", "max_duration"):
            self.assertTrue(fields[name]["recommended"])
            self.assertEqual((fields[name]["role"], fields[name]["presentation"]), ("size", "control"))
        self.assertFalse(fields["top_k"]["recommended"])

    def test_subtitle_or_export_caption_is_not_a_prompt_by_name(self):
        for output, sink in [(["STRING"], False), (["AUDIO"], False), (["CONDITIONING"], True), ([], False)]:
            with self.subTest(output=output, sink=sink):
                values = {name: "kept" for name in ("caption", "lyrics", "output_caption", "caption_path", "duration_path")}
                prompt = {"1": {"class_type": "SubtitleUtility", "inputs": values}}
                info = {"SubtitleUtility": {"input": {"required": {name: ["STRING"] for name in values}},
                                             "output": output, "output_node": sink}}
                fields = inspect_interface(prompt, info)["fields"]
                self.assertTrue(all(not f["recommended"] and f["presentation"] == "control" for f in fields))

    def test_aliases_still_require_real_string_or_numeric_schema_types(self):
        values = {"caption": "preset", "lyrics": 2, "duration": "15", "max_duration": "short"}
        prompt = {"1": {"class_type": "OtherConditioner", "inputs": values}}
        info = {"OtherConditioner": {"input": {"required": {"caption": [["preset"]], "lyrics": ["INT"],
                    "duration": ["STRING"], "max_duration": [["short"]]}}, "output": ["CONDITIONING"]}}
        fields = inspect_interface(prompt, info)["fields"]
        self.assertTrue(all(not f["recommended"] and f["presentation"] == "control" for f in fields))


if __name__ == "__main__":
    unittest.main()
