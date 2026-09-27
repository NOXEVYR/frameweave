import base64
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from frameweave.server import App
from test_service import PNG


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.url = 'http://127.0.0.1:12345'
        self.good = {'id': 'good', 'backend': self.url, 'status': 'completed', 'created_at': 1, 'outputs': []}

    def app(self, backend=None):
        result = App(self.root, self.root, backend or self.url)
        self.addCleanup(result.closed.set)
        return result

    def write_jobs(self, values):
        content = json.dumps(values)
        (self.root/'jobs.json').write_text(content, encoding='utf8')
        return content

    def test_one_bad_record_does_not_hide_other_jobs_and_original_is_backed_up(self):
        broken = {**self.good, 'id': 'broken', 'outputs': [{'type': 'image'}]}
        original = self.write_jobs([self.good, broken])
        app = self.app()
        self.assertEqual([j['id'] for j in app.job_list()['jobs']], ['good'])
        self.assertTrue(app.recovery_warnings)
        backup, = self.root.glob('jobs.recovery-*.json')
        self.assertEqual(backup.read_text(encoding='utf8'), original)
        app.persist_jobs()
        self.assertEqual(backup.read_text(encoding='utf8'), original)

    def test_bad_record_types_and_nonfinite_times_are_isolated(self):
        self.write_jobs([None, {**self.good, 'id': []}, {**self.good, 'id': 'bad-time', 'created_at': 'today'},
                         {**self.good, 'id': 'nan-time', 'created_at': float('nan')}, self.good])
        self.assertEqual(len(self.app().job_list()['jobs']), 1)

    def test_backup_failure_prevents_later_overwrite(self):
        original = self.write_jobs([self.good, None])
        with patch('frameweave.recovery.shutil.copy2', side_effect=OSError('disk full')):
            app = self.app()
        with self.assertRaises(OSError):
            app.persist_jobs()
        self.assertEqual((self.root/'jobs.json').read_text(encoding='utf8'), original)

    def test_temp_output_storage_type_and_url_survive_restart(self):
        self.write_jobs([{**self.good, 'outputs': [{'type': 'image', 'filename': 'preview.png', 'storage_type': 'temp'}]}])
        app = self.app()
        output = app.job_list()['jobs'][0]['outputs'][0]
        self.assertEqual(app.media[output['url'].split('/')[-1]][1]['type'], 'temp')

    def test_protected_jobs_prevents_inference_before_backend_side_effect(self):
        original = self.write_jobs([self.good, None])
        with patch('frameweave.recovery.shutil.copy2', side_effect=OSError('disk full')):
            app = self.app()
        with patch.object(app.backend, 'request') as request:
            with self.assertRaisesRegex(ValueError, '未提交生成'):
                app._dispatch({'prompt': {'1': {'class_type': 'Example', 'inputs': {}}}}, 'api')
            request.assert_not_called()
        self.assertEqual((self.root/'jobs.json').read_text(encoding='utf8'), original)
        self.assertFalse((self.root/'runs').exists())

    def test_protected_inputs_prevents_both_media_uploads(self):
        original = '[null]'
        (self.root/'input-media.json').write_text(original, encoding='utf8')
        with patch('frameweave.recovery.shutil.copy2', side_effect=OSError('disk full')):
            app = self.app()
        with patch.object(app.backend, 'upload') as upload:
            for method in (app.upload, app.upload_audio):
                with self.assertRaisesRegex(ValueError, '未上传'):
                    method({'data': base64.b64encode(PNG).decode()})
            upload.assert_not_called()
        self.assertEqual((self.root/'input-media.json').read_text(encoding='utf8'), original)

    def test_uploaded_reference_restores_same_preview_url_with_backend_owner(self):
        first = self.app()
        with patch.object(first.backend, 'upload', return_value={'name': 'reference.png', 'subfolder': 'refs', 'type': 'input'}):
            result = first.upload({'data': base64.b64encode(PNG).decode()})
        key = result['url'].split('/')[-1]
        second = self.app('http://127.0.0.1:12346')
        self.assertEqual(second.media[key], first.media[key])
        self.assertNotIn(result['name'], second.uploaded)
        third = self.app()
        self.assertIn(result['name'], third.uploaded)

    def test_corrupt_input_does_not_grant_external_or_traversal_media_access(self):
        records = [{'backend': 'https://example.com', 'filename': 'image.png'},
                   {'backend': self.url, 'filename': '../private.png'},
                   {'backend': self.url, 'filename': 'okay.png', 'subfolder': '', 'storage_type': 'input'}]
        (self.root/'input-media.json').write_text(json.dumps(records), encoding='utf8')
        app = self.app()
        self.assertEqual(len(app.media), 1)
        self.assertTrue(app.recovery_warnings)

    def test_malformed_file_can_recover_without_preventing_startup(self):
        (self.root/'jobs.json').write_text('{broken', encoding='utf8')
        app = self.app()
        self.assertEqual(app.job_list()['jobs'], [])
        self.assertTrue(app.recovery_warnings)


if __name__ == '__main__':
    unittest.main()
