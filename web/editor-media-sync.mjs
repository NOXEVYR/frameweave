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
  for (const item of projection.pending) {
    if (item.origin !== 'connected') continue;
    const source = sources.get(item.source_id);
    if (!source || source.type !== 'reference' || !MEDIA.has(source.data.mediaType)) {
      if (item.reason === 'upstream_not_run') pending.push(item);
      continue;
    }
    if (!TRANSFERABLE.has(item.reason) || !/^[a-f0-9]{64}$/.test(source.data.localAssetId || '')) {
      pending.push(item); continue;
    }
    // Images share ComfyUI's image upload contract. Audio/video additionally
    // require the live, exact package field loader contract on the server.
    const type = source.data.mediaType;
    let binding = {};
    if (type !== 'image') {
      const field = fields.get(item.field_id);
      if (!source.data.localMedia || !target.data.package_id || field?.type !== type) {
        pending.push({ ...item, reason: 'mapping_unavailable' }); continue;
      }
      binding = { package_id: target.data.package_id, field_id: field.id, values };
    }
    tasks.push({ sourceId: source.id, assetId: source.data.localAssetId,
      endpoint: source.data.localMedia ? 'media' : 'images', type, binding });
  }
  // A source with an invalid/ambiguous connection is not partially uploaded.
  const blocked = new Set(pending.map(item => item.source_id));
  const eligible = tasks.filter(task => !blocked.has(task.sourceId));
  const cache = new Map(), updates = new Map();
  for (const task of eligible) {
    ensureCurrent();
    const key = JSON.stringify([task.endpoint, task.assetId, task.binding]);
    if (!cache.has(key)) {
      const result = await api(`/api/assets/${task.endpoint}/${task.assetId}/backend-input`,
        { ...task.binding, expected_backend: projection.backend });
      ensureCurrent();
      if (result?.asset_id !== task.assetId || result.backend !== projection.backend ||
          typeof result.name !== 'string' || !result.name ||
          result.media_type !== undefined && result.media_type !== task.type ||
          task.type !== 'image' && (result.package_id !== task.binding.package_id || result.field_id !== task.binding.field_id)) {
        throw new Error('素材同步回执与当前引擎、文件或端口不一致；未改写画布');
      }
      // Reuse the canonical relative-name/backend checks before returning any update.
      const source = sources.get(task.sourceId);
      const probe = { nodes: graph.nodes.map(node => node === source ? { ...node,
        data: { ...node.data, name: result.name, uploadBackend: result.backend } } : node), edges: graph.edges };
      const checked = projectEditorInputs(probe, targetId, options);
      if (checked.pending.some(item => item.source_id === task.sourceId && TRANSFERABLE.has(item.reason))) {
        throw new Error('素材同步返回了无效文件名；未改写画布');
      }
      cache.set(key, result);
    }
    const result = cache.get(key), previous = updates.get(task.sourceId);
    if (previous && previous.name !== result.name) throw new Error('同一素材返回了不同文件，未改写画布；请重新同步');
    updates.set(task.sourceId, { id: task.sourceId, assetId: task.assetId, name: result.name, uploadBackend: result.backend });
    progress(updates.size, new Set(eligible.map(item => item.sourceId)).size);
  }
  ensureCurrent();
  return { updates: [...updates.values()], pending };
}
