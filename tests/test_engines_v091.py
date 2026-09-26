"""0.9.1 readiness supervision tests: engines.json fields, retry, timeout, log rotation.

Fakes only — no real process, HTTP listener, or filesystem outside tempdirs.
"""

import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from frameweave.engines import EngineManager, _profile


class FakeProcess:
    def __init__(self, running=True):
        self.running = running
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

    def wait(self, timeout=None):
        return 0


def sample_profile(**overrides):
    value = {
        "id": "local-test", "name": "测试 ComfyUI", "base_url": "http://127.0.0.1:8188",
        "python_executable": "C:/fake/python.exe",
        "main_script": "C:/fake/ComfyUI/main.py",
        "working_directory": "C:/fake/ComfyUI",
        "arguments": ["--listen", "127.0.0.1", "--port", "8188"],
    }
    value.update(overrides)
    return _profile(value)


class ProfileFieldsTests(unittest.TestCase):
    def test_defaults_are_applied_for_optional_fields(self):
        profile = sample_profile()
        self.assertEqual(profile["startup_timeout_seconds"], 600)
        self.assertEqual(profile["max_retries"], 1)
        self.assertTrue(profile["auto_start"])

    def test_explicit_fields_are_kept(self):
        profile = sample_profile(startup_timeout_seconds=30, max_retries=0, auto_start=False)
        self.assertEqual(profile["startup_timeout_seconds"], 30)
        self.assertEqual(profile["max_retries"], 0)
        self.assertFalse(profile["auto_start"])

    def test_invalid_field_values_are_rejected(self):
        for kwargs in ({"startup_timeout_seconds": 5}, {"startup_timeout_seconds": "600"},
                       {"startup_timeout_seconds": True}, {"max_retries": -1},
                       {"max_retries": 9}, {"auto_start": "yes"}):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                sample_profile(**kwargs)


class AutoStartSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = EngineManager(Path(self.temp.name) / "data")

    def test_selects_profile_bound_to_backend_url(self):
        self.manager._profiles = [sample_profile()]
        self.assertEqual(self.manager.auto_start_profile_for("http://127.0.0.1:8188"), "local-test")
        self.assertEqual(self.manager.auto_start_profile_for("http://localhost:8188"), "local-test")

    def test_opted_out_or_unknown_profiles_are_never_selected(self):
        self.manager._profiles = [sample_profile(auto_start=False)]
        self.assertIsNone(self.manager.auto_start_profile_for("http://127.0.0.1:8188"))
        self.assertIsNone(self.manager.auto_start_profile_for("http://127.0.0.1:9999"))
        self.assertIsNone(self.manager.auto_start_profile_for("not a url"))

    def test_public_status_exposes_auto_start_flag_without_paths(self):
        self.manager._profiles = [sample_profile(auto_start=False)]
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False):
            row = self.manager.status()["profiles"][0]
        self.assertFalse(row["auto_start"])
        encoded = json.dumps(row)
        self.assertNotIn("python", encoded.lower())
        self.assertNotIn("working_directory", encoded)

    def test_loaded_engines_json_without_fields_receives_defaults(self):
        self.manager.data_dir.mkdir(parents=True, exist_ok=True)
        (self.manager.data_dir / "engines.json").write_text(json.dumps({
            "version": 1,
            "profiles": [{
                "id": "qwen-shared", "name": "Qwen", "base_url": "http://127.0.0.1:8189",
                "python_executable": "C:/fake/python.exe",
                "main_script": "C:/fake/ComfyUI/main.py",
                "working_directory": "C:/fake/ComfyUI",
                "arguments": ["--port", "8189"],
            }],
        }, ensure_ascii=False), encoding="utf-8")
        manager = EngineManager(self.manager.data_dir)
        profile = manager._profiles[0]
        self.assertEqual(profile["startup_timeout_seconds"], 600)
        self.assertEqual(profile["max_retries"], 1)
        self.assertTrue(profile["auto_start"])
        self.assertEqual(manager.auto_start_profile_for("http://127.0.0.1:8189"), "qwen-shared")


class SupervisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "userdata"
        self.data.mkdir()
        self.manager = EngineManager(self.data)
        self.profile = dict(sample_profile(), python_executable="C:/fake/python.exe",
                            main_script="C:/fake/ComfyUI/main.py",
                            working_directory="C:/fake/ComfyUI")
        self.manager._profiles = [self.profile]
        self.manager._cleanup_done = False

    def _release_log_handles(self):
        for _, stream in self.manager._processes.values():
            try:
                stream.close()
            except OSError:
                pass
        self.manager._processes.clear()

    def test_startup_timeout_stops_retry_without_killing_owned_process(self):
        child = FakeProcess()
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch.object(self.manager, "_validate_start_paths", return_value=None), \
                patch("frameweave.engines.subprocess.Popen", return_value=child):
            result = self.manager.start("local-test")
            self.assertEqual(result["state"], "starting")
            self.manager._meta["local-test"]["started_at"] = time.monotonic() - 9999
            status = self.manager.supervise()["profiles"][0]
        self.assertEqual(status["state"], "error")
        self.assertIn("启动超时", status["message"])
        self.assertTrue(status["managed"])
        self.assertFalse(child.terminated)
        self.assertFalse(child.killed)
        self.assertIn("local-test", self.manager._processes)
        self._release_log_handles()

    def test_dead_engine_before_ready_is_restarted_once_then_reports_error(self):
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch.object(self.manager, "_validate_start_paths", return_value=None), \
                patch("frameweave.engines.subprocess.Popen", return_value=FakeProcess()):
            self.manager._meta["local-test"] = {"started_at": time.monotonic(),
                                                "online_seen": False, "restarts": 0}
            self.manager._processes["local-test"] = (FakeProcess(running=False),
                                                     self.manager._open_log(self.profile))
            first = self.manager.supervise()["profiles"][0]
            self.assertEqual(first["state"], "starting")
            self.assertIn("自动重试", first["message"])
            self.assertEqual(self.manager._meta["local-test"]["restarts"], 1)
            self._release_log_handles()
            self.manager._processes["local-test"] = (FakeProcess(running=False),
                                                     self.manager._open_log(self.profile))
            second = self.manager.supervise()["profiles"][0]
        self.assertEqual(second["state"], "error")
        self.assertIn("停止自动重试", second["message"])
        self.assertEqual(self.manager._meta["local-test"]["restarts"], 1)
        self._release_log_handles()

    def test_dead_engine_after_ready_requires_manual_restart(self):
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            self.manager._meta["local-test"] = {"started_at": time.monotonic() - 60,
                                                "online_seen": True, "restarts": 0}
            self.manager._processes["local-test"] = (FakeProcess(running=False),
                                                     self.manager._open_log(self.profile))
            status = self.manager.supervise()["profiles"][0]
        self.assertEqual(status["state"], "error")
        self.assertIn("手动启动", status["message"])
        popen.assert_not_called()
        self._release_log_handles()

    def test_engine_becoming_online_resets_retry_budget(self):
        with patch.object(self.manager, "_probe_comfy", return_value=True):
            self.manager._meta["local-test"] = {"started_at": time.monotonic(),
                                                "online_seen": False, "restarts": 1}
            status = self.manager.supervise()["profiles"][0]
        self.assertEqual(status["state"], "online")
        self.assertEqual(self.manager._meta["local-test"]["restarts"], 0)
        self.assertTrue(self.manager._meta["local-test"]["online_seen"])


class LogRotationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "userdata"
        self.data.mkdir()
        self.manager = EngineManager(self.data)
        self.profile = dict(sample_profile(), python_executable="C:/fake/python.exe",
                            main_script="C:/fake/ComfyUI/main.py",
                            working_directory="C:/fake/ComfyUI")
        self.manager._profiles = [self.profile]

    def test_oversized_log_is_rotated_before_append(self):
        log_path = self.data / "engine-logs" / "local-test.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("x" * 40, encoding="utf-8")
        with patch("frameweave.engines._MAX_LOG_BYTES", 16):
            stream = self.manager._open_log(self.profile)
            stream.write(b"fresh")
            stream.close()
        self.assertTrue((log_path.parent / "local-test.log.1").exists())
        self.assertEqual(log_path.read_text(encoding="utf-8"), "fresh")


if __name__ == "__main__":
    unittest.main()
