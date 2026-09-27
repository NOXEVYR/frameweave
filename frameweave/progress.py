"""Bounded ComfyUI event reader. Events never create, complete, or retry jobs."""
import base64
import hashlib
import json
import math
import secrets
import socket
import struct
import threading
import time
from urllib.parse import urlsplit, quote

from .backend import local_url

LIMIT = 10 * 1024 * 1024


class ProgressStream:
    def __init__(self, app):
        self.app = app
        self.lock = threading.RLock()
        self.thread = None
        self.ready = threading.Event()
        self.records = {}
        self.previews = {}
        self.current = None
        self.backend = ''
        self.connected = False
        self.sock = None

    def ensure(self):
        with self.lock:
            if not self.thread or not self.thread.is_alive():
                self.ready.clear()
                self.thread = threading.Thread(target=self._run, daemon=True, name='prism-progress')
                self.thread.start()
        self.ready.wait(.4)

    def _owned(self, job_id):
        job = self.app.jobs.get(job_id)
        return bool(job and job.get('backend') == self.backend and job.get('status') in {'queued', 'running'})

    def event(self, message):
        if not isinstance(message, dict) or not isinstance(message.get('data'), dict):
            return
        data, kind = message['data'], message.get('type')
        job_id = data.get('prompt_id')
        if job_id is not None and (not isinstance(job_id, str) or not 1 <= len(job_id) <= 128):
            return
        with self.app.lock, self.lock:
            if job_id is not None and not self._owned(job_id):
                if kind in {'execution_start', 'executing'}:
                    self.current = None
                return
            if job_id is None:
                # Old progress events omit prompt_id; only trust a prior owned executing event.
                if kind != 'progress':
                    if kind in {'execution_start', 'executing'}:
                        self.current = None
                    return
                job_id = self.current
            if not self._owned(job_id):
                return
            record = self.records.setdefault(job_id, {})
            if kind in {'execution_start', 'executing'}:
                self.current = job_id if kind == 'execution_start' or data.get('node') is not None else None
                record.update(stage='准备执行' if kind == 'execution_start' else '执行节点' if data.get('node') is not None else '正在保存输出', progress=None)
                record['execution_node'] = str(data.get('node') or '')[:100]
                record.pop('step', None)
                record.pop('steps', None)
            elif kind == 'progress':
                value, maximum = data.get('value'), data.get('max')
                if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in (value, maximum)) or maximum <= 0 or value < 0 or value > maximum:
                    return
                record.update(stage='采样中', progress=value / maximum * 100, step=value, steps=maximum)
                if data.get('node') is not None:
                    record['execution_node'] = str(data['node'])[:100]
            else:
                return
            record['progress_updated_at'] = time.time()
            # Finished job events are not retained indefinitely.
            for stale in list(self.records):
                if stale != job_id and not self._owned(stale):
                    self.records.pop(stale, None)
                    self.previews.pop(stale, None)

    def binary(self, payload):
        if len(payload) < 12 or len(payload) > LIMIT:
            return
        event_type, image_type = struct.unpack('!II', payload[:8])
        content = payload[8:]
        if event_type != 1:
            return
        mime = 'image/jpeg' if image_type == 1 and content.startswith(b'\xff\xd8\xff') else 'image/png' if image_type == 2 and content.startswith(b'\x89PNG\r\n\x1a\n') else None
        if not mime:
            return
        with self.app.lock, self.lock:
            if not self._owned(self.current):
                return
            self.previews[self.current] = (content, mime)
            record = self.records.setdefault(self.current, {})
            record['preview_url'] = f'/api/jobs/{quote(self.current, safe="")}/preview?v={time.time_ns()}'

    def snapshot(self, job):
        if job.get('status') not in {'queued', 'running'}:
            with self.lock:
                self.records.pop(job.get('id'), None)
                self.previews.pop(job.get('id'), None)
            return {}
        with self.lock:
            result = dict(self.records.get(job['id'], {})) if job.get('backend') == self.backend else {}
            result['progress_connected'] = self.connected and job.get('backend') == self.backend
            return result

    def preview(self, job_id):
        with self.app.lock, self.lock:
            if not self._owned(job_id) or self.app.backend.url != self.backend or job_id not in self.previews:
                self.previews.pop(job_id, None)
                self.records.pop(job_id, None)
                raise ValueError('此任务当前没有中间预览')
            return self.previews[job_id]

    def _run(self):
        while not self.app.closed.is_set():
            sock = None
            try:
                backend = local_url(self.app.backend.url)
                parsed = urlsplit(backend)
                sock = socket.create_connection((parsed.hostname, parsed.port), timeout=2)
                sock.settimeout(1)
                self.sock = sock
                key = base64.b64encode(secrets.token_bytes(16)).decode()
                request = f'GET /ws?clientId={quote(self.app.client_id)} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'
                sock.sendall(request.encode('ascii'))
                buffer = bytearray()
                while b'\r\n\r\n' not in buffer:
                    part = sock.recv(4096)
                    if not part or len(buffer) > 16384:
                        raise OSError('Invalid WebSocket handshake')
                    buffer.extend(part)
                head, tail = bytes(buffer).split(b'\r\n\r\n', 1)
                lines = head.decode('latin1').split('\r\n')
                headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip() for line in lines[1:] if ':' in line}
                accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                if not lines[0].startswith('HTTP/1.1 101 ') or headers.get('sec-websocket-accept') != accept or headers.get('upgrade', '').lower() != 'websocket':
                    raise OSError('WebSocket unavailable')
                with self.lock:
                    self.backend, self.connected, self.current = backend, True, None
                self.ready.set()
                buffer = bytearray(tail)
                def read(size):
                    while len(buffer) < size:
                        if self.app.closed.is_set() or self.app.backend.url != backend:
                            raise OSError('Session ended')
                        try:
                            part = sock.recv(min(65536, size-len(buffer)))
                        except socket.timeout:
                            continue
                        if not part:
                            raise OSError('Stream closed')
                        buffer.extend(part)
                    value = bytes(buffer[:size]); del buffer[:size]
                    return value
                fragments, initial = bytearray(), None
                while not self.app.closed.is_set():
                    first, second = read(2)
                    opcode, final, size = first & 15, bool(first & 128), second & 127
                    if first & 112 or second & 128:
                        raise OSError('Unexpected server frame')
                    if size == 126: size = struct.unpack('!H', read(2))[0]
                    elif size == 127: size = struct.unpack('!Q', read(8))[0]
                    if size > LIMIT or len(fragments)+size > LIMIT:
                        raise OSError('Frame too large')
                    payload = read(size)
                    if opcode == 8: break
                    if opcode == 9:
                        if not final or size > 125: raise OSError('Invalid ping')
                        mask = secrets.token_bytes(4)
                        sock.sendall(bytes([138, 128+size])+mask+bytes(v^mask[i%4] for i,v in enumerate(payload)))
                        continue
                    if opcode == 10: continue
                    if opcode in {1, 2}:
                        if initial is not None: raise OSError('Invalid fragmentation')
                        initial = opcode
                    elif opcode != 0 or initial is None: raise OSError('Invalid opcode')
                    fragments.extend(payload)
                    if final:
                        if initial == 1:
                            if len(fragments) > 1024*1024: raise OSError('Event too large')
                            self.event(json.loads(fragments.decode('utf8')))
                        else: self.binary(bytes(fragments))
                        fragments, initial = bytearray(), None
            except (OSError, ValueError, UnicodeError, TypeError):
                pass
            finally:
                self.ready.set()
                with self.lock:
                    self.connected, self.current = False, None
                if sock:
                    sock.close()
                self.sock = None
            self.app.closed.wait(2)
