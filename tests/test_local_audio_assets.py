"""Offline bounded audio storage and container integrity, without decoding."""
import hashlib
import io
import os
import stat
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from frameweave.local_assets import LocalMediaAssets, MAX_LOCAL_AUDIO_BYTES
from frameweave.media_contract import audio_content_info


def wav_bytes():
    stream = io.BytesIO()
    with wave.open(stream, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(b"\x00\x00\x10\x00" * 4)
    return stream.getvalue()


def mp3_bytes():
    # One complete MPEG1 layer3 128k/44.1k frame; tests validate framing only.
    return b"\xff\xfb\x90\x00" + b"\x00" * 413


def flac_bytes():
    # Bounded metadata and frame-sync vector; not a codec-quality fixture.
    streaminfo = bytearray(34)
    streaminfo[:4] = b"\x00\x10\x00\x10"
    streaminfo[10:18] = ((16000 << 44) | (15 << 36) | 16).to_bytes(8, "big")
    return b"fLaC\x80\x00\x00\x22" + bytes(streaminfo) + b"\xff\xf8\x69\x08\x00\x00\x00\x00"


def ogg_bytes():
    packet = b"OpusHead" + b"\x01\x01" + b"\x00" * 9
    header = bytearray(27)
    header[:6] = b"OggS\x00\x06"
    header[14:18] = (1).to_bytes(4, "little")
    header[26] = 1
    return bytes(header) + bytes([len(packet)]) + packet


VECTORS = ((wav_bytes, "audio/wav", ".wav"), (mp3_bytes, "audio/mpeg", ".mp3"),
           (flac_bytes, "audio/flac", ".flac"), (ogg_bytes, "audio/ogg", ".ogg"))


class LocalAudioAssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = LocalMediaAssets(self.root)

    def save(self, content=None, mime="audio/wav", name="reference.wav", source=None, length=None):
        content = wav_bytes() if content is None else content
        return self.store.create_from_stream(name, source or io.BytesIO(content),
                                              len(content) if length is None else length, mime)

    def test_four_formats_use_content_sha_and_read_back_after_restart(self):
        for make, mime, extension in VECTORS:
            with self.subTest(mime=mime):
                content = make()
                saved = self.save(content, mime, "untrusted-name.txt")
                self.assertEqual(saved["asset_id"], hashlib.sha256(content).hexdigest())
                self.assertEqual(saved["media_type"], "audio")
                self.assertEqual(saved["mime"], mime)
                self.assertEqual(self.store.read(saved["asset_id"]), (content, mime, "audio"))
                self.assertEqual(LocalMediaAssets(self.root).read(saved["asset_id"]), (content, mime, "audio"))
                self.assertEqual(audio_content_info(content), (mime, extension))

    def test_duplicate_filename_never_controls_storage_identity(self):
        content = wav_bytes()
        first = self.save(content, name="../private.wav")
        second = self.save(content, name="different.mp3")
        self.assertEqual(first["asset_id"], second["asset_id"])
        self.assertEqual(first["filename"], "private.wav")
        self.assertEqual([p.name for p in self.store.root.iterdir()], [first["asset_id"]])

    def test_mime_and_audio_type_must_match_bytes(self):
        for mime in ("audio/mpeg", "audio/flac", "audio/ogg", "video/mp4", "image/png", "audio/aac"):
            with self.subTest(mime=mime), self.assertRaises(ValueError):
                self.save(mime=mime)
        if self.store.root.exists():
            self.assertEqual(list(self.store.root.iterdir()), [])

    def test_declared_audio_size_limit_rejected_without_consuming_source(self):
        source = io.BytesIO(b"ignored")
        with self.assertRaises(ValueError):
            self.save(source=source, length=MAX_LOCAL_AUDIO_BYTES + 1)
        self.assertEqual(source.tell(), 0)
        self.assertFalse(self.store.root.exists())
        self.assertEqual(MAX_LOCAL_AUDIO_BYTES, 20 * 1024 * 1024)

    def test_actual_audio_limit_cannot_be_evaded_using_video_mime(self):
        content = wav_bytes()
        with patch("frameweave.local_assets.MAX_LOCAL_AUDIO_BYTES", len(content) - 1):
            with self.assertRaises(ValueError):
                self.save(content, mime="video/mp4")
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_short_reads_work_and_http_body_boundary_is_not_overread(self):
        content = wav_bytes()

        class ShortStream(io.BytesIO):
            def read(self, count=-1):
                return super().read(min(count, 3))

        source = ShortStream(content + b"NEXT-REQUEST")
        saved = self.save(content, source=source)
        self.assertEqual(source.tell(), len(content))
        self.assertEqual(self.store.read(saved["asset_id"])[0], content)

    def test_truncated_or_misdeclared_bodies_do_not_publish_assets(self):
        content = wav_bytes()
        for source, length in ((io.BytesIO(content[:-1]), len(content)),
                               (io.BytesIO(content), len(content) - 1),
                               (io.BytesIO(content), len(content) + 1)):
            with self.subTest(length=length), self.assertRaises(ValueError):
                self.save(content, source=source, length=length)
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_stream_cannot_return_nonbytes_or_more_than_requested(self):
        class BadStream:
            def __init__(self, value):
                self.value = value

            def read(self, count):
                return self.value

        for value in ("text", b"x" * (len(wav_bytes()) + 1)):
            with self.subTest(type=type(value)), self.assertRaises(ValueError):
                self.save(source=BadStream(value))
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_stream_is_rejected_at_first_oversized_read_even_with_large_remaining_body(self):
        class OversizedStream:
            calls = 0

            def read(self, count):
                self.calls += 1
                return b"x" * (128 * 1024 + 1)

        source = OversizedStream()
        with self.assertRaisesRegex(ValueError, "正文无效"):
            self.save(source=source, length=200000)
        self.assertEqual(source.calls, 1)
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_container_truncation_and_forged_lengths_are_rejected(self):
        bad_wav = bytearray(wav_bytes())
        bad_wav[40:44] = (999999).to_bytes(4, "little")
        bad_flac = bytearray(flac_bytes())
        bad_flac[5:8] = (999999).to_bytes(3, "big")
        bad_id3 = b"ID3\x04\x00\x00\x00\x00\x7f\x7f" + mp3_bytes()
        no_eos = bytearray(ogg_bytes())
        no_eos[5] = 2
        cases = ((wav_bytes()[:-1], "audio/wav"), (bytes(bad_wav), "audio/wav"),
                 (flac_bytes()[:10], "audio/flac"), (bytes(bad_flac), "audio/flac"),
                 (mp3_bytes()[:-1], "audio/mpeg"), (bad_id3, "audio/mpeg"),
                 (ogg_bytes()[:-1], "audio/ogg"), (bytes(no_eos), "audio/ogg"),
                 (b"fLaC" + b"x" * 24, "audio/flac"))
        for content, mime in cases:
            with self.subTest(mime=mime, size=len(content)), self.assertRaises(ValueError):
                self.save(content, mime)
        self.assertEqual(list(self.store.root.iterdir()), [])

    def test_mp3_id3_size_and_optional_id3v1_tag(self):
        data = b"ID3\x04\x00\x00\x00\x00\x00\x02ab" + mp3_bytes() + b"TAG" + b"\x00" * 125
        self.assertEqual(audio_content_info(data), ("audio/mpeg", ".mp3"))
        for bad in (b"ID3" + b"x" * 16, b"\xff\xff\xff\xff" + b"x" * 20):
            with self.assertRaises(ValueError):
                audio_content_info(bad)

    def test_wav_requires_fmt_and_data_but_accepts_additional_chunks(self):
        base = wav_bytes()
        data = base[:36] + b"JUNK\x02\x00\x00\x00ab" + base[36:]
        data = data[:4] + (len(data) - 8).to_bytes(4, "little") + data[8:]
        self.assertEqual(audio_content_info(data), ("audio/wav", ".wav"))
        empty = b"RIFF\x04\x00\x00\x00WAVE"
        with self.assertRaises(ValueError):
            audio_content_info(empty)

    def test_wav_final_odd_pcm_chunk_matches_standard_library_writer(self):
        stream = io.BytesIO()
        with wave.open(stream, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(1)
            writer.setframerate(8000)
            writer.writeframes(b"\x80" * 3)
        self.assertEqual(audio_content_info(stream.getvalue()), ("audio/wav", ".wav"))

    def test_tampering_same_size_and_restored_mtime_still_fails_readback(self):
        saved = self.save()
        path = self.store.root / saved["asset_id"]
        info = path.stat()
        content = bytearray(path.read_bytes())
        content[-1] ^= 1
        path.write_bytes(content)
        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
        with self.assertRaisesRegex(ValueError, "内容校验失败"):
            self.store.read(saved["asset_id"])

    def test_existing_corruption_is_not_overwritten(self):
        content = wav_bytes()
        self.store.root.mkdir()
        asset_id = hashlib.sha256(content).hexdigest()
        path = self.store.root / asset_id
        path.write_bytes(b"wrong-data")
        with self.assertRaises(ValueError):
            self.save(content)
        self.assertEqual(path.read_bytes(), b"wrong-data")
        self.assertEqual([p.name for p in self.store.root.iterdir()], [asset_id])

    def test_atomic_fsync_failure_leaves_no_file_and_retry_succeeds(self):
        with patch("frameweave.local_assets.os.fsync", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.save()
        self.assertEqual(list(self.store.root.iterdir()), [])
        saved = self.save()
        self.assertEqual(self.store.read(saved["asset_id"])[0], wav_bytes())

    def test_reparse_or_symlink_directory_and_asset_are_rejected(self):
        with patch("frameweave.local_assets._is_reparse_or_symlink", return_value=True):
            with self.assertRaises(ValueError):
                self.save()
        saved = self.save()
        path = self.store.root / saved["asset_id"]
        lstat = Path.lstat

        def linked(entry):
            return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0) if entry == path else lstat(entry)

        with patch.object(Path, "lstat", linked):
            with self.assertRaises(ValueError):
                self.store.read(saved["asset_id"])

    def test_replaced_file_between_lstat_and_open_is_rejected(self):
        saved = self.save()
        original = os.fstat

        def changed(descriptor):
            info = original(descriptor)
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0,
                                   st_dev=info.st_dev, st_ino=info.st_ino + 1)

        with patch("frameweave.local_assets.os.fstat", side_effect=changed):
            with self.assertRaisesRegex(ValueError, "打开时发生变化"):
                self.store.read(saved["asset_id"])


if __name__ == "__main__":
    unittest.main()
