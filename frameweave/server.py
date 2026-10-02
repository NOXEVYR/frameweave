"""Loopback service, job ownership and static UI for FrameWeave."""

import base64
import binascii
import copy
import hashlib
import hashlib
import hmac
import http.client
import json
import logging
import mimetypes
import os
import re
import secrets
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
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
from .hub_connection import HubConnection
from .hub_profiles import prepare_offer
from .h3_reference import prepare_h3_reference_package
from .updates import UpdateManager, UpdateError
from .progress import ProgressStream
from .progress_identity import load_progress_identity, persist_progress_identity
from .job_lifecycle import CANCEL_PENDING, cancel_state, new_cancellation, history_outcome, terminal_observed
from .canvas_store import CanvasStore
from .editor_workflows import EditorWorkflowStore, _parse_document as parse_editor_document, _validate_document as validate_editor_document
from .editor_proxy import EditorProxy
from .editor_interfaces import (inspect_interface, reconcile_interface, select_outputs,
                                normalize_editor_inputs, output_closure, apply_missing_interface_values)
from .editor_backends import inspect_backend_fit
from .editor_preparation import prepare_editor_document
from .preset_editor_preparation import prepare_preset_editor
from .local_assets import (LocalImageAssets, LocalMediaAssets, MAX_LOCAL_IMAGE_BYTES,
                           MAX_LOCAL_VIDEO_BYTES)
from .media_contract import AUDIO_MIMES, MAX_AUDIO_BYTES, audio_content_info
from .workspace_services import PROFILES, performance_plan, result_location
from .packages import (MAX_INTERFACE_FIELDS, PackageStore, apply_values, inspect_document,
                       normalize_document, transport_document, validate_package_media_field,
                       apply_editor_values, apply_planning_values, validate_planning_fields,
                       api_prompt, encoded, validate_inspection_result, _stored_package_document)
from .recovery import recover_records, job_record, media_record
from .settings_recovery import load_settings
from .workflows import capabilities, catalog, compile_workflow, generation_options, validate_prompt, validate_editor_prompt

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


def output_identity(job_id, output):
    """Stable owned file identity; history ordering and display URLs are excluded."""
    identity = [job_id, output.get("node_id", ""), output.get("filename", ""),
                output.get("subfolder", ""), output.get("storage_type", "output"),
                output.get("type", "")]
    return "o-" + hashlib.sha256(json.dumps(identity, ensure_ascii=False,
                                              separators=(",", ":")).encode("utf-8")).hexdigest()


