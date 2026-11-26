"""Environment registration is data-only; fixtures never execute Python/models."""
import copy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from frameweave.engines import EngineManager, _profile
from frameweave.packages import PackageStore
from frameweave.voice_environments import VoiceEnvironments, validate_start


class VoiceEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.comfy = self.root / "ComfyUI"; self.comfy.mkdir(); (self.comfy / "comfy").mkdir()
        (self.comfy / "main.py").write_text("# never execute fixture\n")
        self.python = self.root / "python_embeded/python.exe"; self.python.parent.mkdir(); self.python.write_bytes(b'fixture')
        self.site = self.python.parent / "Lib/site-packages"; self.site.mkdir(parents=True)
        for module in ("qwen_tts", "torch", "numpy", "transformers"):
            (self.site / module).mkdir(); (self.site / module / "__init__.py").write_text("raise RuntimeError('must not import')")
        (self.site / "soundfile.py").write_text("raise RuntimeError('must not import')")
        frontend = self.site / "comfyui_frontend_package/static"; frontend.mkdir(parents=True); (frontend / "index.html").write_text("fixture")
        self.model = self.root / "private-model"; self.model.mkdir()
        (self.model / "config.json").write_text(json.dumps({"model_type": "qwen3_tts", "tts_model_type": "voice_design"}))
        for name in ("model.safetensors", "tokenizer_config.json", "vocab.json", "merges.txt", "speech_tokenizer/config.json", "speech_tokenizer/model.safetensors"):
            target = self.model / name; target.parent.mkdir(exist_ok=True); target.write_bytes(b'fixture')
        self.data = self.root / "data"
        self.engines = EngineManager(self.data)
        self.packages = PackageStore(self.data / "workflow-packages")
        self.manager = VoiceEnvironments(self.data, self.engines, self.packages)
        self.request = {"comfy_root": str(self.comfy), "model_path": str(self.model), "port": 19001}
        self.probe = patch.object(EngineManager, '_probe_comfy', return_value=False); self.probe.start(); self.addCleanup(self.probe.stop)

    def register(self):
        inspection = self.manager.inspect(self.request)
        return self.manager.prepare({**self.request, 'fingerprint': inspection['fingerprint']})

    def test_inspect_reads_files_without_import_process_or_writes(self):
        with patch('subprocess.Popen', side_effect=AssertionError('no process')):
            result = self.manager.inspect(self.request)
        self.assertTrue(result['ready_to_register'])
        self.assertEqual(result['inspection_level'], 'files_only')
        self.assertFalse(result['runtime_verified']); self.assertFalse(result['model_loaded'])
        self.assertFalse(self.data.exists())

    def test_prepare_registers_reusable_package_and_immutable_owned_files_only(self):
        original = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch('subprocess.Popen', side_effect=AssertionError('no process')):
            first = self.register(); second = self.register()
        self.assertEqual(first['environment'], second['environment'])
        self.assertEqual(first['package']['id'], second['package']['id'])
        self.assertEqual(len(self.engines._profiles), 1)
        profile = self.engines._profiles[0]
        self.assertFalse(profile['auto_start']); self.assertEqual(profile['max_retries'], 0)
        self.assertIn('--cpu', profile['arguments']); self.assertIsNone(validate_start(profile))
        self.assertNotIn(str(self.model), json.dumps(first['package']))
        self.assertTrue(all(Path(name).read_bytes() == raw for name, raw in original.items()))
        self.assertEqual(len(self.manager.list()['environments']), 1)
        loaded = EngineManager(self.data)
        self.assertEqual(loaded._profiles, self.engines._profiles)

    def test_all_missing_items_are_identified_and_prompt_redacts_local_paths(self):
        (self.site / 'qwen_tts/__init__.py').unlink()
        (self.model / 'model.safetensors').unlink()
        result = self.manager.inspect(self.request)
        self.assertFalse(result['ready_to_register'])
        missing = {item['key'] for item in result['checks'] if item['status'] == 'missing'}
        self.assertIn('module_qwen_tts', missing); self.assertIn('model_weights', missing)
        self.assertNotIn(str(self.root), result['repair_prompt'])
        with self.assertRaisesRegex(ValueError, '尚不完整'):
            self.manager.prepare({**self.request, 'fingerprint': result['fingerprint']})

    def test_model_variant_is_confirmed_by_metadata_not_folder_name(self):
        (self.model / 'config.json').write_text(json.dumps({'model_type': 'qwen3_tts', 'tts_model_type': 'base'}))
        result = self.manager.inspect(self.request)
        self.assertFalse(result['ready_to_register'])
        self.assertTrue(any(item['key'] == 'model_architecture' and item['status'] == 'missing' for item in result['checks']))

    def test_changed_sources_or_configuration_invalidate_previous_inspection(self):
        fingerprint = self.manager.inspect(self.request)['fingerprint']
        (self.comfy / 'main.py').write_text('# changed fixture')
        with self.assertRaisesRegex(ValueError, '已变化'):
            self.manager.prepare({**self.request, 'fingerprint': fingerprint})
        self.assertFalse(self.data.exists())

    def test_port_collision_preserves_existing_registered_profile(self):
        first = self.register(); saved = (self.data / 'engines.json').read_bytes()
        (self.comfy / 'main.py').write_text('# new source version')
        with self.assertRaisesRegex(ValueError, '端口已登记'):
            self.register()
        self.assertEqual((self.data / 'engines.json').read_bytes(), saved)
        self.assertEqual(self.engines._profiles[0]['id'], first['engine']['id'])
        self.assertEqual(len(list(self.manager.directory.glob('voice-*'))), 1)

    def test_bundle_tampering_is_not_overwritten_and_prevents_start(self):
        result = self.register(); profile = self.engines._profiles[0]
        launcher = Path(profile['main_script']); launcher.write_bytes(b'changed by user')
        self.assertIsNotNone(validate_start(profile))
        with self.assertRaisesRegex(ValueError, '被修改'):
            self.register()
        self.assertEqual(launcher.read_bytes(), b'changed by user')
        self.assertEqual(self.manager.list()['environments'][0]['id'], result['engine']['id'])

    def test_registration_disk_failure_rolls_back_in_memory_profiles(self):
        with patch.object(self.engines, '_save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.register()
        self.assertEqual(self.engines._profiles, [])
        self.assertFalse((self.data / 'engines.json').exists())
        self.assertFalse(self.manager.list()['environments'][0]['engine_registered'])
        self.assertEqual(len(self.register()['package']['fields']), 5)
        self.assertTrue(self.manager.list()['environments'][0]['engine_registered'])

    def test_recheck_after_dependency_removed_is_readonly_and_reports_change(self):
        first = self.register()
        (self.site / 'qwen_tts/__init__.py').unlink()
        before = (self.data / 'engines.json').read_bytes()
        with patch('subprocess.Popen', side_effect=AssertionError('no process')):
            result = self.manager.recheck(first['engine']['id'])
        self.assertFalse(result['configuration_unchanged']); self.assertFalse(result['ready_to_register'])
        self.assertEqual((self.data / 'engines.json').read_bytes(), before)

    def test_partitioned_weights_and_missing_shards_are_bounded(self):
        (self.model / 'model.safetensors').unlink()
        (self.model / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'a': 'first.safetensors', 'b': 'second.safetensors'}}))
        (self.model / 'first.safetensors').write_bytes(b'fixture')
        self.assertFalse(self.manager.inspect(self.request)['ready_to_register'])
        (self.model / 'second.safetensors').write_bytes(b'fixture')
        self.assertTrue(self.manager.inspect(self.request)['ready_to_register'])
        (self.model / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': {'a': '../private'}}))
        self.assertFalse(self.manager.inspect(self.request)['ready_to_register'])
        for index in ([], None, {}, {'weight_map': []}, {'weight_map': None}, {'weight_map': 'invalid'}):
            with self.subTest(index=index):
                (self.model / 'model.safetensors.index.json').write_text(json.dumps(index))
                report = self.manager.inspect(self.request)
                self.assertFalse(report['ready_to_register'])
                self.assertTrue(any(item['key'] == 'model_weights' and item['status'] == 'missing' for item in report['checks']))

    def test_rejects_commands_and_invalid_data_before_writes(self):
        for changes in ({'arguments': ['bad']}, {'port': True}, {'port': 0}, {'comfy_root': 'relative'}, {'model_path': '//remote/share'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.manager.inspect({**self.request, **changes})
        self.assertFalse(self.data.exists())

    def test_environment_identity_participates_in_process_signature(self):
        self.register(); profile = self.engines._profiles[0]; altered = copy.deepcopy(profile)
        altered['environment_fingerprint'] = 'a' * 64
        self.assertNotEqual(self.engines._profile_signature(profile), self.engines._profile_signature(altered))
        with self.assertRaisesRegex(ValueError, '身份无效'):
            _profile({**profile, 'environment_id': '../other'})

    def test_corrupt_record_is_reported_without_deleting_it(self):
        result = self.register(); path = self.manager.directory / result['engine']['id'] / 'registration.json'
        path.write_text('{bad')
        self.assertEqual(len(self.manager.list()['issues']), 1); self.assertEqual(path.read_text(), '{bad')

    def test_missing_explicit_overlay_blocks_registration_even_with_installed_modules(self):
        result = self.manager.inspect({**self.request, 'dependency_dir': str(self.root / 'missing-overlay')})
        self.assertFalse(result['ready_to_register'])
        self.assertTrue(any(item['key'] == 'dependency_directory' and item['status'] == 'missing' for item in result['checks']))

    def test_incomplete_bundle_write_is_retryable_without_overwriting_user_files(self):
        from frameweave.voice_environments import _atomic
        def fail_manifest(path, value):
            if path.name == 'bundle.json': raise OSError('disk full')
            return _atomic(path, value)
        with patch('frameweave.voice_environments._atomic', side_effect=fail_manifest):
            with self.assertRaises(OSError): self.register()
        self.assertEqual(list(self.manager.directory.iterdir()), [])
        self.assertEqual(len(self.register()['package']['fields']), 5)

    def test_package_or_registration_failure_leaves_no_invisible_environment(self):
        with patch.object(self.packages, 'save', side_effect=ValueError('package library full')):
            with self.assertRaises(ValueError): self.register()
        self.assertEqual(list(self.manager.directory.iterdir()), [])
        from frameweave.voice_environments import _atomic
        def fail_record(path, value):
            if path.name == 'registration.json': raise OSError('disk full')
            return _atomic(path, value)
        with patch('frameweave.voice_environments._atomic', side_effect=fail_record):
            with self.assertRaises(OSError): self.register()
        self.assertEqual(list(self.manager.directory.iterdir()), [])
        self.assertEqual(len(self.register()['package']['fields']), 5)

    def test_recheck_restores_saved_settings_and_does_not_rename_existing_engine(self):
        first = self.register()
        self.request['name'] = 'another display name'
        second = self.register()
        self.assertEqual(first['environment']['name'], second['environment']['name'])
        result = self.manager.recheck(first['engine']['id'])
        self.assertEqual(result['settings']['comfy_root'], str(self.comfy))
        self.assertTrue(result['configuration_unchanged'])

    def test_http_inspect_register_and_recheck_require_csrf_and_never_start_or_generate(self):
        from frameweave.server import App, make_server
        web = self.root / 'web'; web.mkdir(); (web / 'index.html').write_text('test')
        app = App(self.data, web, 'http://127.0.0.1:19999')
        server = make_server(app)
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        thread.start()
        def call(route, value=None, token=None):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            headers = {'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{server.server_port}'}
            if token: headers['X-FW-Token'] = token
            try:
                connection.request('GET' if value is None else 'POST', route, None if value is None else json.dumps(value), headers)
                response = connection.getresponse(); return response.status, json.loads(response.read())
            finally: connection.close()
        try:
            _, bootstrap = call('/api/bootstrap'); token = bootstrap['csrf']
            with patch('subprocess.Popen', side_effect=AssertionError('must not launch')):
                for route in ('inspect', 'register', 'recheck'):
                    self.assertEqual(call('/api/voice-environments/' + route, {})[0], 403)
                code, checked = call('/api/voice-environments/inspect', self.request, token)
                self.assertEqual(code, 200); self.assertTrue(checked['ready_to_register'])
                code, registered = call('/api/voice-environments/register', {**self.request, 'fingerprint': checked['fingerprint']}, token)
                self.assertEqual(code, 200)
                code, checked = call('/api/voice-environments/recheck', {'id': registered['engine']['id']}, token)
                self.assertEqual(code, 200); self.assertEqual(checked['settings'], self.request)
                code, listed = call('/api/voice-environments')
                self.assertEqual(code, 200); self.assertEqual(len(listed['environments']), 1)
                self.assertNotIn(str(self.model), json.dumps(listed))
                self.assertEqual(call('/api/jobs')[1]['jobs'], [])
                self.assertEqual(app.settings['backend_url'], 'http://127.0.0.1:19999')
        finally:
            app.closed.set(); server.shutdown(); server.server_close(); thread.join(2)

    def test_dispatch_rechecks_environment_identity_before_storage_or_submission(self):
        from frameweave.server import App
        self.register()
        web = self.root / 'web'; web.mkdir()
        app = App(self.data, web, self.engines._profiles[0]['base_url'])
        with patch.object(app.engines, '_probe_profile', return_value=(False, True)), patch.object(app.backend, 'request', side_effect=AssertionError('must not submit')):
            with self.assertRaisesRegex(ValueError, '身份不匹配'):
                app._dispatch({'prompt': {}}, 'api')
        self.assertEqual(app.jobs, {})
        self.assertFalse((self.data / 'runs').exists())


if __name__ == '__main__': unittest.main()
