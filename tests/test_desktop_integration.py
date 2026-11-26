"""Real loopback desktop protocol and injected launcher/tray lifecycle tests.

These tests never invoke the Windows Shell, a real browser, models or updates.
"""

import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frameweave import __main__ as entry
from frameweave.automation import _write_ledger
from frameweave.desktop_shell import DesktopShell
from frameweave.instance import open_app_window, focus_or_open_app_window
from frameweave.settings_recovery import load_settings
from frameweave.windows_tray import WindowsTray
import test_service as service_fixture


class DesktopHTTPTests(unittest.TestCase):
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post

    def fake_tray(self):
        self.app.desktop.supported = True  # Explicit fake; not native acceptance.
        self.open = Mock(return_value=True)
        self.notices = Mock()
        self.app.desktop.configure(tray_ready=True, open_ui=self.open, notify=self.notices)

    def delivered_exit(self):
        self.fake_tray()
        status, _, registered = self.post('/api/desktop/heartbeat', {'settings_available': True})
        self.assertEqual(status, 200)
        self.assertTrue(self.app.desktop.action('exit'))
        status, _, ready = self.post('/api/desktop/heartbeat', {'session_id': registered['session_id'], 'settings_available': True})
        self.assertEqual(status, 200)
        return {'session_id': ready['session_id'], 'command_id': ready['command']['id'],
                'approved': True, 'reason': 'handled'}

    def test_status_and_heartbeat_are_local_no_backend_queries_or_private_paths(self):
        calls = list(self.backend.calls)
        with patch.object(self.app.backend, 'request', side_effect=AssertionError('no backend query')), \
                patch.object(self.app.backend, 'upload', side_effect=AssertionError('no upload')):
            status, _, raw = self.request('GET', '/api/desktop/status')
            self.assertEqual(status, 200)
            desktop = json.loads(raw)
            self.assertEqual(desktop['version'], 1)
            self.assertFalse(desktop['tray_ready'])
            self.assertEqual(desktop['effective_close_action'], 'idle_exit')
            status, _, result = self.post('/api/desktop/heartbeat', {'settings_available': True})
            self.assertEqual(status, 200)
            self.assertRegex(result['session_id'], r'^[A-Za-z0-9_-]{32}$')
            self.assertIsNone(result['command'])
        self.assertEqual(self.backend.calls, calls)
        for private in [str(self.app.data_dir), self.app.csrf, 'session_id', 'command_id']:
            self.assertNotIn(private, json.dumps(desktop))

    def test_desktop_writes_keep_existing_csrf_origin_and_host_checks(self):
        for endpoint in ['/api/desktop/heartbeat', '/api/desktop/complete']:
            with self.subTest(endpoint=endpoint):
                self.assertEqual(self.post(endpoint, {}, csrf=False)[0], 403)
                self.assertEqual(self.post(endpoint, {}, headers={'Origin': 'https://example.com'})[0], 403)
                self.assertEqual(self.post(endpoint, {}, headers={'Host': 'example.com'})[0], 403)
        self.assertFalse(self.app.closed.is_set())
        self.assertFalse(self.app.exit_pending)

    def test_malformed_or_foreign_completion_cannot_call_exit_guard(self):
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('no exit authority')):
            cases = [{}, {'session_id': 'x' * 32, 'command_id': 'a' * 32, 'approved': True},
                     {'approved': True, 'reason': []}, {'approved': 1}, {'approved': True, 'extra': 'private'}]
            for data in cases:
                self.assertEqual(self.post('/api/desktop/complete', data)[0], 400)
        self.assertFalse(self.app.exit_pending)

    def test_settings_command_ack_is_not_exit_and_uses_declared_ui_capability(self):
        self.fake_tray()
        _, _, registered = self.post('/api/desktop/heartbeat', {'settings_available': True})
        self.assertTrue(self.app.desktop.action('settings'))
        _, _, ready = self.post('/api/desktop/heartbeat', {'session_id': registered['session_id'], 'settings_available': True})
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('settings never exits')):
            status, _, result = self.post('/api/desktop/complete', {'session_id': ready['session_id'],
                                        'command_id': ready['command']['id'], 'approved': True})
        self.assertEqual(status, 200)
        self.assertTrue(result['ok'])
        self.assertFalse(result['exiting'])
        self.assertFalse(self.app.closed.is_set())

    def test_declined_draft_failure_retains_service_and_exit_intent(self):
        ack = self.delivered_exit()
        ack.update(approved=False, reason='draft-save-failed')
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('decline must not inspect exit')):
            status, _, result = self.post('/api/desktop/complete', ack)
        self.assertEqual(status, 200)
        self.assertFalse(result['ok'])
        self.assertFalse(result['exiting'])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertIn('草稿', result['error'])

    def test_real_running_job_guard_keeps_icon_and_service(self):
        ack = self.delivered_exit()
        self.app.jobs['fixture-job'] = {'status': 'running'}
        status, _, result = self.post('/api/desktop/complete', ack)
        self.assertEqual(status, 200)
        self.assertFalse(result['exiting'])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertTrue(self.app.desktop.status()['tray_ready'])
        self.assertEqual(self.open.call_count, 1)

    def test_real_unknown_ledger_guard_preserves_exact_ledger_and_service(self):
        ack = self.delivered_exit()
        _write_ledger(self.app, {'fixture-request': {'state': 'unknown', 'digest': 'a' * 64, 'backend': self.backend.url}})
        ledger = self.app.data_dir / 'automation-requests.json'
        before = ledger.read_bytes()
        status, _, result = self.post('/api/desktop/complete', ack)
        self.assertEqual(status, 200)
        self.assertFalse(result['exiting'])
        self.assertEqual(ledger.read_bytes(), before)
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_dry_run_is_pure_and_never_installs_update_or_sets_pending(self):
        self.assertTrue(self.app.prepare_exit(self.port, dry_run=True))
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())
        self.app.settings['auto_update'] = True
        with patch.object(self.app.updates, 'status', side_effect=AssertionError('dry run must not install/update')):
            self.assertTrue(self.app.prepare_exit(self.port, dry_run=True))
        self.assertFalse(self.app.exit_pending)

    def test_late_new_page_or_deadline_during_preflight_never_sets_exit_pending(self):
        for mutation in ['page', 'deadline']:
            with self.subTest(mutation=mutation):
                calls = []
                now = [1000.0]
                self.app.desktop.clock = lambda: now[0]
                # Create a fresh action using the fake clock; old callbacks cannot revive it.
                self.app.desktop.close()
                self.app.desktop = DesktopShell(supported=True, clock=lambda: now[0])
                self.app.desktop.configure(tray_ready=True, open_ui=Mock(return_value=True))
                registered = self.app.desktop.heartbeat({})
                self.app.desktop.action('exit')
                ready = self.app.desktop.heartbeat({'session_id': registered['session_id']})
                ack = {'session_id': ready['session_id'], 'command_id': ready['command']['id'], 'approved': True}

                def guard(port, install=False, *, dry_run=False):
                    calls.append(dry_run)
                    if dry_run:
                        if mutation == 'page':
                            self.app.desktop.heartbeat({})
                        else:
                            now[0] += 61
                        return True
                    self.app.exit_pending = True
                    return True

                with patch.object(self.app, 'prepare_exit', side_effect=guard):
                    status, _, result = self.post('/api/desktop/complete', ack)
                self.assertEqual(status, 200)
                self.assertFalse(result['exiting'])
                self.assertEqual(calls, [True])
                self.assertFalse(self.app.exit_pending)
                self.assertFalse(self.app.closed.is_set())

    def test_confirmed_exit_runs_final_real_guard_and_owner_server_shutdown(self):
        ack = self.delivered_exit()
        status, _, result = self.post('/api/desktop/complete', ack)
        self.assertEqual(status, 200)
        self.assertTrue(result['ok'])
        self.assertTrue(result['exiting'])
        self.assertTrue(self.app.exit_pending)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.assertTrue(self.app.closed.wait(2))

    def test_owner_shutdown_start_failure_releases_exit_intent_without_retry(self):
        ack = self.delivered_exit()
        with patch('frameweave.server.threading.Thread') as thread:
            thread.return_value.start.side_effect = RuntimeError('synthetic thread-start failure')
            result = self.app.complete_desktop_command(ack)
            thread.return_value.start.assert_called_once()
        self.assertFalse(result['ok'])
        self.assertFalse(result['exiting'])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertIn('未能确认', result['error'])
        self.assertEqual(self.request('GET', '/api/heartbeat')[0], 200)

    def test_close_preference_is_validated_persisted_and_omission_preserves_it(self):
        settings = {'backend_url': self.backend.url, 'model_roots': [], 'desktop_close_action': 'idle_exit'}
        status, _, result = self.post('/api/settings', settings)
        self.assertEqual(status, 200)
        self.assertEqual(result['settings']['desktop_close_action'], 'idle_exit')
        saved = self.app.data_dir / 'settings.json'
        before = saved.read_bytes()
        for bad in ['', 'exit', True, None, []]:
            self.assertEqual(self.post('/api/settings', settings | {'desktop_close_action': bad})[0], 400)
            self.assertEqual(saved.read_bytes(), before)
        self.assertEqual(self.post('/api/settings', {'backend_url': self.backend.url, 'model_roots': []})[2]['settings']['desktop_close_action'], 'idle_exit')
        restored, warnings, protected = load_settings(saved, self.app.validate_roots)
        self.assertEqual(restored['desktop_close_action'], 'idle_exit')
        self.assertEqual(warnings, [])
        self.assertFalse(protected)


