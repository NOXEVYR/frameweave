"""Focused CPU/loopback regressions; no Windows Shell or update helper is run."""

import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from frameweave.desktop_shell import DesktopShell
from frameweave.windows_tray import WindowsTray
import test_service as fixtures


class DirectExitHTTPTests(unittest.TestCase):
    setUp = fixtures.ServiceHTTPTests.setUp
    start_client = fixtures.ServiceHTTPTests.start_client
    stop_client = fixtures.ServiceHTTPTests.stop_client
    request = fixtures.ServiceHTTPTests.request
    post = fixtures.ServiceHTTPTests.post

    def register(self):
        code, _, result = self.post('/api/desktop/heartbeat', {'settings_available': True})
        self.assertEqual(code, 200)
        return result['session_id']

    def test_direct_exit_success_retains_legacy_body_and_typed_response(self):
        self.register()
        code, _, result = self.post('/api/exit', {})
        self.assertEqual((code, result), (200, {'ok': True, 'exiting': True}))
        self.assertTrue(self.app.exit_pending)
        self.thread.join(2)
        self.assertFalse(self.thread.is_alive())
        self.assertTrue(self.app.closed.wait(2))
        self.assertEqual(self.backend.calls, [])

    def test_shutdown_is_armed_only_after_the_http_ack_write_finishes(self):
        sent = threading.Event()
        respond = self.server.RequestHandlerClass.respond
        shutdown = self.server.shutdown
        def observe_response(handler, result, *args, **kwargs):
            value = respond(handler, result, *args, **kwargs)
            if result == {'ok': True, 'exiting': True}:
                sent.set()
            return value
        def observe_shutdown():
            self.assertTrue(sent.is_set(), 'HTTP ACK must be written before the owner can terminate')
            return shutdown()
        with patch.object(self.server.RequestHandlerClass, 'respond', observe_response), \
                patch.object(self.server, 'shutdown', side_effect=observe_shutdown) as stopping:
            self.assertEqual(self.post('/api/exit', {})[0], 200)
            self.thread.join(2)
            self.assertFalse(self.thread.is_alive())
            stopping.assert_called_once()

    def test_direct_exit_and_install_refuse_multiple_registered_live_pages(self):
        self.register(); self.register()
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('no exit authority')):
            for path in ('/api/exit', '/api/updates/install'):
                code, _, result = self.post(path, {})
                self.assertEqual(code, 400, result)
                self.assertIn('其他页面', result['error'])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_task_arriving_after_preflight_is_rejected_by_the_final_guard(self):
        original = self.app.prepare_exit
        def prepare(port, install=False, *, dry_run=False):
            safe = original(port, install, dry_run=dry_run)
            if dry_run:
                self.app.jobs['new-task'] = {'status': 'unknown'}
            return safe
        with patch.object(self.app, 'prepare_exit', side_effect=prepare), \
                patch.object(self.server, 'shutdown', side_effect=AssertionError('must cancel waiter')):
            code, _, result = self.post('/api/exit', {})
            self.assertEqual(code, 400, result)
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_direct_exit_and_install_cannot_bypass_a_pending_tray_command(self):
        self.register()
        self.app.desktop.supported = True
        self.app.desktop.configure(tray_ready=True, open_ui=lambda: True)
        self.assertTrue(self.app.desktop.action('exit'))
        with patch.object(self.app, 'prepare_exit', side_effect=AssertionError('no exit authority')):
            for path in ('/api/exit', '/api/updates/install'):
                self.assertEqual(self.post(path, {})[0], 400)
        self.assertTrue(self.app.desktop.status()['command_pending'])
        self.assertFalse(self.app.closed.is_set())

    def test_new_page_during_pure_preflight_never_reaches_final_commit(self):
        self.register()
        calls = []
        def preflight(port, install=False, *, dry_run=False):
            calls.append(dry_run)
            self.app.desktop.heartbeat({})
            return True
        with patch.object(self.app, 'prepare_exit', side_effect=preflight):
            code, _, result = self.post('/api/exit', {})
        self.assertEqual(code, 400, result)
        self.assertIn('已变化', result['error'])
        self.assertEqual(calls, [True])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_protected_job_recovery_is_not_evidence_that_no_task_exists(self):
        self.stop_client()
        path = self.app.data_dir / 'jobs.json'
        damaged = b'{"unknown_task":'
        path.write_bytes(damaged)
        with patch('frameweave.recovery.preserve_config', side_effect=OSError('synthetic backup failure')):
            self.start_client()
        self.assertIn('jobs.json', self.app.recovery_protected_files)
        code, _, result = self.post('/api/exit', {})
        self.assertEqual(code, 400, result)
        self.assertEqual(path.read_bytes(), damaged)
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.closed.is_set())

    def test_owner_worker_start_failure_is_rejected_before_handoff_or_exit_intent(self):
        original_thread = threading.Thread
        def create_thread(*args, **kwargs):
            if kwargs.get('name') == 'PrismCanvas-owner-exit':
                return SimpleNamespace(start=Mock(side_effect=RuntimeError('synthetic thread start failure')))
            return original_thread(*args, **kwargs)
        with patch('frameweave.server.threading.Thread', side_effect=create_thread), \
                patch.object(self.app.updates, 'status', side_effect=AssertionError('no handoff inspection')):
            for path in ('/api/exit', '/api/updates/install'):
                code, _, result = self.post(path, {})
                self.assertEqual(code, 400, result)
                self.assertIn('线程未能启动', result['error'])
        self.assertFalse(self.app.exit_pending)
        self.assertFalse(self.app.exit_handoff_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertEqual(self.request('GET', '/api/heartbeat')[0], 200)

    def test_shutdown_body_failure_without_handoff_keeps_service_and_reports_failure(self):
        failed = threading.Event()
        def fail():
            raise RuntimeError('synthetic shutdown body failure')
        report = self.app.desktop.owner_shutdown_failed
        def publish(**kwargs):
            report(**kwargs)
            failed.set()
        with patch.object(self.server, 'shutdown', side_effect=fail) as shutdown, \
                patch.object(self.app.desktop, 'owner_shutdown_failed', side_effect=publish):
            self.assertEqual(self.post('/api/exit', {})[0], 200)
            self.assertTrue(failed.wait(1))
            code, _, result = self.post('/api/desktop/heartbeat', {})
            self.assertEqual(code, 200, result)
            self.assertIn('退出失败', result['desktop']['last_error'])
            self.assertFalse(self.app.exit_pending)
            self.assertFalse(self.app.closed.is_set())
            shutdown.assert_called_once()

    def test_shutdown_body_failure_after_handoff_does_not_claim_a_rollback(self):
        failed = threading.Event()
        def fail():
            raise RuntimeError('synthetic shutdown failure')
        report = self.app.desktop.owner_shutdown_failed
        def publish(**kwargs):
            report(**kwargs)
            failed.set()
        original_prepare = self.app.prepare_exit
        def prepare(port, install=False, *, dry_run=False):
            if dry_run:
                return original_prepare(port, install, dry_run=True)
            self.app.exit_handoff_pending = True  # Explicit fake, no helper run.
            self.app.exit_pending = True
            return True
        with patch.object(self.app, 'prepare_exit', side_effect=prepare), \
                patch.object(self.server, 'shutdown', side_effect=fail), \
                patch.object(self.app.desktop, 'owner_shutdown_failed', side_effect=publish):
            self.assertEqual(self.post('/api/updates/install', {})[0], 200)
            self.assertTrue(failed.wait(1))
            status = self.app.desktop.status()
            self.assertIn('尚未确认', status['last_error'])
            self.assertTrue(self.app.exit_pending)
            self.assertFalse(self.app.closed.is_set())
            self.assertEqual(self.post('/api/desktop/heartbeat', {})[0], 400)

    def test_ambiguous_handoff_is_502_and_never_unlocks_or_retries_direct_exit(self):
        import frameweave.update_handoff as handoff
        self.app.settings['auto_update'] = True
        staged = {'verified': True, 'version': '99.0.0'}
        with patch.object(self.app.updates, 'status', return_value={'staged': staged}), \
                patch('frameweave.server.os', SimpleNamespace(name='nt')), \
                patch('frameweave.server.sys.frozen', True, create=True), \
                patch.object(handoff, 'launch_handoff', side_effect=RuntimeError('unknown helper launch')) as launch:
            code, _, result = self.post('/api/exit', {})
            self.assertEqual(code, 502, result)
            self.assertIn('交接结果尚未确认', result['error'])
            self.assertEqual(self.post('/api/exit', {})[0], 400)
            launch.assert_called_once()
        self.assertTrue(self.app.exit_pending)
        self.assertTrue(self.app.exit_handoff_pending)
        self.assertFalse(self.app.closed.is_set())
        self.assertEqual(self.post('/api/desktop/heartbeat', {})[0], 400)
        with self.assertRaisesRegex(ValueError, '正在退出'):
            self.app._dispatch({}, 'api')
        self.assertEqual(self.backend.calls, [])


class DirectExitLockTests(unittest.TestCase):
    def test_a_concurrent_page_cannot_register_between_final_guard_and_commit(self):
        shell = DesktopShell()
        shell.heartbeat({})
        trying, finished = threading.Event(), threading.Event()
        errors = []
        def new_page():
            trying.set()
            try:
                shell.heartbeat({})
            except ValueError as error:
                errors.append(str(error))
            finally:
                finished.set()
        thread = threading.Thread(target=new_page)
        def commit():
            thread.start()
            self.assertTrue(trying.wait(1))
            self.assertFalse(finished.wait(0.02), 'registration must wait behind the final commit lock')
            return True
        self.assertEqual(shell.direct_exit(lambda: True, commit), {'ok': True, 'exiting': True})
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)

    def test_recently_closed_unproven_page_remains_conservative_until_session_expiry(self):
        now = [1000]
        shell = DesktopShell(clock=lambda: now[0])
        shell.heartbeat({}); current = shell.heartbeat({})['session_id']
        now[0] += 119
        shell.heartbeat({'session_id': current})
        commit = Mock(return_value=True)
        with self.assertRaisesRegex(ValueError, '其他页面'):
            shell.direct_exit(lambda: True, commit)
        commit.assert_not_called()
        now[0] += 2
        self.assertEqual(shell.direct_exit(lambda: True, commit), {'ok': True, 'exiting': True})
        commit.assert_called_once()


