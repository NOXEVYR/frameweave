import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from frameweave.updates import UpdateError
from frameweave.update_install import prepare_install


EXE_BYTES = b"validated portable executable payload"


def make_archive(entries=None):
    if entries is None:
        entries = [("PrismCanvas/PrismCanvas.exe", EXE_BYTES, None),
                   ("PrismCanvas/readme.txt", b"not extracted", None)]
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data, mode in entries:
            item = zipfile.ZipInfo(name)
            if mode is not None:
                item.external_attr = mode << 16
            archive.writestr(item, data)
    return stream.getvalue()


class PrepareInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive_bytes = make_archive()
        self.archive_path = self.root / "staged.zip"
        self.archive_path.write_bytes(self.archive_bytes)
        self.install_base = self.root / "PrismCanvas"
        self.current_exe = self.install_base / "0.8.0" / "PrismCanvas.exe"
        self.current_exe.parent.mkdir(parents=True)
        self.current_exe.write_bytes(b"old release stays here")
        self.staged = {
            "version": "0.9.0",
            "filename": "PrismCanvas-v0.9.0-Windows-x64.zip",
            "path": str(self.archive_path),
            "bytes": len(self.archive_bytes),
            "sha256": hashlib.sha256(self.archive_bytes).hexdigest(),
            "exe_bytes": len(EXE_BYTES),
            "exe_sha256": hashlib.sha256(EXE_BYTES).hexdigest(),
            "verified": True,
            "installed": False,
        }

    def test_extracts_only_verified_exe_into_new_version_and_preserves_old(self):
        result = prepare_install(self.staged, self.install_base, self.current_exe)
        candidate = Path(result["path"])
        self.assertEqual(candidate, self.install_base / "PrismCanvas-0.9.0" / "PrismCanvas.exe")
        self.assertEqual(candidate.read_bytes(), EXE_BYTES)
        self.assertEqual(self.current_exe.read_bytes(), b"old release stays here")
        self.assertEqual([p.name for p in candidate.parent.iterdir()], ["PrismCanvas.exe"])
        self.assertEqual(result["bytes"], len(EXE_BYTES))
        self.assertEqual(result["sha256"], hashlib.sha256(EXE_BYTES).hexdigest())
        self.assertTrue(result["verified"])
        self.assertFalse(result["installed"])
        self.assertEqual(result["previous_exe"], str(self.current_exe.resolve()))

    def test_rejects_unverified_staged_metadata(self):
        for value in (None, {}, {**self.staged, "verified": False}):
            with self.subTest(value=value):
                with self.assertRaises(UpdateError):
                    prepare_install(value, self.install_base, self.current_exe)

    def test_retry_reuses_matching_candidate_without_overwriting_files(self):
        first = prepare_install(self.staged, self.install_base, self.current_exe)
        candidate = Path(first["path"])
        stamp = candidate.stat().st_mtime_ns
        note = candidate.parent / "user-note.txt"
        note.write_text("keep", encoding="utf-8")
        second = prepare_install(self.staged, self.install_base, self.current_exe)
        self.assertEqual(first, second)
        self.assertEqual(candidate.stat().st_mtime_ns, stamp)
        self.assertEqual(note.read_text(encoding="utf-8"), "keep")

    def test_retry_rejects_modified_candidate(self):
        first = prepare_install(self.staged, self.install_base, self.current_exe)
        candidate = Path(first["path"])
        candidate.write_bytes(b"modified")
        with self.assertRaises(UpdateError):
            prepare_install(self.staged, self.install_base, self.current_exe)
        self.assertEqual(candidate.read_bytes(), b"modified")

    def test_rejects_changed_archive(self):
        self.archive_path.write_bytes(b"changed after staging")
        with self.assertRaises(UpdateError):
            prepare_install(self.staged, self.install_base, self.current_exe)
        self.assertFalse((self.install_base / "PrismCanvas-0.9.0").exists())

    def test_rejects_exe_hash_or_size_mismatch(self):
        for change in (
            {"exe_sha256": "0" * 64},
            {"exe_bytes": len(EXE_BYTES) + 1},
        ):
            with self.subTest(change=change):
                with self.assertRaises(UpdateError):
                    prepare_install({**self.staged, **change}, self.install_base, self.current_exe)
                self.assertFalse((self.install_base / "PrismCanvas-0.9.0").exists())

    def test_requires_exactly_one_prismcanvas_exe(self):
        for entries in (
            [("readme.txt", b"no executable", None)],
            [
                ("one/PrismCanvas.exe", EXE_BYTES, None),
                ("two/PrismCanvas.exe", EXE_BYTES, None),
            ],
        ):
            with self.subTest(entries=entries):
                self._replace_archive(entries)
                with self.assertRaises(UpdateError):
                    prepare_install(self.staged, self.install_base, self.current_exe)
                self.assertFalse((self.install_base / "PrismCanvas-0.9.0").exists())

    def test_rejects_link_executable(self):
        self._replace_archive([("PrismCanvas.exe", EXE_BYTES, 0o120777)])
        with self.assertRaises(UpdateError):
            prepare_install(self.staged, self.install_base, self.current_exe)
        self.assertFalse((self.install_base / "PrismCanvas-0.9.0").exists())

    def test_refuses_to_overwrite_existing_version_directory(self):
        target = self.install_base / "PrismCanvas-0.9.0"
        target.mkdir(parents=True)
        existing = target / "notes.txt"
        existing.write_text("preserve me", encoding="utf-8")
        with self.assertRaises(UpdateError):
            prepare_install(self.staged, self.install_base, self.current_exe)
        self.assertEqual(existing.read_text(encoding="utf-8"), "preserve me")

    def test_rejects_candidate_path_that_is_current_exe(self):
        target = self.install_base / "PrismCanvas-0.9.0"
        target.mkdir(parents=True)
        current_candidate = target / "PrismCanvas.exe"
        current_candidate.write_bytes(b"current")
        with self.assertRaises(UpdateError):
            prepare_install(self.staged, self.install_base, current_candidate)
        self.assertEqual(current_candidate.read_bytes(), b"current")

    def _replace_archive(self, entries):
        self.archive_bytes = make_archive(entries)
        self.archive_path.write_bytes(self.archive_bytes)
        self.staged["bytes"] = len(self.archive_bytes)
        self.staged["sha256"] = hashlib.sha256(self.archive_bytes).hexdigest()


if __name__ == "__main__":
    unittest.main()
