"""Contract tests for data-only H3 multimodal standard-package assembly."""
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from frameweave.h3_reference import h3_reference_capability, prepare_h3_reference_package
from frameweave.packages import apply_editor_values, normalize_document
from frameweave.workflows import compile_workflow, validate_editor_prompt


def fixture():
    """Independent preset golden plus explicit local H3/VHS/audio contracts."""
    golden = json.loads((Path(__file__).parent / "fixtures" / "preset_execution_golden.json").read_text(encoding="utf8"))
    case = next(item for item in golden["cases"] if item["name"] == "h3_ref")
    info = copy.deepcopy(golden["schemas"][case["schema_id"]])
    optional = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]
    for group, prefix, kind in (("ref_videos", "ref_video_", "IMAGE"),
                                ("ref_video_audios", "ref_video_audio_", "AUDIO"),
                                ("ref_audios", "ref_audio_", "AUDIO")):
        optional[group] = ["COMFY_AUTOGROW_V3", {"template": {"input": {"required": {"value": [kind, {}]}},
            "prefix": prefix, "min": 0, "max": 3}}]
    info["VHS_LoadVideo"] = {"input": {"required": {
        "video": [["video.mp4"]],
        "force_rate": ["FLOAT", {"min": 0, "max": 60}],
        "custom_width": ["INT", {"min": 0, "max": 8192}],
        "custom_height": ["INT", {"min": 0, "max": 8192}],
        "frame_load_cap": ["INT", {"min": 0, "max": 9007199254740991}],
        "skip_first_frames": ["INT", {"min": 0, "max": 9007199254740991}],
        "select_every_nth": ["INT", {"min": 1, "max": 9007199254740991}]},
        "optional": {"format": [["None", "AnimateDiff"], {"formats": {"None": {}, "AnimateDiff": {"target_rate": 8}}}],
                     "vae": ["VAE"], "meta_batch": ["VHS_BatchManager"]}},
        "output": ["IMAGE", "INT", "AUDIO", "VHS_VIDEOINFO"],
        "python_module": "custom_nodes.comfyui-videohelpersuite"}
    info["LoadAudio"] = {"input": {"required": {"audio": ["COMBO", {"options": ["audio.wav"], "audio_upload": True}]}},
        "output": ["AUDIO"], "python_module": "comfy_extras.nodes_audio"}
    return info


def layout(images=0, videos=(), audios=0):
    return {"image_count": images, "videos": [{"soundtrack": flag} for flag in videos], "audio_count": audios}


def typed(result, node_type):
    return [(node_id, node["inputs"]) for node_id, node in result["document"]["prompt"].items() if node["class_type"] == node_type]


