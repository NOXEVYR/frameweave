"""Legacy candidate cleanup is zero-page/task-safe, not owner-secret authority."""

import unittest
from unittest.mock import patch

from frameweave.automation import _write_ledger
from frameweave.update_handoff import _post_shutdown
import test_service as fixtures


class ShutdownRouteHTTPTests(unittest.TestCase):
    setUp = fixtures.ServiceHTTPTests.setUp
    start_client = fixtures.ServiceHTTPTests.start_client
    stop_client = fixtures.ServiceHTTPTests.stop_client
    request = fixtures.ServiceHTTPTests.request
    post = fixtures.ServiceHTTPTests.post

    def register(self):
        code, _, result = self.post('/api/desktop/heartbeat', {})
        self.assertEqual(code, 200)
        return result['session_id']

    def test_one_or_two_registered_pages_cannot_use_cleanup_to_bypass_exit(self):
        self.app.jobs['synthetic-unknown'] = {'status': 'unknown'}
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('no page authority')):
            for _ in range(2):
                self.register()
                code, _, result = self.post('/api/shutdown', {})
                self.assertEqual(code, 400, result)
                self.assertIn('其他页面', result['error'])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertEqual(self.backend.calls, [])

    def test_cleanup_cannot_bypass_a_pending_command_with_no_registered_page(self):
        self.app.desktop.supported = True
        self.app.desktop.configure(tray_ready=True, open_ui=lambda: True)
        self.assertTrue(self.app.desktop.action('exit'))
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('pending command')):
            self.assertEqual(self.post('/api/shutdown', {})[0], 400)
        self.assertTrue(self.app.desktop.status()['command_pending'])
        self.assertFalse(self.app.closed.is_set())

    def test_zero_page_cleanup_still_checks_unknown_tasks_and_durable_intent(self):
        self.app.jobs['synthetic-unknown'] = {'status': 'unknown'}
        self.assertEqual(self.post('/api/shutdown', {})[0], 400)
        self.app.jobs.clear()
        _write_ledger(self.app, {'synthetic-unknown': {'state': 'unknown', 'digest': 'a' * 64, 'backend': self.backend.url}})
        path = self.app.data_dir / 'automation-requests.json'
        before = path.read_bytes()
        self.assertEqual(self.post('/api/shutdown', {})[0], 400)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertEqual(self.backend.calls, [])

    def test_new_page_during_preflight_prevents_cleanup_commit(self):
        calls = []
        def prepare(port, install=False, *, dry_run=False, allow_update=True):
            calls.append((dry_run, allow_update))
            self.app.desktop.heartbeat({})
            return True
        with patch.object(self.app, 'prepare_exit', side_effect=prepare):
            self.assertEqual(self.post('/api/shutdown', {})[0], 400)
        self.assertEqual(calls, [(True, True)])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_existing_helper_request_can_cleanup_idle_service_without_checking_or_restarting_updates(self):
        self.app.settings['auto_update'] = True
        with patch.object(self.app.updates, 'status', side_effect=AssertionError('cleanup must not inspect/handoff updates')):
            self.assertTrue(_post_shutdown(self.port, self.token))
            self.thread.join(2)
            self.assertFalse(self.thread.is_alive())
            self.assertTrue(self.app.closed.wait(2))
        self.assertTrue(self.app.exit_pending)
        self.assertFalse(self.app.exit_handoff_pending)
        self.assertEqual(self.backend.calls, [])

    def test_caller_json_cannot_change_internal_cleanup_guards_or_update_policy(self):
        for body in ({'allow_update': True}, {'require_no_sessions': False}, {'skip_guards': True}, {'install': True}):
            with self.subTest(body=body):
                self.assertEqual(self.post('/api/shutdown', body)[0], 400)
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_cleanup_still_requires_existing_host_origin_and_csrf_protection(self):
        self.assertEqual(self.post('/api/shutdown', {}, csrf=False)[0], 403)
        self.assertEqual(self.post('/api/shutdown', {}, headers={'Origin': 'https://example.com'})[0], 403)
        self.assertEqual(self.post('/api/shutdown', {}, headers={'Host': 'example.com'})[0], 403)
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())


if __name__ == '__main__':
    unittest.main()
