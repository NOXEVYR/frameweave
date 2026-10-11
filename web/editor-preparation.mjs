/** Editing projections only: no uploads, execution planning, jobs or canvas writes. */
import { generationInputPorts, edgeInputField, parseGraph, serializeGraph, stableStringify } from './graph.mjs';
import { coerceFieldValue, parseJSONWithSafeNumbers } from './packages.mjs';
import { normalizeTextCompositions, composeTextInput, textCompositionOwn, recordTextContribution, textSourceOccurrence } from './text-input-composition.mjs';

const MEDIA = new Set(['image', 'video', 'audio']);
const TYPES = new Set(['text', 'integer', 'number', 'boolean', 'select', ...MEDIA]);
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !RESERVED.has(value);
export const EDITOR_PREPARATION_SOURCE_LIMIT = 16 * 1024 * 1024;
// Envelope duplicates source/fallback/baseline values; it is not an API prompt.
export const EDITOR_PREPARATION_RESULT_LIMIT = 32 * 1024 * 1024;

function jsonCopy(value, limit = EDITOR_PREPARATION_SOURCE_LIMIT) {
  let count = 0;
  const visit = (item, depth = 0) => {
    if (++count > 500000 || depth > 80) throw new Error('编辑准备数据过大或嵌套过深');
    if (item === null || ['string', 'boolean'].includes(typeof item)) return;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return;
    if (!item || typeof item !== 'object' || !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('编辑准备只支持安全 JSON 数据');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('编辑准备 JSON 数组不能包含空槽位或额外属性');
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > limit) throw new Error('编辑准备数据超过本次来源或投影预算');
  return parseJSONWithSafeNumbers(text);
}

function targetNode(graph, targetId) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('编辑准备需要画布节点和连线');
  const matches = graph.nodes.filter(node => node.id === targetId);
  if (matches.length !== 1 || matches[0].type !== 'generation') throw new Error('请选择有效的工作流节点');
  return matches[0];
}
function inputEdges(graph, targetId) {
  const incoming = graph.edges.filter(edge => edge.target === targetId), ids = new Set();
  for (const edge of incoming) {
    if (Object.hasOwn(edge, 'sourceOccurrence')) textSourceOccurrence(edge);
    if (typeof edge.id !== 'string' || !edge.id || edge.id.length > 120 || ids.has(edge.id) ||
        typeof edge.source !== 'string' || !edge.source || edge.source.length > 120) throw new Error('编辑准备直接输入连线标识无效或重复');
    ids.add(edge.id);
  }
  return jsonCopy(incoming);
}

// Reuse the canvas boundary's actual relative-name and loopback normalization.
function backendIdentity(value) {
  if (typeof value !== 'string' || !value) throw new Error('尚未选择内部编辑器的推理引擎');
  const proof = { id: 'proof', type: 'reference', x: 0, y: 0, data: { uploadBackend: value } };
  return parseGraph(serializeGraph({ nodes: [proof], edges: [] })).nodes[0].data.uploadBackend;
}
function mediaProof(name, backend) {
  const proof = { id: 'proof', type: 'generation', x: 0, y: 0,
    data: { kind: 'h3_t2v', packageMediaBackends: { proof: { name, backend } } } };
  return parseGraph(serializeGraph({ nodes: [proof], edges: [] })).nodes[0].data.packageMediaBackends.proof;
}

/** Only the edited target chooses its engine; unrelated dependencies do not. */
export function editorPreparationBackend(graph, targetId, currentBackend) {
  const backend = targetNode(graph, targetId).data.editor_backend || currentBackend;
  if (!backend) throw new Error('尚未选择内部编辑器的推理引擎');
  return backendIdentity(backend);
}

