"""Loopback service, job ownership and static UI for FrameWeave."""

import base64
import binascii
import copy
import hmac
import http.client
import json
import logging
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import __version__
from .automation import (PROTOCOL_VERSIONS, SubmissionRejected, dispatch as dispatch_mcp,
                         generate as guarded_generate, request_status, _read_ledger, _ledger_lock)
from .backend import Backend, BackendError, local_url
from .diagnostics import diagnose, safe_relative
from .environment import discover_environment
from .engines import EngineManager
from .updates import UpdateManager, UpdateError
from .canvas_store import CanvasStore
from .editor_workflows import EditorWorkflowStore, _parse_document as parse_editor_document
from .editor_proxy import EditorProxy
from .editor_interfaces import inspect_interface, reconcile_interface, select_outputs
from .editor_backends import inspect_backend_fit
from .workspace_services import PROFILES, performance_plan, result_location
from .packages import (PackageStore, apply_values, inspect_document,
                       normalize_document, transport_document)
from .workflows import capabilities, catalog, compile_workflow, generation_options, validate_prompt

MAX_JSON = 28 * 1024 * 1024
MAX_REJECT_DRAIN = 64 * 1024
REJECT_DRAIN_TIMEOUT = 0.25
TERMINAL = {"completed", "failed", "cancelled"}
MAX_RUN = 4 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
REQUEST_FIELDS = {"kind", "positive", "negative", "models", "seed", "width", "height",
                  "steps", "cfg", "denoise", "sampler", "scheduler", "seconds", "fps",
                  "references", "reference_roles", "lora", "lora_strength", "loras", "shift_video", "editor_backend",
                  "shift_audio", "ref_image_size", "custom_size", "ref_resolution", "refine", "package_id", "values", "output_nodes"}


class SubmissionUncertain(BackendError):
    """The backend may have accepted the prompt; never repeat automatically."""


def atomic_json(path, value):
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


