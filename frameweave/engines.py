"""Local ComfyUI process registration and lifecycle helpers.

Only profiles stored in the user's local data directory can be started. The
HTTP-facing caller should expose :meth:`status` and :meth:`start` results, never
the command fields in ``engines.json``.
"""

import ctypes
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


_MAX_CONFIG_BYTES = 256 * 1024
_MAX_PROFILES = 32
_PROFILE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_PROBE_TIMEOUT = 0.6
# 0.9.2: independent read-only status and explicit background supervision.
_MAX_LOG_BYTES = 10 * 1024 * 1024
_DEFAULT_STARTUP_TIMEOUT = 600
_DEFAULT_MAX_RETRIES = 1
_MAX_PROCESS_RECORD_BYTES = 128 * 1024


class _ProcessRecordError(ValueError):
    pass


class _EngineFileLock:
    """OS-released lock for process-record read/modify/write transactions."""

    def __init__(self, path):
        self.path = Path(path)
        self._file = None

    def acquire(self, timeout=0):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        deadline = time.monotonic() + max(0.0, float(timeout))
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
                return True
            except OSError:
                if time.monotonic() >= deadline:
                    handle.close()
                    return False
                time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
            except BaseException:
                handle.close()
                raise

    def release(self):
        handle, self._file = self._file, None
        if handle is None:
            return
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


def _same_executable(left, right):
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    try:
        return os.path.normcase(os.path.realpath(left)) == os.path.normcase(os.path.realpath(right))
    except OSError:
        return os.path.normcase(os.path.normpath(left)) == os.path.normcase(os.path.normpath(right))


def _inspect_windows_process(pid):
    """Return (state, creation token, image path) for one Windows PID."""
    if os.name != "nt":
        return "unknown", None, None
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.FILETIME),
                                        ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME),
                                        ctypes.POINTER(wintypes.FILETIME)]
    kernel32.GetProcessTimes.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                    wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(0x00100000 | 0x00001000, False, pid)  # SYNCHRONIZE | QUERY_LIMITED_INFORMATION
    if not handle:
        return ("dead", None, None) if ctypes.get_last_error() == 87 else ("unknown", None, None)
    try:
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel_time = wintypes.FILETIME()
        user_time = wintypes.FILETIME()
        if not kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time),
                                        ctypes.byref(kernel_time), ctypes.byref(user_time)):
            return "unknown", None, None
        token = "windows:" + str((creation.dwHighDateTime << 32) | creation.dwLowDateTime)
        wait_result = kernel32.WaitForSingleObject(handle, 0)
        if wait_result == 0:
            return "dead", token, None
        if wait_result != 0x00000102:  # WAIT_TIMEOUT
            return "unknown", token, None
        image = ctypes.create_unicode_buffer(32768)
        image_size = wintypes.DWORD(len(image))
        if not kernel32.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(image_size)):
            return "unknown", token, None
        return "alive", token, image.value
    finally:
        if handle:
            kernel32.CloseHandle(handle)


def _inspect_process(pid):
    """Return (state, creation token, image path); unsupported systems are unknown."""
    return _inspect_windows_process(pid)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _local_base_url(value):
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError("推理服务地址无效")
    try:
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "http" or parsed.username or parsed.password
                or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
            raise ValueError()
        host = parsed.hostname
        if host == "localhost":
            host = "127.0.0.1"
        if not host or not ipaddress.ip_address(host).is_loopback:
            raise ValueError()
        port = parsed.port if parsed.port is not None else 80
    except (ValueError, TypeError):
        raise ValueError("只允许本机回环地址，例如 http://127.0.0.1:8188") from None
    if not 1 <= port <= 65535:
        raise ValueError("推理服务端口无效")
    display_host = f"[{host}]" if ":" in host else host
    return f"http://{display_host}:{port}"


