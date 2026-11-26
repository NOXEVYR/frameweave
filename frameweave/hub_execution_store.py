"""Private, optional worker journal. No transport, UI, or native execution.

Records contain leases and raw inputs: callers must not expose them in responses,
logs, package exports, or model prompts. SQLite transactions never span network
calls; execution_lock is the separate cross-process operation guard.
"""

import copy
import json
import math
import os
import re
import sqlite3
import tempfile
import uuid
from contextlib import closing, contextmanager
from pathlib import Path


MAX_EXECUTIONS = 2000
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_RECORD_BYTES = 2 * 1024 * 1024
MAX_INPUT_BYTES = 16000
MAX_DATABASE_BYTES = 64 * 1024 * 1024
BUSY_TIMEOUT_MS = 2000
APPLICATION_ID = 0x50435731
SCHEMA_VERSION = 1
TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
STATES = TERMINAL | {"not_started", "submitting", "running", "uncertain"}
BINDING_KEYS = {"execution_authority_id", "ledger_epoch", "workspace_binding_revision", "client_id"}
SECRET_KEYS = {"lease_token", "authorization", "token", "access_token", "refresh_token", "api_key", "password", "secret"}
RECORD_KEYS = {"execution_id", "identity", "claim_request_id", "provider_request_id", "report_submission_id",
               "native_attempted", "job_id", "claim", "claim_guard", "native_request", "backend",
               "observation", "last_observation", "receipt", "report", "reported", "finished"}


class StoreError(ValueError):
    """Static, non-sensitive error suitable for a local operator."""


class StoreBusy(StoreError):
    """Another process owns this execution; never implies a failed submission."""


def _canonical(value, limit=MAX_RECORD_BYTES):
    stack = [(value, 0)]
    count = 0
    try:
        while stack:
            item, depth = stack.pop()
            count += 1
            if depth > 64 or count > 100000:
                raise StoreError("执行账本 JSON 超过结构上限")
            if type(item) is dict:
                if any(type(key) is not str for key in item):
                    raise StoreError("执行账本只接受标准 JSON 数据")
                stack.extend((child, depth + 1) for child in item.values())
            elif type(item) is list:
                stack.extend((child, depth + 1) for child in item)
            elif type(item) is float:
                if not math.isfinite(item):
                    raise StoreError("执行账本只接受有限数值")
            elif item is not None and type(item) not in (str, int, bool):
                raise StoreError("执行账本只接受标准 JSON 数据")
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if len(encoded.encode("utf-8")) > limit:
            raise StoreError("执行账本记录超过大小上限")
        return encoded
    except (TypeError, ValueError, UnicodeError, OverflowError, RecursionError) as error:
        if isinstance(error, StoreError):
            raise
        raise StoreError("执行账本 JSON 无效") from None


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise StoreError("执行账本 JSON 含重复字段")
        result[key] = value
    return result


def _decode(text):
    try:
        if type(text) is not str or len(text.encode("utf-8")) > MAX_RECORD_BYTES:
            raise StoreError("执行账本记录超过大小上限")
        result = json.loads(text, object_pairs_hook=_pairs)
        _canonical(result)
        return result
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise StoreError("执行账本记录损坏；请保留原记录核对，未自动重建") from None


def _uuid(value):
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ValueError()
        return value
    except (TypeError, ValueError, AttributeError):
        raise StoreError("执行账本身份必须为规范 UUID") from None


def _no_secrets(value):
    stack = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if any(key.lower() in SECRET_KEYS for key in item):
                raise StoreError("上报数据不得包含私有凭据")
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)


def _results(value):
    if type(value) is not list or len(value) > 512:
        raise StoreError("成果清单无效")
    if any(type(item) is not dict or type(item.get("result_id")) is not str or not item["result_id"] for item in value):
        raise StoreError("成果清单缺少稳定身份")
    if len({item["result_id"] for item in value}) != len(value):
        raise StoreError("成果清单身份重复")
    return sorted(copy.deepcopy(value), key=lambda item: item["result_id"])


def _outcome(payload):
    outcome = payload.get("outcome", {})
    if type(outcome) is not dict or set(outcome) - {"error_code", "cancel_evidence"}:
        raise StoreError("执行结果分类无效")
    outcome = copy.deepcopy(outcome)
    for key in ("error_code", "cancel_evidence"):
        if key in payload:
            if key in outcome and _canonical(outcome[key]) != _canonical(payload[key]):
                raise StoreError("执行结果分类冲突")
            outcome[key] = payload[key]
    return outcome


