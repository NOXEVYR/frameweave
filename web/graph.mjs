import { MAX_INTERFACE_FIELDS } from './interface-limits.mjs';
/** Pure graph operations shared by the canvas and dependency-free tests. */
import { packageValues, parseJSONWithSafeNumbers } from './packages.mjs';
import { cachedPackageField } from './canvas-port-layout.mjs';
import { normalizeHiddenUpdates } from './editor-hidden-updates.mjs';
import { normalizeTextCompositions, composeTextInput, textCompositionOwn, textSourceOccurrence, textContributionIdentity } from './text-input-composition.mjs';
export const SCHEMA = 'frameweave.canvas.v1';
export const COMPOSED_SCHEMA = 'frameweave.canvas.v2';
export const NODE_TYPES = ['prompt', 'reference', 'generation', 'result'];
export const KINDS = ['h3_t2v', 'h3_i2v', 'h3_ref', 'sdxl', 'sdxl_i2i', 'krea', 'qwen21_t2i', 'qwen21_edit', 'api', 'package'];
const copy = value => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const FIELD_TYPES = ['text', 'integer', 'number', 'boolean', 'select', 'image', 'audio', 'video'];
const MEDIA_TYPES = ['image', 'video', 'audio'];
const mediaLabel = type => ({ image: '图片', video: '视频', audio: '音频' })[type] || '媒体';
const RESERVED_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const fieldId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !RESERVED_FIELDS.has(value);

function localBackendIdentity(value, label = '媒体来源引擎') {
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`${label}无效`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label}无效`); }
  let hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname)) {
    throw new Error(`${label}必须是本机回环地址`);
  }
  if (hostname === 'localhost') url.hostname = '127.0.0.1';
  hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipv4 = hostname.split('.').map(Number);
  const isLoopbackV4 = ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) && ipv4[0] === 127;
  if (!isLoopbackV4 && hostname !== '::1') throw new Error(`${label}必须是本机回环地址`);
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label}端口无效`);
  // Match Python's existing engine/job identities, which retain IPv6 spelling.
  const ipv6 = hostname === '::1' ? value.match(/^http:\/\/\[([^\]]+)\]/i)?.[1].toLowerCase() : null;
  return `http://${ipv6 ? `[${ipv6}]` : hostname}:${port}`;
}

function packageMediaOwners(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_INTERFACE_FIELDS) throw new Error('工作流包媒体来源记录无效');
  const owners = {};
  for (const [id, owner] of Object.entries(value)) {
    if (!fieldId(id) || !owner || typeof owner !== 'object' || Array.isArray(owner)
        || typeof owner.name !== 'string' || !owner.name) throw new Error('工作流包媒体来源字段无效');
    owners[id] = { name: uploadedMediaName(owner.name, '工作流包媒体'), backend: localBackendIdentity(owner.backend, '工作流包媒体来源引擎') };
    if (owner.preview_url !== undefined) {
      if (typeof owner.preview_url !== 'string' || !/^\/api\/media\/[a-f0-9]{32}$/.test(owner.preview_url)) throw new Error('工作流包媒体预览必须是已登记的本机媒体地址');
      owners[id].preview_url = owner.preview_url;
    }
  }
  return owners;
}

/** Cached public ports only. The actual package is refreshed and validated before running. */
function packageFields(value) {
  if (!Array.isArray(value) || value.length > MAX_INTERFACE_FIELDS) throw new Error(`工作流包最多开放 ${MAX_INTERFACE_FIELDS} 个输入参数`);
  const seen = new Set();
  return value.map(field => {
    if (!field || typeof field !== 'object' || Array.isArray(field) || !fieldId(field.id) || seen.has(field.id)) throw new Error('工作流包参数 ID 无效或重复');
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120) throw new Error('工作流包参数名称必须是 1–120 字符的文本');
    if (!FIELD_TYPES.includes(field.type)) throw new Error('工作流包不支持此参数类型');
    seen.add(field.id);
    if (field.presentation !== undefined && !['port', 'control'].includes(field.presentation)) throw new Error('接口展示方式无效');
    for (const key of ['role', 'group']) if (field[key] !== undefined && (typeof field[key] !== 'string' || field[key].length > 120)) throw new Error('接口分类无效');
    return cachedPackageField(field);
  });
}

function normalizedInputLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_INTERFACE_FIELDS) throw new Error('生成输入端口名称无效');
  const labels = {};
  for (const [id, label] of Object.entries(value)) {
    if (!fieldId(id) || typeof label !== 'string' || !label.trim() || label.length > 80) throw new Error('生成输入端口名称无效');
    labels[id] = label.trim();
  }
  return labels;
}

const makePort = (id, label, type, labels) => ({ id, label: labels?.[id] || label, type });

/** Public, typed inputs for built-in generators and workflow packages. */
export function generationInputPorts(node) {
  if (!node || node.type !== 'generation') return [];
  const labels = node.data?.inputLabels || {};
  if (node.data?.kind === 'package') {
    try { return packageFields(node.data.packageFields || []).map(field => ({ ...field, label: labels[field.id] || field.label })); }
    catch { return []; }
  }
  const kind = node.data?.kind;
  if (!KINDS.includes(kind) || ['api', 'package'].includes(kind)) return [];
  const inputs = [makePort('positive', '正向提示词', 'text', labels), makePort('negative', '负向提示词', 'text', labels)];
  const addImages = (prefix, count, label) => {
    for (let index = 1; index <= count; index++) inputs.push(makePort(prefix + index, label(index), 'image', labels));
  };
  if (kind === 'qwen21_edit') addImages('image_', 10, index => index === 1 ? '编辑目标' : '参考图 ' + index);
  else if (kind === 'sdxl' || kind === 'sdxl_i2i') addImages('image_', 1, () => '输入图');
  else if (kind === 'krea') addImages('image_', 3, index => '参考图 ' + index);
  else if (kind === 'h3_i2v') inputs.push(makePort('start_image', '首帧', 'image', labels), makePort('end_image', '尾帧', 'image', labels));
  else if (kind === 'h3_ref') {
    for (let index = 0; index < 9; index++) inputs.push(makePort('ref_image_' + index, '参考图 ' + (index + 1), 'image', labels));
  }
  return inputs;
}

