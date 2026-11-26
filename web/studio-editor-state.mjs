import { packageValues } from './packages.mjs';
import { normalizeHiddenUpdates } from './editor-hidden-updates.mjs';
import { applyEditorInterfaceData } from './editor-canvas-interface.mjs';
import { restoreAudioMediaPreviews } from './audio-studio.mjs';
import { stableStringify } from './graph.mjs';

const packageId = value => /^p-[a-f0-9]{24}$/.test(value || '');
const editorId = value => /^e-[a-f0-9]{24}$/.test(value || '');
const text = value => typeof value === 'string' && value.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(value);
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const copy = value => structuredClone(value);
const initializationRepairs = new WeakMap();
const repairTypes = new Set(['text', 'integer', 'number', 'boolean', 'select']);
const compilationIdentity = compiled => stableStringify({ workflow: compiled.workflow, output: compiled.output,
  controls: (compiled.controls || []).map(control => Object.fromEntries(
    ['node_id', 'input', 'widget_node_id', 'widget_name'].map(key => [key, control?.[key]]))),
  additional_inputs: compiled.additional_inputs, native_input_observations: compiled.native_input_observations });

/** Obtain a session-only exception from the local service, never caller JSON.
 * This restores execution parameters, not widgets. Recompile after the HTTP
 * read so a changed native graph cannot initialize from an earlier response.
 */
export async function restoreStudioInitializationRepairs(target, compiled, { api, workflow, session, assertCurrent, compile }) {
  const data = target?.data;
  if (!data || !editorId(data.editor_id) || !packageId(data.package_id) || workflow?.id !== data.editor_id ||
      !Number.isSafeInteger(workflow.revision) || workflow.revision < 1 || session?.backend_url !== data.editor_backend ||
      typeof session.session_id !== 'string' || !session.session_id || session.session_id.length > 200 ||
      typeof api !== 'function' || typeof compile !== 'function' || typeof assertCurrent !== 'function' ||
      !compiled?.workflow || !compiled.output || !Array.isArray(compiled.controls)) {
    throw new Error('补参初始化缺少当前原生会话、来源或编译证据；原参数保留');
  }
  await assertCurrent();
  const dataIdentity = stableStringify(data), identity = compilationIdentity(compiled);
  const context = { workflowId: workflow.id, revision: workflow.revision, backend: session.backend_url, sessionId: session.session_id };
  const current = async () => {
    await assertCurrent();
    if (target.data !== data || stableStringify(data) !== dataIdentity || compilationIdentity(compiled) !== identity ||
        workflow.id !== context.workflowId || workflow.revision !== context.revision ||
        session.backend_url !== context.backend || session.session_id !== context.sessionId) {
      throw new Error('补参检查期间来源、参数、编译图或原生会话已变化；未建立初始化基线');
    }
  };
  const response = await api(`/api/editor-workflows/${context.workflowId}/interface`, {
    session_id: context.sessionId, base_revision: context.revision, document: compiled.workflow, prompt: compiled.output,
    previous_package_id: data.package_id,
    ...(data.editor_outputs?.length ? { output_nodes: [...data.editor_outputs] } : {}),
    ...(compiled.additional_inputs ? { additional_inputs: compiled.additional_inputs } : {}),
    ...(compiled.native_input_observations ? { native_input_observations: compiled.native_input_observations } : {}),
  });
  await current();
  const confirmed = await compile(); await current();
  if (compilationIdentity(confirmed) !== identity) throw new Error('补参检查期间内部图或控件映射已变化；请重新进入核对');
  const sources = response?.repair_sources || [], fields = response?.fields || [];
  if (!Array.isArray(sources) || sources.length > 4096 || !Array.isArray(fields) || fields.length > 4096 ||
      !response.prompt || typeof response.prompt !== 'object' || Array.isArray(response.prompt)) {
    throw new Error('本地补参检查未返回可核验的执行参数；原参数保留');
  }
  const repaired = copy(compiled.output), verified = new Map();
  for (const source of sources) {
    if (source?.status !== 'restored') continue;
    const matches = fields.filter(field => field?.id === source.id && field.node_id === source.node_id && field.input === source.input);
    const field = matches[0], original = compiled.output[source.node_id], restored = response.prompt[source.node_id];
    const key = JSON.stringify([source.node_id, source.input]);
    if (source.source !== 'explicit_missing_input' || matches.length !== 1 || !repairTypes.has(field.type) ||
        !text(source.id) || !text(source.node_id) || !text(source.input) || verified.has(key) ||
        !Number.isSafeInteger(source.origin_revision) || source.origin_revision < 1 ||
        !original || !restored || original.class_type !== restored.class_type ||
        Object.hasOwn(original.inputs || {}, source.input) || !Object.hasOwn(restored.inputs || {}, source.input) ||
        !scalar(restored.inputs[source.input])) {
      throw new Error('本地补参绑定与当前缺项不一致；原参数保留，未建立初始化基线');
    }
    repaired[source.node_id].inputs[source.input] = copy(restored.inputs[source.input]);
    verified.set(key, { id: source.id, node_id: source.node_id, input: source.input, type: field.type,
      class_type: restored.class_type, value: copy(restored.inputs[source.input]) });
  }
  if (stableStringify(repaired) !== stableStringify(response.prompt)) {
    throw new Error('补参检查改变了其它执行内容；未建立初始化基线');
  }
  await current();
  initializationRepairs.set(compiled, { target, data, dataIdentity, identity, verified, context, workflow, session });
  return [...verified.values()].filter(field => !(compiled.controls || []).some(control =>
    control.node_id === field.node_id && control.input === field.input)).map(({ value, class_type, ...field }) => field);
}

