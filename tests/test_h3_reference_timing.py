"""Audited reference timing estimates: data-only, conditional, current values."""
import copy
import unittest

from frameweave.h3_reference import h3_reference_timing, prepare_h3_reference_package
from frameweave.packages import apply_editor_values
from test_h3_reference import fixture, layout


def document(cap=48, length=124, soundtrack=True):
    inputs = {"length": length, "ref_videos.ref_video_0": ["video", 0]}
    if soundtrack:
        inputs["ref_video_audios.ref_video_audio_0"] = ["video", 2]
    return {"prompt": {
        "h3": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": inputs},
        "video": {"class_type": "VHS_LoadVideo", "inputs": {
            "video": "synthetic.mp4", "force_rate": 24, "frame_load_cap": cap,
            "skip_first_frames": 0, "select_every_nth": 1, "format": "None"}}}, "fields": []}


class H3ReferenceTimingTests(unittest.TestCase):
    def test_audited_48_frame_gap_is_conditional_and_does_not_change_graph(self):
        doc = document()
        before = copy.deepcopy(doc)
        timing = h3_reference_timing(doc)[0]
        self.assertEqual((timing["frame_load_cap"], timing["effective_frames_estimate"]), (48, 39))
        self.assertEqual(timing["loaded_seconds_estimate"], 2)
        self.assertEqual(timing["effective_seconds_estimate"], 1.625)
        self.assertEqual(timing["soundtrack_seconds_estimate"], 2)
        self.assertEqual(timing["span_difference_seconds_estimate"], .375)
        self.assertEqual(timing["discarded_frames_estimate"], 9)
        self.assertEqual(timing["estimate_status"], "conditional")
        self.assertFalse(timing["runtime_verified"])
        self.assertIn("加载满上限", timing["condition"])
        self.assertIn("object_info 不能证明", timing["condition"])
        self.assertIn("最多 39 帧", timing["message"])
        self.assertEqual(doc, before)

    def test_alignment_boundaries_and_output_length_limit(self):
        for cap, expected in ((5, 5), (21, 5), (22, 22), (38, 22), (39, 39),
                              (48, 39), (55, 39), (56, 56), (123, 107), (124, 124), (362, 362)):
            with self.subTest(cap=cap):
                timing = h3_reference_timing(document(cap, 480))[0]
                self.assertEqual(timing["effective_frames_estimate"], expected)
                self.assertEqual(timing["discarded_frames_estimate"], cap - expected)
        timing = h3_reference_timing(document(48, 22))[0]
        self.assertEqual(timing["effective_frames_estimate"], 22)
        self.assertEqual(timing["span_difference_seconds_estimate"], 26 / 24)

    def test_current_outer_values_override_defaults_and_do_not_change_source(self):
        doc = document(124)
        doc["fields"] = [
            {"id": "cap", "node_id": "video", "input": "frame_load_cap", "default": 124},
            {"id": "length", "node_id": "h3", "input": "length", "default": 124}]
        before = copy.deepcopy(doc)
        for cap, expected in ((48, 39), (39, 39), (56, 56)):
            timing = h3_reference_timing(doc, {"cap": cap})[0]
            self.assertEqual(timing["frame_load_cap"], cap)
            self.assertEqual(timing["effective_frames_estimate"], expected)
        self.assertEqual(h3_reference_timing(doc, {"cap": 48, "length": 22})[0]["effective_frames_estimate"], 22)
        self.assertEqual(doc, before)

    def test_unknown_unbounded_or_changed_reading_controls_never_fabricate_frames(self):
        changes = [("frame_load_cap", value) for value in (0, 4, True, 48.5, "48", ["other", 0], float("inf"), float("nan"), 9007199254740992, 10 ** 400)]
        changes += [("force_rate", 0), ("force_rate", 30), ("select_every_nth", 2),
                    ("skip_first_frames", 1), ("skip_first_frames", ["other", 0]), ("format", "AnimateDiff")]
        for name, value in changes:
            with self.subTest(name=name, value=value):
                doc = document()
                doc["prompt"]["video"]["inputs"][name] = value
                timing = h3_reference_timing(doc)[0]
                self.assertEqual(timing["estimate_status"], "unknown")
                for key in ("effective_frames_estimate", "effective_seconds_estimate", "soundtrack_seconds_estimate", "span_difference_seconds_estimate"):
                    self.assertIsNone(timing[key])
                self.assertFalse(timing["runtime_verified"])
        for length in (4, ["other", 0]):
            self.assertEqual(h3_reference_timing(document(length=length))[0]["estimate_status"], "unknown")

    def test_json_integer_floats_match_javascript_numeric_estimates(self):
        doc = document(48.0, 124.0)
        doc["prompt"]["video"]["inputs"].update(select_every_nth=1.0, skip_first_frames=0.0)
        timing = h3_reference_timing(doc)[0]
        self.assertEqual(timing["estimate_status"], "conditional")
        self.assertEqual(timing["effective_frames_estimate"], 39)
        self.assertEqual(timing["frame_load_cap"], 48)

    def test_stale_defaults_cannot_hide_removed_linked_or_duplicate_bindings(self):
        for mode in ("deleted", "linked", "no_inputs", "duplicate"):
            with self.subTest(mode=mode):
                doc = document()
                doc["fields"] = [{"id": "cap", "node_id": "video", "input": "frame_load_cap", "default": 48}]
                if mode == "deleted":
                    del doc["prompt"]["video"]["inputs"]["frame_load_cap"]
                elif mode == "linked":
                    doc["prompt"]["video"]["inputs"]["frame_load_cap"] = ["other", 0]
                elif mode == "no_inputs":
                    del doc["prompt"]["video"]["inputs"]
                else:
                    doc["fields"].append({**doc["fields"][0], "id": "othercap", "default": 39})
                self.assertEqual(h3_reference_timing(doc, {"cap": 48})[0]["estimate_status"], "unknown")
        doc = document()
        doc["fields"] = [{"id": "length", "node_id": "h3", "input": "length", "default": 124}]
        doc["prompt"]["h3"]["inputs"]["length"] = ["other", 0]
        self.assertEqual(h3_reference_timing(doc, {"length": 124})[0]["estimate_status"], "unknown")

    def test_only_same_loader_audio_is_paired_and_each_video_uses_its_own_cap(self):
        doc = document(soundtrack=False)
        doc["prompt"]["h3"]["inputs"]["ref_video_audios.ref_video_audio_0"] = ["different", 2]
        timing = h3_reference_timing(doc)[0]
        self.assertFalse(timing["soundtrack"])
        self.assertIsNone(timing["span_difference_seconds_estimate"])
        doc["prompt"]["second"] = copy.deepcopy(doc["prompt"]["video"])
        doc["prompt"]["second"]["inputs"]["frame_load_cap"] = 56
        doc["prompt"]["h3"]["inputs"]["ref_videos.ref_video_2"] = ["second", 0]
        self.assertEqual([item["effective_frames_estimate"] for item in h3_reference_timing(doc)], [39, 56])
        doc = document(soundtrack=False)
        doc["prompt"]["h3"]["inputs"]["ref_video_audios.ref_video_audio_1"] = ["video", 2]
        timing = h3_reference_timing(doc)[0]
        # A different group name still carries an explicit same-source audio
        # input. This says nothing about model-side slot pairing correctness.
        self.assertTrue(timing["soundtrack"])
        self.assertEqual(timing["span_difference_seconds_estimate"], .375)
        self.assertIn("同源音轨输入", timing["message"])

    def test_non_suffix_slot_order_uses_actual_loader_field_labels(self):
        info = fixture()
        info["MiniMaxH3ReferenceToVideo"]["input"]["optional"]["ref_videos"][1]["template"]["names"] = ["ref_video_2", "ref_video_0", "ref_video_1"]
        result = prepare_h3_reference_package({"kind": "h3_ref"}, layout(videos=(False, True)), info)
        self.assertEqual(result["status"], "prepared")
        timing = result["summary"]["reference_video_timing"]
        self.assertEqual([(item["video_label"], item["video_ordinal"], item["video_input"], item["soundtrack"]) for item in timing],
                         [("参考视频1", 1, "ref_videos.ref_video_2", False), ("参考视频2", 2, "ref_videos.ref_video_0", True)])

    def test_prepared_package_and_applied_user_cap_share_timing_without_rewriting_inputs(self):
        prepared = prepare_h3_reference_package({"kind": "h3_ref"}, layout(videos=(True,)), fixture())
        doc = prepared["document"]
        before = copy.deepcopy(doc)
        self.assertEqual(prepared["summary"]["reference_video_timing"], h3_reference_timing(doc))
        cap = next(field for field in doc["fields"] if field["input"] == "frame_load_cap")
        prompt = apply_editor_values(doc, {cap["id"]: 48})
        self.assertEqual(prompt[cap["node_id"]]["inputs"]["frame_load_cap"], 48)
        self.assertEqual(h3_reference_timing({"prompt": prompt})[0]["effective_frames_estimate"], 39)
        self.assertEqual(doc, before)

    def test_no_video_and_malformed_or_unsupported_sources_are_safe(self):
        self.assertIn("节点 video", h3_reference_timing(document())[0]["message"])
        self.assertIsNone(h3_reference_timing(document())[0]["video_ordinal"])
        self.assertEqual(h3_reference_timing({"prompt": {}}), [])
        self.assertEqual(h3_reference_timing(None), [])
        self.assertEqual(h3_reference_timing({"prompt": {"x": None}}), [])
        for value in (None, ["video", 1], ["missing", 0]):
            doc = document()
            doc["prompt"]["h3"]["inputs"]["ref_videos.ref_video_0"] = value
            self.assertEqual(h3_reference_timing(doc)[0]["estimate_status"], "unknown")
        doc = document()
        doc["prompt"]["video"]["class_type"] = "OtherVideoLoader"
        self.assertEqual(h3_reference_timing(doc)[0]["estimate_status"], "unknown")


if __name__ == "__main__":
    unittest.main()
