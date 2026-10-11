"""Optional local Hub worker manager. Import/probe never claim or generate.

Configuration and SQLite contain private grant/lease data and stay in data_dir.
Only explicit opt-in starts polling; snapshots perform no network operations.
"""
import copy
import os
import re
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

from .backend import local_url
from .configuration_recovery import read_config
from .hub_execution import NativeApp, Worker
from .hub_execution_contract import (BINDING_PREFIX, EnabledCapability,
    binding_fingerprint, canonical, sha, strict_json, require_uuid)
from .hub_execution_store import WorkerStore
from .hub_execution_transport import HubTransport
from .packages import validate_value

SCHEMA = 'prismcanvas.hub-connection/1'
PROFILE_SCHEMA = 'prismcanvas.hub-capability/1'
MAX_CONFIG = 2 * 1024 * 1024
MESSAGES = {
    'invalid_request': '接入参数格式不正确。', 'connection_required': '请先导入工作端授权。',
    'connection_busy': '接入操作正在进行，请完成后再修改能力或连接。',
    'connection_paused': '工作端已暂停；不会领取新任务或提交新的原生生成。',
    'connection_unavailable': '接入核对未完成，请检查原 Hub 服务、工作区和授权。',
    'connection_changed': '私有接入配置已变化，请保留原件并重新打开客户端。',
    'configuration_blocked': '私有接入配置或账本无法安全读取；原件保留，未覆盖或重新建立。',
    'storage_unavailable': '私有接入记录保存失败，未更换配置，请检查存储。',
    'unfinished_connection': '仍有未完成接入记录，不能更换作用域；请先恢复原任务或完成报告。',
    'unfinished_capability': '此能力仍有未完成任务，不能修改或删除冻结绑定。',
    'capability_invalid': '能力绑定不符合本地工作流包或固定声明，请重新准备并核对。',
    'capability_missing': '没有找到对应的本地能力配置。',
    'capability_disabled': '对应能力尚未明确启用，未领取任务。',
    'connection_enabled': '请先暂停 Hub 工作端，再退出或更换引擎。',
}


class ConnectionError(ValueError):
    def __init__(self, code):
        self.code = code if code in MESSAGES else 'connection_unavailable'
        super().__init__(MESSAGES[self.code])


def _fields(data, required=(), optional=()):
    if type(data) is not dict or not set(required) <= set(data) or set(data) - set(required) - set(optional):
        raise ConnectionError('invalid_request')


