"""Owner-process Windows notification icon using only the standard library.

No browser window is hidden, subclassed or terminated. Native behaviour still
requires Windows shell/DPI acceptance; an injected driver is for CPU tests only.
"""

import ctypes
from ctypes import wintypes
import logging
import os
from pathlib import Path
import queue
import threading
import uuid


TRAY_TITLE = "棱光 PrismCanvas"


class WindowsTray:
    def __init__(self, *, icon_path, on_action, state, on_failure, driver=None):
        self.icon_path = Path(icon_path)
        self.on_action, self.state, self.on_failure = on_action, state, on_failure
        self._driver = driver
        self._thread = None
        self._ready = threading.Event()
        self._started = False
        self._actions = queue.Queue(maxsize=8)
        self._queued = set()
        self._lock = threading.Lock()
        self._stopping = threading.Event()
        self._worker = None

    def _failed(self):
        try:
            self.on_failure()
        except Exception:
            logging.warning("托盘失败反馈暂不可用；未隐藏窗口或授权退出。")

    def _dispatch(self, action):
        with self._lock:
            if self._stopping.is_set() or action in self._queued:
                return
            self._queued.add(action)
            try:
                self._actions.put_nowait(action)
            except queue.Full:
                self._queued.discard(action)

    def _work(self):
        while not self._stopping.is_set():
            try:
                action = self._actions.get(timeout=0.25)
            except queue.Empty:
                continue
            try:
                if not self._stopping.is_set():
                    self.on_action(action)
            except Exception:
                self._failed()
            finally:
                with self._lock:
                    self._queued.discard(action)

    def start(self, timeout=5):
        if self._thread is not None:
            return self._started
        if self._driver is None:
            if os.name != "nt":
                return False
            self._driver = _Win32Driver(self.icon_path, self.state)

        def ready():
            self._started = True
            self._ready.set()

        def run():
            failed = False
            try:
                self._driver.run(self._dispatch, ready)
            except Exception:
                failed = True
            finally:
                self._started = False
                self._ready.set()
                if failed or not self._stopping.is_set():
                    self._failed()

        try:
            self._worker = threading.Thread(target=self._work, daemon=True, name="PrismCanvas-tray-actions")
            self._thread = threading.Thread(target=run, daemon=True, name="PrismCanvas-tray")
            self._worker.start()
            self._thread.start()
        except Exception:
            try:
                self.stop()
            except Exception:
                pass
            self._failed()
            return False
        if not self._ready.wait(timeout) or not self._started:
            try:
                self.stop()
            except Exception:
                self._failed()
            return False
        return True

    def notify(self, message):
        if self._driver is not None and self._started:
            self._driver.notify(str(message)[:240])

    def stop(self):
        self._stopping.set()
        try:
            if self._driver is not None:
                self._driver.stop()
        finally:
            for thread, timeout in ((self._thread, 2), (self._worker, 0.5)):
                if thread is not None and thread is not threading.current_thread() and thread.ident is not None:
                    thread.join(timeout)
            self._started = False


