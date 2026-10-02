"""Carrier conflict checks also protect the compiler's direct library callers."""
import copy
import unittest

from frameweave.workflows import api_carriers_equal, compile_workflow


class ApiCarrierTests(unittest.TestCase):
    info = {"Example": {"input": {"required": {"value": ["INT", {"min": 0}]}},
                        "output": [], "output_node": True}}
    prompt = {"prompt": {"class_type": "Example", "inputs": {"value": 1}},
              "workflow": {"class_type": "Example", "inputs": {"value": 2}}}

    def test_graph_node_ids_are_not_carriers_and_originals_remain(self):
        before = copy.deepcopy(self.prompt)
        for request in ({"kind": "api", "prompt": self.prompt},
                        {"kind": "api", "workflow": {"prompt": self.prompt}}):
            self.assertEqual(compile_workflow(request, self.info)["prompt"], self.prompt)
        self.assertEqual(before, self.prompt)

    def test_equal_carriers_accept_order_difference_conflicts_reject(self):
        reversed_graph = dict(reversed(list(self.prompt.items())))
        result = compile_workflow({"kind": "api", "prompt": self.prompt,
                                   "workflow": reversed_graph}, self.info)
        self.assertEqual(result["prompt"], self.prompt)
        changed = copy.deepcopy(self.prompt)
        changed["prompt"]["inputs"]["value"] = True
        for request in ({"kind": "api", "prompt": self.prompt, "workflow": changed},
                        {"kind": "api", "workflow": {"prompt": self.prompt, "workflow": changed}}):
            with self.assertRaisesRegex(ValueError, "不同的 prompt 和 workflow"):
                compile_workflow(request, self.info)

    def test_numeric_json_spelling_is_equal_but_boolean_is_not(self):
        self.assertTrue(api_carriers_equal({"value": 1}, {"value": 1.0}))
        self.assertFalse(api_carriers_equal({"value": 1}, {"value": True}))
        info = {"Example": {"input": {"required": {"value": ["FLOAT", {}]}}, "output": []}}
        first = {"1": {"class_type": "Example", "inputs": {"value": 1}}}
        second = {"1": {"inputs": {"value": 1.0}, "class_type": "Example"}}
        self.assertEqual(compile_workflow({"kind": "api", "prompt": first, "workflow": second}, info)["prompt"], first)


if __name__ == "__main__":
    unittest.main()
