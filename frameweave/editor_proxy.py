"""A session-scoped, read-mostly ComfyUI origin for the embedded editor.

The proxy is deliberately separate from FrameWeave's application HTTP server:
ComfyUI's frontend runs under this short-lived loopback origin, while writes
that would modify ComfyUI state stay in memory for the lifetime of this proxy.
"""

import hmac
import http.client
import json
import re
import secrets
import select
import socket
import threading
import time
import urllib.parse
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .backend import local_url


MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_SESSION_WRITE_BYTES = 64 * 1024 * 1024
MAX_TARGET_LENGTH = 8192
HTTP_TIMEOUT = 12
WEBSOCKET_CONNECT_TIMEOUT = 5
WEBSOCKET_IDLE_TIMEOUT = 120
WEBSOCKET_FRAME_BUFFER = 64 * 1024
BRIDGE_PATH = "/prism-editor-bridge.js"
BRIDGE_EXTENSION = BRIDGE_PATH
MEDIA_MODULES = {
    "/prism-editor-media.mjs": "native-editor-media.mjs",
    "/prism-editor-media-preview.mjs": "editor-media-preview.mjs",
}

_HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length",
    "set-cookie", "set-cookie2", "location", "access-control-allow-origin",
}
_REQUEST_HEADERS = ("Accept", "Accept-Language", "If-None-Match", "If-Modified-Since",
                    "If-Range", "Range")
_SAFE_STATIC_EXACT = {
    "/favicon.ico", "/index.js", "/index.css", "/manifest.json", "/robots.txt",
    "/index.html", "/scripts", "/assets", "/locales", "/fonts", "/templates",
    "/rgthree/config.js", "/user.css", "/materialdesignicons.min.css",
}
_SAFE_STATIC_PREFIXES = ("/assets/", "/scripts/", "/extensions/", "/locales/",
                         "/fonts/", "/templates/", "/rgthree/common/", "/kjweb_async/")
_TASK_CONTROL_PATHS = {"/prompt", "/queue", "/interrupt", "/api/prompt", "/api/queue",
                      "/api/interrupt"}
_ALWAYS_BLOCKED_PATHS = {"/interrupt", "/api/interrupt", "/upload/image", "/api/upload/image"}
_SAFE_READ_ONLY_POST_PATHS = {"/manager/component/loads", "/api/manager/component/loads"}
_EDITOR_SETTINGS_PATHS = {"/settings", "/api/settings", "/settings/Comfy.TutorialCompleted",
                          "/api/settings/Comfy.TutorialCompleted"}
_ENCODED_SEPARATOR = re.compile(r"%(?:2f|5c)", re.IGNORECASE)
_WEBSOCKET_KEY = re.compile(r"^[A-Za-z0-9+/]{22}==$|^[A-Za-z0-9+/]{23}=$")


def _parent_origin(value):
    if not isinstance(value, str) or len(value) > 512:
        raise ValueError("父窗口来源无效")
    if value == "null":
        return value
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or
            parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("父窗口来源必须是精确的 HTTP(S) origin")
    try:
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError("父窗口来源无效") from None
    if not host:
        raise ValueError("父窗口来源无效")
    host = host.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 80 if parsed.scheme == "http" else 443
    return f"{parsed.scheme}://{host}" + (f":{port}" if port and port != default_port else "")


def _escape_script_json(value):
    """Keep JSON data from ending its inline script element."""
    return json.dumps(value, ensure_ascii=True, separators=(",", ":")).replace("<", "\\u003c")


def _inject_config(document, config):
    escaped = _escape_script_json(config)
    snippet = (f"<script>window.__PRISM_EDITOR__={escaped};"
               "if(new URLSearchParams(location.search).has('session')){"
               "const u=new URL(location.href);u.searchParams.delete('session');"
               "history.replaceState(null,'',u.pathname+u.search+u.hash);}</script>")
    lower = document.lower()
    head_end = lower.find("</head>")
    if head_end >= 0:
        return document[:head_end] + snippet + document[head_end:]
    head_start = re.search(r"<head(?:\s[^>]*)?>", document, re.IGNORECASE)
    if head_start:
        return document[:head_start.end()] + snippet + document[head_start.end():]
    html_start = re.search(r"<html(?:\s[^>]*)?>", document, re.IGNORECASE)
    if html_start:
        at = html_start.end()
        return document[:at] + "<head>" + snippet + "</head>" + document[at:]
    return "<head>" + snippet + "</head>" + document


