"""Safe handoff from a running PrismCanvas executable to a verified update.

The old executable and its shortcut remain intact. This module waits for the
application's data-directory lock, asks :mod:`update_install` to create a
versioned candidate, starts it with the same data directory and port, and only
retargets desktop shortcuts after its loopback bootstrap proves its identity.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
import uuid

from .instance import InstanceLock


MAX_PLAN_BYTES = 1024 * 1024
LOCK_WAIT_SECONDS = 180.0
HEALTH_WAIT_SECONDS = 60.0
SHUTDOWN_WAIT_SECONDS = 12.0
_VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\Z")
_CSRF = re.compile(r"[A-Za-z0-9_-]{40,64}\Z")


def launch_handoff(current_exe, data_dir, staged, port, open_browser=True):
    """Copy the running EXE to a unique helper and launch its apply-update mode.

    ``staged`` is the verified ``UpdateManager.status()["staged"]`` object.
    The returned object contains no update archive paths or tokens.
    """
    current_exe = _local_path(current_exe, "当前程序路径")
    data_dir = Path(data_dir).expanduser().resolve()
    if not current_exe.is_file() or current_exe.suffix.lower() != ".exe":
        raise ValueError("当前程序文件不可用")
    _validate_staged(staged, data_dir=data_dir)
    port = _port(port)
    if type(open_browser) is not bool:
        raise ValueError("窗口启动选项无效")

    updates_dir = data_dir / "updates"
    updates_dir.mkdir(parents=True, exist_ok=True)
    nonce = str(uuid.uuid4())
    helper = updates_dir / f"update-helper-{nonce}.exe"
    plan_path = updates_dir / f"handoff-{nonce}.json"
    result_path = updates_dir / f"handoff-{nonce}.result.json"
    _copy_current_exe(current_exe, helper)
    plan = {
        "version": 1,
        "helper_exe": str(helper),
        "result_path": str(result_path),
        "current_exe": str(current_exe),
        "install_base": str(current_exe.parent.parent),
        "data_dir": str(data_dir),
        "staged": staged,
        "port": port,
        "open_browser": open_browser,
    }
    try:
        _write_json_atomic(plan_path, plan)
        _spawn_helper(helper, plan_path, updates_dir / "handoff-launcher.log")
    except Exception:
        # Keep the copied helper and plan for diagnosis; the installed program
        # has not been changed and the caller can report failure safely.
        raise
    return {"queued": True, "version": staged["version"], "handoff_id": nonce}


def run_handoff(plan_path, *, lock_factory=None, prepare_install_fn=None,
                spawn=None, probe_fn=None, port_in_use_fn=None,
                shortcut_fn=None, restore_shortcuts_fn=None, sleep_fn=None, monotonic_fn=None,
                health_timeout=HEALTH_WAIT_SECONDS, lock_timeout=LOCK_WAIT_SECONDS):
    """Execute one helper plan and write its private result JSON.

    Dependencies are keyword-injectable for isolated tests. No failure path
    terminates an unverified listener or any process it did not start.
    """
    lock_factory = lock_factory or InstanceLock
    if prepare_install_fn is None:
        from .update_install import prepare_install as prepare_install_fn
    spawn = spawn or subprocess.Popen
    probe_fn = probe_fn or _probe_candidate
    port_in_use_fn = port_in_use_fn or _port_in_use
    shortcut_fn = shortcut_fn or update_desktop_shortcuts
    restore_shortcuts_fn = restore_shortcuts_fn or restore_desktop_shortcuts
    sleep_fn = sleep_fn or time.sleep
    monotonic_fn = monotonic_fn or time.monotonic

    result_path = None
    lock = None
    lock_acquired = False
    candidate_process = None
    plan = None
    result = {"state": "failed", "message": "更新交接未完成"}
    try:
        plan = _read_plan(plan_path)
        result_path = Path(plan["result_path"])
        lock = _wait_for_lock(plan["data_dir"], lock_factory, lock_timeout,
                              sleep_fn=sleep_fn, monotonic_fn=monotonic_fn)
        if lock is None:
            result = {"state": "instance-busy", "version": plan["staged"]["version"],
                      "message": "棱光仍在运行，更新尚未切换"}
            return _finish(result_path, result)
        lock_acquired = True

        if _safe_port_in_use(port_in_use_fn, plan["port"]):
            result = {"state": "port-occupied", "version": plan["staged"]["version"],
                      "message": "目标端口已有服务，未安装或启动候选程序"}
            return _finish(result_path, result)
        prepared = prepare_install_fn(plan["staged"], plan["install_base"], plan["current_exe"])
        candidate = _validate_prepared(prepared, plan)
        if _safe_port_in_use(port_in_use_fn, plan["port"]):
            result = {"state": "port-occupied", "version": candidate["version"],
                      "message": "目标端口已有服务，未启动候选程序"}
            return _finish(result_path, result)

        # Hold the instance lock through extraction and release immediately
        # before spawn, preventing an old client from entering during install.
        lock.release()
        lock = None
        candidate_process = _spawn_candidate(
            candidate["path"], plan["data_dir"], plan["port"], plan["open_browser"],
            Path(plan["data_dir"]) / "updates" / f"candidate-{candidate['version']}.log", spawn,
        )
        healthy = _wait_for_candidate(
            plan["port"], candidate["version"], probe_fn, health_timeout,
            sleep_fn=sleep_fn, monotonic_fn=monotonic_fn,
        )
        if healthy is None:
            if _process_exited(candidate_process) and not port_in_use_fn(plan["port"]):
                _spawn_candidate(plan["current_exe"], plan["data_dir"], plan["port"],
                                 plan["open_browser"],
                                 Path(plan["data_dir"]) / "updates" / "previous-version-recovery.log", spawn)
                state = "recovered-old-version"
                message = "候选程序未通过启动检查，已在端口空闲后启动原版本"
            else:
                state = "candidate-unverified"
                message = "未能确认候选程序身份；为避免影响其他服务，没有关闭或重启任何监听进程"
            result = {"state": state, "version": candidate["version"], "message": message}
            return _finish(result_path, result)

        try:
            shortcut_result = shortcut_fn(
                plan["current_exe"], candidate["path"], candidate["version"],
                backup_dir=Path(plan["data_dir"]) / "updates" / "shortcut-backups",
            )
        except Exception:
            # Rollback is allowed only after a fresh identity check proves the
            # server is this exact candidate and returns its in-memory token.
            stopped = (False if _process_exited(candidate_process) else _shutdown_confirmed_candidate(
                plan["port"], candidate["version"], healthy.get("csrf"),
                probe_fn=probe_fn, port_in_use_fn=port_in_use_fn,
                sleep_fn=sleep_fn, monotonic_fn=monotonic_fn,
            ))
            if stopped:
                _spawn_candidate(plan["current_exe"], plan["data_dir"], plan["port"],
                                 plan["open_browser"],
                                 Path(plan["data_dir"]) / "updates" / "previous-version-rollback.log", spawn)
                result = {"state": "rolled-back", "version": candidate["version"],
                          "message": "快捷方式切换失败，已确认关闭候选服务并恢复原版本"}
            else:
                result = {"state": "shortcut-failed", "version": candidate["version"],
                          "message": "候选程序已通过检查，但快捷方式切换失败；未关闭身份无法确认的服务"}
            return _finish(result_path, result)

        final_health = probe_fn(plan["port"], candidate["version"])
        if not _candidate_identity(final_health, candidate["version"]):
            restored = 0
            restore_error = False
            try:
                restored = restore_shortcuts_fn(
                    shortcut_result.get("backups", []),
                    backup_dir=Path(plan["data_dir"]) / "updates" / "shortcut-backups",
                ).get("restored", 0)
            except Exception:
                restore_error = True
            if _process_exited(candidate_process) and not _safe_port_in_use(port_in_use_fn, plan["port"]):
                _spawn_candidate(plan["current_exe"], plan["data_dir"], plan["port"],
                                 plan["open_browser"],
                                 Path(plan["data_dir"]) / "updates" / "previous-version-recovery.log", spawn)
                result = {"state": "recovered-old-version", "version": candidate["version"],
                          "message": "候选程序在快捷方式切换后退出，已在端口空闲后恢复原版本",
                          "shortcuts_restored": restored}
            else:
                result = {"state": "candidate-unverified", "version": candidate["version"],
                          "message": "候选程序二次检查未通过；未关闭身份无法确认的服务",
                          "shortcuts_restored": restored, "shortcut_restore_failed": restore_error}
            return _finish(result_path, result)

        result = {"state": "installed", "version": candidate["version"],
                  "message": "候选程序通过启动检查", "shortcuts_updated": int(shortcut_result.get("updated", 0)),
                  "shortcut_backups": list(shortcut_result.get("backups", []))[:64]}
        return _finish(result_path, result)
    except Exception as exc:
        if lock is not None:
            lock.release()
            lock = None
        message = _safe_error(exc)
        if (plan is not None and lock_acquired and candidate_process is None
                and not _safe_port_in_use(port_in_use_fn, plan["port"])):
            try:
                _spawn_candidate(plan["current_exe"], plan["data_dir"], plan["port"],
                                 plan["open_browser"],
                                 Path(plan["data_dir"]) / "updates" / "previous-version-recovery.log", spawn)
                result = {"state": "recovered-old-version", "version": plan["staged"]["version"],
                          "message": "更新准备失败，已在端口空闲后重新启动原版本"}
            except Exception:
                result = {"state": "failed", "version": plan.get("staged", {}).get("version"),
                          "message": message}
        else:
            result = {"state": "failed", "version": (plan or {}).get("staged", {}).get("version"),
                      "message": message}
        return _finish(result_path, result)
    finally:
        if lock is not None:
            try:
                lock.release()
            except Exception:
                pass


def update_desktop_shortcuts(old_exe, new_exe, version, *, backup_dir=None, runner=None):
    """Retarget only top-level Desktop links whose target is exactly old_exe.

    Each original link is copied to a unique backup file outside the Desktop.
    PowerShell receives an encoded script whose path inputs are base64 values,
    so filesystem names never become executable PowerShell source.
    """
    if os.name != "nt":
        return {"updated": 0, "backups": []}
    old_exe = str(_local_path(old_exe, "原程序路径"))
    new_exe = str(_local_path(new_exe, "候选程序路径"))
    backup_dir = Path(backup_dir).expanduser().resolve() if backup_dir is not None else Path(old_exe).parent / "shortcut-backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise ValueError("版本号无效")
    encode = lambda value: base64.b64encode(value.encode("utf-8")).decode("ascii")
    old_b64, new_b64, version_b64, backup_b64 = map(encode, (old_exe, new_exe, version, str(backup_dir)))
    script = rf'''
$ErrorActionPreference = 'Stop'
$old = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{old_b64}'))
$new = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{new_b64}'))
$version = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{version_b64}'))
$backupDir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{backup_b64}'))
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$linksToUpdate = @()
if ($desktop -and (Test-Path -LiteralPath $desktop -PathType Container)) {{
  foreach ($item in @(Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -File)) {{
    try {{
      $link = $shell.CreateShortcut($item.FullName)
      if ([IO.Path]::GetFullPath($link.TargetPath).TrimEnd('\') -ieq [IO.Path]::GetFullPath($old).TrimEnd('\')) {{
        $linksToUpdate += ,@($item.FullName, $link)
      }}
    }} catch {{ }}
  }}
}}
$backups = @()
$changed = @()
try {{
  foreach ($entry in $linksToUpdate) {{
    $path = [string]$entry[0]
    $link = $entry[1]
    if (!(Test-Path -LiteralPath $backupDir -PathType Container)) {{
      New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    }}
    $backup = Join-Path $backupDir ('shortcut-' + [guid]::NewGuid().ToString('N') + '.lnk.bak')
    Copy-Item -LiteralPath $path -Destination $backup -ErrorAction Stop
    $backups += [pscustomobject]@{{shortcut=$path; backup=$backup}}
    $oldIcon = $false
    if (!$link.IconLocation) {{ $oldIcon = $true }}
    else {{
      $iconPath = $link.IconLocation -replace ',[-]?[0-9]+$', ''
      try {{ $oldIcon = [IO.Path]::GetFullPath($iconPath).TrimEnd('\') -ieq [IO.Path]::GetFullPath($old).TrimEnd('\') }} catch {{ }}
    }}
    $link.TargetPath = $new
    $link.WorkingDirectory = [IO.Path]::GetDirectoryName($new)
    if ($oldIcon) {{ $link.IconLocation = $new + ',0' }}
    $link.Save()
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($path)
    try {{ $updatedHash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }}
    finally {{ $stream.Dispose(); $hasher.Dispose() }}
    $backups[-1] | Add-Member -NotePropertyName updated_sha256 -NotePropertyValue $updatedHash
    $changed += $path
  }}
  @{{ok=$true; updated=$changed.Count; backups=$backups}} | ConvertTo-Json -Compress
}} catch {{
  foreach ($entry in $backups) {{
    if (Test-Path -LiteralPath $entry.backup) {{ Copy-Item -LiteralPath $entry.backup -Destination $entry.shortcut -Force }}
  }}
  [Console]::Error.WriteLine('shortcut update failed')
  exit 2
}}
'''
    encoded_script = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    runner = runner or subprocess.run
    result = runner(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                     "-EncodedCommand", encoded_script], capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=20, check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0:
        raise RuntimeError("无法安全更新桌面快捷方式")
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError, AttributeError):
        raise RuntimeError("桌面快捷方式更新结果无效") from None
    if not isinstance(data, dict) or data.get("ok") is not True or type(data.get("updated")) is not int:
        raise RuntimeError("桌面快捷方式更新未完成")
    backups = data.get("backups", [])
    if (not isinstance(backups, list) or len(backups) > 64
            or any(not isinstance(item, dict)
                   or set(item) != {"shortcut", "backup", "updated_sha256"}
                   or any(not isinstance(item[key], str)
                          for key in ("shortcut", "backup", "updated_sha256"))
                   or not re.fullmatch(r"[0-9a-fA-F]{64}", item["updated_sha256"])
                   for item in backups)):
        raise RuntimeError("桌面快捷方式备份列表无效")
    return {"updated": data["updated"], "backups": backups}


def restore_desktop_shortcuts(backups, *, backup_dir, runner=None):
    """Restore a shortcut only when it still matches the updater's saved hash."""
    if os.name != "nt":
        return {"restored": 0, "skipped": len(backups) if isinstance(backups, list) else 0}
    if not isinstance(backups, list) or len(backups) > 64:
        raise ValueError("快捷方式备份映射无效")
    normalized = []
    for item in backups:
        if (not isinstance(item, dict) or set(item) != {"shortcut", "backup", "updated_sha256"}
                or not isinstance(item.get("updated_sha256"), str)
                or not re.fullmatch(r"[0-9a-fA-F]{64}", item["updated_sha256"])):
            raise ValueError("快捷方式备份映射无效")
        shortcut = _local_path(item["shortcut"], "快捷方式路径").resolve()
        backup = _local_path(item["backup"], "快捷方式备份路径").resolve()
        if not shortcut.is_file() or not backup.is_file():
            raise ValueError("快捷方式或备份文件不存在")
        normalized.append({"shortcut": str(shortcut), "backup": str(backup),
                           "updated_sha256": item["updated_sha256"].lower()})
    backup_dir = _local_path(backup_dir, "备份目录").resolve()
    if any(not _is_under(Path(item["backup"]), backup_dir) for item in normalized):
        raise ValueError("快捷方式备份不在指定目录内")
    encode = lambda value: base64.b64encode(value.encode("utf-8")).decode("ascii")
    entries_b64 = encode(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")))
    directory_b64 = encode(str(backup_dir))
    script = rf'''
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$backupDir = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{directory_b64}'))
$entriesJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{entries_b64}'))
$entries = @($entriesJson | ConvertFrom-Json)
$desktop = [IO.Path]::GetFullPath([Environment]::GetFolderPath('Desktop')).TrimEnd('\')
$restored = 0
$skipped = 0
foreach ($entry in $entries) {{
  $shortcut = [IO.Path]::GetFullPath([string]$entry.shortcut)
  $backup = [IO.Path]::GetFullPath([string]$entry.backup)
  $insideBackup = $backup.StartsWith([IO.Path]::GetFullPath($backupDir).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
  $isDesktopLink = ([IO.Path]::GetDirectoryName($shortcut).TrimEnd('\') -ieq $desktop) -and $shortcut.EndsWith('.lnk', [StringComparison]::OrdinalIgnoreCase)
  if (!$insideBackup -or !$isDesktopLink -or !(Test-Path -LiteralPath $shortcut -PathType Leaf) -or !(Test-Path -LiteralPath $backup -PathType Leaf)) {{ $skipped++; continue }}
  $hasher = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($shortcut)
  try {{ $current = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }}
  finally {{ $stream.Dispose(); $hasher.Dispose() }}
  if ($current -cne ([string]$entry.updated_sha256).ToLowerInvariant()) {{ $skipped++; continue }}
  Copy-Item -LiteralPath $backup -Destination $shortcut -Force -ErrorAction Stop
  $restored++
}}
@{{restored=$restored; skipped=$skipped}} | ConvertTo-Json -Compress
'''
    encoded_script = base64.b64encode(script.encode("utf-16le")).decode("ascii")
    runner = runner or subprocess.run
    result = runner(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                     "-EncodedCommand", encoded_script], capture_output=True, text=True,
                    encoding="utf-8", errors="replace", timeout=20, check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode != 0:
        raise RuntimeError("快捷方式恢复失败")
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError, AttributeError):
        raise RuntimeError("快捷方式恢复结果无效") from None
    if (not isinstance(data, dict) or type(data.get("restored")) is not int
            or type(data.get("skipped")) is not int):
        raise RuntimeError("快捷方式恢复结果无效")
    return {"restored": data["restored"], "skipped": data["skipped"]}


