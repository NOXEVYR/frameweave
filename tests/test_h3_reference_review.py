"""Independent H3 server-method checks with no listening service or generation."""
import copy
import threading
import types
import unittest
from unittest.mock import patch

from frameweave.server import App
from test_h3_reference import fixture


class H3ReferenceIndependentReviewTests(unittest.TestCase):
    def app(self):
        info, calls = fixture(), []

        def request(path, **kwargs):
            calls.append(path)
            return info

        backend = types.SimpleNamespace(url='http://127.0.0.1:8188', request=request)
        app = types.SimpleNamespace(lock=threading.RLock(), backend=backend, info={'stale': {}}, info_at=0)
        app._object_info_for_backend = types.MethodType(App._object_info_for_backend, app)
        return app, calls

    def payload(self):
        return {'backend_url': 'http://127.0.0.1:8188', 'preset_request': {'kind': 'h3_ref'},
                'layout': {'image_count': 0, 'videos': [{'soundtrack': False}], 'audio_count': 0}}

    def test_current_backend_fresh_schema_ignores_stale_cache_without_writes(self):
        app, calls = self.app()
        result = App.prepare_h3_reference(app, self.payload())
        self.assertEqual(calls, ['/object_info'])
        self.assertEqual(result['status'], 'prepared')
        self.assertEqual(result['backend_url'], app.backend.url)
        self.assertNotIn('stale', app.info)

    def test_backend_object_replacement_during_pure_assembly_refuses_late_document(self):
        app, calls = self.app()

        def assemble(*_):
            app.backend = copy.copy(app.backend)
            return {'status': 'prepared', 'document': {'name': 'must not escape'}}

        with patch('frameweave.server.prepare_h3_reference_package', side_effect=assemble):
            with self.assertRaisesRegex(ValueError, '装配期间'):
                App.prepare_h3_reference(app, self.payload())
        self.assertEqual(calls, ['/object_info'])

    def test_wrong_backend_is_refused_before_any_metadata_request(self):
        app, calls = self.app()
        payload = {**self.payload(), 'backend_url': 'http://127.0.0.1:8189'}
        with self.assertRaisesRegex(ValueError, '推理引擎已变化'):
            App.prepare_h3_reference(app, payload)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
