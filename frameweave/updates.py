"""Small, verified update discovery and staging for PrismCanvas.

This module deliberately stops before installation.  The running executable,
backup policy, idle detection, and restart belong to the application host.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import tempfile
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit


MANIFEST_URL = (
    "https://raw.githubusercontent.com/NOXEVYR/frameweave/main/"
    "releases/release-manifest.json"
)
RAW_RELEASES_PREFIX = (
    "https://raw.githubusercontent.com/NOXEVYR/frameweave/main/releases/"
)
GITHUB_RELEASES_PREFIX = (
    "https://github.com/NOXEVYR/frameweave/releases/download/"
)

MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_FILES = 2_000
MAX_UNPACKED_BYTES = 256 * 1024 * 1024
MAX_SINGLE_FILE_BYTES = 128 * 1024 * 1024
MAX_COMPRESSION_RATIO = 250

_VERSION_RE = re.compile(
    r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_WINDOWS_ARCHIVE_RE = re.compile(
    r"^(?:PrismCanvas|FrameWeave)-v?"
    r"(?P<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z.-]+)?)-Windows-x64\.zip$"
)
_WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


class UpdateError(RuntimeError):
    """An update could not be safely checked or staged."""


def compare_versions(left: str, right: str) -> int:
    """Compare supported SemVer versions; build metadata is ignored."""
    a = _parse_version(left)
    b = _parse_version(right)
    core_a, pre_a = a
    core_b, pre_b = b
    if core_a != core_b:
        return (core_a > core_b) - (core_a < core_b)
    if pre_a is None and pre_b is None:
        return 0
    if pre_a is None:
        return 1
    if pre_b is None:
        return -1
    for item_a, item_b in zip(pre_a, pre_b):
        if item_a == item_b:
            continue
        if isinstance(item_a, int) and isinstance(item_b, str):
            return -1
        if isinstance(item_a, str) and isinstance(item_b, int):
            return 1
        return (item_a > item_b) - (item_a < item_b)
    return (len(pre_a) > len(pre_b)) - (len(pre_a) < len(pre_b))


def _parse_version(value: str) -> tuple[tuple[int, int, int], tuple[int | str, ...] | None]:
    if not isinstance(value, str):
        raise UpdateError("版本号格式无效")
    match = _VERSION_RE.fullmatch(value.strip())
    if not match:
        raise UpdateError("版本号格式无效")
    core = tuple(int(match.group(i)) for i in (1, 2, 3))
    raw_pre = match.group(4)
    if raw_pre is None:
        return core, None
    parts = raw_pre.split(".")
    if any(not part or (part.isdigit() and len(part) > 1 and part.startswith("0")) for part in parts):
        raise UpdateError("预发布版本号格式无效")
    prerelease: tuple[int | str, ...] = tuple(
        int(part) if part.isdigit() else part for part in parts
    )
    return core, prerelease


def _validate_url(url: str) -> str:
    """Allow only the repository's immutable release locations."""
    if not isinstance(url, str) or len(url) > 2_048 or "%" in url:
        raise UpdateError("更新地址不在允许范围内")
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or parts.username is not None
        or parts.password is not None
        or parts.port is not None
        or parts.query
        or parts.fragment
    ):
        raise UpdateError("更新地址不在允许范围内")
    path = unquote(parts.path)
    if parts.netloc.lower() == "raw.githubusercontent.com":
        if not path.startswith("/NOXEVYR/frameweave/main/releases/"):
            raise UpdateError("更新地址不在允许范围内")
    elif parts.netloc.lower() == "github.com":
        if not path.startswith("/NOXEVYR/frameweave/releases/download/"):
            raise UpdateError("更新地址不在允许范围内")
        tail = path.removeprefix("/NOXEVYR/frameweave/releases/download/")
        if len(tail.split("/")) != 2 or any(p in ("", ".", "..") for p in tail.split("/")):
            raise UpdateError("更新地址不在允许范围内")
    else:
        raise UpdateError("更新地址不在允许范围内")
    if any(segment in (".", "..") for segment in path.split("/")):
        raise UpdateError("更新地址不在允许范围内")
    return url


