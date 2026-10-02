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


def _identifier(value):
    return isinstance(value, str) and 1 <= len(value) <= 128


def _node(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    value = str(value)
    return value if 1 <= len(value) <= 100 else None


def _steps(value, maximum):
    try:
        return (all(not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v)
                    for v in (value, maximum)) and 0 <= value <= maximum and maximum > 0)
    except OverflowError:
        return False


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
        self.connection_epoch = 0
        self.sock = None

    def ensure(self):
        with self.lock:
            if self.app.closed.is_set():
                return
            if not self.thread or not self.thread.is_alive():
                self.ready.clear()
                self.thread = threading.Thread(target=self._run, daemon=True, name='prism-progress')
                self.thread.start()
        self.ready.wait(.4)

    def _owned(self, job_id):
        job = self.app.jobs.get(job_id)
        return bool(job and job.get('backend') == self.backend and job.get('status') in {'queued', 'running'})

    def _set_node(self, record, node, *, restart=False):
        node = node or ''
        if restart or record.get('execution_node', '') != node:
            record['_node_epoch'] = record.get('_node_epoch', 0) + 1
            record.update(progress=None)
            record.pop('step', None)
            record.pop('steps', None)
        record['execution_node'] = node

    def _sample(self, record, value, maximum):
        record.update(stage='采样中', progress=value / maximum * 100,
                      progress_scope='node', step=value, steps=maximum)

    def event(self, message):
        if not isinstance(message, dict) or not isinstance(message.get('data'), dict):
            return
        data, kind = message['data'], message.get('type')
        if not isinstance(kind, str):
            return
        job_id = data.get('prompt_id')
        if job_id is not None and not _identifier(job_id):
            return
        with self.app.lock, self.lock:
            if not self.connected or self.app.backend.url != self.backend:
                return
            if job_id is not None and not self._owned(job_id):
                if kind in {'execution_start', 'executing', 'progress', 'progress_state'}:
                    self.current = None
                return
            if job_id is None:
                # Old progress events omit prompt_id; only trust a prior owned executing event.
                if kind != 'progress':
                    if kind in {'execution_start', 'executing', 'progress_state'}:
                        self.current = None
                    return
                job_id = self.current
            if not self._owned(job_id):
                return
            record = self.records.get(job_id, {})
            if record.get('_execution_ended') and kind != 'execution_start':
                return
            if kind in {'execution_start', 'executing'}:
                node = _node(data.get('node'))
                if kind == 'executing' and data.get('node') is not None and node is None:
                    return
                self.current = job_id if kind == 'execution_start' or data.get('node') is not None else None
                record.update(stage='准备执行' if kind == 'execution_start' else '执行节点' if data.get('node') is not None else '正在保存输出', progress=None)
                self._set_node(record, node, restart=kind == 'execution_start')
                record.pop('_execution_ended', None)
                record.pop('step', None)
                record.pop('steps', None)
                record.pop('execution_nodes', None)
            elif kind == 'progress':
                value, maximum = data.get('value'), data.get('max')
                if not _steps(value, maximum):
                    return
                node = _node(data.get('node'))
                if data.get('node') is not None and node is None:
                    return
                if data.get('node') is not None:
                    # An explicit prompt/node event can re-establish ownership after reconnect.
                    self._set_node(record, node)
                elif record.get('_progress_epoch') != self.connection_epoch:
                    # The job is explicit, but the reconnect event did not identify its node.
                    self._set_node(record, None, restart=True)
                self.current = job_id
                record.pop('execution_nodes', None)
                self._sample(record, value, maximum)
            elif kind == 'progress_state':
                nodes = data.get('nodes')
                if not isinstance(nodes, dict) or len(nodes) > 4096:
                    return
                running = []
                for node_id, state in nodes.items():
                    if (not _node(node_id) or not isinstance(state, dict)
                            or state.get('prompt_id', job_id) != job_id
                            or state.get('node_id', node_id) != node_id
                            or state.get('state') not in ('running', 'finished', 'error')
                            or not _steps(state.get('value'), state.get('max'))):
                        return
                    if state['state'] == 'running':
                        running.append(node_id)
                record['execution_nodes'] = running
                self._set_node(record, running[0] if len(running) == 1 else None)
                record.update(stage='执行节点' if running else '等待后续节点', progress=None)
                record.pop('step', None)
                record.pop('steps', None)
                # Never aggregate unrelated node counters into an overall percentage.
                if len(running) == 1:
                    state = nodes[running[0]]
                    if state['max'] != 1 or state['value'] != 0:
                        self._sample(record, state['value'], state['max'])
                elif len(running) > 1:
                    record['stage'] = '多个节点执行中'
                self.current = job_id if len(running) == 1 else None
            elif kind == 'execution_cached':
                nodes = data.get('nodes')
                if not isinstance(nodes, list) or len(nodes) > 4096 or any(_node(node) is None for node in nodes):
                    return
                record['cached_nodes'] = len(nodes)
                record.setdefault('stage', '准备执行（复用缓存）')
                record.setdefault('progress', None)
            elif kind in {'execution_success', 'execution_error', 'execution_interrupted'}:
                record.update(stage={'execution_success': '执行结束，等待结果确认',
                                     'execution_error': '执行出错，等待结果确认',
                                     'execution_interrupted': '执行中断，等待结果确认'}[kind],
                              progress=None, _execution_ended=True)
                record.pop('step', None)
                record.pop('steps', None)
                record.pop('execution_nodes', None)
                if self.current == job_id:
                    self.current = None
            else:
                return
            record['progress_updated_at'] = time.time()
            record['_progress_epoch'] = self.connection_epoch
            self.records[job_id] = record
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
        job_id, node = None, None
        if event_type == 4:
            metadata_size = image_type
            if not 1 <= metadata_size <= 16384 or 8 + metadata_size >= len(payload):
                return
            try:
                metadata = json.loads(content[:metadata_size].decode('utf8'))
            except (ValueError, UnicodeError, RecursionError):
                return
            if not isinstance(metadata, dict) or not _identifier(metadata.get('prompt_id')):
                return
            job_id, node = metadata['prompt_id'], _node(metadata.get('node_id'))
            if not node:
                return
            content = content[metadata_size:]
            image_type = 1 if metadata.get('image_type') == 'image/jpeg' else 2 if metadata.get('image_type') == 'image/png' else None
        elif event_type != 1:
            return
        mime = 'image/jpeg' if image_type == 1 and content.startswith(b'\xff\xd8\xff') else 'image/png' if image_type == 2 and content.startswith(b'\x89PNG\r\n\x1a\n') else None
        if not mime:
            return
        with self.app.lock, self.lock:
            if not self.connected or self.app.backend.url != self.backend:
                return
            job_id = job_id or self.current
            if not self._owned(job_id):
                return
            record = self.records.setdefault(job_id, {})
            if record.get('_execution_ended'):
                return
            if node and (record.get('_progress_epoch') != self.connection_epoch
                         or (record.get('execution_node') != node
                             and node not in record.get('execution_nodes', []))):
                return
            self.previews[job_id] = (content, mime)
            record['preview_url'] = f'/api/jobs/{quote(job_id, safe="")}/preview?v={time.time_ns()}'
            record['preview_updated_at'] = time.time()
            record['preview_node'] = node or record.get('execution_node', '')
            record['_preview_epoch'] = self.connection_epoch
            record['_preview_node_epoch'] = record.get('_node_epoch', 0)

    def snapshot(self, job):
        if job.get('status') not in {'queued', 'running'}:
            with self.lock:
                self.records.pop(job.get('id'), None)
                self.previews.pop(job.get('id'), None)
            return {}
        with self.app.lock, self.lock:
            same_backend = job.get('backend') == self.backend == self.app.backend.url
            result = dict(self.records.get(job['id'], {})) if same_backend else {}
            result['progress_connected'] = self.connected and same_backend
            epoch = result.pop('_progress_epoch', None)
            preview_epoch = result.pop('_preview_epoch', None)
            node_epoch = result.pop('_node_epoch', 0)
            preview_node_epoch = result.pop('_preview_node_epoch', None)
            execution_ended = result.pop('_execution_ended', False)
            result['progress_identity_unknown'] = bool(same_backend and (
                not job.get('client_id') or job.get('client_id') != getattr(self.app, 'client_id', None))
                and epoch != self.connection_epoch)
            result['progress_stale'] = bool(result.get('stage')) and (
                not result['progress_connected'] or epoch != self.connection_epoch)
            result['preview_stale'] = bool(result.get('preview_url')) and (
                not result['progress_connected'] or preview_epoch != self.connection_epoch
                or preview_node_epoch != node_epoch or execution_ended
                or ('execution_nodes' in result and result.get('preview_node') not in result['execution_nodes']))
            return result

    def _connected(self, backend):
        with self.lock:
            self.connection_epoch += 1
            self.backend, self.connected, self.current = backend, True, None

    def preview(self, job_id):
        with self.app.lock, self.lock:
            if not self._owned(job_id) or self.app.backend.url != self.backend or job_id not in self.previews:
                self.previews.pop(job_id, None)
                self.records.pop(job_id, None)
                raise ValueError('此任务当前没有中间预览')
            return self.previews[job_id]

    @staticmethod
    def _send_frame(sock, opcode, payload):
        # All client frames, including capability negotiation and pong, are masked.
        mask = secrets.token_bytes(4)
        size = len(payload)
        header = bytes([128 | opcode, 128 | size]) if size < 126 else bytes([128 | opcode, 254]) + struct.pack('!H', size)
        sock.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

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
                deadline = time.monotonic() + 3
                while b'\r\n\r\n' not in buffer:
                    if self.app.closed.is_set() or self.app.backend.url != backend or time.monotonic() >= deadline:
                        raise OSError('Handshake ended')
                    part = sock.recv(4096)
                    if not part or len(buffer) > 16384:
                        raise OSError('Invalid WebSocket handshake')
                    buffer.extend(part)
                head, tail = bytes(buffer).split(b'\r\n\r\n', 1)
                lines = head.decode('latin1').split('\r\n')
                headers = {line.split(':', 1)[0].lower(): line.split(':', 1)[1].strip() for line in lines[1:] if ':' in line}
                accept = base64.b64encode(hashlib.sha1((key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                if (not lines[0].startswith('HTTP/1.1 101 ') or headers.get('sec-websocket-accept') != accept
                        or headers.get('upgrade', '').lower() != 'websocket'
                        or 'upgrade' not in {item.strip().lower() for item in headers.get('connection', '').split(',')}):
                    raise OSError('WebSocket unavailable')
                self._send_frame(sock, 1, b'{"type":"feature_flags","data":{"supports_preview_metadata":true}}')
                self._connected(backend)
                self.ready.set()
                buffer = bytearray(tail)
                def read(size):
                    if self.app.closed.is_set() or self.app.backend.url != backend:
                        raise OSError('Session ended')
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
                    if opcode in {8, 9, 10} and (not final or size > 125):
                        raise OSError('Invalid control frame')
                    if size > LIMIT or len(fragments)+size > LIMIT:
                        raise OSError('Frame too large')
                    payload = read(size)
                    if opcode == 8: break
                    if opcode == 9:
                        self._send_frame(sock, 10, payload)
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
                            try:
                                self.event(json.loads(fragments.decode('utf8')))
                            except (ValueError, UnicodeError, RecursionError):
                                # A malformed event must not suppress all subsequent progress.
                                pass
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
