"""Bounded, content-addressed backups of damaged local configuration files."""
import hashlib
import os
from pathlib import Path
import stat
import tempfile

MAX_BACKUP_BYTES = 16 * 1024 * 1024


def _regular(info):
    if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0)):
        raise OSError('配置文件须为普通文件，原件未修改')


def _identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def _open_regular(path):
    before = path.lstat()
    _regular(before)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    stream = os.fdopen(descriptor, 'rb')
    try:
        after = os.fstat(stream.fileno())
        _regular(after)
        if _identity(before) != _identity(after):
            raise OSError('配置文件读取期间发生变化')
    except BaseException:
        stream.close()
        raise
    return stream, after


def read_config(path, limit):
    """Read at most limit+1 bytes; missing files remain a distinct condition."""
    stream, before = _open_regular(Path(path))
    with stream:
        content = stream.read(limit + 1)
        if len(content) > limit:
            raise ValueError('配置文件超过大小限制')
        if _identity(before) != _identity(os.fstat(stream.fileno())):
            raise OSError('配置文件读取期间发生变化')
    return content


def preserve_config(path, *, expected_digest=None):
    """Return a verified backup basename; raise OSError without altering source.

    Repeated recovery of identical content reuses its backup. Oversize, links,
    conflicting backup names, or concurrent edits fail closed.
    """
    path = Path(path)
    stream, before = _open_regular(path)
    stage = None
    try:
        with stream:
            if before.st_size > MAX_BACKUP_BYTES:
                raise OSError('配置大于 16 MiB，请先手动备份')
            descriptor, name = tempfile.mkstemp(prefix='.config-recovery-', suffix='.tmp', dir=path.parent)
            stage = Path(name)
            digest, size = hashlib.sha256(), 0
            with os.fdopen(descriptor, 'wb') as target:
                while chunk := stream.read(min(65536, MAX_BACKUP_BYTES + 1 - size)):
                    size += len(chunk)
                    if size > MAX_BACKUP_BYTES:
                        raise OSError('配置备份超过大小限制')
                    digest.update(chunk)
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if (size != before.st_size or _identity(before) != _identity(os.fstat(stream.fileno()))
                    or _identity(before) != _identity(path.lstat())):
                raise OSError('配置备份期间发生变化，请重新打开应用')
        expected = digest.hexdigest()
        if expected_digest is not None and expected != expected_digest:
            raise OSError('配置内容已变化，未按旧检查结果生成备份')
        backup = path.with_name(f'{path.stem}.recovery-{expected[:24]}{path.suffix}')
        try:
            os.link(stage, backup)
        except FileExistsError:
            pass
        content = read_config(backup, MAX_BACKUP_BYTES)
        if len(content) != size or hashlib.sha256(content).hexdigest() != expected:
            raise OSError('同名恢复备份校验失败，原件及备份均未覆盖')
        return backup.name
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)