export function sourceOutputType(source, edge, expected = 'image', graph) {
  if (!['generation', 'result'].includes(source?.type)) return null;
  let outputs = source.data?.outputs;
  const index = edge?.outputIndex || 0;
  if (source.type === 'result' && graph) {
    const owner = graph.nodes.find(node => node.type === 'generation' && graph.edges.some(link => link.source === node.id && link.target === source.id));
    if (owner) {
      // A historical file cannot reintroduce an output removed from the current
      // workflow contract. Unknown-but-still-present sinks can use file evidence.
      if (edge?.sourceOutput && Array.isArray(owner.data.editor_outputs) && !owner.data.editor_outputs.includes(edge.sourceOutput)) return null;
      if (Array.isArray(outputs) && Array.isArray(owner.data.editor_outputs)) outputs = outputs.filter(item => owner.data.editor_outputs.includes(item.node_id));
      const declared = sourceOutputType(owner, edge, expected);
      if (declared) return declared;
    }
  }
  if(source.type==='generation') {
    if (edge?.sourceOutput && Array.isArray(source.data.editor_outputs) && !source.data.editor_outputs.includes(edge.sourceOutput)) return null;
    if (Array.isArray(outputs) && Array.isArray(source.data.editor_outputs)) outputs = outputs.filter(item => source.data.editor_outputs.includes(item.node_id));
    if(source.data.kind?.startsWith('h3_')) return 'video';
    if(['sdxl','sdxl_i2i','krea','qwen21_t2i','qwen21_edit'].includes(source.data.kind)) return 'image';
    const definitions=(source.data.editor_output_fields||[]).filter(field=>(!Array.isArray(source.data.editor_outputs) || source.data.editor_outputs.includes(field.id)) && (!edge?.sourceOutput||field.id===edge.sourceOutput));
    if(definitions.some(field=>field.mediaType===expected))return expected;
    const types=[...new Set(definitions.map(field=>field.mediaType).filter(type=>['image','video','audio'].includes(type)))];
    if(types.length===1)return types[0];
  }
  if (Array.isArray(outputs) && outputs.length) {
    const matching = outputs.filter(item => item.type === expected && (!edge?.sourceOutput || item.node_id === edge.sourceOutput));
    if (matching[index]) return expected;
    const types = [...new Set(outputs.filter(item => !edge?.sourceOutput || item.node_id === edge.sourceOutput).map(item => item.type).filter(type => MEDIA_TYPES.includes(type)))];
    return types.length === 1 ? types[0] : null;
  }
  return null;
}

/** Resolve a persisted or legacy implicit input slot for canvas rendering. */
export function edgeInputField(graph, edge) {
  const target = graph?.nodes?.find(node => node.id === edge?.target && node.type === 'generation');
  if (!target) return undefined;
  if (edge.targetField) return edge.targetField;
  const source = graph.nodes.find(node => node.id === edge.source);
  if (source?.type === 'prompt') return 'positive';
  if (!['reference', 'generation', 'result'].includes(source?.type)) return undefined;
  const ports = generationInputPorts(target).filter(item => item.type === 'image');
  if (!ports.length) return undefined;
  const incoming = graph.edges.filter(item => item.target === target.id && ['reference', 'generation', 'result'].includes(graph.nodes.find(node => node.id === item.source)?.type));
  const used = new Set(incoming.filter(item => item.targetField).map(item => item.targetField));
  const legacy = incoming.filter(item => !item.targetField);
  const assign = new Map();
  if (target.data.kind === 'h3_i2v') {
    const start = legacy.find(item => graph.nodes.find(node => node.id === item.source)?.data.role === 'start');
    const end = legacy.find(item => graph.nodes.find(node => node.id === item.source)?.data.role === 'end');
    if (start && ports.some(item => item.id === 'start_image') && !used.has('start_image')) { assign.set(start.id, 'start_image'); used.add('start_image'); }
    if (end && ports.some(item => item.id === 'end_image') && !used.has('end_image')) { assign.set(end.id, 'end_image'); used.add('end_image'); }
  }
  for (const item of legacy) {
    if (assign.has(item.id)) continue;
    const port = ports.find(candidate => !used.has(candidate.id));
    if (!port) break;
    assign.set(item.id, port.id); used.add(port.id);
  }
  return assign.get(edge.id);
}

function edgeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('连接参数必须为对象');
  const result = {};
  if (Object.hasOwn(options, 'sourceOccurrence')) result.sourceOccurrence = textSourceOccurrence(options);
  if (Object.hasOwn(options, 'targetField')) {
    if (!fieldId(options.targetField)) throw new Error('连接的目标参数 ID 无效');
    result.targetField = options.targetField;
  }
  if (Object.hasOwn(options, 'sourceField')) {
    if (!['text', 'negative', ...MEDIA_TYPES].includes(options.sourceField)) throw new Error('连接的来源字段无效');
    result.sourceField = options.sourceField;
  }
  if (Object.hasOwn(options, 'outputIndex')) {
    if (!Number.isInteger(options.outputIndex) || options.outputIndex < 0 || options.outputIndex > 31) throw new Error('输出图片序号必须是 0 到 31 之间的整数');
    result.outputIndex = options.outputIndex;
  }
  if (Object.hasOwn(options, 'sourceOutput')) {
    if (typeof options.sourceOutput !== 'string' || !options.sourceOutput || options.sourceOutput.length > 120) throw new Error('工作流输出节点标识无效');
    result.sourceOutput = options.sourceOutput;
  }
  return result;
}

function uploadedImageName(value) {
  return uploadedMediaName(value, '参考图');
}

function uploadedMediaName(value, label = '媒体输入') {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error(`${label}必须使用后端上传返回的相对名称`);
  const name = value.replaceAll('\\', '/');
  if (name.startsWith('/') || name.includes(':') || name.split('/').some(part => ['.', '..'].includes(part)) || name.includes('\0')) throw new Error(`${label}必须使用后端上传返回的相对名称`);
  return value;
}

/** Keep this optional: an explicit empty stack disables the legacy LoRA role. */
function loraStack(value, kind) {
  if (!Array.isArray(value) || value.length > 4) throw new Error('LoRA 必须是最多 4 项的列表');
  return value.map((entry, index) => {
    const label = `LoRA ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} 参数无效`);
    if (Object.keys(entry).some(key => !['name', 'strength_model', 'strength_clip'].includes(key))) throw new Error(`${label} 含有不支持的参数`);
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 1024) throw new Error(`${label} 模型名称必须是 1–1024 字符的文本`);
    const result = { name: entry.name };
    for (const key of ['strength_model', 'strength_clip']) {
      if (!Object.hasOwn(entry, key)) continue;
      const number = entry[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < -10 || number > 10) throw new Error(`${label} ${key} 必须是 -10 到 10 之间的数字`);
      if (key === 'strength_clip' && !['sdxl', 'sdxl_i2i'].includes(kind) && number !== 0) throw new Error('H3 / Krea / Qwen 2.1 LoRA 仅支持模型强度，CLIP 强度应省略或设为 0');
      result[key] = number;
    }
    return result;
  });
}

