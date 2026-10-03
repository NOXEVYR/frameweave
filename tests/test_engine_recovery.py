"""Engine configuration recovery tests use temporary files and never spawn engines."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from frameweave.configuration_recovery import read_config
from frameweave.engines import EngineManager, _MAX_CONFIG_BYTES


def valid_profile(ident="local-test"):
    return {
        "id": ident,
        "name": "测试引擎",
        "base_url": "http://127.0.0.1:8188",
        "python_executable": "C:/ComfyUI/python/python.exe",
        "main_script": "C:/ComfyUI/main.py",
        "working_directory": "C:/ComfyUI",
        "arguments": ["--listen", "127.0.0.1", "--port", "8188"],
    }


class EngineConfigRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.config = self.data / "engines.json"

    def make_manager(self, content):
        self.config.write_bytes(content)
        return EngineManager(self.data)

    def assert_recovered_with_backup(self, content):
        manager = self.make_manager(content)
        self.assertEqual(manager._profiles, [])
        self.assertFalse(manager.config_protected)
        self.assertTrue(manager.load_error)
        self.assertIn("可回读", manager.load_error)
        backups = list(self.data.glob("engines.recovery-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), content)
        return manager

    def test_truncated_json_is_preserved_and_recoverable(self):
        self.assert_recovered_with_backup(b'{"version":1,"profiles":[{')

    def test_wrong_version_and_container_types_are_recovered(self):
        cases = (
            b'{"version":2,"profiles":[]}',
            b'{"version":true,"profiles":[]}',
            b'{"version":1,"profiles":{}}',
            b'{"version":1,"profiles":[null]}',
            b'{"version":1,"profiles":[{"id":[],"name":"bad"}]}',
        )
        for content in cases:
            with self.subTest(content=content):
                with tempfile.TemporaryDirectory() as directory:
                    data = Path(directory)
                    config = data / "engines.json"
                    config.write_bytes(content)
                    manager = EngineManager(data)
                    self.assertEqual(manager._profiles, [])
                    self.assertFalse(manager.config_protected)
                    self.assertTrue(manager.load_error)
                    backup, = data.glob("engines.recovery-*.json")
                    self.assertEqual(backup.read_bytes(), content)

    def test_invalid_profile_and_duplicate_ids_are_recovered(self):
        invalid_profile = valid_profile()
        invalid_profile["arguments"] = "not-a-list"
        contents = (
            json.dumps({"version": 1, "profiles": [invalid_profile]}).encode(),
            json.dumps({"version": 1, "profiles": [valid_profile(), valid_profile()]}).encode(),
        )
        for content in contents:
            with self.subTest(content=content):
                with tempfile.TemporaryDirectory() as directory:
                    data = Path(directory)
                    config = data / "engines.json"
                    config.write_bytes(content)
                    manager = EngineManager(data)
                    self.assertEqual(manager._profiles, [])
                    self.assertFalse(manager.config_protected)
                    backup, = data.glob("engines.recovery-*.json")
                    self.assertEqual(backup.read_bytes(), content)

    def test_oversized_config_is_read_with_limit_and_backed_up_when_within_backup_cap(self):
        content = b" " * (_MAX_CONFIG_BYTES + 1)
        with patch("frameweave.engines.read_config", wraps=read_config) as bounded_read:
            manager = self.assert_recovered_with_backup(content)
        self.assertFalse(manager.config_protected)
        bounded_read.assert_called_once_with(self.config, _MAX_CONFIG_BYTES)

    def test_identical_corrupt_config_reuses_its_verified_backup_on_restart(self):
        content = b"{truncated"
        first = self.assert_recovered_with_backup(content)
        second = EngineManager(self.data)
        self.assertEqual(second._profiles, [])
        self.assertEqual(second.load_error, first.load_error)
        backups = list(self.data.glob("engines.recovery-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), content)

    def test_backup_failure_protects_original_from_save_and_engine_start(self):
        original = b'{"version":1,"profiles":[null]}'
        self.config.write_bytes(original)
        with patch("frameweave.engines.preserve_config", side_effect=OSError("disk full")):
            manager = EngineManager(self.data)
        self.assertTrue(manager.config_protected)
        self.assertIn("暂停引擎配置写入和启动", manager.load_error)
        self.assertEqual(self.config.read_bytes(), original)

        manager._profiles = [valid_profile()]
        with self.assertRaisesRegex(ValueError, "已暂停引擎配置写入和启动"):
            manager._save()
        with patch("frameweave.engines.subprocess.Popen") as popen:
            with self.assertRaisesRegex(ValueError, "已暂停引擎配置写入和启动"):
                manager.start("local-test")
            popen.assert_not_called()
        self.assertEqual(self.config.read_bytes(), original)

    def test_unreadable_or_unsafe_config_does_not_escape_manager_initialization(self):
        content = b'{"version":1,"profiles":[]}'
        self.config.write_bytes(content)
        with patch("frameweave.engines.read_config", side_effect=OSError("unreadable")), \
                patch("frameweave.engines.preserve_config", side_effect=OSError("unreadable")):
            manager = EngineManager(self.data)
        self.assertEqual(manager._profiles, [])
        self.assertTrue(manager.config_protected)
        self.assertTrue(manager.load_error)
        self.assertEqual(self.config.read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
