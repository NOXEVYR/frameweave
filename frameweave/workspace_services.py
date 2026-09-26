"""Hardware suggestions and owned-result locations for local workspaces."""
import math
import os
from pathlib import Path, PureWindowsPath
import re

PROFILES = ('auto', '8', '12', '16', '24', '32', '48')
MAX_DEVICE_BYTES = 2 ** 60
MAX_OUTPUTS = 1024
MAX_ARGS = 256


def _memory_mib(value):
    if not _valid_bytes(value):
        return None
    return round(value / (1024 * 1024))


def _valid_bytes(value):
    if type(value) is int:
        return 0 <= value <= MAX_DEVICE_BYTES
    if type(value) is float:
        return math.isfinite(value) and 0 <= value <= MAX_DEVICE_BYTES
    return False


def performance_plan(profile, status):
    if not isinstance(profile, str) or profile not in PROFILES:
        raise ValueError('显存预算选项无效')
    if not isinstance(status, dict):
        raise ValueError('后端显存状态无效')
    raw_devices = status.get('devices', [])
    if not isinstance(raw_devices, list):
        raise ValueError('后端设备列表无效')
    devices = raw_devices[:64]
    device = next((d for d in devices if isinstance(d, dict)
                   and isinstance(d.get('type'), str)
                   and d['type'].lower() in {'cuda', 'hip', 'xpu', 'mps'}), None)

    raw_total = device.get('vram_total') if device else None
    raw_free = device.get('vram_free') if device else None
    total = _memory_mib(raw_total) if _valid_bytes(raw_total) else None
    free = (_memory_mib(raw_free) if _valid_bytes(raw_free) and _valid_bytes(raw_total)
            and raw_free <= raw_total else None)
    if total == 0:
        total = None
        free = None
    # Total capacity is not available capacity: models and other applications
    # may already occupy it, so automatic sizing uses only measured free VRAM.
    budget = free if profile == 'auto' else int(profile) * 1024
    if budget is None or budget < 10 * 1024:
        image, video, seconds = 512, (512, 288), 3
    elif budget < 15 * 1024:
        image, video, seconds = 768, (640, 384), 4
    elif budget < 23 * 1024:
        image, video, seconds = 1024, (768, 448), 5
    elif budget < 31 * 1024:
        image, video, seconds = 1024, (1024, 576), 5
    else:
        image, video, seconds = 1536, (1280, 704), 6

    name = device.get('name', '') if device else ''
    if not isinstance(name, str):
        name = ''
    name = ''.join(ch for ch in name[:120] if ch.isprintable())
    basis = 'backend' if device and (total is not None or free is not None) else 'unknown'
    detail = ('按当前后端可用显存保守建议起始尺寸；模型已占用的显存会影响此数值。'
              if profile == 'auto' and free is not None else
              '没有实时空闲显存证据，先使用保守试样尺寸。'
              if profile == 'auto' else '按所选显存预算建议起始尺寸。')
    return {'profile': profile,
            'detected': {'name': name, 'total_vram_mb': total,
                         'available_vram_mb': free, 'basis': basis},
            'suggested': {'image_width': image, 'image_height': image,
                          'video_width': video[0], 'video_height': video[1], 'video_seconds': seconds},
            'detail': detail + ' 点击应用才改变表单；不改变模型、量化、精度或后端加速配置，实际显存仍须小样验证。'}


def _safe_output_part(value, *, filename=False):
    if (not isinstance(value, str) or len(value) > (255 if filename else 1024)
            or any(not ch.isprintable() for ch in value) or '\x00' in value):
        return False
    if filename:
        windows = PureWindowsPath(value)
        return bool(value and value not in {'.', '..'} and Path(value).name == value
                    and '\\' not in value and '/' not in value and ':' not in value
                    and not windows.drive and not windows.root)
    normalized = value.replace('\\', '/')
    windows = PureWindowsPath(value)
    return (not windows.is_absolute() and not windows.drive and not normalized.startswith('/')
            and ':' not in value and all(part not in {'.', '..'} for part in normalized.split('/') if part))