export function makeId(prefix = 'node') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function createNode(type, x, y, overrides = {}) {
  if (!NODE_TYPES.includes(type)) throw new Error('不支持的节点类型');
  const defaults = {
    prompt: { title: '提示词', text: '', negative: '' },
    reference: { title: '参考素材', name: '', url: '', mediaType: 'image', role: 'reference' },
    generation: { title: 'H3 视频生成', kind: 'h3_t2v', positive: '', negative: '', seed: 42, width: 768, height: 448, steps: 20, cfg: 1, seconds: 5, fps: 24, sampler: 'euler', scheduler: 'simple', denoise: 1, models: {}, lora_strength: 1, apiPrompt: null, package_id: '', packageValues: {} },
    result: { title: '生成结果', outputs: [], jobId: '' },
  };
  return { id: makeId(), type, x: finite(x), y: finite(y), data: { ...defaults[type], ...copy(overrides) } };
}

export function canConnect(graph, source, target, options = {}) {
  const validation = validateConnection(graph, source, target, options);
  if (!validation.ok) return validation;
  // A default drag must not create another contribution after occurrence zero
  // was disconnected. Import/execution validate exact stored identities instead.
  const to = graph.nodes.find(node => node.id === target), from = graph.nodes.find(node => node.id === source);
  if (from.type === 'prompt' && to.type === 'generation' && to.data.kind === 'package'
    && textSourceOccurrence(options) === 0 && normalizeTextCompositions(to.data.packageTextCompositions, to.data.packageFields)[options.targetField]
    && graph.edges.some(edge => edge.target === target && edge.targetField === options.targetField && edge.source === source
      && (edge.sourceField || 'text') === (options.sourceField || 'text'))) {
    return { ok: false, reason: '相同文本来源已连接，不能重复拼接' };
  }
  return validation;
}

// Importing a legacy edge preserves its meaning; it does not prove its media type.
function validateConnection(graph, source, target, options = {}, resolvedType = null, allowUnknown = false) {
  if (source === target) return { ok: false, reason: '节点不能连接自身' };
  const from = graph.nodes.find(node => node.id === source);
  const to = graph.nodes.find(node => node.id === target);
  if (!from || !to) return { ok: false, reason: '连接节点不存在' };
  let binding;
  try { binding = edgeOptions(options); } catch (error) { return { ok: false, reason: error.message }; }
  if (binding.sourceField && !(from.type === 'prompt' ? ['text', 'negative'] : ['reference', 'generation', 'result'].includes(from.type) ? MEDIA_TYPES : []).includes(binding.sourceField)) return { ok: false, reason: '来源节点与连接字段类型不匹配' };
  if (binding.outputIndex && !['generation', 'result'].includes(from.type)) return { ok: false, reason: '只有生成或结果节点可选择输出图片序号' };
  const packaged = to.type === 'generation' && to.data.kind === 'package';
  const input = binding.targetField ? generationInputPorts(to).find(item => item.id === binding.targetField) : null;
  if (binding.targetField && !input) return { ok: false, reason: packaged ? '工作流包目标参数不存在，请刷新工作流包定义' : '生成节点目标输入端口不存在' };
  if (Object.hasOwn(binding, 'sourceOccurrence')) {
    try { textContributionIdentity({ source, ...binding }, { sourceType: from.type, fieldType: input?.type,
      composition: packaged && normalizeTextCompositions(to.data.packageTextCompositions, to.data.packageFields)[input?.id] }); }
    catch (error) { return { ok: false, reason: error.message }; }
  }
  if (to.type === 'generation') {
    if (!packaged && !['prompt', 'reference', 'generation', 'result'].includes(from.type)) return { ok: false, reason: '生成节点只接收提示词、参考素材或上游生成结果' };
    if (packaged && !binding.targetField) return { ok: false, reason: '请选择工作流包的目标输入参数；未连接字段仍可通过表单填写' };
    const knownOutputType = MEDIA_TYPES.includes(resolvedType) ? resolvedType : sourceOutputType(from, options, input?.type || binding.sourceField || 'image', graph);
    const sourceType = from.type === 'prompt' ? 'text' : from.type === 'reference' ? from.data.mediaType : knownOutputType;
    if (!sourceType && ['generation', 'result'].includes(from.type) && !allowUnknown) return { ok: false, reason: '上游输出媒体类型未知，请先确认输出接口或完成生成，不能根据目标参数推定类型' };
    if (binding.sourceField && MEDIA_TYPES.includes(binding.sourceField) && knownOutputType && binding.sourceField !== knownOutputType) return { ok: false, reason: '所选输出媒体类型与来源节点的输出不匹配' };
    if (binding.sourceField === 'text' || binding.sourceField === 'negative') {
      if (from.type !== 'prompt') return { ok: false, reason: '来源节点与连接字段类型不匹配' };
    }
    if (binding.sourceField === 'video' && from.type === 'reference' && from.data.mediaType !== 'video') return { ok: false, reason: '来源素材不是视频' };
    if (binding.sourceField === 'image' && from.type === 'reference' && from.data.mediaType !== 'image') return { ok: false, reason: '来源素材不是图片' };
    if (binding.sourceField === 'audio' && from.type === 'reference' && from.data.mediaType !== 'audio') return { ok: false, reason: '来源素材不是音频' };
    if (input) {
      if (!['text', ...MEDIA_TYPES].includes(input.type)) return { ok: false, reason: '此参数通过表单填写；只有文本、图片、视频与音频参数支持连线' };
      let composition;
      try { composition = packaged && normalizeTextCompositions(to.data.packageTextCompositions, to.data.packageFields)[input.id]; }
      catch (error) { return { ok: false, reason: error.message }; }
      const existing = graph.edges.filter(edge => edge.target === target && edgeInputField(graph, edge) === input.id);
      if (existing.length && !composition) return { ok: false, reason: '此输入端口已有连接，请先断开原连接' };
      if (composition) {
        const context = { sourceType: from.type, fieldType: input.type, composition };
        try {
          const identity = textContributionIdentity({ source, ...binding }, context);
          if (existing.some(edge => textContributionIdentity(edge, context) === identity)) return { ok: false, reason: '相同文本来源已连接，不能重复拼接' };
        } catch (error) { return { ok: false, reason: error.message }; }
      }
      if (sourceType && sourceType !== input.type) return { ok: false, reason: '连接类型不匹配：文本接文本，图片接图片，视频接视频，音频接音频' };
      if (!sourceType && MEDIA_TYPES.includes(binding.sourceField) && binding.sourceField !== input.type) return { ok: false, reason: '连接类型不匹配：所存来源字段与目标参数不同' };
      if (!sourceType && !['generation', 'result'].includes(from.type)) return { ok: false, reason: '连接类型不匹配：文本接文本，图片接图片，视频接视频' };
    } else {
      if (binding.targetField) return { ok: false, reason: '生成节点目标输入端口不存在' };
      const compatible = from.type === 'prompt' || from.type === 'reference' && from.data.mediaType === 'image'
        || ['generation', 'result'].includes(from.type) && (sourceType === 'image' || !sourceType && (!binding.sourceField || binding.sourceField === 'image'));
      if (!compatible) return { ok: false, reason: '连接顺序：提示词 / 图片参考 → 生成 → 结果；请为生成输入选择明确端口' };
    }
    if (!binding.targetField && graph.edges.some(edge => edge.source === source && edge.target === target && !edge.targetField)) return { ok: false, reason: '连接已存在' };
  } else if (packaged) {
    return { ok: false, reason: '工作流包输入节点无效' };
  } else {
    if (binding.targetField) return { ok: false, reason: '只有生成节点支持目标输入端口' };
    const valid = from.type === 'generation' && to.type === 'result';
    if (!valid) return { ok: false, reason: '连接顺序：提示词 / 参考素材 → 生成 → 结果；工作流包可接文本、图片或视频输入' };
    if (graph.edges.some(edge => edge.source === source && edge.target === target)) return { ok: false, reason: '连接已存在' };
  }
  if (to.type === 'result' && graph.edges.some(edge => edge.target === target)) return { ok: false, reason: '一个结果节点只能接收一个生成节点' };
  const pending = [target];
  const visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === source) return { ok: false, reason: '连接不能形成循环' };
    if (visited.has(id)) continue;
    visited.add(id);
    graph.edges.filter(edge => edge.source === id).forEach(edge => pending.push(edge.target));
  }
  return { ok: true };
}

