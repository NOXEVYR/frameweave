import copy
import unittest

from frameweave.packages import normalize_document, apply_values
from frameweave.workflow_models import workflow_models


class WorkflowModelTests(unittest.TestCase):
    def setUp(self):
        self.info = {}
        prompt = {}
        for kind in ("VIDEO", "AUDIO"):
            loader, sink = kind + "Custom", "Export" + kind
            self.info[loader] = {"input": {"required": {"weights": [["a.gguf", "b.gguf"]]}}, "output": [kind]}
            self.info[sink] = {"input": {"required": {"samples": [kind]}}, "output": [], "output_node": True}
            prompt[loader] = {"class_type": loader, "inputs": {"weights": "a.gguf"}}
            prompt[sink] = {"class_type": sink, "inputs": {"samples": [loader, 0]}}
        self.pack = normalize_document({"name": "Sample", "prompt": prompt, "fields": []})

    def test_switch_each_output_and_project_model_into_submitted_graph(self):
        for kind in ("VIDEO", "AUDIO"):
            sink = "Export" + kind
            slot, = workflow_models(self.pack, self.info, sink)["slots"]
            self.assertEqual((slot["node"], slot["input"]), (kind + "Custom", "weights"))
            result = workflow_models(self.pack, self.info, sink, {slot["id"]: "b.gguf"})
            compiled = apply_values(result["document"], result["values"])
            self.assertEqual(compiled[kind + "Custom"]["inputs"]["weights"], "b.gguf")
            self.assertEqual(self.pack["prompt"][kind + "Custom"]["inputs"]["weights"], "a.gguf")

    def test_refresh_rejects_removed_options_and_foreign_slots(self):
        slot, = workflow_models(self.pack, self.info, "ExportVIDEO")["slots"]
        self.info["VIDEOCustom"]["input"]["required"]["weights"] = [["next.gguf"]]
        for values in ({slot["id"]: "a.gguf"}, {"foreign": "next.gguf"}, {}):
            with self.assertRaises(ValueError):
                workflow_models(self.pack, self.info, "ExportVIDEO", values)
        result = workflow_models(self.pack, self.info, "ExportVIDEO", {slot["id"]: "next.gguf"})
        self.assertEqual(result["document"]["fields"][0]["default"], "next.gguf")

    def test_author_identity_and_large_modern_combo(self):
        pack = copy.deepcopy(self.pack)
        pack["fields"] = [{"id": "author", "label": "声音模型", "node_id": "AUDIOCustom", "input": "weights",
                           "type": "text", "default": "a.gguf"}]
        opts = [str(n) + ".gguf" for n in range(800)]
        self.info["AUDIOCustom"]["input"]["required"]["weights"] = ["COMBO", {"options": opts}]
        slot, = workflow_models(pack, self.info, "ExportAUDIO")["slots"]
        self.assertEqual((slot["id"], slot["options"]), ("author", opts))
        result = workflow_models(pack, self.info, "ExportAUDIO", {"author": opts[-1]})
        self.assertEqual(result["values"]["author"], opts[-1])
