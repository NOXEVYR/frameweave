"""Unified API/package interface edits use the same safeguards as native edits."""
import unittest
import json
import test_editor_integration as native_tests
from test_editor_integration import compiled_prompt


class InterfaceHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def inspect(self, prompt):
        status, _, info = self.post('/api/interfaces/inspect', {'document': {'prompt': prompt}})
        self.assertEqual(status, 200, info)
        return info

    def test_missing_resources_allow_external_controls_but_not_generation(self):
        prompt = compiled_prompt(image='', clip_name='not-installed.safetensors')
        info = self.inspect(prompt)
        status, _, result = self.post('/api/interfaces/apply', {
            'prompt': prompt, 'fields': info['fields'], 'output_nodes': ['2'],
            'name': 'Editable import', 'backend_url': self.backend.url})
        self.assertEqual(status, 200, result)
        self.assertEqual(result['readiness']['status'], 'blocked')
        self.assertTrue(result['package']['fields'])
        status, _, rejected = self.post('/api/compile', {'kind': 'package',
            'package_id': result['package']['id'], 'values': result['values'], 'output_nodes': ['2']})
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.backend.next_id, 0)
        self.assertEqual(self.app.editor_workflows.list()['total'] if isinstance(self.app.editor_workflows.list(),dict) else len(self.app.editor_workflows.list()), 0)

    def test_reconfigure_empty_media_preserves_renames_values_and_presentation(self):
        prompt = compiled_prompt(image='')
        info = self.inspect(prompt)
        field = next(f for f in info['fields'] if f['input'] == 'text')
        field.update(label='角色描述', presentation='control')
        status, _, first = self.post('/api/interfaces/apply', {'prompt': prompt, 'fields': info['fields'],
            'name': 'First', 'backend_url': self.backend.url})
        self.assertEqual(status, 200, first)
        values = dict(first['values']); values[field['id']] = 'edited outside'
        status, _, second = self.post('/api/interfaces/apply', {
            'package_id': first['package']['id'], 'previous_package_id': first['package']['id'],
            'previous_values': values, 'previous_baseline': first['baseline'], 'fields': first['package']['fields'],
            'name': 'Second', 'backend_url': self.backend.url})
        self.assertEqual(status, 200, second)
        self.assertFalse(second.get('requires_resolution'))
        self.assertEqual(second['values'][field['id']], 'edited outside')
        self.assertEqual(next(f for f in second['package']['fields'] if f['id'] == field['id'])['presentation'], 'control')

    def test_broken_graph_and_wrong_backend_rejected_without_saving(self):
        prompt = compiled_prompt(); info = self.inspect(prompt)
        prompt['2']['inputs']['image'] = ['missing', 0]
        for backend in [self.backend.url, 'http://127.0.0.1:2']:
            status, _, result = self.post('/api/interfaces/apply', {'prompt': prompt,
                'name': 'Bad', 'fields': info['fields'], 'backend_url': backend})
            self.assertEqual(status, 400, result)
        self.assertEqual(self.app.packages.list(), [])
        status, _, _ = self.post('/api/interfaces/apply', {}, csrf=False)
        self.assertEqual(status, 403)

    def test_hiding_control_retains_outer_value_and_inner_conflicts_require_choice(self):
        prompt = compiled_prompt(); info = self.inspect(prompt)
        field = next(f for f in info['fields'] if f['node_id'] == '2' and f['input'] == 'steps')
        media = [f for f in info['fields'] if f['type'] == 'image']
        status, _, first = self.post('/api/interfaces/apply', {'prompt': prompt,
            'fields': media + [field], 'name': 'Hidden controls', 'backend_url': self.backend.url})
        self.assertEqual(status, 200, first)
        common = {'previous_package_id': first['package']['id'], 'previous_values': {field['id']: 27},
                  'previous_baseline': first['baseline'], 'fields': media, 'name': 'Hidden controls',
                  'backend_url': self.backend.url, 'rebindings': {field['id']: None}}
        status, _, hidden = self.post('/api/interfaces/apply', {
            **common, 'package_id': first['package']['id']})
        self.assertEqual(status, 200, hidden)
        self.assertEqual(hidden['package']['prompt']['2']['inputs']['steps'], 27)
        self.assertNotIn(field['id'], hidden['values'])
        prompt['2']['inputs']['steps'] = 31
        before = len(self.app.packages.list())
        status, _, conflict = self.post('/api/interfaces/apply', {**common, 'prompt': prompt})
        self.assertEqual(status, 200, conflict)
        self.assertTrue(conflict['requires_resolution'])
        self.assertEqual(len(self.app.packages.list()), before)
        conflict_id = conflict['changes']['conflicts'][0]['id']
        for choice, expected in [('inner', 31), ('outer', 27)]:
            status, _, resolved = self.post('/api/interfaces/apply', {
                **common, 'prompt': prompt, 'resolutions': {conflict_id: choice}})
            self.assertEqual(status, 200, resolved)
            self.assertEqual(resolved['package']['prompt']['2']['inputs']['steps'], expected)

    def test_invalid_native_document_does_not_leave_package(self):
        status, _, imported = self.post('/api/editor-workflows', {
            'name': 'Original', 'source_json': json.dumps(native_tests.editor_document())})
        self.assertEqual(status, 200, imported)
        ident = imported['id']
        status, _, session = self.post(f'/api/editor-workflows/{ident}/session')
        self.assertEqual(status, 200, session)
        status, _, rejected = self.post(f'/api/editor-workflows/{ident}/apply', {
            'session_id': session['session_id'], 'base_revision': imported['revision'],
            'document': {}, 'prompt': compiled_prompt()})
        self.assertEqual(status, 400, rejected)
        self.assertEqual(self.app.packages.list(), [])
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], imported['revision'])

    def test_custom_media_upload_cannot_be_hidden_on_import_or_reconfigure(self):
        self.backend.info = {
            'AudioLoaderCustom': {'input': {'required': {'audio': ['STRING', {'audio_upload': True}]}},
                                  'output': ['AUDIO'], 'output_node': False},
            'AudioSink': {'input': {'required': {'audio': ['AUDIO']}}, 'output': [], 'output_node': True}}
        prompt = {'1': {'class_type': 'AudioLoaderCustom', 'inputs': {'audio': ''}},
                  '2': {'class_type': 'AudioSink', 'inputs': {'audio': ['1', 0]}}}
        info = self.inspect(prompt)
        payload = {'prompt': prompt, 'name': 'Portable audio', 'backend_url': self.backend.url}
        status, _, result = self.post('/api/interfaces/apply', {**payload, 'fields': []})
        self.assertEqual(status, 400, result)
        self.assertEqual(self.app.packages.list(), [])
        status, _, first = self.post('/api/interfaces/apply', {**payload, 'fields': info['fields']})
        self.assertEqual(status, 200, first)
        before = self.app.packages.list()
        status, _, result = self.post('/api/interfaces/apply', {
            'package_id': first['package']['id'], 'previous_package_id': first['package']['id'],
            'backend_url': self.backend.url, 'name': 'Hidden audio', 'fields': []})
        self.assertEqual(status, 400, result)
        self.assertEqual(self.app.packages.list(), before)
        self.assertEqual(self.backend.next_id, 0)


if __name__ == '__main__':
    unittest.main()
