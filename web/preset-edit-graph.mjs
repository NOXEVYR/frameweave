/** Build an isolated package view of a preset; never mutate a live canvas. */
import { parseGraph, serializeGraph, stableStringify, generationInputPorts, edgeInputField, sourceOutputType } from './graph.mjs';
import { collectPresetEditRequest } from './preset-edit-request.mjs';
import { resolvePresetInterfaceReceipt } from './preset-interface-receipt.mjs';
import { cachedPackageField } from './canvas-port-layout.mjs';
import { editorOutputEdges, editorOutputKey } from './editor-canvas-interface.mjs';
import { isSafeSelectLiteral } from './packages.mjs';

const MEDIA = new Set(['image', 'video', 'audio']);
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function clone(value, limit = 32 * 1024 * 1024) {
  let count = 0;
  function visit(item, depth = 0) {
    if (++count > 500000 || depth > 80) throw new Error('预设影子图超过结构预算');
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return;
    if (!item || typeof item !== 'object' || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)) ||
      Object.getOwnPropertySymbols(item).length) throw new Error('预设影子图仅支持安全 JSON');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('预设影子图数组含空槽或额外属性');
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && key === 'length') continue;
      if (RESERVED.has(key) || !own(descriptor, 'value') || !descriptor.enumerable) throw new Error('预设影子图仅支持安全 JSON 字段');
      visit(descriptor.value, depth + 1);
    }
  }
  visit(value);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > limit) throw new Error('预设影子图超过完整数据预算');
  return JSON.parse(json);
}

function literal(field, prompt, isModel = false) {
  const node = prompt[field.node_id];
  if (!record(node) || typeof node.class_type !== 'string' || !node.class_type || !record(node.inputs) || !own(node.inputs, field.input)) {
    throw new Error(`字段 ${field.id} 缺少完整原始节点输入`);
  }
  if (field.class_type !== undefined && field.class_type !== node.class_type) throw new Error(`字段 ${field.id} 的节点类型已变化`);
  const value = node.inputs[field.input];
  const scalar = ['string', 'number', 'boolean'].includes(typeof value);
  if (!scalar || field.type === 'select' && !isSafeSelectLiteral(value) || field.type === 'text' && (typeof value !== 'string' || value.length > 64000) ||
    field.type === 'integer' && !Number.isSafeInteger(value) || field.type === 'number' && typeof value !== 'number' ||
    field.type === 'boolean' && typeof value !== 'boolean' || MEDIA.has(field.type) && typeof value !== 'string') {
    throw new Error(`字段 ${field.id} 的原始值类型无法证明；未使用默认值或连线值`);
  }
  const modelSelection = isModel || field.type === 'select' && ['model', 'encoder', 'lora'].includes(field.role);
  if ((MEDIA.has(field.type) || modelSelection) && typeof value === 'string' && value) {
    const path = value.replaceAll('\\', '/');
    if (value.length > 1024 || path.startsWith('/') || path.includes(':') || path.includes('\0') ||
      path.split('/').some(part => part === '.' || part === '..')) throw new Error(`字段 ${field.id} 的素材相对名称无效`);
  }
  return value;
}

