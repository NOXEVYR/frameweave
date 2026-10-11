"""Recover settings field by field, with visible warnings and intact originals."""
import json
import hashlib
from .backend import local_url
from .configuration_recovery import read_config, preserve_config
from .workspace_services import PROFILES

MAX_SETTINGS_BYTES = 256 * 1024
DEFAULTS = {'backend_url': 'http://127.0.0.1:8188', 'model_roots': [], 'comfy_roots': [],
            'auto_start_engine': False, 'auto_update': False, 'performance_profile': 'auto'}


def load_settings(path, validate_roots):
    settings = {key: list(value) if isinstance(value, list) else value for key, value in DEFAULTS.items()}
    issues = []
    digest = None
    try:
        raw = read_config(path, MAX_SETTINGS_BYTES)
        digest = hashlib.sha256(raw).hexdigest()
        saved = json.loads(raw.decode('utf-8-sig'))
        if not isinstance(saved, dict):
            raise ValueError('设置须为对象')
    except FileNotFoundError:
        return settings, [], False
    except (OSError, ValueError, TypeError, RecursionError):
        saved = {}
        issues.append('settings.json 无法完整读取，当前使用默认设置')
    for key, default in DEFAULTS.items():
        if key not in saved:
            continue
        value = saved[key]
        try:
            if key == 'backend_url':
                if not isinstance(value, str):
                    raise ValueError()
                value = local_url(value)
            elif key in ('model_roots', 'comfy_roots'):
                value = validate_roots(value)
            elif key in ('auto_start_engine', 'auto_update'):
                if type(value) is not bool:
                    raise ValueError()
            elif not isinstance(value, str) or value not in PROFILES:
                raise ValueError()
            settings[key] = value
        except (ValueError, TypeError, OSError, RecursionError):
            fallback = '空目录列表' if isinstance(default, list) else str(default).lower()
            issues.append(f'settings.json 的 {key} 无效，当前回退为 {fallback}；其他有效字段保留')
    if not issues:
        return settings, [], False
    # A repaired address must never redirect automatic startup or updates.
    settings['auto_start_engine'] = settings['auto_update'] = False
    issues.append('本次启动暂停自动拉起引擎和自动更新；确认恢复内容后可在设置中重新开启')
    protected = False
    try:
        backup = preserve_config(path, expected_digest=digest)
        issues.append(f'settings.json 原件保留，恢复备份为 {backup}；只有明确保存设置才会写回')
    except (OSError, ValueError):
        protected = True
        issues.append('settings.json 恢复备份失败，原件保留；设置写入已阻止，请先手动备份或修复文件权限后重启')
    return settings, issues, protected
