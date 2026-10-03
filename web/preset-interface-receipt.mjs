/** Data-only migration plans. These helpers never write a canvas or editor. */
import { MAX_INTERFACE_FIELDS } from './interface-limits.mjs';
import { parseGraph, serializeGraph } from './graph.mjs';
import { isSafeSelectLiteral } from './packages.mjs';

const LIMIT = 2 * 1024 * 1024;
const MEDIA = new Set(['image', 'video', 'audio']);
const TYPES = new Set(['text', 'integer', 'number', 'boolean', 'select', ...MEDIA]);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !RESERVED.has(value);
const logicalOK = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(value) &&
  value.split('.').every(part => part && !RESERVED.has(part));
const nameOK = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const keyOf = value => JSON.stringify([value.node_id, value.input]);

function copy(value) {
  let count = 0;
  function visit(item, depth = 0) {
    if (++count > 500000 || depth > 80) throw new Error('预设接口数据超过结构预算');
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return;
    if (!record(item) && !Array.isArray(item) || record(item) &&
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('预设接口只接受安全 JSON 数据');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('预设接口数组不能包含空槽或额外属性');
    for (const [key, child] of Object.entries(item)) {
      if (RESERVED.has(key)) throw new Error('预设接口包含保留字段名');
      visit(child, depth + 1);
    }
  }
  visit(value);
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).length > LIMIT) throw new Error('预设接口数据超过 2 MiB');
  return JSON.parse(json);
}

function diagnostic(code, details = {}) {
  const messages = {
    invalid_candidate: '实际接口候选缺少有效的 ID、绑定或类型',
    duplicate_candidate_id: '实际接口候选 ID 重复，不能猜测目标',
    ambiguous_candidate_binding: '实际接口候选对同一节点输入存在多义绑定',
    invalid_receipt: '预设映射缺少有效逻辑 ID、类型或目标列表',
    duplicate_logical_id: '预设逻辑 ID 重复',
    invalid_target: '预设目标缺少有效绑定或类型与逻辑输入不同',
    duplicate_receipt_binding: '预设实际绑定被重复声明或多个逻辑输入争用',
    target_missing: '实际接口候选中不存在预设声明的节点输入',
    target_type_changed: '实际接口候选类型与预设声明不同',
    target_ambiguous: '预设目标不能唯一匹配实际接口候选',
    mapping_unavailable: '逻辑输入没有完整可证明的候选映射',
    invalid_edge: '待迁移连线 ID、来源或逻辑端口无效或重复',
    aggregation_required: '此连线需要明确的提示词聚合合同，不能按单字段覆盖迁移',
    edge_type_unproven: '来源字段或目标类型不支持安全连线迁移',
    duplicate_media_input: '同一媒体输入不能连接多个来源，未猜测使用哪份素材',
    invalid_own_value: '自身参数类型或数值边界不符合实际字段合同',
    invalid_label: '自身输入用途名称无效',
    media_owner_unproven: '媒体来源证明无效；原始证据已保留，未声明素材就绪',
    owner_unknown: '媒体没有来源证明，不能声明已传入当前后端',
    other_backend: '媒体属于另一推理后端，未重新上传',
    media_missing: '媒体尚未提供；接口与原连线需要保留',
  };
  return { code, message: messages[code], blocking: true,
    ...Object.fromEntries(Object.entries(details).filter(([_key, value]) => value !== undefined)) };
}

