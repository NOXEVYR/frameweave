"""Prepare a publishable declaration from an explicitly selected local workflow.

The declaration contains bounds and a binding digest, never the private request
defaults. Preparing it only compiles; it does not publish, claim or generate.
"""
import copy
import json
import re

from .hub_execution_contract import bind_declaration, binding_fingerprint, validate_inputs, canonical, ContractError


def field_schema(field):
    kind = field.get('type')
    if kind == 'text':
        return {'type': 'string', 'maxLength': 12000, **({'minLength': 1} if field.get('required') else {})}
    if kind in {'integer', 'number'}:
        result = {'type': kind, 'minimum': field.get('min', -9007199254740991),
                  'maximum': field.get('max', 9007199254740991)}
        return result
    if kind == 'boolean':
        return {'type': 'boolean'}
    if kind == 'select':
        options = field.get('options', [])
        if not 1 <= len(options) <= 32:
            raise ValueError('此下拉菜单超过声明支持的 32 个选项或没有选项，请保持为本地固定值')
        if all(isinstance(value, str) for value in options):
            if any(len(value) > 12000 for value in options):
                raise ValueError('下拉选项超过 12000 字符，请保持为本地固定值')
            return {'type': 'string', 'enum': copy.deepcopy(options), 'maxLength': 12000}
        if all(type(value) is bool for value in options):
            return {'type': 'boolean', 'enum': list(options)}
        if all(type(value) in (int, float) for value in options):
            # A browser serializes integral JSON numbers without a decimal point.
            values = list(dict.fromkeys(int(value) if value == int(value) else value for value in options))
            return {'type': 'integer' if all(type(value) is int for value in values) else 'number', 'enum': values}
        raise ValueError('混合类型下拉菜单不能直接公开，请保持为本地固定值')
    raise ValueError('参考图片、视频和音频在此能力中保持本地固定；跨应用素材传输尚未开放')


def prepare_offer(app, data):
    required = {'request', 'name', 'key', 'field_ids', 'domain', 'backend_url'}
    if not isinstance(data, dict) or not required <= set(data) or set(data) - required - {'field_descriptions'}:
        raise ValueError('请从已配置工作流选择请求、名称、标识、开放参数和用途')
    name, key = data['name'], data['key']
    if not isinstance(name, str) or not name.strip() or len(name) > 120:
        raise ValueError('能力名称需要 1–120 个字符')
    if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}', key):
        raise ValueError('能力标识请使用 1–100 位英文、数字及 . _ : -')
    if not isinstance(data['domain'], str) or data['domain'] not in {'image', 'video', 'audio'}:
        raise ValueError('请选择图片、视频或音频用途')
    request = copy.deepcopy(data['request'])
    if (not isinstance(request, dict) or request.get('kind') != 'package'
            or set(request) - {'kind', 'package_id', 'values', 'output_nodes', 'editor_backend'}):
        raise ValueError('请先把工作流保存为可复用工作流包，再选择其外层节点')
    fields = data['field_ids']
    if (not isinstance(fields, list) or not 1 <= len(fields) <= 32
            or any(not isinstance(value, str) for value in fields) or len(set(fields)) != len(fields)):
        raise ValueError('每项能力请选择 1–32 个不重复的外部输入')
    descriptions = data.get('field_descriptions', {})
    if (not isinstance(descriptions, dict) or set(descriptions) - set(fields)
            or any(not isinstance(value, str) or not value.strip() or len(value) > 200 for value in descriptions.values())):
        raise ValueError('公开参数说明需对应已选字段，每项 1–200 字符')
    with app.lock:
        backend = app.backend
        if data['backend_url'] != backend.url:
            raise ValueError('推理引擎已变化，请重新读取所选工作流')
        if request.pop('editor_backend', backend.url) != backend.url:
            raise ValueError('工作流属于另一引擎，请先恢复原引擎')
        package = app.packages.get(request.get('package_id'))
    supplied = request.get('values', {})
    definitions = {field['id']: field for field in package['fields']}
    if not isinstance(supplied, dict) or set(supplied) - set(definitions) or set(fields) - set(definitions):
        raise ValueError('工作流输入定义已变化，请重新读取节点')
    request['values'] = {field['id']: copy.deepcopy(supplied.get(field['id'], field.get('default')))
                         for field in package['fields']}
    properties, bindings, mapping = {}, {}, []
    for index, field_id in enumerate(fields):
        field = definitions[field_id]
        external = f'input_{index + 1}'
        properties[external] = field_schema(field)
        if field_id in descriptions:
            properties[external]['description'] = descriptions[field_id].strip()
        value = request['values'][field_id]
        if field['type'] == 'select' and type(value) is float and value.is_integer():
            request['values'][field_id] = int(value)
        bindings[external] = ['values', field_id]
        # Labels aid the local mapping UI; they are not copied to the public
        # declaration, where a user-supplied node label might contain a path.
        mapping.append({'input': external, 'field_id': field_id, 'label': field['label'],
                        'type': field['type'], 'schema': properties[external]})
    inputs = {'type': 'object', 'properties': properties, 'required': [], 'additionalProperties': False}
    try:
        sample = {key: request['values'][path[1]] for key, path in bindings.items()}
        validate_inputs(sample, inputs)
    except ContractError:
        raise ValueError('所选输入的当前值超过对外声明范围，请调整后重试；提示词最多 12000 字符') from None
    if len(canonical(sample)) > 16000:
        raise ValueError('所选参数的当前内容合计超过 16000 字节，请减少对外输入或缩短当前值')
    compiled = app.compile(request)
    with app.lock:
        if app.backend is not backend or app.packages.get(package['id'])['id'] != package['id']:
            raise ValueError('准备期间引擎或工作流已变化，请重新读取节点')
    active = compiled.get('summary', {}).get('execution', {}).get('node_ids')
    if active is not None and any(definitions[field_id]['node_id'] not in active for field_id in fields):
        raise ValueError('所选参数不属于当前输出分支，请重新选择开放参数')
    declaration = bind_declaration({'key': key, 'name': name.strip(), 'kind': 'mcp_tool',
        'domains': [data['domain']], 'description': '棱光本地工作流，仅可调整已声明的标量输入。',
        'inputs': inputs,
        'constraints': ['Requires an explicitly enabled PrismCanvas worker and the approved local workflow.']},
        backend.url, request, bindings)
    # Hub v1 stores its normalized declaration with JSON's default separators.
    # Compact JSON undercounts one space per field/array separator, which is
    # substantial for many enum choices. Include all normalized default fields.
    normalized = dict(provider='', server='', tags=[], outputs=[], hints={}, **declaration)
    published_text = json.dumps(normalized, ensure_ascii=False)
    if len(published_text.encode('utf-8')) > 32768:
        raise ValueError('能力声明超过发布大小限制，请减少公开字段或下拉选项')
    profile = {'schema': 'prismcanvas.hub-capability/1', 'capability_id': '0' * 32,
               'declaration_text': published_text, 'backend': backend.url, 'template': request,
               'bindings': bindings, 'enabled': False}
    if len(canonical(profile)) > 128 * 1024:
        raise ValueError('冻结工作流参数过大，请精简当前配置后重新准备能力')
    return {'schema': 'prismcanvas.hub-offer/1', 'backend': backend.url, 'template': request,
            'bindings': bindings, 'declaration': declaration, 'mapping': mapping,
            'binding_sha256': binding_fingerprint(backend.url, request, bindings),
            'notice': '仅导出能力声明；固定参数与素材留在本机。发布后请粘贴能力 ID，核对并保存，再单独启用。'}
