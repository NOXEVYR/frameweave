"""Prepare a built-in recipe as editing data, with proven interface receipts."""
from __future__ import annotations

import copy

from .editor_interfaces import inspect_interface
from .editor_preparation import prepare_editor_document
from .packages import encoded, MAX_INSPECTION_FIELDS
from .workflows import build_preset_editor_recipe


def prepare_preset_editor(data, *, info, backend_url):
    # Include intents and provenance in the same bounded envelope as the source.
    encoded(data)
    recipe = build_preset_editor_recipe(data['preset_request'], info or {},
        reference_slots=data.get('reference_slots'), input_intents=data.get('input_intents'),
        model_intents=data.get('model_intents'))
    if recipe.get('status') not in {'blocked', 'materialized'}:
        raise ValueError('预设编辑构图返回了未知状态')
    common = {'source_kind': 'preset', 'source_revision': None, 'backend_url': backend_url,
              'source_request': copy.deepcopy(recipe['source_request']),
              'intents': copy.deepcopy(recipe.get('intents', {}))}
    if recipe['status'] == 'blocked':
        result = {**common, 'status': 'blocked', 'prompt': None, 'source_document': None,
                  'receipt': [], 'fields': [], 'receipt_complete': False,
                  'blocked': copy.deepcopy(recipe.get('blocked', [])),
                  'pending': copy.deepcopy(recipe.get('pending', [])), 'overrides': [],
                  'diagnostics': []}
        encoded(result)
        return result

    original = {'prompt': copy.deepcopy(recipe['prompt'])}
    inspected = inspect_interface(recipe['prompt'], info or {})
    fields = inspected['fields']
    by_binding = {}
    for field in fields:
        by_binding.setdefault((field['node_id'], field['input'], field['type']), []).append(field)
    receipt, issues, logical_targets, claimed = [], [], {}, set()
    for item in recipe.get('receipt', []):
        logical = item.get('logical_id')
        entry = copy.deepcopy(item)
        targets = entry.get('targets')
        valid_entry = isinstance(logical, str) and bool(logical) and logical not in logical_targets and isinstance(targets, list) and bool(targets)
        if not valid_entry:
            issues.append({'code': 'interface_binding_unproven', 'logical_id': logical,
                'message': '预设接口身份重复、缺失或没有绑定目标；完整图保留，需检查绑定。'})
        for target in targets if isinstance(targets, list) else []:
            target.pop('field_id', None)
            key = (target.get('node_id'), target.get('input'), target.get('type'))
            candidates = by_binding.get(key, [])
            if not valid_entry or target.get('type') != entry.get('type') or len(candidates) != 1 or key in claimed:
                issues.append({'code': 'interface_binding_unproven', 'logical_id': logical,
                    'node_id': target.get('node_id'), 'input': target.get('input'),
                    'message': '预设输入无法唯一对应当前接口候选；完整图保留，需检查绑定。'})
                continue
            claimed.add(key)
            target['field_id'] = candidates[0]['id']
        if valid_entry:
            logical_targets[logical] = targets
        receipt.append(entry)

    waiting = copy.deepcopy(recipe.get('pending', []))
    supplied = data.get('pending', [])
    if not isinstance(supplied, list) or len(supplied) > MAX_INSPECTION_FIELDS or any(not isinstance(item, dict) for item in supplied):
        raise ValueError('预设待处理输入须为有界对象列表')
    for item in supplied:
        targets = logical_targets.get(item.get('logical_id') or item.get('port_id'), [])
        proven = [target for target in targets if target.get('field_id')]
        if not proven:
            waiting.append(copy.deepcopy(item))
            continue
        for target in proven:
            waiting.append({**copy.deepcopy(item), 'field_id': target['field_id'],
                            'node_id': target['node_id'], 'input': target['input']})
    prepared = prepare_editor_document(original, fields=fields, overrides=data.get('overrides'),
        pending=waiting, info=info, backend_url=backend_url)
    result = {**prepared, **common, 'receipt': receipt, 'receipt_complete': not issues,
              'fields': fields, 'outputs': inspected['outputs'], 'summary': recipe.get('summary', {}),
              'diagnostics': [*prepared['diagnostics'], *issues], 'blocked': []}
    # Reject an oversized complete response; never return truncated source/receipt.
    encoded(result)
    return result
