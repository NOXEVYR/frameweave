"""Real loopback HTTP reentry for private validated missing-input overlays.

Native documents and backend schemas are matching synthetic fixtures; no real
ComfyUI/plugin/GPU execution is claimed, and every operation remains data-only.
"""

import copy
import hashlib
import json
import unittest
from unittest.mock import patch

from frameweave.backend import Backend
import test_missing_interface_http as missing_tests
from test_savevideo_dynamic import video_prompt
from test_service import MockComfy


def native_video_document():
    return {"id": "repair-video-source", "version": 0.4, "last_node_id": 2, "last_link_id": 1,
            "nodes": [
                {"id": 1, "type": "VideoSource", "mode": 0, "inputs": [],
                 "outputs": [{"name": "video", "type": "VIDEO", "links": [1]}],
                 "widgets_values": [], "properties": {}},
                {"id": 2, "type": "SaveVideo", "mode": 0,
                 "inputs": [{"name": "video", "type": "VIDEO", "link": 1}],
                 "outputs": [{"name": "video", "type": "VIDEO", "links": []}],
                 "widgets_values": ["video/test", "mp4"], "properties": {}},
            ], "links": [[1, 1, 0, 2, 0, "VIDEO"]], "groups": [], "config": {}, "extra": {}}


class EditorRepairOverlayHTTPTests(unittest.TestCase):
    setUp = missing_tests.MissingInterfaceHTTPTests.setUp
    tearDown = missing_tests.MissingInterfaceHTTPTests.tearDown
    stop_client = missing_tests.MissingInterfaceHTTPTests.stop_client
    request = missing_tests.MissingInterfaceHTTPTests.request
    post = missing_tests.MissingInterfaceHTTPTests.post
    import_document = missing_tests.MissingInterfaceHTTPTests.import_document
    assert_compiles = missing_tests.MissingInterfaceHTTPTests.assert_compiles

    def ok(self, path, data=None):
        status, _, result = self.post(path, data)
        self.assertEqual(status, 200, result)
        return result

    def repaired_native(self, *, source=None):
        document = native_video_document()
        source = source or json.dumps(document, ensure_ascii=False, indent=3) + "\n"
        status, _, imported = self.import_document(document=document, source_json=source)
        self.assertEqual(status, 200, imported)
        session = self.ok(f"/api/editor-workflows/{imported['id']}/session")
        data = {"session_id": session["session_id"], "base_revision": imported["revision"],
                "document": document, "prompt": video_prompt(format="mp4"), "output_nodes": ["2"]}
        first = self.ok(f"/api/editor-workflows/{imported['id']}/interface", data)
        missing, = first["missing_fields"]
        choices = {missing["id"]: "h264"}
        inspected = self.ok(f"/api/editor-workflows/{imported['id']}/interface", {**data, "missing_values": choices})
        applied = self.ok(f"/api/editor-workflows/{imported['id']}/apply",
                          {**data, "missing_values": choices, "fields": inspected["fields"]})
        return imported["id"], source, data, applied, missing["id"]

    def reopen(self, ident, data):
        self.ok('/api/editor-sessions/close', {'session_id': data['session_id']})
        record = self.app.editor_workflows.get(ident)
        session = self.ok(f"/api/editor-workflows/{ident}/session")
        return {**data, "session_id": session["session_id"], "base_revision": record["revision"],
                "document": record["document"]}

    def test_reopen_restores_same_explicit_origin_and_keeps_source_exact_bytes_hash(self):
        ident, source, data, applied, repair_id = self.repaired_native()
        original_hash = hashlib.sha256(source.encode()).hexdigest()
        private = self.app.editor_workflows.get_compiled(ident)
        self.assertEqual(private['repair_overlay']['source_sha256'], original_hash)
        self.assertIsNotNone(private['repair_overlay']['entries'][0]['native_sha256'])
        self.assertEqual(private['repair_overlay']['entries'][0]['origin_revision'], 1)
        data = self.reopen(ident, data)
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", data)
        self.assertEqual(inspected['missing_fields'], [])
        self.assertEqual(inspected['prompt']['2']['inputs']['format.codec'], 'h264')
        self.assertEqual(inspected['repair_sources'][0]['status'], 'restored')
        self.assertEqual(inspected['repair_sources'][0]['origin_revision'], 1)
        reapplied = self.ok(f"/api/editor-workflows/{ident}/apply", {**data, 'fields': inspected['fields']})
        self.assertEqual(reapplied['package']['id'], applied['package']['id'])
        self.assertEqual(reapplied['repair_sources'][0]['status'], 'restored')
        self.assert_compiles(reapplied)
        current = self.app.editor_workflows.get(ident)
        self.assertEqual(current['source_json'], source)
        for revision in range(1, current['revision'] + 1):
            raw = (self.app.editor_workflows.directory / ident / 'revisions' / f'revision-{revision:08d}.json').read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest(), original_hash)
        status, _, raw = self.request('GET', f'/api/editor-workflows/{ident}')
        self.assertEqual(status, 200)
        public = json.loads(raw)
        self.assertEqual(public['repair_sources'][0]['id'], repair_id)
        self.assertNotIn('repair_overlay', public)
        self.assertNotIn('value', public['repair_sources'][0])
        self.assertNotIn('native_sha256', json.dumps(public))
        exported = self.ok(f"/api/editor-workflows/{ident}/export")
        self.assertEqual(exported['source_json'], source)
        package_export = self.ok(f"/api/packages/{applied['package']['id']}/export")
        self.assertNotIn('repair_overlay', json.dumps(package_export))
        self.assertNotIn('native_sha256', json.dumps(package_export))

    def test_new_explicit_choice_wins_and_native_present_value_is_never_overwritten(self):
        ident, _, data, applied, repair_id = self.repaired_native()
        data = self.reopen(ident, data)
        new_choice = {repair_id: 'av1'}
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", {**data, 'missing_values': new_choice})
        self.assertEqual(inspected['prompt']['2']['inputs']['format.codec'], 'av1')
        changed = self.ok(f"/api/editor-workflows/{ident}/apply",
                          {**data, 'missing_values': new_choice, 'fields': inspected['fields']})
        self.assertNotEqual(changed['package']['id'], applied['package']['id'])
        overlay = self.app.editor_workflows.get_compiled(ident)['repair_overlay']
        self.assertEqual(overlay['entries'][0]['value'], 'av1')
        self.assertEqual(overlay['entries'][0]['origin_revision'], 2)
        self.assertEqual(changed['repair_sources'][0]['status'], 'explicit')
        data = self.reopen(ident, data)
        present = copy.deepcopy(data)
        present['prompt']['2']['inputs']['format.codec'] = 'auto'
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", present)
        self.assertEqual(inspected['prompt']['2']['inputs']['format.codec'], 'auto')
        self.assertEqual(inspected['repair_sources'][0]['status'], 'native_value_present')

    def test_fresh_schema_invalidates_old_choice_and_prewrite_failure_preserves_revision(self):
        ident, source, data, _, repair_id = self.repaired_native()
        data = self.reopen(ident, data)
        for option in self.backend.info['SaveVideo']['input']['required']['format'][1]['options']:
            if option['key'] == 'mp4':
                codec = option['inputs']['required']['codec'][1]
                codec['options'] = [entry for entry in codec['options'] if entry['key'] != 'h264']
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", data)
        self.assertEqual([item['input'] for item in inspected['missing_fields']], ['format.codec'])
        self.assertEqual(inspected['repair_sources'][0]['reason'], 'live_schema_changed')
        before = self.app.editor_workflows.get(ident)
        packages = self.app.packages.list()
        status, _, rejected = self.post(f"/api/editor-workflows/{ident}/apply", {**data, 'fields': inspected['fields']})
        self.assertEqual(status, 400, rejected)
        self.assertIs(rejected['persisted'], False)
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], before['revision'])
        self.assertEqual(self.app.packages.list(), packages)
        self.assertEqual(self.app.editor_workflows.get(ident)['source_json'], source)
        new = self.ok(f"/api/editor-workflows/{ident}/interface", {**data, 'missing_values': {repair_id: 'av1'}})
        self.assertEqual(new['prompt']['2']['inputs']['format.codec'], 'av1')

    def test_current_explicit_outer_value_updates_repair_record_and_restores_on_reopen(self):
        ident, source, data, applied, repair_id = self.repaired_native()
        data = self.reopen(ident, data)
        values = {**applied['values'], repair_id: 'av1'}
        payload = {**data, 'previous_package_id': applied['package']['id'],
                   'previous_values': values, 'previous_baseline': applied['baseline']}
        inspected = self.ok(f'/api/editor-workflows/{ident}/interface', payload)
        saved = self.ok(f'/api/editor-workflows/{ident}/apply', {**payload, 'fields': inspected['fields']})
        self.assertEqual(saved['values'][repair_id], 'av1')
        private = self.app.editor_workflows.get_compiled(ident)
        self.assertEqual(private['repair_overlay']['entries'][0]['value'], 'av1')
        self.assertEqual(private['repair_overlay']['entries'][0]['origin_revision'], 2)
        self.assertEqual(saved['repair_sources'][0]['status'], 'explicit')
        self.assertEqual(self.app.editor_workflows.get(ident)['source_json'], source)
        data = self.reopen(ident, data)
        restored = self.ok(f'/api/editor-workflows/{ident}/interface', data)
        self.assertEqual(restored['missing_fields'], [])
        self.assertEqual(restored['prompt']['2']['inputs']['format.codec'], 'av1')
        status, _, raw = self.request('GET', f"/api/packages/{saved['package']['id']}/editor-sources")
        self.assertEqual(status, 200)
        receipt = next(item for item in json.loads(raw)['sources']
                       if item['workflow_id'] == ident and item['revision'] == 3)
        selection = {key: receipt[key] for key in
                     ('workflow_id', 'revision', 'backend_url', 'document_sha256', 'prompt_sha256')}
        forks = [self.ok(f"/api/packages/{saved['package']['id']}/fork-editor-source", selection)['workflow'],
                 self.ok(f'/api/editor-workflows/{ident}/fork', {'base_revision': 3})['workflow']]
        for fork in forks:
            session = self.ok(f"/api/editor-workflows/{fork['id']}/session")
            fresh = {**data, 'session_id': session['session_id'], 'base_revision': fork['revision']}
            inspected = self.ok(f"/api/editor-workflows/{fork['id']}/interface", fresh)
            self.assertEqual(inspected['prompt']['2']['inputs']['format.codec'], 'av1')
            self.assertEqual(inspected['repair_sources'][0]['origin_workflow_id'], ident)
            self.assertEqual(inspected['repair_sources'][0]['origin_revision'], 2)
            applied_fork = self.ok(f"/api/editor-workflows/{fork['id']}/apply", {**fresh, 'fields': inspected['fields']})
            self.assertEqual(applied_fork['values'][repair_id], 'av1')
            # The selected repair becomes this new source's baseline, so its
            # data content ID can legitimately differ from the old baseline.
            self.assertNotEqual(applied_fork['package']['id'], saved['package']['id'])
            self.assertEqual(self.app.editor_workflows.get(fork['id'])['source_json'], source)
        before = self.app.editor_workflows.get(ident)
        invalid = {**data, 'previous_package_id': saved['package']['id'],
                   'previous_values': {**saved['values'], repair_id: 'invalid-codec'},
                   'previous_baseline': saved['baseline'], 'fields': restored['fields']}
        status, _, rejected = self.post(f'/api/editor-workflows/{ident}/apply', invalid)
        self.assertEqual(status, 200, rejected)
        self.assertIs(rejected['requires_resolution'], True)
        self.assertEqual(rejected['changes']['conflicts'][0]['allowed'], ['inner'])
        self.assertIs(rejected['persisted'], False)
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], before['revision'])
        self.assertEqual(self.app.editor_workflows.get_compiled(ident), private)
        status, _, rejected = self.post(f'/api/editor-workflows/{ident}/apply',
                                       {**invalid, 'resolutions': {repair_id: 'outer'}})
        self.assertEqual(status, 200, rejected)
        self.assertIs(rejected['requires_resolution'], True)
        self.assertIs(rejected['persisted'], False)
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], before['revision'])

    def test_changed_source_inputs_instance_and_class_require_new_choice(self):
        ident, _, data, _, _ = self.repaired_native()
        data = self.reopen(ident, data)
        cases = []
        inputs = copy.deepcopy(data)
        inputs['prompt']['2']['inputs']['format'] = 'webm'
        cases.append((inputs, 'native_inputs_changed'))
        source = copy.deepcopy(data)
        source['document']['nodes'][1]['pos'] = [123, 456]
        cases.append((source, 'source_or_backend_changed'))
        changed_class = copy.deepcopy(data)
        changed_class['prompt']['2']['class_type'] = 'OtherSaveVideo'
        self.backend.info['OtherSaveVideo'] = copy.deepcopy(self.backend.info['SaveVideo'])
        cases.append((changed_class, 'instance_or_class_changed'))
        for request, reason in cases:
            with self.subTest(reason=reason):
                inspected = self.ok(f"/api/editor-workflows/{ident}/interface", request)
                self.assertNotIn('format.codec', inspected['prompt']['2']['inputs'])
                self.assertEqual(inspected['repair_sources'][0]['status'], 'stale')
                self.assertEqual(inspected['repair_sources'][0]['reason'], reason)

    def test_new_draft_keeps_history_but_cannot_reuse_stale_compiled_overlay(self):
        ident, source, data, _, _ = self.repaired_native()
        old_overlay = self.app.editor_workflows.get_compiled(ident)['repair_overlay']
        changed = copy.deepcopy(data['document'])
        changed['extra']['viewport'] = {'scale': 0.5}
        saved = self.ok(f"/api/editor-workflows/{ident}/draft",
                        {'document': changed, 'base_revision': 2})
        self.assertEqual(saved['revision'], 3)
        self.assertEqual(self.app.editor_workflows.get(ident)['repair_sources'][0]['status'], 'stale')
        data = self.reopen(ident, data)
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", data)
        self.assertEqual(inspected['repair_sources'][0]['reason'], 'source_revision_changed')
        self.assertNotIn('format.codec', inspected['prompt']['2']['inputs'])
        self.assertEqual(self.app.editor_workflows.get_compiled(ident, 2)['repair_overlay'], old_overlay)
        first = self.app.editor_workflows.directory / ident / 'revisions' / 'revision-00000001.json'
        self.assertEqual(first.read_text(), source)

    def test_new_session_backend_identity_and_caller_claims_never_transfer_overlay(self):
        ident, _, data, _, _ = self.repaired_native()
        data = self.reopen(ident, data)
        private = self.app.editor_workflows.get_compiled(ident)['repair_overlay']
        without_session = {key: value for key, value in data.items() if key != 'session_id'}
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", without_session)
        self.assertEqual(inspected['repair_sources'][0]['reason'], 'current_native_session_required')
        status, _, new = self.import_document(document=native_video_document())
        self.assertEqual(status, 200)
        session = self.ok(f"/api/editor-workflows/{new['id']}/session")
        forged = {**data, 'session_id': session['session_id'], 'base_revision': 1, 'repair_overlay': private}
        inspected = self.ok(f"/api/editor-workflows/{new['id']}/interface", forged)
        self.assertEqual(inspected['repair_sources'], [])
        self.assertNotIn('format.codec', inspected['prompt']['2']['inputs'])
        other = MockComfy()
        self.addCleanup(other.stop)
        other.info = copy.deepcopy(self.backend.info)
        self.app.backend = Backend(other.url)
        session = self.ok(f"/api/editor-workflows/{ident}/session")
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", {**data, 'session_id': session['session_id']})
        self.assertEqual(inspected['repair_sources'][0]['reason'], 'source_or_backend_changed')
        self.assertNotIn('format.codec', inspected['prompt']['2']['inputs'])

    def test_persistence_failure_keeps_old_committed_overlay_and_source(self):
        ident, source, data, _, repair_id = self.repaired_native()
        data = self.reopen(ident, data)
        private = self.app.editor_workflows.get_compiled(ident)
        inspected = self.ok(f"/api/editor-workflows/{ident}/interface", {**data, 'missing_values': {repair_id: 'av1'}})
        with patch.object(self.app.editor_workflows, '_record_package_source', side_effect=OSError('fixture persistence rejection')):
            status, _, rejected = self.post(f"/api/editor-workflows/{ident}/apply",
                                           {**data, 'missing_values': {repair_id: 'av1'}, 'fields': inspected['fields']})
        self.assertEqual(status, 502, rejected)
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], 2)
        self.assertEqual(self.app.editor_workflows.get_compiled(ident), private)
        self.assertEqual(self.app.editor_workflows.get(ident)['source_json'], source)

    def test_explicit_verified_source_fork_preserves_inert_repair_origin_without_dynamic_authority(self):
        ident, source, data, applied, _ = self.repaired_native()
        status, _, raw = self.request('GET', f"/api/packages/{applied['package']['id']}/editor-sources")
        self.assertEqual(status, 200)
        report = json.loads(raw)
        receipt = next(item for item in report['sources'] if item['workflow_id'] == ident)
        selection = {key: receipt[key] for key in ('workflow_id', 'revision', 'backend_url', 'document_sha256', 'prompt_sha256')}
        forked = self.ok(f"/api/packages/{applied['package']['id']}/fork-editor-source", selection)['workflow']
        self.assertNotEqual(forked['id'], ident)
        private = self.app.editor_workflows.get_compiled(forked['id'])
        self.assertNotIn('contract_proof', private)
        self.assertNotIn('additional_inputs', private)
        self.assertEqual(private['repair_overlay']['entries'][0]['origin_workflow_id'], ident)
        current = self.app.editor_workflows.get(forked['id'])
        self.assertEqual(current['source_json'], source)
        session = self.ok(f"/api/editor-workflows/{forked['id']}/session")
        fork_data = {**data, 'document': current['document'], 'session_id': session['session_id'],
                     'base_revision': current['revision'], 'previous_package_id': applied['package']['id']}
        inspected = self.ok(f"/api/editor-workflows/{forked['id']}/interface", fork_data)
        self.assertEqual(inspected['missing_fields'], [])
        self.assertEqual(inspected['repair_sources'][0]['status'], 'restored')
        self.assertEqual(inspected['repair_sources'][0]['origin_workflow_id'], ident)
        reapplied = self.ok(f"/api/editor-workflows/{forked['id']}/apply", {**fork_data, 'fields': inspected['fields']})
        self.assertEqual(reapplied['package']['id'], applied['package']['id'])
        saved_overlay = self.app.editor_workflows.get_compiled(forked['id'])['repair_overlay']
        self.assertEqual(saved_overlay['entries'][0]['origin_workflow_id'], ident)
        self.assertEqual(self.app.editor_workflows.get(ident)['revision'], 2)

    def test_exact_current_fork_restores_repairs_but_never_copies_private_dynamic_proof(self):
        ident, source, data, _, _ = self.repaired_native()
        path = self.app.editor_workflows.directory / ident / 'compiled' / 'revision-00000002.json'
        private = json.loads(path.read_text())
        private['contract_proof'] = {'kind': 'fixture-private-proof'}
        private['additional_inputs'] = {'version': 1, 'nodes': {'2': {'class_type': 'SaveVideo', 'inputs': {
            'video': {'type': 'VIDEO', 'accept': 'link', 'source': ['1', 0]}}}}}
        path.write_text(json.dumps(private))
        forked = self.ok(f'/api/editor-workflows/{ident}/fork', {'base_revision': 2})['workflow']
        fork_private = self.app.editor_workflows.get_compiled(forked['id'])
        self.assertNotIn('contract_proof', fork_private)
        self.assertNotIn('additional_inputs', fork_private)
        self.assertEqual(self.app.editor_workflows.get(forked['id'])['source_json'], source)
        session = self.ok(f"/api/editor-workflows/{forked['id']}/session")
        inspected = self.ok(f"/api/editor-workflows/{forked['id']}/interface", {
            **data, 'session_id': session['session_id'], 'base_revision': 1})
        self.assertEqual(inspected['missing_fields'], [])
        self.assertEqual(inspected['repair_sources'][0]['origin_workflow_id'], ident)
        self.assertEqual(inspected['repair_sources'][0]['status'], 'restored')

    def test_exact_current_fork_keeps_newest_draft_and_requires_choice_for_stale_overlay(self):
        ident, _, data, _, _ = self.repaired_native()
        changed = copy.deepcopy(data['document'])
        changed['extra']['viewport'] = {'scale': 0.75}
        self.ok(f'/api/editor-workflows/{ident}/draft', {'document': changed, 'base_revision': 2})
        latest = self.app.editor_workflows.get(ident)
        forked = self.ok(f'/api/editor-workflows/{ident}/fork', {'base_revision': 3})['workflow']
        current = self.app.editor_workflows.get(forked['id'])
        self.assertEqual(current['document'], changed)
        self.assertEqual(current['source_json'], latest['source_json'])
        self.assertIsNone(self.app.editor_workflows.get_compiled(forked['id']))
        session = self.ok(f"/api/editor-workflows/{forked['id']}/session")
        inspected = self.ok(f"/api/editor-workflows/{forked['id']}/interface", {
            **data, 'document': changed, 'session_id': session['session_id'], 'base_revision': 1})
        self.assertEqual([field['input'] for field in inspected['missing_fields']], ['format.codec'])
        self.assertEqual(inspected['repair_sources'], [])
        self.assertIn('repair_overlay', self.app.editor_workflows.get_compiled(ident, 2))

    def test_exact_current_fork_rejects_stale_revision_or_caller_supplied_records(self):
        ident, _, _, _, _ = self.repaired_native()
        count = self.app.editor_workflows.list()['total']
        for payload in ({'base_revision': 1}, {'base_revision': 2, 'repair_overlay': {}},
                        {'base_revision': True}, {}):
            with self.subTest(keys=list(payload)):
                status, _, rejected = self.post(f'/api/editor-workflows/{ident}/fork', payload)
                self.assertEqual(status, 400, rejected)
                self.assertEqual(self.app.editor_workflows.list()['total'], count)


if __name__ == '__main__':
    unittest.main()
