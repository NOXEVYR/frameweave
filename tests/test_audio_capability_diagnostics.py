"""Bounded, value-free explanations of live audio package readiness."""

import copy
import json
import unittest
from unittest.mock import patch

from frameweave.audio_workflows import MAX_AUDIO_DIAGNOSTICS, audio_capabilities
from test_generation_extensions import audio_package, schema, typed_audio_schema


class AudioCapabilityDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.info = typed_audio_schema()
        self.package = audio_package("pkg", {
            "1": {"class_type": "ToneGenerator", "inputs": {"prompt": "PRIVATE spoken text"}},
            "2": {"class_type": "AudioWriter", "inputs": {
                "audio": ["1", 0], "filename_prefix": "PRIVATE/output/file"}},
        })

    def result(self):
        return audio_capabilities(self.info, [self.package])["packages"][0]

    def codes(self):
        return [item["code"] for item in self.result()["diagnostics"]]

    def diagnostic_payload(self, result=None):
        result = self.result() if result is None else result
        return json.dumps({key: result[key] for key in (
            "reason", "issues", "diagnostics", "diagnostics_total", "diagnostics_truncated")}, ensure_ascii=False)

    def test_valid_package_keeps_contract_and_is_not_mutated(self):
        before = copy.deepcopy((self.info, self.package))
        result = self.result()
        self.assertTrue(result["schema_supported"])
        self.assertTrue(result["eligible"])
        self.assertTrue(result["available"])
        self.assertEqual(result["fields"], self.package["fields"])
        self.assertEqual(result["audio_outputs"], [{"type": "audio", "node_id": "2",
                                                  "class_type": "AudioWriter", "input": "audio"}])
        self.assertIsNone(result["reason"])
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["diagnostics"], [])
        self.assertEqual(result["diagnostics_total"], 0)
        self.assertFalse(result["diagnostics_truncated"])
        self.assertEqual((self.info, self.package), before)

    def test_missing_node_and_missing_input_have_specific_targets(self):
        del self.info["ToneGenerator"]
        result = self.result()
        self.assertFalse(result["schema_supported"])
        self.assertIn({"code": "missing_node", "node_id": "1", "class_type": "ToneGenerator"}, result["diagnostics"])
        self.assertIn("ToneGenerator", result["reason"])
        self.info = typed_audio_schema()
        self.package["prompt"]["1"]["inputs"].clear()
        result = self.result()
        self.assertEqual(result["diagnostics"], [{"code": "missing_input", "node_id": "1",
                                                   "class_type": "ToneGenerator", "input": "prompt"}])
        self.assertIn("必填输入", result["reason"])
        self.assertEqual(result["reason"], result["issues"][0])

    def test_empty_catalog_missing_model_and_invalid_selection_are_distinct(self):
        self.info["ToneGenerator"]["input"]["required"]["unet_name"] = [["current.safetensors"]]
        inputs = self.package["prompt"]["1"]["inputs"]
        inputs["unet_name"] = "PRIVATE/model-old.safetensors"
        result = self.result()
        self.assertEqual(result["diagnostics"][0], {"code": "missing_model", "node_id": "1",
                          "class_type": "ToneGenerator", "input": "unet_name", "resource_type": "model"})
        self.info["ToneGenerator"]["input"]["required"]["unet_name"] = [[]]
        self.assertEqual(self.result()["diagnostics"][0]["code"], "enum_unavailable")
        self.assertEqual(self.result()["diagnostics"][0]["resource_type"], "model")
        del self.info["ToneGenerator"]["input"]["required"]["unet_name"]
        del inputs["unet_name"]
        self.info["ToneGenerator"]["input"]["required"]["style"] = [["current"]]
        inputs["style"] = "PRIVATE selection text"
        self.assertEqual(self.codes(), ["invalid_selection"])
        self.assertNotIn("PRIVATE", self.diagnostic_payload())
        self.assertNotIn("current.safetensors", self.diagnostic_payload())

    def test_missing_upstream_schema_does_not_invent_broken_downstream_connections(self):
        del self.info["ToneGenerator"]
        self.assertEqual(self.codes(), ["missing_node"])
        self.info["ToneGenerator"] = None
        self.assertEqual(self.codes(), ["invalid_schema"])
        del self.package["prompt"]["1"]
        self.assertEqual(self.codes(), ["invalid_connection"])
        self.assertFalse(self.result()["eligible"])

    def test_exposed_pending_upload_is_eligible_but_empty_catalog_is_not(self):
        self.package["prompt"]["1"] = {"class_type": "LoadAudio", "inputs": {"audio": ""}}
        self.package["fields"] = [{"id": "source", "type": "audio", "node_id": "1", "input": "audio"}]
        self.assertTrue(self.result()["eligible"])
        self.assertEqual(self.codes(), [])
        self.info["LoadAudio"]["input"]["required"]["audio"] = [[]]
        self.assertFalse(self.result()["eligible"])
        self.assertEqual(self.codes(), ["enum_unavailable"])

    def test_nonempty_or_unexposed_media_is_blocked_without_media_names(self):
        self.package["prompt"]["1"] = {"class_type": "LoadAudio", "inputs": {"audio": "PRIVATE voice.wav"}}
        self.package["fields"] = [{"id": "source", "type": "audio", "node_id": "1", "input": "audio"}]
        self.assertEqual(self.codes(), ["missing_media"])
        self.assertNotIn("PRIVATE", self.diagnostic_payload())
        self.package["prompt"]["1"]["inputs"]["audio"] = ""
        self.package["fields"] = []
        self.assertEqual(self.codes(), ["missing_media"])

    def test_unsafe_resource_is_reported_without_path(self):
        self.package["prompt"]["1"] = {"class_type": "LoadAudio", "inputs": {"audio": "../PRIVATE.wav"}}
        self.assertEqual(self.codes(), ["unsafe_resource"])
        self.assertNotIn("PRIVATE", self.diagnostic_payload())
        self.assertNotIn("../", self.diagnostic_payload())

    def test_hard_failure_keeps_other_schema_diagnostics_and_pending_exception(self):
        self.info["ToneGenerator"]["input"]["required"].update(
            unet_name=[["current.safetensors"]], steps=["INT"])
        self.package["prompt"]["1"]["inputs"].update(unet_name="PRIVATE.safetensors", steps="PRIVATE steps")
        self.package["prompt"]["3"] = {"class_type": "LoadAudio", "inputs": {"audio": ""}}
        self.package["fields"] = [{"id": "source", "type": "audio", "node_id": "3", "input": "audio"}]
        self.assertEqual(self.codes(), ["missing_model", "invalid_value_type"])
        self.assertNotIn("PRIVATE", self.diagnostic_payload())

    def test_type_range_and_unsupported_input_are_specific(self):
        self.info["ToneGenerator"]["input"]["required"]["steps"] = ["INT", {"min": 1, "max": 100}]
        for value, code in (("PRIVATE", "invalid_value_type"), (101, "value_out_of_range")):
            with self.subTest(value=value):
                self.package["prompt"]["1"]["inputs"]["steps"] = value
                self.assertEqual(self.codes(), [code])
        self.package["prompt"]["1"]["inputs"]["steps"] = 1
        self.package["prompt"]["1"]["inputs"]["unsupported"] = "PRIVATE"
        self.assertEqual(self.codes(), ["unsupported_input"])

    def test_invalid_connection_and_non_audio_connection_are_blocked(self):
        for connection, code in ((["absent", 0], "invalid_connection"),
                                  (["1", 8], "invalid_connection")):
            with self.subTest(connection=connection):
                self.package["prompt"]["2"]["inputs"]["audio"] = connection
                self.assertEqual(self.codes(), [code])
                self.assertFalse(self.result()["eligible"])
        self.package["prompt"]["2"]["inputs"]["audio"] = ["1", 0]
        self.info["ToneGenerator"]["output"] = ["IMAGE"]
        self.assertEqual(self.codes(), ["connection_type_mismatch"])
        self.assertFalse(self.result()["schema_supported"])
        self.assertEqual(self.result()["audio_outputs"], [])

    def test_valid_non_audio_graph_is_supported_but_not_available(self):
        self.info["PlainImage"] = schema({}, ["IMAGE"])
        self.package["prompt"] = {"1": {"class_type": "PlainImage", "inputs": {}}}
        result = self.result()
        self.assertTrue(result["schema_supported"])
        self.assertFalse(result["eligible"])
        self.assertFalse(result["available"])
        self.assertEqual(result["audio_outputs"], [])
        self.assertEqual(self.codes(), ["no_audio_output"])

    def test_invalid_graph_and_cycle_fail_closed(self):
        self.package["prompt"] = {}
        self.assertEqual(self.codes(), ["invalid_graph"])
        self.info["PassAudio"] = schema({"audio": ["AUDIO"]}, ["AUDIO"])
        self.package["prompt"] = {"1": {"class_type": "PassAudio", "inputs": {"audio": ["1", 0]}}}
        self.assertEqual(self.codes(), ["invalid_graph"])
        self.assertFalse(self.result()["schema_supported"])

    def test_diagnostics_and_strings_are_bounded_with_full_count(self):
        count = MAX_AUDIO_DIAGNOSTICS + 5
        self.package["prompt"] = {str(i): {"class_type": "AbsentAudio", "inputs": {}}
                                  for i in range(count)}
        result = self.result()
        self.assertEqual(len(result["diagnostics"]), MAX_AUDIO_DIAGNOSTICS)
        self.assertEqual(len(result["issues"]), MAX_AUDIO_DIAGNOSTICS)
        self.assertEqual(result["diagnostics_total"], count)
        self.assertTrue(result["diagnostics_truncated"])
        self.assertEqual(result["reason"], result["issues"][0])
        # The same bound covers successful validator calls reporting soft failures.
        self.info["ModelLoader"] = schema({"unet_name": [[]]}, ["AUDIO"])
        self.package["prompt"] = {str(i): {"class_type": "ModelLoader", "inputs": {"unet_name": "PRIVATE.safetensors"}}
                                  for i in range(count)}
        self.assertEqual(self.result()["diagnostics_total"], count)
        self.assertEqual(len(self.result()["issues"]), MAX_AUDIO_DIAGNOSTICS)
        self.assertNotIn("PRIVATE", self.diagnostic_payload())

    def test_identifier_bounds_and_path_like_identifiers_do_not_leak(self):
        for identifier in ("C:\\PRIVATE\\voice.wav", "PRIVATE.mp3", "PRIVATE\ntext", "x" * 129):
            with self.subTest(identifier=identifier):
                self.package["prompt"] = {identifier: {"class_type": identifier, "inputs": {}}}
                result = self.result()
                self.assertEqual(result["diagnostics"], [{"code": "missing_node"}])
                self.assertNotIn(identifier, self.diagnostic_payload(result))

    def test_validator_message_and_unknown_fields_are_never_copied(self):
        readiness = {"issues": [{"code": "missing_model", "node_id": "1", "input": "model",
                                 "resource_type": "model", "message": "PRIVATE C:\\secret.wav",
                                 "value": "PRIVATE.safetensors", "options": ["PRIVATE filename"]}]}
        with patch("frameweave.audio_workflows.validate_editor_prompt", return_value=readiness):
            result = self.result()
        self.assertEqual(result["diagnostics"], [{"code": "missing_model", "node_id": "1",
                          "class_type": "ToneGenerator", "input": "model", "resource_type": "model"}])
        self.assertNotIn("PRIVATE", self.diagnostic_payload(result))

    def test_subgraph_ids_and_dynamic_input_paths_retain_safe_targets(self):
        self.package["prompt"] = {"19:32": {"class_type": "DynamicAudio", "inputs": {}}}
        self.info["DynamicAudio"] = schema({"format.codec": [["wav"]]}, ["AUDIO"])
        self.assertEqual(self.result()["diagnostics"], [{"code": "missing_input", "node_id": "19:32",
                          "class_type": "DynamicAudio", "input": "format.codec"}])
        self.assertIn("format.codec", self.result()["reason"])

    def test_file_suffixes_in_input_identifiers_are_not_published(self):
        for name in ("PRIVATE.wav", "PRIVATE.safetensors", "PRIVATE.GGUF", "PRIVATE.mp4"):
            with self.subTest(name=name):
                self.info["ToneGenerator"]["input"]["required"] = {name: ["STRING"]}
                self.package["prompt"]["1"]["inputs"] = {}
                self.assertNotIn("input", self.result()["diagnostics"][0])
                self.assertNotIn(name, self.diagnostic_payload())

    def test_diagnostic_scan_exception_does_not_interrupt_other_packages(self):
        bad = audio_package("bad", {"1": {"class_type": "Absent", "inputs": {}}})
        with patch("frameweave.audio_workflows._validation_failure_diagnostics",
                   side_effect=RuntimeError("PRIVATE unexpected error")):
            result = audio_capabilities(self.info, [bad, self.package])
        self.assertTrue(result["available"])
        self.assertEqual(result["packages"][0]["diagnostics"], [{"code": "schema_incompatible"}])
        self.assertFalse(result["packages"][0]["schema_supported"])
        self.assertTrue(result["packages"][1]["eligible"])
        self.assertNotIn("PRIVATE", self.diagnostic_payload(result["packages"][0]))

    def test_forceinput_rawlink_and_multiselect_empty_enums_are_not_softened(self):
        for flag in ("forceInput", "rawLink"):
            with self.subTest(flag=flag):
                self.info["ToneGenerator"]["input"]["required"]["style"] = [[], {flag: True}]
                self.package["prompt"]["1"]["inputs"]["style"] = ""
                self.assertEqual(self.codes(), ["invalid_selection"])
                self.assertFalse(self.result()["schema_supported"])
        self.info["ToneGenerator"]["input"]["required"]["style"] = [[], {"multiselect": True}]
        self.package["prompt"]["1"]["inputs"]["style"] = []
        self.assertTrue(self.result()["eligible"])
        self.package["prompt"]["1"]["inputs"]["style"] = ""
        self.assertEqual(self.codes(), ["invalid_selection"])

    def test_multiselect_and_dynamic_combo_model_named_inputs_are_not_missing_models(self):
        self.info["ToneGenerator"]["input"]["required"]["unet_name"] = [["choice"], {"multiselect": True}]
        self.package["prompt"]["1"]["inputs"]["unet_name"] = ["choice"]
        self.package["prompt"]["3"] = {"class_type": "Absent", "inputs": {}}
        self.assertEqual(self.codes(), ["missing_node"])
        self.info["ToneGenerator"]["input"]["required"]["unet_name"] = ["COMFY_DYNAMICCOMBO_V3", {
            "options": [{"key": "choice", "inputs": {"required": {"codec": ["STRING"]}}}]}]
        self.package["prompt"]["1"]["inputs"].update(unet_name="choice", **{"unet_name.codec": "wav"})
        self.assertEqual(self.codes(), ["missing_node"])
        self.package["prompt"]["1"]["inputs"]["unet_name"] = "PRIVATE-invalid-choice"
        self.assertNotIn("missing_model", self.codes())
        self.assertIn("invalid_selection", self.codes())
        self.assertNotIn("PRIVATE", self.diagnostic_payload())

    def test_connection_to_model_named_input_is_not_reported_as_missing_model(self):
        self.info["ToneGenerator"]["input"]["required"]["unet_name"] = [["choice"]]
        self.package["prompt"]["3"] = {"class_type": "ImageLoader", "inputs": {"image": "input.png"}}
        self.package["prompt"]["1"]["inputs"]["unet_name"] = ["3", 0]
        self.assertEqual(self.codes(), ["connection_type_mismatch"])
        self.assertNotIn("resource_type", self.result()["diagnostics"][0])


if __name__ == "__main__":
    unittest.main()
