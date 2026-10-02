/** Explicit direct-reference transfer, separate from generation and native editing. */
import { projectEditorInputs } from './editor-preparation.mjs';

const MEDIA = new Set(['image', 'video', 'audio']);
const TRANSFERABLE = new Set(['local_only', 'other_backend', 'owner_unknown', 'invalid_media']);

export async function stageEditorMediaSync(graph, targetId, options, api, ensureCurrent = () => {}, progress = () => {}) {
  ensureCurrent();
  const projection = projectEditorInputs(graph, targetId, options);
  const target = graph.nodes.find(node => node.id === targetId);
  const sources = new Map(graph.nodes.map(node => [node.id, node]));
  const fields = new Map((options.fields || []).map(field => [field.id, field]));
  const values = { ...(projection.source.data.packageValues || {}) };
  for (const item of projection.overrides) if (fields.has(item.field_id)) values[item.field_id] = item.value;
  const tasks = [], pending = [];
  // Explicit synchronization also refreshes known names. A URL/name receipt
  // does not establish that the engine still retains the remote file.
  const candidates = [...projection.pending,
    ...projection.overrides.filter(item => item.media_owner),
    ...Object.entries(projection.presetInputs.references).map(([field_id, item]) => ({ ...item, field_id }))];
  for (const item of candidates) {
    if (!['connected', 'transaction'].includes(item.origin)) continue;
    const source = sources.get(item.source_id);
    if (!source || source.type !== 'reference' || !MEDIA.has(source.data.mediaType)) {
      if (item.reason === 'upstream_not_run') pending.push(item);
      continue;
    }
    if (item.reason && !TRANSFERABLE.has(item.reason)) {
      pending.push(item); continue;
    }
    if (!/^[a-f0-9]{64}$/.test(source.data.localAssetId || '')) {
      pending.push({ ...item, reason: 'local_copy_unavailable' }); continue;
    }
    // Images share ComfyUI's image upload contract. Audio/video additionally
    // require the live, exact package field loader contract on the server.
    const type = source.data.mediaType;
    let fieldId = null;
    if (type !== 'image') {
      const field = fields.get(item.field_id);
      if (!source.data.localMedia || !target.data.package_id || field?.type !== type) {
        pending.push({ ...item, reason: 'mapping_unavailable' }); continue;
      }
      fieldId = field.id;
    }
    tasks.push({ sourceId: source.id, assetId: source.data.localAssetId,
      endpoint: source.data.localMedia ? 'media' : 'images', type, fieldId });
  }
  const assetKey = source => JSON.stringify([source.data.localMedia ? 'media' : 'images', source.data.localAssetId]);
  // One invalid use blocks the asset, including other nodes holding the same
  // local file. Validate every AV port together before uploading it once.
  const blocked = new Set(pending.map(item => sources.get(item.source_id)).filter(Boolean).map(assetKey));
  const groups = new Map();
  for (const task of tasks) {
    const key = assetKey(sources.get(task.sourceId));
    if (blocked.has(key)) continue;
    if (!groups.has(key)) groups.set(key, { ...task, sourceIds: new Set(), fieldIds: new Set() });
    const group = groups.get(key);
    if (group.type !== task.type) throw new Error('同一本地素材存在冲突类型；未改写画布');
    group.sourceIds.add(task.sourceId);
    if (task.fieldId) group.fieldIds.add(task.fieldId);
  }
  const updates = new Map(), total = [...groups.values()].reduce((count, group) => count + group.sourceIds.size, 0);
  for (const task of groups.values()) {
    ensureCurrent();
    const fieldIds = [...task.fieldIds];
    const binding = task.type === 'image' ? {} : { package_id: target.data.package_id, field_ids: fieldIds, values, refresh: true };
    const result = await api(`/api/assets/${task.endpoint}/${task.assetId}/backend-input`,
      { ...binding, expected_backend: projection.backend });
    ensureCurrent();
    if (result?.asset_id !== task.assetId || result.backend !== projection.backend ||
        typeof result.name !== 'string' || !result.name ||
        result.media_type !== undefined && result.media_type !== task.type ||
        task.type !== 'image' && (result.media_type !== task.type || result.package_id !== binding.package_id || !Array.isArray(result.field_ids) ||
          result.field_ids.length !== fieldIds.length || new Set(result.field_ids).size !== fieldIds.length ||
          fieldIds.some(id => !result.field_ids.includes(id)))) {
      throw new Error('素材同步回执与当前引擎、文件或端口不一致；未改写画布');
    }
    // Reuse the canonical relative-name/backend checks before returning any update.
    const probe = { nodes: graph.nodes.map(node => task.sourceIds.has(node.id) ? { ...node,
      data: { ...node.data, name: result.name, uploadBackend: result.backend } } : node), edges: graph.edges };
    const checked = projectEditorInputs(probe, targetId, options);
    if (checked.pending.some(item => task.sourceIds.has(item.source_id) && TRANSFERABLE.has(item.reason))) {
      throw new Error('素材同步返回了无效文件名；未改写画布');
    }
    for (const id of task.sourceIds) updates.set(id, { id, assetId: task.assetId, name: result.name, uploadBackend: result.backend });
    progress(updates.size, total);
  }
  ensureCurrent();
  return { updates: [...updates.values()], pending };
}
