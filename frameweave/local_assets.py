"""Content-addressed local image assets for offline canvas editing."""

import base64
import binascii
import hashlib
import os
import re
import stat
import tempfile
import threading
from pathlib import Path

from .media_contract import AUDIO_MIMES, MAX_AUDIO_BYTES, audio_header_info, audio_content_info


MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024
MAX_LOCAL_AUDIO_BYTES = MAX_AUDIO_BYTES
MAX_LOCAL_VIDEO_BYTES = 200 * 1024 * 1024
MAX_LOCAL_MEDIA_BYTES = MAX_LOCAL_VIDEO_BYTES
_ASSET_ID = re.compile(r"[0-9a-f]{64}\Z")
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_END = b"\x00\x00\x00\x00IEND\xaeB`\x82"
_MP4_BRANDS = {b"isom", b"iso2", b"iso5", b"iso6", b"mp41", b"mp42", b"avc1", b"M4V ", b"dash", b"msdh", b"msix", b"cmfc", b"cmfs"}


def _is_reparse_or_symlink(info):
    attributes = getattr(info, "st_file_attributes", 0)
    reparse = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISLNK(info.st_mode) or bool(reparse and attributes & reparse)


def _image_mime(content):
    if not 8 <= len(content) <= MAX_LOCAL_IMAGE_BYTES:
        raise ValueError("图片须在 8 字节到 20 MiB 之间")
    if content.startswith(_PNG_SIGNATURE):
        if not content.endswith(_PNG_END):
            raise ValueError("PNG 图片数据不完整")
        return "image/png", ".png"
    if content.startswith(b"\xff\xd8\xff"):
        if not content.endswith(b"\xff\xd9"):
            raise ValueError("JPEG 图片数据不完整")
        return "image/jpeg", ".jpg"
    if (content.startswith(b"RIFF") and len(content) >= 20 and content[8:12] == b"WEBP"
            and int.from_bytes(content[4:8], "little") + 8 == len(content)):
        return "image/webp", ".webp"
    raise ValueError("仅支持完整的 PNG、JPEG 或 WebP 图片")


def _display_filename(name, extension):
    if not isinstance(name, str) or not name:
        raise ValueError("图片文件名无效")
    # This field is presentation metadata only; it never participates in a path.
    leaf = name.replace("\\", "/").rsplit("/", 1)[-1]
    leaf = "".join(character for character in leaf if ord(character) >= 32 and ord(character) != 127)
    leaf = leaf.strip()[:240]
    return leaf if leaf not in {"", ".", ".."} else "image" + extension


def _ebml_vint(data, offset, *, keep_marker=False):
    if offset >= len(data) or data[offset] == 0:
        return None
    first = data[offset]
    marker = 0x80
    length = 1
    while length <= 8 and not first & marker:
        marker >>= 1
        length += 1
    if length > 8 or offset + length > len(data):
        return None
    value = first if keep_marker else first & (marker - 1)
    for byte in data[offset + 1:offset + length]:
        value = (value << 8) | byte
    return length, value


def _is_webm_header(header):
    if not header.startswith(b"\x1a\x45\xdf\xa3"):
        return False
    size = _ebml_vint(header, 4)
    if size is None:
        return False
    size_length, header_size = size
    offset = 4 + size_length
    header_end = offset + header_size
    if header_end > len(header):
        return False
    while offset < header_end:
        element_id = _ebml_vint(header, offset, keep_marker=True)
        if element_id is None:
            return False
        id_length, element_id_value = element_id
        element_size = _ebml_vint(header, offset + id_length)
        if element_size is None:
            return False
        size_length, value_length = element_size
        value_start = offset + id_length + size_length
        value_end = value_start + value_length
        if value_end > header_end:
            return False
        if element_id_value == 0x4282:
            return header[value_start:value_end] == b"webm"
        offset = value_end
    return False


def _media_info(head, tail, length):
    if length >= 8 and head.startswith(_PNG_SIGNATURE):
        if length > MAX_LOCAL_IMAGE_BYTES:
            raise ValueError("图片须不超过 20 MiB")
        if tail.endswith(_PNG_END):
            return "image", "image/png", ".png"
        raise ValueError("PNG 图片数据不完整")
    if length >= 8 and head.startswith(b"\xff\xd8\xff"):
        if length > MAX_LOCAL_IMAGE_BYTES:
            raise ValueError("图片须不超过 20 MiB")
        if tail.endswith(b"\xff\xd9"):
            return "image", "image/jpeg", ".jpg"
        raise ValueError("JPEG 图片数据不完整")
    if (length >= 20 and head.startswith(b"RIFF") and head[8:12] == b"WEBP"
            and int.from_bytes(head[4:8], "little") + 8 == length):
        if length > MAX_LOCAL_IMAGE_BYTES:
            raise ValueError("图片须不超过 20 MiB")
        return "image", "image/webp", ".webp"
    if length >= 16 and head[4:8] == b"ftyp":
        box_size = int.from_bytes(head[:4], "big")
        brand_start = 8
        if box_size == 1:
            if len(head) < 24:
                raise ValueError("MP4/MOV 文件头不完整")
            box_size = int.from_bytes(head[8:16], "big")
            brand_start = 16
        if box_size < brand_start + 8 or box_size > length or len(head) < brand_start + 8:
            raise ValueError("MP4/MOV 文件头无效")
        brands = [head[index:index + 4] for index in range(brand_start, min(box_size, len(head)), 4)]
        if b"qt  " in brands:
            return "video", "video/quicktime", ".mov"
        if any(brand in _MP4_BRANDS for brand in brands):
            return "video", "video/mp4", ".mp4"
        raise ValueError("MP4/MOV brand 不受支持")
    if length >= 16 and _is_webm_header(head):
        return "video", "video/webm", ".webm"
    audio = audio_header_info(head, length, max_bytes=MAX_LOCAL_AUDIO_BYTES)
    if audio is not None:
        return "audio", *audio
    raise ValueError("本地媒体仅支持 PNG、JPEG、WebP、MP4、WebM、MOV、WAV、MP3、FLAC 或 OGG")


