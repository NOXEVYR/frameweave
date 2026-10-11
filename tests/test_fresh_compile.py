"""Compile must resolve scope and validate inputs against one fresh schema."""
import copy
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from frameweave.backend import BackendError
from frameweave.packages import PackageStore
from frameweave.server import App, compile_workflow
from test_execution_plan import draft, live_schema
import test_editor_integration as native_tests


class FreshCompileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.app = object.__new__(App)
        self.app.lock = threading.RLock()
        self.app.packages = PackageStore(Path(self.temp.name) / 'packages')
        self.app.info, self.app.info_at = {}, 0
        self.live_info = live_schema()
        self.calls = []

        def request(path, **kwargs):
            self.calls.append(path)
            return copy.deepcopy(self.live_info)

        self.app.backend = SimpleNamespace(url='http://127.0.0.1:8188', request=request)
        self.package = self.app.packages.save(draft())
        self.original = self.app.packages.export(self.package['id'])
        self.request = {'kind': 'package', 'package_id': self.package['id'],
                        'values': {'a': 'ready.png', 'prefix': 'A'}, 'output_nodes': ['3']}

    def plan(self):
        return self.app.execution_plan({'backend_url': self.app.backend.url, 'request': self.request})

    def test_plan_cache_cannot_hide_removed_output_during_compile(self):
        self.plan()
        self.assertEqual(self.calls, ['/object_info'])
        self.live_info['SaveImage']['output_node'] = False
        with self.assertRaises(ValueError):
            self.app.compile(self.request)
        self.assertEqual(self.calls, ['/object_info', '/object_info'])

    def test_compile_fetches_once_and_shares_schema_between_scope_and_strict_validation(self):
        plan = self.plan()
        original = copy.deepcopy(self.request)
        with patch('frameweave.server.compile_workflow', wraps=compile_workflow) as strict:
            result = self.app.compile(self.request)
        self.assertEqual(self.calls, ['/object_info', '/object_info'])
        self.assertIs(strict.call_args.args[1], self.app.info)
        self.assertEqual(result['summary']['execution'], plan['execution'])
        self.assertEqual(set(result['prompt']), {'1', '3'})
        self.assertEqual(self.request, original)
        self.assertEqual(self.app.packages.export(self.package['id']), self.original)

    def test_cached_schema_cannot_hide_live_media_type_range_or_field_drift(self):
        for change in [
            lambda info: info['LoadImage']['input']['required'].update(image=[['removed.png'], {'image_upload': True}]),
            lambda info: info['LoadImage'].update(output=['STRING', 'MASK']),
            lambda info: info['SaveImage']['input']['required'].update(size=['INT', {'max': 31}]),
            lambda info: info['SaveImage']['input']['required'].update(filename_prefix=['INT']),
        ]:
            self.live_info = live_schema()
            self.plan()
            change(self.live_info)
            before = len(self.calls)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.app.compile(self.request)
            self.assertEqual(len(self.calls), before + 1)

    def test_api_and_builtin_compile_also_refresh_once_while_status_reads_keep_cache(self):
        self.app.object_info()
        self.app.object_info()
        self.assertEqual(self.calls, ['/object_info'])
        api_request = {'kind': 'api', 'prompt': {
            '1': {'class_type': 'LoadImage', 'inputs': {'image': 'ready.png'}},
            '3': {'class_type': 'SaveImage', 'inputs': {'images': ['1', 0], 'filename_prefix': 'A', 'size': 32, 'mode': 'one', 'enabled': False}},
        }, 'output_nodes': ['3']}
        self.app.compile(api_request)
        self.assertEqual(self.calls, ['/object_info', '/object_info'])
        self.app.object_info()
        self.assertEqual(len(self.calls), 2)
        with patch('frameweave.server.compile_workflow', return_value={'prompt': {}, 'summary': {}}) as strict:
            self.app.compile({'kind': 'sdxl'})
        self.assertEqual(len(self.calls), 3)
        self.assertIs(strict.call_args.args[1], self.app.info)

    def test_backend_object_or_url_switch_during_schema_fetch_is_rejected(self):
        for replace in [False, True]:
            captured = self.app.backend

            def request(path, **kwargs):
                if replace:
                    self.app.backend = SimpleNamespace(url=captured.url)
                else:
                    captured.url = 'http://127.0.0.1:8189'
                return copy.deepcopy(self.live_info)

            captured.url = 'http://127.0.0.1:8188'
            captured.request = request
            with self.subTest(replace=replace), self.assertRaisesRegex(ValueError, '推理引擎已变化'):
                self.app.compile(self.request)
            self.app.backend = captured

    def test_backend_switch_during_strict_compile_is_rejected_before_return(self):
        def moved(request, info):
            result = compile_workflow(request, info)
            self.app.backend = SimpleNamespace(url=self.app.backend.url)
            return result

        with patch('frameweave.server.compile_workflow', side_effect=moved):
            with self.assertRaisesRegex(ValueError, '推理引擎已变化'):
                self.app.compile(self.request)

    def test_fresh_fetch_error_never_falls_back_to_plan_cache(self):
        self.plan()
        with patch.object(self.app.backend, 'request', side_effect=BackendError('offline')):
            with self.assertRaises(BackendError):
                self.app.compile(self.request)
        with patch.object(self.app.backend, 'request', return_value=[]):
            with self.assertRaises(BackendError):
                self.app.compile(self.request)


class FreshCompileHTTPTests(unittest.TestCase):
    setUp = native_tests.EditorIntegrationTests.setUp
    stop_client = native_tests.EditorIntegrationTests.stop_client
    request = native_tests.EditorIntegrationTests.request
    post = native_tests.EditorIntegrationTests.post

    def test_http_compile_rejects_output_removed_immediately_after_plan_and_creates_no_job(self):
        self.backend.info = live_schema()
        package = self.app.packages.save(draft())
        original = self.app.packages.export(package['id'])
        request = {'kind': 'package', 'package_id': package['id'],
                   'values': {'a': 'ready.png', 'prefix': 'A'}, 'output_nodes': ['3']}
        payload = {'backend_url': self.backend.url, 'request': request}
        self.assertEqual(self.post('/api/execution-plan', payload)[0], 200)
        schema_reads = sum(call[:2] == ('GET', '/object_info') for call in self.backend.calls)
        self.backend.info['SaveImage']['output_node'] = False
        status, _, error = self.post('/api/compile', request)
        self.assertEqual(status, 400, error)
        self.assertEqual(sum(call[:2] == ('GET', '/object_info') for call in self.backend.calls), schema_reads + 1)
        self.assertEqual(self.app.jobs, {})
        self.assertEqual(self.backend.next_id, 0)
        self.assertFalse(any(call[0] == 'POST' for call in self.backend.calls))
        self.assertEqual(self.app.packages.export(package['id']), original)


if __name__ == '__main__':
    unittest.main()
