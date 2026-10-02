"""A bounded, non-secret identity for ComfyUI's directed progress channel."""

import json
import re
import uuid
from pathlib import Path


LIMIT = 1024
FILENAME = 'progress-client.json'


def valid_client_id(value):
    return isinstance(value, str) and re.fullmatch(r'(?:frameweave-)?[0-9a-f]{32}', value) is not None


def _read(path):
    try:
        with path.open('rb') as stream:
            raw = stream.read(LIMIT + 1)
        if len(raw) > LIMIT:
            return None, 'invalid'
        data = json.loads(raw)
        if (not isinstance(data, dict) or type(data.get('version')) is not int
                or data['version'] != 1 or not valid_client_id(data.get('client_id'))):
            return None, 'invalid'
        return data['client_id'], 'valid'
    except FileNotFoundError:
        return None, 'missing'
    except (OSError, ValueError, UnicodeError, RecursionError):
        return None, 'invalid'


def persist_progress_identity(data_dir, client_id):
    """Save only when missing; return a warning without disclosing the identity."""
    if not valid_client_id(client_id):
        return '生成进度连接身份格式无效，未保存；本次连接身份恢复可能受限。'
    path = Path(data_dir) / FILENAME
    _, state = _read(path)
    if state == 'valid':
        return ''
    if state == 'invalid':
        return '生成进度连接身份记录损坏、过大或无法读取，已保留原件；重启后的实时进度恢复可能受限。'
    try:
        # Exclusive creation never overwrites a file that appeared concurrently.
        with path.open('x', encoding='utf-8') as stream:
            json.dump({'version': 1, 'client_id': client_id}, stream)
            stream.flush()
    except FileExistsError:
        _, concurrent_state = _read(path)
        if concurrent_state != 'valid':
            return '生成进度连接身份保存冲突，已保留已有文件；重启后的实时进度恢复可能受限。'
    except OSError:
        return '生成进度连接身份无法保存；本次仍可提交生成，重启后的实时进度恢复可能受限。'
    return ''


def load_progress_identity(data_dir, jobs, backend_url=None, *, persist=True):
    """Return (client_id, warning), preserving every existing identity file.

    An unambiguous active job's original identity wins for this session. A
    valid saved identity remains the default for sessions with no active jobs.
    Multiple older identities cannot be subscribed through a single socket.
    Set persist=False during read-only startup/discovery; persist explicitly
    before the first real submission using persist_progress_identity.
    """
    path = Path(data_dir) / FILENAME
    saved, state = _read(path)
    records = jobs.values() if isinstance(jobs, dict) else jobs
    active = [job for job in records if isinstance(job, dict)
              and job.get('status') in {'queued', 'running'}
              and (backend_url is None or job.get('backend') == backend_url)]
    identities = {job['client_id'] for job in active if valid_client_id(job.get('client_id'))}
    chosen = next(iter(identities)) if len(identities) == 1 else saved or 'frameweave-' + uuid.uuid4().hex
    warnings = []
    if state == 'invalid':
        warnings.append('生成进度连接身份记录损坏、过大或无法读取，已保留原件；实时进度可能需要等待后端明确任务事件。')
    if len(identities) > 1:
        warnings.append('活跃任务来自多个进度连接身份，当前通道无法订阅全部旧任务；任务状态仍由后端队列和历史确认。')
    if any(not valid_client_id(job.get('client_id')) for job in active):
        warnings.append('部分旧任务缺少可恢复的进度连接身份；等待明确任务事件期间不保证实时进度或预览。')
    if persist and state == 'missing':
        warning = persist_progress_identity(data_dir, chosen)
        if warning:
            warnings.append(warning)
        elif len(identities) != 1:
            concurrent, concurrent_state = _read(path)
            if concurrent_state == 'valid':
                chosen = concurrent
    return chosen, '\n'.join(warnings)