def _local_absolute(value):
    if not isinstance(value, str) or not value or len(value) > 4096 or '\x00' in value:
        return None
    if value.startswith(('\\\\', '//')):
        return None
    try:
        path = Path(value)
        if not path.is_absolute() or PureWindowsPath(value).is_absolute() and os.name != 'nt':
            return None
        return path
    except (OSError, TypeError, ValueError, RuntimeError):
        return None


def _argument(args, name):
    for index, value in enumerate(args):
        if value == name and index + 1 < len(args):
            return args[index + 1]
        if value.startswith(name + '='):
            return value[len(name) + 1:]
    return None


def _profile_root(profile):
    """Derive an output root only from a bounded local engine profile."""
    main = _local_absolute(profile.get('main_script'))
    if main is None:
        return None
    working_value = profile.get('working_directory')
    work = _local_absolute(working_value) if working_value else main.parent
    if work is None:
        return None
    args = profile.get('arguments', [])
    if (not isinstance(args, list) or len(args) > MAX_ARGS
            or any(not isinstance(arg, str) or len(arg) > 4096 or '\x00' in arg for arg in args)):
        return None
    base_value = _argument(args, '--base-directory')
    if base_value is None:
        base = main.parent
    else:
        if not base_value or base_value.startswith(('\\\\', '//')):
            return None
        candidate = Path(base_value)
        base = candidate if candidate.is_absolute() else work / candidate
    output_value = _argument(args, '--output-directory')
    if output_value is None:
        root = base / 'output'
    else:
        if not output_value or output_value.startswith(('\\\\', '//')):
            return None
        candidate = Path(output_value)
        root = candidate if candidate.is_absolute() else work / candidate
    if not root.is_absolute() or str(root).startswith(('\\\\', '//')):
        return None
    try:
        return _local_absolute(str(root.resolve()))
    except (OSError, ValueError, RuntimeError):
        return None


def result_location(job, index, profiles, *, open_folder=False):
    if not isinstance(job, dict):
        raise ValueError('任务结果格式无效')
    if type(open_folder) is not bool:
        raise ValueError('打开目录选项无效')
    outputs = job.get('outputs', [])
    if not isinstance(outputs, list) or len(outputs) > MAX_OUTPUTS:
        raise ValueError('任务结果列表无效')
    if type(index) is not int or not 0 <= index < len(outputs):
        raise ValueError('请选择这个任务的有效生成结果')
    output = outputs[index]
    if not isinstance(output, dict):
        raise ValueError('输出路径无效')
    filename, subfolder = output.get('filename', ''), output.get('subfolder', '')
    if not _safe_output_part(filename, filename=True) or not _safe_output_part(subfolder):
        raise ValueError('输出路径无效')
    backend = job.get('backend')
    if not isinstance(backend, str) or len(backend) > 2048:
        backend = None
    result = {'filename': filename, 'subfolder': subfolder, 'backend_url': backend,
              'path': None, 'directory': None, 'can_open': False,
              'detail': '结果由该任务的推理引擎保存；未登记其输出目录，可用“下载”另存到你选择的位置。'}
    profiles = profiles[:128] if isinstance(profiles, list) else []
    profile = next((p for p in profiles if isinstance(p, dict) and p.get('base_url') == backend), None)
    if profile and backend and output.get('storage_type', 'output') == 'output':
        root = _profile_root(profile)
        if root is not None:
            try:
                relative = Path(subfolder) if subfolder else Path()
                path = (root / relative / filename).resolve()
                if path.is_relative_to(root) and path.is_file():
                    result.update(path=str(path), directory=str(path.parent), can_open=os.name == 'nt',
                                  detail='已核实此任务的本地输出文件；下载另存不会移动原文件。')
            except (OSError, TypeError, ValueError, RuntimeError):
                pass
    if open_folder:
        if not result['can_open']:
            raise ValueError('无法确认可打开的本地输出目录，请使用下载另存')
        try:
            os.startfile(result['directory'])
        except (OSError, AttributeError):
            raise ValueError('无法打开已确认的本地输出目录，请使用下载另存') from None
        result['opened'] = True
    return result