/** A persisted instance carries no bridge/session token or raw executable code. */
export function studioEditorRecord(data, revision, { initialized = true, sourceKind = 'unknown' } = {}) {
  if (!editorId(data.editor_id) || !packageId(data.package_id) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('工作台编辑实例标识或版本无效');
  const url = new URL(data.editor_backend);
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('工作台编辑引擎地址无效');
  const controls = data.editor_controls || [];
  if (!Array.isArray(controls) || controls.length > 4096 || controls.some(c => !c || !['node_id', 'input', 'widget_node_id', 'widget_name'].every(k => text(c[k]) && c[k]))) throw new Error('工作台控件映射无效');
  const outputs = data.editor_outputs || [], outputFields = data.editor_output_fields || [];
  if (!Array.isArray(outputs) || outputs.length > 64 || outputs.some(id => !text(id)) || !Array.isArray(outputFields) || outputFields.length > 64) throw new Error('工作台输出映射无效');
  return { editor_id: data.editor_id, package_id: data.package_id, revision, editor_backend: data.editor_backend,
    initialized: initialized === true, source_kind: ['native', 'api', 'unknown'].includes(sourceKind) ? sourceKind : 'unknown',
    editor_baseline: packageValues(data.editor_baseline || {}),
    editor_controls: controls.map(c => Object.fromEntries(['node_id', 'input', 'widget_node_id', 'widget_name'].map(k => [k, c[k]]))),
    editor_outputs: [...outputs], editor_output_fields: packageValues({ fields: outputFields }).fields,
    editor_hidden_updates: normalizeHiddenUpdates(data.editor_hidden_updates || []) };
}

export function restoreStudioEditorBindings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 200) return {};
  const restored = {};
  for (const [id, record] of Object.entries(value)) {
    if (!packageId(id) || record?.package_id !== id) continue;
    try { restored[id] = studioEditorRecord(record, record.revision, { initialized: record.initialized, sourceKind: record.source_kind }); }
    catch { /* The package/values remain usable even when an old editor hint is invalid. */ }
  }
  return restored;
}

export function restoreStudioEditorMetadata(source) {
  const editorBindings = restoreStudioEditorBindings(source?.editorBindings), editorHistory = [];
  for (const record of Array.isArray(source?.editorHistory) ? source.editorHistory.slice(0, 200) : []) {
    try { editorHistory.push(studioEditorRecord(record, record.revision, { initialized: record.initialized, sourceKind: record.source_kind })); } catch { /* Keep unrelated valid records. */ }
  }
  const validRecovery = value => value && packageId(value.package_id) && editorId(value.editor_id) && Number.isSafeInteger(value.revision) && value.revision > 0 && ['unknown', 'binding_failed'].includes(value.reason)
    ? { package_id: value.package_id, editor_id: value.editor_id, revision: value.revision, reason: value.reason } : null;
  const editorRecovery = validRecovery(source?.editorRecovery), editorRecoveries = {};
  if (editorRecovery) editorRecoveries[editorRecovery.package_id] = editorRecovery;
  const entries = source?.editorRecoveries;
  if (entries && typeof entries === 'object' && !Array.isArray(entries) && Object.keys(entries).length <= 200) {
    for (const [id, value] of Object.entries(entries)) { const checked = validRecovery(value); if (checked?.package_id === id) editorRecoveries[id] = checked; }
  }
  return { editorBindings, editorHistory, editorRecoveries, ...(editorRecovery ? { editorRecovery } : {}) };
}

export function studioEditorRecovery(draft, id) {
  return draft.editorRecoveries?.[id] || (draft.editorRecovery?.package_id === id ? draft.editorRecovery : null);
}

export function clearStudioEditorRecovery(draft, id) {
  if (draft.editorRecovery?.package_id === id) delete draft.editorRecovery;
  if (draft.editorRecoveries) delete draft.editorRecoveries[id];
}

export function studioEditorData(draft, pack, backend, record = null) {
  const owners = {};
  for (const field of pack.fields) if (['image', 'video', 'audio'].includes(field.type)) {
    const name = draft.values?.[field.id], source = draft.mediaBackends?.[field.id];
    if (typeof name === 'string' && name && source) owners[field.id] = { name, backend: source };
  }
  return { ...(record ? copy(record) : {}), kind: 'package', title: pack.name, package_id: pack.id,
    packageFields: copy(pack.fields), packageValues: packageValues(draft.values || {}), packageMediaBackends: owners,
    editor_backend: record?.editor_backend || backend };
}

