"""Pure editing overlays retain source data and never prepare execution."""

import copy
import unittest
from unittest.mock import patch

from frameweave.editor_preparation import MAX_ITEMS, prepare_editor_document
from frameweave.packages import MAX_BYTES
import frameweave.editor_preparation as preparation
from frameweave.packages import encoded


def fixture():
    prompt = {
        "1": {"class_type": "Params", "inputs": {"text": "original", "seed": 42, "enabled": True, "model": "old-model"},
              "_meta": {"title": "保留标题", "plugin": {"state": 1}}, "properties": {"custom": True}},
        "2": {"class_type": "LoadImage", "inputs": {"image": "fixed/original.png"}},
        "3": {"class_type": "Output", "inputs": {"value": ["1", 0]}},
        "bad": {"class_type": "Unknown", "inputs": {"unresolved": ["not-there", 0]}, "extra": {"keep": [1, 2]}},
    }
    fields = [
        {"id": "text", "node_id": "1", "input": "text", "type": "text", "label": "提示词", "required": True},
        {"id": "seed", "node_id": "1", "input": "seed", "type": "integer", "label": "种子", "min": 0, "max": 100},
        {"id": "enabled", "node_id": "1", "input": "enabled", "type": "boolean", "label": "启用"},
        {"id": "model", "node_id": "1", "input": "model", "type": "select", "label": "模型", "options": ["old-model", "new-model"]},
        {"id": "image", "node_id": "2", "input": "image", "type": "image", "label": "图片", "required": True},
    ]
    info = {
        "Params": {"input": {"required": {"text": ["STRING"], "seed": ["INT", {"min": 0, "max": 80}],
                    "enabled": ["BOOLEAN"], "model": [["new-model"]]}}},
        "LoadImage": {"input": {"required": {"image": [["new.png"], {"image_upload": True}]}}},
        "Output": {"input": {"required": {"value": ["STRING", {"forceInput": True}]}}},
    }
    return prompt, fields, info


