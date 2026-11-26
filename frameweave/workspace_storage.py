"""On-demand, metadata-only summaries of client-owned local asset files."""

import os
import stat
from pathlib import Path

from .local_assets import _ASSET_ID, _is_reparse_or_symlink


SAFE_DIRECTORY_SCAN = (os.scandir in os.supports_fd and os.open in os.supports_dir_fd
                       and os.stat in os.supports_dir_fd
                       and os.stat in os.supports_follow_symlinks
                       and bool(getattr(os, "O_NOFOLLOW", 0))
                       and bool(getattr(os, "O_DIRECTORY", 0)))


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink,
            info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            getattr(info, "st_uid", None), getattr(info, "st_gid", None),
            getattr(info, "st_file_attributes", 0), getattr(info, "st_reparse_tag", 0))


def _location(info):
    return (info.st_dev, info.st_ino, info.st_mode,
            getattr(info, "st_file_attributes", 0), getattr(info, "st_reparse_tag", 0))


def _unavailable():
    # Never expose exception messages: they may contain user paths or filenames.
    return {"status": "unavailable", "count": None, "bytes": None}


def asset_directory_summary(root):
    """Count regular SHA-256-named files without reading or verifying contents.

    Directory descriptors pin the parent and asset directory during enumeration.
    Platforms without these no-follow operations return an unknown summary rather
    than falling back to a path scan that could follow a replaced directory.
    """
    root = Path(root)
    if not SAFE_DIRECTORY_SCAN:
        return _unavailable()
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY | getattr(os, "O_NONBLOCK", 0)
    parent_fd = directory_fd = None
    try:
        parent = root.parent.lstat()
        if _is_reparse_or_symlink(parent) or not stat.S_ISDIR(parent.st_mode):
            return _unavailable()
        parent_fd = os.open(root.parent, flags)
        if _identity(os.fstat(parent_fd)) != _identity(parent):
            return _unavailable()
        try:
            before = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            if _identity(root.parent.lstat()) != _identity(parent):
                return _unavailable()
            return {"status": "ok", "count": 0, "bytes": 0}
        if _is_reparse_or_symlink(before) or not stat.S_ISDIR(before.st_mode):
            return _unavailable()
        directory_fd = os.open(root.name, flags, dir_fd=parent_fd)
        if _identity(os.fstat(directory_fd)) != _identity(before):
            return _unavailable()
        count = total = 0
        partial = False
        try:
            with os.scandir(directory_fd) as entries:
                for entry in entries:
                    if not _ASSET_ID.fullmatch(entry.name):
                        continue
                    try:
                        info = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                        if _is_reparse_or_symlink(info) or not stat.S_ISREG(info.st_mode):
                            continue
                        checked = os.stat(entry.name, dir_fd=directory_fd, follow_symlinks=False)
                        if _identity(checked) != _identity(info):
                            partial = True
                            continue
                        count += 1
                        total += info.st_size
                    except OSError:
                        partial = True
        except OSError:
            if not count:
                return _unavailable()
            partial = True
        after = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
        opened = os.fstat(directory_fd)
        if (_location(after) != _location(before) or _location(opened) != _location(before)
                or _location(root.parent.lstat()) != _location(parent)):
            return _unavailable()
        if _identity(after) != _identity(before) or _identity(opened) != _identity(before):
            # Entries may have been removed after being counted; these totals
            # cannot safely be presented as a current confirmed lower bound.
            return _unavailable()
        return {"status": "partial" if partial else "ok", "count": count, "bytes": total}
    except OSError:
        return _unavailable()
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        if parent_fd is not None:
            os.close(parent_fd)


def local_asset_summary(image_root, media_root):
    images = asset_directory_summary(image_root)
    media = asset_directory_summary(media_root)
    known = [item for item in (images, media) if item["status"] != "unavailable"]
    status = ("ok" if images["status"] == media["status"] == "ok"
              else "partial" if known else "unavailable")
    return {"status": status,
            "count": sum(item["count"] for item in known) if known else None,
            "bytes": sum(item["bytes"] for item in known) if known else None,
            "images": images, "media": media}
