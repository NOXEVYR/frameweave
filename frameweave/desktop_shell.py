"""Bounded desktop UI handshake; no browser HWND hiding or task submission."""

import re
import secrets
import threading
import time


CLOSE_ACTIONS = ("background", "idle_exit")
IDLE_GRACE_SECONDS = 180
COMMAND_TIMEOUT_SECONDS = 60
SESSION_LIVE_SECONDS = 120
MAX_CLIENT_SESSIONS = 32
_SESSION = re.compile(r"[A-Za-z0-9_-]{32,64}\Z")
_REASONS = {
    "busy": "仍有任务、调度或待确认提交，请打开界面处理后再退出。",
    "draft-save-failed": "浏览器草稿保存失败，未退出；请先导出或保存画布。",
    "unsupported": "页面尚未提供此桌面操作入口，未退出。",
    "client-error": "页面未能安全完成此操作，未退出。",
    "cancelled": "已取消退出，棱光仍在后台运行。",
    "handled": "",
}


class DesktopExitUncertain(RuntimeError):
    """An update handoff may have started; editing/exit must not be retried."""


class DesktopShell:
    def __init__(self, close_action=lambda: "background", *, supported=False, clock=time.monotonic):
        self._close_action = close_action
        self.supported = bool(supported)
        self.clock = clock
        self._lock = threading.RLock()
        self._sessions = {}
        self._command = None
        self._tray_ready = False
        self._closed = False
        self._notice_sent = False
        self._last_error = ""
        self._open_ui = lambda: False
        self._notify = lambda message: None
        self._shutdown = lambda: None

    def configure(self, *, tray_ready, open_ui=None, notify=None, shutdown=None):
        with self._lock:
            self._tray_ready = bool(tray_ready) and self.supported and not self._closed
            if open_ui is not None:
                self._open_ui = open_ui
            if notify is not None:
                self._notify = notify
            if shutdown is not None:
                self._shutdown = shutdown

    def _live(self):
        now = self.clock()
        return {key for key, value in self._sessions.items()
                if now - value["seen"] <= SESSION_LIVE_SECONDS}

    def status(self):
        with self._lock:
            action = self._close_action()
            if action not in CLOSE_ACTIONS:
                action = "background"
            background = self.supported and self._tray_ready and action == "background"
            live = self._live()
            return {"version": 1, "supported": self.supported,
                    "tray_ready": self._tray_ready, "close_action": action,
                    "effective_close_action": "background" if background else "idle_exit",
                    "idle_grace_seconds": IDLE_GRACE_SECONDS, "heartbeat_seconds": 30,
                    "command_timeout_seconds": COMMAND_TIMEOUT_SECONDS,
                    "settings_available": any(self._sessions[key]["settings"] for key in live),
                    "command_pending": self._command is not None,
                    "last_error": self._last_error}

    def keeps_background(self):
        return self.status()["effective_close_action"] == "background"

    def _report(self, message):
        with self._lock:
            self._last_error = message
        try:
            self._notify(message)
        except Exception:
            pass  # A failed notification must not grant exit or break serving.

    def tray_failed(self):
        with self._lock:
            self._tray_ready = False
        self._report("托盘暂不可用；窗口未隐藏。可再次启动棱光重新打开界面。")

    def tick(self):
        expired = False
        with self._lock:
            if self._command and self.clock() >= self._command["deadline"]:
                self._command = None
                expired = True
        if expired:
            self._report("页面未及时确认桌面操作，未退出；请打开界面后重试。")

    def _open(self):
        try:
            if self._open_ui() is True:
                return True
        except Exception:
            pass
        self._report("未能重新打开主界面；后台和原任务已保留，请再次启动棱光。")
        return False

    def action(self, action):
        if action not in {"open", "settings", "exit"}:
            raise ValueError("桌面操作无效")
        self.tick()
        with self._lock:
            if self._closed:
                return False
        if action == "open":
            return self._open()
        with self._lock:
            if self._command:
                message = "已有桌面操作等待页面确认，请先完成或等待超时。"
            elif not self.supported or not self._tray_ready:
                message = "托盘尚未就绪，未退出；请在主界面操作。"
            elif action == "settings" and not self.status()["settings_available"]:
                message = "设置入口尚未就绪，请先打开主界面。"
            else:
                self._command = {"id": secrets.token_hex(16), "action": action,
                                 "deadline": self.clock() + COMMAND_TIMEOUT_SECONDS,
                                 "required": self._live() if action == "exit" else set(),
                                 "delivered": set(), "approved": set()}
                self._last_error = ""
                message = ""
        if message:
            self._report(message)
            return False
        if not self._open():
            with self._lock:
                self._command = None
            return False
        return True

    def heartbeat(self, data):
        if (not isinstance(data, dict) or set(data) - {"session_id", "settings_available"}
                or type(data.get("settings_available", False)) is not bool):
            raise ValueError("桌面心跳字段无效")
        self.tick()
        with self._lock:
            if self._closed:
                raise ValueError("桌面服务已关闭")
            session = data.get("session_id")
            if session is None:
                if len(self._sessions) >= MAX_CLIENT_SESSIONS:
                    live = self._live()
                    self._sessions = {key: value for key, value in self._sessions.items() if key in live}
                if len(self._sessions) >= MAX_CLIENT_SESSIONS:
                    raise ValueError("页面会话过多，请关闭不用的页面后重试")
                session = secrets.token_urlsafe(24)
            elif not isinstance(session, str) or not _SESSION.fullmatch(session) or session not in self._sessions:
                raise ValueError("桌面页面会话已失效，请重新打开界面")
            self._sessions[session] = {"seen": self.clock(), "settings": data.get("settings_available", False)}
            command = None
            current = self._command
            if current and (current["action"] == "exit" or self._sessions[session]["settings"]):
                if current["action"] == "exit":
                    current["required"].add(session)
                current["delivered"].add(session)
                command = {"id": current["id"], "action": current["action"]}
            notice = ""
            if self._tray_ready and not self._notice_sent:
                self._notice_sent = True
                notice = "棱光托盘已就绪。关闭页面后可从托盘或再次启动程序找回；退出请使用托盘或设置中的退出。"
            return {"session_id": session, "desktop": self.status(), "command": command, "notice": notice}

    def complete(self, data, prepare_exit, *, commit_exit=None):
        if (not isinstance(data, dict) or set(data) - {"session_id", "command_id", "approved", "reason"}
                or type(data.get("approved")) is not bool
                or not isinstance(data.get("reason", "handled"), str)
                or data.get("reason", "handled") not in _REASONS):
            raise ValueError("桌面确认字段无效")
        self.tick()
        exiting = False
        message = ""
        with self._lock:
            session, command_id = data.get("session_id"), data.get("command_id")
            current = self._command
            if (self._closed or not current or current["id"] != command_id
                    or not isinstance(session, str) or session not in self._sessions
                    or session not in current["delivered"]):
                raise ValueError("桌面操作已失效或尚未交给此页面，未退出")
            if not data["approved"]:
                self._command = None
                message = _REASONS[data.get("reason", "client-error")] or _REASONS["client-error"]
            elif current["action"] == "settings":
                self._command = None
            else:
                current["approved"].add(session)
                if current["required"] <= current["approved"]:
                    try:
                        safe = prepare_exit()
                    except Exception:
                        safe = False
                    # Also cover a reentrant guard callback registering a page
                    # or advancing the clock. Never turn a changed handshake
                    # into exit authority merely because the task guard passed.
                    unchanged = (self._command is current
                                 and self.clock() < current["deadline"]
                                 and current["required"] <= current["approved"])
                    if safe and unchanged:
                        # The first callback is a pure preflight. Only this
                        # final validated handshake may publish exit_pending
                        # or hand off an already verified update.
                        try:
                            committed = commit_exit() if commit_exit is not None else True
                        except DesktopExitUncertain as exc:
                            self._command = None
                            self._closed = True
                            self._report(str(exc))
                            raise
                        except Exception:
                            committed = False
                        self._command = None
                        if committed is True:
                            exiting = True
                            self._closed = True
                        else:
                            message = "服务退出未能确认，退出条件已变化；请在主界面重新核实。"
                    elif not safe:
                        self._command = None
                        message = "仍有任务、待确认提交或更新，未退出；请在主界面核实。"
                    elif self._command is not current or self.clock() >= current["deadline"]:
                        self._command = None
                        message = "页面确认已变化或过期，未退出；请在主界面重试。"
        if message:
            self._report(message)
        if exiting:
            try:
                self._shutdown()
            except Exception:
                with self._lock:
                    self._closed = False
                exiting = False
                message = "服务退出未能确认；没有自动重试，请打开主界面核实。"
                self._report(message)
        return {"ok": not bool(message), "exiting": exiting, **({"error": message} if message else {})}

    def direct_exit(self, prepare_exit, commit_exit, *, require_no_sessions=False):
        """Legacy settings exit cannot bypass another registered live page.

        Hold the same lock used by heartbeat/ACK through both guards and the
        final commit. A pure preflight may reenter; recheck its exact session
        set rather than accepting a newly opened replacement page.
        """
        self.tick()
        with self._lock:
            live = self._live()
            if self._closed or self._command or (bool(live) if require_no_sessions else len(live) > 1):
                raise ValueError("其他页面或桌面操作尚待确认；请先处理其他页面后再退出。")
            if not prepare_exit():
                raise ValueError("有任务、待确认提交或下载正在处理，请完成后再退出。")
            if self._closed or self._command or not self._live() <= live:
                raise ValueError("退出检查期间页面或桌面操作已变化，请重新确认后再退出。")
            try:
                committed = commit_exit()
            except DesktopExitUncertain as exc:
                self._closed = True
                self._report(str(exc))
                raise
            if committed is not True:
                raise ValueError("退出条件已变化，未退出；请重新确认。")
            self._closed = True
            return {"ok": True, "exiting": True}

    def owner_shutdown_failed(self, *, handoff_pending=False):
        with self._lock:
            if not handoff_pending:
                self._closed = False
        self._report("服务退出结果尚未确认；请重新打开核实，不会自动重试退出或更新。"
                     if handoff_pending else "服务退出失败，后台仍保留；请重新打开主界面核实，不会自动重试。")

    def close(self):
        with self._lock:
            self._closed = True
            self._tray_ready = False
            self._command = None
            self._sessions.clear()
