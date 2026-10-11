"""Fixed, relocatable sources for the product-owned offline VoiceDesign runtime.

No source discovery, installation or inference takes place when building this bundle.
The preparation service supplies config.json and copies ComfyUI's main.py into base/.
"""
from __future__ import annotations

from textwrap import dedent


_COMMON = r'''
"""Standard-library boundaries shared by the host and single-job worker."""
import hashlib
import ipaddress
import json
import math
import os
import re
import struct
import uuid
from pathlib import Path

MAX_REQUEST_BYTES = 16384
MAX_JSON_BYTES = 65536
MAX_WAV_BYTES = 64 * 1024 * 1024
REQUEST_KEYS = {'text', 'instruct', 'language', 'seed', 'max_new_tokens', 'job_id'}
CONFIG_KEYS = {'schema', 'adapter', 'environment_id', 'comfy_root', 'host_python',
               'worker_python', 'dependency_dir', 'model_path', 'device', 'dtype',
               'attention', 'timeout_seconds', 'frontend_root', 'port'}


def reject(message='隔离语音数据校验失败'):
    raise ValueError(message)


def no_link(path):
    path = Path(path)
    if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
        reject()
    return path


def json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result


def decode_json(raw, limit=MAX_JSON_BYTES):
    if not isinstance(raw, bytes) or not raw or len(raw) > limit:
        reject()
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=json_pairs,
                          parse_constant=lambda value: reject())
    except (UnicodeError, ValueError, RecursionError):
        reject()


def read_json(path, limit=MAX_JSON_BYTES):
    path = no_link(path)
    if not path.is_file():
        raise FileNotFoundError('隔离语音数据尚未就绪')
    with path.open('rb') as source:
        return decode_json(source.read(limit + 1), limit)


def atomic_json(path, data):
    path = no_link(path)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as target:
            json.dump(data, target, ensure_ascii=False, allow_nan=False)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_request(value):
    if not isinstance(value, dict) or set(value) != REQUEST_KEYS:
        reject()
    for key, limit in (('text', 2000), ('instruct', 1000)):
        text = value[key]
        if not isinstance(text, str) or not text.strip() or len(text) > limit or '\x00' in text:
            reject()
        try:
            text.encode('utf-8')
        except UnicodeError:
            reject()
    if value['language'] not in ('Chinese', 'English'):
        reject()
    if type(value['seed']) is not int or not 0 <= value['seed'] <= 2**32 - 1:
        reject()
    if type(value['max_new_tokens']) is not int or not 32 <= value['max_new_tokens'] <= 512:
        reject()
    if not isinstance(value['job_id'], str) or not re.fullmatch('[a-f0-9]{32}', value['job_id']):
        reject()
    raw = json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')
    if len(raw) > MAX_REQUEST_BYTES:
        reject()
    return dict(value)


def validate_config(value):
    if not isinstance(value, dict) or set(value) != CONFIG_KEYS:
        reject('隔离语音配置无效')
    if type(value['schema']) is not int or value['schema'] != 1:
        reject('隔离语音配置无效')
    for key, expected in (('adapter', 'qwen3_tts_voice_design'), ('device', 'cuda:0'),
                          ('dtype', 'bfloat16'), ('attention', 'sdpa')):
        if value[key] != expected:
            reject('隔离语音配置无效')
    if not isinstance(value['environment_id'], str) or not re.fullmatch(
            '[A-Za-z0-9_-]{1,128}', value['environment_id']):
        reject('隔离语音配置无效')
    if type(value['timeout_seconds']) is not int or not 1 <= value['timeout_seconds'] <= 600:
        reject('隔离语音配置无效')
    if type(value['port']) is not int or not 1024 <= value['port'] <= 65535:
        reject('隔离语音配置无效')
    for key in ('comfy_root', 'host_python', 'worker_python', 'dependency_dir', 'model_path', 'frontend_root'):
        raw = value[key]
        if key == 'dependency_dir' and raw == '':
            continue
        if not isinstance(raw, str) or not raw or '\x00' in raw:
            reject('隔离语音配置无效')
        path = Path(raw)
        if not path.is_absolute():
            reject('隔离语音配置无效')
        if not (path.is_file() if key.endswith('_python') else path.is_dir()):
            reject('隔离语音配置无效')
    return dict(value)


def runtime_environment(root, inherited):
    root = Path(root).resolve(strict=True)
    result = dict(inherited)
    for key in ('PYTHONPATH', 'PYTHONHOME'):
        result.pop(key, None)
    result.update({
        'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1', 'HF_DATASETS_OFFLINE': '1',
        'HF_HUB_DISABLE_TELEMETRY': '1', 'DO_NOT_TRACK': '1',
        'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
        'PRISMCANVAS_VOICE_ENVIRONMENT': str(root),
        'HF_HOME': str(root / 'cache' / 'huggingface'),
        'HF_HUB_CACHE': str(root / 'cache' / 'huggingface' / 'hub'),
        'HUGGINGFACE_HUB_CACHE': str(root / 'cache' / 'huggingface' / 'hub'),
        'HF_ASSETS_CACHE': str(root / 'cache' / 'huggingface' / 'assets'),
        'HF_MODULES_CACHE': str(root / 'cache' / 'huggingface' / 'modules'),
        'TRANSFORMERS_CACHE': str(root / 'cache' / 'huggingface' / 'hub'),
        'TORCH_HOME': str(root / 'cache' / 'torch'),
        'NUMBA_CACHE_DIR': str(root / 'cache' / 'numba'),
        'XDG_CACHE_HOME': str(root / 'cache'), 'CUDA_CACHE_PATH': str(root / 'cache' / 'cuda'),
        'TRITON_CACHE_DIR': str(root / 'cache' / 'triton'),
        'TEMP': str(root / 'temp'), 'TMP': str(root / 'temp'), 'TMPDIR': str(root / 'temp'),
    })
    return result


def network_guard(loopback=False):
    def audit(event, args):
        if event not in ('socket.connect', 'socket.sendto', 'socket.getaddrinfo'):
            return
        allowed = False
        if loopback:
            if event == 'socket.getaddrinfo':
                host = args[0]
                allowed = host in (None, 'localhost', '127.0.0.1', '::1')
            else:
                address = args[1]
                if isinstance(address, tuple) and address:
                    try:
                        allowed = ipaddress.ip_address(address[0]).is_loopback
                    except (TypeError, ValueError):
                        pass
        if not allowed:
            raise OSError('隔离语音运行环境禁止网络访问')
    return audit


def job_directory(root, job_id, create=False):
    if not isinstance(job_id, str) or not re.fullmatch('[a-f0-9]{32}', job_id):
        reject()
    root = Path(root).resolve(strict=True)
    jobs = no_link(root / 'jobs')
    if not jobs.is_dir() or jobs.resolve().parent != root:
        reject()
    job = no_link(jobs / job_id)
    if create:
        job.mkdir(exist_ok=False)
    if not job.is_dir() or job.resolve().parent != jobs.resolve():
        reject()
    return job


def inspect_wav(path, proof=None, job_id=None):
    path = no_link(path)
    size = path.stat().st_size
    if not 46 <= size <= MAX_WAV_BYTES:
        reject()
    with path.open('rb') as source:
        raw = source.read(MAX_WAV_BYTES + 1)
    if len(raw) != size:
        reject()
    try:
        riff, length, wave, fmt, fmt_size, encoding, channels, rate, byte_rate, align, bits, data, count = (
            struct.unpack('<4sI4s4sIHHIIHH4sI', raw[:44]))
    except struct.error:
        reject()
    if (riff != b'RIFF' or length != size - 8 or wave != b'WAVE' or fmt != b'fmt '
            or fmt_size != 16 or encoding != 1 or channels != 1 or bits != 16
            or not 8000 <= rate <= 192000 or byte_rate != rate * 2 or align != 2
            or data != b'data' or count != size - 44 or count % 2 or not count):
        reject()
    digest = hashlib.sha256(raw).hexdigest()
    samples = count // 2
    if proof is not None:
        if (not isinstance(proof, dict) or proof.get('status') != 'completed'
                or proof.get('job_id') != job_id or proof.get('offline') is not True
                or proof.get('sha256') != digest or type(proof.get('samples')) is not int
                or proof['samples'] != samples or type(proof.get('sample_rate')) is not int
                or proof['sample_rate'] != rate or type(proof.get('channels')) is not int
                or proof['channels'] != 1 or type(proof.get('sample_width')) is not int
                or proof['sample_width'] != 2):
            reject()
        for key in ('rms', 'peak', 'load_seconds', 'generation_seconds'):
            value = proof.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                reject()
    return {'sha256': digest, 'samples': samples, 'sample_rate': rate,
            'channels': 1, 'sample_width': 2}, raw[44:]
'''


