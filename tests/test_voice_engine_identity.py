"""Product voice environments require both Comfy health and exact identity.

HTTP responses and process handles are simulated. No engine/GPU is started.
"""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import urllib.error

from frameweave.engines import EngineManager, _MAX_VOICE_IDENTITY_BYTES, _NoRedirect, _profile


ENVIRONMENT_ID = 'voice-' + 'a' * 24


def profile(*, voice=True):
    value = {'id': ENVIRONMENT_ID if voice else 'ordinary-comfy', 'name': '测试引擎',
             'base_url': 'http://127.0.0.1:19188', 'python_executable': 'C:/fixture/python.exe',
             'main_script': 'C:/fixture/launcher.py', 'working_directory': 'C:/fixture',
             'arguments': ['--listen', '127.0.0.1', '--port', '19188'], 'max_retries': 0,
             'startup_timeout_seconds': 10, 'auto_start': False}
    if voice:
        value.update(environment_id=ENVIRONMENT_ID, environment_fingerprint='a' * 64)
    return _profile(value)


def response(body, *, status=200, headers=None):
    value = Mock()
    value.status = status
    value.headers = headers or {}
    value.read.return_value = body
    value.__enter__ = Mock(return_value=value)
    value.__exit__ = Mock(return_value=False)
    return value


class VoiceEngineIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.manager = EngineManager(Path(self.temp.name) / 'data')
        self.profile = profile()
        self.manager._profiles = [self.profile]
        self.identity = {'adapter': 'qwen3_tts_voice_design', 'environment_id': ENVIRONMENT_ID}
        self.body = json.dumps(self.identity).encode('utf-8')
        self.no_process = patch('frameweave.engines.subprocess.Popen', side_effect=AssertionError('no engine process'))
        self.popen = self.no_process.start()
        self.addCleanup(self.no_process.stop)

    def call_http_probe(self, value):
        opener = Mock()
        opener.open.return_value = value
        with patch('frameweave.engines.urllib.request.build_opener', return_value=opener) as factory:
            verified = self.manager._probe_voice_identity(self.profile['base_url'], ENVIRONMENT_ID)
        return verified, opener, factory

    def test_identity_http_is_bounded_loopback_direct_and_non_redirecting(self):
        reply = response(self.body)
        verified, opener, factory = self.call_http_probe(reply)
        self.assertTrue(verified)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, self.profile['base_url'] + '/prismcanvas/voice-identity')
        self.assertEqual(opener.open.call_args.kwargs['timeout'], .6)
        self.assertEqual(factory.call_args.args[0].proxies, {})
        self.assertIsInstance(factory.call_args.args[1], _NoRedirect)
        reply.read.assert_called_once_with(_MAX_VOICE_IDENTITY_BYTES + 1)
        self.assertIsNone(factory.call_args.args[1].redirect_request(None, None, 302, '', {}, 'http://example.com'))

    def test_identity_rejects_wrong_adapter_id_missing_extra_and_duplicate_keys(self):
        bodies = [dict(self.identity, adapter='ordinary-comfy'), dict(self.identity, environment_id='voice-' + 'b' * 24),
                  {'environment_id': ENVIRONMENT_ID}, dict(self.identity, extra=True), [], True,
                  dict(self.identity, environment_id=None)]
        for value in bodies:
            with self.subTest(value=value):
                self.assertFalse(self.call_http_probe(response(json.dumps(value).encode()))[0])
        duplicate = (b'{"adapter":"wrong","adapter":"qwen3_tts_voice_design",' +
                     b'"environment_id":"' + ENVIRONMENT_ID.encode() + b'"}')
        for body in (duplicate, b'\xff', b'not JSON', b'{'):
            with self.subTest(body=body):
                self.assertFalse(self.call_http_probe(response(body))[0])

    def test_identity_rejects_overlarge_response_before_or_after_read(self):
        for length in (str(_MAX_VOICE_IDENTITY_BYTES + 1), '-1', 'invalid'):
            reply = response(self.body, headers={'Content-Length': length})
            self.assertFalse(self.call_http_probe(reply)[0])
            reply.read.assert_not_called()
        reply = response(b' ' * (_MAX_VOICE_IDENTITY_BYTES + 1))
        self.assertFalse(self.call_http_probe(reply)[0])
        reply.read.assert_called_once_with(_MAX_VOICE_IDENTITY_BYTES + 1)

    def test_identity_rejects_http_failure_and_network_errors(self):
        for status in (204, 302, 404, 500):
            reply = response(self.body, status=status)
            self.assertFalse(self.call_http_probe(reply)[0])
            reply.read.assert_not_called()
        opener = Mock()
        for error in (TimeoutError(), OSError('private path'), urllib.error.URLError('private endpoint')):
            opener.open.side_effect = error
            with patch('frameweave.engines.urllib.request.build_opener', return_value=opener):
                self.assertFalse(self.manager._probe_voice_identity(self.profile['base_url'], ENVIRONMENT_ID))

    def test_both_system_stats_and_identity_are_required(self):
        stats = response(json.dumps({'system': {'comfyui_version': 'fixture'}, 'devices': []}).encode())
        identity = response(self.body)
        opener = Mock()
        opener.open.side_effect = [stats, identity]
        with patch('frameweave.engines.urllib.request.build_opener', return_value=opener):
            self.assertEqual(self.manager._probe_profile(self.profile), (True, False))
        self.assertEqual([call.args[0].full_url for call in opener.open.call_args_list],
                         [self.profile['base_url'] + '/system_stats', self.profile['base_url'] + '/prismcanvas/voice-identity'])
        with patch.object(self.manager, '_probe_comfy', return_value=False), \
                patch.object(self.manager, '_probe_voice_identity') as probe:
            self.assertEqual(self.manager._probe_profile(self.profile), (False, False))
        probe.assert_not_called()

    def test_all_health_paths_reject_wrong_environment_even_if_port_probe_misses_it(self):
        methods = ('_spawn', 'start', '_public_status', '_supervise_profile', '_persisted_guard')
        for method in methods:
            with self.subTest(method=method), \
                    patch.object(self.manager, '_probe_comfy', return_value=True), \
                    patch.object(self.manager, '_probe_voice_identity', return_value=False) as identity, \
                    patch.object(self.manager, '_port_in_use', return_value=False), \
                    patch.object(self.manager, '_validate_start_paths') as paths:
                if method == 'start':
                    row = self.manager.start(self.profile['id'])
                elif method == '_persisted_guard':
                    with patch.object(self.manager, '_read_process_records', return_value={self.profile['id']: {}}), \
                            patch.object(self.manager, '_inspect_saved_record', return_value='alive'):
                        row = self.manager._persisted_guard(self.profile, manual_start=True)
                else:
                    row = getattr(self.manager, method)(self.profile)
            self.assertFalse(row['online'])
            self.assertIn(row['state'], ('occupied', 'unverified'))
            self.assertIn('身份', row['message'])
            self.assertNotIn(self.profile['main_script'], str(row))
            identity.assert_called_once_with(self.profile['base_url'], ENVIRONMENT_ID)
            paths.assert_not_called()
        self.popen.assert_not_called()

    def test_all_reuse_paths_accept_matching_environment(self):
        for method in ('_spawn', 'start', '_public_status', '_supervise_profile', '_persisted_guard'):
            with self.subTest(method=method), patch.object(self.manager, '_probe_comfy', return_value=True), \
                    patch.object(self.manager, '_probe_voice_identity', return_value=True):
                if method == 'start':
                    row = self.manager.start(self.profile['id'])
                elif method == '_persisted_guard':
                    with patch.object(self.manager, '_read_process_records', return_value={self.profile['id']: {}}), \
                            patch.object(self.manager, '_inspect_saved_record', return_value='alive'):
                        row = self.manager._persisted_guard(self.profile, manual_start=False)
                else:
                    row = getattr(self.manager, method)(self.profile)
            self.assertTrue(row['online'])
            self.assertEqual(row['state'], 'online')
        self.popen.assert_not_called()

    def test_mismatch_preserves_owned_process_meta_and_never_restarts_or_stops(self):
        process = Mock()
        process.poll.return_value = None
        log = Mock()
        self.manager._processes[self.profile['id']] = (process, log)
        meta = {'online_seen': True, 'restarts': 0, 'error': 'retained error', 'stop_retry': True,
                'started_at': time.monotonic() - 1000}
        self.manager._meta[self.profile['id']] = copy.deepcopy(meta)
        with patch.object(self.manager, '_probe_comfy', return_value=True), \
                patch.object(self.manager, '_probe_voice_identity', return_value=False), \
                patch.object(self.manager, '_spawn') as spawn, \
                patch.object(self.manager, '_persist_profile_state') as persisted:
            rows = [self.manager.status()['profiles'][0], self.manager.supervise()['profiles'][0],
                    self.manager.start(self.profile['id'])]
        for row in rows:
            self.assertFalse(row['online'])
            self.assertEqual(row['state'], 'unverified')
            self.assertTrue(row['managed'])
        self.assertEqual(self.manager._meta[self.profile['id']], meta)
        self.assertIs(self.manager._processes[self.profile['id']][0], process)
        process.terminate.assert_not_called()
        process.kill.assert_not_called()
        log.close.assert_not_called()
        spawn.assert_not_called()
        persisted.assert_not_called()

    def test_mismatch_does_not_reap_or_retry_exited_child(self):
        process, log = Mock(), Mock()
        process.poll.return_value = 1
        self.manager._processes[self.profile['id']] = (process, log)
        self.manager._meta[self.profile['id']] = {'online_seen': False, 'restarts': 0}
        with patch.object(self.manager, '_probe_comfy', return_value=True), \
                patch.object(self.manager, '_probe_voice_identity', return_value=False), \
                patch.object(self.manager, '_spawn') as spawn:
            supervised = self.manager.supervise()['profiles'][0]
            started = self.manager.start(self.profile['id'])
        self.assertEqual(supervised['state'], 'occupied')
        self.assertEqual(started['state'], 'occupied')
        log.close.assert_not_called()
        process.terminate.assert_not_called()
        process.kill.assert_not_called()
        spawn.assert_not_called()

    def test_ordinary_comfy_health_and_lifecycle_do_not_request_voice_identity(self):
        ordinary = profile(voice=False)
        self.manager._profiles = [ordinary]
        with patch.object(self.manager, '_probe_comfy', return_value=True), \
                patch.object(self.manager, '_probe_voice_identity', side_effect=AssertionError('ordinary must not handshake')) as identity:
            self.assertEqual(self.manager._probe_profile(ordinary), (True, False))
            for row in (self.manager.status()['profiles'][0], self.manager.supervise()['profiles'][0],
                        self.manager.start(ordinary['id']), self.manager._spawn(ordinary)):
                self.assertTrue(row['online'])
                self.assertEqual(row['state'], 'online')
        identity.assert_not_called()

    def test_environment_registration_retains_transaction_prepare_callback(self):
        prepared = Mock()
        with patch.object(self.manager, '_probe_comfy', return_value=False), \
                patch.object(self.manager, '_port_in_use', return_value=False):
            first = self.manager.register_environment(self.profile, prepare=prepared)
            second = self.manager.register_environment(self.profile, prepare=prepared)
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(prepared.call_count, 2)
        self.assertEqual(len(self.manager._profiles), 1)
        self.assertEqual(prepared.call_args.args[0]['environment_id'], ENVIRONMENT_ID)


if __name__ == '__main__':
    unittest.main()
