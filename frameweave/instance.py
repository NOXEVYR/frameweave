"""Per-data-directory process locking and safe local service discovery."""

from __future__ import annotations

import http.client
import json
import os
import re
import time
import urllib.parse
from pathlib import Path

from . import __version__

_LEGACY_PRISMCANVAS_VERSIONS = {"0.8.0"}
APP_WINDOW_TITLE = "棱光 PrismCanvas · 影像创作工作台"
LEGACY_APP_WINDOW_TITLE = APP_WINDOW_TITLE
APP_WINDOW_TITLE_PREFIX = "棱光 PrismCanvas · 工作区 "


def resolve_default_data(base_default: Path) -> tuple[Path, int]:
    """Resolve the user's canonical local workspace pointer, if valid."""
    base_default = Path(base_default).resolve()
    pointer = base_default / "workspace-location.json"
    try:
        if pointer.stat().st_size > 16 * 1024:
            return base_default, 8765
        value = json.loads(pointer.read_text(encoding="utf-8"))
        path_text = value.get("data_dir") if isinstance(value, dict) else None
        port = value.get("port") if isinstance(value, dict) else None
        if not isinstance(path_text, str) or not path_text or type(port) is not int or not (1 <= port <= 65535):
            return base_default, 8765
        if path_text.startswith(("\\\\", "//")):
            return base_default, 8765
        candidate = Path(path_text)
        if not candidate.is_absolute() or not candidate.is_dir():
            return base_default, 8765
        candidate = candidate.resolve(strict=True)
        resolved_text = str(candidate)
        if resolved_text.startswith(("\\\\", "//")):
            return base_default, 8765
        return candidate, port
    except (OSError, ValueError, TypeError, RecursionError):
        return base_default, 8765


class _FileLock:
    """Small cross-platform advisory lock; the OS releases it after a crash."""

    def __init__(self, path: Path):
        self.lock_path = Path(path)
        self._file = None
        self._locked = False

    def acquire(self, timeout: float = 0) -> bool:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.lock_path.open("a+b")
        deadline = time.monotonic() + max(0, timeout)
        while True:
            try:
                if os.name == "nt":
                    import msvcrt

                    handle.seek(0, os.SEEK_END)
                    if handle.tell() == 0:
                        handle.write(b"\0")
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._file = handle
                self._locked = True
                return True
            except OSError:
                if time.monotonic() >= deadline:
                    handle.close()
                    return False
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            except BaseException:
                handle.close()
                raise

    def release(self) -> None:
        if not self._locked:
            return
        handle, self._file = self._file, None
        self._locked = False
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()


class InstanceLock(_FileLock):
    """An OS-released lock shared by all PrismCanvas processes for one data dir."""

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir).resolve()
        super().__init__(self.data_dir / "instance.lock")
        self.metadata_path = self.data_dir / "instance.json"

    def acquire(self) -> bool:
        if not super().acquire():
            return False
        try:
            self.write_metadata(url=None)
            return True
        except BaseException:
            self.release()
            raise

    def write_metadata(self, *, url: str | None) -> None:
        if not self._locked:
            raise RuntimeError("instance lock is not held")
        temp = self.metadata_path.with_name(self.metadata_path.name + ".tmp")
        temp.write_text(json.dumps({"pid": os.getpid(), "url": url}, separators=(",", ":")), encoding="utf-8")
        os.replace(temp, self.metadata_path)

    def __enter__(self):
        if not self.acquire():
            raise RuntimeError("another PrismCanvas instance holds this data directory")
        return self

    def __exit__(self, *_exc):
        self.release()