_LAUNCHER = r'''
"""Own CPU ComfyUI launcher; all paths come from the adjacent private config."""
import os
import runpy
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_common import network_guard, no_link, read_json, runtime_environment, validate_config


def launch_arguments(root, arguments, config=None):
    root = Path(root).resolve(strict=True)
    config = validate_config(config if config is not None else read_json(root / 'config.json'))
    protected = {'--base-directory': str(root / 'base'), '--models-directory': str(root / 'base' / 'models'),
                 '--user-directory': str(root / 'user'), '--input-directory': str(root / 'input'),
                 '--output-directory': str(root / 'output'), '--temp-directory': str(root / 'temp'),
                 '--front-end-root': config['frontend_root']}
    protected_values = {'--database-url': 'sqlite:///' + (root / 'user' / 'comfyui.db').as_posix(),
                        '--port': str(config['port'])}
    result = []
    index = 0
    while index < len(arguments):
        arg = arguments[index]
        if not isinstance(arg, str) or '\x00' in arg or '=' in arg:
            raise ValueError('隔离语音启动参数无效')
        if arg in ('--gpu-only', '--extra-model-paths-config', '--enable-manager', '--auto-launch'):
            raise ValueError('隔离语音启动参数无效')
        if arg in protected:
            index += 1
            if index >= len(arguments) or Path(arguments[index]).resolve() != Path(protected[arg]).resolve():
                raise ValueError('隔离语音启动目录无效')
        elif arg in protected_values:
            index += 1
            if index >= len(arguments) or arguments[index] != protected_values[arg]:
                raise ValueError('隔离语音启动配置无效')
        elif arg == '--listen':
            index += 1
            if index >= len(arguments) or arguments[index] not in ('127.0.0.1', '::1'):
                raise ValueError('隔离语音仅支持本机连接')
            result.extend((arg, arguments[index]))
        else:
            result.append(arg)
        index += 1
    for arg, value in protected.items():
        result.extend((arg, value))
    for arg, value in protected_values.items():
        result.extend((arg, value))
    if '--cpu' not in result:
        result.append('--cpu')
    if '--listen' not in result:
        result.extend(('--listen', '127.0.0.1'))
    return result


def main():
    root = Path(__file__).resolve().parent
    config = validate_config(read_json(root / 'config.json'))
    environment = runtime_environment(root, os.environ)
    os.environ.clear()
    os.environ.update(environment)
    sys.dont_write_bytecode = True
    sys.addaudithook(network_guard(loopback=True))
    sys.path.insert(0, config['comfy_root'])
    entry = no_link(root / 'base' / 'main.py')
    sys.argv = [str(entry), *launch_arguments(root, sys.argv[1:], config)]
    runpy.run_path(str(entry), run_name='__main__')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('隔离语音引擎启动失败，请检查私有环境配置', file=sys.stderr)
        sys.exit(1)
'''