/** Used once for a newly made source copy, never to reset an existing merge base. */
export function initializeStudioEditorData(data, pack, compiled) {
  const baseline = {}, controls = compiled.controls || [], values = copy(data.packageValues || {});
  const proof = initializationRepairs.get(compiled);
  const validProof = proof && proof.target.data === data && proof.data === data &&
    proof.dataIdentity === stableStringify(data) && proof.identity === compilationIdentity(compiled) &&
    proof.context.workflowId === data.editor_id && proof.context.backend === data.editor_backend &&
    proof.workflow.id === proof.context.workflowId && proof.workflow.revision === proof.context.revision &&
    proof.session.session_id === proof.context.sessionId && proof.session.backend_url === proof.context.backend &&
    data.package_id === pack.id;
  if (!compiled.output || !Array.isArray(controls)) throw new Error('原生前端未提供可验证的执行图和控件映射');
  for (const field of pack.fields) {
    const expected = pack.prompt?.[field.node_id], actual = compiled.output[field.node_id];
    const restored = validProof && proof.verified.get(JSON.stringify([field.node_id, field.input]));
    const matches = controls.filter(c => c?.node_id === field.node_id && c.input === field.input);
    if (restored && restored.id === field.id && restored.type === field.type && expected?.class_type === restored.class_type &&
        actual?.class_type === restored.class_type && !Object.hasOwn(actual.inputs || {}, field.input) && matches.length === 0) {
      baseline[field.id] = copy(restored.value);
      // A fresh source copy may have no local outer value. Only this verified,
      // execution-only repair supplies one; explicit outer choices stay intact.
      if (!Object.hasOwn(values, field.id)) values[field.id] = copy(restored.value);
      continue;
    }
    if (!expected || !actual || actual.class_type !== expected.class_type || !Object.hasOwn(actual.inputs || {}, field.input) || !scalar(actual.inputs[field.input])) {
      throw new Error(`无法确认「${field.label || field.id}」的原生输入；原参数保留，请从执行图副本重新进入或先修复原工作流`);
    }
    const control = matches[0];
    if (matches.length !== 1 || !text(control.widget_node_id) || !control.widget_node_id || !text(control.widget_name) || !control.widget_name ||
        controls.filter(c => c?.widget_node_id === control.widget_node_id && c.widget_name === control.widget_name).length !== 1) {
      throw new Error(`「${field.label || field.id}」缺少唯一的原生控件映射；原参数保留，尚未建立同步基线`);
    }
    baseline[field.id] = actual.inputs[field.input];
  }
  initializationRepairs.delete(compiled);
  return { ...copy(data), packageValues: values, editor_baseline: baseline, editor_controls: controls.map(c => {
    const next = { ...c }; delete next.media_receipt; delete next.mapping_receipt; return next;
  }) };
}

/** Commit a new package without changing a frozen request or another category's draft. */
export function applyStudioEditorResult(draft, data, result, revision, sourceKind) {
  if (!packageId(result.package?.id) || !Array.isArray(result.package.fields)) throw new Error('应用未返回有效工作流包');
  const transformed = applyEditorInterfaceData(data, result), next = copy(draft);
  next.valuesByPackage ||= {}; next.mediaBackendsByPackage ||= {}; next.editorBindings ||= {}; next.mediaPreviewsByPackage ||= {};
  next.valuesByPackage[draft.package_id] = copy(draft.values || {});
  next.mediaBackendsByPackage[draft.package_id] = copy(draft.mediaBackends || {});
  next.package_id = result.package.id; next.values = packageValues(transformed.packageValues);
  next.mediaBackends = Object.fromEntries(Object.entries(transformed.packageMediaBackends).map(([id, owner]) => [id, owner.backend]));
  next.valuesByPackage[next.package_id] = copy(next.values); next.mediaBackendsByPackage[next.package_id] = copy(next.mediaBackends);
  const oldPreviews = restoreAudioMediaPreviews(draft.mediaPreviewsByPackage)[draft.package_id] || {}, previews = {};
  for (const field of result.package.fields) {
    // Rebinding does not transfer a thumbnail proof, even if filenames match.
    if (Object.hasOwn(result.rebindings || {}, field.id) || Object.values(result.rebindings || {}).includes(field.id)) continue;
    const prior = oldPreviews[field.id], owner = transformed.packageMediaBackends[field.id];
    if (prior && owner && prior.name === next.values[field.id] && prior.backend === owner.backend && prior.backend === result.backend_url && prior.type === field.type) previews[field.id] = copy(prior);
  }
  next.mediaPreviewsByPackage[next.package_id] = previews;
  next.editorBindings[next.package_id] = studioEditorRecord(transformed, revision, { initialized: true, sourceKind });
  if (Object.keys(next.editorBindings).length > 200) throw new Error('工作台编辑绑定已达 200 项，原参数保留；本次内部结果已保存，请导出整理后核对');
  clearStudioEditorRecovery(next, draft.package_id);
  clearStudioEditorRecovery(next, next.package_id);
  return { draft: next, data: transformed };
}
