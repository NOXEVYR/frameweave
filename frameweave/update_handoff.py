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
import secrets
import sys

from . import __version__
from .instance import InstanceLock, _FileLock
from .updates import compare_versions


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
    if compare_versions(staged["version"], __version__) <= 0:
        raise ValueError("更新版本必须严格高于当前版本")
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
        "install_base": str(_install_base(current_exe)),
        "current_version": __version__,
        "current_sha256": _sha256_file(current_exe),
        "candidate_nonce": secrets.token_hex(32),
        "old_processes": _owned_processes(current_exe),
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
                spawn=None, probe_fn=None, port_in_use_fn=None, metadata_fn=None,
                process_wait_fn=None, shortcut_fn=None, restore_shortcuts_fn=None,
                sleep_fn=None, monotonic_fn=None,
                health_timeout=HEALTH_WAIT_SECONDS, lock_timeout=LOCK_WAIT_SECONDS):
    """Execute one durable transaction. Interrupted launches are never repeated.

    Probe and process dependencies remain injectable; no path kills a process.
    A transaction journal stores phases before mutations, without CSRF tokens.
    """
    lock_factory = lock_factory or InstanceLock
    if prepare_install_fn is None:
        from .update_install import prepare_install as prepare_install_fn
    spawn = spawn or subprocess.Popen
    probe_fn = probe_fn or _probe_candidate
    metadata_fn = metadata_fn or _read_instance_metadata
    process_wait_fn = process_wait_fn or _wait_owned_processes
    port_in_use_fn = port_in_use_fn or _port_in_use
    shortcut_fn = shortcut_fn or update_desktop_shortcuts
    restore_shortcuts_fn = restore_shortcuts_fn or restore_desktop_shortcuts
    sleep_fn = sleep_fn or time.sleep
    monotonic_fn = monotonic_fn or time.monotonic
    plan = None
    result_path = None
    journal_path = None
    transaction_lock = None
    lock = None
    candidate_process = None
    old_recovery_attempted = False
    ready_for_recovery = False
    journal = {}

    def phase(name, **details):
        journal.update(details)
        journal["phase"] = name
        _write_json_atomic(journal_path, journal)

    def finish(state, message, **details):
        result = {"state": state, "version": plan["staged"]["version"],
                  "message": message, **details}
        phase("finished", result=result)
        return _finish(result_path, result)

    def identity(payload, version, executable, nonce=None):
        try:
            metadata = metadata_fn(Path(plan["data_dir"]))
            return _bound_identity(payload, metadata, version, executable,
                                   plan["data_dir"], plan["port"], nonce)
        except (OSError, ValueError, TypeError):
            return False

    def wait_healthy(version, executable, nonce=None):
        return _wait_for_candidate(
            plan["port"], version, probe_fn, health_timeout,
            sleep_fn=sleep_fn, monotonic_fn=monotonic_fn,
            identity_fn=lambda payload: identity(payload, version, executable, nonce),
        )

    def recover(state, message):
        nonlocal lock, old_recovery_attempted
        if old_recovery_attempted:
            return finish("recovery-unverified", "原版本重启已经尝试，未重复启动")
        # One-file bootloader parents can outlive the Python service. Waiting
        # for the exact Popen handle plus the data lock prevents overlapping it.
        if candidate_process is not None and not _process_exited(candidate_process):
            return finish("candidate-unverified", "候选进程尚未确认退出，未启动原版本")
        if lock is None:
            lock = _wait_for_lock(plan["data_dir"], lock_factory, lock_timeout,
                                  sleep_fn=sleep_fn, monotonic_fn=monotonic_fn)
        if lock is None or _safe_port_in_use(port_in_use_fn, plan["port"]):
            return finish("recovery-blocked", "实例或端口状态不明，未启动原版本")
        if _sha256_file(plan["current_exe"]) != plan["current_sha256"]:
            return finish("recovery-blocked", "原程序发生变化，未启动未经核验的文件")
        phase("recovering-old")
        lock.release()
        lock = None
        old_recovery_attempted = True
        _spawn_candidate(plan["current_exe"], plan["data_dir"], plan["port"],
                         plan["open_browser"], Path(plan["data_dir"]) / "updates" /
                         "previous-version-recovery.log", spawn)
        if wait_healthy(plan["current_version"], plan["current_exe"]) is None:
            return finish("recovery-unverified", "已尝试重启原版本，但尚未核验其服务和实例身份")
        return finish(state, message)

    try:
        plan = _read_plan(plan_path)
        result_path = Path(plan["result_path"])
        journal_path = result_path.with_name(result_path.name.replace(".result.json", ".transaction.json"))
        transaction_lock = _FileLock(journal_path.with_suffix(".lock"))
        if not transaction_lock.acquire():
            return {"state": "transaction-busy", "message": "该更新交接正在执行"}
        if journal_path.exists():
            previous = _read_private_json(journal_path)
            if previous.get("phase") == "finished" and isinstance(previous.get("result"), dict):
                return _finish(result_path, previous["result"])
            # A crash may have occurred after spawn or shortcut mutation. Keep
            # the evidence for explicit recovery instead of replaying commands.
            return _finish(result_path, {"state": "transaction-interrupted",
                           "version": plan["staged"]["version"],
                           "message": "上次交接中断，已保留阶段记录；未重复启动或切换快捷方式"})
        journal = {"handoff_id": Path(plan_path).stem, "candidate_version": plan["staged"]["version"],
                   "previous_version": plan["current_version"], "previous_exe": plan["current_exe"],
                   "previous_sha256": plan["current_sha256"]}
        phase("waiting-old")
        lock = _wait_for_lock(plan["data_dir"], lock_factory, lock_timeout,
                              sleep_fn=sleep_fn, monotonic_fn=monotonic_fn)
        if lock is None:
            return finish("instance-busy", "棱光仍在运行，更新尚未切换")
        if not process_wait_fn(plan["old_processes"], lock_timeout,
                               sleep_fn=sleep_fn, monotonic_fn=monotonic_fn):
            return finish("instance-busy", "原版本进程尚未完全退出，未安装候选程序")
        if _safe_port_in_use(port_in_use_fn, plan["port"]):
            return finish("port-occupied", "目标端口已有服务，未安装或启动候选程序")
        ready_for_recovery = True
        phase("preparing")
        prepared = prepare_install_fn(plan["staged"], plan["install_base"], plan["current_exe"])
        candidate = _validate_prepared(prepared, plan)
        phase("prepared", candidate_exe=candidate["path"], candidate_sha256=prepared["sha256"])
        if _safe_port_in_use(port_in_use_fn, plan["port"]):
            return finish("port-occupied", "目标端口已有服务，未启动候选程序")
        phase("launching-candidate")
        lock.release()
        lock = None
        candidate_process = _spawn_candidate(
            candidate["path"], plan["data_dir"], plan["port"], plan["open_browser"],
            Path(plan["data_dir"]) / "updates" / f"candidate-{candidate['version']}.log", spawn,
            nonce=plan["candidate_nonce"],
        )
        phase("checking-candidate")
        healthy = wait_healthy(candidate["version"], candidate["path"], plan["candidate_nonce"])
        if healthy is None:
            return recover("recovered-old-version", "候选检查失败，已核验原版本恢复")
        phase("switching-shortcuts")
        try:
            shortcut_result = shortcut_fn(
                plan["current_exe"], candidate["path"], candidate["version"],
                backup_dir=Path(plan["data_dir"]) / "updates" / "shortcut-backups",
            )
        except Exception:
            stopped = _shutdown_confirmed_candidate(
                plan["port"], candidate["version"], healthy.get("csrf"),
                probe_fn=probe_fn, port_in_use_fn=port_in_use_fn,
                sleep_fn=sleep_fn, monotonic_fn=monotonic_fn,
                identity_fn=lambda payload: identity(payload, candidate["version"],
                                                     candidate["path"], plan["candidate_nonce"]),
            )
            if stopped:
                _wait_process_exit(candidate_process, SHUTDOWN_WAIT_SECONDS, sleep_fn, monotonic_fn)
                return recover("rolled-back", "快捷方式切换失败，已核验原版本回退")
            return finish("shortcut-failed", "候选服务已核验，但快捷方式切换失败；未关闭身份不明的进程")
        backups = list(shortcut_result.get("backups", []))[:64]
        phase("checking-after-shortcuts", shortcut_backups=backups)
        final_health = probe_fn(plan["port"], candidate["version"])
        if (not identity(final_health, candidate["version"], candidate["path"], plan["candidate_nonce"])
                or not hmac.compare_digest(final_health["csrf"], healthy["csrf"])):
            phase("restoring-shortcuts")
            try:
                restored = restore_shortcuts_fn(backups, backup_dir=Path(plan["data_dir"]) /
                                                "updates" / "shortcut-backups").get("restored", 0)
                phase("shortcuts-restored", shortcuts_restored=restored)
            except Exception:
                return finish("shortcut-restore-failed", "候选二次检查失败，快捷方式恢复未完成；未启动原版本")
            return recover("recovered-old-version", "候选在切换后退出，已核验原版本恢复")
        return finish("installed", "候选程序及同一数据目录的实例身份已通过检查",
                      shortcuts_updated=int(shortcut_result.get("updated", 0)), shortcut_backups=backups)
    except Exception as exc:
        if plan is not None and journal_path is not None:
            try:
                if ready_for_recovery and candidate_process is None and not old_recovery_attempted:
                    return recover("recovered-old-version", "更新准备失败，已核验原版本恢复")
                return finish("failed", _safe_error(exc))
            except Exception:
                pass
        return {"state": "failed", "message": "更新交接失败，已保留已有程序与事务记录"}
    finally:
        for held in (lock, transaction_lock):
            if held is not None:
                try:
                    held.release()
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
    if Path(plan["install_base"]).resolve() != _install_base(Path(plan["current_exe"])):
        raise ValueError("安装目录与原程序不匹配")
    if not isinstance(plan.get("current_version"), str) or not _VERSION.fullmatch(plan["current_version"]):
        raise ValueError("原版本身份缺失")
    if compare_versions(plan["staged"].get("version"), plan["current_version"]) <= 0:
        raise ValueError("更新版本必须严格高于原版本")
    if (not isinstance(plan.get("current_sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", plan["current_sha256"])
            or _sha256_file(plan["current_exe"]) != plan["current_sha256"]):
        raise ValueError("原程序与交接记录不一致")
    if not isinstance(plan.get("candidate_nonce"), str) or not re.fullmatch(r"[0-9a-f]{64}", plan["candidate_nonce"]):
        raise ValueError("候选启动身份缺失")
    if not isinstance(plan.get("old_processes"), list) or len(plan["old_processes"]) > 2:
        raise ValueError("原版本进程记录无效")
    for process in plan["old_processes"]:
        if (not isinstance(process, dict) or type(process.get("pid")) is not int or process["pid"] < 1
                or type(process.get("created")) is not int or process["created"] < 1
                or process.get("executable") != str(Path(plan["current_exe"]).resolve())):
            raise ValueError("原版本进程记录无效")
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
    if size != plan["staged"]["exe_bytes"] or digest.lower() != plan["staged"]["exe_sha256"].lower():
        raise ValueError("候选程序与暂存发布清单不一致")
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


def _wait_for_candidate(port, version, probe_fn, timeout, *, sleep_fn, monotonic_fn, identity_fn=None):
    if not isinstance(timeout, (int, float)) or timeout < 0 or timeout > 180:
        raise ValueError("候选程序检查时限无效")
    deadline = monotonic_fn() + timeout
    while True:
        response = probe_fn(port, version)
        if (identity_fn(response) if identity_fn else _candidate_identity(response, version)):
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


def _read_private_json(path):
    path = Path(path)
    if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
        raise ValueError("本地身份记录不是普通文件")
    if path.stat().st_size > MAX_PLAN_BYTES:
        raise ValueError("本地身份记录过大")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("本地身份记录无效")
    return payload


def _read_instance_metadata(data_dir):
    return _read_private_json(Path(data_dir) / "instance.json")


def _bound_identity(payload, metadata, version, executable, data_dir, port, nonce):
    """Bind bootstrap to the lock owner's durable record and launch request."""
    if not _candidate_identity(payload, version) or not isinstance(metadata, dict):
        return False
    instance = payload.get("instance")
    if not isinstance(instance, dict) or not isinstance(metadata.get("instance"), dict):
        return False
    if instance != metadata["instance"] or metadata.get("version") != version:
        return False
    if (type(instance.get("pid")) is not int or instance["pid"] < 1
            or metadata.get("pid") != instance["pid"]
            or metadata.get("url") != f"http://127.0.0.1:{port}/"):
        return False
    try:
        if (_local_path(instance.get("executable"), "实例程序").resolve() != Path(executable).resolve()
                or _local_path(instance.get("data_dir"), "实例数据目录").resolve() != Path(data_dir).resolve()):
            return False
    except (ValueError, OSError):
        return False
    if nonce is not None:
        return (isinstance(instance.get("nonce"), str)
                and hmac.compare_digest(instance["nonce"], nonce))
    # Rollback receives no new nonce, but its process must have independently
    # published the matching executable/data-dir identity after acquiring lock.
    return True


def _install_base(executable):
    executable = Path(executable).resolve()
    parent = executable.parent
    if re.fullmatch(r"(?:PrismCanvas-)?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", parent.name):
        return parent.parent
    return parent


def _native_process_identity(pid):
    """Read a Windows process's creation time/image; never terminate it."""
    if os.name != "nt":
        raise OSError("进程身份检查只支持 Windows EXE 交接")
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        error = ctypes.get_last_error()
        if error == 87:  # ERROR_INVALID_PARAMETER: process is gone.
            return None
        raise OSError(error, "无法核验原版本进程身份")
    try:
        code = wintypes.DWORD()
        if not kernel.GetExitCodeProcess(handle, ctypes.byref(code)):
            raise OSError("无法核验原版本进程状态")
        if code.value != 259:
            return None
        created, exited, system, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in (created, exited, system, user))):
            raise OSError("无法核验原版本进程创建时间")
        capacity = wintypes.DWORD(32768)
        image = ctypes.create_unicode_buffer(capacity.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(capacity)):
            raise OSError("无法核验原版本程序路径")
        return {"pid": pid, "created": (created.dwHighDateTime << 32) | created.dwLowDateTime,
                "executable": str(Path(image.value).resolve())}
    finally:
        kernel.CloseHandle(handle)


