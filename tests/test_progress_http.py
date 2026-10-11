"""Progress through real loopback client HTTP; mock ComfyUI, no GPU inference."""
import json
import struct
import unittest
from unittest.mock import patch

import test_service as fixture


class ProgressHTTPTests(unittest.TestCase):
    setUp = fixture.ServiceHTTPTests.setUp
    start_client = fixture.ServiceHTTPTests.start_client
    stop_client = fixture.ServiceHTTPTests.stop_client
    request = fixture.ServiceHTTPTests.request
    post = fixture.ServiceHTTPTests.post

    def submit(self):
        with patch.object(self.app.progress, 'ensure'):
            status, _, job = self.post('/api/generate', {'request_id':'progress-test-0001','request':fixture.API_JOB})
        self.assertEqual(status, 200, job)
        return job['id']

    def listed(self, job_id):
        code, _, raw = self.request('GET', '/api/jobs')
        self.assertEqual(code, 200)
        return next(job for job in json.loads(raw)['jobs'] if job['id'] == job_id)

    def test_queue_steps_preview_reconnect_and_history_completion(self):
        job_id = self.submit()
        self.backend.pending.insert(0, 'another-client')
        with patch.object(self.app.progress, 'ensure'):
            self.app.update_jobs()
        self.assertEqual(self.listed(job_id)['queue_position'], 2)
        self.backend.pending = []
        self.backend.running = [job_id]
        with patch.object(self.app.progress, 'ensure'):
            self.app.update_jobs()
        self.assertNotIn('queue_position', self.listed(job_id))
        stream = self.app.progress
        stream._connected(self.backend.url)
        stream.event({'type':'executing','data':{'prompt_id':job_id,'node':'1'}})
        stream.event({'type':'progress','data':{'prompt_id':job_id,'node':'1','value':2,'max':8}})
        stream.binary(struct.pack('!II',1,2) + fixture.PNG)
        job = self.listed(job_id)
        self.assertEqual(job['progress'], 25)
        self.assertEqual(job['execution_label'], 'TestOutput')
        self.assertNotIn('node_labels', job)
        self.assertNotIn('client_id', job)
        code, headers, raw = self.request('GET', job['preview_url'])
        self.assertEqual(code, 200)
        self.assertEqual(raw, fixture.PNG)
        self.assertFalse(job['preview_stale'])
        stream.connected = False
        self.assertTrue(self.listed(job_id)['progress_stale'])
        stream._connected(self.backend.url)
        self.assertTrue(self.listed(job_id)['progress_stale'])
        stream.event({'type':'progress','data':{'prompt_id':job_id,'node':'1','value':3,'max':8}})
        self.assertFalse(self.listed(job_id)['progress_stale'])
        stream.event({'type':'execution_success','data':{'prompt_id':job_id}})
        self.assertEqual(self.listed(job_id)['status'], 'running', 'events must wait for history')
        self.backend.running = []
        self.backend.history[job_id] = {'status':{'completed':True,'status_str':'success'},'outputs':{}}
        with patch.object(stream, 'ensure'):
            self.app.update_jobs()
        job = self.listed(job_id)
        self.assertEqual(job['status'], 'completed')
        self.assertNotIn('preview_url', job)

    def test_restart_reuses_directed_identity_and_resubscribes_without_prompt(self):
        job_id = self.submit()
        original_id = self.app.client_id
        self.stop_client()
        self.start_client()
        self.assertEqual(self.app.client_id, original_id)
        self.assertEqual(self.app.jobs[job_id]['client_id'], original_id)
        before = sum(call[:2] == ('POST','/prompt') for call in self.backend.calls)
        with patch.object(self.app.progress, 'ensure') as ensure:
            self.app.update_jobs()
            ensure.assert_called_once()
        after = sum(call[:2] == ('POST','/prompt') for call in self.backend.calls)
        self.assertEqual(before, after)

    def test_no_active_jobs_do_not_open_progress_channel(self):
        with patch.object(self.app.progress, 'ensure') as ensure:
            self.app.update_jobs()
            ensure.assert_not_called()
