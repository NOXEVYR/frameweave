"""Input-loader previews must not replace generated image/video/audio results."""
import json
import unittest

from frameweave.server import App, output_identity
import test_job_lifecycle as fixtures


class ResultOutputRoleTests(unittest.TestCase):
    setUp = fixtures.JobLifecycleTests.setUp
    finish = fixtures.JobLifecycleTests.finish

    def test_history_filters_input_echoes_in_every_media_channel(self):
        for channel, suffix in (('images', '.png'), ('gifs', '.gif'), ('videos', '.mp4'),
                                ('video', '.webm'), ('audio', '.wav'), ('audios', '.mp3')):
            with self.subTest(channel=channel):
                item = {'outputs': {'21': {channel: [
                    {'filename': 'reference' + suffix, 'type': 'input'},
                    {'filename': 'generated' + suffix, 'type': 'output'},
                    {'filename': 'preview' + suffix, 'type': 'temp'}]}}}
                outputs = self.app._history_outputs('owned', self.engine.url, item)
                self.assertEqual([o['filename'] for o in outputs], ['generated' + suffix, 'preview' + suffix])
                # Filtering must not renumber the backend's stable entry identity.
                self.assertEqual([o['entry_index'] for o in outputs], [1, 2])
                self.assertEqual([o['output_id'] for o in outputs],
                                 [output_identity('owned', o) for o in outputs])

    def test_completed_video_lists_saved_result_before_loader_preview(self):
        self.finish()
        self.engine.history['owned']['outputs'] = {
            '21': {'images': [{'filename': 'source.mp4', 'type': 'input'}]},
            '25': {'images': [{'filename': 'edited.mp4', 'type': 'output'}]}}
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual([(o['node_id'], o['filename']) for o in result['outputs']], [('25', 'edited.mp4')])

    def test_input_only_success_does_not_claim_a_generated_result(self):
        self.finish()
        self.engine.history['owned']['outputs'] = {'21': {'images': [{'filename': 'source.mp4', 'type': 'input'}]}}
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['outputs'], [])

    def test_terminal_merge_preserves_real_partial_outputs_but_not_input_echo(self):
        self.job['outputs'] = [
            {'filename': 'source.mp4', 'storage_type': 'input', 'type': 'video'},
            {'filename': 'partial.mp4', 'storage_type': 'output', 'type': 'video'},
            {'filename': 'preview.png', 'storage_type': 'temp', 'type': 'image'}]
        self.finish('error')
        result = self.app.refresh_job('owned')
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual([o['filename'] for o in result['outputs']], ['partial.mp4', 'preview.png'])

    def test_legacy_restart_keeps_reference_registration_and_result_identity(self):
        reference = {'filename': 'source.mp4', 'subfolder': '', 'storage_type': 'input',
                     'type': 'video', 'node_id': '21', 'history_channel': 'images', 'entry_index': 0}
        generated = {**reference, 'filename': 'edited.mp4', 'storage_type': 'output', 'node_id': '25'}
        self.job.update(status='completed', outputs=[reference, generated])
        self.app.persist_jobs()
        original = (self.root/'jobs.json').read_bytes()
        input_record = {**reference, 'backend': self.engine.url}
        (self.root/'input-media.json').write_text(json.dumps([input_record]), encoding='utf8')
        marker = self.root/'source.mp4'
        marker.write_bytes(b'existing-reference-untouched')
        restored = App(self.root, self.root, self.engine.url)
        self.addCleanup(restored.closed.set)
        # Startup does not rewrite the original journal or remove source assets.
        self.assertEqual((self.root/'jobs.json').read_bytes(), original)
        self.assertEqual(marker.read_bytes(), b'existing-reference-untouched')
        self.assertIn('source.mp4', restored.uploaded)
        outputs = restored.public_job(restored.jobs['owned'])['outputs']
        self.assertEqual(len(outputs), 1)
        self.assertEqual(outputs[0]['output_id'], output_identity('owned', generated))
        picked, query = restored._check_media_source_locked(
            'owned', 'video', 0, None, restored.backend, None, None)
        self.assertEqual((picked['node_id'], query['filename']), ('25', 'edited.mp4'))
        restored.persist_jobs()
        again = App(self.root, self.root, self.engine.url)
        self.addCleanup(again.closed.set)
        self.assertEqual(again.public_job(again.jobs['owned'])['outputs'], outputs)

    def test_legacy_default_output_and_real_temp_preview_remain_available(self):
        self.finish()
        self.engine.history['owned']['outputs'] = {'2': {'images': [
            {'filename': 'legacy.png'}, {'filename': 'preview.png', 'type': 'temp'}]}}
        result = self.app.refresh_job('owned')
        self.assertEqual([o['storage_type'] for o in result['outputs']], ['output', 'temp'])


if __name__ == '__main__':
    unittest.main()
