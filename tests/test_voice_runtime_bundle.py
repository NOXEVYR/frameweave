"""Offline bundle acceptance: stdlib only, with no engine, model or GPU processes."""
from __future__ import annotations

import contextlib
import asyncio
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch
import wave

from frameweave.voice_runtime_bundle import runtime_files


class Progress:
    def __init__(self):
        self.values = []

    def update_absolute(self, value):
        self.values.append(value)


class FakeProcess:
    def __init__(self, on_write=None, returncode=0):
        self.stdin = io.BytesIO()
        self.pid = 12345
        self.returncode = returncode
        self.terminated = False
        self.killed = False
        self.wait_timeout = False
        if on_write is not None:
            self.stdin.write = on_write

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        if not self.wait_timeout:
            self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout):
        if self.wait_timeout and not self.killed:
            raise subprocess.TimeoutExpired('owned worker', timeout)
        return self.returncode


class VoiceRuntimeBundleTests(unittest.TestCase):
    def setUp(self):
        self.path_before = list(sys.path)
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), self.path_before))
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.files = runtime_files()
        for name, source in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(source, encoding='utf-8')
        for name in ('jobs', 'cache', 'temp', 'comfy', 'model', 'dependencies', 'frontend'):
            (self.root / name).mkdir()
        for name in ('host-python', 'worker-python'):
            (self.root / name).write_bytes(b'not executed')
        self.config = {
            'schema': 1, 'adapter': 'qwen3_tts_voice_design', 'environment_id': 'voice_test-1',
            'comfy_root': str(self.root / 'comfy'), 'host_python': str(self.root / 'host-python'),
            'worker_python': str(self.root / 'worker-python'), 'dependency_dir': '',
            'model_path': str(self.root / 'model'), 'device': 'cuda:0', 'dtype': 'bfloat16',
            'attention': 'sdpa', 'timeout_seconds': 600,
            'frontend_root': str(self.root / 'frontend'), 'port': 18188,
        }
        (self.root / 'config.json').write_text(json.dumps(self.config), encoding='utf-8')
        self.common = self.load('voice_common.py', 'voice_common')
        self.module_patch = patch.dict(sys.modules, {'voice_common': self.common})
        self.module_patch.start()
        self.addCleanup(self.module_patch.stop)
        self.worker = self.load('worker.py', 'voice_test_worker')
        self.node = self.load('base/custom_nodes/prismcanvas_voice/__init__.py', 'voice_test_node')
        self.launcher = self.load('launcher.py', 'voice_test_launcher')
        self.request = {'text': '测试声音', 'instruct': '自然清晰的普通话', 'language': 'Chinese',
                        'seed': 42, 'max_new_tokens': 128, 'job_id': 'a' * 32}

    def test_identity_handshake_has_only_current_environment_identity_and_no_generation(self):
        routes = {}
        server = types.SimpleNamespace(PromptServer=types.SimpleNamespace(instance=types.SimpleNamespace(
            routes=types.SimpleNamespace(get=lambda path: lambda handler: routes.setdefault(path, handler)))))
        web = types.SimpleNamespace(json_response=lambda data, **kw: data)
        with patch.dict(os.environ, {'PRISMCANVAS_VOICE_ENVIRONMENT': str(self.root)}), patch.dict(sys.modules, {'server': server, 'aiohttp': types.SimpleNamespace(web=web)}), patch('subprocess.Popen', side_effect=AssertionError('no process')):
            self.node.register_identity()
            identity = asyncio.run(routes['/prismcanvas/voice-identity'](None))
        self.assertEqual(identity, {'adapter': self.config['adapter'], 'environment_id': self.config['environment_id']})
        self.assertNotIn(str(self.root), json.dumps(identity))

    def load(self, filename, name):
        spec = importlib.util.spec_from_file_location(name, self.root / filename)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def make_result(self, job_id=None, samples=(0, 16384, -16384), rate=24000):
        job_id = job_id or self.request['job_id']
        job = self.root / 'jobs' / job_id
        job.mkdir(exist_ok=True)
        with wave.open(str(job / 'result.wav'), 'wb') as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(rate)
            output.writeframes(struct.pack('<' + 'h' * len(samples), *samples))
        proof, pcm = self.common.inspect_wav(job / 'result.wav')
        proof.update(status='completed', job_id=job_id, offline=True, rms=.3, peak=.5,
                     load_seconds=.1, generation_seconds=.2)
        self.common.atomic_json(job / 'result.json', proof)
        self.common.atomic_json(job / 'stage.json', {'stage': 'completed'})
        return job, proof, pcm

    def test_all_fixed_sources_compile_without_optional_imports(self):
        self.assertEqual(set(self.files), {'voice_common.py', 'launcher.py', 'worker.py',
                                         'base/custom_nodes/prismcanvas_voice/__init__.py'})
        for name, source in self.files.items():
            with self.subTest(name=name):
                compile(source, name, 'exec')
                self.assertNotIn(str(self.root), source)
                self.assertNotIn('F:/AI', source)
        self.assertEqual(self.files, runtime_files())
        self.files.clear()
        self.assertEqual(len(runtime_files()), 4)

    def test_config_requires_fixed_adapter_and_existing_absolute_sources(self):
        self.assertEqual(self.common.validate_config(self.config), self.config)
        self.common.validate_config(dict(self.config, dependency_dir=str(self.root / 'dependencies')))
        cases = [{'schema': True}, {'adapter': 'unknown'}, {'device': 'cpu'}, {'dtype': 'float32'},
                 {'attention': 'flash_attention_2'}, {'timeout_seconds': True}, {'timeout_seconds': 601},
                 {'port': True}, {'port': 1023}, {'port': 65536}, {'frontend_root': 'relative'},
                 {'environment_id': '../escape'}, {'dependency_dir': 'relative'},
                 {'model_path': str(self.root / 'missing')}, {'worker_python': str(self.root / 'model')}]
        for changes in cases:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.common.validate_config(dict(self.config, **changes))
        with self.assertRaises(ValueError):
            self.common.validate_config(dict(self.config, extra='ignored'))

    def test_request_boundary_rejects_types_traversal_lengths_and_languages(self):
        self.assertEqual(self.common.validate_request(self.request), self.request)
        self.common.validate_request(dict(self.request, text='界' * 2000, instruct='界' * 1000,
                                          language='English', seed=2**32 - 1, max_new_tokens=512))
        for changes in ({'text': ''}, {'text': '  '}, {'text': 'x' * 2001}, {'instruct': 'x' * 1001},
                        {'text': '\ud800'}, {'text': 'a\x00b'}, {'language': 'Auto'}, {'language': []},
                        {'seed': True}, {'seed': -1}, {'seed': 2**32}, {'max_new_tokens': 31},
                        {'max_new_tokens': 513}, {'max_new_tokens': 128.0}, {'job_id': '../other'},
                        {'job_id': 'A' * 32}, {'job_id': 'a' * 33}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.common.validate_request(dict(self.request, **changes))
        with self.assertRaises(ValueError):
            self.common.validate_request(dict(self.request, ignored=True))

    def test_worker_stdin_and_json_are_bounded_and_duplicates_rejected(self):
        raw = json.dumps(self.request).encode()
        stream = Mock()
        stream.read.return_value = raw
        self.assertEqual(self.worker.read_request(stream), self.request)
        stream.read.assert_called_once_with(16385)
        for raw in (b'x' * 16385, b'{"seed":1,"seed":2}', b'{"x":NaN}', b'\xff', b'[]'):
            with self.subTest(raw=raw[:40]), self.assertRaises(ValueError):
                self.worker.read_request(io.BytesIO(raw))

    def test_environment_is_a_copy_and_all_caches_stay_private(self):
        inherited = {'PYTHONPATH': 'untrusted', 'PYTHONHOME': 'foreign', 'KEEP': 'value',
                     'HF_HOME': 'old', 'HF_MODULES_CACHE': 'old', 'TEMP': 'old'}
        result = self.common.runtime_environment(self.root, inherited)
        self.assertEqual(inherited['HF_HOME'], 'old')
        self.assertEqual(result['KEEP'], 'value')
        self.assertNotIn('PYTHONPATH', result)
        self.assertNotIn('PYTHONHOME', result)
        for key in ('HF_HOME', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'HF_ASSETS_CACHE',
                    'HF_MODULES_CACHE', 'TRANSFORMERS_CACHE', 'TORCH_HOME', 'NUMBA_CACHE_DIR',
                    'CUDA_CACHE_PATH', 'TRITON_CACHE_DIR', 'TEMP', 'TMP'):
            self.assertTrue(Path(result[key]).is_relative_to(self.root))
        for key in ('HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_TELEMETRY',
                    'PYTHONDONTWRITEBYTECODE'):
            self.assertEqual(result[key], '1')

    def test_network_audit_has_offline_worker_and_loopback_host_policies(self):
        worker = self.common.network_guard()
        host = self.common.network_guard(loopback=True)
        worker('open', ('ordinary file',))
        for event, args in (('socket.connect', (None, ('127.0.0.1', 80))),
                            ('socket.sendto', (None, ('8.8.8.8', 53))),
                            ('socket.getaddrinfo', ('localhost', 80))):
            with self.assertRaises(OSError):
                worker(event, args)
        host('socket.connect', (None, ('127.0.0.1', 8188)))
        host('socket.connect', (None, ('::1', 8188)))
        host('socket.getaddrinfo', ('localhost', 8188))
        for event, args in (('socket.connect', (None, ('192.168.1.2', 80))),
                            ('socket.sendto', (None, ('8.8.8.8', 53))),
                            ('socket.getaddrinfo', ('huggingface.co', 443))):
            with self.assertRaises(OSError):
                host(event, args)

    def test_atomic_json_replaces_and_removes_temp_files(self):
        target = self.root / 'jobs' / 'status.json'
        self.common.atomic_json(target, {'stage': 'loading'})
        self.common.atomic_json(target, {'stage': 'generating'})
        self.assertEqual(self.common.read_json(target), {'stage': 'generating'})
        self.assertEqual(list(target.parent.glob('.*.tmp')), [])
        with patch.object(self.common.os, 'replace', side_effect=OSError('private path')):
            with self.assertRaises(OSError):
                self.common.atomic_json(target, {'stage': 'completed'})
        self.assertEqual(self.common.read_json(target), {'stage': 'generating'})
        self.assertEqual(list(target.parent.glob('.*.tmp')), [])

    def test_jobs_are_unique_and_traversal_is_rejected(self):
        job = self.common.job_directory(self.root, self.request['job_id'], create=True)
        self.assertEqual(job.parent, self.root / 'jobs')
        with self.assertRaises(FileExistsError):
            self.common.job_directory(self.root, self.request['job_id'], create=True)
        with self.assertRaises(ValueError):
            self.common.job_directory(self.root, '../escape', create=True)

    def test_wav_recomputes_hash_header_rate_and_sample_count(self):
        job, proof, pcm = self.make_result()
        metadata, actual = self.common.inspect_wav(job / 'result.wav', proof, self.request['job_id'])
        self.assertEqual(actual, pcm)
        self.assertEqual(metadata['samples'], 3)
        self.assertEqual(metadata['sample_rate'], 24000)
        for changes in ({'sha256': '0' * 64}, {'samples': 4}, {'samples': True}, {'sample_rate': 8000},
                        {'channels': 2}, {'sample_width': 4}, {'offline': False}, {'job_id': 'b' * 32},
                        {'status': 'failed'}, {'rms': math.nan}, {'peak': math.inf},
                        {'generation_seconds': -1}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.common.inspect_wav(job / 'result.wav', dict(proof, **changes), self.request['job_id'])
        path = job / 'result.wav'
        valid = path.read_bytes()
        for offset, replacement in ((0, b'RIFX'), (20, b'\x03\x00'), (22, b'\x02\x00'),
                                    (34, b'\x20\x00'), (40, struct.pack('<I', 500))):
            path.write_bytes(valid[:offset] + replacement + valid[offset + len(replacement):])
            with self.subTest(offset=offset), self.assertRaises(ValueError):
                self.common.inspect_wav(path)
        path.write_bytes(valid + b'extra')
        with self.assertRaises(ValueError):
            self.common.inspect_wav(path)

    def test_wav_size_bound_precedes_read(self):
        path = Mock()
        path.stat.return_value.st_size = self.common.MAX_WAV_BYTES + 1
        with patch.object(self.common, 'no_link', return_value=path):
            with self.assertRaises(ValueError):
                self.common.inspect_wav(path)
        path.open.assert_not_called()

    def test_worker_audio_rejects_invalid_rate_shape_empty_and_nonfinite(self):
        np = Mock()
        np.float32 = 'float32'
        for audio in (types.SimpleNamespace(ndim=2, size=3), types.SimpleNamespace(ndim=1, size=0),
                      types.SimpleNamespace(ndim=1, size=self.common.MAX_WAV_BYTES)):
            np.asarray.return_value = audio
            with self.assertRaises(ValueError):
                self.worker.write_audio(self.root, [], 24000, np)
        np.asarray.return_value = types.SimpleNamespace(ndim=1, size=3)
        np.isfinite.return_value.all.return_value = False
        with self.assertRaises(ValueError):
            self.worker.write_audio(self.root, [math.nan], 24000, np)
        with self.assertRaises(ValueError):
            self.worker.write_audio(self.root, [], True, np)

    def test_launcher_enforces_owned_directories_loopback_and_cpu(self):
        args = self.launcher.launch_arguments(self.root, ['--port', '18188', '--listen', '127.0.0.1'])
        self.assertIn('--cpu', args)
        self.assertEqual(args[args.index('--base-directory') + 1], str(self.root / 'base'))
        self.assertEqual(args[args.index('--front-end-root') + 1], self.config['frontend_root'])
        self.assertEqual(args[args.index('--port') + 1], str(self.config['port']))
        for supplied in (['--listen', '0.0.0.0'], ['--gpu-only'], ['--extra-model-paths-config', 'x'],
                         ['--base-directory', str(self.root / 'comfy')], ['--listen=0.0.0.0'],
                         ['--front-end-root', str(self.root / 'comfy')], ['--port', '8192'],
                         ['--database-url', 'sqlite:///' + (self.root / 'foreign.db').as_posix()]):
            with self.subTest(supplied=supplied), self.assertRaises(ValueError):
                self.launcher.launch_arguments(self.root, supplied)

    def test_real_preparer_output_obeys_runtime_config_and_launcher_contract(self):
        # Exercise the real preparation boundary, with files that must never be imported.
        from frameweave.engines import EngineManager
        from frameweave.packages import PackageStore
        from frameweave.voice_environments import VoiceEnvironments, validate_start

        comfy = Path(self.config['comfy_root'])
        (comfy / 'comfy').mkdir()
        (comfy / 'main.py').write_text("raise RuntimeError('must not execute')", encoding='utf-8')
        dependencies = self.root / 'dependencies'
        for name in ('qwen_tts', 'torch', 'transformers', 'numpy'):
            (dependencies / name).mkdir()
            (dependencies / name / '__init__.py').write_text("raise RuntimeError('must not import')", encoding='utf-8')
        (dependencies / 'soundfile.py').write_text("raise RuntimeError('must not import')", encoding='utf-8')
        (self.root / 'frontend' / 'index.html').write_text('fixture', encoding='utf-8')
        model = Path(self.config['model_path'])
        (model / 'config.json').write_text(json.dumps({'model_type': 'qwen3_tts', 'tts_model_type': 'voice_design'}), encoding='utf-8')
        for name in ('model.safetensors', 'tokenizer_config.json', 'vocab.json', 'merges.txt',
                     'speech_tokenizer/config.json', 'speech_tokenizer/model.safetensors'):
            path = model / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'fixture only')
        data_dir = self.root / 'prepared-data'
        with patch('subprocess.Popen', side_effect=AssertionError('no real processes')), \
                patch.object(EngineManager, '_probe_comfy', return_value=False):
            engines = EngineManager(data_dir)
            packages = PackageStore(data_dir / 'workflow-packages')
            manager = VoiceEnvironments(data_dir, engines, packages)
            request = {key: self.config[key] for key in ('comfy_root', 'host_python', 'worker_python',
                                                       'model_path', 'frontend_root', 'port')}
            request['dependency_dir'] = str(dependencies)
            inspected = manager.inspect(request)
            self.assertTrue(inspected['ready_to_register'], inspected['checks'])
            prepared = manager.prepare(dict(request, fingerprint=inspected['fingerprint']))
            profile = engines._profiles[0]
            self.assertEqual(profile['id'], prepared['engine']['id'])
            self.assertIsNone(validate_start(profile))
            environment = Path(profile['main_script']).parent
            emitted_common = self.load_relative(environment / 'voice_common.py', 'prepared_voice_common')
            emitted_launcher = self.load_relative(environment / 'launcher.py', 'prepared_voice_launcher',
                                                 common=emitted_common)
            emitted_config = emitted_common.validate_config(emitted_common.read_json(environment / 'config.json'))
            args = emitted_launcher.launch_arguments(environment, profile['arguments'], emitted_config)
            observed = {}

            def launch_entry(path, *, run_name):
                observed.update(path=path, run_name=run_name, arguments=list(sys.argv[1:]),
                                root=os.environ['PRISMCANVAS_VOICE_ENVIRONMENT'],
                                offline=os.environ['HF_HUB_OFFLINE'], comfy_import_root=sys.path[0])

            with patch.object(emitted_launcher.runpy, 'run_path', side_effect=launch_entry) as run_path, \
                    patch.object(sys, 'argv', [profile['main_script'], *profile['arguments']]), \
                    patch.object(sys, 'path', list(sys.path)), patch.object(sys, 'addaudithook'), \
                    patch.object(sys, 'dont_write_bytecode', False), patch.dict(os.environ, dict(os.environ)):
                emitted_launcher.main()
            run_path.assert_called_once_with(str(environment / 'base/main.py'), run_name='__main__')
            self.assertEqual(observed['arguments'], args)
            self.assertEqual(observed['root'], str(environment))
            self.assertEqual(observed['offline'], '1')
            self.assertEqual(observed['comfy_import_root'], emitted_config['comfy_root'])
        for flag in ('--base-directory', '--models-directory', '--user-directory', '--input-directory',
                     '--output-directory', '--temp-directory', '--database-url', '--front-end-root', '--port'):
            self.assertEqual(args.count(flag), 1)
            self.assertEqual(args[args.index(flag) + 1], profile['arguments'][profile['arguments'].index(flag) + 1])
        for flag in ('--cpu', '--disable-dynamic-vram', '--disable-api-nodes', '--disable-auto-launch', '--cache-none'):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index('--front-end-root') + 1], emitted_config['frontend_root'])
        self.assertEqual((environment / 'base/main.py').read_bytes(), (comfy / 'main.py').read_bytes())

    def load_relative(self, path, name, common=None):
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        if common is None:
            spec.loader.exec_module(module)
        else:
            with patch.dict(sys.modules, {'voice_common': common}):
                spec.loader.exec_module(module)
        return module

    def test_plugin_loads_only_its_explicit_environment(self):
        with patch.dict(os.environ, {'PRISMCANVAS_VOICE_ENVIRONMENT': str(self.root)}):
            root, config, common = self.node.load_runtime()
        self.assertEqual(root, self.root)
        self.assertEqual(config, self.config)
        self.assertEqual(common.MAX_REQUEST_BYTES, 16384)
        for value in ('', 'relative', str(self.root / 'comfy')):
            with patch.dict(os.environ, {'PRISMCANVAS_VOICE_ENVIRONMENT': value}), self.assertRaises(ValueError):
                self.node.load_runtime()

    def test_mock_supervisor_uses_config_python_no_shell_and_verified_pcm(self):
        progress = Progress()
        process = FakeProcess(returncode=None)

        def send(raw):
            request = json.loads(raw)
            self.assertEqual(request, self.request)
            self.make_result()
            process.returncode = 0
            return len(raw)

        process.stdin.write = send
        with patch.object(self.node.subprocess, 'Popen', return_value=process) as popen:
            metadata, pcm = self.node.supervise_worker(self.root, self.config, self.common,
                                                     self.request, progress, lambda: None)
        self.assertEqual(metadata['samples'], 3)
        self.assertEqual(len(pcm), 6)
        argv = popen.call_args.args[0]
        self.assertEqual(argv, [self.config['worker_python'], '-B', '-s', str(self.root / 'worker.py')])
        self.assertFalse(popen.call_args.kwargs['shell'])
        self.assertEqual(popen.call_args.kwargs['env']['HF_HUB_OFFLINE'], '1')
        self.assertFalse(process.terminated)
        self.assertNotIn(3, progress.values)
        self.assertTrue((self.root / 'jobs' / self.request['job_id'] / 'exit.json').is_file())

    def test_worker_failure_is_redacted_and_never_retried(self):
        private = 'secret prompt and private path'
        with patch.object(self.node.subprocess, 'Popen', side_effect=OSError(private)) as popen:
            with self.assertRaises(RuntimeError) as caught:
                self.node.supervise_worker(self.root, self.config, self.common, self.request, Progress(), lambda: None)
        self.assertNotIn(private, str(caught.exception))
        self.assertEqual(popen.call_count, 1)
        log = self.root / 'jobs' / self.request['job_id'] / 'worker.log'
        self.assertIn(private, log.read_text(encoding='utf-8'))

    def test_cancel_stops_only_owned_worker_and_preserves_interrupt(self):
        class Cancelled(Exception):
            pass
        interrupted = Mock(side_effect=[None, Cancelled('')])
        process = FakeProcess(returncode=None)
        with patch.object(self.node.subprocess, 'Popen', return_value=process):
            with self.assertRaises(Cancelled):
                self.node.supervise_worker(self.root, self.config, self.common, self.request, Progress(), interrupted)
        self.assertTrue(process.terminated)
        self.assertFalse(process.killed)

    def test_cancel_before_spawn_creates_no_process(self):
        class Cancelled(Exception):
            pass
        with patch.object(self.node.subprocess, 'Popen') as popen:
            with self.assertRaises(Cancelled):
                self.node.supervise_worker(self.root, self.config, self.common, self.request, Progress(),
                                            Mock(side_effect=Cancelled()))
        popen.assert_not_called()

    def test_timeout_terminates_then_kills_unresponsive_owned_worker(self):
        process = FakeProcess(returncode=None)
        process.wait_timeout = True
        with patch.object(self.node.subprocess, 'Popen', return_value=process), \
                patch.object(self.node.time, 'monotonic', side_effect=[0, 601, 602]):
            with self.assertRaises(RuntimeError):
                self.node.supervise_worker(self.root, self.config, self.common, self.request, Progress(), lambda: None)
        self.assertTrue(process.terminated)
        self.assertTrue(process.killed)

    def test_cancel_remains_available_while_stdin_write_is_blocked(self):
        class Cancelled(Exception):
            pass
        released = threading.Event()
        wrote = threading.Event()
        process = FakeProcess(returncode=None)

        def blocked(raw):
            wrote.set()
            if not released.wait(timeout=2):
                raise RuntimeError('mock stdin did not unblock')
            return len(raw)

        process.stdin.write = blocked
        original = process.terminate

        def terminate():
            original()
            released.set()

        process.terminate = terminate
        calls = 0

        def interrupted():
            nonlocal calls
            calls += 1
            if calls > 1:
                self.assertTrue(wrote.wait(timeout=1))
                raise Cancelled()

        with patch.object(self.node.subprocess, 'Popen', return_value=process):
            with self.assertRaises(Cancelled):
                self.node.supervise_worker(self.root, self.config, self.common, self.request, Progress(), interrupted)
        self.assertTrue(released.is_set())
        self.assertTrue(process.stdin.closed)

    def test_forged_worker_result_never_marks_progress_completed(self):
        progress = Progress()
        process = FakeProcess(returncode=None)

        def send(raw):
            job, proof, pcm = self.make_result()
            proof['sha256'] = '0' * 64
            self.common.atomic_json(job / 'result.json', proof)
            process.returncode = 0
            return len(raw)

        process.stdin.write = send
        with patch.object(self.node.subprocess, 'Popen', return_value=process):
            with self.assertRaises(RuntimeError):
                self.node.supervise_worker(self.root, self.config, self.common, self.request, progress, lambda: None)
        self.assertNotIn(3, progress.values)

    def test_nonzero_worker_exit_is_failed_even_with_valid_pcm(self):
        process = FakeProcess(returncode=None)

        def send(raw):
            self.make_result()
            process.returncode = 1
            return len(raw)

        process.stdin.write = send
        with patch.object(self.node.subprocess, 'Popen', return_value=process):
            with self.assertRaises(RuntimeError):
                self.node.supervise_worker(self.root, self.config, self.common, self.request, Progress(), lambda: None)

    def test_audio_node_returns_cpu_float_tensor_with_batch_channel_sample_shape(self):
        class Tensor:
            def __init__(self, pcm):
                self.values = list(struct.unpack('<' + 'h' * (len(pcm) // 2), pcm))

            def to(self, *, device, dtype):
                self.device, self.dtype = device, dtype
                return self

            def div_(self, amount):
                self.values = [value / amount for value in self.values]
                return self

            def reshape(self, *shape):
                self.shape = shape
                return self

        job, proof, pcm = self.make_result()
        metadata, unused = self.common.inspect_wav(job / 'result.wav', proof, self.request['job_id'])
        tensor = Tensor(pcm)
        finite = Mock()
        finite.all.return_value.item.return_value = True
        torch = types.SimpleNamespace(frombuffer=Mock(return_value=tensor), int16='int16',
                                     float32='float32', isfinite=Mock(return_value=finite))
        progress = Progress()
        modules = {'torch': torch, 'comfy': types.ModuleType('comfy'),
                   'comfy.model_management': types.SimpleNamespace(throw_exception_if_processing_interrupted=Mock()),
                   'comfy.utils': types.SimpleNamespace(ProgressBar=Mock(return_value=progress))}
        with patch.dict(sys.modules, modules), \
                patch.dict(os.environ, {'PRISMCANVAS_VOICE_ENVIRONMENT': str(self.root)}), \
                patch.object(self.node, 'supervise_worker', return_value=(metadata, pcm)):
            audio, = self.node.PrismCanvasQwenVoiceDesign().generate('文字', '声音', 'Chinese', 0, 32)
        self.assertIs(audio['waveform'], tensor)
        self.assertEqual(tensor.shape, (1, 1, 3))
        self.assertEqual(tensor.device, 'cpu')
        self.assertEqual(tensor.dtype, 'float32')
        self.assertEqual(tensor.values, [0, .5, -.5])
        self.assertEqual(audio['sample_rate'], 24000)
        self.assertEqual(progress.values, [0, 3])
        self.assertIn('PrismCanvasQwenVoiceDesign', self.node.NODE_CLASS_MAPPINGS)

    def test_mock_worker_loads_local_model_and_publishes_actual_stages(self):
        self.common.job_directory(self.root, self.request['job_id'], create=True)
        torch = types.SimpleNamespace(manual_seed=Mock(), bfloat16='bfloat16',
            cuda=types.SimpleNamespace(manual_seed_all=Mock(), synchronize=Mock()),
            inference_mode=contextlib.nullcontext)
        model = Mock()
        model.generate_voice_design.return_value = ([['fake wave']], 24000)
        model_class = Mock()
        model_class.from_pretrained.return_value = model
        stages = []
        original = self.common.atomic_json

        def atomic(path, data):
            if path.name == 'stage.json':
                stages.append(data)
            return original(path, data)

        def output(job, audio, rate, np):
            self.assertEqual(audio, ['fake wave'])
            unused, proof, pcm = self.make_result()
            return {key: proof[key] for key in ('sha256', 'samples', 'sample_rate', 'channels',
                                                'sample_width', 'rms', 'peak')}

        modules = {'torch': torch, 'numpy': types.SimpleNamespace(),
                   'qwen_tts': types.SimpleNamespace(Qwen3TTSModel=model_class)}
        with patch.dict(sys.modules, modules), patch.dict(os.environ, dict(os.environ)), \
                patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(json.dumps(self.request).encode()))), \
                patch.object(sys, 'addaudithook') as audit, patch.object(sys, 'dont_write_bytecode', False), \
                patch.object(self.worker, 'write_audio', side_effect=output), \
                patch.object(self.worker, 'atomic_json', side_effect=atomic):
            self.assertEqual(self.worker.main(), 0)
        audit.assert_called_once()
        self.assertEqual(stages, [{'stage': 'loading'}, {'stage': 'generating'}, {'stage': 'completed'}])
        model_class.from_pretrained.assert_called_once_with(self.config['model_path'], device_map='cuda:0',
            dtype='bfloat16', attn_implementation='sdpa', local_files_only=True)
        model.generate_voice_design.assert_called_once_with(text=self.request['text'],
            instruct=self.request['instruct'], language='Chinese', max_new_tokens=128)
        torch.manual_seed.assert_called_once_with(42)
        proof = self.common.read_json(self.root / 'jobs' / self.request['job_id'] / 'result.json')
        self.assertEqual(proof['status'], 'completed')
        self.assertNotIn('text', proof)


if __name__ == '__main__':
    unittest.main()
