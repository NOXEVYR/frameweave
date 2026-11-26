"""Pure preset editing uses the independently captured execution recipe."""
import copy
import json
import unittest
from pathlib import Path

from frameweave.workflows import build_preset_editor_recipe, compile_workflow

GOLDEN = json.loads((Path(__file__).parent / 'fixtures' / 'preset_execution_golden.json').read_text(encoding='utf8'))


def case(name):
    entry = next(item for item in GOLDEN['cases'] if item['name'] == name)
    return copy.deepcopy(entry), copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])


def typed(result, class_type):
    return [(node_id, node['inputs']) for node_id, node in result['prompt'].items() if node['class_type'] == class_type]


def slot(port, index, role='reference'):
    return {'port_id': port, 'index': index, 'ordinal': index + 1, 'role': role}


class PresetEditorRecipeTests(unittest.TestCase):
    def test_independently_captured_complete_execution_goldens(self):
        self.assertTrue(GOLDEN['captured_before_refactor'])
        self.assertEqual(len(GOLDEN['cases']), 17)
        for entry in GOLDEN['cases']:
            with self.subTest(name=entry['name']):
                info = copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
                self.assertEqual(compile_workflow(copy.deepcopy(entry['request']), info), entry['expected'])

    def test_ready_own_values_keep_exact_execution_graph_and_summary(self):
        for entry in GOLDEN['cases']:
            with self.subTest(name=entry['name']):
                request = copy.deepcopy(entry['request'])
                request['models'] = copy.deepcopy(entry['expected']['summary']['models'])
                info = copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
                result = build_preset_editor_recipe(request, info)
                self.assertEqual(result['status'], 'materialized')
                self.assertEqual(result['prompt'], entry['expected']['prompt'])
                self.assertEqual(result['summary'], entry['expected']['summary'])
                self.assertEqual(result['pending'], [])

    def test_all_eight_empty_edit_presets_keep_resource_holes_without_autoselection(self):
        for entry in GOLDEN['cases'][:8]:
            with self.subTest(kind=entry['name']):
                info = copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
                request = {'kind': entry['name'], 'positive': ''}
                result = build_preset_editor_recipe(request, info)
                self.assertEqual(result['status'], 'materialized')
                self.assertTrue(result['pending'])
                self.assertTrue(all(value == '' for value in result['summary']['models'].values()))
                self.assertEqual(result['source_request'], request)
                self.assertTrue(any(item['logical_id'] == 'positive' for item in result['pending']))
                with self.assertRaises(ValueError):
                    compile_workflow(request, info)

    def test_stale_selected_models_and_media_preserve_exact_names(self):
        _, info = case('sdxl')
        request = {'kind': 'sdxl_i2i', 'positive': 'Bird', 'models': {'checkpoint': 'removed_sdxl.safetensors'}, 'references': ['old.png']}
        result = build_preset_editor_recipe(request, info)
        self.assertEqual(typed(result, 'CheckpointLoaderSimple')[0][1]['ckpt_name'], 'removed_sdxl.safetensors')
        self.assertEqual(typed(result, 'LoadImage')[0][1]['image'], 'old.png')
        self.assertEqual({item['logical_id'] for item in result['pending']}, {'models.checkpoint', 'image_1'})
        with self.assertRaises(ValueError):
            compile_workflow(request, info)

    def test_qwen_ordered_reference_holes_do_not_compress(self):
        _, info = case('qwen21_edit')
        request = {'kind': 'qwen21_edit', 'positive': '', 'references': ['first.png', '', 'style.png']}
        result = build_preset_editor_recipe(request, info, reference_slots=[slot('image_5', 4)])
        loaders = typed(result, 'LoadImage')
        self.assertEqual([inputs['image'] for _, inputs in loaders], ['first.png', '', 'style.png', '', ''])
        encoder = typed(result, 'TextEncodeQwenImage21')[0][1]
        self.assertEqual([encoder[f'images.image_{i}'] for i in range(1, 6)], [[node_id, 0] for node_id, _ in loaders])
        receipt = {item['logical_id']: item for item in result['receipt']}
        self.assertEqual(receipt['image_3']['targets'][0]['node_id'], loaders[2][0])
        self.assertEqual(receipt['image_5']['targets'][0]['node_id'], loaders[4][0])
        self.assertEqual(result['summary']['size_mode'], 'first_reference')

    def test_h3_end_only_intent_does_not_invent_start_frame(self):
        _, info = case('h3_i2v')
        result = build_preset_editor_recipe({'kind': 'h3_i2v', 'positive': ''}, info,
                                            reference_slots=[slot('end_image', 1, 'end')])
        condition = typed(result, 'MiniMaxH3ImageToVideo')[0][1]
        self.assertNotIn('first_frame', condition)
        self.assertIn('last_frame', condition)
        self.assertEqual(result['summary']['reference_roles'], ['end'])
        self.assertTrue(any(item['logical_id'] == 'end_image' for item in result['receipt']))
        self.assertFalse(any(item['logical_id'] == 'start_image' for item in result['receipt']))

    def test_h3_own_role_order_and_other_custom_role_labels_are_preserved(self):
        for kind, roles, refs in (('h3_i2v', ['end', 'start'], ['last.png', 'first.png']),
                                  ('krea', ['scene', 'character'], ['first.png', 'style.png']),
                                  ('h3_ref', ['scene', 'character'], ['first.png', 'style.png'])):
            with self.subTest(kind=kind):
                _, info = case(kind)
                request = {'kind': kind, 'positive': 'Bird', 'reference_roles': roles, 'references': refs}
                executed = compile_workflow(request, info)
                request['models'] = executed['summary']['models']
                edited = build_preset_editor_recipe(request, info)
                self.assertEqual(edited['prompt'], executed['prompt'])
                self.assertEqual(edited['summary'], executed['summary'])
                self.assertEqual([inputs['image'] for _, inputs in typed(edited, 'LoadImage')], refs)
                self.assertEqual(edited['summary']['reference_roles'], roles)
                if kind == 'h3_i2v':
                    bindings = [item['logical_id'] for item in edited['receipt'] if item['type'] == 'image']
                    self.assertEqual(bindings, ['end_image', 'start_image'])

    def test_krea_empty_intended_reference_retains_edit_branch(self):
        _, info = case('krea')
        result = build_preset_editor_recipe({'kind': 'krea', 'positive': ''}, info,
                                            reference_slots=[slot('image_3', 2)])
        self.assertEqual(len(typed(result, 'Krea2OstrisEditModelPatch')), 1)
        encoder = typed(result, 'TextEncodeKrea2OstrisEdit')[0][1]
        self.assertTrue({'image1', 'image2', 'image3'} <= encoder.keys())
        self.assertEqual([inputs['image'] for _, inputs in typed(result, 'LoadImage')], ['', '', ''])

    def test_low_denoise_explicitly_intends_image_initialization_even_before_upload(self):
        for kind in ('sdxl', 'krea'):
            with self.subTest(kind=kind):
                _, info = case(kind)
                request = {'kind': kind, 'positive': '', 'denoise': .6}
                result = build_preset_editor_recipe(request, info)
                self.assertEqual(result['status'], 'materialized')
                self.assertEqual(typed(result, 'LoadImage')[0][1]['image'], '')
                self.assertEqual(len(typed(result, 'VAEEncode')), 1)
                self.assertTrue(any(item.get('logical_id') == 'image_1' for item in result['pending']))
                if kind == 'krea':
                    self.assertEqual(len(typed(result, 'Krea2OstrisEditModelPatch')), 1)
                with self.assertRaises(ValueError):
                    compile_workflow(request, info)

    def test_sdxl_image_initialization_and_refine_keep_holes(self):
        _, info = case('sdxl_full')
        result = build_preset_editor_recipe({'kind': 'sdxl_i2i', 'positive': '', 'denoise': .4,
                                            'refine': {'enabled': True}}, info)
        self.assertEqual(len(typed(result, 'VAEEncode')), 1)
        self.assertEqual(len(typed(result, 'LatentUpscale')), 1)
        self.assertEqual(len(typed(result, 'KSampler')), 2)
        receipt = {item['logical_id']: item for item in result['receipt']}
        self.assertEqual(len(receipt['seed']['targets']), 2)
        self.assertEqual(len(receipt['sampler']['targets']), 2)
        self.assertEqual(len(receipt['steps']['targets']), 1)
        self.assertEqual(len(receipt['refine.steps']['targets']), 1)

    def test_negative_intent_materializes_real_text_binding_without_connected_value(self):
        for kind in ('h3_t2v', 'krea'):
            with self.subTest(kind=kind):
                _, info = case(kind)
                request = {'kind': kind, 'positive': '', 'negative': ''}
                result = build_preset_editor_recipe(request, info, input_intents={'negative': True})
                receipt = {item['logical_id']: item for item in result['receipt']}
                target = receipt['negative']['targets'][0]
                self.assertEqual(result['prompt'][target['node_id']]['inputs'][target['input']], '')
                self.assertEqual(receipt['negative']['composition'], {'separator': ', ', 'own_position': 'last'})
                self.assertEqual(receipt['positive']['composition']['separator'], '\n\n')
                self.assertEqual(result['source_request'], request)

    def test_dual_clock_negative_intent_reports_unmapped_not_fake_binding(self):
        _, info = case('h3_t2v')
        result = build_preset_editor_recipe({'kind': 'h3_t2v', 'positive': '', 'sampler': 'dual_clock_euler'}, info,
                                            input_intents={'negative': True})
        self.assertEqual(result['status'], 'materialized')
        self.assertFalse(any(item['logical_id'] == 'negative' for item in result['receipt']))
        self.assertTrue(any(item['logical_id'] == 'negative' and item['code'] == 'unsupported_input' for item in result['pending']))

    def test_empty_sdxl_keys_do_not_enable_external_components(self):
        _, info = case('sdxl_full')
        request = {'kind': 'sdxl', 'positive': '', 'models': {'sdxl_clip_l': '', 'sdxl_clip_g': '', 'vae': ''}}
        embedded = build_preset_editor_recipe(request, info)
        self.assertFalse(typed(embedded, 'DualCLIPLoader'))
        self.assertFalse(typed(embedded, 'VAELoader'))
        explicit = build_preset_editor_recipe(request, info, model_intents={'sdxl_external_clip': True, 'independent_vae': True})
        self.assertEqual(typed(explicit, 'DualCLIPLoader')[0][1]['clip_name1'], '')
        self.assertEqual(typed(explicit, 'VAELoader')[0][1]['vae_name'], '')
        partial = build_preset_editor_recipe({**request, 'models': {'sdxl_clip_l': 'text_encoders/clip_l.safetensors'}}, info)
        self.assertEqual(typed(partial, 'DualCLIPLoader')[0][1]['clip_name2'], '')

    def test_empty_external_encoder_catalog_is_repairable_not_missing_topology(self):
        _, info = case('sdxl_full')
        for name in ('clip_name1', 'clip_name2'):
            info['DualCLIPLoader']['input']['required'][name][0] = []
        result = build_preset_editor_recipe({'kind': 'sdxl', 'positive': ''}, info, model_intents={'sdxl_external_clip': True})
        self.assertEqual(result['status'], 'materialized')
        self.assertTrue({'models.sdxl_clip_l', 'models.sdxl_clip_g'} <= {item.get('logical_id') for item in result['pending']})

    def test_schema_blocking_preserves_entire_source_and_topology_intents(self):
        _, info = case('qwen21_edit')
        del info['TextEncodeQwenImage21']
        request = {'kind': 'qwen21_edit', 'positive': '', 'references': ['', '', 'style.png'], 'custom_size': True, 'notes': {'retained': 'Own source'}}
        slots = [slot('image_3', 2)]
        result = build_preset_editor_recipe(request, info, reference_slots=slots, input_intents={'negative': True})
        self.assertEqual(result['status'], 'blocked')
        self.assertIsNone(result['prompt'])
        self.assertIsNone(result['summary'])
        self.assertEqual(result['receipt'], [])
        self.assertEqual(result['source_request'], request)
        self.assertEqual(result['intents']['reference_slots'], slots)
        self.assertEqual(result['intents']['input_intents'], {'negative': True})
        self.assertTrue(result['blocked'])

    def test_all_missing_required_graph_nodes_block_without_partial_prompt(self):
        for entry in GOLDEN['cases'][:8]:
            for class_type in {node['class_type'] for node in entry['expected']['prompt'].values()}:
                with self.subTest(kind=entry['name'], removed=class_type):
                    info = copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
                    del info[class_type]
                    request = copy.deepcopy(entry['request'])
                    request['models'] = entry['expected']['summary']['models']
                    result = build_preset_editor_recipe(request, info)
                    # H3 has an existing, explicitly declared alternative decoder.
                    if class_type in {'LTXVSeparateAVLatent', 'VAEDecodeAudio'}:
                        self.assertEqual(result['status'], 'blocked')  # fixture has no AV fallback
                    else:
                        self.assertEqual(result['status'], 'blocked')
                    self.assertIsNone(result['prompt'])
                    self.assertEqual(result['source_request'], request)

    def test_dynamic_names_and_capacity_are_proven_from_schema(self):
        for kind, node, group, field in (('qwen21_edit', 'TextEncodeQwenImage21', 'required', 'images'),
                                        ('h3_ref', 'MiniMaxH3ReferenceToVideo', 'optional', 'ref_images')):
            for template in ({'names': ['same', 'same']}, {'max': '9', 'prefix': 'r_'}, {'max': 9}, {'names': []}):
                with self.subTest(kind=kind, template=template):
                    _, info = case(kind)
                    info[node]['input'][group][field][1]['template'].update(template)
                    if 'max' in template:
                        info[node]['input'][group][field][1]['template'].pop('names', None)
                    if 'prefix' not in template and 'max' in template:
                        info[node]['input'][group][field][1]['template'].pop('prefix', None)
                    result = build_preset_editor_recipe({'kind': kind, 'positive': ''}, info)
                    self.assertEqual(result['status'], 'blocked')
                    self.assertIsNone(result['prompt'])

    def test_malformed_used_schema_is_blocked_and_unused_schema_does_not_select_resources(self):
        for kind, name, replacement in (('sdxl', 'CheckpointLoaderSimple', None),
                                        ('h3_t2v', 'MiniMaxH3ImageToVideo', {'input': []}),
                                        ('qwen21_edit', 'TextEncodeQwenImage21', {'input': {}, 'output': None}),
                                        ('h3_t2v', 'SaveVideo', {'input': {'required': None}, 'output': []})):
            with self.subTest(kind=kind, name=name):
                _, info = case(kind)
                info[name] = replacement
                result = build_preset_editor_recipe({'kind': kind, 'positive': ''}, info)
                self.assertEqual(result['status'], 'blocked')
                self.assertIsNone(result['prompt'])
        _, info = case('sdxl')
        info['UNETLoader'] = None
        result = build_preset_editor_recipe({'kind': 'sdxl', 'positive': ''}, info)
        self.assertEqual(result['status'], 'materialized')
        self.assertEqual(result['summary']['models']['checkpoint'], '')

    def test_receipts_have_only_unique_real_literal_targets_and_correct_fanout(self):
        for entry in GOLDEN['cases']:
            with self.subTest(name=entry['name']):
                info = copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
                request = {**entry['request'], 'models': entry['expected']['summary']['models']}
                result = build_preset_editor_recipe(request, info)
                targets = []
                for item in result['receipt']:
                    self.assertTrue(item['targets'])
                    for target in item['targets']:
                        value = result['prompt'][target['node_id']]['inputs'][target['input']]
                        self.assertNotIsInstance(value, list)
                        targets.append((target['node_id'], target['input']))
                self.assertEqual(len(targets), len(set(targets)))

    def test_empty_lora_is_not_deleted_and_unknown_quantization_is_blocked(self):
        _, info = case('sdxl')
        result = build_preset_editor_recipe({'kind': 'sdxl', 'positive': '', 'loras': [{'name': '', 'strength_model': .7, 'strength_clip': .2}]}, info)
        self.assertEqual(typed(result, 'LoraLoader')[0][1]['lora_name'], '')
        self.assertTrue(any(item.get('logical_id') == 'loras.0.name' for item in result['pending']))
        _, info = case('krea')
        request = {'kind': 'krea', 'positive': '', 'loras': [{'name': 'loras/turbo.safetensors'}]}
        result = build_preset_editor_recipe(request, info)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['source_request'], request)

    def test_refine_schema_and_branch_are_not_silently_disabled(self):
        _, info = case('sdxl_full')
        del info['LatentUpscale']
        request = {'kind': 'sdxl', 'positive': '', 'refine': {'enabled': True, 'width': 2048, 'height': 1536}}
        result = build_preset_editor_recipe(request, info)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['source_request']['refine'], request['refine'])
        with self.assertRaises(ValueError):
            build_preset_editor_recipe({**request, 'refine': {'enabled': True, 'width': 2049}}, info)

    def test_explicit_empty_refine_method_is_preserved_as_blocked_without_algorithm_guess(self):
        _, info = case('sdxl_full')
        request = {'kind': 'sdxl', 'positive': 'Bird', 'refine': {'enabled': True, 'upscale_method': ''}}
        result = build_preset_editor_recipe(request, info)
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(result['source_request'], request)
        self.assertIsNone(result['prompt'])
        self.assertIn('未代选算法', result['blocked'][0]['message'])
        with self.assertRaises(ValueError):
            compile_workflow(request, info)

    def test_source_request_inputs_schemas_and_intents_are_not_mutated(self):
        _, info = case('qwen21_edit')
        request = {'kind': 'qwen21_edit', 'positive': '', 'references': ['']}
        slots = [slot('image_3', 2)]
        before = copy.deepcopy((request, info, slots))
        result = build_preset_editor_recipe(request, info, reference_slots=slots)
        self.assertEqual((request, info, slots), before)
        result['source_request']['references'][0] = 'changed.png'
        result['intents']['reference_slots'][0]['port_id'] = 'changed'
        self.assertEqual((request, info, slots), before)

    def test_unsafe_paths_numeric_text_and_model_roles_remain_rejected(self):
        _, info = case('sdxl_full')
        invalid = [{'models': {'checkpoint': 'C:/private/model.safetensors'}}, {'references': ['../bad.png']},
                   {'models': {'checkpoint': 1}}, {'width': 1025}, {'positive': True}, {'seed': 2**53},
                   {'models': {'unknown': ''}}, {'sampler': 'not-a-sampler'}, {'positive': 'x' * 100001},
                   {'loras': [{'name': '', 'strength_model': float('nan')}]},
                   {'references': [None]}]
        for values in invalid:
            with self.subTest(values=str(values)[:90]), self.assertRaises(ValueError):
                build_preset_editor_recipe({'kind': 'sdxl', 'positive': '', **values}, info)
        with self.assertRaises(ValueError):
            build_preset_editor_recipe({'kind': 'api', 'prompt': {}}, info)

    def test_slot_intent_and_model_intent_contract_is_strict(self):
        _, info = case('qwen21_edit')
        bad_slots = [[{**slot('image_1', 0), 'value': 'connected.png'}], [slot('image_1', 0), slot('image_1', 0)],
                     [slot('image_2', 0)], [slot('image_11', 10)], [slot('image_1', 0, 'scene')],
                     [{**slot('image_1', 0), 'index': True}]]
        for slots in bad_slots:
            with self.subTest(slots=slots), self.assertRaises(ValueError):
                build_preset_editor_recipe({'kind': 'qwen21_edit'}, info, reference_slots=slots)
        for kwargs in ({'input_intents': {'negative': 1}}, {'model_intents': {'other': True}},
                       {'model_intents': {'sdxl_external_clip': True}}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                build_preset_editor_recipe({'kind': 'qwen21_edit'}, info, **kwargs)

    def test_full_editor_response_has_hard_two_mib_budget(self):
        _, info = case('sdxl')
        with self.assertRaisesRegex(ValueError, '2 MiB'):
            build_preset_editor_recipe({'kind': 'sdxl', 'positive': '', 'private_note': 'x' * (2 * 1024 * 1024)}, info)
        request = {'kind': 'sdxl', 'positive': '', 'private_note': 'x' * (2 * 1024 * 1024 - 120)}
        with self.assertRaisesRegex(ValueError, '2 MiB'):
            build_preset_editor_recipe(request, info)


if __name__ == '__main__':
    unittest.main()
