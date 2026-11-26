"""Shared editor interface metadata and execution-readiness boundary tests."""

import copy
import hashlib
import tempfile
import unittest
from pathlib import Path

from frameweave.editor_interfaces import (inspect_interface, normalize_editor_inputs,
                                          reconcile_interface, select_outputs)
from frameweave.packages import (PackageStore, apply_editor_values, apply_values,
                                encoded, normalize_document)
from frameweave.workflows import validate_editor_prompt, validate_prompt


def fixture():
    info = {
        "Params": {"input": {"required": {
            "text": ["STRING"], "seed": ["INT", {"min": 0, "max": 100}],
            "ckpt_name": [["current.safetensors"]], "mode": [["fast", "quality"]],
            "filename_prefix": ["STRING"],
        }}, "output": ["STRING"]},
        "LoadImage": {"input": {"required": {"image": [["current.png"]]}}, "output": ["IMAGE"]},
        "LoadVideo": {"input": {"required": {"file": ["COMBO", {
            "options": ["current.mp4"], "video_upload": True,
        }]}}, "output": ["VIDEO"]},
        "Sink": {"input": {"required": {"value": ["STRING"]}}, "output": [], "output_node": True},
    }
    prompt = {
        "1": {"class_type": "Params", "inputs": {
            "text": "hello", "seed": 10, "ckpt_name": "current.safetensors",
            "mode": "fast", "filename_prefix": "outputs",
        }},
        "2": {"class_type": "LoadImage", "inputs": {"image": "current.png"}},
        "3": {"class_type": "Sink", "inputs": {"value": ["1", 0]}},
    }
    return prompt, info


