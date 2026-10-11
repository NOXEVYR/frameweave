"""Fresh backend identity and read-only preparation at the public HTTP boundary."""
import copy
import unittest
from unittest.mock import patch

import test_editor_preparation_http as preparation_tests
from frameweave.backend import BackendError


class H3ReferenceHTTPTests(unittest.TestCase):
    setUp = preparation_tests.EditorPreparationHTTPTests.setUp
    stop_client = preparation_tests.EditorPreparationHTTPTests.stop_client
    request = preparation_tests.EditorPreparationHTTPTests.request
    post = preparation_tests.EditorPreparationHTTPTests.post
    assert_read_only = preparation_tests.EditorPreparationHTTPTests.assert_read_only

    def payload(self):
        return {'backend_url': self.backend.url, 'preset_request': {'kind': 'h3_ref'},
                'layout': {'image_count': 0, 'videos': [{'soundtrack': False}], 'audio_count': 0}}

    def test_success_uses_fresh_schema_and_does_not_save_or_submit(self):
        result = {'status': 'prepared', 'document': {'name': 'Test'}, 'blocked': []}
        with patch('frameweave.server.prepare_h3_reference_package', return_value=result) as builder:
            status, _, response = self.post('/api/h3-reference/prepare', self.payload())
        self.assertEqual(status, 200, response)
        self.assertEqual(response, {**result, 'backend_url': self.backend.url})
        self.assertEqual(builder.call_args.args[:2], (self.payload()['preset_request'], self.payload()['layout']))
        self.assertEqual(builder.call_args.args[2], self.backend.info)
        self.assertTrue(any(path == '/object_info' for _, path, *_ in self.backend.calls))
        self.assert_read_only()

    def test_csrf_wrong_backend_and_unexpected_keys_never_build(self):
        with patch('frameweave.server.prepare_h3_reference_package') as builder:
            self.assertEqual(self.post('/api/h3-reference/prepare', self.payload(), csrf=False)[0], 403)
            for payload in ({**self.payload(), 'execute': True}, {**self.payload(), 'backend_url': 'http://127.0.0.1:2'}, {}):
                self.assertEqual(self.post('/api/h3-reference/prepare', payload)[0], 400)
            builder.assert_not_called()
        self.assert_read_only()

    def test_switch_during_schema_fetch_rejects_result_without_mutation(self):
        prior = self.app.backend
        def switch(_):
            self.app.backend = copy.copy(prior)
            return self.backend.info
        with patch.object(self.app, '_object_info_for_backend', side_effect=switch), patch(
                'frameweave.server.prepare_h3_reference_package', return_value={'status': 'prepared', 'document': {}}):
            status, _, response = self.post('/api/h3-reference/prepare', self.payload())
        self.app.backend = prior
        self.assertEqual(status, 400, response)
        self.assertIn('装配期间', response['error'])
        self.assert_read_only()

    def test_blocked_is_not_success_and_does_not_persist_partial_workflow(self):
        expected = {'status': 'blocked', 'document': None, 'blocked': [{'code': 'loader_missing', 'message': '缺少加载能力'}]}
        with patch('frameweave.server.prepare_h3_reference_package', return_value=expected):
            status, _, result = self.post('/api/h3-reference/prepare', self.payload())
        self.assertEqual(status, 200)
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['document'])
        self.assert_read_only()

    def test_disconnected_backend_does_not_fallback_to_old_schema(self):
        with patch.object(self.app, '_object_info_for_backend', side_effect=BackendError('offline')), patch(
                'frameweave.server.prepare_h3_reference_package') as builder:
            status, _, _ = self.post('/api/h3-reference/prepare', self.payload())
            builder.assert_not_called()
        self.assertEqual(status, 502)
        self.assert_read_only()

    def test_real_builder_standard_package_save_edit_and_compile_share_the_same_bindings(self):
        from test_h3_reference import fixture
        from test_preset_editor_recipe import case
        self.backend.info = fixture()
        golden, _ = case('h3_ref')
        payload = self.payload()
        payload['preset_request'].update(positive='A synthetic test', models=golden['expected']['summary']['models'])
        payload['layout'] = {'image_count': 0, 'videos': [{'soundtrack': True}], 'audio_count': 1}
        status, _, prepared = self.post('/api/h3-reference/prepare', payload)
        self.assertEqual(status, 200, prepared)
        self.assertEqual(prepared['status'], 'prepared', prepared)
        self.assert_read_only()
        status, _, saved = self.post('/api/packages', prepared['document'])
        self.assertEqual(status, 200, saved)
        pack = saved['package']
        fields = pack['fields']
        values = {f['id']: f['default'] for f in fields}
        for field in fields:
            if field['type'] == 'video':
                values[field['id']] = 'video.mp4'
            elif field['type'] == 'audio':
                values[field['id']] = 'audio.wav'
        status, _, edited = self.post('/api/editor-prepare', {'backend_url': self.backend.url, 'package_id': pack['id']})
        self.assertEqual(status, 200, edited)
        self.assertEqual(edited['source_document']['prompt'], pack['prompt'])
        status, _, result = self.post('/api/compile', {'kind': 'package', 'package_id': pack['id'], 'values': values})
        self.assertEqual(status, 200, result)
        video_id = next(key for key, node in result['prompt'].items() if node['class_type'] == 'VHS_LoadVideo')
        conditioning = next(node['inputs'] for node in result['prompt'].values() if node['class_type'] == 'MiniMaxH3ReferenceToVideo')
        self.assertEqual(conditioning['ref_videos.ref_video_0'], [video_id, 0])
        self.assertEqual(conditioning['ref_video_audios.ref_video_audio_0'], [video_id, 2])
        rate = next(field for field in fields if field['input'] == 'force_rate')
        values[rate['id']] = 30
        self.assertEqual(self.post('/api/compile', {'kind': 'package', 'package_id': pack['id'], 'values': values})[0], 400)
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(method != 'GET' for method, *_ in self.backend.calls))


if __name__ == '__main__':
    unittest.main()