class LauncherTests(unittest.TestCase):
    def test_native_user_action_extends_grace_but_timer_does_not(self):
        app = SimpleNamespace(last_seen=10, desktop=Mock())
        entry._desktop_action(app, 'tick', clock=lambda: 20)
        self.assertEqual(app.last_seen, 10)
        app.desktop.tick.assert_called_once()
        entry._desktop_action(app, 'open', clock=lambda: 20)
        self.assertEqual(app.last_seen, 20)
        app.desktop.action.assert_called_once_with('open')

    def test_ordinary_second_launch_reopens_verified_owner_without_creating_service(self):
        with tempfile.TemporaryDirectory() as data, patch.object(entry, 'setup_logging'), \
                patch.object(entry, 'InstanceLock') as instance, \
                patch.object(entry, '_wait_existing_instance', return_value='http://127.0.0.1:8766/'), \
                patch.object(entry, 'focus_or_open_app_window', return_value=True) as reopen, \
                patch.object(entry, 'App') as app, patch('sys.argv', ['PrismCanvas', '--data-dir', data]):
            instance.return_value.acquire.return_value = False
            entry.main()
            reopen.assert_called_once_with('http://127.0.0.1:8766/', Path(data).resolve())
            app.assert_not_called()
            instance.return_value.release.assert_not_called()

    def test_headless_second_launch_does_not_open_another_browser(self):
        with tempfile.TemporaryDirectory() as data, patch.object(entry, 'setup_logging'), \
                patch.object(entry, 'InstanceLock') as instance, \
                patch.object(entry, '_wait_existing_instance', return_value='http://127.0.0.1:8766/'), \
                patch.object(entry, 'focus_or_open_app_window') as reopen, \
                patch.object(entry, 'activate_existing_app_window') as focus, \
                patch('sys.argv', ['PrismCanvas', '--data-dir', data, '--no-browser']):
            instance.return_value.acquire.return_value = False
            entry.main()
            reopen.assert_not_called()
            focus.assert_called_once()

    def test_second_launch_failure_reports_without_starting_or_releasing_owner(self):
        with tempfile.TemporaryDirectory() as data, patch.object(entry, 'setup_logging'), \
                patch.object(entry, 'InstanceLock') as instance, \
                patch.object(entry, '_wait_existing_instance', return_value='http://127.0.0.1:8766/'), \
                patch.object(entry, 'focus_or_open_app_window', return_value=False), \
                patch.object(entry, '_open_failure_notice') as notice, patch.object(entry, 'App') as app, \
                patch('sys.argv', ['PrismCanvas', '--data-dir', data]):
            instance.return_value.acquire.return_value = False
            entry.main()
            notice.assert_called_once()
            app.assert_not_called()
            instance.return_value.release.assert_not_called()

    def test_startup_wait_is_bounded_and_only_reuses_validated_bootstrap(self):
        now = [0.0]
        def wait(seconds):
            now[0] += seconds
        with patch.object(entry, 'read_instance_url', side_effect=[None, 'http://127.0.0.1:8766/']), \
                patch.object(entry, 'validate_prismcanvas_url', return_value=True) as validate:
            self.assertEqual(entry._wait_existing_instance(Path('/synthetic'), clock=lambda: now[0], wait=wait), 'http://127.0.0.1:8766/')
            validate.assert_called_once()
        now[0] = 0
        with patch.object(entry, 'read_instance_url', return_value='https://example.com'), \
                patch.object(entry, 'validate_prismcanvas_url', return_value=False):
            self.assertIsNone(entry._wait_existing_instance(Path('/synthetic'), timeout=1, clock=lambda: now[0], wait=wait))
            self.assertLessEqual(now[0], 1)

    def test_default_browser_failure_is_not_claimed_as_success(self):
        with patch('frameweave.instance.Path.is_file', return_value=False), \
                patch('webbrowser.open', return_value=False), \
                patch('frameweave.instance.activate_existing_app_window', return_value=False):
            self.assertFalse(open_app_window('http://127.0.0.1:8766/'))
            with tempfile.TemporaryDirectory() as data:
                self.assertFalse(focus_or_open_app_window('http://127.0.0.1:8766/', Path(data)))

    def test_build_arguments_bundle_owned_icon_data_without_new_dependency(self):
        path = Path(__file__).resolve().parents[1] / 'tools' / 'build_windows.py'
        import importlib.util
        spec = importlib.util.spec_from_file_location('desktop_build_fixture', path)
        build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(build)
        args = build.pyinstaller_arguments(Path('/synthetic/version.txt'), Path('/synthetic/out'), Path('/synthetic/work'))
        payloads = [args[index + 1] for index, value in enumerate(args) if value == '--add-data']
        self.assertTrue(any(value.endswith('frameweave.ico;assets') for value in payloads))
        self.assertIn('--windowed', args)