class InterfaceContractTests(unittest.TestCase):
    def test_metadata_roundtrip_preserves_old_package_identity(self):
        document = {"format": "frameweave-workflow", "version": 1, "name": "Legacy", "description": "",
                    "prompt": {"1": {"class_type": "Text", "inputs": {"text": "hello"}}},
                    "fields": [{"id": "text", "label": "Text", "node_id": "1", "input": "text",
                                "type": "text", "required": False, "default": "hello"}]}
        original = copy.deepcopy(document)
        expected_id = "p-" + hashlib.sha256(encoded(document)).hexdigest()[:24]
        with tempfile.TemporaryDirectory() as temporary:
            store = PackageStore(Path(temporary))
            saved = store.save(document)
            self.assertEqual(saved["id"], expected_id)
            self.assertEqual(store.export(saved["id"]), document)
            self.assertEqual((Path(temporary) / (saved["id"] + ".json")).read_bytes(), encoded(document))
            document["fields"][0].update(presentation="port", role="positive_prompt", group="提示词")
            current = store.save(document)
            self.assertNotEqual(current["id"], expected_id)
            self.assertEqual(store.get(current["id"])["fields"][0], document["fields"][0])
            self.assertEqual(store.export(expected_id), original)

    def test_metadata_rejects_bad_values_without_coercion(self):
        base = {"name": "Contract", "prompt": {"1": {"class_type": "Text", "inputs": {"text": "ok"}}},
                "fields": [{"id": "text", "label": "Text", "node_id": "1", "input": "text", "type": "text"}]}
        for key, value in (("presentation", "tensor"), ("presentation", []), ("presentation", None),
                           ("role", "Prompt"), ("role", "__proto__"), ("role", "a" * 65),
                           ("role", {}), ("group", ""), ("group", []), ("group", "x" * 81)):
            candidate = copy.deepcopy(base)
            candidate["fields"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                normalize_document(candidate)

    def test_schema_drives_common_defaults_without_exposing_internal_links(self):
        prompt, info = fixture()
        candidate = inspect_interface(prompt, info)
        fields = {(field["node_id"], field["input"]): field for field in candidate["fields"]}
        self.assertEqual(fields[("1", "text")]["presentation"], "port")
        self.assertTrue(fields[("1", "text")]["recommended"])
        self.assertEqual(fields[("1", "seed")]["presentation"], "control")
        self.assertTrue(fields[("1", "seed")]["recommended"])
        self.assertTrue(fields[("1", "ckpt_name")]["recommended"])
        self.assertEqual(fields[("1", "ckpt_name")]["presentation"], "control")
        self.assertFalse(fields[("1", "filename_prefix")]["recommended"])
        self.assertEqual(fields[("2", "image")]["presentation"], "port")
        self.assertNotIn(("3", "value"), fields)
        self.assertEqual(prompt, fixture()[0])

    def test_readiness_allows_missing_resources_but_strict_execution_rejects(self):
        prompt, info = fixture()
        prompt["1"]["inputs"]["ckpt_name"] = "previous.safetensors"
        prompt["2"]["inputs"]["image"] = ""
        original = copy.deepcopy(prompt)
        readiness = validate_editor_prompt(prompt, info)
        self.assertEqual(readiness["status"], "blocked")
        self.assertEqual([(issue["node_id"], issue["input"], issue["code"]) for issue in readiness["issues"]],
                         [("1", "ckpt_name", "missing_model"), ("2", "image", "missing_media")])
        with self.assertRaises(ValueError):
            validate_prompt(prompt, info)
        self.assertEqual(prompt, original)
        self.assertEqual(validate_editor_prompt(*fixture()), {"status": "unverified", "issues": []})

    def test_editor_mode_never_hides_structure_type_or_ordinary_enum_errors(self):
        prompt, info = fixture()
        changes = [lambda graph: graph["1"].update(class_type="Unknown"),
                   lambda graph: graph["3"]["inputs"].update(value=["missing", 0]),
                   lambda graph: graph["3"]["inputs"].update(value=["1", 7]),
                   lambda graph: graph["3"]["inputs"].update(value=["2", 0]),
                   lambda graph: graph["1"]["inputs"].update(seed=True),
                   lambda graph: graph["1"]["inputs"].update(seed=101),
                   lambda graph: graph["1"]["inputs"].update(mode="removed"),
                   lambda graph: graph["1"]["inputs"].update(text=["3", 0]),
                   lambda graph: graph["2"]["inputs"].update(image="../private.png"),
                   lambda graph: graph["1"]["inputs"].update(ckpt_name=False),
                   lambda graph: graph["1"]["inputs"].pop("text")]
        for change in changes:
            candidate = copy.deepcopy(prompt)
            candidate["1"]["inputs"]["ckpt_name"] = "missing.safetensors"
            change(candidate)
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_editor_prompt(candidate, info)

    def test_dynamiccombo_selection_and_schema_stay_strict(self):
        info = {"Dynamic": {"input": {"required": {"mode": ["COMFY_DYNAMICCOMBO_V3", {
            "options": [{"key": "fast", "inputs": {"required": {"count": ["INT"]}}}],
        }]}}, "output": []}}
        for inputs in ({"mode": "missing"}, {"mode": "fast"}, {"mode": "fast", "mode.count": "bad"}):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                validate_editor_prompt({"1": {"class_type": "Dynamic", "inputs": inputs}}, info)
        invalid_info = copy.deepcopy(info)
        invalid_info["Dynamic"]["input"]["required"]["mode"][1]["options"][0].pop("inputs")
        with self.assertRaises(ValueError):
            validate_editor_prompt({"1": {"class_type": "Dynamic", "inputs": {"mode": "fast"}}}, invalid_info)

    def test_editor_values_allow_only_pending_media_not_required_text_or_unsafe_input(self):
        document = {"name": "Inputs", "prompt": {
            "1": {"class_type": "Text", "inputs": {"text": "hello"}},
            "2": {"class_type": "LoadImage", "inputs": {"image": ""}},
        }, "fields": [
            {"id": "text", "label": "Prompt", "node_id": "1", "input": "text", "type": "text", "required": True},
            {"id": "image", "label": "Image", "node_id": "2", "input": "image", "type": "image"},
        ]}
        original = copy.deepcopy(document)
        result = apply_editor_values(document, {"text": "changed", "image": ""})
        self.assertEqual(result["2"]["inputs"]["image"], "")
        self.assertEqual(document, original)
        with self.assertRaises(ValueError):
            apply_values(document, {"image": ""})
        for values in ({"text": ""}, {"image": "../file.png"}, {"image": []}, {"unknown": 1}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                apply_editor_values(document, values)

    def test_video_reconciliation_and_display_metadata_survive_recompile(self):
        _, info = fixture()
        prompt = {"1": {"class_type": "LoadVideo", "inputs": {"file": "current.mp4"}}}
        field = inspect_interface(prompt, info)["fields"][0]
        self.assertEqual(field["presentation"], "port")
        previous = {**field, "presentation": "control"}
        reconciled = reconcile_interface([previous], {field["id"]: ""}, [field], prompt,
                                         {field["id"]: "current.mp4"})
        self.assertEqual(reconciled["values"][field["id"]], "")
        self.assertEqual(reconciled["changes"]["conflicts"], [])
        self.assertEqual(reconciled["changes"]["changed"][0]["current"]["presentation"], "port")

    def test_output_selection_editor_mode_retains_missing_model_branch(self):
        prompt, info = fixture()
        prompt["1"]["inputs"]["ckpt_name"] = "previous.safetensors"
        selected = select_outputs(prompt, ["3"], info, editing=True)
        self.assertEqual(set(selected), {"1", "3"})
        with self.assertRaises(ValueError):
            select_outputs(prompt, ["3"], info)

    def test_savevideo_sink_with_no_tensor_outputs_is_a_video_artifact(self):
        prompt = {"1": {"class_type": "SaveVideo", "inputs": {"filename_prefix": "video"}},
                  "2": {"class_type": "CustomSink", "inputs": {"filename_prefix": "other"}}}
        schema = {"input": {"required": {"filename_prefix": ["STRING"]}},
                  "output": [], "output_node": True}
        result = inspect_interface(prompt, {"SaveVideo": schema, "CustomSink": schema})
        self.assertEqual(result["outputs"], [
            {"id": "1", "label": "SaveVideo · 1", "mediaType": "video"},
            {"id": "2", "label": "CustomSink · 2", "mediaType": "unknown"},
        ])

    def test_dynamic_leaf_migration_uses_live_active_branch_and_preserves_original(self):
        info = {"SaveVideo": {"input": {"required": {"format": ["COMFY_DYNAMICCOMBO_V3", {
            "options": [{"key": "mp4", "inputs": {"required": {"codec": [["h264", "hevc"]]}}}],
        }]}}, "output": [], "output_node": True}}
        prompt = {"1": {"class_type": "SaveVideo", "inputs": {"format": "mp4", "codec": "h264"},
                        "_meta": {"title": "Keep original title"}}}
        original = copy.deepcopy(prompt)
        migrated = normalize_editor_inputs(prompt, info)
        self.assertEqual(migrated["prompt"]["1"]["inputs"], {"format": "mp4", "format.codec": "h264"})
        self.assertEqual(migrated["prompt"]["1"]["_meta"], original["1"]["_meta"])
        self.assertEqual(migrated["migrations"][0]["input"], "codec")
        self.assertEqual(migrated["migrations"][0]["target_input"], "format.codec")
        self.assertEqual(prompt, original)
        with self.assertRaises(ValueError):
            validate_prompt(prompt, info)
        validate_prompt(migrated["prompt"], info)
        self.assertEqual(normalize_editor_inputs(migrated["prompt"], info)["migrations"], [])

    def test_dynamic_leaf_migration_never_guesses_ambiguous_existing_linked_or_invalid_targets(self):
        combo = ["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "on", "inputs": {
            "required": {"count": ["INT", {"min": 0, "max": 3}]},
        }}]}]
        info = {"Dynamic": {"input": {"required": {"first": copy.deepcopy(combo)}}, "output": ["INT"]}}
        for value in (True, "1", 4, ["2", 0]):
            prompt = {"1": {"class_type": "Dynamic", "inputs": {"first": "on", "count": value}}}
            if isinstance(value, list):
                prompt["2"] = {"class_type": "Dynamic", "inputs": {"first": "off"}}
            with self.subTest(value=value):
                self.assertEqual(normalize_editor_inputs(prompt, info), {"prompt": prompt, "migrations": []})
        prompt = {"1": {"class_type": "Dynamic", "inputs": {"first": "on", "count": 1}}}
        ambiguous_info = copy.deepcopy(info)
        ambiguous_info["Dynamic"]["input"]["required"]["second"] = copy.deepcopy(combo)
        ambiguous = copy.deepcopy(prompt)
        ambiguous["1"]["inputs"]["second"] = "on"
        self.assertEqual(normalize_editor_inputs(ambiguous, ambiguous_info)["migrations"], [])
        ambiguous["1"]["inputs"]["first.count"] = 2
        self.assertEqual(normalize_editor_inputs(ambiguous, ambiguous_info)["migrations"], [])
        existing = copy.deepcopy(prompt)
        existing["1"]["inputs"]["first.count"] = 2
        self.assertEqual(normalize_editor_inputs(existing, info)["migrations"], [])
        declared_info = copy.deepcopy(info)
        declared_info["Dynamic"]["input"]["required"]["count"] = ["INT"]
        self.assertEqual(normalize_editor_inputs(prompt, declared_info)["migrations"], [])
        inactive = copy.deepcopy(prompt)
        inactive["1"]["inputs"]["first"] = "off"
        self.assertEqual(normalize_editor_inputs(inactive, info)["migrations"], [])


if __name__ == "__main__":
    unittest.main()