function transactionEvidence(context, target, sources) {
  const references = sources.filter(source => source?.type === 'reference').map(source => {
    const state = context.referenceImports?.get(source.id);
    return { id: source.id, state, ticket: state?.ticket,
      signature: stableStringify(state ? { failed: !!state.error, message: String(state.message || ''), mediaType: state.mediaType || '' } : null) };
  });
  const fields = new Set([...(target.data.packageFields || []).map(field => field.id),
    ...Object.keys(target.data.packageValues || {}), ...(target.data.editor_hidden_updates || []).map(item => item.field?.id)]);
  const transfers = [...fields].map(field => {
    const state = context.mediaTransfers?.state(`${context.canvasId}:${target.id}`, field);
    return { field, state, signature: stableStringify(state ? { status: state.status, error: state.error || '' } : null) };
  });
  return { references, transfers };
}

/** Capture before awaits. Source revision is supplied explicitly by the host. */
export function captureEditorPreparationTarget(graph, targetId, context) {
  if (!Object.hasOwn(context, 'sourceRevision')) throw new Error('编辑准备必须明确提供来源版本（未知时使用 null）');
  const target = targetNode(graph, targetId), incoming = inputEdges(graph, targetId);
  const sources = [...new Set(incoming.map(edge => edge.source))].map(id => {
    const matches = graph.nodes.filter(node => node.id === id);
    if (matches.length > 1) throw new Error('直接输入节点 ID 重复');
    return { id, node: matches[0] || null, signature: stableStringify(matches[0] ? jsonCopy({ type: matches[0].type, data: matches[0].data }) : null) };
  });
  return { targetId, target, canvasId: context.canvasId, backend: backendIdentity(context.backend),
    revision: stableStringify(jsonCopy(context.sourceRevision ?? null)),
    signature: stableStringify(jsonCopy({ type: target.type, data: target.data })),
    incoming: stableStringify(jsonCopy(incoming)), sources,
    transactions: transactionEvidence(context, target, sources.map(source => source.node)) };
}

export function assertEditorPreparationTarget(guard, graph, context) {
  const current = captureEditorPreparationTarget(graph, guard.targetId, context);
  const sameTransactions = (left, right, key) => left.length === right.length && left.every((item, index) =>
    item[key] === right[index][key] && item.state === right[index].state && item.ticket === right[index].ticket && item.signature === right[index].signature);
  if (guard.canvasId !== current.canvasId || guard.backend !== current.backend || guard.revision !== current.revision ||
      guard.target !== current.target || guard.signature !== current.signature || guard.incoming !== current.incoming ||
      guard.sources.length !== current.sources.length || guard.sources.some((source, index) =>
        source.id !== current.sources[index].id || source.node !== current.sources[index].node || source.signature !== current.sources[index].signature) ||
      !sameTransactions(guard.transactions.references, current.transactions.references, 'id') ||
      !sameTransactions(guard.transactions.transfers, current.transactions.transfers, 'field')) {
    throw new Error('编辑准备期间画布、工作流、直接输入或素材事务已变化；未覆盖当前画布');
  }
  return true;
}