def _semantic(payload):
    return _canonical({"provider_state": payload.get("provider_state"),
                       "provider_request_id": payload.get("provider_request_id"),
                       "results": _results(payload.get("results", [])), "outcome": _outcome(payload)})


def _check_transition(previous, next_state):
    if type(next_state) is not str or next_state not in STATES:
        raise StoreError("执行观察状态无效")
    allowed = {"not_started": {"not_started", "submitting"},
               "submitting": {"submitting", "running", "uncertain", *TERMINAL},
               "running": {"running", "uncertain", *TERMINAL},
               "uncertain": {"running", "uncertain", *TERMINAL}}
    if next_state not in allowed.get(previous, {previous}):
        raise StoreError("执行观察状态不能倒退或修改终态")


class WorkerStore:
    def __init__(self, path, binding):
        if type(binding) is not dict or not BINDING_KEYS <= binding.keys() or any(
                type(binding[key]) is not str or not binding[key] or len(binding[key]) > 1024 for key in BINDING_KEYS):
            raise StoreError("执行账本绑定不完整")
        self._binding_json = _canonical(binding, 16000)
        _no_secrets(binding)
        self._binding = copy.deepcopy(binding)
        self._closed = False
        try:
            self.path = Path(path).absolute()
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not self.path.exists():
                self._create()
            with self._connect() as db:
                count, actual_bytes, largest = db.execute(
                    "SELECT COUNT(*), COALESCE(SUM(length(CAST(record AS BLOB))),0), "
                    "COALESCE(MAX(length(CAST(record AS BLOB))),0) FROM executions").fetchone()
                if count > MAX_EXECUTIONS or actual_bytes > MAX_TOTAL_BYTES or largest > MAX_RECORD_BYTES:
                    raise StoreError("执行账本超过容量上限")
                if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise StoreError("执行账本损坏；未自动重建")
                total = len(self._binding_json.encode("utf-8"))
                rows = db.execute("SELECT execution_id, record, bytes FROM executions").fetchall()
                if len(rows) > MAX_EXECUTIONS:
                    raise StoreError("执行账本超过容量上限")
                for execution_id, text, size in rows:
                    self._parse_record(execution_id, text)
                    if type(size) is not int or size != len(text.encode("utf-8")):
                        raise StoreError("执行账本记录大小校验失败")
                    total += size
                if total > MAX_TOTAL_BYTES:
                    raise StoreError("执行账本超过总大小上限")
        except (OSError, sqlite3.Error):
            raise StoreError("执行账本无法安全打开；请保留原记录，未自动重建") from None

    @property
    def binding(self):
        return copy.deepcopy(self._binding)

    def _create(self):
        # Publish a complete DB without ever overwriting an existing/empty file.
        descriptor, name = tempfile.mkstemp(prefix=".hub-worker-", suffix=".tmp", dir=self.path.parent)
        os.close(descriptor)
        candidate = Path(name)
        try:
            with closing(sqlite3.connect(candidate)) as db, db:
                db.execute("PRAGMA synchronous=FULL")
                db.execute(f"PRAGMA application_id={APPLICATION_ID}")
                db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
                db.execute("CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL)")
                db.execute("CREATE TABLE executions (execution_id TEXT PRIMARY KEY, record TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0))")
                db.execute("INSERT INTO metadata VALUES (1, ?)", (self._binding_json,))
            with candidate.open("r+b") as stream:
                os.fsync(stream.fileno())
            try:
                os.link(candidate, self.path)
            except FileExistsError:
                pass  # A concurrent constructor won. _connect verifies its binding.
            if os.name != "nt":
                directory = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            candidate.unlink(missing_ok=True)

    @contextmanager
    def _connect(self, write=False):
        if self._closed:
            raise StoreError("执行账本已关闭")
        db = None
        try:
            if self.path.stat().st_size > MAX_DATABASE_BYTES:
                raise StoreError("执行账本文件超过安全读取上限")
            db = sqlite3.connect(self.path.as_uri() + "?mode=rw", uri=True,
                                 timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None)
            db.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            if (db.execute("PRAGMA application_id").fetchone()[0] != APPLICATION_ID
                    or db.execute("PRAGMA user_version").fetchone()[0] != SCHEMA_VERSION):
                raise StoreError("执行账本版本未知；未迁移或重建")
            objects = {(kind, name) for kind, name in db.execute("SELECT type, name FROM sqlite_master")}
            if objects != {("table", "metadata"), ("table", "executions"), ("index", "sqlite_autoindex_executions_1")}:
                raise StoreError("执行账本结构未知；未迁移或重建")
            rows = db.execute("SELECT id, binding FROM metadata").fetchall()
            if len(rows) != 1 or rows[0][0] != 1 or _canonical(_decode(rows[0][1])) != self._binding_json:
                raise StoreError("执行账本绑定不一致；未改写原记录")
            yield db
            db.commit()
        except (sqlite3.Error, OSError):
            raise StoreError("执行账本读写失败；保留原执行身份后重试") from None
        finally:
            if db is not None:
                db.close()  # Any uncommitted transaction is rolled back.

    def close(self):
        self._closed = True

    def __enter__(self):
        if self._closed:
            raise StoreError("执行账本已关闭")
        return self

    def __exit__(self, *_):
        self.close()

    def _parse_record(self, execution_id, text):
        _uuid(execution_id)
        record = _decode(text)
        if type(record) is not dict or set(record) != RECORD_KEYS or record.get("execution_id") != execution_id:
            raise StoreError("执行账本记录结构损坏")
        for key in ("claim_request_id", "provider_request_id", "report_submission_id"):
            _uuid(record[key])
        for key in ("native_attempted", "reported", "finished"):
            if type(record[key]) is not bool:
                raise StoreError("执行账本记录标记损坏")
        if type(record["identity"]) is not dict or not record["identity"]:
            raise StoreError("执行账本记录身份损坏")
        for key in ("claim", "claim_guard", "native_request", "observation", "last_observation", "receipt", "report"):
            if record[key] is not None and type(record[key]) is not dict:
                raise StoreError("执行账本记录结构损坏")
        if (record["job_id"] is not None and (type(record["job_id"]) is not str or not record["job_id"])
                or record["backend"] is not None and (type(record["backend"]) is not str or not record["backend"])):
            raise StoreError("执行账本原生任务身份损坏")
        if record["claim"] is not None:
            if record["claim_guard"] is None or record["native_request"] is None or not record["backend"]:
                raise StoreError("执行账本领取记录不完整")
            self._identity_matches(record, record["claim"])
            if type(record["claim"].get("lease_token")) is not str or not record["claim"]["lease_token"]:
                raise StoreError("执行账本领取记录不完整")
        elif any(record[key] is not None for key in ("claim_guard", "native_request", "backend", "observation", "last_observation", "receipt")) or record["native_attempted"]:
            raise StoreError("执行账本缺少领取记录")
        if record["observation"] is not None:
            if type(record["observation"]) is not dict:
                raise StoreError("执行账本待上报记录损坏")
            _uuid(record["observation"].get("observation_id"))
            if record["observation"].get("provider_request_id") != record["provider_request_id"]:
                raise StoreError("执行账本待上报身份损坏")
        if record["receipt"] is not None:
            if (record["receipt"].get("provider_request_id") != record["provider_request_id"]
                    or type(record["receipt"].get("provider_state")) is not str
                    or record["receipt"]["provider_state"] not in STATES):
                raise StoreError("执行账本回执身份损坏")
            self._identity_matches(record, record["receipt"])
            if record["last_observation"] is None or _semantic(record["last_observation"]) != _semantic(record["receipt"]):
                raise StoreError("执行账本回执与观察不匹配")
        elif record["last_observation"] is not None or record["native_attempted"]:
            raise StoreError("执行账本缺少观察确认")
        if record["last_observation"] is not None:
            _uuid(record["last_observation"].get("observation_id"))
        if record["finished"] and (not record["reported"] or (record["receipt"] or {}).get("provider_state") not in TERMINAL):
            raise StoreError("执行账本完成记录损坏")
        if record["reported"] and record["report"] is None:
            raise StoreError("执行账本报告记录损坏")
        if record["report"] is not None and (record["receipt"] or {}).get("provider_state") not in TERMINAL:
            raise StoreError("执行账本报告缺少终态")
        return record

    def _read(self, db, execution_id, required=True):
        row = db.execute("SELECT record, bytes FROM executions WHERE execution_id=?", (execution_id,)).fetchone()
        if row is None:
            if required:
                raise StoreError("执行账本中没有此执行")
            return None
        if type(row[0]) is not str or type(row[1]) is not int or row[1] != len(row[0].encode("utf-8")):
            raise StoreError("执行账本记录大小校验失败")
        return self._parse_record(execution_id, row[0])

    def _write(self, db, record, new=False):
        text = _canonical(record)
        size = len(text.encode("utf-8"))
        count, total = db.execute("SELECT COUNT(*), COALESCE(SUM(length(CAST(record AS BLOB))),0) FROM executions WHERE execution_id<>?", (record["execution_id"],)).fetchone()
        if count + 1 > MAX_EXECUTIONS or total + size + len(self._binding_json.encode("utf-8")) > MAX_TOTAL_BYTES:
            raise StoreError("执行账本容量已满；未删除旧记录或重提任务")
        if new:
            db.execute("INSERT INTO executions VALUES (?,?,?)", (record["execution_id"], text, size))
        else:
            db.execute("UPDATE executions SET record=?, bytes=? WHERE execution_id=?", (text, size, record["execution_id"]))

    def get(self, execution_id):
        _uuid(execution_id)
        with self._connect() as db:
            return self._read(db, execution_id, required=False)

    def summaries(self, limit=25, after_execution_id=None, *, unfinished_only=False):
        """Bounded local recovery page; never return inputs, leases or native templates."""
        if type(limit) is not int or not 1 <= limit <= 25 or type(unfinished_only) is not bool:
            raise StoreError("执行摘要页参数无效")
        if after_execution_id is not None:
            _uuid(after_execution_id)
        items = []
        with self._connect() as db:
            # The entire store is bounded to 2,000 records / 16 MiB. Decode one at
            # a time, stop at one extra matching row, and preserve corruption errors.
            rows = db.execute("SELECT execution_id, record, bytes FROM executions WHERE execution_id>? ORDER BY execution_id",
                              (after_execution_id or "",))
            for execution_id, text, size in rows:
                if type(text) is not str or type(size) is not int or size != len(text.encode("utf-8")):
                    raise StoreError("执行账本记录大小校验失败")
                record = self._parse_record(execution_id, text)
                if unfinished_only and record["finished"]:
                    continue
                capability_id = record["identity"].get("capability_id")
                job_id = record["job_id"]
                items.append({"execution_id": execution_id,
                    "capability_id": capability_id if isinstance(capability_id, str) and re.fullmatch("[0-9a-f]{32}", capability_id) else None,
                    "provider_state": (record["observation"] or record["receipt"] or {}).get("provider_state", "not_started"),
                    "native_attempted": record["native_attempted"],
                    "job_id": job_id if isinstance(job_id, str) and re.fullmatch(r"[\w-]{1,100}", job_id) else None,
                    "pending_observation": record["observation"] is not None,
                    "reported": record["reported"], "finished": record["finished"]})
                if len(items) > limit:
                    break
        more = len(items) > limit
        return {"items": items[:limit], "has_more": more,
                "next_after_execution_id": items[limit - 1]["execution_id"] if more else None}

    def has_unfinished(self, capability_id=None):
        after = None
        while True:
            page = self.summaries(25, after, unfinished_only=True)
            if any(capability_id is None or item["capability_id"] == capability_id for item in page["items"]):
                return True
            if not page["has_more"]:
                return False
            after = page["next_after_execution_id"]

    def reserve(self, execution_id, identity):
        _uuid(execution_id)
        if type(identity) is not dict or not identity:
            raise StoreError("执行身份不完整")
        expected = _canonical(identity)
        _no_secrets(identity)
        if "execution_id" in identity and identity["execution_id"] != execution_id:
            raise StoreError("执行身份不一致")
        for key in BINDING_KEYS - {"client_id"}:
            if key in identity and identity[key] != self._binding[key]:
                raise StoreError("执行身份与账本绑定不一致")
        if "executor" in identity and (type(identity["executor"]) is not dict or identity["executor"].get("client_id") != self._binding["client_id"]):
            raise StoreError("执行身份与客户端不一致")
        with self._connect(write=True) as db:
            record = self._read(db, execution_id, required=False)
            if record is not None:
                if _canonical(record["identity"]) != expected:
                    raise StoreError("同一执行身份不能修改")
                return record
            record = {"execution_id": execution_id, "identity": copy.deepcopy(identity),
                      **{key: str(uuid.uuid4()) for key in ("claim_request_id", "provider_request_id", "report_submission_id")},
                      "native_attempted": False, "job_id": None, "claim": None, "claim_guard": None,
                      "native_request": None, "backend": None, "observation": None, "last_observation": None,
                      "receipt": None, "report": None, "reported": False, "finished": False}
            self._write(db, record, new=True)
            return copy.deepcopy(record)

    @contextmanager
    def execution_lock(self, execution_id):
        _uuid(execution_id)
        if self._closed:
            raise StoreError("执行账本已关闭")
        stream = None
        acquired = False
        try:
            directory = self.path.with_name(self.path.name + ".locks")
            directory.mkdir(exist_ok=True, mode=0o700)
            descriptor = os.open(directory / (execution_id + ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
            stream = os.fdopen(descriptor, "r+b")
            if os.fstat(stream.fileno()).st_size == 0:
                stream.write(b"\0")
                stream.flush()
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                acquire = lambda: msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                release = lambda: msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                acquire = lambda: fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                release = lambda: fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            try:
                acquire()
            except OSError:
                raise StoreBusy("此执行正在另一进程处理中；请查原执行，不要另键重提") from None
            acquired = True
        except OSError:
            if stream is not None:
                stream.close()
            raise StoreError("执行排他锁不可用；未开始处理") from None
        except BaseException:
            if stream is not None:
                stream.close()
            raise
        try:
            yield
        finally:
            if stream is not None:
                if acquired:
                    try:
                        stream.seek(0)
                        release()
                    except OSError:
                        pass
                stream.close()
            # Retain the file: unlinking it can create two independently locked inodes.

    @staticmethod
    def _identity_matches(record, receipt):
        if type(receipt) is not dict or any(key not in receipt or _canonical(receipt[key]) != _canonical(value)
                                            for key, value in record["identity"].items()):
            raise StoreError("执行回执身份不一致")

    def save_claim(self, execution_id, claim, native_request, backend):
        _uuid(execution_id)
        _canonical(claim)
        _canonical(native_request)
        if (type(claim) is not dict or type(claim.get("lease_token")) is not str or not claim["lease_token"]
                or type(claim.get("input_json")) is not str or not claim["input_json"]
                or len(claim["input_json"].encode("utf-8")) > MAX_INPUT_BYTES
                or type(claim.get("declaration_text")) is not str or not claim["declaration_text"]
                or type(native_request) is not dict or type(backend) is not str or not backend):
            raise StoreError("领取记录或原生请求不完整")
        task = claim.get("task", {})
        if (type(task) is not dict or type(task.get("report_contract", {})) is not dict
                or type(task.get("report_submission", {})) is not dict):
            raise StoreError("领取任务结构无效")
        submission_claim = task.get("report_submission", {}).get("claim_id")
        legacy_claim = task.get("report_contract", {}).get("claim_id")
        if submission_claim is not None and legacy_claim is not None and submission_claim != legacy_claim:
            raise StoreError("领取任务报告身份冲突")
        guard = {"input_json": claim["input_json"], "declaration_text": claim["declaration_text"],
                 "task_id": task.get("id"), "claim_id": submission_claim if submission_claim is not None else legacy_claim}
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            self._identity_matches(record, claim)
            if record["claim"] is not None and (_canonical(guard) != _canonical(record["claim_guard"])
                    or _canonical(native_request) != _canonical(record["native_request"]) or backend != record["backend"]):
                raise StoreError("领取意图或原始输入不能更改")
            record.update(claim=copy.deepcopy(claim), claim_guard=guard,
                          native_request=copy.deepcopy(native_request), backend=backend)
            self._write(db, record)
            return copy.deepcopy(record)

    def queue_observation(self, execution_id, payload):
        _uuid(execution_id)
        _canonical(payload)
        if type(payload) is not dict or set(payload) - {"provider_state", "provider_request_id", "results", "outcome", "error_code", "cancel_evidence"}:
            raise StoreError("待上报观察包含不支持的字段")
        _no_secrets(payload)
        payload = copy.deepcopy(payload)
        payload["results"] = _results(payload.get("results", []))
        state, outcome = payload.get("provider_state"), _outcome(payload)
        if type(state) is not str or state not in STATES:
            raise StoreError("执行观察状态无效")
        if state == "succeeded" and not payload["results"]:
            raise StoreError("成功状态必须提供成果")
        if state != "succeeded" and payload["results"]:
            raise StoreError("非成功状态不能附带成果")
        if (state == "failed" and (set(outcome) != {"error_code"} or not outcome["error_code"])) or (state == "cancelled" and (set(outcome) != {"cancel_evidence"} or not outcome["cancel_evidence"])):
            raise StoreError("终态缺少对应结果证据")
        if state not in {"failed", "cancelled"} and outcome:
            raise StoreError("当前状态不能包含失败或取消证据")
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            if record["claim"] is None or payload.get("provider_request_id") != record["provider_request_id"]:
                raise StoreError("观察缺少有效领取或原生请求身份不一致")
            pending = record["observation"]
            if pending is not None:
                if _canonical({key: value for key, value in pending.items() if key != "observation_id"}) != _canonical(payload):
                    raise StoreError("待上报观察尚未确认，不能替换")
                return copy.deepcopy(pending)
            previous = record["receipt"] or {"provider_state": "not_started"}
            _check_transition(previous["provider_state"], state)
            if previous["provider_state"] in TERMINAL:
                if _semantic(previous) != _semantic(payload):
                    raise StoreError("执行终态和成果已冻结")
                return copy.deepcopy(record["last_observation"])
            pending = {"observation_id": str(uuid.uuid4()), **payload}
            record["observation"] = pending
            self._write(db, record)
            return copy.deepcopy(pending)

    def ack_observation(self, execution_id, observation_id, receipt):
        _uuid(execution_id)
        _uuid(observation_id)
        _canonical(receipt)
        _no_secrets(receipt)
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            self._identity_matches(record, receipt)
            pending = record["observation"]
            if not pending or pending["observation_id"] != observation_id:
                previous = record["last_observation"]
                if not previous or previous["observation_id"] != observation_id or _semantic(previous) != _semantic(receipt):
                    raise StoreError("观察确认身份不匹配；未清除待上报记录")
                return copy.deepcopy(record["receipt"])
            if _semantic(pending) != _semantic(receipt):
                raise StoreError("观察回执的状态、请求或成果不一致")
            previous = record["receipt"]
            if previous and previous["provider_state"] in TERMINAL and _semantic(previous) != _semantic(receipt):
                raise StoreError("执行终态和成果已冻结")
            record.update(observation=None, last_observation=copy.deepcopy(pending), receipt=copy.deepcopy(receipt))
            self._write(db, record)
            return copy.deepcopy(receipt)

    def begin_native(self, execution_id):
        _uuid(execution_id)
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            if record["native_attempted"]:
                return False
            if record["claim"] is None or record["observation"] is not None or (record["receipt"] or {}).get("provider_state") != "submitting":
                raise StoreError("原生提交前必须确认 submitting 观察与有效领取")
            record["native_attempted"] = True
            self._write(db, record)
            return True

    def save_job(self, execution_id, job_id):
        _uuid(execution_id)
        if type(job_id) is not str or not job_id or len(job_id) > 200:
            raise StoreError("原生任务身份无效")
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            if record["job_id"] is not None and record["job_id"] != job_id:
                raise StoreError("同一执行不能改绑原生任务")
            record["job_id"] = job_id
            self._write(db, record)
            return copy.deepcopy(record)

    def save_report(self, execution_id, payload):
        _uuid(execution_id)
        _canonical(payload)
        if type(payload) is not dict or not payload:
            raise StoreError("分类报告不能为空")
        _no_secrets(payload)
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            if (record["receipt"] or {}).get("provider_state") not in TERMINAL:
                raise StoreError("确认原生终态后才能保存分类报告")
            if "submission_id" in payload and payload["submission_id"] != record["report_submission_id"]:
                raise StoreError("分类报告提交身份不一致")
            if record["report"] is not None and _canonical(record["report"]) != _canonical(payload):
                raise StoreError("已保存的分类报告不能更改")
            record["report"] = copy.deepcopy(payload)
            self._write(db, record)
            return copy.deepcopy(payload)

    def mark_reported(self, execution_id):
        _uuid(execution_id)
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            if record["report"] is None or (record["receipt"] or {}).get("provider_state") not in TERMINAL:
                raise StoreError("分类报告尚未准备好")
            record["reported"] = True
            self._write(db, record)
            return copy.deepcopy(record)

    def mark_finished(self, execution_id):
        _uuid(execution_id)
        with self._connect(write=True) as db:
            record = self._read(db, execution_id)
            if not record["reported"] or (record["receipt"] or {}).get("provider_state") not in TERMINAL:
                raise StoreError("执行终态和分类报告均确认后才能完成")
            record["finished"] = True
            self._write(db, record)
            return copy.deepcopy(record)
