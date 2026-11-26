"""Run the desktop client independently of the backend launcher's lifetime."""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes
from pathlib import Path


def session_key(origin: str) -> str:
    return hashlib.sha256(origin.rstrip("/").encode("ascii")).hexdigest()


def _allow_foreground(key: str) -> None:
    """Pass the launcher's foreground activation grant to the existing workspace window."""
    user = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetPropW.argtypes = [wintypes.HWND, wintypes.LPCWSTR]
    user.GetPropW.restype = wintypes.HANDLE
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.AllowSetForegroundWindow.argtypes = [wintypes.DWORD]
    marker = "PrismCanvas.Native." + key

    @callback_type
    def match(hwnd, _context):
        if user.GetPropW(hwnd, marker) != 1:
            return True
        pid = wintypes.DWORD()
        if user.GetWindowThreadProcessId(hwnd, ctypes.byref(pid)):
            user.AllowSetForegroundWindow(pid.value)
        return False

    user.EnumWindows(match, 0)


def recall(origin: str) -> bool:
    if os.name != "nt":
        return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenEventW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
    kernel.OpenEventW.restype = wintypes.HANDLE
    kernel.SetEvent.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    key = session_key(origin)
    obj = kernel.OpenEventW(2, False, "Local\\PrismCanvas.Desktop." + key + ".Recall")
    if not obj:
        return False
    try:
        _allow_foreground(key)
        return bool(kernel.SetEvent(obj))
    finally:
        kernel.CloseHandle(obj)


def _client_image(source: Path, cache: Path) -> Path:
    """Do not run a long-lived window out of the one-file launcher's _MEIPASS."""
    manifest = (source / "client-files.json").read_bytes()
    files = json.loads(manifest)
    if not isinstance(files, dict) or "PrismDesktop.exe" not in files or any(
        Path(name).name != name or name in (".", "..") for name in files
    ):
        raise ValueError("invalid desktop client manifest")
    target = cache / hashlib.sha256(manifest).hexdigest()
    def valid(directory: Path) -> bool:
        return all((directory / name).is_file() and hashlib.sha256(
            (directory / name).read_bytes()).hexdigest() == checksum for name,checksum in files.items())
    if valid(target):
        return target / "PrismDesktop.exe"
    cache.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="install-", dir=cache) as transfer:
        stage = Path(transfer) / "image"
        stage.mkdir()
        for name in files:
            shutil.copyfile(source/name, stage/name)
        if not valid(stage):
            raise OSError("desktop client failed verification")
        try:
            stage.rename(target)
        except OSError:
            if not valid(target):
                # Another release may still have the old image mapped. Repair
                # by using a separately committed image without touching it.
                repaired = cache / (target.name + "-" + Path(transfer).name)
                stage.rename(repaired)
                target = repaired
    return target / "PrismDesktop.exe"


def launch(origin: str, data_dir: Path) -> bool:
    app_data = Path(os.environ["LOCALAPPDATA"]) / "PrismCanvas"
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    executable = _client_image(base/"native_host", app_data/"DesktopHost")
    workspace = os.path.normcase(str(data_dir.resolve())).encode("utf8")
    profile = app_data/"DesktopProfiles"/hashlib.sha256(workspace).hexdigest()
    child = subprocess.Popen([str(executable), origin, str(profile), session_key(origin)],
                             cwd=executable.parent, creationflags=subprocess.CREATE_NO_WINDOW)
    until = time.monotonic()+8
    while time.monotonic()<until:
        if recall(origin):
            return True
        if child.poll() is not None:
            return False
        time.sleep(.1)
    return False