class App:
    def __init__(self, data_dir, web_dir, backend_url=None, roots=None, comfy_roots=None):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.web_dir = Path(web_dir).resolve()
        self.csrf = secrets.token_urlsafe(32)
        self.client_id = "frameweave-" + uuid.uuid4().hex
        self.lock = threading.RLock()
        self.closed = threading.Event()
        self.last_seen = time.monotonic()
        self.settings = {"backend_url": "http://127.0.0.1:8188", "model_roots": [], "comfy_roots": []}
        try:
            saved = json.loads((self.data_dir / "settings.json").read_text(encoding="utf-8"))
            self.settings["backend_url"] = local_url(saved["backend_url"])
            self.settings["model_roots"] = self.validate_roots(saved.get("model_roots", []))
            self.settings["comfy_roots"] = self.validate_roots(saved.get("comfy_roots", []))
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            pass
        if backend_url:
            self.settings["backend_url"] = local_url(backend_url)
        if roots:
            self.settings["model_roots"] = self.validate_roots(roots)
        if comfy_roots:
            self.settings["comfy_roots"] = self.validate_roots(comfy_roots)
        self.backend = Backend(self.settings["backend_url"])
        self.engines = EngineManager(self.data_dir)
        saved_options = locals().get("saved", {})
        self.settings["auto_start_engine"] = isinstance(saved_options, dict) and saved_options.get("auto_start_engine") is True
        self.settings["auto_update"] = isinstance(saved_options, dict) and saved_options.get("auto_update") is True
        self.settings["performance_profile"] = saved_options.get("performance_profile", "auto") if isinstance(saved_options, dict) else "auto"
        if self.settings["performance_profile"] not in PROFILES:
            self.settings["performance_profile"] = "auto"
        self.updates = UpdateManager(__version__, self.data_dir, auto_check=self.settings["auto_update"])
        self.update_lock = threading.Lock()
        self.update_busy = False
        self.update_error = ""
        self.exit_pending = False
        self.listen_port = None
        self.info = {}
        self.info_at = 0
        self.jobs = {}
        self.media = {}
        self.uploaded = set()
        self.packages = PackageStore(self.data_dir / "workflow-packages")
        self.canvases = CanvasStore(self.data_dir / "canvases")
        self.editor_workflows = EditorWorkflowStore(self.data_dir / "editor-workflows")
        self.editor_sessions = {}
        threading.Thread(target=self._close_editors_on_exit, daemon=True).start()
        self.environment_lock = threading.Lock()
        self.environment_snapshot = None
        self.environment_at = 0
        try:
            old = json.loads((self.data_dir / "jobs.json").read_text(encoding="utf-8"))
            for job in old[-200:]:
                if isinstance(job, dict) and re.fullmatch(r"[\w-]{1,100}", job.get("id", "")):
                    self.jobs[job["id"]] = job
                    if job.get("backend") != self.backend.url and job.get("status") not in TERMINAL:
                        job["status"], job["error"] = "failed", "后端地址已变化；请在原后端检查任务"
                    for output in job.get("outputs", []):
                        self.register_media(output["filename"], output.get("subfolder", ""), "output", job.get("backend"))
        except (OSError, ValueError, KeyError, TypeError, RecursionError):
            self.jobs = {}

        if self.settings["auto_start_engine"]:
            threading.Thread(target=self.start_saved_engine, daemon=True).start()
        if self.settings["auto_update"]:
            self.begin_update("auto")

    def _close_editors_on_exit(self):
        self.closed.wait()
        with self.lock:
            sessions, self.editor_sessions = self.editor_sessions, {}
        for session in sessions.values():
            session['proxy'].close()

    def editor_session(self, workflow_id, parent_origin):
        self.editor_workflows.get(workflow_id)
        with self.lock:
            if len(self.editor_sessions) >= 4:
                raise ValueError('请先关闭已有的内部工作流编辑器')
            backend = self.backend.url
            proxy = EditorProxy(backend, parent_origin,
                                (self.web_dir / 'native-editor-bridge.js').read_text(encoding='utf-8'))
            session_id = secrets.token_hex(16)
            result = proxy.start()
            self.editor_sessions[session_id] = {'proxy': proxy, 'backend': backend, 'workflow_id': workflow_id}
        return {**result, 'session_id': session_id, 'backend_url': backend}

    def editor_backends(self, workflow_id):
        document = self.editor_workflows.get(workflow_id)['document']
        current = self.backend.url
        profiles = self.engines.registered_endpoints()
        choices = {current: {'base_url': current, 'name': '当前引擎'}}
        for profile in profiles:
            choices[profile['base_url']] = {'base_url': profile['base_url'], 'name': profile['name']}
        def inspect(item):
            try:
                backend = Backend(item['base_url'])
                info = backend.request('/object_info', timeout=3)
                extensions = backend.request('/extensions', timeout=3)
                return {**item, 'online': True, **inspect_backend_fit(document, info, extensions)}
            except (BackendError, ValueError) as exc:
                return {**item, 'online': False, 'error': str(exc), 'score': -1}
        with ThreadPoolExecutor(max_workers=8) as pool:
            candidates = list(pool.map(inspect, choices.values()))
        return {'current': current, 'candidates': candidates}

    def editor_interface(self, workflow_id, data):
        self.editor_workflows.get(workflow_id)
        prompt = data.get('prompt')
        if prompt is None:
            prompt = self._editor_package_prompt(data)
        return inspect_interface(prompt, self.object_info(refresh=True))

    def _editor_package_prompt(self, data):
        package = self.packages.get(data.get('package_id'))
        baseline = data.get('previous_baseline')
        return apply_values(package, baseline if isinstance(baseline, dict) and baseline else data.get('values', {}))

    def apply_editor(self, workflow_id, data, configure=False):
        with self.lock:
            if configure:
                if data.get('backend_url') != self.backend.url:
                    raise ValueError('请切换到该工作流的原推理后端后配置参数')
                prompt = self._editor_package_prompt(data)
            else:
                session = self.editor_sessions.get(data.get('session_id'))
                if not session or session['workflow_id'] != workflow_id:
                    raise ValueError('编辑会话已失效，请重新进入工作流')
                if session['backend'] != self.backend.url:
                    raise ValueError('编辑期间推理后端已变化，请重新进入工作流')
                prompt = data.get('prompt')
            info = self.object_info(refresh=True)
            validate_prompt(prompt, info)
            interface = inspect_interface(prompt, info)
            candidates = {field['id']: field for field in interface['fields']}
            requested = data.get('fields')
            if requested is None:
                requested = [field for field in interface['fields'] if field.get('recommended') or field['type'] in {'image', 'audio'}][:64]
            if not isinstance(requested, list) or len(requested) > 64:
                raise ValueError('外层最多开放 64 个参数')
            fields = []
            for selection in requested:
                candidate = candidates.get(selection.get('id')) if isinstance(selection, dict) else None
                if candidate is None or any(selection.get(key) != candidate[key] for key in ('node_id', 'input', 'type')):
                    raise ValueError('参数接口已改变，请重新选择外层字段')
                fields.append({**candidate, 'label': selection.get('label', candidate['label'])})
            baseline = {f['id']: prompt[f['node_id']]['inputs'][f['input']] for f in fields}
            values = copy.deepcopy(baseline)
            previous = self.packages.get(data['previous_package_id']) if data.get('previous_package_id') else None
            changes = {}
            if previous:
                mappings = data.get('rebindings') or {}
                if not isinstance(mappings, dict):
                    raise ValueError('接口重绑映射须为对象')
                live_bindings = {(f['node_id'], f['input'], f['type']) for f in interface['fields']}
                for old in previous['fields']:
                    if (old['node_id'], old['input'], old['type']) not in live_bindings and old['id'] not in mappings:
                        raise ValueError('旧字段已失效，请明确重绑或解除：' + old['label'])
                reconciled = reconcile_interface(
                    previous['fields'], data.get('previous_values', {}), fields,
                    prompt, data.get('previous_baseline'), data.get('rebindings'))
                values.update(reconciled['values'])
                changes = reconciled['changes']
                resolutions = data.get('resolutions', {})
                if changes.get('conflicts'):
                    for index, conflict in enumerate(changes['conflicts']):
                        key = str(conflict.get('id', index))
                        choice = resolutions.get(key)
                        if choice not in conflict.get('allowed', ['outer', 'inner']):
                            return {'requires_resolution': True, 'changes': changes}
                        values[conflict.get('field_id', conflict.get('id'))] = conflict[choice]
            output_nodes = data.get('output_nodes', [item['id'] for item in interface['outputs']])
            select_outputs(prompt, output_nodes, info)
            current = self.editor_workflows.get(workflow_id)
            if data.get('base_revision', current['revision']) != current['revision']:
                raise ValueError('另一窗口已保存此工作流，请先导出当前修改，再重新打开以免覆盖')
            package_document = normalize_document({
                'name': current['name'],
                'description': '内部调参后应用到外层；草稿不会自动替换已应用参数。',
                'prompt': prompt, 'fields': fields,
            })
            validate_prompt(apply_values(package_document, values), info)
            package = self.packages.save(package_document)
            revision = current if configure else self.editor_workflows.save_revision(workflow_id, data.get('document'), prompt)
        return {'workflow': revision, 'package': package, 'values': values, 'baseline': baseline,
                'output_nodes': output_nodes, 'outputs': interface['outputs'], 'changes': changes, 'backend_url': self.backend.url}

    def update_status(self):
        return {**self.updates.status(), "busy": self.update_busy, "error": self.update_error,
                "auto_update": self.settings["auto_update"], "install_supported": bool(getattr(sys, "frozen", False) and os.name == "nt")}

    def begin_update(self, action):
        if action not in {"check", "stage", "auto"}:
            raise ValueError("更新操作无效")
        with self.lock, self.update_lock:
            if self.exit_pending:
                raise ValueError("棱光正在退出，不能开始更新")
            if self.update_busy:
                return self.update_status()
            self.update_busy, self.update_error = True, ""
        def run():
            try:
                status = self.updates.check()
                if action in {"stage", "auto"} and status.get("update_available"):
                    if status.get("release", {}).get("bytes", 0) > 50 * 1024 * 1024:
                        raise ValueError("更新包超过 50 MiB，请通过发布页面确认大小后手动下载")
                    self.updates.stage()
            except (OSError, ValueError, UpdateError) as exc:
                self.update_error = str(exc)
            finally:
                self.update_busy = False
        threading.Thread(target=run, daemon=True).start()
        return self.update_status()

    def prepare_exit(self, port, install=False):
        """An owned client may exit only after its submissions are settled."""
        with self.lock, _ledger_lock(self):
            if self.exit_pending:
                raise ValueError("棱光正在退出，请勿重复安装")
            if self.update_busy:
                return False
            if any(job["status"] not in TERMINAL for job in self.jobs.values()):
                return False
            if any(record["state"] in {"pending", "unknown"} for record in _read_ledger(self).values()):
                return False
            staged = self.updates.status().get("staged")
            if install or (self.settings["auto_update"] and staged):
                if self.update_busy:
                    return False
                if not staged or not staged.get("verified"):
                    raise ValueError("请先下载并校验更新")
                if not getattr(sys, "frozen", False) or os.name != "nt":
                    if install:
                        raise ValueError("自动安装仅支持 Windows 打包客户端，源码运行请使用版本管理更新")
                    return True
                from .update_handoff import launch_handoff
                launch_handoff(sys.executable, self.data_dir, staged, port)
            self.exit_pending = True
            return True

    def start_saved_engine(self):
        """Start only the user's selected, locally registered engine; never switch.

        A profile may opt out of auto start with ``"auto_start": false`` in
        engines.json; manual starts from the engine center are unaffected.
        """
        try:
            for profile in self.engines.status()["profiles"]:
                if profile["base_url"] != self.backend.url:
                    continue
                if profile.get("auto_start", True) is False:
                    logging.info("引擎 %s 配置为不自动启动，跳过。", profile["id"])
                    break
                logging.info("自动拉起引擎 %s（%s）。", profile["id"], profile["base_url"])
                self.engines.start(profile["id"])
                break
        except (OSError, ValueError, BackendError) as exc:
            logging.warning("自动拉起引擎未完成：%s", exc)  # The engine center reports failure; startup must remain usable.

    @staticmethod
    def validate_roots(roots):
        if not isinstance(roots, list) or len(roots) > 12:
            raise ValueError("模型目录须为最多 12 个绝对路径")
        result = []
        for root in roots:
            if not isinstance(root, str) or len(root) > 1024 or not Path(root).is_absolute() or root.startswith(("\\\\", "//")):
                raise ValueError("请选择本机磁盘的绝对目录，不支持网络共享")
            normalized = str(Path(root).resolve())
            if normalized not in result:
                result.append(normalized)
        return result

    def object_info(self, refresh=False):
        with self.lock:
            if refresh or not self.info or time.monotonic() - self.info_at > 60:
                info = self.backend.request("/object_info", timeout=30)
                if not isinstance(info, dict):
                    raise BackendError("后端 object_info 格式不正确")
                self.info = info
                self.info_at = time.monotonic()
            return self.info

    def status(self):
        try:
            stats = self.backend.request("/system_stats", timeout=4)
            if not isinstance(stats, dict) or not isinstance(stats.get("system"), dict) or not isinstance(stats.get("devices"), list):
                raise BackendError("此端口未返回有效的 ComfyUI 环境信息")
            info = self.object_info()
            models = catalog(info)
            models["checkpoints"] = models.get("checkpoint", [])
            return {"online": True, "backend_url": self.backend.url, "devices": stats.get("devices", []),
                    "system": stats.get("system", {}), "capabilities": capabilities(info), "models": models,
                    "generation_options": generation_options(info)}
        except BackendError as exc:
            return {"online": False, "backend_url": self.backend.url, "devices": [], "capabilities": {}, "models": {}, "error": str(exc)}

    def environment(self):
        with self.environment_lock:
            if self.environment_snapshot is None or time.monotonic() - self.environment_at > 10:
                with self.lock:
                    settings = copy.deepcopy(self.settings)
                discovered = discover_environment(settings)
                with self.lock:
                    if settings == self.settings:
                        self.environment_snapshot = discovered
                        self.environment_at = time.monotonic()
                    else:
                        return discovered | {"stale": True, "notes": discovered.get("notes", []) + ["扫描期间设置已变化，请重新检查"]}
            return copy.deepcopy(self.environment_snapshot)

    def resolve_request(self, data):
        if not isinstance(data, dict):
            raise ValueError("生成请求须为对象")
        if 'output_nodes' in data and data.get('kind') != 'package':
            raise ValueError('输出分支选择仅用于工作流包')
        if data.get("kind") == "package":
            if data.get('editor_backend') and data['editor_backend'] != self.backend.url:
                raise ValueError('此原生工作流的参数来自另一推理后端，请切回该后端或重新进入工作流应用参数')
            package = self.packages.get(data.get("package_id"))
            prompt = apply_values(package, data.get("values", {}))
            if 'output_nodes' in data:
                prompt = select_outputs(prompt, data['output_nodes'], self.object_info())
            return {"kind": "api", "prompt": prompt}
        return data

    def diagnostics(self, data):
        request = self.resolve_request(data)
        status = self.status()
        return diagnose(self.settings, self.info if status["online"] else {}, status, request,
                        status.get("models", {}), environment=self.environment())

    def save_settings(self, data):
        settings = {"backend_url": local_url(data.get("backend_url", "")),
                    "performance_profile": data.get("performance_profile", self.settings.get("performance_profile", "auto")),
                    "auto_start_engine": data.get("auto_start_engine", self.settings.get("auto_start_engine", False)),
                    "auto_update": data.get("auto_update", self.settings.get("auto_update", False)),
                    "model_roots": self.validate_roots(data.get("model_roots", [])),
                    "comfy_roots": self.validate_roots(data.get("comfy_roots", self.settings.get("comfy_roots", [])))}
        if type(settings["auto_start_engine"]) is not bool or type(settings["auto_update"]) is not bool:
            raise ValueError("自动启动设置须为布尔值")
        if settings["performance_profile"] not in PROFILES:
            raise ValueError("显存预算选项无效")
        with self.lock:
            changed = settings["backend_url"] != self.backend.url
            enable_updates = settings["auto_update"] and not self.settings.get("auto_update", False)
            if changed and any(j["status"] not in TERMINAL for j in self.jobs.values()):
                raise ValueError("有任务尚未结束，请等待任务结束后切换推理后端")
            if changed:
                with _ledger_lock(self):
                    if any(record["state"] in {"pending", "unknown"} for record in _read_ledger(self).values()):
                        raise ValueError("有提交结果尚未确认，请先在原引擎核实请求，不能切换后端")
            atomic_json(self.data_dir / "settings.json", settings)
            self.settings = settings
            self.updates.set_auto_check(settings["auto_update"])
            self.backend = Backend(settings["backend_url"])
            self.info, self.info_at = {}, 0
            self.environment_at = 0
            if changed:
                self.uploaded.clear()
            if enable_updates:
                self.begin_update("auto")
            return {"settings": settings}

    def register_media(self, filename, subfolder="", kind="output", backend=None):
        filename = safe_relative(filename)
        subfolder = safe_relative(subfolder) if subfolder else ""
        if "/" in filename or kind not in ("input", "output", "temp"):
            raise ValueError("媒体路径无效")
        backend = local_url(backend or self.backend.url)
        # Stable opaque media id avoids leaking server path in browser URLs.
        import hashlib
        key = hashlib.sha256(f"{backend}|{kind}|{subfolder}|{filename}".encode()).hexdigest()[:32]
        self.media[key] = (backend, {"filename": filename, "subfolder": subfolder, "type": kind})
        return f"/api/media/{key}"

    def upload(self, data):
        # Keep backend identity stable until upload registration finishes.
        with self.lock:
            return self._upload(data)

    def _upload(self, data):
        if not isinstance(data.get("data"), str):
            raise ValueError("请上传图片内容")
        try:
            content = base64.b64decode(data["data"], validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("图片编码无效") from None
        return self._upload_content(content)

    def upload_audio(self, data):
        with self.lock:
            try:
                content = base64.b64decode(data.get('data', ''), validate=True)
            except (ValueError, TypeError, binascii.Error):
                raise ValueError('音频编码无效') from None
            if not 12 <= len(content) <= MAX_IMAGE_BYTES:
                raise ValueError('参考音频须在 12 字节到 20 MiB 之间')
            if content[:4] == b'RIFF' and content[8:12] == b'WAVE':
                if int.from_bytes(content[4:8], 'little') + 8 != len(content):
                    raise ValueError('WAV 文件长度无效')
                ext, mime = '.wav', 'audio/wav'
            elif content.startswith(b'fLaC'):
                ext, mime = '.flac', 'audio/flac'
            elif content.startswith(b'ID3') or content[0] == 255 and content[1] & 0xe0 == 0xe0:
                ext, mime = '.mp3', 'audio/mpeg'
            elif content.startswith(b'OggS'):
                ext, mime = '.ogg', 'audio/ogg'
            else:
                raise ValueError('参考音频仅支持 WAV、FLAC、MP3、OGG 文件')
            name = 'prismcanvas-' + uuid.uuid4().hex + ext
            result = self.backend.upload(name, content, mime)
            if not isinstance(result, dict) or not result.get('name') or result.get('type', 'input') != 'input':
                raise BackendError('后端未确认音频上传')
            relative = '/'.join(filter(None, [result.get('subfolder', ''), result['name']]))
            safe_relative(relative)
            url = self.register_media(result['name'], result.get('subfolder', ''), 'input')
            self.uploaded.add(relative)
            self.info_at = 0
            return {'name': relative, 'url': url, 'backend': self.backend.url}

    def output_location(self, job_id, data):
        if type(data.get('open', False)) is not bool:
            raise ValueError('打开目录选项无效')
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError('结果不属于此客户端的任务')
            with self.engines._lock:
                profiles = copy.deepcopy(self.engines._profiles)
            return result_location(job, data.get('index', 0), profiles, open_folder=data.get('open', False))

    def _upload_content(self, content, *, complete=False):
        if not 8 <= len(content) <= MAX_IMAGE_BYTES:
            raise ValueError("参考图大小须在 8 字节到 20 MiB 之间")
        if content.startswith(b"\x89PNG\r\n\x1a\n"):
            ext, mime = ".png", "image/png"
        elif content.startswith(b"\xff\xd8\xff"):
            ext, mime = ".jpg", "image/jpeg"
        elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
            ext, mime = ".webp", "image/webp"
        else:
            raise ValueError("初版参考图支持 PNG、JPEG、WebP；不接受 SVG 或可执行内容")
        if complete:
            # Boundaries detect truncation without adding an image-decoder runtime.
            # This is not a claim that all compressed image pixels were decoded.
            valid_end = (content.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82") if ext == ".png"
                         else content.endswith(b"\xff\xd9") if ext == ".jpg"
                         else len(content) >= 20 and int.from_bytes(content[4:8], "little") + 8 == len(content))
            if not valid_end:
                raise ValueError("结果图片数据不完整，无法作为下游输入")
        name = "frameweave-" + uuid.uuid4().hex + ext
        result = self.backend.upload(name, content, mime)
        if not isinstance(result, dict) or (complete and (not isinstance(result.get("name"), str)
                or not result["name"] or result.get("type", "input") != "input")):
            raise BackendError("后端没有返回有效的图片输入登记，无法交给下游节点")
        returned_name = result.get("name", name)
        subfolder = result.get("subfolder", "")
        url = self.register_media(returned_name, subfolder, "input")
        backend_name = f"{subfolder}/{returned_name}" if subfolder else returned_name
        self.uploaded.add(backend_name)
        self.info_at = 0
        return {"name": backend_name, "url": url, "backend": self.backend.url}

    def image_input(self, job_id, data):
        """Copy an owned completed result into the current backend's image inputs."""
        if not isinstance(data, dict) or set(data) != {"output_index"} or type(data["output_index"]) is not int:
            raise ValueError("图片结果复用需要整数 output_index，不接受 URL 或文件路径")
        index = data["output_index"]
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("任务不属于此客户端")
            if job.get("status") != "completed":
                raise ValueError("只能复用已完成任务的图片结果")
            if job.get("backend") != self.backend.url:
                raise ValueError("结果来自另一个后端，请先恢复原后端连接")
            outputs = [output for output in job.get("outputs", [])
                       if isinstance(output, dict) and output.get("type") == "image"]
            if not 0 <= index < len(outputs):
                raise ValueError("图片结果索引越界，或此任务没有图片输出")
            output = outputs[index]
            if Path(output.get("filename", "")).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                raise ValueError("只能复用 PNG、JPEG、WebP 图片结果")
            url = output.get("url", "")
            if not isinstance(url, str) or not re.fullmatch(r"/api/media/[0-9a-f]{32}", url):
                raise ValueError("结果图片没有有效的本地媒体登记")
            registered = self.media.get(url.rsplit("/", 1)[-1])
            if not registered:
                raise ValueError("结果图片未登记或已不可用")
            media_backend, query = registered
            if (media_backend != job["backend"] or query.get("type") not in {"output", "temp"}
                    or query.get("filename") != output.get("filename")
                    or query.get("subfolder", "") != output.get("subfolder", "")):
                raise ValueError("结果图片与任务媒体登记不一致")
            # Revalidate registered names rather than accepting a URL from a caller.
            filename = safe_relative(query["filename"])
            subfolder = safe_relative(query["subfolder"]) if query.get("subfolder") else ""
            if "/" in filename:
                raise ValueError("结果图片文件名无效")
            view_query = {"filename": filename, "subfolder": subfolder, "type": query["type"]}
            request = urllib.request.Request(media_backend + "/view?" + urllib.parse.urlencode(view_query),
                                             headers={"Accept-Encoding": "identity"})
            try:
                with self.backend.opener.open(request, timeout=30) as response:
                    if response.status != 200 or response.headers.get("Content-Range"):
                        raise BackendError("结果图片未返回完整响应")
                    if response.headers.get("Content-Encoding", "identity").lower() != "identity":
                        raise BackendError("结果图片使用了不支持的传输编码")
                    lengths = response.headers.get_all("Content-Length", [])
                    transfer = response.headers.get("Transfer-Encoding", "").lower()
                    if transfer not in {"", "identity", "chunked"} or (transfer == "chunked" and lengths):
                        raise BackendError("结果图片响应传输格式不明确")
                    if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,20}", lengths[0])):
                        raise BackendError("结果图片响应长度无效")
                    expected = int(lengths[0]) if lengths else None
                    if expected is not None and not 8 <= expected <= MAX_IMAGE_BYTES:
                        raise BackendError("结果图片响应大小超过 20 MiB 或为空")
                    content = response.read(MAX_IMAGE_BYTES + 1)
                    if len(content) > MAX_IMAGE_BYTES:
                        raise BackendError("结果图片响应大小超过 20 MiB")
                    if expected is not None and len(content) != expected:
                        raise BackendError("结果图片响应读取不完整")
            except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
                raise BackendError("无法完整读取任务图片结果：" + str(exc)) from None
            result = self._upload_content(content, complete=True)
            return {**result, "backend": self.backend.url, "source_job": job_id, "output_index": index}

    def compile(self, data):
        result = compile_workflow(self.resolve_request(data), self.object_info())
        if data.get("kind") == "package":
            package = self.packages.get(data.get("package_id"))
            result.setdefault("summary", {}).update({"package_id": package["id"], "package_name": package["name"]})
        return result

    def submit(self, data):
        with self.lock:
            result = self.compile(data)
            request = {k: copy.deepcopy(v) for k, v in data.items() if k in REQUEST_FIELDS}
            if data.get("kind") == "api":
                request = None  # The exact graph is already stored once below.
            elif data.get("kind") != "package":
                summary = result.get("summary", {})
                for key in ("kind", "models", "seed", "width", "height", "steps", "cfg", "sampler", "scheduler", "reference_roles", "denoise", "loras", "custom_size", "ref_resolution"):
                    if key in summary:
                        if key in {"width", "height"} and summary[key] is None:
                            # An input-derived output size is unknown until execution;
                            # its display summary must not erase replayable input values.
                            if key not in request and summary.get("requested_" + key) is not None:
                                request[key] = summary["requested_" + key]
                            continue
                        if key == "reference_roles" and str(data.get("kind", "")).startswith("qwen21_"):
                            continue
                        request[key] = copy.deepcopy(summary[key])
            result["request"] = request
            return self._dispatch(result, data.get("kind"))

    def _dispatch(self, result, kind, retry_of=None):
        """Called under lock. Prepare storage before any inference side effect."""
        if self.exit_pending or self.closed.is_set():
            raise ValueError("棱光正在退出，未提交生成任务")
        if sum(j["status"] not in TERMINAL for j in self.jobs.values()) >= 24:
            raise ValueError("最多同时保留 24 个未结束任务")
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2)
        if len(encoded.encode("utf-8")) > MAX_RUN:
            raise ValueError("任务复现记录超过 4 MiB，请精简工作流与参数")
        run_dir = self.data_dir / "runs"
        run_dir.mkdir(exist_ok=True)
        pending = run_dir / ("pending-" + uuid.uuid4().hex + ".json")
        atomic_json(pending, result)
        try:
            try:
                response = self.backend.request("/prompt", {"prompt": result["prompt"], "client_id": self.client_id}, timeout=30)
            except BackendError as exc:
                if str(exc).startswith(("后端 HTTP 400:", "后端 HTTP 422:")):
                    raise
                raise SubmissionUncertain("提交结果不确定，请先检查后端队列，不要重复提交：" + str(exc)) from None
            if not isinstance(response, dict):
                raise SubmissionUncertain("后端提交结果不明确，请先检查后端队列")
            if response.get("node_errors"):
                raise BackendError("工作流被后端拒绝：" + json.dumps(response["node_errors"], ensure_ascii=False)[:5000])
            job_id = response.get("prompt_id")
            if not isinstance(job_id, str) or not re.fullmatch(r"[\w-]{1,100}", job_id):
                raise SubmissionUncertain("后端未返回有效 prompt_id，请先检查后端队列")
            job = {"id": job_id, "status": "queued", "progress": None, "elapsed": 0,
                   "created_at": time.time(), "started_at": None, "finished_at": None,
                   "kind": kind, "outputs": [], "backend": self.backend.url,
                   "summary": result.get("summary", {}), "error": ""}
            if retry_of:
                job["retry_of"] = retry_of
            self.jobs[job_id] = job
            # Once accepted, disk errors must not be reported as a failed submission.
            try:
                os.replace(pending, run_dir / f"{job_id}.json")
                self.persist_jobs()
            except OSError:
                job["storage_warning"] = "后端已接受任务，但本地记录保存失败；请勿重复提交，修复磁盘权限或空间后保留任务 ID。"
            return self.public_job(job)
        finally:
            # Remove only our preflight file when the operation failed before acceptance.
            if pending.exists() and not locals().get("job_id"):
                try:
                    pending.unlink()
                except OSError:
                    pass

    def public_job(self, job):
        result = copy.deepcopy(job)
        try:
            has_run = (self.data_dir / "runs" / f"{job['id']}.json").is_file()
        except OSError:
            has_run = False
        attempt = job.get("retry_attempt", {})
        result["can_reuse"] = has_run
        result["can_retry"] = bool(has_run and job.get("status") in TERMINAL and
                                   job.get("backend") == self.backend.url and
                                   attempt.get("state") not in {"pending", "unknown"})
        if attempt.get("state") in {"pending", "unknown"}:
            result["retry_warning"] = "上次再次生成的提交结果不确定，请先在原后端核实队列；此记录已停止重提。"
        try:
            result["backend"] = local_url(job.get("backend"))
        except ValueError:
            result.pop("backend", None)
        result.pop("retry_attempt", None)
        result.pop("retry_requests", None)
        return result

    def _read_run(self, job_id):
        if job_id not in self.jobs:
            raise ValueError("任务不属于此客户端")
        try:
            file = self.data_dir / "runs" / f"{job_id}.json"
            with file.open("rb") as stream:
                raw = stream.read(MAX_RUN + 1)
            if len(raw) > MAX_RUN:
                raise ValueError("任务复现记录超过 4 MiB")
            run = json.loads(raw)
            if not isinstance(run, dict) or not isinstance(run.get("prompt"), dict) or not run["prompt"]:
                raise ValueError("无有效 API 图")
            return run
        except (OSError, ValueError, RecursionError, TypeError):
            raise ValueError("任务复现记录缺失、损坏或过大，无法恢复") from None

    def recipe(self, job_id):
        with self.lock:
            run = self._read_run(job_id)
            job = self.jobs[job_id]
            warnings = ["再次生成使用保存的 API 图和种子，提交前重新校验节点与模型；原后端输入素材需要保留。"]
            request = run.get("request")
            if isinstance(request, dict) and request.get("kind") == "package":
                try:
                    self.packages.get(request.get("package_id"))
                except ValueError:
                    request = None
            if not isinstance(request, dict):
                request = {"kind": "api", "prompt": run["prompt"]}
                warnings.append("此任务恢复为 API 工作流，完整保留原始节点和参数。")
            # Do not silently round legacy 64-bit seeds in the browser.
            stack = [request]
            while stack:
                value = stack.pop()
                if isinstance(value, dict):
                    stack.extend(value.values())
                elif isinstance(value, list):
                    stack.extend(value)
                elif isinstance(value, (int, float)) and (not -9007199254740991 <= value <= 9007199254740991):
                    raise ValueError("旧任务包含浏览器无法精确编辑的数字；请使用再次生成以保留原始精度")
            same_backend = job.get("backend") == self.backend.url
            if not same_backend:
                warnings.append("当前后端地址与原任务不同；可恢复编辑，请重新选择模型和上传参考图后再提交。")
            return {"request": copy.deepcopy(request), "summary": run.get("summary", {}),
                    "warnings": warnings, "replayable": same_backend}

    def retry(self, job_id, data):
        key = data.get("request_id")
        if not isinstance(key, str) or not re.fullmatch(r"[\w-]{8,100}", key):
            raise ValueError("再次生成需要有效的 request_id")
        with self.lock:
            run = self._read_run(job_id)
            source = self.jobs[job_id]
            if source.get("backend") != self.backend.url or source.get("status") not in TERMINAL:
                raise ValueError("只能在原后端对已结束的任务再次生成")
            requests = source.setdefault("retry_requests", {})
            if key in requests:
                known = self.jobs.get(requests[key])
                if not known:
                    raise ValueError("该请求已提交，其结果已超出最近任务范围；请核实后端历史")
                return self.public_job(known)
            previous = source.get("retry_attempt", {})
            child = self.jobs.get(previous.get("job_id"))
            if child and (previous.get("key") == key or child.get("status") not in TERMINAL):
                if len(requests) >= 64 and key not in requests:
                    raise ValueError("该历史任务的请求次数超过限制，请从最近生成的任务继续")
                requests[key] = child["id"]
                try:
                    self.persist_jobs()
                except OSError:
                    child["storage_warning"] = "任务已存在，但本地记录保存失败；请保留任务 ID，勿重复提交。"
                return self.public_job(child)
            if previous.get("state") in {"pending", "unknown"}:
                raise ValueError("上次提交结果不确定，请先在原后端检查；为避免重复任务已停止重提")
            if len(requests) >= 64:
                raise ValueError("该历史任务已再次生成 64 次，请从最近生成的任务继续")
            validate_prompt(run["prompt"], self.object_info(refresh=True))
            if sum(j["status"] not in TERMINAL for j in self.jobs.values()) >= 24:
                raise ValueError("最多同时保留 24 个未结束任务")
            source["retry_attempt"] = {"key": key, "state": "pending"}
            try:
                self.persist_jobs()  # If this fails, no backend submission occurs.
            except OSError:
                source["retry_attempt"] = previous
                raise
            try:
                result = self._dispatch(run, source.get("kind"), retry_of=job_id)
            except (OSError, ValueError, BackendError) as exc:
                source["retry_attempt"] = {"key": key, "state": "unknown"} if isinstance(exc, SubmissionUncertain) else previous
                try:
                    self.persist_jobs()
                except OSError:
                    pass
                raise
            source["retry_attempt"].update(state="accepted", job_id=result["id"])
            requests[key] = result["id"]
            try:
                self.persist_jobs()
            except OSError:
                self.jobs[result["id"]]["storage_warning"] = "后端已接受任务，但本地记录保存失败；请保留任务 ID，勿重复提交。"
            return self.public_job(self.jobs[result["id"]])

    def persist_jobs(self):
        atomic_json(self.data_dir / "jobs.json", list(self.jobs.values())[-200:])

    def job_list(self):
        with self.lock:
            now = time.time()
            jobs = [self.public_job(job) for job in list(self.jobs.values())[-200:]]
        for job in jobs:
            start = job.get("started_at") or job.get("created_at", now)
            job["elapsed"] = round(max(0, (job.get("finished_at") or now) - start), 1)
        return {"jobs": list(reversed(jobs[-200:]))}

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("只能取消由棱光提交的任务")
            if job["status"] in TERMINAL:
                return {"id": job_id, "status": job["status"]}
            # Newer ComfyUI exposes an atomic job-scoped cancellation API.
            # Never fall back to a global interrupt, even after a queue ownership check.
            try:
                targeted = self.backend.request("/api/jobs/" + urllib.parse.quote(job_id) + "/cancel", {})
                if targeted.get("cancelled"):
                    job["status"], job["finished_at"] = "cancelled", time.time()
                    self.persist_jobs()
                    return {"id": job_id, "status": "cancelled"}
            except BackendError as exc:
                if "HTTP 404" not in str(exc) and "HTTP 405" not in str(exc):
                    raise
            queue = self.backend.request("/queue")
            pending = {str(row[1]) for row in queue.get("queue_pending", []) if len(row) > 1}
            running = {str(row[1]) for row in queue.get("queue_running", []) if len(row) > 1}
            if job_id in pending:
                self.backend.request("/queue", {"delete": [job_id]})
                # Queue deletion may race execution. Verify before claiming cancellation.
                verify = self.backend.request("/queue")
                active = {str(row[1]) for row in verify.get("queue_running", []) + verify.get("queue_pending", []) if len(row) > 1}
                if job_id in active:
                    raise ValueError("任务已经开始执行；为避免中断其他客户端，请在推理后端停止此运行")
                job["status"], job["finished_at"] = "cancelled", time.time()
            elif job_id in running:
                raise ValueError("当前后端使用共享的全局中断接口；初版只安全取消排队任务。运行中任务请在推理后端停止")
            else:
                raise ValueError("后端队列中已无此任务，请等待状态刷新")
            self.persist_jobs()
            return {"id": job_id, "status": job["status"]}

    def update_jobs(self):
        with self.lock:
            active = [(k, copy.deepcopy(v)) for k, v in self.jobs.items() if v["status"] not in TERMINAL]
        if not active:
            return
        try:
            queue = self.backend.request("/queue", timeout=4)
            running = {str(row[1]) for row in queue.get("queue_running", []) if len(row) > 1}
            pending = {str(row[1]) for row in queue.get("queue_pending", []) if len(row) > 1}
            for job_id, old in active:
                history = self.backend.request("/history/" + urllib.parse.quote(job_id), timeout=5)
                item = history.get(job_id)
                with self.lock:
                    job = self.jobs[job_id]
                    if job["status"] in TERMINAL:
                        continue
                    if item:
                        result_status = item.get("status", {})
                        failed = result_status.get("status_str") == "error"
                        if failed or result_status.get("completed"):
                            job["status"] = "failed" if failed else "completed"
                            job["finished_at"] = time.time()
                            job["progress"] = 100 if not failed else None
                            if failed:
                                messages = result_status.get("messages", [])
                                errors = [v[1].get("exception_message", "生成执行失败") for v in messages
                                          if isinstance(v, list) and len(v) > 1 and v[0] == "execution_error" and isinstance(v[1], dict)]
                                job["error"] = "\n".join(errors)[:4000] or "后端执行失败或被中断"
                            outputs = []
                            for output_node_id, node_result in item.get("outputs", {}).items():
                                for key in ("images", "gifs", "videos", "video", "audio", "audios"):
                                    values = node_result.get(key, [])
                                    if not isinstance(values, list):
                                        continue
                                    for entry in values:
                                        if not isinstance(entry, dict) or not isinstance(entry.get("filename"), str):
                                            continue
                                        filename = entry["filename"]
                                        suffix = Path(filename).suffix.lower()
                                        if suffix not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"):
                                            continue
                                        subfolder = entry.get("subfolder", "")
                                        url = self.register_media(filename, subfolder, entry.get("type", "output"), old["backend"])
                                        out_type = "video" if suffix in (".mp4", ".webm") else "audio" if suffix in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus") else "image"
                                        outputs.append({"url": url, "filename": filename, "subfolder": subfolder, "type": out_type, "storage_type": entry.get("type", "output"), "node_id": str(output_node_id)})
                            job["outputs"] = outputs
                    elif job_id in running:
                        job["status"] = "running"
                        job["started_at"] = job.get("started_at") or time.time()
                    elif job_id in pending:
                        job["status"] = "queued"
                    elif time.time() - job["created_at"] > 15:
                        job["status"] = "failed"
                        job["finished_at"] = time.time()
                        job["error"] = "任务已离开后端队列且没有历史记录，可能被外部移除或后端重启"
                    self.persist_jobs()
        except (BackendError, ValueError, OSError):
            # A disconnected backend is not proof a generation failed.
            pass

    def poll(self):
        while not self.closed.wait(2):
            self.update_jobs()


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def make_server(app, port=0):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # URLs and prompts must not end up in ambient logs.

        def allowed_host(self):
            expected = f"127.0.0.1:{self.server.server_port}"
            return self.headers.get("Host") == expected

        def origin_ok(self):
            origin = self.headers.get("Origin")
            return not origin or origin == f"http://127.0.0.1:{self.server.server_port}"

        def respond(self, data, code=200, content_type="application/json; charset=utf-8", extra=None):
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def drain_rejected_body(self):
            """Consume only a small, explicitly sized body after the rejection is sent."""
            if self.headers.get_all("Transfer-Encoding"):
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
                return
            digits = lengths[0].lstrip("0") or "0"
            if len(digits) > len(str(MAX_REJECT_DRAIN)):
                return
            length = int(digits)
            if not 1 <= length <= MAX_REJECT_DRAIN:
                return
            deadline = time.monotonic() + REJECT_DRAIN_TIMEOUT
            remaining = length
            try:
                while remaining:
                    timeout = deadline - time.monotonic()
                    if timeout <= 0:
                        return
                    self.connection.settimeout(timeout)
                    chunk = self.rfile.read1(min(remaining, 8192))
                    if not chunk:
                        return
                    remaining -= len(chunk)
            except OSError:
                # The response has already been sent. A timeout or disconnect
                # ends this rejected request without waiting for the full body.
                return

        def reject(self, data, code=400, content_type="application/json; charset=utf-8", extra=None):
            """Reject and close, draining only a bounded, unambiguous body."""
            self.close_connection = True
            headers = dict(extra or {})
            headers["Connection"] = "close"
            self.respond(data, code, content_type, headers)
            self.drain_rejected_body()

        def do_GET(self):
            if not self.allowed_host() or not self.origin_ok() or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.reject({"error": "仅允许本机客户端访问"}, 403)
                return
            app.last_seen = time.monotonic()
            path = urllib.parse.urlsplit(self.path).path
            try:
                if path == "/api/bootstrap":
                    self.respond({"application": "PrismCanvas", "version": __version__, "csrf": app.csrf, "settings": app.settings,
                                  "presets": [{"id": "draft", "label": "构图试样", "steps": 20, "width": 768, "height": 448, "seconds": 4},
                                              {"id": "balanced", "label": "标准制作", "steps": 20, "width": 1344, "height": 768, "seconds": 5},
                                              {"id": "quality", "label": "细节优先", "steps": 25, "width": 1344, "height": 768, "seconds": 5}]})
                elif path == "/mcp":
                    self.reject({"error": "此 MCP 接口使用 POST；不提供 SSE 订阅"}, 405, extra={"Allow": "POST"})
                elif path == "/api/status":
                    self.respond(app.status())
                elif path == '/api/performance-plan':
                    self.respond(performance_plan(app.settings['performance_profile'], app.status()))
                elif path == '/api/canvases':
                    self.respond(app.canvases.list())
                elif re.fullmatch(r'/api/canvases/[0-9a-f]{32}', path):
                    self.respond(app.canvases.get(path.rsplit('/', 1)[-1]))
                elif path == '/api/audio-capabilities':
                    from .audio_workflows import audio_capabilities
                    self.respond({**audio_capabilities(app.object_info(), [app.packages.get(p['id']) for p in app.packages.list()]), 'backend_url': app.backend.url})
                elif path == "/api/engines":
                    self.respond(app.engines.status())
                elif path == "/api/updates":
                    self.respond(app.update_status())
                elif path == "/api/heartbeat":
                    self.respond({"ok": True})
                elif path == "/api/jobs":
                    self.respond(app.job_list())
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/recipe", path):
                    self.respond(app.recipe(path.split("/")[3]))
                elif path == '/api/editor-workflows':
                    self.respond(app.editor_workflows.list())
                elif re.fullmatch(r'/api/editor-workflows/e-[0-9a-f]{24}', path):
                    self.respond(app.editor_workflows.get(path.rsplit('/', 1)[-1]))
                elif path == "/api/packages":
                    self.respond({"packages": app.packages.list()})
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}", path):
                    self.respond({"package": app.packages.get(path.rsplit("/", 1)[-1])})
                elif path.startswith("/api/media/"):
                    key = path.rsplit("/", 1)[-1]
                    with app.lock:
                        registered = app.media.get(key)
                    if not registered:
                        self.reject({"error": "媒体不属于此客户端的任务或导入"}, 404)
                        return
                    backend_url, query = registered
                    header = {}
                    range_header = self.headers.get("Range")
                    if range_header and re.fullmatch(r"bytes=\d+-\d*", range_header):
                        header["Range"] = range_header
                    # Stream large videos: no full-file buffering in the lightweight client.
                    self.stream_media(backend_url, query, header)
                elif path.startswith("/api/"):
                    self.reject({"error": "接口不存在"}, 404)
                else:
                    relative = "index.html" if path == "/" else safe_relative(urllib.parse.unquote(path).lstrip("/"))
                    file = (app.web_dir / relative).resolve()
                    if not file.is_relative_to(app.web_dir) or not file.is_file():
                        self.reject({"error": "文件不存在"}, 404)
                    else:
                        mime = "text/javascript" if file.suffix in (".js", ".mjs") else mimetypes.guess_type(str(file))[0] or "application/octet-stream"
                        self.respond(file.read_bytes(), content_type=mime)
            except (ValueError, OSError, BackendError) as exc:
                self.reject({"error": str(exc)}, 400 if isinstance(exc, ValueError) else 502)

        def stream_media(self, backend_url, query, headers):
            import urllib.request
            adapter = Backend(backend_url)
            req = urllib.request.Request(backend_url + "/view?" + urllib.parse.urlencode(query), headers=headers)
            with adapter.opener.open(req, timeout=30) as source:
                self.send_response(source.status)
                mime = mimetypes.guess_type(query["filename"])[0] or "application/octet-stream"
                self.send_header("Content-Type", mime)
                length = source.headers.get("Content-Length")
                if length:
                    self.send_header("Content-Length", length)
                else:
                    self.send_header("Connection", "close")
                    self.close_connection = True
                for header in ("Accept-Ranges", "Content-Range"):
                    if source.headers.get(header):
                        self.send_header(header, source.headers[header])
                self.send_header("Cache-Control", "private, max-age=300")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.end_headers()
                try:
                    while chunk := source.read(128 * 1024):
                        self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def do_POST(self):
            path = urllib.parse.urlsplit(self.path).path
            is_mcp = path == "/mcp"
            supplied = self.headers.get("Authorization", "") if is_mcp else self.headers.get("X-FW-Token", "")
            expected = "Bearer " + app.csrf if is_mcp else app.csrf
            if (not self.allowed_host() or not self.origin_ok()
                    or self.headers.get("Sec-Fetch-Site") == "cross-site"
                    or not hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))):
                self.reject({"error": "请求校验失败，请刷新客户端后重试"}, 403)
                return
            app.last_seen = time.monotonic()
            if self.headers.get_all("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) > 1:
                self.reject({"error": "请求须使用单一 Content-Length"}, 400)
                return
            if is_mcp:
                accepted = set()
                for part in self.headers.get("Accept", "").split(","):
                    media_type, *parameters = part.lower().strip().split(";")
                    try:
                        quality = next((float(value.split("=", 1)[1]) for value in parameters if value.strip().startswith("q=")), 1)
                    except ValueError:
                        quality = 0
                    if 0 < quality <= 1:
                        accepted.add(media_type.strip())
                if not {"application/json", "text/event-stream"} <= accepted:
                    self.reject({"error": "MCP Accept 须包含 application/json 和 text/event-stream"}, 406)
                    return
                protocol = self.headers.get("MCP-Protocol-Version", "2025-03-26")
                if protocol not in PROTOCOL_VERSIONS:
                    self.reject({"error": "不支持此 MCP 协议版本"}, 400)
                    return
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.reject({"error": "仅支持 application/json"}, 415)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.reject({"error": "Content-Length 无效"}, 400)
                return
            if not 1 <= length <= MAX_JSON:
                self.reject({"error": "请求大小超限"}, 413)
                return
            try:
                self.connection.settimeout(30)
                try:
                    raw = self.rfile.read(length)
                    data = json.loads(raw.decode("utf-8") if is_mcp else raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("数字无效")))
                except (ValueError, UnicodeDecodeError, RecursionError):
                    if is_mcp:
                        self.respond({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "JSON 解析失败"}}, 400)
                        return
                    raise
                if is_mcp:
                    code, response = dispatch_mcp(app, data)
                    self.respond(b"" if response is None else response, code)
                    return
                if not isinstance(data, dict):
                    raise ValueError("请求应为 JSON 对象")
                if path == "/api/settings":
                    result = app.save_settings(data)
                elif path == '/api/canvases':
                    result = app.canvases.save(data.get('document'))
                elif path == '/api/upload-audio':
                    result = app.upload_audio(data)
                elif re.fullmatch(r'/api/jobs/[\w-]{1,100}/output-location', path):
                    result = app.output_location(path.split('/')[3], data)
                elif path == "/api/engines/start":
                    result = app.engines.start(data.get("id"))
                elif path == "/api/engines/register":
                    if set(data) - {"root", "port", "name"}:
                        raise ValueError("仅支持登记已有安装目录、名称和端口")
                    result = app.engines.register(data.get("root"), data.get("port", 8188), data.get("name", "本地 ComfyUI"))
                elif path in {"/api/updates/check", "/api/updates/stage"}:
                    result = app.begin_update(path.rsplit("/", 1)[-1])
                elif path in {"/api/updates/install", "/api/exit"}:
                    if not app.prepare_exit(self.server.server_port, install=path.endswith("/install")):
                        raise ValueError("有生成任务、待确认提交或下载正在处理，请完成后再退出安装")
                    self.respond({"ok": True, "exiting": True})
                    app.closed.set()
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
                elif path == "/api/environment":
                    result = app.environment()
                elif path == "/api/diagnostics":
                    result = app.diagnostics(data)
                elif path == '/api/editor-workflows/inspect':
                    checked = parse_editor_document(data.get('source_json'))
                    result = {'nodes': len(checked['nodes']), 'links': len(checked['links'])}
                elif path == '/api/editor-workflows':
                    document = data.get('document')
                    if document is None and isinstance(data.get('source_json'), str):
                        document = json.loads(data['source_json'].lstrip('\ufeff'))
                    result = app.editor_workflows.create(data.get('name'), document, data.get('source_json'))
                elif re.fullmatch(r'/api/editor-workflows/e-[0-9a-f]{24}/(session|draft|apply|export|interface|configure|backends)', path):
                    workflow_id, action = path.split('/')[3:5]
                    if action == 'backends':
                        result = app.editor_backends(workflow_id)
                    elif action == 'session':
                        result = app.editor_session(workflow_id, 'http://' + self.headers['Host'])
                    elif action == 'draft':
                        with app.lock:
                            current = app.editor_workflows.get(workflow_id)
                            if data.get('base_revision', current['revision']) != current['revision']:
                                raise ValueError('另一窗口已保存此工作流，请先导出当前修改，再重新打开以免覆盖')
                            result = current if current['document'] == data.get('document') else app.editor_workflows.save_revision(workflow_id, data.get('document'))
                    elif action == 'apply':
                        result = app.apply_editor(workflow_id, data)
                    elif action == 'configure':
                        result = app.apply_editor(workflow_id, data, configure=True)
                    elif action == 'interface':
                        result = app.editor_interface(workflow_id, data)
                    else:
                        result = {'source_json': app.editor_workflows.export(workflow_id)}
                elif path == '/api/editor-sessions/close':
                    with app.lock:
                        session = app.editor_sessions.pop(data.get('session_id'), None)
                    if session:
                        session['proxy'].close()
                    result = {'ok': True}
                elif path == "/api/packages/inspect":
                    result = inspect_document(transport_document(data), app.info)
                elif path == "/api/packages":
                    result = {"package": app.packages.save(transport_document(data, allow_bare=True))}
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}/export", path):
                    result = app.packages.export_transport(path.split("/")[3])
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}/apply", path):
                    result = {"prompt": apply_values(app.packages.get(path.split("/")[3]), data.get("values", {}))}
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}/metadata", path):
                    result = {"package": app.packages.update_metadata(path.split("/")[3], data)}
                elif path == "/api/compile":
                    result = app.compile(data)
                elif path == "/api/jobs":
                    result = app.submit(data)
                elif path == "/api/generate":
                    if set(data) != {"request_id", "request"}:
                        raise ValueError("生成接口需要 request_id 和 request")
                    result = guarded_generate(app, data["request_id"], data["request"])
                elif path == "/api/requests/query":
                    if set(data) != {"request_id"}:
                        raise ValueError("请求查询只接受 request_id")
                    result = request_status(app, data["request_id"])
                elif path == "/api/upload":
                    result = app.upload(data)
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/cancel", path):
                    result = app.cancel(path.split("/")[3])
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/image-input", path):
                    result = app.image_input(path.split("/")[3], data)
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/retry", path):
                    result = app.retry(path.split("/")[3], data)
                elif path == "/api/shutdown":
                    self.respond({"ok": True})
                    app.closed.set()
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                    return
                else:
                    self.respond({"error": "接口不存在"}, 404)
                    return
                self.respond(result)
            except SubmissionRejected as exc:
                self.respond({"error": str(exc), "submission_state": "rejected"}, 400)
            except (ValueError, KeyError, TypeError, RecursionError, OverflowError) as exc:
                self.respond({"error": "请求的 JSON 嵌套或数字超出限制" if isinstance(exc, (RecursionError, OverflowError)) else str(exc)}, 400)
            except (BackendError, OSError) as exc:
                self.respond({"error": str(exc)}, 502)

        def do_OPTIONS(self):
            self.reject({"error": "不允许跨站请求"}, 403)

        def do_DELETE(self):
            if not self.allowed_host() or not self.origin_ok() or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.reject({"error": "仅允许本机客户端访问"}, 403)
            elif urllib.parse.urlsplit(self.path).path == "/mcp":
                self.reject({"error": "此 MCP 接口不创建会话"}, 405, extra={"Allow": "POST"})
            else:
                self.reject({"error": "接口不存在"}, 404)

    server = Server(("127.0.0.1", port), Handler)
    server.app = app
    return server
