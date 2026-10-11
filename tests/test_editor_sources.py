"""Exact editor provenance is separate from editable drafts and package names."""
import copy
import hashlib
import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

import test_editor_integration as native
from frameweave.editor_workflows import EditorWorkflowStore


class EditorSourceHTTPTests(unittest.TestCase):
    setUp = native.EditorIntegrationTests.setUp
    stop_client = native.EditorIntegrationTests.stop_client
    request = native.EditorIntegrationTests.request
    post = native.EditorIntegrationTests.post

    def get(self, path, **kwargs):
        status, _, raw = self.request('GET', path, **kwargs)
        return status, json.loads(raw)

    def apply(self, *, kind='native', document=None):
        document = document or native.editor_document()
        status, _, created = self.post('/api/editor-workflows', {
            'name': 'Same visible name', 'document': document, 'source_kind': kind})
        self.assertEqual(status, 200, created)
        ident = created['id']
        status, _, session = self.post(f'/api/editor-workflows/{ident}/session')
        self.assertEqual(status, 200, session)
        body = {'session_id': session['session_id'], 'base_revision': created['revision'],
                'document': document, 'prompt': native.compiled_prompt(), 'output_nodes': ['2']}
        status, _, applied = self.post(f'/api/editor-workflows/{ident}/apply', body)
        self.assertEqual(status, 200, applied)
        return ident, applied, body

    def report(self, package_id):
        status, result = self.get(f'/api/packages/{package_id}/editor-sources')
        self.assertEqual(status, 200, result)
        return result

    @staticmethod
    def selection(source):
        return {key: source[key] for key in ('workflow_id', 'revision', 'backend_url', 'document_sha256', 'prompt_sha256')}

    def test_apply_records_exact_source_without_execution_or_mutating_package(self):
        ident, applied, _ = self.apply()
        package_id = applied['package']['id']
        before = (self.app.packages.directory / f'{package_id}.json').read_bytes()
        calls = list(self.backend.calls)
        report = self.report(package_id)
        self.assertFalse(report['ambiguous'])
        self.assertFalse(report['unreadable'])
        source = report['sources'][0]
        self.assertEqual((source['workflow_id'], source['revision'], source['source_kind']),
                         (ident, applied['workflow']['revision'], 'native'))
        raw = self.app.editor_workflows.export(ident).encode()
        self.assertEqual(source['document_sha256'], hashlib.sha256(raw).hexdigest())
        self.assertNotIn('prompt', source)
        self.assertNotIn('source_json', source)
        self.assertEqual(calls, self.backend.calls)
        self.assertEqual(before, (self.app.packages.directory / f'{package_id}.json').read_bytes())
        self.assertFalse(self.app.jobs)

    def test_newer_draft_forks_the_applied_revision_and_keeps_private_ui_structure(self):
        ident, applied, _ = self.apply()
        package_id = applied['package']['id']
        source = self.report(package_id)['sources'][0]
        original = self.app.editor_workflows.get(ident)
        draft = copy.deepcopy(original['document'])
        draft['nodes'][1]['widgets_values'] = ['New draft note must stay private to original']
        self.app.editor_workflows.save_revision(ident, draft)
        report = self.report(package_id)
        self.assertTrue(report['sources'][0]['draft_newer'])
        status, _, result = self.post(f'/api/packages/{package_id}/fork-editor-source', self.selection(source))
        self.assertEqual(status, 200, result)
        forked = self.app.editor_workflows.get(result['workflow']['id'])
        self.assertNotEqual(forked['id'], ident)
        self.assertEqual(forked['source_json'], original['source_json'])
        self.assertEqual(forked['document']['definitions'], original['document']['definitions'])
        self.assertEqual(self.app.editor_workflows.get(ident)['document'], draft)
        self.assertFalse(self.app.jobs)

    def test_multiple_valid_sources_are_reported_without_name_based_selection(self):
        first, applied, _ = self.apply()
        other = native.editor_document()
        other['groups'][0]['title'] = 'Different layout with same execution'
        second, again, _ = self.apply(document=other)
        self.assertEqual(applied['package']['id'], again['package']['id'])
        report = self.report(applied['package']['id'])
        self.assertTrue(report['ambiguous'])
        self.assertEqual({item['workflow_id'] for item in report['sources']}, {first, second})
        self.assertEqual(len({item['document_sha256'] for item in report['sources']}), 2)

    def test_plain_api_import_has_no_invented_source_and_converted_origin_survives(self):
        status, _, package = self.post('/api/interfaces/apply', {'name': 'Same visible name',
            'prompt': native.compiled_prompt(), 'backend_url': self.app.backend.url, 'output_nodes': ['2']})
        self.assertEqual(status, 200, package)
        self.assertEqual(self.report(package['package']['id'])['sources'], [])
        ident, applied, _ = self.apply(kind='api')
        report = self.report(applied['package']['id'])
        self.assertEqual(report['sources'][0]['source_kind'], 'api')
        status, _, fork = self.post(f"/api/packages/{applied['package']['id']}/fork-editor-source", self.selection(report['sources'][0]))
        self.assertEqual(status, 200, fork)
        self.assertEqual(fork['workflow']['source_kind'], 'api')
        self.assertEqual(self.app.editor_workflows.get(ident)['source_kind'], 'api')

    def test_restart_preserves_sources_and_legacy_metadata_stays_unknown(self):
        ident, applied, _ = self.apply()
        directory = self.app.editor_workflows.directory
        meta_path = directory / ident / 'meta.json'
        meta = json.loads(meta_path.read_bytes())
        meta.pop('source_kind')
        meta_path.write_text(json.dumps(meta), encoding='utf-8')
        store = EditorWorkflowStore(directory)
        report = store.package_sources(applied['package']['id'])
        self.assertEqual(report['sources'][0]['source_kind'], 'unknown')
        self.assertEqual(store.get(ident)['source_kind'], 'unknown')

    def test_modified_revision_or_compiled_content_is_not_certified(self):
        for part in ('revisions', 'compiled'):
            with self.subTest(part=part):
                ident, applied, _ = self.apply()
                package_id = applied['package']['id']
                old = next(item for item in self.report(package_id)['sources'] if item['workflow_id'] == ident)
                path = self.app.editor_workflows.directory / ident / part / f"revision-{old['revision']:08d}.json"
                data = json.loads(path.read_bytes())
                if part == 'revisions':
                    data['nodes'][1]['widgets_values'] = ['Changed outside committed application']
                else:
                    data['prompt']['2']['inputs']['text'] = 'Changed execution'
                path.write_text(json.dumps(data), encoding='utf-8')
                report = self.report(package_id)
                self.assertFalse(any(item['workflow_id'] == ident for item in report['sources']))
                self.assertTrue(any(item['workflow_id'] == ident for item in report['unreadable']))
                count = len(list(self.app.editor_workflows.directory.glob('e-*')))
                status, _, result = self.post(f'/api/packages/{package_id}/fork-editor-source', self.selection(old))
                self.assertEqual(status, 400, result)
                self.assertEqual(len(list(self.app.editor_workflows.directory.glob('e-*'))), count)

    def test_forged_revision_hash_and_missing_csrf_cannot_create_forks(self):
        _, applied, _ = self.apply()
        package_id = applied['package']['id']
        source = self.selection(self.report(package_id)['sources'][0])
        count = len(list(self.app.editor_workflows.directory.glob('e-*')))
        for key, value in [('revision', True), ('revision', 1), ('document_sha256', '0' * 64),
                           ('prompt_sha256', '0' * 64), ('workflow_id', '../private')]:
            status, _, result = self.post(f'/api/packages/{package_id}/fork-editor-source', {**source, key: value})
            self.assertEqual(status, 400, result)
        status, _, _ = self.request('POST', f'/api/packages/{package_id}/fork-editor-source', data=source, csrf=False)
        self.assertEqual(status, 403)
        self.assertEqual(len(list(self.app.editor_workflows.directory.glob('e-*'))), count)

    def test_publication_failure_removes_source_receipt_and_keeps_original_metadata(self):
        ident, applied, payload = self.apply()
        package_id = applied['package']['id']
        before = self.report(package_id)
        meta_path = self.app.editor_workflows.directory / ident / 'meta.json'
        original = meta_path.read_bytes()
        payload['base_revision'] = applied['workflow']['revision']
        payload['prompt']['2']['inputs']['text'] = 'New revision package'
        real_link = os.link
        def failure(source, target):
            if Path(target).name.startswith('p-'):
                raise OSError('injected source publication failure')
            return real_link(source, target)
        with patch('frameweave.server.os.link', side_effect=failure):
            status, _, result = self.post(f'/api/editor-workflows/{ident}/apply', payload)
        self.assertEqual(status, 502, result)
        self.assertEqual(meta_path.read_bytes(), original)
        self.assertEqual(self.report(package_id), before)

    def test_receipt_write_failure_does_not_publish_a_package(self):
        ident, applied, payload = self.apply()
        before = list(self.app.packages.list())
        original = self.app.editor_workflows.get(ident)
        payload['base_revision'] = applied['workflow']['revision']
        payload['prompt']['2']['inputs']['text'] = 'Different package'
        with patch.object(self.app.editor_workflows, '_record_package_source', side_effect=OSError('receipt write failed')):
            status, _, result = self.post(f'/api/editor-workflows/{ident}/apply', payload)
        self.assertEqual(status, 502, result)
        self.assertEqual(self.app.editor_workflows.get(ident), original)
        self.assertEqual(self.app.packages.list(), before)

    def test_reconfigure_adds_source_only_when_compiled_revision_is_proven(self):
        ident, applied, _ = self.apply()
        fields = copy.deepcopy(applied['package']['fields'])
        fields[0]['label'] = 'Renamed external input'
        body = {'backend_url': self.app.backend.url, 'package_id': applied['package']['id'],
                'values': applied['values'], 'previous_baseline': applied['baseline'], 'fields': fields,
                'output_nodes': ['2']}
        status, _, configured = self.post(f'/api/editor-workflows/{ident}/configure', body)
        self.assertEqual(status, 200, configured)
        self.assertNotEqual(configured['package']['id'], applied['package']['id'])
        source = self.report(configured['package']['id'])['sources'][0]
        self.assertEqual(source['revision'], applied['workflow']['revision'])
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], applied['workflow']['revision'])
        body.pop('previous_baseline')
        for field in fields:
            if field['input'] == 'text':
                body['values'][field['id']] = 'Outer value never written into native document'
        status, _, changed = self.post(f'/api/editor-workflows/{ident}/configure', body)
        self.assertEqual(status, 200, changed)
        self.assertEqual(self.report(changed['package']['id'])['sources'], [])

    def test_bad_origin_and_receipt_metadata_are_rejected_without_guessing(self):
        count = len(list(self.app.editor_workflows.directory.glob('e-*')))
        status, _, result = self.post('/api/editor-workflows', {'name': 'bad', 'document': native.editor_document(), 'source_kind': 'guessed'})
        self.assertEqual(status, 400, result)
        self.assertEqual(len(list(self.app.editor_workflows.directory.glob('e-*'))), count)
        ident, applied, _ = self.apply()
        path = self.app.editor_workflows.directory / ident / 'meta.json'
        meta = json.loads(path.read_bytes())
        meta['package_sources'][0]['revision'] = True
        path.write_text(json.dumps(meta), encoding='utf-8')
        report = self.report(applied['package']['id'])
        self.assertEqual(report['sources'], [])
        self.assertEqual(report['unreadable'], [{'workflow_id': ident, 'reason': 'source_record_unavailable'}])

    def test_reconfigure_receipt_failure_preserves_prior_package_and_meta(self):
        ident, applied, _ = self.apply()
        before = list(self.app.packages.list())
        meta_path = self.app.editor_workflows.directory / ident / 'meta.json'
        original = meta_path.read_bytes()
        fields = copy.deepcopy(applied['package']['fields'])
        fields[0]['label'] = 'New external interface'
        with patch.object(self.app.editor_workflows, '_record_package_source', side_effect=OSError('association unavailable')):
            status, _, result = self.post(f'/api/editor-workflows/{ident}/configure', {
                'backend_url': self.app.backend.url, 'package_id': applied['package']['id'],
                'values': applied['values'], 'previous_baseline': applied['baseline'], 'fields': fields, 'output_nodes': ['2']})
        self.assertEqual(status, 502, result)
        self.assertEqual(meta_path.read_bytes(), original)
        self.assertEqual(self.app.packages.list(), before)

    def test_source_recording_never_overwrites_imported_exact_source(self):
        ident, applied, _ = self.apply()
        original = self.app.editor_workflows.get(ident)
        created_at = original['created_at']
        newer = copy.deepcopy(original['document'])
        newer['extra']['new_ui_option'] = True
        self.app.editor_workflows.save_revision(ident, newer)
        self.assertEqual(self.app.editor_workflows.get(ident)['created_at'], created_at)
        sources = self.report(applied['package']['id'])['sources']
        self.assertEqual(len(sources), 1)
        self.assertEqual(sources[0]['revision'], applied['workflow']['revision'])


if __name__ == '__main__':
    unittest.main()
