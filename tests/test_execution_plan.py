"""Live package execution plans are scope evidence, never submission readiness."""
import copy
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from frameweave.packages import PackageStore, apply_planning_values, apply_values
from frameweave.server import App
import test_editor_integration as native_tests
from test_output_closure import graph, package_draft, schema


def draft():
    package = package_draft(graph())
    package['prompt']['3']['inputs'].update(filename_prefix='', size=32, mode='one', enabled=False)
    package['prompt']['4']['inputs'].update(size=32, mode='one', enabled=False)
    package['fields'] += [
        {'id': 'prefix', 'node_id': '3', 'input': 'filename_prefix', 'label': 'Prefix',
         'type': 'text', 'required': True},
        {'id': 'size', 'node_id': '3', 'input': 'size', 'label': 'Size',
         'type': 'integer', 'min': 1, 'max': 64},
        {'id': 'mode', 'node_id': '3', 'input': 'mode', 'label': 'Mode',
         'type': 'select', 'options': ['one', 'two']},
        {'id': 'enabled', 'node_id': '3', 'input': 'enabled', 'label': 'Enabled', 'type': 'boolean'},
    ]
    return package


def live_schema():
    info = schema()
    info['SaveImage']['input']['required'].update(
        size=['INT', {'min': 1, 'max': 64}], mode=[['one', 'two']], enabled=['BOOLEAN'])
    return info


class ExecutionPlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = object.__new__(App)
        self.app.lock = threading.RLock()
        self.app.packages = PackageStore(Path(self.temp.name) / 'packages')
        self.info = live_schema()
        self.schema_calls = []

        def request(path, **kwargs):
            self.schema_calls.append(path)
            return copy.deepcopy(self.info)

        self.app.backend = SimpleNamespace(url='http://127.0.0.1:8188', request=request)
        self.app.object_info = lambda refresh=False: self.info
        self.package = self.app.packages.save(draft())

    def payload(self, values=None, outputs=None):
        request = {'kind': 'package', 'package_id': self.package['id'], 'values': values or {}}
        if outputs is not None:
            request['output_nodes'] = outputs
        return {'backend_url': self.app.backend.url, 'request': request}

    def test_output_matrix_freezes_all_live_outputs_and_authoritative_fields(self):
        original = self.app.packages.export(self.package['id'])
        for outputs, nodes, fields in [
            (['3'], ['1', '3'], ['a', 'prefix', 'size', 'mode', 'enabled']),
            (['4'], ['2', '4'], ['b']),
            (None, ['1', '2', '3', '4'], ['a', 'b', 'prefix', 'size', 'mode', 'enabled']),
        ]:
            with self.subTest(outputs=outputs):
                result = self.app.execution_plan(self.payload(outputs=outputs))
                self.assertEqual(result['package_id'], self.package['id'])
                self.assertEqual(result['backend_url'], self.app.backend.url)
                self.assertEqual(result['execution']['selected_outputs'], outputs or ['3', '4'])
                self.assertEqual(result['execution']['node_ids'], nodes)
                self.assertEqual(result['execution']['active_field_ids'], fields)
                self.assertEqual(self.app.packages.export(self.package['id']), original)
        self.assertEqual(self.schema_calls, ['/object_info'] * 3)

    def test_empty_required_text_and_media_defer_but_compile_stays_strict(self):
        payload = self.payload(outputs=['3'])
        self.app.execution_plan(payload)
        with self.assertRaises(ValueError):
            self.app.compile(payload['request'])
        payload['request']['values'] = {'a': 'ready.png', 'prefix': 'branch-A'}
        plan = self.app.execution_plan(payload)
        compiled = self.app.compile(payload['request'])
        self.assertEqual(compiled['summary']['execution'], plan['execution'])
        self.assertEqual(set(compiled['prompt']), {'1', '3'})

    def test_inactive_data_boundaries_remain_strict(self):
        for values in [{'a': '../escape.png'}, {'a': 42}, {'a': None}, {'a': False},
                       {'prefix': []}, {'size': 65}, {'size': 0}, {'size': True},
                       {'size': ''}, {'mode': 'forged'}, {'enabled': 0}, {'forged': ''},
                       {'size': float('nan')}, {'prefix': 'x' * 64001}]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.app.execution_plan(self.payload(values, ['4']))
        self.app.execution_plan(self.payload({'enabled': False}, ['4']))

    def test_live_schema_boundaries_and_media_options_remain_strict(self):
        for change, values in [
            (lambda info: None, {'a': 'not-uploaded.png'}),
            (lambda info: info['SaveImage']['input']['required'].update(mode=[['two']]), {'mode': 'one'}),
            (lambda info: info['SaveImage']['input']['required'].update(size=['INT', {'max': 31}]), {}),
            (lambda info: info['SaveImage']['input']['required'].update(filename_prefix=['INT']), {}),
            (lambda info: info['LoadImage']['input']['required'].update(image=[['ready.png'], {'image_upload': False}]), {}),
        ]:
            self.info = live_schema()
            change(self.info)
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.app.execution_plan(self.payload(values, ['3']))

    def test_live_enum_type_drift_cannot_treat_boolean_as_integer(self):
        source = draft()
        source['prompt']['3']['inputs']['mode'] = False
        next(field for field in source['fields'] if field['id'] == 'mode')['options'] = [False]
        self.package = self.app.packages.save(source)
        self.info['SaveImage']['input']['required']['mode'] = [[0]]
        with self.assertRaisesRegex(ValueError, '当前后端可选值'):
            self.app.execution_plan(self.payload(outputs=['3']))

    def test_invalid_outputs_and_no_declared_outputs_are_rejected(self):
        for outputs in [[], ['3', '3'], ['missing'], ['1'], '3', [3]]:
            with self.subTest(outputs=outputs), self.assertRaises(ValueError):
                self.app.execution_plan(self.payload(outputs=outputs))
        self.info['SaveImage']['output_node'] = False
        with self.assertRaises(ValueError):
            self.app.execution_plan(self.payload())

    def test_inactive_unknown_and_broken_islands_preserve_source(self):
        source = draft()
        source['prompt'].update(
            unknown={'class_type': 'NotInstalled', 'inputs': {}},
            broken={'class_type': 'PassImage', 'inputs': {'image': ['missing', 0]}},
            cycle={'class_type': 'PassImage', 'inputs': {'image': ['cycle', 0]}})
        self.package = self.app.packages.save(source)
        original = self.app.packages.export(self.package['id'])
        execution = self.app.execution_plan(self.payload(outputs=['3']))['execution']
        self.assertTrue({'unknown', 'broken', 'cycle'} <= set(execution['ignored_node_ids']))
        self.assertTrue(any(w['code'] == 'inactive_unknown_node' for w in execution['warnings']))
        self.assertEqual(self.app.packages.export(self.package['id']), original)
        for source_id in ['unknown', 'broken', 'cycle']:
            invalid = copy.deepcopy(source)
            invalid['prompt']['3']['inputs']['images'] = [source_id, 0]
            self.package = self.app.packages.save(invalid)
            with self.subTest(source_id=source_id), self.assertRaises(ValueError):
                self.app.execution_plan(self.payload(outputs=['3']))

    def test_active_dependency_slot_and_type_errors_are_rejected(self):
        for source_id, slot in [('1', 99), ('1', 1), ('missing', 0)]:
            source = draft()
            source['prompt']['3']['inputs']['images'] = [source_id, slot]
            self.package = self.app.packages.save(source)
            with self.subTest(slot=slot), self.assertRaises(ValueError):
                self.app.execution_plan(self.payload(outputs=['3']))

    def test_backend_expected_url_and_object_identity_are_guarded(self):
        payload = self.payload(outputs=['3'])
        with self.assertRaises(ValueError):
            self.app.execution_plan({**payload, 'backend_url': 'http://127.0.0.1:8189'})
        self.assertEqual(self.schema_calls, [])
        payload['backend_url'] = 'http://localhost:8188/'
        self.assertEqual(self.app.execution_plan(payload)['backend_url'], 'http://127.0.0.1:8188')
        captured = self.app.backend

        def switched(backend):
            self.assertIs(backend, captured)
            self.app.backend = SimpleNamespace(url=captured.url)
            return self.info

        with patch.object(self.app, '_object_info_for_backend', side_effect=switched):
            with self.assertRaisesRegex(ValueError, '已变化'):
                self.app.execution_plan(payload)

    def test_same_backend_url_mutation_during_plan_is_guarded(self):
        payload = self.payload(outputs=['3'])

        def moved(backend):
            backend.url = 'http://127.0.0.1:8189'
            return self.info

        with patch.object(self.app, '_object_info_for_backend', side_effect=moved):
            with self.assertRaisesRegex(ValueError, '已变化'):
                self.app.execution_plan(payload)

    def test_plan_never_saves_submits_uploads_or_creates_request_ids(self):
        payload = self.payload(outputs=['3'])
        before = {p.name: p.read_bytes() for p in self.app.packages.directory.iterdir()}
        with (patch.object(self.app.packages, 'save', side_effect=AssertionError('save')),
              patch.object(self.app, 'submit', side_effect=AssertionError('submit')),
              patch.object(self.app, 'upload', side_effect=AssertionError('upload')),
              patch('frameweave.server.uuid.uuid4', side_effect=AssertionError('request id'))):
            self.app.execution_plan(payload)
            with self.assertRaises(ValueError):
                self.app.execution_plan(self.payload({'a': '../escape'}, ['3']))
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.app.packages.directory.iterdir()})
        self.assertEqual(self.schema_calls, ['/object_info', '/object_info'])

    def test_untrusted_client_scope_and_wrong_request_kinds_are_rejected(self):
        for mutation in [{'active_field_ids': ['a']}, {'kind': 'api'}, {'kind': None},
                         {'editor_backend': 'http://127.0.0.1:8189'}]:
            payload = self.payload(outputs=['3'])
            payload['request'].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.app.execution_plan(payload)
        for payload in [{}, {'request': {}}, {'backend_url': self.app.backend.url, 'request': []},
                        {**self.payload(), 'active_nodes': ['1']}]:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.app.execution_plan(payload)

    def test_dynamic_fields_use_current_values_and_never_silently_disappear(self):
        source = draft()
        source['prompt']['3']['inputs'].update(format='a', **{'format.note': ''})
        source['fields'] += [
            {'id': 'format', 'node_id': '3', 'input': 'format', 'label': 'Format',
             'type': 'select', 'options': ['a', 'b']},
            {'id': 'note', 'node_id': '3', 'input': 'format.note', 'label': 'Note',
             'type': 'text', 'required': True},
        ]
        self.info['SaveImage']['input']['required']['format'] = ['COMFY_DYNAMICCOMBO_V3', {'options': [
            {'key': 'a', 'inputs': {'required': {'note': ['STRING']}}},
            {'key': 'b', 'inputs': {'required': {'note': ['INT']}}},
        ]}]
        self.package = self.app.packages.save(source)
        plan = self.app.execution_plan(self.payload({'format': 'a'}, ['3']))
        self.assertIn('note', plan['execution']['active_field_ids'])
        with self.assertRaisesRegex(ValueError, 'note'):
            self.app.execution_plan(self.payload({'format': 'b'}, ['3']))
        self.info['SaveImage']['input']['required']['format'][1]['options'][1]['inputs'] = {}
        with self.assertRaisesRegex(ValueError, '动态输入接口'):
            self.app.execution_plan(self.payload({'format': 'b'}, ['3']))

    def test_planning_value_helper_keeps_optional_empty_media_and_original_source(self):
        source = draft()
        source['fields'][0]['required'] = False
        before = copy.deepcopy(source)
        prompt = apply_planning_values(source, {})
        self.assertEqual(prompt['1']['inputs']['image'], '')
        self.assertEqual(source, before)
        self.assertNotIn('image', apply_values(source, {'prefix': 'A', 'b': 'ready.png'})['1']['inputs'])

    def test_64_and_65_fields_remain_complete_in_execution_plans(self):
        source = package_draft(graph())
        for index in range(62):
            name = 'text_' + str(index)
            source['prompt']['3']['inputs'][name] = ''
            self.info['SaveImage']['input']['optional'] = self.info['SaveImage']['input'].get('optional', {})
            self.info['SaveImage']['input']['optional'][name] = ['STRING']
            source['fields'].append({'id': name, 'node_id': '3', 'input': name,
                                     'label': name, 'type': 'text', 'required': True})
        # The standard sink still has its full live required scalar contract.
        for node_id in ['3', '4']:
            source['prompt'][node_id]['inputs'].update(size=32, mode='one', enabled=False)
        self.package = self.app.packages.save(source)
        plan = self.app.execution_plan(self.payload(outputs=['3']))
        self.assertEqual(len(self.package['fields']), 64)
        self.assertEqual(len(plan['execution']['active_field_ids']), 63)
        source['prompt']['3']['inputs']['overflow'] = ''
        source['fields'].append({'id': 'overflow', 'node_id': '3', 'input': 'overflow',
                                 'label': 'Overflow', 'type': 'text'})
        self.info['SaveImage']['input']['optional']['overflow'] = ['STRING']
        self.package = self.app.packages.save(source)
        plan = self.app.execution_plan(self.payload(outputs=['3']))
        self.assertEqual(len(self.package['fields']), 65)
        self.assertEqual(len(plan['execution']['active_field_ids']), 64)


class ExecutionPlanHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def test_http_contract_csrf_live_schema_and_no_durable_side_effects(self):
        self.backend.info = live_schema()
        package = self.app.packages.save(draft())
        before = self.app.packages.export(package['id'])
        payload = {'backend_url': self.backend.url, 'request': {
            'kind': 'package', 'package_id': package['id'], 'values': {}, 'output_nodes': ['3']}}
        self.assertEqual(self.post('/api/execution-plan', payload, csrf=False)[0], 403)
        status, _, plan = self.post('/api/execution-plan', payload)
        self.assertEqual(status, 200, plan)
        self.assertEqual(set(plan), {'backend_url', 'package_id', 'execution'})
        self.assertEqual(plan['execution']['active_field_ids'], ['a', 'prefix', 'size', 'mode', 'enabled'])
        self.assertEqual(self.post('/api/compile', payload['request'])[0], 400)
        status, _, rejected = self.post('/api/generate', {
            'request_id': 'plan-empty-generation-0001', 'request': payload['request']})
        self.assertEqual(status, 400, rejected)
        self.assertIn('请填写', rejected['error'])
        self.backend.info['SaveImage']['input']['required']['size'] = ['INT', {'max': 31}]
        self.assertEqual(self.post('/api/execution-plan', payload)[0], 400)
        self.assertEqual(self.app.packages.export(package['id']), before)
        self.assertEqual(self.app.jobs, {})
        self.assertEqual(self.app.editor_workflows.list()['total'], 0)
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(call[0] == 'POST' for call in self.backend.calls))


if __name__ == '__main__':
    unittest.main()
