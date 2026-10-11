"""First-upload scope planning defers only proven, blank media bindings."""
import copy
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from frameweave.packages import PackageStore
from frameweave.server import App
from frameweave.workflows import validate_editor_prompt


MEDIA = {"image": "frame.png", "video": "clip.mp4", "audio": "voice.wav"}
LEGACY = {"image": ("LoadImage", "image"),
          "video": ("VHS_LoadVideo", "video"), "audio": ("LoadAudio", "audio")}


def media_case(media, *, combo=False, legacy=False, options=None):
    """A generic loader and output, using only the live filename contract."""
    options = [] if options is None else list(options)
    node_type, input_name = LEGACY[media] if legacy else ("ThirdPartyLoader", "source")
    metadata = {} if legacy else {media + "_upload": True}
    definition = (["COMBO", {**metadata, "options": options}] if combo
                  else [options, metadata])
    document = {"name": "First " + media + " upload", "prompt": {
        "1": {"class_type": node_type, "inputs": {input_name: ""}},
        "2": {"class_type": "MediaOutput", "inputs": {"media": ["1", 0]}},
    }, "fields": [{"id": "reference", "node_id": "1", "input": input_name,
                    "label": "Reference", "type": media, "required": True}]}
    info = {node_type: {"input": {"required": {input_name: definition}},
                        "output": [media.upper()]},
            "MediaOutput": {"input": {"required": {"media": [media.upper()]}},
                            "output": [], "output_node": True}}
    return document, info


