"""Prepare a verified PrismCanvas executable beside the current installation.

Installation switching and restart are intentionally left to the application
host.  This module only verifies a staged archive and publishes a new,
version-specific candidate directory without replacing an existing version.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from .updates import UpdateError, _parse_version, _validate_portable_zip


_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_EXE_NAMES = {"prismcanvas.exe"}


def prepare_install(
    staged_state: dict[str, Any],
    install_base: str | os.PathLike[str],
    current_exe: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Create a new version directory containing only PrismCanvas.exe.

    ``staged_state`` must be the verified object returned by ``UpdateManager``.
    Its archive hash is recomputed, its ZIP structure and CRCs are inspected,
    and the only extracted executable must match the manifest's size and hash.
    An existing candidate directory is never overwritten.
    """
    if not isinstance(staged_state, dict) or staged_state.get("verified") is not True:
        raise UpdateError("安装包尚未通过更新校验")
    if staged_state.get("installed") is True:
        raise UpdateError("该候选包已标记为安装")
    version = staged_state.get("version")
    _parse_version(version)
    version = str(version).removeprefix("v")

    archive_path = Path(staged_state.get("path", ""))
    if archive_path.is_symlink() or not archive_path.is_file():
        raise UpdateError("暂存安装包不存在或不是普通文件")
    archive_bytes = _positive_int(staged_state.get("bytes"), "暂存安装包大小无效")
    archive_sha = _valid_sha(staged_state.get("sha256"), "暂存安装包 SHA-256 无效")
    if archive_path.stat().st_size != archive_bytes or _sha256_file(archive_path) != archive_sha:
        raise UpdateError("暂存安装包与已验证清单不一致")

    exe_bytes = _positive_int(staged_state.get("exe_bytes"), "清单 EXE 大小无效")
    exe_sha = _valid_sha(staged_state.get("exe_sha256"), "清单 EXE SHA-256 无效")
    _validate_portable_zip(archive_path)

    install_root = Path(install_base).resolve()
    install_root.mkdir(parents=True, exist_ok=True)
    candidate_dir = install_root / f"PrismCanvas-{version}"
    candidate_exe = candidate_dir / "PrismCanvas.exe"
    old_exe = Path(current_exe).resolve() if current_exe is not None else None
    if old_exe is not None and old_exe == candidate_exe.resolve(strict=False):
        raise UpdateError("候选路径指向当前运行版本")
    reuse_candidate = candidate_dir.exists()
    if candidate_dir.is_symlink() or (reuse_candidate and (
        getattr(candidate_dir.lstat(), "st_file_attributes", 0) & 0x400
        or not candidate_dir.is_dir()
        or candidate_exe.is_symlink()
        or not candidate_exe.is_file()
        or getattr(candidate_exe.lstat(), "st_file_attributes", 0) & 0x400
        or candidate_exe.stat().st_size != exe_bytes
        or _sha256_file(candidate_exe) != exe_sha
    )):
        raise UpdateError("目标版本目录已存在且校验不匹配，未覆盖旧文件")

    exe_member: zipfile.ZipInfo | None = None
    try:
        with zipfile.ZipFile(archive_path, "r") as archive:
            matches = [
                member for member in archive.infolist()
                if not member.is_dir() and Path(member.filename).name.casefold() in _EXE_NAMES
            ]
            if len(matches) != 1:
                raise UpdateError("安装包必须且只能包含一个 PrismCanvas.exe")
            exe_member = matches[0]
            mode = (exe_member.external_attr >> 16) & 0xFFFF
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                raise UpdateError("安装包中的 EXE 不是普通文件")
            if exe_member.file_size != exe_bytes:
                raise UpdateError("EXE 大小与发布清单不一致")

            temp_dir = Path(tempfile.mkdtemp(prefix=f".PrismCanvas-{version}-", dir=install_root))
            temp_exe = temp_dir / "PrismCanvas.exe"
            try:
                digest = hashlib.sha256()
                total = 0
                with archive.open(exe_member, "r") as source, temp_exe.open("xb") as output:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > exe_bytes:
                            raise UpdateError("EXE 超过清单声明大小")
                        digest.update(chunk)
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
                if total != exe_bytes or digest.hexdigest() != exe_sha:
                    raise UpdateError("EXE SHA-256 或大小与发布清单不一致")

                # mkdir is an atomic no-overwrite reservation on supported hosts.
                if not reuse_candidate:
                    candidate_dir.mkdir()
                    try:
                        os.rename(temp_exe, candidate_exe)
                    except Exception:
                        candidate_dir.rmdir()
                        raise
                elif candidate_exe.stat().st_size != exe_bytes or _sha256_file(candidate_exe) != exe_sha:
                    raise UpdateError("重试期间候选程序发生变化，安装已停止")
            finally:
                try:
                    temp_exe.unlink(missing_ok=True)
                    temp_dir.rmdir()
                except OSError:
                    pass
    except UpdateError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as exc:
        raise UpdateError(_message(exc)) from exc

    return {
        "version": version,
        "path": str(candidate_exe.resolve()),
        "bytes": exe_bytes,
        "sha256": exe_sha,
        "verified": True,
        "installed": False,
        "previous_exe": str(old_exe) if old_exe is not None else None,
    }


def _positive_int(value: Any, message: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise UpdateError(message)
    return value


def _valid_sha(value: Any, message: str) -> str:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise UpdateError(message)
    return value.lower()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _message(exc: BaseException) -> str:
    message = str(exc).strip()
    return message[:300] if message else exc.__class__.__name__
