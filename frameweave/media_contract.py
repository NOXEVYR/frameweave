"""Pure standard Comfy filename-upload contracts and bounded audio checks.

No package, workflow, server or codec dependency. Upload flags describe files,
not tensor inputs. Audio checks establish container structure, not decodability.
"""

MAX_AUDIO_BYTES = 20 * 1024 * 1024
MEDIA_TYPES = ("image", "video", "audio")
AUDIO_MIMES = {"audio/wav", "audio/mpeg", "audio/flac", "audio/ogg"}
_ACCEPT = {"image": ("image/png", "image/jpeg", "image/webp"),
           "video": ("video/mp4", "video/webm", "video/quicktime"),
           "audio": ("audio/wav", "audio/mpeg", "audio/flac", "audio/ogg")}
_LEGACY_LOADERS = {("LoadImage", "image"): "image",
                   ("LoadImageMask", "image"): "image",
                   ("VHS_LoadVideo", "video"): "video",
                   ("LoadAudio", "audio"): "audio"}


def media_input_contract(node_type, input_name, definition, *, required=True):
    """Return a supported input-filename contract or a value-free reason.

    ``definition`` is an already-expanded [kind, metadata] schema entry. The
    caller obtains ``required`` from live schema, never from a saved package.
    Legacy STRING+audio_upload remains supported, explicitly marked legacy.
    """
    result = {"supported": False, "reason": "not_media", "media_type": None,
              "required": required is True, "legacy": False}

    def reject(reason):
        return {**result, "reason": reason}

    if not isinstance(node_type, str) or not isinstance(input_name, str):
        return reject("invalid_binding")
    if not isinstance(definition, (list, tuple)) or not 1 <= len(definition) <= 2:
        return reject("invalid_definition")
    kind = definition[0]
    meta = definition[1] if len(definition) == 2 else {}
    if not isinstance(meta, dict):
        return reject("invalid_metadata")
    flags = [media for media in MEDIA_TYPES if meta.get(media + "_upload") is True]
    if len(flags) == 1:
        result["media_type"] = flags[0]
    elif len(flags) > 1:
        result["media_types"] = flags
        return reject("conflicting_upload_flags")
    if any(media + "_upload" in meta and type(meta[media + "_upload"]) is not bool
           for media in MEDIA_TYPES):
        return reject("invalid_upload_flag")
    legacy_type = _LEGACY_LOADERS.get((node_type, input_name))
    if not flags:
        if legacy_type and isinstance(kind, (list, tuple)) and all(isinstance(x, str) for x in kind):
            # Explicit false must not be overridden by a historical fallback.
            if legacy_type + "_upload" in meta:
                return reject("upload_disabled")
            result.update(media_type=legacy_type, legacy=True)
        else:
            return result
    if meta.get("multiselect"):
        return reject("multiple_files_unsupported")
    if meta.get("remote") is not None or any(key in meta for key in
            ("upload_route", "upload_endpoint", "upload_url", "custom_upload", "upload")):
        return reject("custom_transport_unsupported")
    for key in ("image_folder", "video_folder", "audio_folder", "folder", "storage_type"):
        if key in meta and meta[key] != "input":
            return reject("non_input_storage")
    options = kind if isinstance(kind, (list, tuple)) else meta.get("options")
    if isinstance(kind, str) and kind == "STRING" and result["media_type"] == "audio":
        result["legacy"] = True
    elif not (isinstance(kind, (list, tuple)) or kind == "COMBO"):
        return reject("not_filename_combo")
    if options is not None and (not isinstance(options, (list, tuple))
                                or any(not isinstance(x, str) for x in options)):
        return reject("non_filename_options")
    return {**result, "supported": True, "reason": "supported",
            "transport": "comfy_input_filename", "storage_type": "input",
            "cardinality": "single", "accept": list(_ACCEPT[result["media_type"]])}


def audio_header_info(head, length, *, max_bytes=MAX_AUDIO_BYTES):
    """Recognize audio independently of filename; return None for other media."""
    if head.startswith(b"RIFF") and head[8:12] == b"WAVE":
        if len(head) < 12 or int.from_bytes(head[4:8], "little") + 8 != length:
            raise ValueError("WAV 文件长度无效")
        result = ("audio/wav", ".wav")
    elif head.startswith(b"fLaC"):
        result = ("audio/flac", ".flac")
    elif head.startswith(b"ID3") or len(head) >= 2 and head[0] == 255 and head[1] & 0xE0 == 0xE0:
        result = ("audio/mpeg", ".mp3")
    elif head.startswith(b"OggS"):
        result = ("audio/ogg", ".ogg")
    else:
        return None
    if type(length) is not int or not 12 <= length <= max_bytes:
        raise ValueError("参考音频须在 12 字节到 20 MiB 之间")
    return result


def _wav(content):
    offset, fmt, data = 12, False, False
    while offset < len(content):
        if offset + 8 > len(content):
            raise ValueError("WAV chunk 文件头不完整")
        tag = content[offset:offset + 4]
        size = int.from_bytes(content[offset + 4:offset + 8], "little")
        offset += 8
        end = offset + size
        if end > len(content):
            raise ValueError("WAV chunk 长度无效")
        if tag == b"fmt ":
            if size < 16 or not int.from_bytes(content[offset:offset + 2], "little"):
                raise ValueError("WAV fmt 无效")
            if not int.from_bytes(content[offset + 2:offset + 4], "little") or not int.from_bytes(content[offset + 4:offset + 8], "little"):
                raise ValueError("WAV 声道或采样率无效")
            fmt = True
        if tag == b"data":
            data = data or size > 0
        # Python's wave writer and some real PCM writers omit the final data
        # padding byte. The declared RIFF length still proves the exact end.
        offset = end if tag == b"data" and end == len(content) else end + (size & 1)
        if offset > len(content):
            raise ValueError("WAV chunk 对齐数据不完整")
    if not fmt or not data:
        raise ValueError("WAV 缺少有效 fmt 或音频数据")