def _validate_query(parsed, decoded_path):
    try:
        fields = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True, errors="strict")
    except (UnicodeDecodeError, ValueError):
        raise ValueError("请求路径无效") from None
    for name, value in fields:
        for part in (name, value):
            if (any(ord(ch) < 32 or ord(ch) == 127 for ch in part) or "\\" in part or
                    re.search(r"%(?:0[0-9a-f]|1[0-9a-f]|25|2e|2f|3a|5c|7f)", part, re.IGNORECASE)):
                raise ValueError("请求路径无效")
        if decoded_path in {"/view", "/api/view"} and name in {"filename", "subfolder"}:
            # Current ComfyUI LoadImage also uses content-addressed assets.
            # This is an identifier, not a drive path or an arbitrary scheme.
            asset_hash = name == "filename" and re.fullmatch(r"blake3:[0-9a-f]{64}", value)
            if (value.startswith("/") or (":" in value and not asset_hash) or
                    any(segment.endswith((" ", ".")) for segment in value.split("/"))):
                raise ValueError("请求路径无效")


def _safe_target(target):
    if not isinstance(target, str) or len(target) > MAX_TARGET_LENGTH:
        raise ValueError("请求路径无效")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in target) or "\\" in target:
        raise ValueError("请求路径无效")
    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme or parsed.netloc or parsed.fragment or not parsed.path.startswith("/"):
        raise ValueError("请求路径无效")
    if parsed.path.startswith("//"):
        raise ValueError("请求路径无效")
    for prefix in ("/userdata/", "/api/userdata/"):
        if parsed.path.startswith(prefix):
            if parsed.path == prefix:
                _validate_query(parsed, prefix)
                return parsed, prefix
            try:
                leaf = urllib.parse.unquote(parsed.path[len(prefix):], errors="strict")
            except (UnicodeDecodeError, ValueError):
                raise ValueError("请求路径无效") from None
            # Frontend encodes the whole relative file, including directory slashes.
            # Decode this leaf once only; it never changes the routing prefix.
            if (not leaf or "%" in leaf or any(ch in leaf for ch in '\\:*?"<>|#') or
                    any(ord(ch) < 32 or ord(ch) == 127 for ch in leaf) or
                    any(part in {"", ".", ".."} or part.endswith((" ", "."))
                        for part in leaf.split("/"))):
                raise ValueError("请求路径无效")
            _validate_query(parsed, prefix + leaf)
            return parsed, prefix + leaf
    if _ENCODED_SEPARATOR.search(parsed.path):
        raise ValueError("请求路径无效")
    decoded = parsed.path
    for _ in range(3):
        try:
            decoded = urllib.parse.unquote(decoded, errors="strict")
        except (UnicodeDecodeError, ValueError):
            raise ValueError("请求路径无效") from None
        if (_ENCODED_SEPARATOR.search(decoded) or re.search(r"%2e", decoded, re.IGNORECASE) or
                "\\" in decoded or decoded.startswith("//") or
                any(part in {".", ".."} for part in decoded.split("/")) or
                any(ord(ch) < 32 or ord(ch) == 127 for ch in decoded)):
            raise ValueError("请求路径无效")
        if "%" not in decoded:
            break
    _validate_query(parsed, decoded)
    return parsed, decoded


def _strip_bootstrap_secret(parsed):
    """Keep the one-use bootstrap query local; never send it to ComfyUI."""
    fields = [item for item in parsed.query.split("&")
              if item and urllib.parse.unquote(item.partition("=")[0]) != "session"]
    return parsed.path + ("?" + "&".join(fields) if fields else "")


def _read_only_path(path):
    if path in _ALWAYS_BLOCKED_PATHS:
        return False
    if re.fullmatch(r"/(?:api/)?experiment/models(?:/[A-Za-z0-9_-]+)?", path):
        return True
    if re.fullmatch(r"/(?:api/)?view_metadata/[A-Za-z0-9_-]+", path):
        return True
    if path in _SAFE_STATIC_EXACT or any(path.startswith(prefix) for prefix in _SAFE_STATIC_PREFIXES):
        return True
    if path in {"/", "/object_info", "/system_stats", "/queue", "/prompt", "/history",
                "/view", "/features", "/embeddings", "/free", "/extensions"}:
        return True
    if path.startswith(("/object_info/", "/history/", "/models/", "/settings/", "/userdata/")):
        return True
    if path in {"/models", "/settings", "/userdata"}:
        return True
    if path in {"/api/extensions", "/api/settings", "/api/userdata"}:
        return True
    if path.startswith(("/api/settings/", "/api/userdata/")):
        return True
    if path in {"/api/object_info", "/api/system_stats", "/api/queue", "/api/prompt",
                "/api/history", "/api/view", "/api/models", "/api/features",
                "/api/embeddings", "/api/free", "/api/users", "/api/i18n",
                "/api/node_replacements"}:
        return True
    if path.startswith(("/api/object_info/", "/api/history/", "/api/models/")):
        return True
    return False