def read_instance_url(data_dir: Path) -> str | None:
    """Read only the URL advertised by the lock owner's metadata."""
    try:
        value = json.loads((Path(data_dir) / "instance.json").read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    url = value.get("url") if isinstance(value, dict) else None
    return url if isinstance(url, str) else None


def read_legacy_url(data_dir: Path) -> str | None:
    """Read the previous release's URL hint; callers must validate it before use."""
    try:
        value = (Path(data_dir) / "last-url.txt").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return value if value else None


def validate_prismcanvas_url(url: str, timeout: float = 1.0, *, allow_legacy: bool = False, allow_previous_owner: bool = False) -> bool:
    """Probe one fixed, read-only endpoint on a numeric IPv4 loopback address.

    Never follow redirects or honor proxy settings. The URL is parsed and
    restricted before any socket is opened, and only the app's bootstrap
    identity is accepted for reuse.
    """
    try:
        parts = urllib.parse.urlsplit(url)
        if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or
                parts.username is not None or parts.password is not None or
                parts.query or parts.fragment or parts.path not in ("", "/") or
                not parts.port or not (1 <= parts.port <= 65535)):
            return False
        port = parts.port
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        try:
            connection.request("GET", "/api/bootstrap", headers={
                "Host": f"127.0.0.1:{port}",
                "Accept": "application/json",
                "Connection": "close",
            })
            response = connection.getresponse()
            if response.status != 200 or not response.getheader("Content-Type", "").lower().startswith("application/json"):
                return False
            if (response.getheader("X-Frame-Options", "").upper() != "DENY" or
                    response.getheader("X-Content-Type-Options", "").lower() != "nosniff" or
                    "frame-ancestors 'none'" not in response.getheader("Content-Security-Policy", "")):
                return False
            raw = response.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                return False
        finally:
            connection.close()
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            return False
        version = payload.get("version")
        # The existing workspace lock can belong to the preceding desktop build
        # while its pending jobs finish. Keep the same workspace and browser origin.
        known_version = version == __version__ or (allow_previous_owner and version in ("0.11.5", "0.11.6", "0.11.7", "0.11.8"))
        current_identity = payload.get("application") == "PrismCanvas" and known_version
        legacy_identity = (allow_legacy and "application" not in payload and
                           version in _LEGACY_PRISMCANVAS_VERSIONS)
        if not (current_identity or legacy_identity):
            return False
        csrf = payload.get("csrf")
        settings = payload.get("settings")
        presets = payload.get("presets")
        return (isinstance(csrf, str) and bool(re.fullmatch(r"[A-Za-z0-9_-]{40,64}", csrf)) and
                isinstance(settings, dict) and
                all(key in settings for key in ("backend_url", "model_roots", "comfy_roots")) and
                isinstance(settings["backend_url"], str) and
                isinstance(settings["model_roots"], list) and
                isinstance(settings["comfy_roots"], list) and
                isinstance(presets, list))
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        return False


def _app_window_title_for_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or
            parts.username is not None or parts.password is not None or
            parts.path not in ("", "/") or parts.query or parts.fragment or
            not parts.port or not (1 <= parts.port <= 65535)):
        raise ValueError("expected a numeric loopback root URL with an explicit port")
    return APP_WINDOW_TITLE_PREFIX + str(parts.port)


def activate_existing_app_window(url: str, timeout: float = 3.0, *, window_title: str | None = None) -> bool:
    """Recall only the native client belonging to this workspace origin."""
    from .native_window import recall

    try:
        _app_window_title_for_url(url)
        return recall(url)
    except (OSError, ValueError):
        return False


def open_app_window(url: str, data_dir: Path | None = None) -> bool:
    try:
        _app_window_title_for_url(url)
        if os.name == "nt":
            from .native_window import launch
            data_dir = data_dir or Path(os.environ["LOCALAPPDATA"]) / "FrameWeave"
            return launch(url, data_dir)
        import webbrowser
        return bool(webbrowser.open(url))
    except (OSError, ValueError, KeyError):
        return False


def focus_or_open_app_window(url: str, data_dir: Path, *, window_title: str | None = None) -> bool:
    """Serialize window creation without touching the backend instance lock."""
    gate = _FileLock(Path(data_dir).resolve() / "window-open.lock")
    if not gate.acquire(timeout=12):
        return False
    try:
        return activate_existing_app_window(url) or open_app_window(url, data_dir)
    finally:
        gate.release()
