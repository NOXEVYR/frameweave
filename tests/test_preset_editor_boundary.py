"""Independent defensive checks of the preset editing data boundary."""
import copy
import unittest
from unittest.mock import patch

from frameweave.packages import MAX_BYTES, encoded
from frameweave.preset_editor_preparation import prepare_preset_editor
from frameweave.workflows import build_preset_editor_recipe, compile_workflow
from test_preset_editor_recipe import case
import test_preset_editor_preparation_http as http_tests

BACKEND = 'http://127.0.0.1:8188'


def ready_source(name='sdxl_full'):
    entry, info = case(name)
    request = copy.deepcopy(entry['request'])
    request['models'] = copy.deepcopy(entry['expected']['summary']['models'])
    return request, info


class PresetEditorBoundaryTests(unittest.TestCase):
    def test_full_request_envelope_budget_is_checked_before_recipe(self):
        request, info = ready_source('sdxl')
        data = {'preset_request': request, 'backend_url': BACKEND, 'pending': [{'note': 'x' * MAX_BYTES}]}
        with patch('frameweave.preset_editor_preparation.build_preset_editor_recipe') as builder:
            with self.assertRaisesRegex(ValueError, '2 MiB'):
                prepare_preset_editor(data, info=info, backend_url=BACKEND)
            builder.assert_not_called()

    def test_full_response_budget_counts_fields_receipt_and_provenance(self):
        request, info = ready_source('sdxl')
        recipe = build_preset_editor_recipe(request, info)
        source_padding = MAX_BYTES - len(encoded(recipe)) - 80
        request['retained_note'] = 'x' * source_padding
        recipe = build_preset_editor_recipe(request, info)
        self.assertLessEqual(len(encoded(recipe)), MAX_BYTES)
        data = {'preset_request': request}
        self.assertLessEqual(len(encoded(data)), MAX_BYTES)
        before = copy.deepcopy(data)
        with self.assertRaisesRegex(ValueError, '2 MiB'):
            prepare_preset_editor(data, info=info, backend_url=BACKEND)
        self.assertEqual(data, before)

    def test_complete_valid_recipe_maps_every_real_binding_and_preserves_own_graph(self):
        request, info = ready_source()
        before = copy.deepcopy(request)
        expected = compile_workflow(request, info)
        result = prepare_preset_editor({'preset_request': request}, info=info, backend_url=BACKEND)
        self.assertTrue(result['receipt_complete'], result['diagnostics'])
        self.assertEqual(result['source_document']['prompt'], expected['prompt'])
        self.assertEqual(result['summary'], expected['summary'])
        self.assertEqual(request, before)
        ids = {field['id']: field for field in result['fields']}
        seen = set()
        for item in result['receipt']:
            for target in item['targets']:
                self.assertEqual(item['type'], target['type'])
                field = ids[target['field_id']]
                self.assertEqual(tuple(target[key] for key in ('node_id', 'input', 'type')),
                                 tuple(field[key] for key in ('node_id', 'input', 'type')))
                bound = (target['node_id'], target['input'])
                self.assertNotIn(bound, seen)
                seen.add(bound)

    def test_unknown_target_is_explicitly_unproven_without_source_changes(self):
        request, info = ready_source('sdxl')
        recipe = build_preset_editor_recipe(request, info)
        item = next(item for item in recipe['receipt'] if item['logical_id'] == 'positive')
        item['targets'][0]['node_id'] = 'absent'
        with patch('frameweave.preset_editor_preparation.build_preset_editor_recipe', return_value=recipe):
            result = prepare_preset_editor({'preset_request': request}, info=info, backend_url=BACKEND)
        self.assertFalse(result['receipt_complete'])
        self.assertTrue(any(issue['code'] == 'interface_binding_unproven' for issue in result['diagnostics']))
        self.assertEqual(result['source_document']['prompt'], recipe['prompt'])

    def test_item_type_disagreement_cannot_report_complete_receipt(self):
        request, info = ready_source('sdxl')
        recipe = build_preset_editor_recipe(request, info)
        item = next(item for item in recipe['receipt'] if item['logical_id'] == 'positive')
        item['type'] = 'integer'
        with patch('frameweave.preset_editor_preparation.build_preset_editor_recipe', return_value=recipe):
            result = prepare_preset_editor({'preset_request': request}, info=info, backend_url=BACKEND)
        self.assertFalse(result['receipt_complete'])

    def test_empty_target_list_cannot_report_complete_receipt(self):
        request, info = ready_source('sdxl')
        recipe = build_preset_editor_recipe(request, info)
        next(item for item in recipe['receipt'] if item['logical_id'] == 'positive')['targets'] = []
        with patch('frameweave.preset_editor_preparation.build_preset_editor_recipe', return_value=recipe):
            result = prepare_preset_editor({'preset_request': request}, info=info, backend_url=BACKEND)
        self.assertFalse(result['receipt_complete'])

    def test_unproven_target_may_not_keep_supplied_field_id_as_proof(self):
        request, info = ready_source('sdxl')
        recipe = build_preset_editor_recipe(request, info)
        item = next(item for item in recipe['receipt'] if item['logical_id'] == 'positive')
        item['targets'][0].update(node_id='absent', field_id='forged')
        with patch('frameweave.preset_editor_preparation.build_preset_editor_recipe', return_value=recipe):
            result = prepare_preset_editor({'preset_request': request,
                'pending': [{'logical_id': 'positive', 'reason': 'upstream_pending'}]}, info=info, backend_url=BACKEND)
        self.assertFalse(result['receipt_complete'])
        self.assertNotIn('field_id', next(item for item in result['receipt'] if item['logical_id'] == 'positive')['targets'][0])
        self.assertFalse(any(item.get('field_id') == 'forged' for item in result['pending']))

    def test_unknown_recipe_status_must_not_silently_prepare_as_materialized(self):
        request, info = ready_source('sdxl')
        recipe = build_preset_editor_recipe(request, info)
        recipe['status'] = 'future_partial'
        with patch('frameweave.preset_editor_preparation.build_preset_editor_recipe', return_value=recipe):
            with self.assertRaises(ValueError):
                prepare_preset_editor({'preset_request': request}, info=info, backend_url=BACKEND)

    def test_blocked_preserves_source_and_topology_intents_without_partial_graph(self):
        _, info = case('qwen21_edit')
        info.pop('TextEncodeQwenImage21')
        own = {'kind': 'qwen21_edit', 'positive': '', 'references': ['', '', 'style.png'],
               'custom_size': True, 'own_note': {'scene': 'keep'}}
        slots = [{'port_id': 'image_3', 'index': 2, 'ordinal': 3, 'role': 'reference'}]
        data = {'preset_request': own, 'reference_slots': slots, 'input_intents': {'negative': True}}
        before = copy.deepcopy(data)
        result = prepare_preset_editor(data, info=info, backend_url=BACKEND)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['source_request'], own)
        self.assertEqual(result['intents']['reference_slots'], slots)
        self.assertEqual(result['intents']['input_intents'], {'negative': True})
        self.assertIsNone(result['prompt'])
        self.assertIsNone(result['source_document'])
        self.assertEqual(data, before)

    def test_empty_model_options_never_coerce_receipt_to_text(self):
        request, info = ready_source('sdxl')
        info['CheckpointLoaderSimple']['input']['required']['ckpt_name'][0] = []
        request['models']['checkpoint'] = ''
        result = prepare_preset_editor({'preset_request': request}, info=info, backend_url=BACKEND)
        self.assertTrue(result['receipt_complete'])
        model = next(item for item in result['receipt'] if item['logical_id'] == 'models.checkpoint')
        self.assertEqual(model['type'], 'select')
        field = next(field for field in result['fields'] if field['id'] == model['targets'][0]['field_id'])
        self.assertEqual(field['type'], 'select')
        self.assertEqual(field['options'], [])
        self.assertTrue(any(item.get('field_id') == field['id'] and item['reason'] == 'enum_unavailable'
                            for item in result['pending']))
        self.assertEqual(result['source_document']['prompt']['1']['inputs']['ckpt_name'], '')

    def test_additional_ready_source_variants_keep_execute_recipe_exact(self):
        variants = [
            ('sdxl_full', {'loras': [], 'models': {'checkpoint': 'checkpoints/studio_xl.safetensors',
               'lora': 'unavailable.safetensors'}, 'refine': {'enabled': False}}),
            ('sdxl_full', {'loras': [{'name': 'loras/turbo.safetensors', 'strength_model': 0, 'strength_clip': 0}],
               'refine': {'enabled': True, 'width': 1024, 'height': 768, 'steps': 1, 'denoise': 0,
                          'upscale_method': 'nearest-exact'}}),
            ('krea_edit', {'references': ['style.png'], 'reference_roles': ['character'], 'denoise': 1,
                          'loras': [{'name': 'loras/turbo.safetensors', 'strength_model': .25}]}),
            ('h3_native_negative', {'references': ['last.png', 'first.png'], 'reference_roles': ['end', 'start'],
                                    'steps': 1, 'cfg': 0}),
            ('qwen_custom_size', {'custom_size': False, 'ref_resolution': 0,
                                  'models': {'dit': 'QwenImage21/qwen_image_2.1_bf16_from_diffusers.safetensors',
                                             'text_encoder': 'QwenImage21/qwen3vl_8b_int8_convrot.safetensors',
                                             'vae': 'QwenImage21/qwen_image_2.1_vae_bf16.safetensors'}}),
        ]
        for name, overrides in variants:
            with self.subTest(name=name, overrides=overrides):
                request, info = ready_source(name)
                request.update(overrides)
                executed = compile_workflow(request, info)
                request['models'] = copy.deepcopy(executed['summary']['models'])
                edited = build_preset_editor_recipe(request, info)
                self.assertEqual(edited['status'], 'materialized')
                self.assertEqual(edited['prompt'], executed['prompt'])
                self.assertEqual(edited['summary'], executed['summary'])