export function connect(graph, source, target, options = {}) {
  const validation = canConnect(graph, source, target, options);
  if (!validation.ok) throw new Error(validation.reason);
  graph.edges.push({ id: makeId('edge'), source, target, ...edgeOptions(options) });
  return graph;
}

function freezeImageInputSlots(graph, affectedTargets) {
  // Freeze inferred slots before removing their predecessors from a legacy canvas.
  const bindings = graph.edges.filter(edge => affectedTargets.has(edge.target) && !edge.targetField
    && ['reference', 'generation', 'result'].includes(graph.nodes.find(node => node.id === edge.source)?.type))
    .map(edge => [edge, edgeInputField(graph, edge)]);
  for (const [edge, field] of bindings) if (field) edge.targetField = field;
}

export function removeEdges(graph, ids) {
  const removed = new Set(ids);
  freezeImageInputSlots(graph, new Set(graph.edges.filter(edge => removed.has(edge.id)).map(edge => edge.target)));
  graph.edges = graph.edges.filter(edge => !removed.has(edge.id));
  return graph;
}

export function removeNodes(graph, ids) {
  const removed = new Set(ids);
  const affectedTargets = new Set(graph.edges.filter(edge => removed.has(edge.source) && !removed.has(edge.target)).map(edge => edge.target));
  freezeImageInputSlots(graph, affectedTargets);
  graph.nodes = graph.nodes.filter(node => !removed.has(node.id));
  graph.edges = graph.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
  return graph;
}

export function duplicateNodes(graph, ids) {
  const selected = new Set(ids);
  const map = new Map();
  const clones = graph.nodes.filter(node => selected.has(node.id)).map(node => {
    const clone = copy(node);
    clone.id = makeId();
    clone.x += 44;
    clone.y += 44;
    if (clone.type === 'result') { clone.data.outputs = []; clone.data.jobId = ''; }
    map.set(node.id, clone.id);
    return clone;
  });
  const edges = graph.edges.filter(edge => map.has(edge.source) && map.has(edge.target)).map(edge => {
    const options = edgeOptions(edge);
    if (!options.targetField && ['reference', 'generation', 'result'].includes(graph.nodes.find(node => node.id === edge.source)?.type)) {
      const field = edgeInputField(graph, edge);
      if (field) options.targetField = field;
    }
    return { id: makeId('edge'), source: map.get(edge.source), target: map.get(edge.target), ...options };
  });
  const validated = parseGraph(serializeGraph({ nodes: clones, edges }));
  graph.nodes.push(...validated.nodes);
  graph.edges.push(...validated.edges);
  return validated.nodes.map(node => node.id);
}

