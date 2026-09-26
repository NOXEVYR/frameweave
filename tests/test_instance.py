import http.server
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from frameweave import __version__
from frameweave.instance import (InstanceLock, read_instance_url, resolve_default_data,
                                 validate_prismcanvas_url, _app_window_title_for_url)


BOOTSTRAP = {
    "application": "PrismCanvas",
    "version": __version__,
    "csrf": "A" * 43,
    "settings": {"backend_url": "http://127.0.0.1:8188", "model_roots": [], "comfy_roots": []},
    "presets": [],
}


class _AppHandler(http.server.BaseHTTPRequestHandler):
    payload = BOOTSTRAP

    def do_GET(self):
        if self.path != "/api/bootstrap":
            self.send_error(404)
            return
        body = json.dumps(self.payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class InstanceTests(unittest.TestCase):
    def test_window_identity_is_scoped_to_the_exact_loopback_origin_port(self):
        self.assertEqual(_app_window_title_for_url("http://127.0.0.1:18769/"),
                         "棱光 PrismCanvas · 工作区 18769")
        self.assertEqual(_app_window_title_for_url("http://127.0.0.1:8766/"),
                         "棱光 PrismCanvas · 工作区 8766")
        with self.assertRaises(ValueError):
            _app_window_title_for_url("http://127.0.0.1:8766/api/bootstrap")

    def test_default_workspace_pointer_selects_existing_local_directory_and_port(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "FrameWeave"
            workspace = Path(folder) / "PrismCanvas Qwen"
            root.mkdir()
            workspace.mkdir()
            (root / "workspace-location.json").write_text(
                json.dumps({"data_dir": str(workspace), "port": 8766}), encoding="utf-8")
            self.assertEqual(resolve_default_data(root), (workspace.resolve(), 8766))

    def test_invalid_workspace_pointer_falls_back_and_rejects_unc_or_missing_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "FrameWeave"
            root.mkdir()
            pointer = root / "workspace-location.json"
            fallback = (root.resolve(), 8765)
            invalid = [
                {"data_dir": "relative/path", "port": 8766},
                {"data_dir": r"\\server\share\PrismCanvas", "port": 8766},
                {"data_dir": str(Path(folder) / "missing"), "port": 8766},
                {"data_dir": str(root), "port": 70000},
                {"data_dir": str(root), "port": True},
            ]
            for value in invalid:
                with self.subTest(value=value):
                    pointer.write_text(json.dumps(value), encoding="utf-8")
                    self.assertEqual(resolve_default_data(root), fallback)

    def test_os_lock_excludes_another_process_and_releases_on_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            code = (
                "import sys,time; from pathlib import Path; "
                "from frameweave.instance import InstanceLock; "
                "lock=InstanceLock(Path(sys.argv[1])); "
                "assert lock.acquire(); print('ready',flush=True); time.sleep(60)"
            )
            proc = subprocess.Popen([sys.executable, "-c", code, folder], stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
            try:
                self.assertEqual(proc.stdout.readline().strip(), "ready")
                contender = InstanceLock(Path(folder))
                self.assertFalse(contender.acquire())
                proc.terminate()
                proc.wait(timeout=5)
                proc.stdout.close()
                proc.stderr.close()
                recovered = InstanceLock(Path(folder))
                self.assertTrue(recovered.acquire())
                recovered.release()
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=5)

    def test_owned_metadata_is_written_and_read(self):
        with tempfile.TemporaryDirectory() as folder:
            lock = InstanceLock(Path(folder))
            self.assertTrue(lock.acquire())
            try:
                self.assertIsNone(read_instance_url(Path(folder)))
                lock.write_metadata(url="http://127.0.0.1:12345/")
                self.assertEqual(read_instance_url(Path(folder)), "http://127.0.0.1:12345/")
            finally:
                lock.release()

    def test_only_valid_prismcanvas_loopback_bootstrap_is_reusable(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _AppHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/"
        try:
            self.assertTrue(validate_prismcanvas_url(url))
            with patch.object(_AppHandler, "payload", {**BOOTSTRAP, "version": "0.0.0"}):
                self.assertFalse(validate_prismcanvas_url(url))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_known_legacy_bootstrap_requires_explicit_compatibility_mode(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _AppHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_port}/"
        legacy = {key: value for key, value in BOOTSTRAP.items() if key != "application"}
        legacy["version"] = "0.8.0"
        try:
            with patch.object(_AppHandler, "payload", legacy):
                self.assertFalse(validate_prismcanvas_url(url))
                self.assertTrue(validate_prismcanvas_url(url, allow_legacy=True))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_untrusted_or_non_root_urls_are_rejected_before_network_access(self):
        invalid = [
            "https://127.0.0.1:12345/",
            "http://localhost:12345/",
            "http://127.0.0.1.evil.invalid:12345/",
            "http://user@127.0.0.1:12345/",
            "http://127.0.0.1:12345/api/submit",
            "http://127.0.0.1:12345/?next=https://example.invalid",
        ]
        with patch("frameweave.instance.http.client.HTTPConnection") as connection:
            for url in invalid:
                with self.subTest(url=url):
                    self.assertFalse(validate_prismcanvas_url(url))
            connection.assert_not_called()


if __name__ == "__main__":
    unittest.main()