_WORKER = r'''
"""One bounded VoiceDesign request; imports model dependencies only in main()."""
import json
import os
import sys
import time
import traceback
import uuid
import wave
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from voice_common import (MAX_REQUEST_BYTES, MAX_WAV_BYTES, atomic_json, decode_json,
                          inspect_wav, job_directory, network_guard, read_json,
                          runtime_environment, validate_config, validate_request)


def read_request(stream):
    return validate_request(decode_json(stream.read(MAX_REQUEST_BYTES + 1), MAX_REQUEST_BYTES))


def write_audio(job, samples, rate, np):
    if type(rate) is not int or not 8000 <= rate <= 192000:
        raise ValueError('隔离语音采样率无效')
    audio = np.asarray(samples, dtype=np.float32)
    if (audio.ndim != 1 or not audio.size or audio.size > (MAX_WAV_BYTES - 44) // 2
            or not np.isfinite(audio).all()):
        raise ValueError('隔离语音音频无效')
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(audio.astype(np.float64)**2)))
    pcm = np.rint(np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
    temporary = job / ('.result.' + uuid.uuid4().hex + '.wav')
    try:
        with wave.open(str(temporary), 'wb') as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(rate)
            target.writeframes(pcm)
        proof, unused = inspect_wav(temporary)
        os.replace(temporary, job / 'result.wav')
    finally:
        temporary.unlink(missing_ok=True)
    return dict(proof, rms=rms, peak=peak)


def main():
    job = None
    request = None
    try:
        root = Path(__file__).resolve().parent
        config = validate_config(read_json(root / 'config.json'))
        environment = runtime_environment(root, os.environ)
        os.environ.clear()
        os.environ.update(environment)
        sys.dont_write_bytecode = True
        if config['dependency_dir']:
            sys.path.insert(0, config['dependency_dir'])
        sys.addaudithook(network_guard())
        request = read_request(sys.stdin.buffer)
        job = job_directory(root, request['job_id'])
        started = time.monotonic()
        atomic_json(job / 'stage.json', {'stage': 'loading'})
        import numpy as np
        import torch
        from qwen_tts import Qwen3TTSModel
        torch.manual_seed(request['seed'])
        torch.cuda.manual_seed_all(request['seed'])
        model = Qwen3TTSModel.from_pretrained(config['model_path'], device_map=config['device'],
            dtype=torch.bfloat16, attn_implementation=config['attention'], local_files_only=True)
        loaded = time.monotonic()
        atomic_json(job / 'stage.json', {'stage': 'generating'})
        with torch.inference_mode():
            waves, rate = model.generate_voice_design(**{key: request[key] for key in
                ('text', 'instruct', 'language', 'max_new_tokens')})
        torch.cuda.synchronize()
        if not isinstance(waves, (list, tuple)) or len(waves) != 1:
            raise ValueError('隔离语音输出无效')
        proof = write_audio(job, waves[0], rate, np)
        proof.update(status='completed', job_id=request['job_id'], offline=True,
                     load_seconds=loaded - started, generation_seconds=time.monotonic() - loaded)
        atomic_json(job / 'result.json', proof)
        atomic_json(job / 'stage.json', {'stage': 'completed'})
        return 0
    except Exception:
        if job is not None:
            try:
                with (job / 'worker.log').open('a', encoding='utf-8') as log:
                    traceback.print_exc(file=log)
                atomic_json(job / 'result.json', {'status': 'failed', 'code': 'worker_failed',
                                                 'job_id': request['job_id']})
            except Exception:
                pass
        print('隔离语音工作进程失败', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
'''


