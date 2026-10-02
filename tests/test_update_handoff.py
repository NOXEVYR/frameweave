"""Update handoff tests use temporary executables and fake processes/services."""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from frameweave import update_handoff as handoff


TOKEN = "A" * 43


class FakeLock:
    def __init__(self, acquired=True):
        self.acquired = acquired
        self.released = False

    def acquire(self):
        return self.acquired

    def release(self):
        self.released = True


class FakeProcess:
    def __init__(self, code=None):
        self.code = code

    def poll(self):
        return self.code


class FakeHTTPResponse:
    status = 200

    def __init__(self, body):
        self.body = body

    def getheader(self, name, default=None):
        return {"Content-Type": "application/json; charset=utf-8",
                "Content-Length": str(len(self.body))}.get(name, default)

    def read(self, limit=-1):
        return self.body[:limit]


class FakeHTTPConnection:
    def __init__(self, _host, _port, timeout):
        self.timeout = timeout
        self.requested = None

    def request(self, method, path, headers):
        self.requested = (method, path, headers)

    def getresponse(self):
        return FakeHTTPResponse(json.dumps({
            "application": "PrismCanvas", "version": "0.10.0", "csrf": TOKEN,
        }).encode("utf-8"))

    def close(self):
        pass


class UpdateHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "userdata"
        self.staging = self.data / "updates" / "staged"
        self.staging.mkdir(parents=True)
        self.install_base = self.root / "PrismCanvas"
        old_dir = self.install_base / "PrismCanvas-0.9.0"
        old_dir.mkdir(parents=True)
        self.old_exe = old_dir / "PrismCanvas.exe"
        self.old_exe.write_bytes(b"old exe")
        self.archive = self.staging / "PrismCanvas-v0.10.0-Windows-x64.zip"
        self.archive.write_bytes(b"verified stage bytes")
        self.staged = {
            "version": "0.10.0", "filename": self.archive.name,
            "path": str(self.archive.resolve()), "bytes": self.archive.stat().st_size,
            "sha256": hashlib.sha256(self.archive.read_bytes()).hexdigest(),
            "exe_bytes": len(b"new exe"), "exe_sha256": hashlib.sha256(b"new exe").hexdigest(),
            "verified": True, "installed": False,
        }
        updates = self.data / "updates"
        self.helper = updates / "update-helper-12345678-1234-1234-1234-123456789abc.exe"
        self.helper.write_bytes(b"helper copy")
        self.plan_path = updates / "handoff-12345678-1234-1234-1234-123456789abc.json"
        self.result_path = self.plan_path.with_suffix(".result.json")
        self.plan = {
            "version": 1, "helper_exe": str(self.helper), "result_path": str(self.result_path),
            "current_exe": str(self.old_exe), "install_base": str(self.install_base),
            "data_dir": str(self.data), "staged": self.staged, "port": 8765,
            "open_browser": True,
            "current_version": "0.9.0",
            "current_sha256": hashlib.sha256(self.old_exe.read_bytes()).hexdigest(),
            "candidate_nonce": "f" * 64, "old_processes": [],
        }
        self.write_plan()
        self.new_exe = self.install_base / "PrismCanvas-0.10.0" / "PrismCanvas.exe"
        self.new_exe.parent.mkdir(parents=True)
        self.new_exe.write_bytes(b"new exe")
        self.lock = FakeLock()

    def write_plan(self):
        self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")

    def prepared(self):
        content = self.new_exe.read_bytes()
        return {
            "version": "0.10.0", "path": str(self.new_exe.resolve()),
            "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
            "verified": True, "installed": False, "previous_exe": str(self.old_exe),
        }

    def run_with(self, **overrides):
        defaults = {
            "lock_factory": lambda _data: self.lock,
            "prepare_install_fn": lambda staged, base, old: self.prepared(),
            "spawn": Mock(return_value=FakeProcess()),
            "probe_fn": lambda port, version: {
                "application": "PrismCanvas", "version": version, "csrf": TOKEN,
            },
            "port_in_use_fn": lambda port: False,
            "shortcut_fn": lambda old, new, version, **kwargs: {
                "updated": 1, "backups": [{"shortcut": "desktop.lnk", "backup": "shortcut.bak",
                                             "updated_sha256": "b" * 64}],
            },
            "sleep_fn": lambda _seconds: None,
            "health_timeout": 0,
            "lock_timeout": 0,
        }
        defaults.update(overrides)
        original_probe = defaults["probe_fn"]
        metadata = {}

        def bound_probe(port, version):
            value = original_probe(port, version)
            if isinstance(value, dict):
                value = dict(value)
                instance = {"nonce": self.plan["candidate_nonce"] if version == "0.10.0" else "",
                            "pid": 321, "data_dir": str(self.data),
                            "executable": str(self.new_exe if version == "0.10.0" else self.old_exe)}
                value.setdefault("instance", instance)
                metadata.update({"instance": value["instance"], "pid": 321,
                                 "url": f"http://127.0.0.1:{port}/", "version": value["version"]})
            return value

        defaults["probe_fn"] = bound_probe
        defaults.setdefault("metadata_fn", lambda _: dict(metadata))
        return handoff.run_handoff(self.plan_path, **defaults), defaults

    def test_launch_copies_helper_writes_plan_and_starts_hidden_without_user_command(self):
        launch_args = []

        def fake_popen(args, **kwargs):
            launch_args.append((args, kwargs))
            return FakeProcess()

        with patch.object(handoff.subprocess, "Popen", side_effect=fake_popen), patch.object(handoff, "__version__", "0.9.0"):
            queued = handoff.launch_handoff(self.old_exe, self.data, self.staged, 8765)
        self.assertTrue(queued["queued"])
        self.assertEqual(queued["version"], "0.10.0")
        self.assertRegex(queued["handoff_id"], r"^[0-9a-f-]{36}$")
        args, options = launch_args[0]
        self.assertEqual(args[1], "--apply-update")
        self.assertTrue(Path(args[0]).is_file())
        self.assertTrue(Path(args[2]).is_file())
        self.assertNotIn("--backend", args)
        self.assertFalse(options["shell"])
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertEqual(options["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(options["env"]["PYINSTALLER_RESET_ENVIRONMENT"], "1")
        plan = json.loads(Path(args[2]).read_text(encoding="utf-8"))
        self.assertEqual(plan["data_dir"], str(self.data.resolve()))
        self.assertEqual(plan["port"], 8765)
        self.assertEqual(Path(plan["current_exe"]), self.old_exe)

    def test_handoff_prepares_then_starts_same_data_and_port_and_retargets_links(self):
        child = FakeProcess()
        spawn = Mock(return_value=child)
        prepare = Mock(side_effect=lambda staged, base, old: self.prepared())
        backups = [
            {"shortcut": "a.lnk", "backup": "a.bak", "updated_sha256": "a" * 64},
            {"shortcut": "b.lnk", "backup": "b.bak", "updated_sha256": "b" * 64},
        ]
        shortcut = Mock(return_value={"updated": 2, "backups": backups})
        result, deps = self.run_with(spawn=spawn, prepare_install_fn=prepare, shortcut_fn=shortcut)
        self.assertEqual(result["state"], "installed")
        prepare.assert_called_once_with(self.staged, str(self.install_base), str(self.old_exe))
        args = spawn.call_args.args[0]
        self.assertEqual(args, [str(self.new_exe), "--data-dir", str(self.data), "--port", "8765"])
        self.assertNotIn("--backend", args)
        self.assertEqual(spawn.call_args.kwargs["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(spawn.call_args.kwargs["env"]["PYINSTALLER_RESET_ENVIRONMENT"], "1")
        self.assertEqual(spawn.call_args.kwargs["env"]["PRISMCANVAS_UPDATE_NONCE"], self.plan["candidate_nonce"])
        shortcut.assert_called_once_with(
            str(self.old_exe), str(self.new_exe), "0.10.0",
            backup_dir=self.data / "updates" / "shortcut-backups",
        )
        self.assertTrue(self.lock.released)
        self.assertNotIn(TOKEN, json.dumps(result))
        self.assertNotIn(TOKEN, self.result_path.read_text(encoding="utf-8"))
        self.assertEqual(json.loads(self.result_path.read_text(encoding="utf-8"))["state"], "installed")

    def test_unverified_running_candidate_is_not_killed_and_old_is_not_started(self):
        spawn = Mock(return_value=FakeProcess())
        shutdown = Mock(return_value=True)
        probe = Mock(return_value=None)
        with patch.object(handoff, "_post_shutdown", shutdown):
            result, _ = self.run_with(spawn=spawn, probe_fn=probe,
                                      shortcut_fn=Mock(side_effect=AssertionError("identity must be checked first")))
        self.assertEqual(result["state"], "candidate-unverified")
        self.assertEqual(spawn.call_count, 1)
        shutdown.assert_not_called()

    def test_shortcut_failure_with_changed_candidate_identity_does_not_shutdown_or_restart_old(self):
        spawn = Mock(return_value=FakeProcess())
        shutdown = Mock(return_value=True)
        probe = Mock(side_effect=[
            {"application": "PrismCanvas", "version": "0.10.0", "csrf": TOKEN},
            {"application": "PrismCanvas", "version": "0.9.0", "csrf": TOKEN},
        ])
        with patch.object(handoff, "_post_shutdown", shutdown):
            result, _ = self.run_with(spawn=spawn, probe_fn=probe,
                                      shortcut_fn=Mock(side_effect=OSError("shortcut failed")))
        self.assertEqual(result["state"], "shortcut-failed")
        self.assertEqual(spawn.call_count, 1)
        shutdown.assert_not_called()

    def test_final_health_failure_restores_shortcut_mapping_without_killing_live_candidate(self):
        child = FakeProcess()
        spawn = Mock(return_value=child)
        backup_map = [{"shortcut": "desktop.lnk", "backup": "backup.lnk",
                       "updated_sha256": "d" * 64}]
        probe = Mock(side_effect=[
            {"application": "PrismCanvas", "version": "0.10.0", "csrf": TOKEN},
            None,
        ])
        restore = Mock(return_value={"restored": 1, "skipped": 0})
        result, _ = self.run_with(spawn=spawn, probe_fn=probe,
                                  shortcut_fn=lambda *args, **kwargs: {"updated": 1, "backups": backup_map},
                                  restore_shortcuts_fn=restore)
        self.assertEqual(result["state"], "candidate-unverified")
        self.assertEqual(spawn.call_count, 1)
        restore.assert_called_once_with(
            backup_map, backup_dir=self.data / "updates" / "shortcut-backups",
        )

    def test_bootstrap_probe_accepts_staged_future_version_without_current_version_gate(self):
        with patch.object(handoff.http.client, "HTTPConnection", FakeHTTPConnection):
            payload = handoff._probe_candidate(8765, "0.10.0")
        self.assertEqual(payload["version"], "0.10.0")
        self.assertEqual(payload["application"], "PrismCanvas")
        self.assertEqual(payload["csrf"], TOKEN)
        self.assertIsNone(handoff._probe_candidate(8765, "0.9.0"))

    def test_exited_candidate_and_free_port_restarts_old_version_safely(self):
        spawn = Mock(side_effect=[FakeProcess(code=1), FakeProcess()])
        result, _ = self.run_with(spawn=spawn, probe_fn=lambda *_: None, health_timeout=0,
                                  port_in_use_fn=lambda _port: False)
        self.assertEqual(result["state"], "recovery-unverified")
        self.assertEqual(spawn.call_count, 2)
        self.assertEqual(spawn.call_args.args[0][0], str(self.old_exe))

    def test_occupied_port_prevents_candidate_install_and_start(self):
        prepare = Mock(side_effect=AssertionError("must not extract when port is busy"))
        spawn = Mock()
        result, _ = self.run_with(prepare_install_fn=prepare, spawn=spawn,
                                  port_in_use_fn=lambda _port: True)
        self.assertEqual(result["state"], "port-occupied")
        prepare.assert_not_called()
        spawn.assert_not_called()

    def test_lock_wait_timeout_does_not_start_any_process(self):
        attempts = []

        def factory(_data):
            attempts.append(True)
            return FakeLock(acquired=False)

        result, deps = self.run_with(lock_factory=factory, lock_timeout=0, spawn=Mock())
        self.assertEqual(result["state"], "instance-busy")
        self.assertEqual(len(attempts), 1)
        deps["spawn"].assert_not_called()

    def test_prepare_failure_restores_old_only_when_target_port_is_free(self):
        spawn = Mock(return_value=FakeProcess())
        result, _ = self.run_with(spawn=spawn,
                                  prepare_install_fn=Mock(side_effect=RuntimeError("unpack rejected")),
                                  port_in_use_fn=lambda _port: False)
        self.assertEqual(result["state"], "recovered-old-version")
        self.assertEqual(spawn.call_count, 1)
        self.assertEqual(spawn.call_args.args[0][0], str(self.old_exe))

    def test_shortcut_failure_shuts_down_only_after_fresh_candidate_identity(self):
        spawn = Mock(side_effect=[FakeProcess(), FakeProcess()])
        ports = iter([False, False, False])
        candidate = FakeProcess()
        spawn = Mock(side_effect=[candidate, FakeProcess()])
        shutdown = Mock(side_effect=lambda *args: setattr(candidate, "code", 0) or True)
        with patch.object(handoff, "_post_shutdown", shutdown):
            # The handoff's safe shutdown path calls _post_shutdown only after
            # a fresh exact-version/token identity probe succeeds.
            result, _ = self.run_with(spawn=spawn,
                                      shortcut_fn=Mock(side_effect=OSError("desktop read-only")),
                                      port_in_use_fn=lambda _port: next(ports, False),
                                      probe_fn=lambda port, version: {
                                          "application": "PrismCanvas", "version": version, "csrf": TOKEN,
                                      })
        self.assertEqual(result["state"], "rolled-back")
        shutdown.assert_called_once_with(8765, TOKEN)
        self.assertEqual(spawn.call_count, 2)
        self.assertEqual(spawn.call_args.args[0][0], str(self.old_exe))

    def test_shortcut_powershell_inputs_are_encoded_and_backups_are_required(self):
        mapping = {"shortcut": str(self.root / "Desktop.lnk"),
                   "backup": str(self.data / "updates" / "shortcut-backups" / "shortcut.bak"),
                   "updated_sha256": "c" * 64}
        output = json.dumps({"ok": True, "updated": 1, "backups": [mapping]})
        called = {}

        def runner(args, **kwargs):
            called["args"] = args
            called["kwargs"] = kwargs
            return Mock(returncode=0, stdout=output)

        with patch.object(handoff.os, "name", "nt"):
            result = handoff.update_desktop_shortcuts(
                self.old_exe, self.new_exe, "0.10.0", backup_dir=self.data / "updates" / "shortcut-backups",
                runner=runner,
            )
        self.assertEqual(result, {"updated": 1, "backups": [mapping]})
        command = called["args"]
        self.assertEqual(command[-2], "-EncodedCommand")
        script = base64.b64decode(command[-1]).decode("utf-16le")
        self.assertIn("FromBase64String", script)
        self.assertIn("Copy-Item -LiteralPath $path -Destination $backup", script)
        self.assertIn("$link.WorkingDirectory = [IO.Path]::GetDirectoryName($new)", script)
        self.assertIn("$link.IconLocation = $new + ',0'", script)
        self.assertIn("updated_sha256", script)
        self.assertNotIn(str(self.old_exe), script)
        self.assertNotIn(str(self.new_exe), script)
        self.assertIn("$backupDir", script)
        self.assertIn("shortcut-' + [guid]::NewGuid()", script)
        self.assertEqual(called["kwargs"]["encoding"], "utf-8")
        self.assertEqual(called["kwargs"]["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def test_shortcut_restore_is_exact_mapping_and_hash_guarded(self):
        desktop_shortcut = self.root / "Desktop.lnk"
        desktop_shortcut.write_bytes(b"updated shortcut")
        backup_dir = self.data / "updates" / "shortcut-backups"
        backup_dir.mkdir(parents=True)
        backup_file = backup_dir / "shortcut-123.lnk.bak"
        backup_file.write_bytes(b"old shortcut")
        mapping = [{
            "shortcut": str(desktop_shortcut), "backup": str(backup_file),
            "updated_sha256": hashlib.sha256(desktop_shortcut.read_bytes()).hexdigest(),
        }]
        called = {}

        def runner(args, **kwargs):
            called["args"] = args
            return Mock(returncode=0, stdout=json.dumps({"restored": 1, "skipped": 0}))

        with patch.object(handoff.os, "name", "nt"):
            result = handoff.restore_desktop_shortcuts(mapping, backup_dir=backup_dir, runner=runner)
        script = base64.b64decode(called["args"][-1]).decode("utf-16le")
        self.assertEqual(result, {"restored": 1, "skipped": 0})
        self.assertIn("updated_sha256", script)
        self.assertIn("$current -cne", script)
        self.assertIn("Copy-Item -LiteralPath $backup -Destination $shortcut", script)
        self.assertNotIn(str(desktop_shortcut), script)

    def test_plan_rejects_staged_archive_outside_local_update_folder(self):
        outside = self.root / "outside.zip"
        outside.write_bytes(b"not trusted")
        self.plan["staged"] = {**self.staged, "path": str(outside)}
        self.write_plan()
        result, _ = self.run_with()
        self.assertEqual(result["state"], "failed")

    def test_same_version_listener_with_wrong_nonce_does_not_switch_or_shutdown(self):
        shortcut = Mock()
        shutdown = Mock()
        payload = {"application": "PrismCanvas", "version": "0.10.0", "csrf": TOKEN,
                   "instance": {"nonce": "0" * 64, "pid": 321, "data_dir": str(self.data),
                                "executable": str(self.new_exe)}}
        with patch.object(handoff, "_post_shutdown", shutdown):
            result, _ = self.run_with(probe_fn=lambda *_: payload, shortcut_fn=shortcut)
        self.assertEqual(result["state"], "candidate-unverified")
        shortcut.assert_not_called()
        shutdown.assert_not_called()

    def test_bootstrap_must_match_persistent_data_directory_metadata(self):
        shortcut = Mock()
        result, _ = self.run_with(metadata_fn=lambda _: {}, shortcut_fn=shortcut)
        self.assertEqual(result["state"], "candidate-unverified")
        shortcut.assert_not_called()

    def test_original_process_parent_must_exit_before_extraction(self):
        prepare = Mock()
        waiter = Mock(return_value=False)
        result, _ = self.run_with(process_wait_fn=waiter, prepare_install_fn=prepare)
        self.assertEqual(result["state"], "instance-busy")
        prepare.assert_not_called()
        waiter.assert_called_once()

    def test_finished_transaction_is_idempotent_and_keeps_durable_phases(self):
        first, _ = self.run_with()
        spawn = Mock()
        second, _ = self.run_with(spawn=spawn)
        self.assertEqual(first, second)
        spawn.assert_not_called()
        journal = json.loads(self.plan_path.with_suffix(".transaction.json").read_text(encoding="utf-8"))
        self.assertEqual(journal["phase"], "finished")
        self.assertEqual(journal["previous_exe"], str(self.old_exe))
        self.assertEqual(journal["candidate_exe"], str(self.new_exe))
        self.assertNotIn(TOKEN, json.dumps(journal))

    def test_interrupted_launch_is_preserved_and_not_replayed(self):
        journal = self.plan_path.with_suffix(".transaction.json")
        journal.write_text(json.dumps({"phase": "launching-candidate"}), encoding="utf-8")
        spawn = Mock()
        result, _ = self.run_with(spawn=spawn)
        self.assertEqual(result["state"], "transaction-interrupted")
        spawn.assert_not_called()
        self.assertEqual(json.loads(journal.read_text(encoding="utf-8"))["phase"], "launching-candidate")

    def test_missing_candidate_poll_cannot_count_as_exited(self):
        spawn = Mock(return_value=object())
        result, _ = self.run_with(spawn=spawn, probe_fn=lambda *_: None)
        self.assertEqual(result["state"], "candidate-unverified")
        self.assertEqual(spawn.call_count, 1)

    def test_equal_version_plan_is_rejected_without_starting(self):
        self.plan["current_version"] = self.staged["version"]
        self.write_plan()
        spawn = Mock()
        result, _ = self.run_with(spawn=spawn)
        self.assertEqual(result["state"], "failed")
        spawn.assert_not_called()

    def test_pyinstaller_environment_is_reset_and_nonce_is_not_inherited_by_rollback(self):
        spawn = Mock(return_value=FakeProcess())
        with patch.dict(os.environ, {"PRISMCANVAS_UPDATE_NONCE": "old-value"}):
            handoff._spawn_candidate(self.old_exe, self.data, 8765, False,
                                     self.data / "updates" / "test.log", spawn)
        self.assertNotIn("PRISMCANVAS_UPDATE_NONCE", spawn.call_args.kwargs["env"])
        self.assertEqual(spawn.call_args.kwargs["env"]["PYINSTALLER_RESET_ENVIRONMENT"], "1")

    def test_unknown_port_status_prevents_old_restart(self):
        def port_status(_):
            if spawn.call_count:
                raise OSError("port unavailable")
            return False
        spawn = Mock(return_value=FakeProcess(code=1))
        result, _ = self.run_with(spawn=spawn, probe_fn=lambda *_: None, port_in_use_fn=port_status)
        self.assertEqual(result["state"], "recovery-blocked")
        self.assertEqual(spawn.call_count, 1)

    def test_bound_identity_rejects_wrong_executable_data_dir_and_missing_metadata(self):
        instance = {"nonce": "f" * 64, "pid": 321, "data_dir": str(self.data),
                    "executable": str(self.new_exe)}
        payload = {"application": "PrismCanvas", "version": "0.10.0", "csrf": TOKEN,
                   "instance": instance}
        metadata = {"instance": instance, "pid": 321, "version": "0.10.0",
                    "url": "http://127.0.0.1:8765/"}
        self.assertTrue(handoff._bound_identity(payload, metadata, "0.10.0", self.new_exe,
                                               self.data, 8765, "f" * 64))
        for field, value in (("executable", str(self.old_exe)), ("data_dir", str(self.root)),
                             ("pid", False), ("nonce", "0" * 64)):
            changed = {**instance, field: value}
            self.assertFalse(handoff._bound_identity({**payload, "instance": changed},
                {**metadata, "instance": changed}, "0.10.0", self.new_exe, self.data, 8765, "f" * 64))


if __name__ == "__main__":
    unittest.main()