function derivedEdgeId(parts, used) {
  const text = JSON.stringify(parts);
  let a = 2166136261, b = 5381;
  for (let index = 0; index < text.length; index++) { a = Math.imul(a ^ text.charCodeAt(index), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(index); }
  const base = `preset-edge-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  let id = base, suffix = 0;
  while (used.has(id)) id = `${base}-${++suffix}`;
  used.add(id); return id;
}

function outputMigration(graph, targetId, outputs) {
  const fields = new Map(), result = {};
  if (!Array.isArray(outputs) || outputs.length > 64) throw new Error('预设输出候选无效');
  for (const output of outputs) {
    if (!record(output) || typeof output.id !== 'string' || !output.id || output.id.length > 120 || fields.has(output.id)) throw new Error('预设输出候选身份无效或重复');
    fields.set(output.id, output);
  }
  for (const edge of editorOutputEdges(graph, targetId)) {
    const source = graph.nodes.find(node => node.id === edge.source), target = graph.nodes.find(node => node.id === edge.target);
    const expected = generationInputPorts(target).find(field => field.id === edgeInputField(graph, edge))?.type;
    const actual = sourceOutputType(source, edge, MEDIA.has(expected) ? expected : 'image', graph);
    if (!MEDIA.has(actual) || expected && expected !== actual) throw new Error(`输出连接 ${edge.id} 的媒体类型无法证明或不匹配`);
    let chosen;
    if (edge.sourceOutput) {
      chosen = fields.get(edge.sourceOutput);
      if (!chosen || chosen.mediaType !== actual) throw new Error(`输出连接 ${edge.id} 的原分支已不存在，需手动选择`);
    } else {
      const matches = outputs.filter(output => output.mediaType === actual);
      if (matches.length !== 1) throw new Error(`输出连接 ${edge.id} 有 ${matches.length} 个 ${actual} 分支，需手动选择`);
      [chosen] = matches;
    }
    result[editorOutputKey(edge)] = chosen.id;
  }
  return result;
}

/** A shadow is preparation data, not a submission or permission to replace the live graph. */
export function preparePresetEditGraph(graph, targetId, prepared, collected) {
  const original = clone(graph), response = clone(prepared), request = clone(collected);
  const document = clone(response.source_document, 2 * 1024 * 1024);
  if (response.status === 'blocked' || response.receipt_complete === false || !record(document?.prompt) ||
    !Object.keys(document.prompt).length || Object.keys(document.prompt).length > 1000) throw new Error('预设缺少完整且可证明的原始 API 图或接口映射');
  if (!Array.isArray(original.nodes) || !Array.isArray(original.edges) || original.nodes.length > 500 || original.edges.length > 2000) throw new Error('原画布结构或数量无效');
  parseGraph(serializeGraph(original));
  const matches = original.nodes.filter(node => node.id === targetId);
  if (matches.length !== 1 || matches[0].type !== 'generation') throw new Error('预设目标节点无效或重复');
  const initial = matches[0], fresh = collectPresetEditRequest(original, targetId, { backend: response.backend_url });
  for (const key of ['preset_request', 'logical_inputs', 'reference_slots', 'input_intents', 'model_intents']) {
    if (stableStringify(request[key]) !== stableStringify(fresh[key])) throw new Error(`预设采集来源 ${key} 已变化，请重新准备`);
  }
  if (stableStringify(response.source_request) !== stableStringify(request.preset_request)) throw new Error('预设原始请求与当前自身参数不一致，请重新准备');
  if (own(response, 'intents')) {
    for (const key of ['reference_slots', 'input_intents', 'model_intents']) {
      if (stableStringify(response.intents?.[key]) !== stableStringify(fresh[key])) throw new Error(`预设准备意图 ${key} 与当前画布不一致，请重新准备`);
    }
  }
  const resolution = resolvePresetInterfaceReceipt({ receipt: response.receipt, fields: response.fields });
  if (!resolution.ok) throw new Error(resolution.diagnostics.map(item => item.message).join('；'));
  const fields = clone(response.fields), byField = new Map(fields.map(field => [field.id, field]));
  const byLogical = new Map(resolution.mappings.map(item => [item.logical_id, item]));
  const modelFields = new Set(resolution.mappings.filter(item => item.logical_id.startsWith('models.')).flatMap(item => item.fields.map(field => field.id)));
  const values = Object.fromEntries(fields.map(field => [field.id, literal(field, document.prompt, modelFields.has(field.id))]));
  const output_rebindings = outputMigration(original, targetId, response.outputs || []);
  for (const output of response.outputs || []) if (!own(document.prompt, output.id)) throw new Error(`输出候选 ${output.id} 不属于完整原始图`);
  const target = initial, original_target_data = clone(initial.data);
  target.data = { ...target.data, kind: 'package', package_id: '', packageValues: values,
    packageFields: fields.map(cachedPackageField), packageTextCompositions: {}, inputLabels: {}, packageMediaBackends: {},
    editor_baseline: clone(values), editor_output_fields: clone(response.outputs || []), editor_outputs: (response.outputs || []).map(item => item.id) };
  // Their real nodes and values already belong to N. Legacy preset-only stacks
  // would be revalidated against the new package kind and can lose CLIP strength.
  delete target.data.loras; delete target.data.lora;
  delete target.data.outputs; delete target.data.jobId;
  const logical_rebindings = {}, edge_migrations = [], migrated = [];
  const incoming = original.edges.filter(edge => edge.target === targetId), incomingById = new Map(incoming.map(edge => [edge.id, edge]));
  const used = new Set(original.edges.map(edge => edge.id)), retainedIds = new Set();
  const consumed = new Set();
  for (const mapping of resolution.mappings) {
    logical_rebindings[mapping.logical_id] = mapping.fields.map(field => field.id);
    if (['positive', 'negative'].includes(mapping.logical_id)) {
      if (mapping.type !== 'text') throw new Error('提示词预设映射必须为文本');
      for (const field of mapping.fields) target.data.packageTextCompositions[field.id] = mapping.logical_id === 'negative' ? 'comma' : 'paragraphs';
    }
  }
  let edgeCount = original.edges.length - incoming.length;
  for (const input of fresh.logical_inputs) {
    const mapping = byLogical.get(input.logical_id), contributors = input.contributors || [];
    if (!mapping) {
      if (contributors.length || input.own_nonempty || MEDIA.has(input.type)) throw new Error(`逻辑输入 ${input.logical_id} 没有真实接口映射，未丢弃连线`);
      continue;
    }
    if (mapping.type !== input.type) throw new Error(`逻辑输入 ${input.logical_id} 类型已变化`);
    const ordered = [...contributors].sort((a, b) => (a.aggregation_order ?? a.order) - (b.aggregation_order ?? b.order));
    if ((edgeCount += ordered.length * mapping.fields.length) > 2000) throw new Error('预设接口展开后画布连线超过 2000 条');
    for (const contributor of ordered) {
      const edge = incomingById.get(contributor.edge_id);
      if (!edge || edge.source !== contributor.source_id) throw new Error('预设贡献没有匹配的原始连线');
      consumed.add(edge.id);
      for (let index = 0; index < mapping.fields.length; index++) {
        const field = mapping.fields[index];
        const preserve = !retainedIds.has(edge.id) && !(contributor.legacy && input.logical_id === 'negative') && index === 0;
        const id = preserve ? edge.id : derivedEdgeId([targetId, edge.id, input.logical_id, field.id, contributor.source_field], used);
        if (preserve) retainedIds.add(id);
        const next = { ...edge, id, targetField: field.id, sourceField: contributor.source_field };
        migrated.push(next); edge_migrations.push({ edge_id: edge.id, logical_id: input.logical_id, field_id: field.id, migrated_edge_id: id });
      }
    }
  }
  if (consumed.size !== incoming.length) throw new Error('有原始输入连线未被证明迁移，未修改画布');
  for (const [logical, label] of Object.entries(original_target_data.inputLabels || {})) {
    const mapping = byLogical.get(logical);
    if (!mapping) throw new Error(`输入用途 ${logical} 没有真实接口映射，未丢弃名称`);
    for (const field of mapping.fields) target.data.inputLabels[field.id] = label;
  }
  for (const [logical, owner] of Object.entries(original_target_data.packageMediaBackends || {})) {
    const mapping = byLogical.get(logical);
    if (!mapping || !MEDIA.has(mapping.type)) continue;
    for (const field of mapping.fields) if (owner?.name && owner.name === values[field.id] && owner.backend) target.data.packageMediaBackends[field.id] = clone(owner);
  }
  const pending = [], pendingKeys = new Set();
  for (const item of [...(response.pending || []), ...(request.pending || [])]) {
    const mapping = byLogical.get(item.logical_id || item.port_id);
    const existing = byField.get(item.field_id);
    const candidates = existing ? [existing] : mapping?.fields || [];
    const entries = candidates.length ? candidates.map(field => ({ ...item, field_id: field.id, node_id: field.node_id, input: field.input, type: field.type })) : [item];
    for (const entry of entries) {
      if (existing && (item.node_id !== undefined && item.node_id !== existing.node_id || item.input !== undefined && item.input !== existing.input)) throw new Error('待处理输入绑定与真实候选不同');
      const key = stableStringify(entry); if (!pendingKeys.has(key)) { pending.push(entry); pendingKeys.add(key); }
    }
  }
  let inserted = false;
  original.edges = original.edges.flatMap(edge => {
    if (edge.target !== targetId) return [edge];
    if (inserted) return [];
    inserted = true; return migrated;
  });
  const textContributions = new Map();
  for (const edge of migrated) {
    if (byField.get(edge.targetField)?.type !== 'text') continue;
    const key = JSON.stringify([edge.source, edge.sourceField, edge.targetField]);
    const occurrence = textContributions.get(key) || 0;
    if (occurrence) edge.sourceOccurrence = occurrence;
    textContributions.set(key, occurrence + 1);
  }
  // Validate the complete proposal, but do not use normalization to replace
  // unrelated extension metadata, source literals or current media records.
  parseGraph(serializeGraph(original));
  const result = clone({ graph: original, fields, receipt: response.receipt, logical_rebindings,
    output_rebindings, source_document: document, original_target_data, edge_migrations, pending });
  result.target = result.graph.nodes.find(node => node.id === targetId);
  return result;
}