class _AllowlistedRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _validate_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class UpdateManager:
    """Check a pinned project feed and atomically stage a verified ZIP.

    ``auto_check`` is a persisted preference owned by the caller.  This class
    never schedules or performs background network access on its own.
    """

    def __init__(
        self,
        current_version: str,
        data_dir: str | os.PathLike[str],
        *,
        auto_check: bool = False,
        timeout: float = 10.0,
        manifest_url: str = MANIFEST_URL,
        max_manifest_bytes: int = MAX_MANIFEST_BYTES,
        max_archive_bytes: int = MAX_ARCHIVE_BYTES,
        opener: Any = None,
    ) -> None:
        _parse_version(current_version)
        if not 0.1 <= float(timeout) <= 60:
            raise ValueError("timeout must be between 0.1 and 60 seconds")
        if not 1 <= int(max_manifest_bytes) <= MAX_MANIFEST_BYTES:
            raise ValueError("max_manifest_bytes exceeds the supported limit")
        if not 1 <= int(max_archive_bytes) <= MAX_ARCHIVE_BYTES:
            raise ValueError("max_archive_bytes exceeds the supported limit")
        self.current_version = current_version.lstrip("v")
        self.data_dir = Path(data_dir)
        self.staging_dir = self.data_dir / "updates" / "staged"
        self.auto_check = bool(auto_check)
        self.timeout = float(timeout)
        self.manifest_url = _validate_url(manifest_url)
        self.max_manifest_bytes = int(max_manifest_bytes)
        self.max_archive_bytes = int(max_archive_bytes)
        self._opener = opener
        self._last_checked: str | None = None
        self._last_error: str | None = None
        self._release: dict[str, Any] | None = None
        self._staged: dict[str, Any] | None = None

    def set_auto_check(self, enabled: bool) -> dict[str, Any]:
        """Change the in-memory preference; caller persists it in app settings."""
        self.auto_check = bool(enabled)
        return self.status()

    def status(self) -> dict[str, Any]:
        """Return local state only; this method does not contact the network."""
        release = self._release or {}
        return {
            "current_version": self.current_version,
            "auto_check": self.auto_check,
            "last_checked": self._last_checked,
            "latest_version": release.get("version"),
            "update_available": bool(release.get("update_available", False)),
            "available": bool(release.get("update_available", False)),
            "new_version": release.get("version") if release.get("update_available") else None,
            "release": self._public_release(release) if release else None,
            "staged": dict(self._staged) if self._staged else None,
            "last_error": self._last_error,
        }

    def check(self) -> dict[str, Any]:
        """Explicitly fetch and validate the current manifest."""
        self._last_checked = _utc_now()
        self._last_error = None
        try:
            payload = self._fetch_bytes(self.manifest_url, self.max_manifest_bytes)
            manifest = _decode_manifest(payload)
            release = self._select_release(manifest)
            release["update_available"] = compare_versions(
                release["version"], self.current_version
            ) > 0
            self._release = release
        except UpdateError as exc:
            self._last_error = str(exc)
            raise
        except (OSError, urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            self._last_error = _error_message(exc)
            raise UpdateError(self._last_error) from exc
        return self.status()

    def stage(self) -> dict[str, Any]:
        """Download, hash-check and inspect the latest portable ZIP.

        Returns verified staging metadata only.  It does not extract, install,
        replace, terminate, or restart the application.
        """
        if self._release is None:
            self.check()
        release = self._release
        if not release or not release.get("update_available"):
            raise UpdateError("当前没有可暂存的新版本")

        if self._staged and self._staged.get('version') == release['version']:
            try:
                info = self._verify_existing_stage(Path(self._staged['path']), release)
            except (UpdateError, OSError):
                pass
            else:
                if self._staged.get('recovery_note'):
                    info['recovery_note'] = self._staged['recovery_note']
                self._staged, self._last_error = info, None
                return self.status()

        self.staging_dir.mkdir(parents=True, exist_ok=True)
        filename = release["name"]
        destination = self.staging_dir / filename
        recovery_note = ''
        if destination.exists():
            try:
                info = self._verify_existing_stage(destination, release)
            except UpdateError:
                # Preserve the existing bytes and retry in a new owned directory.
                # Never delete or rename a potentially user-supplied old file.
                destination = Path(tempfile.mkdtemp(prefix='retry-', dir=self.staging_dir)) / filename
                recovery_note = '原暂存包校验失败，已原样保留；本次下载使用新的暂存目录。'
            else:
                self._staged = info
                self._last_error = None
                return self.status()

        temp_path: Path | None = None
        try:
            fd, temp_name = tempfile.mkstemp(prefix=f".{filename}.", suffix=".part", dir=self.staging_dir)
            temp_path = Path(temp_name)
            digest = hashlib.sha256()
            total = 0
            with os.fdopen(fd, "wb") as output:
                with self._open(release["url"]) as response:
                    content_length = response.headers.get("Content-Length")
                    if content_length is not None:
                        try:
                            announced = int(content_length)
                        except (TypeError, ValueError) as exc:
                            raise UpdateError("下载大小标头无效") from exc
                        if announced != release["bytes"]:
                            raise UpdateError("下载大小与发布清单不一致")
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > self.max_archive_bytes or total > release["bytes"]:
                            raise UpdateError("下载文件超过清单大小限制")
                        digest.update(chunk)
                        output.write(chunk)
                output.flush()
                os.fsync(output.fileno())

            if total != release["bytes"]:
                raise UpdateError("下载文件大小校验失败")
            actual_sha = digest.hexdigest()
            if actual_sha.lower() != release["sha256"].lower():
                raise UpdateError("下载文件 SHA-256 校验失败")
            _validate_portable_zip(temp_path)
            if destination.exists():
                raise UpdateError("暂存目标已存在，未覆盖现有文件")
            os.replace(temp_path, destination)
            temp_path = None
            self._staged = {
                "version": release["version"],
                "filename": filename,
                "path": str(destination.resolve()),
                "bytes": total,
                "sha256": actual_sha,
                "exe_bytes": release["exe_bytes"],
                "exe_sha256": release["exe_sha256"],
                "verified": True,
                "installed": False,
                **({'recovery_note': recovery_note} if recovery_note else {}),
            }
        except UpdateError as exc:
            self._last_error = str(exc)
            raise
        except (OSError, urllib.error.URLError, TimeoutError, zipfile.BadZipFile) as exc:
            self._last_error = _error_message(exc)
            raise UpdateError(self._last_error) from exc
        finally:
            if temp_path is not None:
                try:
                    temp_path.unlink(missing_ok=True)
                except OSError:
                    pass
        self._last_error = None
        return self.status()

    def _fetch_bytes(self, url: str, limit: int) -> bytes:
        data = bytearray()
        with self._open(url) as response:
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    if int(length) > limit:
                        raise UpdateError("发布清单超过大小限制")
                except (TypeError, ValueError) as exc:
                    raise UpdateError("发布清单大小标头无效") from exc
            while True:
                chunk = response.read(min(64 * 1024, limit + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > limit:
                    raise UpdateError("发布清单超过大小限制")
        return bytes(data)

    def _open(self, url: str):
        safe_url = _validate_url(url)
        request = urllib.request.Request(
            safe_url,
            headers={"User-Agent": "PrismCanvas-Updater/1", "Accept": "application/json, application/zip, */*"},
        )
        if self._opener is not None:
            return self._opener(request, timeout=self.timeout)
        opener = urllib.request.build_opener(_AllowlistedRedirectHandler())
        return opener.open(request, timeout=self.timeout)

    def _select_release(self, manifest: dict[str, Any]) -> dict[str, Any]:
        if manifest.get("compatibility_identity") not in (None, "FrameWeave"):
            raise UpdateError("发布清单的产品身份不匹配")
        version = manifest.get("version")
        _parse_version(version)
        if manifest.get("published") is False or manifest.get("release_channel") == "local-candidate":
            raise UpdateError("当前清单不是公开发布版本")
        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, list):
            raise UpdateError("发布清单缺少安装包列表")
        for item in artifacts:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            if not isinstance(name, str):
                continue
            match = _WINDOWS_ARCHIVE_RE.fullmatch(name)
            if not match or match.group("version") != version.removeprefix("v"):
                continue
            size = item.get("bytes")
            sha256 = item.get("sha256")
            if isinstance(size, bool) or not isinstance(size, int) or not (1 <= size <= self.max_archive_bytes):
                raise UpdateError("Windows 安装包大小无效")
            if not isinstance(sha256, str) or not _SHA256_RE.fullmatch(sha256):
                raise UpdateError("Windows 安装包 SHA-256 无效")
            exe_bytes = manifest.get("exe_bytes")
            exe_sha256 = manifest.get("exe_sha256")
            if (
                isinstance(exe_bytes, bool)
                or not isinstance(exe_bytes, int)
                or not (1 <= exe_bytes <= MAX_SINGLE_FILE_BYTES)
            ):
                raise UpdateError("发布清单中的 EXE 大小无效")
            if not isinstance(exe_sha256, str) or not _SHA256_RE.fullmatch(exe_sha256):
                raise UpdateError("发布清单中的 EXE SHA-256 无效")
            url = item.get("download_url") or item.get("url")
            if url is None:
                url = RAW_RELEASES_PREFIX + name
            url = _validate_url(url)
            kind = item.get("kind", "Windows x64 portable")
            return {
                "version": version.removeprefix("v"),
                "name": name,
                "kind": str(kind),
                "bytes": size,
                "sha256": sha256.lower(),
                "exe_bytes": exe_bytes,
                "exe_sha256": exe_sha256.lower(),
                "url": url,
                "update_available": False,
                "published": manifest.get("published", True) is True,
            }
        raise UpdateError("发布清单中没有匹配版本的 Windows x64 安装包")

    def _verify_existing_stage(self, path: Path, release: dict[str, Any]) -> dict[str, Any]:
        if not path.is_file() or path.stat().st_size != release["bytes"]:
            raise UpdateError("已存在的暂存文件大小不符，未覆盖")
        digest = _sha256_file(path)
        if digest != release["sha256"]:
            raise UpdateError("已存在的暂存文件哈希不符，未覆盖")
        _validate_portable_zip(path)
        return {
            "version": release["version"],
            "filename": path.name,
            "path": str(path.resolve()),
            "bytes": path.stat().st_size,
            "sha256": digest,
            "exe_bytes": release["exe_bytes"],
            "exe_sha256": release["exe_sha256"],
            "verified": True,
            "installed": False,
        }

    @staticmethod
    def _public_release(release: dict[str, Any]) -> dict[str, Any]:
        keys = ("version", "name", "kind", "bytes", "sha256", "exe_bytes", "exe_sha256", "update_available", "published")
        return {key: release[key] for key in keys if key in release}


def _decode_manifest(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError, UpdateError) as exc:
        raise UpdateError("发布清单不是有效的 UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise UpdateError("发布清单格式无效")
    return value


def _reject_duplicate_keys(items: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in items:
        if key in result:
            raise UpdateError("发布清单包含重复字段")
        result[key] = value
    return result


def _validate_portable_zip(path: Path) -> dict[str, int]:
    try:
        with zipfile.ZipFile(path, "r") as archive:
            members = archive.infolist()
            if not members or len(members) > MAX_ARCHIVE_FILES:
                raise UpdateError("安装包文件数量无效")
            total_unpacked = 0
            seen: set[str] = set()
            for info in members:
                # ZipInfo.filename normalizes backslashes on Windows. Inspect
                # orig_filename so path validation sees the bytes' original path.
                name = getattr(info, "orig_filename", info.filename)
                if (
                    not name
                    or "\\" in name
                    or name.startswith("/")
                    or len(name) > 240
                    or any(ord(char) < 32 for char in name)
                ):
                    raise UpdateError("安装包包含不安全路径")
                path_parts = name.rstrip("/").split("/")
                if (
                    not path_parts
                    or any(part in ("", ".", "..") for part in path_parts)
                    or any(len(part) > 120 or ":" in part or part.endswith((" ", ".")) for part in path_parts)
                    or any(part.split(".")[0].upper() in _WINDOWS_RESERVED for part in path_parts)
                ):
                    raise UpdateError("安装包包含不安全路径")
                normalized = "/".join(path_parts).casefold()
                if normalized in seen:
                    raise UpdateError("安装包包含重复路径")
                seen.add(normalized)
                mode = (info.external_attr >> 16) & 0xFFFF
                file_type = stat.S_IFMT(mode)
                is_dir = info.is_dir()
                if file_type == stat.S_IFLNK or file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise UpdateError("安装包包含链接或特殊文件")
                if is_dir and file_type not in (0, stat.S_IFDIR):
                    raise UpdateError("安装包目录条目类型无效")
                if not is_dir and file_type == stat.S_IFDIR:
                    raise UpdateError("安装包文件条目类型无效")
                if info.flag_bits & 0x1:
                    raise UpdateError("安装包包含加密文件")
                if info.file_size < 0 or info.file_size > MAX_SINGLE_FILE_BYTES:
                    raise UpdateError("安装包单文件展开尺寸超限")
                total_unpacked += info.file_size
                if total_unpacked > MAX_UNPACKED_BYTES:
                    raise UpdateError("安装包展开总体积超限")
                if info.file_size:
                    if info.compress_size <= 0 or info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                        raise UpdateError("安装包压缩比例异常")
            if archive.testzip() is not None:
                raise UpdateError("安装包包含损坏的 ZIP 数据")
            return {"file_count": len(members), "unpacked_bytes": total_unpacked}
    except zipfile.BadZipFile as exc:
        raise UpdateError("下载内容不是有效 ZIP 安装包") from exc
    except (NotImplementedError, RuntimeError) as exc:
        raise UpdateError("安装包使用了不支持的压缩格式") from exc


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _error_message(exc: BaseException) -> str:
    message = str(exc).strip()
    return message[:300] if message else exc.__class__.__name__