class EmptyMediaPlanningTests(unittest.TestCase):
    def setUp(self):
        # Same minimal App/PackageStore pattern as test_execution_plan.py;
        # no listener, service, codec, GPU, upload or submission is started.
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = object.__new__(App)
        self.app.lock = threading.RLock()
        self.app.packages = PackageStore(Path(self.temp.name) / "packages")
        self.schema_calls = []
        self.refresh_calls = []

        def request(path, **kwargs):
            self.assertEqual(path, "/object_info", "planning must never upload or submit")
            self.schema_calls.append(path)
            return copy.deepcopy(self.live_info)

        def object_info(refresh=False):
            self.refresh_calls.append(refresh)
            return copy.deepcopy(self.live_info)

        self.app.backend = SimpleNamespace(url="http://127.0.0.1:8188", request=request)
        self.app.object_info = object_info

    def install(self, document, info):
        self.live_info = copy.deepcopy(info)
        self.package = self.app.packages.save(document)
        return {"backend_url": self.app.backend.url, "request": {
            "kind": "package", "package_id": self.package["id"],
            "values": {}, "output_nodes": ["2"]}}

    def definition(self):
        node = self.package["prompt"]["1"]
        name = self.package["fields"][0]["input"]
        return self.live_info[node["class_type"]]["input"]["required"][name]

    def set_catalog(self, filenames):
        definition = self.definition()
        if isinstance(definition[0], list):
            definition[0] = list(filenames)
        else:
            definition[1]["options"] = list(filenames)

    def assert_plan_and_compile_rejected(self, payload):
        with self.assertRaises(ValueError):
            self.app.execution_plan(payload)
        with self.assertRaises(ValueError):
            self.app.compile(payload["request"])

    def test_generic_list_and_combo_first_upload_then_fresh_final_compile(self):
        for media, filename in MEDIA.items():
            for combo in (False, True):
                with self.subTest(media=media, combo=combo):
                    document, info = media_case(media, combo=combo)
                    payload = self.install(document, info)
                    original = self.app.packages.export(self.package["id"])
                    raw = self.app.packages._path(self.package["id"]).read_bytes()
                    issues = validate_editor_prompt(document["prompt"], info)["issues"]
                    self.assertEqual([(i["node_id"], i["input"], i["code"]) for i in issues],
                                     [("1", "source", "enum_unavailable")])
                    with (patch.object(self.app, "upload", side_effect=AssertionError("upload")),
                          patch.object(self.app, "submit", side_effect=AssertionError("submit")),
                          patch.object(self.app.packages, "save", side_effect=AssertionError("save"))):
                        plan = self.app.execution_plan(payload)
                        self.assertEqual(plan["execution"]["node_ids"], ["1", "2"])
                        self.assertEqual(plan["execution"]["active_field_ids"], ["reference"])
                        with self.assertRaises(ValueError):
                            self.app.compile(payload["request"])
                        payload["request"]["values"] = {"reference": filename}
                        # A name alone is insufficient while the live directory is empty.
                        self.assert_plan_and_compile_rejected(payload)
                        # Simulate object_info after the first successful backend upload.
                        self.set_catalog([filename])
                        payload["request"]["values"] = {}
                        self.app.execution_plan(payload)
                        with self.assertRaises(ValueError):
                            self.app.compile(payload["request"])
                        payload["request"]["values"] = {"reference": filename}
                        ready_plan = self.app.execution_plan(payload)
                        compiled = self.app.compile(payload["request"])
                    self.assertEqual(compiled["prompt"]["1"]["inputs"]["source"], filename)
                    self.assertEqual(compiled["summary"]["execution"], ready_plan["execution"])
                    self.assertEqual(ready_plan["execution"], plan["execution"])
                    self.assertEqual(self.refresh_calls[-1], True)
                    self.assertEqual(self.app.packages.export(self.package["id"]), original)
                    self.assertEqual(self.app.packages._path(self.package["id"]).read_bytes(), raw)
        self.assertEqual(self.schema_calls, ["/object_info"] * 24)
        self.assertTrue(all(self.refresh_calls))

    def test_legacy_loader_list_catalog_first_upload_closure(self):
        for media, filename in MEDIA.items():
            with self.subTest(media=media):
                document, info = media_case(media, legacy=True)
                payload = self.install(document, info)
                plan = self.app.execution_plan(payload)
                with self.assertRaises(ValueError):
                    self.app.compile(payload["request"])
                self.set_catalog([filename])
                payload["request"]["values"] = {"reference": filename}
                compiled = self.app.compile(payload["request"])
                name = LEGACY[media][1]
                self.assertEqual(compiled["prompt"]["1"]["inputs"][name], filename)
                self.assertEqual(compiled["summary"]["execution"], plan["execution"])

    def test_legacy_audio_string_missing_media_is_still_deferred(self):
        document, info = media_case("audio")
        info["ThirdPartyLoader"]["input"]["required"]["source"] = [
            "STRING", {"audio_upload": True}]
        payload = self.install(document, info)
        self.assertEqual(validate_editor_prompt(document["prompt"], info)["issues"][0]["code"],
                         "missing_media")
        self.app.execution_plan(payload)
        with self.assertRaises(ValueError):
            self.app.compile(payload["request"])
        payload["request"]["values"] = {"reference": "voice.wav"}
        self.assertEqual(self.app.compile(payload["request"])["prompt"]["1"]["inputs"]["source"],
                         "voice.wav")

    def test_nonempty_catalog_blank_still_defers_only_missing_media(self):
        for media, filename in MEDIA.items():
            for combo in (False, True):
                with self.subTest(media=media, combo=combo):
                    document, info = media_case(media, combo=combo, options=[filename])
                    payload = self.install(document, info)
                    self.assertEqual(validate_editor_prompt(document["prompt"], info)["issues"][0]["code"],
                                     "missing_media")
                    self.app.execution_plan(payload)
                    with self.assertRaises(ValueError):
                        self.app.compile(payload["request"])

    def test_static_model_empty_enum_on_same_node_never_inherits_media_deferral(self):
        for combo in (False, True):
            for declared in (False, True):
                with self.subTest(combo=combo, declared=declared):
                    document, info = media_case("video", combo=combo)
                    document["prompt"]["1"]["inputs"]["ckpt_name"] = ""
                    info["ThirdPartyLoader"]["input"]["required"]["ckpt_name"] = (
                        ["COMBO", {"options": []}] if combo else [[]])
                    if declared:
                        document["fields"].append({"id": "model", "node_id": "1",
                            "input": "ckpt_name", "label": "Model", "type": "select", "options": []})
                    self.assert_plan_and_compile_rejected(self.install(document, info))

    def test_forged_media_contracts_never_authorize_empty_catalog_planning(self):
        for media in MEDIA:
            bad_definitions = ([[]], ["COMBO", {"options": []}],
                ["COMBO", {media + "_upload": False, "options": []}],
                ["COMBO", {media + "_upload": "true", "options": []}],
                ["COMBO", {media + "_upload": True, "options": [], "storage_type": "output"}],
                ["COMBO", {media + "_upload": True, "options": [], "upload_endpoint": "/custom"}],
                ["COMBO", {media + "_upload": True, "options": [], "multiselect": True}],
                ["COMBO", {media + "_upload": True, "options": [],
                           next(other for other in MEDIA if other != media) + "_upload": True}],
                [media.upper(), {media + "_upload": True}])
            for definition in bad_definitions:
                with self.subTest(media=media, definition=definition):
                    document, info = media_case(media)
                    info["ThirdPartyLoader"]["input"]["required"]["source"] = definition
                    payload = self.install(document, info)
                    with self.assertRaisesRegex(ValueError, "不兼容"):
                        self.app.execution_plan(payload)

    def test_explicit_disabled_legacy_upload_cannot_use_loader_name_fallback(self):
        for media in MEDIA:
            with self.subTest(media=media):
                document, info = media_case(media, legacy=True)
                node_type, name = LEGACY[media]
                info[node_type]["input"]["required"][name][1][media + "_upload"] = False
                payload = self.install(document, info)
                with self.assertRaisesRegex(ValueError, "不兼容"):
                    self.app.execution_plan(payload)

    def test_nonblank_stale_media_is_rejected_for_empty_and_populated_catalogs(self):
        for media, filename in MEDIA.items():
            for combo in (False, True):
                for catalog in ([], [filename]):
                    with self.subTest(media=media, combo=combo, catalog=catalog):
                        document, info = media_case(media, combo=combo, options=catalog)
                        payload = self.install(document, info)
                        payload["request"]["values"] = {"reference": "deleted-" + filename}
                        self.assert_plan_and_compile_rejected(payload)

    def test_unsafe_paths_and_nonstring_values_are_rejected_before_deferral(self):
        for media in MEDIA:
            for value in ("../escape", "folder/../escape", "C:/escape", "/escape",
                          "https://example.invalid/file", 0, False, None, [], {}):
                with self.subTest(media=media, value=value):
                    document, info = media_case(media, combo=True)
                    payload = self.install(document, info)
                    payload["request"]["values"] = {"reference": value}
                    self.assert_plan_and_compile_rejected(payload)

    def test_live_media_type_drift_after_successful_plan_is_rejected(self):
        for media in MEDIA:
            document, info = media_case(media, combo=True)
            payload = self.install(document, info)
            self.app.execution_plan(payload)
            for replacement in (["INT"], ["STRING"], ["COMBO", {
                    "options": [], next(other for other in MEDIA if other != media) + "_upload": True}]):
                with self.subTest(media=media, replacement=replacement):
                    self.live_info = copy.deepcopy(info)
                    self.live_info["ThirdPartyLoader"]["input"]["required"]["source"] = replacement
                    with self.assertRaisesRegex(ValueError, "不兼容"):
                        self.app.execution_plan(payload)
                    with self.assertRaises(ValueError):
                        self.app.compile(payload["request"])

    def test_undeclared_blank_media_cannot_be_deferred(self):
        for media in MEDIA:
            for combo in (False, True):
                with self.subTest(media=media, combo=combo):
                    document, info = media_case(media, combo=combo)
                    document["fields"] = []
                    self.assert_plan_and_compile_rejected(self.install(document, info))

    def test_inactive_empty_media_preserves_source_without_poisoning_selected_output(self):
        for media in MEDIA:
            with self.subTest(media=media):
                document, info = media_case(media, combo=True)
                info.update({"EmptySource": {"input": {"required": {}}, "output": [media.upper()]},
                             "ReadyOutput": copy.deepcopy(info["MediaOutput"])})
                document["prompt"].update({
                    "3": {"class_type": "EmptySource", "inputs": {}},
                    "4": {"class_type": "ReadyOutput", "inputs": {"media": ["3", 0]}},
                })
                payload = self.install(document, info)
                payload["request"]["output_nodes"] = ["4"]
                original = self.app.packages.export(self.package["id"])
                plan = self.app.execution_plan(payload)
                self.assertEqual(plan["execution"]["active_field_ids"], [])
                self.assertEqual(plan["execution"]["node_ids"], ["3", "4"])
                compiled = self.app.compile(payload["request"])
                self.assertEqual(set(compiled["prompt"]), {"3", "4"})
                self.assertEqual(self.app.packages.export(self.package["id"]), original)
                payload["request"]["output_nodes"] = ["2"]
                self.assertEqual(self.app.execution_plan(payload)["execution"]["active_field_ids"],
                                 ["reference"])
                with self.assertRaises(ValueError):
                    self.app.compile(payload["request"])


if __name__ == "__main__":
    unittest.main()