class FakeTrayDriver:
    def __init__(self, *, fails=False):
        self.fails = fails
        self.stopped = threading.Event()
        self.dispatch = None
        self.stop_calls = 0
        self.cleaned = 0
        self.messages = []

    def run(self, dispatch, ready):
        self.dispatch = dispatch
        try:
            if self.fails:
                raise OSError('synthetic startup error')
            ready()
            self.stopped.wait(5)
        finally:
            self.cleaned += 1

    def stop(self):
        self.stop_calls += 1
        self.stopped.set()

    def notify(self, message):
        self.messages.append(message)


class TrayLifecycleTests(unittest.TestCase):
    def tray(self, driver, action=None):
        self.failures = Mock()
        value = WindowsTray(icon_path='/synthetic/icon.ico', on_action=action or Mock(),
                            state=lambda: {}, on_failure=self.failures, driver=driver)
        self.addCleanup(value.stop)
        return value

    def test_injected_start_notify_stop_releases_owner_thread_and_driver(self):
        driver = FakeTrayDriver()
        tray = self.tray(driver)
        self.assertTrue(tray.start())
        tray.notify('棱光反馈')
        self.assertEqual(driver.messages, ['棱光反馈'])
        tray.stop()
        self.assertEqual(driver.cleaned, 1)
        self.assertFalse(tray._thread.is_alive())
        self.failures.assert_not_called()

    def test_creation_failure_never_claims_background_or_dispatches_open_hide(self):
        driver = FakeTrayDriver(fails=True)
        action = Mock()
        tray = self.tray(driver, action)
        ready = tray.start()
        self.assertFalse(ready)
        shell = DesktopShell(supported=True)
        shell.configure(tray_ready=ready)
        self.assertFalse(shell.keeps_background())
        action.assert_not_called()
        self.failures.assert_called_once()
        self.assertEqual(driver.cleaned, 1)

    def test_callbacks_run_outside_notification_loop_and_duplicate_clicks_coalesce(self):
        driver = FakeTrayDriver()
        begun, release = threading.Event(), threading.Event()
        calls = []
        def action(value):
            calls.append(value)
            begun.set()
            release.wait(2)
        tray = self.tray(driver, action)
        self.assertTrue(tray.start())
        driver.dispatch('open')
        self.assertTrue(begun.wait(1))
        driver.dispatch('open')
        tray.notify('仍可处理消息')
        self.assertEqual(driver.messages, ['仍可处理消息'])
        release.set()
        tray.stop()
        self.assertEqual(calls, ['open'])

    def test_unexpected_notification_loop_exit_reports_failure(self):
        driver = FakeTrayDriver()
        tray = self.tray(driver)
        self.assertTrue(tray.start())
        driver.stopped.set()
        tray._thread.join(1)
        self.failures.assert_called_once()
        self.assertFalse(tray._started)


if __name__ == '__main__':
    unittest.main()
