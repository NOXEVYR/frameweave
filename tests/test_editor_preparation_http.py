"""Editing preparation preserves sources and never submits generation."""
import copy
import json
import unittest
from unittest.mock import patch
import test_editor_integration as native_tests
from frameweave.backend import BackendError

class EditorPreparationHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def field(self):
        return {'id': 'description', 'node_id': '2', 'input': 'text', 'type': 'text', 'label': 'Prompt'}

    def prepare(self, **kwargs):
        return self.post('/api/editor-prepare', {'backend_url': self.backend.url, **kwargs})

    def assert_read_only(self):
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(method != 'GET' for method, *_ in self.backend.calls))
        self.assertEqual(self.app.packages.list(), [])
        self.assertEqual(self.app.editor_sessions, {})
        self.assertEqual(self.app.editor_workflows.list()['total'], 0)

    def test_full_api_with_empty_media_broken_island_and_metadata_opens_as_data(self):
        prompt = native_tests.compiled_prompt(image='')
        prompt['2']['_meta'] = {'title': 'Kept', 'custom': {'a': False}}
        prompt['bad'] = {'class_type': 'FutureNode', 'inputs': {'reference': ['absent', 0]}, 'extension': {'keep': True}}
        source = {'prompt': prompt, 'note': 'original carrier'}
        original = copy.deepcopy(source)
        status, _, result = self.prepare(document=source, fields=[self.field()], overrides=[
            {'field_id': 'description', 'value': 'Projected text', 'origin': 'connected', 'stored_fallback': 'My fallback'}])
        self.assertEqual(status, 200, result)
        self.assertEqual(result['source_document'], original)
        self.assertEqual(set(result['prompt']), set(prompt))
        self.assertEqual(result['prompt']['2']['inputs']['text'], 'Projected text')
        self.assertEqual(result['prompt']['bad'], prompt['bad'])
        self.assertEqual(result['prompt']['2']['_meta'], prompt['2']['_meta'])
        self.assertEqual(result['status'], 'unverified')
        self.assertTrue(result['pending'])
        self.assertEqual(source, original)
        self.assert_read_only()

    def test_offline_keeps_source_and_reports_unapplied_override(self):
        prompt = native_tests.compiled_prompt()
        with patch.object(self.app, '_object_info_for_backend', side_effect=BackendError('offline')):
            status, _, result = self.prepare(document={'prompt': prompt}, fields=[self.field()],
                overrides=[{'field_id': 'description', 'value': 'Cannot prove'}])
        self.assertEqual(status, 200, result)
        self.assertEqual(result['prompt'], prompt)
        self.assertEqual(result['overrides'], [])
        self.assertTrue(any(item['code'] == 'schema_unavailable' for item in result['diagnostics']))
        self.assert_read_only()

    def test_backend_change_during_probe_rejects_without_saving(self):
        prior = self.app.backend
        def switch(_):
            self.app.backend = copy.copy(prior)
            return self.backend.info
        with patch.object(self.app, '_object_info_for_backend', side_effect=switch):
            status, _, result = self.prepare(document={'prompt': native_tests.compiled_prompt()})
        self.app.backend = prior
        self.assertEqual(status, 400, result)
        self.assert_read_only()

    def test_auth_wrong_backend_and_ambiguous_carriers_are_rejected(self):
        for payload in ({'backend_url': 'http://127.0.0.1:2', 'document': {'prompt': native_tests.compiled_prompt()}},
                        {'backend_url': self.backend.url, 'source_json': '{"x":1,"x":2}'}):
            status, _, _ = self.post('/api/editor-prepare', payload)
            self.assertEqual(status, 400)
        self.assertEqual(self.post('/api/editor-prepare', {}, csrf=False)[0], 403)
        self.assert_read_only()

    def test_package_uses_immutable_complete_mapping_without_rewriting_stored_bytes(self):
        prompt = native_tests.compiled_prompt()
        status, _, inspected = self.post('/api/interfaces/inspect', {'document': {'prompt': prompt}})
        self.assertEqual(status, 200)
        status, _, applied = self.post('/api/interfaces/apply', {'prompt': prompt, 'fields': inspected['fields'],
            'name': 'Editor source', 'backend_url': self.backend.url})
        self.assertEqual(status, 200, applied)
        package = applied['package']
        stored = self.app.packages._path(package['id'])
        before = stored.read_bytes()
        field = next(f for f in package['fields'] if f['node_id'] == '2' and f['input'] == 'text')
        status, _, result = self.prepare(package_id=package['id'], overrides=[{'field_id': field['id'], 'value': 'Editing'}])
        self.assertEqual(status, 200, result)
        self.assertEqual(result['prompt']['2']['inputs']['text'], 'Editing')
        self.assertEqual(result['source_revision'], package['id'])
        self.assertEqual(stored.read_bytes(), before)
        status, _, _ = self.prepare(package_id=package['id'], fields=[self.field()])
        self.assertEqual(status, 400)
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(method != 'GET' for method, *_ in self.backend.calls))

if __name__ == '__main__':
    unittest.main()