class App:
    def __init__(self, data_dir, web_dir, backend_url=None, roots=None, comfy_roots=None):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.web_dir = Path(web_dir).resolve()
        self.csrf = secrets.token_urlsafe(32)
        self.client_id = "frameweave-" + uuid.uuid4().hex
        self.lock = threading.RLock()
        self.transfer_locks_guard = threading.Lock()
        self.transfer_locks = {}
        self.closed = threading.Event()
        self.last_seen = time.monotonic()
        self.settings, self.recovery_warnings, protected = load_settings(
            self.data_dir / 'settings.json', self.validate_roots)
        self.recovery_protected_files = {'settings.json'} if protected else set()
        if backend_url:
            self.settings["backend_url"] = local_url(backend_url)
        if roots:
            self.settings["model_roots"] = self.validate_roots(roots)
        if comfy_roots:
            self.settings["comfy_roots"] = self.validate_roots(comfy_roots)
        self.backend = Backend(self.settings["backend_url"])
        self.engines = EngineManager(self.data_dir)
        if self.engines.load_error:
            self.recovery_warnings.append(self.engines.load_error)
        self.updates = UpdateManager(__version__, self.data_dir, auto_check=self.settings["auto_update"])
        self.update_lock = threading.Lock()
        self.update_busy = False
        self.update_error = ""
        self.exit_pending = False
        self.listen_port = None
        self.info = {}
        self.info_at = 0
        self.jobs = {}
        self.progress = ProgressStream(self)
        self.media = {}
        self.uploaded = set()
        self.packages = PackageStore(self.data_dir / "workflow-packages")
        self.canvases = CanvasStore(self.data_dir / "canvases")
        self.local_assets = LocalImageAssets(self.data_dir)
        self.local_media_assets = LocalMediaAssets(self.data_dir)
        self.video_output_assets = {}
        self.local_media_upload_cache = {}
        self.editor_workflows = EditorWorkflowStore(self.data_dir / "editor-workflows")
        self.editor_sessions = {}
        threading.Thread(target=self._close_editors_on_exit, daemon=True).start()
        self.environment_lock = threading.Lock()
        self.environment_snapshot = None
        self.environment_at = 0
        old, warnings, protected = recover_records(self.data_dir / 'jobs.json', job_record, 200)
        if protected:
            self.recovery_protected_files.add('jobs.json')
        self.recovery_warnings.extend(warnings)
        for job in old:
            self.jobs[job['id']] = job
            if job['backend'] != self.backend.url and job['status'] not in TERMINAL:
                job['status'] = 'unknown'
                job['status_warning'] = '当前引擎与原任务不同；正在只读查询原引擎，不会重新提交。'
            for output in job['outputs']:
                output['url'] = self.register_media(output['filename'], output['subfolder'], output['storage_type'], job['backend'])
                output['output_id'] = output_identity(job['id'], output)
        self.client_id, progress_warning = load_progress_identity(self.data_dir, self.jobs, self.backend.url, persist=False)
        if progress_warning:
            self.recovery_warnings.append(progress_warning)
        inputs, warnings, protected = recover_records(self.data_dir / 'input-media.json', media_record, 10000)
        if protected:
            self.recovery_protected_files.add('input-media.json')
        self.recovery_warnings.extend(warnings)
        for item in inputs:
            if item['storage_type'] != 'input':
                continue
            self.register_media(item['filename'], item['subfolder'], 'input', item['backend'])
            if item['backend'] == self.backend.url:
                self.uploaded.add('/'.join(filter(None, [item['subfolder'], item['filename']])))

        for warning in self.recovery_warnings:
            logging.getLogger(__name__).warning('配置恢复：%s', warning)
        self.hub_connection = HubConnection(self)
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
        previous = self._interface_previous_package(data)
        prompt = data.get('prompt')
        if prompt is None:
            prompt = self._editor_package_prompt(data)
        info = self.object_info(refresh=True)
        migrated = normalize_editor_inputs(prompt, info)
        repaired = apply_missing_interface_values(migrated['prompt'], info, data.get('missing_values', {}), output_nodes=data.get('output_nodes'))
        return validate_inspection_result({**inspect_interface(repaired['prompt'], info, output_nodes=data.get('output_nodes'),
                                   previous_fields=previous['fields'] if previous else None),
                'migrations': migrated['migrations'], 'repairs': repaired['repairs']})

    def _interface_previous_package(self, data):
        """Resolve public identity from stored content, not caller field claims."""
        package_id = data.get('previous_package_id') or data.get('package_id')
        return self.packages.get(package_id) if package_id else None

    def inspect_package(self, data):
        """Shared data-only package discovery for HTTP and MCP."""
        carrier = {key: value for key, value in data.items() if key != 'output_nodes'}
        document = transport_document(carrier)
        # Validate data before requesting backend metadata; offline discovery
        # remains available without certifying any executable output roots.
        fallback = inspect_document(document, check_dependencies=False)
        schema_warning = None
        try:
            info = self.object_info(refresh=True)
        except BackendError:
            if data.get('output_nodes') is not None:
                raise
            info = {}
            schema_warning = {'code': 'schema_unavailable',
                              'message': '后端节点定义暂不可用；仅分析源数据，执行范围尚未验证'}
        inspection = inspect_document(document, info, check_dependencies=False) if info else fallback
        execution = output_closure(api_prompt(document), data.get('output_nodes'), info,
                                   allow_no_outputs=True)
        if schema_warning:
            execution['warnings'].insert(0, schema_warning)
        return validate_inspection_result({**inspection, 'execution': execution, 'warnings': execution['warnings']})

    def prepare_h3_reference(self, data):
        """Prepare a standard package from fresh schema; do not save or execute."""
        if not isinstance(data, dict) or set(data) != {'backend_url', 'preset_request', 'layout'}:
            raise ValueError('H3 装配需要 backend_url、preset_request 与 layout')
        with self.lock:
            backend = self.backend
            if local_url(data['backend_url']) != backend.url:
                raise ValueError('推理引擎已变化，请重新准备 H3 工作流')
        info = self._object_info_for_backend(backend)
        result = prepare_h3_reference_package(data['preset_request'], data['layout'], info)
        with self.lock:
            if self.backend is not backend:
                raise ValueError('装配期间推理引擎已变化，未保存工作流')
            return {**result, 'backend_url': backend.url}

    def _editor_package_prompt(self, data):
        package = self.packages.get(data.get('package_id'))
        baseline = data.get('previous_baseline')
        return apply_editor_values(_stored_package_document(package), baseline if isinstance(baseline, dict) and baseline else data.get('values', {}))

    def prepare_editor(self, data):
        """Read-only editing preparation; never use execution readiness here."""
        with self.lock:
            backend = self.backend
            if local_url(data.get('backend_url')) != backend.url:
                raise ValueError('推理引擎已变化，请重新准备编辑文档')
            package_id = data.get('package_id')
            preset = 'preset_request' in data
            if preset:
                if any(key in data for key in ('package_id', 'document', 'source_json', 'fields')):
                    raise ValueError('内置预设编辑不能同时提交其他工作流来源或字段')
                source_kind = 'preset'
            elif any(key in data for key in ('reference_slots', 'input_intents', 'model_intents')):
                raise ValueError('预设结构意图只能用于内置预设编辑')
            elif package_id:
                if any(key in data for key in ('document', 'source_json', 'fields')):
                    raise ValueError('工作流包编辑使用本机完整字段定义，不能同时提交另一份来源')
                document = _stored_package_document(self.packages.get(package_id))
                fields = document['fields']
                source_kind = 'package'
            else:
                document = transport_document({key: data[key] for key in ('document', 'source_json') if key in data})
                fields = data.get('fields', [])
                source_kind = 'api'
        # A disconnected engine is a repair diagnostic, not an excuse to replace
        # the source with a partial graph or to run/upload upstream dependencies.
        try:
            info = self._object_info_for_backend(backend)
        except BackendError:
            info = None
        with self.lock:
            if self.backend is not backend:
                raise ValueError('准备期间推理引擎已变化，请重新进入工作流')
            if preset:
                return prepare_preset_editor(data, info=info, backend_url=backend.url)
            result = prepare_editor_document(document, source_kind=source_kind,
                fields=fields, overrides=data.get('overrides'), pending=data.get('pending'),
                info=info, backend_url=backend.url)
            return {**result, 'source_kind': source_kind, 'source_revision': package_id or None}

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
            current = self.editor_workflows.get(workflow_id)
            if data.get('base_revision', current['revision']) != current['revision']:
                raise ValueError('另一窗口已保存此工作流，请先导出当前修改，再重新打开以免覆盖')
            if not configure:
                # Reject malformed editor state before creating a reusable package.
                validate_editor_document(data.get('document'))
            result = self.apply_interface(prompt, data, current['name'], persist=False)
            if result.get('requires_resolution'):
                return result
            compiled_prompt = result.pop('_compiled_prompt')
            package_document = result.pop('_package_document')
            # Sources join the same metadata rollback as editor revisions. No
            # provenance is inferred from names or an uncommitted revision file.
            with self.packages.lock, self.editor_workflows.lock:
                with self._stage_interface_package(package_document) as (package, publish):
                    result['package'] = package
                    if configure:
                        revision = current
                        report = self.editor_workflows.package_sources(data['package_id'], compiled_prompt,
                                                                       workflow_id=workflow_id)
                        matches = [item for item in report['sources'] if item['backend_url'] == self.backend.url]
                        current_matches = [item for item in matches if item['revision'] == current['revision']]
                        source = current_matches[0] if len(current_matches) == 1 else matches[0] if len(matches) == 1 else None
                        if source:
                            with self.editor_workflows.package_source_transaction(
                                    workflow_id, package['id'], source['revision'], self.backend.url):
                                publish()
                        else:
                            publish()
                    else:
                        with self.editor_workflows.revision_transaction(
                                workflow_id, data.get('document'), compiled_prompt,
                                package_id=package['id'], backend_url=self.backend.url) as revision:
                            publish()
        return {'workflow': revision, **result}

    def package_editor_sources(self, package_id):
        with self.lock, self.packages.lock, self.editor_workflows.lock:
            self.packages.get(package_id)
            return self.editor_workflows.package_sources(package_id)

    def fork_package_editor_source(self, package_id, selection):
        with self.lock, self.packages.lock, self.editor_workflows.lock:
            self.packages.get(package_id)
            return self.editor_workflows.fork_package_source(package_id, selection)

    @contextmanager
    def _stage_interface_package(self, document):
        """Prepare an immutable package; the final link is the only publication."""
        normalized = normalize_document(document)
        raw = encoded(normalized)
        package_id = 'p-' + hashlib.sha256(raw).hexdigest()[:24]
        directory = self.packages.directory
        directory.mkdir(exist_ok=True, parents=True)
        target = self.packages._path(package_id)
        if target.is_file():
            yield self.packages.get(package_id), lambda: None
            return
        if sum(1 for _ in directory.glob('p-*.json')) >= 200:
            raise ValueError('当前工作流包库最多保存 200 个包')
        temporary = None
        try:
            with tempfile.NamedTemporaryFile('wb', prefix='.editor-package-', suffix='.tmp',
                                             dir=directory, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            modified = temporary.stat().st_mtime
            metadata = self.packages._read_metadata().get(package_id, {})
            package = {**normalized, 'id': package_id, 'created_at': modified,
                       'updated_at': modified, 'favorite': metadata.get('favorite', False),
                       'archived': metadata.get('archived', False),
                       'requirements': {'nodes': sorted({node['class_type']
                                                        for node in normalized['prompt'].values()})}}
            # A competing destination is never overwritten. All response data
            # and durable bytes are ready before this last fallible commit step.
            yield package, lambda: os.link(temporary, target)
        finally:
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    # Hidden staging residue must not turn a committed apply
                    # into a reported failure or undo an existing package.
                    pass

    def apply_interface(self, prompt, data, name, *, persist=True):
        """One editable interface contract for native, API, and package imports."""
        previous = self._interface_previous_package(data)
        info = self.object_info(refresh=True)
        migrated = normalize_editor_inputs(prompt, info)
        repaired = apply_missing_interface_values(migrated['prompt'], info, data.get('missing_values', {}), output_nodes=data.get('output_nodes'))
        prompt = repaired['prompt']
        interface = inspect_interface(prompt, info, output_nodes=data.get('output_nodes'),
                                      previous_fields=previous['fields'] if previous else None)
        execution = output_closure(prompt, data.get('output_nodes'), info)
        output_nodes = execution['selected_outputs']
        select_outputs(prompt, output_nodes, info, editing=True)
        candidates = {field['id']: field for field in interface['fields']}
        requested = data.get('fields')
        if requested is None:
            media = [field for field in interface['fields'] if field['type'] in {'image', 'audio', 'video'}]
            # 64 is a recommendation budget, not the interface capacity. Every
            # media input retains its upload entry, including batches over 64.
            requested = media + [field for field in interface['fields']
                                 if field['type'] not in {'image', 'audio', 'video'}
                                 and field.get('recommended')][:max(0, 64 - len(media))]
        if not isinstance(requested, list) or len(requested) > MAX_INTERFACE_FIELDS:
            raise ValueError(f'外层最多开放 {MAX_INTERFACE_FIELDS} 个参数')
        fields = []
        for selection in requested:
            candidate = candidates.get(selection.get('id')) if isinstance(selection, dict) else None
            if candidate is None or any(selection.get(key) != candidate[key] for key in ('node_id', 'input', 'type')):
                raise ValueError('参数接口已改变，请重新选择外层字段')
            fields.append({**candidate, 'label': selection.get('label', candidate['label']),
                           'presentation': selection.get('presentation', candidate.get('presentation', 'control'))})
        selected_ids = {field['id'] for field in fields}
        if any(field['type'] in {'image', 'audio', 'video'} and field['id'] not in selected_ids
               for field in interface['fields']):
            raise ValueError('素材输入必须保留上传入口；可改为侧栏控件，不能取消外露')
        baseline = {f['id']: prompt[f['node_id']]['inputs'][f['input']] for f in fields}
        values = copy.deepcopy(baseline)
        changes = {}
        hidden_fields, hidden_values = {}, {}
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
            # Hiding an external control must not reset its current literal.
            # Still-live bindings use the same three-way merge as visible ones;
            # removed/replaced nodes and explicit moves are never guessed.
            by_binding = {(f['node_id'], f['input'], f['type']): f for f in interface['fields']}
            selected_bindings = {(f['node_id'], f['input'], f['type']) for f in fields}
            hidden_old = [old for old in previous['fields']
                          if (old['node_id'], old['input'], old['type']) in by_binding
                          and (old['node_id'], old['input'], old['type']) not in selected_bindings
                          and mappings.get(old['id']) is None]
            if any(old['type'] in {'image', 'audio', 'video'} for old in hidden_old):
                raise ValueError('素材输入必须保留上传入口；可改为侧栏控件，不能取消外露')
            if hidden_old:
                hidden_candidates = [by_binding[(f['node_id'], f['input'], f['type'])] for f in hidden_old]
                hidden_merge = reconcile_interface(hidden_old, data.get('previous_values', {}),
                                                   fields + hidden_candidates, prompt, data.get('previous_baseline'))
                hidden_fields = {f['id']: f for f in hidden_candidates}
                hidden_values = {key: value for key, value in hidden_merge['values'].items() if key in hidden_fields}
                for conflict in hidden_merge['changes']['conflicts']:
                    conflict['id'] = 'hidden:' + conflict['id']
                    conflict['hidden'] = True
                    conflict['label'] += '（取消外露后保留的值）'
                    changes.setdefault('conflicts', []).append(conflict)
            resolutions = data.get('resolutions', {})
            if changes.get('conflicts'):
                for index, conflict in enumerate(changes['conflicts']):
                    key = str(conflict.get('id', index))
                    choice = resolutions.get(key)
                    if choice not in conflict.get('allowed', ['outer', 'inner']):
                        return {'requires_resolution': True, 'changes': changes}
                    destination = hidden_values if conflict.get('hidden') else values
                    destination[conflict.get('field_id', conflict.get('id'))] = conflict[choice]
        hidden_updates = []
        for field_id, value in hidden_values.items():
            field = hidden_fields[field_id]
            hidden_updates.append({'field': copy.deepcopy(field), 'value': copy.deepcopy(value),
                                   'baseline': copy.deepcopy(prompt[field['node_id']]['inputs'][field['input']])})
            prompt[field['node_id']]['inputs'][field['input']] = copy.deepcopy(value)
        package_document = normalize_document({
            'name': name,
            'description': '通过管理外部接口调整连线入口与侧栏参数；生成前检查当前环境。',
            'prompt': prompt, 'fields': fields,
        })
        edited_prompt = apply_editor_values(package_document, values)
        readiness = validate_editor_prompt(
            {node_id: edited_prompt[node_id] for node_id in execution['node_ids']}, info)
        package = self.packages.save(package_document) if persist else None
        return {'package': package, 'values': values, 'baseline': baseline,
                'output_nodes': output_nodes, 'outputs': interface['outputs'], 'changes': changes,
                'backend_url': self.backend.url, 'readiness': readiness, 'migrations': migrated['migrations'], 'repairs': repaired['repairs'],
                'execution': execution, 'warnings': execution['warnings'],
                'hidden_updates': hidden_updates, 'hidden_updates_reset': data.get('prompt') is not None,
                '_compiled_prompt': prompt,
                **({'_package_document': package_document} if not persist else {})}

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
            if not self.hub_connection.prepare_exit():
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

    def _object_info_for_backend(self, backend):
        info = backend.request("/object_info", timeout=30)
        if not isinstance(info, dict):
            raise BackendError("后端 object_info 格式不正确")
        with self.lock:
            if self.backend is backend:
                self.info = info
                self.info_at = time.monotonic()
        return info

    @contextmanager
    def _transfer_lock(self, key):
        with self.transfer_locks_guard:
            entry = self.transfer_locks.get(key)
            if entry is None:
                entry = {"lock": threading.Lock(), "users": 0}
                self.transfer_locks[key] = entry
            entry["users"] += 1
        entry["lock"].acquire()
        try:
            yield
        finally:
            entry["lock"].release()
            with self.transfer_locks_guard:
                entry["users"] -= 1
                if entry["users"] == 0 and self.transfer_locks.get(key) is entry:
                    self.transfer_locks.pop(key, None)

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

    def _package_execution(self, package, data, info, *, planning=False):
        """One output closure and stored-field identity for planning and compile."""
        document = _stored_package_document(package)
        prompt = apply_planning_values(document, data.get("values", {}))
        execution = output_closure(prompt, data.get('output_nodes'), info)
        active_nodes = set(execution['node_ids'])
        execution['active_field_ids'] = [field['id'] for field in package['fields']
                                         if field['node_id'] in active_nodes]
        if planning:
            validate_planning_fields(package['fields'], prompt, info, active_nodes)
            readiness = validate_editor_prompt({key: prompt[key] for key in execution['node_ids']}, info)
            deferred_media = {(field['node_id'], field['input']) for field in package['fields']
                              if field['id'] in execution['active_field_ids']
                              and field['type'] in {'image', 'audio', 'video'}
                              and not prompt[field['node_id']]['inputs'][field['input']].strip()}
            for issue in readiness['issues']:
                # A fresh engine may have no uploaded files yet. Live field
                # validation above proves these are media upload contracts;
                # planning only selects scope, before upload and strict compile.
                if (issue['code'] not in {'missing_media', 'enum_unavailable'}
                        or (issue['node_id'], issue['input']) not in deferred_media):
                    raise ValueError(issue['message'])
        else:
            prompt = apply_values(document, data.get("values", {}), active_nodes=active_nodes)
            prompt = select_outputs(prompt, execution['selected_outputs'], info)
        return prompt, execution

    def execution_plan(self, data):
        """Confirm a package's live scope without creating any durable work."""
        encoded(data)
        if not isinstance(data, dict) or set(data) != {'backend_url', 'request'}:
            raise ValueError('执行计划需要 backend_url 和 request')
        request = data['request']
        if (not isinstance(request, dict) or request.get('kind') != 'package'
                or set(request) - {'kind', 'package_id', 'values', 'output_nodes', 'editor_backend'}):
            raise ValueError('执行计划目前仅支持工作流包及其已定义请求字段')
        expected_url = local_url(data['backend_url'])
        with self.lock:
            backend = self.backend
            backend_url = local_url(backend.url)
            if expected_url != backend_url:
                raise ValueError('推理引擎已变化，请重新确认执行范围')
        if request.get('editor_backend') and local_url(request['editor_backend']) != backend_url:
            raise ValueError('此工作流参数来自另一推理后端，请切回该后端')
        package = self.packages.get(request.get('package_id'))
        info = self._object_info_for_backend(backend)
        _, execution = self._package_execution(package, request, info, planning=True)
        with self.lock:
            if self.backend is not backend or local_url(backend.url) != backend_url:
                raise ValueError('执行计划期间推理引擎已变化，请重新确认执行范围')
            return {'backend_url': backend_url, 'package_id': package['id'], 'execution': execution}

    def resolve_request(self, data, *, info=None, backend_url=None):
        if not isinstance(data, dict):
            raise ValueError("生成请求须为对象")
        if 'output_nodes' in data and data.get('kind') not in {'package', 'api'}:
            raise ValueError('输出分支选择仅用于工作流包或 API 工作流')
        if data.get("kind") == "package":
            if data.get('editor_backend') and data['editor_backend'] != (backend_url if backend_url is not None else self.backend.url):
                raise ValueError('此原生工作流的参数来自另一推理后端，请切回该后端或重新进入工作流应用参数')
            package = self.packages.get(data.get("package_id"))
            info = self.object_info() if info is None else info
            prompt, execution = self._package_execution(package, data, info)
            return {"kind": "api", "prompt": prompt, "execution": execution}
        if data.get('kind') == 'api':
            prompt = api_prompt(data)
            info = self.object_info() if info is None else info
            execution = output_closure(prompt, data.get('output_nodes'), info)
            return {'kind': 'api', 'prompt': select_outputs(prompt, execution['selected_outputs'], info),
                    'execution': execution}
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
            if 'settings.json' in self.recovery_protected_files:
                raise ValueError('设置原件未成功备份，未保存；请先手动备份或修复文件权限后重启')
            changed = settings["backend_url"] != self.backend.url
            if changed and not self.hub_connection.can_switch_backend(settings['backend_url']):
                raise ValueError('请先暂停 Hub 接收并完成当前操作；待恢复任务只能切回其共同的原推理引擎')
            enable_updates = settings["auto_update"] and not self.settings.get("auto_update", False)
            if changed and any(j["status"] not in TERMINAL and j.get("backend") != settings["backend_url"] for j in self.jobs.values()):
                raise ValueError("有任务尚未结束，请等待任务结束后切换推理后端")
            if changed:
                with _ledger_lock(self):
                    if any(record["state"] in {"pending", "unknown"} and record.get("backend") != settings["backend_url"]
                           for record in _read_ledger(self).values()):
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

    def persist_input_media(self):
        if 'input-media.json' in self.recovery_protected_files:
            raise OSError('输入素材原始记录尚未成功备份，暂停覆盖；请先备份本地工作区')
        records = [{'backend': backend, 'filename': query['filename'],
                    'subfolder': query['subfolder'], 'storage_type': 'input'}
                   for backend, query in self.media.values() if query['type'] == 'input']
        if len(records) > 10000:
            raise ValueError('输入素材登记已达上限，请先备份工作区后整理素材')
        atomic_json(self.data_dir / 'input-media.json', records)

    def check_input_storage(self):
        # Reject known persistence failures before creating a backend file.
        if 'input-media.json' in self.recovery_protected_files:
            raise ValueError('输入素材记录无法安全保存，未上传；请先备份本地工作区、修复磁盘问题并重启客户端')
        if sum(query['type'] == 'input' for _, query in self.media.values()) >= 10000:
            raise ValueError('输入素材登记已达上限，未上传；请先备份工作区后整理素材')

    def register_input_media(self, filename, subfolder="", *, backend=None):
        """Publish an input receipt only after its durable registration succeeds."""
        with self.lock:
            backend = local_url(backend or self.backend.url)
            prior_keys = set(self.media)
            url = self.register_media(filename, subfolder, "input", backend=backend)
            key = url.rsplit("/", 1)[-1]
            try:
                self.persist_input_media()
            except (OSError, ValueError):
                # Only undo this call's new registration. Existing inputs,
                # outputs and registrations made before acquiring the lock stay.
                if key not in prior_keys:
                    self.media.pop(key, None)
                raise
            if self.backend.url == backend:
                self.uploaded.add("/".join(filter(None, [subfolder, filename])))
                self.info_at = 0
            return url

    def _upload(self, data):
        if not isinstance(data.get("data"), str):
            raise ValueError("请上传图片内容")
        try:
            content = base64.b64decode(data["data"], validate=True)
        except (ValueError, binascii.Error):
            raise ValueError("图片编码无效") from None
        return self._upload_content(content)

    def create_local_image_asset(self, data):
        if set(data) != {"name", "data"}:
            raise ValueError("本地图片导入只接受 name 和 data")
        saved = self.local_assets.create(data.get("name"), data.get("data"))
        return {**saved, "url": f"/api/assets/images/{saved['asset_id']}"}

    def media_sync_backend(self, data):
        """Pin a client-selected backend before any explicit asset transfer."""
        with self.lock:
            backend = self.backend
            if "expected_backend" in data and local_url(data["expected_backend"]) != backend.url:
                raise ValueError("素材目标引擎已变化，未上传；请重新选择引擎后同步")
            return backend

    def sync_local_image_asset(self, asset_id, *, expected_backend=None):
        with self.lock:
            if expected_backend is not None and self.backend is not expected_backend:
                raise ValueError("同步期间后端已变化，请重新选择输入素材")
            content, _mime = self.local_assets.read(asset_id)
            result = self._upload_content(content, complete=True)
            return {**result, "asset_id": asset_id}

    def create_local_media_asset(self, name, source, content_length, content_type):
        saved = self.local_media_assets.create_from_stream(name, source, content_length, content_type)
        return {**saved, "url": f"/api/assets/media/{saved['asset_id']}"}

    def sync_local_media_asset(self, asset_id, package_id=None, field_id=None, *, schema=None,
                               expected_backend=None, source=None, values=None, field_ids=None, refresh=False):
        if not isinstance(refresh, bool):
            raise ValueError("媒体同步 refresh 必须是布尔值")
        if field_ids is not None and (field_id is not None or not isinstance(field_ids, list)
                or not 1 <= len(field_ids) <= 4096
                or any(not isinstance(item, str) or not item or len(item) > 80 for item in field_ids)
                or len(set(field_ids)) != len(field_ids)):
            raise ValueError("媒体同步 field_ids 必须是非空、不重复的字段列表，不能与 field_id 同时使用")
        content, mime, media_type = self.local_media_assets.read(asset_id)
        if media_type == "image":
            if package_id is not None or field_id is not None or field_ids is not None or values is not None:
                raise ValueError("图片同步只接受空对象")
            with self.lock:
                if expected_backend is not None and self.backend is not expected_backend:
                    raise ValueError("同步期间后端已变化，请重新选择输入素材")
                result = self._upload_content(content, complete=True)
                return {**result, "asset_id": asset_id, "media_type": media_type}

        if media_type not in {"video", "audio"} or package_id is None or field_id is None and field_ids is None:
            raise ValueError("音视频同步必须绑定工作流包字段")
        with self.lock:
            backend = self.backend
            if expected_backend is not None and backend is not expected_backend:
                raise ValueError("同步期间后端已变化，请重新选择输入素材")
        package = self.packages.get(package_id)
        live_schema = schema if schema is not None else self._object_info_for_backend(backend)
        requested_fields = field_ids if field_ids is not None else [field_id]
        for requested_field in requested_fields:
            validate_package_media_field(_stored_package_document(package), requested_field, live_schema, media_type, values=values)
        binding_receipt = {"package_id": package_id, **({"field_ids": list(field_ids)} if field_ids is not None else {"field_id": field_id})}
        cache_key = (asset_id, backend)

        with self._transfer_lock(("local-media-upload", asset_id, backend.url)):
            with self.lock:
                if self.backend is not backend:
                    raise ValueError("同步期间后端已变化，请重新选择输入素材")
                if source is not None:
                    self._check_media_source_locked(*source)
                cached = self.local_media_upload_cache.get(cache_key)
                if cached is not None and not refresh:
                    media_key = cached.get("url", "").rsplit("/", 1)[-1]
                    registered = self.media.get(media_key)
                    if (registered and registered[0] == backend.url
                            and registered[1].get("type") == "input"
                            and "/".join(filter(None, [registered[1].get("subfolder", ""),
                                                      registered[1].get("filename", "")])) == cached["name"]):
                        self.persist_input_media()
                        self.uploaded.add(cached["name"])
                        self.info_at = 0
                        return {**cached, "asset_id": asset_id, "media_type": media_type,
                                **binding_receipt}
                    self.local_media_upload_cache.pop(cache_key, None)
                self.check_input_storage()

            extension = {"video/mp4": ".mp4", "video/webm": ".webm",
                         "video/quicktime": ".mov", "audio/wav": ".wav",
                         "audio/mpeg": ".mp3", "audio/flac": ".flac", "audio/ogg": ".ogg"}.get(mime)
            if extension is None:
                raise ValueError("音视频媒体格式不受支持")
            name = "prismcanvas-" + uuid.uuid4().hex + extension
            acknowledgement = backend.upload(name, content, mime)
            if (not isinstance(acknowledgement, dict)
                    or not isinstance(acknowledgement.get("name"), str)
                    or not acknowledgement["name"]
                    or acknowledgement.get("type", "input") != "input"):
                raise BackendError("后端未确认音视频输入上传")
            returned_name = acknowledgement["name"]
            subfolder = acknowledgement.get("subfolder", "")
            relative = "/".join(filter(None, [subfolder, returned_name]))
            safe_relative(relative)
            with self.lock:
                if self.backend is not backend:
                    raise ValueError("同步期间后端已变化，请重新选择输入素材")
                if source is not None:
                    self._check_media_source_locked(*source)
                url = self.register_input_media(returned_name, subfolder, backend=backend.url)
                result = {"name": relative, "url": url, "backend": backend.url}
                self.local_media_upload_cache[cache_key] = result
            return {**result, "asset_id": asset_id, "media_type": media_type,
                    **binding_receipt}

    def _check_media_source_locked(self, job_id, media_type, index, output_id, expected_backend,
                                   expected_output, expected_query):
        if self.backend is not expected_backend:
            raise ValueError("结果来源后端已变化，请恢复原后端后重试")
        job = self.jobs.get(job_id)
        if not job:
            raise ValueError("任务不属于此客户端")
        if job.get("status") != "completed":
            raise ValueError("只能复用已完成任务的媒体结果")
        if job.get("backend") != expected_backend.url:
            raise ValueError("结果来自另一个后端，请先恢复原后端连接")
        outputs = [output for output in job.get("outputs", [])
                   if isinstance(output, dict) and output.get("type") == media_type]
        if output_id is not None:
            matches = [item for item in outputs if output_identity(job_id, item) == output_id]
            if len(matches) != 1:
                raise ValueError("媒体输出身份不存在或不唯一")
            output = matches[0]
        else:
            if not 0 <= index < len(outputs):
                raise ValueError("媒体结果索引越界，或此任务没有对应类型输出")
            output = outputs[index]
        url = output.get("url", "")
        if not isinstance(url, str) or not re.fullmatch(r"/api/media/[0-9a-f]{32}", url):
            raise ValueError("结果没有有效的本地媒体登记")
        registered = self.media.get(url.rsplit("/", 1)[-1])
        if not registered:
            raise ValueError("结果未登记或已不可用")
        media_backend, query = registered
        if (media_backend != job["backend"] or query.get("type") not in {"output", "temp"}
                or query.get("filename") != output.get("filename")
                or query.get("subfolder", "") != output.get("subfolder", "")
                or query.get("type") != output.get("storage_type", "output")):
            raise ValueError("结果与任务媒体登记不一致")
        if expected_output is not None and (
                output_identity(job_id, output) != output_identity(job_id, expected_output)
                or output.get("url") != expected_output.get("url")):
            raise ValueError("任务媒体输出在传输期间发生变化")
        if expected_query is not None and query != expected_query:
            raise ValueError("任务媒体登记在传输期间发生变化")
        return output, query

    def media_input(self, job_id, data):
        """Copy an owned completed audio/video file to a live package media field."""
        required = {"output_index", "package_id", "field_id"}
        if (not isinstance(data, dict) or not required <= set(data)
                or set(data) - (required | {"media_type", "output_id"})
                or type(data.get("output_index")) is not int
                or data["output_index"] < 0
                or not isinstance(data.get("media_type", "video"), str)
                or data.get("media_type", "video") not in {"video", "audio"}
                or ("output_id" in data and (not isinstance(data["output_id"], str) or not data["output_id"]))
                or not isinstance(data.get("package_id"), str) or not data["package_id"]
                or not isinstance(data.get("field_id"), str) or not data["field_id"]):
            raise ValueError("媒体结果复用需要 output_index、package_id 和 field_id，不接受 URL 或文件路径")
        index, package_id, field_id = data["output_index"], data["package_id"], data["field_id"]
        media_type, selected_id = data.get("media_type", "video"), data.get("output_id")
        limit = MAX_AUDIO_BYTES if media_type == "audio" else MAX_LOCAL_VIDEO_BYTES
        with self.lock:
            backend = self.backend
            output, query = self._check_media_source_locked(job_id, media_type, index, selected_id,
                                                           backend, None, None)
            output, query = copy.deepcopy(output), copy.deepcopy(query)
        filename = output.get("filename", "")
        extension = Path(filename).suffix.lower()
        mime = ({".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
                if media_type == "video" else {".wav": "audio/wav", ".mp3": "audio/mpeg",
                                               ".flac": "audio/flac", ".ogg": "audio/ogg"}).get(extension)
        if mime is None:
            raise ValueError("只能复用 MP4/WebM/MOV 视频或 WAV/MP3/FLAC/OGG 音频结果")
        filename = safe_relative(query["filename"])
        subfolder = safe_relative(query["subfolder"]) if query.get("subfolder") else ""
        if "/" in filename:
            raise ValueError("结果媒体文件名无效")
        output_id = output_identity(job_id, output)
        # Old index calls retain index lifecycle checks; identity calls tolerate reorder.
        source = (job_id, media_type, index, selected_id, backend, output, query)
        source_key = (backend, job_id, output_id)

        with self._transfer_lock(("job-media-output", *source_key)):
            with self.lock:
                self._check_media_source_locked(*source)
            package = self.packages.get(package_id)
            live_schema = self._object_info_for_backend(backend)
            validate_package_media_field(_stored_package_document(package), field_id, live_schema, media_type)
            with self.lock:
                self._check_media_source_locked(*source)
                asset_id = self.video_output_assets.get(source_key)
            if asset_id:
                try:
                    cached_stream, _size, cached_mime, cached_type = self.local_media_assets.open(asset_id)
                    cached_stream.close()
                    if cached_type != media_type or cached_mime != mime:
                        raise ValueError("缓存媒体类型与任务输出不一致")
                except FileNotFoundError:
                    with self.lock:
                        self.video_output_assets.pop(source_key, None)
                    asset_id = None

            if not asset_id:
                view_query = {"filename": filename, "subfolder": subfolder, "type": query["type"]}
                request = urllib.request.Request(
                    backend.url + "/view?" + urllib.parse.urlencode(view_query),
                    headers={"Accept-Encoding": "identity"})
                spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b", dir=self.data_dir)
                try:
                    with backend.opener.open(request, timeout=120) as response:
                        if response.status != 200 or response.headers.get_all("Content-Range", []):
                            raise BackendError("结果媒体未返回完整响应")
                        encodings = response.headers.get_all("Content-Encoding", [])
                        if len(encodings) > 1 or (encodings and encodings[0].strip().lower() != "identity"):
                            raise BackendError("结果媒体使用了不支持的传输编码")
                        lengths = response.headers.get_all("Content-Length", [])
                        transfers = response.headers.get_all("Transfer-Encoding", [])
                        transfer = transfers[0].strip().lower() if len(transfers) == 1 else ""
                        if (len(transfers) > 1 or transfer not in {"", "identity", "chunked"}
                                or (transfer == "chunked" and lengths)):
                            raise BackendError("结果媒体响应传输格式不明确")
                        if len(lengths) > 1 or (lengths and not re.fullmatch(r"[0-9]{1,20}", lengths[0])):
                            raise BackendError("结果媒体响应长度无效")
                        expected = int(lengths[0]) if lengths else None
                        if expected is not None and not 8 <= expected <= limit:
                            raise BackendError("结果媒体响应大小超限或为空")
                        size = 0
                        while True:
                            chunk = response.read(min(128 * 1024, limit + 1 - size))
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > limit:
                                raise BackendError("结果媒体响应大小超限")
                            spool.write(chunk)
                        if size < 8 or (expected is not None and size != expected):
                            raise BackendError("结果媒体响应读取不完整")
                    spool.seek(0)
                    try:
                        saved = self.local_media_assets.create_from_stream(filename, spool, size, mime)
                    except ValueError as exc:
                        raise BackendError("任务输出不是有效的完整媒体：" + str(exc)) from None
                    asset_id = saved["asset_id"]
                    with self.lock:
                        self._check_media_source_locked(*source)
                        self.video_output_assets[source_key] = asset_id
                except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
                    raise BackendError("无法完整读取任务媒体结果：" + str(exc)) from None
                finally:
                    spool.close()

            with self.lock:
                self._check_media_source_locked(*source)
            result = self.sync_local_media_asset(asset_id, package_id, field_id,
                                                 schema=live_schema, expected_backend=backend, source=source)
            return {**result, "source_job": job_id, "output_index": index, "output_id": output_id}

    def upload_audio(self, data):
        with self.lock:
            self.check_input_storage()
            try:
                content = base64.b64decode(data.get('data', ''), validate=True)
            except (ValueError, TypeError, binascii.Error):
                raise ValueError('音频编码无效') from None
            mime, ext = audio_content_info(content)
            name = 'prismcanvas-' + uuid.uuid4().hex + ext
            result = self.backend.upload(name, content, mime)
            if not isinstance(result, dict) or not result.get('name') or result.get('type', 'input') != 'input':
                raise BackendError('后端未确认音频上传')
            relative = '/'.join(filter(None, [result.get('subfolder', ''), result['name']]))
            safe_relative(relative)
            url = self.register_input_media(result['name'], result.get('subfolder', ''))
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
        self.check_input_storage()
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
        if (not isinstance(result, dict) or not isinstance(result.get("name"), str)
                or not result["name"] or result.get("type", "input") != "input"):
            raise BackendError("后端没有返回有效的图片输入登记，无法交给下游节点")
        returned_name = result.get("name", name)
        subfolder = result.get("subfolder", "")
        url = self.register_input_media(returned_name, subfolder)
        backend_name = f"{subfolder}/{returned_name}" if subfolder else returned_name
        return {"name": backend_name, "url": url, "backend": self.backend.url}

    def image_input(self, job_id, data):
        """Transfer a frozen owned image without holding the job lock over I/O."""
        if (not isinstance(data, dict) or "output_index" not in data
                or set(data) - {"output_index", "output_id"}
                or type(data["output_index"]) is not int or data["output_index"] < 0
                or ("output_id" in data and (not isinstance(data["output_id"], str) or not data["output_id"]))):
            raise ValueError("图片结果复用需要整数 output_index，不接受 URL 或文件路径")
        index = data["output_index"]
        with self.lock:
            backend = self.backend
            output, query = self._check_media_source_locked(job_id, "image", index, data.get("output_id"),
                                                           backend, None, None)
            output, query = copy.deepcopy(output), copy.deepcopy(query)
            source = (job_id, "image", index, data.get("output_id"), backend, output, query)
        if Path(output.get("filename", "")).suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            raise ValueError("只能复用 PNG、JPEG、WebP 图片结果")
        # The registered tuple is the only source; never use caller URLs/paths.
        filename = safe_relative(query["filename"])
        subfolder = safe_relative(query["subfolder"]) if query.get("subfolder") else ""
        if "/" in filename:
            raise ValueError("结果图片文件名无效")
        identity = output_identity(job_id, output)
        with self._transfer_lock(("job-image-output", backend, job_id, identity)):
            with self.lock:
                self._check_media_source_locked(*source)
                self.check_input_storage()
            view_query = {"filename": filename, "subfolder": subfolder, "type": query["type"]}
            request = urllib.request.Request(backend.url + "/view?" + urllib.parse.urlencode(view_query),
                                             headers={"Accept-Encoding": "identity"})
            try:
                with backend.opener.open(request, timeout=30) as response:
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

            # Keep the existing image signature/end-boundary contract. The general
            # _upload_content uses self.backend, so this path uploads explicitly
            # through its frozen backend after releasing the short source check.
            if not 8 <= len(content) <= MAX_IMAGE_BYTES:
                raise ValueError("参考图大小须在 8 字节到 20 MiB 之间")
            if content.startswith(b"\x89PNG\r\n\x1a\n"):
                ext, mime = ".png", "image/png"
                complete = content.endswith(b"\x00\x00\x00\x00IEND\xaeB`\x82")
            elif content.startswith(b"\xff\xd8\xff"):
                ext, mime = ".jpg", "image/jpeg"
                complete = content.endswith(b"\xff\xd9")
            elif content[:4] == b"RIFF" and content[8:12] == b"WEBP":
                ext, mime = ".webp", "image/webp"
                complete = len(content) >= 20 and int.from_bytes(content[4:8], "little") + 8 == len(content)
            else:
                raise ValueError("初版参考图支持 PNG、JPEG、WebP；不接受 SVG 或可执行内容")
            if not complete:
                raise ValueError("结果图片数据不完整，无法作为下游输入")
            with self.lock:
                self._check_media_source_locked(*source)
                self.check_input_storage()
            name = "frameweave-" + uuid.uuid4().hex + ext
            acknowledgement = backend.upload(name, content, mime)
            if (not isinstance(acknowledgement, dict)
                    or not isinstance(acknowledgement.get("name"), str)
                    or not acknowledgement["name"] or acknowledgement.get("type", "input") != "input"):
                raise BackendError("后端没有返回有效的图片输入登记，无法交给下游节点")
            returned_name = safe_relative(acknowledgement["name"])
            returned_folder = acknowledgement.get("subfolder", "")
            returned_folder = safe_relative(returned_folder) if returned_folder else ""
            if "/" in returned_name:
                raise ValueError("媒体路径无效")
            relative = "/".join(filter(None, [returned_folder, returned_name]))
            with self.lock:
                self._check_media_source_locked(*source)
                self.check_input_storage()
                url = self.register_input_media(returned_name, returned_folder, backend=backend.url)
            return {"name": relative, "url": url, "backend": backend.url, "source_job": job_id,
                    "output_index": index, "media_type": "image", "output_id": identity}

    def compile(self, data):
        if not isinstance(data, dict):
            raise ValueError("生成请求须为对象")
        # The status cache is useful for browsing, but never evidence for a new
        # submission. Capture the backend under the same lock as the one fresh
        # schema read, then share that exact schema throughout this compile.
        with self.lock:
            backend, backend_url = self.backend, self.backend.url
            info = self.object_info(refresh=True)
            if self.backend is not backend or backend.url != backend_url:
                raise ValueError('编译期间推理引擎已变化，请重新确认执行范围')
        resolved = self.resolve_request(data, info=info, backend_url=backend_url)
        result = compile_workflow(resolved, info)
        if 'execution' in resolved:
            result.setdefault('summary', {})['execution'] = resolved['execution']
            result['summary']['warnings'] = [item['message'] for item in resolved['execution']['warnings']]
        if data.get("kind") == "package":
            package = self.packages.get(data.get("package_id"))
            result.setdefault("summary", {}).update({"package_id": package["id"], "package_name": package["name"]})
        with self.lock:
            if self.backend is not backend or backend.url != backend_url:
                raise ValueError('编译期间推理引擎已变化，请重新确认执行范围')
            return result

    def submit(self, data):
        with self.lock:
            result = self.compile(data)
            request = {k: copy.deepcopy(v) for k, v in data.items() if k in REQUEST_FIELDS}
            if data.get("kind") == "api":
                request = None  # The exact graph is already stored once below.
            elif data.get("kind") != "package":
                summary = result.get("summary", {})
                for key in ("kind", "models", "seed", "width", "height", "steps", "cfg", "sampler", "scheduler", "reference_roles", "denoise", "loras", "custom_size", "ref_resolution", "refine"):
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
        if 'jobs.json' in self.recovery_protected_files:
            raise ValueError('任务记录无法安全保存，未提交生成；请先备份本地工作区、修复磁盘问题并重启客户端')
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
                progress_warning = persist_progress_identity(self.data_dir, self.client_id)
                if progress_warning and progress_warning not in self.recovery_warnings:
                    self.recovery_warnings.append(progress_warning)
                self.progress.ensure()
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
                   "client_id": self.client_id,
                   "summary": result.get("summary", {}), "error": ""}
            job["node_labels"] = {str(node_id): str(node.get("_meta", {}).get("title") or node.get("class_type", ""))[:120]
                                  for node_id, node in result["prompt"].items()
                                  if isinstance(node, dict) and isinstance(node.get("_meta", {}), dict)}
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
        for output in result.get("outputs", []):
            if isinstance(output, dict):
                output["output_id"] = output_identity(job["id"], output)
        try:
            has_run = (self.data_dir / "runs" / f"{job['id']}.json").is_file()
        except OSError:
            has_run = False
        attempt = job.get("retry_attempt", {})
        result["can_reuse"] = has_run
        result["can_retry"] = bool(has_run and job.get("status") in TERMINAL and
                                   job.get("backend") == self.backend.url and
                                   attempt.get("state") not in {"pending", "unknown"})
        result["can_cancel"] = bool(job.get("status") not in TERMINAL and job.get("backend") == self.backend.url
                                    and job.get("cancellation", {}).get("state") not in CANCEL_PENDING)
        if attempt.get("state") in {"pending", "unknown"}:
            result["retry_warning"] = "上次再次生成的提交结果不确定，请先在原后端核实队列；此记录已停止重提。"
        try:
            result["backend"] = local_url(job.get("backend"))
        except ValueError:
            result.pop("backend", None)
        result.pop("retry_attempt", None)
        result.pop("retry_requests", None)
        result.pop("client_id", None)
        result.update(self.progress.snapshot(job))
        labels = result.pop("node_labels", {})
        label = labels.get(result.get("execution_node")) if isinstance(labels, dict) else None
        if isinstance(label, str):
            result["execution_label"] = label[:120]
        if isinstance(labels, dict) and isinstance(result.get("execution_nodes"), list):
            result["execution_labels"] = {node_id: labels[node_id][:120] for node_id in result["execution_nodes"]
                                          if isinstance(labels.get(node_id), str)}
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
            # Reuse only previously registered input previews from this job's
            # backend. Reading a recipe must not register/fetch guessed paths.
            previews = {}
            for key, (owner, query) in self.media.items():
                if owner == job.get("backend") and query.get("type") == "input":
                    name = "/".join(part for part in (query.get("subfolder"), query.get("filename")) if part)
                    previews[name] = {"name": name, "backend": owner, "url": f"/api/media/{key}"}
            references = [previews[name] for name in request.get("references", [])
                          if isinstance(name, str) and name in previews]
            return {"request": copy.deepcopy(request), "summary": run.get("summary", {}),
                    "job_id": job_id, "backend": job.get("backend"), "references": references,
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
        if 'jobs.json' in self.recovery_protected_files:
            raise OSError('任务原始记录尚未成功备份，暂停覆盖；请先备份本地工作区')
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
                return self.public_job(job)
            if job.get("backend") != self.backend.url:
                raise ValueError("此任务属于另一推理引擎；请查询原任务或切回原引擎后再请求取消")
            if job.get("cancellation", {}).get("state") in CANCEL_PENDING:
                return self.public_job(job)  # Repeated clicks cannot dispatch another cancellation.
            previous = copy.deepcopy(job.get("cancellation"))
            job["cancellation"] = new_cancellation()
            try:
                self.persist_jobs()  # Persist intent before any backend mutation.
            except OSError:
                if previous is None:
                    job.pop("cancellation", None)
                else:
                    job["cancellation"] = previous
                raise
            identifier = job["cancellation"]["id"]
            adapter = self.backend

        def record(state, message, method=None):
            with self.lock:
                if self.jobs.get(job_id) is not job or job.get("cancellation", {}).get("id") != identifier:
                    raise ValueError("原取消记录已变化，请查询原任务")
                # A concurrent poll may already have confirmed a real terminal.
                if job["status"] not in TERMINAL:
                    cancel_state(job, state, message, method)
                try:
                    self.persist_jobs()
                except OSError:
                    job["storage_warning"] = "取消请求记录保存失败；请保留原任务编号并查询原任务，不要重复发起。"
                return self.public_job(job)

        try:
            targeted = adapter.request("/api/jobs/" + urllib.parse.quote(job_id, safe="") + "/cancel", {})
            # ComfyUI's boolean means signal dispatched, not execution terminated.
            if isinstance(targeted, dict) and targeted.get("cancelled") is True:
                return record("requested", "已向原引擎发送定向取消请求，等待此任务的终态记录。", "job_scoped")
            return record("uncertain", "原引擎未确认发送取消；任务可能已经结束，请查询原任务。", "job_scoped")
        except BackendError as exc:
            if not re.match(r"^(?:后端 )?HTTP (404|405)(?::|$)", str(exc)):
                return record("uncertain", "取消请求的回复未确认；保留原任务，先查询原引擎。", "job_scoped")
        except (OSError, ValueError):
            return record("uncertain", "取消请求的回复未确认；保留原任务，先查询原引擎。", "job_scoped")
        try:
            queue = adapter.request("/queue")
            pending = self._queue_ids(queue, "queue_pending")
            if job_id not in pending:
                return record("unavailable", "此引擎不支持安全的定向运行中取消；请在原引擎处理，客户端继续查询。")
            # This exact-ID delete cannot interrupt another job. Its empty reply is
            # not proof of terminal cancellation, even when the next queue is empty.
            record("requesting", "正在请求移除原排队任务，随后核对原引擎历史。", "queue_delete")
            adapter.request("/queue", {"delete": [job_id]})
            return record("requested", "已请求移除排队任务；是否已开始或已生成仍需核对原任务。", "queue_delete")
        except (BackendError, ValueError, OSError):
            return record("uncertain", "取消请求结果待确认，请查询原任务；不会调用共享全局中断。")

    @staticmethod
    def _queue_ids(queue, key):
        values = queue.get(key) if isinstance(queue, dict) else None
        if not isinstance(values, list):
            raise ValueError("引擎队列响应无效")
        return [str(row[1]) for row in values if isinstance(row, (list, tuple)) and len(row) > 1]

    def _history_outputs(self, job_id, backend, item):
        outputs = []
        groups = item.get("outputs", {})
        if not isinstance(groups, dict):
            return outputs
        for output_node_id, node_result in groups.items():
            if not isinstance(node_result, dict):
                continue
            for key in ("images", "gifs", "videos", "video", "audio", "audios"):
                values = node_result.get(key, [])
                if not isinstance(values, list):
                    continue
                for entry_index, entry in enumerate(values):
                    if not isinstance(entry, dict) or not isinstance(entry.get("filename"), str):
                        continue
                    filename = entry["filename"]
                    suffix = Path(filename).suffix.lower()
                    if suffix not in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".webm", ".mov", ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus"):
                        continue
                    subfolder = entry.get("subfolder", "")
                    try:
                        url = self.register_media(filename, subfolder, entry.get("type", "output"), backend)
                    except ValueError:
                        continue
                    kind = "video" if suffix in (".mp4", ".webm", ".mov") else "audio" if suffix in (".wav", ".mp3", ".flac", ".ogg", ".m4a", ".opus") else "image"
                    output = {"url": url, "filename": filename, "subfolder": subfolder, "type": kind,
                              "storage_type": entry.get("type", "output"), "node_id": str(output_node_id),
                              "history_channel": key, "entry_index": entry_index}
                    output["output_id"] = output_identity(job_id, output)
                    outputs.append(output)
        return outputs

    def refresh_job(self, job_id, *, adapter=None, queue=None):
        """Read the owned original backend, without resubmitting or cancelling anything."""
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise ValueError("只能查询由棱光提交的原任务")
            if job["status"] in TERMINAL:
                return self.public_job(job)
            owner = job["backend"]
            adapter = adapter or (self.backend if owner == self.backend.url else Backend(owner))
            if adapter.url != owner:
                raise ValueError("原任务引擎身份不匹配")
        history_available = queue_available = False
        item, running, pending = None, [], []
        try:
            history = adapter.request("/history/" + urllib.parse.quote(job_id, safe=""), timeout=5)
            if isinstance(history, dict):
                history_available, item = True, history.get(job_id)
        except (BackendError, ValueError, OSError):
            pass
        try:
            queue = adapter.request("/queue", timeout=4) if queue is None else queue
            running, pending = self._queue_ids(queue, "queue_running"), self._queue_ids(queue, "queue_pending")
            queue_available = True
        except (BackendError, ValueError, OSError):
            pass
        with self.lock:
            if self.jobs.get(job_id) is not job or job.get("backend") != owner:
                raise ValueError("原任务记录已变化，请重新查询")
            if job["status"] in TERMINAL:
                return self.public_job(job)
            outcome = history_outcome(job_id, item)
            job.pop("queue_position", None)
            if outcome:
                terminal_observed(job, outcome)
                if outcome == "failed":
                    messages = item.get("status", {}).get("messages", [])
                    errors = [v[1].get("exception_message") for v in messages
                              if isinstance(v, list) and len(v) > 1 and v[0] == "execution_error" and isinstance(v[1], dict)] if isinstance(messages, list) else []
                    job["error"] = "\n".join(value for value in errors if isinstance(value, str))[:4000] or "原引擎记录此任务执行失败"
                # An interrupted/error history can omit already registered partial
                # outputs. Merge by stable ownership identity; never erase them.
                outputs = {output_identity(job_id, value): value for value in self._history_outputs(job_id, owner, item)}
                for value in job.get("outputs", []):
                    key = output_identity(job_id, value)
                    outputs.setdefault(key, {**value, "output_id": key})
                job["outputs"] = list(outputs.values())
            elif job_id in running or job_id in pending:
                job.pop("status_warning", None)
                job.pop("error", None)
                job.pop("finished_at", None)
                job["status"] = "running" if job_id in running else "queued"
                if job_id in running:
                    job["started_at"] = job.get("started_at") or time.time()
                else:
                    job["queue_position"] = pending.index(job_id) + 1
            elif (not history_available or not queue_available or job.get("cancellation")
                  or time.time() - job["created_at"] > 15):
                job["status"], job["progress"] = "unknown", None
                job.pop("finished_at", None)
                job["status_warning"] = ("原引擎暂时不可读取；保留原任务，连接恢复后继续核对。" if not history_available or not queue_available
                                         else "原任务不在队列中，且没有终态历史；可能已被移除或引擎已重启，不能据此判定失败或取消。")
                if job.get("cancellation", {}).get("state") in CANCEL_PENDING:
                    cancel_state(job, "uncertain", "取消结果待确认；原任务尚无可靠终态，请保留编号并查询原引擎。")
            try:
                self.persist_jobs()
            except OSError:
                job["storage_warning"] = "原任务状态记录保存失败；请保留编号，不要重复生成。"
            return self.public_job(job)

    def update_jobs(self):
        with self.lock:
            active = [(k, v["backend"]) for k, v in self.jobs.items() if v["status"] not in TERMINAL]
        if not active:
            return
        # Restored tasks also need their event channel, without submitting again.
        self.progress.ensure()
        queues, adapters = {}, {}
        for job_id, owner in active:
            if owner not in adapters:
                adapters[owner] = self.backend if owner == self.backend.url else Backend(owner)
                try:
                    queues[owner] = adapters[owner].request("/queue", timeout=4)
                except (BackendError, ValueError, OSError):
                    queues[owner] = {}  # An unavailable observation, not an empty queue.
            try:
                self.refresh_job(job_id, adapter=adapters[owner], queue=queues[owner])
            except (BackendError, ValueError, OSError):
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
            try:
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
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                # The operation may already be persisted. End this transport;
                # do not send a second response or keep reading this connection.
                self.close_connection = True

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
                    self.respond({"application": "PrismCanvas", "version": __version__, "csrf": app.csrf, "settings": app.settings, "recovery_warnings": app.recovery_warnings,
                                  "presets": [{"id": "draft", "label": "构图试样", "steps": 20, "width": 768, "height": 448, "seconds": 4},
                                              {"id": "balanced", "label": "标准制作", "steps": 20, "width": 1344, "height": 768, "seconds": 5},
                                              {"id": "quality", "label": "细节优先", "steps": 25, "width": 1344, "height": 768, "seconds": 5}]})
                elif path == "/mcp":
                    self.reject({"error": "此 MCP 接口使用 POST；不提供 SSE 订阅"}, 405, extra={"Allow": "POST"})
                elif path == "/api/status":
                    self.respond(app.status())
                elif path == '/api/hub-connection':
                    self.respond(app.hub_connection.snapshot())
                elif path == '/api/performance-plan':
                    self.respond(performance_plan(app.settings['performance_profile'], app.status()))
                elif path == '/api/canvases':
                    params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                    self.respond(app.canvases.list(offset=int(params.get('offset', ['0'])[0]),
                                                  limit=int(params.get('limit', ['200'])[0]),
                                                  query=params.get('q', [''])[0]))
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
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/preview", path):
                    preview = app.progress.preview(path.split("/")[3])
                    self.respond(preview[0], content_type=preview[1])
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/recipe", path):
                    self.respond(app.recipe(path.split("/")[3]))
                elif path == '/api/editor-workflows':
                    self.respond(app.editor_workflows.list())
                elif re.fullmatch(r'/api/editor-workflows/e-[0-9a-f]{24}', path):
                    self.respond(app.editor_workflows.get(path.rsplit('/', 1)[-1]))
                elif path == "/api/packages":
                    params = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query, keep_blank_values=True)
                    for key in ("summary", "refresh"):
                        if key in params and (len(params[key]) != 1 or params[key][0] not in {"0", "1"}):
                            raise ValueError("summary、refresh 查询参数须为单个 0 或 1")
                    summary = params.get("summary", ["0"])[0] == "1"
                    refresh = params.get("refresh", ["0"])[0] == "1"
                    if refresh and not summary:
                        raise ValueError("刷新摘要须同时提供 summary=1")
                    if summary:
                        self.respond({"packages": app.packages.list_summaries(refresh=refresh), "summary": True})
                    else:
                        self.respond({"packages": app.packages.list()})
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}", path):
                    self.respond({"package": app.packages.get(path.rsplit("/", 1)[-1])})
                elif re.fullmatch(r'/api/packages/p-[0-9a-f]{24}/editor-sources', path):
                    self.respond(app.package_editor_sources(path.split('/')[3]))
                elif path.startswith("/api/assets/images/"):
                    match = re.fullmatch(r"/api/assets/images/([0-9a-f]{64})", path)
                    if not match:
                        self.reject({"error": "本地图片标识无效"}, 404)
                        return
                    try:
                        content, mime = app.local_assets.read(match[1])
                    except FileNotFoundError:
                        self.reject({"error": "本地图片不存在"}, 404)
                        return
                    self.respond(content, content_type=mime)
                elif path.startswith("/api/assets/media/"):
                    match = re.fullmatch(r"/api/assets/media/([0-9a-f]{64})", path)
                    if not match:
                        self.reject({"error": "本地媒体标识无效"}, 404)
                        return
                    try:
                        self.stream_local_media(match[1])
                    except FileNotFoundError:
                        self.reject({"error": "本地媒体不存在"}, 404)
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

        def stream_local_media(self, asset_id):
            stream, size, mime, _media_type = app.local_media_assets.open(asset_id)
            with stream:
                status, start, end = 200, 0, size - 1
                ranges = self.headers.get_all("Range", [])
                if ranges:
                    valid = len(ranges) == 1 and len(ranges[0]) <= 128
                    match = re.fullmatch(r"bytes=(\d*)-(\d*)", ranges[0]) if valid else None
                    if match is None or not (match.group(1) or match.group(2)):
                        self.respond(b"", 416, mime, {"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"})
                        return
                    try:
                        if not match.group(1):
                            suffix = int(match.group(2))
                            if suffix <= 0:
                                raise ValueError()
                            start = max(0, size - suffix)
                        else:
                            start = int(match.group(1))
                            end = int(match.group(2)) if match.group(2) else size - 1
                            if start >= size or end < start:
                                raise ValueError()
                            end = min(end, size - 1)
                    except ValueError:
                        self.respond(b"", 416, mime, {"Accept-Ranges": "bytes", "Content-Range": f"bytes */{size}"})
                        return
                    status = 206

                count = end - start + 1
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(count))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-src http://127.0.0.1:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                stream.seek(start)
                remaining = count
                try:
                    while remaining:
                        chunk = stream.read(min(128 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        def upload_local_media(self):
            content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type not in {"image/png", "image/jpeg", "image/webp",
                                    "video/mp4", "video/webm", "video/quicktime"} | AUDIO_MIMES:
                self.reject({"error": "本地媒体 Content-Type 不受支持"}, 415)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.reject({"error": "Content-Length 无效"}, 400)
                return
            limit = (MAX_AUDIO_BYTES if content_type in AUDIO_MIMES else MAX_LOCAL_IMAGE_BYTES
                     if content_type.startswith("image/") else MAX_LOCAL_VIDEO_BYTES)
            if not 8 <= length <= limit:
                self.reject({"error": "本地媒体请求大小超限"}, 413)
                return
            query = urllib.parse.urlsplit(self.path).query
            try:
                values = urllib.parse.parse_qs(query, keep_blank_values=True, strict_parsing=True, max_num_fields=2)
            except ValueError:
                self.reject({"error": "媒体文件名无效"}, 400)
                return
            names = values.get("name", [])
            if set(values) != {"name"} or len(names) != 1 or not names[0] or len(names[0]) > 1024:
                self.reject({"error": "媒体请求只接受一个有效 name"}, 400)
                return
            try:
                self.connection.settimeout(120)
                result = app.create_local_media_asset(names[0], self.rfile, length, content_type)
            except ValueError as exc:
                self.reject({"error": str(exc)}, 400)
                return
            except OSError as exc:
                self.reject({"error": str(exc)}, 502)
                return
            self.respond(result)

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
            if path == "/api/assets/media":
                self.upload_local_media()
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
                elif path == '/api/hub-connection/prepare-offer':
                    result = prepare_offer(app, data)
                elif path.startswith('/api/hub-connection/'):
                    operation = {
                        'grant': 'import_grant', 'probe': 'probe',
                        'read-capability': 'read_capability', 'capabilities': 'save_capability',
                        'remove-capability': 'remove_capability', 'enable-capability': 'enable_capability',
                        'enabled': 'set_enabled', 'inbox': 'inbox', 'step': 'step',
                        'executions': 'executions',
                    }.get(path.removeprefix('/api/hub-connection/'))
                    if operation is None:
                        self.respond({'error': '未找到接入操作'}, 404)
                        return
                    result = getattr(app.hub_connection, operation)(data)
                elif path == '/api/canvases':
                    result = app.canvases.save(data.get('document'))
                elif path == '/api/assets/images':
                    result = app.create_local_image_asset(data)
                elif re.fullmatch(r'/api/assets/images/[0-9a-f]{64}/backend-input', path):
                    if set(data) - {"expected_backend"}:
                        raise ValueError('同步本地图片只接受可选 expected_backend')
                    backend = app.media_sync_backend(data)
                    asset_id = path.split('/')[4]
                    try:
                        result = app.sync_local_image_asset(asset_id, expected_backend=backend)
                    except FileNotFoundError:
                        self.respond({"error": "本地图片不存在"}, 404)
                        return
                elif re.fullmatch(r'/api/assets/media/[0-9a-f]{64}/backend-input', path):
                    binding_keys = set(data) - {"expected_backend", "values", "refresh"}
                    if binding_keys and (binding_keys not in ({"package_id", "field_id"}, {"package_id", "field_ids"})
                                         or not isinstance(data.get("package_id"), str) or not data["package_id"]
                                         or "field_id" in data and (not isinstance(data["field_id"], str) or not data["field_id"])):
                        raise ValueError('媒体同步必须绑定 package_id 与 field_id 或 field_ids')
                    if "values" in data and (not binding_keys or not isinstance(data["values"], dict)):
                        raise ValueError('媒体同步 values 必须是绑定工作流的参数对象')
                    backend = app.media_sync_backend(data)
                    asset_id = path.split('/')[4]
                    try:
                        result = app.sync_local_media_asset(
                            asset_id, data.get("package_id"), data.get("field_id"), expected_backend=backend,
                            values=data.get("values"), field_ids=data.get("field_ids"), refresh=data.get("refresh", False))
                    except FileNotFoundError:
                        self.respond({"error": "本地媒体不存在"}, 404)
                        return
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
                    result = app.editor_workflows.create(data.get('name'), document, data.get('source_json'),
                                                         origin=data.get('source_kind', 'native'))
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
                elif path == "/api/editor-prepare":
                    result = app.prepare_editor(data)
                elif path == "/api/interfaces/inspect":
                    carrier = {key: value for key, value in data.items() if key not in {'output_nodes', 'missing_values', 'previous_package_id'}}
                    document = None if data.get('package_id') else transport_document(carrier)
                    prompt = app._editor_package_prompt(data) if data.get('package_id') else api_prompt(document)
                    previous = app._interface_previous_package(data)
                    info = app.object_info(refresh=True)
                    migrated = normalize_editor_inputs(prompt, info)
                    repaired = apply_missing_interface_values(migrated['prompt'], info, data.get('missing_values', {}), output_nodes=data.get('output_nodes'))
                    result = validate_inspection_result({**inspect_interface(repaired['prompt'], info, output_nodes=data.get('output_nodes'),
                                                 previous_fields=previous['fields'] if previous else None),
                              'migrations': migrated['migrations'], 'repairs': repaired['repairs']})
                elif path == "/api/interfaces/apply":
                    with app.lock:
                        if data.get('backend_url') != app.backend.url:
                            raise ValueError('推理引擎已变化，请重新编译接口')
                        prompt = app._editor_package_prompt(data) if data.get('package_id') else api_prompt(data)
                        result = app.apply_interface(prompt, data, data.get('name', '我的工作流'))
                        result.pop('_compiled_prompt', None)
                elif path == "/api/packages/inspect":
                    result = app.inspect_package(data)
                elif path == "/api/h3-reference/prepare":
                    result = app.prepare_h3_reference(data)
                elif path == "/api/packages":
                    result = {"package": app.packages.save(transport_document(data, allow_bare=True))}
                elif re.fullmatch(r'/api/packages/p-[0-9a-f]{24}/fork-editor-source', path):
                    result = app.fork_package_editor_source(path.split('/')[3], data)
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}/export", path):
                    result = app.packages.export_transport(path.split("/")[3])
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}/apply", path):
                    resolved = app.resolve_request({**data, 'kind': 'package', 'package_id': path.split('/')[3]})
                    result = {"prompt": resolved['prompt'], 'execution': resolved['execution']}
                elif re.fullmatch(r"/api/packages/p-[0-9a-f]{24}/metadata", path):
                    result = {"package": app.packages.update_metadata(path.split("/")[3], data)}
                elif path == "/api/execution-plan":
                    result = app.execution_plan(data)
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
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/refresh", path):
                    if data:
                        raise ValueError("任务刷新不接受生成参数")
                    result = app.refresh_job(path.split("/")[3])
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/image-input", path):
                    result = app.image_input(path.split("/")[3], data)
                elif re.fullmatch(r"/api/jobs/[\w-]{1,100}/media-input", path):
                    result = app.media_input(path.split("/")[3], data)
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
