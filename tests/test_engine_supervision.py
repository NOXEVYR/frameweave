"""Regression coverage for isolated engine supervision behavior."""

from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from frameweave.engines import EngineManager, _EngineFileLock, _profile


class FakeProcess:
    def __init__(self, running=True, pid=None):
        self.running = running
        self.pid = pid
        self.terminated = False
        self.killed = False

    def poll(self):
        return None if self.running else 1

    def terminate(self):
        self.terminated = True
        self.running = False

    def kill(self):
        self.killed = True
        self.running = False


def sample_profile(**overrides):
    value = {
        "id": "managed-test",
        "name": "Supervision fixture",
        "base_url": "http://127.0.0.1:18188",
        "python_executable": "C:/fake/python.exe",
        "main_script": "C:/fake/ComfyUI/main.py",
        "working_directory": "C:/fake/ComfyUI",
        "arguments": ["--listen", "127.0.0.1", "--port", "18188"],
        "startup_timeout_seconds": 10,
        "max_retries": 1,
    }
    value.update(overrides)
    return _profile(value)


class EngineSupervisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = EngineManager(Path(self.temp.name) / "userdata")
        self.profile = sample_profile()
        self.manager._profiles = [self.profile]
        self.addCleanup(self._release_logs)

    def _release_logs(self):
        self._release_manager_logs(self.manager)

    @staticmethod
    def _release_manager_logs(manager):
        for _, stream in manager._processes.values():
            try:
                stream.close()
            except (OSError, AttributeError):
                pass
        manager._processes.clear()

    def _track(self, process, stream=None):
        stream = stream or Mock()
        self.manager._processes[self.profile["id"]] = (process, stream)
        return stream

    def _seed_managed_record(self):
        child = FakeProcess(pid=4242)
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch.object(self.manager, "_validate_start_paths", return_value=None), \
                patch.object(self.manager, "_capture_process_identity",
                             return_value=("windows:123456", "C:/fake/python.exe")), \
                patch("frameweave.engines.subprocess.Popen", return_value=child):
            row = self.manager.start(self.profile["id"])
        self.assertEqual(row["state"], "starting")
        self.assertEqual(self.manager._read_process_records()[self.profile["id"]]["state"], "managed")
        return child

    def test_ready_engine_probe_failure_is_degraded_and_never_stopped(self):
        child = FakeProcess()
        self._track(child)
        self.manager._meta[self.profile["id"]] = {
            "online_seen": True,
            "started_at": time.monotonic() - 10000,
            "restarts": 0,
        }
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=True):
            row = self.manager.supervise()["profiles"][0]
        self.assertEqual(row["state"], "degraded")
        self.assertTrue(row["managed"])
        self.assertIsNone(child.poll())
        self.assertFalse(child.terminated)
        self.assertFalse(child.killed)
        self.assertNotIn("error", self.manager._meta[self.profile["id"]])

    def test_status_is_read_only_for_dead_child_and_retry_state(self):
        child = FakeProcess(running=False)
        stream = self._track(child)
        meta = {"online_seen": False, "started_at": time.monotonic(), "restarts": 0}
        self.manager._meta[self.profile["id"]] = dict(meta)
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch.object(self.manager, "_spawn") as spawn, \
                patch("frameweave.engines.subprocess.Popen") as popen:
            row = self.manager.status()["profiles"][0]
        self.assertEqual(row["state"], "starting")
        self.assertFalse(row["managed"])
        self.assertIs(self.manager._processes[self.profile["id"]][0], child)
        self.assertIs(self.manager._processes[self.profile["id"]][1], stream)
        self.assertEqual(self.manager._meta[self.profile["id"]], meta)
        stream.close.assert_not_called()
        spawn.assert_not_called()
        popen.assert_not_called()

    def test_retry_rechecks_port_before_popen_and_persists_error(self):
        dead = FakeProcess(running=False)
        self._track(dead)
        self.manager._meta[self.profile["id"]] = {
            "online_seen": False,
            "started_at": time.monotonic() - 2,
            "restarts": 0,
        }
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", side_effect=[False, True]) as port_probe, \
                patch("frameweave.engines.subprocess.Popen") as popen:
            row = self.manager.supervise()["profiles"][0]
        self.assertEqual(port_probe.call_count, 2)
        popen.assert_not_called()
        self.assertIn("占用", row["message"])
        self.assertIn("error", self.manager._meta[self.profile["id"]])
        self.assertTrue(self.manager._meta[self.profile["id"]]["stop_retry"])
        self.assertEqual(row["state"], "error")

    def test_uncertain_owned_process_handle_is_not_treated_as_stale(self):
        class UnqueryableProcess(FakeProcess):
            def poll(self):
                raise OSError("temporary process query failure")

        child = UnqueryableProcess()
        self._track(child)
        self.manager._meta[self.profile["id"]] = {
            "online_seen": False,
            "started_at": time.monotonic() - 10000,
            "restarts": 0,
        }
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            row = self.manager.supervise()["profiles"][0]
        self.assertEqual(row["state"], "starting")
        self.assertTrue(row["managed"])
        self.assertIn(self.profile["id"], self.manager._processes)
        self.assertFalse(child.terminated)
        self.assertFalse(child.killed)
        popen.assert_not_called()

    def test_supervisor_loop_runs_without_ui_and_stop_does_not_kill_children(self):
        child = FakeProcess()
        self._track(child)
        self.manager._meta[self.profile["id"]] = {
            "online_seen": False,
            "started_at": time.monotonic(),
            "restarts": 0,
        }
        stop = threading.Event()
        checks = []

        def probe(_url):
            checks.append(1)
            if len(checks) >= 3:
                stop.set()
            return False

        with patch.object(self.manager, "_probe_comfy", side_effect=probe), \
                patch.object(self.manager, "_port_in_use", return_value=False):
            worker = threading.Thread(target=self.manager.supervise_loop,
                                      args=(stop,), kwargs={"interval": 0.01}, daemon=True)
            worker.start()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertGreaterEqual(len(checks), 3)
        self.assertFalse(child.terminated)
        self.assertFalse(child.killed)
        self.assertIn(self.profile["id"], self.manager._processes)

    def test_error_is_stable_until_manual_start_clears_it(self):
        self.profile["max_retries"] = 0
        dead = FakeProcess(running=False)
        self._track(dead)
        self.manager._meta[self.profile["id"]] = {
            "online_seen": False,
            "started_at": time.monotonic() - 2,
            "restarts": 0,
        }
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            first = self.manager.supervise()["profiles"][0]
            second = self.manager.supervise()["profiles"][0]
            self.assertEqual(first["state"], "error")
            self.assertEqual(second["state"], "error")
            self.assertEqual(first["message"], second["message"])
            popen.assert_not_called()

            child = FakeProcess()
            with patch.object(self.manager, "_validate_start_paths", return_value=None), \
                    patch("frameweave.engines.subprocess.Popen", return_value=child):
                started = self.manager.start(self.profile["id"])
        self.assertEqual(started["state"], "starting")
        self.assertNotIn("error", self.manager._meta[self.profile["id"]])

    def test_loop_rejects_invalid_interval_and_event(self):
        with self.assertRaises(ValueError):
            self.manager.supervise_loop(threading.Event(), interval=0)
        with self.assertRaises(TypeError):
            self.manager.supervise_loop(object())

    def test_spawn_persists_reservation_before_creating_child(self):
        child = FakeProcess(pid=5151)

        def create_child(*_args, **_kwargs):
            record = self.manager._read_process_records()[self.profile["id"]]
            self.assertEqual(record["state"], "launching")
            self.assertIsNone(record["pid"])
            return child

        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch.object(self.manager, "_validate_start_paths", return_value=None), \
                patch.object(self.manager, "_capture_process_identity",
                             return_value=("windows:515151", "C:/fake/python.exe")), \
                patch("frameweave.engines.subprocess.Popen", side_effect=create_child):
            row = self.manager.start(self.profile["id"])
        self.assertEqual(row["state"], "starting")
        record = self.manager._read_process_records()[self.profile["id"]]
        self.assertEqual((record["state"], record["pid"], record["creation_token"]),
                         ("managed", 5151, "windows:515151"))

    def test_restart_reuses_verified_live_record_without_adopting_or_spawning(self):
        self._seed_managed_record()
        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        with patch("frameweave.engines._inspect_process",
                   return_value=("alive", "windows:123456", "C:/fake/python.exe")), \
                patch.object(restarted, "_probe_comfy", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            row = restarted.start(self.profile["id"])
        self.assertEqual(row["state"], "starting")
        self.assertFalse(row["managed"])
        self.assertIn("未重复启动", row["message"])
        self.assertEqual(restarted._processes, {})
        popen.assert_not_called()

    def test_background_supervision_does_not_restart_verified_live_old_child(self):
        self._seed_managed_record()
        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        with patch("frameweave.engines._inspect_process",
                   return_value=("alive", "windows:123456", "C:/fake/python.exe")), \
                patch.object(restarted, "_probe_comfy", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            row = restarted.supervise()["profiles"][0]
        self.assertEqual(row["state"], "starting")
        self.assertFalse(row["managed"])
        popen.assert_not_called()

    def test_dead_or_pid_reused_record_is_cleared_before_manual_retry(self):
        self._seed_managed_record()
        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        self.addCleanup(self._release_manager_logs, restarted)
        replacement = FakeProcess(pid=5252)
        with patch("frameweave.engines._inspect_process",
                   return_value=("alive", "windows:999999", "C:/other/python.exe")), \
                patch.object(restarted, "_probe_comfy", return_value=False), \
                patch.object(restarted, "_port_in_use", return_value=False), \
                patch.object(restarted, "_validate_start_paths", return_value=None), \
                patch.object(restarted, "_capture_process_identity",
                             return_value=("windows:525252", "C:/fake/python.exe")), \
                patch("frameweave.engines.subprocess.Popen", return_value=replacement) as popen:
            row = restarted.start(self.profile["id"])
        self.assertEqual(row["state"], "starting")
        popen.assert_called_once()
        self.assertEqual(restarted._read_process_records()[self.profile["id"]]["pid"], 5252)

    def test_verified_dead_record_is_removed_before_manual_retry(self):
        self._seed_managed_record()
        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        self.addCleanup(self._release_manager_logs, restarted)
        replacement = FakeProcess(pid=5353)
        with patch("frameweave.engines._inspect_process",
                   return_value=("dead", "windows:123456", None)), \
                patch.object(restarted, "_probe_comfy", return_value=False), \
                patch.object(restarted, "_port_in_use", return_value=False), \
                patch.object(restarted, "_validate_start_paths", return_value=None), \
                patch.object(restarted, "_capture_process_identity",
                             return_value=("windows:535353", "C:/fake/python.exe")), \
                patch("frameweave.engines.subprocess.Popen", return_value=replacement) as popen:
            row = restarted.start(self.profile["id"])
        self.assertEqual(row["state"], "starting")
        popen.assert_called_once()
        self.assertEqual(restarted._read_process_records()[self.profile["id"]]["pid"], 5353)

    def test_crash_window_reservation_blocks_uncertain_relaunch(self):
        self.manager._save_process_record(self.profile, "launching")
        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        with patch("frameweave.engines._inspect_process") as inspect, \
                patch("frameweave.engines.subprocess.Popen") as popen:
            row = restarted.start(self.profile["id"])
        self.assertEqual(row["state"], "error")
        self.assertIn("无法核验", row["message"])
        inspect.assert_not_called()
        popen.assert_not_called()

    def test_unidentified_but_confirmed_dead_pid_record_can_retry(self):
        first_child = FakeProcess(pid=5454)
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch.object(self.manager, "_validate_start_paths", return_value=None), \
                patch.object(self.manager, "_capture_process_identity", return_value=(None, None)), \
                patch("frameweave.engines.subprocess.Popen", return_value=first_child):
            self.manager.start(self.profile["id"])
        self.assertEqual(self.manager._read_process_records()[self.profile["id"]]["state"], "unknown")

        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        self.addCleanup(self._release_manager_logs, restarted)
        replacement = FakeProcess(pid=5555)
        with patch("frameweave.engines._inspect_process", return_value=("dead", None, None)), \
                patch.object(restarted, "_probe_comfy", return_value=False), \
                patch.object(restarted, "_port_in_use", return_value=False), \
                patch.object(restarted, "_validate_start_paths", return_value=None), \
                patch.object(restarted, "_capture_process_identity",
                             return_value=("windows:555555", "C:/fake/python.exe")), \
                patch("frameweave.engines.subprocess.Popen", return_value=replacement) as popen:
            row = restarted.start(self.profile["id"])
        self.assertEqual(row["state"], "starting")
        popen.assert_called_once()

    def test_process_record_file_lock_is_exclusive_and_released(self):
        lock_path = self.manager.process_lock_path
        first = _EngineFileLock(lock_path)
        second = _EngineFileLock(lock_path)
        self.assertTrue(first.acquire(timeout=0))
        self.assertFalse(second.acquire(timeout=0))
        first.release()
        self.assertTrue(second.acquire(timeout=0))
        second.release()

    def test_unverifiable_record_blocks_start_and_status_does_not_inspect_it(self):
        self._seed_managed_record()
        restarted = EngineManager(self.manager.data_dir)
        restarted._profiles = [self.profile]
        original = restarted._read_process_records()
        with patch("frameweave.engines._inspect_process",
                   return_value=("unknown", None, None)) as inspect, \
                patch.object(restarted, "_probe_comfy", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            status = restarted.status()["profiles"][0]
            inspect.assert_not_called()
            row = restarted.start(self.profile["id"])
        self.assertEqual(status["state"], "offline")
        self.assertEqual(row["state"], "error")
        self.assertIn("无法核验", row["message"])
        popen.assert_not_called()
        self.assertEqual(restarted._read_process_records(), original)


if __name__ == "__main__":
    unittest.main()