_NODE = r'''
"""CPU host node supervising only its own offline GPU worker."""
import importlib.util
import json
import os
import subprocess
import threading
import time
import traceback
import uuid
from pathlib import Path


def load_runtime():
    raw = os.environ.get('PRISMCANVAS_VOICE_ENVIRONMENT', '')
    if not raw or not Path(raw).is_absolute():
        raise ValueError('隔离语音环境尚未配置')
    root = Path(raw).resolve(strict=True)
    # Bind this node to its own runtime rather than a different inherited environment.
    if Path(__file__).resolve().parents[3] != root:
        raise ValueError('隔离语音环境身份不匹配')
    helper = root / 'voice_common.py'
    if helper.is_symlink() or not helper.is_file():
        raise ValueError('隔离语音环境不完整')
    spec = importlib.util.spec_from_file_location('_prismcanvas_voice_common', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    config = module.validate_config(module.read_json(root / 'config.json'))
    return root, config, module


def stop_worker(process):
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def supervise_worker(root, config, common, request, progress, interrupted):
    job = None
    process = None
    sender = None
    send_errors = []
    started = time.monotonic()
    cancelled = False
    last_stage = None
    try:
        request = common.validate_request(request)
        raw = json.dumps(request, ensure_ascii=False, allow_nan=False).encode('utf-8')
        job = common.job_directory(root, request['job_id'], create=True)
        with (job / 'worker.log').open('ab') as log:
            try:
                interrupted()
            except Exception:
                cancelled = True
                raise
            process = subprocess.Popen([config['worker_python'], '-B', '-s', str(root / 'worker.py')],
                stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, cwd=str(root),
                env=common.runtime_environment(root, os.environ), shell=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            common.atomic_json(job / 'process.json', {'pid': process.pid})
            def send_request():
                try:
                    process.stdin.write(raw)
                    process.stdin.close()
                except Exception as error:
                    send_errors.append(error)
            # A pipe write can block if a child stalls before reading stdin. Keep cancellation
            # and the deadline in the supervisor thread, including that initial write.
            sender = threading.Thread(target=send_request, daemon=True)
            sender.start()
            while True:
                try:
                    interrupted()
                except Exception:
                    cancelled = True
                    raise
                if time.monotonic() - started > config['timeout_seconds']:
                    raise TimeoutError('隔离语音任务超时')
                try:
                    value = common.read_json(job / 'stage.json', 1024)
                    current = value.get('stage') if isinstance(value, dict) else None
                except FileNotFoundError:
                    current = None
                stages = {'loading': 1, 'generating': 2, 'completed': 3}
                if current in stages and (last_stage is None or stages[current] > stages[last_stage]):
                    # Completed is reported only after exit and independent PCM verification.
                    if current != 'completed':
                        progress.update_absolute(stages[current])
                    last_stage = current
                if process.poll() is not None:
                    break
                time.sleep(.1)
            if send_errors or process.returncode != 0:
                raise RuntimeError('隔离语音工作进程失败')
            proof = common.read_json(job / 'result.json')
            metadata, pcm = common.inspect_wav(job / 'result.wav', proof, request['job_id'])
            return metadata, pcm
    except Exception:
        try:
            if job is not None:
                with (job / 'worker.log').open('a', encoding='utf-8') as log:
                    traceback.print_exc(file=log)
        except OSError:
            pass
        if cancelled:
            raise
        raise RuntimeError('隔离语音任务失败或超时，详情保存在本任务私有日志；未重试') from None
    finally:
        try:
            stop_worker(process)
            if sender is not None:
                sender.join(timeout=1)
            if process is not None and process.stdin is not None and not process.stdin.closed:
                process.stdin.close()
            if job is not None:
                common.atomic_json(job / 'exit.json', {'worker_exit': process.returncode if process else None,
                                   'elapsed_seconds': max(0, time.monotonic() - started)})
        except Exception:
            if job is not None:
                try:
                    with (job / 'worker.log').open('a', encoding='utf-8') as log:
                        traceback.print_exc(file=log)
                except OSError:
                    pass
            if not cancelled:
                raise RuntimeError('隔离语音任务清理失败，请检查本任务私有日志') from None


class PrismCanvasQwenVoiceDesign:
    @classmethod
    def INPUT_TYPES(cls):
        return {'required': {
            'text': ('STRING', {'default': '', 'multiline': True}),
            'instruct': ('STRING', {'default': '', 'multiline': True}),
            'language': (['Chinese', 'English'], {'default': 'Chinese'}),
            'seed': ('INT', {'default': 42, 'min': 0, 'max': 2**32 - 1}),
            'max_new_tokens': ('INT', {'default': 128, 'min': 32, 'max': 512})}}

    RETURN_TYPES = ('AUDIO',)
    RETURN_NAMES = ('audio',)
    FUNCTION = 'generate'
    CATEGORY = 'PrismCanvas/Audio'

    def generate(self, text, instruct, language, seed, max_new_tokens):
        # Comfy and tensor libraries are host dependencies, never imported by template inspection.
        try:
            from comfy.model_management import throw_exception_if_processing_interrupted
            from comfy.utils import ProgressBar
            import torch
            root, config, common = load_runtime()
            request = {'text': text, 'instruct': instruct, 'language': language, 'seed': seed,
                       'max_new_tokens': max_new_tokens, 'job_id': uuid.uuid4().hex}
            common.validate_request(request)
        except Exception:
            raise RuntimeError('隔离语音环境或请求无效，请检查配置和输入') from None
        progress = ProgressBar(3)
        progress.update_absolute(0)
        metadata, pcm = supervise_worker(root, config, common, request, progress,
                                        throw_exception_if_processing_interrupted)
        throw_exception_if_processing_interrupted()
        try:
            waveform = torch.frombuffer(bytearray(pcm), dtype=torch.int16).to(
                device='cpu', dtype=torch.float32).div_(32768).reshape(1, 1, metadata['samples'])
            if not torch.isfinite(waveform).all().item():
                raise ValueError('隔离语音音频无效')
        except Exception:
            raise RuntimeError('隔离语音音频校验失败') from None
        progress.update_absolute(3)
        return ({'waveform': waveform, 'sample_rate': metadata['sample_rate']},)


NODE_CLASS_MAPPINGS = {'PrismCanvasQwenVoiceDesign': PrismCanvasQwenVoiceDesign}
NODE_DISPLAY_NAME_MAPPINGS = {'PrismCanvasQwenVoiceDesign': 'Qwen3-TTS · 声音设计'}


def register_identity():
    # Node discovery does not load model dependencies. This bounded, local
    # handshake distinguishes this registered environment from another Comfy.
    if not os.environ.get('PRISMCANVAS_VOICE_ENVIRONMENT'):
        return
    from aiohttp import web
    from server import PromptServer
    _, config, _ = load_runtime()
    identity = {key: config[key] for key in ('adapter', 'environment_id')}
    async def identify(request):
        return web.json_response(identity, headers={'Cache-Control': 'no-store'})
    PromptServer.instance.routes.get('/prismcanvas/voice-identity')(identify)


register_identity()
'''


def runtime_files() -> dict[str, str]:
    """Return versionable constants; callers materialize under one private environment."""
    return {name: dedent(source).lstrip() for name, source in {
        'voice_common.py': _COMMON,
        'launcher.py': _LAUNCHER,
        'worker.py': _WORKER,
        'base/custom_nodes/prismcanvas_voice/__init__.py': _NODE,
    }.items()}
