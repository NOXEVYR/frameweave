"""Optional manager acceptance with isolated private dirs and fake worker transport."""
import copy
import json
import tempfile
import threading
import time
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from frameweave.hub_connection import HubConnection, ConnectionError, PROFILE_SCHEMA
from frameweave.hub_execution_contract import bind_declaration, canonical, sha
from frameweave.hub_execution_transport import HubTransport
from frameweave.packages import PackageStore
from test_hub_execution import FakeHub, FakeNative, uid

START_THREAD = HubConnection._start_thread


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.app = types.SimpleNamespace(data_dir=self.root, closed=threading.Event(), lock=threading.RLock(), exit_pending=False,
                                         packages=PackageStore(self.root / 'packages'))
        self.addCleanup(self.app.closed.set)
        self.package = self.app.packages.save({'name': 'Test package', 'prompt': {
            '1': {'class_type': 'TestOutput', 'inputs': {'text': 'default'}}}, 'fields': [
            {'id': 'text', 'node_id': '1', 'input': 'text', 'type': 'text', 'label': 'Prompt', 'default': 'default', 'required': True}]})
        self.grant = {'schema': 'ai-hub-execution-grant/1', 'protocol': 'aihub-execution/1', 'role': 'worker',
            'subject': 'test-worker', 'grant_id': uid(), 'token': 'a' * 43, 'workspace_root': str(self.root),
            'workspace_binding_revision': 'a' * 64, 'execution_authority_id': uid(), 'ledger_epoch': uid(),
            'connection': {'scheme': 'http', 'host': '127.0.0.1', 'port': 18888, 'app': 'ai-hub',
                'install_root': str(self.root), 'service_instance_id': uuid.uuid4().hex,
                'connection_revision': 'c' * 64, 'control_protocol': 'ai-hub-local-control-v1'}}
        self.hub, self.native = FakeHub(), FakeNative()
        binding = HubTransport(self.grant).binding
        self.hub.binding = binding
        self.hub.receipt.update({k: v for k, v in binding.items() if k != 'client_id'})
        self.calls = []
        self.hub.describe = lambda: self.calls.append('describe') or {}
        self.hub.inbox = lambda limit=10, after_execution_id=None: self.calls.append('inbox') or {
            'protocol': 'aihub-execution/1', 'items': [copy.deepcopy(self.hub.receipt)], 'has_more': False,
            'next_after_execution_id': None, 'claim_performed': False, 'native_work_started': False}
        self.hub.read_capability = lambda identifier: self.calls.append('read-capability') or {
            'capability_id': identifier, 'client_id': binding['client_id'], 'declaration_text': self.hub.declaration,
            'declaration_sha256': sha(self.hub.declaration.encode())}
        def transport(grant):
            HubTransport(grant)
            return self.hub
        for target, replacement in [('frameweave.hub_connection.HubTransport', transport),
                                     ('frameweave.hub_connection.NativeApp', lambda app: self.native)]:
            patcher = patch(target, replacement); patcher.start(); self.addCleanup(patcher.stop)
        thread = patch.object(HubConnection, '_start_thread'); thread.start(); self.addCleanup(thread.stop)
        self.manager = HubConnection(self.app)

    def import_grant(self):
        return self.manager.import_grant({'grant_json': json.dumps(self.grant)})

    def profile(self):
        template = {'kind': 'package', 'package_id': self.package['id'], 'values': {'text': 'private-fixed-prompt'}, 'output_nodes': ['1']}
        bindings = {'text': ['values', 'text']}
        declaration = {'key': 'prism.test', 'name': 'Test public capability',
            'inputs': {'type': 'object', 'properties': {'text': {'type': 'string', 'maxLength': 200}}, 'required': ['text']}}
        declaration = canonical(bind_declaration(declaration, self.native.backend, template, bindings)).decode()
        return {'schema': PROFILE_SCHEMA, 'capability_id': 'b' * 32, 'declaration_text': declaration,
                'backend': self.native.backend, 'template': template, 'bindings': bindings, 'enabled': False}

    def configure(self, enabled=True):
        self.import_grant()
        profile = self.profile()
        self.hub.declaration = profile['declaration_text']
        self.hub.receipt['declaration_sha256'] = sha(self.hub.declaration.encode())
        self.manager.save_capability({'profile_json': json.dumps(profile)})
        self.manager.enable_capability({'capability_id': 'b' * 32, 'enabled': True})
        if enabled:
            self.manager.set_enabled({'enabled': True})
        return profile

    def test_default_is_disabled_no_file_thread_or_network_and_snapshot_is_redacted(self):
        state = self.manager.snapshot()
        self.assertEqual(state['status'], 'unconfigured'); self.assertFalse((self.root / 'hub-worker').exists())
        self.assertEqual(self.calls, []); self.assertIsNone(self.manager._thread)

    def test_import_probe_and_inbox_are_readonly_and_never_claim_or_generate(self):
        state = self.import_grant()
        self.manager.probe({}); inbox = self.manager.inbox({})
        self.assertFalse(state['enabled']); self.assertEqual(state['status'], 'paused')
        self.assertFalse(inbox['claim_performed']); self.assertEqual(self.native.submissions, [])
        self.assertIsNone(self.hub.claim_key)
        public = json.dumps([state, inbox], ensure_ascii=False)
        for private in (self.grant['token'], str(self.root), 'input_json', 'lease_token'):
            self.assertNotIn(private, public)
        self.assertEqual(state['connection']['subject'], 'test-worker')
        self.assertEqual(self.calls, ['describe', 'inbox', 'describe', 'inbox', 'describe', 'inbox'])

    def test_import_requires_json_content_limit_and_rejects_paths(self):
        for data in ({'path': str(self.root / 'grant.json')}, {'grant_json': str(self.root / 'grant.json')}, {'grant_json': ' ' * 32769}, {'grant_json': '{"x":1,"x":2}'}):
            with self.assertRaises(ConnectionError): self.manager.import_grant(data)
        self.assertFalse((self.root / 'hub-worker').exists()); self.assertEqual(self.calls, [])

    def test_profile_is_fixed_package_only_and_cannot_change_binding_or_enable_on_import(self):
        self.configure(False)
        for mutate in (lambda p: p.update(enabled=True), lambda p: p['template'].update(kind='api'),
            lambda p: p['template'].update(prompt={}), lambda p: p['template']['values'].update(text='changed'),
            lambda p: p['bindings'].update(text=['package_id']), lambda p: p.update(extra='field'),
            lambda p: p['template'].update(output_nodes=['foreign'])):
            profile = self.profile(); mutate(profile)
            with self.assertRaises(ConnectionError): self.manager.save_capability({'profile_json': json.dumps(profile)})
        self.assertEqual(self.native.submissions, []); self.assertFalse(self.manager.snapshot()['enabled'])

    def test_exact_published_declaration_must_match_and_private_template_not_in_snapshot(self):
        self.import_grant(); profile = self.profile()
        with self.assertRaises(ConnectionError): self.manager.save_capability({'profile_json': json.dumps(profile)})
        self.hub.declaration = profile['declaration_text']
        state = self.manager.save_capability({'profile_json': json.dumps(profile)})
        self.assertNotIn('private-fixed-prompt', json.dumps(state)); self.assertNotIn('template', json.dumps(state))
        self.assertEqual(state['capabilities'][0]['package_id'], self.package['id'])

    def test_explicit_enable_and_step_submit_once_and_pause_recovers_original_without_new_submission(self):
        self.configure(); eid = self.hub.receipt['execution_id']
        first = self.manager.step({'execution_id': eid}); self.assertEqual(first['state'], 'running')
        original = self.manager._store.get(eid)
        self.manager.set_enabled({'enabled': False})
        self.manager.step({'execution_id': eid})
        self.assertEqual(len(self.native.submissions), 1)
        self.assertEqual(self.manager._store.get(eid)['provider_request_id'], original['provider_request_id'])
        restored = HubConnection(self.app)
        self.assertFalse(restored.snapshot()['enabled']); restored.step({'execution_id': eid})
        self.assertEqual(len(self.native.submissions), 1)
        self.assertTrue(restored.has_unfinished())
        with self.assertRaises(ConnectionError): restored.prepare_exit()

    def test_disabled_new_execution_is_not_claimed(self):
        self.configure(False)
        with self.assertRaises(ConnectionError): self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        self.assertIsNone(self.hub.claim_key); self.assertEqual(self.native.submissions, [])

    def test_pause_during_claim_prevents_first_native_intent_and_is_resumable(self):
        self.configure(); original_claim = self.hub.claim
        def claim(*args):
            result = original_claim(*args)
            self.manager.set_enabled({'enabled': False})
            return result
        with patch.object(self.hub, 'claim', side_effect=claim), self.assertRaises(ConnectionError):
            self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        record = self.manager._store.get(self.hub.receipt['execution_id'])
        self.assertFalse(record['native_attempted']); self.assertEqual(self.native.submissions, [])
        self.manager.set_enabled({'enabled': True}); self.manager.step({'execution_id': record['execution_id']})
        self.assertEqual(len(self.native.submissions), 1)

    def test_pause_after_durable_native_admission_does_not_reject_or_repeat_that_submission(self):
        self.configure(); original_submit = self.native.submit
        def submit(*args):
            self.manager.set_enabled({'enabled': False})
            return original_submit(*args)
        with patch.object(self.native, 'submit', side_effect=submit):
            self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        self.assertEqual(len(self.native.submissions), 1)

    def test_disabled_capability_cannot_start_already_claimed_but_unsubmitted_record(self):
        self.configure(); eid = self.hub.receipt['execution_id']; original_claim = self.hub.claim
        def claim(*args):
            result = original_claim(*args)
            self.manager.set_enabled({'enabled': False})
            return result
        with patch.object(self.hub, 'claim', side_effect=claim), self.assertRaises(ConnectionError):
            self.manager.step({'execution_id': eid})
        self.manager.enable_capability({'capability_id': 'b' * 32, 'enabled': False})
        self.manager.set_enabled({'enabled': True})
        with self.assertRaises(ConnectionError) as error:
            self.manager.step({'execution_id': eid})
        self.assertEqual(error.exception.code, 'capability_disabled')
        self.assertFalse(self.manager._store.get(eid)['native_attempted'])
        self.assertEqual(self.native.submissions, [])
        self.manager.enable_capability({'capability_id': 'b' * 32, 'enabled': True})
        self.manager.step({'execution_id': eid})
        self.assertEqual(len(self.native.submissions), 1)

    def test_scope_or_profile_change_is_blocked_for_unfinished_ledger_and_grant_rotation_keeps_it(self):
        self.configure(); eid = self.hub.receipt['execution_id']; self.manager.step({'execution_id': eid})
        original_store = self.manager._store
        with self.assertRaises(ConnectionError): self.manager.remove_capability({'capability_id': 'b' * 32})
        profile = self.profile(); profile['template']['values']['text'] = 'different'
        declaration = json.loads(profile['declaration_text'])
        profile['declaration_text'] = canonical(bind_declaration(declaration, profile['backend'], profile['template'], profile['bindings'])).decode()
        with self.assertRaises(ConnectionError): self.manager.save_capability({'profile_json': json.dumps(profile)})
        grant = copy.deepcopy(self.grant); grant['workspace_root'] = str(self.root / 'other')
        with self.assertRaises(ConnectionError): self.manager.import_grant({'grant_json': json.dumps(grant)})
        grant = dict(self.grant, grant_id=uid(), token='z' * 43)
        self.manager.import_grant({'grant_json': json.dumps(grant)})
        self.assertIs(self.manager._store, original_store); self.assertFalse(self.manager.snapshot()['enabled'])

    def test_busy_configuration_edits_are_rejected_but_pause_remains_available(self):
        self.configure(); outcomes = []
        def describe():
            for operation in (lambda: self.manager.remove_capability({'capability_id': 'b' * 32}),
                              lambda: self.manager.enable_capability({'capability_id': 'b' * 32, 'enabled': False})):
                try: operation()
                except ConnectionError as error: outcomes.append(error.code)
            self.manager.set_enabled({'enabled': False})
            return {}
        with patch.object(self.hub, 'describe', side_effect=describe), self.assertRaises(ConnectionError):
            self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        self.assertEqual(outcomes, ['connection_busy', 'connection_busy']); self.assertEqual(self.native.submissions, [])
        self.assertIsNone(self.hub.claim_key)

    def test_external_config_change_corruption_and_missing_journal_are_protected(self):
        self.import_grant(); path = self.manager._path; original = path.read_bytes()
        path.write_text('{"damaged":', encoding='utf-8')
        restored = HubConnection(self.app); self.assertEqual(restored.snapshot()['status'], 'blocked')
        with self.assertRaises(ConnectionError): restored.import_grant({'grant_json': json.dumps(self.grant)})
        self.assertEqual(path.read_text(), '{"damaged":')
        with self.assertRaises(ConnectionError): self.manager.set_enabled({'enabled': False})
        self.assertEqual(path.read_text(), '{"damaged":')
        path.write_bytes(original); self.manager._store.close(); self.manager._store.path.unlink()
        restored = HubConnection(self.app); self.assertEqual(restored.snapshot()['status'], 'blocked')
        self.assertFalse(self.manager._store.path.exists())

    def test_failed_persist_does_not_publish_enabled_state_or_send_work(self):
        self.configure(False)
        with patch('frameweave.hub_connection.os.replace', side_effect=OSError('private/path/token')):
            with self.assertRaises(ConnectionError) as caught: self.manager.set_enabled({'enabled': True})
        self.assertNotIn('private/path/token', str(caught.exception)); self.assertFalse(self.manager.snapshot()['enabled'])
        self.assertEqual(self.native.submissions, [])

    def test_exit_pending_during_probe_prevents_late_enable_and_native_admission(self):
        self.configure(False)
        self.hub.describe = lambda: setattr(self.app, 'exit_pending', True) or {}
        with self.assertRaises(ConnectionError): self.manager.set_enabled({'enabled': True})
        self.assertFalse(self.manager.snapshot()['enabled']); self.assertEqual(self.native.submissions, [])

    def test_pause_during_enable_probe_wins_over_late_enable_commit(self):
        self.configure(False)
        self.hub.describe = lambda: self.manager.set_enabled({'enabled': False})
        with self.assertRaises(ConnectionError): self.manager.set_enabled({'enabled': True})
        self.assertFalse(self.manager.snapshot()['enabled'])
        self.assertFalse(json.loads(self.manager._path.read_text('utf-8'))['enabled'])

    def test_unapproved_remote_declaration_is_never_claimed_even_by_explicit_step(self):
        self.configure(); self.hub.receipt['declaration_sha256'] = '0' * 64
        with self.assertRaises(ConnectionError): self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        self.assertIsNone(self.hub.claim_key); self.assertEqual(self.native.submissions, [])

    def test_tick_is_bounded_and_prioritizes_known_recovery_before_inbox(self):
        self.configure(); eid = self.hub.receipt['execution_id']
        self.manager.step({'execution_id': eid}); self.calls.clear()
        self.manager._tick()
        self.assertNotIn('inbox', self.calls); self.assertEqual(len(self.native.submissions), 1)
        self.calls.clear(); self.manager._tick()
        self.assertEqual(self.calls.count('inbox'), 1)
        self.manager.set_enabled({'enabled': False}); self.calls.clear(); self.manager._tick()
        self.assertEqual(self.calls, [])

    def test_store_summary_has_no_claim_or_input_and_pages_stably(self):
        self.configure(); self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        for _ in range(3):
            eid = uid(); stable = copy.deepcopy(self.hub.receipt); stable['execution_id'] = eid
            self.manager._store.reserve(eid, stable)
        store = self.manager._store; page = store.summaries(2)
        self.assertEqual(len(page['items']), 2); self.assertTrue(page['has_more'])
        second = store.summaries(2, page['next_after_execution_id'])
        self.assertEqual(len(second['items']), 2)
        self.assertEqual(len({v['execution_id'] for v in page['items'] + second['items']}), 4)
        text = json.dumps([page, second])
        for secret in ('lease_token', 'input_json', 'private-fixed-prompt', 'declaration_text', self.grant['token']): self.assertNotIn(secret, text)
        for limit in (True, 0, 26):
            with self.assertRaises(ValueError): store.summaries(limit)

    def test_local_execution_pages_are_available_paused_without_network_and_validate_cursor(self):
        self.configure(); self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        for _ in range(3):
            eid = uid(); stable = copy.deepcopy(self.hub.receipt); stable['execution_id'] = eid
            self.manager._store.reserve(eid, stable)
        self.manager.set_enabled({'enabled': False}); self.calls.clear()
        first = self.manager.executions({'limit': 2, 'unfinished_only': True})
        second = self.manager.executions({'limit': 2, 'after_execution_id': first['next_after_execution_id']})
        self.assertTrue(first['has_more']); self.assertFalse(second['has_more'])
        self.assertEqual(len({item['execution_id'] for item in first['items'] + second['items']}), 4)
        self.assertEqual(self.calls, [])
        for data in ({'limit': True}, {'limit': 26}, {'after_execution_id': 'not-id'}, {'unfinished_only': 1}, {'token': 'private'}):
            with self.assertRaises(ConnectionError): self.manager.executions(data)
        self.assertFalse(self.manager.snapshot()['status'] == 'blocked')

    def test_paused_backend_switch_only_allows_common_frozen_original_backend(self):
        self.assertTrue(self.manager.can_switch_backend(self.native.backend))
        self.configure(); self.manager.step({'execution_id': self.hub.receipt['execution_id']})
        self.assertFalse(self.manager.can_switch_backend(self.native.backend))
        self.manager.set_enabled({'enabled': False}); self.calls.clear()
        self.assertTrue(self.manager.can_switch_backend(self.native.backend))
        self.assertFalse(self.manager.can_switch_backend('http://127.0.0.1:8189'))
        with self.manager._operation(): self.assertFalse(self.manager.can_switch_backend(self.native.backend))
        eid = uid(); stable = copy.deepcopy(self.hub.receipt); stable['execution_id'] = eid
        self.manager._store.reserve(eid, stable)
        self.assertFalse(self.manager.can_switch_backend(self.native.backend))
        self.assertEqual(self.calls, [])

    def test_daemon_observes_minimum_tick_interval_and_closed_without_network(self):
        self.configure(); observed = threading.Event(); start = time.monotonic()
        def tick():
            observed.set(); self.app.closed.set()
        with patch.object(self.manager, '_tick', side_effect=tick) as mocked:
            START_THREAD(self.manager); thread = self.manager._thread
            self.assertTrue(thread.daemon)
            self.assertTrue(observed.wait(4))
            thread.join(1)
            self.assertGreaterEqual(time.monotonic() - start, 1.9)
            self.assertFalse(thread.is_alive()); self.assertEqual(mocked.call_count, 1)