def _cap_id(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{32}', value):
        raise ConnectionError('capability_invalid')
    return value


def _scope(grant, binding):
    return sha(canonical({'binding': binding, 'workspace': grant['workspace_root'],
                          'install_root': grant['connection']['install_root']}))


class _GatedHub:
    def __init__(self, manager, hub, store):
        self.manager, self.hub, self.store = manager, hub, store
        self.binding = hub.binding

    def __getattr__(self, name):
        return getattr(self.hub, name)

    def claim(self, execution_id, claim_request_id):
        # Admission is serialized with pause; an already admitted network call
        # may finish, but pause prevents its subsequent first native submission.
        with self.manager._lock:
            record = self.store.get(execution_id)
            if not self.manager._enabled and not (record and record.get('claim')):
                raise ConnectionError('connection_paused')
            if record and not record.get('claim') and not any(
                    profile['enabled'] and profile['capability_id'] == record['identity']['capability_id']
                    and sha(profile['declaration_text'].encode('utf-8')) == record['identity']['declaration_sha256']
                    for profile in self.manager._profiles):
                raise ConnectionError('capability_disabled')
            if self.manager.app.closed.is_set() or getattr(self.manager.app, 'exit_pending', False):
                raise ConnectionError('connection_paused')
        return self.hub.claim(execution_id, claim_request_id)


class _GatedStore:
    def __init__(self, manager, store):
        self.manager, self.store = manager, store

    def __getattr__(self, name):
        return getattr(self.store, name)

    def begin_native(self, execution_id):
        # Persisted admission is the commit point. Once it returns True, submit
        # may finish even if pause arrives; no wrapper rejects it after the mark.
        with self.manager._lock:
            if not self.manager._enabled or self.manager.app.closed.is_set() or getattr(self.manager.app, 'exit_pending', False):
                raise ConnectionError('connection_paused')
            record = self.store.get(execution_id)
            if not record or not any(profile['enabled']
                    and profile['capability_id'] == record['identity']['capability_id']
                    and sha(profile['declaration_text'].encode('utf-8')) == record['identity']['declaration_sha256']
                    for profile in self.manager._profiles):
                raise ConnectionError('capability_disabled')
            return self.store.begin_native(execution_id)


class HubConnection:
    def __init__(self, app):
        self.app = app
        self._lock, self._operation_lock = threading.RLock(), threading.Lock()
        self._directory = Path(app.data_dir) / 'hub-worker'
        self._path = self._directory / 'connection.json'
        self._grant = self._hub = self._store = self._scope = None
        self._profiles = []
        self._enabled = self._busy = self._blocked = False
        self._error = None
        self._config_hash = None
        self._thread = None
        self._pause_epoch = 0
        self._recovery_after = self._inbox_after = None
        try:
            raw = read_config(self._path, MAX_CONFIG)
        except FileNotFoundError:
            return  # Default construction creates no file, thread or network I/O.
        except (ValueError, OSError):
            self._block()
            return
        try:
            config = strict_json(raw.decode('utf-8'), MAX_CONFIG)
            _fields(config, ('schema', 'grant', 'enabled', 'capabilities'))
            if config['schema'] != SCHEMA or type(config['enabled']) is not bool or type(config['capabilities']) is not list or len(config['capabilities']) > 32:
                raise ConnectionError('configuration_blocked')
            grant, hub = self._validate_grant(canonical(config['grant']).decode('utf-8'))
            profiles = [self._validate_profile(value) for value in config['capabilities']]
            if len({value['capability_id'] for value in profiles}) != len(profiles):
                raise ConnectionError('configuration_blocked')
            scope = _scope(grant, hub.binding)
            # Existing configuration requires its original DB; never rebuild a
            # missing journal as an empty one and adopt claimed remote work.
            store_path = self._directory / (scope + '.sqlite3')
            if not store_path.is_file():
                raise ConnectionError('configuration_blocked')
            store = WorkerStore(store_path, hub.binding)
            self._grant, self._hub, self._store, self._scope = grant, hub, store, scope
            self._profiles, self._enabled = profiles, config['enabled']
            self._config_hash = sha(raw)
        except Exception:
            self._block()
            return
        if self._enabled:
            self._start_thread()

    def _block(self):
        self._blocked, self._enabled = True, False
        self._error = {'code': 'configuration_blocked', 'message': MESSAGES['configuration_blocked']}

    def _validate_grant(self, text):
        try:
            grant = strict_json(text, 32768)
            hub = HubTransport(grant)
            subject = grant['subject']
            if (not re.fullmatch(r'[A-Za-z0-9_.:-]{1,120}', subject)
                    or re.fullmatch(r'[A-Za-z0-9_-]{43}|[a-fA-F0-9]{64}', subject)):
                raise ValueError()
            return grant, hub
        except Exception:
            raise ConnectionError('invalid_request') from None

    def _validate_profile(self, value):
        try:
            _fields(value, ('schema', 'capability_id', 'declaration_text', 'backend', 'template', 'bindings', 'enabled'))
            if value['schema'] != PROFILE_SCHEMA or type(value['enabled']) is not bool:
                raise ValueError()
            _cap_id(value['capability_id'])
            if len(canonical(value)) > 128 * 1024:
                raise ValueError()
            template, bindings = value['template'], value['bindings']
            _fields(template, ('kind', 'package_id', 'values'), ('output_nodes',))
            if template['kind'] != 'package' or type(template['values']) is not dict or type(bindings) is not dict or len(bindings) > 128:
                raise ValueError()
            package = self.app.packages.get(template['package_id'])
            fields = {field['id']: field for field in package['fields']}
            if set(template['values']) - fields.keys():
                raise ValueError()
            for name, item in template['values'].items():
                validate_value(fields[name], item, template=True)
            if 'output_nodes' in template:
                outputs = template['output_nodes']
                if (type(outputs) is not list or not 1 <= len(outputs) <= 512 or any(type(item) is not str for item in outputs)
                        or len(set(outputs)) != len(outputs) or set(outputs) - package['prompt'].keys()):
                    raise ValueError()
            declaration = strict_json(value['declaration_text'], 32768)
            properties = declaration['inputs']['properties']
            if type(properties) is not dict or set(properties) != set(bindings):
                raise ValueError()
            sample, targets = {}, set()
            for key, path in bindings.items():
                if (type(path) is not list or len(path) != 2 or path[0] != 'values' or type(path[1]) is not str
                        or path[1] not in fields or path[1] in targets or path[1] not in template['values']
                        or fields[path[1]]['type'] not in {'text', 'integer', 'number', 'boolean', 'select'}
                        or properties[key].get('type') not in {'string', 'integer', 'number', 'boolean'}):
                    raise ValueError()
                targets.add(path[1])
                sample[key] = template['values'][path[1]]
            markers = [v for v in declaration.get('constraints', []) if isinstance(v, str) and v.startswith(BINDING_PREFIX)]
            if markers != [BINDING_PREFIX + binding_fingerprint(value['backend'], template, bindings)]:
                raise ValueError()
            # Exercise the exact same closed schema/binding compiler used at claim.
            capability = self._capability(value)
            raw = canonical(sample).decode('utf-8')
            capability.prepare({'capability_id': value['capability_id'], 'input_json': raw,
                'input_sha256': sha(raw.encode()), 'declaration_text': value['declaration_text'],
                'declaration_sha256': sha(value['declaration_text'].encode('utf-8'))})
            if value['backend'] != local_url(value['backend']):
                raise ValueError()
            return copy.deepcopy(value)
        except Exception:
            raise ConnectionError('capability_invalid') from None

    @staticmethod
    def _capability(profile):
        return EnabledCapability(profile['capability_id'], profile['declaration_text'],
                                 profile['backend'], profile['template'], profile['bindings'])

    def _config(self, **changes):
        value = {'schema': SCHEMA, 'grant': self._grant, 'enabled': self._enabled, 'capabilities': self._profiles}
        return copy.deepcopy(dict(value, **changes))

    def _write(self, config):
        if self._blocked:
            raise ConnectionError('configuration_blocked')
        encoded = canonical(config)
        if len(encoded) > MAX_CONFIG:
            raise ConnectionError('invalid_request')
        temp = None
        try:
            self._directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                existing = read_config(self._path, MAX_CONFIG)
            except FileNotFoundError:
                existing = None
            if (sha(existing) if existing is not None else None) != self._config_hash:
                self._block()
                raise ConnectionError('connection_changed')
            descriptor, name = tempfile.mkstemp(prefix='.connection-', suffix='.tmp', dir=self._directory)
            temp = Path(name)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self._path)
            self._config_hash = sha(encoded)
        except ConnectionError:
            raise
        except (ValueError, OSError):
            raise ConnectionError('storage_unavailable') from None
        finally:
            if temp is not None:
                temp.unlink(missing_ok=True)

    @contextmanager
    def _operation(self, *, configured=True):
        if not self._operation_lock.acquire(blocking=False):
            raise ConnectionError('connection_busy')
        try:
            with self._lock:
                if self._blocked:
                    raise ConnectionError('configuration_blocked')
                if configured and self._hub is None:
                    raise ConnectionError('connection_required')
                if self.app.closed.is_set() or getattr(self.app, 'exit_pending', False):
                    raise ConnectionError('connection_paused')
                self._busy = True
            try:
                yield
            except ConnectionError:
                raise
            except Exception:
                raise ConnectionError('connection_unavailable') from None
            else:
                with self._lock:
                    self._error = None
        except ConnectionError as error:
            with self._lock:
                self._error = {'code': error.code, 'message': str(error)}
            raise
        finally:
            with self._lock:
                self._busy = False
            self._operation_lock.release()

    def snapshot(self):
        with self._lock:
            connection = None
            if self._grant:
                connection = {'host': '127.0.0.1', 'port': self._grant['connection']['port'],
                    'subject': self._grant['subject'], 'scope': ' / '.join(self._hub.binding[key][:8] for key in
                        ('execution_authority_id', 'ledger_epoch', 'workspace_binding_revision'))}
            capabilities = []
            for profile in self._profiles:
                declaration = strict_json(profile['declaration_text'], 32768)
                capabilities.append({'capability_id': profile['capability_id'], 'name': str(declaration.get('name', '工作流能力'))[:160],
                    'package_id': profile['template']['package_id'], 'enabled': profile['enabled'],
                    'declaration_sha256': sha(profile['declaration_text'].encode('utf-8'))})
            executions = {'items': [], 'has_more': False, 'next_after_execution_id': None}
            if self._store and not self._blocked:
                try:
                    executions = self._store.summaries()
                except Exception:
                    self._block()
            return {'configured': connection is not None, 'enabled': self._enabled, 'busy': self._busy,
                'status': 'blocked' if self._blocked else 'busy' if self._busy else 'enabled' if self._enabled else 'paused' if connection else 'unconfigured',
                'last_error': copy.deepcopy(self._error), 'connection': connection, 'capabilities': capabilities,
                'executions': executions}

    def import_grant(self, data):
        _fields(data, ('grant_json',))
        with self._operation(configured=False):
            grant, hub = self._validate_grant(data['grant_json'])
            scope = _scope(grant, hub.binding)
            if self._store and scope != self._scope and self._store.has_unfinished():
                raise ConnectionError('unfinished_connection')
            hub.describe()
            hub.inbox(1)  # Authenticate worker scope without a claim.
            store = self._store if scope == self._scope else WorkerStore(self._directory / (scope + '.sqlite3'), hub.binding)
            profiles = self._profiles if scope == self._scope else []
            with self._lock:
                self._write(self._config(grant=grant, enabled=False, capabilities=profiles))
                self._grant, self._hub, self._store, self._scope = grant, hub, store, scope
                self._profiles, self._enabled = profiles, False
                self._recovery_after = self._inbox_after = None
        return self.snapshot()

    def probe(self, data=None):
        _fields({} if data is None else data)
        with self._operation():
            self._hub.describe()
            self._hub.inbox(1)
        return self.snapshot()

    def read_capability(self, data):
        _fields(data, ('capability_id',))
        with self._operation():
            result = self._hub.read_capability(_cap_id(data['capability_id']))
        return result

    def save_capability(self, data):
        _fields(data, ('profile_json',))
        with self._operation():
            try:
                profile = self._validate_profile(strict_json(data['profile_json'], 128 * 1024))
            except Exception:
                raise ConnectionError('capability_invalid') from None
            if profile['enabled']:
                raise ConnectionError('capability_invalid')  # Separate explicit opt-in.
            identifier = profile['capability_id']
            existing = next((p for p in self._profiles if p['capability_id'] == identifier), None)
            if existing and dict(existing, enabled=False) != profile and self._store.has_unfinished(identifier):
                raise ConnectionError('unfinished_capability')
            if not existing and len(self._profiles) >= 32:
                raise ConnectionError('capability_invalid')
            remote = self._hub.read_capability(identifier)
            if remote['declaration_text'] != profile['declaration_text'] or remote['client_id'] != self._hub.binding['client_id']:
                raise ConnectionError('capability_invalid')
            profiles = [p for p in self._profiles if p['capability_id'] != identifier] + [profile]
            with self._lock:
                self._write(self._config(capabilities=profiles))
                self._profiles = profiles
        return self.snapshot()

    def remove_capability(self, data):
        _fields(data, ('capability_id',))
        with self._operation():
            identifier = _cap_id(data['capability_id'])
            if self._store.has_unfinished(identifier):
                raise ConnectionError('unfinished_capability')
            profiles = [p for p in self._profiles if p['capability_id'] != identifier]
            if len(profiles) == len(self._profiles):
                raise ConnectionError('capability_missing')
            with self._lock:
                self._write(self._config(capabilities=profiles))
                self._profiles = profiles
        return self.snapshot()

    def enable_capability(self, data):
        _fields(data, ('capability_id', 'enabled'))
        if type(data['enabled']) is not bool:
            raise ConnectionError('invalid_request')
        with self._operation():
            identifier = _cap_id(data['capability_id'])
            profiles = copy.deepcopy(self._profiles)
            target = next((p for p in profiles if p['capability_id'] == identifier), None)
            if target is None:
                raise ConnectionError('capability_missing')
            if data['enabled']:
                self._validate_profile(target)
                remote = self._hub.read_capability(identifier)
                if remote['declaration_text'] != target['declaration_text']:
                    raise ConnectionError('capability_invalid')
            target['enabled'] = data['enabled']
            with self._lock:
                self._write(self._config(capabilities=profiles))
                self._profiles = profiles
        return self.snapshot()

    def set_enabled(self, data):
        _fields(data, ('enabled',))
        if type(data['enabled']) is not bool:
            raise ConnectionError('invalid_request')
        if not data['enabled']:
            with self._lock:
                if self._blocked:
                    raise ConnectionError('configuration_blocked')
                if not self._hub:
                    raise ConnectionError('connection_required')
                self._write(self._config(enabled=False))
                self._enabled = False
                self._pause_epoch += 1
            return self.snapshot()
        with self._operation():
            with self._lock:
                pause_epoch = self._pause_epoch
            self._hub.describe()
            self._hub.inbox(1)
            if not any(p['enabled'] for p in self._profiles) and not self._store.has_unfinished():
                raise ConnectionError('capability_disabled')
            with self.app.lock, self._lock:
                if self.app.closed.is_set() or getattr(self.app, 'exit_pending', False) or self._pause_epoch != pause_epoch:
                    raise ConnectionError('connection_paused')
                self._write(self._config(enabled=True))
                self._enabled = True
        self._start_thread()
        return self.snapshot()

    @staticmethod
    def _public_inbox(page):
        return {key: copy.deepcopy(page[key]) for key in ('has_more', 'next_after_execution_id')} | {
            'items': [{key: item.get(key) for key in ('execution_id', 'capability_id', 'dispatch_state', 'provider_state', 'cancel_requested')}
                      for item in page['items']], 'claim_performed': False, 'native_work_started': False}

    def inbox(self, data=None):
        data = {} if data is None else data
        _fields(data, optional=('limit', 'after_execution_id'))
        with self._operation():
            self._hub.describe()
            page = self._hub.inbox(data.get('limit', 10), data.get('after_execution_id'))
        return self._public_inbox(page)

    def _advance(self, execution_id):
        require_uuid(execution_id)
        record = self._store.get(execution_id)
        if not self._enabled and not record:
            raise ConnectionError('connection_paused')
        capabilities = [self._capability(p) for p in self._profiles if p['enabled']]
        worker = Worker(_GatedStore(self, self._store), _GatedHub(self, self._hub, self._store), NativeApp(self.app), capabilities)
        return worker.step(execution_id)

    def step(self, data):
        _fields(data, ('execution_id',))
        with self._operation():
            result = self._advance(data['execution_id'])
        return result

    def has_unfinished(self):
        with self._lock:
            if self._blocked:
                return True  # Corruption cannot authorize discarding ownership.
            return bool(self._store and self._store.has_unfinished())

    def executions(self, data=None):
        """Local, redacted pages; available while paused and performs no network I/O."""
        data = {} if data is None else data
        _fields(data, optional=('limit', 'after_execution_id', 'unfinished_only'))
        limit, after, unfinished = data.get('limit', 25), data.get('after_execution_id'), data.get('unfinished_only', False)
        if type(limit) is not int or not 1 <= limit <= 25 or type(unfinished) is not bool:
            raise ConnectionError('invalid_request')
        try:
            if after is not None:
                require_uuid(after)
        except ValueError:
            raise ConnectionError('invalid_request') from None
        with self._lock:
            if self._blocked:
                raise ConnectionError('configuration_blocked')
            if self._store is None:
                return {'items': [], 'has_more': False, 'next_after_execution_id': None}
            try:
                return self._store.summaries(limit, after, unfinished_only=unfinished)
            except Exception:
                self._block()
                raise ConnectionError('configuration_blocked') from None

    def can_switch_backend(self, target):
        """No network/App lock: paused recovery may return to its frozen backend."""
        with self._lock:
            if self._blocked or self._enabled or self._busy:
                return False
            try:
                target = local_url(target)
                if self._store is None:
                    return True
                after = None
                while True:
                    page = self._store.summaries(25, after, unfinished_only=True)
                    for item in page['items']:
                        record = self._store.get(item['execution_id'])
                        if not record or record['backend'] is None or local_url(record['backend']) != target:
                            return False
                    if not page['has_more']:
                        return True
                    after = page['next_after_execution_id']
            except Exception:
                # Corruption or unresolved intent must not authorize an engine swap.
                return False

    def prepare_exit(self):
        with self._lock:
            if self._busy:
                raise ConnectionError('connection_busy')
            if self._enabled:
                raise ConnectionError('connection_enabled')
            if self.has_unfinished():
                raise ConnectionError('unfinished_connection')
        return True

    def _tick(self):
        with self._operation():
            if not self._enabled:
                return
            page = self._store.summaries(1, self._recovery_after, unfinished_only=True)
            if page['items']:
                item = page['items'][0]
                self._recovery_after = item['execution_id']
                return self._advance(item['execution_id'])
            self._recovery_after = None
            self._hub.describe()
            page = self._hub.inbox(25, self._inbox_after)
            self._inbox_after = page['next_after_execution_id']
            enabled = {(p['capability_id'], sha(p['declaration_text'].encode('utf-8'))) for p in self._profiles if p['enabled']}
            for item in page['items']:
                if (item['capability_id'], item['declaration_sha256']) in enabled and not self._store.get(item['execution_id']):
                    return self._advance(item['execution_id'])

    def _start_thread(self):
        with self._lock:
            if not self._enabled or self._thread and self._thread.is_alive():
                return
            def loop():
                try:
                    while not self.app.closed.wait(2):
                        with self._lock:
                            if not self._enabled:
                                return
                        try:
                            self._tick()
                        except ConnectionError:
                            pass  # Only static, redacted error state is retained.
                finally:
                    with self._lock:
                        self._thread = None
                        if self._enabled and not self.app.closed.is_set():
                            self._start_thread()
            self._thread = threading.Thread(target=loop, name='prism-hub-worker', daemon=True)
            self._thread.start()
