"""Fake-adapter contract checks; these do not validate the Windows notification area."""

import json
import unittest
from unittest.mock import Mock

from frameweave.desktop_shell import DesktopShell


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class DesktopShellTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.close_action = "background"
        self.open_ui = Mock(return_value=True)
        self.notify = Mock()
        self.shutdown = Mock()
        self.guard = Mock(return_value=True)
        self.shell = DesktopShell(lambda: self.close_action, supported=True,
                                  clock=self.clock)
        self.shell.configure(tray_ready=True, open_ui=self.open_ui,
                             notify=self.notify, shutdown=self.shutdown)
        self.addCleanup(self.shell.close)

    def register(self, *, settings_available=False):
        response = self.shell.heartbeat({"settings_available": settings_available})
        self.assertIsInstance(response, dict)
        self.assertRegex(response["session_id"], r"^[A-Za-z0-9_-]{32,}$")
        return response

    def heartbeat(self, session_id, *, settings_available=False):
        return self.shell.heartbeat({"session_id": session_id,
                                     "settings_available": settings_available})

    def command(self, session_id, *, action="exit", settings_available=False):
        response = self.heartbeat(session_id, settings_available=settings_available)
        command = response["command"]
        self.assertIsInstance(command, dict)
        self.assertRegex(command["id"], r"^[0-9a-f]{32}$")
        self.assertEqual(command["action"], action)
        return command

    def acknowledge(self, session_id, command, *, approved=True, reason="handled"):
        return self.shell.complete({"session_id": session_id,
                                    "command_id": command["id"],
                                    "approved": approved, "reason": reason},
                                   prepare_exit=self.guard)

    def test_fake_supported_adapter_requires_ready_tray_for_background(self):
        self.assertTrue(self.shell.keeps_background())
        self.shell.configure(tray_ready=False, open_ui=self.open_ui,
                             notify=self.notify, shutdown=self.shutdown)
        self.assertFalse(self.shell.keeps_background())
        self.assertIsInstance(self.shell.status(), dict)
        self.shutdown.assert_not_called()

    def test_unsupported_platform_never_keeps_background_even_with_fake_ready(self):
        shell = DesktopShell(lambda: "background", supported=False, clock=self.clock)
        self.addCleanup(shell.close)
        shell.configure(tray_ready=True, open_ui=self.open_ui,
                        notify=self.notify, shutdown=self.shutdown)
        self.assertFalse(shell.keeps_background())
        self.assertIsInstance(shell.status(), dict)

    def test_exit_close_preference_does_not_keep_background(self):
        self.close_action = "idle_exit"
        self.assertFalse(self.shell.keeps_background())
        self.close_action = "background"
        self.assertTrue(self.shell.keeps_background())

    def test_passive_heartbeat_status_and_tick_never_open_or_shutdown(self):
        session = self.register()["session_id"]
        for _ in range(3):
            self.assertIsNone(self.heartbeat(session)["command"])
            self.assertIsInstance(self.shell.status(), dict)
            self.shell.tick()
        self.open_ui.assert_not_called()
        self.shutdown.assert_not_called()
        self.guard.assert_not_called()

    def test_status_does_not_expose_session_tokens_or_command_nonce(self):
        session = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(session)
        public = json.dumps(self.shell.status(), ensure_ascii=False)
        self.assertNotIn(session, public)
        self.assertNotIn(command["id"], public)
        self.shutdown.assert_not_called()

    def test_exit_without_registered_pages_only_opens_and_waits_for_delivery(self):
        self.shell.action("exit")
        self.open_ui.assert_called_once()
        self.shutdown.assert_not_called()
        self.guard.assert_not_called()
        response = self.register()
        self.assertIsInstance(response["command"], dict)
        self.assertEqual(response["command"]["action"], "exit")
        self.shutdown.assert_not_called()

    def test_pending_exit_heartbeats_and_ticks_do_not_reopen_the_window(self):
        session = self.register()["session_id"]
        self.shell.action("exit")
        self.open_ui.assert_called_once()
        command = self.command(session)
        for _ in range(3):
            self.shell.tick()
            self.assertEqual(self.command(session), command)
        self.open_ui.assert_called_once()
        self.shutdown.assert_not_called()

    def test_expired_exit_is_not_redelivered_or_automatically_reopened(self):
        self.assertEqual(self.shell.status()["command_timeout_seconds"], 60)
        session = self.register()["session_id"]
        self.shell.action("exit")
        self.command(session)
        self.clock.advance(61)
        self.shell.tick()
        for _ in range(3):
            self.assertIsNone(self.heartbeat(session)["command"])
            self.shell.tick()
        self.open_ui.assert_called_once()
        self.shutdown.assert_not_called()

    def test_settings_only_delivered_to_a_currently_capable_page(self):
        incapable = self.register()["session_id"]
        capable = self.register(settings_available=True)["session_id"]
        self.assertTrue(self.shell.status()["settings_available"])
        self.assertTrue(self.shell.action("settings"))
        self.assertIsNone(self.heartbeat(incapable)["command"])
        self.assertIsNone(self.heartbeat(capable, settings_available=False)["command"])
        command = self.command(capable, action="settings", settings_available=True)
        result = self.acknowledge(capable, command)
        self.assertTrue(result["ok"])
        self.assertFalse(result["exiting"])
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertFalse(self.shell.status()["command_pending"])

    def test_settings_without_capability_reports_error_and_does_not_guess_a_route(self):
        session = self.register()["session_id"]
        self.assertFalse(self.shell.action("settings"))
        self.assertFalse(self.shell.status()["command_pending"])
        self.assertTrue(self.shell.status()["last_error"])
        self.notify.assert_called_once()
        self.assertIsNone(self.heartbeat(session)["command"])
        self.shutdown.assert_not_called()

    def test_registered_page_cannot_ack_a_command_not_delivered_to_it(self):
        delivered = self.register()["session_id"]
        undelivered = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(delivered)
        with self.assertRaises(ValueError):
            self.acknowledge(undelivered, command)
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertTrue(self.shell.status()["command_pending"])

    def test_foreign_session_or_nonce_cannot_authorize_exit(self):
        session = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(session)
        foreign_id = "0" * 32 if command["id"] != "0" * 32 else "1" * 32
        for forged_session, forged_command in [("SYNTHETIC_UNISSUED_SESSION_TOKEN_12345", command),
                                                (session, {"id": foreign_id})]:
            with self.subTest(session=forged_session == session):
                with self.assertRaises(ValueError):
                    self.acknowledge(forged_session, forged_command)
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()

    def test_expired_completion_cannot_call_exit_guard_even_without_explicit_tick(self):
        session = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(session)
        self.clock.advance(59)
        self.assertEqual(self.command(session), command)
        self.clock.advance(1)
        with self.assertRaises(ValueError):
            self.acknowledge(session, command)
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertFalse(self.shell.status()["command_pending"])

    def test_each_decline_reason_keeps_running_and_invalidates_the_old_command(self):
        session = self.register()["session_id"]
        for reason in ("busy", "draft-save-failed", "handled", "unsupported",
                       "client-error", "cancelled"):
            with self.subTest(reason=reason):
                self.shell.action("exit")
                command = self.command(session)
                result = self.acknowledge(session, command, approved=False, reason=reason)
                self.assertFalse(result["ok"])
                self.assertFalse(result["exiting"])
                self.assertTrue(result["error"])
                self.assertFalse(self.shell.status()["command_pending"])
                with self.assertRaises(ValueError):
                    self.acknowledge(session, command)
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()

    def test_all_registered_live_pages_must_approve_before_backend_guard(self):
        first = self.register()["session_id"]
        second = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(first)
        self.assertEqual(self.command(second), command)
        first_result = self.acknowledge(first, command)
        self.assertFalse(first_result["exiting"])
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()
        final = self.acknowledge(second, command)
        self.assertTrue(final["ok"])
        self.assertTrue(final["exiting"])
        self.guard.assert_called_once_with()
        self.shutdown.assert_called_once_with()
        with self.assertRaises(ValueError):
            self.acknowledge(second, command)
        self.shutdown.assert_called_once_with()

    def test_new_page_joins_an_already_partly_approved_exit(self):
        first = self.register()["session_id"]
        second = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(first)
        self.command(second)
        self.acknowledge(first, command)
        newcomer = self.register()
        self.assertEqual(newcomer["command"], command)
        self.assertFalse(self.acknowledge(second, command)["exiting"])
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertTrue(self.acknowledge(newcomer["session_id"], command)["exiting"])
        self.shutdown.assert_called_once_with()

    def test_a_decline_from_any_page_cancels_pending_exit_for_every_page(self):
        first = self.register()["session_id"]
        second = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(first)
        self.command(second)
        self.acknowledge(first, command)
        self.acknowledge(second, command, approved=False, reason="cancelled")
        with self.assertRaises(ValueError):
            self.acknowledge(first, command)
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()

    def test_page_registered_during_guard_must_also_approve_before_shutdown(self):
        session = self.register()["session_id"]
        newcomer = []

        def reentrant_guard():
            if not newcomer:
                newcomer.append(self.register())
            return True

        self.guard.side_effect = reentrant_guard
        self.shell.action("exit")
        command = self.command(session)
        first = self.acknowledge(session, command)
        self.assertFalse(first["exiting"])
        self.assertEqual(newcomer[0]["command"], command)
        self.shutdown.assert_not_called()
        self.assertTrue(self.acknowledge(newcomer[0]["session_id"], command)["exiting"])
        self.assertEqual(self.guard.call_count, 2)
        self.shutdown.assert_called_once_with()

    def test_backend_guard_false_keeps_running_and_never_automatically_retries(self):
        session = self.register()["session_id"]
        self.guard.return_value = False
        self.shell.action("exit")
        command = self.command(session)
        result = self.acknowledge(session, command)
        self.assertFalse(result["exiting"])
        self.assertFalse(result["ok"])
        self.assertTrue(result["error"])
        for _ in range(3):
            self.shell.tick()
            self.heartbeat(session)
        self.guard.assert_called_once_with()
        self.shutdown.assert_not_called()
        self.open_ui.assert_called_once_with()

    def test_guard_exception_keeps_running_without_leaking_callback_details(self):
        session = self.register()["session_id"]
        self.guard.side_effect = RuntimeError("SYNTHETIC private guard detail")
        self.shell.action("exit")
        result = self.acknowledge(session, self.command(session))
        self.assertFalse(result["exiting"])
        self.assertFalse(result["ok"])
        self.assertNotIn("SYNTHETIC private guard detail", json.dumps(result))
        self.assertNotIn("SYNTHETIC private guard detail", self.shell.status()["last_error"])
        self.shell.tick()
        self.guard.assert_called_once_with()
        self.shutdown.assert_not_called()

    def test_command_expiring_inside_exit_guard_cannot_authorize_late_shutdown(self):
        session = self.register()["session_id"]
        self.guard.side_effect = lambda: self.clock.advance(61) or True
        self.shell.action("exit")
        result = self.acknowledge(session, self.command(session))
        self.assertFalse(result["exiting"])
        self.shutdown.assert_not_called()
        self.shell.tick()
        self.guard.assert_called_once_with()

    def test_close_during_exit_guard_invalidates_its_late_callback(self):
        session = self.register()["session_id"]
        self.guard.side_effect = lambda: self.shell.close() or True
        self.shell.action("exit")
        result = self.acknowledge(session, self.command(session))
        self.assertFalse(result["exiting"])
        self.shutdown.assert_not_called()

    def test_open_failure_or_exception_never_hides_failure_with_a_background_retry(self):
        self.open_ui.return_value = False
        self.assertFalse(self.shell.action("exit"))
        self.assertFalse(self.shell.status()["command_pending"])
        self.assertTrue(self.shell.status()["last_error"])
        self.open_ui.side_effect = RuntimeError("SYNTHETIC private opener detail")
        self.assertFalse(self.shell.action("exit"))
        self.assertNotIn("SYNTHETIC private opener detail", self.shell.status()["last_error"])
        for _ in range(3):
            self.shell.tick()
        self.assertEqual(self.open_ui.call_count, 2)
        self.shutdown.assert_not_called()

    def test_notification_exception_does_not_authorize_exit_or_repeat_commands(self):
        self.notify.side_effect = RuntimeError("SYNTHETIC notifier failure")
        session = self.register()["session_id"]
        self.assertFalse(self.shell.action("settings"))
        for _ in range(3):
            self.assertIsNone(self.heartbeat(session)["command"])
            self.shell.tick()
        self.notify.assert_called_once()
        self.shutdown.assert_not_called()

    def test_session_limit_refuses_new_pages_without_evicting_live_pages(self):
        sessions = [self.register()["session_id"] for _ in range(32)]
        self.assertEqual(len(set(sessions)), 32)
        with self.assertRaises(ValueError):
            self.register()
        self.assertEqual(self.heartbeat(sessions[0])["session_id"], sessions[0])
        self.clock.advance(121)
        replacement = self.register()["session_id"]
        self.assertNotIn(replacement, sessions)
        with self.assertRaises(ValueError):
            self.heartbeat(sessions[0])
        self.shutdown.assert_not_called()

    def test_stale_settings_capability_does_not_enable_settings_command(self):
        self.register(settings_available=True)
        self.clock.advance(121)
        self.assertFalse(self.shell.status()["settings_available"])
        self.assertFalse(self.shell.action("settings"))
        self.assertFalse(self.shell.status()["command_pending"])

    def test_unknown_session_and_invalid_payload_cannot_create_an_exit_approval(self):
        with self.assertRaises(ValueError):
            self.heartbeat("SYNTHETIC_UNISSUED_SESSION_TOKEN_12345")
        for body in [{"settings_available": "true"}, {"unexpected": "SYNTHETIC"}, []]:
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    self.shell.heartbeat(body)
        session = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(session)
        for change in [{"approved": 1}, {"reason": "SYNTHETIC arbitrary reason"},
                       {"unexpected": "SYNTHETIC"}]:
            body = {"session_id": session, "command_id": command["id"], "approved": True}
            body.update(change)
            with self.subTest(change=change):
                with self.assertRaises(ValueError):
                    self.shell.complete(body, prepare_exit=self.guard)
        self.guard.assert_not_called()
        self.shutdown.assert_not_called()

    def test_duplicate_exit_click_does_not_replace_the_command_or_reopen_again(self):
        session = self.register()["session_id"]
        self.assertTrue(self.shell.action("exit"))
        command = self.command(session)
        self.assertFalse(self.shell.action("exit"))
        self.assertEqual(self.command(session), command)
        self.open_ui.assert_called_once_with()
        self.shutdown.assert_not_called()

    def test_only_explicit_new_action_after_timeout_creates_a_new_command(self):
        session = self.register()["session_id"]
        self.shell.action("exit")
        original = self.command(session)
        self.clock.advance(61)
        self.shell.tick()
        self.assertIsNone(self.heartbeat(session)["command"])
        self.open_ui.assert_called_once_with()
        self.assertTrue(self.shell.action("exit"))
        self.assertNotEqual(self.command(session)["id"], original["id"])
        self.assertEqual(self.open_ui.call_count, 2)

    def test_close_is_idempotent_and_discards_old_commands_and_page_registrations(self):
        session = self.register(settings_available=True)["session_id"]
        self.shell.action("exit")
        command = self.command(session)
        self.shell.close()
        self.shell.close()
        status = self.shell.status()
        self.assertFalse(status["tray_ready"])
        self.assertFalse(status["settings_available"])
        self.assertFalse(status["command_pending"])
        self.assertFalse(self.shell.keeps_background())
        for action in ("open", "settings", "exit"):
            self.assertFalse(self.shell.action(action))
        with self.assertRaises(ValueError):
            self.heartbeat(session)
        with self.assertRaises(ValueError):
            self.acknowledge(session, command)
        self.open_ui.assert_called_once_with()
        self.shutdown.assert_not_called()

    def test_final_commit_runs_once_only_after_all_live_pages_approve(self):
        order = []
        self.guard.side_effect = lambda: order.append("preflight") or True
        commit = Mock(side_effect=lambda: order.append("commit") or True)
        self.shutdown.side_effect = lambda: order.append("shutdown")
        first = self.register()["session_id"]
        second = self.register()["session_id"]
        self.shell.action("exit")
        command = self.command(first)
        self.command(second)
        body = {"command_id": command["id"], "approved": True, "reason": "handled"}
        pending = self.shell.complete({**body, "session_id": first}, self.guard,
                                      commit_exit=commit)
        self.assertFalse(pending["exiting"])
        self.guard.assert_not_called()
        commit.assert_not_called()
        self.shutdown.assert_not_called()
        done = self.shell.complete({**body, "session_id": second}, self.guard,
                                   commit_exit=commit)
        self.assertTrue(done["ok"])
        self.assertTrue(done["exiting"])
        self.assertEqual(order, ["preflight", "commit", "shutdown"])
        commit.assert_called_once_with()
        self.shutdown.assert_called_once_with()
        with self.assertRaises(ValueError):
            self.shell.complete({**body, "session_id": second}, self.guard,
                                commit_exit=commit)
        commit.assert_called_once_with()

    def test_late_page_or_expired_preflight_never_calls_final_commit(self):
        for change in ("late-page", "expired"):
            with self.subTest(change=change):
                clock = FakeClock()
                shell = DesktopShell(lambda: "background", supported=True, clock=clock)
                self.addCleanup(shell.close)
                shutdown = Mock()
                opener = Mock(return_value=True)
                commit = Mock(return_value=True)
                shell.configure(tray_ready=True, open_ui=opener, shutdown=shutdown)
                session = shell.heartbeat({})["session_id"]
                shell.action("exit")
                command = shell.heartbeat({"session_id": session})["command"]

                def changed_preflight():
                    if change == "late-page":
                        shell.heartbeat({})
                    else:
                        clock.advance(61)
                    return True

                guard = Mock(side_effect=changed_preflight)
                result = shell.complete({"session_id": session, "command_id": command["id"],
                                         "approved": True}, guard, commit_exit=commit)
                self.assertFalse(result["exiting"])
                for _ in range(3):
                    shell.tick()
                    shell.heartbeat({"session_id": session})
                guard.assert_called_once_with()
                commit.assert_not_called()
                shutdown.assert_not_called()
                opener.assert_called_once_with()

    def test_failed_or_raising_final_commit_never_shuts_down_or_automatically_retries(self):
        session = self.register()["session_id"]
        for outcome in ("false", "exception"):
            with self.subTest(outcome=outcome):
                self.guard.reset_mock()
                self.open_ui.reset_mock()
                commit = Mock(return_value=False) if outcome == "false" else Mock(
                    side_effect=RuntimeError("SYNTHETIC private final-commit detail"))
                self.shell.action("exit")
                command = self.command(session)
                body = {"session_id": session, "command_id": command["id"], "approved": True}
                result = self.shell.complete(body, self.guard, commit_exit=commit)
                self.assertFalse(result["ok"])
                self.assertFalse(result["exiting"])
                self.assertTrue(result["error"])
                self.assertNotIn("SYNTHETIC private final-commit detail", json.dumps(result))
                self.assertFalse(self.shell.status()["command_pending"])
                for _ in range(3):
                    self.shell.tick()
                    self.assertIsNone(self.heartbeat(session)["command"])
                with self.assertRaises(ValueError):
                    self.shell.complete(body, self.guard, commit_exit=commit)
                self.guard.assert_called_once_with()
                commit.assert_called_once_with()
                self.shutdown.assert_not_called()
                self.open_ui.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