def _absolute_local_path(value, label):
    if not isinstance(value, str) or not value or len(value) > 2048 or "\x00" in value:
        raise ValueError(f"{label}无效")
    if value.startswith(("\\\\", "//")):
        raise ValueError(f"{label}必须是本机路径")
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label}必须是绝对路径")
    return Path(os.path.normpath(path))


def _profile(value):
    if not isinstance(value, dict):
        raise ValueError("引擎配置格式无效")
    ident, name = value.get("id"), value.get("name")
    if not isinstance(ident, str) or not _PROFILE_ID.fullmatch(ident):
        raise ValueError("引擎配置标识无效")
    if not isinstance(name, str) or not name.strip() or len(name) > 100:
        raise ValueError("引擎名称无效")
    base_url = _local_base_url(value.get("base_url"))
    python = _absolute_local_path(value.get("python_executable"), "Python 路径")
    script = _absolute_local_path(value.get("main_script"), "引擎脚本路径")
    working = _absolute_local_path(value.get("working_directory"), "工作目录")
    arguments = value.get("arguments")
    if (not isinstance(arguments, list) or len(arguments) > 64
            or any(not isinstance(arg, str) or len(arg) > 2048 or "\x00" in arg for arg in arguments)):
        raise ValueError("引擎启动参数无效")
    startup_timeout = value.get("startup_timeout_seconds", _DEFAULT_STARTUP_TIMEOUT)
    if type(startup_timeout) is not int or not 10 <= startup_timeout <= 7200:
        raise ValueError("引擎就绪超时须为 10 到 7200 之间的整数秒")
    max_retries = value.get("max_retries", _DEFAULT_MAX_RETRIES)
    if type(max_retries) is not int or not 0 <= max_retries <= 5:
        raise ValueError("引擎自动重试次数须为 0 到 5 的整数")
    auto_start = value.get("auto_start", True)
    if type(auto_start) is not bool:
        raise ValueError("引擎自动启动设置须为布尔值")
    return {
        "id": ident,
        "name": name.strip(),
        "base_url": base_url,
        "python_executable": str(python),
        "main_script": str(script),
        "working_directory": str(working),
        "arguments": list(arguments),
        "startup_timeout_seconds": startup_timeout,
        "max_retries": max_retries,
        "auto_start": auto_start,
    }