class Driver:
    def __init__(self):
        self.stop_event = threading.Event()
        self.dispatch = None
        self.cleaned = 0
    def run(self, dispatch, ready):
        self.dispatch = dispatch
        try:
            ready()
            self.stop_event.wait(2)
        finally:
            self.cleaned += 1
    def stop(self):
        self.stop_event.set()
    def notify(self, message):
        pass


class TrayFailureTests(unittest.TestCase):
    def test_owner_and_action_thread_start_failures_return_fallback_instead_of_aborting_window_open(self):
        original_start = threading.Thread.start
        for failed_name in ('PrismCanvas-tray', 'PrismCanvas-tray-actions'):
            with self.subTest(failed_name=failed_name):
                driver, failure = Driver(), Mock()
                tray = WindowsTray(icon_path='/synthetic/icon.ico', on_action=Mock(), state=lambda: {}, on_failure=failure, driver=driver)
                def start(thread):
                    if thread.name == failed_name:
                        raise RuntimeError('synthetic thread start failure')
                    return original_start(thread)
                with patch('frameweave.windows_tray.threading.Thread.start', start):
                    self.assertFalse(tray.start())
                self.assertFalse(tray._started)
                self.assertFalse(tray._worker.is_alive())
                failure.assert_called_once()
                tray.stop()

    def test_failure_callback_exception_does_not_kill_the_action_worker(self):
        driver, failed, handled = Driver(), threading.Event(), threading.Event()
        def action(value):
            if value == 'open':
                raise RuntimeError('synthetic action failure')
            handled.set()
        def feedback():
            failed.set()
            raise RuntimeError('synthetic feedback failure')
        tray = WindowsTray(icon_path='/synthetic/icon.ico', on_action=action, state=lambda: {}, on_failure=feedback, driver=driver)
        self.addCleanup(tray.stop)
        self.assertTrue(tray.start())
        driver.dispatch('open'); self.assertTrue(failed.wait(1))
        driver.dispatch('settings'); self.assertTrue(handled.wait(1))
        self.assertTrue(tray._worker.is_alive())

    def test_driver_stop_error_still_joins_owned_threads_and_clears_ready_state(self):
        driver = Driver()
        tray = WindowsTray(icon_path='/synthetic/icon.ico', on_action=Mock(), state=lambda: {}, on_failure=Mock(), driver=driver)
        self.assertTrue(tray.start())
        def fail_stop():
            driver.stop_event.set()
            raise RuntimeError('synthetic stop error')
        with patch.object(driver, 'stop', side_effect=fail_stop):
            with self.assertRaises(RuntimeError):
                tray.stop()
        self.assertFalse(tray._started)
        self.assertFalse(tray._worker.is_alive())
        self.assertFalse(tray._thread.is_alive())


if __name__ == '__main__':
    unittest.main()
