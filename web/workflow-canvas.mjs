import { canConnect, parseGraph, serializeGraph, stableStringify } from './graph.mjs';
import { parseJSONWithSafeNumbers } from './packages.mjs';
import { createWorkflowRunner } from './workflow-runner.mjs';

const RUN_KEY = 'frameweave.workflow-run.v1';
const BUNDLE = 'prismcanvas.project.v1';
const LIMIT = 8 * 1024 * 1024;
const element = (tag, className = '', text) => { const item = document.createElement(tag); item.className = className; if (text !== undefined) item.textContent = text; return item; };
const statusNames = { running: '运行中', stopping: '停止后续中', paused: '已暂停', completed: '全部完成', failed: '已停止：任务失败' };
const stepNames = { pending: '等待前序', preparing: '准备输入', submitting: '提交中', uncertain: '提交待确认', running: '执行中', completed: '完成', failed: '失败' };

export function createWorkflowCanvas(host) {
  let runner, dialog, statePanel, runSelected, runAll, resume, stop, clear, lastRunSignature = '', operation = '';
  const button = (text, id, fn, style = 'button quiet') => {
    const b = element('button', style, text); b.type = 'button'; b.id = id;
    b.addEventListener('click', event => { event.stopPropagation(); Promise.resolve().then(fn).catch(host.reportError); }); return b;
  };
  const inputLabel = (text, input) => { const label = element('label', 'field'); label.append(element('span', '', text), input); input.setAttribute('aria-label', text); return label; };
  const select = entries => { const input = element('select'); for (const [value, label] of entries) { const option = element('option', '', label); option.value = value; input.append(option); } return input; };
  const packageNode = id => host.graph().nodes.find(n => n.id === id && n.data.kind === 'package');
  const closeDialog = () => { dialog?.close(); dialog?.remove(); dialog = null; };

  async function connectNodes(sourceId = '', targetId = '', fieldId = '') {
    await host.loadPackages();
    const graph = host.graph(), target = packageNode(targetId);
    if (!target) throw new Error('请选择一个工作流包节点作为目标');
    const pack = host.packages().find(p => p.id === target.data.package_id);
    if (!pack) throw new Error('请先导入这个节点对应的工作流包');
    const fields = (pack.fields || []).filter(f => ['text', 'image'].includes(f.type) && (!fieldId || fieldId === f.id));
    if (!fields.length) throw new Error('这个工作流没有可连接的文本或图片输入，请重新封装并开放所需参数');
    closeDialog(); dialog = element('dialog', 'workflow-connect-dialog'); dialog.id = 'workflow-connection-dialog';
    const header = element('div', 'dialog-header'); header.append(element('h2', '', `连接到 ${target.data.title}`), button('关闭', 'workflow-connect-close', closeDialog)); dialog.append(header);
    const body = element('div', 'workflow-connect-body'); dialog.append(body);
    body.append(element('p', 'model-note', '连接会替代该字段的表单值。生成结果会在上游成功后自动上传为下游参考图。'));
    const sources = graph.nodes.filter(n => n.id !== target.id && (!sourceId || n.id === sourceId) && ['prompt', 'reference', 'generation', 'result'].includes(n.type));
    const source = select(sources.map(n => [n.id, n.data.title])); source.id = 'workflow-connect-source';
    const targetField = select([]); targetField.id = 'workflow-connect-field';
    const sourceField = select([['text', '正向提示词'], ['negative', '负向提示词']]); sourceField.id = 'workflow-connect-text';
    const textLabel = inputLabel('提示词内容', sourceField);
    const output = select(Array.from({ length: 32 }, (_, i) => [String(i), `第 ${i + 1} 张图片`])); output.id = 'workflow-connect-output'; const outputLabel = inputLabel('使用上游输出', output);
    const note = element('p', 'workflow-connect-note');
    const sync = () => {
      const from = graph.nodes.find(n => n.id === source.value), type = from?.type === 'prompt' ? 'text' : 'image';
      const previous = targetField.value; targetField.replaceChildren();
      for (const f of fields.filter(f => f.type === type)) { const option = element('option', '', f.label); option.value = f.id; targetField.append(option); }
      if ([...targetField.options].some(o => o.value === previous)) targetField.value = previous;
      textLabel.hidden = type !== 'text'; outputLabel.hidden = !['generation', 'result'].includes(from?.type);
      note.textContent = targetField.options.length ? '每个输入连接一个来源；同一个来源可以连接多个输入。' : '来源类型与输入不匹配，请更换来源或开放对应参数。';
    };
    source.addEventListener('change', sync); sync();
    body.append(inputLabel('来源节点', source), inputLabel('工作流输入', targetField), textLabel, outputLabel, note);
    const actions = element('div', 'dialog-actions');
    actions.append(button('取消', 'workflow-connect-cancel', closeDialog), button('建立连接', 'workflow-connect-submit', () => {
      const from = graph.nodes.find(n => n.id === source.value);
      if (!from || !targetField.value) throw new Error('请选择可连接的来源与输入');
      const options = { targetField: targetField.value, sourceField: from.type === 'prompt' ? sourceField.value : 'image', ...(['generation', 'result'].includes(from.type) ? { outputIndex: Number(output.value) } : {}) };
      const valid = canConnect(host.graph(), source.value, targetId, options); if (!valid.ok) throw new Error(valid.reason);
      host.connect(source.value, targetId, options); closeDialog(); host.toast('已连接工作流输入');
    }, 'button primary'));
    dialog.append(actions); dialog.addEventListener('close', () => { const old = dialog; dialog = null; old?.remove(); }); document.body.append(dialog); dialog.showModal();
  }

  function describeInput(nodeId, field) {
    const graph = host.graph(), edge = graph.edges.find(e => e.target === nodeId && e.targetField === field.id);
    if (!edge) return null;
    const source = graph.nodes.find(n => n.id === edge.source);
    return { edge, text: `${source?.data.title || '来源已缺失'} · ${source?.type === 'prompt' ? edge.sourceField === 'negative' ? '负向提示词' : '正向提示词' : `图片 ${Number(edge.outputIndex || 0) + 1}`}` };
  }

  function renderState(state) {
    if (!statePanel) return;
    const busy = runner?.isRunning() || !!operation;
    runSelected.disabled = busy; runAll.disabled = busy;
    document.querySelectorAll('[data-run-node]').forEach(b => { b.disabled = busy; });
    const signature = JSON.stringify([state?.id, state?.status, state?.error, state?.steps, busy]);
    if (signature === lastRunSignature) return; lastRunSignature = signature;
    const detailsOpen = statePanel.querySelector('details')?.open || false;
    statePanel.replaceChildren(); statePanel.hidden = !state;
    if (!state) return;
    const title = element('strong', '', `工作流 · ${statusNames[state.status] || state.status}`);
    const completed = state.steps.filter(s => s.state === 'completed').length;
    statePanel.append(title, element('span', '', `${completed} / ${state.steps.length} 步`));
    if (state.error) statePanel.append(element('p', 'workflow-run-error', state.error));
    const details = element('details'), summary = element('summary', '', '运行步骤与恢复'); details.open = detailsOpen; details.append(summary);
    for (const step of state.steps) {
      const node = state.graph.nodes.find(n => n.id === step.node_id);
      details.append(element('p', '', `${node?.data.title || step.node_id} · ${stepNames[step.state] || step.state}${step.error ? ` · ${step.error}` : ''}`));
    }
    details.append(element('p', 'model-note', '运行使用开始时的画布快照。停止后续不会强制取消当前推理；刷新后点击“查询并继续”恢复。'));
    const actions = element('div', 'workflow-run-actions');
    resume = button('查询并继续', 'workflow-resume', resumeRun); resume.disabled = busy || state.status === 'completed';
    stop = button('停止后续', 'workflow-stop', () => runner.stop()); stop.disabled = !runner?.isRunning();
    clear = button('清除运行记录', 'workflow-clear', () => runner.clear()); clear.disabled = busy;
    actions.append(resume, stop, clear); details.append(actions); statePanel.append(details);
  }

  async function run(ids) {
    if (!runner) throw new Error('运行记录无法读取，请保留原记录并修复后重试；画布编辑仍可使用');
    if (operation || runner.isRunning()) throw new Error('工作流正在运行或导入，请等待当前操作完成');
    operation = 'run'; renderState(runner.getState());
    try {
    await host.loadPackages();
    if (!host.engine().online) throw new Error('本地推理引擎未连接，请先连接并检查模型');
    const targets = ids?.length ? ids : host.graph().nodes.filter(n => n.type === 'generation').map(n => n.id);
    if (!targets.length) throw new Error('请先向画布添加工作流或生成节点');
    return await runner.start({ graph: host.graph(), targetIds: targets, backend: host.engine().backend_url, canvasId: host.canvasIdentity() });
    } finally { operation = ''; renderState(runner.getState()); }
  }
  async function resumeRun() {
    if (operation || runner.isRunning()) throw new Error('工作流正在运行或导入，请等待当前操作完成');
    operation = 'resume'; renderState(runner.getState());
    try { return await runner.resume(); } finally { operation = ''; renderState(runner.getState()); }
  }

  async function exportBundle() {
    await host.loadPackages();
    const canvas = JSON.parse(serializeGraph(host.graph(), host.viewport()));
    const ids = [...new Set(canvas.nodes.filter(n => n.data.kind === 'package').map(n => n.data.package_id))];
    const packages = [];
    for (const id of ids) { const result = await host.api(`/api/packages/${encodeURIComponent(id)}/export`, {}); if (!result.document) throw new Error('工作流包不完整，无法导出集合'); packages.push(result.source_json ? { id, source_json: result.source_json } : { id, document: result.document }); }
    const document = { schema: BUNDLE, version: 1, name: host.title(), canvas, packages };
    const serialized = stableStringify(document);
    if (new TextEncoder().encode(serialized).length > LIMIT) throw new Error('工作流画布集合最大为 8 MiB，请减少节点或拆分画布');
    host.downloadJSON(serialized, 'prismcanvas-workflow-project.json');
    host.toast('已导出画布与对应工作流定义；不包含模型、素材或生成结果文件');
  }

  async function importBundle(file) {
    if (operation || runner?.isRunning()) throw new Error('请先停止后续调度或等待导入完成，再导入其他画布');
    operation = 'import'; if (runner) renderState(runner.getState());
    try {
    if (file.size > LIMIT) throw new Error('工作流画布集合最大为 8 MiB');
    const document = parseJSONWithSafeNumbers(await file.text());
    if (document?.schema !== BUNDLE || document.version !== 1 || !Array.isArray(document.packages) || document.packages.length > 200) throw new Error('不是有效的棱光工作流画布集合');
    const incoming = parseGraph(document.canvas);
    const needed = new Set(incoming.nodes.filter(n => n.data.kind === 'package').map(n => n.data.package_id));
    const definitions = new Map();
    for (const entry of document.packages) {
      if (!entry || typeof entry.id !== 'string' || !/^p-[a-f0-9]{24}$/.test(entry.id) || definitions.has(entry.id) || !needed.has(entry.id)) throw new Error('集合含有重复或未引用的工作流包');
      const payload = typeof entry.source_json === 'string' ? { source_json: entry.source_json } : { document: entry.document };
      if (entry.source_json !== undefined && typeof entry.source_json !== 'string') throw new Error('集合中的工作流原文无效');
      const checked = await host.api('/api/packages/inspect', payload);
      if (!checked.prompt || !Array.isArray(checked.fields)) throw new Error('集合内的工作流定义无效');
      definitions.set(entry.id, typeof entry.source_json === 'string' ? payload : entry.document);
    }
    if ([...needed].some(id => !definitions.has(id))) throw new Error('集合缺少画布所引用的工作流定义，画布尚未更改');
    const remap = new Map();
    for (const [id, definition] of definitions) { const result = await host.api('/api/packages', definition); if (!result.package?.id) throw new Error('包导入未完成，当前画布尚未更改；已导入的包保留在包库'); remap.set(id, result.package); }
    for (const node of incoming.nodes.filter(n => n.data.kind === 'package')) {
      const pack = remap.get(node.data.package_id); node.data.package_id = pack.id; node.data.packageFields = pack.fields.map(({ id, label, type }) => ({ id, label, type }));
    }
    // Revalidate bindings against the definitions accepted by the local service.
    const validated = parseGraph(serializeGraph(incoming, incoming.viewport));
    await host.loadPackages(); host.setGraph(validated, String(document.name || file.name).slice(0, 120)); host.toast('已导入工作流集合；没有启动生成，原画布可撤销恢复');
    } finally { operation = ''; if (runner) renderState(runner.getState()); }
  }

  function init() {
    const toolbar = element('div', 'workflow-canvas-toolbar'); toolbar.id = 'workflow-canvas-toolbar';
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
    toolbar.append(menu, runSelected, runAll); document.querySelector('#canvas').append(toolbar);
    statePanel = element('div', 'workflow-run-panel'); statePanel.id = 'workflow-run-panel'; statePanel.hidden = true; document.querySelector('#canvas').append(statePanel);
    for (const overlay of [toolbar, statePanel]) for (const type of ['pointerdown', 'wheel', 'dblclick', 'contextmenu', 'keydown']) overlay.addEventListener(type, event => event.stopPropagation());
    try {
      runner = createWorkflowRunner({ api: host.api, load: () => JSON.parse(localStorage.getItem(RUN_KEY) || 'null'), save: state => { if (state) localStorage.setItem(RUN_KEY, JSON.stringify(state)); else localStorage.removeItem(RUN_KEY); }, onChange: renderState, onJob: host.onJob });
      renderState(runner.getState());
    } catch (error) {
      runSelected.disabled = true; runAll.disabled = true;
      statePanel.hidden = false; statePanel.append(element('strong', '', '工作流运行记录暂不可读取'), element('p', '', '原记录已保留，画布和独立生成页可继续使用。请导出记录后检查恢复。'), button('导出原运行记录', 'workflow-export-damaged-record', () => host.downloadJSON({ raw: localStorage.getItem(RUN_KEY), error: error.message }, 'prismcanvas-run-recovery.json')));
      host.reportError(new Error(`工作流记录读取失败：${error.message}`));
    }
  }
  return { init, connectNodes, describeInput, run, exportBundle, importBundle, state: () => runner?.getState(), isRunning: () => runner?.isRunning() || !!operation, refresh: () => { if (runner) renderState(runner.getState()); } };
}
