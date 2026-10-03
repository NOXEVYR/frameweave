import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from frameweave.configuration_recovery import preserve_config, read_config
from frameweave.server import App
from frameweave.settings_recovery import DEFAULTS, MAX_SETTINGS_BYTES, load_settings


class SettingsRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'settings.json'

    def write(self, value):
        raw = json.dumps(value).encode()
        self.path.write_bytes(raw)
        return raw

    def load(self):
        return load_settings(self.path, App.validate_roots)

    def app(self):
        app = App(self.root, self.root)
        self.addCleanup(app.closed.set)
        return app

    def test_missing_and_normal_settings_need_no_recovery(self):
        self.assertEqual(self.load(), (DEFAULTS, [], False))
        original = self.write({**DEFAULTS, 'backend_url': 'http://127.0.0.1:19777'})
        settings, warnings, protected = self.load()
        self.assertEqual(settings['backend_url'], 'http://127.0.0.1:19777')
        self.assertEqual(warnings, [])
        self.assertFalse(protected)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(list(self.root.glob('*.recovery-*')), [])

    def test_invalid_field_does_not_hide_valid_independent_fields(self):
        original = self.write({**DEFAULTS, 'backend_url': ['private-secret'],
                               'model_roots': [str(self.root)], 'comfy_roots': [str(self.root)],
                               'auto_start_engine': True, 'auto_update': True})
        settings, warnings, protected = self.load()
        self.assertEqual(settings['backend_url'], DEFAULTS['backend_url'])
        self.assertEqual(settings['model_roots'], [str(self.root.resolve())])
        self.assertEqual(settings['comfy_roots'], [str(self.root.resolve())])
        self.assertFalse(settings['auto_start_engine'])
        self.assertFalse(settings['auto_update'])
        self.assertIn('backend_url', '\n'.join(warnings))
        self.assertNotIn('private-secret', '\n'.join(warnings))
        self.assertNotIn(str(self.root), '\n'.join(warnings))
        self.assertFalse(protected)
        self.assertEqual(self.path.read_bytes(), original)

    def test_each_invalid_type_is_reported_without_crashing(self):
        bad = {'backend_url': 'https://private.example', 'model_roots': 'private-folder',
               'comfy_roots': [123], 'auto_start_engine': 'true', 'auto_update': 1,
               'performance_profile': []}
        self.write(bad)
        settings, warnings, protected = self.load()
        self.assertEqual(settings, DEFAULTS)
        for field in bad:
            self.assertIn(field, '\n'.join(warnings))
        self.assertFalse(protected)

    def test_repeated_malformed_load_reuses_backup_and_warning(self):
        for raw in (b'{broken', b'null', b'[]', b'\xff', b'x' * (MAX_SETTINGS_BYTES + 1)):
            with self.subTest(raw=raw[:8]):
                self.path.write_bytes(raw)
                first = self.load()
                count = len(list(self.root.glob('settings.recovery-*')))
                second = self.load()
                self.assertEqual(first, second)
                self.assertTrue(first[1])
                self.assertFalse(first[2])
                self.assertEqual(len(list(self.root.glob('settings.recovery-*'))), count)
                self.assertEqual(self.path.read_bytes(), raw)

    def test_backup_failure_blocks_settings_write_and_automatic_actions(self):
        original = self.write({**DEFAULTS, 'model_roots': 'invalid', 'auto_start_engine': True,
                               'auto_update': True})
        with patch('frameweave.settings_recovery.preserve_config', side_effect=OSError('secret-path')):
            with patch.object(App, 'start_saved_engine') as start, patch.object(App, 'begin_update') as update:
                app = self.app()
                start.assert_not_called()
                update.assert_not_called()
        self.assertIn('settings.json', app.recovery_protected_files)
        self.assertNotIn('secret-path', '\n'.join(app.recovery_warnings))
        with self.assertRaisesRegex(ValueError, '未保存'):
            app.save_settings(DEFAULTS)
        self.assertEqual(self.path.read_bytes(), original)

    def test_explicit_save_preserves_backup_and_next_start_is_clean(self):
        original = self.write({'backend_url': 0, 'performance_profile': 'auto'})
        app = self.app()
        self.assertTrue(app.recovery_warnings)
        app.save_settings({**DEFAULTS, 'backend_url': 'http://127.0.0.1:19777'})
        backup, = self.root.glob('settings.recovery-*')
        self.assertEqual(backup.read_bytes(), original)
        restarted = self.app()
        self.assertFalse(restarted.recovery_warnings)
        self.assertEqual(restarted.backend.url, 'http://127.0.0.1:19777')


class ConfigBackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'engines.json'
        self.path.write_bytes(b'{bad')

    def test_backup_is_verified_deduplicated_and_independent_of_source(self):
        name = preserve_config(self.path)
        self.assertEqual(name, preserve_config(self.path))
        backup = self.root / name
        self.assertEqual(backup.read_bytes(), self.path.read_bytes())
        self.path.write_bytes(b'changed')
        self.assertEqual(backup.read_bytes(), b'{bad')
        self.assertEqual(list(self.root.glob('.config-recovery-*')), [])

    def test_digest_change_does_not_publish_stale_backup(self):
        with self.assertRaisesRegex(OSError, '变化'):
            preserve_config(self.path, expected_digest=hashlib.sha256(b'old').hexdigest())
        self.assertEqual(list(self.root.glob('*.recovery-*')), [])
        self.assertEqual(list(self.root.glob('.config-recovery-*')), [])
        self.assertEqual(self.path.read_bytes(), b'{bad')

    def test_existing_conflicting_backup_is_never_overwritten(self):
        digest = hashlib.sha256(self.path.read_bytes()).hexdigest()[:24]
        backup = self.root / f'engines.recovery-{digest}.json'
        backup.write_bytes(b'other')
        with self.assertRaisesRegex(OSError, '校验失败'):
            preserve_config(self.path)
        self.assertEqual(backup.read_bytes(), b'other')
        self.assertEqual(self.path.read_bytes(), b'{bad')

    def test_read_and_backup_have_independent_size_limits(self):
        with self.assertRaises(ValueError):
            read_config(self.path, 2)
        with patch('frameweave.configuration_recovery.MAX_BACKUP_BYTES', 2):
            with self.assertRaises(OSError):
                preserve_config(self.path)
        self.assertEqual(list(self.root.glob('*.recovery-*')), [])

    def test_failed_atomic_publish_leaves_original_and_no_stage(self):
        with patch('frameweave.configuration_recovery.os.link', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                preserve_config(self.path)
        self.assertEqual(self.path.read_bytes(), b'{bad')
        self.assertEqual(list(self.root.glob('.config-recovery-*')), [])

    def test_directory_is_never_treated_as_regular_config(self):
        with self.assertRaises(OSError):
            preserve_config(self.root)


if __name__ == '__main__':
    unittest.main()