def _owned_processes(executable):
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return []
    own = _native_process_identity(os.getpid())
    if own is None or Path(own["executable"]) != Path(executable).resolve():
        raise ValueError("当前 EXE 与运行进程不一致")
    result = [own]
    # PyInstaller one-file bootloader uses a second parent with the same image.
    parent = _native_process_identity(os.getppid())
    if parent is not None and Path(parent["executable"]) == Path(own["executable"]):
        result.append(parent)
    for process in result:
        process["executable"] = str(Path(executable).resolve())
    return result


def _wait_owned_processes(processes, timeout, *, sleep_fn, monotonic_fn):
    deadline = monotonic_fn() + timeout
    while True:
        try:
            alive = False
            for expected in processes:
                current = _native_process_identity(expected["pid"])
                if (current is not None and current["created"] == expected["created"]
                        and Path(current["executable"]) == Path(expected["executable"])):
                    alive = True
        except OSError:
            return False
        if not alive:
            return True
        if monotonic_fn() >= deadline:
            return False
        sleep_fn(0.1)


def _wait_process_exit(process, timeout, sleep_fn, monotonic_fn):
    deadline = monotonic_fn() + timeout
    while not _process_exited(process):
        if monotonic_fn() >= deadline:
            return False
        sleep_fn(0.1)
    return True


def _shutdown_confirmed_candidate(port, version, csrf, *, probe_fn, port_in_use_fn,
                                  sleep_fn, monotonic_fn, identity_fn=None):
    """Shutdown only the exact healthy candidate whose token was just observed."""
    if not isinstance(csrf, str) or not _CSRF.fullmatch(csrf):
        return False
    current = probe_fn(port, version)
    if (not (identity_fn(current) if identity_fn else _candidate_identity(current, version))
            or not hmac.compare_digest(current["csrf"], csrf)):
        return False
    if not _post_shutdown(port, csrf):
        return False
    deadline = monotonic_fn() + SHUTDOWN_WAIT_SECONDS
    while _safe_port_in_use(port_in_use_fn, port):
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


def _spawn_candidate(executable, data_dir, port, open_browser, log_path, spawn, *, nonce=None):
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
    options["env"].pop("PRISMCANVAS_UPDATE_NONCE", None)
    if nonce is not None:
        options["env"]["PRISMCANVAS_UPDATE_NONCE"] = nonce
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
        if _sha256_file(source) != _sha256_file(temporary):
            raise OSError("辅助程序复制后 SHA-256 不一致")
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
        return False


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
