"""r4 inbox transport boundaries, using temporary test-only TCP fixtures."""
import copy
import json
import unittest
from unittest.mock import patch

import test_hub_boundaries as fixtures
from test_hub_execution import FakeHub, uid
from frameweave.hub_execution_contract import ContractError, sha
from frameweave.hub_execution_transport import HubTransport


class InboxTests(unittest.TestCase):
    setUp = fixtures.TransportTests.setUp
    stop = fixtures.TransportTests.stop

    def receipt(self):
        hub = HubTransport(self.grant)
        receipt = FakeHub().receipt
        receipt.update({k: v for k, v in hub.binding.items() if k != 'client_id'})
        receipt['executor']['client_id'] = hub.binding['client_id']
        return receipt

    def page(self, items=None, more=False):
        items = [self.receipt()] if items is None else items
        return {'protocol': 'aihub-execution/1', 'items': items, 'has_more': more,
                'next_after_execution_id': items[-1]['execution_id'] if more and items else None,
                'claim_performed': False, 'native_work_started': False}

    def test_readonly_paginated_request_injects_private_scope_and_only_bearer_header(self):
        self.response = self.page(more=True)
        hub, after = HubTransport(self.grant), uid()
        result = hub.inbox(1, after)
        self.assertEqual(result['items'], self.response['items'])
        path, auth, raw = self.requests[0]
        self.assertEqual(path, '/api/execution/inbox')
        self.assertEqual(auth, 'Bearer ' + self.grant['token'])
        self.assertEqual(json.loads(raw), {'limit': 1, 'after_execution_id': after, '_workspace_root': self.grant['workspace_root']})
        self.assertNotIn(self.grant['token'].encode(), raw)
        self.assertEqual(len(self.requests), 1)

    def test_invalid_limits_and_cursors_have_no_network_effect(self):
        hub = HubTransport(self.grant)
        for limit in (True, 0, 26, 1.5, '1'):
            with self.subTest(limit=limit), self.assertRaises(ContractError):
                hub.inbox(limit)
        with self.assertRaises(ContractError):
            hub.inbox(after_execution_id='not-a-uuid')
        self.assertEqual(self.requests, [])

    def test_foreign_scope_or_secret_inbox_items_are_rejected(self):
        mutations = [lambda item: item.update(ledger_epoch=uid()),
            lambda item: item['executor'].update(client_id='someone-else'),
            lambda item: item.update(lease_token='private'), lambda item: item.update(input_json='private'),
            lambda item: item.update(declaration_text='private'), lambda item: item.update(dispatch_state='completed')]
        for mutate in mutations:
            self.response = self.page()
            mutate(self.response['items'][0])
            with self.subTest(mutate=mutate), self.assertRaises(ContractError):
                HubTransport(self.grant).inbox()

    def test_page_shape_duplicate_and_cursor_contract(self):
        values = [self.page([], True), dict(self.page(), claim_performed=True),
                  dict(self.page(), native_work_started=True), dict(self.page(), has_more=1),
                  dict(self.page(more=True), next_after_execution_id=uid())]
        duplicate = self.page(); duplicate['items'] *= 2; values.append(duplicate)
        for value in values:
            self.response = value
            with self.assertRaises(ContractError):
                HubTransport(self.grant).inbox()

    def test_claimed_terminal_pending_report_is_a_valid_inbox_item(self):
        self.response = self.page()
        self.response['items'][0].update(dispatch_state='claimed', provider_state='succeeded')
        self.assertEqual(HubTransport(self.grant).inbox()['items'][0]['provider_state'], 'succeeded')

    def snapshot_pair(self):
        hub = HubTransport(self.grant)
        descriptor = {'protocol': 'aihub-execution/1', 'schema_version': 1,
            'identity': dict(self.grant['connection'], status='available'),
            'workspace': {'status': 'available', 'binding_revision': self.grant['workspace_binding_revision']},
            'workspace_root': self.grant['workspace_root'], 'connection_revision': 'e' * 64,
            'execution_authority_id': self.grant['execution_authority_id'], 'ledger_epoch': self.grant['ledger_epoch']}
        text = '{ "name": "测试能力", "inputs": {} }'
        snapshot = dict(descriptor, protocol='aihub-interop/1', selected={'id': 'b' * 32, 'client_id': self.grant['subject']},
            declaration={'origin': 'stored_normalized_declaration', 'encoding': 'utf-8', 'text': text,
                         'bytes': len(text.encode()), 'sha256': sha(text.encode()), 'parsed': json.loads(text)})
        return hub, descriptor, snapshot

    def test_exact_published_text_read_requires_public_scope_and_same_publisher_without_owner_credential(self):
        hub, descriptor, snapshot = self.snapshot_pair()
        with patch.object(hub, '_request', side_effect=[descriptor, snapshot]) as call:
            result = hub.read_capability('b' * 32)
        self.assertEqual(result['declaration_text'], snapshot['declaration']['text'])
        self.assertEqual(call.call_args_list[0].args, ('/api/execution/describe',))
        self.assertIn('/api/interop/capability-snapshot?', call.call_args_list[1].args[0])
        self.assertEqual(len(call.call_args_list[1].args), 1)
        self.assertEqual(call.call_args_list[1].kwargs, {})
        self.assertNotIn(self.grant['token'], call.call_args_list[1].args[0])

    def test_capability_text_digest_publisher_revision_and_scope_cannot_drift(self):
        for mutate in (lambda v: v['selected'].update(client_id='foreign'),
            lambda v: v.update(connection_revision='0' * 64), lambda v: v['declaration'].update(text='{}'),
            lambda v: v['workspace'].update(binding_revision='0' * 64)):
            hub, descriptor, snapshot = self.snapshot_pair()
            snapshot = copy.deepcopy(snapshot); mutate(snapshot)
            with patch.object(hub, '_request', side_effect=[descriptor, snapshot]), self.assertRaises(ContractError):
                hub.read_capability('b' * 32)
