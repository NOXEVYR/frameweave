import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frameweave.updates import (
    GITHUB_RELEASES_PREFIX,
    MANIFEST_URL,
    MAX_BACKGROUND_DOWNLOAD_BYTES,
    RAW_RELEASES_PREFIX,
    UpdateError,
    UpdateManager,
)
from test_updates import FixtureOpener, make_zip, manifest_for


class UpdateIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data_dir = Path(self.temp.name)
        self.archive = make_zip([("PrismCanvas/PrismCanvas.exe", b"small test payload", None)])
        self.body = json.loads(manifest_for(self.archive))
        self.archive_url = RAW_RELEASES_PREFIX + self.body["artifacts"][0]["name"]

    def manager(self, body=None, archive=None):
        payload = json.dumps(self.body if body is None else body).encode()
        opener = FixtureOpener({MANIFEST_URL: payload, self.archive_url: self.archive if archive is None else archive})
        return UpdateManager("1.0.0", self.data_dir, opener=opener), opener

    def test_legacy_public_0111_manifest_remains_compatible_without_download(self):
        # Read only the historical manifest's identity shape; no remote package.
        path = Path(__file__).resolve().parents[1] / "releases" / "release-manifest-v0.11.1.json"
        opener = FixtureOpener({MANIFEST_URL: path.read_bytes()})
        manager = UpdateManager("0.11.0", self.data_dir, opener=opener)
        release = manager.check()["release"]
        self.assertEqual((release["app"], release["platform"], release["arch"], release["channel"]),
                         ("FrameWeave", "windows", "x64", "stable"))
        self.assertEqual(release["version"], "0.11.1")
        self.assertEqual(opener.requests, [MANIFEST_URL])

    def test_manifest_source_is_pinned_even_to_other_official_files(self):
        for url in (RAW_RELEASES_PREFIX + "other.json", "https://example.com/feed.json"):
            with self.subTest(url=url), self.assertRaises(UpdateError):
                UpdateManager("1.0.0", self.data_dir, manifest_url=url)

    def test_explicit_manifest_and_artifact_identity_conflicts_are_rejected(self):
        conflicts = {
            "compatibility_identity": "Other", "app": "Other", "app_id": "Other",
            "application": "Other", "platform": "linux", "arch": "arm64",
            "architecture": "x86", "channel": "beta", "release_channel": "source-candidate",
            "published": False, "prerelease": True, "draft": True, "source_candidate": True,
            "download_mode": "delta", "platform_null": None,
        }
        for scope in ("manifest", "artifact"):
            for field, value in conflicts.items():
                field = "platform" if field == "platform_null" else field
                with self.subTest(scope=scope, field=field, value=value):
                    body = copy.deepcopy(self.body)
                    target = body if scope == "manifest" else body["artifacts"][0]
                    target[field] = value
                    manager, opener = self.manager(body)
                    with self.assertRaises(UpdateError):
                        manager.check()
                    self.assertFalse(manager.status()["update_available"])
                    self.assertEqual(opener.requests, [MANIFEST_URL])

    def test_stable_channel_rejects_prerelease_even_if_marked_published(self):
        body = json.loads(manifest_for(self.archive, version="1.3.0-rc.1"))
        manager, _ = self.manager(body)
        with self.assertRaisesRegex(UpdateError, "预发布"):
            manager.check()

    def test_stage_requires_strictly_higher_version(self):
        for current in ("1.2.0", "1.2.0+local.3", "2.0.0"):
            with self.subTest(current=current):
                manager, opener = self.manager()
                manager.current_version = current
                self.assertFalse(manager.check()["update_available"])
                with self.assertRaises(UpdateError):
                    manager.stage()
                self.assertEqual(opener.requests, [MANIFEST_URL])

    def test_duplicate_identical_and_legacy_alias_archives_are_rejected(self):
        for name in (self.body["artifacts"][0]["name"], "FrameWeave-v1.2.0-Windows-x64.zip"):
            with self.subTest(name=name):
                body = copy.deepcopy(self.body)
                duplicate = copy.deepcopy(body["artifacts"][0])
                duplicate["name"] = name
                body["artifacts"].append(duplicate)
                manager, _ = self.manager(body)
                with self.assertRaisesRegex(UpdateError, "歧义"):
                    manager.check()

    def test_download_url_must_bind_basename_and_release_tag(self):
        name = self.body["artifacts"][0]["name"]
        invalid = (
            RAW_RELEASES_PREFIX + "PrismCanvas-v1.1.0-Windows-x64.zip",
            RAW_RELEASES_PREFIX + "nested/" + name,
            GITHUB_RELEASES_PREFIX + "v1.1.0/" + name,
        )
        for url in invalid:
            with self.subTest(url=url):
                body = copy.deepcopy(self.body)
                body["artifacts"][0]["download_url"] = url
                manager, _ = self.manager(body)
                with self.assertRaises(UpdateError):
                    manager.check()
        for tag in ("v1.2.0", "1.2.0"):
            body = copy.deepcopy(self.body)
            body["artifacts"][0]["download_url"] = GITHUB_RELEASES_PREFIX + tag + "/" + name
            manager, _ = self.manager(body)
            self.assertTrue(manager.check()["update_available"])

    def test_source_kind_cannot_disguise_a_windows_package(self):
        body = copy.deepcopy(self.body)
        body["artifacts"][0]["kind"] = "source"
        manager, _ = self.manager(body)
        with self.assertRaises(UpdateError):
            manager.check()

    def test_manifest_digest_and_optional_build_id_flow_to_verified_stage(self):
        body = copy.deepcopy(self.body)
        body["build_id"] = "release-120.7"
        body["artifacts"][0]["build_id"] = body["build_id"]
        manager, opener = self.manager(body)
        release = manager.check()["release"]
        identity = release["identity"]
        self.assertEqual(identity["manifest_sha256"], hashlib.sha256(opener.replies[MANIFEST_URL]).hexdigest())
        self.assertEqual(identity["build_id"], body["build_id"])
        staged = manager.stage(expected_identity=identity)["staged"]
        self.assertTrue(staged["verified"])
        self.assertEqual(staged["identity"], identity)
        self.assertEqual(staged["manifest_sha256"], identity["manifest_sha256"])
        self.assertEqual(staged["build_id"], identity["build_id"])

    def test_build_id_conflict_and_invalid_types_are_rejected(self):
        for build_id in ("other-build", None, {}, "../escape", ""):
            with self.subTest(build_id=build_id):
                body = copy.deepcopy(self.body)
                body["build_id"] = "release-120"
                body["artifacts"][0]["build_id"] = build_id
                manager, _ = self.manager(body)
                with self.assertRaises(UpdateError):
                    manager.check()

    def test_public_identity_cannot_mutate_internal_release(self):
        manager, _ = self.manager()
        release = manager.check()["release"]
        original = copy.deepcopy(release["identity"])
        release["identity"]["bytes"] = 1
        self.assertEqual(manager.status()["release"]["identity"], original)
        stage = manager.stage(expected_identity=original)["staged"]
        stage["identity"]["sha256"] = "0" * 64
        self.assertEqual(manager.status()["staged"]["identity"], original)

    def test_recheck_changed_manifest_invalidates_old_confirmation_before_download(self):
        manager, opener = self.manager()
        original = manager.check()["release"]["identity"]
        changed = copy.deepcopy(self.body)
        changed["build_id"] = "new-build"
        opener.replies[MANIFEST_URL] = json.dumps(changed).encode()
        manager.check()
        with self.assertRaisesRegex(UpdateError, "身份已变化"):
            manager.stage(expected_identity=original, allow_large=True)
        self.assertEqual(opener.requests, [MANIFEST_URL, MANIFEST_URL])
        self.assertFalse(manager.staging_dir.exists())

    def test_failed_recheck_removes_old_download_candidate(self):
        manager, opener = self.manager()
        manager.check()
        opener.replies[MANIFEST_URL] = b"invalid"
        with self.assertRaises(UpdateError):
            manager.check()
        self.assertIsNone(manager.status()["release"])
        self.assertFalse(manager.status()["update_available"])

    def test_large_archive_refused_before_any_archive_request_or_directory_write(self):
        body = copy.deepcopy(self.body)
        body["artifacts"][0]["bytes"] = MAX_BACKGROUND_DOWNLOAD_BYTES + 1
        manager, opener = self.manager(body)
        release = manager.check()["release"]
        self.assertTrue(manager.status()["requires_download_confirmation"])
        for allow_large in (False, 1, "true"):
            with self.subTest(allow_large=allow_large), self.assertRaisesRegex(UpdateError, "50 MiB"):
                manager.stage(expected_identity=release["identity"], allow_large=allow_large)
        self.assertEqual(opener.requests, [MANIFEST_URL])
        self.assertFalse(manager.staging_dir.exists())
        self.assertEqual(manager.status()["actual_download_bytes"], 0)

    def test_allow_large_download_and_cache_reuse_without_permission_use_real_byte_counts(self):
        # Lower only the consent limit for this fixture instead of creating or
        # downloading a real >50 MiB package.
        manager, opener = self.manager()
        with patch("frameweave.updates.MAX_BACKGROUND_DOWNLOAD_BYTES", 1):
            identity = manager.check()["release"]["identity"]
            with self.assertRaises(UpdateError):
                manager.stage(expected_identity=identity)
            first = manager.stage(expected_identity=identity, allow_large=True)
            self.assertEqual(first["download_mode"], "full-archive")
            self.assertEqual(first["download_bytes"], len(self.archive))
            self.assertEqual(first["actual_download_bytes"], len(self.archive))
            self.assertEqual(first["staged"]["download_bytes"], len(self.archive))
            second = manager.stage(expected_identity=identity)
            self.assertEqual(second["actual_download_bytes"], 0)
            self.assertEqual(second["staged"], first["staged"])
        self.assertEqual(opener.requests, [MANIFEST_URL, self.archive_url])

    def test_archive_hash_success_is_insufficient_without_exe_hash_and_size(self):
        for replacement in (b"small test payloaD", b"wrong-sized"):
            with self.subTest(replacement=replacement):
                archive = make_zip([("PrismCanvas/PrismCanvas.exe", replacement, None)])
                body = json.loads(manifest_for(archive))
                manager, _ = self.manager(body, archive)
                with self.assertRaisesRegex(UpdateError, "EXE"):
                    manager.stage()
                self.assertIsNone(manager.status()["staged"])
                self.assertFalse(list(manager.staging_dir.glob("*.zip")))
                self.assertFalse(list(manager.staging_dir.glob("*.part")))

    def test_archive_must_contain_exactly_one_application_executable(self):
        for entries in (
            [("readme.txt", b"no exe", None)],
            [("PrismCanvas.exe", b"small test payload", None), ("FrameWeave.exe", b"small test payload", None)],
        ):
            with self.subTest(entries=entries):
                archive = make_zip(entries)
                manager, _ = self.manager(json.loads(manifest_for(archive)), archive)
                with self.assertRaisesRegex(UpdateError, "唯一"):
                    manager.stage()
                self.assertIsNone(manager.status()["staged"])

    def test_existing_archive_is_revalidated_against_executable_identity(self):
        bad_archive = make_zip([("PrismCanvas.exe", b"small test payloaD", None)])
        manager, opener = self.manager(json.loads(manifest_for(bad_archive)), bad_archive)
        manager.check()
        target = manager.staging_dir / self.body["artifacts"][0]["name"]
        target.parent.mkdir(parents=True)
        target.write_bytes(bad_archive)
        with self.assertRaisesRegex(UpdateError, "EXE"):
            manager.stage()
        self.assertEqual(target.read_bytes(), bad_archive)
        self.assertIsNone(manager.status()["staged"])
        self.assertEqual(opener.requests, [MANIFEST_URL, self.archive_url])


if __name__ == "__main__":
    unittest.main()