class EngineManager:
    """Owns registered local ComfyUI profiles and starts only their commands.

    ``engines.json`` uses ``{"version": 1, "profiles": [...]}``. A profile
    has ``id``, ``name``, ``base_url``, ``python_executable``, ``main_script``,
    ``working_directory`` and an ``arguments`` string list. ``status()`` returns
    ``{"profiles": [...]}``; ``start(id)`` returns one public status object.
    Public statuses omit every executable and filesystem path.
    """

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir)
        self.config_path = self.data_dir / "engines.json"
        self.process_records_path = self.data_dir / "engine-processes.json"
        self.process_lock_path = self.data_dir / "engine-manager.lock"
        self.log_dir = self.data_dir / "engine-logs"
        self._lock = threading.RLock()
        self._profiles = self._load()
        self._processes = {}
        self._meta = {}

    def _load(self):
        try:
            raw = self.config_path.read_bytes()
        except FileNotFoundError:
            return []
        if len(raw) > _MAX_CONFIG_BYTES:
            raise ValueError("本地引擎配置文件过大")
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError):
            raise ValueError("本地引擎配置文件无法读取") from None
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("profiles"), list):
            raise ValueError("本地引擎配置文件格式无效")
        if len(data["profiles"]) > _MAX_PROFILES:
            raise ValueError("本地引擎配置数量超出上限")
        profiles = [_profile(item) for item in data["profiles"]]
        ids = [item["id"] for item in profiles]
        if len(ids) != len(set(ids)):
            raise ValueError("本地引擎配置包含重复标识")
        return profiles

    def _save(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.config_path.with_name("engines.json.tmp")
        payload = json.dumps({"version": 1, "profiles": self._profiles},
                             ensure_ascii=False, indent=2).encode("utf-8")
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.config_path)

    @staticmethod
    def _profile_signature(profile):
        command = {key: profile[key] for key in (
            "id", "base_url", "python_executable", "main_script", "working_directory", "arguments",
        )}
        raw = json.dumps(command, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def _read_process_records(self):
        try:
            raw = self.process_records_path.read_bytes()
        except FileNotFoundError:
            return {}
        except OSError as exc:
            raise _ProcessRecordError("无法读取本地引擎启动记录") from exc
        if len(raw) > _MAX_PROCESS_RECORD_BYTES:
            raise _ProcessRecordError("本地引擎启动记录超出大小限制")
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise _ProcessRecordError("本地引擎启动记录无法解析") from exc
        if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("profiles"), dict):
            raise _ProcessRecordError("本地引擎启动记录格式无效")
        return payload["profiles"]

    def _write_process_records(self, records):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.process_records_path.with_name(self.process_records_path.name + ".tmp")
        payload = json.dumps({"version": 1, "profiles": records}, ensure_ascii=False,
                             separators=(",", ":")).encode("utf-8")
        if len(payload) > _MAX_PROCESS_RECORD_BYTES:
            raise _ProcessRecordError("本地引擎启动记录超出大小限制")
        try:
            with temporary.open("wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.process_records_path)
        except OSError as exc:
            raise _ProcessRecordError("无法保存本地引擎启动记录") from exc

    def _save_process_record(self, profile, state, *, pid=None, creation_token=None, image_path=None):
        records = self._read_process_records()
        records[profile["id"]] = {
            "state": state,
            "pid": pid,
            "creation_token": creation_token,
            "image_path": image_path,
            "python_executable": profile["python_executable"],
            "profile_signature": self._profile_signature(profile),
            "updated_at": time.time(),
        }
        self._write_process_records(records)

    def _remove_process_record(self, ident):
        records = self._read_process_records()
        if ident in records:
            records.pop(ident)
            self._write_process_records(records)

    @staticmethod
    def _inspect_saved_record(record, profile):
        if not isinstance(record, dict) or record.get("state") not in ("managed", "unknown"):
            return "unknown"
        pid = record.get("pid")
        expected_token = record.get("creation_token")
        expected_image = record.get("image_path")
        if type(pid) is not int or pid <= 0:
            return "unknown"
        state, actual_token, actual_image = _inspect_process(pid)
        if state == "unknown":
            return "unknown"
        if state == "dead":
            return "dead" if expected_token is None or actual_token in (None, expected_token) else "stale"
        if state != "alive":
            return "unknown"
        if not isinstance(expected_token, str) or not expected_token:
            return "unknown"
        if actual_token != expected_token:
            return "stale"
        if not _same_executable(actual_image, expected_image):
            return "unknown"
        if (record.get("profile_signature") != EngineManager._profile_signature(profile)
                or not _same_executable(record.get("python_executable"), profile["python_executable"])):
            return "unknown"
        return "alive"

    def _persisted_guard(self, profile, *, manual_start):
        """Return a safe no-process snapshot when an earlier process is recorded."""
        try:
            records = self._read_process_records()
        except _ProcessRecordError as exc:
            return self._status_item(profile, False, False, "error", f"{exc}；为防止重复启动，暂不拉起引擎")
        record = records.get(profile["id"])
        if record is None:
            return None
        result = self._inspect_saved_record(record, profile)
        if result == "dead" or result == "stale":
            try:
                self._remove_process_record(profile["id"])
            except _ProcessRecordError as exc:
                return self._status_item(profile, False, False, "error", f"旧启动记录已失效，但清理失败：{exc}")
            if manual_start:
                return None
            message = ("上次启动的引擎进程已退出，旧记录已清理；请手动启动以重试" if result == "dead"
                       else "上次启动记录对应的 PID 已被系统复用，旧记录已安全清理；请手动启动以重试")
            return self._status_item(profile, False, False, "error", message)
        if result == "alive":
            online = self._probe_comfy(profile["base_url"])
            message = ("上次启动的 ComfyUI 仍在运行，已复用且未重复启动" if online
                       else "上次启动的引擎进程仍在运行，正在等待 ComfyUI 就绪；未重复启动")
            return self._status_item(profile, online, False, "online" if online else "starting", message)
        return self._status_item(profile, False, False, "error",
                                 "检测到上次的引擎启动记录，但无法核验进程身份；为防重复启动已暂停，请检查后台进程后重启")

    @staticmethod
    def _capture_process_identity(profile, process):
        pid = getattr(process, "pid", None)
        if type(pid) is not int or pid <= 0 or os.name != "nt":
            return None, None
        state, token, image = _inspect_process(pid)
        if state != "alive" or not token or not image:
            return None, None
        if not _same_executable(image, profile["python_executable"]):
            return None, None
        return token, image

    def _persist_profile_state(self, profile):
        meta = self._meta.get(profile["id"], {})
        pid = meta.get("process_pid")
        token = meta.get("creation_token")
        image = meta.get("image_path")
        state = "managed" if type(pid) is int and token and image else "unknown"
        self._save_process_record(profile, state, pid=pid, creation_token=token, image_path=image)

    def register(self, root, port=8188, name="本地 ComfyUI"):
        """Register a detected ComfyUI tree with a fixed safe startup command."""
        root = _absolute_local_path(str(root), "ComfyUI 根目录")
        if type(port) is not int or not 1 <= port <= 65535:
            raise ValueError("引擎端口必须在 1 到 65535 之间")
        if not isinstance(name, str) or not name.strip() or len(name) > 100:
            raise ValueError("引擎名称无效")
        main_script = root / "main.py"
        if not main_script.is_file() or not (root / "comfy").is_dir():
            raise ValueError("所选目录不是有效的 ComfyUI 安装目录")
        python_candidates = (
            root / "venv" / "Scripts" / "python.exe",
            root / ".venv" / "Scripts" / "python.exe",
            root.parent / "python_embeded" / "python.exe",
        )
        python = next((path for path in python_candidates if path.is_file()), None)
        if python is None:
            raise FileNotFoundError("未在 ComfyUI 安装目录的固定位置找到 Python 环境")

        canonical_root = os.path.normcase(os.path.normpath(str(root)))
        ident = "comfy-" + hashlib.sha256(f"{canonical_root}:{port}".encode("utf-8")).hexdigest()[:16]
        profile = _profile({
            "id": ident,
            "name": name,
            "base_url": f"http://127.0.0.1:{port}",
            "python_executable": str(python),
            "main_script": str(main_script),
            "working_directory": str(root),
            "arguments": ["--listen", "127.0.0.1", "--port", str(port), "--disable-auto-launch"],
        })
        with self._lock:
            existing = next((i for i, item in enumerate(self._profiles) if item["id"] == ident), None)
            if existing is None:
                if len(self._profiles) >= _MAX_PROFILES:
                    raise ValueError("本地引擎配置数量已达上限")
                self._profiles.append(profile)
            else:
                self._profiles[existing] = profile
            self._save()
            return self._public_status(profile)

    def registered_endpoints(self):
        """List validated public identities without network or lifecycle probes."""
        with self._lock:
            return [{key: profile[key] for key in ('id', 'name', 'base_url')}
                    for profile in self._profiles]

    def status(self):
        """Read health without changing state or managing any process."""
        with self._lock:
            return {"profiles": [self._public_status(profile) for profile in self._profiles]}

    def supervise(self):
        """Advance engine lifecycle state without coupling it to an HTTP GET.

        Call this from a background worker. The method may clean up naturally
        exited children and retry a pre-ready child according to its profile;
        it never terminates a child process.
        """
        with self._lock:
            process_lock = _EngineFileLock(self.process_lock_path)
            try:
                locked = process_lock.acquire(timeout=0.2)
            except OSError:
                locked = False
            if not locked:
                return {"profiles": [self._public_status(profile) for profile in self._profiles]}
            try:
                rows = []
                for profile in self._profiles:
                    if profile["id"] not in self._processes:
                        guarded = self._persisted_guard(profile, manual_start=False)
                        if guarded is not None:
                            rows.append(guarded)
                            continue
                    rows.append(self._supervise_profile(profile))
                return {"profiles": rows}
            finally:
                process_lock.release()

    def supervise_loop(self, stop_event, interval=15):
        """Run supervision independently until ``stop_event`` is set.

        The first pass is immediate. Stopping this loop only stops supervision;
        it does not stop or close any engine process or its log stream.
        """
        try:
            interval = float(interval)
        except (TypeError, ValueError):
            raise ValueError("监督间隔必须是正数") from None
        if not 0 < interval <= 3600:
            raise ValueError("监督间隔必须大于 0 且不超过 3600 秒")
        if not callable(getattr(stop_event, "is_set", None)) or not callable(getattr(stop_event, "wait", None)):
            raise TypeError("stop_event 必须提供 is_set() 和 wait()")

        while not stop_event.is_set():
            try:
                self.supervise()
            except Exception:
                # One transient filesystem/probe failure must not permanently
                # kill the daemon worker. The next pass will re-evaluate state.
                pass
            if stop_event.wait(interval):
                break

    def auto_start_profile_for(self, base_url):
        """Return the id of the profile bound to ``base_url`` when it may auto start."""
        with self._lock:
            try:
                target = _local_base_url(base_url)
            except ValueError:
                return None
            for profile in self._profiles:
                if profile["base_url"] == target and profile.get("auto_start", True):
                    return profile["id"]
            return None

    def public_flags(self):
        """Non-sensitive per-profile flags for lifecycle decisions (no paths)."""
        with self._lock:
            return {profile["id"]: bool(profile.get("auto_start", True)) for profile in self._profiles}

    def start(self, ident):
        """Explicitly start/retry one profile, clearing its saved error state."""
        with self._lock:
            profile = next((item for item in self._profiles if item["id"] == ident), None)
            if profile is None:
                raise KeyError("未找到指定的本地引擎配置")
            process_lock = _EngineFileLock(self.process_lock_path)
            try:
                locked = process_lock.acquire(timeout=2)
            except OSError:
                return self._status_item(profile, False, False, "error", "无法取得引擎启动锁，未启动引擎")
            if not locked:
                return self._status_item(profile, False, False, "starting", "其他客户端正在处理引擎状态，请稍后刷新")
            try:
                had_process = profile["id"] in self._processes
                if not had_process:
                    guarded = self._persisted_guard(profile, manual_start=True)
                    if guarded is not None:
                        return guarded
                process = self._alive_process(profile["id"])
                if had_process and process is None:
                    try:
                        self._remove_process_record(profile["id"])
                    except _ProcessRecordError as exc:
                        return self._status_item(profile, False, False, "error", f"引擎已退出，但启动记录无法清理：{exc}")
                online = self._probe_comfy(profile["base_url"])
                meta = self._meta.setdefault(profile["id"], {})
                meta.pop("error", None)
                meta["stop_retry"] = False
                meta["restarts"] = 0
                if online:
                    meta["online_seen"] = True
                    meta["started_at"] = None
                    if process is not None:
                        self._persist_profile_state(profile)
                    return self._status_item(profile, online=True, managed=process is not None,
                                             state="online", message="ComfyUI 已就绪" if process else "已复用运行中的 ComfyUI")
                if process is not None:
                    meta.setdefault("online_seen", False)
                    meta["started_at"] = time.monotonic()
                    self._persist_profile_state(profile)
                    if meta["online_seen"]:
                        return self._status_item(profile, online=False, managed=True,
                                                 state="degraded", message="已就绪引擎的健康探测暂未通过，仍在运行观察中")
                    return self._status_item(profile, online=False, managed=True,
                                             state="starting", message="引擎已启动，正在等待 ComfyUI 就绪")

                meta.update(started_at=time.monotonic(), started_wall=time.time(), online_seen=False)
                result = self._spawn(profile)
                if result["state"] == "online":
                    meta.update(online_seen=True, started_at=None)
                elif result["state"] != "starting":
                    meta["error"] = result["message"]
                    meta["stop_retry"] = True
                return result
            finally:
                process_lock.release()

    def _open_log(self, profile):
        """Append to the profile log, rotating once past a bounded size."""
        self.log_dir.mkdir(parents=True, exist_ok=True)
        log_path = self.log_dir / f"{profile['id']}.log"
        try:
            if log_path.stat().st_size > _MAX_LOG_BYTES:
                os.replace(log_path, log_path.with_name(log_path.name + ".1"))
        except OSError:
            pass
        return log_path.open("ab", buffering=0)

    def _spawn(self, profile):
        """Start one registered profile with its fixed argv, logging to App_Data."""
        # Re-check immediately before Popen. Auto-retries must never claim a
        # port that became occupied after the earlier health probe.
        if self._probe_comfy(profile["base_url"]):
            return self._status_item(profile, online=True, managed=False,
                                     state="online", message="已复用运行中的 ComfyUI")
        if self._port_in_use(profile["base_url"]):
            return self._status_item(profile, online=False, managed=False,
                                     state="occupied", message="端口已被其他服务占用，未启动引擎")
        invalid = self._validate_start_paths(profile)
        if invalid:
            return self._status_item(profile, online=False, managed=False,
                                     state="error", message=invalid)
        try:
            # Persist a crash-safe reservation before creating the child. If
            # this app exits in the spawn window, the next run blocks safely.
            self._save_process_record(profile, "launching")
        except _ProcessRecordError as exc:
            return self._status_item(profile, False, False, "error", f"无法记录引擎启动状态，未启动：{exc}")
        try:
            log_stream = self._open_log(profile)
            options = {
                "cwd": profile["working_directory"],
                "stdin": subprocess.DEVNULL,
                "stdout": log_stream,
                "stderr": subprocess.STDOUT,
                "shell": False,
                "close_fds": True,
                "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
            }
            if os.name != "nt":
                options["start_new_session"] = True
            try:
                process = subprocess.Popen(
                    [profile["python_executable"], profile["main_script"], *profile["arguments"]],
                    **options,
                )
            except BaseException:
                log_stream.close()
                raise
            self._processes[profile["id"]] = (process, log_stream)
        except (OSError, ValueError, subprocess.SubprocessError):
            try:
                self._remove_process_record(profile["id"])
            except _ProcessRecordError:
                pass
            return self._status_item(profile, online=False, managed=False,
                                     state="error", message="无法启动本地引擎，请检查安装目录和日志")
        meta = self._meta.setdefault(profile["id"], {})
        token, image = self._capture_process_identity(profile, process)
        meta.update(process_pid=getattr(process, "pid", None), creation_token=token, image_path=image)
        try:
            self._persist_profile_state(profile)
        except _ProcessRecordError:
            # The reservation remains in place. A later application instance
            # will conservatively wait instead of launching a duplicate.
            pass
        return self._status_item(profile, online=False, managed=True,
                                 state="starting", message="引擎已启动，正在等待 ComfyUI 就绪")

    def _validate_start_paths(self, profile):
        python = Path(profile["python_executable"])
        script = Path(profile["main_script"])
        working = Path(profile["working_directory"])
        try:
            if not python.is_file() or not script.is_file() or not working.is_dir():
                return "引擎安装文件缺失，请重新选择本地 ComfyUI 目录"
        except OSError:
            return "无法访问引擎安装目录"
        return None

    def _alive_process(self, ident):
        entry = self._processes.get(ident)
        if not entry:
            return None
        process, _ = entry
        try:
            alive = process.poll() is None
        except (OSError, ValueError):
            # Unknown is not proof of exit; keep ownership and avoid a
            # duplicate spawn while the process handle cannot be queried.
            return process
        if alive:
            return process
        self._forget_exited_process(ident)
        return None

    def _forget_exited_process(self, ident):
        """Drop a child already confirmed exited and close only its log handle."""
        entry = self._processes.pop(ident, None)
        if not entry:
            return
        _, log_stream = entry
        try:
            log_stream.close()
        except (OSError, ValueError):
            pass
        try:
            self._remove_process_record(ident)
        except _ProcessRecordError:
            pass

    @staticmethod
    def _probe_comfy(base_url):
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
            request = urllib.request.Request(base_url + "/system_stats", headers={
                "Accept": "application/json", "Connection": "close",
            })
            with opener.open(request, timeout=_PROBE_TIMEOUT) as response:
                if response.status != 200:
                    return False
                length = response.headers.get("Content-Length")
                if length and (not length.isdigit() or int(length) > 65536):
                    return False
                body = response.read(65537)
                if len(body) > 65536:
                    return False
            payload = json.loads(body.decode("utf-8"))
            return (isinstance(payload, dict) and isinstance(payload.get("system"), dict)
                    and isinstance(payload.get("devices"), list)
                    and ("comfyui_version" in payload["system"]
                         or "python_version" in payload["system"]))
        except (http.client.HTTPException, OSError, ValueError, TypeError, TimeoutError, urllib.error.URLError,
                urllib.error.HTTPError, UnicodeError, json.JSONDecodeError):
            return False

    @staticmethod
    def _port_in_use(base_url):
        parsed = urllib.parse.urlsplit(base_url)
        host, port = parsed.hostname, parsed.port
        try:
            with socket.create_connection((host, port), timeout=_PROBE_TIMEOUT):
                return True
        except OSError:
            return False

    def _public_status(self, profile):
        """Return a read-only health snapshot; never spawn, reap, or mutate state."""
        ident = profile["id"]
        meta = self._meta.get(ident) or {}
        entry = self._processes.get(ident)
        process = entry[0] if entry else None
        if process is not None:
            try:
                alive = process.poll() is None
            except (OSError, ValueError):
                # Keep an uncertain child represented as managed. A later
                # supervisor pass can check again without risking a duplicate.
                alive = True
        online = self._probe_comfy(profile["base_url"])
        managed = process is not None and alive
        if meta.get("error"):
            return self._status_item(profile, online, managed, "error", meta["error"])
        if online:
            return self._status_item(profile, True, managed, "online",
                                     "ComfyUI 已就绪" if managed else "已复用运行中的 ComfyUI")
        if managed:
            if meta.get("online_seen"):
                return self._status_item(profile, False, True, "degraded",
                                         "已就绪引擎的健康探测暂未通过，后台仍在运行观察中")
            return self._status_item(profile, False, True, "starting",
                                     "引擎已启动，正在等待后台监督检查就绪状态")
        if process is not None:
            if meta.get("online_seen"):
                return self._status_item(profile, False, False, "error",
                                         "引擎进程已退出；等待后台监督记录状态")
            return self._status_item(profile, False, False, "starting",
                                     "引擎进程已退出；等待后台监督处理")
        if self._port_in_use(profile["base_url"]):
            state, message = "occupied", "端口由非 ComfyUI 服务占用"
        else:
            state, message = "offline", "引擎未运行"
        return self._status_item(profile, False, False, state, message)

    def _supervise_profile(self, profile):
        """Advance one profile; only naturally exited children are cleaned up."""
        ident = profile["id"]
        meta = self._meta.setdefault(ident, {})
        entry = self._processes.get(ident)
        process = entry[0] if entry else None
        alive = False
        process_status_uncertain = False
        if process is not None:
            try:
                alive = process.poll() is None
            except (OSError, ValueError):
                alive = True
                process_status_uncertain = True

        online = self._probe_comfy(profile["base_url"])
        if meta.get("error"):
            if process is not None and not alive:
                self._forget_exited_process(ident)
            return self._status_item(profile, online, alive, "error", meta["error"])

        if online:
            meta["online_seen"] = True
            meta["restarts"] = 0
            meta["started_at"] = None
            return self._status_item(profile, True, alive, "online",
                                     "ComfyUI 已就绪" if alive else "已复用运行中的 ComfyUI")

        if process is not None and alive:
            if meta.get("online_seen"):
                return self._status_item(profile, False, True, "degraded",
                                         "已就绪引擎的健康探测暂未通过，后台仍在运行观察中")
            if process_status_uncertain:
                return self._status_item(profile, False, True, "starting",
                                         "无法确认引擎进程状态，后台保留该进程并继续观察")
            timeout = profile.get("startup_timeout_seconds", _DEFAULT_STARTUP_TIMEOUT)
            started_at = meta.get("started_at")
            if started_at is not None and time.monotonic() - started_at >= timeout:
                message = (f"引擎启动超时（{timeout} 秒未就绪）；后台已停止自动重试，"
                           "进程和日志已保留，请检查后手动重试")
                meta["error"] = message
                meta["stop_retry"] = True
                return self._status_item(profile, False, True, "error", message)
            return self._status_item(profile, False, True, "starting",
                                     "引擎已启动，正在等待 ComfyUI 就绪")

        if process is not None:
            # This process exited on its own; close its log and forget only the
            # stale child handle. Never send a signal to it.
            self._forget_exited_process(ident)
            if meta.get("online_seen"):
                message = "引擎进程已退出；已停止自动重试，请检查日志后手动启动"
                meta["error"] = message
                meta["stop_retry"] = True
                return self._status_item(profile, False, False, "error", message)

        if process is not None:
            # The managed child exited before readiness. Check the port again
            # before deciding whether an automatic retry is safe.
            if self._port_in_use(profile["base_url"]):
                message = "端口由非 ComfyUI 服务占用，未自动启动引擎"
                meta["error"] = message
                meta["stop_retry"] = True
                return self._status_item(profile, False, False, "error", message)
            max_retries = profile.get("max_retries", _DEFAULT_MAX_RETRIES)
            used = meta.get("restarts", 0)
            if used >= max_retries:
                message = "引擎启动失败，已停止自动重试；请检查引擎日志后手动启动"
                meta["error"] = message
                meta["stop_retry"] = True
                return self._status_item(profile, False, False, "error", message)
            meta["restarts"] = used + 1
            meta["started_at"] = time.monotonic()
            retried = self._spawn(profile)
            if retried["state"] == "starting":
                return self._status_item(profile, False, True, "starting",
                                         f"引擎进程退出，自动重试启动（第 {used + 1}/{max_retries} 次）")
            if retried["state"] == "online":
                meta.update(online_seen=True, started_at=None, restarts=0)
                return retried
            meta["error"] = retried["message"]
            meta["stop_retry"] = True
            return self._status_item(profile, False, False, "error", retried["message"])

        # A profile that has never been started is intentionally passive here;
        # startup is an explicit action (or the application's own auto-start policy).
        if self._port_in_use(profile["base_url"]):
            return self._status_item(profile, False, False, "occupied", "端口由非 ComfyUI 服务占用")
        return self._status_item(profile, False, False, "offline", "引擎未运行")

    @staticmethod
    def _status_item(profile, online, managed, state, message):
        return {
            "id": profile["id"],
            "name": profile["name"],
            "base_url": profile["base_url"],
            "online": bool(online),
            "managed": bool(managed),
            "state": state,
            "message": message,
            "auto_start": bool(profile.get("auto_start", True)),
        }
