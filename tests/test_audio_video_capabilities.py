"""Video-backed AUDIO package readiness: pure live-schema checks, no inference."""
import copy
import hashlib
import json
import unittest

from frameweave.audio_workflows import audio_capabilities
from frameweave.workflows import validate_prompt
from test_generation_extensions import audio_package, schema, typed_audio_schema
import test_local_assets as asset_fixture
import test_service as service_fixture


class AudioVideoCapabilityTests(unittest.TestCase):
    def setUp(self):
        self.info = typed_audio_schema()
        self.info['LoadVideo'] = schema({'file': ['COMBO', {'options': ['clip.mp4'], 'video_upload': True}]}, ['VIDEO'])
        self.info['VideoToAudio'] = schema({'video': ['VIDEO']}, ['AUDIO'])
        self.package = audio_package('audio-video', {
            '1': {'class_type': 'LoadVideo', 'inputs': {'file': ''}},
            '2': {'class_type': 'VideoToAudio', 'inputs': {'video': ['1', 0]}},
            '3': {'class_type': 'AudioWriter', 'inputs': {'audio': ['2', 0], 'filename_prefix': 'test/audio'}},
        }, fields=[{'id': 'video', 'type': 'video', 'label': 'Reference video', 'node_id': '1', 'input': 'file', 'required': True, 'default': ''}])

    def result(self):
        return audio_capabilities(self.info, [self.package])['packages'][0]

    def test_exposed_empty_video_is_eligible_but_not_executable_before_upload(self):
        before = copy.deepcopy((self.info, self.package))
        result = self.result()
        self.assertTrue(result['eligible'])
        self.assertEqual(result['audio_outputs'][0]['node_id'], '3')
        with self.assertRaisesRegex(ValueError, '尚未填写资源'):
            validate_prompt(self.package['prompt'], self.info)
        self.assertEqual((self.info, self.package), before)

    def test_only_the_matching_exposed_empty_video_is_pending(self):
        original = copy.deepcopy(self.package['fields'])
        for fields in ([], [{**original[0], 'type': 'audio'}], [{**original[0], 'node_id': '2'}], [{**original[0], 'input': 'wrong'}]):
            with self.subTest(fields=fields):
                self.package['fields'] = fields
                self.assertFalse(self.result()['eligible'])

    def test_nonempty_video_still_needs_backend_filename_and_safe_path(self):
        for name, eligible in [('clip.mp4', True), ('missing.mp4', False), ('../clip.mp4', False)]:
            with self.subTest(name=name):
                self.package['prompt']['1']['inputs']['file'] = name
                self.assertEqual(self.result()['eligible'], eligible)

    def test_other_missing_inputs_and_wrong_output_types_are_not_relaxed(self):
        self.info['VideoToAudio']['input']['required']['mode'] = [['extract', 'reference']]
        self.assertFalse(self.result()['eligible'])
        self.package['prompt']['2']['inputs']['mode'] = 'extract'
        self.assertTrue(self.result()['eligible'])
        self.info['VideoToAudio']['output'] = ['IMAGE']
        self.assertFalse(self.result()['eligible'])

    def test_video_and_audio_placeholders_share_the_live_media_contract(self):
        self.info['LoadAudio']['input']['required']['audio'] = ['COMBO', {'options': ['existing.wav'], 'audio_upload': True}]
        self.info['AudioMix'] = schema({'first': ['AUDIO'], 'second': ['AUDIO']}, ['AUDIO'])
        self.package['prompt']['4'] = {'class_type': 'LoadAudio', 'inputs': {'audio': ''}}
        self.package['prompt']['5'] = {'class_type': 'AudioMix', 'inputs': {'first': ['2', 0], 'second': ['4', 0]}}
        self.package['prompt']['3']['inputs']['audio'] = ['5', 0]
        self.package['fields'].append({'id': 'audio', 'type': 'audio', 'node_id': '4', 'input': 'audio', 'default': ''})
        self.assertTrue(self.result()['eligible'])
        self.package['fields'].pop()
        self.assertFalse(self.result()['eligible'])

    def test_empty_combo_catalog_remains_unavailable_instead_of_becoming_an_upload_placeholder(self):
        self.info['LoadVideo']['input']['required']['file'][1]['options'] = []
        self.assertFalse(self.result()['eligible'])


class AudioVideoHTTPContractTests(unittest.TestCase):
    """Exercise the studio's two-stage protocol against isolated loopback mocks."""
    setUp = service_fixture.ServiceHTTPTests.setUp
    start_client = service_fixture.ServiceHTTPTests.start_client
    stop_client = service_fixture.ServiceHTTPTests.stop_client
    request = service_fixture.ServiceHTTPTests.request
    post = service_fixture.ServiceHTTPTests.post
    post_media = asset_fixture.LocalImageAssetHTTPTests.post_media
    upload_video = asset_fixture.LocalImageAssetHTTPTests.upload_video
    assert_no_generation = asset_fixture.LocalImageAssetHTTPTests.assert_no_generation

    def test_audio_video_readiness_upload_preview_named_input_and_compile_without_generation(self):
        fixture = AudioVideoCapabilityTests()
        fixture.setUp()
        self.backend.info = fixture.info
        self.app.info_at = 0
        package = self.app.packages.save({key: value for key, value in fixture.package.items() if key != 'id'})
        status, _, raw = self.request('GET', '/api/audio-capabilities')
        capability = json.loads(raw)
        self.assertEqual(status, 200, capability)
        self.assertEqual(capability['backend_url'], self.backend.url)
        self.assertTrue(next(item for item in capability['packages'] if item['id'] == package['id'])['eligible'])
        # Readiness makes the picker usable; it never makes a missing input executable.
        self.assertEqual(self.post('/api/compile', {'kind': 'package', 'package_id': package['id'], 'values': {}})[0], 400)
        content = asset_fixture.mp4_bytes()
        status, _, asset = self.upload_video(content)
        self.assertEqual(status, 200, asset)
        self.assertEqual(asset['asset_id'], hashlib.sha256(content).hexdigest())
        self.assertEqual((asset['media_type'], asset['mime']), ('video', 'video/mp4'))
        self.assertEqual(self.request('GET', asset['url'])[2], content)
        status, _, receipt = self.post(asset['url'] + '/backend-input', {'package_id': package['id'], 'field_id': 'video'})
        self.assertEqual(status, 200, receipt)
        self.assertEqual({key: receipt[key] for key in ('asset_id', 'media_type', 'backend', 'package_id', 'field_id')},
                         {'asset_id': asset['asset_id'], 'media_type': 'video', 'backend': self.backend.url,
                          'package_id': package['id'], 'field_id': 'video'})
        self.assertRegex(receipt['url'], r'^/api/media/[a-f0-9]{32}$')
        # The real loader rescans its input directory after upload. Keep this mock's
        # schema equally explicit; a storage receipt does not bypass the enum.
        self.backend.info['LoadVideo']['input']['required']['file'][1]['options'].append(receipt['name'])
        status, _, compiled = self.post('/api/compile', {'kind': 'package', 'package_id': package['id'],
                                                        'values': {'video': receipt['name']}})
        self.assertEqual(status, 200, compiled)
        self.assertEqual(compiled['prompt']['1']['inputs']['file'], receipt['name'])
        uploads = [call for call in self.backend.calls if call[:2] == ('POST', '/upload/image')]
        self.assertEqual(len(uploads), 1)
        self.assertIn(content, uploads[0][2])
        self.assert_no_generation()


if __name__ == '__main__':
    unittest.main()