def _flac(content):
    offset, first = 4, True
    while True:
        if offset + 4 > len(content):
            raise ValueError("FLAC metadata 不完整")
        tag = content[offset]
        size = int.from_bytes(content[offset + 1:offset + 4], "big")
        offset += 4
        end = offset + size
        if end > len(content) or tag & 127 == 127:
            raise ValueError("FLAC metadata 长度或类型无效")
        if first:
            if tag & 127 != 0 or size != 34:
                raise ValueError("FLAC 缺少 STREAMINFO")
            packed = int.from_bytes(content[offset + 10:offset + 18], "big")
            if packed >> 44 == 0:
                raise ValueError("FLAC 采样率无效")
            first = False
        elif tag & 127 == 0:
            raise ValueError("FLAC STREAMINFO 重复")
        offset = end
        if tag & 128:
            break
    if offset + 4 > len(content) or content[offset] != 255 or content[offset + 1] & 0xFE != 0xF8:
        raise ValueError("FLAC 音频帧不完整")


def _mp3(content):
    offset = 0
    if content.startswith(b"ID3"):
        if len(content) < 10 or content[3] not in (2, 3, 4) or any(x & 128 for x in content[6:10]):
            raise ValueError("MP3 ID3 文件头无效")
        size = 0
        for byte in content[6:10]:
            size = (size << 7) | byte
        offset = 10 + size + (10 if content[3] == 4 and content[5] & 16 else 0)
    end = len(content) - 128 if content[-128:-125] == b"TAG" else len(content)
    frames = 0
    while offset < end:
        if offset + 4 > end:
            raise ValueError("MP3 帧文件头不完整")
        header = int.from_bytes(content[offset:offset + 4], "big")
        version, layer = (header >> 19) & 3, (header >> 17) & 3
        bitrate, rate = (header >> 12) & 15, (header >> 10) & 3
        padding = (header >> 9) & 1
        if header >> 21 != 0x7FF or version == 1 or layer == 0 or bitrate in (0, 15) or rate == 3:
            raise ValueError("MP3 帧文件头无效")
        rates = (44100, 48000, 32000)
        sample_rate = rates[rate] // (1 if version == 3 else 2 if version == 2 else 4)
        if version == 3:
            table = {3: (32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
                     2: (32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
                     1: (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)}[layer]
        else:
            table = ((32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256)
                     if layer == 3 else (8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160))
        bits = table[bitrate - 1] * 1000
        size = ((12 * bits // sample_rate + padding) * 4 if layer == 3
                else (72 if layer == 1 and version != 3 else 144) * bits // sample_rate + padding)
        if offset + size > end:
            raise ValueError("MP3 音频帧长度无效")
        offset += size
        frames += 1
    if not frames or offset != end:
        raise ValueError("MP3 缺少完整音频帧")


def _ogg(content):
    offset, serials, audio = 0, {}, False
    while offset < len(content):
        if offset + 27 > len(content) or content[offset:offset + 5] != b"OggS\x00":
            raise ValueError("OGG page 文件头无效")
        flags = content[offset + 5]
        serial = int.from_bytes(content[offset + 14:offset + 18], "little")
        sequence = int.from_bytes(content[offset + 18:offset + 22], "little")
        segments = content[offset + 26]
        start = offset + 27 + segments
        if flags & ~7 or start > len(content):
            raise ValueError("OGG page 分段无效")
        end = start + sum(content[offset + 27:start])
        if end > len(content):
            raise ValueError("OGG page 长度无效")
        previous = serials.get(serial)
        if previous is None:
            if not flags & 2 or sequence != 0:
                raise ValueError("OGG 缺少起始页")
            packet = content[start:end]
            audio = audio or packet.startswith((b"\x01vorbis", b"OpusHead", b"\x7fFLAC", b"Speex   "))
        elif previous[1] or sequence != previous[0] + 1:
            raise ValueError("OGG page 序列无效")
        serials[serial] = (sequence, bool(flags & 4))
        offset = end
    if not audio or not serials or not all(item[1] for item in serials.values()):
        raise ValueError("OGG 缺少音频或完整结束页")


def audio_content_info(content, *, max_bytes=MAX_AUDIO_BYTES):
    """Return (MIME, extension) after bounded audio container validation.

    Does not decode, transcode, validate compressed-frame CRCs or certify audio
    quality. SHA validation in the asset store protects subsequent reads.
    """
    if not isinstance(content, bytes):
        raise ValueError("音频内容必须为字节")
    info = audio_header_info(content[:4096], len(content), max_bytes=max_bytes)
    if info is None:
        raise ValueError("参考音频仅支持 WAV、FLAC、MP3、OGG 文件")
    {"audio/wav": _wav, "audio/flac": _flac, "audio/mpeg": _mp3, "audio/ogg": _ogg}[info[0]](content)
    return info
