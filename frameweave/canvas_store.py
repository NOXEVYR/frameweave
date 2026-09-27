"""Named, immutable local canvas snapshots; no model or media copying."""
import json
import math
import os
import re
import threading
import time
import uuid
from pathlib import Path

LIMIT = 24 * 1024 * 1024


class CanvasStore:
    def __init__(self, root):
        self.root = Path(root)
        self.lock = threading.RLock()

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
            if not path.is_file():
                raise ValueError("画布记录不存在")
            if path.stat().st_size > LIMIT + 4096:
                raise ValueError("画布记录过大")
            try:
                record = json.loads(path.read_text(encoding='utf-8'))
                if not isinstance(record, dict) or record.get('id') != ident:
                    raise ValueError()
                document = record.get('document')
                self._validate(document)
                name, created_at, nodes = record.get('name'), record.get('created_at'), record.get('nodes')
                if (not isinstance(name, str) or name != document['name'].strip()
                        or type(created_at) not in (int, float) or not math.isfinite(created_at) or created_at <= 0
                        or type(nodes) is not int or nodes != len(document['canvas']['nodes'])):
                    raise ValueError()
            except (KeyError, TypeError, ValueError, OverflowError, json.JSONDecodeError,
                    UnicodeError, RecursionError):
                raise ValueError("画布记录损坏，原文件已保留") from None
            return record

    def list(self):
        with self.lock:
            entries, unreadable = [], 0
            if self.root.is_dir():
                for path in self.root.glob('*.json'):
                    try:
                        record = self.get(path.stem)
                        entries.append({key: record[key] for key in ('id', 'name', 'created_at', 'nodes')})
                    except (OSError, ValueError, KeyError):
                        unreadable += 1
            entries.sort(key=lambda x: x['created_at'], reverse=True)
            return {'canvases': entries[:200], 'total': len(entries), 'unreadable': unreadable,
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
            if depth > 64 or items > 100000:
                raise ValueError("画布集合的 JSON 结构过深或项目过多")
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
