"""Own-value recipe preparation reads schema but never creates drafts or jobs."""
import copy
import unittest
from unittest.mock import patch

from frameweave.backend import BackendError
import test_editor_preparation_http as preparation_tests
from test_preset_editor_recipe import GOLDEN, case


class PresetPreparationHTTPTests(unittest.TestCase):
    setUp = preparation_tests.EditorPreparationHTTPTests.setUp
    stop_client = preparation_tests.EditorPreparationHTTPTests.stop_client
    request = preparation_tests.EditorPreparationHTTPTests.request
    post = preparation_tests.EditorPreparationHTTPTests.post
    prepare = preparation_tests.EditorPreparationHTTPTests.prepare
    assert_read_only = preparation_tests.EditorPreparationHTTPTests.assert_read_only

    def test_all_empty_presets_prepare_full_own_source_and_real_field_receipts(self):
        for entry in GOLDEN['cases'][:8]:
            with self.subTest(kind=entry['name']):
                self.backend.info = copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
                own = {'kind': entry['name'], 'positive': ''}
                status, _, result = self.prepare(preset_request=own)
                self.assertEqual(status, 200, result)
                self.assertEqual(result['source_request'], own)
                self.assertEqual(result['source_kind'], 'preset')
                self.assertEqual(result['status'], 'unverified')
                self.assertEqual(result['source_document']['prompt'], result['prompt'])
                self.assertTrue(result['pending'])
                self.assertTrue(result['receipt_complete'], result['diagnostics'])
                by_id = {field['id']: field for field in result['fields']}
                for item in result['receipt']:
                    for target in item['targets']:
                        field = by_id[target['field_id']]
                        for key in ('node_id', 'input', 'type'):
                            self.assertEqual(target[key], field[key])
        self.assert_read_only()

    def test_schema_unavailable_or_missing_loader_retains_request_and_intents_without_partial_graph(self):
        _, self.backend.info = case('sdxl')
        own = {'kind':'sdxl_i2i','positive':'','models':{'checkpoint':'old.safetensors'}}
        slots = [{'port_id':'image_1','index':0,'ordinal':1,'role':'reference'}]
        for offline in (True, False):
            if not offline:
                self.backend.info.pop('CheckpointLoaderSimple')
            context = patch.object(self.app, '_object_info_for_backend', side_effect=BackendError('offline')) if offline else patch.object(self.app, '_object_info_for_backend', return_value=self.backend.info)
            with context:
                status, _, result = self.prepare(preset_request=own, reference_slots=slots)
            self.assertEqual(status, 200, result)
            self.assertEqual(result['status'],'blocked')
            self.assertEqual(result['source_request'],own)
            self.assertEqual(result['intents']['reference_slots'],slots)
            self.assertIsNone(result['prompt'])
            self.assertIsNone(result['source_document'])
        self.assert_read_only()

    def test_reference_slot_holes_and_pending_binding_do_not_upload_or_guess_images(self):
        _, self.backend.info = case('qwen21_edit')
        own = {'kind':'qwen21_edit','positive':''}
        status, _, result = self.prepare(preset_request=own,
            reference_slots=[{'port_id':'image_3','index':2,'ordinal':3,'role':'reference'}],
            pending=[{'logical_id':'image_3','reason':'local_only','edge_id':'edge3','origin':'connected'}])
        self.assertEqual(status,200,result)
        refs = [row for row in result['receipt'] if row['type']=='image']
        self.assertEqual([row['logical_id'] for row in refs],['image_1','image_2','image_3'])
        target=refs[-1]['targets'][0]
        self.assertEqual(result['source_document']['prompt'][target['node_id']]['inputs'][target['input']],'')
        self.assertTrue(any(item.get('edge_id')=='edge3' and item.get('field_id')==target['field_id'] for item in result['pending']))
        self.assert_read_only()

    def test_preset_carriers_and_intents_are_exclusive_and_require_csrf(self):
        own={'kind':'sdxl','positive':''}
        for other in ({'document':{}},{'source_json':'{}'},{'fields':[]},{'package_id':''}):
            self.assertEqual(self.prepare(preset_request=own,**other)[0],400)
        self.assertEqual(self.prepare(document={'prompt':{}},input_intents={'negative':True})[0],400)
        self.assertEqual(self.post('/api/editor-prepare',{'preset_request':own},csrf=False)[0],403)
        self.assert_read_only()

    def test_backend_switch_during_preset_probe_rejects_without_side_effect(self):
        prior=self.app.backend
        def switch(_):
            self.app.backend=copy.copy(prior)
            return self.backend.info
        with patch.object(self.app,'_object_info_for_backend',side_effect=switch):
            status,_,_=self.prepare(preset_request={'kind':'sdxl','positive':''})
        self.app.backend=prior
        self.assertEqual(status,400)
        self.assert_read_only()

    def test_materialized_empty_recipe_can_establish_outer_fields_without_execution_readiness(self):
        for entry in GOLDEN['cases'][:8]:
            self.backend.info=copy.deepcopy(GOLDEN['schemas'][entry['schema_id']])
            status,_,prepared=self.prepare(preset_request={'kind':entry['name'],'positive':''})
            self.assertEqual(status,200,prepared)
            status,_,result=self.post('/api/interfaces/apply', {'prompt':prepared['source_document']['prompt'],
                'fields':prepared['fields'],'output_nodes':[item['id'] for item in prepared['outputs']],
                'backend_url':self.backend.url,'name':entry['name']})
            self.assertEqual(status,200,result)
            self.assertTrue(result['readiness']['issues'])
            self.assertEqual(len(result['package']['fields']),len(prepared['fields']))
            self.assertEqual(result['values'],{field['id']:prepared['source_document']['prompt'][field['node_id']]['inputs'][field['input']] for field in prepared['fields']})
        self.assertEqual(self.backend.next_id,0)
        self.assertFalse(any(method!='GET' for method,*_ in self.backend.calls))

if __name__=='__main__':
    unittest.main()
