/** Pure graph operations shared by the canvas and dependency-free tests. */
import { packageValues, parseJSONWithSafeNumbers } from './packages.mjs';
export const SCHEMA = 'frameweave.canvas.v1';
export const NODE_TYPES = ['prompt', 'reference', 'generation', 'result'];
export const KINDS = ['h3_t2v', 'h3_i2v', 'h3_ref', 'sdxl', 'krea', 'api', 'package'];
const copy = value => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function makeId(prefix = 'node') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function createNode(type, x, y, overrides = {}) {
  if (!NODE_TYPES.includes(type)) throw new Error('不支持的节点类型');
  const defaults = {
    prompt: { title: '提示词', text: '', negative: '' },
    reference: { title: '参考素材', name: '', url: '', mediaType: 'image', role: 'reference' },
    generation: { title: 'H3 视频生成', kind: 'h3_t2v', positive: '', negative: '', seed: 42, width: 768, height: 448, steps: 20, cfg: 1, seconds: 5, fps: 24, sampler: 'euler', scheduler: 'simple', denoise: 1, models: {}, lora_strength: 1, apiPrompt: null, package_id: '', packageValues: {} },
    result: { title: '生成结果', outputs: [], jobId: '' },
  };
  return { id: makeId(), type, x: finite(x), y: finite(y), data: { ...defaults[type], ...copy(overrides) } };
}

export function canConnect(graph, source, target) {
  if (source === target) return { ok: false, reason: '节点不能连接自身' };
  const from = graph.nodes.find(node => node.id === source);
  const to = graph.nodes.find(node => node.id === target);
  if (!from || !to) return { ok: false, reason: '连接节点不存在' };
  if (to.type === 'generation' && to.data.kind === 'package') return { ok: false, reason: '工作流包通过右侧表单填写输入，输出端口可连接结果节点' };
  const valid = (['prompt', 'reference'].includes(from.type) && to.type === 'generation') || (from.type === 'generation' && to.type === 'result');
  if (!valid) return { ok: false, reason: '连接顺序：提示词 / 参考素材 → 生成 → 结果' };
  if (graph.edges.some(edge => edge.source === source && edge.target === target)) return { ok: false, reason: '连接已存在' };
  if (to.type === 'result' && graph.edges.some(edge => edge.target === target)) return { ok: false, reason: '一个结果节点只能接收一个生成节点' };
  const pending = [target];
  const visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === source) return { ok: false, reason: '连接不能形成循环' };
    if (visited.has(id)) continue;
    visited.add(id);
    graph.edges.filter(edge => edge.source === id).forEach(edge => pending.push(edge.target));
  }
  return { ok: true };
}

export function connect(graph, source, target) {
  const validation = canConnect(graph, source, target);
  if (!validation.ok) throw new Error(validation.reason);
  graph.edges.push({ id: makeId('edge'), source, target });
  return graph;
}

export function removeNodes(graph, ids) {
  const removed = new Set(ids);
  graph.nodes = graph.nodes.filter(node => !removed.has(node.id));
  graph.edges = graph.edges.filter(edge => !removed.has(edge.source) && !removed.has(edge.target));
  return graph;
}

export function duplicateNodes(graph, ids) {
  const selected = new Set(ids);
  const map = new Map();
  const clones = graph.nodes.filter(node => selected.has(node.id)).map(node => {
    const clone = copy(node);
    clone.id = makeId();
    clone.x += 44;
    clone.y += 44;
    if (clone.type === 'result') { clone.data.outputs = []; clone.data.jobId = ''; }
    map.set(node.id, clone.id);
    return clone;
  });
  const edges = graph.edges.filter(edge => map.has(edge.source) && map.has(edge.target)).map(edge => ({ id: makeId('edge'), source: map.get(edge.source), target: map.get(edge.target) }));
  graph.nodes.push(...clones);
  graph.edges.push(...edges);
  return clones.map(node => node.id);
}