export function generationPayload(graph, id, context = {}) {
  const node = graph.nodes.find(item => item.id === id && item.type === 'generation');
  if (!node) throw new Error('请选择生成节点');
  if (!KINDS.includes(node.data.kind)) throw new Error('生成模式不受支持');
  for (const edge of graph.edges.filter(item => item.target === id && Object.hasOwn(item, 'sourceOccurrence'))) {
    const source = graph.nodes.find(item => item.id === edge.source);
    const field = (node.data.packageFields || []).find(item => item.id === edge.targetField);
    const composition = node.data.kind === 'package' && normalizeTextCompositions(node.data.packageTextCompositions, node.data.packageFields)[edge.targetField];
    textContributionIdentity(edge, { sourceType: source?.type, fieldType: field?.type, composition });
  }
  if (graph.edges.some(edge => edge.target === id && graph.nodes.some(ref => ref.id === edge.source && ref.type === 'reference' && ref.data.localAssetId && !ref.data.name))) throw new Error('参考图片已保存在本机，点击“开始生成”时会自动传入当前推理引擎');
  if (node.data.kind === 'package') {
    if (typeof node.data.package_id !== 'string' || !node.data.package_id) throw new Error('请先选择或导入对应工作流包');
    const values = packageValues(node.data.packageValues || {});
    const compositions = normalizeTextCompositions(node.data.packageTextCompositions, node.data.packageFields);
    for (const field of Object.keys(compositions)) textCompositionOwn(values, field);
    const textInputs = new Map();
    const checked = { nodes: graph.nodes, edges: graph.edges.filter(edge => edge.target !== id) };
    for (const edge of graph.edges.filter(edge => edge.target === id)) {
      const validation = validateConnection(checked, edge.source, edge.target, edge, context.edgeMediaTypes?.[edge.id]);
      if (!validation.ok) throw new Error(`工作流包输入连接无效：${validation.reason}`);
      checked.edges.push(edge);
      const source = graph.nodes.find(item => item.id === edge.source);
      if (source.type === 'prompt') {
        const text = source.data[edge.sourceField || 'text'];
        if (typeof text !== 'string' || text.length > 100000) throw new Error('连接的提示词必须是不超过 100000 字符的文本');
        if (compositions[edge.targetField]) {
          if (!textInputs.has(edge.targetField)) textInputs.set(edge.targetField, []);
          textInputs.get(edge.targetField).push(text);
        } else values[edge.targetField] = text;
      } else if (source.type === 'reference') {
        if (!source.data.name) throw new Error('工作流包参考图片待准备，请先上传已连接的图片');
        const field = (node.data.packageFields || []).find(item => item.id === edge.targetField);
        if (!field || !MEDIA_TYPES.includes(field.type) || source.data.mediaType !== field.type) throw new Error('工作流包输入与连接素材类型不匹配');
        values[edge.targetField] = uploadedMediaName(source.data.name, `工作流${mediaLabel(field.type)}`);
      } else {
        const images = context?.edgeImages;
        if (!images || typeof images !== 'object' || Array.isArray(images) || !Object.hasOwn(images, edge.id) || !images[edge.id]) throw new Error('等待上游生成完成，输出图片待准备；请先运行上游并将图片上传到当前后端');
        const field = (node.data.packageFields || []).find(item => item.id === edge.targetField);
        if (!field || !MEDIA_TYPES.includes(field.type)) throw new Error('工作流包连接目标不是图片、视频或音频输入');
        const outputType = context.edgeMediaTypes?.[edge.id] || sourceOutputType(source, edge, field.type, graph);
        if (outputType && outputType !== field.type) throw new Error('上游生成结果与工作流包输入媒体类型不匹配');
        values[edge.targetField] = uploadedMediaName(images[edge.id], `工作流${mediaLabel(field.type)}`);
      }
    }
    for (const [field, incoming] of textInputs) values[field] = composeTextInput(compositions[field], incoming, values[field] ?? '');
    return { kind: 'package', package_id: node.data.package_id, values: packageValues(values), ...(node.data.editor_backend ? { editor_backend: node.data.editor_backend } : {}), ...(node.data.editor_outputs?.length ? { output_nodes: [...node.data.editor_outputs] } : {}) };
  }
  if (node.data.kind === 'api') {
    if (!node.data.apiPrompt || typeof node.data.apiPrompt !== 'object' || Array.isArray(node.data.apiPrompt)) throw new Error('请先导入 ComfyUI API 格式工作流');
    return { kind: 'api', prompt: copy(node.data.apiPrompt) };
  }
  const incomingEdges = graph.edges.filter(edge => edge.target === id);
  if (node.data.kind === 'qwen21_t2i' && incomingEdges.some(edge => graph.nodes.some(item => item.id === edge.source && item.type === 'reference'))) throw new Error('Qwen 2.1 文生图不接收参考图，请选择图像编辑模式');
  const imageSourceCount = incomingEdges.filter(edge => graph.nodes.some(item => item.id === edge.source && ['reference', 'generation', 'result'].includes(item.type))).length;
  if (node.data.kind === 'sdxl_i2i' && imageSourceCount !== 1) throw new Error('SDXL 图生图需要连接 1 张已上传的参考图片');
  if (node.data.kind === 'sdxl' && imageSourceCount > 1) throw new Error('SDXL 图生图只使用一张输入图');
  const prompts = [], positive = [], negative = [], imageInputs = [];
  for (const edge of incomingEdges) {
    const source = graph.nodes.find(item => item.id === edge.source);
    if (!source) continue;
    if (source.type === 'prompt') {
      const field = edge.sourceField || (edge.targetField === 'negative' ? 'negative' : 'text');
      const value = source.data[field];
      if (typeof value !== 'string' || value.length > 100000) throw new Error('连接的提示词必须是不超过 100000 字符的文本');
      if (!edge.targetField) prompts.push(source);
      else if (edge.targetField === 'positive') positive.push(value);
      else if (edge.targetField === 'negative') negative.push(value);
      continue;
    }
    if (!['reference', 'generation', 'result'].includes(source.type)) continue;
    const portId = edgeInputField(graph, edge);
    const portInfo = generationInputPorts(node).find(item => item.id === portId);
    if (!portInfo || portInfo.type !== 'image') {
      if (node.data.kind.startsWith('sdxl')) continue;
      throw new Error('生成节点连接没有匹配的图片输入端口');
    }
    let name;
    if (source.type === 'reference') {
      if (!source.data.name) {
        if (node.data.kind === 'sdxl_i2i' || node.data.kind.startsWith('qwen21_')) continue;
        throw new Error('连接的参考素材尚未上传完成');
      }
      if (source.data.mediaType !== 'image') throw new Error('普通生成节点需要图片参考素材');
      name = uploadedImageName(source.data.name);
    } else {
      const images = context?.edgeImages;
      if (!images || typeof images !== 'object' || Array.isArray(images) || !Object.hasOwn(images, edge.id) || !images[edge.id]) throw new Error('等待上游生成完成，输出图片待准备；请先运行上游并将图片上传到当前后端');
      const outputType = context.edgeMediaTypes?.[edge.id] || sourceOutputType(source, edge, 'image', graph);
      if (!outputType) throw new Error('上游输出媒体类型未知，不能作为图片输入');
      if (outputType && outputType !== 'image') throw new Error('上游输出不是图片，不能连接到此图片输入端口');
      name = uploadedImageName(images[edge.id]);
    }
    imageInputs.push({ edge, source, port: portInfo, name });
  }
  const imagePorts = generationInputPorts(node).filter(port => port.type === 'image');
  const orderedImages = [...imageInputs].sort((a, b) => imagePorts.findIndex(item => item.id === a.port.id) - imagePorts.findIndex(item => item.id === b.port.id));
  // These backends bind a compact list by position: holes must never promote a
  // later reference into the edit target or another numbered conditioning slot.
  if (node.data.kind === 'qwen21_edit' || ['krea', 'h3_ref'].includes(node.data.kind) && orderedImages.length) {
    const used = new Set(orderedImages.map(item => item.port.id));
    const lastIndex = imagePorts.findIndex(port => port.id === orderedImages.at(-1)?.port.id);
    const requiredCount = Math.max(node.data.kind === 'qwen21_edit' ? 1 : 0, lastIndex + 1);
    const missing = imagePorts.slice(0, requiredCount).filter(port => !used.has(port.id));
    if (missing.length) throw new Error(`缺少图片输入端口：${missing.map(port => `${port.label}（${port.id}）`).join('、')}；请补齐前面的图片槽位，后续参考图不会自动前移`);
  }
  const refs = orderedImages.map(item => item.name);
  if (node.data.kind === 'sdxl_i2i' && refs.length !== 1) throw new Error('SDXL 图生图需要连接 1 张已上传的参考图片');
  if (node.data.kind.startsWith('qwen21_')) {
    if (incomingEdges.some(edge => graph.nodes.some(item => item.id === edge.source && item.type === 'reference' && !item.data.name))) throw new Error('Qwen 2.1 参考图片尚未上传完成');
    if (node.data.kind === 'qwen21_t2i' && refs.length) throw new Error('Qwen 2.1 文生图不接收参考图，请选择图像编辑模式');
    if (node.data.kind === 'qwen21_edit' && (refs.length < 1 || refs.length > 10)) throw new Error('Qwen 2.1 编辑需要连接 1–10 张参考图片');
    if (node.data.denoise !== 1) throw new Error('Qwen 2.1 条件编辑使用 denoise=1');
    if ((node.data.kind !== 'qwen21_edit' || node.data.custom_size) && (node.data.width % 32 || node.data.height % 32)) throw new Error('Qwen 2.1 宽高须为 32 的倍数');
  }
  const legacyPositive = prompts.map(item => item.data.text);
  const legacyNegative = prompts.map(item => item.data.negative);
  const stack = Object.hasOwn(node.data, 'loras') ? loraStack(node.data.loras, node.data.kind) : undefined;
  if (!Number.isSafeInteger(node.data.seed) || node.data.seed < 0) throw new Error('随机种子必须是 0 到 9007199254740991 之间的整数');
  const data = copy(node.data);
  if (stack !== undefined) data.loras = stack;
  delete data.title;
  delete data.apiPrompt;
  delete data.package_id;
  delete data.packageValues;
  delete data.packageFields;
  return {
    ...data,
    positive: [...legacyPositive, ...positive, data.positive].filter(Boolean).join('\n\n'),
    negative: [...legacyNegative, ...negative, data.negative].filter(Boolean).join(', '),
    references: refs,
    ...(!data.kind.startsWith('qwen21_') ? { reference_roles: orderedImages.map(item => item.port.id === 'start_image' ? 'start' : item.port.id === 'end_image' ? 'end' : 'reference') } : {}),
  };
}

