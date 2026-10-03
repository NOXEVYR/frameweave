"""Explicit media synchronization pins backend identity without submitting jobs."""
import json
import unittest
from unittest.mock import patch

from frameweave.backend import Backend
from frameweave.packages import validate_package_media_field, _stored_package_document
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

    def grouped_video(self):
        path, body = self.video()
        document = _stored_package_document(self.app.packages.get(body['package_id']))
        document['prompt']['8'] = {'class_type': 'LoadVideo', 'inputs': {'file': ''}}
        document['fields'].append({'id': 'motion', 'node_id': '8', 'input': 'file', 'type': 'video', 'label': 'motion', 'default': ''})
        package = self.app.packages.save(document)
        return path, {'package_id': package['id'], 'field_ids': ['clip', 'motion'], 'values': body['values'],
                      'expected_backend': self.backend.url, 'refresh': True}

    def test_grouped_refresh_validates_all_ports_then_uploads_once_and_bypasses_cache(self):
        path, body = self.grouped_video()
        events = []
        def validate(*args, **kwargs):
            events.append(('validate', args[1]))
            return validate_package_media_field(*args, **kwargs)
        def upload(*args):
            events.append(('upload', args[0]))
            return {'name': args[0], 'type': 'input'}
        with patch('frameweave.server.validate_package_media_field', side_effect=validate), patch.object(self.app.backend, 'upload', side_effect=upload) as transfer:
            first = self.post(path, body)
            second = self.post(path, body)
        self.assertEqual(first[0], 200, first[2])
        self.assertEqual(second[0], 200, second[2])
        self.assertEqual(transfer.call_count, 2)
        self.assertNotEqual(first[2]['name'], second[2]['name'])
        self.assertEqual(second[2]['field_ids'], ['clip', 'motion'])
        self.assertEqual([item[0] for item in events], ['validate', 'validate', 'upload'] * 2)
        self.assert_no_generation()

    def test_invalid_second_port_blocks_whole_refresh_and_retains_old_cache(self):
        path, body = self.grouped_video()
        with patch.object(self.app.backend, 'upload', return_value={'name': 'previous.mp4', 'type': 'input'}):
            self.assertEqual(self.post(path, body)[0], 200)
        previous = dict(self.app.local_media_upload_cache)
        for fields in (['clip', 'missing'], ['clip', 'mode']):
            with patch.object(self.app.backend, 'upload') as upload:
                self.assertEqual(self.post(path, {**body, 'field_ids': fields})[0], 400)
                upload.assert_not_called()
        self.assertEqual(self.app.local_media_upload_cache, previous)
        self.assert_no_generation()

    def test_grouped_contract_rejects_invalid_fields_refresh_and_unknown_keys(self):
        path, body = self.grouped_video()
        invalid = [{**body, 'field_ids': value} for value in (None, [], 'clip', ['clip', 'clip'], [1], [[]], ['x' * 81], ['clip'] * 4097)]
        invalid += [{**body, 'refresh': value} for value in (None, 1, 0, 'true', {})]
        invalid += [{**body, 'field_id': 'clip'}, {**body, 'extra': 1}, {**body, 'values': []}]
        for item in invalid:
            with self.subTest(item=str(item)[:120]), patch.object(self.app.backend, 'upload') as upload:
                self.assertEqual(self.post(path, item)[0], 400)
                upload.assert_not_called()

    def test_refresh_failure_retains_previous_receipt_and_never_submits(self):
        path, body = self.grouped_video()
        with patch.object(self.app.backend, 'upload', return_value={'name': 'previous.mp4', 'type': 'input'}):
            self.assertEqual(self.post(path, body)[0], 200)
        previous = dict(self.app.local_media_upload_cache)
        from frameweave.backend import BackendError
        with patch.object(self.app.backend, 'upload', side_effect=BackendError('unavailable')):
            self.assertEqual(self.post(path, body)[0], 502)
        self.assertEqual(self.app.local_media_upload_cache, previous)
        self.assert_no_generation()

    def test_grouped_refresh_rejects_same_url_backend_replacement_during_upload(self):
        path, body = self.grouped_video()
        original = self.app.backend
        def upload(*args):
            self.app.backend = Backend(original.url)
            return {'name': 'late.mp4', 'type': 'input'}
        with patch.object(original, 'upload', side_effect=upload):
            self.assertEqual(self.post(path, body)[0], 400)
        self.assertFalse(self.app.local_media_upload_cache)
        self.app.backend = original
        self.assert_no_generation()

    def test_disk_failure_preserves_previous_av_receipt_and_registry(self):
        path, body = self.grouped_video()
        with patch.object(self.app.backend, 'upload', return_value={'name': 'previous.mp4', 'type': 'input'}):
            self.assertEqual(self.post(path, body)[0], 200)
        cache, media, uploaded = dict(self.app.local_media_upload_cache), dict(self.app.media), set(self.app.uploaded)
        stored = (self.app.data_dir / 'input-media.json').read_bytes()
        for name in ('new-after-failure.mp4', 'previous.mp4'):
            with patch.object(self.app.backend, 'upload', return_value={'name': name, 'type': 'input'}), \
                    patch.object(self.app, 'persist_input_media', side_effect=OSError('disk full')):
                self.assertEqual(self.post(path, body)[0], 502)
            self.assertEqual(self.app.local_media_upload_cache, cache)
            self.assertEqual(self.app.media, media)
            self.assertEqual(self.app.uploaded, uploaded)
            self.assertEqual((self.app.data_dir / 'input-media.json').read_bytes(), stored)
        self.assert_no_generation()

    def test_image_storage_failure_does_not_publish_a_new_receipt(self):
        for path in self.image_paths():
            media, uploaded = dict(self.app.media), set(self.app.uploaded)
            with patch.object(self.app.backend, 'upload', return_value={'name': 'new-image.png', 'type': 'input'}), \
                    patch.object(self.app, 'persist_input_media', side_effect=OSError('disk full')):
                self.assertEqual(self.post(path, {'expected_backend': self.backend.url})[0], 502)
            self.assertEqual(self.app.media, media)
            self.assertEqual(self.app.uploaded, uploaded)
        self.assert_no_generation()