/** Resolve only exact declared bindings; labels, positions and defaults are never evidence. */
export function resolvePresetInterfaceReceipt({ receipt, fields }) {
  const source = copy({ receipt, fields });
  if (!Array.isArray(source.receipt) || !Array.isArray(source.fields) ||
    source.receipt.length > MAX_INTERFACE_FIELDS || source.fields.length > MAX_INTERFACE_FIELDS) {
    throw new Error(`预设映射与候选最多 ${MAX_INTERFACE_FIELDS} 项`);
  }
  const diagnostics = [], byBinding = new Map(), fieldIds = new Map();
  for (const field of source.fields) {
    if (!record(field) || !idOK(field.id) || !nameOK(field.node_id) || !nameOK(field.input) || !TYPES.has(field.type)) {
      diagnostics.push(diagnostic('invalid_candidate')); continue;
    }
    fieldIds.set(field.id, (fieldIds.get(field.id) || 0) + 1);
    const key = keyOf(field), list = byBinding.get(key) || []; list.push(field); byBinding.set(key, list);
  }
  for (const [id, count] of fieldIds) if (count > 1) diagnostics.push(diagnostic('duplicate_candidate_id', { field_id: id }));
  for (const list of byBinding.values()) if (list.length > 1) diagnostics.push(diagnostic('ambiguous_candidate_binding', { node_id: list[0].node_id, input: list[0].input }));
  const logicalCounts = new Map(), targetCounts = new Map();
  let totalTargets = 0;
  for (const item of source.receipt) {
    if (record(item) && logicalOK(item.logical_id)) logicalCounts.set(item.logical_id, (logicalCounts.get(item.logical_id) || 0) + 1);
    if (Array.isArray(item?.targets)) for (const target of item.targets) {
      if (++totalTargets > MAX_INTERFACE_FIELDS) throw new Error(`预设实际目标最多 ${MAX_INTERFACE_FIELDS} 项`);
      if (record(target) && nameOK(target.node_id) && nameOK(target.input)) {
        const key = keyOf(target); targetCounts.set(key, (targetCounts.get(key) || 0) + 1);
      }
    }
  }
  const mappings = [];
  for (const item of source.receipt) {
    if (!record(item) || !logicalOK(item.logical_id) || !TYPES.has(item.type) || !Array.isArray(item.targets) || !item.targets.length) {
      diagnostics.push(diagnostic('invalid_receipt', { ...(logicalOK(item?.logical_id) ? { logical_id: item.logical_id } : {}) })); continue;
    }
    const start = diagnostics.length, matches = [];
    if (logicalCounts.get(item.logical_id) !== 1) diagnostics.push(diagnostic('duplicate_logical_id', { logical_id: item.logical_id }));
    for (const target of item.targets) {
      const details = { logical_id: item.logical_id, ...(record(target) ? { node_id: target.node_id, input: target.input } : {}) };
      if (!record(target) || !nameOK(target.node_id) || !nameOK(target.input) || target.type !== item.type) {
        diagnostics.push(diagnostic('invalid_target', details)); continue;
      }
      if (targetCounts.get(keyOf(target)) !== 1) { diagnostics.push(diagnostic('duplicate_receipt_binding', details)); continue; }
      const candidates = byBinding.get(keyOf(target)) || [];
      if (!candidates.length) { diagnostics.push(diagnostic('target_missing', details)); continue; }
      if (candidates.length !== 1 || fieldIds.get(candidates[0].id) !== 1) { diagnostics.push(diagnostic('target_ambiguous', details)); continue; }
      if (candidates[0].type !== target.type) { diagnostics.push(diagnostic('target_type_changed', details)); continue; }
      matches.push(candidates[0]);
    }
    if (diagnostics.length === start) mappings.push({ ...item, fields: matches });
  }
  return copy({ ok: diagnostics.length === 0, mappings, diagnostics });
}

function ownerProof(owner) {
  const node = { id: 'proof', type: 'generation', x: 0, y: 0,
    data: { kind: 'h3_t2v', packageMediaBackends: { proof: owner } } };
  return parseGraph(serializeGraph({ nodes: [node], edges: [] })).nodes[0].data.packageMediaBackends.proof;
}

function scalarCheck(field, value) {
  if (field.type === 'text') return { valid: typeof value === 'string' && value.length <= 64000 };
  if (field.type === 'boolean') return { valid: typeof value === 'boolean' };
  if (field.type === 'select') return {
    valid: isSafeSelectLiteral(value),
    pending: Array.isArray(field.options) && field.options.some(option => Object.is(option, value)) ? '' : 'selection_unverified',
  };
  if (field.type === 'integer' && !Number.isSafeInteger(value) || field.type === 'number' &&
    (typeof value !== 'number' || !Number.isFinite(value))) return { valid: false };
  return { valid: true, pending: (field.min === undefined || typeof field.min === 'number' && value >= field.min) &&
    (field.max === undefined || typeof field.max === 'number' && value <= field.max) ? '' : 'range_unverified' };
}