class LocalImageAssets:
    """Store uploaded bytes under their SHA-256 identity below data_dir."""

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.root = self.data_dir / "local-assets-images"
        self._lock = threading.RLock()

    def _checked_root(self, *, create=False):
        try:
            info = self.root.lstat()
        except FileNotFoundError:
            if not create:
                raise
            self.root.mkdir(mode=0o700)
            info = self.root.lstat()
        if _is_reparse_or_symlink(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("本地图片目录必须是普通目录，不能是符号链接")
        resolved = self.root.resolve(strict=True)
        if resolved.parent != self.data_dir:
            raise ValueError("本地图片目录越出数据目录")
        return resolved

    def _read_file(self, root, asset_id):
        path = root / asset_id
        try:
            info = path.lstat()
        except FileNotFoundError:
            raise
        if _is_reparse_or_symlink(info) or not stat.S_ISREG(info.st_mode):
            raise ValueError("本地图片文件必须是普通文件")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                content = stream.read(MAX_LOCAL_IMAGE_BYTES + 1)
        finally:
            os.close(descriptor)
        if len(content) > MAX_LOCAL_IMAGE_BYTES or hashlib.sha256(content).hexdigest() != asset_id:
            raise ValueError("本地图片内容校验失败")
        mime, _ = _image_mime(content)
        return content, mime

    @staticmethod
    def _remove_temp_if_owned(path, identity):
        try:
            info = path.lstat()
        except FileNotFoundError:
            return
        if (not _is_reparse_or_symlink(info) and stat.S_ISREG(info.st_mode)
                and (info.st_dev, info.st_ino) == identity):
            path.unlink()

    def create(self, name, encoded):
        if not isinstance(encoded, str):
            raise ValueError("请上传图片内容")
        try:
            content = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("图片编码无效") from None
        mime, extension = _image_mime(content)
        filename = _display_filename(name, extension)
        asset_id = hashlib.sha256(content).hexdigest()
        with self._lock:
            root = self._checked_root(create=True)
            path = root / asset_id
            try:
                existing, existing_mime = self._read_file(root, asset_id)
            except FileNotFoundError:
                existing = None
            if existing is not None:
                if existing != content or existing_mime != mime:
                    raise ValueError("已有本地图片与其内容标识不一致")
            else:
                descriptor, temporary_name = tempfile.mkstemp(prefix=f".{asset_id}.", suffix=".tmp", dir=root)
                temporary = Path(temporary_name)
                identity = None
                try:
                    info = os.fstat(descriptor)
                    identity = (info.st_dev, info.st_ino)
                    stream = os.fdopen(descriptor, "wb")
                    descriptor = None
                    with stream:
                        stream.write(content)
                        stream.flush()
                        os.fsync(stream.fileno())
                    try:
                        os.link(temporary, path)
                    except FileExistsError:
                        existing, existing_mime = self._read_file(root, asset_id)
                        if existing != content or existing_mime != mime:
                            raise ValueError("已有本地图片与其内容标识不一致") from None
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
                    if identity is not None:
                        self._remove_temp_if_owned(temporary, identity)
        return {"asset_id": asset_id, "filename": filename, "mime": mime}

    def read(self, asset_id):
        if not isinstance(asset_id, str) or not _ASSET_ID.fullmatch(asset_id):
            raise ValueError("本地图片标识无效")
        with self._lock:
            root = self._checked_root()
            return self._read_file(root, asset_id)


class LocalMediaAssets:
    """Content-addressed image/video/audio store for bounded HTTP bodies."""

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.root = self.data_dir / "local-assets-media"
        self._lock = threading.RLock()
        self._verified = {}

    def _checked_root(self, *, create=False):
        try:
            info = self.root.lstat()
        except FileNotFoundError:
            if not create:
                raise
            self.root.mkdir(mode=0o700)
            info = self.root.lstat()
        if _is_reparse_or_symlink(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError("本地媒体目录必须是普通目录，不能是符号链接")
        resolved = self.root.resolve(strict=True)
        if resolved.parent != self.data_dir:
            raise ValueError("本地媒体目录越出数据目录")
        return resolved

    def _open_file(self, root, asset_id):
        if not isinstance(asset_id, str) or not _ASSET_ID.fullmatch(asset_id):
            raise ValueError("本地媒体标识无效")
        path = root / asset_id
        info = path.lstat()
        if _is_reparse_or_symlink(info) or not stat.S_ISREG(info.st_mode):
            raise ValueError("本地媒体文件必须是普通文件")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if (not stat.S_ISREG(opened.st_mode) or _is_reparse_or_symlink(opened)
                    or (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino)):
                raise ValueError("本地媒体文件在打开时发生变化")
            if not 8 <= opened.st_size <= MAX_LOCAL_MEDIA_BYTES:
                raise ValueError("本地媒体大小无效")
            identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            cached = self._verified.get(asset_id)
            if cached is None or cached[0] != identity or cached[1] == "audio":
                digest = hashlib.sha256()
                with os.fdopen(os.dup(descriptor), "rb") as stream:
                    head = stream.read(4096)
                    stream.seek(-min(opened.st_size, 32), os.SEEK_END)
                    tail = stream.read(32)
                    stream.seek(0)
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                media_type, mime, extension = _media_info(head, tail, opened.st_size)
                if media_type == "audio":
                    with os.fdopen(os.dup(descriptor), "rb") as stream:
                        stream.seek(0)
                        content = stream.read(MAX_LOCAL_AUDIO_BYTES + 1)
                    audio_content_info(content, max_bytes=MAX_LOCAL_AUDIO_BYTES)
                if digest.hexdigest() != asset_id:
                    raise ValueError("本地媒体内容校验失败")
                cached = (identity, media_type, mime, extension)
                self._verified[asset_id] = cached
            os.lseek(descriptor, 0, os.SEEK_SET)
            return os.fdopen(descriptor, "rb"), opened.st_size, cached[2], cached[1]
        except BaseException:
            os.close(descriptor)
            raise

    def create_from_stream(self, name, source, content_length, content_type):
        if type(content_length) is not int or not 8 <= content_length <= MAX_LOCAL_MEDIA_BYTES:
            raise ValueError("本地媒体须在 8 字节到 200 MiB 之间")
        if not isinstance(content_type, str) or content_type.lower() not in {
                "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "video/quicktime", *AUDIO_MIMES}:
            raise ValueError("本地媒体 Content-Type 不受支持")
        if content_type.lower() in AUDIO_MIMES and content_length > MAX_LOCAL_AUDIO_BYTES:
            raise ValueError("参考音频须不超过 20 MiB")
        _display_filename(name, ".bin")  # Validate presentation metadata before consuming the body.
        with self._lock:
            root = self._checked_root(create=True)
            descriptor, temporary_name = tempfile.mkstemp(prefix=".upload-", suffix=".tmp", dir=root)
            temporary = Path(temporary_name)
            identity = None
            digest = hashlib.sha256()
            try:
                info = os.fstat(descriptor)
                identity = (info.st_dev, info.st_ino)
                remaining = content_length
                with os.fdopen(descriptor, "wb") as stream:
                    descriptor = None
                    while remaining:
                        limit = min(128 * 1024, remaining)
                        chunk = source.read(limit)
                        if not chunk:
                            raise ValueError("本地媒体请求正文不完整")
                        if not isinstance(chunk, bytes) or len(chunk) > limit:
                            raise ValueError("本地媒体请求正文无效")
                        stream.write(chunk)
                        digest.update(chunk)
                        remaining -= len(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                with temporary.open("rb") as stream:
                    head = stream.read(4096)
                    stream.seek(-min(content_length, 32), os.SEEK_END)
                    tail = stream.read(32)
                media_type, mime, extension = _media_info(head, tail, content_length)
                if media_type == "audio":
                    with temporary.open("rb") as stream:
                        audio_content_info(stream.read(MAX_LOCAL_AUDIO_BYTES + 1),
                                           max_bytes=MAX_LOCAL_AUDIO_BYTES)
                if content_type.lower() != mime:
                    raise ValueError("媒体 Content-Type 与文件签名不一致")
                filename = _display_filename(name, extension)
                asset_id = digest.hexdigest()
                final_path = root / asset_id
                try:
                    os.link(temporary, final_path)
                    info = final_path.lstat()
                    self._verified[asset_id] = ((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns),
                                                media_type, mime, extension)
                except FileExistsError:
                    with self._open_file(root, asset_id)[0]:
                        pass
            finally:
                if descriptor is not None:
                    os.close(descriptor)
                if identity is not None:
                    LocalImageAssets._remove_temp_if_owned(temporary, identity)
        return {"asset_id": asset_id, "filename": filename, "mime": mime, "media_type": media_type}

    def open(self, asset_id):
        with self._lock:
            root = self._checked_root()
            return self._open_file(root, asset_id)

    def read(self, asset_id):
        stream, size, mime, media_type = self.open(asset_id)
        with stream:
            content = stream.read(size + 1)
        if len(content) != size:
            raise ValueError("本地媒体读取不完整")
        return content, mime, media_type
