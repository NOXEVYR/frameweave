"""Engine controls retain the same HTTP ownership and settings guards."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from frameweave.server import App


class EngineIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = App(self.root, self.root)

    def test_auto_start_option_survives_settings_update_and_restart(self):
        self.app.save_settings({"backend_url": self.app.backend.url, "auto_start_engine": True})
        self.app.save_settings({"backend_url": self.app.backend.url})
        with patch.object(App, 'start_saved_engine') as start:
            restored = App(self.root, self.root)
            self.assertTrue(restored.settings['auto_start_engine'])
        self.assertTrue(json.loads((self.root/'settings.json').read_text())['auto_start_engine'])

    def test_only_selected_engine_is_started(self):
        self.app.engines = Mock()
        self.app.engines.status.return_value = {'profiles': [
            {'id': 'other', 'base_url': 'http://127.0.0.1:8199'},
            {'id': 'chosen', 'base_url': self.app.backend.url}]}
        self.app.start_saved_engine()
        self.app.engines.start.assert_called_once_with('chosen')

    def test_active_job_prevents_engine_switch(self):
        self.app.jobs['busy'] = {'status': 'running'}
        with self.assertRaisesRegex(ValueError, '任务'):
            self.app.save_settings({'backend_url': 'http://127.0.0.1:8199'})

    def test_uncertain_submission_prevents_engine_switch(self):
        (self.root/'automation-requests.json').write_text(json.dumps({'version': 1, 'requests': {
            'pending-request': {'state': 'unknown', 'digest': 'a'*64, 'backend': self.app.backend.url}}}))
        with self.assertRaisesRegex(ValueError, '尚未确认'):
            self.app.save_settings({'backend_url': 'http://127.0.0.1:8199'})

    def test_invalid_auto_start_rejected(self):
        with self.assertRaises(ValueError):
            self.app.save_settings({'backend_url': self.app.backend.url, 'auto_start_engine': 'false'})

    def test_exit_is_blocked_by_active_and_uncertain_work(self):
        self.app.jobs['busy'] = {'status': 'queued'}
        self.assertFalse(self.app.prepare_exit(8765))
        self.assertFalse(self.app.exit_pending)
        self.app.jobs.clear()
        (self.root/'automation-requests.json').write_text(json.dumps({'version': 1, 'requests': {
            'pending-request': {'state': 'pending', 'digest': 'a'*64, 'backend': self.app.backend.url}}}))
        self.assertFalse(self.app.prepare_exit(8765))

    def test_exit_stops_new_dispatch_and_duplicate_exit(self):
        self.assertTrue(self.app.prepare_exit(8765))
        with self.assertRaisesRegex(ValueError, '退出'):
            self.app._dispatch({}, 'api')
        with self.assertRaisesRegex(ValueError, '退出'):
            self.app.prepare_exit(8765)

    def test_download_blocks_exit_before_staged_exists(self):
        self.app.update_busy = True
        self.assertFalse(self.app.prepare_exit(8765))
        self.assertFalse(self.app.exit_pending)

    def test_enabling_auto_updates_starts_check_in_current_session(self):
        with patch.object(self.app, 'begin_update') as begin:
            self.app.save_settings({'backend_url': self.app.backend.url, 'auto_update': True})
            begin.assert_called_once_with('auto')
        self.assertTrue(self.app.updates.auto_check)