class H3ReferenceTests(unittest.TestCase):
    def prepare(self, slots, request=None, info=None):
        return prepare_h3_reference_package(request or {"kind": "h3_ref"}, slots, info if info is not None else fixture())

    def assertBlocked(self, result, code=None):
        self.assertEqual(result["status"], "blocked")
        self.assertIsNone(result["document"])
        self.assertIsNone(result["summary"])
        self.assertTrue(result["blocked"])
        if code:
            self.assertEqual(result["blocked"][0]["code"], code)

    def test_all_modalities_maximum_draft_roundtrips_standard_package(self):
        result = self.prepare(layout(9, (False, True, True), 3))
        self.assertEqual(result["status"], "prepared")
        document = result["document"]
        self.assertEqual(document["format"], "frameweave-workflow")
        self.assertEqual(document["version"], 1)
        self.assertEqual(normalize_document(document), document)
        self.assertEqual(apply_editor_values(document, {}), document["prompt"])
        self.assertEqual(len(typed(result, "LoadImage")), 9)
        self.assertEqual(len(typed(result, "VHS_LoadVideo")), 3)
        self.assertEqual(len(typed(result, "LoadAudio")), 3)
        self.assertTrue(any(item["code"] == "missing_model" for item in result["pending"]))
        media = [field for field in document["fields"] if field["type"] in {"image", "video", "audio"}]
        self.assertEqual(len(media), 15)
        self.assertTrue(all(field["required"] and field["default"] == "" for field in media))
        self.assertEqual({field["label"] for field in media if field["type"] == "video"}, {"参考视频1", "参考视频2", "参考视频3"})
        with self.assertRaises(ValueError):
            compile_workflow({"kind": "api", "prompt": document["prompt"]}, fixture())

    def test_image_only_does_not_require_unused_loaders(self):
        info = fixture()
        del info["VHS_LoadVideo"], info["LoadAudio"]
        result = self.prepare(layout(2), info=info)
        self.assertEqual(result["status"], "prepared")
        self.assertEqual(len(typed(result, "LoadImage")), 2)

    def test_only_used_reference_groups_are_required_on_older_schemas(self):
        info = fixture()
        optional = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]
        for group in ("ref_videos", "ref_video_audios", "ref_audios"):
            del optional[group]
        self.assertEqual(self.prepare(layout(1), info=info)["status"], "prepared")
        self.assertTrue(h3_reference_capability(info)["images"]["available"])
        self.assertFalse(h3_reference_capability(info)["videos"]["available"])
        info = fixture()
        optional = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]
        del optional["ref_images"], optional["ref_videos"], optional["ref_video_audios"]
        self.assertEqual(self.prepare(layout(audios=1), info=info)["status"], "prepared")
        info = fixture()
        optional = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]
        del optional["ref_audios"], optional["ref_video_audios"]
        self.assertEqual(self.prepare(layout(videos=(False,)), info=info)["status"], "prepared")
        self.assertBlocked(self.prepare(layout(videos=(True,)), info=info), "incompatible_reference_group")

    def test_video_only_removes_disposable_image_and_pending_even_without_image_loader(self):
        info = fixture()
        del info["LoadImage"]
        info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]["ref_images"][1]["template"] = {
            "input": {"required": {"x": ["IMAGE", {}]}}, "names": [], "min": 0}
        result = self.prepare(layout(videos=(False,)), info=info)
        self.assertEqual(result["status"], "prepared")
        self.assertFalse(typed(result, "LoadImage"))
        inputs = typed(result, "MiniMaxH3ReferenceToVideo")[0][1]
        self.assertFalse(any(key.startswith("ref_images.") for key in inputs))
        self.assertFalse(any(item.get("logical_id", "").startswith("ref_image_") or item.get("resource_type") == "image" for item in result["pending"]))
        self.assertFalse(any(field["type"] == "image" for field in result["document"]["fields"]))
        validate_editor_prompt(result["document"]["prompt"], info)

    def test_audio_only_and_positive_hole_remain_draft(self):
        info = fixture()
        del info["LoadImage"], info["VHS_LoadVideo"]
        result = self.prepare(layout(audios=2), info=info)
        self.assertEqual(result["status"], "prepared")
        self.assertFalse(typed(result, "LoadImage"))
        self.assertFalse(typed(result, "VHS_LoadVideo"))
        self.assertEqual(len(typed(result, "LoadAudio")), 2)
        self.assertTrue(any(item.get("logical_id") == "positive" for item in result["pending"]))

    def test_pairing_uses_live_names_and_actual_same_suffix_not_position(self):
        info = fixture()
        optional = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]
        optional["ref_videos"][1]["template"]["names"] = ["ref_video_2", "ref_video_0", "ref_video_1"]
        optional["ref_video_audios"][1]["template"]["names"] = ["ref_video_audio_1", "ref_video_audio_2", "ref_video_audio_0"]
        result = self.prepare(layout(videos=(False, True), audios=1), info=info)
        self.assertEqual(result["status"], "prepared")
        inputs = typed(result, "MiniMaxH3ReferenceToVideo")[0][1]
        loaders = typed(result, "VHS_LoadVideo")
        self.assertEqual(inputs["ref_videos.ref_video_2"], [loaders[0][0], 0])
        self.assertEqual(inputs["ref_video_audios.ref_video_audio_0"], [loaders[1][0], 2])
        self.assertEqual(sum(key.startswith("ref_video_audios.") for key in inputs), 1)
        self.assertEqual(result["summary"]["reference_tags"]["soundtracks"], ["<Audio 1>"])
        self.assertEqual(result["summary"]["reference_tags"]["audios"], ["<Audio 2>"])
        soundtrack = next(item for item in result["summary"]["reference_mapping"] if item["modality"] == "soundtrack")
        self.assertEqual((soundtrack["video_slot"], soundtrack["token"]), (2, "<Audio 1>"))
        self.assertIn("第二个视频有声", result["document"]["description"])

    def test_missing_same_number_soundtrack_is_blocked_without_reindexing(self):
        info = fixture()
        info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]["ref_video_audios"][1]["template"]["names"] = ["ref_video_audio_7"]
        self.assertBlocked(self.prepare(layout(videos=(True,)), info=info), "soundtrack_pair_unavailable")
        self.assertEqual(self.prepare(layout(videos=(False,)), info=info)["status"], "prepared")

    def test_loader_bounds_24fps_and_visible_decode_controls(self):
        for seconds, expected_cap in ((5, 124), (20, 362), (5 / 24, 5)):
            result = self.prepare(layout(videos=(False,)), {"kind": "h3_ref", "seconds": seconds})
            values = typed(result, "VHS_LoadVideo")[0][1]
            self.assertEqual(values["force_rate"], 24)
            self.assertEqual(values["select_every_nth"], 1)
            self.assertEqual(values["format"], "None")
            self.assertEqual(values["frame_load_cap"], expected_cap)
            self.assertEqual((values["custom_width"], values["custom_height"]), (736, 416))
            self.assertNotIn("vae", values)
            fields = {field["input"]: field for field in result["document"]["fields"] if field["node_id"] == typed(result, "VHS_LoadVideo")[0][0]}
            self.assertEqual(fields["force_rate"]["min"], fields["force_rate"]["max"])
            self.assertEqual(fields["frame_load_cap"]["max"], expected_cap)
            self.assertGreater(fields["custom_width"]["min"], 0)
            self.assertGreater(fields["custom_height"]["min"], 0)
            self.assertEqual(fields["custom_width"]["label"], "视频1 · 参考宽度")
            self.assertEqual(fields["frame_load_cap"]["label"], "视频1 · 读取帧数上限")
            self.assertEqual(fields["skip_first_frames"]["label"], "视频1 · 跳过起始帧")
            self.assertIn("中心裁切", result["document"]["description"])

    def test_small_output_uses_small_reference_size(self):
        result = self.prepare(layout(videos=(False,)), {"kind": "h3_ref", "width": 320, "height": 192})
        video = typed(result, "VHS_LoadVideo")[0][1]
        self.assertEqual((video["custom_width"], video["custom_height"]), (320, 192))

    def test_dynamic_capacity_changes_and_names_are_authoritative(self):
        for group, slots in (("ref_images", layout(2)), ("ref_videos", layout(videos=(False, False))), ("ref_audios", layout(audios=2))):
            info = fixture()
            template = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"][group][1]["template"]
            template.pop("names", None)
            template["max"] = 1
            self.assertBlocked(self.prepare(slots, info=info), "reference_capacity_exceeded")
        info = fixture()
        info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]["ref_audios"][1]["template"]["names"] = ["named_voice"]
        result = self.prepare(layout(audios=1), info=info)
        self.assertIn("ref_audios.named_voice", typed(result, "MiniMaxH3ReferenceToVideo")[0][1])

    def test_dynamic_group_wrong_types_names_prefix_or_min_are_blocked(self):
        changes = ({"names": ["same", "same"]}, {"prefix": "wrong_"}, {"max": "3"}, {"min": 1},
                   {"names": ["ref_video_0", "ref_video_00"], "input": {"required": {"v": ["VIDEO", {}]}}})
        for change in changes:
            info = fixture()
            info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]["ref_videos"][1]["template"].update(change)
            self.assertBlocked(self.prepare(layout(videos=(False,)), info=info))
        for group, slots in (("ref_images", layout(1)), ("ref_videos", layout(videos=(False,))),
                             ("ref_video_audios", layout(videos=(True,))), ("ref_audios", layout(audios=1))):
            info = fixture()
            template = info["MiniMaxH3ReferenceToVideo"]["input"]["optional"][group][1]["template"]
            template["input"] = {"required": {"wrong": ["VIDEO", {}]}}
            self.assertBlocked(self.prepare(slots, info=info), "incompatible_reference_group")

    def test_video_output_contract_and_soundtrack_are_checked_separately(self):
        info = fixture()
        info["VHS_LoadVideo"]["output"][2] = "STRING"
        self.assertEqual(self.prepare(layout(videos=(False,)), info=info)["status"], "prepared")
        self.assertBlocked(self.prepare(layout(videos=(True,)), info=info), "incompatible_video_loader")
        info["VHS_LoadVideo"]["output"][0] = "LATENT"
        self.assertBlocked(self.prepare(layout(videos=(False,)), info=info), "incompatible_media_loader")

    def test_generic_loadvideo_is_not_accepted_as_24fps_converter(self):
        info = fixture()
        del info["VHS_LoadVideo"]
        info["LoadVideo"] = {"input": {"required": {"file": ["COMBO", {"video_upload": True, "options": []}]}}, "output": ["VIDEO"]}
        self.assertBlocked(self.prepare(layout(videos=(False,)), info=info), "missing_node")

    def test_missing_rate_bound_controls_profile_or_unknown_required_block(self):
        for name in ("force_rate", "frame_load_cap", "custom_width", "custom_height", "select_every_nth"):
            info = fixture()
            del info["VHS_LoadVideo"]["input"]["required"][name]
            self.assertBlocked(self.prepare(layout(videos=(False,)), info=info), "incompatible_video_loader")
        for change in ("rate", "format", "extra"):
            info = fixture()
            if change == "rate":
                info["VHS_LoadVideo"]["input"]["required"]["force_rate"][1]["max"] = 23
            elif change == "format":
                info["VHS_LoadVideo"]["input"]["optional"]["format"][0] = ["AnimateDiff"]
            else:
                info["VHS_LoadVideo"]["input"]["required"]["new_decoder"] = ["STRING", {}]
            self.assertBlocked(self.prepare(layout(videos=(False,)), info=info), "incompatible_video_loader")

    def test_audio_or_image_upload_contract_mismatch_block(self):
        for name, field, slots in (("LoadAudio", "audio", layout(audios=1)), ("LoadImage", "image", layout(1)),
                                    ("VHS_LoadVideo", "video", layout(videos=(False,)))):
            info = fixture()
            info[name]["input"]["required"][field] = ["STRING", {}]
            self.assertBlocked(self.prepare(slots, info=info), "incompatible_media_loader")
        info = fixture()
        info["LoadAudio"]["output"] = ["IMAGE"]
        self.assertBlocked(self.prepare(layout(audios=1), info=info), "incompatible_media_loader")

    def test_missing_core_node_or_used_loader_is_blocked(self):
        for name, slots in (("MiniMaxH3ReferenceToVideo", layout(1)), ("UNETLoader", layout(audios=1)),
                            ("LoadAudio", layout(audios=1)), ("VHS_LoadVideo", layout(videos=(False,)))):
            info = fixture()
            del info[name]
            self.assertBlocked(self.prepare(slots, info=info))

    def test_final_graph_is_validated_against_original_live_schema(self):
        info = fixture()
        info["MiniMaxH3ReferenceToVideo"]["input"]["required"]["new_input"] = ["STRING", {}]
        self.assertBlocked(self.prepare(layout(audios=1), info=info))

    def test_capability_is_value_free_and_modality_specific(self):
        info = fixture()
        capabilities = h3_reference_capability(info)
        self.assertEqual({name: capabilities[name]["max_count"] for name in ("images", "videos", "audios", "soundtracks")},
                         {"images": 9, "videos": 3, "audios": 3, "soundtracks": 3})
        self.assertNotIn("video.mp4", json.dumps(capabilities))
        del info["VHS_LoadVideo"]
        capabilities = h3_reference_capability(info)
        self.assertTrue(capabilities["base"]["available"])
        self.assertTrue(capabilities["images"]["available"])
        self.assertTrue(capabilities["audios"]["available"])
        self.assertFalse(capabilities["videos"]["available"])
        self.assertIn("VHS_LoadVideo", capabilities["videos"]["reason"])

    def test_all_invalid_layout_types_unknown_keys_and_empty_reject(self):
        bad = [layout(), {"image_count": 1}, {**layout(1), "extra": 1}, layout(True), layout(10), layout(-1),
               layout(audios=True), layout(audios=4), layout(videos=(False,) * 4), {**layout(1), "videos": {}},
               {**layout(1), "videos": [{}]}, {**layout(1), "videos": [{"soundtrack": 1}]},
               {**layout(1), "videos": [{"soundtrack": False, "file": "media.mp4"}]}]
        for slots in bad:
            with self.subTest(slots=slots), self.assertRaises(ValueError):
                self.prepare(slots)

    def test_request_kind_unknown_keys_media_and_wrong_own_values_reject(self):
        changes = [{"kind": "h3_t2v"}, {"unknown": None}, {"package_id": "p-123"}, {"references": [""]},
                   {"references": ["image.png"]}, {"reference_roles": ["reference"]}, {"references": None},
                   {"positive": True}, {"width": 33}, {"fps": 30}, {"models": {"private": ""}},
                   {"models": {"dit": "C:/private/model.safetensors"}}]
        for values in changes:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.prepare(layout(1), {"kind": "h3_ref", **values})
        self.assertEqual(self.prepare(layout(1), {"kind": "h3_ref", "references": [], "reference_roles": []})["status"], "prepared")

    def test_bounded_payload_rejects_oversize_without_truncation(self):
        with self.assertRaises(ValueError):
            self.prepare(layout(1), {"kind": "h3_ref", "positive": "x" * (2 * 1024 * 1024)})

    def test_no_mutation_and_no_side_effects(self):
        info, request, slots = fixture(), {"kind": "h3_ref", "positive": ""}, layout(1, (True,), 1)
        original = copy.deepcopy((info, request, slots))
        with patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
             patch("subprocess.run", side_effect=AssertionError("process")), \
             patch("builtins.open", side_effect=AssertionError("file IO")), \
             patch.object(Path, "write_text", side_effect=AssertionError("write")):
            result = prepare_h3_reference_package(request, slots, info)
            h3_reference_capability(info)
        self.assertEqual((info, request, slots), original)
        result["document"]["prompt"].clear()
        result["summary"]["layout"]["videos"][0]["soundtrack"] = False
        self.assertEqual((info, request, slots), original)


if __name__ == "__main__":
    unittest.main()
