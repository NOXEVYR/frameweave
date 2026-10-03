import { packageValues } from './packages.mjs';
import { normalizeHiddenUpdates } from './editor-hidden-updates.mjs';
import { applyEditorInterfaceData } from './editor-canvas-interface.mjs';
import { restoreAudioMediaPreviews } from './audio-studio.mjs';

const packageId = value => /^p-[a-f0-9]{24}$/.test(value || '');
const editorId = value => /^e-[a-f0-9]{24}$/.test(value || '');
const text = value => typeof value === 'string' && value.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(value);
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
const copy = value => structuredClone(value);

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
  const baseline = {}, controls = compiled.controls || [];
  if (!compiled.output || !Array.isArray(controls)) throw new Error('原生前端未提供可验证的执行图和控件映射');
  for (const field of pack.fields) {
    const expected = pack.prompt?.[field.node_id], actual = compiled.output[field.node_id];
    if (!expected || !actual || actual.class_type !== expected.class_type || !Object.hasOwn(actual.inputs || {}, field.input) || !scalar(actual.inputs[field.input])) {
      throw new Error(`无法确认「${field.label || field.id}」的原生输入；原参数保留，请从执行图副本重新进入或先修复原工作流`);
    }
    const matches = controls.filter(c => c?.node_id === field.node_id && c.input === field.input);
    const control = matches[0];
    if (matches.length !== 1 || !text(control.widget_node_id) || !control.widget_node_id || !text(control.widget_name) || !control.widget_name ||
        controls.filter(c => c?.widget_node_id === control.widget_node_id && c.widget_name === control.widget_name).length !== 1) {
      throw new Error(`「${field.label || field.id}」缺少唯一的原生控件映射；原参数保留，尚未建立同步基线`);
    }
    baseline[field.id] = actual.inputs[field.input];
  }
  return { ...copy(data), editor_baseline: baseline, editor_controls: controls.map(c => {
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
