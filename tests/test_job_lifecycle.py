"""Cancellation races, durable recovery and original-backend identity."""
import copy
import json
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from frameweave.backend import BackendError
from frameweave.job_lifecycle import has_terminal_evidence, new_cancellation
from frameweave.recovery import job_record
from frameweave.server import App


class Engine:
    url = 'http://127.0.0.1:18282'

    def __init__(self):
        self.calls, self.history = [], {}
        self.queue = {'queue_pending': [[0, 'owned']], 'queue_running': []}
        self.cancel_reply = {'cancelled': True}
        self.cancel_hook = None

    def request(self, path, body=None, **kwargs):
        self.calls.append((path, copy.deepcopy(body)))
        if path.endswith('/cancel'):
            if self.cancel_hook:
                return self.cancel_hook()
            if isinstance(self.cancel_reply, Exception):
                raise self.cancel_reply
            return self.cancel_reply
        if path.startswith('/history/'):
            return copy.deepcopy(self.history)
        if path == '/queue':
            if body is not None:
                self.queue['queue_pending'] = [r for r in self.queue['queue_pending'] if r[1] not in body['delete']]
                return {}
            return copy.deepcopy(self.queue)
        raise AssertionError(path)


class JobLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.engine = Engine()
        self.app = App(self.root, self.root, self.engine.url)
        self.addCleanup(self.app.closed.set)
        self.app.backend = self.engine
        self.job = {'id': 'owned', 'backend': self.engine.url, 'status': 'queued',
                    'created_at': time.time() - 30, 'outputs': []}
        self.app.jobs['owned'] = self.job

    def finish(self, status='success', prompt_id='owned', output=False):
        self.engine.history = {'owned': {'status': {'status_str': status, 'completed': status == 'success',
            'messages': [['execution_interrupted', {'prompt_id': prompt_id}]] if status == 'error' else []},
            'outputs': {'2': {'images': [{'filename': 'result.png'}]}} if output else {}}}
        self.engine.queue = {'queue_pending': [], 'queue_running': []}

    def test_ack_only_is_not_terminal_and_repeat_is_not_dispatched(self):
        first = self.app.cancel('owned')
        self.assertEqual(first['status'], 'queued')
        self.assertEqual(first['cancellation']['state'], 'requested')
        self.assertFalse(first['can_cancel'])
        self.assertEqual(self.app.cancel('owned')['cancellation']['id'], first['cancellation']['id'])
        self.assertEqual(len(self.engine.calls), 1)
        self.assertNotIn('finished_at', self.job)

    def test_exact_interruption_history_confirms_cancel_and_keeps_partial_outputs(self):
        self.app.cancel('owned')
        self.finish('error', output=True)
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(result['cancellation']['state'], 'confirmed')
        self.assertTrue(has_terminal_evidence(result))
        self.assertEqual(len(result['outputs']), 1)

    def test_natural_completion_after_signal_keeps_results(self):
        self.app.cancel('owned')
        self.finish(output=True)
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['cancellation']['state'], 'completed')
        self.assertTrue(result['outputs'][0]['url'].startswith('/api/media/'))

    def test_foreign_interruption_does_not_confirm_owned_cancellation(self):
        self.app.cancel('owned')
        self.finish('error', prompt_id='foreign')
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['cancellation']['state'], 'failed')

    def test_queue_delete_absence_is_unknown_not_cancelled(self):
        self.engine.cancel_reply = BackendError('HTTP 404')
        self.engine.queue['queue_pending'].append([1, 'foreign'])
        self.app.cancel('owned')
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['cancellation']['state'], 'uncertain')
        self.assertEqual(self.engine.queue['queue_pending'], [[1, 'foreign']])
        self.assertFalse(any(p == '/interrupt' for p, _ in self.engine.calls))
        self.assertFalse(result['can_retry'])

    def test_failed_or_malformed_ack_does_not_fallback_or_resend(self):
        for reply in (BackendError('HTTP 500'), OSError('offline'), [], None, {'cancelled': False}):
            with self.subTest(reply=type(reply).__name__):
                self.job.pop('cancellation', None)
                self.engine.calls.clear()
                self.engine.cancel_reply = reply
                self.assertEqual(self.app.cancel('owned')['cancellation']['state'], 'uncertain')
                self.app.cancel('owned')
                self.assertEqual(len(self.engine.calls), 1)

    def test_disk_failure_before_dispatch_has_no_backend_mutation(self):
        with patch.object(self.app, 'persist_jobs', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                self.app.cancel('owned')
        self.assertEqual(self.engine.calls, [])
        self.assertNotIn('cancellation', self.job)

    def test_lost_final_disk_write_recovers_intent_without_repeat(self):
        original = self.app.persist_jobs
        count = 0
        def save():
            nonlocal count
            count += 1
            if count == 1:
                original()
            else:
                raise OSError('disk full')
        with patch.object(self.app, 'persist_jobs', side_effect=save):
            self.assertIn('storage_warning', self.app.cancel('owned'))
        restored = App(self.root, self.root, self.engine.url)
        self.addCleanup(restored.closed.set)
        restored.backend = self.engine
        before = len(self.engine.calls)
        self.assertEqual(restored.cancel('owned')['cancellation']['state'], 'uncertain')
        self.assertEqual(len(self.engine.calls), before)

    def test_two_simultaneous_cancel_requests_dispatch_once(self):
        entered, release = threading.Event(), threading.Event()
        def block():
            entered.set()
            if not release.wait(3):
                raise AssertionError('test gate timed out')
            return {'cancelled': True}
        self.engine.cancel_hook = block
        with ThreadPoolExecutor(2) as executor:
            first = executor.submit(self.app.cancel, 'owned')
            self.assertTrue(entered.wait(2))
            second = executor.submit(self.app.cancel, 'owned')
            try:
                self.assertEqual(second.result(2)['cancellation']['state'], 'requesting')
            finally:
                release.set()
            first.result(2)
        self.assertEqual(len(self.engine.calls), 1)

    def test_concurrent_completion_cannot_be_overwritten_by_late_cancel_ack(self):
        def race():
            self.finish(output=True)
            self.app.refresh_job('owned')
            return {'cancelled': True}
        self.engine.cancel_hook = race
        result = self.app.cancel('owned')
        self.assertEqual((result['status'], result['cancellation']['state']), ('completed', 'completed'))
        self.assertEqual(len(result['outputs']), 1)

    def test_original_backend_is_queried_without_switch_or_mutation(self):
        current = Engine()
        current.url = 'http://127.0.0.1:18283'
        self.app.backend = current
        self.finish(output=True)
        with patch('frameweave.server.Backend', return_value=self.engine) as construct:
            result = self.app.refresh_job('owned')
        construct.assert_called_once_with(self.engine.url)
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(current.calls, [])
        self.assertTrue(all(body is None for _, body in self.engine.calls))
        self.assertEqual(self.app.backend.url, current.url)

    def test_foreign_backend_cancel_and_wrong_adapter_are_rejected(self):
        self.job['backend'] = 'http://127.0.0.1:18283'
        with self.assertRaises(ValueError):
            self.app.cancel('owned')
        with self.assertRaises(ValueError):
            self.app.refresh_job('owned', adapter=self.engine)
        self.assertEqual(self.engine.calls, [])

    def test_unknown_recovers_to_running_then_terminal(self):
        self.engine.queue = {'queue_running': [], 'queue_pending': []}
        self.assertEqual(self.app.refresh_job('owned')['status'], 'unknown')
        self.engine.queue['queue_running'] = [[0, 'owned']]
        self.assertEqual(self.app.refresh_job('owned')['status'], 'running')
        self.finish()
        self.assertEqual(self.app.refresh_job('owned')['status'], 'completed')

    def test_legacy_cancelled_requires_terminal_evidence_and_survives_restart(self):
        self.job.update(status='cancelled', finished_at=123)
        recovered = job_record(self.job)
        self.assertEqual(recovered['status'], 'unknown')
        self.assertNotIn('finished_at', recovered)
        self.app.persist_jobs()
        restored = App(self.root, self.root, self.engine.url)
        self.addCleanup(restored.closed.set)
        self.assertEqual(restored.jobs['owned']['status'], 'unknown')

    def test_restore_requesting_is_uncertain_preserving_cancel_identity(self):
        self.job['cancellation'] = new_cancellation()
        recovered = job_record(self.job)
        self.assertEqual(recovered['cancellation']['id'], self.job['cancellation']['id'])
        self.assertEqual(recovered['cancellation']['state'], 'uncertain')

    def test_legacy_backend_change_failure_reopens_but_actual_failures_remain_terminal(self):
        self.job.update(status='failed', error='后端地址已变化；请在原后端检查任务')
        self.assertEqual(job_record(self.job)['status'], 'unknown')
        self.job['error'] = 'CUDA out of memory'
        self.assertEqual(job_record(self.job)['status'], 'failed')

    def test_existing_and_new_outputs_merge_without_duplicates(self):
        self.finish(output=True)
        existing = self.app._history_outputs('owned', self.engine.url, self.engine.history['owned'])
        self.job['outputs'] = existing
        self.engine.history['owned']['outputs']['3'] = {'images': [{'filename': 'second.png'}]}
        result = self.app.refresh_job('owned')
        self.assertEqual([o['filename'] for o in result['outputs']], ['result.png', 'second.png'])

    def test_unknown_blocks_backend_switch_but_allows_return_to_original(self):
        self.job['status'] = 'unknown'
        with self.assertRaises(ValueError):
            self.app.save_settings({'backend_url': 'http://127.0.0.1:18283'})
        self.app.backend = type('Other', (), {'url': 'http://127.0.0.1:18283'})()
        self.assertEqual(self.app.save_settings({'backend_url': self.engine.url})['settings']['backend_url'], self.engine.url)
