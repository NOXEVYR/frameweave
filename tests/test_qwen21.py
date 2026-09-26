"""Native Qwen Image 2.1 graph compilation and diagnostics contracts."""

import unittest

from frameweave.diagnostics import diagnose
from frameweave.workflows import capabilities, catalog, compile_workflow, generation_options
from test_workflows import fixture


DIT_21 = "QwenImage21/qwen_image_2.1_int8_convrot.safetensors"
DIT_21_BF16 = "QwenImage21/qwen_image_2.1_bf16_from_diffusers.safetensors"
ENCODER_21 = "QwenImage21/qwen3vl_8b_int8_convrot.safetensors"
VAE_21 = "QwenImage21/qwen_image_2.1_vae_bf16.safetensors"


def qwen_fixture():
    info = fixture()
    info["UNETLoader"]["input"]["required"]["unet_name"][0].append(DIT_21)
    info["UNETLoader"]["input"]["required"]["unet_name"][0].append(DIT_21_BF16)
    info["CLIPLoader"]["input"]["required"]["clip_name"][0].append(ENCODER_21)
    info["CLIPLoader"]["input"]["required"]["type"][0].append("qwen_image")
    info["VAELoader"]["input"]["required"]["vae_name"][0].append(VAE_21)
    info["TextEncodeQwenImage21"] = {
        "input": {
            "required": {
                "clip": ["CLIP"],
                "prompt": ["STRING"],
                "negative_prompt": ["STRING"],
                "resolution": ["INT", {"default": 1024, "min": 0, "max": 4096, "step": 32}],
                "images": ["COMFY_AUTOGROW_V3", {
                    "template": {
                        "input": {"required": {"image": ["IMAGE"]}},
                        "names": [f"image_{index}" for index in range(1, 17)],
                        "min": 0,
                    },
                }],
            },
            "optional": {"vae": ["VAE"]},
        },
        "output": ["CONDITIONING", "CONDITIONING", "LATENT"],
    }
    info["LoraLoaderModelOnly"]["input"]["required"]["lora_name"][0].append(
        "loras/qwen_image_2.1_style.safetensors")
    info["LoraLoaderBypassModelOnly"]["input"]["required"]["lora_name"][0].append(
        "loras/qwen_image_2.1_style.safetensors")
    return info


def qwen_compile(info, kind="qwen21_t2i", **request):
    return compile_workflow({"kind": kind, "positive": "A blue paper bird.", **request}, info)


def of_type(result, class_type):
    return [(node_id, node["inputs"]) for node_id, node in result["prompt"].items()
            if node["class_type"] == class_type]


