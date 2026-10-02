"""Local storage for data-only ComfyUI editor workflow documents.

This module deliberately does not submit workflows to a backend. The native
ComfyUI editor remains responsible for compiling its graph to an API prompt.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from .packages import normalize_prompt

MAX_BYTES = 16 * 1024 * 1024
MAX_NODES = 10_000
MAX_LINKS = 50_000
MAX_DEPTH = 80
MAX_ITEMS = 500_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
ID_PATTERN = re.compile(r"e-[0-9a-f]{24}\Z")
REVISION_PATTERN = re.compile(r"revision-([0-9]{8})\.json\Z")


class _JSONContractError(ValueError):
    """A safe parser diagnostic, without source text or user field values."""


def _pairs_no_duplicates(items):
    value = {}
    for key, item in items:
        if key in value:
            raise _JSONContractError("JSON 不能包含重复键")
        value[key] = item
    return value


def _parse_integer(token):
    try:
        value = int(token)
    except ValueError:
        raise _JSONContractError("JSON 整数位数超出解析上限") from None
    if abs(value) > MAX_SAFE_INTEGER:
        raise _JSONContractError("JSON 整数超过浏览器的精确范围（绝对值不能超过 9007199254740991）")
    return value


def _parse_float(token):
    value = float(token)
    if not math.isfinite(value):
        raise _JSONContractError("JSON 数字必须有限，不能使用 NaN 或 Infinity")
    return value


def _reject_constant(_token):
    raise _JSONContractError("JSON 数字必须有限，不能使用 NaN 或 Infinity")


def _walk_json(value):
    """Reject non-JSON Python objects, cycles, deep trees, and imprecise ints."""
    pending = [(value, 0)]
    seen = set()
    items = 0
    while pending:
        current, depth = pending.pop()
        items += 1
        if depth > MAX_DEPTH or items > MAX_ITEMS:
            raise ValueError("工作流 JSON 结构过深或项目过多")
        if isinstance(current, dict):
            identity = id(current)
            if identity in seen:
                raise ValueError("工作流 JSON 不能包含循环引用")
            seen.add(identity)
            for key, child in current.items():
                if not isinstance(key, str):
                    raise ValueError("工作流 JSON 对象键必须是文本")
                try:
                    key.encode("utf-8")
                except UnicodeEncodeError:
                    raise ValueError("工作流 JSON 文本包含无效 Unicode") from None
                pending.append((child, depth + 1))
        elif isinstance(current, list):
            identity = id(current)
            if identity in seen:
                raise ValueError("工作流 JSON 不能包含循环引用")
            seen.add(identity)
            pending.extend((child, depth + 1) for child in current)
        elif current is None or type(current) in (str, bool):
            if isinstance(current, str):
                try:
                    current.encode("utf-8")
                except UnicodeEncodeError:
                    raise ValueError("工作流 JSON 文本包含无效 Unicode") from None
        elif type(current) is int:
            if abs(current) > MAX_SAFE_INTEGER:
                raise ValueError("JSON 整数超过浏览器的精确范围")
        elif type(current) is float:
            if not math.isfinite(current):
                raise ValueError("JSON 数字必须有限")
        else:
            raise ValueError("工作流只能包含标准 JSON 数据")


def _encode_document(document):
    _walk_json(document)
    try:
        encoded = json.dumps(document, ensure_ascii=False, allow_nan=False,
                             separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, OverflowError, UnicodeError, RecursionError):
        raise ValueError("工作流不是有效的 JSON 数据") from None
    if len(encoded) > MAX_BYTES:
        raise ValueError("ComfyUI 工作流 JSON 最大为 16 MiB")
    return encoded


def _parse_document(source):
    if not isinstance(source, str):
        raise ValueError("source_json 须为 JSON 原文字符串")
    try:
        raw = source.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("source_json 须为有效 Unicode 文本") from None
    if len(raw) > MAX_BYTES:
        raise ValueError("ComfyUI 工作流 JSON 最大为 16 MiB")
    try:
        document = json.loads(source.removeprefix("\ufeff"),
                              object_pairs_hook=_pairs_no_duplicates,
                              parse_int=_parse_integer, parse_float=_parse_float,
                              parse_constant=_reject_constant)
    except _JSONContractError as exc:
        raise ValueError(f"ComfyUI 工作流无法导入：{exc}；请从原工具修复或重新导出，原文件未修改") from None
    except json.JSONDecodeError as exc:
        raise ValueError(f"ComfyUI 工作流 JSON 语法错误（第 {exc.lineno} 行，第 {exc.colno} 列）；请检查该位置后重新导入，原文件未修改") from None
    except (TypeError, ValueError, OverflowError,
            UnicodeError, RecursionError):
        raise ValueError("ComfyUI 工作流 JSON 无效或嵌套过深") from None
    _validate_document(document)
    return document


def _validate_document(document):
    _encode_document(document)
    if not isinstance(document, dict):
        raise ValueError("请选择 ComfyUI editor JSON 对象")
    version = document.get("version")
    if (type(version) not in (int, float) or not math.isfinite(version)
            or not (version == 0.4 or 1 <= version < 2)):
        raise ValueError("仅支持 ComfyUI editor workflow 0.4 或新版 1.x 格式")
    nodes, links = document.get("nodes"), document.get("links")
    if not isinstance(nodes, list) or not isinstance(links, list):
        raise ValueError("ComfyUI editor workflow 须包含 nodes 与 links 数组")
    if len(nodes) > MAX_NODES:
        raise ValueError("ComfyUI editor workflow 最多包含 10000 个节点")
    if len(links) > MAX_LINKS:
        raise ValueError("ComfyUI editor workflow 最多包含 50000 条连接")
    if any(not isinstance(node, dict) for node in nodes):
        raise ValueError("ComfyUI editor workflow 的 nodes 项须为对象")
    if any(not isinstance(link, (dict, list)) for link in links):
        raise ValueError("ComfyUI editor workflow 的 links 项须为数组或对象")
    return document


def _equivalent_json(left, right):
    """Compare parsed JSON while allowing JS to normalize 1.0 to 1."""
    if isinstance(left, dict) and isinstance(right, dict):
        return (left.keys() == right.keys()
                and all(_equivalent_json(left[key], right[key]) for key in left))
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _equivalent_json(a, b) for a, b in zip(left, right))
    if type(left) in (int, float) and type(right) in (int, float):
        return left == right
    return type(left) is type(right) and left == right


def _name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 120:
        raise ValueError("工作流名称须为 1–120 字的文本")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("工作流名称包含无效 Unicode") from None
    return value.strip()


def _json_bytes(value):
    _walk_json(value)
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, OverflowError, UnicodeError, RecursionError):
        raise ValueError("存储记录不是有效 JSON 数据") from None


class EditorWorkflowStore:
    """Store immutable editor JSON revisions and separately compiled API prompts."""

    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.RLock()

    def _ensure_root(self, *, create=False):
        if self.directory.is_symlink():
            raise ValueError("editor-workflows 存储目录不能是符号链接")
        if create:
            self.directory.mkdir(parents=True, exist_ok=True)
            if self.directory.is_symlink():
                raise ValueError("editor-workflows 存储目录不能是符号链接")
        if self.directory.exists() and not self.directory.is_dir():
            raise ValueError("editor-workflows 存储路径不是目录")

    def _record_dir(self, workflow_id, *, create=False):
        if not isinstance(workflow_id, str) or not ID_PATTERN.fullmatch(workflow_id):
            raise ValueError("editor workflow ID 无效")
        self._ensure_root(create=create)
        path = self.directory / workflow_id
        if path.is_symlink():
            raise ValueError("editor workflow 记录目录不能是符号链接")
        if create:
            path.mkdir(exist_ok=False)
        if path.exists() and not path.is_dir():
            raise ValueError("editor workflow 记录路径不是目录")
        if path.exists():
            try:
                path.resolve(strict=True).relative_to(self.directory.resolve(strict=True))
            except (OSError, ValueError):
                raise ValueError("editor workflow 记录路径越界") from None
        return path

    def _safe_file(self, record_dir, relative, *, required=True):
        path = record_dir / relative
        if path.is_symlink():
            raise ValueError("editor workflow 数据文件不能是符号链接")
        if required and not path.is_file():
            raise ValueError("editor workflow 记录缺少必要文件")
        if path.exists() and not path.is_file():
            raise ValueError("editor workflow 数据路径不是普通文件")
        if path.exists():
            try:
                path.resolve(strict=True).relative_to(record_dir.resolve(strict=True))
            except (OSError, ValueError):
                raise ValueError("editor workflow 数据文件路径越界") from None
        return path

    @staticmethod
    def _summary(meta, document):
        revision = meta["current_revision"]
        compiled_revision = meta["compiled_revision"]
        nodes, links = document["nodes"], document["links"]
        return {
            "id": meta["id"],
            "name": meta["name"],
            "revision": revision,
            "nodes": len(nodes),
            "links": len(links),
            "updated_at": meta["updated_at"],
            "summary": {
                "version": document["version"],
                "nodes": len(nodes),
                "links": len(links),
                "compiled": compiled_revision is not None,
                "stale": compiled_revision is not None and compiled_revision != revision,
            },
        }

    def _read_meta(self, record_dir, workflow_id):
        path = self._safe_file(record_dir, "meta.json")
        try:
            if path.stat().st_size > 64 * 1024:
                raise ValueError("记录元数据超过大小上限")
            with path.open("rb") as stream:
                raw = stream.read(64 * 1024 + 1)
            if len(raw) > 64 * 1024:
                raise ValueError("记录元数据超过大小上限")
            meta = json.loads(raw,
                                  object_pairs_hook=_pairs_no_duplicates,
                                  parse_int=_parse_integer, parse_float=_parse_float,
                                  parse_constant=_reject_constant)
            if (not isinstance(meta, dict) or meta.get("version") != 1
                    or type(meta.get("version")) is not int or meta.get("id") != workflow_id
                    or _name(meta.get("name")) != meta.get("name")
                    or type(meta.get("current_revision")) is not int
                    or not 1 <= meta["current_revision"] <= MAX_SAFE_INTEGER
                    or type(meta.get("created_at")) not in (int, float)
                    or type(meta.get("updated_at")) not in (int, float)
                    or not math.isfinite(meta["created_at"])
                    or not math.isfinite(meta["updated_at"])
                    or meta["created_at"] <= 0 or meta["updated_at"] <= 0):
                raise ValueError("元数据字段无效")
            compiled_revision = meta.get("compiled_revision")
            if (compiled_revision is not None
                    and (type(compiled_revision) is not int or compiled_revision < 1
                         or compiled_revision > meta["current_revision"])):
                raise ValueError("compiled revision 元数据无效")
            if compiled_revision is None:
                if meta.get("compiled_updated_at") is not None:
                    raise ValueError("compiled 时间元数据无效")
            elif (type(meta.get("compiled_updated_at")) not in (int, float)
                    or not math.isfinite(meta["compiled_updated_at"])
                    or meta["compiled_updated_at"] <= 0):
                raise ValueError("compiled 时间元数据无效")
            return meta
        except (OSError, json.JSONDecodeError, TypeError, ValueError,
                OverflowError, UnicodeError, RecursionError) as exc:
            reason = str(exc) or "元数据无法读取"
            raise ValueError(f"editor workflow 记录损坏（{reason}），原文件已保留") from None

    def _read_revision(self, record_dir, revision):
        relative = Path("revisions") / f"revision-{revision:08d}.json"
        revisions_dir = record_dir / "revisions"
        if revisions_dir.is_symlink():
            raise ValueError("editor workflow revisions 目录不能是符号链接")
        path = self._safe_file(record_dir, relative)
        try:
            if path.stat().st_size > MAX_BYTES:
                raise ValueError("revision 超过 16 MiB")
            with path.open("rb") as stream:
                raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("revision 超过 16 MiB")
            source = raw.decode("utf-8")
            return _parse_document(source), source
        except (OSError, UnicodeError, ValueError, RecursionError) as exc:
            reason = str(exc) or "revision 无法读取"
            raise ValueError(f"editor workflow revision {revision} 损坏（{reason}），原文件已保留") from None

    def _read_compiled(self, record_dir, revision):
        relative = Path("compiled") / f"revision-{revision:08d}.json"
        compiled_dir = record_dir / "compiled"
        if compiled_dir.is_symlink():
            raise ValueError("editor workflow compiled 目录不能是符号链接")
        path = self._safe_file(record_dir, relative)
        try:
            if path.stat().st_size > MAX_BYTES:
                raise ValueError("compiled prompt 超过 16 MiB")
            with path.open("rb") as stream:
                raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("compiled prompt 超过 16 MiB")
            data = json.loads(raw, object_pairs_hook=_pairs_no_duplicates,
                              parse_int=_parse_integer, parse_float=_parse_float,
                              parse_constant=_reject_constant)
            if (not isinstance(data, dict) or type(data.get("revision")) is not int
                    or data["revision"] != revision
                    or type(data.get("updated_at")) not in (int, float)
                    or not math.isfinite(data["updated_at"])
                    or data["updated_at"] <= 0):
                raise ValueError("compiled prompt 元数据无效")
            # This is the saved full editor graph. Validate dependency closure only
            # for selected outputs at execution; unfinished islands remain editable.
            prompt = normalize_prompt(data.get("prompt"), check_dependencies=False)
            return {"prompt": prompt, "revision": revision,
                    "updated_at": data["updated_at"]}
        except (OSError, json.JSONDecodeError, TypeError, ValueError,
                OverflowError, UnicodeError, RecursionError) as exc:
            reason = str(exc) or "compiled prompt 无法读取"
            raise ValueError(f"editor workflow compiled prompt 损坏（{reason}），原文件已保留") from None

    @staticmethod
    def _write_atomic(path, data):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("wb", prefix="." + path.name + ".",
                                             suffix=".tmp", dir=path.parent,
                                             delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    @staticmethod
    def _write_exclusive(path, data):
        with path.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    @staticmethod
    def _write_new_atomic(path, data):
        """Atomically publish a new immutable file without replacing an old one."""
        temporary = None
        try:
            with tempfile.NamedTemporaryFile("wb", prefix="." + path.name + ".",
                                             suffix=".tmp", dir=path.parent,
                                             delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            # A same-directory hard link publishes the complete file atomically
            # and fails if the immutable destination already exists.
            os.link(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    @staticmethod
    def _make_meta(workflow_id, name, revision, now, *, compiled_revision=None,
                   compiled_updated_at=None):
        return {"version": 1, "id": workflow_id, "name": name,
                "created_at": now, "updated_at": now,
                "current_revision": revision,
                "compiled_revision": compiled_revision,
                "compiled_updated_at": compiled_updated_at}

    def create(self, name, document, source_json=None):
        name = _name(name)
        if source_json is None:
            _validate_document(document)
            raw = _encode_document(document)
            source = raw.decode("utf-8")
            stored_document = document
        else:
            parsed = _parse_document(source_json)
            _validate_document(document)
            if not _equivalent_json(parsed, document):
                raise ValueError("document 与 source_json 内容不一致")
            source = source_json
            stored_document = parsed
            raw = source.encode("utf-8")
        with self.lock:
            self._ensure_root(create=True)
            while True:
                workflow_id = "e-" + secrets.token_hex(12)
                target = self.directory / workflow_id
                if not target.exists() and not target.is_symlink():
                    break
            temporary_dir = Path(tempfile.mkdtemp(prefix=".editor-workflow-",
                                                   dir=self.directory))
            try:
                (temporary_dir / "revisions").mkdir()
                (temporary_dir / "compiled").mkdir()
                self._write_exclusive(
                    temporary_dir / "revisions" / "revision-00000001.json", raw)
                now = time.time()
                meta = self._make_meta(workflow_id, name, 1, now)
                self._write_atomic(temporary_dir / "meta.json", _json_bytes(meta))
                os.replace(temporary_dir, target)
            except BaseException:
                # Only remove the private temporary directory created above.
                for path in sorted(temporary_dir.rglob("*"),
                                   key=lambda item: len(item.parts), reverse=True):
                    if path.is_file() or path.is_symlink():
                        path.unlink(missing_ok=True)
                    elif path.is_dir():
                        path.rmdir()
                temporary_dir.rmdir()
                raise
            return self._summary(meta, stored_document)

    def _get(self, workflow_id):
        record_dir = self._record_dir(workflow_id)
        if not record_dir.is_dir():
            raise ValueError("editor workflow 不存在")
        meta = self._read_meta(record_dir, workflow_id)
        document, source = self._read_revision(record_dir, meta["current_revision"])
        compiled_revision = meta["compiled_revision"]
        if compiled_revision is not None:
            self._read_compiled(record_dir, compiled_revision)
        result = self._summary(meta, document)
        result.update({"created_at": meta["created_at"],
                       "document": document, "source_json": source,
                       "compiled": {"available": compiled_revision is not None,
                                    "revision": compiled_revision,
                                    "stale": (compiled_revision is not None
                                              and compiled_revision != meta["current_revision"])}})
        return result

    def get(self, workflow_id):
        with self.lock:
            return self._get(workflow_id)

    def list(self):
        with self.lock:
            self._ensure_root()
            workflows, unreadable = [], []
            if self.directory.is_dir():
                for path in sorted(self.directory.iterdir(), key=lambda item: item.name):
                    if not ID_PATTERN.fullmatch(path.name):
                        continue
                    try:
                        if path.is_symlink():
                            raise ValueError("editor workflow 记录目录不能是符号链接")
                        record = self._get(path.name)
                        workflows.append({key: record[key] for key in
                                          ("id", "name", "revision", "nodes", "links",
                                           "updated_at", "summary")})
                    except (OSError, ValueError) as exc:
                        unreadable.append({"id": path.name, "reason": str(exc)})
            workflows.sort(key=lambda item: item["updated_at"], reverse=True)
            return {"workflows": workflows, "total": len(workflows),
                    "unreadable": unreadable}

    def export(self, workflow_id):
        """Return the current revision's exact JSON source text."""
        with self.lock:
            return self._get(workflow_id)["source_json"]

    def _next_revision(self, record_dir, current_revision):
        revisions_dir = record_dir / "revisions"
        if revisions_dir.is_symlink():
            raise ValueError("editor workflow revisions 目录不能是符号链接")
        revisions_dir.mkdir(exist_ok=True)
        largest = current_revision
        for path in revisions_dir.iterdir():
            if path.is_symlink():
                raise ValueError("editor workflow revision 不能是符号链接")
            match = REVISION_PATTERN.fullmatch(path.name)
            if match:
                if not path.is_file():
                    raise ValueError("editor workflow revision 路径不是普通文件")
                largest = max(largest, int(match.group(1)))
        return largest + 1

    def save_revision(self, workflow_id, document, prompt=None):
        _validate_document(document)
        raw = _encode_document(document)
        normalized_prompt = None
        if prompt not in (None, {}):
            normalized_prompt = normalize_prompt(prompt, check_dependencies=False)
        with self.lock:
            record_dir = self._record_dir(workflow_id)
            if not record_dir.is_dir():
                raise ValueError("editor workflow 不存在")
            meta = self._read_meta(record_dir, workflow_id)
            self._read_revision(record_dir, meta["current_revision"])
            if meta["compiled_revision"] is not None:
                self._read_compiled(record_dir, meta["compiled_revision"])
            revision = self._next_revision(record_dir, meta["current_revision"])
            revisions_dir = record_dir / "revisions"
            self._write_new_atomic(revisions_dir / f"revision-{revision:08d}.json", raw)
            now = time.time()
            compiled_revision = meta["compiled_revision"]
            compiled_updated_at = meta["compiled_updated_at"]
            if normalized_prompt is not None:
                compiled_dir = record_dir / "compiled"
                if compiled_dir.is_symlink():
                    raise ValueError("editor workflow compiled 目录不能是符号链接")
                compiled_dir.mkdir(exist_ok=True)
                compiled_data = {"revision": revision, "updated_at": now,
                                 "prompt": normalized_prompt}
                self._write_new_atomic(
                    compiled_dir / f"revision-{revision:08d}.json",
                    _json_bytes(compiled_data))
                compiled_revision, compiled_updated_at = revision, now
            new_meta = self._make_meta(
                workflow_id, meta["name"], revision, now,
                compiled_revision=compiled_revision,
                compiled_updated_at=compiled_updated_at)
            self._write_atomic(record_dir / "meta.json", _json_bytes(new_meta))
            return self._summary(new_meta, document)

    @contextmanager
    def revision_transaction(self, workflow_id, document, prompt=None):
        """Restore exact visible metadata if a coordinated package publish fails.

        Revision/compiled files remain immutable, including unreferenced failed
        attempts. This is an exception transaction for one locked service, not a
        crash-atomic transaction across both stores.
        """
        with self.lock:
            record_dir = self._record_dir(workflow_id)
            self._read_meta(record_dir, workflow_id)
            meta_path = self._safe_file(record_dir, Path('meta.json'))
            original = meta_path.read_bytes()
            backup = None
            keep_backup = False
            try:
                with tempfile.NamedTemporaryFile('wb', prefix='.apply-meta-', suffix='.backup',
                                                 dir=record_dir, delete=False) as stream:
                    backup = Path(stream.name)
                    stream.write(original)
                    stream.flush()
                    os.fsync(stream.fileno())
                try:
                    revision = self.save_revision(workflow_id, document, prompt)
                    yield revision
                except BaseException as apply_error:
                    try:
                        if meta_path.read_bytes() != original:
                            os.replace(backup, meta_path)
                    except OSError as rollback_error:
                        keep_backup = True
                        raise OSError(
                            f'工作流应用失败（{apply_error}）；恢复原revision也失败（{rollback_error}）。'
                            f'原meta完整备份已保留：{backup}；请停止写入并恢复该备份') from apply_error
                    raise
            finally:
                if backup is not None and not keep_backup:
                    try:
                        backup.unlink(missing_ok=True)
                    except OSError:
                        pass

    def get_compiled(self, workflow_id):
        with self.lock:
            record_dir = self._record_dir(workflow_id)
            if not record_dir.is_dir():
                raise ValueError("editor workflow 不存在")
            meta = self._read_meta(record_dir, workflow_id)
            self._read_revision(record_dir, meta["current_revision"])
            revision = meta["compiled_revision"]
            if revision is None:
                return None
            compiled = self._read_compiled(record_dir, revision)
            return {**compiled, "stale": revision != meta["current_revision"]}
