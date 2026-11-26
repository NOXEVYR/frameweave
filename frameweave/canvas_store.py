"""Named, immutable local canvas snapshots; no model or media copying."""
import json
import math
import os
import re
import threading
import time
import uuid
import stat
from pathlib import Path

LIMIT = 24 * 1024 * 1024
MAX_CANVAS_ITEMS = 500000
MAX_SUMMARY_CACHE_ENTRIES = 2000
MAX_SUMMARY_CACHE_BYTES = 2 * 1024 * 1024
SUMMARY_CACHE_SUPPORTED = os.name in ('nt', 'posix')
if os.name == 'nt':
    from .windows_file_revision import file_revision


class _CanvasChanged(ValueError):
    """A transient identity race must never become a malformed-file cache hit."""


def gallery_preview(graph):
    """Bound the project-card payload even when a version contains large workflows."""
    nodes = []
    covers = []
    excerpt = ''
    for node in graph['nodes']:
        data = node.get('data')
        data = data if isinstance(data, dict) else {}
        kind = node.get('type')
        if not excerpt and kind == 'prompt' and isinstance(data.get('text'), str):
            excerpt = ' '.join(data['text'].strip()[:80].split())
        outputs = data.get('outputs')
        if kind == 'result' and isinstance(outputs, list):
            for item in outputs:
                if isinstance(item, dict) and item.get('type') == 'image':
                    covers.append((0, item.get('url')))
        if kind == 'reference' and data.get('mediaType') == 'image':
            covers.append((1, data.get('url')))
        if (len(nodes) < 32 and isinstance(node.get('id'), str)
                and all(type(node.get(key)) in (int, float) and abs(node[key]) <= 1e7 for key in ('x', 'y'))):
            nodes.append({'id': node['id'][:120], 'x': node['x'], 'y': node['y'],
                          'type': kind if kind in ('prompt','generation','reference','result') else 'node',
                          'title': str(data.get('title') or '')[:36]})
    known = {node['id'] for node in nodes}
    edges = [[e['source'], e['target']] for e in graph['edges']
             if isinstance(e.get('source'), str) and isinstance(e.get('target'), str)
             and e['source'] in known and e['target'] in known][:96]
    cover = next((url for _, url in sorted(covers, key=lambda pair: pair[0])
                  if isinstance(url, str) and re.fullmatch(r'/api/(?:assets/media/[a-f0-9]{64}|media/[a-f0-9]{32})', url)), '')
    return {'nodes': nodes, 'edges': edges, 'image': cover, 'count': len(graph['nodes']), 'excerpt': excerpt}


