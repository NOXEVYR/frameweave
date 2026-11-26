"""Unavailable static enums preserve editing data, never execution authority."""
import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

from frameweave.editor_interfaces import inspect_interface, reconcile_interface
from frameweave.editor_preparation import prepare_editor_document
from frameweave.packages import (PackageStore, apply_editor_values, apply_planning_values,
    apply_values, encoded, inspect_document, normalize_document, validate_planning_fields, validate_value)
from frameweave.preset_editor_preparation import prepare_preset_editor
from frameweave.workflows import validate_editor_prompt, validate_prompt
from test_preset_editor_recipe import case


def fixture(value='', combo=False):
    spec = ['COMBO', {'options': []}] if combo else [[]]
    info = {'Model': {'input': {'required': {'model': spec}}, 'output': ['IMAGE']},
            'Image': {'input': {'required': {}}, 'output': ['IMAGE']},
            'SaveImage': {'input': {'required': {'images': ['IMAGE']}}, 'output': [], 'output_node': True}}
    prompt = {'1': {'class_type': 'Model', 'inputs': {'model': value}, '_meta': {'preserve': True}},
              '2': {'class_type': 'SaveImage', 'inputs': {'images': ['1', 0]}},
              '3': {'class_type': 'Image', 'inputs': {}},
              '4': {'class_type': 'SaveImage', 'inputs': {'images': ['3', 0]}}}
    field = {'id': 'model', 'label': 'Model', 'type': 'select', 'node_id': '1', 'input': 'model', 'options': []}
    return {'name': 'Missing model', 'prompt': prompt, 'fields': [field]}, info


