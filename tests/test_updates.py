import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from email.message import Message
from pathlib import Path

from frameweave.updates import (
    MANIFEST_URL,
    RAW_RELEASES_PREFIX,
    UpdateError,
    UpdateManager,
    compare_versions,
)


def make_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            if mode is not None:
                info.external_attr = mode << 16
            archive.writestr(info, data)
    return buffer.getvalue()


class FakeResponse:
    def __init__(self, payload):
        self._stream = io.BytesIO(payload)
        self.headers = Message()
        self.headers["Content-Length"] = str(len(payload))

    def read(self, amount=-1):
        return self._stream.read(amount)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self._stream.close()


class FixtureOpener:
    def __init__(self, replies):
        self.replies = replies
        self.requests = []
        self.timeouts = []

    def __call__(self, request, timeout):
        self.requests.append(request.full_url)
        self.timeouts.append(timeout)
        try:
            return FakeResponse(self.replies[request.full_url])
        except KeyError as exc:
            raise AssertionError(f"Unexpected URL: {request.full_url}") from exc


def manifest_for(archive: bytes, version="1.2.0", **artifact_overrides):
    exe = b"small test payload"
    artifact = {
        "name": f"PrismCanvas-v{version}-Windows-x64.zip",
        "kind": "Windows x64 portable",
        "bytes": len(archive),
        "sha256": hashlib.sha256(archive).hexdigest(),
    }
    artifact.update(artifact_overrides)
    return json.dumps({
        "display_name": "棱光 PrismCanvas",
        "compatibility_identity": "FrameWeave",
        "version": version,
        "exe_bytes": len(exe),
        "exe_sha256": hashlib.sha256(exe).hexdigest(),
        "release_channel": "public-release",
        "published": True,
        "artifacts": [artifact, {
            "name": f"PrismCanvas-v{version}-source.zip",
            "kind": "Source",
            "bytes": len(archive),
            "sha256": hashlib.sha256(archive).hexdigest(),
        }],
    }).encode("utf-8")


class VersionTests(unittest.TestCase):
    def test_semver_stable_and_prerelease_order(self):
        self.assertEqual(compare_versions("v1.2.0", "1.2.0+build.7"), 0)
        self.assertEqual(compare_versions("1.2.0-rc.2", "1.2.0-rc.10"), -1)
        self.assertEqual(compare_versions("1.2.0-alpha", "1.2.0-alpha.1"), -1)
        self.assertEqual(compare_versions("1.2.0-rc.1", "1.2.0"), -1)
        self.assertEqual(compare_versions("1.3.0", "1.2.9"), 1)

    def test_rejects_invalid_version(self):
        with self.assertRaises(UpdateError):
            compare_versions("1.02.0", "1.2.0")


class UpdateManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.archive = make_zip([
            ("PrismCanvas/PrismCanvas.exe", b"small test payload", None),
            ("PrismCanvas/README.txt", b"portable package", None),
        ])

    def manager(self, *, current="1.0.0", archive=None, manifest=None, auto_check=False):
        archive = self.archive if archive is None else archive
        manifest = manifest or manifest_for(archive)
        opener = FixtureOpener({MANIFEST_URL: manifest, RAW_RELEASES_PREFIX + "PrismCanvas-v1.2.0-Windows-x64.zip": archive})
        return UpdateManager(current, self.data_dir, auto_check=auto_check, opener=opener), opener

    def test_status_and_constructor_do_not_contact_network(self):
        manager, opener = self.manager(auto_check=True)
        state = manager.status()
        self.assertTrue(state["auto_check"])
        self.assertIsNone(state["last_checked"])
        self.assertEqual(opener.requests, [])

    def test_check_reads_existing_manifest_shape_and_uses_fixed_raw_url(self):
        manager, opener = self.manager()
        state = manager.check()
        self.assertTrue(state["update_available"])
        self.assertTrue(state["available"])
        self.assertEqual(state["new_version"], "1.2.0")
        self.assertEqual(state["release"]["version"], "1.2.0")
        self.assertEqual(
            opener.requests,
            [MANIFEST_URL],
        )
        self.assertEqual(state["release"]["sha256"], hashlib.sha256(self.archive).hexdigest())

    def test_stage_verifies_and_atomically_returns_staged_metadata_without_installing(self):
        manager, opener = self.manager()
        state = manager.stage()
        staged = state["staged"]
        path = Path(staged["path"])
        self.assertTrue(staged["verified"])
        self.assertFalse(staged["installed"])
        self.assertEqual(staged["exe_bytes"], len(b"small test payload"))
        self.assertEqual(staged["exe_sha256"], hashlib.sha256(b"small test payload").hexdigest())
        self.assertTrue(path.is_file())
        self.assertEqual(path.read_bytes(), self.archive)
        self.assertFalse(list(path.parent.glob("*.part")))
        self.assertEqual(opener.requests[0], MANIFEST_URL)
        self.assertEqual(opener.requests[1], RAW_RELEASES_PREFIX + path.name)

    def test_stage_reuses_previously_staged_verified_file(self):
        manager, _ = self.manager()
        first = manager.stage()["staged"]
        second = manager.stage()["staged"]
        self.assertEqual(first, second)

    def test_no_update_does_not_download(self):
        manager, opener = self.manager(current="1.2.0")
        state = manager.check()
        self.assertFalse(state["update_available"])
        with self.assertRaises(UpdateError):
            manager.stage()
        self.assertEqual(opener.requests, [MANIFEST_URL])

    def test_auto_check_is_opt_in_and_only_changes_local_preference(self):
        manager, opener = self.manager()
        manager.set_auto_check(True)
        manager.set_auto_check(False)
        self.assertFalse(manager.status()["auto_check"])
        self.assertEqual(opener.requests, [])

    def test_rejects_nonmatching_identity_and_local_candidate(self):
        for overrides in (
            {"compatibility_identity": "AnotherApp"},
            {"release_channel": "local-candidate"},
        ):
            body = json.loads(manifest_for(self.archive))
            body.update(overrides)
            opener = FixtureOpener({MANIFEST_URL: json.dumps(body).encode()})
            manager = UpdateManager("1.0.0", self.data_dir, opener=opener)
            with self.assertRaises(UpdateError):
                manager.check()

    def test_rejects_missing_or_mismatched_package_version(self):
        body = json.loads(manifest_for(self.archive))
        body["artifacts"] = [body["artifacts"][1]]
        opener = FixtureOpener({MANIFEST_URL: json.dumps(body).encode()})
        manager = UpdateManager("1.0.0", self.data_dir, opener=opener)
        with self.assertRaises(UpdateError):
            manager.check()

    def test_rejects_download_size_mismatch(self):
        body = json.loads(manifest_for(self.archive))
        body["artifacts"][0]["bytes"] += 1
        opener = FixtureOpener({
            MANIFEST_URL: json.dumps(body).encode(),
            RAW_RELEASES_PREFIX + "PrismCanvas-v1.2.0-Windows-x64.zip": self.archive,
        })
        manager = UpdateManager("1.0.0", self.data_dir, opener=opener)
        with self.assertRaises(UpdateError):
            manager.stage()
        self.assertEqual(list((self.data_dir / "updates" / "staged").glob("*")), [])

    def test_rejects_hash_mismatch(self):
        body = json.loads(manifest_for(self.archive))
        body["artifacts"][0]["sha256"] = "0" * 64
        opener = FixtureOpener({
            MANIFEST_URL: json.dumps(body).encode(),
            RAW_RELEASES_PREFIX + "PrismCanvas-v1.2.0-Windows-x64.zip": self.archive,
        })
        manager = UpdateManager("1.0.0", self.data_dir, opener=opener)
        with self.assertRaises(UpdateError):
            manager.stage()
        self.assertEqual(list((self.data_dir / "updates" / "staged").glob("*")), [])

    def test_rejects_manifest_over_limit(self):
        opener = FixtureOpener({MANIFEST_URL: b" " * 128})
        manager = UpdateManager("1.0.0", self.data_dir, max_manifest_bytes=32, opener=opener)
        with self.assertRaises(UpdateError):
            manager.check()

    def test_rejects_untrusted_manifest_artifact_url(self):
        bad_url = "https://example.com/PrismCanvas-v1.2.0-Windows-x64.zip"
        opener = FixtureOpener({MANIFEST_URL: manifest_for(self.archive, url=bad_url)})
        manager = UpdateManager("1.0.0", self.data_dir, opener=opener)
        with self.assertRaises(UpdateError):
            manager.check()

    def test_failed_check_is_reported_in_status(self):
        opener = FixtureOpener({MANIFEST_URL: b"not-json"})
        manager = UpdateManager("1.0.0", self.data_dir, opener=opener)
        with self.assertRaises(UpdateError):
            manager.check()
        self.assertIsNotNone(manager.status()["last_error"])
        self.assertIsNotNone(manager.status()["last_checked"])

    def test_zip_rejects_parent_absolute_backslash_and_windows_drive_paths(self):
        for name in ("../outside.txt", "/outside.txt", "C:/outside.txt", "dir\\outside.txt"):
            with self.subTest(name=name):
                archive = make_zip([(name, b"x", None)])
                if "\\" in name:
                    archive = archive.replace(b"dir/outside.txt", b"dir\\outside.txt")
                manager, _ = self.manager(archive=archive)
                with self.assertRaises(UpdateError):
                    manager.stage()

    def test_zip_rejects_symlinks(self):
        archive = make_zip([("link", b"target", 0o120777)])
        manager, _ = self.manager(archive=archive)
        with self.assertRaises(UpdateError):
            manager.stage()

    def test_zip_rejects_duplicate_case_insensitive_paths(self):
        archive = make_zip([("App.exe", b"a", None), ("app.exe", b"b", None)])
        manager, _ = self.manager(archive=archive)
        with self.assertRaises(UpdateError):
            manager.stage()

    def test_zip_rejects_too_many_entries(self):
        entries = [(f"f{i}.txt", b"x", None) for i in range(2_001)]
        archive = make_zip(entries)
        manager, _ = self.manager(archive=archive)
        with self.assertRaises(UpdateError):
            manager.stage()

    def test_existing_corrupt_stage_is_not_overwritten(self):
        manager, _ = self.manager()
        manager.check()
        target = manager.staging_dir / "PrismCanvas-v1.2.0-Windows-x64.zip"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"keep my existing file")
        with self.assertRaises(UpdateError):
            manager.stage()
        self.assertEqual(target.read_bytes(), b"keep my existing file")


if __name__ == "__main__":
    unittest.main()
