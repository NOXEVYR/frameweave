/** Canvas images belong to the client; inference inputs belong to an engine. */
export function validateImageFile(file) {
  if (!file || !/\.(png|jpe?g|webp)$/i.test(file.name || '') && !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) throw new Error('请选择 PNG、JPG 或 WebP 图片');
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('单张图片须大于 0 字节且不超过 20 MiB');
}
export function validateMediaFile(file) {
  const video = /\.(mp4|webm|mov)$/i.test(file?.name || '') || /^video\/(mp4|webm|quicktime)$/i.test(file?.type || '');
  if (!video) { validateImageFile(file); return 'image'; }
  if (!file.size || file.size > 200 * 1024 * 1024) throw new Error('单个视频须大于 0 字节且不超过 200 MiB');
  return 'video';
}

export function readImageBase64(file) {
  validateImageFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reader.onabort = () => reject(new Error('无法读取图片，请重新选择'));
    reader.readAsDataURL(file);
  });
}

export function importPosition(point, index) {
  return {x: point.x + index % 3 * 360, y: point.y + Math.floor(index / 3) * 380};
}

export async function prepareLocalImages(graph, targets, backend, api) {
  const needed = new Set();
  const visit = id => { if (needed.has(id)) return; needed.add(id); graph.edges.filter(e => e.target === id).forEach(e => visit(e.source)); };
  targets.forEach(visit);
  const updates = [], uploaded = new Map();
  for (const node of graph.nodes.filter(n => needed.has(n.id) && n.type === 'reference' && n.data.localAssetId)) {
    if (node.data.name && node.data.uploadBackend === backend && node.data.mediaType !== 'video') continue;
    const id = node.data.localAssetId;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('本地图片标识无效，请重新导入');
    const endpoint = node.data.localMedia ? 'media' : 'images';
    const bindings = node.data.mediaType === 'video' ? graph.edges.filter(e => e.source === node.id && needed.has(e.target)).map(e => {
      const target = graph.nodes.find(n => n.id === e.target);
      if (target?.data.kind !== 'package' || !e.targetField) throw new Error('视频素材需要连接工作流明确开放的视频输入端口');
      return {package_id:target.data.package_id,field_id:e.targetField};
    }) : [{}];
    let result;
    for (const binding of bindings) {
      const key = `${endpoint}:${id}:${JSON.stringify(binding)}`;
      if (!uploaded.has(key)) uploaded.set(key, await api(`/api/assets/${endpoint}/${id}/backend-input`, binding));
      result = uploaded.get(key);
    }
    if (!result?.name || result.backend !== backend || result.asset_id !== id) throw new Error('推理引擎在准备图片时发生变化，尚未提交生成；本地图片已保留');
    updates.push({id: node.id, assetId: id, name: result.name, uploadBackend: result.backend});
  }
  return updates;
}
