/** Canvas images belong to the client; inference inputs belong to an engine. */
export function validateImageFile(file) {
  if (!file || !/\.(png|jpe?g|webp)$/i.test(file.name || '') && !/^image\/(png|jpeg|webp)$/i.test(file.type || '')) throw new Error('请选择 PNG、JPG 或 WebP 图片');
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('单张图片须大于 0 字节且不超过 20 MiB');
}
export function validateMediaFile(file) {
  const audio = /\.(wav|mp3|flac|ogg)$/i.test(file?.name || '') || /^audio\/(wav|x-wav|mpeg|mp3|flac|x-flac|ogg)$/i.test(file?.type || '');
  if (audio) {
    if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('单个音频须大于 0 字节且不超过 20 MiB');
    return 'audio';
  }
  const video = /\.(mp4|webm|mov)$/i.test(file?.name || '') || /^video\/(mp4|webm|quicktime)$/i.test(file?.type || '');
  if (!video) { validateImageFile(file); return 'image'; }
  if (!file.size || file.size > 200 * 1024 * 1024) throw new Error('单个视频须大于 0 字节且不超过 200 MiB');
  return 'video';
}

export function mediaFileContentType(file) {
  const aliases = {'audio/x-wav':'audio/wav','audio/mp3':'audio/mpeg','audio/x-flac':'audio/flac'};
  const inferred = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',wav:'audio/wav',mp3:'audio/mpeg',flac:'audio/flac',ogg:'audio/ogg'};
  return aliases[file.type] || file.type || inferred[(file.name || '').split('.').pop().toLowerCase()] || 'application/octet-stream';
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

/** A visible replacement must never submit the previous underlying asset. */
export function upstreamNodeIds(graph, targets) {
  const needed = new Set();
  const visit = id => { if (needed.has(id)) return; needed.add(id); graph.edges.filter(edge => edge.target === id).forEach(edge => visit(edge.source)); };
  targets.forEach(visit);
  return needed;
}

export function assertReferenceImportsReady(graph, targets, imports) {
  const needed = upstreamNodeIds(graph, targets);
  const blocked = graph.nodes.find(node => needed.has(node.id) && node.type === 'reference' && imports.has(node.id));
  if (blocked) throw new Error(`素材“${blocked.data.title || blocked.id}”尚未成功保存。请等待导入完成；保存失败时重新选择素材或选择保留原素材，避免生成使用旧图。`);
}

export async function prepareLocalImages(graph, targets, backend, api) {
  const needed = new Set();
  const visit = id => { if (needed.has(id)) return; needed.add(id); graph.edges.filter(e => e.target === id).forEach(e => visit(e.source)); };
  targets.forEach(visit);
  const updates = [], uploaded = new Map();
  for (const node of graph.nodes.filter(n => needed.has(n.id) && n.type === 'reference' && n.data.localAssetId)) {
    if (node.data.name && node.data.uploadBackend === backend && !['video','audio'].includes(node.data.mediaType)) continue;
    const id = node.data.localAssetId;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('本地素材标识无效，请重新导入');
    const endpoint = node.data.localMedia ? 'media' : 'images';
    const bindings = ['video','audio'].includes(node.data.mediaType) ? graph.edges.filter(e => e.source === node.id && needed.has(e.target)).map(e => {
      const target = graph.nodes.find(n => n.id === e.target);
      if (target?.data.kind !== 'package' || !e.targetField) throw new Error('音视频素材需要连接工作流明确开放的对应输入端口');
      return {package_id:target.data.package_id,field_id:e.targetField};
    }) : [{}];
    let result;
    for (const binding of bindings) {
      const key = `${endpoint}:${id}:${JSON.stringify(binding)}`;
      if (!uploaded.has(key)) uploaded.set(key, await api(`/api/assets/${endpoint}/${id}/backend-input`, binding));
      result = uploaded.get(key);
    }
    if (!result?.name || result.backend !== backend || result.asset_id !== id) throw new Error('推理引擎在准备素材时发生变化，尚未提交生成；本地素材已保留');
    updates.push({id: node.id, assetId: id, name: result.name, uploadBackend: result.backend});
  }
  return updates;
}
