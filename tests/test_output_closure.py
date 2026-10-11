"""A selected output controls execution requirements, never stored source data."""
import copy
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest

from frameweave.editor_interfaces import inspect_interface, output_closure, select_outputs
from frameweave.packages import PackageStore, api_prompt, apply_values, normalize_prompt
from frameweave.server import App
import test_editor_integration as native_tests
import test_mcp_http as mcp_tests


def schema():
    return {
        "LoadImage": {"input": {"required": {"image": [["ready.png"], {"image_upload": True}]}},
                      "output": ["IMAGE", "MASK"], "output_node": False},
        "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING"]}},
                      "output": [], "output_node": True},
        "PassImage": {"input": {"required": {"image": ["IMAGE"]}},
                      "output": ["IMAGE"], "output_node": False},
        "UnusedSource": {"input": {"required": {"width": ["INT", {"min": 1, "max": 64}]}},
                         "output": ["IMAGE"], "output_node": False},
    }


def graph(a="ready.png", b=""):
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": a}, "_meta": {"title": "A"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": b}, "_meta": {"title": "B"}},
        "3": {"class_type": "SaveImage", "inputs": {"images": ["1", 0], "filename_prefix": "branch-A"}},
        "4": {"class_type": "SaveImage", "inputs": {"images": ["2", 0], "filename_prefix": "branch-B"}},
    }


def package_draft(prompt):
    return {"name": "Two independent branches", "prompt": prompt, "fields": [
        {"id": "a", "node_id": "1", "input": "image", "label": "A", "type": "image"},
        {"id": "b", "node_id": "2", "input": "image", "label": "B", "type": "image"},
    ]}


class OutputClosureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = object.__new__(App)
        self.app.lock = threading.RLock()
        self.app.packages = PackageStore(Path(self.temp.name) / "packages")
        self.info = schema()
        self.app.object_info = lambda refresh=False: self.info
        self.app.backend = SimpleNamespace(url="http://127.0.0.1:8188")

    def test_required_media_matrix_and_switching_outputs_do_not_change_package(self):
        package = self.app.packages.save(package_draft(graph()))
        before = self.app.packages.export(package["id"])
        for values, outputs, expected in [
            ({"a": "ready.png"}, ["3"], {"1", "3"}),
            ({"a": "ready.png"}, ["3", "4"], None),
            ({"b": "ready.png"}, ["3"], None),
            ({"a": "ready.png", "b": "ready.png"}, ["3", "4"], {"1", "2", "3", "4"}),
            ({"a": "ready.png"}, ["4"], None),
            ({"b": "ready.png"}, ["4"], {"2", "4"}),
            ({"a": "ready.png"}, None, None),
        ]:
            with self.subTest(values=values, outputs=outputs):
                request = {"kind": "package", "package_id": package["id"], "values": values}
                if outputs is not None:
                    request["output_nodes"] = outputs
                if expected is None:
                    with self.assertRaises(ValueError):
                        self.app.compile(request)
                else:
                    result = self.app.compile(request)
                    self.assertEqual(set(result["prompt"]), expected)
                    execution = result["summary"]["execution"]
                    self.assertEqual(execution["selected_outputs"], outputs)
                    self.assertEqual(set(execution["node_ids"]), expected)
                    self.assertEqual(set(execution["ignored_node_ids"]), set(package["prompt"]) - expected)
                self.assertEqual(self.app.packages.export(package["id"]), before)

    def test_ignored_fields_still_validate_ids_types_and_safe_paths(self):
        package = self.app.packages.save(package_draft(graph()))
        for values in [{"a": "ready.png", "b": "../secret.png"},
                       {"a": "ready.png", "b": 42}, {"a": "ready.png", "forged": ""}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.app.resolve_request({"kind": "package", "package_id": package["id"],
                                          "values": values, "output_nodes": ["3"]})
        with self.assertRaises(ValueError):
            apply_values(package, {"a": "ready.png"}, active_nodes={"forged"})

    def test_inactive_required_text_is_deferred_but_enum_and_range_checks_remain(self):
        self.info['TextImage'] = {
            'input': {'required': {'text': ['STRING'], 'size': ['INT', {'min': 1, 'max': 64}],
                                    'mode': [['one', 'two']]}},
            'output': ['IMAGE'], 'output_node': False}
        prompt = graph()
        prompt['2'] = {'class_type': 'TextImage', 'inputs': {'text': '', 'size': 32, 'mode': 'one'}}
        draft = package_draft(prompt)
        draft['fields'][1] = {'id': 'b', 'node_id': '2', 'input': 'text', 'label': 'B',
                              'type': 'text', 'required': True}
        draft['fields'] += [
            {'id': 'size', 'node_id': '2', 'input': 'size', 'label': 'Size',
             'type': 'integer', 'min': 1, 'max': 64},
            {'id': 'mode', 'node_id': '2', 'input': 'mode', 'label': 'Mode',
             'type': 'select', 'options': ['one', 'two']}]
        package = self.app.packages.save(draft)
        request = {'kind': 'package', 'package_id': package['id'], 'output_nodes': ['3']}
        self.assertEqual(set(self.app.compile({**request, 'values': {'a': 'ready.png'}})['prompt']), {'1', '3'})
        for values in [{'a': 'ready.png', 'size': 65}, {'a': 'ready.png', 'size': True},
                       {'a': 'ready.png', 'mode': 'forged'}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.app.compile({**request, 'values': values})
        with self.assertRaises(ValueError):
            self.app.compile({**request, 'values': {'a': 'ready.png'}, 'output_nodes': ['4']})

    def test_inactive_nodes_do_not_bypass_json_and_node_shape_limits(self):
        for node_id, node in [
            ('__proto__', {'class_type': 'UnusedSource', 'inputs': {}}),
            ('island', {'class_type': '', 'inputs': {}}),
            ('island', {'class_type': 'UnusedSource', 'inputs': {'constructor': 1}}),
            ('island', {'class_type': 'UnusedSource', 'inputs': {'width': float('nan')}}),
        ]:
            prompt = graph(); prompt[node_id] = node
            with self.subTest(node=node), self.assertRaises(ValueError):
                output_closure(prompt, ['3'], self.info)

    def test_unfinished_unknown_and_malformed_dependency_islands_stay_in_source(self):
        prompt = graph()
        prompt.update({
            "unfinished": {"class_type": "UnusedSource", "inputs": {}},
            "unknown": {"class_type": "NotInstalled", "inputs": {"literal": "keep"}},
            "broken": {"class_type": "PassImage", "inputs": {"image": ["missing", 0]}},
            "cycle1": {"class_type": "PassImage", "inputs": {"image": ["cycle2", 0]}},
            "cycle2": {"class_type": "PassImage", "inputs": {"image": ["cycle1", 0]}},
            "slot": {"class_type": "PassImage", "inputs": {"image": ["1", 99]}},
        })
        before = copy.deepcopy(prompt)
        result = self.app.apply_interface(prompt, {"output_nodes": ["3"]}, "Complete source")
        self.assertEqual(result["_compiled_prompt"], before)
        self.assertEqual(set(result["package"]["prompt"]), set(before))
        self.assertEqual(prompt, before)
        self.assertTrue(any(w["code"] == "inactive_unknown_node" for w in result["warnings"]))
        self.assertNotIn("unfinished", result["execution"]["node_ids"])
        for node in ["unfinished", "unknown", "broken", "cycle1", "slot"]:
            bad = copy.deepcopy(prompt)
            bad["3"]["inputs"]["images"] = [node, 0]
            with self.subTest(node=node), self.assertRaises(ValueError):
                self.app.resolve_request({"kind": "api", "prompt": bad, "output_nodes": ["3"]})

    def test_active_schema_errors_and_invalid_output_selection_are_rejected(self):
        for outputs in [[], ["3", "3"], ["missing"], ["1"], "3", [3]]:
            with self.subTest(outputs=outputs), self.assertRaises(ValueError):
                output_closure(graph(), outputs, self.info)
        for mutation in [lambda p: p["3"]["inputs"].pop("images"),
                         lambda p: p["3"]["inputs"].update(images=["1", 1]),
                         lambda p: p["3"]["inputs"].update(images=["1", -1]),
                         lambda p: p["3"]["inputs"].update(images=["missing", 0]),
                         lambda p: p["3"]["inputs"].update(filename_prefix=3),
                         lambda p: p["3"]["inputs"].update(unknown=3)]:
            bad = graph(); mutation(bad)
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.app.resolve_request({"kind": "api", "prompt": bad, "output_nodes": ["3"]})

    def test_default_output_roots_and_no_output_diagnostics_never_guess_terminals(self):
        execution = output_closure(graph(), None, self.info)
        self.assertEqual(execution["selected_outputs"], ["3", "4"])
        no_outputs = {"1": graph()["1"]}
        inspection = inspect_interface(no_outputs, self.info)
        self.assertEqual(inspection["execution"]["selected_outputs"], [])
        self.assertTrue(any(w["code"] == "no_output_nodes" for w in inspection["warnings"]))
        with self.assertRaises(ValueError):
            self.app.compile({"kind": "api", "prompt": no_outputs})
        with self.assertRaises(ValueError):
            self.app.apply_interface(no_outputs, {}, "No output")

    def test_native_full_document_is_not_pruned_and_api_carrier_node_ids_are_legal(self):
        prompt = graph()
        renamed = {"prompt": prompt["1"], "workflow": prompt["3"]}
        renamed["workflow"]["inputs"]["images"] = ["prompt", 0]
        self.assertIs(api_prompt(renamed), renamed)
        result = self.app.compile({"kind": "api", "workflow": {"prompt": renamed}})
        self.assertEqual(set(result["prompt"]), {"prompt", "workflow"})
        self.assertEqual(api_prompt({"prompt": prompt, "workflow": copy.deepcopy(prompt)}), prompt)
        floating = copy.deepcopy(prompt)
        prompt['3']['inputs']['size'] = 1
        floating['3']['inputs']['size'] = 1.0
        self.assertEqual(api_prompt({'prompt': prompt, 'workflow': floating}), prompt)
        floating['3']['inputs']['size'] = True
        with self.assertRaises(ValueError):
            api_prompt({'prompt': prompt, 'workflow': floating})
        conflicting = copy.deepcopy(prompt); conflicting["3"]["inputs"]["filename_prefix"] = "changed"
        with self.assertRaises(ValueError):
            api_prompt({"prompt": prompt, "workflow": conflicting})
        self.assertEqual(select_outputs(prompt, None, self.info), prompt)


class OutputClosureHTTPTests(unittest.TestCase):
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post
    import_document = native_tests.EditorIntegrationTests.import_document

    def setUp(self):
        native_tests.EditorIntegrationTests.setUp(self)
        self.backend.info = schema()

    def test_interface_apply_compile_and_output_switch_keep_complete_source(self):
        prompt = graph()
        prompt["island"] = {"class_type": "UnusedSource", "inputs": {}}
        status, _, inspected = self.post('/api/interfaces/inspect', {
            "document": {"prompt": prompt}, "output_nodes": ["3"]})
        self.assertEqual(status, 200, inspected)
        status, _, applied = self.post('/api/interfaces/apply', {
            "prompt": prompt, "fields": inspected["fields"], "output_nodes": ["3"],
            "backend_url": self.backend.url, "name": "Both branches"})
        self.assertEqual(status, 200, applied)
        self.assertEqual(applied["readiness"]["status"], "unverified")
        package = applied["package"]
        self.assertEqual(set(package["prompt"]), set(prompt))
        values = applied["values"]
        request = {"kind": "package", "package_id": package["id"], "values": values}
        status, _, compiled = self.post('/api/compile', {**request, "output_nodes": ["3"]})
        self.assertEqual(status, 200, compiled)
        self.assertEqual(set(compiled["prompt"]), {"1", "3"})
        self.assertEqual(compiled["summary"]["execution"]["ignored_node_ids"], ["2", "4", "island"])
        for outputs in [["4"], ["3", "4"]]:
            status, _, rejected = self.post('/api/compile', {**request, "output_nodes": outputs})
            self.assertEqual(status, 400, rejected)
        field_b = next(f for f in package["fields"] if f["node_id"] == "2")
        values[field_b["id"]] = "ready.png"
        status, _, both = self.post('/api/compile', {**request, "output_nodes": ["3", "4"]})
        self.assertEqual(status, 200, both)
        self.assertEqual(set(both["prompt"]), {"1", "2", "3", "4"})
        for path in ['/api/interfaces/inspect', '/api/interfaces/apply', '/api/packages/inspect']:
            self.assertEqual(self.post(path, {}, csrf=False)[0], 403)
        self.assertFalse(any(call[:2] == ("POST", "/prompt") for call in self.backend.calls))

    def test_native_apply_retains_editor_document_and_entire_compiled_source(self):
        document = native_tests.editor_document()
        status, _, imported = self.import_document(document=document)
        self.assertEqual(status, 200, imported)
        ident = imported['id']
        status, _, session = self.post(f'/api/editor-workflows/{ident}/session')
        self.assertEqual(status, 200, session)
        prompt = graph()
        prompt['unfinished'] = {'class_type': 'NotInstalled', 'inputs': {'data': 'keep'}}
        status, _, applied = self.post(f'/api/editor-workflows/{ident}/apply', {
            'session_id': session['session_id'], 'document': document,
            'prompt': prompt, 'output_nodes': ['3']})
        self.assertEqual(status, 200, applied)
        revision = self.app.editor_workflows.get(ident)
        self.assertEqual(revision['document'], document)
        self.assertEqual(self.app.editor_workflows.get_compiled(ident)['prompt'],
                         normalize_prompt(prompt, check_dependencies=False))
        self.assertEqual(set(applied['package']['prompt']), set(prompt))
        self.assertEqual(applied['execution']['node_ids'], ['1', '3'])

    def test_native_unselected_broken_and_cyclic_islands_roundtrip_but_cannot_run(self):
        document = native_tests.editor_document()
        status, _, imported = self.import_document(document=document)
        self.assertEqual(status, 200, imported)
        ident = imported['id']
        for island in [
            {'class_type': 'PassImage', 'inputs': {'image': ['absent', 0]}},
            {'class_type': 'PassImage', 'inputs': {'image': ['island', 0]}},
        ]:
            with self.subTest(island=island):
                status, _, session = self.post(f'/api/editor-workflows/{ident}/session')
                self.assertEqual(status, 200, session)
                prompt = graph()
                prompt['island'] = island
                prompt['5'] = {'class_type': 'SaveImage', 'inputs': {
                    'images': ['island', 0], 'filename_prefix': 'unfinished'}}
                status, _, applied = self.post(f'/api/editor-workflows/{ident}/apply', {
                    'session_id': session['session_id'], 'document': document,
                    'prompt': prompt, 'output_nodes': ['3']})
                self.assertEqual(status, 200, applied)
                self.assertEqual(self.app.editor_workflows.get(ident)['document'], document)
                self.assertEqual(self.app.editor_workflows.get_compiled(ident)['prompt'],
                                 normalize_prompt(prompt, check_dependencies=False))
                request = {'kind': 'package', 'package_id': applied['package']['id'],
                           'values': applied['values'], 'output_nodes': ['3']}
                status, _, compiled = self.post('/api/compile', request)
                self.assertEqual(status, 200, compiled)
                self.assertEqual(set(compiled['prompt']), {'1', '3'})
                self.assertEqual(self.post('/api/compile', {**request, 'output_nodes': ['5']})[0], 400)
        self.assertFalse(any(call[:2] == ('POST', '/prompt') for call in self.backend.calls))


class OutputClosureMCPTests(unittest.TestCase):
    stop = mcp_tests.MCPHTTPTests.stop
    request = mcp_tests.MCPHTTPTests.request
    rpc = mcp_tests.MCPHTTPTests.rpc
    tool = mcp_tests.MCPHTTPTests.tool

    def setUp(self):
        mcp_tests.MCPHTTPTests.setUp(self)
        self.backend.info = schema()

    def test_package_inspection_and_compile_match_http_with_selected_closure(self):
        prompt = graph()
        prompt['island'] = {"class_type": "NotInstalled", "inputs": {}}
        args = {"source_json": json.dumps({"prompt": prompt}), "output_nodes": ["3"]}
        inspected = self.tool('fw_package_inspect', args)
        self.assertFalse(inspected['isError'], inspected)
        http_headers = {"X-FW-Token": self.app.csrf}
        status, _, http_result = self.request(args, path='/api/packages/inspect', headers=http_headers)
        self.assertEqual(status, 200, http_result)
        self.assertEqual(inspected['structuredContent'], http_result)
        draft = inspected['structuredContent']
        imported = self.tool('fw_package_import', {"document": draft})
        self.assertFalse(imported['isError'], imported)
        package = imported['structuredContent']
        field_a = next(f for f in package['fields'] if f['node_id'] == '1')
        request = {"kind": "package", "package_id": package['id'],
                   "values": {field_a['id']: 'ready.png'}, "output_nodes": ['3']}
        compiled = self.tool('fw_compile', {'request': request})
        self.assertFalse(compiled['isError'], compiled)
        status, _, http_compiled = self.request(request, path='/api/compile', headers=http_headers)
        self.assertEqual(status, 200, http_compiled)
        self.assertEqual(compiled['structuredContent'], http_compiled)
        self.assertEqual(set(http_compiled['prompt']), {'1', '3'})
        self.assertFalse(any(call[:2] == ('POST', '/prompt') for call in self.backend.calls))
