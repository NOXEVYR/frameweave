"""Independent lifecycle review: isolated apps, no native service or generation."""
import copy
import time
import unittest
from unittest.mock import patch

import test_job_lifecycle as fixtures
from frameweave.recovery import job_record
from frameweave.server import App


class LifecycleIndependentReview(unittest.TestCase):
    setUp = fixtures.JobLifecycleTests.setUp
    finish = fixtures.JobLifecycleTests.finish

    def test_legacy_queue_absence_failure_is_reopened_as_unknown(self):
        # This exact message was emitted by the previous released update_jobs.
        self.job.update(status='failed', finished_at=time.time(),
                        error='任务已离开后端队列且没有历史记录，可能被外部移除或后端重启')
        recovered = job_record(self.job)
        self.assertEqual(recovered['status'], 'unknown')
        self.assertNotIn('finished_at', recovered)
        self.app.persist_jobs()
        restored = App(self.root, self.root, self.engine.url)
        self.addCleanup(restored.closed.set)
        restored.backend = self.engine
        self.finish(output=True)
        result = restored.refresh_job('owned')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(result['outputs']), 1)

    def test_terminal_history_without_outputs_preserves_previously_owned_partial_media(self):
        old = {'filename': 'partial.png', 'subfolder': '', 'storage_type': 'output', 'type': 'image',
               'node_id': '2', 'history_channel': 'images', 'entry_index': 0}
        old['url'] = self.app.register_media(old['filename'], backend=self.engine.url)
        self.job['outputs'] = [copy.deepcopy(old)]
        self.app.cancel('owned')
        self.finish('error', output=False)
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual([output['filename'] for output in result['outputs']], ['partial.png'])

    def test_late_refresh_cannot_replace_confirmed_completed_by_stale_empty_history(self):
        original = self.engine.request
        entered = False

        def request(path, body=None, **kwargs):
            nonlocal entered
            if path.startswith('/history/') and not entered:
                entered = True
                self.finish(output=True)
                self.app.refresh_job('owned')
                return {}
            return original(path, body, **kwargs)

        with patch.object(self.engine, 'request', side_effect=request):
            result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(result['outputs']), 1)

    def test_periodic_poll_groups_original_backend_queries_without_mutations(self):
        self.job['status'] = 'unknown'
        other = fixtures.Engine()
        other.url = 'http://127.0.0.1:18283'
        self.app.backend = other
        self.finish(output=True)
        with patch('frameweave.server.Backend', return_value=self.engine), patch.object(self.app.progress, 'ensure'):
            self.app.update_jobs()
        self.assertEqual(self.job['status'], 'completed')
        self.assertEqual(other.calls, [])
        self.assertTrue(all(body is None for _, body in self.engine.calls))


if __name__ == '__main__':
    unittest.main()
