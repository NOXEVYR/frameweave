/** Pure graph operations shared by the canvas and dependency-free tests. */
import { packageValues, parseJSONWithSafeNumbers } from './packages.mjs';
export const SCHEMA = 'frameweave.canvas.v1';
export const NODE_TYPES = ['prompt', 'reference', 'generation', 'result'];
export const KINDS = ['h3_t2v', 'h3_i2v', 'h3_ref', 'sdxl', 'sdxl_i2i', 'krea', 'api', 'package'];
const copy = value => JSON.parse(JSON.stringify(value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const FIELD_TYPES = ['text', 'integer', 'number', 'boolean', 'select', 'image'];
const RESERVED_FIELDS = new Set(['__proto__', 'prototype', 'constructor']);
const fieldId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value) && !RESERVED_FIELDS.has(value);

/** Cached public ports only. The actual package is refreshed and validated before running. */
function packageFields(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error('工作流包最多开放 64 个输入参数');
  const seen = new Set();
  return value.map(field => {
    if (!field || typeof field !== 'object' || Array.isArray(field) || !fieldId(field.id) || seen.has(field.id)) throw new Error('工作流包参数 ID 无效或重复');
    if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120) throw new Error('工作流包参数名称必须是 1–120 字符的文本');
    if (!FIELD_TYPES.includes(field.type)) throw new Error('工作流包不支持此参数类型');
    seen.add(field.id);
    return { id: field.id, label: field.label, type: field.type };
  });
}

function edgeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('连接参数必须为对象');
  const result = {};
  if (Object.hasOwn(options, 'targetField')) {
    if (!fieldId(options.targetField)) throw new Error('连接的目标参数 ID 无效');
    result.targetField = options.targetField;
  }
  if (Object.hasOwn(options, 'sourceField')) {
    if (!['text', 'negative', 'image'].includes(options.sourceField)) throw new Error('连接的来源字段无效');
    result.sourceField = options.sourceField;
  }
  if (Object.hasOwn(options, 'outputIndex')) {
    if (!Number.isInteger(options.outputIndex) || options.outputIndex < 0 || options.outputIndex > 31) throw new Error('输出图片序号必须是 0 到 31 之间的整数');
    result.outputIndex = options.outputIndex;
  }
  return result;
}

function uploadedImageName(value) {
  if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('参考图必须使用后端上传返回的相对名称');
  const name = value.replaceAll('\\', '/');
  if (name.startsWith('/') || name.includes(':') || name.split('/').some(part => ['.', '..'].includes(part)) || name.includes('\0')) throw new Error('参考图必须使用后端上传返回的相对名称');
  return value;
}

/** Keep this optional: an explicit empty stack disables the legacy LoRA role. */
function loraStack(value, kind) {
  if (!Array.isArray(value) || value.length > 4) throw new Error('LoRA 必须是最多 4 项的列表');
  return value.map((entry, index) => {
    const label = `LoRA ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} 参数无效`);
    if (Object.keys(entry).some(key => !['name', 'strength_model', 'strength_clip'].includes(key))) throw new Error(`${label} 含有不支持的参数`);
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 1024) throw new Error(`${label} 模型名称必须是 1–1024 字符的文本`);
    const result = { name: entry.name };
    for (const key of ['strength_model', 'strength_clip']) {
      if (!Object.hasOwn(entry, key)) continue;
      const number = entry[key];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < -10 || number > 10) throw new Error(`${label} ${key} 必须是 -10 到 10 之间的数字`);
      if (key === 'strength_clip' && !['sdxl', 'sdxl_i2i'].includes(kind) && number !== 0) throw new Error('H3 / Krea LoRA 仅支持模型强度，CLIP 强度应省略或设为 0');
      result[key] = number;
    }
    return result;
  });
}

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

