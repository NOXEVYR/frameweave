"""Complete canvas snapshots retain large interfaces under bounded budgets."""
import copy
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from frameweave.canvas_store import CanvasStore, LIMIT, MAX_CANVAS_ITEMS
from frameweave.packages import normalize_document


def bundle():
    return {"schema": "prismcanvas.project.v1", "version": 1, "name": "Budget",
            "canvas": {"nodes": [], "edges": []}, "packages": [], "padding": []}


def item_count(document):
    pending, items = [document], 0
    while pending:
        value = pending.pop()
        items += 1
        if isinstance(value, dict):
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    return items


class CanvasCapacityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "canvases"
        self.store = CanvasStore(self.root)

    @unittest.skipUnless(shutil.which("node"), "Cross-layer fixture requires Node.js")
    def test_real_configuration_two_and_eight_4096_parameter_nodes_roundtrip(self):
        script = r"""
import {createNode,serializeGraph} from './web/graph.mjs';
import {configurationBundle} from './web/workflow-configurations.mjs';
const fields=Array.from({length:4096},(_,i)=>({id:`f${i}`,label:`Parameter ${i}`,type:'integer',
  presentation:'control',role:'settings',group:'Parameters',node_id:String(Math.floor(i/512)),input:`value_${i}`,default:i}));
const prompt={};for(const f of fields){prompt[f.node_id]??={class_type:`Bulk${f.node_id}`,inputs:{}};prompt[f.node_id].inputs[f.input]=f.default;}
const id='p-0123456789abcdef01234567',editor_id=`e-${'a'.repeat(24)}`;
const values=Object.fromEntries(fields.map(f=>[f.id,f.default]));
const node=createNode('generation',0,0,{kind:'package',package_id:id,editor_id,
  editor_backend:'http://127.0.0.1:8188',packageFields:fields,packageValues:values,
  editor_baseline:structuredClone(values),editor_controls:fields.map(f=>({node_id:f.node_id,
  input:f.input,widget_node_id:f.node_id,widget_name:f.input}))});
const source={canvas:JSON.parse(serializeGraph({nodes:[node],edges:[]})),
  packages:[{id,source_json:JSON.stringify({name:'Bulk',prompt,fields})}],
  editors:[{id:editor_id,name:'Native source',source_json:JSON.stringify({nodes:[],links:[]})}]};
console.log(JSON.stringify(configurationBundle(source,node.id,'4096 controls')));
"""
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                                cwd=Path(__file__).resolve().parents[1], capture_output=True,
                                text=True, encoding="utf-8", check=True, timeout=30)
        configuration = json.loads(result.stdout)
        raw = configuration["packages"][0]["source_json"]
        self.assertEqual(len(normalize_document(json.loads(raw))["fields"]), 4096)
        for count in (2, 8):
            with self.subTest(nodes=count):
                document = copy.deepcopy(configuration)
                document["canvas"]["nodes"] = []
                for index in range(count):
                    node = copy.deepcopy(configuration["canvas"]["nodes"][0])
                    node["id"] = f"node-{index}"
                    document["canvas"]["nodes"].append(node)
                self.assertGreater(item_count(document), 100000)
                self.assertLess(item_count(document), MAX_CANVAS_ITEMS)
                saved = self.store.save(document)
                restored = self.store.get(saved["id"])["document"]
                self.assertEqual(restored, document)
                self.assertEqual(restored["packages"][0]["source_json"], raw)
                self.assertTrue(all(len(n["data"]["packageFields"]) == 4096
                                    for n in restored["canvas"]["nodes"]))

    def test_exact_item_budget_roundtrips_and_plus_one_is_rejected_without_write(self):
        document = bundle()
        document["padding"] = [None] * (MAX_CANVAS_ITEMS - item_count(document))
        self.assertEqual(item_count(document), MAX_CANVAS_ITEMS)
        saved = self.store.save(document)
        self.assertEqual(self.store.get(saved["id"])["document"], document)
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        document["padding"].append(None)
        with self.assertRaisesRegex(ValueError, "500000.*拆分"):
            self.store.save(document)
        self.assertEqual({p.name: p.read_bytes() for p in self.root.iterdir()}, before)

    def test_depth_cycle_and_bytes_stay_bounded_without_creating_files(self):
        deep = bundle()
        value = deep
        for _ in range(65):
            value["nested"] = {}
            value = value["nested"]
        exact_depth = bundle()
        value = exact_depth
        for _ in range(64):
            value["nested"] = {}
            value = value["nested"]
        self.store._validate(exact_depth)
        cyclic = bundle()
        cyclic["cycle"] = cyclic
        huge = bundle()
        huge["padding"] = "x" * LIMIT
        for document, message in ((deep, "64.*拆分"), (cyclic, "有效的 JSON"), (huge, "24 MiB")):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                self.store.save(document)
        self.assertFalse(self.root.exists())

    def test_other_canvas_caps_are_unchanged(self):
        for name, amount in (("nodes", 501), ("edges", 2001), ("packages", 201)):
            document = bundle()
            if name == "packages":
                document[name] = [{} for _ in range(amount)]
            else:
                document["canvas"][name] = [{} for _ in range(amount)]
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.store.save(document)
        self.assertFalse(self.root.exists())


if __name__ == "__main__":
    unittest.main()
