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

    def test_reconnect_does_not_relabel_old_steps_or_preview_as_fresh(self):
        self.event('executing', prompt_id='ours', node='1')
        self.event('progress', prompt_id='ours', value=5, max=20)
        preview = struct.pack('!II', 1, 2)+b'\x89PNG\r\n\x1a\nhello'
        self.stream.binary(preview)
        self.assertFalse(self.stream.snapshot(self.app.jobs['ours'])['progress_stale'])
        self.stream.connected = False
        stale = self.stream.snapshot(self.app.jobs['ours'])
        self.assertTrue(stale['progress_stale'])
        self.assertTrue(stale['preview_stale'])
        self.stream._connected(self.app.backend.url)
        stale = self.stream.snapshot(self.app.jobs['ours'])
        self.assertTrue(stale['progress_connected'])
        self.assertTrue(stale['progress_stale'])
        self.assertTrue(stale['preview_stale'])
        self.assertEqual(stale['progress'], 25)
        self.event('executing', prompt_id='ours', node='1')
        self.event('progress', prompt_id='ours', value=6, max=20)
        fresh = self.stream.snapshot(self.app.jobs['ours'])
        self.assertFalse(fresh['progress_stale'])
        self.assertTrue(fresh['preview_stale'])
        self.stream.binary(preview)
        fresh = self.stream.snapshot(self.app.jobs['ours'])
        self.assertFalse(fresh['preview_stale'])
        self.assertFalse(any(key.startswith('_') for key in fresh))

    def test_backend_change_hides_previous_engine_steps_and_preview(self):
        self.event('executing', prompt_id='ours', node='1')
        self.event('progress', prompt_id='ours', value=1, max=2)
        self.stream._connected('http://127.0.0.1:8189')
        result = self.stream.snapshot(self.app.jobs['ours'])
        self.assertFalse(result['progress_connected'])
        self.assertNotIn('step', result)
        self.assertNotIn('preview_url', result)

    def test_backend_switch_is_hidden_before_socket_notices(self):
        self.event('progress', prompt_id='ours', node='1', value=1, max=2)
        self.app.backend.url = 'http://127.0.0.1:8189'
        result = self.stream.snapshot(self.app.jobs['ours'])
        self.assertFalse(result['progress_connected'])
        self.assertNotIn('step', result)
        self.event('progress', prompt_id='ours', value=2, max=2)
        self.assertEqual(self.stream.records['ours']['step'], 1)

    def test_scoped_progress_recovers_preview_owner_after_reconnect(self):
        self.stream._connected(self.app.backend.url)
        self.event('executing', node='1')  # Official reconnect event does not include prompt_id.
        self.event('progress', value=1, max=2)
        self.assertEqual(self.stream.records, {})
        self.event('progress', prompt_id='ours', node='1', value=1, max=2)
        self.stream.binary(struct.pack('!II', 1, 2) + b'\x89PNG\r\n\x1a\nhello')
        self.assertEqual(self.stream.current, 'ours')
        self.assertIn('ours', self.stream.previews)
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours'])['progress_scope'], 'node')

    def test_node_change_marks_old_preview_and_new_preview_restores_freshness(self):
        self.event('progress', prompt_id='ours', node='first', value=1, max=2)
        payload = struct.pack('!II', 1, 2) + b'\x89PNG\r\n\x1a\nhello'
        self.stream.binary(payload)
        self.event('executing', prompt_id='ours', node='second')
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertTrue(state['preview_stale'])
        self.assertEqual(state['preview_node'], 'first')
        self.assertIn('preview_updated_at', state)
        self.stream.binary(payload)
        self.assertFalse(self.stream.snapshot(self.app.jobs['ours'])['preview_stale'])
        self.event('execution_start', prompt_id='ours')
        self.assertTrue(self.stream.snapshot(self.app.jobs['ours'])['preview_stale'])

    def test_scoped_foreign_progress_clears_legacy_preview_owner(self):
        self.event('executing', prompt_id='ours', node='first')
        self.event('progress', prompt_id='other-client', node='x', value=1, max=2)
        self.stream.binary(struct.pack('!II', 1, 2) + b'\x89PNG\r\n\x1a\nhello')
        self.assertNotIn('ours', self.stream.previews)

    def test_execution_lifecycle_stages_wait_for_history_and_ignore_late_sampling(self):
        self.event('execution_cached', prompt_id='ours', nodes=['1', '2'])
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours'])['cached_nodes'], 2)
        for kind, stage in (('execution_success', '执行结束，等待结果确认'),
                            ('execution_error', '执行出错，等待结果确认'),
                            ('execution_interrupted', '执行中断，等待结果确认')):
            self.event('execution_start', prompt_id='ours')
            self.event('progress', prompt_id='ours', node='1', value=2, max=2)
            self.event(kind, prompt_id='ours')
            self.event('progress', prompt_id='ours', node='1', value=2, max=2)
            state = self.stream.snapshot(self.app.jobs['ours'])
            self.assertEqual(state['stage'], stage)
            self.assertIsNone(state['progress'])
            self.assertNotIn('step', state)
            self.assertIsNone(self.stream.current)
            self.assertEqual(self.app.jobs['ours']['status'], 'running')

    def test_executed_output_event_is_not_node_completion(self):
        self.event('progress', prompt_id='ours', node='sampler', value=1, max=2)
        self.event('executed', prompt_id='ours', node='sampler', output={})
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours'])['progress'], 50)

    def test_progress_state_tracks_one_node_without_aggregating_parallel_nodes(self):
        nodes = {'1': {'state': 'finished', 'value': 1, 'max': 1},
                 '2': {'state': 'running', 'value': 3, 'max': 12}}
        self.event('progress_state', prompt_id='ours', nodes=nodes)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertEqual((state['execution_node'], state['step'], state['steps']), ('2', 3, 12))
        nodes['3'] = {'state': 'running', 'value': 2, 'max': 10}
        self.event('progress_state', prompt_id='ours', nodes=nodes)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertIsNone(state['progress'])
        self.assertNotIn('step', state)
        self.assertEqual(state['execution_nodes'], ['2', '3'])
        self.assertEqual(state['stage'], '多个节点执行中')
        self.assertIsNone(self.stream.current)
        nodes['2']['state'] = nodes['3']['state'] = 'finished'
        self.event('progress_state', prompt_id='ours', nodes=nodes)
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours'])['stage'], '等待后续节点')

    def test_malformed_state_and_large_numbers_do_not_replace_valid_progress(self):
        self.event('progress', prompt_id='ours', node='1', value=1, max=2)
        for nodes in ({'1': {'state': 'running', 'value': 1, 'max': 2, 'prompt_id': 'foreign'}},
                      {'1': {'state': 'running', 'value': True, 'max': 2}},
                      {'1': {'state': [], 'value': 1, 'max': 2}}):
            self.event('progress_state', prompt_id='ours', nodes=nodes)
        self.event('progress', prompt_id='ours', value=10**1000, max=10**1001)
        self.event('progress', prompt_id='ours', node={}, value=1, max=2)
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours'])['step'], 1)

    def test_metadata_preview_validates_task_node_and_image_type(self):
        def payload(prompt='ours', node='1', mime='image/png'):
            metadata = json.dumps({'prompt_id': prompt, 'node_id': node, 'image_type': mime}).encode()
            return struct.pack('!II', 4, len(metadata)) + metadata + b'\x89PNG\r\n\x1a\nhello'
        self.event('progress', prompt_id='ours', node='1', value=1, max=2)
        for data in (payload(prompt='foreign'), payload(node='other'), payload(mime='image/jpeg'),
                     struct.pack('!II', 4, 20000) + b'x' * 20):
            self.stream.binary(data)
        self.assertNotIn('ours', self.stream.previews)
        self.stream.current = None
        self.stream.binary(payload())
        self.assertEqual(self.stream.preview('ours')[1], 'image/png')
        self.event('execution_success', prompt_id='ours')
        self.assertTrue(self.stream.snapshot(self.app.jobs['ours'])['preview_stale'])

    def test_unknown_identity_is_not_reported_as_verified_until_scoped_event(self):
        self.app.client_id = 'frameweave-' + 'a' * 32
        self.assertTrue(self.stream.snapshot(self.app.jobs['ours'])['progress_identity_unknown'])
        self.app.jobs['ours']['client_id'] = 'frameweave-' + 'b' * 32
        self.assertTrue(self.stream.snapshot(self.app.jobs['ours'])['progress_identity_unknown'])
        self.event('progress', prompt_id='ours', node='1', value=1, max=2)
        self.assertFalse(self.stream.snapshot(self.app.jobs['ours'])['progress_identity_unknown'])
        self.stream._connected(self.app.backend.url)
        self.assertTrue(self.stream.snapshot(self.app.jobs['ours'])['progress_identity_unknown'])

    def test_reconnect_progress_without_node_cannot_relabel_old_preview_node_as_current(self):
        self.event('progress', prompt_id='ours', node='old', value=1, max=2)
        self.stream.binary(struct.pack('!II', 1, 2) + b'\x89PNG\r\n\x1a\nhello')
        self.stream._connected(self.app.backend.url)
        self.event('progress', prompt_id='ours', value=1, max=4)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertEqual(state['execution_node'], '')
        self.assertEqual(state['progress'], 25)
        self.assertEqual(state['preview_node'], 'old')
        self.assertTrue(state['preview_stale'])

    def test_parallel_metadata_preview_follows_running_node_and_connection_epoch(self):
        nodes = {'first': {'state': 'running', 'value': 1, 'max': 4},
                 'second': {'state': 'running', 'value': 2, 'max': 8}}
        metadata = json.dumps({'prompt_id': 'ours', 'node_id': 'first', 'image_type': 'image/png'}).encode()
        payload = struct.pack('!II', 4, len(metadata)) + metadata + b'\x89PNG\r\n\x1a\nhello'
        self.event('progress_state', prompt_id='ours', nodes=nodes)
        self.assertIsNone(self.stream.current)
        self.stream.binary(payload)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertEqual(state['preview_node'], 'first')
        self.assertFalse(state['preview_stale'])
        self.assertIsNone(state['progress'])
        previous_url = state['preview_url']
        self.stream._connected(self.app.backend.url)
        self.stream.binary(payload)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertEqual(state['preview_url'], previous_url)
        self.assertTrue(state['preview_stale'])
        self.event('progress_state', prompt_id='ours', nodes=nodes)
        self.stream.binary(payload)
        self.assertFalse(self.stream.snapshot(self.app.jobs['ours'])['preview_stale'])
        nodes['first']['state'] = 'finished'
        nodes['third'] = {'state': 'running', 'value': 0, 'max': 1}
        self.event('progress_state', prompt_id='ours', nodes=nodes)
        state = self.stream.snapshot(self.app.jobs['ours'])
        self.assertEqual(state['execution_nodes'], ['second', 'third'])
        self.assertTrue(state['preview_stale'])
        previous_url = state['preview_url']
        self.stream.binary(payload)
        self.assertEqual(self.stream.snapshot(self.app.jobs['ours'])['preview_url'], previous_url)
