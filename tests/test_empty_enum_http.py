"""Real temporary HTTP routes keep empty-enum edits and reject execution."""
import copy
import json
import unittest

import test_editor_integration as native_tests
from test_empty_enum_editing import fixture
from test_preset_editor_recipe import case


class EmptyEnumHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def prepare(self, **kwargs):
        return self.post('/api/editor-prepare', {'backend_url': self.backend.url, **kwargs})

    def assert_no_jobs(self):
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(method != 'GET' for method, *_ in self.backend.calls))

    def saved(self, combo=False):
        document, self.backend.info = fixture('old.safetensors', combo)
        status, _, inspection = self.post('/api/interfaces/inspect', {'document': document})
        self.assertEqual(status, 200, inspection)
        field = next(field for field in inspection['fields'] if field['node_id']=='1')
        self.assertEqual((field['type'],field['options']), ('select',[]))
        status, _, result = self.post('/api/interfaces/apply', {'prompt':document['prompt'],
            'fields':inspection['fields'],'output_nodes':['2','4'],'backend_url':self.backend.url,'name':'Empty enum'})
        self.assertEqual(status,200,result)
        self.assertTrue(result['readiness']['issues'])
        self.assertEqual(result['values'][field['id']], 'old.safetensors')
        return result, field

    def test_static_empty_package_roundtrip_prepare_and_export_leave_exact_bytes(self):
        for combo in (False, True):
            applied, field = self.saved(combo)
            package_id = applied['package']['id']
            path = self.app.packages._path(package_id)
            before = path.read_bytes()
            status, _, detail = self.request('GET', '/api/packages/' + package_id)
            self.assertEqual(status,200)
            self.assertEqual(json.loads(detail)['package']['fields'][0]['options'], [])
            status, _, result = self.prepare(package_id=package_id)
            self.assertEqual(status,200,result)
            self.assertEqual(result['source_revision'],package_id)
            self.assertTrue(any(item.get('field_id')==field['id'] and item['reason']=='enum_unavailable' for item in result['pending']))
            status, _, exported = self.post(f'/api/packages/{package_id}/export')
            self.assertEqual(status,200,exported)
            status, _, imported = self.post('/api/packages', {'source_json':exported['source_json']})
            self.assertEqual(status,200,imported)
            self.assertEqual(imported['package']['id'],package_id)
            self.assertEqual(path.read_bytes(),before)
        self.assert_no_jobs()

    def test_active_compile_and_plan_reject_but_other_output_with_empty_island_works(self):
        applied, field = self.saved()
        request = {'kind':'package','package_id':applied['package']['id'],'values':applied['values']}
        for outputs, expected in [(['2'],400), (['4'],200)]:
            request['output_nodes']=outputs
            status, _, plan = self.post('/api/execution-plan', {'backend_url':self.backend.url,'request':request})
            self.assertEqual(status,expected,plan)
            status, _, compiled = self.post('/api/compile',request)
            self.assertEqual(status,expected,compiled)
            if expected==200:
                self.assertEqual(set(compiled['prompt']),{'3','4'})
                self.assertNotIn(field['id'],plan['execution']['active_field_ids'])
        self.assert_no_jobs()

    def test_preset_empty_model_encoder_lora_still_receipts_and_binds_without_execution(self):
        names = {'ckpt_name','unet_name','clip_name','clip_name1','clip_name2','vae_name','lora_name'}
        for name in ('sdxl', 'krea', 'qwen21_t2i', 'h3_t2v'):
            _, self.backend.info = case(name)
            for schema in self.backend.info.values():
                for group in ('required','optional'):
                    for key, spec in schema.get('input',{}).get(group,{}).items():
                        if key in names and isinstance(spec,list) and isinstance(spec[0],list):
                            spec[0]=[]
            own={'kind':name,'positive':'OWN'}
            status, _, prepared=self.prepare(preset_request=own)
            self.assertEqual(status,200,prepared)
            self.assertTrue(prepared['receipt_complete'],prepared['diagnostics'])
            empty = [field for field in prepared['fields'] if field['type']=='select' and field['options']==[]]
            self.assertTrue(empty)
            self.assertTrue(any(item.get('reason')=='enum_unavailable' for item in prepared['pending']))
            status, _, applied = self.post('/api/interfaces/apply', {'prompt':prepared['source_document']['prompt'],
                'fields':prepared['fields'],'output_nodes':[item['id'] for item in prepared['outputs']],
                'backend_url':self.backend.url,'name':name})
            self.assertEqual(status,200,applied)
            self.assertTrue(applied['readiness']['issues'])
            status, _, reopened=self.prepare(package_id=applied['package']['id'])
            self.assertEqual(status,200,reopened)
            self.assertEqual(reopened['source_document']['prompt'],applied['package']['prompt'])
        self.assert_no_jobs()

    def test_invalid_external_value_is_pending_and_original_store_is_untouched(self):
        applied, field=self.saved()
        package_id=applied['package']['id']
        before=self.app.packages._path(package_id).read_bytes()
        status, _, result=self.prepare(package_id=package_id, overrides=[{'field_id':field['id'],'value':'NEW','origin':'outer'}])
        self.assertEqual(status,200,result)
        self.assertEqual(result['overrides'],[])
        self.assertEqual(result['prompt']['1']['inputs']['model'],'old.safetensors')
        self.assertTrue(any(item.get('value')=='NEW' and item['reason']=='enum_unavailable' for item in result['pending']))
        self.assertEqual(self.app.packages._path(package_id).read_bytes(),before)
        self.assert_no_jobs()

    def test_catalog_recovery_rebinds_same_field_and_fresh_execution_checks_current_options(self):
        applied, old=self.saved()
        self.backend.info['Model']['input']['required']['model'][0]=['new.safetensors']
        package_id=applied['package']['id']
        status, _, inspection=self.post('/api/interfaces/inspect', {'package_id':package_id,'previous_package_id':package_id})
        self.assertEqual(status,200,inspection)
        current=next(field for field in inspection['fields'] if field['node_id']=='1')
        self.assertEqual(current['id'],old['id'])
        self.assertEqual(current['type'],'select')
        status, _, result=self.prepare(package_id=package_id,overrides=[{'field_id':old['id'],'value':'new.safetensors'}])
        self.assertEqual(status,200,result)
        # An old empty snapshot cannot authorize a new option by itself. The
        # user must refresh/reapply the interface after the live catalog changes.
        self.assertEqual(result['overrides'],[])
        selected = copy.deepcopy(inspection['prompt'])
        selected['1']['inputs']['model'] = 'new.safetensors'
        status, _, refreshed=self.post('/api/interfaces/apply', {'prompt':selected,'fields':inspection['fields'],
            'previous_package_id':package_id,'previous_values':applied['values'],'previous_baseline':applied['baseline'],
            'resolutions':{old['id']:'inner'},
            'output_nodes':['2'],'backend_url':self.backend.url,'name':'Refreshed'})
        self.assertEqual(status,200,refreshed)
        self.assertFalse(refreshed.get('requires_resolution'))
        request={'kind':'package','package_id':refreshed['package']['id'],'output_nodes':['2'],'values':{old['id']:'new.safetensors'}}
        self.assertEqual(self.post('/api/compile',request)[0],200)
        request['values'][old['id']]='old.safetensors'
        self.assertEqual(self.post('/api/compile',request)[0],400)
        self.assert_no_jobs()


if __name__ == '__main__':
    unittest.main()