class CanvasStore:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()
        self._summary_cache = {}
        self._summary_cache_bytes = 0

    @staticmethod
    def _file_identity(info):
        return tuple(getattr(info, key, None) for key in (
            'st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid',
            'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_file_attributes', 'st_reparse_tag'))

    @staticmethod
    def _read_flags():
        return os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)

    def _forget_summary(self, ident):
        previous = self._summary_cache.pop(ident, None)
        if previous is not None:
            self._summary_cache_bytes -= previous[2]

    def _remember_summary(self, ident, identity, summary):
        # Store only small display data, including stable malformed-file states.
        # Entry count also bounds the fixed-size stat tuples and LRU overhead.
        size = len(ident.encode('utf-8', errors='replace')) + len(
            json.dumps(summary, ensure_ascii=False, allow_nan=False).encode('utf-8'))
        self._forget_summary(ident)
        if identity is None or not SUMMARY_CACHE_SUPPORTED or size > MAX_SUMMARY_CACHE_BYTES:
            return
        # Sequential full-library scans must not evict every resident summary
        # when the library exceeds the budget. Admit only into available space;
        # deleted or changed files release their old entry independently.
        if (len(self._summary_cache) >= MAX_SUMMARY_CACHE_ENTRIES or
                self._summary_cache_bytes + size > MAX_SUMMARY_CACHE_BYTES):
            return
        self._summary_cache[ident] = (identity, dict(summary) if summary is not None else None, size)
        self._summary_cache_bytes += size

    def _path(self, ident):
        if not isinstance(ident, str) or not re.fullmatch(r"[0-9a-f]{32}", ident):
            raise ValueError("画布记录标识无效")
        path = self.root / (ident + '.json')
        if path.is_symlink():
            raise ValueError("画布记录不能指向链接")
        return path

    def get(self, ident):
        with self.lock:
            path = self._path(ident)
            try:
                info = path.lstat()
            except FileNotFoundError:
                raise ValueError("画布记录不存在")
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("画布记录不存在")
            if info.st_size > LIMIT + 4096:
                raise ValueError("画布记录过大")
            identity = self._file_identity(info)
            try:
                descriptor = os.open(path, self._read_flags())
                with os.fdopen(descriptor, 'rb') as stream:
                    if self._file_identity(os.fstat(stream.fileno())) != identity:
                        raise _CanvasChanged("画布记录在读取期间已变化")
                    raw = stream.read(LIMIT + 4097)
                    if (len(raw) > LIMIT + 4096 or self._file_identity(os.fstat(stream.fileno())) != identity or
                            self._file_identity(path.lstat()) != identity):
                        raise _CanvasChanged("画布记录在读取期间已变化")
                record = json.loads(raw.decode('utf-8'))
                if not isinstance(record, dict) or record.get('id') != ident:
                    raise ValueError()
                document = record.get('document')
                self._validate(document)
                name, created_at, nodes = record.get('name'), record.get('created_at'), record.get('nodes')
                if (not isinstance(name, str) or name != document['name'].strip()
                        or type(created_at) not in (int, float) or not math.isfinite(created_at) or created_at <= 0
                        or type(nodes) is not int or nodes != len(document['canvas']['nodes'])):
                    raise ValueError()
                if self._file_identity(path.lstat()) != identity:
                    raise _CanvasChanged("画布记录在读取期间已变化")
            except _CanvasChanged:
                raise
            except (KeyError, TypeError, ValueError, OverflowError, json.JSONDecodeError,
                    UnicodeError, RecursionError):
                raise ValueError("画布记录损坏，原文件已保留") from None
            return record

    def _summary_identity(self, path, info):
        identity = self._file_identity(info)
        if os.name != 'nt' or not SUMMARY_CACHE_SUPPORTED:
            return identity
        # Windows stat ctime may be creation time. Only admit a revision
        # obtained from the file itself. Other volumes keep full validation.
        if (not stat.S_ISREG(info.st_mode) or info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                or not re.fullmatch(r'[0-9a-f]{32}', path.stem)):
            return None
        descriptor = os.open(path, self._read_flags())
        try:
            if self._file_identity(os.fstat(descriptor)) != identity:
                raise _CanvasChanged("画布记录在摘要读取期间已变化")
            revision = file_revision(descriptor)
        finally:
            os.close(descriptor)
        if self._file_identity(path.lstat()) != identity:
            raise _CanvasChanged("画布记录在摘要读取期间已变化")
        return (*identity, revision) if revision is not None else None

    def _list_summary(self, path):
        if not re.fullmatch(r"[0-9a-f]{32}", path.stem):
            return None
        identity = self._summary_identity(path, path.lstat())
        cached = self._summary_cache.get(path.stem) if SUMMARY_CACHE_SUPPORTED else None
        if cached is not None and cached[0] == identity:
            if os.name != 'nt' and cached[1] is not None:
                # A cheap open retains current read-access/sharing semantics;
                # warm listings never read or validate the large document.
                descriptor = os.open(path, self._read_flags())
                try:
                    if self._file_identity(os.fstat(descriptor)) != identity:
                        raise _CanvasChanged("画布记录在摘要读取期间已变化")
                finally:
                    os.close(descriptor)
                if self._file_identity(path.lstat()) != identity:
                    raise _CanvasChanged("画布记录在摘要读取期间已变化")
            return dict(cached[1]) if cached[1] is not None else None
        self._forget_summary(path.stem)
        try:
            record = self.get(path.stem)
            summary = {key: record[key] for key in ('id', 'name', 'created_at', 'nodes')}
            doc = record['document']
            project = doc.get('project_id')
            summary['project_id'] = project if isinstance(project, str) and re.fullmatch(r'[0-9a-f]{32}', project) else record['id']
            summary['preview'] = gallery_preview(doc['canvas'])
        except _CanvasChanged:
            raise
        except ValueError:
            summary = None
        except OSError:
            # Sharing violations and temporary access failures can disappear
            # without a stat change. Recheck them on the next listing.
            raise
        if self._summary_identity(path, path.lstat()) != identity:
            raise _CanvasChanged("画布记录在摘要读取期间已变化")
        self._remember_summary(path.stem, identity, summary)
        return dict(summary) if summary is not None else None

    def list(self, offset=0, limit=200, query='', *, gallery=False):
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
            raise ValueError('画布分页参数无效')
        if not isinstance(query, str) or len(query) > 120:
            raise ValueError('画布搜索内容过长')
        with self.lock:
            entries, unreadable = [], 0
            paths = list(self.root.glob('*.json')) if self.root.is_dir() else []
            present = {path.stem for path in paths}
            for ident in list(self._summary_cache):
                if ident not in present:
                    self._forget_summary(ident)
            for path in paths:
                try:
                    summary = self._list_summary(path)
                    if summary is None:
                        unreadable += 1
                    else:
                        entries.append(summary)
                except (OSError, ValueError, KeyError):
                    self._forget_summary(path.stem)
                    unreadable += 1
            entries.sort(key=lambda x: x['created_at'], reverse=True)
            total = len(entries)
            entries = [entry for entry in entries if query.casefold() in entry['name'].casefold()]
            end = offset + limit
            page = entries[offset:end]
            if not gallery:
                page = [{key: row[key] for key in ('id', 'name', 'created_at', 'nodes')} for row in page]
            return {'canvases': page, 'total': total, 'matched': len(entries),
                    'offset': offset, 'next_offset': end if end < len(entries) else None, 'unreadable': unreadable,
                    'directory': str(self.root.resolve())}

    @staticmethod
    def _validate(document):
        if (not isinstance(document, dict) or document.get('schema') != 'prismcanvas.project.v1'
                or type(document.get('version')) is not int or document.get('version') != 1):
            raise ValueError("请选择有效的工作流画布集合")
        graph = document.get('canvas')
        if not isinstance(graph, dict) or not isinstance(graph.get('nodes'), list) or not isinstance(graph.get('edges'), list):
            raise ValueError("画布节点或连接格式无效")
        if len(graph['nodes']) > 500 or len(graph['edges']) > 2000:
            raise ValueError("请将大型画布拆分保存")
        if (any(not isinstance(node, dict) for node in graph['nodes'])
                or any(not isinstance(edge, dict) for edge in graph['edges'])):
            raise ValueError("画布节点或连接格式无效")
        if not isinstance(document.get('packages'), list) or len(document['packages']) > 200:
            raise ValueError("画布工作流包格式无效")
        package_ids = set()
        for entry in document['packages']:
            if (not isinstance(entry, dict) or not isinstance(entry.get('id'), str)
                    or not re.fullmatch(r'p-[a-f0-9]{24}', entry['id']) or entry['id'] in package_ids
                    or (('source_json' in entry) == ('document' in entry))):
                raise ValueError("画布工作流包格式无效")
            package_ids.add(entry['id'])
            if 'source_json' in entry and (not isinstance(entry['source_json'], str) or not entry['source_json']):
                raise ValueError("画布工作流包格式无效")
            if 'document' in entry and not isinstance(entry['document'], dict):
                raise ValueError("画布工作流包格式无效")
        if not isinstance(document.get('name'), str) or not document['name'].strip() or len(document['name']) > 120:
            raise ValueError("请填写 1–120 字的画布名称")
        # Bound nesting and item count before recursive JSON encoding. JSON parsed
        # from HTTP has no cycles, but save() is also a public Python boundary.
        pending, seen, items = [(document, 0)], set(), 0
        while pending:
            value, depth = pending.pop()
            items += 1
            if depth > 64:
                raise ValueError("画布集合的 JSON 结构超过 64 层，请拆分画布后保存")
            if items > MAX_CANVAS_ITEMS:
                raise ValueError(f"画布集合超过 {MAX_CANVAS_ITEMS} 个 JSON 数据项，请拆分画布后保存")
            if isinstance(value, dict):
                identity = id(value)
                if identity in seen or any(not isinstance(key, str) for key in value):
                    raise ValueError("画布集合不是有效的 JSON 数据")
                seen.add(identity)
                pending.extend((child, depth + 1) for child in value.values())
            elif isinstance(value, list):
                identity = id(value)
                if identity in seen:
                    raise ValueError("画布集合不是有效的 JSON 数据")
                seen.add(identity)
                pending.extend((child, depth + 1) for child in value)
            elif value is not None and type(value) not in (str, int, float, bool):
                raise ValueError("画布集合含有非 JSON 数据")
            elif type(value) is float and not math.isfinite(value):
                raise ValueError("画布集合包含无效数字")
        # JSON data is retained verbatim in meaning; graph and package execution
        # still require the frontend's independent validation.
        try:
            encoded = json.dumps(document, ensure_ascii=False, allow_nan=False).encode('utf-8')
        except (TypeError, ValueError, OverflowError, UnicodeError, RecursionError):
            raise ValueError("画布集合不是有效的 JSON 数据") from None
        if len(encoded) > LIMIT:
            raise ValueError("画布集合最大为 24 MiB")

    def save(self, document):
        self._validate(document)
        with self.lock:
            self.root.mkdir(parents=True, exist_ok=True)
            ident = uuid.uuid4().hex
            record = {'id': ident, 'name': document['name'].strip(), 'created_at': time.time(),
                      'nodes': len(document['canvas']['nodes']), 'document': document}
            path = self._path(ident)
            temp = self.root / f'.{ident}.{uuid.uuid4().hex}.tmp'
            created = False
            try:
                with temp.open('x', encoding='utf-8') as stream:
                    created = True
                    json.dump(record, stream, ensure_ascii=False, allow_nan=False)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, path)
            finally:
                if created:
                    temp.unlink(missing_ok=True)
            return {key: record[key] for key in ('id', 'name', 'created_at', 'nodes')}
