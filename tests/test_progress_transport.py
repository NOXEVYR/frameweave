"""One-shot loopback WebSocket peers for the progress reader; no inference service."""

import base64
import hashlib
import json
import socket
import struct
import threading
import time
import unittest
from types import SimpleNamespace

from frameweave.progress import ProgressStream


PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII="
)


def frame(opcode, payload=b"", *, final=True, masked=False):
    first = opcode | (0x80 if final else 0)
    size = len(payload)
    header = bytearray([first, (0x80 if masked else 0) | (size if size < 126 else 126)])
    if size >= 126:
        header.extend(struct.pack("!H", size))
    if masked:
        mask = b"abcd"
        header.extend(mask)
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return bytes(header) + payload


def text_event(kind, **data):
    return json.dumps({"type": kind, "data": data}).encode("utf-8")


def wait_for(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.01)
    return predicate()


def receive_exact(connection, size):
    content = bytearray()
    while len(content) < size:
        part = connection.recv(size - len(content))
        if not part:
            raise AssertionError("WebSocket peer closed early")
        content.extend(part)
    return bytes(content)


class OneShotPeer:
    def __init__(self, scenario):
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(3)
        self.url = f"http://127.0.0.1:{self.listener.getsockname()[1]}"
        self.scenario = scenario
        self.error = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        try:
            with self.listener.accept()[0] as connection:
                connection.settimeout(3)
                request = bytearray()
                while b"\r\n\r\n" not in request:
                    part = connection.recv(4096)
                    if not part:
                        raise AssertionError("WebSocket handshake ended early")
                    request.extend(part)
                lines = request.decode("ascii").split("\r\n")
                assert lines[0].startswith("GET /ws?clientId=prism-test HTTP/1.1"), lines[0]
                headers = {line.split(":", 1)[0].lower(): line.split(":", 1)[1].strip()
                           for line in lines[1:] if ":" in line}
                key = headers["sec-websocket-key"]
                accept = base64.b64encode(hashlib.sha1(
                    (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
                ).digest()).decode("ascii")
                response = ("HTTP/1.1 101 Switching Protocols\r\n"
                            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                            f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode("ascii")
                self.scenario(connection, response)
        except Exception as exc:
            self.error = exc
        finally:
            self.done.set()
            self.listener.close()

    def finish(self):
        self.done.wait(4)
        self.thread.join(1)
        if self.error:
            raise self.error


class ProgressTransportTests(unittest.TestCase):
    def attach(self, scenario):
        peer = OneShotPeer(scenario)
        app = SimpleNamespace(lock=threading.RLock(), closed=threading.Event(),
                              backend=SimpleNamespace(url=peer.url), client_id="prism-test",
                              jobs={"ours": {"id": "ours", "backend": peer.url, "status": "running"},
                                    "foreign": {"id": "foreign", "backend": "http://127.0.0.1:9", "status": "running"}})
        stream = ProgressStream(app)
        self.addCleanup(app.closed.set)
        self.addCleanup(peer.finish)
        stream.ensure()
        return app, stream, peer

    def test_coalesced_handshake_fragmented_text_ping_preview_and_close(self):
        release = threading.Event()
        pong = []

        def scenario(connection, response):
            start = frame(1, text_event("execution_start", prompt_id="ours"))
            connection.sendall(response + start)  # First frame shares the HTTP response packet.
            payload = text_event("progress", prompt_id="ours", node="sampler", value=3, max=12)
            middle = len(payload) // 2
            connection.sendall(frame(1, payload[:middle], final=False))
            connection.sendall(frame(9, b"ok"))
            connection.sendall(frame(0, payload[middle:]))
            connection.sendall(frame(2, struct.pack("!II", 1, 2) + PNG))
            first, second = receive_exact(connection, 2)
            self.assertEqual(first & 15, 10)
            self.assertTrue(second & 128, "client pong must be masked")
            size = second & 127
            mask = receive_exact(connection, 4)
            body = receive_exact(connection, size)
            pong.append(bytes(value ^ mask[index % 4] for index, value in enumerate(body)))
            release.wait(3)
            connection.sendall(frame(8))

        app, stream, peer = self.attach(scenario)
        try:
            self.assertTrue(wait_for(lambda: stream.snapshot(app.jobs["ours"]).get("progress") == 25))
            self.assertTrue(wait_for(lambda: "ours" in stream.previews))
            self.assertEqual(stream.preview("ours"), (PNG, "image/png"))
            self.assertTrue(wait_for(lambda: pong == [b"ok"]))
            self.assertTrue(stream.snapshot(app.jobs["ours"])["progress_connected"])
            release.set()
            self.assertTrue(wait_for(lambda: not stream.connected))
        finally:
            release.set()
            app.closed.set()
        peer.finish()

    def test_malformed_prompt_id_is_ignored_without_dropping_following_event(self):
        release = threading.Event()

        def scenario(connection, response):
            connection.sendall(response)
            connection.sendall(frame(1, text_event("progress", prompt_id=[], value=1, max=2)))
            connection.sendall(frame(1, text_event("progress", prompt_id="ours", value=1, max=2)))
            release.wait(3)
            connection.sendall(frame(8))

        app, stream, peer = self.attach(scenario)
        try:
            self.assertTrue(wait_for(lambda: stream.snapshot(app.jobs["ours"]).get("progress") == 50),
                            "malformed event disconnected the stream")
            self.assertTrue(stream.connected)
        finally:
            release.set()
            app.closed.set()
        peer.finish()

    def test_foreign_prompt_preview_is_not_exposed_and_terminal_preview_expires(self):
        release = threading.Event()

        def scenario(connection, response):
            connection.sendall(response)
            connection.sendall(frame(1, text_event("execution_start", prompt_id="foreign")))
            connection.sendall(frame(2, struct.pack("!II", 1, 2) + PNG))
            connection.sendall(frame(1, text_event("execution_start", prompt_id="ours")))
            connection.sendall(frame(2, struct.pack("!II", 1, 2) + PNG))
            release.wait(3)
            connection.sendall(frame(8))

        app, stream, peer = self.attach(scenario)
        try:
            self.assertTrue(wait_for(lambda: "ours" in stream.previews))
            self.assertNotIn("foreign", stream.previews)
            app.jobs["ours"]["status"] = "completed"
            self.assertEqual(stream.snapshot(app.jobs["ours"]), {})
            self.assertNotIn("ours", stream.previews, "terminal preview should release its bytes on status polling")
            with self.assertRaises(ValueError):
                stream.preview("ours")
        finally:
            release.set()
            app.closed.set()
        peer.finish()

    def test_unscoped_executing_cannot_rebind_foreign_preview_to_our_job(self):
        release = threading.Event()

        def scenario(connection, response):
            connection.sendall(response)
            connection.sendall(frame(1, text_event("execution_start", prompt_id="ours")))
            connection.sendall(frame(1, text_event("executing", node="unknown-owner")))
            connection.sendall(frame(2, struct.pack("!II", 1, 2) + PNG))
            release.wait(3)

        app, stream, peer = self.attach(scenario)
        try:
            self.assertTrue(wait_for(lambda: "ours" in stream.records))
            self.assertTrue(wait_for(lambda: stream.current is None),
                            "an unscoped execution event retained the previous job identity")
            self.assertNotIn("ours", stream.previews)
        finally:
            release.set()
            app.closed.set()
        peer.finish()

    def test_masked_server_frame_disconnects_without_accepting_event(self):
        release = threading.Event()

        def scenario(connection, response):
            connection.sendall(response)
            connection.sendall(frame(1, text_event("progress", prompt_id="ours", value=1, max=2), masked=True))
            release.wait(3)

        app, stream, peer = self.attach(scenario)
        try:
            self.assertTrue(wait_for(lambda: not stream.connected))
            self.assertEqual(stream.records, {})
        finally:
            release.set()
            app.closed.set()
        peer.finish()

    def test_backend_switch_invalidates_preview_and_disconnects_old_socket(self):
        release = threading.Event()

        def scenario(connection, response):
            connection.sendall(response)
            connection.sendall(frame(1, text_event("execution_start", prompt_id="ours")))
            connection.sendall(frame(2, struct.pack("!II", 1, 2) + PNG))
            release.wait(3)

        app, stream, peer = self.attach(scenario)
        try:
            self.assertTrue(wait_for(lambda: "ours" in stream.previews))
            self.assertEqual(stream.preview("ours"), (PNG, "image/png"))
            app.backend.url = "http://127.0.0.1:9"
            with self.assertRaises(ValueError):
                stream.preview("ours")
            self.assertTrue(wait_for(lambda: not stream.connected))
        finally:
            release.set()
            app.closed.set()
        peer.finish()


if __name__ == "__main__":
    unittest.main()
