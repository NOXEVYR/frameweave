"""Independent checks of root's public declaration semantics, no production edits."""
import unittest
import json
import threading
import types
import test_editor_integration as fixtures
from frameweave.hub_profiles import prepare_offer
from frameweave.hub_execution_contract import canonical, validate_inputs
from frameweave.hub_connection import PROFILE_SCHEMA


class PublicSchemaReview(unittest.TestCase):
    setUp = fixtures.EditorIntegrationTests.setUp
    stop_client = fixtures.EditorIntegrationTests.stop_client
    request = fixtures.EditorIntegrationTests.request

    def test_required_text_does_not_offer_empty_input_that_local_package_rejects(self):
        package = self.app.packages.save({'name': 'Required prompt', 'prompt': fixtures.compiled_prompt(), 'fields': [
            {'id': 'prompt', 'node_id': '2', 'input': 'text', 'type': 'text', 'label': 'Prompt', 'default': 'valid', 'required': True},
            {'id': 'image', 'node_id': '1', 'input': 'image', 'type': 'image', 'label': 'Image', 'default': '', 'required': True}]})
        request = {'kind': 'package', 'package_id': package['id'], 'values': {'prompt': 'valid', 'image': 'incoming/portrait.png'}, 'output_nodes': ['2']}
        offer = prepare_offer(self.app, {'request': request, 'name': 'Public prompt', 'key': 'prism.required',
            'field_ids': ['prompt'], 'domain': 'image', 'backend_url': self.backend.url})
        with self.assertRaises(ValueError):
            self.app.compile(dict(request, values={'prompt': '', 'image': 'incoming/portrait.png'}))
        with self.assertRaises(ValueError, msg='公开 schema 应拒绝本地必填提示词不能接受的空字符串'):
            validate_inputs({'input_1': ''}, offer['declaration']['inputs'])


class DeclarationCapacityReview(unittest.TestCase):
    def prepare(self, fields, public_ids):
        package = {'id': 'p-synthetic', 'fields': fields}
        backend = types.SimpleNamespace(url='http://127.0.0.1:8188')
        app = types.SimpleNamespace(lock=threading.RLock(), backend=backend,
            packages=types.SimpleNamespace(get=lambda _: package),
            compile=lambda _: {'summary': {'execution': {'node_ids': [f['node_id'] for f in fields]}}})
        return prepare_offer(app, {'request': {'kind': 'package', 'package_id': package['id'], 'values': {}},
            'field_ids': public_ids, 'name': 'Synthetic', 'key': 'prism.synthetic', 'domain': 'image', 'backend_url': backend.url})

    @staticmethod
    def stored_text(declaration):
        # Sealed r4 capabilities.py:171-199,247-267 adds these fields then
        # json.dumps(..., ensure_ascii=False), including default separators.
        value = dict(provider='', server='', tags=[], outputs=[], hints={})
        value.update(declaration)
        return json.dumps(value, ensure_ascii=False)

    def test_prepared_offer_fits_exact_r4_normalized_declaration_not_just_canonical_json(self):
        fields = [{'id': f'f{i}', 'node_id': str(i), 'input': 'choice', 'type': 'select', 'label': f'Choice{i}',
            'options': [f'{j:02}' + 'x' * 24 for j in range(32)], 'default': '00' + 'x' * 24} for i in range(32)]
        try:
            offer = self.prepare(fields, [field['id'] for field in fields])
        except ValueError:
            return  # An early actionable preparation error is the intended fallback.
        self.assertLessEqual(len(self.stored_text(offer['declaration']).encode('utf-8')), 32768,
            'canonical size excludes Hub stored JSON spaces and metadata')

    def test_prepared_offer_fits_profile_with_declaration_text_escaped_as_string(self):
        fields = [{'id': 'choice', 'node_id': '1', 'input': 'choice', 'type': 'select', 'label': 'Choice',
            'options': ['default'] + [str(i) + '\\' * 450 for i in range(31)], 'default': 'default'}]
        fields += [{'id': f'fixed{i}', 'node_id': str(i + 2), 'input': 'text', 'type': 'text', 'label': 'Fixed',
                    'default': 'x' * 45000} for i in range(2)]
        try:
            offer = self.prepare(fields, ['choice'])
        except ValueError:
            return
        profile = {'schema': PROFILE_SCHEMA, 'capability_id': 'b' * 32,
            'declaration_text': self.stored_text(offer['declaration']), 'backend': offer['backend'],
            'template': offer['template'], 'bindings': offer['bindings'], 'enabled': False}
        self.assertLessEqual(len(canonical(profile)), 128 * 1024,
            'profile encodes declaration as a JSON string, escaping it one more time')
