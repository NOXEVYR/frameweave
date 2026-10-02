/** Own-only preset editing preparation. Never uploads, executes or changes a canvas. */
import { generationInputPorts, edgeInputField, sourceOutputType, parseGraph, serializeGraph } from './graph.mjs';

export const PRESET_EDIT_REQUEST_LIMIT = 2 * 1024 * 1024;
const PRESETS = new Set(['h3_t2v', 'h3_i2v', 'h3_ref', 'sdxl', 'sdxl_i2i', 'krea', 'qwen21_t2i', 'qwen21_edit']);
const OMIT = new Set(['title', 'apiPrompt', 'package_id', 'packageValues', 'packageFields', 'packageMediaBackends',
  'inputLabels', 'outputs', 'jobId', 'editor_id', 'editor_backend', 'editor_baseline', 'editor_outputs',
  'editor_output_fields', 'editor_controls', 'editor_hidden_updates']);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const MODEL_ROLES = new Set(['checkpoint', 'dit', 'text_encoder', 'vae', 'audio_vae', 'lora', 'sdxl_clip_l', 'sdxl_clip_g']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && !!value && value.length <= 120 && !RESERVED.has(value);

function clone(value) {
  let count = 0;
  function visit(item, depth = 0) {
    if (++count > 300000 || depth > 64) throw new Error('预设编辑数据过大或嵌套过深');
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return;
    if (!item || typeof item !== 'object' || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('预设编辑仅支持安全 JSON 数据');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('预设编辑仅支持安全 JSON 数据');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('JSON 数组不能包含空槽位或额外属性');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (RESERVED.has(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('预设编辑仅支持安全 JSON 字段');
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > PRESET_EDIT_REQUEST_LIMIT) throw new Error('预设编辑完整请求超过 2 MiB');
  return JSON.parse(text);
}

function directSource(source) {
  // The host freezes full source identity/data separately. A large upstream API
  // graph or user history is not an editing input and must not consume this DTO.
  const keys = source.type === 'prompt' ? ['text', 'negative'] : source.type === 'reference'
    ? ['name', 'mediaType', 'uploadBackend', 'localAssetId', 'role']
    : ['kind', 'outputs', 'editor_outputs', 'editor_output_fields'];
  if (!record(source.data)) throw new Error('直接输入节点内容无效');
  const data = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source.data, key);
    if (!descriptor) continue;
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('直接输入仅支持安全 JSON 字段');
    data[key] = descriptor.value;
  }
  return { id: source.id, type: source.type, data: clone(data) };
}

function number(request, key, min, max, integer = false, alignment = 1) {
  if (!Object.hasOwn(request, key)) return;
  const value = request[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isSafeInteger(value) || alignment > 1 && value % alignment) throw new Error(`预设参数 ${key} 无效或超出范围`);
}
function name(value, label, empty = true) {
  if (typeof value !== 'string' || value.length > 1024 || !empty && !value) throw new Error(`${label}名称无效`);
  if (!value) return;
  const path = value.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes(':') || path.includes('\0') || path.split('/').some(part => ['.', '..'].includes(part))) throw new Error(`${label}必须为安全相对名称`);
}
function backend(value) {
  const proof = { id: 'proof', type: 'reference', x: 0, y: 0, data: { uploadBackend: value } };
  return parseGraph(serializeGraph({ nodes: [proof], edges: [] })).nodes[0].data.uploadBackend;
}
function validateOwn(request) {
  for (const key of ['positive', 'negative']) if (Object.hasOwn(request, key) && (typeof request[key] !== 'string' || request[key].length > 100000)) throw new Error(`${key} 必须是不超过 100000 字符的文本`);
  const alignment = request.kind.startsWith('h3') || request.kind.startsWith('qwen21') ? 32 : request.kind === 'krea' ? 16 : 8;
  for (const key of ['width', 'height']) number(request, key, 32, 8192, true, alignment);
  number(request, 'seed', 0, Number.MAX_SAFE_INTEGER, true);
  number(request, 'steps', 1, 1000, true); number(request, 'cfg', 0, 100); number(request, 'denoise', 0, 1);
  number(request, 'seconds', 5 / 24, 150); number(request, 'fps', 1, 120);
  if (request.kind.startsWith('h3') && request.fps !== undefined && request.fps !== 24) throw new Error('H3 原生生成帧率固定为 24 fps');
  if (request.kind.startsWith('qwen21') && request.denoise !== undefined && request.denoise !== 1) throw new Error('Qwen 2.1 denoise 必须为 1');
  for (const key of ['shift_video', 'shift_audio']) number(request, key, .01, 100);
  number(request, 'ref_resolution', 0, 4096, true, 32);
  if (Object.hasOwn(request, 'custom_size') && typeof request.custom_size !== 'boolean') throw new Error('custom_size 必须为布尔值');
  for (const key of ['sampler', 'scheduler', 'ref_image_size']) if (Object.hasOwn(request, key) && (typeof request[key] !== 'string' || request[key].length > 1024)) throw new Error(`${key} 必须为有界文本`);
  if (request.models !== undefined) {
    if (!record(request.models)) throw new Error('models 必须为对象');
    for (const [role, value] of Object.entries(request.models)) { if (!MODEL_ROLES.has(role)) throw new Error('模型角色无效或不受支持'); name(value, '模型'); }
  }
  if (request.lora !== undefined) name(request.lora, 'LoRA');
  number(request, 'lora_strength', -10, 10);
  if (request.loras !== undefined) {
    if (!Array.isArray(request.loras) || request.loras.length > 4) throw new Error('LoRA 必须为最多 4 项的列表');
    for (const lora of request.loras) {
      if (!record(lora) || Object.keys(lora).some(key => !['name', 'strength_model', 'strength_clip'].includes(key))) throw new Error('LoRA 参数无效');
      name(lora.name, 'LoRA');
      for (const key of ['strength_model', 'strength_clip']) number(lora, key, -10, 10);
      if (!request.kind.startsWith('sdxl') && lora.strength_clip !== undefined && lora.strength_clip !== 0) throw new Error('当前模式只支持模型 LoRA 强度');
    }
  }
  if (request.refine !== undefined) {
    const refine = request.refine;
    if (!record(refine) || typeof refine.enabled !== 'boolean' || Object.keys(refine).some(key => !['enabled', 'width', 'height', 'steps', 'denoise', 'upscale_method'].includes(key))) throw new Error('二次重绘参数无效');
    if (refine.enabled && !request.kind.startsWith('sdxl')) throw new Error('二次重绘仅支持 SDXL');
    for (const key of ['width', 'height']) number(refine, key, 32, 8192, true, 8);
    number(refine, 'steps', 1, 1000, true); number(refine, 'denoise', 0, 1);
    if (refine.upscale_method !== undefined && (typeof refine.upscale_method !== 'string' || refine.upscale_method.length > 1024)) throw new Error('二次重绘方法无效');
  }
}

/** Collect logical intent separately from own values; host supplies guards and live schemas. */
export function collectPresetEditRequest(graph, targetId, options = {}) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('预设编辑需要画布节点和连线');
  const matches = graph.nodes.filter(node => node.id === targetId);
  if (!identifier(targetId) || matches.length !== 1 || matches[0].type !== 'generation' || !PRESETS.has(matches[0].data?.kind)) throw new Error('请选择内置预设生成节点');
  const target = matches[0], data = clone(target.data);
  const preset_request = Object.fromEntries(Object.entries(data).filter(([key]) => !OMIT.has(key)));
  validateOwn(preset_request);
  if (data.inputLabels !== undefined && (!record(data.inputLabels) || Object.entries(data.inputLabels).some(([id, label]) => !/^[A-Za-z0-9_-]{1,80}$/.test(id) || typeof label !== 'string' || !label.trim() || label.length > 80))) throw new Error('生成输入端口名称无效');
  const ports = generationInputPorts({ ...target, data }), portMap = new Map(ports.map(port => [port.id, port]));
  const imagePorts = ports.filter(port => port.type === 'image');
  const logical = new Map(ports.map(port => [port.id, { logical_id: port.id, type: port.type,
    ...(data.inputLabels?.[port.id] ? { label: data.inputLabels[port.id] } : {}),
    ...(port.type === 'text' ? { own_key: port.id, separator: port.id === 'negative' ? ', ' : '\n\n', own_nonempty: !!data[port.id] } : {}), contributors: [] }]));
  const pending = [], diagnostics = [], active = new Set(), input_intents = {};
  const selectedBackend = options.backend ? backend(options.backend) : null;
  const addPending = (portId, reason, extra = {}) => pending.push({ logical_id: portId, port_id: portId, reason, ...extra });
  const mediaPending = (portId, source, extra, owner) => {
    const transfer = options.mediaTransfers?.state(`${options.canvasId}:${targetId}`, portId);
    const transaction = source?.id ? options.referenceImports?.get(source.id) : null;
    if (transfer || transaction) { addPending(portId, transfer?.status === 'failed' || transfer?.error || transaction?.error ? 'import_failed' : 'import_pending', { ...extra, origin: 'transaction' }); return; }
    const mediaName = source?.data?.name ?? owner?.name;
    if (!mediaName) { addPending(portId, source?.data?.localAssetId ? 'local_media_not_uploaded' : 'media_missing', extra); return; }
    name(mediaName, '参考图', false);
    const ownedBackend = source?.data?.uploadBackend || owner?.backend;
    if (!ownedBackend || !selectedBackend) addPending(portId, 'owner_unknown', extra);
    else if (backend(ownedBackend) !== selectedBackend) addPending(portId, 'backend_mismatch', extra);
  };
  const ownRefs = preset_request.references ?? [];
  if (!Array.isArray(ownRefs) || ownRefs.length > imagePorts.length || ownRefs.some(ref => typeof ref !== 'string')) throw new Error('本节点 references 必须是有界名称列表，不接受 studio 素材对象');
  ownRefs.forEach(ref => name(ref, '参考图'));
  const roles = preset_request.reference_roles;
  if (roles !== undefined && (!Array.isArray(roles) || roles.length !== ownRefs.length || roles.some(role => typeof role !== 'string' || !role || role.length > 64))) throw new Error('参考图角色必须与自身 references 一一对应');
  const ownUsed = new Set();
  const roleAliases = { start: 'start', first_frame: 'start', start_frame: 'start', first: 'start', end: 'end', last_frame: 'end', end_frame: 'end', last: 'end', reference: null };
  const resolvedRoles = ownRefs.map((_ref, index) => {
    if (data.kind !== 'h3_i2v') {
      if (data.kind.startsWith('qwen21') && roles && roles[index] !== 'reference') throw new Error('Qwen 参考槽位只支持 reference 角色');
      return 'reference';
    }
    const role = roles?.[index] ?? (index ? 'end' : 'start');
    if (!Object.hasOwn(roleAliases, role)) throw new Error('首尾帧角色无效');
    return roleAliases[role];
  });
  for (const role of resolvedRoles.filter(Boolean)) { if (data.kind === 'h3_i2v' && ownUsed.has(role)) throw new Error('首尾帧角色重复'); ownUsed.add(role); }
  const remaining = ['start', 'end'].filter(role => !ownUsed.has(role));
  ownRefs.forEach((value, own_index) => {
    const role = data.kind === 'h3_i2v' ? resolvedRoles[own_index] || remaining.shift() : 'reference';
    const portId = data.kind === 'h3_i2v' ? `${role}_image` : imagePorts[own_index].id;
    active.add(portId); Object.assign(logical.get(portId), { own_index, role,
      ...(roles ? { own_role: roles[own_index] } : {}), own_nonempty: !!value });
    const owner = data.packageMediaBackends?.[portId];
    if (owner && owner.name !== value) addPending(portId, 'owner_mismatch', { origin: 'own' });
    else mediaPending(portId, null, { origin: 'own' }, { ...owner, name: value });
  });
  const incoming = graph.edges.filter(edge => edge.target === targetId);
  if (incoming.length > 2000) throw new Error('直接输入连线超过 2000 条');
  const sources = new Map(), edgeIds = new Set(), occupied = new Set(), explicitText = new Set();
  for (const edge of incoming) {
    if (!identifier(edge.id) || edgeIds.has(edge.id) || !identifier(edge.source) || edge.source === targetId) throw new Error('直接输入连线标识无效或重复');
    edgeIds.add(edge.id);
    const found = graph.nodes.filter(node => node.id === edge.source);
    if (found.length !== 1) throw new Error('直接输入来源缺失或 ID 重复');
    if (!sources.has(edge.source)) sources.set(edge.source, directSource(found[0]));
  }
  const relevant = { nodes: [target, ...sources.values()], edges: incoming };
  incoming.forEach((rawEdge, order) => {
    const edge = clone(rawEdge), source = sources.get(edge.source);
    if (edge.sourceField !== undefined && !['text', 'negative', 'image', 'video', 'audio'].includes(edge.sourceField) || edge.outputIndex !== undefined && (!Number.isInteger(edge.outputIndex) || edge.outputIndex < 0 || edge.outputIndex > 31) || edge.sourceOutput !== undefined && !identifier(edge.sourceOutput)) throw new Error('直接输入连线参数无效');
    if (edge.targetField !== undefined && !portMap.has(edge.targetField)) throw new Error('生成节点目标端口不存在');
    if (source.type === 'prompt') {
      if (edge.sourceField && !['text', 'negative'].includes(edge.sourceField) || edge.outputIndex !== undefined || edge.sourceOutput !== undefined || edge.targetField && portMap.get(edge.targetField).type !== 'text') throw new Error('提示词连线类型无效');
      const keys = edge.targetField ? [edge.targetField] : ['positive', 'negative'];
      if (edge.targetField && explicitText.has(edge.targetField)) throw new Error('提示词目标端口连接重复');
      if (edge.targetField) explicitText.add(edge.targetField);
      for (const key of keys) {
        const source_field = !edge.targetField ? key === 'positive' ? 'text' : 'negative' : edge.sourceField || (key === 'negative' ? 'negative' : 'text');
        const value = source.data[source_field];
        if (typeof value !== 'string' || value.length > 100000) throw new Error('直接输入提示词必须是不超过 100000 字符的文本');
        logical.get(key).contributors.push({ edge_id: edge.id, source_id: edge.source, source_field, order,
          legacy: !edge.targetField, source_nonempty: !!value, source_length: value.length });
        input_intents[key] = true;
      }
      return;
    }
    if (!['reference', 'generation', 'result'].includes(source.type) || edge.sourceField && edge.sourceField !== 'image') throw new Error('内置预设参考连线必须为图片');
    const portId = edgeInputField(relevant, edge), port = portMap.get(portId);
    if (!port || port.type !== 'image') throw new Error('参考连线没有匹配的图片端口');
    if (occupied.has(portId)) throw new Error('参考图片槽位连接重复');
    occupied.add(portId); active.add(portId);
    const extra = { edge_id: edge.id, source_id: source.id, origin: 'connected' };
    logical.get(portId).contributors.push({ ...extra, source_field: 'image', order,
      ...(edge.outputIndex !== undefined ? { output_index: edge.outputIndex } : {}),
      ...(edge.sourceOutput !== undefined ? { source_output: edge.sourceOutput } : {}) });
    if (source.type === 'reference') {
      if (source.data.mediaType !== 'image' || edge.outputIndex !== undefined || edge.sourceOutput !== undefined) throw new Error('参考素材不是图片或连线参数无效');
      mediaPending(portId, source, extra);
    } else {
      const type = sourceOutputType(source, edge, 'image');
      if (type && type !== 'image') throw new Error('上游输出不是图片');
      addPending(portId, type ? 'upstream_not_run' : 'media_type_unproven', extra);
    }
  });
  if (!active.size && ['h3_i2v', 'h3_ref', 'sdxl_i2i', 'qwen21_edit'].includes(data.kind)) active.add(imagePorts[0].id);
  if (['h3_ref', 'krea', 'qwen21_edit'].includes(data.kind) && active.size) {
    const last = Math.max(...[...active].map(id => imagePorts.findIndex(port => port.id === id)));
    imagePorts.slice(0, last + 1).forEach(port => active.add(port.id));
  }
  const reference_slots = imagePorts.filter(port => active.has(port.id)).map(port => {
    const index = imagePorts.findIndex(item => item.id === port.id), role = port.id === 'start_image' ? 'start' : port.id === 'end_image' ? 'end' : 'reference';
    Object.assign(logical.get(port.id), { index, ordinal: index + 1, role });
    if (!occupied.has(port.id) && logical.get(port.id).own_index === undefined) addPending(port.id, 'media_missing', { origin: 'intent' });
    return { port_id: port.id, index, ordinal: index + 1, role };
  });
  const logical_inputs = [...logical.values()].filter(item => item.type === 'text' || active.has(item.logical_id));
  let requires_aggregation = false;
  for (const item of logical_inputs.filter(item => item.type === 'text')) {
    // Built-in requests concatenate legacy sources first, explicit sources next,
    // then own fallback, even when the original edge order interleaves them.
    item.contributors.sort((a, b) => Number(b.legacy) - Number(a.legacy) || a.order - b.order);
    item.contributors.forEach((contributor, index) => { contributor.aggregation_order = index; });
    item.requires_aggregation = item.contributors.length > 1 || item.contributors.length > 0 && item.own_nonempty;
    if (item.requires_aggregation) { requires_aggregation = true; diagnostics.push({ logical_id: item.logical_id, reason: 'aggregation_requires_atomic_migration' }); }
    const lengths = [...item.contributors.filter(contributor => contributor.source_nonempty).map(contributor => contributor.source_length), ...(item.own_nonempty ? [(data[item.own_key] || '').length] : [])];
    const combinedLength = lengths.reduce((sum, length) => sum + length, 0) + Math.max(0, lengths.length - 1) * item.separator.length;
    if (combinedLength > 100000) addPending(item.logical_id, 'aggregate_text_limit', { origin: 'connected' });
  }
  return clone({ preset_request, reference_slots, input_intents, model_intents: {}, logical_inputs,
    pending, requires_aggregation, diagnostics });
}