def _read_plan(plan_path):
    plan_path = Path(plan_path).expanduser()
    if plan_path.is_symlink():
        raise ValueError("更新计划文件无效")
    plan_path = plan_path.resolve(strict=True)
    if plan_path.stat().st_size > MAX_PLAN_BYTES:
        raise ValueError("更新计划文件无效")
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError("更新计划文件无法读取") from None
    if not isinstance(plan, dict) or plan.get("version") != 1:
        raise ValueError("更新计划格式无效")
    data_dir = _local_path(plan.get("data_dir"), "数据目录").resolve()
    updates_dir = (data_dir / "updates").resolve()
    if plan_path.parent != updates_dir:
        raise ValueError("更新计划必须位于本地更新目录")
    plan["data_dir"] = str(data_dir)
    for key in ("current_exe", "helper_exe", "install_base", "result_path"):
        plan[key] = str(_local_path(plan.get(key), key))
    helper = Path(plan["helper_exe"]).resolve()
    result = Path(plan["result_path"]).resolve()
    match = re.fullmatch(r"handoff-([0-9a-f-]{36})", plan_path.stem)
    if not match:
        raise ValueError("更新计划标识无效")
    ident = match.group(1)
    try:
        if str(uuid.UUID(ident)) != ident:
            raise ValueError()
    except ValueError:
        raise ValueError("更新计划标识无效") from None
    if (helper.parent != updates_dir or result.parent != updates_dir
            or helper.name != f"update-helper-{ident}.exe"
            or result.name != f"handoff-{ident}.result.json"
            or not helper.is_file()):
        raise ValueError("更新计划中的辅助程序路径无效")
    if Path(plan["current_exe"]).suffix.lower() != ".exe" or not Path(plan["current_exe"]).is_file():
        raise ValueError("原程序文件不可用")
    if Path(plan["install_base"]).resolve() != Path(plan["current_exe"]).parent.parent.resolve():
        raise ValueError("安装目录与原程序不匹配")
    plan["port"] = _port(plan.get("port"))
    if type(plan.get("open_browser")) is not bool:
        raise ValueError("窗口启动选项无效")
    _validate_staged(plan.get("staged"), data_dir=data_dir)
    return plan


