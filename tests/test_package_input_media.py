"""Package/editor/live validation share one standard filename-upload contract."""

import copy
import tempfile
import unittest
from pathlib import Path

from frameweave.editor_interfaces import inspect_interface, output_closure, select_outputs
from frameweave.packages import (PackageStore, apply_editor_values, apply_values,
                                inspect_document, normalize_document,
                                validate_package_media_field)
from frameweave.workflows import validate_editor_prompt, validate_prompt


def loader(media, definition=None, *, required=True, node_type="ThirdPartyLoader"):
    filename = {"image": "frame.png", "video": "clip.mp4", "audio": "voice.wav"}[media]
    if definition is None:
        definition = ["COMBO", {media + "_upload": True, "options": [filename]}]
    info = {node_type: {"input": {"required" if required else "optional": {
        "source": definition}}, "output": [media.upper()]}}
    prompt = {"7": {"class_type": node_type, "inputs": {"source": filename}}}
    return prompt, info


def declared_package(media, prompt):
    return {"name": "Standard input", "prompt": prompt, "fields": [{
        "id": "reference", "node_id": "7", "input": "source", "label": "Reference",
        "type": media}]}


class PackageInputMediaTests(unittest.TestCase):
    def test_third_party_uploads_have_consistent_ports_and_live_validation(self):
        for media in ("image", "video", "audio"):
            for kind in ("COMBO", [], ["known"]):
                for required in (True, False):
                    with self.subTest(media=media, kind=kind, required=required):
                        prompt, info = loader(media, [kind, {media + "_upload": True}],
                                              required=required)
                        before = copy.deepcopy((prompt, info))
                        portable = inspect_document(prompt, info)
                        self.assertEqual(portable["fields"][0]["type"], media)
                        self.assertEqual(portable["fields"][0]["default"], "")
                        self.assertTrue(portable["fields"][0]["recommended"])
                        interface = inspect_interface(prompt, info)
                        field = interface["fields"][0]
                        self.assertEqual(field["default"], prompt["7"]["inputs"]["source"])
                        self.assertEqual((field["type"], field["presentation"], field["role"],
                                          field["required"]),
                                         (media, "port", media + "_reference", required))
                        self.assertEqual(field["id"], portable["fields"][0]["id"])
                        package = normalize_document({**portable, "name": "Upload"})
                        validated, node = validate_package_media_field(package, field["id"], info, media)
                        self.assertEqual(validated["id"], field["id"])
                        self.assertEqual(node["class_type"], "ThirdPartyLoader")
                        for other in {"image", "video", "audio"} - {media}:
                            with self.assertRaisesRegex(ValueError, "类型不一致"):
                                validate_package_media_field(package, field["id"], info, other)
                        self.assertEqual((prompt, info), before)

    def test_unsupported_transport_keeps_literal_and_never_becomes_upload(self):
        bad_metadata = ({"image_folder": "output"}, {"storage_type": "temp"},
                        {"remote": {"route": "/internal/files/output"}},
                        {"upload_endpoint": "/plugin/upload"}, {"multiselect": True},
                        {"video_upload": True}, {"image_upload": "true"},
                        {"options": [123]})
        for metadata in bad_metadata:
            with self.subTest(metadata=metadata):
                prompt, info = loader("image", ["COMBO", {"image_upload": True, **metadata}])
                inspected = inspect_interface(prompt, info)
                self.assertNotIn(inspected["fields"][0]["type"], ("image", "video", "audio"))
                self.assertEqual(inspected["prompt"], prompt)
                self.assertEqual(inspected["fields"][0]["default"], "frame.png")
                with self.assertRaisesRegex(ValueError, "兼容媒体上传节点"):
                    validate_package_media_field(declared_package("image", prompt),
                                                 "reference", info, "image")

    def test_output_image_loader_is_preserved_as_ordinary_combo(self):
        prompt = {"7": {"class_type": "LoadImageOutput", "inputs": {"image": "output.png"}}}
        info = {"LoadImageOutput": {"input": {"required": {"image": [["output.png"], {
            "image_upload": True, "image_folder": "output",
            "remote": {"route": "/internal/files/output"}}]}}, "output": ["IMAGE", "MASK"]}}
        field = inspect_interface(prompt, info)["fields"][0]
        self.assertEqual((field["type"], field["default"], field["presentation"]),
                         ("select", "output.png", "control"))
        self.assertEqual(validate_editor_prompt(prompt, info)["issues"], [])
        stale = copy.deepcopy(prompt)
        stale["7"]["inputs"]["image"] = "missing.png"
        with self.assertRaisesRegex(ValueError, "选项"):
            validate_editor_prompt(stale, info)

    def test_audio_output_and_path_names_do_not_imply_upload(self):
        for definition in (["STRING"], ["STRING", {"audio_upload": False}],
                           ["STRING", {"audio_upload": "true"}]):
            prompt = {"7": {"class_type": "PathAudio", "inputs": {
                "audio": "C:/custom/voice.wav"}}}
            info = {"PathAudio": {"input": {"required": {"audio": definition}},
                                  "output": ["AUDIO"]}}
            inspected = inspect_interface(prompt, info)
            self.assertEqual(inspected["fields"][0]["type"], "text")
            self.assertEqual(inspected["prompt"], prompt)
            self.assertEqual(validate_editor_prompt(prompt, info)["issues"], [])

    def test_tensor_upload_flags_do_not_create_filename_fields(self):
        for media in ("image", "video", "audio"):
            prompt, info = loader(media, [media.upper(), {media + "_upload": True}])
            field = inspect_interface(prompt, info)["fields"][0]
            self.assertEqual(field["type"], "text")
            with self.assertRaisesRegex(ValueError, "兼容媒体上传节点"):
                validate_package_media_field(declared_package(media, prompt),
                                             "reference", info, media)
            with self.assertRaisesRegex(ValueError, "必须连接"):
                validate_prompt(prompt, info)

    def test_legacy_audio_string_checks_required_and_safe_filename(self):
        prompt, info = loader("audio", ["STRING", {"audio_upload": True}])
        field = inspect_interface(prompt, info)["fields"][0]
        self.assertEqual(field["type"], "audio")
        package = declared_package("audio", prompt)
        validate_package_media_field(package, "reference", info, "audio")
        for value in ("", "../outside.wav", "C:/outside.wav", True):
            invalid = copy.deepcopy(prompt)
            invalid["7"]["inputs"]["source"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_prompt(invalid, info)
        empty = copy.deepcopy(prompt)
        empty["7"]["inputs"]["source"] = ""
        self.assertEqual(validate_editor_prompt(empty, info)["issues"][0]["resource_type"], "audio")
        optional = copy.deepcopy(info)
        optional["ThirdPartyLoader"]["input"] = {"optional": {
            "source": ["STRING", {"audio_upload": True}]}}
        validate_prompt(empty, optional)
        self.assertEqual(validate_editor_prompt(empty, optional)["issues"], [])

    def test_explicit_upload_contract_takes_precedence_over_model_name_hints(self):
        info = {"ThirdPartyLoader": {"input": {"required": {"ckpt_name": [
            "COMBO", {"audio_upload": True, "options": ["voice.wav"]}]}}, "output": ["AUDIO"]}}
        prompt = {"7": {"class_type": "ThirdPartyLoader", "inputs": {"ckpt_name": ""}}}
        inspected = inspect_interface(prompt, info)
        self.assertEqual(inspected["fields"][0]["type"], "audio")
        issues = validate_editor_prompt(prompt, info)["issues"]
        self.assertEqual((issues[0]["code"], issues[0]["resource_type"]), ("missing_media", "audio"))

    def test_optional_upload_blank_is_editor_placeholder_and_execution_omits_it(self):
        for media in ("image", "video", "audio"):
            prompt, info = loader(media, required=False)
            interface = inspect_interface(prompt, info)
            field = interface["fields"][0]
            package = {**interface, "name": "Optional"}
            edited = apply_editor_values(package, {})
            self.assertEqual(edited["7"]["inputs"]["source"], "")
            self.assertEqual(validate_editor_prompt(edited, info)["issues"], [])
            executed = apply_values(package, {})
            self.assertNotIn("source", executed["7"]["inputs"])
            validate_prompt(executed, info)
            strict = copy.deepcopy(info)
            strict["ThirdPartyLoader"]["input"]["required"] = strict["ThirdPartyLoader"]["input"].pop("optional")
            with self.assertRaisesRegex(ValueError, "缺少必填输入"):
                validate_prompt(executed, strict)
            validate_prompt(apply_values(package, {field["id"]: prompt["7"]["inputs"]["source"]}), info)

    def test_dynamic_active_upload_leaf_is_validated_using_expanded_binding(self):
        info = {"DynamicLoader": {"input": {"required": {"mode": ["COMFY_DYNAMICCOMBO_V3", {
            "options": [{"key": "on", "inputs": {"required": {
                "source": ["COMBO", {"audio_upload": True, "options": ["voice.wav"]}]}}},
                        {"key": "off", "inputs": {}}]}]}}, "output": ["AUDIO"]}}
        prompt = {"7": {"class_type": "DynamicLoader", "inputs": {
            "mode": "on", "mode.source": "voice.wav"}}}
        inspected = inspect_interface(prompt, info)
        media = next(field for field in inspected["fields"] if field["type"] == "audio")
        selector = next(field for field in inspected["fields"] if field["input"] == "mode")
        self.assertTrue(media["required"])
        package = {**inspected, "name": "Dynamic input"}
        validate_package_media_field(package, media["id"], info, "audio")
        validate_package_media_field(package, media["id"], info, "audio", values={selector["id"]: "on"})
        with self.assertRaisesRegex(ValueError, "兼容媒体上传节点"):
            validate_package_media_field(package, media["id"], info, "audio", values={selector["id"]: "off"})

    def test_selected_output_keeps_required_media_on_only_its_active_branch(self):
        prompt, info = loader("audio")
        prompt["8"] = copy.deepcopy(prompt["7"])
        info["SaveAudio"] = {"input": {"required": {"audio": ["AUDIO"]}},
                             "output": [], "output_node": True}
        prompt["9"] = {"class_type": "SaveAudio", "inputs": {"audio": ["7", 0]}}
        prompt["10"] = {"class_type": "SaveAudio", "inputs": {"audio": ["8", 0]}}
        inspected = inspect_interface(prompt, info, output_nodes=["9"])
        fields = {field["node_id"]: field for field in inspected["fields"]}
        package = normalize_document({**inspected, "name": "Independent branches"})
        before = copy.deepcopy(package)
        active = set(output_closure(package["prompt"], ["9"], info)["node_ids"])
        applied = apply_values(package, {fields["7"]["id"]: "voice.wav"}, active_nodes=active)
        self.assertEqual(set(select_outputs(applied, ["9"], info)), {"7", "9"})
        with self.assertRaises(ValueError):
            select_outputs(applied, ["10"], info)
        self.assertEqual(package, before)

    def test_old_package_id_and_export_are_not_given_new_contract_metadata(self):
        document = {"name": "Legacy input", "prompt": {
            "7": {"class_type": "LoadImage", "inputs": {"image": ""}}}, "fields": [{
                "id": "reference", "label": "Reference", "node_id": "7", "input": "image",
                "type": "image"}]}
        original = copy.deepcopy(document)
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory))
            package = store.save(document)
            self.assertEqual(package["id"], "p-3dff16250fafddc714ca56dd")
            exported = store.export_transport(package["id"])
            before = exported["source_json"]
            info = {"LoadImage": {"input": {"required": {
                "image": [["frame.png"], {"image_upload": True}]}}}}
            validate_package_media_field(package, "reference", info, "image")
            self.assertEqual(store.export_transport(package["id"])["source_json"], before)
            self.assertNotIn("transport", exported["document"]["fields"][0])
            self.assertNotIn("presentation", exported["document"]["fields"][0])
        self.assertEqual(document, original)


if __name__ == "__main__":
    unittest.main()