/** Upstream generations execute once, including dependencies reached through result nodes. */
export function executionOrder(graph, ids = graph.nodes.filter(node => node.type === 'generation').map(node => node.id)) {
  if (!Array.isArray(ids) && !(ids instanceof Set)) throw new Error('执行节点须为节点 ID 列表');
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) throw new Error('节点 ID 无效或重复');
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error('执行链中存在缺失节点');
    incoming.get(edge.target).push(edge.source);
  }
  const states = new Map(), order = [];
  const visit = id => {
    if (states.get(id) === 1) throw new Error('执行链不能形成循环');
    if (states.get(id) === 2) return;
    states.set(id, 1);
    incoming.get(id).forEach(visit);
    states.set(id, 2); order.push(id);
  };
  nodes.forEach((_node, id) => visit(id));
  const needed = new Set();
  const include = id => {
    if (!nodes.has(id)) throw new Error('选择的执行节点不存在');
    if (needed.has(id)) return;
    needed.add(id); incoming.get(id).forEach(include);
  };
  [...ids].forEach(include);
  return order.filter(id => needed.has(id) && nodes.get(id).type === 'generation');
}

/** Fail closed when file names would cross the local engine boundary. */
export function validateExecutionMediaBackends(graph, targets, currentBackend, targetBackend) {
  const order = executionOrder(graph, targets);
  if (!order.length) return true;
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) incoming.get(edge.target)?.push(edge);
  const needed = new Set();
  const include = id => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const edge of incoming.get(id) || []) include(edge.source);
  };
  for (const id of targets) include(id);

  const switching = currentBackend !== targetBackend;
  const issues = [];
  const check = (label, filename, owner) => {
    if (owner && owner !== targetBackend) {
      issues.push(`${label}（${filename}）上传自 ${owner}，目标引擎为 ${targetBackend}`);
    } else if (!owner && switching) {
      issues.push(`${label}（${filename}）没有上传引擎记录，切换到 ${targetBackend} 后无法确认素材是否存在`);
    }
  };

  for (const id of needed) {
    const node = nodes.get(id);
    if (node?.type === 'reference' && node.data.name) {
      if (node.data.localAssetId) continue; // A client-owned source can be copied to the target engine before submission.
      check(node.data.title || '参考图片', node.data.name, node.data.uploadBackend || '');
      continue;
    }
    if (node?.type !== 'generation' || node.data.kind !== 'package') continue;
    const connectedFields = new Set(graph.edges.filter(edge => edge.target === id && edge.targetField).map(edge => edge.targetField));
    for (const field of node.data.packageFields || []) {
      if (!['image', 'audio', 'video'].includes(field.type) || connectedFields.has(field.id)) continue;
      const filename = node.data.packageValues?.[field.id];
      if (filename === undefined || filename === null || filename === '') continue;
      const owner = node.data.packageMediaBackends?.[field.id];
      check(field.label || '工作流包图片输入', filename,
        owner?.name === filename ? owner.backend : '');
    }
  }
  if (issues.length) throw new Error(`媒体输入不会在推理引擎之间自动转移。${issues.slice(0, 4).join('；')}。请在目标引擎中重新上传对应媒体，再运行工作流。`);
  return true;
}