class Qwen21WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.info = qwen_fixture()

    def test_t2i_uses_native_qwen_encoder_and_standard_safetensors_loaders(self):
        result = qwen_compile(self.info, seed=123, steps=40, cfg=1, width=1024, height=768)
        self.assertEqual(of_type(result, "UNETLoader")[0][1]["unet_name"], DIT_21)
        self.assertEqual(of_type(result, "CLIPLoader")[0][1], {"clip_name": ENCODER_21, "type": "qwen_image"})
        self.assertEqual(of_type(result, "VAELoader")[0][1]["vae_name"], VAE_21)
        encoder_id, encoder = of_type(result, "TextEncodeQwenImage21")[0]
        self.assertEqual(encoder["prompt"], "A blue paper bird.")
        self.assertEqual(encoder["negative_prompt"], "")
        self.assertEqual(encoder["resolution"], 1024)
        self.assertNotIn("vae", encoder)
        sampler = of_type(result, "KSampler")[0][1]
        self.assertEqual(sampler["positive"], [encoder_id, 0])
        self.assertEqual(sampler["negative"], [encoder_id, 1])
        self.assertEqual(sampler["seed"], 123)
        self.assertEqual(sampler["steps"], 40)
        self.assertEqual(sampler["cfg"], 1)
        self.assertEqual(sampler["denoise"], 1)
        self.assertEqual(of_type(result, "EmptyLatentImage")[0][1]["width"], 1024)
        self.assertEqual(len(of_type(result, "VAEDecode")), 1)
        self.assertEqual(len(of_type(result, "SaveImage")), 1)
        self.assertFalse(of_type(result, "CLIPTextEncode"))
        self.assertEqual(result["summary"]["kind"], "qwen21_t2i")

    def test_edit_uses_native_dynamic_image_fields_and_encoder_latent_by_default(self):
        references = [f"edit-{index}.png" for index in range(1, 11)]
        self.info["LoadImage"]["input"]["required"]["image"][0].extend(references)
        result = qwen_compile(self.info, "qwen21_edit", references=references, width=1024, height=768,
                              ref_resolution=1024, seed=12, steps=25, cfg=1)
        encoder_id, encoder = of_type(result, "TextEncodeQwenImage21")[0]
        self.assertEqual(encoder["resolution"], 1024)
        self.assertEqual(encoder["vae"], ["3", 0])
        self.assertEqual([encoder[f"images.image_{index}"] for index in range(1, 11)],
                         [[str(index + 3), 0] for index in range(1, 11)])
        sampler = of_type(result, "KSampler")[0][1]
        self.assertEqual(sampler["positive"], [encoder_id, 0])
        self.assertEqual(sampler["negative"], [encoder_id, 1])
        self.assertEqual(sampler["latent_image"], [encoder_id, 2])
        self.assertEqual(sampler["denoise"], 1)
        self.assertFalse(of_type(result, "EmptyLatentImage"))
        self.assertFalse(of_type(result, "ImageScale"))
        self.assertFalse(of_type(result, "VAEEncode"))
        self.assertIsNone(result["summary"]["width"])
        self.assertIsNone(result["summary"]["height"])
        self.assertEqual(result["summary"]["requested_width"], 1024)
        self.assertEqual(result["summary"]["size_mode"], "first_reference")

    def test_edit_custom_size_selects_explicit_empty_latent(self):
        self.info["LoadImage"]["input"]["required"]["image"][0].append("rgb-or-rgba.png")
        result = qwen_compile(self.info, "qwen21_edit", references=["rgb-or-rgba.png"],
                              custom_size=True, width=768, height=512)
        encoder_id = of_type(result, "TextEncodeQwenImage21")[0][0]
        latent_id, latent = of_type(result, "EmptyLatentImage")[0]
        self.assertEqual(latent["width"], 768)
        self.assertEqual(latent["height"], 512)
        self.assertEqual(of_type(result, "KSampler")[0][1]["latent_image"], [latent_id, 0])
        self.assertNotEqual(of_type(result, "KSampler")[0][1]["latent_image"], [encoder_id, 2])
        self.assertEqual(result["summary"]["size_mode"], "custom")
        self.assertEqual(result["summary"]["width"], 768)
        self.assertEqual(result["summary"]["height"], 512)

    def test_generic_reference_role_is_accepted_but_frame_roles_are_not(self):
        self.info["LoadImage"]["input"]["required"]["image"][0].append("edit.png")
        result = qwen_compile(self.info, "qwen21_edit", references=["edit.png"],
                              reference_roles=["reference"])
        self.assertEqual(result["summary"]["reference_roles"], ["reference"])
        with self.assertRaisesRegex(ValueError, "reference"):
            qwen_compile(self.info, "qwen21_edit", references=["edit.png"],
                         reference_roles=["start"])

    def test_rgb_and_rgba_uploads_share_native_image_socket_without_rewrite_nodes(self):
        names = ["rgb-upload.png", "rgba-upload.png"]
        self.info["LoadImage"]["input"]["required"]["image"][0].extend(names)
        result = qwen_compile(self.info, "qwen21_edit", references=names)
        encoder = of_type(result, "TextEncodeQwenImage21")[0][1]
        self.assertEqual(encoder["images.image_1"], ["4", 0])
        self.assertEqual(encoder["images.image_2"], ["5", 0])
        self.assertFalse(of_type(result, "ImageScale"))
        self.assertFalse(of_type(result, "VAEEncode"))
        self.assertEqual(self.info["LoadImage"]["output"][0], "IMAGE")

    def test_model_only_lora_preserves_clip_and_warns_about_weight_compatibility(self):
        name = "loras/qwen_image_2.1_style.safetensors"
        result = qwen_compile(self.info, loras=[{"name": name, "strength_model": 0.5}])
        loader = of_type(result, "LoraLoaderBypassModelOnly")
        self.assertEqual(len(loader), 1)
        self.assertEqual(loader[0][1]["lora_name"], name)
        self.assertFalse(of_type(result, "LoraLoader"))
        self.assertTrue(any("兼容" in warning for warning in result["summary"]["warnings"]))
        result = qwen_compile(self.info, models={"dit": DIT_21_BF16},
                              loras=[{"name": name, "strength_model": 0.5}])
        self.assertEqual(len(of_type(result, "LoraLoaderModelOnly")), 1)

    def test_gguf_is_not_claimed_by_standard_safetensors_loaders(self):
        name = "qwen_image_2.1_bf16.gguf"
        self.info["UNETLoader"]["input"]["required"]["unet_name"][0].append(name)
        with self.assertRaisesRegex(ValueError, "safetensors"):
            qwen_compile(self.info, models={"dit": name})

    def test_old_qwen_model_vae_and_encoder_are_rejected(self):
        wrong = {
            "dit": "qwen_image_fp8_e4m3fn.safetensors",
            "text_encoder": "qwen3vl_4b_fp8_scaled.safetensors",
            "vae": "qwen_image_vae.safetensors",
        }
        for role, name in wrong.items():
            with self.subTest(role=role):
                field = {"dit": "unet_name", "text_encoder": "clip_name", "vae": "vae_name"}[role]
                node = {"dit": "UNETLoader", "text_encoder": "CLIPLoader", "vae": "VAELoader"}[role]
                self.info[node]["input"]["required"][field][0].append(name)
                with self.assertRaisesRegex(ValueError, "架构不相容"):
                    qwen_compile(self.info, models={role: name})

    def test_missing_required_model_roles_do_not_fall_back_to_old_qwen_models(self):
        cases = [("dit", "UNETLoader", "unet_name", [DIT_21, DIT_21_BF16], "dit 模型"),
                 ("text_encoder", "CLIPLoader", "clip_name", [ENCODER_21], "text_encoder 模型"),
                 ("vae", "VAELoader", "vae_name", [VAE_21], "vae 模型")]
        for role, node, field, names, error in cases:
            info = qwen_fixture()
            for name in names:
                info[node]["input"]["required"][field][0].remove(name)
            with self.subTest(role=role), self.assertRaisesRegex(ValueError, error):
                qwen_compile(info)

    def test_invalid_kinds_parameters_and_reference_limits_are_rejected(self):
        invalid = [
            ("qwen21_t2i", {"references": ["edit-1.png"]}),
            ("qwen21_edit", {"references": []}),
            ("qwen21_edit", {"references": [f"{i}.png" for i in range(11)]}),
            ("qwen21_t2i", {"width": 1000}),
            ("qwen21_edit", {"references": ["edit.png"], "height": 1000}),
            ("qwen21_edit", {"references": ["edit.png"], "ref_resolution": 1000}),
            ("qwen21_edit", {"references": ["edit.png"], "denoise": 0.5}),
            ("qwen21_edit", {"references": ["edit.png"], "seed": -1}),
            ("qwen21_edit", {"references": ["edit.png"], "steps": 0}),
            ("qwen21_edit", {"references": ["edit.png"], "cfg": 101}),
            ("qwen21_edit", {"references": ["edit.png"], "sampler": "unsupported"}),
            ("qwen21_edit", {"references": ["edit.png"], "scheduler": "unsupported"}),
            ("qwen21_edit", {"references": ["edit.png"], "custom_size": 1}),
            ("qwen21_t2i", {"custom_size": True}),
            ("qwen21_t2i", {"models": {"checkpoint": "unused.safetensors"}}),
        ]
        self.info["LoadImage"]["input"]["required"]["image"][0].extend(
            ["edit.png", "edit-1.png", *[f"{i}.png" for i in range(11)]])
        for kind, values in invalid:
            with self.subTest(kind=kind, values=values), self.assertRaises(ValueError):
                qwen_compile(self.info, kind, **values)

    def test_catalog_capabilities_and_generation_options_name_qwen21_separately(self):
        available = catalog(self.info)
        self.assertIn(DIT_21, available["dit"])
        self.assertIn(ENCODER_21, available["text_encoder"])
        self.assertIn(VAE_21, available["vae"])
        options = generation_options(self.info)
        for role, name in (("dit", DIT_21), ("text_encoder", ENCODER_21), ("vae", VAE_21)):
            self.assertEqual(options["model_families"][role][name], "qwen21")
        self.assertEqual(options["qwen21"]["clip_types"], ["qwen_image"])
        self.assertEqual(options["qwen21"]["reference_limit"], 10)
        self.assertEqual(options["qwen21"]["ref_resolution"],
                         {"default": 1024, "min": 0, "max": 4096, "step": 32})
        self.assertTrue(capabilities(self.info)["qwen21_t2i"])
        self.assertTrue(capabilities(self.info)["qwen21_edit"])

    def test_diagnostics_report_missing_nodes_and_weights_consistently(self):
        info = qwen_fixture()
        for name in (DIT_21, DIT_21_BF16):
            info["UNETLoader"]["input"]["required"]["unet_name"][0].remove(name)
        result = diagnose({}, info, {"online": True}, {"kind": "qwen21_t2i", "positive": "test"}, catalog(info))
        model = next(row for row in result["checks"] if row["id"].startswith("model.dit."))
        self.assertEqual(model["status"], "missing")
        self.assertFalse(result["ready"])
        info = qwen_fixture()
        del info["TextEncodeQwenImage21"]
        result = diagnose({}, info, {"online": True}, {"kind": "qwen21_edit", "references": ["style.png"]}, catalog(info))
        node = next(row for row in result["checks"] if row["name"] == "节点 · TextEncodeQwenImage21")
        self.assertEqual(node["status"], "missing")
        self.assertFalse(result["ready"])

    def test_diagnostic_parameter_validation_matches_compiler(self):
        result = diagnose({}, self.info, {"online": True},
                          {"kind": "qwen21_t2i", "positive": "test", "references": ["style.png"]},
                          catalog(self.info))
        self.assertEqual(next(row for row in result["checks"] if row["id"] == "input.references")["status"], "error")
        self.assertFalse(result["ready"])
        result = diagnose({}, self.info, {"online": True},
                          {"kind": "qwen21_edit", "positive": "test", "references": ["style.png"], "denoise": 0.5},
                          catalog(self.info))
        self.assertEqual(next(row for row in result["checks"] if row["id"] == "workflow.schema")["status"], "error")
        self.assertFalse(result["ready"])
        with self.assertRaisesRegex(ValueError, "32 的倍数"):
            diagnose({}, self.info, {"online": True},
                     {"kind": "qwen21_edit", "positive": "test", "references": ["style.png"], "ref_resolution": 1000},
                     catalog(self.info))


if __name__ == "__main__":
    unittest.main()
