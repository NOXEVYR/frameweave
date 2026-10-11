import { canConnect, generationInputPorts, sourceOutputType, parseGraph, serializeGraph, stableStringify, validateExecutionMediaBackends } from './graph.mjs';
import { cachedPackageField } from './canvas-port-layout.mjs';
import { parseJSONWithSafeNumbers } from './packages.mjs';
import { createWorkflowRunner, validateRunTargets } from './workflow-runner.mjs';
import { planExecution, projectExecution } from './execution-scope.mjs';
import { canvasChromeOffsets } from './canvas-layout.mjs';

const RUN_KEY = 'frameweave.workflow-run.v1';
const BUNDLE = 'prismcanvas.project.v1';
const LIMIT = 24 * 1024 * 1024;
export const MAX_CANVAS_ITEMS = 500000;

/** Match the local canvas store's bounded structure checks before export/save. */
export function validateCanvasStructure(document) {
  const pending = [[document, 0]], seen = new Set();
  let items = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (depth > 64) throw new Error('画布集合的 JSON 结构超过 64 层，请拆分画布后保存');
    if (++items > MAX_CANVAS_ITEMS) throw new Error(`画布集合超过 ${MAX_CANVAS_ITEMS} 个 JSON 数据项，请拆分画布后保存`);
    if (value && typeof value === 'object') {
      if (seen.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error('画布集合不是有效的 JSON 数据');
      }
      seen.add(value);
      for (const child of Array.isArray(value) ? value : Object.values(value)) pending.push([child, depth + 1]);
    } else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error('画布集合含有非 JSON 数据');
    } else if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('画布集合包含无效数字');
    }
  }
  return document;
}
const element = (tag, className = '', text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
const statusNames = { running: '运行中', stopping: '停止后续中', paused: '已暂停', completed: '全部完成', failed: '已停止：任务失败' };
const stepNames = { pending: '等待前序', preparing: '准备输入', submitting: '提交中', uncertain: '提交待确认', running: '执行中', completed: '完成', failed: '失败' };

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function packageDefinition(host, id) {
  if (!id || typeof host.ensurePackageDefinition !== 'function') throw new Error('工作流包完整定义尚未加载，请重新导入或刷新后重试');
  const full = await host.ensurePackageDefinition(id);
  if (!record(full) || full.summary === true || full.id !== id || typeof full.name !== 'string' || !Array.isArray(full.fields) || !record(full.prompt)) {
    throw new Error('工作流包详情不完整，摘要不能用于配置、连线或执行');
  }
  return full;
}

function matchesCachedField(field, cached) {
  return Boolean(cached && field.type === cached.type &&
    (cached.node_id === undefined || cached.node_id === field.node_id) &&
    (cached.input === undefined || cached.input === field.input));
}

function checkPlannedDefinition(node, scope, full) {
  const nodes = new Set(scope.node_ids), active = new Set(scope.active_field_ids);
  const fresh = new Map(full.fields.map(field => [field.id, field]));
  const cached = new Map((node.data.packageFields || []).map(field => [field.id, field]));
  if (fresh.size !== full.fields.length || scope.node_ids.some(id => !Object.hasOwn(full.prompt, id))) {
    throw new Error('执行计划与完整工作流定义不一致，未准备素材或提交生成');
  }
  for (const id of active) {
    const field = fresh.get(id), previous = cached.get(id);
    if (!field || !matchesCachedField(field, previous) || !nodes.has(field.node_id) ||
        !Object.hasOwn(full.prompt[field.node_id]?.inputs || {}, field.input)) {
      throw new Error('活动输入与完整工作流定义不一致，请重新检查接口；原画布映射已保留');
    }
  }
  if (full.fields.some(field => nodes.has(field.node_id) && !active.has(field.id))) {
    throw new Error('执行计划遗漏了活动工作流输入，未准备素材或提交生成');
  }
}

/** Full definitions are fetched only for the chosen connection target. */
export async function prepareCanvasConnection(host, targetId, fieldId = '') {
  const graph = host.graph(), target = graph.nodes.find(node => node.id === targetId && node.type === 'generation');
  if (!target) throw new Error('请选择一个生成节点作为目标');
  const identity = host.canvasIdentity(), before = serializeGraph(graph), backend = host.engine().backend_url;
  const assertCurrent = () => {
    if (host.canvasIdentity() !== identity || host.graph().nodes.find(node => node.id === targetId) !== target ||
        serializeGraph(host.graph()) !== before || host.engine().backend_url !== backend) {
      throw new Error('连接准备期间画布、节点、参数或推理引擎已变化，请重新选择；原连线已保留');
    }
  };
  const full = target.data.kind === 'package' ? await packageDefinition(host, target.data.package_id) : null;
  assertCurrent();
  if (full) {
    const cached = new Map((target.data.packageFields || []).map(field => [field.id, field]));
    if (cached.size !== (target.data.packageFields || []).length || full.fields.length !== cached.size ||
        new Set(full.fields.map(field => field.id)).size !== full.fields.length || full.fields.some(field => !matchesCachedField(field, cached.get(field.id)))) {
      throw new Error('完整工作流定义与画布输入映射不一致，请重新配置接口；原画布和连线已保留');
    }
  }
  const fields = (full?.fields || generationInputPorts(target)).filter(field =>
    ['text', 'image', 'video', 'audio'].includes(field.type) && (!fieldId || fieldId === field.id));
  if (!fields.length) throw new Error('这个工作流没有可连接的文本或媒体输入，请在工作流内开放所需参数');
  return { graph, target, fields, assertCurrent };
}

/** Plan and materialize one frozen canvas without submitting any generation. */
export async function prepareCanvasExecution(host, ids) {
  let source = structuredClone(host.graph());
  parseGraph(serializeGraph(source));
  const targets = ids?.length ? [...ids] : source.nodes.filter(node => node.type === 'generation').map(node => node.id);
  if (!targets.length) throw new Error('请先向画布添加工作流或生成节点');
  const identity = host.canvasIdentity(), before = serializeGraph(source), previousBackend = host.engine().backend_url;
  const assertCurrent = (expected = before, backend = null) => {
    if (host.canvasIdentity() !== identity || serializeGraph(host.graph()) !== expected) throw new Error('准备期间画布、连线或参数已变化，未提交生成，请重新运行');
    if (backend && host.engine().backend_url !== backend) throw new Error('准备期间推理引擎已变化，未提交生成，请重新运行');
  };
  if (host.prepareBackend) await host.prepareBackend(targets, {graph:source, rootOnly:true});
  assertCurrent();
  const backend = host.engine().backend_url;
  if (!host.engine().online || !backend) throw new Error('本地推理引擎未连接，请先连接并检查模型');
  const execution = await planExecution(source, targets, backend, async (...args) => {
    assertCurrent(before, backend);
    const result = await host.api(...args);
    assertCurrent(before, backend);
    return result;
  });
  assertCurrent(before, backend);
  // The backend plan decides active ancestry before any definition hydration.
  // Archived definitions remain reachable by ID; inactive islands are untouched.
  const definitions = new Map();
  for (const [nodeId, scope] of Object.entries(execution.packages)) {
    assertCurrent(before, backend);
    if (!definitions.has(scope.package_id)) definitions.set(scope.package_id, await packageDefinition(host, scope.package_id));
    assertCurrent(before, backend);
    checkPlannedDefinition(source.nodes.find(node => node.id === nodeId), scope, definitions.get(scope.package_id));
  }
  const projection = projectExecution(source, execution, targets);
  validateRunTargets(projection, targets);
  validateExecutionMediaBackends(projection, targets, previousBackend || backend, backend);
  if (host.prepareInputs) {
    source = await host.prepareInputs(targets, {graph:source, execution, projection, backend, canvasId:identity}) || source;
    assertCurrent(serializeGraph(source), backend);
    projectExecution(source, execution, targets);
  }
  return {graph:source, execution, targetIds:targets, backend, canvasId:identity};
}

export function configurationScope(graph, nodeId) {
  const target = graph.nodes.find(node => node.id === nodeId);
  if (!target) throw new Error('工作流节点已经移除，请重新选择');
  const ids = new Set([nodeId]);
  const edges = graph.edges.filter(edge => edge.target === nodeId && graph.nodes.some(node => node.id === edge.source && node.type === 'prompt'));
  edges.forEach(edge => ids.add(edge.source));
  return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges };
}

