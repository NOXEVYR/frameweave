import unittest

from frameweave.audio_workflows import audio_capabilities
from frameweave.workflows import catalog, compile_workflow, generation_options, validate_prompt


def schema(required, output, optional=None, output_node=False):
    return {"input": {"required": required, "optional": optional or {}},
            "output": output, "output_node": output_node}


def image_schema():
    number = ["FLOAT", {"min": 0, "max": 100}]
    integer = ["INT", {"min": 0, "max": 2**64 - 1}]
    text = ["STRING"]
    image = ["IMAGE"]
    latent = ["LATENT"]
    conditioning = ["CONDITIONING"]
    return {
        "CheckpointLoaderSimple": schema({"ckpt_name": [["checkpoints/test_sdxl.safetensors"]]},
                                          ["MODEL", "CLIP", "VAE"]),
        "DualCLIPLoader": schema({
            "clip_name1": [["text_encoders/clip_l.safetensors"]],
            "clip_name2": [["text_encoders/clip_g.safetensors"]],
            "type": [["sdxl", "flux"]],
        }, ["CLIP"]),
        "VAELoader": schema({"vae_name": [["vae/test_sdxl_vae.safetensors"]]}, ["VAE"]),
        "CLIPTextEncode": schema({"clip": ["CLIP"], "text": text}, ["CONDITIONING"]),
        "EmptyLatentImage": schema({"width": integer, "height": integer, "batch_size": integer}, ["LATENT"]),
        "LoadImage": schema({"image": [["reference.png"]]}, ["IMAGE", "MASK"]),
        "ImageScale": schema({"image": image, "upscale_method": [["lanczos"]],
                               "width": integer, "height": integer, "crop": [["center"]]}, ["IMAGE"]),
        "VAEEncode": schema({"pixels": image, "vae": ["VAE"]}, ["LATENT"]),
        "KSampler": schema({"model": ["MODEL"], "seed": integer, "steps": ["INT", {"min": 1, "max": 1000}],
                             "cfg": number, "sampler_name": [["euler"]], "scheduler": [["simple"]],
                             "positive": conditioning, "negative": conditioning,
                             "latent_image": latent, "denoise": ["FLOAT", {"min": 0, "max": 1}]}, ["LATENT"]),
        "LatentUpscale": schema({"samples": latent, "upscale_method": [["nearest-exact", "bislerp"]],
                                 "width": ["INT", {"min": 0, "max": 16384, "step": 8}],
                                 "height": ["INT", {"min": 0, "max": 16384, "step": 8}],
                                 "crop": [["disabled", "center"]]}, ["LATENT"]),
        "VAEDecode": schema({"samples": latent, "vae": ["VAE"]}, ["IMAGE"]),
        "SaveImage": schema({"images": image, "filename_prefix": text}, ["IMAGE"], output_node=True),
    }


def typed_audio_schema():
    return {
        "ToneGenerator": schema({"prompt": ["STRING"]}, ["AUDIO"]),
        "AudioWriter": schema({"audio": ["AUDIO"], "filename_prefix": ["STRING"]}, ["AUDIO"], output_node=True),
        "SaveAudioMP3": schema({"audio": ["AUDIO"], "filename_prefix": ["STRING"]}, ["AUDIO"], output_node=True),
        "LoadAudio": schema({"audio": [["existing.wav"]]}, ["AUDIO"]),
        "ImageLoader": schema({"image": [["input.png"]]}, ["IMAGE"]),
        "SaveImage": schema({"images": ["IMAGE"]}, ["IMAGE"], output_node=True),
    }


def audio_package(package_id, prompt, **extra):
    return {"id": package_id, "name": package_id, "prompt": prompt,
            "fields": [],
            "requirements": {"nodes": sorted({node["class_type"] for node in prompt.values()})}, **extra}


