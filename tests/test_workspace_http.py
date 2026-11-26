"""Local workspace API boundaries; all media and engines are synthetic."""
import base64
import io
import json
import wave
import unittest
from unittest.mock import patch
import test_service as fixture
from frameweave.packages import inspect_document, normalize_document, apply_values


class WorkspaceHTTPTests(unittest.TestCase):
    setUp = fixture.ServiceHTTPTests.setUp
    start_client = fixture.ServiceHTTPTests.start_client
    stop_client = fixture.ServiceHTTPTests.stop_client
    request = fixture.ServiceHTTPTests.request
    post = fixture.ServiceHTTPTests.post

    def test_canvas_snapshot_round_trip_and_csrf(self):
        document = {'schema':'prismcanvas.project.v1','version':1,'name':'我的测试画布',
                    'canvas':{'nodes':[],'edges':[]},'packages':[]}
        self.assertEqual(self.post('/api/canvases', {'document':document}, csrf=False)[0],403)
        status, _, saved = self.post('/api/canvases', {'document':document})
        self.assertEqual(status,200)
        status, _, raw = self.request('GET', '/api/canvases/'+saved['id'])
        self.assertEqual(json.loads(raw)['document'],document)
        status, _, raw = self.request('GET','/api/canvases')
        self.assertEqual(json.loads(raw)['total'],1)
        self.assertEqual(self.backend.next_id,0)

    def test_audio_upload_safe_name_and_invalid_header(self):
        stream=io.BytesIO()
        with wave.open(stream,'wb') as out:
            out.setnchannels(1);out.setsampwidth(2);out.setframerate(8000);out.writeframes(b'\0'*160)
        with patch.object(self.app.backend,'upload', return_value={'name':'reference.wav','type':'input'}) as upload:
            code, _, response=self.post('/api/upload-audio',{'data':base64.b64encode(stream.getvalue()).decode()})
            self.assertEqual(code,200);self.assertEqual(response['name'],'reference.wav')
            self.assertTrue(upload.call_args.args[0].endswith('.wav'))
            self.assertEqual(upload.call_args.args[2],'audio/wav')
        self.assertEqual(self.post('/api/upload-audio',{'data':base64.b64encode(b'MZ'+b'0'*100).decode()})[0],400)
        self.assertEqual(self.post('/api/upload-audio',{'data':'not base64!'})[0],400)
        self.assertEqual(self.post('/api/upload-audio',{},csrf=False)[0],403)

    def test_audio_path_rejection_and_result_ownership(self):
        stream=io.BytesIO()
        with wave.open(stream,'wb') as writer:
            writer.setnchannels(1);writer.setsampwidth(2);writer.setframerate(8000);writer.writeframes(b'\0'*160)
        raw=stream.getvalue()
        with patch.object(self.app.backend,'upload',return_value={'name':'../bad.wav','type':'input'}) as upload:
            self.assertEqual(self.post('/api/upload-audio',{'data':base64.b64encode(raw).decode()})[0],400)
            upload.assert_called_once()
        self.assertEqual(self.post('/api/jobs/not-owned/output-location',{'index':0})[0],400)

    def test_job_list_retains_only_validated_loopback_backend_identity(self):
        self.app.jobs['ours']={'id':'ours','status':'completed','backend':self.backend.url,'outputs':[]}
        self.app.jobs['bad']={'id':'bad','status':'completed','backend':'http://user:secret@example.com','outputs':[]}
        status,_,raw=self.request('GET','/api/jobs')
        jobs={job['id']:job for job in json.loads(raw)['jobs']}
        self.assertEqual(status,200)
        self.assertEqual(jobs['ours']['backend'],self.backend.url)
        self.assertNotIn('backend',jobs['bad'])

    def test_performance_settings_and_read_only_plan(self):
        self.assertEqual(self.post('/api/settings',{'backend_url':self.backend.url,'performance_profile':'16'})[0],200)
        status,_,raw=self.request('GET','/api/performance-plan')
        self.assertEqual(status,200);self.assertEqual(json.loads(raw)['profile'],'16')
        self.assertEqual(self.post('/api/settings',{'backend_url':self.backend.url,'performance_profile':'unsafe'})[0],400)

    def test_audio_fields_clear_private_reference_and_reject_traversal(self):
        info={'LoadAudio':{'input':{'required':{'audio':[['private.wav'],{'audio_upload':True}]}},'output':['AUDIO']}}
        inspected=inspect_document({'1':{'class_type':'LoadAudio','inputs':{'audio':'private.wav'}}},info)
        field=inspected['fields'][0];self.assertEqual(field['type'],'audio');self.assertEqual(field['default'],'')
        pack=normalize_document(inspected)
        with self.assertRaises(ValueError): apply_values(pack,{field['id']:'../private.wav'})
        self.assertEqual(apply_values(pack,{field['id']:'reference.wav'})['1']['inputs']['audio'],'reference.wav')


if __name__ == '__main__': unittest.main()