export function createWorkflowCanvas(host) {
  let runner, dialog, statePanel, runSelected, runAll, resume, stop, clear, lastRunSignature = '', operation = '', preparation = null;
  let toolbar, canvasElement, canvasShell, chromeObserver, chromeVisibilityObserver, chromeFrame = 0;
  function layoutChrome() {
    if (!canvasElement || !canvasElement.getClientRects().length) return;
    const rect = selector => {
      const item = canvasShell.querySelector(selector);
      return item && !item.hidden && item.getClientRects().length ? item.getBoundingClientRect() : null;
    };
    const offsets = canvasChromeOffsets(canvasElement.getBoundingClientRect(), { topline: rect('.canvas-topline'), banner: rect('.discovery-banner'), actions: rect('.canvas-action-bar') });
    for (const [name, value] of [['--canvas-action-top', offsets.actionTop], ['--workflow-toolbar-top', offsets.workflowTop]]) {
      const next = `${value}px`;
      if (canvasShell.style.getPropertyValue(name) !== next) canvasShell.style.setProperty(name, next);
    }
    const height = canvasElement.getBoundingClientRect().height;
    const detailsHeight = `${Math.max(0, Math.min(height / 2, height - offsets.workflowTop - toolbar.getBoundingClientRect().height - 80))}px`;
    if (canvasShell.style.getPropertyValue('--workflow-details-height') !== detailsHeight) canvasShell.style.setProperty('--workflow-details-height', detailsHeight);
  }
  function scheduleChrome() {
    if (chromeFrame) return;
    chromeFrame = requestAnimationFrame(() => { chromeFrame = 0; layoutChrome(); });
  }
  function destroyLayout() {
    chromeObserver?.disconnect(); chromeVisibilityObserver?.disconnect();
    if (chromeFrame) cancelAnimationFrame(chromeFrame);
    chromeFrame = 0;
  }
  const button = (text, id, fn, style = 'button quiet') => {
    const b = element('button', style, text); b.type = 'button'; b.id = id;
    b.addEventListener('click', event => { event.stopPropagation(); Promise.resolve().then(fn).catch(host.reportError); }); return b;
  };
  const inputLabel = (text, input) => { const label = element('label', 'field'); label.append(element('span', '', text), input); input.setAttribute('aria-label', text); return label; };
  const select = entries => { const input = element('select'); for (const [value, label] of entries) { const option = element('option', '', label); option.value = value; input.append(option); } return input; };
  const packageNode = id => host.graph().nodes.find(n => n.id === id && n.data.kind === 'package');
  const closeDialog = () => { dialog?.close(); dialog?.remove(); dialog = null; };

  async function connectNodes(sourceId = '', targetId = '', fieldId = '') {
    const { graph, target, fields, assertCurrent } = await prepareCanvasConnection(host, targetId, fieldId);
    closeDialog(); dialog = element('dialog', 'workflow-connect-dialog'); dialog.id = 'workflow-connection-dialog';
    const header = element('div', 'dialog-header'); header.append(element('h2', '', `连接到 ${target.data.title}`), button('关闭', 'workflow-connect-close', closeDialog)); dialog.append(header);
    const body = element('div', 'workflow-connect-body'); dialog.append(body);
    body.append(element('p', 'model-note', '连接默认替代该字段的表单值；启用文本拼接的字段按连接顺序合并，再追加自身文本。上游完成后，媒体会传入对应类型的输入。'));
    const sources = graph.nodes.filter(n => n.id !== target.id && (!sourceId || n.id === sourceId) && ['prompt', 'reference', 'generation', 'result'].includes(n.type));
    const source = select(sources.map(n => [n.id, n.data.title])); source.id = 'workflow-connect-source';
    const targetField = select([]); targetField.id = 'workflow-connect-field';
    const sourceField = select([['text', '正向提示词'], ['negative', '负向提示词']]); sourceField.id = 'workflow-connect-text';
    const textLabel = inputLabel('提示词内容', sourceField);
    const output = select(Array.from({ length: 32 }, (_, i) => [String(i), `第 ${i + 1} 张图片`])); output.id = 'workflow-connect-output'; const outputLabel = inputLabel('使用上游输出', output);
    const outputNode = select([]), outputNodeLabel = inputLabel('工作流输出接口', outputNode); outputNode.id = 'workflow-connect-output-node';
    const note = element('p', 'workflow-connect-note');
    const sync = () => {
      const from = graph.nodes.find(n => n.id === source.value), type = from?.type === 'prompt' ? 'text' : from?.type === 'reference' ? from.data.mediaType : null;
      const previous = targetField.value; targetField.replaceChildren();
      for (const f of fields.filter(f => f.type === type || !type && ['image','video','audio'].includes(f.type) && sourceOutputType(from, {}, f.type, graph) === f.type)) { const option = element('option', '', f.label); option.value = f.id; targetField.append(option); }
      if ([...targetField.options].some(o => o.value === previous)) targetField.value = previous;
      textLabel.hidden = type !== 'text'; outputLabel.hidden = !['generation', 'result'].includes(from?.type);
      const mediaName = {video:'个视频',audio:'段音频',image:'张图片'}[fields.find(field => field.id === targetField.value)?.type] || '个输出';
      [...output.options].forEach((option, index) => { option.textContent = `第 ${index + 1} ${mediaName}`; });
      outputNode.replaceChildren();
      const outputOwner = from?.type === 'result' ? graph.nodes.find(n => n.id === graph.edges.find(edge => edge.target === from.id)?.source) : from;
      for (const item of (outputOwner?.data.editor_output_fields || []).filter(item => (outputOwner.data.editor_outputs || []).includes(item.id) && sourceOutputType(from, {sourceOutput:item.id}, fields.find(f=>f.id===targetField.value)?.type, graph) === fields.find(f=>f.id===targetField.value)?.type)) {
        const option = element('option', '', `${item.label} · ${item.id}`); option.value = item.id; outputNode.append(option);
      }
      outputNodeLabel.hidden = !outputNode.options.length;
      note.textContent = targetField.options.length ? (target.data.packageTextCompositions?.[targetField.value] ? '此文本输入启用了拼接，可按顺序连接多个不同来源，自身文本最后加入。' : '此输入连接一个来源；文本可在侧栏启用多来源拼接。') : '没有已确认类型的匹配输出。请检查输出接口；未知类型需要先完成一次生成，再选择实际媒体。';
    };
    source.addEventListener('change', sync); targetField.addEventListener('change', sync); sync();
    body.append(inputLabel('来源节点', source), inputLabel('工作流输入', targetField), textLabel, outputNodeLabel, outputLabel, note);
    const actions = element('div', 'dialog-actions');
    actions.append(button('取消', 'workflow-connect-cancel', closeDialog), button('建立连接', 'workflow-connect-submit', () => {
      assertCurrent();
      const from = graph.nodes.find(n => n.id === source.value);
      if (host.graph().nodes.find(node => node.id === source.value) !== from) throw new Error('来源节点已变化，请重新建立连接');
      if (!from || !targetField.value) throw new Error('请选择可连接的来源与输入');
      const options = { targetField: targetField.value, sourceField: from.type === 'prompt' ? sourceField.value : fields.find(f=>f.id===targetField.value)?.type, ...(['generation', 'result'].includes(from.type) ? { outputIndex: Number(output.value), ...(outputNode.value ? { sourceOutput: outputNode.value } : {}) } : {}) };
      const valid = canConnect(host.graph(), source.value, targetId, options); if (!valid.ok) throw new Error(valid.reason);
      host.connect(source.value, targetId, options); closeDialog(); host.toast('已连接工作流输入');
    }, 'button primary'));
    dialog.append(actions); dialog.addEventListener('close', () => { const old = dialog; dialog = null; old?.remove(); }); document.body.append(dialog); dialog.showModal();
  }

  function describeInput(nodeId, field) {
    const graph = host.graph(), edges = graph.edges.filter(e => e.target === nodeId && e.targetField === field.id);
    if (!edges.length) return null;
    const descriptions = edges.map(edge => {
      const source = graph.nodes.find(n => n.id === edge.source);
      const repeated = source?.type === 'prompt' && Number.isSafeInteger(edge.sourceOccurrence) && edge.sourceOccurrence > 0 ? ` · 第${edge.sourceOccurrence + 1}次引用` : '';
      return `${source?.data.title || '来源已缺失'} · ${source?.type === 'prompt' ? edge.sourceField === 'negative' ? '负向提示词' : '正向提示词' : `${{video:'视频',audio:'音频',image:'图片'}[field.type] || '输出'} ${Number(edge.outputIndex || 0) + 1}`}${repeated}`;
    });
    return { edge: edges[0], edges, text: descriptions.join('；') };
  }

  function renderState(state) {
    if (!statePanel) return;
    const busy = runner?.isRunning() || !!operation;
    runSelected.disabled = busy; runAll.disabled = busy;
    document.querySelectorAll('[data-run-node]').forEach(b => { const node = host.graph().nodes.find(n => n.id === b.dataset.runNode); b.disabled = busy || node?.data.kind === 'package' && !node?.data.package_id; });
    const currentCanvas = host.canvasIdentity();
    const preparing = preparation?.canvasId === currentCanvas ? preparation : null;
    const otherCanvas = !!state && state.canvas_id !== currentCanvas;
    const signature = JSON.stringify([state?.id, state?.status, state?.error, state?.steps, busy, currentCanvas, preparing]);
    if (signature === lastRunSignature) return; lastRunSignature = signature;
    const detailsOpen = statePanel.open || false;
    statePanel.replaceChildren(); statePanel.hidden = !state && !preparing;
    statePanel.open = detailsOpen;
    const summary = element('summary', 'workflow-run-summary');
    const details = element('div', 'workflow-run-details');
    if (!state && !preparing) { scheduleChrome(); return; }
    if (preparing) {
      summary.append(element('span', '', preparing.error ? '工作流 · 未开始生成' : '工作流 · 正在准备'));
      details.append(element('p', preparing.error ? 'workflow-run-error' : 'model-note', preparing.error || '正在检查所选输出、活动上游和参考素材。'));
    }
    statePanel.append(summary, details);
    scheduleChrome();
    if (!state) return;
    const title = element('strong', '', `${otherCanvas ? '其他画布 · 上次运行' : '工作流'} · ${statusNames[state.status] || state.status}`);
    const completed = state.steps.filter(s => s.state === 'completed').length;
    if (!preparing) {
      summary.append(title, element('span', '', `${completed}/${state.steps.length} 步`));
    }
    summary.title = preparing ? '展开查看上次运行记录' : '展开运行步骤与恢复';
    details.append(element('strong', '', preparing ? '上次运行记录' : '运行步骤与恢复'));
    if (preparing) details.append(title, element('span', '', `${completed} / ${state.steps.length} 步`));
    if (state.error) details.append(element('p', 'workflow-run-error', state.error));
    if (otherCanvas) details.append(element('p', 'model-note', '这份运行记录属于另一张画布；查询会使用该记录的快照，不会运行当前画布。'));
    for (const step of state.steps) {
      const node = state.graph.nodes.find(n => n.id === step.node_id);
      details.append(element('p', '', `${node?.data.title || step.node_id} · ${stepNames[step.state] || step.state}${step.error ? ` · ${step.error}` : ''}`));
    }
    details.append(element('p', 'model-note', '运行使用开始时的画布快照。停止后续不会强制取消当前推理；刷新后点击“查询并继续”恢复。'));
    const actions = element('div', 'workflow-run-actions');
    resume = button('查询并继续', 'workflow-resume', resumeRun); resume.disabled = busy || state.status === 'completed';
    stop = button('停止后续', 'workflow-stop', () => runner.stop()); stop.disabled = !runner?.isRunning();
    clear = button('清除运行记录', 'workflow-clear', () => runner.clear()); clear.disabled = busy;
    actions.append(resume, stop, clear); details.append(actions);
  }

  async function run(ids) {
    if (!runner) throw new Error('运行记录无法读取，请保留原记录并修复后重试；画布编辑仍可使用');
    if (operation || runner.isRunning()) throw new Error('工作流正在运行或导入，请等待当前操作完成');
    operation = 'run'; preparation = {canvasId:host.canvasIdentity(), error:''}; renderState(runner.getState());
    try {
    const prepared = await prepareCanvasExecution(host, ids);
    preparation = null;
    return await runner.start(prepared);
    } catch (error) {
      if (preparation) {
        preparation = {...preparation, error:error.message};
        // Reveal the new failure once; later refreshes preserve manual collapse.
        if (statePanel && preparation.canvasId === host.canvasIdentity()) statePanel.open = true;
      }
      throw error;
    } finally { operation = ''; renderState(runner.getState()); }
  }
  async function resumeRun() {
    if (operation || runner.isRunning()) throw new Error('工作流正在运行或导入，请等待当前操作完成');
    operation = 'resume'; renderState(runner.getState());
    try { return await runner.resume(); } finally { operation = ''; renderState(runner.getState()); }
  }

  async function buildBundle(nodeId = null) {
    const identity = host.canvasIdentity(), before = serializeGraph(host.graph()), backend = host.engine().backend_url, title = host.title();
    const assertCurrent = () => {
      if (host.canvasIdentity() !== identity || serializeGraph(host.graph()) !== before || host.engine().backend_url !== backend || host.title() !== title) {
        throw new Error('导出期间画布或推理引擎已变化，请重新导出；未下载不一致的集合');
      }
    };
    const canvas = JSON.parse(serializeGraph(nodeId ? configurationScope(host.graph(), nodeId) : host.graph(), host.viewport()));
    const ids = [...new Set(canvas.nodes.filter(n => n.data.kind === 'package' && n.data.package_id).map(n => n.data.package_id))];
    const packages = [];
    for (const id of ids) { const result = await host.api(`/api/packages/${encodeURIComponent(id)}/export`, {}); assertCurrent(); if (!result.document) throw new Error('工作流包不完整，无法导出集合'); packages.push(result.source_json ? { id, source_json: result.source_json } : { id, document: result.document }); }
    const editors = [];
    for (const id of new Set(canvas.nodes.map(n => n.data.editor_id).filter(Boolean))) {
      const result = await host.api(`/api/editor-workflows/${id}`);
      assertCurrent();
      editors.push({ id, name: result.name, source_json: result.source_json, source_kind: result.source_kind || 'unknown' });
    }
    const document = { schema: BUNDLE, version: 1, name: title, canvas, packages, ...(editors.length ? { editors } : {}) };
    validateCanvasStructure(document);
    const serialized = stableStringify(document);
    if (new TextEncoder().encode(serialized).length > LIMIT) throw new Error('工作流画布集合最大为 24 MiB，请减少节点或拆分画布');
    return document;
  }
  async function exportBundle() {
    host.downloadJSON(stableStringify(await buildBundle()), 'prismcanvas-workflow-project.json');
    host.toast('已导出画布与对应工作流定义；不包含模型、素材或生成结果文件');
  }

  async function importBundle(file) {
    if (operation || runner?.isRunning()) throw new Error('请先停止后续调度或等待导入完成，再导入其他画布');
    operation = 'import'; if (runner) renderState(runner.getState());
    try {
    const identity = host.canvasIdentity(), openingGraph = host.graph(), before = serializeGraph(openingGraph, host.viewport?.()), backend = host.engine().backend_url, title = host.title?.();
    const assertCurrent = () => {
      if (host.canvasIdentity() !== identity || host.graph() !== openingGraph || serializeGraph(host.graph(), host.viewport?.()) !== before || host.engine().backend_url !== backend || host.title?.() !== title) {
        throw new Error('导入期间画布或推理引擎已变化，未替换原画布；已导入的定义仍保留在包库');
      }
    };
    if (file.size > LIMIT) throw new Error('工作流画布集合最大为 24 MiB');
    const source = await file.text();
    assertCurrent();
    if (typeof source !== 'string' || new TextEncoder().encode(source).length > LIMIT) throw new Error('工作流画布集合最大为 24 MiB');
    const document = parseJSONWithSafeNumbers(source.replace(/^\uFEFF/, ''));
    if (document?.schema !== BUNDLE || document.version !== 1 || !Array.isArray(document.packages) || document.packages.length > 200) throw new Error('不是有效的棱光工作流画布集合');
    validateCanvasStructure(document);
    const incoming = parseGraph(document.canvas);
    const needed = new Set(incoming.nodes.filter(n => n.data.kind === 'package' && n.data.package_id).map(n => n.data.package_id));
    const editorIds = new Set(incoming.nodes.map(n => n.data.editor_id).filter(Boolean));
    const editorDefinitions = new Map();
    if (document.editors !== undefined && (!Array.isArray(document.editors) || document.editors.length > 200)) throw new Error('集合中的原生工作流列表无效');
    for (const entry of document.editors || []) {
      if (!entry || !editorIds.has(entry.id) || editorDefinitions.has(entry.id) || typeof entry.source_json !== 'string' || !Array.isArray(parseJSONWithSafeNumbers(entry.source_json.replace(/^\uFEFF/, '')).nodes)) throw new Error('集合中的原生工作流缺失或重复');
      if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 120) throw new Error('原生工作流名称无效');
      if (entry.source_kind !== undefined && !['native', 'api', 'unknown'].includes(entry.source_kind)) throw new Error('工作流来源类型无效');
      await host.api('/api/editor-workflows/inspect', { source_json: entry.source_json });
      assertCurrent();
      editorDefinitions.set(entry.id, entry);
    }
    if ([...editorIds].some(id => !editorDefinitions.has(id))) throw new Error('集合缺少内部工作流原文；请在原设备重新导出完整集合');
    const definitions = new Map();
    for (const entry of document.packages) {
      if (!entry || typeof entry.id !== 'string' || !/^p-[a-f0-9]{24}$/.test(entry.id) || definitions.has(entry.id) || !needed.has(entry.id)) throw new Error('集合含有重复或未引用的工作流包');
      const payload = typeof entry.source_json === 'string' ? { source_json: entry.source_json } : { document: entry.document };
      if (entry.source_json !== undefined && typeof entry.source_json !== 'string') throw new Error('集合中的工作流原文无效');
      const checked = await host.api('/api/packages/inspect', payload);
      assertCurrent();
      if (!checked.prompt || !Array.isArray(checked.fields)) throw new Error('集合内的工作流定义无效');
      definitions.set(entry.id, typeof entry.source_json === 'string' ? payload : entry.document);
    }
    if ([...needed].some(id => !definitions.has(id))) throw new Error('集合缺少画布所引用的工作流定义，画布尚未更改');
    const remap = new Map();
    for (const [id, definition] of definitions) {
      const result = await host.api('/api/packages', definition);
      assertCurrent();
      if (!record(result.package) || result.package.summary === true || !/^p-[a-f0-9]{24}$/.test(result.package.id || '') ||
          !Array.isArray(result.package.fields) || !record(result.package.prompt)) {
        throw new Error('包导入未返回完整定义，当前画布尚未更改；已导入的包保留在包库');
      }
      if (typeof host.rememberPackageDefinition === 'function') await host.rememberPackageDefinition(result.package);
      assertCurrent();
      remap.set(id, result.package);
    }
    const editorRemap = new Map();
    for (const [id, entry] of editorDefinitions) { const result = await host.api('/api/editor-workflows', { name: entry.name, source_json: entry.source_json, source_kind: entry.source_kind || 'unknown' }); assertCurrent(); editorRemap.set(id, result.id); }
    for (const node of incoming.nodes) {
      if (node.data.editor_id) node.data.editor_id = editorRemap.get(node.data.editor_id);
    }
    for (const node of incoming.nodes.filter(n => n.data.kind === 'package' && n.data.package_id)) {
      const pack = remap.get(node.data.package_id); node.data.package_id = pack.id; node.data.packageFields = pack.fields.map(cachedPackageField);
    }
    // Revalidate bindings against the definitions accepted by the local service.
    const validated = parseGraph(serializeGraph(incoming, incoming.viewport));
    await host.loadPackages(); assertCurrent(); host.setGraph(validated, String(document.name || file.name).slice(0, 120)); host.toast('已导入工作流集合；没有启动生成，原画布可撤销恢复');
    } finally { operation = ''; if (runner) renderState(runner.getState()); }
  }

  function init() {
    if (statePanel) { scheduleChrome(); return; }
    canvasElement = document.querySelector('#canvas');
    canvasShell = canvasElement.closest('.canvas-shell');
    toolbar = element('div', 'workflow-canvas-toolbar'); toolbar.id = 'workflow-canvas-toolbar';
    const menu = element('details', 'workflow-canvas-menu'), summary = element('summary', '', '工作流集合'); menu.append(summary);
    const actions = element('div', 'workflow-menu-actions');
    const file = element('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true; file.id = 'workflow-bundle-input';
    file.addEventListener('change', () => { const selected = file.files?.[0]; file.value = ''; if (selected) importBundle(selected).catch(host.reportError); });
    actions.append(button('添加工作流', 'canvas-add-workflow', () => { menu.open = false; return host.openPackages(); }), button('导出工作流集合', 'workflow-export-bundle', exportBundle), button('导入工作流集合', 'workflow-import-bundle', () => file.click()), file); menu.append(actions);
    runSelected = button('运行所选及上游', 'workflow-run-selected', () => {
      const ids = host.selectedIds().filter(id => host.graph().nodes.find(n => n.id === id)?.type === 'generation');
      if (!ids.length) throw new Error('请先选择一个或多个工作流 / 生成节点'); return run(ids);
    });
    runAll = button('运行整个画布', 'workflow-run-all', () => run(), 'button primary');
    toolbar.append(menu, runSelected, runAll); canvasElement.append(toolbar);
    statePanel = element('details', 'workflow-run-panel'); statePanel.id = 'workflow-run-panel'; statePanel.hidden = true; toolbar.append(statePanel);
    for (const overlay of [toolbar, statePanel]) for (const type of ['pointerdown', 'wheel', 'dblclick', 'contextmenu', 'keydown']) overlay.addEventListener(type, event => event.stopPropagation());
    try {
      runner = createWorkflowRunner({ api: host.api, load: () => JSON.parse(localStorage.getItem(RUN_KEY) || 'null'), save: state => { if (state) localStorage.setItem(RUN_KEY, JSON.stringify(state)); else localStorage.removeItem(RUN_KEY); }, onChange: renderState, onJob: host.onJob });
      renderState(runner.getState());
    } catch (error) {
      runSelected.disabled = true; runAll.disabled = true;
      statePanel.hidden = false;
      const details = element('div', 'workflow-run-details');
      details.append(element('p', '', '原记录已保留，画布和独立生成页可继续使用。请导出记录后检查恢复。'), button('导出原运行记录', 'workflow-export-damaged-record', () => host.downloadJSON({ raw: localStorage.getItem(RUN_KEY), error: error.message }, 'prismcanvas-run-recovery.json')));
      statePanel.append(element('summary', 'workflow-run-summary', '工作流运行记录暂不可读取'), details);
      host.reportError(new Error(`工作流记录读取失败：${error.message}`));
    }
    const chrome = [...canvasShell.querySelectorAll('.canvas-topline,.canvas-action-bar,.discovery-banner')];
    if (typeof ResizeObserver !== 'undefined') {
      chromeObserver = new ResizeObserver(scheduleChrome);
      for (const item of [canvasElement, toolbar, ...chrome]) chromeObserver.observe(item);
    }
    if (typeof MutationObserver !== 'undefined') {
      chromeVisibilityObserver = new MutationObserver(scheduleChrome);
      for (const item of [canvasElement, canvasShell, ...chrome]) chromeVisibilityObserver.observe(item, { attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
      if (document.body) chromeVisibilityObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    }
    layoutChrome();
  }
  return { init, connectNodes, describeInput, run, buildBundle, exportBundle, importBundle, state: () => runner?.getState(), isRunning: () => runner?.isRunning() || !!operation, refresh: () => { if (runner) renderState(runner.getState()); scheduleChrome(); }, destroyLayout };
}
