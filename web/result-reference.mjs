/** Explicit reuse of an owned, completed output. Never starts a generation. */
import { createNode, generationInputPorts, edgeInputField, connect, parseGraph, serializeGraph, stableStringify } from './graph.mjs';

const TYPES = new Set(['image', 'video', 'audio']);
const idOK = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
const backendOf = value => {
  const proof = createNode('reference', 0, 0, { uploadBackend: value });
  if (!value) throw new Error('请先连接产物所属的推理引擎');
  return parseGraph(serializeGraph({ nodes: [proof], edges: [] })).nodes[0].data.uploadBackend;
};
const outputKey = output => stableStringify(Object.fromEntries(
  ['output_id', 'type', 'node_id', 'filename', 'subfolder', 'storage_type', 'url'].map(key => [key, output?.[key] ?? ''])));
export { outputKey as resultReferenceOutputKey };

export function resultReferenceOutputs(job) {
  if (!idOK(job?.id) || job.status !== 'completed') throw new Error('只能传入此客户端已完成任务的产物');
  const outputs = (job.outputs || []).filter(item => TYPES.has(item?.type));
  const counts = new Map();
  for (const item of outputs) counts.set(item.output_id, (counts.get(item.output_id) || 0) + 1);
  return outputs.filter(item => typeof item.output_id === 'string' && /^o-[a-f0-9]{64}$/.test(item.output_id)
    && counts.get(item.output_id) === 1 && /^\/api\/media\/[a-f0-9]{32}$/.test(item.url || ''));
}

export function resultReferenceTargets(graph, type, backend) {
  if (!TYPES.has(type)) return [];
  const occupied = new Map();
  for (const edge of graph.edges) {
    if (!occupied.has(edge.target)) occupied.set(edge.target, new Set());
    occupied.get(edge.target).add(edgeInputField(graph, edge));
  }
  return graph.nodes.filter(node => node.type === 'generation' && node.data.kind !== 'api'
    && (node.data.kind !== 'package' || node.data.package_id)
    && (!node.data.editor_backend || node.data.editor_backend === backend))
    .flatMap(node => generationInputPorts(node).filter(field => field.type === type
      && (type === 'image' || node.data.kind === 'package')
      && !occupied.get(node.id)?.has(field.id))
      .map(field => ({ node, field, label: `${node.data.title} · ${field.label || field.id} [${field.id}]` })));
}

/** Freeze source identity and target configuration before asynchronous transfer. */
export function captureResultReference({ graph, canvasId, source, job, outputId, targetId, fieldId, backend, newTarget = null }) {
  backend = backendOf(backend);
  if (job?.backend !== backend) throw new Error('产物属于另一个推理引擎，请切换回原引擎后传入');
  if (source?.type !== 'result' || !graph.nodes.includes(source) || source.data.jobId !== job.id) throw new Error('结果节点已更换任务，请重新选择产物');
  const output = resultReferenceOutputs(job).find(item => item.output_id === outputId);
  if (!output || !source.data.outputs?.some(item => outputKey(item) === outputKey(output))) throw new Error('所选产物已变化或没有可核验的输出身份，请刷新任务结果');
  // A quick-edit destination stays outside the canvas until the whole transfer
  // succeeds. Use the same port, ownership and persistence validation as reuse.
  if (newTarget && (newTarget.id !== targetId || graph.nodes.some(node => node.id === targetId))) throw new Error('新编辑节点身份冲突，请重新接入');
  const destinationGraph = newTarget ? { nodes: [...graph.nodes, newTarget], edges: graph.edges } : graph;
  if (newTarget) parseGraph(serializeGraph(destinationGraph));
  const choice = resultReferenceTargets(destinationGraph, output.type, backend).find(item => item.node.id === targetId && item.field.id === fieldId);
  if (!choice) throw new Error('目标输入不存在、类型不匹配、已连接或属于其他引擎');
  if (graph.nodes.length + (newTarget ? 2 : 1) > 500 || graph.edges.length >= 2000) throw new Error('画布容量不足，请先整理节点或连接');
  return { graph, canvasId, source, target: choice.node, targetId, newTarget: Boolean(newTarget), fieldId, backend, jobId: job.id, output: structuredClone(output),
    outputIndex: job.outputs.filter(item => item.type === output.type).indexOf(output),
    targetSignature: stableStringify(choice.node.data),
    edgesSignature: stableStringify(graph.edges.filter(edge => edge.target === targetId)) };
}

