"""The optional worker is reachable only through the existing loopback guards."""
import json
import unittest
from unittest.mock import patch
import test_editor_integration as fixtures
from frameweave.__main__ import _idle_can_exit


class HubConnectionHTTPTests(unittest.TestCase):
    setUp = fixtures.EditorIntegrationTests.setUp
    stop_client = fixtures.EditorIntegrationTests.stop_client
    request = fixtures.EditorIntegrationTests.request
    post = fixtures.EditorIntegrationTests.post

    def test_default_status_and_local_pagination_create_no_worker_files(self):
        code, _, raw = self.request('GET', '/api/hub-connection')
        self.assertEqual(code, 200); state = json.loads(raw)
        self.assertEqual(state['status'], 'unconfigured'); self.assertFalse(state['enabled'])
        self.assertFalse((self.app.data_dir / 'hub-worker').exists())
        code, _, result = self.post('/api/hub-connection/executions', {})
        self.assertEqual(code, 200, result); self.assertEqual(result['items'], [])
        self.assertEqual(self.backend.calls, [])

    def test_routes_require_csrf_and_same_origin_even_for_grant_probe(self):
        for path in ('grant', 'probe', 'enabled', 'capabilities', 'inbox', 'step', 'executions', 'prepare-offer'):
            self.assertEqual(self.post('/api/hub-connection/' + path, {}, csrf=False)[0], 403)
            self.assertEqual(self.post('/api/hub-connection/' + path, {}, headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('GET', '/api/hub-connection', headers={'Sec-Fetch-Site': 'cross-site'})[0], 403)
        self.assertEqual(self.backend.calls, [])

    def test_invalid_or_unknown_operations_are_errors_not_implicit_generation(self):
        self.assertEqual(self.post('/api/hub-connection/unknown', {})[0], 404)
        for path, body in [('grant', {'grant_json': 'not json'}), ('probe', {}), ('enabled', {'enabled': 'yes'}), ('step', {'execution_id': 'invalid'})]:
            self.assertEqual(self.post('/api/hub-connection/' + path, body)[0], 400)
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse((self.app.data_dir / 'hub-worker').exists())

    def test_worker_guard_precedes_exit_and_backend_replacement(self):
        with patch.object(self.app.hub_connection, 'prepare_exit', return_value=False):
            self.assertFalse(self.app.prepare_exit(self.port))
            self.assertFalse(self.app.exit_pending)
        before = self.app.backend
        with patch.object(self.app.hub_connection, 'can_switch_backend', return_value=False):
            status, _, result = self.post('/api/settings', {'backend_url': 'http://127.0.0.1:8199'})
            self.assertEqual(status, 400, result); self.assertIs(self.app.backend, before)

    def test_idle_watcher_survives_worker_enabled_then_exits_after_pause(self):
        self.app.hub_connection._enabled = True
        self.assertFalse(_idle_can_exit(self.app, self.port))
        self.assertFalse(self.app.exit_pending)
        with self.assertRaisesRegex(ValueError, '暂停 Hub'):
            self.app.prepare_exit(self.port)
        self.app.hub_connection._enabled = False
        self.assertTrue(_idle_can_exit(self.app, self.port))
        self.assertTrue(self.app.exit_pending)
