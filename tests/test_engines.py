"""Local engine manager tests use fake HTTP and process objects only."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from frameweave.engines import EngineManager


class FakeResponse:
    status = 200
    headers = {"Content-Length": "72"}

    def __init__(self, body=None):
        self.body = body or json.dumps({
            "system": {"comfyui_version": "test"}, "devices": [],
        }).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, limit=-1):
        return self.body[:limit]


class FakeProcess:
    def __init__(self, running=True):
        self.running = running

    def poll(self):
        return None if self.running else 1


class EngineManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "userdata"
        self.data.mkdir()
        self.install = Path(self.temp.name) / "ComfyUI"
        self.install.mkdir()
        (self.install / "comfy").mkdir()
        (self.install / "main.py").write_text("# test fixture", encoding="utf-8")
        self.python = Path(self.temp.name) / "python.exe"
        self.python.write_text("# not executed", encoding="utf-8")
        self.manager = EngineManager(self.data)
        self.profile = {
            "id": "local-test", "name": "测试 ComfyUI", "base_url": "http://127.0.0.1:8188",
            "python_executable": str(self.python),
            "main_script": str(self.install / "main.py"),
            "working_directory": str(self.install),
            "arguments": ["--listen", "127.0.0.1", "--port", "8188"],
        }
        self.manager._profiles = [self.profile]
        self.addCleanup(self._cleanup_fake_process_logs)

    def _cleanup_fake_process_logs(self):
        # The tests use fake child objects, so release only the manager's log
        # handles before TemporaryDirectory removes its fixture tree.
        for _, stream in self.manager._processes.values():
            stream.close()
        self.manager._processes.clear()

    def test_probe_accepts_only_comfy_system_stats_using_fake_http(self):
        response = FakeResponse()
        opener = Mock()
        opener.open.return_value = response
        with patch("frameweave.engines.urllib.request.build_opener", return_value=opener) as build:
            self.assertTrue(self.manager._probe_comfy("http://127.0.0.1:8188"))
        args, kwargs = opener.open.call_args
        self.assertEqual(args[0].full_url, "http://127.0.0.1:8188/system_stats")
        self.assertEqual(kwargs["timeout"], 0.6)
        build.assert_called_once()

        opener.open.return_value = FakeResponse(b'{"ok": true}')
        with patch("frameweave.engines.urllib.request.build_opener", return_value=opener):
            self.assertFalse(self.manager._probe_comfy("http://127.0.0.1:8188"))

    def test_status_exposes_health_without_any_local_paths(self):
        with patch.object(self.manager, "_probe_comfy", return_value=True):
            result = self.manager.status()
        self.assertEqual(len(result["profiles"]), 1)
        row = result["profiles"][0]
        self.assertEqual((row["online"], row["managed"], row["state"]), (True, False, "online"))
        encoded = json.dumps(result)
        self.assertNotIn(str(self.install), encoded)
        self.assertNotIn(str(self.python), encoded)

    def test_start_reuses_comfy_without_spawning(self):
        with patch.object(self.manager, "_probe_comfy", return_value=True), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            result = self.manager.start("local-test")
        self.assertEqual(result["state"], "online")
        self.assertFalse(result["managed"])
        popen.assert_not_called()

    def test_non_comfy_listener_is_never_overwritten(self):
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=True), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            result = self.manager.start("local-test")
        self.assertEqual(result["state"], "occupied")
        self.assertFalse(result["online"])
        popen.assert_not_called()

    def test_start_uses_only_registered_argv_and_hidden_logged_subprocess(self):
        child = FakeProcess()
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch("frameweave.engines.subprocess.Popen", return_value=child) as popen:
            result = self.manager.start("local-test")
        self.assertEqual(result["state"], "starting")
        self.assertTrue(result["managed"])
        argv = popen.call_args.args[0]
        self.assertEqual(argv, [str(self.python), str(self.install / "main.py"), *self.profile["arguments"]])
        options = popen.call_args.kwargs
        self.assertFalse(options["shell"])
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertTrue(options["stdout"].name.endswith("local-test.log"))
        self.assertEqual(options["stderr"], subprocess.STDOUT)
        self.assertEqual(options["creationflags"], getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(options["cwd"], str(self.install))

    def test_parallel_start_calls_spawn_once(self):
        child = FakeProcess()
        calls = []

        def spawn(*args, **kwargs):
            calls.append((args, kwargs))
            time.sleep(0.04)
            return child

        results = []
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch("frameweave.engines.subprocess.Popen", side_effect=spawn):
            threads = [threading.Thread(target=lambda: results.append(self.manager.start("local-test")))
                       for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(2)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(results), 2)
        self.assertTrue(all(item["managed"] for item in results))

    def test_invalid_profile_url_is_rejected_before_becoming_startable(self):
        bad = dict(self.profile, base_url="http://example.com:8188")
        self.data.joinpath("engines.json").write_text(
            json.dumps({"version": 1, "profiles": [bad]}), encoding="utf-8")
        with self.assertRaises(ValueError):
            EngineManager(self.data)

    def test_missing_start_files_return_error_without_spawning(self):
        self.manager._profiles[0]["python_executable"] = str(Path(self.temp.name) / "missing.exe")
        with patch.object(self.manager, "_probe_comfy", return_value=False), \
                patch.object(self.manager, "_port_in_use", return_value=False), \
                patch("frameweave.engines.subprocess.Popen") as popen:
            result = self.manager.start("local-test")
        self.assertEqual(result["state"], "error")
        popen.assert_not_called()

    def test_register_detects_python_and_writes_fixed_local_arguments(self):
        embedded = self.install.parent / "python_embeded"
        embedded.mkdir()
        interpreter = embedded / "python.exe"
        interpreter.write_text("# test fixture", encoding="utf-8")
        registered = self.manager.register(self.install, 8191, "集成环境")
        config = json.loads((self.data / "engines.json").read_text(encoding="utf-8"))
        profile = next(item for item in config["profiles"] if item["id"] == registered["id"])
        self.assertEqual(profile["python_executable"], str(interpreter))
        self.assertEqual(profile["arguments"], ["--listen", "127.0.0.1", "--port", "8191", "--disable-auto-launch"])
        self.assertEqual(registered["base_url"], "http://127.0.0.1:8191")
        self.assertNotIn(str(interpreter), json.dumps(registered))

    def test_register_requires_real_comfy_tree_and_python_candidate(self):
        incomplete = Path(self.temp.name) / "empty"
        incomplete.mkdir()
        with self.assertRaises(ValueError):
            self.manager.register(incomplete)
        with self.assertRaises(FileNotFoundError):
            self.manager.register(self.install)


if __name__ == "__main__":
    unittest.main()