export function assertResultReferenceCurrent(ticket, { graph, canvasId, backend }) {
  if (ticket.graph !== graph || ticket.canvasId !== canvasId || ticket.backend !== backendOf(backend)
    || !graph.nodes.includes(ticket.source) || ticket.target.id !== ticket.targetId
    || (ticket.newTarget ? graph.nodes.some(node => node.id === ticket.target.id) : !graph.nodes.includes(ticket.target))
    || ticket.source.data.jobId !== ticket.jobId
    || !ticket.source.data.outputs?.some(item => outputKey(item) === outputKey(ticket.output))
    || ticket.targetSignature !== stableStringify(ticket.target.data)
    || ticket.edgesSignature !== stableStringify(graph.edges.filter(edge => edge.target === ticket.target.id))
    || graph.nodes.length + (ticket.newTarget ? 2 : 1) > 500 || graph.edges.length >= 2000) {
    throw new Error('传入期间画布、目标输入、产物或推理引擎已变化；没有修改当前画布');
  }
}

/** Shared transport proof for canvas and studio reuse; callers own their destination guard. */
export async function transferOwnedOutput(ticket, { api, check }) {
  backendOf(ticket.backend);
  check();
  const status = await api('/api/status'); check();
  if (!status?.online || backendOf(status.backend_url) !== ticket.backend) throw new Error('原推理引擎未连接或已切换，无法传入产物');
  const jobs = await api('/api/jobs'); check();
  const job = jobs?.jobs?.find(item => item.id === ticket.jobId);
  if (job?.backend !== ticket.backend || !resultReferenceOutputs(job).some(item => outputKey(item) === outputKey(ticket.output))) throw new Error('任务或所选产物已变化，请刷新后重试');
  const type = ticket.output.type;
  const data = { output_index: ticket.outputIndex, output_id: ticket.output.output_id,
    ...(type === 'image' ? {} : { media_type: type, package_id: ticket.packageId, field_id: ticket.fieldId }) };
  let uploaded;
  try { uploaded = await api(`/api/jobs/${encodeURIComponent(ticket.jobId)}/${type === 'image' ? 'image-input' : 'media-input'}`, data); }
  catch (error) { throw new Error(`产物传入未完成：${error.message}。没有提交生成或修改目标；请检查后手动重试。`); }
  check();
  const after = await api('/api/status'); check();
  if (!after?.online || backendOf(after.backend_url) !== ticket.backend) throw new Error('传入期间推理引擎已离线或切换，没有修改目标');
  if (uploaded?.backend !== ticket.backend || uploaded.source_job !== ticket.jobId || uploaded.output_id !== ticket.output.output_id
    || uploaded.media_type !== type || typeof uploaded.name !== 'string' || !uploaded.name
    || !/^\/api\/media\/[a-f0-9]{32}$/.test(uploaded.url || '')
    || type !== 'image' && (uploaded.package_id !== ticket.packageId || uploaded.field_id !== ticket.fieldId)) {
    throw new Error('素材传输回执与所选产物或目标不一致，没有修改目标');
  }
  parseGraph(serializeGraph({ nodes: [createNode('generation', 0, 0,
    { packageMediaBackends: { reference: { name: uploaded.name, backend: uploaded.backend } } })], edges: [] }));
  return uploaded;
}

export async function transferResultReference(ticket, { api, current }) {
  const check = () => assertResultReferenceCurrent(ticket, current());
  const uploaded = await transferOwnedOutput({ ...ticket, packageId: ticket.target.data.package_id }, { api, check });
  const type = ticket.output.type;
  const ref = createNode('reference', Math.max(-1e7, ticket.target.x - 380), ticket.target.y, {
    title: `参考 · ${ticket.output.filename || ticket.source.data.title}`.slice(0, 120),
    name: uploaded.name, uploadBackend: uploaded.backend, url: uploaded.url, mediaType: type,
    ...(uploaded.asset_id ? { localAssetId: uploaded.asset_id, localMedia: true, localFilename: ticket.output.filename } : {}),
  });
  const fragment = { nodes: [ref, structuredClone(ticket.target)], edges: [] };
  connect(fragment, ref.id, ticket.target.id, { targetField: ticket.fieldId });
  const edge = fragment.edges[0];
  // Validate using the same persisted-canvas boundary, including media name/owner.
  const candidate = parseGraph(serializeGraph({ nodes: [...ticket.graph.nodes, ...(ticket.newTarget ? [ticket.target] : []), ref], edges: [...ticket.graph.edges, edge] }));
  check();
  return { reference: candidate.nodes.find(node => node.id === ref.id), edge,
    ...(ticket.newTarget ? { target: candidate.nodes.find(node => node.id === ticket.target.id) } : {}) };
}