class _Win32Driver:
    CALLBACK = 0x8001
    NOTICE = 0x8002

    def __init__(self, icon_path, state):
        self.icon_path, self.state = icon_path, state
        self.hwnd = None
        self._user = None
        self._notices = queue.Queue(maxsize=8)
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()
        if self.hwnd and self._user:
            self._user.PostMessageW(self.hwnd, 0x0010, 0, 0)  # WM_CLOSE

    def notify(self, message):
        try:
            self._notices.put_nowait(message)
        except queue.Full:
            return
        if self.hwnd and self._user:
            self._user.PostMessageW(self.hwnd, self.NOTICE, 0, 0)

    def run(self, dispatch, ready):
        if self._stop.is_set():
            return
        user = self._user = ctypes.WinDLL("user32", use_last_error=True)
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        pointer = ctypes.c_ssize_t
        wndproc_type = ctypes.WINFUNCTYPE(pointer, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                        ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

        class NotifyData(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("hWnd", wintypes.HWND),
                        ("uID", wintypes.UINT), ("uFlags", wintypes.UINT),
                        ("uCallbackMessage", wintypes.UINT), ("hIcon", wintypes.HANDLE),
                        ("szTip", wintypes.WCHAR * 128), ("dwState", wintypes.DWORD),
                        ("dwStateMask", wintypes.DWORD), ("szInfo", wintypes.WCHAR * 256),
                        ("uTimeoutOrVersion", wintypes.UINT), ("szInfoTitle", wintypes.WCHAR * 64),
                        ("dwInfoFlags", wintypes.DWORD), ("guidItem", GUID),
                        ("hBalloonIcon", wintypes.HANDLE)]

        class WindowClass(ctypes.Structure):
            _fields_ = [("style", wintypes.UINT), ("lpfnWndProc", wndproc_type),
                        ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                        ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HANDLE),
                        ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HANDLE),
                        ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)]

        # Explicit signatures preserve pointer-width HWND/HMENU/LRESULT on x64.
        kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
        kernel.GetModuleHandleW.restype = wintypes.HMODULE
        user.RegisterClassW.argtypes = [ctypes.POINTER(WindowClass)]
        user.RegisterClassW.restype = wintypes.ATOM
        user.UnregisterClassW.argtypes = [wintypes.LPCWSTR, wintypes.HINSTANCE]
        user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
                                        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, ctypes.c_void_p]
        user.CreateWindowExW.restype = wintypes.HWND
        user.DefWindowProcW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user.DefWindowProcW.restype = pointer
        user.LoadImageW.argtypes = [wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                                   ctypes.c_int, ctypes.c_int, wintypes.UINT]
        user.LoadImageW.restype = wintypes.HANDLE
        user.DestroyIcon.argtypes = [wintypes.HANDLE]
        user.DestroyWindow.argtypes = [wintypes.HWND]
        user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user.GetMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT]
        user.GetMessageW.restype = wintypes.BOOL
        user.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        user.DispatchMessageW.restype = pointer
        user.CreatePopupMenu.restype = wintypes.HMENU
        user.AppendMenuW.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_size_t, wintypes.LPCWSTR]
        user.DestroyMenu.argtypes = [wintypes.HMENU]
        user.TrackPopupMenu.argtypes = [wintypes.HMENU, wintypes.UINT, ctypes.c_int, ctypes.c_int,
                                       ctypes.c_int, wintypes.HWND, ctypes.c_void_p]
        user.TrackPopupMenu.restype = wintypes.UINT
        user.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
        user.SetForegroundWindow.argtypes = [wintypes.HWND]
        user.RegisterWindowMessageW.argtypes = [wintypes.LPCWSTR]
        user.RegisterWindowMessageW.restype = wintypes.UINT
        user.SetTimer.argtypes = [wintypes.HWND, ctypes.c_size_t, wintypes.UINT, ctypes.c_void_p]
        user.SetTimer.restype = ctypes.c_size_t
        user.KillTimer.argtypes = [wintypes.HWND, ctypes.c_size_t]
        shell.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(NotifyData)]
        shell.Shell_NotifyIconW.restype = wintypes.BOOL
        instance = kernel.GetModuleHandleW(None)
        class_name = "PrismCanvas.Tray." + uuid.uuid4().hex
        data = NotifyData()
        icon = None
        registered = False
        taskbar_created = user.RegisterWindowMessageW("TaskbarCreated")

        def add_icon():
            data.uFlags = 1 | 2 | 4  # message, icon, tooltip
            data.szTip = TRAY_TITLE
            return bool(shell.Shell_NotifyIconW(0, ctypes.byref(data)))

        def menu(hwnd):
            popup = user.CreatePopupMenu()
            if not popup:
                return
            try:
                snapshot = self.state()
                user.AppendMenuW(popup, 0, 1, "打开主界面")
                user.AppendMenuW(popup, 0 if snapshot.get("settings_available") else 1, 2, "设置")
                user.AppendMenuW(popup, 0x800, 0, None)
                user.AppendMenuW(popup, 1 if snapshot.get("command_pending") else 0, 3, "退出棱光")
                point = wintypes.POINT()
                user.GetCursorPos(ctypes.byref(point))
                user.SetForegroundWindow(hwnd)
                selected = user.TrackPopupMenu(popup, 0x100 | 2, point.x, point.y, 0, hwnd, None)
                if selected in (1, 2, 3):
                    dispatch({1: "open", 2: "settings", 3: "exit"}[selected])
                user.PostMessageW(hwnd, 0, 0, 0)
            finally:
                user.DestroyMenu(popup)

        def handle(hwnd, message, wparam, lparam):
            if message == self.CALLBACK:
                if lparam in (0x0202, 0x0203):
                    dispatch("open")
                elif lparam in (0x0205, 0x007B):
                    menu(hwnd)
                return 0
            if taskbar_created and message == taskbar_created:
                if not add_icon():
                    user.PostMessageW(hwnd, 0x0010, 0, 0)
                return 0
            if message == self.NOTICE:
                while True:
                    try:
                        text = self._notices.get_nowait()
                    except queue.Empty:
                        break
                    data.uFlags = 0x10
                    data.szInfo = text
                    data.szInfoTitle = TRAY_TITLE
                    data.dwInfoFlags = 2
                    shell.Shell_NotifyIconW(1, ctypes.byref(data))
                return 0
            if message == 0x0113:  # WM_TIMER, cheap in-memory command expiry
                dispatch("tick")
                return 0
            if message == 0x0010:
                user.DestroyWindow(hwnd)
                return 0
            if message == 0x0002:
                user.PostQuitMessage(0)
                return 0
            return user.DefWindowProcW(hwnd, message, wparam, lparam)

        def safe_handle(*args):
            try:
                return handle(*args)
            except Exception:
                user.PostMessageW(args[0], 0x0010, 0, 0)
                return 0

        self._wndproc = wndproc_type(safe_handle)  # Keep callback alive until HWND destroyed.
        window_class = WindowClass(lpfnWndProc=self._wndproc, hInstance=instance, lpszClassName=class_name)
        try:
            if not user.RegisterClassW(ctypes.byref(window_class)):
                raise OSError("tray class registration failed")
            registered = True
            self.hwnd = user.CreateWindowExW(0, class_name, TRAY_TITLE, 0, 0, 0, 0, 0, None, None, instance, None)
            if not self.hwnd:
                raise OSError("tray owner creation failed")
            icon = user.LoadImageW(None, str(self.icon_path), 1, 32, 32, 0x10)
            if not icon:
                raise OSError("tray product icon loading failed")
            data.cbSize, data.hWnd, data.uID = ctypes.sizeof(data), self.hwnd, 1
            data.uCallbackMessage, data.hIcon = self.CALLBACK, icon
            if not add_icon():
                raise OSError("tray icon registration failed")
            if self._stop.is_set():
                return
            user.SetTimer(self.hwnd, 1, 5000, None)
            ready()
            message = wintypes.MSG()
            while True:
                result = user.GetMessageW(ctypes.byref(message), None, 0, 0)
                if result <= 0:
                    if result < 0:
                        raise OSError("tray message loop failed")
                    break
                user.TranslateMessage(ctypes.byref(message))
                user.DispatchMessageW(ctypes.byref(message))
        finally:
            if self.hwnd:
                user.KillTimer(self.hwnd, 1)
                shell.Shell_NotifyIconW(2, ctypes.byref(data))
                user.DestroyWindow(self.hwnd)
                self.hwnd = None
            if icon:
                user.DestroyIcon(icon)
            if registered:
                user.UnregisterClassW(class_name, instance)