class PresetEditorBoundaryHTTPTests(unittest.TestCase):
    setUp = http_tests.PresetPreparationHTTPTests.setUp
    stop_client = http_tests.PresetPreparationHTTPTests.stop_client
    request = http_tests.PresetPreparationHTTPTests.request
    post = http_tests.PresetPreparationHTTPTests.post
    prepare = http_tests.PresetPreparationHTTPTests.prepare
    assert_read_only = http_tests.PresetPreparationHTTPTests.assert_read_only

    def test_all_source_carrier_presence_and_non_preset_kind_are_rejected_read_only(self):
        _, self.backend.info = case('sdxl')
        for carrier in ('document', 'source_json', 'package_id', 'fields'):
            for value in (None, '', {}, []):
                with self.subTest(carrier=carrier, value=value):
                    self.assertEqual(self.prepare(preset_request={'kind': 'sdxl'}, **{carrier: value})[0], 400)
        self.assertEqual(self.prepare(preset_request={'kind': 'api', 'prompt': {}})[0], 400)
        self.assertEqual(self.prepare(preset_request=None)[0], 400)
        self.assert_read_only()

    def test_wrong_backend_identity_rejects_before_schema_read(self):
        with patch.object(self.app, '_object_info_for_backend') as probe:
            status, _, _ = self.post('/api/editor-prepare', {'backend_url': 'http://127.0.0.1:2',
                'preset_request': {'kind': 'sdxl'}})
            self.assertEqual(status, 400)
            probe.assert_not_called()
        self.assert_read_only()

    def test_graph_overrides_never_create_store_or_upload(self):
        request, self.backend.info = ready_source('sdxl')
        status, _, baseline = self.prepare(preset_request=request)
        self.assertEqual(status, 200)
        target = next(item for item in baseline['receipt'] if item['logical_id'] == 'positive')['targets'][0]
        status, _, changed = self.prepare(preset_request=request, overrides=[
            {'field_id': target['field_id'], 'value': 'Connected projected text', 'origin': 'connected'}])
        self.assertEqual(status, 200, changed)
        self.assertEqual(changed['source_request'], request)
        self.assertEqual(changed['source_document']['prompt'][target['node_id']]['inputs'][target['input']], request['positive'])
        self.assertEqual(changed['prompt'][target['node_id']]['inputs'][target['input']], 'Connected projected text')
        self.assert_read_only()


if __name__ == '__main__':
    unittest.main()
