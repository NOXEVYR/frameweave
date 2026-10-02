"""Explicit media synchronization pins backend identity without submitting jobs."""
import json
import unittest
from unittest.mock import patch

from frameweave.backend import Backend
from frameweave.packages import validate_package_media_field
import test_local_assets as asset_fixture


class EditorMediaSyncHTTPTests(unittest.TestCase):
    setUp = asset_fixture.LocalImageAssetHTTPTests.setUp
    start_client = asset_fixture.LocalImageAssetHTTPTests.start_client
    stop_client = asset_fixture.LocalImageAssetHTTPTests.stop_client
    request = asset_fixture.LocalImageAssetHTTPTests.request
    post = asset_fixture.LocalImageAssetHTTPTests.post
    import_image = asset_fixture.LocalImageAssetHTTPTests.import_image
    post_media = asset_fixture.LocalImageAssetHTTPTests.post_media
    upload_video = asset_fixture.LocalImageAssetHTTPTests.upload_video
    assert_no_generation = asset_fixture.LocalImageAssetHTTPTests.assert_no_generation

    def image_paths(self):
        _, _, image = self.import_image()
        _, _, raw = self.post_media(asset_fixture.PNG, 'image.png', 'image/png')
        media = json.loads(raw)
        return [f"/api/assets/images/{image['asset_id']}/backend-input",
                f"/api/assets/media/{media['asset_id']}/backend-input"]

    def test_expected_backend_rejects_stale_and_invalid_targets_before_upload(self):
        for path in self.image_paths():
            for value in ('http://127.0.0.1:1', 'https://example.org', '', None, {}, 2):
                with self.subTest(path=path, value=value), patch.object(self.app.backend, 'upload') as upload:
                    self.assertEqual(self.post(path, {'expected_backend': value})[0], 400)
                    upload.assert_not_called()
        self.assert_no_generation()

    def test_expected_backend_current_image_sync_preserves_legacy_api(self):
        for path in self.image_paths():
            with patch.object(self.app.backend, 'upload', return_value={'name': 'safe.png', 'type': 'input'}):
                status, _, data = self.post(path, {'expected_backend': self.backend.url})
            self.assertEqual(status, 200, data)
            self.assertEqual(data['backend'], self.backend.url)
        self.assert_no_generation()

    def test_backend_object_change_after_pinning_rejects_same_url_aba(self):
        for path in self.image_paths():
            original = self.app.backend
            def change_backend(data):
                self.app.backend = Backend(original.url)
                return original
            with patch.object(self.app, 'media_sync_backend', side_effect=change_backend), patch.object(original, 'upload') as upload:
                self.assertEqual(self.post(path, {'expected_backend': original.url})[0], 400)
                upload.assert_not_called()
            self.app.backend = original
        self.assert_no_generation()

    def video(self):
        _, _, asset = self.upload_video()
        package = self.app.packages.save({'name': 'video sync', 'description': '',
            'prompt': {'7': {'class_type': 'LoadVideo', 'inputs': {'file': '', 'mode': 'default'}}},
            'fields': [{'id': 'clip', 'node_id': '7', 'input': 'file', 'type': 'video', 'label': 'clip', 'default': ''},
                       {'id': 'mode', 'node_id': '7', 'input': 'mode', 'type': 'text', 'label': 'mode', 'default': 'default'}]})
        self.backend.info['LoadVideo'] = {'input': {'required': {'file': ['COMBO', {'options': [], 'video_upload': True}],
            'mode': ['STRING', {'default': 'default'}]}}, 'output': ['VIDEO']}
        self.app.info_at = 0
        return f"/api/assets/media/{asset['asset_id']}/backend-input", {'package_id': package['id'], 'field_id': 'clip',
            'expected_backend': self.backend.url, 'values': {'mode': 'current'}}

    def test_current_values_reach_live_contract_and_cached_upload_still_revalidates(self):
        path, body = self.video()
        with patch('frameweave.server.validate_package_media_field', wraps=validate_package_media_field) as validate, \
                patch.object(self.app.backend, 'upload', return_value={'name': 'safe.mp4', 'type': 'input'}) as upload:
            self.assertEqual(self.post(path, body)[0], 200)
            self.assertEqual(self.post(path, body)[0], 200)
            self.assertEqual(validate.call_count, 2)
            self.assertEqual(validate.call_args.kwargs['values'], {'mode': 'current'})
            self.assertEqual(upload.call_count, 1)
        self.assert_no_generation()

    def test_invalid_values_and_unpaired_bindings_never_upload(self):
        path, body = self.video()
        for data in ({**body, 'values': []}, {**body, 'values': {'unknown': True}}, {'values': {}},
                     {'expected_backend': self.backend.url, 'field_id': 'clip'}, {**body, 'extra': True}):
            with self.subTest(data=data), patch.object(self.app.backend, 'upload') as upload:
                self.assertEqual(self.post(path, data)[0], 400)
                upload.assert_not_called()
        self.assert_no_generation()