/** Restore a recorded request as an independent, editable canvas fragment. */
export function recipeGraph(recipe, x = 80, y = 80) {
  const request = recipe?.request;
  if (!request || typeof request !== 'object' || Array.isArray(request) || !KINDS.includes(request.kind)) throw new Error('任务没有可复用的生成参数');
  const data = copy(request);
  delete data.references;
  delete data.reference_roles;
  delete data.values;
  delete data.prompt;
  if (request.kind === 'api') data.apiPrompt = copy(request.prompt);
  if (request.kind === 'package') data.packageValues = packageValues(request.values || {});
  data.title = typeof recipe.title === 'string' ? recipe.title : `复用 · ${request.kind === 'package' ? '工作流包' : request.kind === 'api' ? 'API 工作流' : request.kind.startsWith('h3') ? 'H3 视频生成' : '图片生成'}`;
  const node = createNode('generation', x, y, data);
  const fragment = { nodes: [node], edges: [] };
  if (!['api', 'package'].includes(request.kind)) {
    (request.references || []).forEach((name, index) => {
      const metadata = (recipe.references || []).find(item => item.name === name) || {};
      const reference = createNode('reference', x - 345, y + index * 340, { title: `复用素材 ${index + 1}`, name, url: metadata.url || '', uploadBackend: metadata.backend || recipe.backend || '', mediaType: 'image', role: request.reference_roles?.[index] || 'reference' });
      fragment.nodes.push(reference);
      const role = request.reference_roles?.[index] || 'reference';
      const targetField = request.kind === 'qwen21_edit' ? 'image_' + (index + 1)
        : ['sdxl', 'sdxl_i2i'].includes(request.kind) ? 'image_1'
          : request.kind === 'krea' ? 'image_' + (index + 1)
            : request.kind === 'h3_i2v' ? role === 'end' ? 'end_image' : role === 'start' || index === 0 ? 'start_image' : 'end_image'
              : request.kind === 'h3_ref' ? 'ref_image_' + index : '';
      if (targetField) connect(fragment, reference.id, node.id, { targetField });
      else connect(fragment, reference.id, node.id);
    });
  }
  // Use the same boundary validation as an imported canvas before adding anything.
  const validated = parseGraph(serializeGraph(fragment));
  generationPayload(validated, node.id);
  return { nodes: validated.nodes, edges: validated.edges, generationId: node.id };
}

export function stableStringify(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value), null, 2);
}

/** Unknown progress stays unknown; queued jobs are not fabricated percentages. */
export function progressPercent(progress) {
  if (progress === null || progress === undefined) return null;
  if (typeof progress === 'number') return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
  if (typeof progress === 'object' && Number.isFinite(progress.value) && Number.isFinite(progress.max) && progress.max > 0) return Math.max(0, Math.min(100, progress.value / progress.max * 100));
  return null;
}

export function serializeGraph(graph, viewport = { x: 60, y: 60, scale: 1 }) {
  for (const edge of graph.edges) if (Object.hasOwn(edge, 'sourceOccurrence')) textSourceOccurrence(edge);
  const composed = graph.nodes.some(node => node.data?.packageTextCompositions && Object.keys(node.data.packageTextCompositions).length)
    || graph.edges.some(edge => Object.hasOwn(edge, 'sourceOccurrence'));
  return stableStringify({ schema: composed ? COMPOSED_SCHEMA : SCHEMA, nodes: graph.nodes, edges: graph.edges, viewport });
}