function mappingOK(field) {
  return field && idOK(field.id) && TYPES.has(field.type) && ['node_id', 'input'].every(key =>
    typeof field[key] === 'string' && field[key] && field[key].length <= 200 && !RESERVED.has(field[key]));
}
function scalarValue(field, value) {
  if (field.type === 'text' && typeof value !== 'string' || field.type === 'boolean' && typeof value !== 'boolean' ||
      ['number', 'integer'].includes(field.type) && typeof value !== 'number' ||
      !['string', 'number', 'boolean'].includes(typeof value)) throw new Error('无效标量');
  if (typeof value === 'number' && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('无效数字');
  if (field.type === 'text' && value.length > 64000) throw new Error('工作流包文本超过 64000 字符');
  return coerceFieldValue({ ...field, required: false }, value);
}
const fieldRecord = field => ({ field_id: field?.id || null, ...(mappingOK(field) ? { node_id: field.node_id, input: field.input } : {}) });

function mediaValue(value, owner, type, backend, transaction, localAssetId = '') {
  if (transaction) return { reason: transaction.status === 'failed' || transaction.error ? 'import_failed' : 'import_pending' };
  if (!value) return { reason: localAssetId ? 'local_only' : 'media_missing' };
  if (!owner?.backend || owner.name !== value) return { reason: 'owner_unknown' };
  try {
    const proof = mediaProof(value, owner.backend);
    if (proof.backend !== backend) return { reason: 'other_backend' };
    return { value, owner: { ...proof, media_type: type } };
  } catch { return { reason: 'invalid_media' }; }
}

function ownProjection(data, fields, backend, mediaState) {
  if (!Array.isArray(fields) || fields.length > 4096) throw new Error('完整编辑字段映射无效');
  const pending = [], overrides = new Map(), mediaOwners = {};
  const byId = new Map(), seenBindings = new Map(), ambiguous = new Set();
  for (const field of fields) {
    if (byId.has(field.id)) ambiguous.add(field.id);
    byId.set(field.id, field);
  }
  const effectiveFields = [...fields];
  for (const item of data.editor_hidden_updates || []) {
    if (!byId.has(item.field.id)) { byId.set(item.field.id, item.field); effectiveFields.push(item.field); }
  }
  if (effectiveFields.length > 4096) throw new Error('完整编辑字段映射无效');
  for (const field of effectiveFields) {
    if (mappingOK(field)) {
      const binding = JSON.stringify([field.node_id, field.input]);
      if (seenBindings.has(binding)) { ambiguous.add(field.id); ambiguous.add(seenBindings.get(binding)); }
      seenBindings.set(binding, field.id);
    }
  }
  const addPending = (field, reason, extra = {}) => pending.push({ ...fieldRecord(field), reason, origin: 'own', ...extra });
  const coveredOwnReasons = new Set(['invalid_value', 'enum_unavailable', 'owner_unknown', 'other_backend', 'media_missing', 'local_only', 'invalid_media']);
  const put = (field, value, origin, extra = {}) => {
    if (origin === 'connected') {
      // A proved connected value is this session's effective input. Its stored
      // fallback remains in source, but fallback readiness cannot veto the edge.
      // Hidden changes and live target transfers retain their separate blockers.
      for (let index = pending.length - 1; index >= 0; index--) {
        const item = pending[index];
        if (item.field_id === field.id && item.origin === 'own' && coveredOwnReasons.has(item.reason)) pending.splice(index, 1);
      }
    }
    overrides.set(field.id, { ...fieldRecord(field), value, origin,
    ...(Object.hasOwn(data.packageValues || {}, field.id) ? { stored_fallback: data.packageValues[field.id] } : {}),
    ...(Object.hasOwn(data.editor_baseline || {}, field.id) ? { baseline: data.editor_baseline[field.id] } : {}), ...extra });
  };
  for (const field of effectiveFields) {
    const hiddenMatches = (data.editor_hidden_updates || []).filter(item => item.field.id === field.id);
    const hidden = hiddenMatches[0];
    const own = Object.hasOwn(data.packageValues || {}, field.id);
    if (!hidden && !own) continue;
    const provenance = { origin: hidden ? 'hidden' : 'own' };
    if (hidden && (hiddenMatches.length !== 1 || ['node_id', 'input', 'type'].some(key => hidden.field[key] !== field[key]))) {
      addPending(hidden.field, 'mapping_unavailable', provenance);
      continue;
    }
    if (!mappingOK(field) || ambiguous.has(field.id)) { addPending(field, 'mapping_unavailable', provenance); continue; }
    const value = hidden ? hidden.value : data.packageValues[field.id];
    if (MEDIA.has(field.type)) {
      const state = mediaState?.(field.id);
      const result = mediaValue(value, data.packageMediaBackends?.[field.id], field.type, backend, state);
      if (result.reason) addPending(field, result.reason, provenance);
      else { put(field, value, 'own', { media_owner: result.owner }); mediaOwners[field.id] = result.owner; }
    } else {
      try { put(field, scalarValue(field, value), hidden ? 'hidden' : 'own', hidden ? { baseline: hidden.baseline } : {}); }
      catch {
        const safeScalar = typeof value === 'string' || typeof value === 'boolean'
          || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
        const unavailable = field.type === 'select' && safeScalar && Array.isArray(field.options) && !field.options.includes(value);
        addPending(field, unavailable ? 'enum_unavailable' : 'invalid_value', provenance);
      }
    }
  }
  for (const id of Object.keys(data.packageValues || {})) if (!byId.has(id)) addPending({ id }, 'mapping_unavailable');
  return { pending, overrides, mediaOwners, byId, ambiguous, addPending, put };
}

/** Independent workspace input preparation, with no artificial canvas target. */
export function projectOwnEditorInputs(data, fields, { backend, mediaState } = {}) {
  backend = backendIdentity(backend);
  const { pending, overrides, mediaOwners } = ownProjection(jsonCopy(data), jsonCopy(fields), backend, mediaState);
  return jsonCopy({ backend, overrides: [...overrides.values()], pending, mediaOwners }, EDITOR_PREPARATION_RESULT_LIMIT);
}

/**
 * Host supplies full fields (not cached ports), current backend and transactions.
 * Overrides are session-only. stored_fallback and baseline must survive application.
 */
export function projectEditorInputs(graph, targetId, options) {
  const target = targetNode(graph, targetId), backend = backendIdentity(options.backend), data = jsonCopy(target.data);
  const fields = jsonCopy(options.fields || []), incoming = inputEdges(graph, targetId);
  const { pending, overrides, mediaOwners, byId, ambiguous, addPending, put } = ownProjection(data, fields, backend,
    fieldId => options.mediaTransfers?.state(`${options.canvasId}:${targetId}`, fieldId));
  const presetInputs = { positive: '', negative: '', references: {} }, legacyPositive = [], legacyNegative = [], positive = [], negative = [];
  const builtin = !['package', 'api'].includes(data.kind);
  const compositions = normalizeTextCompositions(data.packageTextCompositions, fields);
  for (const id of Object.keys(compositions)) {
    try { textCompositionOwn(data.packageValues, id); }
    catch { overrides.delete(id); addPending(byId.get(id), 'invalid_value'); }
  }
  const composedInputs = new Map();
  const contributions = new Set();
  const ports = builtin ? generationInputPorts(target) : [];
  const connectedCounts = new Map();
  for (const edge of incoming) {
    const fieldId = builtin ? edgeInputField({ nodes: [target, ...graph.nodes.filter(node => incoming.some(item => item.source === node.id))], edges: incoming }, edge) : edge.targetField;
    if (fieldId) connectedCounts.set(fieldId, (connectedCounts.get(fieldId) || 0) + 1);
  }
  for (const edge of incoming) {
    const sourceNodes = graph.nodes.filter(node => node.id === edge.source);
    if (sourceNodes.length > 1) throw new Error('直接输入节点 ID 重复');
    const source = sourceNodes[0] ? { id: sourceNodes[0].id, type: sourceNodes[0].type, data: jsonCopy(sourceNodes[0].data) } : null;
    const fieldId = builtin ? edgeInputField(graph, edge) : edge.targetField;
    const field = builtin ? ports.find(port => port.id === fieldId) : byId.get(fieldId);
    const extra = { edge_id: edge.id, source_id: edge.source, origin: 'connected' };
    if (!builtin) { overrides.delete(fieldId); delete mediaOwners[fieldId]; }
    if (!source) { addPending(field || { id: fieldId }, 'source_missing', extra); continue; }
    if (!field || !builtin && (!mappingOK(field) || ambiguous.has(field.id))) { addPending(field || { id: fieldId }, 'mapping_unavailable', extra); continue; }
    try { recordTextContribution(contributions, edge, { sourceType: source.type, fieldType: field.type, composition: compositions[fieldId] }); }
    catch { addPending(field, 'ambiguous_connection', extra); continue; }
    if (!builtin && MEDIA.has(field.type)) {
      const transfer = options.mediaTransfers?.state(`${options.canvasId}:${targetId}`, field.id);
      if (transfer) {
        addPending(field, transfer.status === 'failed' || transfer.error ? 'import_failed' : 'import_pending', { ...extra, origin: 'transaction' });
        continue;
      }
    }
    if (!builtin && connectedCounts.get(fieldId) > 1 && !compositions[fieldId] || builtin && MEDIA.has(field.type) && connectedCounts.get(fieldId) > 1) { addPending(field, 'ambiguous_connection', extra); continue; }
    if (source.type === 'prompt') {
      const sourceField = edge.sourceField || (builtin && edge.targetField === 'negative' ? 'negative' : 'text');
      const value = source.data[sourceField];
      if (field.type !== 'text' || !['text', 'negative'].includes(sourceField) || typeof value !== 'string' || value.length > 100000) { addPending(field, 'invalid_value', extra); continue; }
      if (!builtin) {
        if (compositions[fieldId]) {
          if (!composedInputs.has(fieldId)) composedInputs.set(fieldId, []);
          const inputs = composedInputs.get(fieldId);
          inputs.push({ ...extra, source_field: sourceField, value });
        } else {
          try { put(field, scalarValue(field, value), 'connected', extra); }
          catch { addPending(field, 'invalid_value', extra); }
        }
      }
      else if (!edge.targetField) {
        const pos = source.data.text, neg = source.data.negative;
        if (typeof pos !== 'string' || pos.length > 100000 || typeof neg !== 'string' || neg.length > 100000) { addPending(field, 'invalid_value', extra); continue; }
        legacyPositive.push(pos); legacyNegative.push(neg);
      } else (fieldId === 'negative' ? negative : positive).push(value);
    } else if (['generation', 'result'].includes(source.type)) addPending(field, 'upstream_not_run', extra);
    else if (source.type === 'reference' && MEDIA.has(field.type)) {
      if (source.data.mediaType !== field.type) { addPending(field, 'media_type_mismatch', extra); continue; }
      const transaction = options.referenceImports?.get(source.id);
      const result = mediaValue(source.data.name, { name: source.data.name, backend: source.data.uploadBackend }, field.type, backend, transaction, source.data.localAssetId);
      if (result.reason) addPending(field, result.reason, extra);
      else if (builtin) presetInputs.references[field.id] = { ...result.owner, ...extra };
      else { put(field, result.value, 'connected', { ...extra, media_owner: result.owner }); mediaOwners[field.id] = result.owner; }
    } else addPending(field, 'media_type_mismatch', extra);
  }
  for (const [id, inputs] of composedInputs) {
    const field = byId.get(id);
    // One invalid contributor vetoes the whole joined value, not just that edge.
    if (pending.some(item => item.field_id === id)) { overrides.delete(id); continue; }
    try {
      const value = composeTextInput(compositions[id], inputs.map(item => item.value), data.packageValues?.[id] ?? '');
      put(field, scalarValue(field, value), 'connected', { edge_id: inputs[0].edge_id,
        source_id: inputs[0].source_id, edge_ids: inputs.map(item => item.edge_id), composition: compositions[id] });
    } catch { overrides.delete(id); addPending(field, 'invalid_value', { origin: 'connected' }); }
  }
  if (builtin) {
    for (const key of ['positive', 'negative']) if (data[key] !== undefined && (typeof data[key] !== 'string' || data[key].length > 100000)) addPending({ id: key }, 'invalid_value');
    presetInputs.positive = [...legacyPositive, ...positive, typeof data.positive === 'string' && data.positive.length <= 100000 ? data.positive : ''].filter(Boolean).join('\n\n');
    presetInputs.negative = [...legacyNegative, ...negative, typeof data.negative === 'string' && data.negative.length <= 100000 ? data.negative : ''].filter(Boolean).join(', ');
    for (const key of ['positive', 'negative']) if (presetInputs[key].length > 100000) addPending({ id: key }, 'invalid_value', { origin: 'connected' });
  }
  return jsonCopy({ targetId, backend, source: { kind: data.editor_id ? 'native' : data.kind === 'api' ? 'api' : data.kind === 'package' ? 'package' : 'preset',
    editorId: data.editor_id || '', packageId: data.package_id || '', data }, overrides: [...overrides.values()], pending, mediaOwners, presetInputs }, EDITOR_PREPARATION_RESULT_LIMIT);
}
