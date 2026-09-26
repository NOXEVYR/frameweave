"""Per-data-directory process locking and safe local service discovery."""

from __future__ import annotations

import ctypes
import http.client
import json
import os
import re
import subprocess
import time
import urllib.parse
from pathlib import Path
from ctypes import wintypes

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


def validate_prismcanvas_url(url: str, timeout: float = 1.0, *, allow_legacy: bool = False) -> bool:
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
        current_identity = payload.get("application") == "PrismCanvas" and version == __version__
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


def open_app_window(url: str) -> None:
    """Open the known local app URL using the same lightweight window mode."""
    edge_paths = [
        Path(os.environ.get("PROGRAMFILES(X86)", "C:/Program Files (x86)")) / "Microsoft/Edge/Application/msedge.exe",
        Path(os.environ.get("PROGRAMFILES", "C:/Program Files")) / "Microsoft/Edge/Application/msedge.exe",
    ]
    edge = next((path for path in edge_paths if path.is_file()), None)
    if edge:
        subprocess.Popen([str(edge), "--app=" + url, "--window-size=1500,960", "--no-first-run"],
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        import webbrowser

        webbrowser.open(url)


def _app_window_title_for_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if (parts.scheme != "http" or parts.hostname != "127.0.0.1" or
            parts.username is not None or parts.password is not None or
            parts.path not in ("", "/") or parts.query or parts.fragment or
            not parts.port or not (1 <= parts.port <= 65535)):
        raise ValueError("expected a numeric loopback root URL with an explicit port")
    return APP_WINDOW_TITLE_PREFIX + str(parts.port)


def _edge_app_windows(window_title: str) -> list[int]:
    """Find visible Edge app-mode windows by the product's exact window title."""
    if os.name != "nt":
        return []

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                    wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    get_long = getattr(user32, "GetWindowLongPtrW", user32.GetWindowLongW)
    get_long.argtypes = [wintypes.HWND, ctypes.c_int]
    get_long.restype = ctypes.c_ssize_t

    windows = []
    def inspect(hwnd, _param):
        length = user32.GetWindowTextLengthW(hwnd)
        if not length or not user32.IsWindowVisible(hwnd):
            return True
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        if title.value != window_title:
            return True
        class_name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, class_name, len(class_name))
        if class_name.value != "Chrome_WidgetWin_1":
            return True
        style = get_long(hwnd, -16)
        exstyle = get_long(hwnd, -20)
        if not (style & 0x10000000) or exstyle & 0x00000080:  # visible, not a tool window
            return True
        process_id = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
        process = kernel32.OpenProcess(0x1000, False, process_id.value)  # QUERY_LIMITED_INFORMATION
        if not process:
            return True
        try:
            image = ctypes.create_unicode_buffer(32768)
            image_size = wintypes.DWORD(len(image))
            if kernel32.QueryFullProcessImageNameW(process, 0, image, ctypes.byref(image_size)):
                if Path(image.value).name.lower() == "msedge.exe":
                    windows.append(int(hwnd))
        finally:
            kernel32.CloseHandle(process)
        return True

    callback = callback_type(inspect)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows(callback, 0)
    return windows


def activate_existing_app_window(url: str, timeout: float = 3.0, *, window_title: str | None = None) -> bool:
    """Find the existing Edge app window and request foreground activation.

    A matching HWND counts as an existing window even when Windows declines to
    transfer foreground ownership. Callers must never open a duplicate just
    because a background process could not steal focus.
    """
    if os.name != "nt" or not re.fullmatch(r"http://127\.0\.0\.1:\d{1,5}/", url):
        return False
    if window_title is None:
        try:
            window_title = _app_window_title_for_url(url)
        except ValueError:
            return False
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.SetForegroundWindow.argtypes = [wintypes.HWND]
        user32.BringWindowToTop.argtypes = [wintypes.HWND]
        user32.SetActiveWindow.argtypes = [wintypes.HWND]
        user32.SetFocus.argtypes = [wintypes.HWND]
        user32.GetForegroundWindow.restype = wintypes.HWND
        user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
        kernel32.GetCurrentThreadId.restype = wintypes.DWORD
        windows = _edge_app_windows(window_title)
        for hwnd in windows:
            foreground = user32.GetForegroundWindow()
            foreground_pid = wintypes.DWORD()
            target_pid = wintypes.DWORD()
            foreground_thread = user32.GetWindowThreadProcessId(foreground, ctypes.byref(foreground_pid)) if foreground else 0
            target_thread = user32.GetWindowThreadProcessId(hwnd, ctypes.byref(target_pid))
            current_thread = kernel32.GetCurrentThreadId()
            attached = []
            try:
                for thread_id in dict.fromkeys((foreground_thread, target_thread)):
                    if thread_id and thread_id != current_thread and user32.AttachThreadInput(current_thread, thread_id, True):
                        attached.append(thread_id)
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                user32.BringWindowToTop(hwnd)
                user32.SetForegroundWindow(hwnd)
                if user32.GetForegroundWindow() != hwnd:
                    user32.SetActiveWindow(hwnd)
                    user32.SetFocus(hwnd)
                    user32.SetForegroundWindow(hwnd)
            finally:
                for thread_id in reversed(attached):
                    user32.AttachThreadInput(current_thread, thread_id, False)
            return True
        return False
    except (AttributeError, OSError, ValueError):
        return False


def focus_or_open_app_window(url: str, data_dir: Path, *, window_title: str | None = None) -> bool:
    """Serialize second-launch window handling and reopen if the app was closed."""
    gate = _FileLock(Path(data_dir).resolve() / "window-open.lock")
    if not gate.acquire(timeout=8):
        return False
    try:
        if activate_existing_app_window(url, window_title=window_title):
            return True
        open_app_window(url)
        # Chromium may hand the request to an existing browser process and
        # return before the app-mode window appears. Keep the gate until it can
        # be found, so two rapid launches do not each create a window.
        deadline = time.monotonic() + 4
        while os.name == "nt" and time.monotonic() < deadline:
            time.sleep(0.25)
            if activate_existing_app_window(url, timeout=1.0, window_title=window_title):
                return True
        return True
    finally:
        gate.release()