class _ProxyHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False

    def __init__(self, address, handler, owner):
        self.owner = owner
        super().__init__(address, handler)


class EditorProxy:
    """Serve an isolated ComfyUI frontend origin with session-only writes."""

    def __init__(self, backend_url, parent_origin, bridge_script: str):
        self.backend_url = local_url(backend_url)
        self._backend = urllib.parse.urlsplit(self.backend_url)
        self.parent_origin = _parent_origin(parent_origin)
        if not isinstance(bridge_script, str) or len(bridge_script.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ValueError("bridge 脚本无效或过大")
        self.bridge_script = bridge_script
        self.bridge_nonce = secrets.token_urlsafe(32)
        self._bootstrap_secret = secrets.token_urlsafe(32)
        self._cookie_name = "prism_editor_" + secrets.token_hex(12)
        self._cookie_value = secrets.token_urlsafe(32)
        self._session_data = {}
        self._session_data_bytes = 0
        self._data_lock = threading.RLock()
        self._lifecycle_lock = threading.RLock()
        self._socket_lock = threading.RLock()
        self._active_sockets = set()
        self._server = None
        self._serve_thread = None
        self._closed = False
        self._origin = None
        self._start_result = None
        self._bootstrap_consumed = False

    @property
    def origin(self):
        return self._origin

    @property
    def bridgeNonce(self):
        """Compatibility spelling for the bridge configuration field."""
        return self.bridge_nonce

    def start(self):
        with self._lifecycle_lock:
            if self._closed:
                raise RuntimeError("EditorProxy 已关闭")
            if self._server is not None:
                return dict(self._start_result)
            server = _ProxyHTTPServer(("127.0.0.1", 0), _ProxyHandler, self)
            port = server.server_address[1]
            self._origin = f"http://127.0.0.1:{port}"
            self._start_result = {
                "url": f"{self._origin}/?session={urllib.parse.quote(self._bootstrap_secret)}",
                "origin": self._origin,
                "bridgeNonce": self.bridge_nonce,
            }
            self._server = server
            thread = threading.Thread(target=server.serve_forever,
                                      name=f"EditorProxy-{port}", daemon=True)
            self._serve_thread = thread
            thread.start()
            return dict(self._start_result)

    def close(self):
        with self._lifecycle_lock:
            if self._closed:
                return
            self._closed = True
            server = self._server
            thread = self._serve_thread
        self._close_sockets()
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2)
        with self._lifecycle_lock:
            self._server = None
            self._serve_thread = None

    def _register_socket(self, sock):
        with self._socket_lock:
            if self._closed:
                try:
                    sock.close()
                except OSError:
                    pass
                return False
            self._active_sockets.add(sock)
            return True

    def _unregister_socket(self, sock):
        with self._socket_lock:
            self._active_sockets.discard(sock)

    def _close_sockets(self):
        with self._socket_lock:
            sockets = list(self._active_sockets)
            self._active_sockets.clear()
        for sock in sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass

    def _expected_host(self):
        if self._server is None:
            return ""
        return f"127.0.0.1:{self._server.server_address[1]}"

    def _has_cookie(self, headers):
        raw_cookie = headers.get("Cookie", "")
        for part in raw_cookie.split(";"):
            name, sep, value = part.strip().partition("=")
            if sep and name == self._cookie_name:
                return hmac.compare_digest(value, self._cookie_value)
        return False

    def _authenticate(self, handler, parsed, decoded_path):
        if handler.headers.get("Host", "").lower() != self._expected_host():
            return False, False
        origin = handler.headers.get("Origin")
        if origin and origin not in {self._origin, self.parent_origin}:
            return False, False
        fetch_site = handler.headers.get("Sec-Fetch-Site", "").lower()
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        session_values = query.get("session")
        bootstrap_attempt = (decoded_path == "/" and handler.command == "GET" and
                             len(session_values or ()) == 1 and
                             hmac.compare_digest((session_values or [""])[0], self._bootstrap_secret))
        if fetch_site == "cross-site" and origin != self.parent_origin and not bootstrap_attempt:
            return False, False
        if session_values is not None:
            if (decoded_path != "/" or handler.command != "GET" or len(session_values) != 1 or
                    not hmac.compare_digest(session_values[0], self._bootstrap_secret)):
                return False, False
            if self._has_cookie(handler.headers):
                return True, True
            with self._lifecycle_lock:
                if self._bootstrap_consumed:
                    return False, False
                self._bootstrap_consumed = True
            return True, True
        return self._has_cookie(handler.headers), False

    def _backend_connection(self):
        host = self._backend.hostname
        port = self._backend.port or 80
        connection = http.client.HTTPConnection(host, port, timeout=HTTP_TIMEOUT)
        connection.connect()
        sock = connection.sock
        if sock is None or not self._register_socket(sock):
            connection.close()
            raise OSError("EditorProxy 已关闭")
        return connection, sock

    def _proxy_http(self, handler, method, target):
        connection = None
        upstream_socket = None
        editor_settings = urllib.parse.urlsplit(target).path in _EDITOR_SETTINGS_PATHS
        try:
            connection, upstream_socket = self._backend_connection()
            connection.putrequest(method, target, skip_host=True, skip_accept_encoding=True)
            connection.putheader("Host", self._backend.netloc)
            connection.putheader("Accept-Encoding", "identity")
            connection.putheader("Connection", "close")
            for name in _REQUEST_HEADERS:
                if editor_settings and name in {"If-None-Match", "If-Modified-Since", "If-Range", "Range"}:
                    continue
                value = handler.headers.get(name)
                if value and "\r" not in value and "\n" not in value:
                    connection.putheader(name, value)
            connection.endheaders()
            response = connection.getresponse()
            if 300 <= response.status < 400:
                response.read(65536)
                self._send_error(handler, 502, "后端重定向已拒绝")
                return
            encoding = response.getheader("Content-Encoding", "identity").lower()
            if encoding not in {"", "identity"}:
                self._send_error(handler, 502, "后端压缩响应已拒绝")
                return
            body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                self._send_error(handler, 502, "后端响应超过 64 MiB 上限")
                return
            content_type = response.getheader("Content-Type", "application/octet-stream")
            if self._needs_css_type(target):
                content_type = "text/css; charset=utf-8"
            if method == "GET" and target.split("?", 1)[0] in {"/", "/index.html"}:
                body, content_type = self._inject_html(body, content_type)
            elif method == "GET" and urllib.parse.urlsplit(target).path in {"/extensions", "/api/extensions"}:
                body, content_type = self._append_extension(body, content_type)
            if method == "GET" and response.status == 200:
                body, content_type = self._merge_session_settings(target, body, content_type)
                body, content_type = self._editor_settings(target, body, content_type)
            headers = response.getheaders()
            if editor_settings:
                headers = [(key, value) for key, value in headers
                           if key.lower() not in {"etag", "last-modified", "cache-control", "expires"}]
                headers.append(("Cache-Control", "no-store"))
            self._send_response(handler, response.status, body, content_type,
                                headers, head=(method == "HEAD"))
        except (OSError, http.client.HTTPException, TimeoutError, ValueError) as exc:
            self._send_error(handler, 502, f"无法读取本机 ComfyUI：{str(exc)[:200]}")
        finally:
            if connection is not None:
                connection.close()
            if upstream_socket is not None:
                self._unregister_socket(upstream_socket)

    def _inject_html(self, body, content_type):
        charset = "utf-8"
        match = re.search(r"charset\s*=\s*[\"']?([^;\"'\s]+)", content_type, re.IGNORECASE)
        if match:
            charset = match.group(1)
        try:
            document = body.decode(charset)
        except (LookupError, UnicodeDecodeError):
            document = body.decode("utf-8", "replace")
            charset = "utf-8"
        config = {"parentOrigin": self.parent_origin, "bridgeNonce": self.bridge_nonce,
                  "backendUrl": self.backend_url, "mediaProtocol": 1}
        injected = _inject_config(document, config).encode("utf-8")
        content_type = re.sub(r";\s*charset\s*=\s*[^;]+", "", content_type, flags=re.IGNORECASE)
        return injected, content_type + "; charset=utf-8"

    def _append_extension(self, body, content_type):
        if "json" not in content_type.lower():
            return body, content_type
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return body, content_type
        values = payload if isinstance(payload, list) else payload.get("extensions") if isinstance(payload, dict) else None
        if not isinstance(values, list):
            return body, content_type
        self._filter_backup_extensions(values)
        if BRIDGE_EXTENSION not in values:
            values.append(BRIDGE_EXTENSION)
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), content_type

    @staticmethod
    def _filter_backup_extensions(values):
        paths = set()
        for item in values:
            if isinstance(item, str):
                parsed = urllib.parse.urlsplit(item)
                if parsed.path.lower().endswith(".js"):
                    paths.add(parsed.path)
        filtered = []
        for item in values:
            if isinstance(item, str):
                parsed = urllib.parse.urlsplit(item)
                path = parsed.path
                rest = path[len("/extensions/"):] if path.startswith("/extensions/") else ""
                component, separator, trailing = rest.partition("/")
                suffix = next((suffix for suffix in (".bak_old", ".backup")
                               if component.endswith(suffix)), None)
                if suffix and path.lower().endswith(".js"):
                    canonical_path = "/extensions/" + component[:-len(suffix)] + separator + trailing
                    if canonical_path in paths:
                        continue
            filtered.append(item)
        values[:] = filtered

    @staticmethod
    def _needs_css_type(target):
        path = urllib.parse.urlsplit(target).path
        return path in {"/user.css", "/materialdesignicons.min.css", "/api/userdata/user.css"}

    def _session_key(self, category, path):
        return category, path

    @staticmethod
    def _editor_settings(target, body, content_type):
        """Skip first-run onboarding only inside this document editor session."""
        path = urllib.parse.urlsplit(target).path
        if path in {"/settings/Comfy.TutorialCompleted", "/api/settings/Comfy.TutorialCompleted"}:
            return b"true", "application/json; charset=utf-8"
        if path not in {"/settings", "/api/settings"} or "json" not in content_type.lower():
            return body, content_type
        try:
            settings = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return body, content_type
        if not isinstance(settings, dict):
            return body, content_type
        settings["Comfy.TutorialCompleted"] = True
        return json.dumps(settings, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), content_type

    def _session_read(self, category, path):
        if category == "settings" and path == "Comfy.TutorialCompleted":
            return b"true", "application/json; charset=utf-8"
        with self._data_lock:
            if category == "settings":
                saved = self._session_data.get(self._session_key(category, ""))
                if path and saved is not None:
                    settings = json.loads(saved[0])
                    if path in settings:
                        return json.dumps(settings[path], ensure_ascii=False).encode("utf-8"), saved[1]
                # Aggregate GET merges the session overlay with upstream defaults.
                return None
            return self._session_data.get(self._session_key(category, path))

    def _merge_session_settings(self, target, body, content_type):
        if urllib.parse.urlsplit(target).path not in {"/settings", "/api/settings"}:
            return body, content_type
        if "json" not in content_type.lower():
            return body, content_type
        try:
            settings = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return body, content_type
        if not isinstance(settings, dict):
            return body, content_type
        with self._data_lock:
            saved = self._session_data.get(self._session_key("settings", ""))
            if saved is not None:
                settings.update(json.loads(saved[0]))
        return json.dumps(settings, ensure_ascii=False).encode("utf-8"), content_type

    def _session_write(self, category, path, body, content_type):
        with self._data_lock:
            key = self._session_key(category, "" if category == "settings" else path)
            old = self._session_data.get(key)
            if category == "settings":
                value = json.loads(body)
                settings = json.loads(old[0]) if old is not None else {}
                settings.update({path: value} if path else value)
                body = json.dumps(settings, ensure_ascii=False).encode("utf-8")
                content_type = "application/json; charset=utf-8"
            old_size = len(old[0]) if old else 0
            if self._session_data_bytes - old_size + len(body) > MAX_SESSION_WRITE_BYTES:
                raise ValueError("本会话临时数据超过 64 MiB 上限")
            self._session_data[key] = (body, content_type)
            self._session_data_bytes += len(body) - old_size

    def _websocket(self, handler, parsed):
        if not self._valid_ws_request(handler, parsed):
            self._send_error(handler, 400, "WebSocket 握手无效")
            return
        if not self._register_socket(handler.connection):
            return
        upstream = None
        upgraded = False
        try:
            upstream = self._connect_websocket(parsed.query)
            if upstream is None:
                self._send_error(handler, 502, "无法建立本机 WebSocket")
                return
            upstream_sock, _backend_response = upstream
            raw_upstream_sock = getattr(upstream_sock, "_sock", upstream_sock)
            client_key = handler.headers.get("Sec-WebSocket-Key", "")
            accept = _websocket_accept(client_key)
            handler.close_connection = True
            handler.send_response(101, "Switching Protocols")
            handler.send_header("Upgrade", "websocket")
            handler.send_header("Connection", "Upgrade")
            handler.send_header("Sec-WebSocket-Accept", accept)
            handler.end_headers()
            handler.wfile.flush()
            upgraded = True
            if isinstance(upstream_sock, _PrefixedSocket):
                prefix = upstream_sock.take_prefix()
                if prefix:
                    handler.connection.sendall(prefix)
                upstream_sock = raw_upstream_sock
            self._tunnel_websocket(handler.connection, upstream_sock)
        except (OSError, http.client.HTTPException, TimeoutError, ValueError):
            if not upgraded and not handler.wfile.closed:
                self._send_error(handler, 502, "本机 WebSocket 连接失败")
        finally:
            if upstream is not None:
                sock = upstream[0]
                raw_sock = getattr(sock, "_sock", sock)
                try:
                    raw_sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                raw_sock.close()
                self._unregister_socket(raw_sock)
            self._unregister_socket(handler.connection)

    def _valid_ws_request(self, handler, parsed):
        if parsed.path != "/ws":
            return False
        if handler.headers.get("Upgrade", "").lower() != "websocket":
            return False
        connection = {value.strip().lower() for value in handler.headers.get("Connection", "").split(",")}
        if "upgrade" not in connection or handler.headers.get("Sec-WebSocket-Version") != "13":
            return False
        key = handler.headers.get("Sec-WebSocket-Key", "")
        if not _WEBSOCKET_KEY.fullmatch(key):
            return False
        try:
            import base64
            if len(base64.b64decode(key, validate=True)) != 16:
                return False
        except (ValueError, TypeError):
            return False
        try:
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
        except ValueError:
            return False
        return set(query) <= {"clientId"} and all(
            len(values) == 1 and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", values[0])
            for values in query.values())

    def _connect_websocket(self, query):
        client_id = urllib.parse.parse_qs(query).get("clientId", [None])[0]
        target = "/ws" + ("?clientId=" + urllib.parse.quote(client_id, safe="") if client_id else "")
        host = self._backend.hostname
        port = self._backend.port or 80
        sock = socket.create_connection((host, port), timeout=WEBSOCKET_CONNECT_TIMEOUT)
        if not self._register_socket(sock):
            return None
        sock.settimeout(WEBSOCKET_CONNECT_TIMEOUT)
        import base64
        key = base64.b64encode(secrets.token_bytes(16)).decode("ascii")
        request = (f"GET {target} HTTP/1.1\r\nHost: {self._backend.netloc}\r\n"
                   "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        try:
            sock.sendall(request.encode("ascii"))
            headers = bytearray()
            while b"\r\n\r\n" not in headers and len(headers) <= 16 * 1024:
                chunk = sock.recv(4096)
                if not chunk:
                    raise OSError("后端 WebSocket 提前关闭")
                headers.extend(chunk)
            marker = headers.find(b"\r\n\r\n")
            if marker < 0 or marker > 16 * 1024:
                raise OSError("后端 WebSocket 响应头无效")
            response = bytes(headers[:marker + 4]).decode("iso-8859-1")
            status_line = response.split("\r\n", 1)[0]
            response_headers = {}
            for line in response.split("\r\n")[1:]:
                name, sep, value = line.partition(":")
                if sep:
                    response_headers[name.strip().lower()] = value.strip()
            if (not status_line.startswith("HTTP/1.1 101 ") or
                    response_headers.get("upgrade", "").lower() != "websocket" or
                    response_headers.get("sec-websocket-accept") != _websocket_accept(key)):
                raise OSError("后端拒绝 WebSocket 升级")
            trailing = bytes(headers[marker + 4:])
            sock.settimeout(None)
            if trailing:
                return _PrefixedSocket(sock, trailing), response_headers
            return sock, response_headers
        except BaseException:
            sock.close()
            self._unregister_socket(sock)
            raise

    def _tunnel_websocket(self, client_sock, backend_sock):
        last_activity = time.monotonic()
        while not self._closed:
            remaining = WEBSOCKET_IDLE_TIMEOUT - (time.monotonic() - last_activity)
            if remaining <= 0:
                return
            readable, _, exceptional = select.select([client_sock, backend_sock], [],
                                                       [client_sock, backend_sock], remaining)
            if exceptional:
                return
            if not readable:
                return
            for source in readable:
                try:
                    data = source.recv(WEBSOCKET_FRAME_BUFFER)
                except OSError:
                    return
                if not data:
                    return
                target = backend_sock if source is client_sock else client_sock
                try:
                    target.sendall(data)
                except OSError:
                    return
                last_activity = time.monotonic()


class _PrefixedSocket:
    """Expose bytes read with the upstream handshake as the tunnel's first data."""

    def __init__(self, sock, prefix):
        self._sock = sock
        self._prefix = bytearray(prefix)

    def recv(self, size):
        if self._prefix:
            value = bytes(self._prefix[:size])
            del self._prefix[:size]
            return value
        return self._sock.recv(size)

    def take_prefix(self):
        value = bytes(self._prefix)
        self._prefix.clear()
        return value

    def sendall(self, data):
        return self._sock.sendall(data)

    def shutdown(self, how):
        return self._sock.shutdown(how)

    def close(self):
        return self._sock.close()

    def fileno(self):
        return self._sock.fileno()


def _websocket_accept(key):
    import hashlib
    import base64
    digest = hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


class _ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PrismEditorProxy"
    sys_version = ""

    @property
    def proxy(self):
        return self.server.owner

    def setup(self):
        super().setup()
        if not self.proxy._register_socket(self.connection):
            self.close_connection = True

    def finish(self):
        try:
            super().finish()
        finally:
            self.proxy._unregister_socket(self.connection)

    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        self._dispatch("OPTIONS")

    def _dispatch(self, method):
        try:
            parsed, decoded_path = _safe_target(self.path)
        except ValueError:
            self.proxy._send_error(self, 400, "请求路径无效")
            return
        allowed, bootstrapped = self.proxy._authenticate(self, parsed, decoded_path)
        if not allowed:
            self.proxy._send_error(self, 403, "EditorProxy 会话或来源校验失败")
            return
        if bootstrapped:
            self._editor_bootstrap_cookie = (f"{self.proxy._cookie_name}={self.proxy._cookie_value}; "
                                             "HttpOnly; SameSite=Strict; Path=/")
        if decoded_path in _ALWAYS_BLOCKED_PATHS or (method not in {"GET", "HEAD"} and
                                                      decoded_path in _TASK_CONTROL_PATHS):
            self.proxy._send_error(self, 403, "ComfyUI 写入与任务控制已禁用")
            return
        if decoded_path in {"/upload/image", "/api/upload/image"}:
            self.proxy._send_error(self, 403, "嵌入编辑器不支持上传到原 ComfyUI")
            return
        if method in {"POST", "PUT", "PATCH", "DELETE"} and not self.headers.get("Origin"):
            self.proxy._send_error(self, 403, "写入请求必须提供受信任 Origin")
            return
        if self.headers.get("Upgrade", "").lower() == "websocket" and decoded_path != "/ws":
            self.proxy._send_error(self, 403, "仅允许 ComfyUI 的 /ws WebSocket")
            return
        if decoded_path == "/ws":
            if method != "GET" or not self.headers.get("Origin"):
                self.proxy._send_error(self, 403, "WebSocket 请求无效")
            elif self.headers.get("Upgrade", "").lower() != "websocket":
                self.proxy._send_error(self, 426, "需要 WebSocket 升级")
            else:
                self.proxy._websocket(self, parsed)
            return
        if method == "GET" and decoded_path == BRIDGE_PATH:
            body = self.proxy.bridge_script.encode("utf-8")
            self.proxy._send_response(self, 200, body, "application/javascript; charset=utf-8", ())
            return
        if decoded_path in MEDIA_MODULES:
            if method != "GET":
                self.proxy._send_error(self, 403, "媒体编辑模块只允许读取")
                return
            path = Path(__file__).resolve().parent.parent / "web" / MEDIA_MODULES[decoded_path]
            try:
                body = path.read_bytes()
                if len(body) > MAX_REQUEST_BYTES:
                    raise ValueError("媒体模块超过大小限制")
            except (OSError, ValueError):
                self.proxy._send_error(self, 503, "媒体编辑模块尚未可用")
                return
            self.proxy._send_response(self, 200, body, "application/javascript; charset=utf-8", ())
            return
        if method == "GET" and decoded_path in {"/userdata", "/userdata/", "/api/userdata", "/api/userdata/"}:
            self.proxy._send_response(self, 200, b"[]", "application/json; charset=utf-8", ())
            return
        if method == "GET" and decoded_path == "/api/global_subgraphs":
            self.proxy._send_response(self, 200, b"[]", "application/json; charset=utf-8", ())
            return
        if method in {"POST", "PUT"} and self._is_session_write(decoded_path):
            self._session_write(decoded_path)
            return
        if method == "GET" and self._is_session_read(decoded_path):
            category, key = self._session_location(decoded_path)
            saved = self.proxy._session_read(category, key)
            if saved is not None:
                body, content_type = saved
                body, content_type = self.proxy._editor_settings(decoded_path, body, content_type)
                if self.proxy._needs_css_type(self.path):
                    content_type = "text/css; charset=utf-8"
                cache_headers = (("Cache-Control", "no-store"),) if decoded_path in _EDITOR_SETTINGS_PATHS else ()
                self.proxy._send_response(self, 200, body, content_type, cache_headers)
                return
        if method == "POST" and decoded_path in _SAFE_READ_ONLY_POST_PATHS:
            content_lengths = self.headers.get_all("Content-Length", [])
            if (parsed.query or self.headers.get_all("Transfer-Encoding") or
                    len(content_lengths) > 1 or
                    (content_lengths and content_lengths[0].strip() != "0")):
                self.proxy._send_error(self, 400, "只读组件读取仅接受无请求体 POST")
                return
            self.proxy._proxy_http(self, method, parsed.path)
            return
        if method not in {"GET", "HEAD"} or not _read_only_path(decoded_path):
            self.proxy._send_error(self, 403, "EditorProxy 仅开放允许的只读 ComfyUI 路由")
            return
        upstream_target = _strip_bootstrap_secret(parsed) if "session" in urllib.parse.parse_qs(parsed.query) else self.path
        self.proxy._proxy_http(self, method, upstream_target)

    def _is_session_write(self, path):
        return (path.startswith("/userdata/") or path.startswith("/settings/") or
                path.startswith("/api/userdata/") or path.startswith("/api/settings/") or
                path in {"/settings", "/api/settings"})

    def _is_session_read(self, path):
        return self._is_session_write(path) or path in {"/settings", "/api/settings"}

    def _session_location(self, path):
        if path.startswith("/api/userdata/"):
            return "userdata", path[len("/api/userdata/"):]
        if path.startswith("/userdata/"):
            return "userdata", path[len("/userdata/"):]
        if path.startswith("/api/settings/"):
            return "settings", path[len("/api/settings/"):]
        if path.startswith("/settings/"):
            return "settings", path[len("/settings/"):]
        return "settings", ""

    def _session_write(self, path):
        category, key = self._session_location(path)
        if category == "userdata" and not key:
            self.proxy._send_error(self, 403, "userdata 写入必须指定会话内文件名")
            return
        try:
            body = self._read_body()
            content_type = self.headers.get("Content-Type", "application/octet-stream")
            if category == "settings":
                try:
                    value = json.loads(body)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self.proxy._send_error(self, 400, "设置必须是有效 JSON")
                    return
                if not key and not isinstance(value, dict):
                    self.proxy._send_error(self, 400, "完整设置必须是 JSON 对象")
                    return
            if self.proxy._needs_css_type(self.path):
                content_type = "text/css; charset=utf-8"
            self.proxy._session_write(category, key, body, content_type)
        except ValueError as exc:
            self.proxy._send_error(self, 413, str(exc))
            return
        self.proxy._send_response(self, 200, b"{}", "application/json; charset=utf-8", ())

    def _read_body(self):
        transfer_encoding = self.headers.get("Transfer-Encoding")
        if transfer_encoding:
            raise ValueError("不接受分块请求体")
        value = self.headers.get("Content-Length")
        if value is None:
            return b""
        try:
            length = int(value)
        except ValueError:
            raise ValueError("请求体长度无效") from None
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ValueError("请求体超过 16 MiB 上限")
        body = self.rfile.read(length)
        if len(body) != length:
            raise ValueError("请求体不完整")
        return body


def _send_response(handler, status, body, content_type, upstream_headers=(), *, head=False):
    if handler.wfile.closed:
        return
    try:
        handler.send_response(status)
        if content_type:
            handler.send_header("Content-Type", content_type)
        bootstrap_cookie = getattr(handler, "_editor_bootstrap_cookie", None)
        for name, value in upstream_headers:
            if name.lower() in _HOP_BY_HOP or name.lower() in {"content-type", "content-encoding"}:
                continue
            if bootstrap_cookie and name.lower() in {"cache-control", "referrer-policy"}:
                continue
            if "\r" not in value and "\n" not in value:
                handler.send_header(name, value)
        if bootstrap_cookie:
            handler.send_header("Set-Cookie", bootstrap_cookie)
            handler.send_header("Cache-Control", "no-store")
            handler.send_header("Referrer-Policy", "no-referrer")
            del handler._editor_bootstrap_cookie
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.end_headers()
        if not head and body:
            handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError, OSError):
        handler.close_connection = True


def _send_error(handler, status, message):
    body = json.dumps({"error": message}, ensure_ascii=False).encode("utf-8")
    handler.close_connection = True
    _send_response(handler, status, body, "application/json; charset=utf-8", ())


# Keep response helpers on the class for the handler and convenient focused tests.
EditorProxy._send_response = staticmethod(_send_response)
EditorProxy._send_error = staticmethod(_send_error)