export function canConnect(graph, source, target, options = {}) {
  if (source === target) return { ok: false, reason: '节点不能连接自身' };
  const from = graph.nodes.find(node => node.id === source);
  const to = graph.nodes.find(node => node.id === target);
  if (!from || !to) return { ok: false, reason: '连接节点不存在' };
  let binding;
  try { binding = edgeOptions(options); } catch (error) { return { ok: false, reason: error.message }; }
  if (binding.sourceField && !(from.type === 'prompt' ? ['text', 'negative'] : ['image']).includes(binding.sourceField)) return { ok: false, reason: '来源节点与连接字段类型不匹配' };
  if (binding.outputIndex && !['generation', 'result'].includes(from.type)) return { ok: false, reason: '只有生成或结果节点可选择输出图片序号' };
  const packaged = to.type === 'generation' && to.data.kind === 'package';
  if (packaged) {
    if (!binding.targetField) return { ok: false, reason: '请选择工作流包的目标输入参数；未连接字段仍可通过表单填写' };
    let fields;
    try { fields = packageFields(to.data.packageFields || []); } catch (error) { return { ok: false, reason: error.message }; }
    const field = fields.find(item => item.id === binding.targetField);
    if (!field) return { ok: false, reason: '工作流包目标参数不存在，请刷新工作流包定义' };
    const sourceType = from.type === 'prompt' ? 'text' : ['reference', 'generation', 'result'].includes(from.type) ? 'image' : null;
    if (!['text', 'image'].includes(field.type)) return { ok: false, reason: '此参数通过表单填写；只有文本与图片参数支持连线' };
    if (field.type !== sourceType || from.type === 'reference' && from.data.mediaType !== 'image') return { ok: false, reason: '连接类型不匹配：文本接文本，图片接图片' };
    if (graph.edges.some(edge => edge.target === target && edge.targetField === binding.targetField)) return { ok: false, reason: '工作流包此输入参数已有连接，请先断开原连接' };
  } else {
    if (binding.targetField) return { ok: false, reason: '仅工作流包支持按输入参数连线' };
    const valid = (['prompt', 'reference'].includes(from.type) && to.type === 'generation') || (from.type === 'generation' && to.type === 'result');
    if (!valid) return { ok: false, reason: '连接顺序：提示词 / 参考素材 → 生成 → 结果；工作流包可接文本或图片输入' };
    if (graph.edges.some(edge => edge.source === source && edge.target === target)) return { ok: false, reason: '连接已存在' };
  }
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

export function connect(graph, source, target, options = {}) {
  const validation = canConnect(graph, source, target, options);
  if (!validation.ok) throw new Error(validation.reason);
  graph.edges.push({ id: makeId('edge'), source, target, ...edgeOptions(options) });
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
  const edges = graph.edges.filter(edge => map.has(edge.source) && map.has(edge.target)).map(edge => ({ id: makeId('edge'), source: map.get(edge.source), target: map.get(edge.target), ...edgeOptions(edge) }));
  const validated = parseGraph(serializeGraph({ nodes: clones, edges }));
  graph.nodes.push(...validated.nodes);
  graph.edges.push(...validated.edges);
  return validated.nodes.map(node => node.id);
}

export function generationPayload(graph, id, context = {}) {
  const node = graph.nodes.find(item => item.id === id && item.type === 'generation');
  if (!node) throw new Error('请选择生成节点');
  if (!KINDS.includes(node.data.kind)) throw new Error('生成模式不受支持');
  if (node.data.kind === 'package') {
    if (typeof node.data.package_id !== 'string' || !node.data.package_id) throw new Error('请先选择或导入对应工作流包');
    const values = packageValues(node.data.packageValues || {});
    const checked = { nodes: graph.nodes, edges: graph.edges.filter(edge => edge.target !== id) };
    for (const edge of graph.edges.filter(edge => edge.target === id)) {
      const validation = canConnect(checked, edge.source, edge.target, edge);
      if (!validation.ok) throw new Error(`工作流包输入连接无效：${validation.reason}`);
      checked.edges.push(edge);
      const source = graph.nodes.find(item => item.id === edge.source);
      if (source.type === 'prompt') {
        const text = source.data[edge.sourceField || 'text'];
        if (typeof text !== 'string' || text.length > 100000) throw new Error('连接的提示词必须是不超过 100000 字符的文本');
        values[edge.targetField] = text;
      } else if (source.type === 'reference') {
        if (!source.data.name) throw new Error('工作流包参考图片待准备，请先上传已连接的图片');
        values[edge.targetField] = uploadedImageName(source.data.name);
      } else {
        const images = context?.edgeImages;
        if (!images || typeof images !== 'object' || Array.isArray(images) || !Object.hasOwn(images, edge.id) || !images[edge.id]) throw new Error('等待上游生成完成，输出图片待准备；请先运行上游并将图片上传到当前后端');
        values[edge.targetField] = uploadedImageName(images[edge.id]);
      }
    }
    return { kind: 'package', package_id: node.data.package_id, values: packageValues(values) };
  }
  if (node.data.kind === 'api') {
    if (!node.data.apiPrompt || typeof node.data.apiPrompt !== 'object' || Array.isArray(node.data.apiPrompt)) throw new Error('请先导入 ComfyUI API 格式工作流');
    return { kind: 'api', prompt: copy(node.data.apiPrompt) };
  }
  const incoming = graph.edges.filter(edge => edge.target === id).map(edge => graph.nodes.find(item => item.id === edge.source)).filter(Boolean);
  const prompts = incoming.filter(item => item.type === 'prompt');
  const refs = incoming.filter(item => item.type === 'reference' && item.data.name);
  const orderedRefs = [...refs].sort((a, b) => ({ start: 0, reference: 1, end: 2 }[a.data.role] ?? 1) - ({ start: 0, reference: 1, end: 2 }[b.data.role] ?? 1));
  if (node.data.kind === 'sdxl_i2i' && refs.length !== 1) throw new Error('SDXL 图生图需要连接 1 张已上传的参考图片');
  for (const ref of refs) {
    uploadedImageName(ref.data.name);
    if (ref.data.mediaType !== 'image') throw new Error('生成节点需要图片参考素材，请先上传图片');
  }
  const stack = Object.hasOwn(node.data, 'loras') ? loraStack(node.data.loras, node.data.kind) : undefined;
  if (!Number.isSafeInteger(node.data.seed) || node.data.seed < 0) throw new Error('随机种子必须是 0 到 9007199254740991 之间的整数');
  const data = copy(node.data);
  if (stack !== undefined) data.loras = stack;
  delete data.title;
  delete data.apiPrompt;
  delete data.package_id;
  delete data.packageValues;
  delete data.packageFields;
  return {
    ...data,
    positive: [...prompts.map(item => item.data.text), data.positive].filter(Boolean).join('\n\n'),
    negative: [...prompts.map(item => item.data.negative), data.negative].filter(Boolean).join(', '),
    references: orderedRefs.map(item => item.data.name),
    reference_roles: orderedRefs.map(item => item.data.role || 'reference'),
  };
}

/** Upstream generations execute once, including dependencies reached through result nodes. */
export function executionOrder(graph, ids = graph.nodes.filter(node => node.type === 'generation').map(node => node.id)) {
  if (!Array.isArray(ids) && !(ids instanceof Set)) throw new Error('执行节点须为节点 ID 列表');
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length) throw new Error('节点 ID 无效或重复');
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error('执行链中存在缺失节点');
    incoming.get(edge.target).push(edge.source);
  }
  const states = new Map(), order = [];
  const visit = id => {
    if (states.get(id) === 1) throw new Error('执行链不能形成循环');
    if (states.get(id) === 2) return;
    states.set(id, 1);
    incoming.get(id).forEach(visit);
    states.set(id, 2); order.push(id);
  };
  nodes.forEach((_node, id) => visit(id));
  const needed = new Set();
  const include = id => {
    if (!nodes.has(id)) throw new Error('选择的执行节点不存在');
    if (needed.has(id)) return;
    needed.add(id); incoming.get(id).forEach(include);
  };
  [...ids].forEach(include);
  return order.filter(id => needed.has(id) && nodes.get(id).type === 'generation');
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
  if (!input || typeof input !== 'object' || input.schema !== SCHEMA || !Array.isArray(input.nodes) || !Array.isArray(input.edges)) throw new Error('不是有效的 FrameWeave 画布文件');
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
      if (Object.hasOwn(node.data, 'packageFields')) data.packageFields = packageFields(node.data.packageFields);
      if (!Number.isSafeInteger(data.seed) || data.seed < 0) throw new Error('随机种子必须是 0 到 9007199254740991 之间的整数');
      if (Object.hasOwn(node.data, 'loras')) data.loras = loraStack(node.data.loras, data.kind);
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
    if (!edge || typeof edge.id !== 'string' || !edge.id || edge.id.length > 120 || edgeIds.has(edge.id)) throw new Error('连接 ID 无效或重复');
    const validation = canConnect(graph, edge.source, edge.target, edge);
    if (!validation.ok) throw new Error(`无效连接：${validation.reason}`);
    edgeIds.add(edge.id);
    graph.edges.push({ id: edge.id, source: edge.source, target: edge.target, ...edgeOptions(edge) });
  }
  return { ...graph, viewport: { x: finite(input.viewport?.x, 60), y: finite(input.viewport?.y, 60), scale: Math.min(3, Math.max(0.2, finite(input.viewport?.scale, 1))) } };
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