class EditorPreparationTests(unittest.TestCase):
    def prepare(self, **kwargs):
        prompt, fields, info = fixture()
        return prepare_editor_document(prompt, fields=fields, info=info,
                                       backend_url="http://127.0.0.1:8188", **kwargs)

    def test_complete_api_and_carrier_metadata_survive_unknown_and_unfinished_islands(self):
        prompt, fields, info = fixture()
        prompt["bad"]["inputs"]["cycle"] = ["bad", 0]
        source = {"prompt": prompt, "extra": {"editor": "original"}, "definitions": {"subgraphs": ["keep"]}}
        original = copy.deepcopy(source)
        result = prepare_editor_document(source, fields=fields, info=info)
        self.assertEqual(result["source_document"], original)
        self.assertEqual(result["prompt"], prompt)
        result["prompt"]["1"]["_meta"]["plugin"]["state"] = 9
        self.assertEqual(source, original)
        self.assertEqual(result["source_document"], original)
        self.assertEqual(result["status"], "unverified")

    def test_package_keeps_fixed_filenames_default_and_all_extension_fields(self):
        prompt, fields, info = fixture()
        fields[-1]["default"] = "private/fixed.png"
        source = {"format": "frameweave-workflow", "version": 1, "name": "工作流", "prompt": prompt,
                  "fields": fields, "custom_package": {"preserve": True}}
        original = copy.deepcopy(source)
        result = prepare_editor_document(source, source_kind="package", info=info)
        self.assertEqual(result["prompt"]["2"]["inputs"]["image"], "fixed/original.png")
        self.assertEqual(result["source_document"], original)
        self.assertEqual(source, original)

    def test_no_compile_upload_generate_or_backend_requests_even_for_missing_media(self):
        with patch("frameweave.workflows.compile_workflow", side_effect=AssertionError("compile")), \
                patch("frameweave.backend.Backend.request", side_effect=AssertionError("backend request")), \
                patch("frameweave.backend.Backend.upload", side_effect=AssertionError("upload")):
            result = self.prepare(overrides=[{"field_id": "image", "value": ""}])
        self.assertEqual(result["prompt"]["2"]["inputs"]["image"], "fixed/original.png")
        self.assertEqual(result["pending"][0]["reason"], "missing_media")

    def test_explicit_zero_false_empty_text_and_provenance_are_not_replaced_by_defaults(self):
        overrides = [{"field_id": "seed", "value": 0, "origin": "own", "stored_fallback": 42, "baseline": 42},
                     {"field_id": "enabled", "value": False},
                     {"field_id": "text", "value": "", "origin": "connection", "edge_id": "edge-1", "source_id": "prompt-1"}]
        original = copy.deepcopy(overrides)
        result = self.prepare(overrides=overrides)
        self.assertEqual(result["prompt"]["1"]["inputs"]["seed"], 0)
        self.assertIs(result["prompt"]["1"]["inputs"]["enabled"], False)
        self.assertEqual(result["prompt"]["1"]["inputs"]["text"], "")
        self.assertEqual(result["overrides"][0]["source_value"], 42)
        self.assertEqual(result["overrides"][2]["edge_id"], "edge-1")
        self.assertEqual(overrides, original)
        self.assertTrue(any(item["reason"] == "missing_value" for item in result["pending"]))

    def test_invalid_overrides_remain_pending_and_preserve_original_literals(self):
        for field_id, value in (("seed", True), ("seed", 81), ("seed", 1.5), ("text", {}),
                                ("enabled", 0), ("model", "not-current"), ("image", "../escape.png"),
                                ("image", "C:\\private.png"), ("image", "https://test.invalid/image.png")):
            with self.subTest(field_id=field_id, value=value):
                result = self.prepare(overrides=[{"field_id": field_id, "value": value}])
                self.assertEqual(result["prompt"], fixture()[0])
                self.assertEqual(result["overrides"], [])
                self.assertEqual(result["pending"][0]["reason"], "invalid_value")

    def test_stored_and_live_select_contracts_are_both_checked_without_changing_old_model(self):
        rejected = self.prepare(overrides=[{"field_id": "model", "value": "old-model"}])
        self.assertEqual(rejected["prompt"]["1"]["inputs"]["model"], "old-model")
        self.assertEqual(rejected["pending"][0]["reason"], "invalid_value")
        self.assertTrue(any(item["code"] == "enum_unavailable" and item.get("input") == "model"
                            for item in rejected["diagnostics"]))
        accepted = self.prepare(overrides=[{"field_id": "model", "value": "new-model"}])
        self.assertEqual(accepted["prompt"]["1"]["inputs"]["model"], "new-model")
        self.assertEqual(accepted["source_document"]["1"]["inputs"]["model"], "old-model")

    def test_missing_live_schema_preserves_values_and_reports_unapplied_projection(self):
        prompt, fields, _ = fixture()
        result = prepare_editor_document(prompt, fields=fields, overrides=[{"field_id": "seed", "value": 0}])
        self.assertEqual(result["prompt"], prompt)
        self.assertEqual(result["overrides"], [])
        self.assertEqual(result["pending"][0]["reason"], "schema_unavailable")

    def test_missing_required_values_are_diagnostic_not_an_editing_gate(self):
        prompt, fields, info = fixture()
        del prompt["1"]["inputs"]["seed"]
        prompt["2"]["inputs"]["image"] = ""
        info["Params"]["input"]["required"]["seed"][1]["default"] = 7
        result = prepare_editor_document(prompt, fields=fields, info=info)
        self.assertEqual(result["prompt"], prompt)
        self.assertNotIn("seed", result["prompt"]["1"]["inputs"])
        self.assertTrue(any(item["reason"] == "missing_input" and item["input"] == "seed" for item in result["pending"]))
        self.assertTrue(any(item["reason"] == "missing_media" for item in result["pending"]))

    def test_mapping_mismatch_unknown_and_duplicate_fields_do_not_write_any_node(self):
        for overrides in ([{"field_id": "unknown", "value": 0}],
                          [{"field_id": "seed", "node_id": "bad", "value": 0}],
                          [{"field_id": "seed", "input": "enabled", "value": 0}],
                          [{"field_id": "seed", "value": 0}, {"field_id": "seed", "value": 1}]):
            result = self.prepare(overrides=overrides)
            self.assertEqual(result["prompt"], fixture()[0])
            self.assertFalse(result["overrides"])
        prompt, fields, info = fixture()
        fields.append({**fields[1], "id": "another-seed"})
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "seed", "value": 0}])
        self.assertEqual(result["prompt"], prompt)
        self.assertEqual(result["pending"][0]["reason"], "ambiguous_mapping")

    def test_internal_links_and_system_hidden_or_forceinput_cannot_be_overridden(self):
        for change in ("link", "hidden", "forceInput", "rawLink", "multiselect", "wrong-type"):
            prompt, fields, info = fixture()
            if change == "link":
                prompt["1"]["inputs"]["seed"] = ["2", 0]
            elif change == "hidden":
                info["Params"]["input"]["hidden"] = {"seed": "PROMPT"}
            elif change == "wrong-type":
                info["Params"]["input"]["required"]["seed"] = ["IMAGE"]
            else:
                info["Params"]["input"]["required"]["seed"][1][change] = True
            with self.subTest(change=change):
                result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "seed", "value": 0}])
                self.assertEqual(result["prompt"], prompt)
                self.assertFalse(result["overrides"])

    def test_media_requires_exact_name_type_and_same_canonical_loopback_backend(self):
        variants = [(None, "owner_unknown"), ({"name": "other.png", "backend": "http://127.0.0.1:8188", "media_type": "image"}, "owner_unknown"),
                    ({"name": "new.png", "backend": "http://127.0.0.1:8188", "media_type": "video"}, "owner_unknown"),
                    ({"name": "new.png", "backend": "http://127.0.0.1:8189", "media_type": "image"}, "other_backend"),
                    ({"name": "new.png", "backend": "https://remote.invalid", "media_type": "image"}, "owner_unknown"),
                    ({"name": "new.png", "backend": "http://localhost:8188/", "media_type": "image"}, None)]
        for owner, reason in variants:
            with self.subTest(owner=owner):
                result = self.prepare(overrides=[{"field_id": "image", "value": "new.png", "media_owner": owner}])
                if reason:
                    self.assertEqual(result["pending"][0]["reason"], reason)
                    self.assertEqual(result["prompt"]["2"]["inputs"]["image"], "fixed/original.png")
                else:
                    self.assertEqual(result["prompt"]["2"]["inputs"]["image"], "new.png")
                    self.assertEqual(len(result["overrides"]), 1)

    def test_audio_and_video_filename_contracts_project_without_loading_any_media(self):
        for node_type, input_name, media_type in (("LoadAudio", "audio", "audio"), ("LoadVideo", "file", "video")):
            prompt = {"1": {"class_type": node_type, "inputs": {input_name: "old.bin"}}}
            fields = [{"id": "media", "node_id": "1", "input": input_name, "type": media_type, "label": "素材"}]
            info = {node_type: {"input": {"required": {input_name: [["new.bin"], {media_type + "_upload": True}]}}}}
            result = prepare_editor_document(prompt, fields=fields, info=info, backend_url="http://127.0.0.1:8188",
                overrides=[{"field_id": "media", "value": "new.bin", "media_owner": {
                    "name": "new.bin", "backend": "http://127.0.0.1:8188", "media_type": media_type}}])
            self.assertEqual(result["prompt"]["1"]["inputs"][input_name], "new.bin")
            self.assertEqual(result["source_document"], prompt)

    def test_existing_pending_and_source_provenance_are_retained_without_evaluation(self):
        waiting = [{"field_id": "image", "reason": "local_only", "source_id": "reference-1", "edge_id": "edge-image"},
                   {"field_id": "text", "reason": "upstream_not_run", "source_id": "generation-1"}]
        result = self.prepare(pending=waiting)
        self.assertEqual(result["pending"][:2], waiting)
        self.assertEqual(result["prompt"], fixture()[0])

    def test_pending_replacement_prevents_a_proven_but_stale_filename_projection(self):
        owner = {"name": "new.png", "backend": "http://127.0.0.1:8188", "media_type": "image"}
        for waiting in ([{"field_id": "image", "reason": "import_failed"}],
                        [{"node_id": "2", "input": "image", "reason": "import_pending"}]):
            result = self.prepare(pending=waiting, overrides=[{"field_id": "image", "value": "new.png", "media_owner": owner}])
            self.assertEqual(result["prompt"], fixture()[0])
            self.assertFalse(result["overrides"])
            self.assertEqual(result["pending"][0], waiting[0])
            self.assertEqual(result["pending"][1]["reason"], "input_pending")

    def test_diagnostics_do_not_copy_override_values_or_malformed_identity_objects(self):
        result = self.prepare(overrides=[{"field_id": {"private": "secret-id"}, "value": "secret-value"}])
        self.assertNotIn("secret", repr(result["diagnostics"]))
        self.assertEqual(result["pending"][0]["value"], "secret-value")
        self.assertEqual(result["prompt"], fixture()[0])

    def test_child_overlay_uses_final_explicit_dynamic_parent_and_keeps_inactive_islands(self):
        prompt = {"1": {"class_type": "Dynamic", "inputs": {"mode": "A", "mode.count": 5, "mode.text": "old"}}}
        fields = [{"id": "mode", "node_id": "1", "input": "mode", "type": "select", "label": "模式", "options": ["A", "B"]},
                  {"id": "count", "node_id": "1", "input": "mode.count", "type": "integer", "label": "数量"},
                  {"id": "text", "node_id": "1", "input": "mode.text", "type": "text", "label": "文字"}]
        info = {"Dynamic": {"input": {"required": {"mode": ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "A", "inputs": {"required": {"count": ["INT"]}}},
            {"key": "B", "inputs": {"required": {"text": ["STRING"]}}},
        ]}]}}}}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
            {"field_id": "text", "value": "new"}, {"field_id": "count", "value": 0}, {"field_id": "mode", "value": "B"}])
        self.assertEqual(result["prompt"]["1"]["inputs"], {"mode": "B", "mode.count": 5, "mode.text": "new"})
        self.assertTrue(any(item["reason"] == "inactive_input" for item in result["pending"]))
        self.assertEqual(result["source_document"], prompt)

    def test_safe_json_shape_boundaries_remain_errors(self):
        for document in ({}, {"nodes": []}, {"1": {"class_type": "X", "inputs": {"__proto__": 1}}},
                         {"1": {"class_type": "X", "inputs": {"seed": 9007199254740992}}},
                         {"1": {"class_type": "X", "inputs": {"value": float("nan")}}}):
            with self.subTest(document=document), self.assertRaises(ValueError):
                prepare_editor_document(document)
        for kwargs in ({"source_kind": "native"}, {"backend_url": "http://remote.invalid:8188"},
                       {"overrides": {}}, {"overrides": [{}] * (MAX_ITEMS + 1)},
                       {"pending": ["invalid"]}, {"fields": {}}, {"info": []}):
            with self.subTest(kwargs=repr(kwargs)[:60]), self.assertRaises(ValueError):
                prepare_editor_document(fixture()[0], **kwargs)

    def test_unsafe_mapping_metadata_and_malformed_schema_become_pending(self):
        prompt, fields, info = fixture()
        fields[1]["min"] = "unsafe"
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "seed", "value": 0}])
        self.assertEqual(result["prompt"], prompt)
        fields[1]["min"] = 0
        info["Params"]["input"]["optional"] = {"seed": ["INT"]}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "seed", "value": 0}])
        self.assertEqual(result["pending"][0]["reason"], "schema_invalid")

    def test_large_projection_cannot_expand_original_prompt_beyond_limit(self):
        prompt, fields, info = fixture()
        prompt["bad"]["extra"]["padding"] = "x" * (MAX_BYTES - 1000)
        result = prepare_editor_document(prompt, fields=fields, info=info,
                                         overrides=[{"field_id": "text", "value": "x" * 64000}])
        self.assertEqual(result["prompt"], prompt)
        self.assertEqual(result["pending"][0]["reason"], "payload_limit")

    def test_many_missing_inputs_have_explicit_bounded_diagnostics_without_blocking_source(self):
        prompt = {str(index): {"class_type": "Many", "inputs": {}} for index in range(1000)}
        info = {"Many": {"input": {"required": {f"item_{index}": ["STRING"] for index in range(5)}}}}
        result = prepare_editor_document(prompt, info=info)
        self.assertEqual(result["prompt"], prompt)
        self.assertEqual(len(result["pending"]), MAX_ITEMS)
        self.assertEqual(len(result["diagnostics"]), MAX_ITEMS)
        self.assertEqual(result["pending_omitted_count"], 5000 - MAX_ITEMS)
        self.assertEqual(result["diagnostics_omitted_count"], 5000 - MAX_ITEMS)

    def test_invalid_duplicate_id_records_cannot_hide_mapping_ambiguity(self):
        prompt, fields, info = fixture()
        for defect in ({"node_id": "not-present"}, {"type": "unsupported"}, {"min": "invalid"},
                       {"input": "missing-input"}, {"label": {"not": "text"}}):
            for invalid_first in (True, False):
                good = fields[1]
                bad = {**good, **defect}
                with self.subTest(defect=defect, invalid_first=invalid_first):
                    result = prepare_editor_document(prompt, fields=[bad, good] if invalid_first else [good, bad],
                        info=info, overrides=[{"field_id": "seed", "value": 0}])
                    self.assertEqual(result["prompt"], prompt)
                    self.assertFalse(result["overrides"])
                    self.assertEqual(result["pending"][0]["reason"], "ambiguous_mapping")

    def test_invalid_duplicate_binding_records_cannot_hide_mapping_ambiguity(self):
        prompt, fields, info = fixture()
        good = fields[1]
        for defect in ({"type": "unsupported"}, {"label": {"not": "text"}}, {"min": "invalid"}):
            bad = {**good, "id": "other", **defect}
            for mappings in ([good, bad], [bad, good]):
                with self.subTest(defect=defect, ids=[field["id"] for field in mappings]):
                    result = prepare_editor_document(prompt, fields=mappings, info=info,
                        overrides=[{"field_id": "seed", "value": 0}])
                    self.assertEqual(result["prompt"], prompt)
                    self.assertFalse(result["overrides"])
                    self.assertEqual(result["pending"][0]["reason"], "ambiguous_mapping")

    def test_flat_format_parent_precedes_reversed_scalar_and_enum_children(self):
        for definition, field_type, value in ((["INT", {"max": 2}], "integer", 3),
                                               ([["small"]], "select", "large")):
            initial = 5 if field_type == "integer" else "large"
            old_definition = ["INT", {"max": 5}] if field_type == "integer" else [["small", "large"]]
            prompt = {"1": {"class_type": "Formats", "inputs": {"format": "old", "quality": initial}}}
            fields = [{"id": "format", "node_id": "1", "input": "format", "type": "select", "options": ["old", "new"]},
                      {"id": "quality", "node_id": "1", "input": "quality", "type": field_type}]
            if field_type == "select":
                fields[1]["options"] = ["small", "large"]
            info = {"Formats": {"input": {"required": {"format": [["old", "new"], {"formats": {
                "old": [["quality", *old_definition]], "new": [["quality", *definition]],
            }}]}}}}
            result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
                {"field_id": "quality", "value": value}, {"field_id": "format", "value": "new"}])
            self.assertEqual(result["prompt"]["1"]["inputs"], {"format": "new", "quality": initial})
            self.assertEqual([item["field_id"] for item in result["overrides"]], ["format"])
            self.assertEqual(result["pending"][0]["reason"], "invalid_value")

    def test_final_dynamic_dependency_failure_restores_entire_node_batch_only(self):
        prompt = {"1": {"class_type": "Coupled", "inputs": {"mode": "old", "format": "A", "amount": 2}},
                  "2": {"class_type": "Plain", "inputs": {"amount": 2}}}
        fields = [{"id": "mode", "node_id": "1", "input": "mode", "type": "select", "options": ["old", "new"]},
                  {"id": "format", "node_id": "1", "input": "format", "type": "select", "options": ["A", "B"]},
                  {"id": "amount", "node_id": "1", "input": "amount", "type": "integer"},
                  {"id": "plain", "node_id": "2", "input": "amount", "type": "integer"}]
        info = {"Coupled": {"input": {"required": {
            "format": [["A", "B"], {"formats": {
                "A": [["mode", ["old", "new"], {"formats": {}}]],
                "B": [["mode", ["old"], {"formats": {}}]],
            }}], "amount": ["INT"],
        }}}, "Plain": {"input": {"required": {"amount": ["INT"]}}}}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
            {"field_id": "mode", "value": "new"}, {"field_id": "format", "value": "B"},
            {"field_id": "amount", "value": 0}, {"field_id": "plain", "value": 0}])
        self.assertEqual(result["prompt"]["1"], prompt["1"])
        self.assertEqual(result["prompt"]["2"]["inputs"]["amount"], 0)
        self.assertEqual([item["field_id"] for item in result["overrides"]], ["plain"])
        self.assertEqual({item["field_id"] for item in result["pending"]}, {"mode", "format", "amount"})
        self.assertTrue(all(item["reason"] == "dynamic_dependencies_unproven" for item in result["pending"]))
        self.assertEqual(result["source_document"], prompt)

    def test_static_scalar_batch_expands_schema_once_and_encodes_whole_graph_constant_times(self):
        count = 1024
        prompt = {"1": {"class_type": "Batch", "inputs": {f"value_{index}": index for index in range(count)}}}
        fields = [{"id": f"f{index}", "node_id": "1", "input": f"value_{index}", "type": "integer"} for index in range(count)]
        info = {"Batch": {"input": {"required": {f"value_{index}": ["INT"] for index in range(count)}}}}
        overlays = [{"field_id": f"f{index}", "value": 0} for index in range(count)]
        graph_encodings = []
        def observe(value):
            if isinstance(value, dict) and isinstance(value.get("1"), dict) and "inputs" in value["1"]:
                graph_encodings.append(value)
            return encoded(value)
        with patch.object(preparation, "_expanded_inputs", wraps=preparation._expanded_inputs) as expand, \
                patch.object(preparation, "encoded", side_effect=observe):
            result = prepare_editor_document(prompt, fields=fields, info=info, overrides=overlays)
        self.assertEqual(len(result["overrides"]), count)
        self.assertEqual(expand.call_count, 1)
        self.assertEqual(len(graph_encodings), 3)
        self.assertEqual(prompt["1"]["inputs"]["value_1023"], 1023)

    def test_nested_dynamic_selectors_refresh_cached_parent_activity(self):
        prompt = {"1": {"class_type": "Nested", "inputs": {"mode": "A", "mode.variant": "one", "mode.variant.amount": 7}}}
        fields = [{"id": "mode", "node_id": "1", "input": "mode", "type": "select", "options": ["A", "B"]},
                  {"id": "variant", "node_id": "1", "input": "mode.variant", "type": "select", "options": ["one", "two"]},
                  {"id": "amount", "node_id": "1", "input": "mode.variant.amount", "type": "integer"}]
        info = {"Nested": {"input": {"required": {"mode": ["COMFY_DYNAMICCOMBO_V3", {"options": [
            {"key": "A", "inputs": {"required": {"variant": ["COMFY_DYNAMICCOMBO_V3", {"options": [
                {"key": "one", "inputs": {"required": {"amount": ["INT", {"max": 10}]}}},
                {"key": "two", "inputs": {"required": {"amount": ["INT", {"max": 1}]}}},
            ]}]}}},
            {"key": "B", "inputs": {"required": {"variant": ["COMFY_DYNAMICCOMBO_V3", {"options": [
                {"key": "one", "inputs": {"required": {"amount": ["INT", {"max": 10}]}}},
                {"key": "two", "inputs": {"required": {"amount": ["INT", {"max": 3}]}}},
            ]}]}}},
        ]}]}}}}
        with patch.object(preparation, "_expanded_inputs", wraps=preparation._expanded_inputs) as expand:
            result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
                {"field_id": "amount", "value": 3}, {"field_id": "variant", "value": "two"}, {"field_id": "mode", "value": "B"}])
        self.assertEqual(result["prompt"]["1"]["inputs"], {"mode": "B", "mode.variant": "two", "mode.variant.amount": 3})
        self.assertEqual(expand.call_count, 3)
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
            {"field_id": "mode", "value": "B"}, {"field_id": "variant", "value": "two"}, {"field_id": "amount", "value": 4}])
        self.assertEqual(result["prompt"]["1"]["inputs"]["mode.variant.amount"], 7)
        self.assertEqual(result["pending"][0]["reason"], "invalid_value")

    def test_extension_format_selector_invalidates_cached_flat_widget_inputs(self):
        prompt = {"1": {"class_type": "Formats", "inputs": {"format": "old", "quality": 5}}}
        fields = [{"id": "format", "node_id": "1", "input": "format", "type": "select", "options": ["old", "new"]},
                  {"id": "quality", "node_id": "1", "input": "quality", "type": "integer"}]
        info = {"Formats": {"input": {"required": {"format": [["old", "new"], {"formats": {
            "old": [["quality", "INT", {"max": 5}]], "new": [["quality", "INT", {"max": 2}]],
        }}]}}}}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
            {"field_id": "format", "value": "new"}, {"field_id": "quality", "value": 3}])
        self.assertEqual(result["prompt"]["1"]["inputs"], {"format": "new", "quality": 5})
        self.assertEqual(result["pending"][0]["reason"], "invalid_value")

    def test_utf8_escaping_and_negative_zero_deltas_match_exact_json_boundary(self):
        value = '图🎨"\n\\' * 100
        prompt = {"1": {"class_type": "Bytes", "inputs": {"text": "", "number": -0.0}, "extra": ""}}
        fields = [{"id": "text", "node_id": "1", "input": "text", "type": "text"},
                  {"id": "number", "node_id": "1", "input": "number", "type": "number"}]
        info = {"Bytes": {"input": {"required": {"text": ["STRING"], "number": ["FLOAT"]}}}}
        final = copy.deepcopy(prompt)
        final["1"]["inputs"].update(text=value, number=0.0)
        padding = MAX_BYTES - len(encoded(final))
        prompt["1"]["extra"] = "x" * padding
        original = copy.deepcopy(prompt)
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
            {"field_id": "number", "value": 0.0}, {"field_id": "text", "value": value}])
        self.assertEqual(len(encoded(result["prompt"])), MAX_BYTES)
        self.assertEqual(len(result["overrides"]), 2)
        self.assertEqual(prompt, original)
        rejected = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
            {"field_id": "number", "value": 0.0}, {"field_id": "text", "value": value + "图"}])
        self.assertEqual(rejected["prompt"]["1"]["inputs"]["text"], "")
        self.assertEqual(rejected["pending"][0]["reason"], "payload_limit")

    def test_final_whole_graph_encoding_failure_aborts_without_mutating_source(self):
        prompt, fields, info = fixture()
        original = copy.deepcopy(prompt)
        calls = 0
        def reject_final(value):
            nonlocal calls
            if isinstance(value, dict) and isinstance(value.get("1"), dict) and "inputs" in value["1"]:
                calls += 1
                if calls == 3:
                    raise ValueError("complete encoding failed")
            return encoded(value)
        with patch.object(preparation, "encoded", side_effect=reject_final), self.assertRaisesRegex(ValueError, "complete encoding failed"):
            prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "seed", "value": 0}])
        self.assertEqual(prompt, original)

    def test_dynamic_rollback_over_budget_withdraws_remaining_overlays_and_returns_source(self):
        prompt = {
            "1": {"class_type": "Coupled", "inputs": {"format": "A", "mode": "old", "text": "x" * 5000},
                  "_meta": {"extension": {"keep": True}}},
            "2": {"class_type": "Plain", "inputs": {"text": ""}, "padding": "", "properties": {"keep": [1, 2]}},
            "unknown": {"class_type": "NotInstalled", "inputs": {"broken": ["missing", -1]}, "extension": ["keep"]},
        }
        prompt["2"]["padding"] = "x" * (MAX_BYTES - len(encoded(prompt)) - 1000)
        self.assertEqual(len(encoded(prompt)), MAX_BYTES - 1000)
        fields = [
            {"id": "mode", "node_id": "1", "input": "mode", "type": "select", "options": ["old", "new"]},
            {"id": "format", "node_id": "1", "input": "format", "type": "select", "options": ["A", "B"]},
            {"id": "shrink", "node_id": "1", "input": "text", "type": "text"},
            {"id": "grow", "node_id": "2", "input": "text", "type": "text"},
        ]
        info = {
            "Coupled": {"input": {"required": {
                "format": [["A", "B"], {"formats": {
                    "A": [["mode", ["old", "new"], {"formats": {}}]],
                    "B": [["mode", ["old"], {"formats": {}}]],
                }}], "text": ["STRING"],
            }}}, "Plain": {"input": {"required": {"text": ["STRING"]}}},
        }
        overlays = [
            {"field_id": "mode", "value": "new"}, {"field_id": "format", "value": "B"},
            {"field_id": "shrink", "value": ""},
            {"field_id": "grow", "value": "y" * 4000, "origin": "connected", "edge_id": "edge-2",
             "source_id": "prompt-2", "stored_fallback": "fallback", "baseline": "older"},
        ]
        original, original_overlays = copy.deepcopy(prompt), copy.deepcopy(overlays)
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=overlays)
        self.assertEqual(result["prompt"], original)
        self.assertEqual(result["source_document"], original)
        self.assertEqual(prompt, original)
        self.assertEqual(overlays, original_overlays)
        self.assertEqual(result["overrides"], [])
        self.assertEqual(len(encoded(result["prompt"])), MAX_BYTES - 1000)
        deferred = {item["field_id"]: item for item in result["pending"] if "field_id" in item}
        self.assertEqual({key: item["reason"] for key, item in deferred.items()}, {
            "mode": "dynamic_dependencies_unproven", "format": "dynamic_dependencies_unproven",
            "shrink": "dynamic_dependencies_unproven", "grow": "payload_limit",
        })
        self.assertEqual(deferred["grow"], {
            **original_overlays[-1], "node_id": "2", "input": "text", "source_value": "", "reason": "payload_limit",
        })
        # The restored source selector A accepts "old". A cached B declaration
        # would incorrectly flag it, so source diagnostics must be refreshed.
        self.assertFalse(any(item["code"] == "source_value_unverified" and item.get("input") == "mode"
                             for item in result["diagnostics"]))
        package = {"format": "frameweave-workflow", "version": 1, "prompt": prompt, "fields": fields,
                   "extension": {"definitions": [{"unchanged": True}]}}
        original_package = copy.deepcopy(package)
        packaged = prepare_editor_document(package, source_kind="package", info=info, overrides=overlays)
        self.assertEqual(packaged["source_document"], original_package)
        self.assertEqual(packaged["prompt"], original)
        self.assertEqual(packaged["overrides"], [])
        self.assertEqual(packaged["pending"], result["pending"])
        self.assertEqual(package, original_package)

    def test_active_v3_qualified_input_collision_rejects_both_declaration_orders(self):
        prompt = {"1": {"class_type": "Overlap", "inputs": {"mode": "A", "mode.amount": 0},
                        "_meta": {"plugin": {"keep": True}}, "properties": {"keep": "original"}},
                  "2": {"class_type": "Plain", "inputs": {"amount": 1}}}
        fields = [{"id": "amount", "node_id": "1", "input": "mode.amount", "type": "integer"},
                  {"id": "plain", "node_id": "2", "input": "amount", "type": "integer"}]
        dynamic = ["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "A", "inputs": {
            "required": {"amount": ["INT", {"max": 1}]}}}]}]
        original = copy.deepcopy(prompt)
        for entries in (("mode", "mode.amount"), ("mode.amount", "mode")):
            definitions = {"mode": dynamic, "mode.amount": ["INT", {"max": 10}]}
            info = {"Overlap": {"input": {"required": {name: definitions[name] for name in entries}}},
                    "Plain": {"input": {"required": {"amount": ["INT"]}}}}
            with self.subTest(order=entries):
                result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[
                    {"field_id": "amount", "value": 5}, {"field_id": "plain", "value": 0}])
                self.assertEqual(result["prompt"]["1"], original["1"])
                self.assertEqual(result["prompt"]["2"]["inputs"]["amount"], 0)
                self.assertEqual([item["field_id"] for item in result["overrides"]], ["plain"])
                self.assertEqual(result["pending"][0]["reason"], "schema_invalid")
                self.assertEqual(result["source_document"], original)
                self.assertEqual(prompt, original)

    def test_v3_qualified_collision_across_required_optional_hidden_is_not_a_mapping(self):
        prompt = {"1": {"class_type": "Overlap", "inputs": {"mode": "A", "mode.amount": 0}}}
        fields = [{"id": "amount", "node_id": "1", "input": "mode.amount", "type": "integer"}]
        for child_group in ("required", "optional", "hidden"):
            for flat_group in ("required", "optional", "hidden"):
                child = "PROMPT" if child_group == "hidden" else ["INT", {"max": 1}]
                flat = "PROMPT" if flat_group == "hidden" else ["INT", {"max": 10}]
                dynamic = ["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "A", "inputs": {
                    child_group: {"amount": child}}}]}]
                groups = {"required": {"mode": dynamic}}
                groups.setdefault(flat_group, {})["mode.amount"] = flat
                with self.subTest(child_group=child_group, flat_group=flat_group):
                    result = prepare_editor_document(prompt, fields=fields, info={"Overlap": {"input": groups}},
                        overrides=[{"field_id": "amount", "value": 5}])
                    self.assertEqual(result["prompt"], prompt)
                    self.assertFalse(result["overrides"])
                    self.assertEqual(result["pending"][0]["reason"], "schema_invalid")

    def test_inactive_v3_branch_collision_does_not_block_the_current_unambiguous_branch(self):
        prompt = {"1": {"class_type": "Overlap", "inputs": {"mode": "B", "mode.amount": 0}}}
        fields = [{"id": "amount", "node_id": "1", "input": "mode.amount", "type": "integer"}]
        info = {"Overlap": {"input": {"required": {
            "mode": ["COMFY_DYNAMICCOMBO_V3", {"options": [
                {"key": "A", "inputs": {"required": {"amount": ["INT", {"max": 1}]}}},
                {"key": "B", "inputs": {"required": {"other": ["INT"]}}}]}],
            "mode.amount": ["INT", {"max": 10}]}}}}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "amount", "value": 5}])
        self.assertEqual(result["prompt"]["1"]["inputs"]["mode.amount"], 5)
        self.assertEqual(len(result["overrides"]), 1)

    def test_format_widget_explicit_same_name_keeps_official_declared_input_precedence(self):
        prompt = {"1": {"class_type": "Formats", "inputs": {"format": "mp4", "quality": 0}}}
        fields = [{"id": "quality", "node_id": "1", "input": "quality", "type": "integer"}]
        info = {"Formats": {"input": {"required": {
            "format": [["mp4"], {"formats": {"mp4": [["quality", "INT", {"max": 1}]]}}],
            "quality": ["INT", {"max": 10}]}}}}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "quality", "value": 5}])
        self.assertEqual(result["prompt"]["1"]["inputs"]["quality"], 5)
        self.assertEqual(len(result["overrides"]), 1)

    def test_autogrow_derived_collision_rejects_explicit_and_generated_names_in_both_orders(self):
        for naming, child in (({"names": ["amount"]}, "amount"),
                              ({"prefix": "value_", "max": 1}, "value_0")):
            input_name = "refs." + child
            prompt = {"1": {"class_type": "Overlap", "inputs": {input_name: 0},
                            "_meta": {"keep": {"nested": True}}}}
            fields = [{"id": "amount", "node_id": "1", "input": input_name, "type": "integer"}]
            auto = ["COMFY_AUTOGROW_V3", {"template": {**naming, "min": 0,
                "input": {"optional": {}, "required": {"unrelated_template_name": ["INT", {"max": 1}]}}}}]
            for entries in (("refs", input_name), (input_name, "refs")):
                definitions = {"refs": auto, input_name: ["INT", {"max": 10}]}
                with self.subTest(naming=naming, order=entries):
                    original = copy.deepcopy(prompt)
                    result = prepare_editor_document(prompt, fields=fields,
                        info={"Overlap": {"input": {"required": {name: definitions[name] for name in entries}}}},
                        overrides=[{"field_id": "amount", "value": 5}])
                    self.assertEqual(result["prompt"], original)
                    self.assertEqual(result["source_document"], original)
                    self.assertEqual(prompt, original)
                    self.assertFalse(result["overrides"])
                    self.assertEqual(result["pending"][0]["reason"], "schema_invalid")

    def test_autogrow_named_children_collide_with_active_v3_paths_in_both_orders(self):
        prompt = {"1": {"class_type": "Overlap", "inputs": {"mode": "A", "mode.refs.amount": 0}}}
        fields = [{"id": "amount", "node_id": "1", "input": "mode.refs.amount", "type": "integer"}]
        dynamic = ["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "A", "inputs": {"required": {
            "refs.amount": ["INT", {"max": 1}]}}}]}]
        auto = ["COMFY_AUTOGROW_V3", {"template": {"names": ["amount"], "input": {
            "required": {"entry": ["INT", {"max": 10}]}}}}]
        for entries in (("mode", "mode.refs"), ("mode.refs", "mode")):
            definitions = {"mode": dynamic, "mode.refs": auto}
            result = prepare_editor_document(prompt, fields=fields,
                info={"Overlap": {"input": {"required": {name: definitions[name] for name in entries}}}},
                overrides=[{"field_id": "amount", "value": 5}])
            self.assertEqual(result["prompt"], prompt)
            self.assertEqual(result["pending"][0]["reason"], "schema_invalid")

    def test_format_generated_collision_with_v3_is_rejected_in_both_orders(self):
        prompt = {"1": {"class_type": "Overlap", "inputs": {"mode": "A", "format": "mp4", "mode.amount": 0}}}
        fields = [{"id": "amount", "node_id": "1", "input": "mode.amount", "type": "integer"}]
        definitions = {
            "mode": ["COMFY_DYNAMICCOMBO_V3", {"options": [{"key": "A", "inputs": {"required": {
                "amount": ["INT", {"max": 1}]}}}]}],
            "format": [["mp4"], {"formats": {"mp4": [["mode.amount", "INT", {"max": 10}]]}}]}
        for entries in (("mode", "format"), ("format", "mode")):
            result = prepare_editor_document(prompt, fields=fields,
                info={"Overlap": {"input": {"required": {name: definitions[name] for name in entries}}}},
                overrides=[{"field_id": "amount", "value": 5}])
            self.assertEqual(result["prompt"], prompt)
            self.assertFalse(result["overrides"])
            self.assertEqual(result["pending"][0]["reason"], "schema_invalid")

    def test_multiple_active_formats_cannot_silently_choose_first_generated_declaration(self):
        prompt = {"1": {"class_type": "Overlap", "inputs": {"format_a": "mp4", "format_b": "mp4", "quality": 0}}}
        fields = [{"id": "quality", "node_id": "1", "input": "quality", "type": "integer"}]
        definitions = {name: [["mp4"], {"formats": {"mp4": [["quality", "INT", {"max": maximum}]]}}]
                       for name, maximum in (("format_a", 1), ("format_b", 10))}
        for entries in (("format_a", "format_b"), ("format_b", "format_a")):
            result = prepare_editor_document(prompt, fields=fields,
                info={"Overlap": {"input": {"required": {name: definitions[name] for name in entries}}}},
                overrides=[{"field_id": "quality", "value": 5}])
            self.assertEqual(result["prompt"], prompt)
            self.assertFalse(result["overrides"])
            self.assertEqual(result["pending"][0]["reason"], "schema_invalid")

    def test_opaque_format_metadata_does_not_invent_widget_declarations(self):
        prompt = {"1": {"class_type": "Formats", "inputs": {"format": "mp4", "quality": 0}}}
        fields = [{"id": "quality", "node_id": "1", "input": "quality", "type": "integer"}]
        info = {"Formats": {"input": {"required": {
            "format": [["mp4"], {"formats": {"mp4": {"quality": "opaque-processing-metadata"}}}],
            "quality": ["INT", {"max": 10}]}}}}
        result = prepare_editor_document(prompt, fields=fields, info=info, overrides=[{"field_id": "quality", "value": 5}])
        self.assertEqual(result["prompt"]["1"]["inputs"]["quality"], 5)
        self.assertEqual(len(result["overrides"]), 1)


if __name__ == "__main__":
    unittest.main()
