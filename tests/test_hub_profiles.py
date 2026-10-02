"""Public offers freeze local parameters without generating or publishing."""
import copy
import json
import unittest
from unittest.mock import patch

import test_editor_integration as fixtures
from frameweave.hub_profiles import field_schema, prepare_offer
from frameweave.hub_execution_contract import validate_inputs


class HubOfferTests(unittest.TestCase):
    setUp = fixtures.EditorIntegrationTests.setUp
    stop_client = fixtures.EditorIntegrationTests.stop_client
    request = fixtures.EditorIntegrationTests.request
    post = fixtures.EditorIntegrationTests.post

    def package(self):
        return self.app.packages.save({'name': 'Workflow', 'prompt': fixtures.compiled_prompt(), 'fields': [
            {'id': 'prompt', 'node_id': '2', 'input': 'text', 'type': 'text', 'label': 'Private user label', 'default': 'private prompt'},
            {'id': 'steps', 'node_id': '2', 'input': 'steps', 'type': 'integer', 'label': 'Steps', 'default': 18, 'min': 1, 'max': 50},
            {'id': 'encoder', 'node_id': '2', 'input': 'clip_name', 'type': 'select', 'label': 'Encoder', 'default': 'encoder-a.safetensors', 'options': ['encoder-a.safetensors', 'encoder-b.safetensors']},
            {'id': 'image', 'node_id': '1', 'input': 'image', 'type': 'image', 'label': 'Image', 'default': 'incoming/portrait.png'},
            {'id': 'other', 'node_id': '3', 'input': 'text', 'type': 'text', 'label': 'Other branch', 'default': 'private other'},
        ]})

    def body(self, package=None):
        return {'request': {'kind': 'package', 'package_id': (package or self.package())['id'], 'values': {'prompt': 'current private prompt', 'image': 'incoming/portrait.png'}, 'output_nodes': ['2']},
            'name': 'Public name', 'key': 'prism.test', 'field_ids': ['prompt', 'steps'], 'domain': 'image', 'backend_url': self.backend.url}

    def test_http_offer_freezes_defaults_maps_fields_and_only_exports_safe_declaration(self):
        body = self.body(); original = copy.deepcopy(body)
        code, _, offer = self.post('/api/hub-connection/prepare-offer', body)
        self.assertEqual(code, 200, offer)
        self.assertEqual(offer['bindings'], {'input_1': ['values', 'prompt'], 'input_2': ['values', 'steps']})
        self.assertEqual(offer['template']['values']['prompt'], 'current private prompt')
        self.assertEqual(offer['template']['values']['encoder'], 'encoder-a.safetensors')
        self.assertEqual(offer['template']['output_nodes'], ['2'])
        public = json.dumps(offer['declaration'])
        for secret in ('private', 'portrait.png', 'encoder-a.safetensors', self.backend.url): self.assertNotIn(secret, public)
        self.assertEqual(body, original)
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(call[0] != 'GET' for call in self.backend.calls))
        self.assertFalse((self.app.data_dir / 'hub-worker').exists())

    def test_unselected_branch_and_media_cannot_be_public_inputs(self):
        body = self.body()
        for field in ['other', 'image', 'missing']:
            body['field_ids'] = [field]
            status, _, result = self.post('/api/hub-connection/prepare-offer', body)
            self.assertEqual(status, 400, result)
        self.assertEqual(self.backend.next_id, 0)

    def test_changed_binding_changes_digest_and_missing_fields_never_silently_disappear(self):
        body = self.body(); before = prepare_offer(self.app, body)
        body['request']['values']['prompt'] = 'new private default'
        after = prepare_offer(self.app, body)
        self.assertNotEqual(before['binding_sha256'], after['binding_sha256'])
        body['request']['values']['removed'] = 'stale'
        with self.assertRaisesRegex(ValueError, '定义已变化'): prepare_offer(self.app, body)

    def test_engine_is_checked_before_and_after_fresh_compile(self):
        body = self.body(); body['backend_url'] = 'http://127.0.0.1:8199'
        with self.assertRaisesRegex(ValueError, '引擎已变化'): prepare_offer(self.app, body)
        body['backend_url'] = self.backend.url
        compile_request = self.app.compile
        def swap(request):
            result = compile_request(request)
            self.app.backend = copy.copy(self.app.backend)
            return result
        with patch.object(self.app, 'compile', side_effect=swap), self.assertRaisesRegex(ValueError, '准备期间'):
            prepare_offer(self.app, body)

    def test_malformed_or_overbroad_requests_fail_before_generation(self):
        body = self.body()
        for mutation in (lambda b: b.update(domain=[]), lambda b: b.update(field_ids=[]),
            lambda b: b.update(field_ids=['prompt', 'prompt']), lambda b: b.update(key='../bad'),
            lambda b: b['request'].update(kind='api', prompt={}), lambda b: b['request'].update(editor_backend='http://127.0.0.1:8199'),
            lambda b: b['request']['values'].update(prompt='x' * 12001), lambda b: b.update(extra=True)):
            modified = copy.deepcopy(body); mutation(modified)
            with self.subTest(modified=list(modified)), self.assertRaises(ValueError): prepare_offer(self.app, modified)
        self.assertEqual(self.backend.next_id, 0)

    def test_explicit_public_descriptions_do_not_inherit_local_field_labels(self):
        body = self.body(); body['field_descriptions'] = {'prompt': 'Describe the scene', 'steps': 'Sampling steps'}
        offer = prepare_offer(self.app, body)
        self.assertEqual(offer['declaration']['inputs']['properties']['input_1']['description'], 'Describe the scene')
        self.assertNotIn('Private user label', json.dumps(offer['declaration']))
        for descriptions in ({'other': 'unexpected'}, {'prompt': ''}, {'prompt': 'x' * 201}):
            body['field_descriptions'] = descriptions
            with self.assertRaisesRegex(ValueError, '公开参数说明'): prepare_offer(self.app, body)

    def test_large_default_input_and_public_declaration_fail_before_export(self):
        body = self.body(); body['request']['values']['prompt'] = '中' * 6000
        with self.assertRaisesRegex(ValueError, '16000 字节'): prepare_offer(self.app, body)
        body = self.body()
        package = self.package(); package['fields'][2]['options'] = [str(index) + 'a' * 1020 for index in range(32)]
        package['fields'][2]['default'] = package['fields'][2]['options'][0]
        package = self.app.packages.save(package)
        body['request']['package_id'] = package['id']; body['field_ids'] = ['encoder']
        with patch.object(self.app, 'compile', return_value={}), self.assertRaisesRegex(ValueError, '声明超过'):
            prepare_offer(self.app, body)

    def test_numeric_enum_default_uses_browser_json_carrier_before_binding(self):
        package = self.app.packages.save({'name': 'Numeric', 'prompt': {'1': {'class_type': 'Output', 'inputs': {'n': 1.0}}},
            'fields': [{'id': 'n', 'type': 'select', 'label': 'Numeric', 'node_id': '1', 'input': 'n', 'options': [1.0, 2.5], 'default': 1.0}]})
        body = {'request': {'kind': 'package', 'package_id': package['id'], 'values': {}}, 'name': 'Numeric', 'key': 'n',
            'domain': 'image', 'field_ids': ['n'], 'backend_url': self.backend.url}
        with patch.object(self.app, 'compile', return_value={}): offer = prepare_offer(self.app, body)
        self.assertIs(type(offer['template']['values']['n']), int)


class HubFieldSchemaTests(unittest.TestCase):
    def test_bounded_scalar_schema_and_enum_number_carriers(self):
        for field, valid, invalid in [
            ({'type': 'integer', 'min': 1, 'max': 30}, 10, 31),
            ({'type': 'number', 'min': 0, 'max': 1}, .5, 2),
            ({'type': 'boolean'}, False, 1), ({'type': 'text'}, 'hello', 'x' * 12001),
            ({'type': 'select', 'options': [1.0, 2.0]}, 1, True),
        ]:
            schema = field_schema(field); validate_inputs(valid, schema)
            with self.assertRaises(ValueError): validate_inputs(invalid, schema)

    def test_media_mixed_empty_and_oversize_enums_remain_fixed(self):
        for field in [{'type': 'image'}, {'type': 'audio'}, {'type': 'video'}, {'type': 'select', 'options': []},
            {'type': 'select', 'options': ['a', 1]}, {'type': 'select', 'options': list(range(33))},
            {'type': 'select', 'options': ['x' * 12001]}]:
            with self.assertRaises(ValueError): field_schema(field)
