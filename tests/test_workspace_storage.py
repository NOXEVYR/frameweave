"""On-demand storage metadata, filesystem boundaries and real loopback HTTP."""

import base64
import io
import json
import os
import stat
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frameweave.server import INPUT_MEDIA_LIMIT
from frameweave.workspace_storage import (SAFE_DIRECTORY_SCAN, asset_directory_summary,
                                          local_asset_summary)
import test_service as service_fixture


@unittest.skipUnless(SAFE_DIRECTORY_SCAN, "safe directory descriptor enumeration unavailable")
class WorkspaceStorageFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / "data"
        self.data.mkdir()
        self.root = self.data / "local-assets-images"

    def asset(self, content=b"local bytes", name="a" * 64):
        self.root.mkdir(exist_ok=True)
        path = self.root / name
        path.write_bytes(content)
        return path

    def test_missing_store_is_zero_without_creating_anything(self):
        before = list(self.data.iterdir())
        self.assertEqual(asset_directory_summary(self.root), {"status": "ok", "count": 0, "bytes": 0})
        self.assertEqual(list(self.data.iterdir()), before)

    def test_only_regular_content_address_names_count_without_content_reads(self):
        self.asset(b"not decoded or rehashed")
        self.asset(b"", "b" * 64)
        for name in ["c" * 63, "D" * 64, ".upload-private.tmp", "." + "e" * 64 + ".tmp", "private-prompt.txt"]:
            (self.root / name).write_bytes(b"ignored")
        (self.root / ("f" * 64)).mkdir()
        (self.root / ("0" * 64)).symlink_to(self.root / ("a" * 64))
        if hasattr(os, "mkfifo"):
            os.mkfifo(self.root / ("1" * 64))
        with patch.object(Path, "read_bytes", side_effect=AssertionError("metadata only")), \
                patch("builtins.open", side_effect=AssertionError("no content stream")):
            result = asset_directory_summary(self.root)
        self.assertEqual(result, {"status": "ok", "count": 2, "bytes": 23})

    def test_symlink_or_non_directory_store_is_unknown_not_empty(self):
        outside = Path(self.temp.name) / "private"
        outside.mkdir()
        (outside / ("a" * 64)).write_bytes(b"private outside")
        self.root.symlink_to(outside, target_is_directory=True)
        with patch("frameweave.workspace_storage.os.scandir", side_effect=AssertionError("must not enumerate outside")):
            self.assertEqual(asset_directory_summary(self.root), {"status": "unavailable", "count": None, "bytes": None})
        self.root.unlink()
        self.root.write_bytes(b"wrong type")
        self.assertEqual(asset_directory_summary(self.root)["status"], "unavailable")

    def test_parent_symlink_is_rejected_before_enumeration(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        self.data.rmdir()
        self.data.symlink_to(outside, target_is_directory=True)
        with patch("frameweave.workspace_storage.os.scandir", side_effect=AssertionError("no outside scan")):
            self.assertEqual(asset_directory_summary(self.root)["status"], "unavailable")

    def test_stat_error_is_partial_and_next_explicit_scan_recovers(self):
        self.asset(b"known")
        self.asset(b"unknown", "b" * 64)
        original = os.stat

        def denied(path, *args, **kwargs):
            if path == "b" * 64:
                raise PermissionError("PRIVATE/path/secret-name")
            return original(path, *args, **kwargs)

        with patch("frameweave.workspace_storage.os.stat", side_effect=denied):
            result = asset_directory_summary(self.root)
        self.assertEqual(result, {"status": "partial", "count": 1, "bytes": 5})
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertEqual(asset_directory_summary(self.root), {"status": "ok", "count": 2, "bytes": 12})

    def test_enumeration_failure_preserves_only_confirmed_lower_bound(self):
        self.asset(b"known")

        class BrokenScan:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def __iter__(self):
                yield SimpleNamespace(name="a" * 64)
                raise OSError("PRIVATE filename in error")

        with patch("frameweave.workspace_storage.os.scandir", return_value=BrokenScan()):
            self.assertEqual(asset_directory_summary(self.root), {"status": "partial", "count": 1, "bytes": 5})
        with patch("frameweave.workspace_storage.os.scandir", side_effect=PermissionError("PRIVATE")):
            self.assertEqual(asset_directory_summary(self.root), {"status": "unavailable", "count": None, "bytes": None})

    def test_root_replaced_before_open_never_scans_symlink_target(self):
        self.asset()
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / ("b" * 64)).write_bytes(b"outside")
        original = os.open

        def replace_root(path, flags, *args, **kwargs):
            if path == self.root.name:
                self.root.rename(self.data / "previous")
                self.root.symlink_to(outside, target_is_directory=True)
            return original(path, flags, *args, **kwargs)

        with patch("frameweave.workspace_storage.os.open", side_effect=replace_root), \
                patch("frameweave.workspace_storage.os.scandir", side_effect=AssertionError("no outside scan")):
            self.assertEqual(asset_directory_summary(self.root)["status"], "unavailable")

    def test_root_replaced_during_scan_discards_old_directory_totals(self):
        self.asset()
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / ("b" * 64)).write_bytes(b"outside")
        original_scan, original_stat = os.scandir, os.stat
        names = []

        def replace_root(descriptor):
            iterator = original_scan(descriptor)
            self.root.rename(self.data / "previous")
            self.root.symlink_to(outside, target_is_directory=True)
            return iterator

        def record_stat(path, *args, **kwargs):
            names.append(path)
            return original_stat(path, *args, **kwargs)

        with patch("frameweave.workspace_storage.os.scandir", side_effect=replace_root), \
                patch("frameweave.workspace_storage.os.stat", side_effect=record_stat):
            self.assertEqual(asset_directory_summary(self.root), {"status": "unavailable", "count": None, "bytes": None})
        self.assertNotIn("b" * 64, names)

    def test_file_change_between_metadata_checks_is_partial(self):
        target = self.asset(b"before")
        original = os.stat
        calls = 0

        def change_file(path, *args, **kwargs):
            nonlocal calls
            if path == target.name:
                calls += 1
                if calls == 2:
                    target.write_bytes(b"changed content")
            return original(path, *args, **kwargs)

        with patch("frameweave.workspace_storage.os.stat", side_effect=change_file):
            self.assertEqual(asset_directory_summary(self.root), {"status": "partial", "count": 0, "bytes": 0})
        self.assertEqual(asset_directory_summary(self.root), {"status": "ok", "count": 1, "bytes": 15})

    def test_directory_contents_changed_during_scan_discards_stale_totals(self):
        target = self.asset(b"known")

        class ChangedScan:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def __iter__(self):
                yield SimpleNamespace(name=target.name)
                target.unlink()

        with patch("frameweave.workspace_storage.os.scandir", return_value=ChangedScan()):
            self.assertEqual(asset_directory_summary(self.root), {"status": "unavailable", "count": None, "bytes": None})
        self.assertEqual(asset_directory_summary(self.root), {"status": "ok", "count": 0, "bytes": 0})

    def test_reparse_attributes_are_rejected_even_on_posix(self):
        self.asset()
        original = os.stat

        def reparse_file(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == "a" * 64:
                values = {key: getattr(info, key) for key in dir(info) if key.startswith("st_")}
                return SimpleNamespace(**(values | {"st_file_attributes": 1024}))
            return info

        with patch("frameweave.workspace_storage.os.stat", side_effect=reparse_file), \
                patch.object(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 1024, create=True):
            self.assertEqual(asset_directory_summary(self.root), {"status": "ok", "count": 0, "bytes": 0})

    def test_unavailable_platform_does_not_use_unsafe_path_fallback(self):
        self.asset()
        with patch("frameweave.workspace_storage.SAFE_DIRECTORY_SCAN", False), \
                patch("frameweave.workspace_storage.os.scandir", side_effect=AssertionError("no unsafe fallback")):
            self.assertEqual(asset_directory_summary(self.root), {"status": "unavailable", "count": None, "bytes": None})
            result = local_asset_summary(self.root, self.data / "local-assets-media")
            self.assertEqual((result["status"], result["count"], result["bytes"]), ("unavailable", None, None))

    def test_aggregate_unknown_store_is_partial_not_zero(self):
        self.asset(b"known")
        media = self.data / "local-assets-media"
        media.write_bytes(b"not a directory")
        result = local_asset_summary(self.root, media)
        self.assertEqual((result["status"], result["count"], result["bytes"]), ("partial", 1, 5))
        self.assertIsNone(result["media"]["bytes"])


class WorkspaceStorageHTTPTests(unittest.TestCase):
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request

    def summary(self, **kwargs):
        status, _, raw = self.request("GET", "/api/workspace/storage", **kwargs)
        return status, json.loads(raw)

    @unittest.skipUnless(SAFE_DIRECTORY_SCAN, "safe directory descriptor enumeration unavailable")
    def test_actual_image_media_stores_and_registration_share_existing_quota(self):
        self.app.local_assets.create("PRIVATE-name.png", base64.b64encode(service_fixture.PNG).decode())
        self.app.local_media_assets.create_from_stream("PRIVATE-name.png", io.BytesIO(service_fixture.PNG),
                                                      len(service_fixture.PNG), "image/png")
        video = (20).to_bytes(4, "big") + b"ftypisom" + b"\x00\x00\x02\x00mp42mdatvideo"
        self.app.local_media_assets.create_from_stream("PRIVATE-video.mp4", io.BytesIO(video), len(video), "video/mp4")
        audio_buffer = io.BytesIO()
        with wave.open(audio_buffer, "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(8000)
            audio.writeframes(b"\x00\x00" * 16)
        audio = audio_buffer.getvalue()
        self.app.local_media_assets.create_from_stream("PRIVATE-audio.wav", io.BytesIO(audio), len(audio), "audio/wav")
        self.app.register_input_media("PRIVATE-input.png", backend=self.backend.url)
        self.app.register_input_media("PRIVATE-input.png", backend=self.backend.url)
        self.app.register_input_media("PRIVATE-input.png", backend="http://127.0.0.1:19991")
        self.app.register_media("PRIVATE-output.png", kind="output")
        self.app.register_media("PRIVATE-temp.png", kind="temp")
        record = self.app.data_dir / "input-media.json"
        before = record.read_bytes()
        calls = list(self.backend.calls)
        with patch.object(self.app.backend, "request", side_effect=AssertionError("no backend scan")), \
                patch.object(self.app.backend, "upload", side_effect=AssertionError("no upload")):
            status, result = self.summary()
        self.assertEqual(status, 200)
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["measurement"], "logical_file_bytes")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["local_assets"]["count"], 4)
        self.assertEqual(result["local_assets"]["bytes"], 2 * len(service_fixture.PNG) + len(video) + len(audio))
        self.assertEqual(result["input_registration"], {"status": "ok", "count": 2, "limit": 10000,
                                                        "remaining": 9998, "protected": False})
        self.assertEqual(record.read_bytes(), before)
        self.assertEqual(self.backend.calls, calls)
        output = json.dumps(result)
        for private in ["PRIVATE", str(self.app.data_dir), self.backend.url, "filename", "prompt", "asset_id"]:
            self.assertNotIn(private, output)

    def test_quota_count_includes_all_backends_and_full_limit_rejects_upload(self):
        for index in range(INPUT_MEDIA_LIMIT):
            self.app.register_media(f"input-{index}.png", kind="input",
                                    backend=self.backend.url if index % 2 else "http://127.0.0.1:19991")
        status, result = self.summary()
        self.assertEqual(status, 200)
        self.assertEqual(result["input_registration"]["count"], INPUT_MEDIA_LIMIT)
        self.assertEqual(result["input_registration"]["remaining"], 0)
        with self.assertRaisesRegex(ValueError, "上限"):
            self.app.check_input_storage()
        self.app.media.pop(next(iter(self.app.media)))
        self.app.check_input_storage()
        self.assertEqual(self.summary()[1]["input_registration"]["remaining"], 1)

    def test_recovery_protection_never_presents_remaining_upload_capacity(self):
        self.app.register_media("known.png", kind="input")
        self.app.recovery_protected_files.add("input-media.json")
        result = self.summary()[1]
        self.assertEqual(result["input_registration"], {"status": "unavailable", "count": 1,
                                                        "limit": 10000, "remaining": None, "protected": True})
        self.assertNotEqual(result["status"], "ok")
        with self.assertRaisesRegex(ValueError, "无法安全保存"):
            self.app.check_input_storage()

    @unittest.skipUnless(SAFE_DIRECTORY_SCAN, "safe directory descriptor enumeration unavailable")
    def test_refresh_rechecks_external_change_and_reports_unknown_store(self):
        self.assertEqual(self.summary()[1]["local_assets"]["count"], 0)
        store = self.app.local_assets.root
        store.mkdir()
        file = store / ("a" * 64)
        file.write_bytes(b"bytes")
        self.assertEqual(self.summary()[1]["local_assets"]["bytes"], 5)
        file.write_bytes(b"updated bytes")
        self.assertEqual(self.summary()[1]["local_assets"]["bytes"], 13)
        file.unlink()
        store.rmdir()
        store.write_bytes(b"wrong directory")
        result = self.summary()[1]
        self.assertEqual(result["local_assets"]["status"], "partial")
        self.assertIsNone(result["local_assets"]["images"]["bytes"])
        store.unlink()
        self.assertEqual(self.summary()[1]["local_assets"]["status"], "ok")

    def test_no_storage_scan_on_bootstrap_status_or_heartbeat(self):
        with patch("frameweave.server.local_asset_summary", side_effect=AssertionError("only explicit storage read")):
            for endpoint in ["/api/bootstrap", "/api/status", "/api/heartbeat"]:
                self.assertEqual(self.request("GET", endpoint)[0], 200)

    def test_scan_runs_without_holding_global_task_lock(self):
        def unlocked(*args):
            self.assertFalse(self.app.lock._is_owned())
            return {"status": "ok", "count": 0, "bytes": 0,
                    "images": {"status": "ok", "count": 0, "bytes": 0},
                    "media": {"status": "ok", "count": 0, "bytes": 0}}

        with patch("frameweave.server.local_asset_summary", side_effect=unlocked):
            self.assertEqual(self.summary()[0], 200)

    def test_host_and_cross_site_boundaries_apply_to_read_endpoint(self):
        with patch("frameweave.server.local_asset_summary", side_effect=AssertionError("rejected reads do not scan")):
            for headers in [{"Host": "example.com"}, {"Origin": "https://example.com"}, {"Sec-Fetch-Site": "cross-site"}]:
                self.assertEqual(self.summary(headers=headers)[0], 403)


if __name__ == "__main__":
    unittest.main()
