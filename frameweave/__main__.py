import argparse
import logging
from logging.handlers import RotatingFileHandler
import os
import sys
import threading
import time
from pathlib import Path

from . import __version__
from .instance import (resolve_default_data, InstanceLock, activate_existing_app_window, focus_or_open_app_window,
                       read_instance_url, read_legacy_url,
                       validate_prismcanvas_url)
from .server import App, make_server
from .desktop_shell import DesktopExitUncertain
from .windows_tray import WindowsTray

_APP_LOG_BYTES = 1_000_000
_APP_LOG_BACKUPS = 2


def setup_logging(data: Path) -> None:
    """Log app-level events to App_Data\\app.log (rotated); never block startup."""
    try:
        data.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(data / "app.log", maxBytes=_APP_LOG_BYTES,
                                      backupCount=_APP_LOG_BACKUPS, encoding="utf-8")
        logging.basicConfig(level=logging.INFO, handlers=[handler],
                            format="%(asctime)s %(levelname)s %(message)s")
    except OSError:
        pass


def _idle_can_exit(app, port):
    """An active optional worker defers idle shutdown without ending the watcher."""
    try:
        return app.direct_desktop_exit()["exiting"] is True
    except (ValueError, DesktopExitUncertain):
        # The interactive exit endpoint returns the concrete reason. The idle
        # watcher simply keeps serving and checks again on its normal interval.
        return False


def _desktop_action(app, action, *, clock=time.monotonic):
    if action == "tick":
        return app.desktop.tick()
    # A user menu action grants idle grace; the cheap timer never does.
    app.last_seen = clock()
    return app.desktop.action(action)


def _open_failure_notice(message="未能重新打开主界面。现有服务和任务已保留，请稍后再次启动棱光。"):
    logging.warning("%s", message)
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes
            user = ctypes.WinDLL("user32", use_last_error=True)
            user.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.UINT]
            user.MessageBoxW(None, message, "棱光", 0x30)
        except (OSError, AttributeError):
            pass


def _reopen_verified_instance(url, data):
    try:
        if focus_or_open_app_window(url, data):
            return True
    except (OSError, ValueError):
        pass
    _open_failure_notice()
    return False


def _wait_existing_instance(data, timeout=5, *, clock=time.monotonic, wait=time.sleep):
    deadline = clock() + timeout
    while True:
        url = read_instance_url(data)
        remaining = deadline - clock()
        if url and validate_prismcanvas_url(url, timeout=max(0.05, min(1, remaining)), allow_previous_owner=True):
            return url
        if remaining <= 0:
            return None
        wait(min(0.15, remaining))


def main():
    parser = argparse.ArgumentParser(description="棱光 PrismCanvas · 轻量本地 AI 画布")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--backend")
    parser.add_argument("--model-root", action="append")
    parser.add_argument("--comfy-root", action="append")
    parser.add_argument("--data-dir")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--open-existing", action="store_true",
                        help="已有棱光实例时重新打开它的画布窗口")
    parser.add_argument("--apply-update", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.apply_update:
        from .update_handoff import run_handoff

        run_handoff(args.apply_update)
        return
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    default_data = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "FrameWeave"
    pointed_data, pointed_port = resolve_default_data(default_data)
    data = (Path(args.data_dir).resolve() if args.data_dir else pointed_data)
    port = args.port if args.port is not None else pointed_port
    setup_logging(data)
    instance = InstanceLock(data)
    if not instance.acquire():
        existing_url = _wait_existing_instance(data)
        if existing_url:
            if sys.stdout:
                print(f"棱光已在运行: {existing_url}", flush=True)
            logging.info("已有实例在运行: %s；本次不启动第二个服务。", existing_url)
            if args.open_existing or not args.no_browser:
                _reopen_verified_instance(existing_url, data)
            else:
                activate_existing_app_window(existing_url)
        else:
            message = "棱光正在启动或现有画布暂不可用；未创建第二个实例，请稍后再次启动。"
            if sys.stdout:
                print(message, flush=True)
            if not args.no_browser:
                _open_failure_notice(message)
        return

    # Releases before 0.9 did not hold an OS instance lock. Honor their saved
    # loopback service if it still identifies as the known PrismCanvas app.
    # This avoids starting a second server on a fallback port during upgrades.
    legacy_url = read_legacy_url(data)
    if legacy_url and validate_prismcanvas_url(legacy_url, allow_legacy=True):
        try:
            if sys.stdout:
                print(f"检测到旧版棱光仍在运行: {legacy_url}；保留现有实例。", flush=True)
            logging.info("检测到旧版棱光仍在运行: %s；保留现有实例。", legacy_url)
            if args.open_existing or not args.no_browser:
                _reopen_verified_instance(legacy_url, data)
            else:
                activate_existing_app_window(legacy_url)
        finally:
            instance.release()
        return

    server = None
    tray = None
    try:
        app = App(data, base / "web", args.backend, args.model_root, args.comfy_root)
        try:
            server = make_server(app, port)
        except OSError:
            server = make_server(app, 0)
    except BaseException:
        logging.exception("应用启动失败")
        instance.release()
        raise

    try:
        url = f"http://127.0.0.1:{server.server_port}/"
        app.listen_port = server.server_port
        instance.write_metadata(url=url)
        (data / "last-url.txt").write_text(url, encoding="utf-8")
        if sys.stdout:
            print(f"PrismCanvas 棱光: {url}\nData: {data}", flush=True)
        logging.info("PrismCanvas %s 启动: %s（数据目录 %s）",
                     __version__, url, data)
        threading.Thread(target=app.poll, daemon=True).start()
        threading.Thread(target=app.engines.supervise_loop, args=(app.closed,), daemon=True).start()
        if not args.no_browser:
            app.desktop.configure(tray_ready=False, open_ui=lambda: focus_or_open_app_window(url, data))
            if os.name == "nt":
                tray = WindowsTray(icon_path=base / "assets" / "frameweave.ico",
                                   on_action=lambda action: _desktop_action(app, action),
                                   state=app.desktop.status, on_failure=app.desktop.tray_failed)
                ready = tray.start()
                app.desktop.configure(tray_ready=ready, notify=tray.notify)
                if not ready:
                    app.desktop.tray_failed()
            if not app.desktop.action("open"):
                _open_failure_notice()
            # The desktop window owns its draft and downloads. The service has
            # a separate lifetime so background jobs survive closing the window.
            def idle_exit():
                while not app.closed.wait(15):
                    app.desktop.tick()
                    if app.desktop.keeps_background():
                        continue
                    if time.monotonic() - app.last_seen > 180:
                        if not _idle_can_exit(app, server.server_port):
                            continue
                        return
            threading.Thread(target=idle_exit, daemon=True).start()
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
    finally:
        logging.info("PrismCanvas 服务退出（引擎进程不受影响，继续在线）。")
        if 'app' in locals():
            app.closed.set()
            app.desktop.close()
        try:
            if tray is not None:
                tray.stop()
        except Exception:
            logging.warning("托盘退出清理未完成；服务仍按正常退出流程释放。")
        try:
            server.server_close()
        finally:
            instance.release()


if __name__ == "__main__":
    main()