def _validate_staged(staged, *, data_dir=None):
    if not isinstance(staged, dict) or staged.get("verified") is not True or staged.get("installed") is True:
        raise ValueError("安装包尚未验证或已经安装")
    version = staged.get("version")
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise ValueError("更新版本号无效")
    archive = _local_path(staged.get("path"), "暂存安装包路径")
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("暂存安装包不存在")
    if data_dir is not None:
        staging = (Path(data_dir) / "updates" / "staged").resolve()
        if not _is_under(archive.resolve(), staging):
            raise ValueError("暂存安装包必须位于应用的本地更新目录")
    for field in ("bytes", "exe_bytes"):
        number = staged.get(field)
        if type(number) is not int or number < 1:
            raise ValueError("暂存安装包清单不完整")
    for field in ("sha256", "exe_sha256"):
        value = staged.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", value):
            raise ValueError("暂存安装包校验值无效")


def _validate_prepared(prepared, plan):
    if not isinstance(prepared, dict) or prepared.get("verified") is not True or prepared.get("installed") is not False:
        raise ValueError("新版本尚未通过安装校验")
    version = prepared.get("version")
    if version != plan["staged"]["version"]:
        raise ValueError("新版本与暂存清单版本不一致")
    path = _local_path(prepared.get("path"), "候选程序路径")
    if path.suffix.lower() != ".exe" or not path.is_file():
        raise ValueError("候选程序文件不存在")
    size, digest = prepared.get("bytes"), prepared.get("sha256")
    if type(size) is not int or size < 1 or path.stat().st_size != size:
        raise ValueError("候选程序大小与校验结果不一致")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
        raise ValueError("候选程序 SHA-256 无效")
    if _sha256_file(path).lower() != digest.lower():
        raise ValueError("候选程序 SHA-256 校验失败")
    if path.resolve() == Path(plan["current_exe"]).resolve():
        raise ValueError("候选程序路径仍指向当前版本")
    expected = Path(plan["install_base"]).resolve() / f"PrismCanvas-{version}" / "PrismCanvas.exe"
    if path.resolve() != expected:
        raise ValueError("候选程序不在安全的版本目录中")
    return {"path": str(path), "version": version}


