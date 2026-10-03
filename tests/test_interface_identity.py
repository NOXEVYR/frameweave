"""Stable public identities depend on exact bindings, never display names."""
import copy
import unittest

from frameweave.editor_interfaces import inspect_interface, preserve_interface_identity, reconcile_interface


def fixture():
    prompt = {"3": {"class_type": "SaveImage", "inputs": {"filename_prefix": "FrameWeave"}}}
    info = {"SaveImage": {"input": {"required": {"filename_prefix": ["STRING"]}}, "output_node": True}}
    return prompt, info


class InterfaceIdentityTests(unittest.TestCase):
    def test_custom_prefix_keeps_public_identity_label_and_port(self):
        prompt, info = fixture()
        fresh = inspect_interface(prompt, info)["fields"]
        self.assertEqual(fresh[0]["id"], "f_b635470637a431b4")
        old = {**fresh[0], "id": "prefix", "label": "输出名称测试", "presentation": "port"}
        source = copy.deepcopy((prompt, info, fresh, old))
        current = inspect_interface(prompt, info, previous_fields=[old])["fields"]
        self.assertEqual([(f["id"], f["label"], f["presentation"]) for f in current],
                         [("prefix", "输出名称测试", "port")])
        self.assertEqual((prompt, info, fresh, old), source)
        outside = reconcile_interface([old], {"prefix": "outside output"}, current, prompt, {"prefix": "FrameWeave"})
        self.assertEqual(outside["values"], {"prefix": "outside output"})
        prompt["3"]["inputs"]["filename_prefix"] = "inside output"
        inside_fields = inspect_interface(prompt, info, previous_fields=[old])["fields"]
        inside = reconcile_interface([old], {"prefix": "FrameWeave"}, inside_fields, prompt, {"prefix": "FrameWeave"})
        self.assertEqual(inside["values"], {"prefix": "inside output"})

    def test_live_contract_defaults_options_and_bounds_never_come_from_old_fields(self):
        fresh = [{"id": "fresh", "node_id": "1", "input": "mode", "type": "select", "label": "Fresh", "options": ["new"], "default": "new", "required": True},
                 {"id": "fresh_n", "node_id": "1", "input": "amount", "type": "integer", "label": "Amount", "default": 2, "min": 1, "max": 3}]
        old = [{**fresh[0], "id": "mode", "label": "Custom mode", "options": ["old"], "default": "old", "required": False, "presentation": "control"},
               {**fresh[1], "id": "amount", "default": 0, "min": -100, "max": 100}]
        before = copy.deepcopy((fresh, old))
        kept = preserve_interface_identity(fresh, old)
        self.assertEqual(kept[0]["options"], ["new"])
        self.assertEqual((kept[0]["default"], kept[0]["required"]), ("new", True))
        self.assertEqual((kept[1]["default"], kept[1]["min"], kept[1]["max"]), (2, 1, 3))
        self.assertEqual((fresh, old), before)

    def test_same_label_or_changed_type_does_not_reuse_an_old_identity(self):
        fresh = [{"id": "fresh", "node_id": "2", "input": "text", "type": "text", "label": "Same", "presentation": "control"}]
        for old in ({"id": "old", "node_id": "1", "input": "text", "type": "text", "label": "Same", "presentation": "port"},
                    {"id": "old", "node_id": "2", "input": "other", "type": "text", "label": "Same", "presentation": "port"},
                    {"id": "old", "node_id": "2", "input": "text", "type": "integer", "label": "Same", "presentation": "port"}):
            self.assertEqual(preserve_interface_identity(fresh, [old]), fresh)

    def test_ambiguous_or_invalid_old_identity_is_rejected_including_unmatched_records(self):
        fresh = [{"id": "fresh", "node_id": "1", "input": "text", "type": "text", "label": "Fresh"}]
        good = {**fresh[0], "id": "custom"}
        cases = [[good, {**good, "node_id": "not-present"}], [good, {**good, "id": "other"}],
                 [{**good, "id": "__proto__"}], [{**good, "type": "unknown"}],
                 [{**good, "label": {"invalid": True}}], [{**good, "presentation": "unknown"}]]
        for fields in cases:
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                preserve_interface_identity(fresh, fields)

    def test_candidate_cross_identity_conflicts_are_rejected_even_when_both_could_be_renamed(self):
        fresh = [{"id": "fresh_a", "node_id": "1", "input": "a", "type": "text", "label": "A"},
                 {"id": "fresh_b", "node_id": "1", "input": "b", "type": "text", "label": "B"}]
        old = [{**fresh[0], "id": "fresh_b"}, {**fresh[1], "id": "custom_b"}]
        with self.assertRaisesRegex(ValueError, "冲突"):
            preserve_interface_identity(fresh, old)

    def test_fresh_duplicate_id_or_binding_is_never_silently_collapsed(self):
        good = {"id": "first", "node_id": "1", "input": "text", "type": "text", "label": "First"}
        for other in ({**good, "input": "other"}, {**good, "id": "second"}, {**good, "id": "second", "type": "integer"}):
            with self.subTest(other=other), self.assertRaises(ValueError):
                preserve_interface_identity([good, other])

    def test_no_previous_interface_preserves_fresh_preset_candidates_and_source(self):
        prompt, info = fixture()
        fresh = inspect_interface(prompt, info)["fields"]
        result = preserve_interface_identity(fresh)
        self.assertEqual(result, fresh)
        self.assertIsNot(result, fresh)
        result[0]["label"] = "changed locally"
        self.assertNotEqual(result, fresh)


if __name__ == "__main__":
    unittest.main()
