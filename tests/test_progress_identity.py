import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from frameweave.progress_identity import FILENAME, load_progress_identity, persist_progress_identity, valid_client_id


class ProgressIdentityTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / FILENAME

    def job(self, identity=None, status='running', backend='http://127.0.0.1:8188'):
        return {'status': status, 'backend': backend, 'client_id': identity}

    def save(self, identity):
        self.path.write_text(json.dumps({'version': 1, 'client_id': identity}), encoding='utf8')

    def test_new_identity_is_bounded_and_stable_across_restarts(self):
        first, warning = load_progress_identity(self.root, {})
        self.assertTrue(valid_client_id(first))
        self.assertEqual(warning, '')
        self.assertLess(self.path.stat().st_size, 1024)
        self.assertEqual(load_progress_identity(self.root, {})[0], first)

    def test_unique_active_identity_wins_over_saved_default_without_overwriting(self):
        saved, original = 'frameweave-' + 'a' * 32, 'b' * 32
        self.save(saved)
        content = self.path.read_bytes()
        identity, warning = load_progress_identity(self.root, {'ours': self.job(original)})
        self.assertEqual(identity, original)
        self.assertEqual(warning, '')
        self.assertEqual(self.path.read_bytes(), content)

    def test_unique_active_identity_is_saved_if_no_identity_file_exists(self):
        original = 'frameweave-' + 'b' * 32
        self.assertEqual(load_progress_identity(self.root, [self.job(original)])[0], original)
        self.assertEqual(load_progress_identity(self.root, {})[0], original)

    def test_terminal_and_other_backend_jobs_cannot_select_identity(self):
        saved = 'frameweave-' + 'a' * 32
        self.save(saved)
        jobs = [self.job('b' * 32, status='completed'), self.job('c' * 32, backend='http://127.0.0.1:8189')]
        identity, warning = load_progress_identity(self.root, jobs, 'http://127.0.0.1:8188')
        self.assertEqual(identity, saved)
        self.assertEqual(warning, '')

    def test_multiple_active_identities_use_saved_default_and_warn_without_disclosing_ids(self):
        saved = 'frameweave-' + 'a' * 32
        self.save(saved)
        first, second = 'b' * 32, 'c' * 32
        identity, warning = load_progress_identity(self.root, [self.job(first), self.job(second)])
        self.assertEqual(identity, saved)
        self.assertIn('多个', warning)
        self.assertNotIn(first, warning)
        self.assertNotIn(second, warning)

    def test_legacy_jobs_without_identity_warn(self):
        identity, warning = load_progress_identity(self.root, [self.job()])
        self.assertTrue(valid_client_id(identity))
        self.assertIn('旧任务', warning)

    def test_corrupt_oversized_and_invalid_identity_files_are_preserved(self):
        for raw in (b'{invalid', b'x' * 1025, b'{"version":true,"client_id":"' + b'a'*32 + b'"}',
                    b'{"version":1,"client_id":"secret-invalid-token"}'):
            self.path.write_bytes(raw)
            identity, warning = load_progress_identity(self.root, {})
            self.assertTrue(valid_client_id(identity))
            self.assertIn('保留原件', warning)
            self.assertNotIn('secret-invalid-token', warning)
            self.assertEqual(self.path.read_bytes(), raw)

    def test_write_failure_does_not_block_generation_identity(self):
        with patch.object(Path, 'open', side_effect=PermissionError('private-path')):
            identity, warning = load_progress_identity(self.root, [])
        self.assertTrue(valid_client_id(identity))
        self.assertTrue(warning)
        self.assertNotIn('private-path', warning)
        with patch.object(Path, 'open', side_effect=FileNotFoundError):
            identity, warning = load_progress_identity(self.root, [])
        self.assertTrue(valid_client_id(identity))
        self.assertIn('无法保存', warning)

    def test_accepts_only_uuid_hex_or_existing_frameweave_format(self):
        for identity in ('a' * 32, 'frameweave-' + 'b' * 32):
            self.assertTrue(valid_client_id(identity))
        for identity in ('a' * 33, 'A' * 32, '../' + 'a' * 32, 'frameweave-' + 'z' * 32, None, [], ''):
            self.assertFalse(valid_client_id(identity))

    def test_read_only_load_keeps_discovery_directory_empty_until_real_submission(self):
        identity, warning = load_progress_identity(self.root, {}, persist=False)
        self.assertTrue(valid_client_id(identity))
        self.assertEqual(warning, '')
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(persist_progress_identity(self.root, identity), '')
        self.assertEqual(load_progress_identity(self.root, {}, persist=False)[0], identity)

    def test_read_only_active_identity_recovery_does_not_create_file(self):
        original = 'frameweave-' + 'b' * 32
        identity, warning = load_progress_identity(self.root, [self.job(original)], persist=False)
        self.assertEqual(identity, original)
        self.assertEqual(warning, '')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_explicit_persist_preserves_valid_and_corrupt_existing_files(self):
        self.save('a' * 32)
        original = self.path.read_bytes()
        self.assertEqual(persist_progress_identity(self.root, 'b' * 32), '')
        self.assertEqual(self.path.read_bytes(), original)
        self.path.write_bytes(b'{invalid-original')
        warning = persist_progress_identity(self.root, 'b' * 32)
        self.assertIn('保留原件', warning)
        self.assertEqual(self.path.read_bytes(), b'{invalid-original')

    def test_explicit_persist_failure_warns_without_exposing_identity_or_path(self):
        identity = 'a' * 32
        with patch.object(Path, 'open', side_effect=FileNotFoundError('private-path')):
            warning = persist_progress_identity(self.root, identity)
        self.assertIn('无法保存', warning)
        self.assertNotIn(identity, warning)
        self.assertNotIn('private-path', warning)

    def test_explicit_persist_invalid_identity_does_not_create_file(self):
        warning = persist_progress_identity(self.root, 'secret-invalid-token')
        self.assertIn('无效', warning)
        self.assertNotIn('secret-invalid-token', warning)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