def _wait_for_lock(data_dir, lock_factory, timeout, *, sleep_fn, monotonic_fn):
    if not isinstance(timeout, (int, float)) or timeout < 0 or timeout > 600:
        raise ValueError("实例等待时间无效")
    deadline = monotonic_fn() + timeout
    while True:
        lock = lock_factory(Path(data_dir))
        if lock.acquire():
            return lock
        if monotonic_fn() >= deadline:
            return None
        sleep_fn(min(0.1, max(0.01, deadline - monotonic_fn())))


def _wait_for_candidate(port, version, probe_fn, timeout, *, sleep_fn, monotonic_fn):
    if not isinstance(timeout, (int, float)) or timeout < 0 or timeout > 180:
        raise ValueError("候选程序检查时限无效")
    deadline = monotonic_fn() + timeout
    while True:
        response = probe_fn(port, version)
        if _candidate_identity(response, version):
            return response
        if monotonic_fn() >= deadline:
            return None
        sleep_fn(min(0.25, max(0.01, deadline - monotonic_fn())))


def _probe_candidate(port, version):
    """Return an identity-bearing bootstrap payload, keeping its token private."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=0.75)
    try:
        connection.request("GET", "/api/bootstrap", headers={
            "Host": f"127.0.0.1:{port}", "Accept": "application/json", "Connection": "close",
        })
        response = connection.getresponse()
        if response.status != 200 or not response.getheader("Content-Type", "").lower().startswith("application/json"):
            return None
        length = response.getheader("Content-Length")
        if length and (not length.isdigit() or int(length) > 65536):
            return None
        raw = response.read(65537)
        if len(raw) > 65536:
            return None
        payload = json.loads(raw.decode("utf-8"))
        if _candidate_identity(payload, version):
            return payload
        return None
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def _candidate_identity(payload, version):
    return (isinstance(payload, dict) and payload.get("application") == "PrismCanvas"
            and payload.get("version") == version and isinstance(payload.get("csrf"), str)
            and bool(_CSRF.fullmatch(payload["csrf"])))


def _shutdown_confirmed_candidate(port, version, csrf, *, probe_fn, port_in_use_fn,
                                  sleep_fn, monotonic_fn):
    """Shutdown only the exact healthy candidate whose token was just observed."""
    if not isinstance(csrf, str) or not _CSRF.fullmatch(csrf):
        return False
    current = probe_fn(port, version)
    if (not _candidate_identity(current, version)
            or not hmac.compare_digest(current["csrf"], csrf)):
        return False
    if not _post_shutdown(port, csrf):
        return False
    deadline = monotonic_fn() + SHUTDOWN_WAIT_SECONDS
    while port_in_use_fn(port):
        if monotonic_fn() >= deadline:
            return False
        sleep_fn(0.1)
    return True


def _post_shutdown(port, csrf):
    body = b"{}"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("POST", "/api/shutdown", body=body, headers={
            "Host": f"127.0.0.1:{port}", "Origin": f"http://127.0.0.1:{port}",
            "X-FW-Token": csrf, "Content-Type": "application/json",
            "Content-Length": str(len(body)), "Connection": "close",
        })
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            return False
        payload = json.loads(raw.decode("utf-8"))
        return isinstance(payload, dict) and payload.get("ok") is True
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def _port_in_use(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


def _safe_port_in_use(port_in_use_fn, port):
    try:
        return bool(port_in_use_fn(port))
    except Exception:
        # If listener state cannot be established, treat the port as occupied.
        return True


def _spawn_candidate(executable, data_dir, port, open_browser, log_path, spawn):
    executable = str(Path(executable))
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    arguments = [executable, "--data-dir", str(data_dir), "--port", str(port)]
    if not open_browser:
        arguments.append("--no-browser")
    options = {
        "cwd": str(Path(executable).parent), "stdin": subprocess.DEVNULL,
        "stderr": subprocess.STDOUT, "shell": False, "close_fds": True,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
    }
    if os.name != "nt":
        options["start_new_session"] = True
    options["env"] = _pyinstaller_environment()
    with Path(log_path).open("ab", buffering=0) as stream:
        options["stdout"] = stream
        return spawn(arguments, **options)


def _spawn_helper(helper, plan, log_path):
    options = {
        "cwd": str(Path(helper).parent), "stdin": subprocess.DEVNULL,
        "stderr": subprocess.STDOUT, "shell": False, "close_fds": True,
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
    }
    if os.name != "nt":
        options["start_new_session"] = True
    options["env"] = _pyinstaller_environment()
    with Path(log_path).open("ab", buffering=0) as stream:
        options["stdout"] = stream
        subprocess.Popen([str(helper), "--apply-update", str(plan)], **options)


def _copy_current_exe(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp")
    try:
        with Path(source).open("rb") as reader, temporary.open("xb") as writer:
            shutil.copyfileobj(reader, writer, 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        if Path(source).stat().st_size != temporary.stat().st_size:
            raise OSError("辅助程序复制后大小不一致")
        os.replace(temporary, destination)
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _write_json_atomic(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            Path(temporary).unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _finish(path, result):
    if path is None:
        return result
    try:
        _write_json_atomic(path, result)
    except OSError:
        pass
    return result


def _local_path(value, label):
    if not isinstance(value, (str, os.PathLike)):
        raise ValueError(f"{label}无效")
    text = os.fspath(value)
    if not text or "\x00" in text or len(text) > 4096:
        raise ValueError(f"{label}无效")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label}必须是绝对路径")
    return Path(os.path.normpath(path))


def _port(value):
    if type(value) is not int or not 1 <= value <= 65535:
        raise ValueError("端口必须在 1 到 65535 之间")
    return value


def _is_under(path, parent):
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _process_exited(process):
    try:
        return process.poll() is not None
    except (AttributeError, OSError, ValueError):
        return True


def _sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_error(exc):
    text = "".join(char for char in str(exc) if char.isprintable()).strip()
    return (text or exc.__class__.__name__)[:300]


def _pyinstaller_environment():
    """Make a restarted one-file EXE unpack as an independent application."""
    environment = os.environ.copy()
    environment["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    return environment