class EmptyEnumEditingTests(unittest.TestCase):
    def test_static_list_and_combo_preserve_type_literal_and_no_synthetic_option(self):
        for combo in (False, True):
            for value in ('', 'old.safetensors', 0, False, 1.5):
                document, info = fixture(value, combo)
                before = copy.deepcopy(document)
                candidate = inspect_interface(document['prompt'], info)['fields'][0]
                self.assertEqual((candidate['type'], candidate['options'], candidate['default']), ('select', [], value))
                normalized = normalize_document({**document, 'fields': [candidate]})
                self.assertEqual(normalized['fields'][0]['default'], value)
                self.assertEqual(apply_editor_values(normalized, {})['1']['inputs']['model'], value)
                self.assertEqual(document, before)

    def test_empty_default_must_be_same_actual_source_literal(self):
        document, _ = fixture('old.safetensors')
        for default in ('', 'first.safetensors', False):
            with self.subTest(default=default), self.assertRaisesRegex(ValueError, '原始节点字面值'):
                normalize_document({**document, 'fields': [{**document['fields'][0], 'default': default}]})

    def test_preservation_is_explicit_and_does_not_relax_template_membership(self):
        document, _ = fixture()
        field = document['fields'][0]
        for value in ('', 'old', False, 0):
            with self.assertRaises(ValueError):
                validate_value(field, value, template=True)
            self.assertEqual(validate_value(field, value, editing_enum_preservation=True), value)
        with self.assertRaises(ValueError):
            apply_values(document, {})

    def test_preservation_never_accepts_unsafe_scalar_or_bypasses_other_types(self):
        document, _ = fixture()
        for value in (None, [], {}, 2**53, float('nan'), float('inf'), 'x' * 64001):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(ValueError):
                validate_value(document['fields'][0], value, editing_enum_preservation=True)
        for field, value in [({'type':'image','label':'Image'}, '../escape.png'),
                             ({'type':'integer','label':'Steps','max':4}, 5),
                             ({'type':'boolean','label':'Bool'}, 0),
                             ({'type':'select','label':'Model','options':[],'role':'model'}, '../escape.safetensors')]:
            with self.assertRaises(ValueError):
                validate_value(field, value, editing_enum_preservation=True)

    def test_empty_inspection_rejects_unsafe_original_literal(self):
        document, info = fixture('x' * 64001)
        with self.assertRaises(ValueError):
            inspect_interface(document['prompt'], info)

    def test_preserved_literal_length_is_separate_from_option_member_budget(self):
        document, info = fixture('x' * 64000)
        field = inspect_document(document, info)['fields'][0]
        self.assertEqual(len(normalize_document({**document, 'fields':[field]})['fields'][0]['default']),64000)
        document['fields'][0]['options'] = ['x' * 2049]
        with self.assertRaises(ValueError):
            normalize_document(document)

    def test_empty_dynamic_selector_keeps_source_unverified_without_inventing_branch(self):
        document, info = fixture('unresolved')
        info['Model']['input']['required']['model'] = ['COMFY_DYNAMICCOMBO_V3', {'options':[]}]
        result = prepare_editor_document(document, source_kind='package', info=info)
        self.assertEqual(result['source_document'],document)
        self.assertEqual(result['prompt'],document['prompt'])
        self.assertEqual(result['overrides'],[])
        self.assertTrue(any(item['code']=='source_value_unverified' for item in result['diagnostics']))
        self.assertFalse(any(item.get('reason')=='enum_unavailable' for item in result['pending']))
        with self.assertRaises(ValueError):
            inspect_interface(document['prompt'],info)

    def test_unknown_static_empty_combo_and_choice_are_editable_issues_but_not_executable(self):
        for combo in (False, True):
            document, info = fixture('unresolved', combo)
            readiness = validate_editor_prompt(document['prompt'], info)
            self.assertEqual(readiness['issues'][0]['code'],'enum_unavailable')
            with self.assertRaises(ValueError):
                validate_prompt(document['prompt'],info)
        prompt = {'x': {'class_type':'CustomChoice','inputs':{'choice':False}}}
        info = {'CustomChoice':{'input':{'required':{'choice':[[]]}},'output':[]}}
        self.assertEqual(validate_editor_prompt(prompt,info)['issues'][0]['code'],'enum_unavailable')
        with self.assertRaises(ValueError):
            validate_prompt(prompt,info)

    def test_empty_preservation_does_not_relax_dynamic_multiselect_forceinput_or_resource_paths(self):
        for meta in ({'multiselect':True},{'forceInput':True},{'rawLink':True}):
            document, info = fixture('invalid')
            info['Model']['input']['required']['model'] = ['COMBO', {'options':[], **meta}]
            with self.subTest(meta=meta), self.assertRaises(ValueError):
                validate_editor_prompt(document['prompt'],info)
        document, info = fixture()
        node = document['prompt']['1']
        node['inputs'] = {'ckpt_name':'../outside.safetensors'}
        info['Model']['input']['required'] = {'ckpt_name':[[]]}
        with self.assertRaises(ValueError):
            validate_editor_prompt(document['prompt'],info)
        node['inputs']['ckpt_name'] = False
        with self.assertRaises(ValueError):
            validate_editor_prompt(document['prompt'],info)

    def test_prepare_keeps_source_and_reports_field_pending_without_overlay(self):
        for combo in (False, True):
            document, info = fixture('old.safetensors', combo)
            result = prepare_editor_document(document, source_kind='package', info=info)
            self.assertEqual(result['source_document'], document)
            self.assertEqual(result['prompt'], document['prompt'])
            self.assertEqual(result['overrides'], [])
            self.assertTrue(any(item.get('field_id') == 'model' and item['reason'] == 'enum_unavailable'
                                for item in result['pending']))

    def test_new_invalid_enum_override_is_pending_never_applied_even_if_catalog_empty(self):
        document, info = fixture('OWN')
        for value in ('NEW', 'OWN'):
            result = prepare_editor_document(document, source_kind='package', info=info,
                overrides=[{'field_id':'model','value':value,'origin':'outer'}])
            self.assertEqual(result['prompt'], document['prompt'])
            self.assertEqual(result['overrides'], [])
            self.assertTrue(any(item.get('value') == value and item['reason'] == 'enum_unavailable'
                                for item in result['pending']))

    def test_catalog_recovery_accepts_only_a_live_option_and_keeps_source_identity(self):
        document, info = fixture('OLD')
        info['Model']['input']['required']['model'][0] = ['NEW']
        fields = inspect_interface(document['prompt'], info)['fields']
        field = fields[0]
        self.assertEqual(field['options'], ['OLD', 'NEW'], 'historical nonempty stale inspection stays unchanged')
        result = prepare_editor_document({'prompt': document['prompt']}, fields=fields, info=info,
            overrides=[{'field_id':field['id'],'value':'NEW'}])
        self.assertEqual(result['prompt']['1']['inputs']['model'], 'NEW')
        self.assertEqual(result['source_document']['prompt']['1']['inputs']['model'], 'OLD')
        self.assertEqual(len(result['overrides']), 1)
        blocked = prepare_editor_document({'prompt': document['prompt']}, fields=fields, info=info,
            overrides=[{'field_id':field['id'],'value':'OLD'}])
        self.assertEqual(blocked['overrides'], [])
        self.assertTrue(blocked['pending'])

    def test_reconcile_empty_directory_retains_outer_and_three_way_conflicts(self):
        document, info = fixture('INNER')
        field = inspect_interface(document['prompt'], info)['fields'][0]
        old = {**field, 'default': 'BASE'}
        result = reconcile_interface([old], {field['id']:'OUTER'}, [field], document['prompt'], {field['id']:'BASE'})
        self.assertEqual(result['changes']['invalid_value'], [])
        self.assertEqual(result['changes']['conflicts'][0].get('allowed', ['outer', 'inner']), ['outer', 'inner'])
        unchanged = reconcile_interface([old], {field['id']:'BASE'}, [field], document['prompt'], {field['id']:'BASE'})
        self.assertEqual(unchanged['values'][field['id']], 'INNER')

    def test_planning_builds_closure_but_active_fresh_empty_enum_is_rejected(self):
        document, info = fixture()
        prompt = apply_planning_values(document, {})
        with self.assertRaisesRegex(ValueError, '当前后端可选值'):
            validate_planning_fields(document['fields'], prompt, info, {'1', '2'})
        validate_planning_fields(document['fields'], prompt, info, {'3', '4'})
        self.assertEqual(apply_values(document, {}, active_nodes={'3','4'})['1']['inputs']['model'], '')
        with self.assertRaises(ValueError):
            apply_values(document, {}, active_nodes={'1','2'})

    def test_inactive_nonempty_enum_forgery_remains_rejected(self):
        document, _ = fixture('GOOD')
        document['fields'][0]['options'] = ['GOOD']
        for function in (apply_editor_values, apply_planning_values):
            with self.assertRaises(ValueError):
                function(document, {'model':'FORGED'})
        with self.assertRaises(ValueError):
            apply_values(document, {'model':'FORGED'}, active_nodes={'3','4'})

    def test_full_store_read_export_import_preserves_raw_bytes_and_content_id(self):
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory))
            document, _ = fixture('old.safetensors')
            saved = store.save(document)
            raw = store._path(saved['id']).read_bytes()
            self.assertEqual(store.get(saved['id'])['fields'][0]['options'], [])
            self.assertEqual(store.save(store.export(saved['id']))['id'], saved['id'])
            self.assertEqual(store._path(saved['id']).read_bytes(), raw)

    def test_nonempty_old_document_has_exact_normalized_shape_and_hash(self):
        document = {'name':'Old','prompt':{'1':{'class_type':'Node','inputs':{'model':'old'}}},
            'fields':[{'id':'model','node_id':'1','input':'model','label':'Model','type':'select','options':['old','new']}]}
        expected = {'format':'frameweave-workflow','version':1,'name':'Old','description':'',
            'prompt':document['prompt'], 'fields':[dict(document['fields'][0], required=False, default='old')]}
        self.assertEqual(normalize_document(document), expected)
        with tempfile.TemporaryDirectory() as directory:
            store = PackageStore(Path(directory))
            saved = store.save(document)
            self.assertEqual(saved['id'], 'p-' + hashlib.sha256(encoded(expected)).hexdigest()[:24])
            self.assertEqual(store._path(saved['id']).read_bytes(), encoded(expected))

    def test_preset_empty_model_has_proven_real_select_receipt_and_pending(self):
        entry, info = case('sdxl')
        info['CheckpointLoaderSimple']['input']['required']['ckpt_name'][0] = []
        own = {'kind':'sdxl','positive':'','models':{'checkpoint':''}}
        result = prepare_preset_editor({'preset_request':own}, info=info, backend_url='http://127.0.0.1:8188')
        self.assertTrue(result['receipt_complete'])
        target = next(item for item in result['receipt'] if item['logical_id']=='models.checkpoint')['targets'][0]
        field = next(field for field in result['fields'] if field['id']==target['field_id'])
        self.assertEqual((field['type'],field['options'],field['default']), ('select',[],''))
        self.assertTrue(any(item.get('field_id')==field['id'] and item['reason']=='enum_unavailable' for item in result['pending']))
        self.assertEqual(result['source_request'], own)


if __name__ == '__main__':
    unittest.main()