export function generationPayload(graph, id) {
  const node = graph.nodes.find(item => item.id === id && item.type === 'generation');
  if (!node) throw new Error('请选择生成节点');
  if (node.data.kind === 'package') {
    if (typeof node.data.package_id !== 'string' || !node.data.package_id) throw new Error('请先选择或导入对应工作流包');
    return { kind: 'package', package_id: node.data.package_id, values: packageValues(node.data.packageValues || {}) };
  }
  if (node.data.kind === 'api') {
    if (!node.data.apiPrompt || typeof node.data.apiPrompt !== 'object' || Array.isArray(node.data.apiPrompt)) throw new Error('请先导入 ComfyUI API 格式工作流');
    return { kind: 'api', prompt: copy(node.data.apiPrompt) };
  }
  const incoming = graph.edges.filter(edge => edge.target === id).map(edge => graph.nodes.find(item => item.id === edge.source)).filter(Boolean);
  const prompts = incoming.filter(item => item.type === 'prompt');
  const refs = incoming.filter(item => item.type === 'reference' && item.data.name);
  const orderedRefs = [...refs].sort((a, b) => ({ start: 0, reference: 1, end: 2 }[a.data.role] ?? 1) - ({ start: 0, reference: 1, end: 2 }[b.data.role] ?? 1));
  const data = copy(node.data);
  delete data.title;
  delete data.apiPrompt;
  delete data.package_id;
  delete data.packageValues;
  return {
    ...data,
    positive: [...prompts.map(item => item.data.text), data.positive].filter(Boolean).join('\n\n'),
    negative: [...prompts.map(item => item.data.negative), data.negative].filter(Boolean).join(', '),
    references: orderedRefs.map(item => item.data.name),
    reference_roles: orderedRefs.map(item => item.data.role || 'reference'),
  };
}

/** Restore a recorded request as an independent, editable canvas fragment. */
export function recipeGraph(recipe, x = 80, y = 80) {
  const request = recipe?.request;
  if (!request || typeof request !== 'object' || Array.isArray(request) || !KINDS.includes(request.kind)) throw new Error('任务没有可复用的生成参数');
  const data = copy(request);
  delete data.references;
  delete data.reference_roles;
  delete data.values;
  delete data.prompt;
  if (request.kind === 'api') data.apiPrompt = copy(request.prompt);
  if (request.kind === 'package') data.packageValues = packageValues(request.values || {});
  data.title = typeof recipe.title === 'string' ? recipe.title : `复用 · ${request.kind === 'package' ? '工作流包' : request.kind === 'api' ? 'API 工作流' : request.kind.startsWith('h3') ? 'H3 视频生成' : '图片生成'}`;
  const node = createNode('generation', x, y, data);
  const fragment = { nodes: [node], edges: [] };
  if (!['api', 'package'].includes(request.kind)) {
    (request.references || []).forEach((name, index) => {
      const metadata = (recipe.references || []).find(item => item.name === name) || {};
      const reference = createNode('reference', x - 345, y + index * 340, { title: `复用素材 ${index + 1}`, name, url: metadata.url || '', mediaType: 'image', role: request.reference_roles?.[index] || 'reference' });
      fragment.nodes.push(reference); connect(fragment, reference.id, node.id);
    });
  }
  // Use the same boundary validation as an imported canvas before adding anything.
  const validated = parseGraph(serializeGraph(fragment));
  generationPayload(validated, node.id);
  return { nodes: validated.nodes, edges: validated.edges, generationId: node.id };
}

export function stableStringify(value) {
  const sort = item => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sort(item[key])])) : item;
  return JSON.stringify(sort(value), null, 2);
}

/** Unknown progress stays unknown; queued jobs are not fabricated percentages. */
export function progressPercent(progress) {
  if (progress === null || progress === undefined) return null;
  if (typeof progress === 'number') return Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;
  if (typeof progress === 'object' && Number.isFinite(progress.value) && Number.isFinite(progress.max) && progress.max > 0) return Math.max(0, Math.min(100, progress.value / progress.max * 100));
  return null;
}

export function serializeGraph(graph, viewport = { x: 60, y: 60, scale: 1 }) {
  return stableStringify({ schema: SCHEMA, nodes: graph.nodes, edges: graph.edges, viewport });
}

