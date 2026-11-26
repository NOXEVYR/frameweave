"""Response transport failures must not replay a completed local write."""

import errno
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from frameweave.server import App, make_server


class _FailingWriter:
    """Inject a socket failure at a real HTTP response write boundary."""

    def __init__(self, stream, write_number, error):
        self.stream = stream
        self.write_number = write_number
        self.error = error
        self.writes = 0

    def write(self, data):
        self.writes += 1
        if self.writes == self.write_number:
            raise self.error
        return self.stream.write(data)

    def __getattr__(self, name):
        return getattr(self.stream, name)


class ResponseDisconnectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.web = self.root / "web"
        self.web.mkdir()
        self.app = App(self.root / "data", self.web)
        self.server = make_server(self.app)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.app.closed.set)

    def request(self, path, data):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request("POST", path, json.dumps(data).encode(), {
                "Content-Type": "application/json",
                "X-FW-Token": self.app.csrf,
                "Origin": f"http://127.0.0.1:{self.server.server_port}",
            })
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def start_server(self):
        thread = threading.Thread(target=self.server.serve_forever,
                                  kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 3)
        self.addCleanup(self.server.shutdown)

    def test_header_and_body_disconnect_preserve_exactly_one_canvas_write(self):
        document = {"schema": "prismcanvas.project.v1", "version": 1,
                    "name": "Disconnect persistence", "packages": [],
                    "canvas": {"nodes": [], "edges": []}}
        handler_class = self.server.RequestHandlerClass
        original_setup = handler_class.setup
        original_send_response = handler_class.send_response
        original_finish = handler_class.finish
        self.start_server()

        for phase, write_number in (("headers", 1), ("body", 2)):
            for error_type in (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                with self.subTest(phase=phase, error=error_type.__name__):
                    completed = threading.Event()
                    statuses, handlers = [], []

                    def setup(handler):
                        original_setup(handler)
                        # Windows reports WinError 10053 as ConnectionAbortedError.
                        error = error_type("client disconnected")
                        if error_type is ConnectionAbortedError:
                            error.winerror = 10053
                        handler.wfile = _FailingWriter(handler.wfile, write_number, error)
                        handlers.append(handler)

                    def send_response(handler, code, message=None):
                        statuses.append(code)
                        return original_send_response(handler, code, message)

                    def finish(handler):
                        try:
                            original_finish(handler)
                        finally:
                            completed.set()

                    before = set(self.app.canvases.root.glob("*.json"))
                    with patch.object(handler_class, "setup", setup), \
                         patch.object(handler_class, "send_response", send_response), \
                         patch.object(handler_class, "finish", finish), \
                         patch.object(self.server, "handle_error") as errors, \
                         patch.object(self.app.canvases, "save", wraps=self.app.canvases.save) as save:
                        with self.assertRaises((http.client.RemoteDisconnected, http.client.IncompleteRead)):
                            self.request("/api/canvases", {"document": document})
                        self.assertTrue(completed.wait(3), "disconnected handler did not finish")
                        self.assertEqual(save.call_count, 1)
                        self.assertEqual(statuses, [200], "a second HTTP response was attempted")
                        errors.assert_not_called()
                        self.assertTrue(handlers[0].close_connection)
                        self.assertEqual(handlers[0].wfile.writes, write_number)

                    created = set(self.app.canvases.root.glob("*.json")) - before
                    self.assertEqual(len(created), 1)
                    saved = json.loads(created.pop().read_text(encoding="utf-8"))
                    self.assertEqual(saved["document"], document)
                    self.assertEqual(self.app.canvases.get(saved["id"])["document"], document)

    def test_editor_close_finishes_once_after_response_abort(self):
        proxy = Mock()
        self.app.editor_sessions["test-session"] = {"proxy": proxy}
        handler_class = self.server.RequestHandlerClass
        original_setup = handler_class.setup
        original_finish = handler_class.finish
        completed = threading.Event()

        def setup(handler):
            original_setup(handler)
            handler.wfile = _FailingWriter(handler.wfile, 2, ConnectionAbortedError("client disconnected"))

        def finish(handler):
            try:
                original_finish(handler)
            finally:
                completed.set()

        with patch.object(handler_class, "setup", setup), \
             patch.object(handler_class, "finish", finish), \
             patch.object(self.server, "handle_error") as errors:
            self.start_server()
            with self.assertRaises(http.client.IncompleteRead):
                self.request("/api/editor-sessions/close", {"session_id": "test-session"})
            self.assertTrue(completed.wait(3))
            errors.assert_not_called()
        proxy.close.assert_called_once_with()
        self.assertNotIn("test-session", self.app.editor_sessions)

    def test_business_os_errors_still_return_502_without_persistence(self):
        self.start_server()
        for error in (OSError(errno.ENOSPC, "test disk full"),
                      PermissionError(errno.EACCES, "test access denied"),
                      ConnectionAbortedError("business operation failed")):
            with self.subTest(error=type(error).__name__), \
                 patch.object(self.app.canvases, "save", side_effect=error) as save:
                status, headers, body = self.request("/api/canvases", {"document": {}})
                self.assertEqual(status, 502)
                self.assertEqual(json.loads(body), {"error": str(error)})
                self.assertEqual(headers["X-Frame-Options"], "DENY")
                save.assert_called_once_with({})
        self.assertEqual(list(self.app.canvases.root.glob("*.json")), [])

    def test_non_disconnect_output_errors_and_serialization_errors_propagate(self):
        handler = self.server.RequestHandlerClass.__new__(self.server.RequestHandlerClass)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = Mock()
        handler.close_connection = False
        error = OSError(errno.EIO, "test unexpected output failure")
        handler.wfile.write.side_effect = error
        with self.assertRaises(OSError) as caught:
            handler.respond(b"payload")
        self.assertIs(caught.exception, error)
        self.assertFalse(handler.close_connection)
        handler.send_response.reset_mock()
        handler.wfile.reset_mock()
        with self.assertRaises(ValueError):
            handler.respond({"invalid": float("nan")})
        handler.send_response.assert_not_called()
        handler.wfile.write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