export function parseGraph(text) {
  if (typeof text !== 'string' && Array.isArray(text?.edges)) {
    for (const edge of text.edges) if (edge && Object.hasOwn(edge, 'sourceOccurrence')) textSourceOccurrence(edge);
  }
  const input = parseJSONWithSafeNumbers(typeof text === 'string' ? text : JSON.stringify(text));
  if (!input || typeof input !== 'object' || ![SCHEMA, COMPOSED_SCHEMA].includes(input.schema) || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) throw new Error('不是有效或受支持的 FrameWeave 画布文件；新版格式请更新客户端后打开');
  if (input.schema === SCHEMA && (input.nodes.some(node => node?.data?.packageTextCompositions && Object.keys(node.data.packageTextCompositions).length)
    || input.edges.some(edge => edge && Object.hasOwn(edge, 'sourceOccurrence')))) throw new Error('带文本拼接规则或贡献身份的画布需要 v2 格式，请用支持此规则的客户端重新导出');
  if (input.nodes.length > 500 || input.edges.length > 2000) throw new Error('画布超过限制：最多 500 个节点 / 2000 条连接');
  const seen = new Set();
  const nodes = input.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 120 || seen.has(node.id)) throw new Error('节点 ID 无效或重复');
    if (!NODE_TYPES.includes(node.type)) throw new Error('画布含有不支持的节点');
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || Math.abs(node.x) > 1e7 || Math.abs(node.y) > 1e7) throw new Error('节点坐标无效');
    if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw new Error('节点内容无效');
    seen.add(node.id);
    const data = createNode(node.type, 0, 0).data;
    for (const key of Object.keys(data)) {
      if (!(key in node.data)) continue;
      if (key === 'packageValues') data[key] = packageValues(node.data[key]);
      else if (['models', 'apiPrompt', 'outputs'].includes(key)) data[key] = copy(node.data[key]);
      else if (typeof data[key] === 'number') data[key] = finite(node.data[key], data[key]);
      else data[key] = String(node.data[key] ?? '').slice(0, 100000);
    }
    if (node.type === 'reference' && node.data.uploadBackend !== undefined) {
      data.uploadBackend = node.data.uploadBackend === '' ? '' : localBackendIdentity(node.data.uploadBackend);
    }
    if (node.type === 'reference' && node.data.localMedia !== undefined) {
      if (typeof node.data.localMedia !== 'boolean') throw new Error('本地媒体标识无效');
      data.localMedia = node.data.localMedia;
    }
    if (node.type === 'reference' && node.data.localAssetId) {
      if (typeof node.data.localAssetId !== 'string' || !/^[a-f0-9]{64}$/.test(node.data.localAssetId)) throw new Error('本地图片标识无效');
      data.localAssetId = node.data.localAssetId;
      data.localFilename = String(node.data.localFilename || '本地图片').slice(0, 260);
      data.url = (data.localMedia ? '/api/assets/media/' : '/api/assets/images/') + data.localAssetId;
    }
    if (node.type === 'generation' && !KINDS.includes(data.kind)) throw new Error('生成模式不受支持');
    if (node.type === 'generation' && (!data.models || typeof data.models !== 'object' || Array.isArray(data.models))) data.models = {};
    if (node.type === 'generation') {
      if (Object.hasOwn(node.data, 'outputs')) {
        if (!Array.isArray(node.data.outputs)) throw new Error('工作流输出文件记录无效');
        data.outputs = copy(node.data.outputs).filter(item => item && MEDIA_TYPES.includes(item.type)
          && (typeof item.url === 'string' || typeof item.filename === 'string')).slice(0, 32);
      }
      if (node.data.packageMediaBackends !== undefined) data.packageMediaBackends = packageMediaOwners(node.data.packageMediaBackends);
      if (node.data.editor_id !== undefined) {
        if (typeof node.data.editor_id !== 'string' || !/^e-[a-f0-9]{24}$/.test(node.data.editor_id)) throw new Error('原生工作流 ID 无效');
        data.editor_id = node.data.editor_id;
      }
      if (node.data.editor_backend !== undefined) {
        if (typeof node.data.editor_backend !== 'string' || node.data.editor_backend.length > 200) throw new Error('原生工作流后端地址无效');
        data.editor_backend = node.data.editor_backend ? localBackendIdentity(node.data.editor_backend, '原生工作流后端地址') : '';
      }
      for (const key of ['editor_baseline', 'editor_outputs', 'editor_output_fields']) {
        if (node.data[key] !== undefined) data[key] = packageValues({ value: node.data[key] }).value;
      }
      if (data.editor_outputs !== undefined && (!Array.isArray(data.editor_outputs) || data.editor_outputs.length > 64 || data.editor_outputs.some(id => typeof id !== 'string' || !id || id.length > 120))) throw new Error('工作流输出定义无效');
      if (node.data.editor_controls !== undefined) {
        if (!Array.isArray(node.data.editor_controls) || node.data.editor_controls.length > MAX_INTERFACE_FIELDS) throw new Error('工作流控件映射无效');
        data.editor_controls = node.data.editor_controls.map(control => {
          const keys = ['node_id', 'input', 'widget_node_id', 'widget_name'];
          if (!control || keys.some(key => typeof control[key] !== 'string' || !control[key] || control[key].length > 200)) throw new Error('工作流控件映射无效');
          return Object.fromEntries(keys.map(key => [key, control[key]]));
        });
      }
      if (node.data.editor_hidden_updates !== undefined) data.editor_hidden_updates = normalizeHiddenUpdates(node.data.editor_hidden_updates);
      if (Object.hasOwn(node.data, 'refine')) {
        const value = node.data.refine;
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') throw new Error('二次重绘参数无效');
        data.refine = packageValues(value);
      }
      if (Object.hasOwn(node.data, 'packageFields')) data.packageFields = packageFields(node.data.packageFields);
      if (Object.hasOwn(node.data, 'packageTextCompositions')) {
        if (data.kind !== 'package') throw new Error('文本拼接规则仅适用于工作流包');
        data.packageTextCompositions = normalizeTextCompositions(node.data.packageTextCompositions, data.packageFields);
        for (const id of Object.keys(data.packageTextCompositions)) textCompositionOwn(data.packageValues, id);
      }
      if (Object.hasOwn(node.data, 'inputLabels')) data.inputLabels = normalizedInputLabels(node.data.inputLabels);
      if (!Number.isSafeInteger(data.seed) || data.seed < 0) throw new Error('随机种子必须是 0 到 9007199254740991 之间的整数');
      if (Object.hasOwn(node.data, 'loras')) data.loras = loraStack(node.data.loras, data.kind);
      // Optional native controls survive recipes and old canvases without adding defaults.
      for (const key of ['shift_video', 'shift_audio']) {
        if (!Object.hasOwn(node.data, key)) continue;
        const value = node.data[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < .01 || value > 100) throw new Error(`${key} 必须是 0.01 到 100 之间的数字`);
        data[key] = value;
      }
      if (Object.hasOwn(node.data, 'ref_image_size')) data.ref_image_size = String(node.data.ref_image_size ?? '').slice(0, 100000);
      if (Object.hasOwn(node.data, 'custom_size')) {
        if (typeof node.data.custom_size !== 'boolean') throw new Error('custom_size 必须是布尔值');
        data.custom_size = node.data.custom_size;
      }
      if (Object.hasOwn(node.data, 'ref_resolution')) {
        const value = node.data.ref_resolution;
        if (!Number.isInteger(value) || value < 0 || value > 4096 || value % 32) throw new Error('ref_resolution 必须是 0–4096 间 32 的倍数');
        data.ref_resolution = value;
      }
      // The backend gives a nonempty top-level LoRA precedence. Normalize it into
      // the existing editable model role so later UI changes remain effective.
      if (node.data.lora) {
        if (typeof node.data.lora !== 'string') throw new Error('LoRA 模型名称必须是文本');
        data.models = { ...data.models, lora: node.data.lora.slice(0, 100000) };
      }
    }
    if (node.type === 'result') {
      if (!Array.isArray(data.outputs)) data.outputs = [];
      data.outputs = data.outputs.filter(item => item && ['image', 'video', 'audio'].includes(item.type) && typeof item.url === 'string').slice(0, 32);
    }
    return { id: node.id, type: node.type, x: node.x, y: node.y, data };
  });
  const graph = { nodes, edges: [] };
  const edgeIds = new Set();
  for (const edge of input.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edge.id.length > 120 || edgeIds.has(edge.id)) throw new Error('连接 ID 无效或重复');
    const validation = validateConnection(graph, edge.source, edge.target, edge, null, true);
    if (!validation.ok) throw new Error(`无效连接：${validation.reason}`);
    edgeIds.add(edge.id);
    graph.edges.push({ id: edge.id, source: edge.source, target: edge.target, ...edgeOptions(edge) });
  }
  return { ...graph, viewport: { x: finite(input.viewport?.x, 60), y: finite(input.viewport?.y, 60), scale: Math.min(3, Math.max(0.2, finite(input.viewport?.scale, 1))) } };
}

export function createDemo() {
  const prompt = createNode('prompt', 40, 80, { title: '镜头 01 · 晨光花园', text: '清晨的玻璃温室，阳光穿过沾着露水的叶片。摄影机缓慢向前推进，微风轻轻拂动植物，远处浮现柔和的金色光晕。电影摄影，细腻自然光，稳定运动，真实材质。', negative: '画面闪烁，变形，文字，水印，过度锐化' });
  const generation = createNode('generation', 420, 80);
  const result = createNode('result', 800, 80, { title: '镜头 01 · 预览' });
  const graph = { nodes: [prompt, generation, result], edges: [] };
  connect(graph, prompt.id, generation.id);
  connect(graph, generation.id, result.id);
  return graph;
}