class GenerationExtensionTests(unittest.TestCase):
    def setUp(self):
        self.info = image_schema()

    def compile(self, kind="sdxl", **kwargs):
        request = {"kind": kind, "positive": "A sunlit room with plants."}
        request.update(kwargs)
        return compile_workflow(request, self.info)

    @staticmethod
    def nodes(result, class_type):
        return [(node_id, node["inputs"]) for node_id, node in result["prompt"].items()
                if node["class_type"] == class_type]

    def test_live_options_disclose_sdxl_dual_encoder_and_refine_schema(self):
        options = generation_options(self.info)
        self.assertTrue(options["sdxl_clip"]["available"])
        self.assertEqual(options["sdxl_clip"]["types"], ["sdxl", "flux"])
        self.assertEqual(options["sdxl_clip"]["clip_name1"], ["text_encoders/clip_l.safetensors"])
        self.assertEqual(options["sdxl_clip"]["clip_name2"], ["text_encoders/clip_g.safetensors"])
        self.assertTrue(options["refine"]["available"])
        self.assertEqual(options["refine"]["upscale_methods"], ["nearest-exact", "bislerp"])
        self.assertFalse(options["refine"]["missing"])

    def test_external_sdxl_encoders_and_vae_override_are_schema_checked(self):
        result = self.compile(models={"sdxl_clip_l": "text_encoders/clip_l.safetensors",
                                     "sdxl_clip_g": "text_encoders/clip_g.safetensors",
                                     "vae": "vae/test_sdxl_vae.safetensors"})
        clip_id, clip_inputs = self.nodes(result, "DualCLIPLoader")[0]
        self.assertEqual(clip_inputs["type"], "sdxl")
        self.assertEqual(clip_inputs["clip_name1"], "text_encoders/clip_l.safetensors")
        self.assertEqual(clip_inputs["clip_name2"], "text_encoders/clip_g.safetensors")
        self.assertEqual(self.nodes(result, "CLIPTextEncode")[0][1]["clip"], [clip_id, 0])
        vae_id, vae_inputs = self.nodes(result, "VAELoader")[0]
        self.assertEqual(vae_inputs["vae_name"], "vae/test_sdxl_vae.safetensors")
        self.assertEqual(self.nodes(result, "VAEDecode")[0][1]["vae"], [vae_id, 0])
        self.assertEqual(result["summary"]["models"]["sdxl_clip_l"], "text_encoders/clip_l.safetensors")

    def test_sdxl_external_clip_pair_and_family_are_enforced(self):
        with self.assertRaisesRegex(ValueError, "必须成对"):
            self.compile(models={"sdxl_clip_l": "text_encoders/clip_l.safetensors"})
        with self.assertRaisesRegex(ValueError, "sdxl_clip_l"):
            self.compile("sdxl", models={"sdxl_clip_l": "text_encoders/clip_g.safetensors",
                                          "sdxl_clip_g": "text_encoders/clip_l.safetensors"})
        with self.assertRaisesRegex(ValueError, "只支持 SDXL"):
            self.compile("krea", models={"sdxl_clip_l": "text_encoders/clip_l.safetensors",
                                         "sdxl_clip_g": "text_encoders/clip_g.safetensors"})

    def test_external_clip_requires_live_sdxl_dual_loader(self):
        del self.info["DualCLIPLoader"]
        options = generation_options(self.info)["sdxl_clip"]
        self.assertFalse(options["available"])
        self.assertTrue(options["reason"])
        with self.assertRaisesRegex(ValueError, "DualCLIPLoader"):
            self.compile(models={"sdxl_clip_l": "text_encoders/clip_l.safetensors",
                                 "sdxl_clip_g": "text_encoders/clip_g.safetensors"})

    def test_live_loader_without_sdxl_mode_is_not_accepted(self):
        self.info["DualCLIPLoader"]["input"]["required"]["type"] = [["flux"]]
        options = generation_options(self.info)["sdxl_clip"]
        self.assertFalse(options["available"])
        with self.assertRaisesRegex(ValueError, "type=sdxl"):
            self.compile(models={"sdxl_clip_l": "text_encoders/clip_l.safetensors",
                                 "sdxl_clip_g": "text_encoders/clip_g.safetensors"})

    def test_refinement_adds_upscale_and_second_sampler_to_same_graph(self):
        result = self.compile(width=768, height=512, refine={
            "enabled": True, "width": 1536, "height": 1024,
            "steps": 9, "denoise": 0.22, "upscale_method": "bislerp",
        })
        samplers = self.nodes(result, "KSampler")
        upscale_id, upscale = self.nodes(result, "LatentUpscale")[0]
        self.assertEqual(len(samplers), 2)
        self.assertEqual(upscale["samples"], [samplers[0][0], 0])
        self.assertEqual((upscale["width"], upscale["height"]), (1536, 1024))
        self.assertEqual(upscale["crop"], "disabled")
        self.assertEqual(samplers[1][1]["latent_image"], [upscale_id, 0])
        self.assertEqual(samplers[1][1]["steps"], 9)
        self.assertEqual(samplers[1][1]["denoise"], 0.22)
        self.assertEqual(self.nodes(result, "VAEDecode")[0][1]["samples"], [samplers[1][0], 0])
        self.assertEqual(result["summary"]["refine"]["steps"], 9)

    def test_refinement_also_chains_from_the_sdxl_image_edit_sample(self):
        result = self.compile("sdxl_i2i", references=["reference.png"], width=768, height=512,
                              refine={"enabled": True, "width": 1024, "height": 768,
                                      "steps": 6, "denoise": 0.15})
        samplers = self.nodes(result, "KSampler")
        upscale_id, upscale = self.nodes(result, "LatentUpscale")[0]
        self.assertEqual(upscale["samples"], [samplers[0][0], 0])
        self.assertEqual(samplers[1][1]["latent_image"], [upscale_id, 0])
        self.assertEqual(self.nodes(result, "VAEDecode")[0][1]["samples"], [samplers[1][0], 0])

    def test_refine_capability_gaps_are_reported_and_requests_fail_closed(self):
        del self.info["LatentUpscale"]
        options = generation_options(self.info)["refine"]
        self.assertFalse(options["available"])
        self.assertIn("LatentUpscale", options["missing"])
        with self.assertRaisesRegex(ValueError, "LatentUpscale"):
            self.compile(refine={"enabled": True})

    def test_refine_capability_checks_wire_types_not_only_node_names(self):
        self.info["LatentUpscale"]["input"]["required"]["samples"] = ["IMAGE"]
        options = generation_options(self.info)["refine"]
        self.assertFalse(options["available"])
        self.assertIn("LatentUpscale.samples:LATENT", options["missing"])
        with self.assertRaisesRegex(ValueError, "samples:LATENT"):
            self.compile(refine={"enabled": True})

    def test_refinement_is_sdxl_only_and_validates_all_fields(self):
        with self.assertRaisesRegex(ValueError, "只支持 SDXL"):
            self.compile("krea", refine={"enabled": True})
        for refine in (
            {"enabled": "true"},
            {"enabled": True, "extra": 1},
            {"enabled": True, "width": 1001},
            {"enabled": True, "steps": 0},
            {"enabled": True, "denoise": 1.1},
            {"enabled": True, "upscale_method": "unlisted"},
        ):
            with self.subTest(refine=refine), self.assertRaises(ValueError):
                self.compile(refine=refine)

    def test_legacy_requests_and_disabled_refinement_keep_single_sampler_graph(self):
        legacy = self.compile()
        disabled = self.compile(refine={"enabled": False})
        self.assertEqual(legacy["prompt"], disabled["prompt"])
        self.assertEqual(len(self.nodes(legacy, "KSampler")), 1)
        self.assertFalse(self.nodes(legacy, "LatentUpscale"))


class AudioCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.info = typed_audio_schema()
        self.good = audio_package("pkg-good", {
            "1": {"class_type": "ToneGenerator", "inputs": {"prompt": "A soft melody"}},
            "2": {"class_type": "AudioWriter", "inputs": {"audio": ["1", 0], "filename_prefix": "audio/result"}},
        }, category="music")

    def test_audio_packages_are_live_schema_checked_without_fixed_save_node_name(self):
        result = audio_capabilities(self.info, [self.good])
        self.assertTrue(result["available"])
        self.assertTrue(result["schema_available"])
        self.assertIn({"class_type": "AudioWriter", "input": "audio", "type": "AUDIO"}, result["outputs"])
        package = result["packages"][0]
        self.assertTrue(package["eligible"])
        self.assertEqual(package["category"], "music")
        self.assertEqual(package["audio_outputs"], [{"type": "audio", "node_id": "2",
                                                        "class_type": "AudioWriter", "input": "audio"}])
        self.assertEqual(package["fields"], self.good["fields"])

    def test_unsupported_packages_remain_visible_with_reasons(self):
        image_only = audio_package("pkg-image", {
            "1": {"class_type": "ImageLoader", "inputs": {"image": "input.png"}},
            "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
        })
        missing_node = audio_package("pkg-missing", {
            "1": {"class_type": "MissingAudioNode", "inputs": {}},
        })
        result = audio_capabilities(self.info, [self.good, image_only, missing_node])
        self.assertEqual(len(result["packages"]), 3)
        self.assertTrue(result["packages"][0]["eligible"])
        self.assertFalse(result["packages"][1]["eligible"])
        self.assertIsNotNone(result["packages"][1]["reason"])
        self.assertFalse(result["packages"][2]["schema_supported"])
        self.assertTrue(result["packages"][2]["reason"])

    def test_audio_output_connection_type_must_be_real_audio(self):
        wrong_type = audio_package("pkg-wrong-type", {
            "1": {"class_type": "ImageLoader", "inputs": {"image": "input.png"}},
            "2": {"class_type": "SaveAudioMP3", "inputs": {"audio": ["1", 0], "filename_prefix": "bad"}},
        })
        result = audio_capabilities(self.info, [wrong_type])
        self.assertFalse(result["available"])
        self.assertFalse(result["packages"][0]["schema_supported"])

    def test_blank_upload_placeholder_is_eligible_but_other_parameters_stay_strict(self):
        upload = audio_package("pkg-upload", {
            "1": {"class_type": "LoadAudio", "inputs": {"audio": ""}},
            "2": {"class_type": "AudioWriter", "inputs": {"audio": ["1", 0], "filename_prefix": "audio/result"}},
        })
        upload["fields"] = [{"id": "source_audio", "type": "audio", "node_id": "1",
                             "input": "audio", "default": ""}]
        strict_info = typed_audio_schema()
        strict_info["ToneGenerator"]["input"]["required"]["style"] = [["studio", "warm"]]
        invalid_other_field = audio_package("pkg-bad-style", {
            "1": {"class_type": "ToneGenerator", "inputs": {"prompt": "A soft melody", "style": "unknown"}},
            "2": {"class_type": "SaveAudioMP3", "inputs": {"audio": ["1", 0], "filename_prefix": "audio/result"}},
        })
        result = audio_capabilities(strict_info, [upload, invalid_other_field])
        self.assertTrue(result["packages"][0]["eligible"])
        self.assertEqual(result["packages"][0]["fields"][0]["type"], "audio")
        self.assertFalse(result["packages"][1]["schema_supported"])
        self.assertNotIn("", strict_info["LoadAudio"]["input"]["required"]["audio"][0])
        with self.assertRaisesRegex(ValueError, "尚未填写资源"):
            validate_prompt(upload["prompt"], strict_info)

    def test_pending_upload_capability_requires_an_exposed_matching_empty_media_field(self):
        upload = audio_package("pkg-upload", {
            "1": {"class_type": "LoadAudio", "inputs": {"audio": ""}},
            "2": {"class_type": "AudioWriter", "inputs": {"audio": ["1", 0], "filename_prefix": "audio/result"}},
        })
        field = {"id": "source_audio", "type": "audio", "node_id": "1", "input": "audio", "default": ""}
        for fields in ([], [{**field, "type": "image"}], [{**field, "node_id": "missing"}]):
            with self.subTest(fields=fields):
                upload["fields"] = fields
                self.assertFalse(audio_capabilities(typed_audio_schema(), [upload])["packages"][0]["eligible"])
        upload["fields"] = [field]
        for name in ("missing.wav", "../unsafe.wav"):
            with self.subTest(name=name):
                upload["prompt"]["1"]["inputs"]["audio"] = name
                self.assertFalse(audio_capabilities(typed_audio_schema(), [upload])["packages"][0]["eligible"])

    def test_pending_string_upload_is_discoverable_without_accepting_real_submission(self):
        info = typed_audio_schema()
        info["LoadAudio"]["input"]["required"]["audio"] = ["STRING", {"audio_upload": True}]
        upload = audio_package("pkg-upload", {
            "1": {"class_type": "LoadAudio", "inputs": {"audio": ""}},
            "2": {"class_type": "AudioWriter", "inputs": {"audio": ["1", 0], "filename_prefix": "audio/result"}},
        }, fields=[{"id": "source_audio", "type": "audio", "node_id": "1", "input": "audio", "default": ""}])
        self.assertTrue(audio_capabilities(info, [upload])["packages"][0]["eligible"])
        with self.assertRaisesRegex(ValueError, "尚未填写资源"):
            validate_prompt(upload["prompt"], info)

    def test_schema_without_audio_outputs_reports_unavailable_and_keeps_packages(self):
        result = audio_capabilities({"KSampler": schema({}, ["LATENT"])}, [self.good])
        self.assertFalse(result["available"])
        self.assertFalse(result["schema_available"])
        self.assertEqual(len(result["packages"]), 1)
        self.assertFalse(result["packages"][0]["eligible"])


if __name__ == "__main__":
    unittest.main()
