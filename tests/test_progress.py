import json
import struct
import threading
import unittest
from types import SimpleNamespace

from frameweave.progress import ProgressStream


class ProgressTests(unittest.TestCase):
    def setUp(self):
        self.app = SimpleNamespace(lock=threading.RLock(), closed=threading.Event(), backend=SimpleNamespace(url='http://127.0.0.1:8188'), jobs={
            'ours': {'id': 'ours', 'backend': 'http://127.0.0.1:8188', 'status': 'running'},
            'old': {'id': 'old', 'backend': 'http://127.0.0.1:8189', 'status': 'running'},
        })
        self.stream = ProgressStream(self.app)
        self.stream.backend = 'http://127.0.0.1:8188'
        self.stream.connected = True

    def event(self, kind, **data):
        self.stream.event({'type': kind, 'data': data})

    def test_steps_and_node_change_do_not_fake_overall_completion(self):
        self.event('executing', prompt_id='ours', node='sampler')
        self.event('progress', prompt_id='ours', node='sampler', value=5, max=20)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertEqual(state['progress'], 25)
        self.assertEqual((state['step'], state['steps']), (5, 20))
        self.event('executing', prompt_id='ours', node='save')
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertIsNone(state['progress'])
        self.assertEqual(state['execution_node'], 'save')
        self.assertEqual(self.app.jobs['ours']['status'], 'running')

    def test_foreign_jobs_and_old_backend_are_ignored(self):
        for job in ('foreign', 'old'):
            self.event('executing', prompt_id=job, node='1')
            self.event('progress', prompt_id=job, value=1, max=2)
            self.stream.binary(struct.pack('!II', 1, 2)+b'\x89PNG\r\n\x1a\nhello')
        self.assertEqual(self.stream.records, {})
        self.assertEqual(self.stream.previews, {})

    def test_legacy_unscoped_progress_only_follows_owned_execution(self):
        self.event('progress', value=1, max=2)
        self.assertEqual(self.stream.records, {})
        self.event('executing', prompt_id='ours', node='1')
        self.event('progress', value=1, max=2)
        self.assertEqual(self.stream.records['ours']['progress'], 50)
        self.event('executing', prompt_id='foreign', node='x')
        self.event('progress', value=2, max=2)
        self.assertEqual(self.stream.records['ours']['progress'], 50)

    def test_bad_progress_and_terminal_records(self):
        for value, maximum in ((True, 2), (1, 0), (-1, 2), (3, 2), (float('nan'), 3)):
            self.event('progress', prompt_id='ours', value=value, max=maximum)
        self.assertNotIn('progress', self.stream.records.get('ours', {}))
        self.app.jobs['ours']['status'] = 'completed'
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours']), {})

    def test_preview_is_ephemeral_and_owned(self):
        self.event('executing', prompt_id='ours', node='1')
        content = b'\x89PNG\r\n\x1a\nhello'
        self.stream.binary(struct.pack('!II', 1, 2)+content)
        self.assertEqual(self.stream.preview('ours'), (content, 'image/png'))
        self.assertIn('/api/jobs/ours/preview', self.stream.snapshot(self.app.jobs['ours'])['preview_url'])
        self.assertNotIn('preview_url', self.app.jobs['ours'])
        with self.assertRaises(ValueError):
            self.stream.preview('foreign')
