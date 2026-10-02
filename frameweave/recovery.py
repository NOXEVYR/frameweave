"""Recover independent local records without discarding their healthy siblings."""
import json
import math
import hashlib
from pathlib import Path

from .backend import local_url
from .diagnostics import safe_relative
from .configuration_recovery import read_config, preserve_config
from .job_lifecycle import cancellation_record, cancel_state, has_terminal_evidence

MAX_RECORD_BYTES = 16 * 1024 * 1024


def media_record(value):
    if not isinstance(value, dict):
        raise ValueError('媒体记录无效')
    backend = local_url(value['backend'])
    filename = safe_relative(value['filename'])
    subfolder = safe_relative(value.get('subfolder', '')) if value.get('subfolder') else ''
    kind = value.get('storage_type', 'input')
    if '/' in filename or kind not in ('input', 'output', 'temp'):
        raise ValueError('媒体路径无效')
    return {'backend': backend, 'filename': filename, 'subfolder': subfolder, 'storage_type': kind}


def recover_records(path, normalize, limit):
    path = Path(path)
    warnings, records, damaged, protected = [], [], 0, False
    digest = None
    try:
        raw = read_config(path, MAX_RECORD_BYTES)
        digest = hashlib.sha256(raw).hexdigest()
        values = json.loads(raw.decode('utf-8'))
        if not isinstance(values, list):
            raise ValueError('记录列表无效')
    except FileNotFoundError:
        return [], [], False
    except (OSError, ValueError, TypeError, RecursionError):
        values, damaged = [], 1
    for value in values[-limit:]:
        try:
            # Reject NaN/Infinity before they can break every HTTP response.
            json.dumps(value, allow_nan=False)
            records.append(normalize(value))
        except (ValueError, KeyError, TypeError, AttributeError, RecursionError):
            damaged += 1
    if damaged:
        try:
            backup = preserve_config(path, expected_digest=digest)
            warnings.append(f'{path.name} 有 {damaged} 项无法恢复；已恢复 {len(records)} 项，原始记录另存为 {backup}。')
        except (OSError, ValueError):
            protected = True
            warnings.append(f'{path.name} 有 {damaged} 项无法恢复；已恢复 {len(records)} 项。原文件仍保留，但恢复备份失败或超过 16 MiB 安全恢复上限，已暂停相关写入；请先手动备份并整理本地数据。')
    return records, warnings, protected


def job_record(value):
    import re
    if not isinstance(value, dict) or not isinstance(value.get('id'), str) or not re.fullmatch(r'[\w-]{1,100}', value['id']):
        raise ValueError('任务标识无效')
    result = dict(value)
    result['backend'] = local_url(result['backend'])
    if result.get('status') not in {'queued', 'running', 'unknown', 'completed', 'failed', 'cancelled'}:
        raise ValueError('任务状态无效')
    for key in ('created_at', 'started_at', 'finished_at'):
        number = result.get(key)
        if number is not None and (type(number) not in (int, float) or not math.isfinite(number)):
            raise ValueError('任务时间无效')
    result['created_at'] = result.get('created_at') or 0
    if not isinstance(result.get('retry_attempt', {}), dict):
        raise ValueError('重试记录无效')
    if not isinstance(result.get('outputs', []), list):
        raise ValueError('产物列表无效')
    outputs = []
    for output in result.get('outputs', []):
        record = media_record({**output, 'backend': result['backend'], 'storage_type': output.get('storage_type', 'output')})
        if output.get('type') not in ('image', 'video', 'audio'):
            raise ValueError('产物类型无效')
        outputs.append({**output, **{k: v for k, v in record.items() if k != 'backend'}})
    result['outputs'] = outputs
    if 'cancellation' in result:
        result['cancellation'] = cancellation_record(result['cancellation'])
        if result['cancellation']['state'] == 'requesting':
            cancel_state(result, 'uncertain', '客户端已恢复，先查询原任务；上次取消是否送达待确认。')
    legacy_absence = result['status'] == 'failed' and result.get('error') in {
        '任务已离开后端队列且没有历史记录，可能被外部移除或后端重启',
        '后端地址已变化；请在原后端检查任务'}
    if (result['status'] == 'cancelled' or legacy_absence) and not has_terminal_evidence(result):
        result['status'], result['progress'] = 'unknown', None
        result.pop('finished_at', None)
        result.pop('error', None)
        result['status_warning'] = '旧版任务记录没有原引擎终态证据，正在查询原任务；不会自动重新生成。'
        cancel_state(result, 'uncertain', result['status_warning'])
    return result