export function parseGraph(text) {
  const input = parseJSONWithSafeNumbers(typeof text === 'string' ? text : JSON.stringify(text));
  if (input.schema !== SCHEMA || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) throw new Error('不是有效的 FrameWeave 画布文件');
  if (input.nodes.length > 500 || input.edges.length > 2000) throw new Error('画布超过限制：最多 500 个节点 / 2000 条连接');
  const seen = new Set();
  const nodes = input.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || !node.id || node.id.length > 120 || seen.has(node.id)) throw new Error('节点 ID 无效或重复');
    if (!NODE_TYPES.includes(node.type)) throw new Error('画布含有不支持的节点');
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || Math.abs(node.x) > 1e7 || Math.abs(node.y) > 1e7) throw new Error('节点坐标无效');
    if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw new Error('节点内容无效');
    seen.add(node.id);
    const data = createNode(node.type, 0, 0).data;
    for (const key of Object.keys(data)) {
      if (!(key in node.data)) continue;
      if (key === 'packageValues') data[key] = packageValues(node.data[key]);
      else if (['models', 'apiPrompt', 'outputs'].includes(key)) data[key] = copy(node.data[key]);
      else if (typeof data[key] === 'number') data[key] = finite(node.data[key], data[key]);
      else data[key] = String(node.data[key] ?? '').slice(0, 100000);
    }
    if (node.type === 'generation' && !KINDS.includes(data.kind)) throw new Error('生成模式不受支持');
    if (node.type === 'generation' && (!data.models || typeof data.models !== 'object' || Array.isArray(data.models))) data.models = {};
    if (node.type === 'generation') {
      // Optional native controls survive recipes and old canvases without adding defaults.
      for (const key of ['shift_video', 'shift_audio']) {
        if (!Object.hasOwn(node.data, key)) continue;
        const value = node.data[key];
        if (typeof value !== 'number' || !Number.isFinite(value) || value < .01 || value > 100) throw new Error(`${key} 必须是 0.01 到 100 之间的数字`);
        data[key] = value;
      }
      if (Object.hasOwn(node.data, 'ref_image_size')) data.ref_image_size = String(node.data.ref_image_size ?? '').slice(0, 100000);
      // The backend gives a nonempty top-level LoRA precedence. Normalize it into
      // the existing editable model role so later UI changes remain effective.
      if (node.data.lora) {
        if (typeof node.data.lora !== 'string') throw new Error('LoRA 模型名称必须是文本');
        data.models = { ...data.models, lora: node.data.lora.slice(0, 100000) };
      }
    }
    if (node.type === 'result') {
      if (!Array.isArray(data.outputs)) data.outputs = [];
      data.outputs = data.outputs.filter(item => item && ['image', 'video'].includes(item.type) && typeof item.url === 'string').slice(0, 32);
    }
    return { id: node.id, type: node.type, x: node.x, y: node.y, data };
  });
  const graph = { nodes, edges: [] };
  const edgeIds = new Set();
  for (const edge of input.edges) {
    if (!edge || typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) throw new Error('连接 ID 无效或重复');
    const validation = canConnect(graph, edge.source, edge.target);
    if (!validation.ok) throw new Error(`无效连接：${validation.reason}`);
    edgeIds.add(edge.id);
    graph.edges.push({ id: edge.id, source: edge.source, target: edge.target });
  }
  return { ...graph, viewport: { x: finite(input.viewport?.x, 60), y: finite(input.viewport?.y, 60), scale: Math.min(2, Math.max(0.2, finite(input.viewport?.scale, 1))) } };
}

export function createDemo() {
  const prompt = createNode('prompt', 40, 80, { title: '镜头 01 · 晨光花园', text: '清晨的玻璃温室，阳光穿过沾着露水的叶片。摄影机缓慢向前推进，微风轻轻拂动植物，远处浮现柔和的金色光晕。电影摄影，细腻自然光，稳定运动，真实材质。', negative: '画面闪烁，变形，文字，水印，过度锐化' });
  const generation = createNode('generation', 420, 80);
  const result = createNode('result', 800, 80, { title: '镜头 01 · 预览' });
  const graph = { nodes: [prompt, generation, result], edges: [] };
  connect(graph, prompt.id, generation.id);
  connect(graph, generation.id, result.id);
  return graph;
}