function mediaLiteralValid(value) {
  if (typeof value !== 'string' || value.length > 1024) return false;
  if (!value) return true;
  // Syntax only; this dummy identity is never emitted as media ownership.
  try { ownerProof({ name: value, backend: 'http://127.0.0.1:1' }); return true; } catch { return false; }
}

/**
 * ready_to_apply covers interface migration only, not execution/resource readiness.
 * Pending origins distinguish an empty own fallback from an unavailable source.
 * stored_own_values are N; value_updates never contain derived connected C.
 * The caller must recheck its frozen source/backend before using any plan.
 */
export function preflightPresetInterfaceMigration({ receipt, fields, incoming_edges = [], pending = [],
  own_values = {}, media_owners = {}, input_labels = {}, backend = '' }) {
  const source = copy({ receipt, fields, incoming_edges, pending, own_values, media_owners, input_labels, backend });
  if (!Array.isArray(source.incoming_edges) || source.incoming_edges.length > 2000 || !Array.isArray(source.pending) ||
    source.pending.length > MAX_INTERFACE_FIELDS || ![source.own_values, source.media_owners, source.input_labels].every(record)) {
    throw new Error('预设迁移来源结构或数量无效');
  }
  const resolution = resolvePresetInterfaceReceipt(source), diagnostics = [...resolution.diagnostics];
  const byLogical = new Map(resolution.mappings.map(item => [item.logical_id, item]));
  const edge_migrations = [], value_updates = [], stored_own_values = {}, remapped_pending = [], owners = {}, labels = {};
  const unmapped = { incoming_edges: [], pending: [], own_values: {}, media_owners: {}, input_labels: {} };
  const selected = new Set(), edgeIds = new Set(), usedFields = new Set();
  const mapped = logical => {
    const mapping = byLogical.get(logical);
    if (!mapping) diagnostics.push(diagnostic('mapping_unavailable', { logical_id: logical }));
    return mapping;
  };
  for (const edge of source.incoming_edges) {
    if (!record(edge) || !nameOK(edge.id) || edgeIds.has(edge.id) || !nameOK(edge.source) || !logicalOK(edge.logical_id)) {
      diagnostics.push(diagnostic('invalid_edge')); unmapped.incoming_edges.push(edge); continue;
    }
    edgeIds.add(edge.id);
    const mapping = mapped(edge.logical_id);
    if (!mapping) { unmapped.incoming_edges.push(edge); continue; }
    const expected = mapping.type === 'text' ? ['text', 'negative'] : MEDIA.has(mapping.type) ? [mapping.type] : [];
    if (!expected.includes(edge.source_field)) {
      const code = edge.source_field === undefined && mapping.type === 'text' ? 'aggregation_required' : 'edge_type_unproven';
      diagnostics.push(diagnostic(code, { logical_id: edge.logical_id, edge_id: edge.id, blocking: code !== 'aggregation_required' }));
      unmapped.incoming_edges.push(edge); continue;
    }
    const ids = mapping.fields.map(field => field.id);
    if (MEDIA.has(mapping.type) && ids.some(id => usedFields.has(id))) {
      diagnostics.push(diagnostic('duplicate_media_input', { logical_id: edge.logical_id, edge_id: edge.id }));
      unmapped.incoming_edges.push(edge); continue;
    }
    if (ids.some(id => usedFields.has(id)) || mapping.type === 'text' && typeof source.own_values[edge.logical_id] === 'string' && source.own_values[edge.logical_id]) {
      diagnostics.push(diagnostic('aggregation_required', { logical_id: edge.logical_id, edge_id: edge.id, blocking: false }));
      unmapped.incoming_edges.push(edge); continue;
    }
    for (const id of ids) { usedFields.add(id); selected.add(id); }
    edge_migrations.push({ ...edge, field_ids: ids });
  }
  for (const [logical, value] of Object.entries(source.own_values)) {
    const mapping = mapped(logical);
    if (!mapping) { unmapped.own_values[logical] = value; continue; }
    const checks = mapping.fields.map(field => MEDIA.has(field.type) ? { valid: mediaLiteralValid(value) } : scalarCheck(field, value));
    if ((logical.startsWith('models.') && typeof value === 'string' && !mediaLiteralValid(value)) || checks.some(check => !check.valid)) {
      diagnostics.push(diagnostic('invalid_own_value', { logical_id: logical })); unmapped.own_values[logical] = value; continue;
    }
    for (const field of mapping.fields) { stored_own_values[field.id] = value; selected.add(field.id); }
    if (checks.some(check => check.pending)) {
      for (let index = 0; index < mapping.fields.length; index++) {
        const field = mapping.fields[index];
        remapped_pending.push({ logical_id: logical, field_id: field.id, node_id: field.node_id, input: field.input,
          type: field.type, reason: checks[index].pending || 'fanout_value_unverified', origin: 'own' });
      }
      continue;
    }
    for (const field of mapping.fields) value_updates.push({ field_id: field.id, value });
    if (MEDIA.has(mapping.type) && !value) for (const field of mapping.fields) remapped_pending.push({ logical_id: logical, field_id: field.id, node_id: field.node_id, input: field.input, type: field.type, reason: 'media_missing', origin: 'own' });
    else if (MEDIA.has(mapping.type) && !Object.hasOwn(source.media_owners, logical)) for (const field of mapping.fields) remapped_pending.push({ logical_id: logical, field_id: field.id, node_id: field.node_id, input: field.input, type: field.type, reason: 'owner_unknown', origin: 'own' });
  }
  for (const [logical, owner] of Object.entries(source.media_owners)) {
    const mapping = mapped(logical);
    if (!mapping || !MEDIA.has(mapping.type)) {
      if (mapping) diagnostics.push(diagnostic('media_owner_unproven', { logical_id: logical }));
      unmapped.media_owners[logical] = owner; continue;
    }
    let proof;
    try {
      proof = ownerProof(owner);
      if (proof.name !== source.own_values[logical]) throw new Error('name mismatch');
    } catch {
      diagnostics.push(diagnostic('media_owner_unproven', { logical_id: logical, blocking: false })); unmapped.media_owners[logical] = owner;
      for (const field of mapping.fields) remapped_pending.push({ logical_id: logical, field_id: field.id, node_id: field.node_id, input: field.input, type: field.type, reason: 'owner_unknown', origin: 'own' });
      continue;
    }
    let sameBackend = false;
    try { sameBackend = ownerProof({ name: proof.name, backend }).backend === proof.backend; } catch { /* No known target backend is not proof. */ }
    for (const field of mapping.fields) {
      owners[field.id] = proof; selected.add(field.id);
      if (!sameBackend) remapped_pending.push({ logical_id: logical, field_id: field.id, node_id: field.node_id, input: field.input, type: field.type, reason: 'other_backend', origin: 'own' });
    }
  }
  for (const item of source.pending) {
    const logical = item?.logical_id || item?.field_id;
    const mapping = mapped(logical);
    if (!mapping) { unmapped.pending.push(item); continue; }
    for (const field of mapping.fields) {
      remapped_pending.push({ ...item, logical_id: logical, field_id: field.id, node_id: field.node_id, input: field.input, type: field.type }); selected.add(field.id);
    }
  }
  for (const [logical, label] of Object.entries(source.input_labels)) {
    const mapping = mapped(logical);
    if (!mapping) { unmapped.input_labels[logical] = label; continue; }
    if (typeof label !== 'string' || !label.trim() || label.length > 80) {
      diagnostics.push(diagnostic('invalid_label', { logical_id: logical })); unmapped.input_labels[logical] = label; continue;
    }
    for (const field of mapping.fields) labels[field.id] = label;
  }
  const needs_aggregation = diagnostics.some(item => item.code === 'aggregation_required');
  const ok = !diagnostics.some(item => item.blocking);
  return copy({ ok, needs_aggregation, ready_to_apply: ok && !needs_aggregation, has_pending_values: remapped_pending.length > 0,
    plan_only: true, mappings: resolution.mappings,
    selected_field_ids: [...selected], edge_migrations, value_updates, stored_own_values, pending: remapped_pending,
    media_owners: owners, input_labels: labels, unmapped, issues: diagnostics });
}
