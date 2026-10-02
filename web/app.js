import { liveProgressText, elapsedText, previewStatusText, updateLiveProgress } from './job-progress.mjs';
import { isJobActive, isJobTerminal, jobStatusLabel, jobStateDetail, canCancelJob, canRefreshJob, canSwitchJobBackend, cancelActionLabel } from './job-state.mjs';
import { createUpdateCenter } from './update-center.mjs';
document.title = `棱光 PrismCanvas · 工作区 ${location.port}`;
import { createEngineCenter } from './engine-center.mjs';
import { createHubCenter } from './hub-center.mjs';
import { selectedHubRequest } from './hub-selection.mjs';
import { createNode, createDemo, connect, removeNodes, removeEdges, generationPayload, generationInputPorts, edgeInputField, canConnect, recipeGraph, serializeGraph, parseGraph, stableStringify, progressPercent } from './graph.mjs';
import { PACKAGE_LIMIT, defaultValues, fieldType, coerceFieldValue, selectFieldState, validateValues, parseJSONWithSafeNumbers, parsePackageDocument, apiPromptFromDocument, redactLocalText, publicChecksReport } from './packages.mjs';
import { filterJobs, filterPackages } from './library.mjs';
import { placeFragment, canvasContentArea } from './canvas-layout.mjs';
import { selectionBounds, copySelection, pasteSelection, moveSelection, arrangeSelection, clampMenuPosition } from './canvas-actions.mjs';
import { createGenerationStudio } from './generation-studio.mjs';
import { createWorkspaceTools } from './workspace-tools.mjs';
import { createWorkflowCanvas, validateCanvasStructure } from './workflow-canvas.mjs';
import { createNativeWorkflowEditor, editorDocument, EDITOR_LIMIT } from './native-workflow-editor.mjs';
import { autoEditorInterfaceSelection, chooseEditorInterface, resolveEditorConflicts, initialEditorFieldIds } from './editor-interface-panel.mjs';
import { cachedPackageField, visibleInputPorts, inputPortCandidates, outputChoices, portExpansionPositions, CANVAS_PORT_PAGE_SIZE } from './canvas-port-layout.mjs';
import { createContentLayout } from './canvas-content-layout.mjs';
import { editorConnectionSummary, applyEditorInterfaceGraph } from './editor-canvas-interface.mjs';
import { chooseWorkflowBackend, workflowBackendTarget, workflowRootBackendTarget } from './editor-backend-picker.mjs';
import { createWorkflowConfigurations } from './workflow-configurations.mjs';
import { validateMediaFile, mediaFileContentType, importPosition, prepareLocalImages, assertReferenceImportsReady, upstreamNodeIds } from './canvas-images.mjs';
import { createMediaTransfers } from './media-transfers.mjs';
import { readWorkflowFile } from './workflow-file.mjs';
import { choosePngWorkflow } from './workflow-file-dialog.mjs';
import { packageNodePresentation } from './package-node-presentation.mjs';
import { repairInterfaceInputs, chooseMissingInputValues } from './interface-repair.mjs';
import { mergeDiagnosticChecks } from './diagnostics-view.mjs';
import { createCanvasInspection, captureRequestInspection, inspectWithDiscovery } from './canvas-inspection.mjs';
import { editorPreparationBackend, captureEditorPreparationTarget, assertEditorPreparationTarget, projectEditorInputs } from './editor-preparation.mjs';
import { stageEditorMediaSync } from './editor-media-sync.mjs';
import { createNodeActionPress } from './node-action-press.mjs';
import { interfacePage, interfaceSearch } from './interface-pagination.mjs';
import { INTERFACE_PAGE_SIZE } from './interface-limits.mjs';
import { createPackageCatalog } from './package-catalog.mjs';
import { collectPresetEditRequest } from './preset-edit-request.mjs';
import { preparePresetEditGraph } from './preset-edit-graph.mjs';
import { openResultReferenceDialog } from './result-reference-dialog.mjs';
import { prepareResultEdit } from './result-edit.mjs';

const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'frameweave.canvas.v1';
const PORT_VIEW_STORAGE_KEY = 'frameweave.canvas.ports.v1';
const TITLE_STORAGE_KEY = 'frameweave.canvas.title.v1';
const JOB_MAP_KEY = 'frameweave.jobs.v1';
const RETRY_REQUESTS_KEY = 'frameweave.retry-requests.v1';
const CANVAS_ID_KEY = 'frameweave.canvas.identity.v1';
let canvasIdentity = '';
const KIND_NAMES = { h3_t2v: 'H3 · 文生视频', h3_i2v: 'H3 · 首尾帧视频', h3_ref: 'H3 · 参考生成视频', sdxl: 'SDXL · 文生图', sdxl_i2i: 'SDXL · 图生图', krea: 'Krea 2 · 图片生成', qwen21_t2i: 'Qwen Image 2.1 · 文生图', qwen21_edit: 'Qwen Image 2.1 · 多图编辑', api: 'ComfyUI · API 工作流', package: '工作流包 · 填写即生成' };
const STATUS_NAMES = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const canvas = $('#canvas');
const world = $('#world');
const nodesLayer = $('#nodes');
const edgesLayer = $('#connections');
let graph = createDemo();
let viewport = { x: 60, y: 110, scale: 1 };
let selected = new Set([graph.nodes[1].id]);
let selectedEdge = null;
let history = [];
let future = [];
let csrf = '';
const nativeSyncTargets = new WeakMap();
const nativeSessionContexts = new WeakMap();
const editorMediaSyncs = new WeakMap();
const nodeActionPress = createNodeActionPress({ isCurrent: node => !!node && getNode(node.id) === node });
const nativeEditor = createNativeWorkflowEditor({ api, toast, downloadJSON, copyText,
  ensureBackend: ensureWorkflowBackend,
  prepareSession: prepareNativeEditorSession,
  endSession: endNativeEditorSession,
  reopen: node => openNodeWorkflow(getNode(node.id)),
  async ensureInstance(node) {
    const context = nativeSessionContexts.get(node);
    context?.assertCurrent();
    if (graph.nodes.filter(other => other.data.editor_id === node.data.editor_id).length < 2) return;
    const original = await api(`/api/editor-workflows/${node.data.editor_id}`);
    context?.assertCurrent();
    const copied = await api('/api/editor-workflows', { name: original.name, source_json: original.source_json });
    context?.assertCurrent();
    mutate(() => { node.data.editor_id = copied.id; });
    context?.rebaseTarget();
  },
  fields: node => {
    const context = nativeSessionContexts.get(node);
    context?.assertCurrent();
    const fields = context?.fields || packageCatalog.peek(node.data.package_id)?.fields || node.data.packageFields || [];
    const byId = new Map(fields.map(field => [field.id, field]));
    for (const item of node.data.editor_hidden_updates || []) if (!byId.has(item.field.id)) byId.set(item.field.id, item.field);
    return [...byId.values()];
  },
  syncOuterValues(node, updates) {
    const context = nativeSessionContexts.get(node);
    context?.assertCurrent();
    const guard = nativeSyncTargets.get(node) || captureNativeInterfaceTarget(node);
    assertNativeInterfaceTarget(guard);
    mutate(() => {
      for (const target of new Set([node, guard.node])) {
        const hiddenIds = new Set((target.data.editor_hidden_updates || []).map(item => item.field.id));
        target.data.packageValues = { ...target.data.packageValues, ...Object.fromEntries(Object.entries(updates).filter(([id]) => !hiddenIds.has(id))) };
        if (hiddenIds.size) target.data.editor_hidden_updates = target.data.editor_hidden_updates.map(item =>
          Object.hasOwn(updates, item.field.id) ? { ...item, value: updates[item.field.id] } : item);
        // An internal filename selection is not an upload receipt. It must not
        // inherit the previous external file's backend or local thumbnail.
        for (const id of Object.keys(updates)) if (target.data.packageMediaBackends?.[id]) delete target.data.packageMediaBackends[id];
      }
    });
    context?.rebaseTarget();
  },
  resolveConflicts: resolveEditorConflicts,
  applyInterface: configureNativeInterface,
  releaseSession(session_id) { fetch('/api/editor-sessions/close', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FW-Token': csrf }, body: JSON.stringify({ session_id }), keepalive: true }).catch(() => {}); },
  async applied(node, result) {
    if (result._canvas_guard) assertNativeInterfaceTarget(result._canvas_guard);
    let source = graph;
    if (node.data.kind !== 'package') {
      source = clone(graph);
      for(const edge of source.edges.filter(e=>e.target===node.id)) edge.targetField=edgeInputField(graph,edge);
      source.nodes.find(n=>n.id===node.id).data.kind='package';
    }
    const updated = applyEditorInterfaceGraph(source, node.id, result);
    rememberPackageDefinition(result.package);
    mutate(() => {
      graph = updated;
    });
  }
});

/** Fixed direct-input witnesses survive source loading and the whole editor session. */
function beginNativeEditorContext(node) {
  if (editorMediaSyncs.has(node)) throw new Error('参考素材正在同步，请完成后再进入工作流');
  const previous = nativeSessionContexts.get(node);
  if (previous) { previous.assertCurrent(); return previous; }
  const target = getNode(node.id);
  if (!target) throw new Error('工作流节点已不存在，未准备内部编辑器');
  const context = { target, aliases: new Set([node, target]), fields: null, package: null,
    sourceRevision: target.data.package_id || target.data.editor_id || null, baselineBackend: null };
  const live = () => ({ canvasId: currentCanvasIdentity(), backend: settings.backend_url,
    sourceRevision: context.sourceRevision, referenceImports, mediaTransfers: packageMediaTransfers });
  context.guard = captureEditorPreparationTarget(graph, target.id, live());
  context.assertCurrent = () => assertEditorPreparationTarget(context.guard, graph, live());
  context.rebaseTarget = () => {
    const fresh = captureEditorPreparationTarget(graph, target.id, live());
    assertEditorPreparationTarget({ ...context.guard, signature: fresh.signature }, graph, live());
    context.guard = { ...context.guard, signature: fresh.signature };
  };
  context.acceptBackend = expected => {
    if (settings.backend_url !== expected) throw new Error('选择期间推理引擎已变化，请重新进入工作流');
    const fresh = captureEditorPreparationTarget(graph, target.id, live());
    if (context.baselineBackend && fresh.backend !== context.baselineBackend) throw new Error('首次转换的基准属于原推理引擎；后端已变化，请重新进入以重新准备完整来源');
    assertEditorPreparationTarget({ ...context.guard, backend: fresh.backend }, graph, live());
    context.guard = { ...context.guard, backend: fresh.backend };
  };
  for (const alias of context.aliases) nativeSessionContexts.set(alias, context);
  return context;
}
function aliasNativeEditorContext(context, node) {
  context.aliases.add(node); nativeSessionContexts.set(node, context);
}
function endNativeEditorSession(node) {
  const context = nativeSessionContexts.get(node);
  if (!context) return;
  for (const alias of context.aliases) if (nativeSessionContexts.get(alias) === context) nativeSessionContexts.delete(alias);
}
async function loadNativeEditorFields(context) {
  context.assertCurrent();
  if (context.fields) return;
  if (!context.target.data.package_id) { context.fields = []; return; }
  const pack = await ensurePackageDefinition(context.target.data.package_id);
  context.assertCurrent();
  if (pack.id !== context.target.data.package_id || !Array.isArray(pack.fields)) throw new Error('完整工作流包定义已变化，请重新进入');
  context.package = pack; context.fields = clone(pack.fields);
}
function nativeEditorProjection(context, node, ownOnly = false) {
  const target = context.target;
  const base = context.sessionGraph || graph;
  const source = { nodes: base.nodes, edges: ownOnly ? base.edges.filter(edge => edge.target !== target.id) : base.edges };
  return projectEditorInputs(source, target.id, { fields: context.fields || [], backend: settings.backend_url,
    canvasId: currentCanvasIdentity(), referenceImports, mediaTransfers: packageMediaTransfers });
}
async function prepareNativeEditorSession(node, workflow) {
  const context = nativeSessionContexts.get(node) || beginNativeEditorContext(node);
  context.assertCurrent();
  await loadNativeEditorFields(context); context.assertCurrent();
  const projection = nativeEditorProjection(context, node);
  let provenance = [], ownMedia = [], pending = projection.pending;
  const document = context.baselineDocument || (node.data.kind === 'api' ? { prompt: node.data.apiPrompt } : null);
  if (context.package || document) {
    const request = { backend_url: settings.backend_url, overrides: projection.overrides, pending: projection.pending,
      ...(context.package ? { package_id: context.package.id } : { document, fields: context.fields || [] }) };
    const prepared = await api('/api/editor-prepare', request); context.assertCurrent();
    if (prepared.backend_url !== settings.backend_url || context.package && prepared.source_revision !== context.package.id) throw new Error('编辑准备结果的来源或后端已变化');
    const byId = new Map((context.fields || []).map(field => [field.id, field]));
    for (const item of context.target.data.editor_hidden_updates || []) if (!byId.has(item.field.id)) byId.set(item.field.id, item.field);
    const enrich = (result, items) => items.map(item => {
      const field = byId.get(item.field_id), definition = result.prompt?.[item.node_id];
      if (!field || field.node_id !== item.node_id || field.input !== item.input || !definition?.class_type) throw new Error('连线投影缺少完整且匹配的字段证明');
      if (!Object.is(definition.inputs?.[item.input], item.value)) throw new Error('编辑准备响应与实际执行输入不一致');
      return { ...item, class_type: definition.class_type, type: field.type, label: field.label || field.id };
    });
    provenance = enrich(prepared, (prepared.overrides || []).filter(item => item.origin === 'connected'));
    // A connected C hides its own fallback F in the effective projection.
    // Prove F independently before syncing it into the native baseline N.
    const ownProjection = nativeEditorProjection(context, node, true);
    const mediaIds = new Set([...byId.values()].filter(field => ['image', 'video', 'audio'].includes(field.type)).map(field => field.id));
    const ownOverrides = ownProjection.overrides.filter(item => mediaIds.has(item.field_id));
    if (ownOverrides.length) {
      const ownPrepared = await api('/api/editor-prepare', { ...request, overrides: ownOverrides,
        pending: ownProjection.pending.filter(item => mediaIds.has(item.field_id)) });
      context.assertCurrent();
      if (ownPrepared.backend_url !== settings.backend_url || context.package && ownPrepared.source_revision !== context.package.id) throw new Error('素材准备结果的来源或后端已变化');
      ownMedia = enrich(ownPrepared, (ownPrepared.overrides || []).filter(item => mediaIds.has(item.field_id) && item.origin === 'own'));
    }
    pending = prepared.pending || pending;
  } else if (context.target.data.editor_id) {
    pending = [...pending, { reason: 'source_unavailable', message: '这套原生工作流尚未绑定可验证的外部字段来源；请在内部选择参数并管理外部接口，当前连线未投影到内部。' }];
  }
  context.provenance = provenance; context.pending = pending;
  return { assertCurrent: context.assertCurrent, provenance: clone(provenance), ownMedia: clone(ownMedia), pending: clone(pending) };
}

function editorMediaSyncButton(node) {
  const control = button(editorMediaSyncs.has(node) ? '正在同步参考素材…' : '同步参考素材到引擎', 'button quiet sync-editor-media', () => syncEditorMedia(node));
  control.disabled = editorMediaSyncs.has(node); control.dataset.syncMediaNode = node.id;
  control.title = '仅同步此工作流直接连接的图片、视频和音频，之后可进入内部查看；不开始生成';
  return control;
}
async function syncEditorMedia(node) {
  if (editorMediaSyncs.has(node)) return editorMediaSyncs.get(node);
  if (nativeSessionContexts.has(node)) throw new Error('请先返回画布，再同步参考素材并重新进入工作流');
  const backend = editorPreparationBackend(graph, node.id, settings.backend_url);
  if (backend !== settings.backend_url) throw new Error('请先连接此工作流绑定的推理引擎，再同步参考素材');
  const live = () => ({ canvasId: currentCanvasIdentity(), backend: settings.backend_url,
    sourceRevision: node.data.package_id || node.data.editor_id || null, referenceImports, mediaTransfers: packageMediaTransfers });
  const guard = captureEditorPreparationTarget(graph, node.id, live());
  const check = () => {
    if (nativeSessionContexts.has(node)) throw new Error('内部工作流已打开，未应用迟到的素材同步；请返回画布后重试');
    return assertEditorPreparationTarget(guard, graph, live());
  };
  const showProgress = (done, total) => {
    for (const control of document.querySelectorAll('[data-sync-media-node]')) if (control.dataset.syncMediaNode === node.id) {
      control.disabled = true; control.textContent = total ? `正在同步参考素材 ${done}/${total}…` : '正在检查参考素材…';
    }
  };
  const task = (async () => {
    showProgress(0, 0);
    const pack = node.data.package_id ? await ensurePackageDefinition(node.data.package_id) : null;
    check();
    const result = await stageEditorMediaSync(graph, node.id, { ...live(), fields: pack?.fields || [] }, api, check, showProgress);
    const status = await api('/api/status'); check();
    if (status.backend_url !== backend) throw new Error('同步期间引擎已切换，未改写画布；请重新连接后同步');
    if (result.updates.length) mutate(() => {
      for (const update of result.updates) {
        const source = getNode(update.id);
        source.data.name = update.name; source.data.uploadBackend = update.uploadBackend;
      }
    });
    const reasons = { upstream_not_run: '上游尚未生成', mapping_unavailable: '尚未建立对应媒体接口',
      ambiguous_connection: '同一端口存在多条连接', import_pending: '素材正在导入', import_failed: '素材导入失败',
      media_type_mismatch: '素材类型与端口不一致', local_only: '本地素材不可用', other_backend: '缺少可重新同步的本地素材',
      owner_unknown: '缺少可重新同步的本地素材', media_missing: '尚未选择素材' };
    const pending = [...new Set(result.pending.map(item => reasons[item.reason] || '请检查素材和端口映射'))];
    toast(`${result.updates.length ? `已同步 ${result.updates.length} 份参考素材，可进入工作流查看` : '没有需要同步的直接本地素材'}${pending.length ? `；待处理：${pending.join('、')}` : ''}。尚未开始生成`, !!pending.length);
  })();
  editorMediaSyncs.set(node, task);
  try { return await task; }
  finally {
    editorMediaSyncs.delete(node); renderNodes(); renderInspector();
    // Cached node cards can survive a redraw with unchanged content. Settle
    // transient button state explicitly rather than leaving the old busy DOM.
    for (const control of document.querySelectorAll('[data-sync-media-node]')) {
      if (control.dataset.syncMediaNode === node.id && !editorMediaSyncs.has(getNode(node.id))) {
        control.disabled = false; control.textContent = '同步参考素材到引擎';
      }
    }
  }
}

function captureNativeInterfaceTarget(node) {
  const target = getNode(node.id);
  if (!target) throw new Error('工作流节点已不存在；未应用外部接口');
  return { identity: currentCanvasIdentity(), node: target, signature: stableStringify(target.data),
    edges: stableStringify(graph.edges), sources: [...new Set(graph.edges.filter(edge => edge.target === target.id).map(edge => edge.source))].map(id => {
      const source = getNode(id); return { id, node: source, signature: stableStringify(source ? { type: source.type, data: source.data } : null) };
    }) };
}
function assertNativeInterfaceTarget(guard) {
  nativeSessionContexts.get(guard.node)?.assertCurrent();
  if (guard.identity !== currentCanvasIdentity() || getNode(guard.node.id) !== guard.node ||
      guard.signature !== stableStringify(guard.node.data) || guard.edges !== stableStringify(graph.edges) ||
      (guard.sources || []).some(source => getNode(source.id) !== source.node || source.signature !== stableStringify(source.node ? { type: source.node.type, data: source.node.data } : null))) {
    throw new Error('画布、节点或连线已变化；内部工作流和接口候选仍保留，未覆盖当前画布，请重新应用');
  }
}
async function completeInterfaceInputs(info, selection, { path, payload, options, ensureCurrent = () => {} }) {
  if (!(info.missing_fields || []).length) return { info, selection, missing_values: {} };
  const backend = settings.backend_url;
  const check = async () => {
    ensureCurrent();
    const status = await api('/api/status'); ensureCurrent();
    if (status.backend_url !== backend || settings.backend_url !== backend) throw new Error('补齐参数期间推理引擎已变化，请重新检查。');
  };
  return repairInterfaceInputs({ info, selection, ensureCurrent, notify: toast, chooseValues: chooseMissingInputValues,
    inspect: async repair => { ensureCurrent(); const next = await api(path, { ...payload, ...repair }); await check(); return next; },
    chooseFields: async (next, previous) => {
      const selectedIds = new Set(previous.fields.map(field => field.id));
      const retained = new Map((options.previousFields || []).map(field => [field.id, { ...field, selected: selectedIds.has(field.id) }]));
      for (const field of previous.fields) if (!retained.has(field.id)) retained.set(field.id, field);
      return chooseEditorInterface({ ...options, ...next, previousFields: [...retained.values()], selectedOutputs: previous.output_nodes });
    },
  });
}
async function configureNativeInterface(node, compiled = null, session = null, { automatic = false, syncBaseline = [] } = {}) {
  const context = nativeSessionContexts.get(node); context?.assertCurrent();
  const guard = captureNativeInterfaceTarget(node);
  if (compiled?.ignored_ui_inputs?.length) toast(`已识别并排除 ${compiled.ignored_ui_inputs.length} 个仅用于界面操作的控件；原工作流保留`);
  const previousFields = context?.fields || packageCatalog.peek(node.data.package_id)?.fields || (node.data.kind !== 'package' ? generationInputPorts(node,graph).filter(field=>graph.edges.some(edge=>edge.target===node.id&&edgeInputField(graph,edge)===field.id)) : []);
  const previousBaseline = clone(node.data.editor_baseline || {});
  // This option is local editor state, never an arbitrary addition to the
  // session HTTP payload. Recheck both the previous field and clean native
  // compile before replacing a single field's three-way merge base.
  if (compiled && session?.session_id && Array.isArray(syncBaseline)) {
    const fields = [...previousFields, ...(node.data.editor_hidden_updates || []).map(item => item.field)];
    const fieldsById = new Map(), controlsByBinding = new Map(), ownerCounts = new Map(), baselineCounts = new Map();
    for (const field of fields) { const matches = fieldsById.get(field.id) || []; matches.push(field); fieldsById.set(field.id, matches); }
    for (const control of compiled.controls || []) {
      const binding = JSON.stringify([control.node_id, control.input]), target = JSON.stringify([control.widget_node_id, control.widget_name]);
      const matches = controlsByBinding.get(binding) || []; matches.push(control); controlsByBinding.set(binding, matches);
      ownerCounts.set(target, (ownerCounts.get(target) || 0) + 1);
    }
    for (const item of syncBaseline) if (item) baselineCounts.set(item.field_id, (baselineCounts.get(item.field_id) || 0) + 1);
    const hiddenById = new Map((node.data.editor_hidden_updates || []).map(item => [item.field.id, item]));
    const seen = new Set();
    for (const item of syncBaseline) {
      if (!item || seen.has(item.field_id)) continue;
      seen.add(item.field_id);
      const matches = fieldsById.get(item.field_id) || [];
      const field = matches[0], definition = compiled.output?.[item.node_id];
      const controls = controlsByBinding.get(JSON.stringify([item.node_id, item.input])) || [];
      const hidden = hiddenById.get(item.field_id);
      const ownValue = hidden ? hidden.value : node.data.packageValues?.[item.field_id];
      if (baselineCounts.get(item.field_id) !== 1 || matches.length !== 1 || field.node_id !== item.node_id || field.input !== item.input || field.type !== item.type ||
          definition?.class_type !== item.class_type || !Object.hasOwn(definition.inputs || {}, item.input) ||
          controls.length !== 1 || ownerCounts.get(JSON.stringify([item.widget_node_id, item.widget_name])) !== 1 || controls[0].widget_node_id !== item.widget_node_id || controls[0].widget_name !== item.widget_name ||
          !Object.is(ownValue, item.value) || item.value !== null && !['string', 'number', 'boolean'].includes(typeof item.value)) continue;
      previousBaseline[item.field_id] = item.value;
    }
  }
  const prefix = `/api/editor-workflows/${node.data.editor_id}`;
  const inspectionPayload = { previous_package_id: node.data.package_id || null,
    ...(compiled ? { prompt: compiled.output } : { package_id: node.data.package_id, values: node.data.packageValues, previous_baseline: node.data.editor_baseline }) };
  let info = await api(`${prefix}/interface`, inspectionPayload);
  assertNativeInterfaceTarget(guard);
  if (info.migrations?.length) toast(`已按当前节点定义对齐 ${info.migrations.length} 个参数名；未改动原文件或参数值`);
  const oldOutputs = (node.data.editor_output_fields || []).filter(item => (node.data.editor_outputs || []).includes(item.id));
  const connectionGraph=clone(graph);
  if(node.data.kind!=='package') for(const edge of connectionGraph.edges.filter(e=>e.target===node.id)) edge.targetField=edgeInputField(graph,edge);
  const connections = editorConnectionSummary(connectionGraph, node.id, oldOutputs);
  if (!compiled) info.outputs = info.outputs.map(item => ({ ...item, label: oldOutputs.find(old => old.id === item.id)?.label || item.label }));
  const options = { ...info, previousFields, previousValues: node.data.packageValues, previousBaseline, selectedOutputs: oldOutputs.length ? oldOutputs : node.data.editor_outputs || [], connections };
  let selection = (automatic ? autoEditorInterfaceSelection(options) : null) || await chooseEditorInterface(options);
  if (!selection) return null;
  const repaired = await completeInterfaceInputs(info, selection, { path: `${prefix}/interface`, payload: inspectionPayload, options, ensureCurrent: () => assertNativeInterfaceTarget(guard) });
  if (!repaired) return null;
  ({ info, selection } = repaired);
  assertNativeInterfaceTarget(guard);
  const payload = { ...(session ? { session_id: session.session_id, base_revision: session.base_revision } : {}), missing_values: repaired.missing_values, fields: selection.fields, output_nodes: selection.output_nodes, rebindings: selection.rebindings,
    ...(compiled?.connected_resolutions ? { connected_resolutions: compiled.connected_resolutions } : {}),
    previous_package_id: node.data.package_id || null, previous_values: node.data.packageValues || {}, previous_baseline: previousBaseline,
    ...(compiled ? { document: compiled.workflow, prompt: compiled.output } : { package_id: node.data.package_id, values: node.data.packageValues, backend_url: node.data.editor_backend }) };
  let result = await api(`${prefix}/${compiled ? 'apply' : 'configure'}`, payload);
  if (result.requires_resolution) {
    const resolutions = await resolveEditorConflicts(result.changes.conflicts);
    if (!resolutions) return null;
    assertNativeInterfaceTarget(guard);
    result = await api(`${prefix}/${compiled ? 'apply' : 'configure'}`, { ...payload, resolutions });
    if (result.requires_resolution) throw new Error('仍有参数冲突未选择，请重新配置');
  }
  assertNativeInterfaceTarget(guard);
  if (result.readiness?.issues?.length) toast(`外部接口已建立；生成前还需修复：${result.readiness.issues[0].message || result.readiness.issues[0]}`, true);
  const controls = (compiled?.controls || node.data.editor_controls || []).map(control => {
    const copy = { ...control }; delete copy.media_receipt; delete copy.mapping_receipt; return copy;
  });
  const invalidated_media_fields = (Array.isArray(compiled?.connected_resolutions) ? compiled.connected_resolutions : []).filter(item => item.choice === 'inner' && item.media_owner_invalidated === true).map(item => item.field_id);
  return { ...result, outputs: info.outputs, controls, invalidated_media_fields, rebindings: selection.rebindings, output_rebindings: selection.output_rebindings, _canvas_guard: guard };
}
async function configureNativePanel(node) {
  const existing = nativeSessionContexts.get(node), context = existing || beginNativeEditorContext(node);
  try {
    if (!await ensureWorkflowBackend(node)) return;
    await loadNativeEditorFields(context); context.assertCurrent();
    const result = await configureNativeInterface(node);
    if (result) { await nativeEditor.applyToNode(node, result); toast('外层参数面板已更新；无需进入内部即可调节'); }
  } finally { if (!existing) endNativeEditorSession(node); }
}
async function configurePackageInterface(node) {
  if (node.data.editor_id) return configureNativePanel(node);
  const openingIdentity = currentCanvasIdentity(), openingPackage = node.data.package_id, openingData = stableStringify(node.data), openingBackend = settings.backend_url;
  const pack = await ensurePackageDefinition(openingPackage);
  if (openingIdentity !== currentCanvasIdentity() || getNode(node.id) !== node || node.data.package_id !== openingPackage || openingData !== stableStringify(node.data) || openingBackend !== settings.backend_url) throw new Error('画布或工作流已变化，请重新打开接口设置');
  const snapshot = stableStringify(node.data), identity = currentCanvasIdentity(), backend = settings.backend_url;
  const saved = { package_id: pack.id, values: node.data.packageValues, previous_baseline: node.data.editor_baseline };
  let info = await api('/api/interfaces/inspect', saved);
  const options = { ...info, previousFields: pack.fields, previousValues: node.data.packageValues,
    previousBaseline: node.data.editor_baseline, selectedOutputs: node.data.editor_outputs || [],
    connections: editorConnectionSummary(graph,node.id,node.data.editor_output_fields || []) };
  const ensureCurrent = () => { if (identity !== currentCanvasIdentity() || getNode(node.id) !== node || snapshot !== stableStringify(node.data)) throw new Error('画布或工作流已变化，请重新打开接口设置'); };
  let selection = await chooseEditorInterface(options);
  if (!selection) return;
  const repaired = await completeInterfaceInputs(info, selection, { path: '/api/interfaces/inspect', payload: saved, options, ensureCurrent });
  if (!repaired) return;
  ({ info, selection } = repaired); ensureCurrent();
  const payload = { ...saved, ...selection, missing_values: repaired.missing_values, name: pack.name, backend_url: backend,
    previous_package_id: pack.id, previous_values: node.data.packageValues || {} };
  let result = await api('/api/interfaces/apply', payload);
  if (result.requires_resolution) {
    const resolutions = await resolveEditorConflicts(result.changes.conflicts);
    if (!resolutions) return;
    result = await api('/api/interfaces/apply', { ...payload, resolutions });
  }
  if (result.requires_resolution) throw new Error('仍有参数冲突未处理');
  if (identity !== currentCanvasIdentity() || getNode(node.id) !== node || snapshot !== stableStringify(node.data)) throw new Error('画布已变化，接口已保存在包库；未覆盖当前节点');
  await nativeEditor.applyToNode(node, { ...result, rebindings: selection.rebindings, output_rebindings: selection.output_rebindings });
  toast('外部接口已更新；已有连线和参数已核对');
}
async function importApiInterface(document, name, target = null) {
  const prompt = apiPromptFromDocument(document), backend = settings.backend_url, identity = currentCanvasIdentity();
  // Preserve API data even when an extension or schema prevents compilation.
  const rawNode = target || addNode('generation', { title: name, kind: 'api', apiPrompt: prompt });
  if (target) mutate(() => { target.data.apiPrompt = prompt; });
  const signature = stableStringify(rawNode.data);
  let info = await api('/api/interfaces/inspect', { document: { prompt } });
  const options = { ...info, previousFields: rawNode.data.packageFields || [],
    selectedOutputs: rawNode.data.editor_output_fields || [],
    connections: editorConnectionSummary(graph, rawNode.id, rawNode.data.editor_output_fields || []) };
  const ensureCurrent = () => { if (identity !== currentCanvasIdentity() || getNode(rawNode.id) !== rawNode || signature !== stableStringify(rawNode.data)) throw new Error('画布或工作流已变化，请重新导入；原始执行图已保留。'); };
  let selection = autoEditorInterfaceSelection(options) || await chooseEditorInterface(options);
  if (!selection) return;
  const repaired = await completeInterfaceInputs(info, selection, { path: '/api/interfaces/inspect', payload: { document: { prompt } }, options, ensureCurrent });
  if (!repaired) return;
  ({ info, selection } = repaired); ensureCurrent();
  const result = await api('/api/interfaces/apply', { prompt, name, backend_url: backend, ...selection, missing_values: repaired.missing_values });
  if (identity !== currentCanvasIdentity() || getNode(rawNode.id) !== rawNode || signature !== stableStringify(rawNode.data)) throw new Error('画布已变化，工作流已保存在包库；未覆盖当前节点');
  const node = rawNode;
  await nativeEditor.applyToNode(node, { ...result, rebindings: selection.rebindings, output_rebindings: selection.output_rebindings });
  $('#packages-dialog').close(); $('#package-editor-dialog').close();
  try { await loadPackages(); } catch (error) { toast(`接口已应用；包库刷新失败：${error.message}`, true); }
  toast(`已编译外部接口：${result.package.fields.length} 项参数、${result.output_nodes.length} 个输出。可点“管理外部接口”调整`);
  if (result.readiness?.issues?.length) toast(result.readiness.issues[0].message, true);
}
async function ensureWorkflowBackend(node, _workflow = null, force = false) {
  const context = nativeSessionContexts.get(node);
  context?.assertCurrent();
  const report = await api(`/api/editor-workflows/${node.data.editor_id}/backends`, {});
  context?.assertCurrent();
  const target = await chooseWorkflowBackend(report, node.data.editor_backend, force);
  context?.assertCurrent();
  if (!target) return false;
  if (target !== report.current || target !== settings.backend_url) await useBackend(target);
  context?.acceptBackend(target); context?.assertCurrent();
  if (!node.data.package_id && node.data.editor_backend !== target) {
    mutate(() => { node.data.editor_backend = target; }); context?.rebaseTarget();
  }
  return target;
}
async function prepareEditorRootBackend(context) {
  context.assertCurrent();
  const target = editorPreparationBackend(graph, context.target.id, settings.backend_url);
  if (target === settings.backend_url) return;
  const profiles = (await api('/api/engines')).profiles || []; context.assertCurrent();
  if (!profiles.some(item => item.base_url === target && item.online)) throw new Error('工作流绑定的引擎尚未登记或未启动，请在设置中连接后再进入。');
  await useBackend(target); context.acceptBackend(target); context.assertCurrent();
}
async function prepareWorkflowBackend(targets, options = {}) {
  const currentBackend = settings.backend_url;
  const snapshot = options.graph || parseGraph(serializeGraph(graph));
  if (serializeGraph(graph) !== serializeGraph(snapshot)) throw new Error('准备工作流期间画布已变化，请重新运行');
  const target = (options.rootOnly ? workflowRootBackendTarget : workflowBackendTarget)(snapshot, targets, currentBackend);
  if (target === currentBackend) return;
  const profiles = (await api('/api/engines')).profiles || [];
  if (settings.backend_url !== currentBackend) throw new Error('准备工作流期间推理引擎已变化，请重新运行以检查参考图片归属。');
  if (!profiles.some(item => item.base_url === target && item.online)) throw new Error('工作流绑定的引擎尚未登记或未启动，请在设置中连接后再运行。');
  await useBackend(target);
  if (serializeGraph(graph) !== serializeGraph(snapshot)) throw new Error('切换推理引擎期间画布发生了变化。请确认参考图片后重新运行，避免使用未检查的素材。');
  toast('已连接这套工作流记住的推理引擎');
}
let settings = { backend_url: 'http://127.0.0.1:8188', model_roots: [], comfy_roots: [] };
let engine = { online: false, capabilities: {}, models: {} };
let jobs = [];
let jobNodes = {};
let pointer = null;
let connecting = null;
let tool = 'select';
let spaceDown = false;
let uploadTarget = null;
const referenceImports = new Map();
const packageMediaTransfers = createMediaTransfers();
const packageMediaOwner = node => `${currentCanvasIdentity()}:${node.id}`;
function assertCanvasMediaReady(targets, source = graph, scoped = false) {
  assertReferenceImportsReady(source, targets, referenceImports);
  const needed = upstreamNodeIds(source, targets), identity = currentCanvasIdentity();
  const fields = scoped ? new Map(source.nodes.filter(node => needed.has(node.id) && node.data.kind === 'package')
    .map(node => [`${identity}:${node.id}`, new Set((node.data.packageFields || []).map(field => field.id))])) : null;
  packageMediaTransfers.assertReady([...needed].map(id => `${identity}:${id}`), fields);
}
const referenceImportTickets = new Map();
let workflowTarget = null;
let saveTimer;
let pollBusy = false;
let restored = false;
let submitting = new Set();
let projectTitle = '未命名画布';
let packages = [];
const packageCatalog = createPackageCatalog({ api });
const sidebarPackageLoads = new WeakMap();
const sidebarRefreshGuards = new WeakMap();
const packageNodeAdds = new Map();
let activeSidebarPackage = null;
function ensurePackageDefinition(id) { return packageCatalog.ensure(id); }
function rememberPackageDefinition(pack) { const full = packageCatalog.remember(pack); packages = packageCatalog.summaries(); return full; }
let editorLibrary = [];
let packagesLoaded = false;
let packageDraft = null;
let environment = null;
let environmentPending = null;
let diagnosticChecks = [];
let workflowChecks = [];
let workflowRepair = '';
let diagnosticNodeId = null;
let diagnosticBusy = false;
const jobViews = new Map();
const retrying = new Set();
const controllingJobs = new Set();
const retryRequests = new Map();
const reusing = new Set();
const organizingPackages = new Set();
let draftEditing = null;
let canvasClipboard = null;
let pasteOffset = 0;
let nodeMenu = null;
let keyboardMoveBefore = null;
let contentLayout = null;
let studio = null;
let workflowCanvas = null;
let edgeScale = null;
let edgeCanvasVisible = null;
const clone = value => JSON.parse(JSON.stringify(value));

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}
function button(text, className, action, title) {
  const element = el('button', className, text);
  element.type = 'button';
  if (title) { element.title = title; element.setAttribute('aria-label', title); }
  // Keep the pressed button in place until click: opening the inspector on
  // canvas pointerdown can move or cover the target before pointerup.
  element.addEventListener('pointerdown', event => {
    const card = element.closest('.node');
    if (event.button === 0 && !spaceDown && tool !== 'hand' && card) {
      nodeActionPress.begin(element, card, card._node, event.pointerId); event.stopPropagation();
    }
  });
  element.addEventListener('click', event => {
    event.stopPropagation();
    const card = element.closest('.node');
    if (card && !nodeActionPress.activate(element, card._node, !event.detail)) { renderNodes(); return; }
    if (card && !element.closest('.node-input-ports')) {
      selected = new Set([card.dataset.nodeId]); selectedEdge = null;
      revealInspector(); renderSelection(); renderInspector(); switchTab('properties');
    }
    if (!card) { Promise.resolve().then(() => action(event)).catch(reportError); return; }
    // Activation has already consumed the pointer press. Let a synchronous
    // content transaction render its changed card before recording history.
    nodeActionPress.finish(element);
    try { Promise.resolve(action(event)).catch(reportError); }
    catch (error) { reportError(error); }
    finally { if (card) { nodeActionPress.finish(element); renderNodes(); } }
  });
  return element;
}
function bind(selector, action) {
  $(selector).addEventListener('click', event => Promise.resolve().then(() => action(event)).catch(reportError));
}
function toast(message, error = false) {
  const messageElement = el('div', `toast${error ? ' error' : ''}`, message);
  const region = $('#toast-region');
  // Keep rapid import/connect feedback from covering the canvas. Error
  // messages retain their own lifetime and are not displaced by successes.
  if (!error) [...region.querySelectorAll('.toast:not(.error)')].slice(0, -1).forEach(item => item.remove());
  region.append(messageElement);
  setTimeout(() => messageElement.remove(), error ? 7000 : 3500);
}
function reportError(error) { toast(error?.message || String(error), true); }
function mediaURL(value) {
  if (typeof value !== 'string' || !value || value.includes('\\')) return '';
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
async function api(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ['/api/diagnostics', '/api/environment'].includes(path) ? 90000 : 45000);
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-FW-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const result = await response.json().catch(() => ({ error: `服务返回无效数据 (${response.status})` }));
    if (!response.ok) {
      const error = new Error(result.error || `请求失败 (${response.status})`);
      error.status = response.status; error.payload = result; throw error;
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('本地服务响应超时，请检查引擎状态后重试。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function getNode(id) { return graph.nodes.find(node => node.id === id); }
function ensureCanvasIdentity() {
  if (!canvasIdentity) { try { canvasIdentity = localStorage.getItem(CANVAS_ID_KEY) || ''; } catch {} canvasIdentity ||= crypto.randomUUID(); }
  return canvasIdentity;
}
function currentCanvasIdentity() { const identity = ensureCanvasIdentity(); localStorage.setItem(CANVAS_ID_KEY, identity); return identity; }
function replaceCanvasIdentity() { const next = crypto.randomUUID(); localStorage.setItem(CANVAS_ID_KEY, next); canvasIdentity = next; jobNodes = {}; expandedInputs.clear(); portBindings.clear(); contentLayout?.reset(); }
function normalizeProjectTitle(value, fallback = '未命名画布') {
  const title = typeof value === 'string' ? value.trim().slice(0, 120) : '';
  const safeFallback = typeof fallback === 'string' ? fallback.trim().slice(0, 120) : '';
  return title || safeFallback || '未命名画布';
}
function importedProjectTitle(value, fallback = '导入的画布') {
  const name = typeof value === 'string' ? value.replace(/\.json$/i, '') : '';
  return normalizeProjectTitle(name, fallback);
}
function setProjectTitle(value, fallback) {
  projectTitle = normalizeProjectTitle(value, fallback);
  $('#project-title').textContent = projectTitle;
}
function singleSelected() { return selected.size === 1 ? getNode([...selected][0]) : null; }
function selectedGeneration() { const node = singleSelected(); return node?.type === 'generation' ? node : graph.nodes.find(item => item.type === 'generation'); }
function snapshot(includeSelection = true) {
  return JSON.stringify({ graph, canvasIdentity: ensureCanvasIdentity(), jobNodes, projectTitle,
    expandedInputs: [...expandedInputs],
    portViews: savedPortViews(),
    ...(includeSelection ? { selection: { nodes: [...selected], edge: selectedEdge } } : {}) });
}
function snapshotChanged(before) {
  const previous = JSON.parse(before); delete previous.selection;
  return JSON.stringify(previous) !== snapshot(false);
}
function restoreSnapshot(value) {
  contentLayout?.reset();
  const state = JSON.parse(value);
  localStorage.setItem(CANVAS_ID_KEY, state.canvasIdentity);
  canvasIdentity = state.canvasIdentity; graph = state.graph; jobNodes = state.jobNodes || {};
  expandedInputs.clear();
  portBindings.clear();
  for (const id of state.expandedInputs || []) if (getNode(id)) expandedInputs.add(id);
  restorePortViews(state.portViews);
  setProjectTitle(state.projectTitle);
  if (Array.isArray(state.selection?.nodes)) selected = new Set(state.selection.nodes.filter(id => getNode(id)));
  if (state.selection) selectedEdge = state.selection.edge || null;
  if (selectedEdge && !graph.edges.some(edge => edge.id === selectedEdge)) selectedEdge = null;
}
function pushHistory(before) {
  if (!snapshotChanged(before)) return;
  history.push(before);
  if (history.length > 80) history.shift();
  future = [];
  save();
  updateHistory();
}
function mutate(action, options = {}) {
  finishKeyboardMove();
  const before = snapshot();
  contentLayout?.begin();
  try {
    action();
    if (draftEditing) {
      if (!draftEditing.recorded && snapshotChanged(before)) { pushHistory(before); draftEditing.recorded = true; }
      else save();
      return;
    }
    // A blur/change event often recommits the last live draft value. It is
    // only a redraw, not a new content transaction that may absorb a pending
    // backend resize into the user's ordinary snapshot history.
    if (!snapshotChanged(before)) {
      contentLayout?.end();
      renderNodes();
      if (options.inspector !== false) renderInspector();
      return;
    }
    renderNodes();
    pushHistory(before);
    if (options.inspector !== false) renderInspector();
  } catch (error) {
    restoreSnapshot(before); renderAll(); throw error;
  } finally {
    contentLayout?.end();
  }
}
function layoutHistoryEntry(positions) {
  return { kind: 'content-layout', canvasIdentity: ensureCanvasIdentity(), positions };
}
function inverseHistoryEntry(entry) {
  return entry?.kind === 'content-layout'
    ? layoutHistoryEntry(entry.positions.flatMap(position => { const node = getNode(position.id); return node ? [{ id: node.id, x: node.x, y: node.y }] : []; }))
    : snapshot();
}
function restoreHistoryEntry(entry) {
  if (entry?.kind !== 'content-layout') return restoreSnapshot(entry);
  contentLayout?.reset();
  if (entry.canvasIdentity !== ensureCanvasIdentity()) return;
  for (const position of entry.positions) { const node = getNode(position.id); if (node) { node.x = position.x; node.y = position.y; } }
}
function save(immediate = false) {
  clearTimeout(saveTimer);
  $('#save-state').textContent = '保存中…';
  const write = () => {
    try {
      localStorage.setItem(STORAGE_KEY, serializeGraph(graph, viewport));
      localStorage.setItem(PORT_VIEW_STORAGE_KEY, JSON.stringify({ canvasIdentity: currentCanvasIdentity(), nodes: [...expandedInputs].filter(id => getNode(id)), views: savedPortViews() }));
      localStorage.setItem(JOB_MAP_KEY, JSON.stringify(jobNodes));
      localStorage.setItem(TITLE_STORAGE_KEY, projectTitle);
      $('#save-state').textContent = '浏览器草稿已保存';
      return true;
    } catch { $('#save-state').textContent = '草稿保存失败，请导出或保存本地版本'; return false; }
  };
  if (immediate) return write(); else saveTimer = setTimeout(write, 500);
}
function undo() {
  finishKeyboardMove();
  if (!history.length) return;
  const before = inverseHistoryEntry(history.at(-1)); restoreHistoryEntry(history.at(-1));
  history.pop(); future.push(before);
  selected = new Set([...selected].filter(id => getNode(id)));
  renderAll(); save();
}
function redo() {
  finishKeyboardMove();
  if (!future.length) return;
  const before = inverseHistoryEntry(future.at(-1)); restoreHistoryEntry(future.at(-1));
  future.pop(); history.push(before);
  selected = new Set([...selected].filter(id => getNode(id)));
  renderAll(); save();
}
function updateHistory() { $('#undo').disabled = !history.length; $('#redo').disabled = !future.length; }
function viewPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: (clientX - rect.left - viewport.x) / viewport.scale, y: (clientY - rect.top - viewport.y) / viewport.scale };
}
function applyViewport() {
  const scaleChanged = edgeScale !== viewport.scale;
  const contentBeforeScale = scaleChanged ? contentLayout?.captureViewChange() : null;
  // Native layout zoom rerasterizes text at its displayed size. GPU scaling of
  // the entire world can reuse a low-resolution texture on HiDPI WebView2.
  if (globalThis.CSS?.supports('zoom', '1')) {
    world.style.zoom = String(viewport.scale);
    world.style.transform = `translate(${viewport.x / viewport.scale}px,${viewport.y / viewport.scale}px)`;
  } else world.style.transform = `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.scale})`;
  canvas.style.backgroundSize = `${22 * viewport.scale}px ${22 * viewport.scale}px`;
  canvas.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
  $('#zoom-reset').textContent = `${Math.round(viewport.scale * 100)}%`;
  // Translation moves the existing SVG with its nodes. Only scale/visibility
  // changes need fresh pixel-rounded port centers; rebuilding on every pan
  // would replace thousands of paths unnecessarily on larger canvases.
  const visible = canvas.offsetParent !== null;
  // CSS layout zoom rounds text metrics differently. A view change is never
  // content growth. Preserve content already waiting for an edit to finish.
  if (scaleChanged) contentLayout?.rebase(contentBeforeScale);
  if (edgeScale !== viewport.scale || edgeCanvasVisible !== visible) renderEdges();
  else drawMinimap();
}
function zoom(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
  const next = Math.max(.2, Math.min(3, viewport.scale * factor));
  viewport.x = x - (x - viewport.x) / viewport.scale * next;
  viewport.y = y - (y - viewport.y) / viewport.scale * next;
  viewport.scale = next;
  applyViewport(); save();
}
function nodeSize(node) {
  const dom = document.getElementById(`fw-node-${node.id}`);
  return { width: dom?.offsetWidth || (node.type === 'result' ? 338 : node.type === 'generation' ? 304 : 286), height: dom?.offsetHeight || (node.type === 'generation' ? 440 : 340) };
}
function placementSize(node) {
  const size = nodeSize(node);
  // Images/videos load after placement. Reserve the maximum media height plus
  // header, caption, multiple-output action and footer for both new and pending
  // cards, so a later portrait image cannot grow into an adjacent node.
  return { ...size, height: Math.max(size.height, ['result', 'reference'].includes(node.type) ? 480 : node.type === 'generation' ? 440 : 340) };
}
function placeNewNodes(nodes, preferredAnchor = null) {
  const rectangles = nodes.map(node => ({ x: node.x, y: node.y, ...placementSize(node) }));
  const occupied = graph.nodes.map(node => ({ x: node.x, y: node.y, ...placementSize(node) }));
  const preferred = preferredAnchor ? { x: preferredAnchor.x + Math.min(...rectangles.map(rect => rect.x)) - nodes[0].x, y: preferredAnchor.y + Math.min(...rectangles.map(rect => rect.y)) - nodes[0].y } : null;
  placeFragment(rectangles, occupied, preferred).forEach((position, index) => { nodes[index].x = position.x; nodes[index].y = position.y; });
}
function visibleCanvasArea(contentSize) {
  const shell = canvas.closest('.canvas-shell') || canvas;
  const groups = [
    ['top', '.canvas-topline,.canvas-action-bar,.discovery-banner,.workflow-canvas-toolbar'],
    ['bottom', '.canvas-footer'],
    ['obstacle', '#minimap-button,.workflow-run-details,.workflow-menu-actions'],
  ];
  const overlays = groups.flatMap(([kind, selector]) => [...shell.querySelectorAll(selector)]
    .filter(element => !element.hidden && !element.closest('details:not([open])') && element.getClientRects().length).map(element => {
      const rect = element.getBoundingClientRect();
      return { kind, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    }));
  return canvasContentArea(canvas.getBoundingClientRect(), overlays, contentSize);
}
function centerOnNode(node) {
  const size = nodeSize(node);
  const area = visibleCanvasArea(size);
  if (area.width <= 0 || area.height <= 0) { toast('画布空间不足，请收起侧栏或浮层后重试'); return; }
  viewport.x = area.x + area.width / 2 - (node.x + size.width / 2) * viewport.scale;
  viewport.y = area.y + Math.max(0, (area.height - size.height * viewport.scale) / 2) - node.y * viewport.scale;
  applyViewport(); save();
}
function bounds(nodes = graph.nodes) {
  return selectionBounds(nodes, nodeSize) || { minX: 0, minY: 0, maxX: 800, maxY: 500 };
}
function fitView(onlySelected = false) {
  onlySelected = onlySelected === true;
  const nodes = onlySelected ? graph.nodes.filter(node => selected.has(node.id)) : graph.nodes;
  if (onlySelected && !nodes.length) { toast('先选择需要查看的节点'); return; }
  const box = bounds(nodes);
  const area = visibleCanvasArea({ width: box.maxX - box.minX, height: box.maxY - box.minY });
  if (area.width <= 0 || area.height <= 0) { toast('画布空间不足，请收起侧栏或浮层后重试'); return; }
  viewport.scale = Math.min(1, Math.max(.2, Math.min(area.width / (box.maxX - box.minX), area.height / (box.maxY - box.minY))));
  viewport.x = area.x + (area.width - (box.maxX - box.minX) * viewport.scale) / 2 - box.minX * viewport.scale;
  viewport.y = area.y - box.minY * viewport.scale + Math.max(0, (area.height - (box.maxY - box.minY) * viewport.scale) / 3);
  applyViewport(); save();
}
function drawMinimap() {
  const map = $('#minimap');
  const context = map.getContext('2d');
  context.clearRect(0, 0, map.width, map.height);
  const box = bounds();
  const viewBox = { x: -viewport.x / viewport.scale, y: -viewport.y / viewport.scale, width: canvas.clientWidth / viewport.scale, height: canvas.clientHeight / viewport.scale };
  const minX = Math.min(box.minX, viewBox.x), minY = Math.min(box.minY, viewBox.y);
  const maxX = Math.max(box.maxX, viewBox.x + viewBox.width), maxY = Math.max(box.maxY, viewBox.y + viewBox.height);
  const scale = Math.min(270 / Math.max(1, maxX - minX), 125 / Math.max(1, maxY - minY));
  const offsetX = (300 - (maxX - minX) * scale) / 2, offsetY = (185 - (maxY - minY) * scale) / 2;
  context.lineWidth = 1;
  for (const node of graph.nodes) {
    const size = nodeSize(node);
    context.fillStyle = selected.has(node.id) ? '#4968cf' : node.type === 'generation' ? '#bc8373' : '#a0a6b7';
    context.fillRect(offsetX + (node.x - minX) * scale, offsetY + (node.y - minY) * scale, size.width * scale, size.height * scale);
  }
  context.strokeStyle = '#4968cf99'; context.fillStyle = '#4968cf0c';
  const rect = [offsetX + (viewBox.x - minX) * scale, offsetY + (viewBox.y - minY) * scale, viewBox.width * scale, viewBox.height * scale];
  context.fillRect(...rect); context.strokeRect(...rect);
}
function edgePath(a, b) { const spread = Math.max(65, Math.abs(b.x - a.x) * .45); return `M ${a.x} ${a.y} C ${a.x + spread} ${a.y}, ${b.x - spread} ${b.y}, ${b.x} ${b.y}`; }
function svgElement(tag, attributes) { const element = document.createElementNS('http://www.w3.org/2000/svg', tag); Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, String(value))); return element; }
function portPoint(node, direction, field = '') {
  const ports = [...(document.getElementById(`fw-node-${node.id}`)?.querySelectorAll(`.port.${direction}`) || [])];
  const port = ports.find(item => item.dataset.field === field) || ports[0];
  if (port?.getClientRects().length) {
    const rect = port.getBoundingClientRect();
    return viewPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
  return { x: node.x + (direction === 'output' ? nodeSize(node).width : 0), y: node.y + 74.5 };
}
function renderEdges() {
  edgeScale = viewport.scale;
  edgeCanvasVisible = canvas.offsetParent !== null;
  edgesLayer.replaceChildren();
  const anchors = new Map();
  const anchor = (node, direction, field = '') => {
    const key = `${node.id}:${direction}:${field}`;
    if (!anchors.has(key)) anchors.set(key, portPoint(node, direction, field));
    return anchors.get(key);
  };
  for (const edge of graph.edges) {
    const from = getNode(edge.source), to = getNode(edge.target);
    if (!from || !to) continue;
    const a = anchor(from, 'output'), b = anchor(to, 'input', edgeInputField(graph, edge));
    const path = edgePath(a, b);
    const hit = svgElement('path', { d: path, class: 'edge-hit', 'data-edge-id': edge.id });
    hit.addEventListener('click', event => { event.stopPropagation(); selectedEdge = edge.id; selected.clear(); renderSelection(); renderEdges(); renderInspector(); });
    edgesLayer.append(hit, svgElement('path', { d: path, class: `edge-line${selectedEdge === edge.id ? ' edge-selected' : ''}` }));
  }
  if (connecting) {
    const node = getNode(connecting.source);
    if (node) edgesLayer.append(svgElement('path', { d: edgePath(anchor(node, 'output'), connecting.point), class: 'edge-draft' }));
  }
  drawMinimap();
}
function copyText(value, success = '已复制到剪贴板') {
  if (!value) { toast('还没有可复制的内容'); return Promise.resolve(); }
  return navigator.clipboard.writeText(value).then(() => toast(success)).catch(() => {
    const area = el('textarea'); area.value = value; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
    const done = document.execCommand('copy'); area.remove();
    if (!done) throw new Error('剪贴板不可用，请选中文本后手动复制。');
    toast(success);
  });
}
async function openAiConnection() {
  const trigger = $('#aiConnectBtn'); trigger.disabled = true;
  try {
    const bootstrap = await api('/api/bootstrap');
    if (!bootstrap.csrf) throw new Error('本地服务没有返回有效的接入令牌');
    csrf = bootstrap.csrf;
    $('#mcpUrl').value = `${location.origin}/mcp`;
    $('#mcpConfig').textContent = JSON.stringify({ mcpServers: { frameweave: { url: `${location.origin}/mcp`, headers: { Authorization: `Bearer ${csrf}` } } } }, null, 2);
    if (!$('#aiDialog').open) $('#aiDialog').showModal();
  } finally { trigger.disabled = false; }
}
function clearAiConnection() { $('#mcpUrl').value = ''; $('#mcpConfig').textContent = ''; }
function outputMedia(output, className, controls = false) {
  const url = mediaURL(output.url);
  if (!url) return el('div', 'media-error', '此媒体地址不可用。请从本地任务重新载入。');
  const media = el(['video', 'audio'].includes(output.type) ? output.type : 'img', className);
  media.src = url;
  if (['video', 'audio'].includes(output.type)) { media.controls = controls || output.type === 'audio'; media.preload = 'metadata'; media.playsInline = true; }
  else { media.alt = output.filename || '本地生成结果'; media.loading = 'lazy'; }
  media.addEventListener('error', () => { if (media.isConnected && media.hasAttribute('src')) media.replaceWith(el('div', 'media-error', '媒体文件不可用。导入的画布不包含原始媒体，请重新导入素材或检查本地输出。')); }, { once: true });
  if (!controls && output.type !== 'audio') media.addEventListener('click', event => { event.stopPropagation(); preview(output); });
  return media;
}
function releaseMedia(root) {
  root.querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
}
function clearPreview() {
  releaseMedia($('#preview-content'));
  $('#preview-content').replaceChildren();
  $('#preview-download').removeAttribute('href');
}
function preview(output) {
  const url = mediaURL(output.url);
  if (!url) throw new Error('只能预览当前本地服务的媒体');
  clearPreview();
  $('#preview-title').textContent = output.filename || '本地媒体预览';
  $('#preview-content').replaceChildren(outputMedia(output, '', true));
  $('#preview-download').href = url;
  $('#preview-download').download = output.filename || 'frameweave-output';
  if (!$('#preview-dialog').open) $('#preview-dialog').showModal();
}
function beginConnection(node) {
  const point = portPoint(node, 'output');
  connecting = {source:node.id,point:{x:point.x+80,y:point.y}};
  canvas.classList.add('connecting'); $('#canvas-hint').textContent = '按住拖到对应输入端口后松手 · 也可依次点击 · Esc 取消'; renderEdges(); renderSelection();
}
function finishConnection(node, field = '') {
  if (!connecting) return;
  const source = connecting.source;
  if (node.data.kind === 'package' && !field) { cancelConnection(); return workflowCanvas.connectNodes(source,node.id); }
  const options = field ? {targetField:field} : {};
  if (field && getNode(source)?.type === 'prompt') options.sourceField = field === 'negative' ? 'negative' : 'text';
  if (field && ['generation', 'result'].includes(getNode(source)?.type)) {
    const type = generationInputPorts(node).find(item => item.id === field)?.type;
    const available = outputChoices(graph, source, type);
    if (available.ambiguous) { cancelConnection(); return workflowCanvas.connectNodes(source, node.id, field); }
    if (available.choices.length === 1) options.sourceOutput = available.choices[0].id;
    else if (available.actual.length === 1 && available.actual[0].node_id) options.sourceOutput = available.actual[0].node_id;
    if (['image', 'video', 'audio'].includes(type)) options.sourceField = type;
  }
  mutate(() => connect(graph,source,node.id,options)); cancelConnection(); toast('节点已连接');
}
let portDrag = null, suppressPortClick = false;
const expandedInputs = new Set();
const portBindings = new Map();
function portBindingSignature(node) {
  return JSON.stringify([node.data.kind, node.data.package_id, node.data.editor_id,
    generationInputPorts(node, graph).map(field => [field.id, field.type])]);
}
function savedPortViews() {
  return [...expandedInputs].flatMap(id => {
    const node = getNode(id);
    return node ? [{ id, binding: portBindingSignature(node), ...interfaceViewState(node, 'ports') }] : [];
  });
}
function restorePortViews(views) {
  if (!Array.isArray(views)) return;
  for (const view of views.slice(0, 500)) {
    const node = getNode(view?.id);
    if (!node || !expandedInputs.has(node.id)) continue;
    if (view.binding !== undefined && view.binding !== portBindingSignature(node)) { expandedInputs.delete(node.id); continue; }
    Object.assign(interfaceViewState(node, 'ports'), {
      page: Number.isSafeInteger(view.page) && view.page >= 0 ? view.page : 0,
      query: typeof view.query === 'string' ? view.query.slice(0, 1000) : '',
    });
  }
}
function port(node, direction, field = '', label = '') {
  const element = button('', `port ${direction}${connecting?.source === node.id && direction === 'output' ? ' armed' : ''}`, () => {
    if (suppressPortClick) { suppressPortClick = false; return; }
    if (direction === 'output') beginConnection(node);
    else if (connecting) return finishConnection(node,field);
    else toast('从来源节点右侧端口拖到此处即可连接');
  }, `${node.data.title} · ${label || (direction === 'input' ? '输入' : '输出')}端口`);
  element.dataset.port = direction;
  element.dataset.field = field;
  element.addEventListener('pointerdown', event => {
    if (event.button !== 0 || direction !== 'output') return;
    event.stopPropagation(); beginConnection(node); portDrag = {id:event.pointerId,x:event.clientX,y:event.clientY,moved:false};
    canvas.setPointerCapture(event.pointerId); event.preventDefault();
  });
  return element;
}
function inputPorts(node, body) {
  const fields = generationInputPorts(node,graph);
  if (!fields.length) return;
  const list = el('div','node-input-ports');
  const connected = new Set(graph.edges.filter(e=>e.target===node.id).map(e=>edgeInputField(graph,e)));
  const state = interfaceViewState(node, 'ports');
  const candidates = inputPortCandidates(fields, connected);
  if (!candidates.length) return;
  const heading = el('div', 'node-ports-heading'); heading.append(el('span', '', '输入'), el('span', '', `${connected.size} 已连接 · ${candidates.length} 个接口`)); list.append(heading);
  const search = el('input', 'field-input'); search.type = 'search'; search.value = state.query;
  search.placeholder = '搜索输入名称 / ID'; search.setAttribute('aria-label', '搜索画布输入端口');
  const rows = el('div');
  const updateLayout = change => {
    mutate(() => { change(); refresh(); }, { inspector: false });
    renderEdges();
  };
  const refresh = () => {
    rows.replaceChildren();
    const expanded = expandedInputs.has(node.id);
    search.value = state.query;
    search.hidden = !expanded || candidates.length <= CANVAS_PORT_PAGE_SIZE;
    const { visible, hidden, page } = visibleInputPorts(fields, connected, expanded, 4, state);
    state.page = page.page;
    for (const field of visible) {
      const row = el('div',`node-input-row type-${field.type}`);
      const bound = graph.edges.find(edge=>edge.target===node.id&&edgeInputField(graph,edge)===field.id);
      const socket = port(node,'input',field.id,field.label); row.append(socket,el('span','input-port-label',field.label),el('span','input-port-type',{text:'文本',image:'图片',video:'视频',audio:'音频'}[field.type]||field.type));
      if (bound) { row.classList.add('connected'); row.title = `来自：${getNode(bound.source)?.data.title || '来源'}；选中连线可删除`; }
      rows.append(row);
    }
    if (expanded) appendInterfacePager(rows, page, '端口', number => updateLayout(() => { state.page = number; }));
    if (hidden || expanded && candidates.length > 4) rows.append(button(expanded ? '收起未连接接口' : `＋ 其他 ${hidden} 个接口`,'node-action port-overflow',()=>{
      updateLayout(() => { if (expanded) expandedInputs.delete(node.id); else expandedInputs.add(node.id); });
    }));
  };
  search.addEventListener('input', () => { try { updateLayout(() => { state.query = search.value; state.page = 0; }); } catch (error) { reportError(error); } });
  list.append(search, rows); refresh(); body.append(list);
}
function cancelConnection() { connecting = null; canvas.classList.remove('connecting'); $('#canvas-hint').textContent = '左键框选 · 中键平移 · 双击新建 · 滚轮缩放'; renderEdges(); renderSelection(); }
function renderNodes() {
  for (const id of portBindings.keys()) if (!getNode(id)) { portBindings.delete(id); expandedInputs.delete(id); }
  const remaining = new Map([...nodesLayer.children].map(card => [card.dataset.nodeId, card]));
  graph.nodes.forEach((node, index) => {
    if (node.type === 'generation') {
      const binding = portBindingSignature(node);
      if (portBindings.has(node.id) && portBindings.get(node.id) !== binding) {
        expandedInputs.delete(node.id); Object.assign(interfaceViewState(node, 'ports'), { page: 0, query: '' });
      }
      portBindings.set(node.id, binding);
    }
    const previous = remaining.get(node.id); remaining.delete(node.id);
    const signature = JSON.stringify([node.data, expandedInputs.has(node.id), referenceImports.get(node.id), index, submitting.has(node.id), graph.edges.filter(edge => edge.target === node.id).map(edge => [edge, getNode(edge.source)?.data]), node.data.kind === 'package' ? packages.find(item => item.id === node.data.package_id) : null]);
    if (previous && previous._node === node && (nodeActionPress.preserves(previous, node) || previous._signature === signature || previous.contains(document.activeElement) && document.activeElement.matches('input,textarea,select,[contenteditable=true]'))) {
      previous.style.left = `${node.x}px`; previous.style.top = `${node.y}px`; previous.classList.toggle('selected', selected.has(node.id));
      if (nodesLayer.children[index] !== previous) nodesLayer.insertBefore(previous, nodesLayer.children[index] || null);
      return;
    }
    const card = el('article', `node node-${node.type}${selected.has(node.id) ? ' selected' : ''}`);
    card._node = node; card._signature = signature;
    card.id = `fw-node-${node.id}`; card.dataset.nodeId = node.id; card.style.left = `${node.x}px`; card.style.top = `${node.y}px`;
    card.setAttribute('aria-label', `${node.data.title} 节点`);
    const header = el('div', 'node-header');
    header.append(el('span', 'node-badge', { prompt: 'T', reference: '▧', generation: node.data.kind?.startsWith('h3') ? '▷' : '✧', result: '▣' }[node.type]), el('span', 'node-title', node.data.title), el('span', 'node-index', String(index + 1).padStart(2, '0')));
    card.append(header);
    const body = el('div', 'node-body');
    if (node.type === 'prompt') {
      const text = el('textarea', 'node-textarea'); text.value = node.data.text; text.placeholder = '描述画面、主体、镜头与运动…'; text.setAttribute('aria-label', `${node.data.title} 内容`);
      bindDraft(text, value => mutate(() => { node.data.text = value; }, { inspector: false }));
      text.addEventListener('change', () => mutate(() => { node.data.text = text.value; }, { inspector: false }));
      body.append(text); card.append(body);
      const footer = el('div', 'node-footer'); footer.append(el('span', '', `${node.data.text.length} 字 · 可连接多个生成节点`), button('复制提示词 ↗', 'node-action', () => copyText(node.data.text))); card.append(footer, port(node, 'output'));
    } else if (node.type === 'generation') {
      const pack = node.data.kind === 'package' ? packages.find(item => item.id === node.data.package_id) : null;
      if (node.data.kind === 'package') {
        card.classList.add('node-package');
        const view = packageNodePresentation(node, pack);
        const overview = el('div', 'package-node-overview');
        overview.append(el('span', 'package-node-kind', '工作流包'), el('strong', 'package-node-name', view.name));
        const counts = el('div', 'package-node-counts'); counts.append(el('span', '', view.inputs), el('span', '', view.outputs)); overview.append(counts);
        body.append(overview);
        if (node.data.editor_id && !pack) {
          body.append(button('提取外层参数', 'button primary prepare-workflow', () => nativeEditor.prepare(node)), button('复用已保存配置', 'button quiet reuse-workflow', () => workflowConfigurations.choose(node)));
        }
        const actions = el('div', 'package-node-actions');
        actions.append(button(!node.data.package_id && !node.data.editor_id ? '选择工作流' : '进入工作流 ↗', 'button quiet enter-workflow', () => openNodeWorkflow(node)));
        if (pack) actions.append(button('管理外部接口', 'button quiet manage-package-interface', () => configurePackageInterface(node)));
        actions.append(editorMediaSyncButton(node));
        body.append(actions, el('p', 'package-node-hint', view.hint));
        inputPorts(node, body);
        if (pack?.description) { const description = el('p', 'node-prompt-summary package-node-description', pack.description); description.title = pack.description; body.append(description); }
      } else {
        inputPorts(node, body);
        const labels = el('div', 'port-label'); labels.append(el('span', '', 'INPUT / 提示词与参考'), el('span', '', 'OUTPUT'));
        body.append(labels, el('span', 'model-chip', node.data.kind.startsWith('h3') ? 'MiniMax H3 · 本地推理' : node.data.kind === 'api' ? 'API 工作流 · 高级' : `${node.data.kind.startsWith('qwen21_') ? 'Qwen Image 2.1' : node.data.kind === 'krea' ? 'Krea 2' : 'SDXL'} · 本地推理`));
        const summary = el('div', 'generation-summary');
        const stats = node.data.kind === 'api' ? [['工作流', '已导入 API'], ['节点', Object.keys(node.data.apiPrompt || {}).length], ['执行', '本地引擎'], ['编辑', '原始 JSON']] : [['尺寸', `${node.data.width} × ${node.data.height}`], ['模式', node.data.kind.startsWith('h3') ? `${node.data.seconds}s · ${node.data.fps}fps` : '静态图像'], ['采样步数', node.data.steps], ['种子', node.data.seed]];
        stats.forEach(([name, value]) => { const stat = el('div', 'stat'); stat.append(el('span', '', name), el('strong', '', value)); summary.append(stat); });
        body.append(summary);
        let prompt = ''; try { prompt = generationPayload(graph, node.id).positive; } catch { /* API import has no prompt yet. */ }
        body.append(el('p', 'node-prompt-summary', node.data.kind === 'api' ? '保留原始 ComfyUI API 节点与参数，按完整工作流执行。' : prompt || '连接提示词节点，或在右侧填写画面描述。'));
        body.append(button('↗  进入工作流', 'button quiet enter-workflow', () => openNodeWorkflow(node)), editorMediaSyncButton(node));
      }
      const run = button(submitting.has(node.id) ? '正在提交…' : '▷  开始生成', 'button primary run-node', () => runNode(node.id)); run.disabled = submitting.has(node.id) || workflowCanvas?.isRunning() || node.data.kind==='package' && !node.data.package_id; run.dataset.runNode = node.id;
      const live = el('div','node-live-progress'); live.dataset.liveNode = node.id; live.hidden = true;
      const detail = el('p','live-detail'); const bar = el('progress'); bar.max = 100; bar.setAttribute('aria-label','当前节点采样进度'); const img = el('img','live-preview'); img.alt = '采样中间预览，尚未完成'; img.hidden = true;
      live.append(detail,bar,img,el('small','live-preview-status')); body.append(run,live); card.append(body);
      const footer = el('div', 'node-footer');
      const status = el('span', 'node-status', '○ 等待提交'); status.dataset.nodeStatus = node.id;
      footer.append(status, button('检查环境', 'node-action', () => runDiagnostics(node))); card.append(footer, ...(node.data.kind==='package'||generationInputPorts(node,graph).length ? [] : [port(node,'input')]), port(node, 'output'));
    } else if (node.type === 'reference') {
      const pending = referenceImports.get(node.id);
      if (pending?.previewURL) { const media = el(['video','audio'].includes(pending.mediaType) ? pending.mediaType : 'img', 'reference-media'); media.src = pending.previewURL; media.draggable = false; if (['video','audio'].includes(pending.mediaType)) { media.controls = true; media.preload = 'metadata'; } body.append(media); }
      else if (node.data.url) { const media = outputMedia({ url: node.data.url, type: node.data.mediaType, filename: node.data.localFilename || node.data.name }, 'reference-media', ['video','audio'].includes(node.data.mediaType)); media.draggable = false; body.append(media); }
      else { const drop = button('', 'reference-drop', () => chooseReference(node.id)); drop.append(el('span', 'large', node.data.name ? '▧' : '＋'), el('span', '', node.data.name ? '已复用素材引用 · 点击更换' : '点击选素材，或拖到这里'), el('span', 'field-help', node.data.name ? '运行前确认原引擎仍保留此素材' : '图片 / 视频 / 音频 · 可离线预览')); body.append(drop); }
      body.append(el('div', 'reference-name', node.data.localFilename || node.data.name || '图片 / 音频 20 MiB · 视频 200 MiB'));
      const importState = referenceImports.get(node.id);
      if (importState?.message) body.append(el('p', `reference-import-state${importState.error ? ' error' : ''}`, importState.message));
      else if (node.data.localAssetId) body.append(el('p', 'reference-import-state', node.data.name && node.data.uploadBackend === settings.backend_url
        ? '本地副本已保存 · 已传入当前引擎' : '素材已保存在客户端 · 生成时自动传入引擎'));
      if (importState?.error && (node.data.localAssetId || node.data.name)) body.append(button('保留原素材', 'button quiet', () => { referenceImportTickets.delete(node.id); referenceImports.delete(node.id); renderNodes(); }));
      card.append(body);
      const footer = el('div', 'node-footer'); footer.append(el('span', '', node.data.mediaType === 'audio' ? '音频参考' : node.data.mediaType === 'video' ? '视频参考' : { start: '首帧参考', end: '尾帧参考', reference: '角色 / 场景参考' }[node.data.role] || '参考素材'), button('更换素材', 'node-action', () => chooseReference(node.id))); card.append(footer, port(node, 'output'));
    } else {
      const outputs = Array.isArray(node.data.outputs) ? node.data.outputs : [];
      if (outputs.length) {
        body.append(outputMedia(outputs[0], {video:'output-video',audio:'output-audio',image:'output-image'}[outputs[0].type] || 'output-image'));
        const caption = el('div', 'output-caption'); caption.append(el('span', '', `${{video:'VIDEO',audio:'AUDIO',image:'IMAGE'}[outputs[0].type] || 'MEDIA'} · 本地输出`), button(outputs[0].type === 'image' ? '大图预览 ↗' : '播放预览 ↗', 'node-action', () => preview(outputs[0]))); body.append(caption);
        if (outputs[0].type === 'image') {
          const edit = el('div','inspector-actions'); edit.append(button('接入 Qwen 多图编辑','button quiet compact',()=>editOutput(node,outputs[0],'qwen21_edit')),button('接入重绘','button quiet compact',()=>editOutput(node,outputs[0],'sdxl_i2i'))); body.append(edit);
        }
        body.append(button('传入工作流…', 'button quiet compact', () => passResultToWorkflow(node, outputs[0])));
        if (outputs.length > 1) body.append(button(`查看全部 ${outputs.length} 个输出 →`, 'node-action', () => switchTab('jobs')));
      } else {
        const placeholder = el('div', 'output-placeholder'), headline = el('strong', '', '等待生成产物'), detail = el('p', '', '连接生成节点并运行，图片、视频与音频将在这里呈现。');
        headline.dataset.resultHeadline = node.data.jobId; detail.dataset.resultDetail = node.data.jobId;
        placeholder.append(el('span', 'empty-icon', '▻'), headline, detail); body.append(placeholder);
        const caption = el('div', 'output-caption'), state = el('span', '', '未生成'); state.dataset.resultStatus = node.data.jobId;
        caption.append(el('span', '', 'OUTPUT / 本地媒体'), state); body.append(caption);
      }
      card.append(body); const footer = el('div', 'node-footer'); footer.append(el('span', '', node.data.jobId ? `任务 ${node.data.jobId.slice(0, 8)}` : '结果会自动保存到本机'), el('span', '', '图片 / 视频 / 音频')); card.append(footer, port(node, 'input'), port(node, 'output'));
    }
    if (previous) { releaseMedia(previous); previous.replaceWith(card); }
    if (nodesLayer.children[index] !== card) nodesLayer.insertBefore(card, nodesLayer.children[index] || null);
  });
  remaining.forEach(card => { releaseMedia(card); card.remove(); });
  $('#node-count').textContent = `${graph.nodes.length} 个节点`;
  $('#canvas-empty').hidden = !!graph.nodes.length;
  updateCanvasActions();
  updateNodeJobStatus();
  workflowCanvas?.refresh();
  contentLayout?.rendered();
  requestAnimationFrame(renderEdges);
}
function renderSelection() {
  document.querySelectorAll('.node').forEach(node => node.classList.toggle('selected', selected.has(node.dataset.nodeId)));
  document.querySelectorAll('.port.output').forEach(element => element.classList.toggle('armed', connecting?.source === element.closest('.node').dataset.nodeId));
  drawMinimap();
  updateCanvasActions();
}
function editNode(id, key, value, refreshInspector = false) { mutate(() => { const node = getNode(id); if (node) node.data[key] = value; }, { inspector: refreshInspector }); }
function bindDraft(input, change, number = false) {
  let session = { recorded: false };
  input.addEventListener('focus', () => { session = { recorded: false }; });
  input.addEventListener('input', () => {
    if (input.readOnly || number && (input.value === '' || !input.checkValidity())) return;
    draftEditing = session;
    try { change(number ? Number(input.value) : input.value); } finally { draftEditing = null; }
  });
  input.addEventListener('blur', () => { if (input.closest('#nodes')) queueMicrotask(renderNodes); });
}
function field(label, value, onChange, options = {}) {
  const wrapper = el('label', 'field'); wrapper.append(el('span', '', label));
  if (options.help) wrapper.append(el('span', 'field-help', options.help));
  const input = el(options.multiline ? 'textarea' : options.select ? 'select' : 'input');
  input.setAttribute('aria-label', label);
  if (options.select) {
    options.select.forEach(option => { const item = el('option', '', typeof option === 'string' ? option : option.label); item.value = typeof option === 'string' ? option : option.value; item.disabled = typeof option === 'object' && !!option.disabled; input.append(item); });
  } else if (!options.multiline) input.type = options.number ? 'number' : 'text';
  if (options.multiline) input.rows = options.rows || 4;
  if (options.readonly) input.readOnly = true;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.min !== undefined) input.min = String(options.min);
  if (options.max !== undefined) input.max = String(options.max);
  if (options.step !== undefined) input.step = String(options.step);
  input.value = value ?? '';
  let acceptedValue = input.value;
  const commit = next => {
    try {
      if (onChange(next) === false) {
        if (options.number && !draftEditing) input.value = acceptedValue;
        return;
      }
      if (options.number) acceptedValue = String(next);
    } catch (error) {
      if (options.number) input.value = acceptedValue;
      if (!draftEditing) reportError(error);
    }
  };
  if (!options.select && options.live !== false) bindDraft(input, commit, !!options.number);
  input.addEventListener('change', () => {
    if (input.readOnly || input.disabled) return;
    const next = options.number ? Number(input.value) : input.value;
    if (options.number && (input.value.trim() === '' || !Number.isFinite(next) || !input.checkValidity())) { toast(`「${label}」请输入范围内的数字，已恢复上次有效值`, true); input.value = acceptedValue; return; }
    commit(next);
  });
  wrapper.append(input); return wrapper;
}
function section(container, label, index) { const heading = el('div', 'section-label'); heading.append(el('span', '', label), el('span', 'section-index', index)); container.append(heading); }
function catalog(key, kind) {
  let values = engine.models?.[key] || (key === 'checkpoint' ? engine.models?.checkpoints : []) || [];
  if (key === 'lora' && engine.generation_options?.lora_loaders) {
    const loaders = engine.generation_options.lora_loaders;
    const names = kind.startsWith('sdxl') ? ['LoraLoader'] : ['LoraLoaderModelOnly', 'LoraLoaderBypassModelOnly'];
    values = names.flatMap(name => loaders[name]?.names || []);
  }
  values = values.map(value => typeof value === 'string' ? value : value?.name).filter(Boolean);
  values = [...new Set(values)];
  const lower = value => value.toLowerCase().replaceAll('\\', '/');
  const prefer = predicate => [...values.filter(predicate), ...values.filter(value => !predicate(value))];
  if (kind.startsWith('qwen21_')) {
    const families = engine.generation_options?.model_families?.[key] || {};
    return values.filter(value => !families[value] || ['unknown', 'qwen21'].includes(families[value]));
  }
  if (kind.startsWith('h3')) {
    if (key === 'dit') return prefer(value => /h3/i.test(value) && (kind === 'h3_ref' ? /ref/i.test(value) : /fl2v|fl2va|t2v/i.test(value)) && !/lora|turbo_4step|turbo_8step/i.test(value));
    if (key === 'text_encoder') return prefer(value => /minimax_h3|qwen3vl[_-]?32b|qwen3[_-]vl[_-]?32b/.test(lower(value)));
    if (key === 'vae') return prefer(value => /minimax_h3.*video|h3.*video.*vae|h3.*vae.*video/.test(lower(value)));
    if (key === 'audio_vae') return prefer(value => /h3.*audio|audio.*h3/.test(lower(value)));
    if (key === 'lora') return prefer(value => /h3/.test(lower(value)) && !(kind === 'h3_ref' ? /fl2v/.test(lower(value)) : /ref2v/.test(lower(value))));
  }
  if (kind === 'krea') {
    if (key === 'dit') return prefer(value => /krea2|krea_2/.test(lower(value)) && !/lora/.test(lower(value)));
    if (key === 'text_encoder') return prefer(value => /qwen3vl[_-]?4b|qwen3[_-]vl[_-]?4b/.test(lower(value)));
    if (key === 'vae') return prefer(value => /qwen_image|qwen.*vae/.test(lower(value)));
    if (key === 'lora') return prefer(value => /krea/.test(lower(value)));
  }
  if (kind.startsWith('sdxl') && key === 'lora') return prefer(value => /sdxl|pony|illustrious|noob|\bxl\b/.test(lower(value)));
  return values;
}
function modelField(node, label, key) {
  const values = catalog(key, node.data.kind);
  const current = node.data.models?.[key] || '';
  if (current && !values.includes(current)) values.unshift(current);
  return field(label, current, value => mutate(() => { node.data.models = { ...node.data.models, [key]: value }; }, { inspector: false }), { select: [{ value: '', label: key === 'lora' ? '不使用 LoRA' : '自动匹配可用模型' }, ...values.map(value => ({ value, label: key === 'lora' ? `${/turbo|lightning|lcm|hyper|\d[_-]?step/i.test(value) ? '加速' : '风格 / 适配'} · ${value}` : value }))], help: values.length ? `${values.length} 个可选模型` : '连接引擎后读取模型目录' });
}
const interfaceViews = new WeakMap();
function interfaceViewState(owner, name) {
  let views = interfaceViews.get(owner);
  if (!views) { views = new Map(); interfaceViews.set(owner, views); }
  if (!views.has(name)) views.set(name, { page: 0, query: '' });
  return views.get(name);
}
function appendInterfacePager(container, page, name, onPage) {
  if (page.pages <= 1) return;
  const controls = el('div', 'inspector-actions');
  const previous = button(`${name}上一页`, 'button quiet compact', () => onPage(page.page - 1)); previous.disabled = page.page === 0;
  const next = button(`${name}下一页`, 'button quiet compact', () => onPage(page.page + 1)); next.disabled = page.page === page.pages - 1;
  controls.append(previous, el('span', 'field-help', `${page.page + 1}/${page.pages} 页 · ${page.total} 项`), next);
  container.append(controls);
}
function renderInterfaceList(container, items, state, name, renderItem, extraActions = null) {
  const toolbar = el('div');
  const search = el('input', 'field-input'); search.type = 'search'; search.value = state.query;
  search.placeholder = '搜索名称、ID、节点或输入…'; search.setAttribute('aria-label', `搜索${name}`);
  const count = el('p', 'form-note'), rows = el('div');
  const refresh = () => {
    rows.replaceChildren();
    const matching = interfaceSearch(items, state.query), page = interfacePage(matching, state.page); state.page = page.page;
    count.textContent = `筛选 ${matching.length}/${items.length} 项 · 每页最多 ${INTERFACE_PAGE_SIZE} 项`;
    appendInterfacePager(rows, page, name, number => { state.page = number; refresh(); });
    if (!matching.length) rows.append(el('p', 'form-note', '没有匹配的输入。'));
    for (const item of page.items) renderItem(item, rows);
  };
  search.addEventListener('input', () => { state.query = search.value; state.page = 0; refresh(); });
  if (items.length > INTERFACE_PAGE_SIZE) toolbar.append(search, count);
  if (extraActions) extraActions(toolbar, () => interfaceSearch(items, state.query), refresh);
  container.append(toolbar, rows); refresh();
}
function renderInputPortSettings(wrap, node) {
  const connectedPorts = graph.edges.filter(edge => edge.target === node.id).map(edge => edgeInputField(graph, edge));
  const ports = inputPortCandidates(generationInputPorts(node,graph), connectedPorts);
  if (!ports.length) return;
  const details=el('details','input-port-settings'); details.append(el('summary','',`输入端口用途与连接 · ${ports.length} 项`));
  renderInterfaceList(details, ports, interfaceViewState(node, 'purposes'), '输入用途', (port, area) => {
    const edges = graph.edges.filter(e=>e.target===node.id&&edgeInputField(graph,e)===port.id);
    const row=field(port.label,port.label,value=>mutate(()=>{node.data.inputLabels={...(node.data.inputLabels||{})};if(value.trim())node.data.inputLabels[port.id]=value.trim().slice(0,80);else delete node.data.inputLabels[port.id];}),{help:edges.length?`来自 ${edges.map(edge=>`${getNode(edge.source)?.data.title || '来源已缺失'}${edge.sourceField === 'negative' ? '（负向）' : ''}${Number.isSafeInteger(edge.sourceOccurrence) && edge.sourceOccurrence > 0 ? `（第${edge.sourceOccurrence + 1}次引用）` : ''}`).join('、')}；此名称只说明用途，不会改变工作流本身的输入顺序。`:port.type==='text'?'可为文本入口命名；只改变显示名称，不改变内部绑定。':'可命名为场景参考、人物参考等；请在提示词中明确各素材用途。'});
    if(edges.length) row.append(button(edges.length>1?'断开此输入的全部连接':'断开此输入','node-action',()=>mutate(()=>removeEdges(graph,edges.map(edge=>edge.id)))));area.append(row);
  });
  wrap.append(details);
}
function packageMediaPreview(node, definition, value) {
  const owner = node.data.packageMediaBackends?.[definition.id], type = fieldType(definition);
  if (!['image', 'audio', 'video'].includes(type) || !owner || owner.name !== value ||
      owner.backend !== settings.backend_url || !/^\/api\/media\/[a-f0-9]{32}$/.test(owner.preview_url || '')) return null;
  const url = mediaURL(owner.preview_url);
  return url ? { type, url, filename: value } : null;
}
function watchPackageSidebar(panel) {
  let guard = sidebarRefreshGuards.get(panel);
  if (guard) return guard;
  guard = { pressed: null, pending: new Map() }; sidebarRefreshGuards.set(panel, guard);
  panel.addEventListener('pointerdown', event => { if (event.button === 0) guard.pressed = event.pointerId; }, true);
  const release = event => {
    if (guard.pressed === null || event?.pointerId != null && event.pointerId !== guard.pressed) return;
    guard.pressed = null;
    // Native click follows pointerup synchronously; do not rebuild its target in a microtask.
    requestAnimationFrame(() => {
      const pending = [...guard.pending]; guard.pending.clear();
      for (const [node, loading] of pending) refreshPackageSidebar(node, loading);
    });
  };
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', () => release(), true);
  return guard;
}
function refreshPackageSidebar(node, loading) {
  if (sidebarPackageLoads.get(node) !== loading || currentCanvasIdentity() !== loading.identity ||
      getNode(node.id) !== node || node.data.package_id !== loading.packageId || singleSelected() !== node) return;
  const panel = $('#properties-panel'), active = document.activeElement;
  const guard = watchPackageSidebar(panel);
  if (guard.pressed !== null) { guard.pending.set(node, loading); return; }
  if (panel.contains(active) && active?.matches?.('input,textarea,select,[contenteditable=true]')) {
    if (!loading.refreshDeferred) {
      loading.refreshDeferred = true;
      panel.addEventListener('focusout', () => {
        loading.refreshDeferred = false;
        requestAnimationFrame(() => refreshPackageSidebar(node, loading));
      }, { once: true });
    }
    return;
  }
  renderInspector();
}
function renderPackageInputs(wrap, node) {
  const identity = currentCanvasIdentity(), packageId = node.data.package_id;
  if (activeSidebarPackage && (activeSidebarPackage.node !== node || activeSidebarPackage.identity !== identity || activeSidebarPackage.packageId !== packageId)) activeSidebarPackage = null;
  const pack = packageCatalog.peek(packageId) || activeSidebarPackage?.full;
  if (!pack && packageId) {
    watchPackageSidebar($('#properties-panel'));
    let loading = sidebarPackageLoads.get(node);
    if (!loading || loading.identity !== identity || loading.packageId !== packageId || loading.status === 'ready') {
      loading = { identity, packageId, status: 'loading', error: '' }; sidebarPackageLoads.set(node, loading);
      ensurePackageDefinition(packageId).then(full => {
        if (sidebarPackageLoads.get(node) !== loading) return;
        loading.status = 'ready';
        if (currentCanvasIdentity() === identity && getNode(node.id) === node && node.data.package_id === packageId && singleSelected() === node) {
          if (!packageCatalog.peek(packageId)) activeSidebarPackage = { node, identity, packageId, full };
          refreshPackageSidebar(node, loading);
        }
      }).catch(error => {
        if (sidebarPackageLoads.get(node) !== loading) return;
        loading.status = 'error'; loading.error = error.message || '读取失败';
        refreshPackageSidebar(node, loading);
      });
    }
    wrap.append(el('p', 'model-note', loading.status === 'error' ? `无法读取完整工作流定义：${loading.error}` : '正在按需读取完整工作流参数…已有画布接口仍保留。'));
    if (loading.status === 'error') wrap.append(button('重试读取工作流参数', 'button quiet', () => { sidebarPackageLoads.delete(node); renderInspector(); }));
    wrap.append(button('进入工作流 · 修复', 'button quiet', () => openNodeWorkflow(node)), button('导入对应工作流包', 'button quiet', openPackages));
    return;
  }
  const tools = el('details', 'workflow-configuration-tools');
  tools.append(el('summary', '', '工作流结构 · 保存与复用配置'));
  if (node.data.editor_id) {
    if (!pack) {
      wrap.append(el('p', 'model-note', '此原生文件尚未建立外层参数。可直接提取控件，或使用已保存的完整配置；不需要先生成一次。'),
        button('提取外层参数', 'button primary prepare-workflow', () => nativeEditor.prepare(node)),
        button('复用已保存配置', 'button quiet reuse-workflow', () => workflowConfigurations.choose(node)),
        button('进入内部编辑 · 修复结构', 'button quiet', () => nativeEditor.open(node)));
      return;
    }
    tools.append(button('↗ 进入工作流 · 内部调参', 'button quiet', () => nativeEditor.open(node)));
    if (pack) tools.append(button('配置外层参数与输出', 'button quiet', () => configureNativePanel(node)));
  }
  if (!pack) {
    wrap.append(el('p', 'model-note', packagesLoaded ? '本机包库中没有对应工作流包。请导入原来的包文件；相同内容会恢复画布关联。' : '正在读取本机工作流包库…'));
    wrap.append(button('导入对应工作流包', 'button quiet', openPackages));
    return;
  }
  tools.append(el('p', 'model-note', pack.description || '填写以下输入，整套工作流将在本地推理引擎中执行。'));
  const actions = el('div', 'inspector-actions'); actions.append(button('保存此工作流配置', 'button quiet save-workflow-configuration', () => workflowConfigurations.save(node)), button('我的工作流配置', 'button quiet', () => workflowConfigurations.choose()), button('导出此工作流包', 'button quiet', () => exportPackage(pack.id))); tools.append(actions); wrap.append(tools);
  section(wrap, '工作流输入', `${pack.fields.length} / INPUTS`);
  if (!pack.fields.length) wrap.append(el('p', 'form-note', '此包使用固定参数，可以直接检查环境并运行。'));
  const values = { ...defaultValues(pack.fields), ...(node.data.packageValues || {}) };
  renderInterfaceList(wrap, pack.fields, interfaceViewState(node, 'package-inputs'), '工作流参数', (definition, area) => {
    const type = fieldType(definition), value = values[definition.id];
    const label = `${definition.label || definition.input}${definition.required ? ' *' : ''}`;
    const owner = packageMediaOwner(node);
    const change = (raw, mediaBackend = '', previewURL = '') => {
      try {
        const next = coerceFieldValue(definition, raw);
        mutate(() => {
          node.data.packageValues = { ...(node.data.packageValues || {}), [definition.id]: next };
          if (['image', 'audio', 'video'].includes(type)) {
            node.data.packageMediaBackends = { ...(node.data.packageMediaBackends || {}) };
            if (mediaBackend) {
              const record = { name: next, backend: mediaBackend };
              if (mediaBackend === settings.backend_url && /^\/api\/media\/[a-f0-9]{32}$/.test(previewURL) && mediaURL(previewURL)) record.preview_url = previewURL;
              node.data.packageMediaBackends[definition.id] = record;
            }
            else delete node.data.packageMediaBackends[definition.id];
          }
        }, { inspector: false });
        packageMediaTransfers.discard(packageMediaOwner(node), definition.id);
        return true;
      } catch (error) { if (!draftEditing) { reportError(error); renderInspector(); } return false; }
    };
    let control;
    if (type === 'boolean') {
      control = el('label', 'field package-boolean');
      const input = el('input'); input.type = 'checkbox'; input.checked = value === true; input.setAttribute('aria-label', label); input.addEventListener('change', () => change(input.checked));
      control.append(input, el('span', '', label));
    } else if (type === 'select') {
      const selection = selectFieldState(definition, value);
      if (selection.state === 'empty' || selection.state === 'unproven') {
        control = field(label, selection.currentLabel, () => false, { readonly: true, live: false, help: selection.help });
      } else {
        const choices = selection.state === 'stale'
          ? [{ value: 'preserved', label: `${selection.currentLabel} · 当前名称不可用`, disabled: true }, ...selection.choices]
          : selection.choices;
        control = field(label, selection.selectedIndex < 0 ? 'preserved' : String(selection.selectedIndex), selectedIndex => {
          if (!/^(0|[1-9]\d*)$/.test(selectedIndex) || Number(selectedIndex) >= definition.options.length) return false;
          return change(definition.options[Number(selectedIndex)]);
        }, { select: choices, help: selection.help });
      }
    } else if (type === 'video' || type === 'audio') {
      const mediaName = type === 'audio' ? '音频' : '视频';
      control = field(label,value,change,{help:type === 'audio' ? '可连接画布的音频素材，或选择 WAV / MP3 / FLAC / OGG（最大 20 MiB）。' : '可从画布的视频素材节点连接，或选择 MP4 / WebM / MOV（最大 200 MiB）。'});
      const input=el('input');input.type='file';input.accept=type === 'audio' ? '.wav,.mp3,.flac,.ogg' : '.mp4,.webm,.mov';input.hidden=true;
      const upload=button(`选择参考${mediaName}`,'button quiet compact',()=>input.click());
      input.addEventListener('change',()=>{
        const file=input.files?.[0];input.value='';if(!file)return;upload.disabled=true;
        const identity=currentCanvasIdentity(), packageId=node.data.package_id, backend=settings.backend_url;
        const ticket=packageMediaTransfers.start(owner,definition.id,label);renderInspector();
        (async()=>{const asset=await storeLocalMedia(file);if(asset.media_type!==type)throw new Error(`请选择${mediaName}素材`);
          const uploaded=await api(`/api/assets/media/${asset.asset_id}/backend-input`,{package_id:packageId,field_id:definition.id});
          if(!packageMediaTransfers.current(ticket))return;
          if(identity!==currentCanvasIdentity()||getNode(node.id)!==node||node.data.package_id!==packageId||backend!==settings.backend_url||uploaded.backend!==backend)throw new Error('工作流或引擎已变化，本次素材已保存在本地，请重新选择');
          if(change(uploaded.name,uploaded.backend,uploaded.url)===false)throw new Error('媒体字段校验未通过，请重新选择或保留原值');renderInspector();toast(`${mediaName}已接入此工作流输入`);
        })().catch(error=>{packageMediaTransfers.fail(ticket,error);reportError(error);renderInspector();}).finally(()=>{upload.disabled=false;});
      });control.append(upload,input);
    } else if (type === 'image') {
      control = field(label, value, change, { help: '上传 PNG / JPG / WebP，或使用后端已有的相对文件名。' });
      const input = el('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.hidden = true;
      const upload = button('选择本地参考图', 'button quiet compact', () => input.click());
      input.addEventListener('change', () => {
        const file = input.files?.[0]; input.value = ''; if (!file) return;
        upload.disabled = true;
        const identity=currentCanvasIdentity(), packageId=node.data.package_id, backend=settings.backend_url;
        const ticket=packageMediaTransfers.start(owner,definition.id,label);renderInspector();
        uploadImage(file).then(uploaded => {
          if (!packageMediaTransfers.current(ticket)) return;
          if (identity!==currentCanvasIdentity() || getNode(node.id)!==node || node.data.package_id!==packageId || settings.backend_url!==backend || backend!==uploaded.backend) throw new Error('上传期间工作流或引擎发生了变化，本次媒体未应用。请重新选择。');
          if(change(uploaded.name, uploaded.backend, uploaded.url)===false)throw new Error('媒体字段校验未通过，请重新选择或保留原值'); renderInspector(); toast('参考素材已保存到本地推理服务');
        }).catch(error => { packageMediaTransfers.fail(ticket,error);reportError(error);renderInspector(); }).finally(() => { upload.disabled = false; });
      });
      control.append(upload, input);
    } else {
      control = field(label, value, change, { multiline: type === 'text', rows: 3, number: ['integer', 'number'].includes(type), min: definition.min, max: type === 'integer' ? Math.min(Number.MAX_SAFE_INTEGER, definition.max ?? Number.MAX_SAFE_INTEGER) : definition.max, step: type === 'integer' ? 1 : 'any' });
    }
    control.dataset.packageField = definition.id;
    const uploadedPreview = packageMediaPreview(node, definition, value);
    if (uploadedPreview) {
      const media = outputMedia(uploadedPreview, 'reference-image', true);
      media.style.maxWidth = '100%'; media.style.maxHeight = '180px'; media.style.objectFit = 'contain';
      const success = el('small', 'field-help', '已上传并接入工作流 · 可预览当前素材'); success.setAttribute('role', 'status');
      control.append(media, success);
    }
    const mapping = el('span', 'field-help package-mapping', `节点 ${definition.node_id} · ${definition.input}`); control.append(mapping);
    let textOptions;
    if (['text', 'image', 'video', 'audio'].includes(type)) {
      const connected = workflowCanvas?.describeInput(node.id, definition), connections = el('div', 'workflow-field-link');
      const composition = type === 'text' && node.data.packageTextCompositions?.[definition.id];
      if (connected) {
        if (!composition) control.querySelectorAll('input,textarea,select,button').forEach(input => { input.disabled = true; });
        const edges = connected.edges || [connected.edge];
        connections.append(el('span', '', `已连接：${connected.text}；${composition ? '依次拼接连线文字，再追加上方自身文本' : '运行时使用连线值'}`), button(edges.length > 1 ? '断开全部' : '断开', 'button quiet', () => mutate(() => removeEdges(graph,edges.map(edge => edge.id)))));
      } else connections.append(el('span', '', '可从画布连接输入'), button('连接来源', 'button quiet', () => workflowCanvas.connectNodes('', node.id, definition.id)));
      control.append(connections);
      if (type === 'text') {
        const options = el('details', 'text-composition-options'); options.append(el('summary', '', '连线文本处理'));
        options.append(field(`${label} · 合并方式`, composition || 'replace', mode => {
          if (mode === 'replace' && (connected?.edges || (connected ? [connected.edge] : [])).length > 1) { toast('此字段有多个文本来源，请先保留一条连接，再改为替换模式', true); renderInspector(); return; }
          mutate(() => {
            node.data.packageTextCompositions = { ...(node.data.packageTextCompositions || {}) };
            if (mode === 'replace') delete node.data.packageTextCompositions[definition.id];
            else { node.data.packageTextCompositions[definition.id] = mode; node.data.packageValues = { ...(node.data.packageValues || {}), [definition.id]: value }; }
          }); renderInspector();
        }, { select: [{value:'replace',label:'连线替换自身文本'}, {value:'paragraphs',label:'按段落拼接 + 自身文本'}, {value:'comma',label:'按逗号拼接 + 自身文本'}], help:'拼接按连接顺序进行，跳过空文本，自身文本最后加入；多条线分别可在画布选中后删除。' }));
        textOptions = options;
      }
    }
    const transfer = packageMediaTransfers.state(owner, definition.id);
    if (transfer) {
      control.append(el('small', 'field-help', transfer.status === 'pending' ? '正在上传，完成前不会提交旧素材。' : `上传失败：${transfer.error}`));
      control.append(button(transfer.status === 'pending' ? '取消应用，保留原值' : '保留原值', 'button quiet', () => { packageMediaTransfers.discard(owner,definition.id);renderInspector(); }));
    }
    area.append(control);
    if (textOptions) area.append(textOptions);
  });
}
async function loadPackages({ force = false } = {}) {
  const [summaries, editors] = await Promise.all([packageCatalog.refresh({ force }), api('/api/editor-workflows')]);
  editorLibrary = editors.workflows || [];
  packages = packageCatalog.summaries();
  packagesLoaded = true;
  activeSidebarPackage = null;
  // Summary refresh never replaces cached canvas fields or writes the user's graph.
  renderPackageLibrary(); renderNodes();
  if (singleSelected()?.data?.kind === 'package' && !$('#properties-panel').contains(document.activeElement)) renderInspector();
}
function renderPackageLibrary() {
  const list = $('#package-list'); list.replaceChildren();
  if (!packages.length && !editorLibrary.length) { $('#package-library-count').textContent = '0 个工作流'; list.append(el('div', 'package-empty', packagesLoaded ? '导入原生 ComfyUI 工作流或 API JSON，开始构建可复用节点。' : '正在读取工作流包…')); return; }
  const filtered = filterPackages(packages, $('#package-scope').value, $('#package-search').value);
  $('#package-library-count').textContent = `${filtered.length} / ${packages.length} 个工作流包 · ${editorLibrary.length} 个原生工作流`;
  for (const entry of editorLibrary.filter(item => $('#package-scope').value === 'library' && item.name.toLowerCase().includes($('#package-search').value.toLowerCase()))) {
    const card = el('article', 'package-card'); card.append(el('span', 'eyebrow', 'NATIVE WORKFLOW'), el('h3', '', entry.name), el('p', 'muted', `${entry.nodes} 个节点 · 保留内部控件、分组和旁路状态`));
    card.append(button('添加到画布 · 提取参数', 'button primary', async event => {
      if (event?.detail > 1) return;
      const node = await addPackageNode({ name: entry.name, id: '', fields: [] });
      mutate(() => { node.data.editor_id = entry.id; });
      await nativeEditor.prepare(node);
    })); list.append(card);
  }
  if (!filtered.length) list.append(el('div', 'package-empty', '没有符合当前筛选的工作流包。可以清空搜索或切换到其他分类。'));
  for (const pack of filtered) {
    const card = el('article', 'package-card');
    card.dataset.packageId = pack.id;
    const heading = el('div', 'package-heading');
    const favorite = button(pack.favorite ? '★ 已收藏' : '☆ 收藏', `package-favorite${pack.favorite ? ' active' : ''}`, () => organizePackage(pack.id, { favorite: !pack.favorite }));
    favorite.setAttribute('aria-pressed', String(pack.favorite === true)); favorite.disabled = organizingPackages.has(pack.id);
    heading.append(el('span', 'eyebrow', pack.archived ? 'ARCHIVED WORKFLOW' : 'LOCAL WORKFLOW'), favorite);
    card.append(heading, el('h3', '', pack.name), el('p', 'muted', pack.description || '可复用的本地图片 / 视频工作流'));
    const meta = el('div', 'package-card-meta'); meta.append(el('span', '', `${pack.field_count ?? '待确认'} 个可填输入`), el('span', 'inline-code', String(pack.id).slice(0, 14))); card.append(meta);
    const actions = el('div', 'inspector-actions'); actions.append(button('添加到画布', 'button primary', event => event?.detail > 1 ? null : addPackageNode(pack)), button('导出包', 'button quiet', () => exportPackage(pack.id))); card.append(actions);
    const archive = button(pack.archived ? '恢复到包库' : '归档', 'text-link package-archive', () => organizePackage(pack.id, { archived: !pack.archived }), pack.archived ? '恢复到常规包库' : '归档只隐藏包库中的条目，不影响已有画布节点');
    archive.disabled = organizingPackages.has(pack.id); card.append(archive); list.append(card);
  }
}
async function organizePackage(id, metadata) {
  if (organizingPackages.has(id)) return;
  organizingPackages.add(id); renderPackageLibrary();
  try {
    const result = await api(`/api/packages/${encodeURIComponent(id)}/metadata`, metadata);
    if (!result.package?.id) throw new Error('服务没有返回工作流包整理结果');
    rememberPackageDefinition(result.package);
    if ('archived' in metadata) toast(metadata.archived ? '已归档；已有画布节点仍可使用' : '已恢复到工作流包库');
  } finally { organizingPackages.delete(id); renderPackageLibrary(); }
}
async function openPackages() {
  if (!$('#packages-dialog').open) $('#packages-dialog').showModal();
  renderPackageLibrary();
  try { await loadPackages(); } catch (error) { $('#package-list').replaceChildren(el('p', 'model-note', error.message)); throw error; }
}
async function addPackageNode(pack, { nodeData = {}, ensureCurrent = null } = {}) {
  const identity = currentCanvasIdentity(), targetGraph = graph;
  const check = () => {
    ensureCurrent?.();
    if (identity !== currentCanvasIdentity() || graph !== targetGraph) throw new Error('画布已切换，工作流未放入新画布；包仍保留在本机库');
  };
  check();
  if (!pack.id) return placePackageNode(pack, nodeData);
  const key = JSON.stringify([identity, pack.id]);
  const existing = packageNodeAdds.get(key);
  const dataSignature = JSON.stringify(nodeData);
  if (existing?.graph === targetGraph && existing.guard === ensureCurrent && existing.dataSignature === dataSignature) return existing.promise;
  const pending = (async () => {
    pack = Array.isArray(pack.fields) && pack.prompt ? rememberPackageDefinition(pack) : await ensurePackageDefinition(pack.id);
    check();
    return placePackageNode(pack, nodeData);
  })();
  const entry = { graph: targetGraph, guard: ensureCurrent, dataSignature, promise: pending }; packageNodeAdds.set(key, entry);
  try { return await pending; } finally { if (packageNodeAdds.get(key) === entry) packageNodeAdds.delete(key); }
}
function placePackageNode(pack, nodeData = {}) {
  studio?.open('canvas');
  const box = bounds(), origin = { x: graph.nodes.length ? box.maxX + 72 : 80, y: singleSelected()?.y ?? 80 };
  const node = addNode('generation', { title: pack.name, kind: 'package', package_id: pack.id, packageValues: defaultValues(pack.fields || []), packageFields: (pack.fields || []).map(cachedPackageField), ...nodeData }, origin);
  viewport.x = canvas.clientWidth / 2 - (node.x + 152) * viewport.scale;
  viewport.y = 150 - node.y * viewport.scale; applyViewport(); save();
  $('#packages-dialog').close(); $('#package-editor-dialog').close();
  switchTab('properties'); renderInspector();
  toast('已添加工作流节点，可连接提示词、参考图或其他工作流的图片输出');
  return node;
}
async function exportPackage(id) {
  const result = await api(`/api/packages/${encodeURIComponent(id)}/export`, {});
  if (!result.document) throw new Error('本地服务没有返回工作流包');
  downloadJSON(result.source_json || result.document, `frameweave-workflow-${id}.json`);
  toast('已导出工作流与输入定义，不包含模型或素材文件');
}
function renderPackageDraft() {
  const list = $('#package-field-list'); list.replaceChildren();
  if (!packageDraft) return;
  $('#package-field-count').textContent = `${packageDraft.fields.filter(item => item.selected).length} / ${packageDraft.fields.length} 个输入`;
  renderInterfaceList(list, packageDraft.fields, interfaceViewState(packageDraft, 'draft-inputs'), '包输入', (item, area) => {
    const row = el('div', `package-field-row${item.selected ? ' included' : ''}`);
    const select = el('input'); select.type = 'checkbox'; select.checked = item.selected; select.disabled = ['image', 'audio', 'video'].includes(fieldType(item)); select.setAttribute('aria-label', `暴露 ${item.label || item.input}`);
    if (select.disabled) select.title = '图像输入必须开放，使用者运行时需上传自己的参考图';
    select.addEventListener('change', () => { item.selected = select.checked; row.classList.toggle('included', item.selected); $('#package-field-count').textContent = `${packageDraft.fields.filter(field => field.selected).length} / ${packageDraft.fields.length} 个输入`; });
    const body = el('div', 'package-field-body');
    const input = el('input'); input.type = 'text'; input.maxLength = 100; input.value = item.label; input.setAttribute('aria-label', `输入名称 ${item.node_id}.${item.input}`); input.addEventListener('change', () => { item.label = input.value.trim() || item.input; input.value = item.label; });
    body.append(input, el('span', 'package-mapping', `节点 ${item.node_id} → ${item.input} · ${fieldType(item)}${item.recommended ? ' · 推荐' : ''}`));
    const preview = ['image', 'audio', 'video'].includes(item.type) ? '运行时选择参考媒体' : item.default === undefined ? '没有默认值' : String(item.default).slice(0, 120);
    body.append(el('span', 'field-help package-default', `默认：${preview}`)); row.append(select, body); area.append(row);
  }, (toolbar, matching, refresh) => {
    for (const [selected, label] of [[true, '勾选筛选结果'], [false, '取消筛选结果']]) toolbar.append(button(label, 'button quiet compact', () => {
      for (const item of matching()) if (selected || !['image', 'audio', 'video'].includes(fieldType(item))) item.selected = selected;
      $('#package-field-count').textContent = `${packageDraft.fields.filter(item => item.selected).length} / ${packageDraft.fields.length} 个输入`; refresh();
    }));
  });
  if (!packageDraft.fields.length) list.append(el('p', 'model-note', '没有可暴露的基础输入。仍可保存为使用固定参数的工作流包。'));
}
async function inspectPackageDocument(document, name = '', sourceJSON = '', ensureCurrent = () => {}, checkBackend = async () => {}) {
  ensureCurrent();
  const result = await api('/api/packages/inspect', sourceJSON ? { source_json: sourceJSON } : { document });
  await checkBackend(); ensureCurrent();
  if (!result.prompt || !Array.isArray(result.fields)) throw new Error('本地服务未返回有效的工作流输入定义');
  const selectedIds = new Set(initialEditorFieldIds(result.fields));
  packageDraft = { ...result, fields: result.fields.map(item => ({ ...item, selected: document.format === 'frameweave-workflow' || selectedIds.has(item.id) })) };
  $('#package-name').value = name || result.name || '新建工作流包'; $('#package-description').value = result.description || '';
  if (sourceJSON && document.format === 'frameweave-workflow') {
    packageDraft.sourceJSON = sourceJSON;
    packageDraft.originalEditor = stableStringify({ name: $('#package-name').value.trim(), description: $('#package-description').value.trim(), fields: packageDraft.fields });
  }
  $('#package-inspection-note').textContent = '保存只建立本地工作流包；每次运行前会按当前后端重新校验节点、参数与模型。';
  renderPackageDraft(); $('#packages-dialog').close(); $('#package-editor-dialog').showModal();
}
async function inspectPackageFile(file) {
  const identity = currentCanvasIdentity(), targetGraph = graph;
  const ensureCanvas = () => { if (currentCanvasIdentity() !== identity || graph !== targetGraph) throw new Error('导入期间画布已切换，未添加到新画布；已保存的工作流仍保留在本机库。请在目标画布重新导入。'); };
  const imported = await readWorkflowFile(file, choosePngWorkflow);
  if (!imported) return;
  ensureCanvas();
  const { sourceJSON, name } = imported;
  const native = editorDocument(sourceJSON);
  if (native) {
    const record = await api('/api/editor-workflows', { name, source_json: sourceJSON });
    ensureCanvas();
    const node = await addPackageNode({ name: record.name, id: '', fields: [] });
    mutate(() => { node.data.editor_id = record.id; });
    toast(`已保存完整工作流（${record.nodes} 个节点），正在提取外层参数`);
    await nativeEditor.prepare(node);
    return;
  }
  const document = parsePackageDocument(sourceJSON.replace(/^\uFEFF/, ''));
  if (document.format !== 'frameweave-workflow') {
    await importApiInterface(document, name);
    return;
  }
  const result = await api('/api/packages', { source_json: sourceJSON });
  rememberPackageDefinition(result.package);
  await loadPackages();
  ensureCanvas();
  // Prepare all derived defaults off canvas: one import must be one complete undo.
  // A package already contains the author's interface choices. Keep its identity.
  const backend = settings.backend_url;
  let nodeData = {};
  try {
    const info = await api('/api/interfaces/inspect', { package_id: result.package.id, values: defaultValues(result.package.fields || []) });
    ensureCanvas();
    if (settings.backend_url !== backend) throw new Error('推理引擎已切换，请在当前引擎重新检查输出');
    if (!Array.isArray(info.outputs)) throw new Error('服务未返回有效的输出定义');
    nodeData = { editor_outputs: info.outputs.map(item => item.id), editor_output_fields: info.outputs };
  } catch (error) { ensureCanvas(); toast(`工作流包已导入；输出识别待连接正确后端：${error.message}`, true); }
  ensureCanvas();
  await addPackageNode(result.package, { nodeData, ensureCurrent: ensureCanvas });
}
const canvasInspection = createCanvasInspection({ api, graph: () => graph, backend: () => settings.backend_url,
  canvasIdentity: currentCanvasIdentity, assertMediaReady: assertCanvasMediaReady });
async function packageCurrentNode() {
  const node = selectedGeneration();
  if (!node) throw new Error('请先在画布选择一个图片 / 视频生成节点');
  if (node.data.kind === 'package') throw new Error('当前节点已经是工作流包，可以直接导出此包');
  const inspection = await canvasInspection.compile(node.id);
  inspection.ensureCurrent();
  await inspectPackageDocument({ prompt: inspection.result.prompt }, node.data.title, '', inspection.ensureCurrent, inspection.checkBackend);
}
async function openNodeWorkflow(node) {
  if (node.data.kind === 'package' && !node.data.package_id && !node.data.editor_id) return openPackages();
  if(node.data.editor_id) {
    beginNativeEditorContext(node);
    try { return await nativeEditor.open(node); } catch (error) { endNativeEditorSession(node); throw error; }
  }
  if (['package', 'api'].includes(node.data.kind)) {
    const context = beginNativeEditorContext(node);
    try {
      await prepareEditorRootBackend(context);
      await loadNativeEditorFields(context); context.assertCurrent();
      const own = nativeEditorProjection(context, node, true);
      const source = context.package ? { package_id: context.package.id } : { document: { prompt: node.data.apiPrompt }, fields: context.fields };
      const baseline = await api('/api/editor-prepare', { ...source, backend_url: settings.backend_url, overrides: own.overrides, pending: own.pending });
      context.assertCurrent();
      if (baseline.backend_url !== settings.backend_url || context.package && baseline.source_revision !== context.package.id) throw new Error('完整来源的后端或版本已变化，请重新进入');
      context.baselineBackend = settings.backend_url;
      context.baselineDocument = baseline.source_document;
      const saved = await api('/api/editor-workflows', { name: node.data.title, document: { version: 0.4, nodes: [], links: [], last_node_id: 0, last_link_id: 0 } });
      context.assertCurrent();
      const draft = clone(node); draft.data.editor_id = saved.id; draft.data.editor_backend = settings.backend_url;
      aliasNativeEditorContext(context, draft);
      await nativeEditor.openApiPrompt(draft, baseline.prompt, () => {
        context.assertCurrent();
        mutate(() => { node.data.editor_id = draft.data.editor_id; node.data.editor_backend = draft.data.editor_backend; });
        context.rebaseTarget();
      });
      return;
    } catch (error) { endNativeEditorSession(node); throw error; }
  }
  const context = beginNativeEditorContext(node);
  try {
    await prepareEditorRootBackend(context); context.assertCurrent();
    const collected = collectPresetEditRequest(graph, node.id, { backend: settings.backend_url,
      canvasId: currentCanvasIdentity(), referenceImports, mediaTransfers: packageMediaTransfers });
    const prepared = await api('/api/editor-prepare', { backend_url: settings.backend_url,
      preset_request: collected.preset_request, reference_slots: collected.reference_slots,
      input_intents: collected.input_intents, model_intents: collected.model_intents, pending: collected.pending });
    context.assertCurrent();
    if (prepared.backend_url !== settings.backend_url || prepared.source_kind !== 'preset') throw new Error('预设编辑来源或引擎不一致；请更新本机客户端后重试');
    if (prepared.status === 'blocked') throw new Error(`完整预设尚不能装配：${(prepared.blocked || []).map(item => item.message).join('；') || '缺少可验证的节点声明'}。原参数和连线已保留。`);
    if (!prepared.receipt_complete) throw new Error('预设内部输入尚不能唯一映射到外层；原节点与连线已保留，请检查当前节点版本');
    const shadow = preparePresetEditGraph(graph, node.id, prepared, collected);
    context.fields = shadow.fields; context.sessionGraph = shadow.graph;
    context.baselineBackend = settings.backend_url; context.baselineDocument = prepared.source_document;
    const saved = await api('/api/editor-workflows', { name: node.data.title,
      document: { version: 0.4, nodes: [], links: [], last_node_id: 0, last_link_id: 0 } });
    context.assertCurrent();
    const draft = clone(shadow.target); draft.data.editor_id = saved.id; draft.data.editor_backend = settings.backend_url;
    aliasNativeEditorContext(context, draft);
    await nativeEditor.openApiPrompt(draft, prepared.source_document.prompt,
      converted => bindPreparedPreset(context, draft, prepared, collected, converted));
  } catch (error) { endNativeEditorSession(node); throw error; }
}
async function bindPreparedPreset(context, draft, prepared, collected, converted) {
  context.assertCurrent();
  if (!converted?.output) throw new Error('原生转换没有返回已验证的完整执行图');
  const target = context.target, guard = captureNativeInterfaceTarget(target);
  const info = await api('/api/interfaces/inspect', { document: { prompt: converted.output } });
  assertNativeInterfaceTarget(guard);
  const fresh = { ...prepared, source_document: { prompt: converted.output }, fields: info.fields, outputs: info.outputs };
  // Validate the complete connection migration before creating a package.
  preparePresetEditGraph(graph, target.id, fresh, collected);
  const result = await api('/api/interfaces/apply', { prompt: converted.output, fields: info.fields,
    output_nodes: info.outputs.map(item => item.id), backend_url: settings.backend_url, name: target.data.title });
  assertNativeInterfaceTarget(guard);
  if (result.requires_resolution || result.backend_url !== settings.backend_url || !result.package?.id) throw new Error('首次外层绑定尚未完成，原节点已保留；请重新进入核对');
  const shadow = preparePresetEditGraph(graph, target.id, { ...fresh, fields: result.package.fields }, collected);
  shadow.target.data.editor_id = draft.data.editor_id;
  const updated = applyEditorInterfaceGraph(shadow.graph, target.id, { ...result, outputs: info.outputs,
    controls: converted.controls || [], rebindings: {}, output_rebindings: shadow.output_rebindings || {} }, { preserveOutputIndices: true });
  const next = updated.nodes.find(item => item.id === target.id);
  rememberPackageDefinition(result.package);
  assertNativeInterfaceTarget(guard);
  mutate(() => { target.data = clone(next.data); graph.edges = updated.edges; draft.data = clone(next.data); });
  // The preceding guarded migration is the only authorized graph change here.
  context.package = result.package; context.fields = clone(result.package.fields);
  context.sourceRevision = result.package.id; context.sessionGraph = null; context.baselineDocument = null;
  context.guard = captureEditorPreparationTarget(graph, target.id, { canvasId: currentCanvasIdentity(), backend: settings.backend_url,
    sourceRevision: context.sourceRevision, referenceImports, mediaTransfers: packageMediaTransfers });
  toast('预设已建立外层参数与命名接口，已有输入连接已同步');
}
function renderInspector() {
  if (activeSidebarPackage && (singleSelected() !== activeSidebarPackage.node || currentCanvasIdentity() !== activeSidebarPackage.identity || activeSidebarPackage.node.data.package_id !== activeSidebarPackage.packageId)) activeSidebarPackage = null;
  const content = $('#inspector-content'); releaseMedia(content); content.replaceChildren();
  if (selectedEdge) {
    const wrap = el('div', 'inspector-empty'); wrap.append(el('span', 'eyebrow', 'CONNECTION'), el('h2', '', '工作流连接'), el('p', '', '连接将提示词、参考素材和生成结果传递给下一个节点。'), button('删除此连接', 'button quiet', () => deleteSelection())); content.append(wrap); return;
  }
  if (selected.size > 1) {
    const wrap = el('div', 'multi-selection'); wrap.append(el('span', 'eyebrow', 'MULTI SELECTION'), el('h2', '', `已选择 ${selected.size} 个节点`), el('p', '', '拖动任一已选节点的标题，可以一起移动。复制时会保留所选节点之间的连接。'));
    const actions = el('div', 'inspector-actions'); actions.append(button('复制所选', 'button quiet', duplicateSelection), button('删除所选', 'button quiet', deleteSelection)); wrap.append(actions); content.append(wrap); return;
  }
  const node = singleSelected();
  if (!node) {
    const wrap = el('div', 'inspector-empty'); wrap.append(el('span', 'eyebrow', 'YOUR CREATIVE SPACE'), el('h2', '', '选择一个节点，开始创作'), el('p', '', '在这里调节模型、镜头与生成参数。每个节点都可以自由连接和复用。'), el('hr', 'divider'), button('检查本地环境', 'button quiet', () => runDiagnostics())); content.append(wrap); return;
  }
  const wrap = el('div', 'inspector-content-wrap');
  wrap.append(el('span', 'eyebrow', { prompt: 'PROMPT DESIGN', reference: 'REFERENCE ASSET', generation: 'GENERATION CONTROL', result: 'OUTPUT PREVIEW' }[node.type]));
  const title = el('div', 'inspector-title-row'); title.append(el('h2', '', node.type === 'generation' ? KIND_NAMES[node.data.kind] : node.data.title)); wrap.append(title);
  wrap.append(el('p', 'inspector-description', { prompt: '写下画面、光线与运动，将文字连接到生成节点。', reference: '角色、场景或首尾帧，让每一次生成有据可循。', generation: '精确设定每一帧，让创作保持可控。', result: '实际输出与任务记录，完整保存在本地。' }[node.type]));
  wrap.append(field('节点名称', node.data.title, value => editNode(node.id, 'title', value || '未命名节点')));
  if (node.type === 'generation') {
    renderInputPortSettings(wrap, node);
    section(wrap, '生成模式', '01 / MODEL');
    wrap.append(field('模型与任务', node.data.kind, kind => {
      if (kind === 'package' && node.data.kind !== 'package') { renderInspector(); openPackages().catch(reportError); return; }
      if (node.data.kind === 'package' && kind !== 'package' && graph.edges.some(edge => edge.target === node.id && edge.targetField)) { renderInspector(); throw new Error('此工作流已有输入连接，请先断开连接，再切换为其他生成模式'); }
      const candidate=clone(graph);candidate.nodes.find(n=>n.id===node.id).data.kind=kind;
      try {parseGraph(serializeGraph(candidate));} catch(error) {renderInspector();throw new Error(`现有连线不适用于此模式，请先调整输入连接：${error.message}`);}
      mutate(() => {
      node.data.kind = kind; node.data.title = KIND_NAMES[kind]; node.data.models = {};
      if (Object.hasOwn(node.data, 'loras')) node.data.loras = [];
      if (kind === 'krea') { node.data.steps = 8; node.data.cfg = 1; node.data.width = 1024; node.data.height = 1024; }
      if (kind.startsWith('qwen21_')) { node.data.steps = 40; node.data.cfg = 1; node.data.width = 1024; node.data.height = 1024; node.data.denoise = 1; node.data.sampler = 'euler'; node.data.scheduler = 'simple'; node.data.custom_size = false; node.data.ref_resolution = 1024; }
      else if (kind.startsWith('sdxl')) { node.data.steps = 25; node.data.cfg = 7; node.data.width = 1024; node.data.height = 1024; }
      else if (kind.startsWith('h3')) { node.data.steps = 20; node.data.cfg = 1; node.data.width = 768; node.data.height = 448; }
      });
    }, { select: Object.entries(KIND_NAMES).map(([value, label]) => ({ value, label })) }));
    if (node.data.kind === 'package') {
      if (node.data.package_id) wrap.append(button('管理外部接口', 'button quiet inspector-interface', () => configurePackageInterface(node)));
      renderPackageInputs(wrap, node);
    } else if (node.data.kind === 'api') {
      wrap.append(el('p', 'model-note', '导入 ComfyUI「Save (API Format)」JSON。工作流完整保留，模型与路径仍需在你的推理引擎中可用。'));
      wrap.append(button(node.data.apiPrompt ? '重新导入 API 工作流' : '导入 API 工作流', 'button quiet', () => { workflowTarget = node.id; $('#workflow-input').click(); }));
      if (node.data.apiPrompt) wrap.append(field('API 工作流 JSON', stableStringify(node.data.apiPrompt), value => { try { const parsed = parseJSONWithSafeNumbers(value); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); editNode(node.id, 'apiPrompt', parsed); } catch (error) { toast(error.message || 'API 工作流必须是有效 JSON 对象', true); } }, { multiline: true, rows: 10, live: false }));
    } else {
      if (node.data.kind.startsWith('h3')) wrap.append(el('p', 'model-note', 'MiniMax H3 需要兼容扩展与模型。默认 20 步；低步数加速须配合对应 Turbo LoRA。实际帧数与时长由引擎校正。'));
      if (node.data.kind === 'h3_i2v') wrap.append(el('p', 'form-note', '连接首帧参考素材，可再连接一张尾帧。素材属性中选择「首帧」与「尾帧」角色。'));
      if (node.data.kind === 'h3_ref') wrap.append(el('p', 'form-note', '连接角色或场景参考素材以保持一致性。兼容素材类型与上限由当前 H3 扩展校验。'));
      if (node.data.kind.startsWith('qwen21_')) wrap.append(el('p', 'model-note', 'Qwen Image 2.1 使用专用主模型、Qwen3-VL 8B 编码器和 2.1 VAE；旧版 Qwen Image 权重不通用。默认 40 步，实际性能需本机生成验证。'));
      if (node.data.kind === 'qwen21_edit') wrap.append(el('p', 'form-note', '按连接顺序输入 1–10 张参考图片，用提示词说明各图用途与修改要求。条件编辑固定 denoise=1。'));
      if (node.data.kind === 'qwen21_edit') {
        const references = graph.edges.filter(edge => edge.target === node.id && /^image_/.test(edgeInputField(graph,edge))).sort((a,b)=>Number(edgeInputField(graph,a).split('_')[1])-Number(edgeInputField(graph,b).split('_')[1]));
        references.forEach((edge, index) => {
          const source = getNode(edge.source), row = el('div', 'qwen-reference-order');
          row.append(el('p', 'form-note', `${index === 0 ? '编辑目标' : '参考图'} · 图 ${index + 1}：${source.data.title}${source.data.name ? '' : ' · 尚未上传'}`));
          const controls = el('div', 'inspector-actions');
          for (const [delta, label] of [[-1, '上移'], [1, '下移']]) {
            const move = button(label, 'button quiet compact', () => mutate(() => {
              const other=references[index+delta], first=edgeInputField(graph,edge), second=edgeInputField(graph,other);
              for(const item of references) item.targetField=edgeInputField(graph,item);
              edge.targetField=second;other.targetField=first;
            }));
            move.disabled = index + delta < 0 || index + delta >= references.length;
            move.setAttribute('aria-label', `画布图 ${index + 1} ${label}`); controls.append(move);
          }
          row.append(controls); wrap.append(row);
        });
      }
      section(wrap, '画面与提示词', '02 / DIRECTION');
      const incomingPrompts = graph.edges.filter(edge => edge.target === node.id && getNode(edge.source)?.type === 'prompt').length;
      wrap.append(field(incomingPrompts ? `补充提示词 · 已连接 ${incomingPrompts} 个文本节点` : '正向提示词', node.data.positive, value => editNode(node.id, 'positive', value), { multiline: true, rows: 4, placeholder: '主体、环境、动作、光线、镜头…' }));
      wrap.append(field('负向提示词', node.data.negative, value => editNode(node.id, 'negative', value), { multiline: true, rows: 2, placeholder: '不希望出现的内容' }));
      wrap.append(button('复制合并后的提示词', 'text-link', () => { const payload = generationPayload(graph, node.id); return copyText(`${payload.positive}${payload.negative ? `\n\n负向提示词：${payload.negative}` : ''}`); }));
      section(wrap, '画幅与时间', '03 / FRAME');
      const referenceSize = node.data.kind === 'qwen21_edit' && !node.data.custom_size;
      if (node.data.kind === 'qwen21_edit') {
        wrap.append(field('输出尺寸模式', node.data.custom_size ? 'custom' : 'reference', value => editNode(node.id, 'custom_size', value === 'custom', true), { select: [{ value: 'reference', label: '按第一张参考图的比例' }, { value: 'custom', label: '自定义宽高' }], help: '按首图模式结合参考分辨率确定输出；自定义宽高可能改变构图。' }));
        wrap.append(field('参考分辨率 / px', node.data.ref_resolution ?? 1024, value => editNode(node.id, 'ref_resolution', value), { number: true, min: 0, max: 4096, step: 32, help: '参考图面积预算的边长；0 保留输入尺寸并对齐 32。' }));
      }
      const ratios = el('div', 'ratio-list');
      [['横屏', 768, 448], ['竖屏', 448, 768], ['1 : 1', 768, 768]].forEach(([label, width, height]) => { const active = Math.abs(node.data.width / node.data.height - width / height) < .01; ratios.append(button(label, `ratio-button${active ? ' active' : ''}`, () => mutate(() => { node.data.width = width; node.data.height = height; }))); });
      if (!referenceSize) wrap.append(ratios);
      const dimensionStep = node.data.kind.startsWith('h3') || node.data.kind.startsWith('qwen21_') ? 32 : node.data.kind === 'krea' ? 16 : 8;
      const dimensions = el('div', 'field-grid'); dimensions.append(field('宽度 / px', node.data.width, value => editNode(node.id, 'width', value), { number: true, min: 64, max: 4096, step: dimensionStep }), field('高度 / px', node.data.height, value => editNode(node.id, 'height', value), { number: true, min: 64, max: 4096, step: dimensionStep })); if (!referenceSize) wrap.append(dimensions);
      if (node.data.kind.startsWith('h3')) { const timing = el('div', 'field-grid'); timing.append(field('时长 / s', node.data.seconds, value => editNode(node.id, 'seconds', value), { number: true, min: 1, max: 30, step: .1 }), field('帧率 / fps', 24, () => {}, { number: true, readonly: true, help: 'H3 原生固定 24 fps' })); wrap.append(timing); }
      section(wrap, '采样与可复现性', '04 / SAMPLING');
      const sampling = el('div', 'field-grid'); sampling.append(field('采样步数', node.data.steps, value => editNode(node.id, 'steps', value), { number: true, min: 1, max: 150, step: 1 }), field('引导强度 / CFG', node.data.cfg, value => editNode(node.id, 'cfg', value), { number: true, min: 0, max: 30, step: .1 })); wrap.append(sampling);
      wrap.append(field('随机种子', node.data.seed, value => editNode(node.id, 'seed', value), { number: true, min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }));
      wrap.append(button('↻  换一个随机种子', 'text-link', () => editNode(node.id, 'seed', crypto.getRandomValues(new Uint32Array(1))[0], true)));
      const schedule = el('div', 'field-grid');
      schedule.append(field('采样器', node.data.sampler || 'euler', value => editNode(node.id, 'sampler', value), { select: ['euler', 'euler_ancestral', 'heun', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'uni_pc', 'ddim'] }), field('调度器', node.data.scheduler || 'simple', value => editNode(node.id, 'scheduler', value), { select: ['simple', 'normal', 'karras', 'exponential', 'sgm_uniform', 'beta'] }));
      wrap.append(schedule, field('去噪强度', node.data.denoise ?? 1, value => editNode(node.id, 'denoise', value), { number: true, min: 0, max: 1, step: .05, readonly: node.data.kind.startsWith('h3') || node.data.kind.startsWith('qwen21_'), help: node.data.kind.startsWith('h3') || node.data.kind.startsWith('qwen21_') ? '当前条件生成固定为 1' : '低于 1 时需要连接参考图' }));
      section(wrap, '模型文件', '05 / LOCAL ASSETS');
      const modelFields = node.data.kind.startsWith('sdxl') ? [['Checkpoint 主模型', 'checkpoint']] : [['DiT 主模型', 'dit'], ['文本编码器', 'text_encoder'], ['图像 / 视频 VAE', 'vae'], ...(node.data.kind.startsWith('h3') ? [['音频 VAE', 'audio_vae']] : [])];
      modelFields.forEach(([label, key]) => wrap.append(modelField(node, label, key)));
      renderLoraFields(wrap, node);
    }
    const actions = el('div', 'inspector-actions'); actions.append(button('检查缺失项', 'button quiet', () => runDiagnostics(node)), button('导出执行 JSON', 'button quiet', () => compileNode(node))); wrap.append(actions);
    wrap.append(button('↗ 进入工作流 · 内部调参','button quiet inspector-run',()=>openNodeWorkflow(node)), editorMediaSyncButton(node));
    const run = button(submitting.has(node.id) ? '正在提交…' : '▷  开始生成', 'button primary inspector-run', () => runNode(node.id)); run.disabled = submitting.has(node.id) || workflowCanvas?.isRunning() || node.data.kind==='package' && !node.data.package_id; run.dataset.runNode = node.id; wrap.append(run);
    wrap.append(el('p', 'form-note', '速度与质量取决于后端、模型、显存和参数。生成任务通过本机服务执行，可在队列中查看耗时与取消。'));
  } else if (node.type === 'prompt') {
    wrap.append(field('正向提示词', node.data.text, value => editNode(node.id, 'text', value), { multiline: true, rows: 9 }), field('负向提示词', node.data.negative, value => editNode(node.id, 'negative', value), { multiline: true, rows: 3 }));
    wrap.append(button('复制提示词', 'button primary inspector-run', () => copyText(node.data.text)));
  } else if (node.type === 'reference') {
    if (node.data.url) wrap.append(outputMedia({ url: node.data.url, type: node.data.mediaType, filename: node.data.name }, 'reference-media'));
    if (!['audio', 'video'].includes(node.data.mediaType)) wrap.append(field('参考角色', node.data.role, value => editNode(node.id, 'role', value), { select: [{ value: 'reference', label: '角色 / 场景参考' }, { value: 'start', label: '首帧' }, { value: 'end', label: '尾帧' }] }));
    else wrap.append(el('p', 'form-note', '用途由连接的工作流接口决定；可将同一素材连接到多个命名输入。'));
    wrap.append(el('p', 'form-note', node.data.localFilename || node.data.name || '还未导入素材。'));
    wrap.append(button('选择图片 / 视频 / 音频', 'button quiet inspector-run', () => chooseReference(node.id)));
    wrap.append(el('p', 'form-note', '素材先保存在客户端，生成时自动传入对应引擎。导出画布只记录引用，不打包原始媒体；迁移设备时需同时保留客户端素材目录。'));
  } else {
    if (node.data.outputs?.length) node.data.outputs.forEach(output => { wrap.append(outputMedia(output, output.type === 'audio' ? 'output-audio' : 'output-image'), button('打开预览', 'button quiet inspector-run', () => preview(output)), button('传入工作流…', 'button quiet inspector-run', () => passResultToWorkflow(node, output))); });
    else wrap.append(el('p', 'model-note', '尚无真实生成结果。连接生成节点，检查环境后提交任务。'));
  }
  wrap.append(el('hr', 'divider'));
  const bottom = el('div', 'inspector-actions'); bottom.append(button('复制节点', 'button quiet', duplicateSelection), button('删除节点', 'button quiet', deleteSelection)); wrap.append(bottom);
  content.append(wrap);
}
function renderAll() { renderNodes(); renderInspector(); updateHistory(); applyViewport(); }
function revealInspector() {
  if (document.body.classList.contains('canvas-focus') || !canvasIsActive()) return;
  document.body.classList.add('inspector-open');
  $('#toggle-inspector')?.setAttribute('aria-pressed', 'true');
}
function addNode(type, data = {}, position = null, anchored = false, center = !anchored) {
  if (graph.nodes.length >= 500) throw new Error('当前画布已满，请先导出或整理节点。');
  const point = viewPoint(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2);
  const node = createNode(type, position?.x ?? point.x - 145, position?.y ?? point.y - 115, data);
  // Explicit positions come from the node menu; keep the node anchored there.
  if (!anchored) placeNewNodes([node]);
  mutate(() => { graph.nodes.push(node); selected = new Set([node.id]); selectedEdge = null; });
  revealInspector();
  if (center) centerOnNode(node);
  return node;
}
function renderLoraFields(wrap, node) {
  const clip = node.data.kind.startsWith('sdxl');
  if (!Object.hasOwn(node.data, 'loras')) {
    wrap.append(modelField(node, 'LoRA · 风格 / 加速', 'lora'));
    wrap.append(field('LoRA 强度', node.data.lora_strength ?? 1, value => editNode(node.id, 'lora_strength', value), { number: true, min: -10, max: 10, step: .05 }));
    wrap.append(button('使用多 LoRA · 分别调节强度', 'button quiet inspector-run', () => mutate(() => {
      const name = node.data.models?.lora || '', strength = node.data.lora_strength ?? 1;
      node.data.loras = name ? [{ name, strength_model: strength, ...(clip ? { strength_clip: strength } : {}) }] : [];
    })));
    return;
  }
  const values = catalog('lora', node.data.kind), stack = node.data.loras;
  const container = el('div', 'inspector-lora-list'); container.setAttribute('aria-label', '节点 LoRA 叠加');
  container.append(el('p', 'field-help', stack.length ? `按顺序应用 ${stack.length} / 4 个 LoRA。文件名推荐不代表权重兼容性已验证。` : '未启用 LoRA。空列表会禁用旧画布的单 LoRA 设置。'));
  stack.forEach((item, index) => {
    const row = el('section', 'inspector-lora-row'); row.dataset.loraIndex = String(index);
    const choices = [...values]; if (!choices.includes(item.name)) choices.unshift(item.name);
    const change = (key, value) => mutate(() => { node.data.loras[index] = { ...node.data.loras[index], [key]: value }; }, { inspector: false });
    row.append(field(`LoRA ${index + 1} 文件`, item.name, value => change('name', value), { select: choices.map(value => ({ value, label: values.includes(value) ? value : `${value} · 当前后端未列出` })) }));
    const strengths = el('div', 'field-grid');
    strengths.append(field(`LoRA ${index + 1} 模型强度`, item.strength_model ?? 1, value => change('strength_model', value), { number: true, min: -10, max: 10, step: .05 }));
    if (clip) strengths.append(field(`LoRA ${index + 1} 文本强度`, item.strength_clip ?? 1, value => change('strength_clip', value), { number: true, min: -10, max: 10, step: .05 }));
    row.append(strengths, button(`移除 LoRA ${index + 1}`, 'text-link', () => mutate(() => { node.data.loras.splice(index, 1); })));
    container.append(row);
  });
  const add = button('＋ 添加 LoRA', 'button quiet inspector-run', () => mutate(() => {
    if (node.data.loras.length >= 4) return;
    const name = values.find(value => !node.data.loras.some(item => item.name === value)) || values[0];
    if (!name) return;
    node.data.loras.push({ name, strength_model: 1, ...(clip ? { strength_clip: 1 } : {}) });
  }));
  add.disabled = stack.length >= 4 || !values.length; container.append(add);
  if (!values.length) container.append(el('p', 'field-help', '连接本地引擎后可选择该模式加载器支持的 LoRA。现有选择会保留。'));
  wrap.append(container);
}
function deleteSelection() {
  if (!selected.size && !selectedEdge) return;
  mutate(() => {
    if (selectedEdge) removeEdges(graph, [selectedEdge]);
    removeNodes(graph, selected); selected.clear(); selectedEdge = null;
  });
  toast('已删除，可使用 Ctrl+Z 撤销');
}
function duplicateSelection() {
  if (!selected.size) return;
  const copied = copySelection(graph, selected), box = bounds(copied.nodes);
  if (graph.edges.length + copied.edges.length > 2000) throw new Error('复制后超过 2000 条连接，请先整理画布。');
  const fragment = pasteSelection(copied, { x: box.minX + 44, y: box.minY + 44 }, graph.nodes.length);
  mutate(() => { graph.nodes.push(...fragment.nodes); graph.edges.push(...fragment.edges); selected = new Set(fragment.nodes.map(node => node.id)); selectedEdge = null; });
}

function canvasIsActive() { return (!document.body.dataset.workspace || document.body.dataset.workspace === 'canvas') && canvas.offsetParent !== null; }
function updateCanvasActions() {
  const count = selected.size;
  const copy = $('#canvas-copy'), paste = $('#canvas-paste'), fit = $('#canvas-fit-selection'), rename = $('#canvas-rename');
  if (copy) copy.disabled = !count;
  if (paste) paste.disabled = !canvasClipboard?.nodes.length;
  if (fit) fit.disabled = !count;
  if (rename) rename.disabled = count !== 1;
  const arrange = $('#canvas-arrange');
  if (arrange) { arrange.disabled = count < 2; [...arrange.options].forEach(option => { if (['horizontal', 'vertical'].includes(option.value)) option.disabled = count < 3; }); }
  const label = $('#canvas-selection-count'); if (label) label.textContent = count ? `已选 ${count}` : '未选择';
}
function copyCanvasSelection() {
  if (!selected.size) return;
  canvasClipboard = copySelection(graph, selected); pasteOffset = 0;
  updateCanvasActions(); toast(`已复制 ${canvasClipboard.nodes.length} 个节点和内部连接`);
}
function pasteCanvasSelection(position = null) {
  if (!canvasClipboard?.nodes.length) { toast('请先复制画布节点'); return; }
  if (graph.edges.length + canvasClipboard.edges.length > 2000) throw new Error('粘贴后超过 2000 条连接，请先整理画布。');
  const box = bounds(canvasClipboard.nodes);
  pasteOffset += 36;
  const fragment = pasteSelection(canvasClipboard, position || { x: box.minX + pasteOffset, y: box.minY + pasteOffset }, graph.nodes.length);
  mutate(() => { graph.nodes.push(...fragment.nodes); graph.edges.push(...fragment.edges); selected = new Set(fragment.nodes.map(node => node.id)); selectedEdge = null; });
  toast(`已粘贴 ${fragment.nodes.length} 个节点，可撤销`);
}
function arrangeCanvasSelection(mode) {
  const positions = arrangeSelection(graph.nodes.filter(node => selected.has(node.id)), mode, nodeSize);
  if (!positions.length) return;
  mutate(() => positions.forEach(position => Object.assign(getNode(position.id), position)));
}
function renameCanvasSelection() {
  const node = singleSelected(); if (!node) { toast('请选择一个节点重命名'); return; }
  closeNodeMenu();
  let dialog = $('#canvas-rename-dialog');
  if (!dialog) {
    dialog = el('dialog', 'modal canvas-rename-dialog'); dialog.id = 'canvas-rename-dialog'; dialog.setAttribute('aria-label', '重命名节点');
    const form = el('form'), heading = el('h2', '', '重命名节点'), label = el('label', 'field', '节点名称'), input = el('input');
    input.id = 'canvas-rename-input'; input.required = true; input.maxLength = 100; input.autocomplete = 'off';
    label.append(input);
    const actions = el('div', 'modal-actions'), submit = el('button', 'button primary', '保存名称'); submit.type = 'submit';
    actions.append(button('取消', 'button quiet', () => dialog.close()), submit); form.append(heading, label, actions); dialog.append(form); document.body.append(dialog);
    form.addEventListener('submit', event => {
      event.preventDefault(); const target = getNode(dialog.dataset.nodeId), title = input.value.trim();
      if (!title || !target) return;
      mutate(() => { target.data.title = title; }); dialog.close();
    });
    dialog.addEventListener('close', () => canvas.focus({ preventScroll: true }));
  }
  dialog.dataset.nodeId = node.id; $('#canvas-rename-input').value = node.data.title; dialog.showModal(); $('#canvas-rename-input').select();
}
function toggleCanvasFocus(force) {
  const active = typeof force === 'boolean' ? force : !document.body.classList.contains('canvas-focus');
  document.body.classList.toggle('canvas-focus', active);
  const control = $('#canvas-focus'); if (control) { control.textContent = active ? '退出专注' : '专注画布'; control.setAttribute('aria-pressed', String(active)); }
  requestAnimationFrame(applyViewport);
}
function closeNodeMenu(restoreFocus = false) {
  if (nodeMenu) { nodeMenu.remove(); nodeMenu = null; }
  if (restoreFocus) canvas.focus({ preventScroll: true });
}
function openNodeMenu(clientX, clientY, nodeId = null) {
  closeNodeMenu();
  if (nodeId && !selected.has(nodeId)) { selected = new Set([nodeId]); selectedEdge = null; renderSelection(); renderInspector(); }
  if (nodeId) revealInspector();
  const point = viewPoint(clientX, clientY);
  point.x = Math.max(-1e7, Math.min(1e7, Math.round(point.x))); point.y = Math.max(-1e7, Math.min(1e7, Math.round(point.y)));
  nodeMenu = el('div', 'canvas-node-menu'); nodeMenu.id = 'canvas-node-menu'; nodeMenu.setAttribute('role', 'menu'); nodeMenu.setAttribute('aria-label', nodeId ? '节点操作' : '新建节点');
  nodeMenu.style.position = 'fixed'; nodeMenu.style.zIndex = '150';
  nodeMenu.append(el('div', 'canvas-menu-heading', nodeId ? '节点操作' : '在此处新建节点'));
  const item = (label, action, disabled = false) => {
    const control = button(label, 'canvas-menu-item', () => { closeNodeMenu(); action(); }, label);
    control.setAttribute('role', 'menuitem'); control.disabled = disabled; nodeMenu.append(control);
  };
  if (!nodeId) {
    item('文本 / 提示词', () => addNode('prompt', {}, point, true));
    item('参考素材 · 图片 / 视频 / 音频', () => addNode('reference', {}, point, true));
    item('H3 视频生成', () => addNode('generation', {}, point, true));
    item('图片生成', () => addNode('generation', { title: 'SDXL 图片生成', kind: 'sdxl', width: 1024, height: 1024, steps: 25, cfg: 7 }, point, true));
    item('结果预览', () => addNode('result', {}, point, true));
    item('工作流包 · 添加到画布', () => openPackages().catch(reportError));
    nodeMenu.append(el('hr', 'canvas-menu-divider'));
  } else {
    item('重命名 · F2', renameCanvasSelection, selected.size !== 1);
    item('复制所选 · Ctrl+C', copyCanvasSelection);
    item('创建副本 · Ctrl+D', duplicateSelection);
    item('适配所选 · Shift+F', () => fitView(true));
    item('删除所选 · Delete', deleteSelection);
  }
  item('粘贴节点 · Ctrl+V', () => pasteCanvasSelection(point), !canvasClipboard?.nodes.length);
  nodeMenu.addEventListener('keydown', event => {
    const controls = [...nodeMenu.querySelectorAll('button:not(:disabled)')];
    if (event.key === 'Escape') { event.preventDefault(); closeNodeMenu(true); return; }
    if (event.key === 'Tab') { closeNodeMenu(true); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const index = controls.indexOf(document.activeElement), next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
      controls[next]?.focus();
    }
  });
  document.body.append(nodeMenu);
  nodeMenu.style.maxHeight = `${Math.max(100, window.innerHeight - 16)}px`; nodeMenu.style.overflowY = 'auto';
  const position = clampMenuPosition({ x: clientX, y: clientY }, nodeMenu.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
  nodeMenu.style.left = `${position.x}px`; nodeMenu.style.top = `${position.y}px`;
  nodeMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
function initializeCanvasActions() {
  const bar = el('div', 'canvas-action-bar'); bar.id = 'canvas-actions'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '画布编辑工具');
  const add = button('＋ 新建节点', 'canvas-action-button', () => { const rect = add.getBoundingClientRect(); openNodeMenu(rect.left, rect.bottom + 8); });
  const box = button('框选', 'canvas-action-button', () => { tool = tool === 'box' ? 'select' : 'box'; canvas.classList.remove('hand'); $('#tool-hand').classList.remove('active'); $('#tool-hand').setAttribute('aria-pressed', 'false'); $('#tool-select').classList.add('active'); $('#tool-select').setAttribute('aria-pressed', 'true'); box.setAttribute('aria-pressed', String(tool === 'box')); }); box.id = 'canvas-box-select'; box.setAttribute('aria-pressed', 'false');
  const copy = button('复制', 'canvas-action-button', copyCanvasSelection); copy.id = 'canvas-copy';
  const paste = button('粘贴', 'canvas-action-button', () => pasteCanvasSelection()); paste.id = 'canvas-paste';
  const rename = button('重命名', 'canvas-action-button', renameCanvasSelection); rename.id = 'canvas-rename';
  const arrange = el('select', 'canvas-arrange'); arrange.id = 'canvas-arrange'; arrange.setAttribute('aria-label', '对齐和分布所选节点');
  [['', '对齐 / 分布'], ['left', '左对齐'], ['right', '右对齐'], ['top', '顶对齐'], ['bottom', '底对齐'], ['horizontal', '水平等距'], ['vertical', '垂直等距']].forEach(([value, label]) => { const option = el('option', '', label); option.value = value; arrange.append(option); });
  arrange.addEventListener('change', () => { const value = arrange.value; arrange.value = ''; if (value) try { arrangeCanvasSelection(value); } catch (error) { reportError(error); } });
  const fit = button('适配所选', 'canvas-action-button', () => fitView(true)); fit.id = 'canvas-fit-selection';
  const focus = button('专注画布', 'canvas-action-button', () => toggleCanvasFocus()); focus.id = 'canvas-focus'; focus.setAttribute('aria-pressed', 'false');
  const count = el('span', 'canvas-selection-count'); count.id = 'canvas-selection-count';
  bar.append(add, box, copy, paste, rename, arrange, fit, focus, count); $('.canvas-topline').after(bar); updateCanvasActions();
}
function downloadJSON(value, filename) {
  const blob = new Blob([typeof value === 'string' ? value : stableStringify(value)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = el('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const CANVAS_FILE_LIMIT = 24 * 1024 * 1024;
function checkedCanvasFile(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > CANVAS_FILE_LIMIT) throw new Error('画布 JSON 最大为 24 MiB，请拆分画布');
  const document = parseJSONWithSafeNumbers(source.replace(/^\uFEFF/, ''));
  validateCanvasStructure(document);
  return document;
}
function exportProject() {
  const source = serializeGraph(graph, viewport);
  checkedCanvasFile(source);
  parseGraph(source);
  downloadJSON(source, `frameweave-canvas-${new Date().toISOString().slice(0, 10)}.json`);
  save(true); toast('已导出画布 JSON（不包含模型与原始素材）');
}
async function importCanvasFile(file) {
  if (workflowCanvas.isRunning()) throw new Error('请先停止后续调度或等待导入完成，再导入其他画布');
  if (file.size > CANVAS_FILE_LIMIT) throw new Error('画布 JSON 最大为 24 MiB，请拆分画布');
  const identity = currentCanvasIdentity(), openingGraph = graph, before = serializeGraph(graph, viewport), title = projectTitle;
  const source = await file.text();
  if (workflowCanvas.isRunning() || currentCanvasIdentity() !== identity || graph !== openingGraph || serializeGraph(graph, viewport) !== before || projectTitle !== title) {
    throw new Error('导入期间画布已变化，未替换当前内容，请重新导入');
  }
  const document = checkedCanvasFile(source);
  if (document?.schema === 'prismcanvas.project.v1') {
    return workflowCanvas.importBundle({ name: file.name, size: new TextEncoder().encode(source).length, text: async () => source.replace(/^\uFEFF/, '') });
  }
  const incoming = parseGraph(document);
  mutate(() => { replaceCanvasIdentity(); graph = { nodes: incoming.nodes, edges: incoming.edges }; viewport = incoming.viewport; selected.clear(); selectedEdge = null; setProjectTitle(importedProjectTitle(file.name)); });
  applyViewport(); save(true); toast('画布已导入。原画布可通过撤销恢复。');
}
async function compileNode(node) {
  const inspection = await canvasInspection.compile(node.id);
  inspection.ensureCurrent();
  downloadJSON(inspection.result.prompt, `frameweave-${node.data.kind}-api.json`);
  toast(typeof inspection.result.summary === 'string' ? inspection.result.summary : '已按所选输出校验并导出执行工作流 JSON');
}
async function refreshEngine(showToast = false) {
  try {
    engine = await api('/api/status');
    $('#engine-status').classList.toggle('online', !!engine.online); $('#engine-status').classList.toggle('offline', !engine.online);
    $('#engine-label').textContent = engine.online ? '本地引擎已连接' : '本地引擎未连接';
    $('#engine-status').title = engine.online ? `${engine.backend_url || settings.backend_url} · ${engine.devices?.map(item => typeof item === 'string' ? item : item.name).filter(Boolean).join(' / ') || '点击检查环境'}` : '点击查看缺失项与修复提示词';
    if (showToast) toast(engine.online ? '已连接本地推理引擎' : '引擎尚未就绪，可复制环境检查中的修复提示词', !engine.online);
    if (environment) renderEnvironment();
  } catch (error) {
    engine.online = false; $('#engine-status').classList.remove('online'); $('#engine-status').classList.add('offline'); $('#engine-label').textContent = '本地服务不可用';
    if (showToast) throw error;
  } finally { studio?.refresh(); }
}
function knownLocalPaths() {
  return [...(settings.model_roots || []), ...(settings.comfy_roots || []), ...(environment?.installations || []).flatMap(item => [item.root, typeof item.python === 'string' ? item.python : item.python?.path, ...(item.model_roots || [])])].filter(value => typeof value === 'string');
}
function renderDiagnosticChecks() {
  const categoryNames = { hardware: '硬件与驱动', gpu: '硬件与驱动', runtime: '运行环境', python: 'Python 环境', packages: 'Python 依赖', backend: '推理服务', node: '工作流节点', nodes: '工作流节点', custom_nodes: '自定义节点', models: '模型文件', model: '模型文件', inputs: '工作流输入', workflow: '当前工作流', environment: '本地环境' };
  diagnosticChecks = mergeDiagnosticChecks(environment?.checks || [], workflowChecks);
  const counts = { ok: 0, missing: 0, error: 0, warning: 0, unknown: 0 };
  const groups = new Map();
  for (const check of diagnosticChecks) {
    const status = Object.hasOwn(counts, check.status) ? check.status : 'unknown'; counts[status]++;
    const name = categoryNames[check.category] || check.category || '其他检查';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ ...check, status });
  }
  const countArea = $('#diagnostic-counts'); countArea.replaceChildren();
  for (const [status, name] of Object.entries({ ok: '就绪', missing: '缺失', error: '错误', warning: '提醒', unknown: '待确认' })) countArea.append(el('span', `diagnostic-count ${status}`, `${counts[status]} ${name}`));
  const list = $('#diagnostic-list'); list.replaceChildren();
  for (const [name, checks] of groups) {
    const group = el('section', 'check-group'); group.append(el('h3', '', name));
    checks.forEach(check => {
      const row = el('div', `check-row ${check.status}`); row.append(el('span', 'check-symbol', { ok: '✓', warning: '!', missing: '×', error: '×', unknown: '?' }[check.status]));
      const body = el('div'); body.append(el('div', 'check-name', check.name), el('div', 'check-detail', check.detail)); row.append(body); group.append(row);
    }); list.append(group);
  }
  const prompt = workflowRepair || '请协助我补齐棱光 PrismCanvas 本地图片 / 视频工作流环境。先解释缺失项与操作影响，再给出可核查的安装、配置与验证步骤。保留现有模型和数据；不要把“待确认”当成已安装或已损坏。';
  $('#repair-prompt').value = redactLocalText(prompt, knownLocalPaths());
  $('#copy-repair').disabled = !diagnosticChecks.length; $('#export-diagnostics').disabled = !diagnosticChecks.length;
}
function hasActiveJobs() { return submitting.size > 0 || !!studio?.hasPending() || jobs.some(isJobActive); }
function canUseBackend(url) { return !submitting.size && !studio?.hasPending() && canSwitchJobBackend(jobs, url, settings.backend_url); }
async function useBackend(url) {
  await pollJobs();
  if (!canUseBackend(url)) throw new Error('仍有未结束或待确认的任务；只能恢复全部原任务所属的引擎，不能切到新引擎。');
  const result = await api('/api/settings', { ...settings, backend_url: url });
  settings = result.settings || { ...settings, backend_url: url };
  $('#backend-url').value = settings.backend_url;
  await refreshEngine(true); renderInspector(); renderEnvironment();
  if ($('#diagnostics-dialog').open) await runDiagnostics(getNode(diagnosticNodeId) || selectedGeneration());
}
function openSettings(modelRoots = null) {
  workspaceTools.refreshSettings();
  $('#auto-update').checked = Boolean(settings.auto_update);
  updateCenter.refresh();
  $('#engine-autostart').checked = Boolean(settings.auto_start_engine);
  engineCenter.refresh();
  $('#backend-url').value = settings.backend_url;
  $('#model-roots').value = [...new Set(modelRoots ? [...(settings.model_roots || []), ...modelRoots] : settings.model_roots || [])].join('\n');
  $('#comfy-roots').value = (settings.comfy_roots || []).join('\n');
  $('#settings-dialog').showModal();
}
function renderEnvironment() {
  const target = $('#environment-discoveries'); target.replaceChildren();
  if (!environment) return;
  const online = (environment.candidates || []).filter(item => item.online);
  const alternatives = online.filter(item => item.url !== settings.backend_url);
  $('#environment-status').textContent = `发现 ${online.length} 个可用服务 · ${(environment.installations || []).length} 个安装目录 · ${Math.round(Number(environment.elapsed_ms) || 0)} ms${environment.scanned_at ? ` · ${new Date(environment.scanned_at).toLocaleString('zh-CN', { hour12: false })}` : ''}`;
  $('#discovery-banner').hidden = engine.online || !alternatives.length;
  if (!engine.online && alternatives.length) $('#discovery-message').textContent = `自动发现 ${alternatives.length} 个可用本地引擎，当前地址尚未连接`;
  const probes = el('details', 'environment-probes');
  probes.append(el('summary', '', '其他常用端口的探测结果 · 未启用不代表环境缺失'));
  for (const candidate of environment.candidates || []) {
    const active = candidate.url === settings.backend_url;
    const optional = !active && !candidate.online && candidate.classification === 'probe_only';
    const title = candidate.online ? active ? '当前生成引擎 · 已连接' : '其他可用推理引擎' : optional ? '备用探测端口 · 未发现服务' : active ? '当前生成引擎 · 连接失败' : '发现的引擎 · 暂不可访问';
    const row = el('div', `environment-card${candidate.online ? ' available' : ''}`), body = el('div', 'environment-card-body');
    body.append(el('strong', '', title), el('span', 'inline-code', candidate.url), el('span', 'field-help', [candidate.source, candidate.version ? `ComfyUI ${candidate.version}` : ''].filter(Boolean).join(' · ')));
    if (!candidate.online) body.append(el('span', 'field-help', candidate.detail || ({refused:'此地址没有服务接受连接，请检查引擎是否启动与端口是否一致。',timeout:'服务响应超时，请查看引擎日志及启动状态。',non_comfy:'端口有响应，但不是可确认的 ComfyUI 接口。',identity_unknown:'端口有响应，尚不能确认服务身份。'}[candidate.offline_reason] || '此端口没有返回可确认的推理服务。')));
    if (optional) body.append(el('span', 'field-help', '仅用于自动发现；当前引擎可用时，无需安装或启动此端口。'));
    const action = button(active ? '当前地址' : '使用此后端', 'button quiet compact', () => useBackend(candidate.url)); action.disabled = active || !candidate.online || !canUseBackend(candidate.url);
    if (!canUseBackend(candidate.url) && !active) action.title = '有未结束或待确认任务，只能恢复原任务所属引擎'; row.append(body); if (!optional) row.append(action); (optional ? probes : target).append(row);
  }
  if (probes.children.length > 1) target.append(probes);
  for (const installation of environment.installations || []) {
    const row = el('div', 'environment-card');
    const body = el('div', 'environment-card-body'); body.append(el('strong', '', installation.source || '本地安装'), el('span', 'inline-code path-text', installation.root));
    if (installation.python) body.append(el('span', 'field-help path-text', `Python：${typeof installation.python === 'string' ? installation.python : installation.python.path || installation.python.detail || '尚未确认'}`));
    const roots = (installation.model_roots || []).filter(value => typeof value === 'string');
    body.append(el('span', 'field-help', roots.length ? `${roots.length} 个模型目录可填入设置` : '未找到可确认的模型目录')); row.append(body);
    if (roots.length) row.append(button('填入模型目录', 'button quiet compact', () => openSettings(roots)));
    target.append(row);
  }
  if (environment.hardware) {
    const hardware = el('div', 'environment-hardware');
    const gpus = (environment.hardware.gpus || []).map(gpu => typeof gpu === 'string' ? gpu : gpu.name || gpu.model || '').filter(Boolean);
    hardware.append(el('strong', '', gpus.join(' / ') || '硬件信息待确认'), el('p', 'field-help', environment.hardware.detail || '硬件可见性与当前推理进程的可用性分别检查。')); target.append(hardware);
  }
  if (environment.notes?.length) target.append(el('p', 'form-note', environment.notes.join(' ')));
  renderDiagnosticChecks();
}
async function scanEnvironment() {
  if (environmentPending) return environmentPending;
  $('#environment-status').textContent = '正在自动识别本地服务与安装环境…';
  environmentPending = (async () => {
    try { environment = await api('/api/environment', {}); renderEnvironment(); return environment; }
    catch (error) { $('#environment-status').textContent = `自动发现未完成：${error.message}`; throw error; }
    finally { environmentPending = null; }
  })();
  return environmentPending;
}
async function runDiagnostics(node = selectedGeneration(), scan = false) {
  const dialog = $('#diagnostics-dialog'); if (!dialog.open) dialog.showModal();
  if (diagnosticBusy) return;
  diagnosticNodeId = node?.id || null; diagnosticBusy = true;
  $('#diagnostic-summary').textContent = `正在检查${node ? `「${node.data.title}」的` : ''}节点、模型与输入…`;
  $('#diagnostic-refresh').disabled = true; workflowChecks = []; workflowRepair = ''; renderDiagnosticChecks();
  try {
    const empty = { checks: [], summary: '已检查本地服务与硬件。选择生成方式或工作流后，可继续检查对应的节点、模型和输入。', repair_prompt: '' };
    const inspect = !canvasIsActive() ? async () => {
      const context = captureRequestInspection({ api, backend: () => settings.backend_url,
        context: () => ({ workspace: document.body.dataset.workspace, request: studio.diagnosticsRequest?.() }) });
      const payload = studio.diagnosticsRequest?.();
      await context.checkBackend();
      return { ...context, result: payload ? await api('/api/diagnostics', payload) : empty };
    } : node ? () => canvasInspection.diagnose(node.id) : () => ({ result: empty });
    const [inspection, discoveryResult] = await inspectWithDiscovery(inspect, () => scan || !environment ? scanEnvironment() : environment);
    if (discoveryResult.status === 'rejected') $('#environment-status').textContent = `自动发现未完成：${discoveryResult.reason.message}`;
    if (inspection.status === 'rejected') throw inspection.reason;
    await refreshEngine(); await inspection.value.checkBackend?.(); inspection.value.ensureCurrent?.();
    const result = inspection.value.result;
    workflowChecks = Array.isArray(result.checks) ? result.checks : []; workflowRepair = result.repair_prompt || '';
    $('#diagnostic-summary').textContent = typeof result.summary === 'string' ? result.summary : `已检查${node ? `「${node.data.title}」` : '当前工作流'}，未知项仍需人工确认。`;
    renderDiagnosticChecks(); renderEnvironment();
    if (!$('#properties-panel').contains(document.activeElement)) renderInspector();
  } catch (error) {
    workflowChecks = [{ category: 'workflow', status: 'unknown', name: '当前工作流检查未完成', detail: error.message }];
    $('#diagnostic-summary').textContent = error.message; renderDiagnosticChecks();
  } finally { diagnosticBusy = false; $('#diagnostic-refresh').disabled = false; }
}
async function runNode(id) {
  if (!getNode(id)) return;
  return workflowCanvas.run([id]);
}
function acceptCanvasWorkflowJob(id, job) {
  if (!job?.id) return;
  const node = getNode(id);
  if (node?.type === 'generation' && workflowCanvas.state()?.canvas_id === currentCanvasIdentity()) {
    jobNodes[job.id] = id;
    mutate(() => {
      let targets = graph.edges.filter(edge => edge.source === id).map(edge => getNode(edge.target)).filter(item => item?.type === 'result');
      if (!targets.length && graph.nodes.length < 500 && graph.edges.length < 2000) {
        const result = createNode('result', node.x + nodeSize(node).width + 64, node.y, { title: `${node.data.title} · 结果` });
        placeNewNodes([result]); graph.nodes.push(result); connect(graph, id, result.id); targets = [result];
      }
      targets.forEach(target => { target.data.jobId = job.id; target.data.outputs = clone(job.outputs || []); });
    });
  }
  jobs = [{ ...job, elapsed: job.elapsed || 0, outputs: job.outputs || [] }, ...jobs.filter(item => item.id !== job.id)];
  renderJobs(); save(true); pollJobs();
}
function duration(seconds) { seconds = Math.max(0, Math.floor(Number(seconds) || 0)); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`; }
function updateNodeJobStatus() {
  document.querySelectorAll('[data-live-node]').forEach(element => {
    const job = jobs.find(item=>jobNodes[item.id]===element.dataset.liveNode);
    element.hidden = !isJobActive(job);
    // Clear retained sampling text and preview callbacks even after hiding the
    // live section; terminal jobs must not leave pending status in the DOM.
    if (!job) return;
    updateLiveProgress({detail:element.querySelector('.live-detail'),bar:element.querySelector('progress'),image:element.querySelector('.live-preview'),caption:element.querySelector('.live-preview-status')}, job);
  });
  document.querySelectorAll('[data-node-status]').forEach(element => {
    const job = jobs.find(item => jobNodes[item.id] === element.dataset.nodeStatus);
    element.classList.toggle('error', job?.status === 'failed');
    element.textContent = job ? `${job.status === 'completed' ? '✓' : job.status === 'failed' ? '!' : '○'} ${jobStatusLabel(job)} · ${duration(job.elapsed)}` : '○ 等待提交';
  });
  document.querySelectorAll('[data-result-status],[data-result-headline],[data-result-detail]').forEach(element => {
    const id = element.dataset.resultStatus ?? element.dataset.resultHeadline ?? element.dataset.resultDetail;
    if (!id) return;
    const job = jobs.find(item => item.id === id);
    if ('resultStatus' in element.dataset) element.textContent = job ? jobStatusLabel(job) : '等待同步';
    else if ('resultHeadline' in element.dataset) element.textContent = job ? jobStatusLabel(job) : '正在同步任务';
    else element.textContent = jobStateDetail(job) || { queued: '引擎开始执行后，生成状态会自动更新。', running: '图像与视频生成完成后会自动出现在这里。', failed: '在任务列表查看错误详情，修复后可再次生成。', cancelled: '原始参数仍保留，可在任务列表复用或再次生成。', completed: '此任务没有可预览的图像或视频输出，请检查工作流输出节点。' }[job?.status] || '请保持本地服务运行，或在任务列表查看记录。';
  });
}

function jobTitle(job) { return getNode(jobNodes[job.id])?.data.title || job.summary?.package_name || KIND_NAMES[job.kind] || `任务 ${job.id.slice(0, 8)}`; }
function resultForJob(id) { return graph.nodes.find(node => node.type === 'result' && node.data.jobId === id); }
function placeJobOnCanvas(id, focus = true) {
  const job = jobs.find(item => item.id === id);
  if (!job) throw new Error('此任务已不在本地列表中，请刷新后重试。');
  let node = resultForJob(id);
  if (!node) {
    if (graph.nodes.length >= 500) throw new Error('当前画布已满，请先导出或整理节点。');
    const previous = resultForJob(job.retry_of), source = job.retry_of ? null : getNode(jobNodes[id]);
    // Exact retries may differ from a subsequently edited generation card.
    // Keep their result independent; reuse explicitly restores the saved recipe.
    const anchor = previous || source || getNode(jobNodes[job.retry_of]);
    const point = viewPoint(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2);
    node = createNode('result', anchor ? anchor.x + nodeSize(anchor).width + 64 : point.x - 169, anchor?.y ?? point.y - 160, { title: `${jobTitle(job)} · 结果`, jobId: id, outputs: clone(job.outputs || []) });
    placeNewNodes([node]);
    mutate(() => {
      graph.nodes.push(node); selected = new Set([node.id]); selectedEdge = null;
      if (source?.type === 'generation' && graph.edges.length < 2000) { connect(graph, source.id, node.id); jobNodes[id] = source.id; }
    });
    centerOnNode(node);
  }
  if (focus) { selected = new Set([node.id]); selectedEdge = null; renderSelection(); renderInspector(); centerOnNode(node); switchTab('properties'); }
  renderJobs(); save(true);
  return node;
}
function installRecipe(recipe) {
  const anchor = singleSelected();
  const point = viewPoint(canvas.getBoundingClientRect().left + canvas.clientWidth / 2, canvas.getBoundingClientRect().top + canvas.clientHeight / 2);
  // Validate the recipe at a safe origin before placing it near an imported
  // node that may already be at the canvas coordinate boundary.
  const fragment = recipeGraph(recipe, 0, 0);
  if (graph.nodes.length + fragment.nodes.length > 500 || graph.edges.length + fragment.edges.length > 2000) throw new Error('当前画布已满，请先导出或整理节点再复用。');
  let referenceY = 0;
  for (const reference of fragment.nodes.filter(node => node.type === 'reference')) { reference.y = referenceY; referenceY += placementSize(reference).height + 36; }
  placeNewNodes(fragment.nodes, { x: anchor ? anchor.x + nodeSize(anchor).width + 64 : point.x - 152, y: anchor?.y ?? point.y - 160 });
  mutate(() => { graph.nodes.push(...fragment.nodes); graph.edges.push(...fragment.edges); selected = new Set([fragment.generationId]); selectedEdge = null; });
  const node = getNode(fragment.generationId);
  centerOnNode(node); switchTab('properties'); save(true);
  return node;
}
async function reuseJob(id) {
  if (reusing.has(id)) return;
  const source = jobs.find(job => job.id === id);
  if (!source || !source.backend) throw new Error('原任务不在当前队列或缺少后端身份，请刷新后重试');
  const sourceKind = source.kind, sourceBackend = source.backend;
  const startedGraph = graph, startedIdentity = currentCanvasIdentity(), startedSnapshot = snapshot();
  const startedWorkspace = document.body.dataset.workspace;
  reusing.add(id);
  try {
    renderJobs();
    const recipe = await api(`/api/jobs/${encodeURIComponent(id)}/recipe`);
    if (graph !== startedGraph || currentCanvasIdentity() !== startedIdentity || snapshot() !== startedSnapshot
      || document.body.dataset.workspace !== startedWorkspace
      || !jobs.some(job => job.id === id && job.kind === sourceKind && job.backend === sourceBackend)) {
      throw new Error('读取期间画布、选择、页面或原任务已变化，未添加节点；请重新复用');
    }
    if ((recipe.job_id && recipe.job_id !== id) || (recipe.backend && recipe.backend !== sourceBackend)) {
      throw new Error('参数记录与原任务身份不一致，请刷新后重试');
    }
    installRecipe({ ...recipe, backend: sourceBackend });
    toast('已添加独立生成节点，可修改参数后再生成');
    for (const warning of recipe.warnings || []) toast(warning);
  } finally { reusing.delete(id); renderJobs(); }
}
async function retryJob(id) {
  if (isJobActive(jobs.find(job => job.id === id))) throw new Error('原任务尚未确认结束，请查询原任务，不能换请求再次生成。');
  if (retrying.has(id)) return;
  retrying.add(id);
  if (!retryRequests.has(id)) { retryRequests.set(id, crypto.randomUUID()); saveRetryRequests(); }
  renderJobs();
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}/retry`, { request_id: retryRequests.get(id) });
    if (!job.id) throw new Error('服务没有返回任务 ID，请先检查队列。再次点击会查询同一次请求。');
    retryRequests.delete(id); saveRetryRequests();
    jobs = [job, ...jobs.filter(item => item.id !== job.id)];
    if (!resultForJob(job.id) && graph.nodes.length < 500) placeJobOnCanvas(job.id, false);
    switchTab('jobs'); save(true); toast('任务已加入队列；原参数和随机种子保持不变');
    await pollJobs();
  } finally { retrying.delete(id); renderJobs(); }
}
function saveRetryRequests() {
  try { localStorage.setItem(RETRY_REQUESTS_KEY, JSON.stringify([...retryRequests].slice(-200))); }
  catch { /* The current page still retains retry identities when browser storage is full. */ }
}
async function controlJob(id, operation) {
  if (!['cancel', 'refresh'].includes(operation)) throw new Error('任务操作无效');
  if (controllingJobs.has(id)) return;
  const original = jobs.find(job => job.id === id);
  if (!original || !(operation === 'cancel' ? canCancelJob(original) : canRefreshJob(original))) throw new Error('请先查询原任务，当前不能执行此操作。');
  const owner = original.backend;
  controllingJobs.add(id);
  try {
    renderJobs(); studio?.refresh();
    const result = await api(`/api/jobs/${encodeURIComponent(id)}/${operation}`, {});
    if (result?.id !== id || result.backend && result.backend !== owner || typeof result.status !== 'string') throw new Error('原任务响应身份不一致，请重新查询；不会创建新任务。');
    const current = jobs.findIndex(job => job.id === id && job.backend === owner);
    if (current >= 0 && !(isJobTerminal(jobs[current]) && !isJobTerminal(result))
        && !(Number(jobs[current].cancellation?.updated_at) > Number(result.cancellation?.updated_at))) jobs[current] = { ...jobs[current], ...result };
    const visible = current >= 0 ? jobs[current] : result;
    toast(operation === 'cancel' ? jobStateDetail(visible) || jobStatusLabel(visible) : `原任务：${jobStatusLabel(visible)}`);
    await pollJobs();
  } catch (error) {
    await pollJobs();
    throw new Error(`${operation === 'cancel' ? '取消结果请以原任务状态为准，可点击“查询原任务”。' : '原任务查询未完成。'} ${error.message}`);
  } finally { controllingJobs.delete(id); renderJobs(); studio?.refresh(); }
}

function newJobView(id) {
  const card = el('article', 'job-card'); card.dataset.jobId = id;
  const heading = el('div', 'job-heading'), title = el('span', 'job-title'), status = el('span', 'job-tag'); heading.append(title, status);
  const time = el('div', 'job-time'), elapsed = el('span'); time.append(elapsed, el('span', '', id.slice(0, 8)));
  const track = el('div', 'progress-track'), bar = el('div', 'progress-bar'); track.append(bar); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', '当前节点采样进度');
  const state = el('div', 'progress-state'), error = el('p', 'job-error'), warning = el('p', 'job-warning'), provenance = el('p', 'job-provenance'), thumbs = el('div', 'job-thumbs');
  const livePreview = el('img', 'live-preview'); livePreview.alt = '采样中间预览，尚未完成'; livePreview.hidden = true;
  const previewStatus = el('small', 'live-preview-status');
  const actions = el('div', 'job-actions');
  const reuse = button('复用参数', 'job-action', () => reuseJob(id), '把原任务参数添加为独立节点，不会自动开始生成');
  const locate = button('放入画布', 'job-action', () => placeJobOnCanvas(id), '在当前画布中查看任务结果，不会重新提交生成');
  const retry = button('再次生成', 'job-action', () => retryJob(id), '以原任务参数和随机种子再提交一次，由当前引擎重新校验');
  const cancel = button('取消任务', 'job-action job-cancel', () => controlJob(id, 'cancel'));
  const refresh = button('查询原任务', 'job-action job-refresh', () => controlJob(id, 'refresh'));
  actions.append(locate, reuse, retry, cancel, refresh); card.append(heading, time, track, state, error, warning, provenance, livePreview, previewStatus, thumbs, actions);
  return { card, title, status, elapsed, track, bar, state, error, warning, provenance, livePreview, previewStatus, thumbs, locate, reuse, retry, cancel, refresh, outputSignature: '' };
}
function renderJobs() {
  $('#job-count').textContent = String(jobs.filter(isJobActive).length);
  const list = $('#jobs-list');
  const filtered = filterJobs(jobs, $('#job-status-filter').value, $('#job-search').value, jobTitle);
  const unattached = jobs.filter(job => !resultForJob(job.id)).length;
  $('#jobs-filter-count').textContent = `显示 ${filtered.length} / ${jobs.length} 个任务${unattached ? ` · ${unattached} 个可放入画布` : ''}`;
  const visible = new Set(filtered.map(job => job.id));
  const current = new Set(jobs.map(job => job.id));
  jobViews.forEach((view, id) => {
    if (!current.has(id)) { releaseMedia(view.card); view.card.remove(); jobViews.delete(id); }
    else if (!visible.has(id)) { view.card.hidden = true; view.card.querySelectorAll('video,audio').forEach(media => media.pause()); }
  });
  const existingEmpty = list.querySelector('.jobs-empty'); if (existingEmpty) existingEmpty.remove();
  if (!filtered.length) list.append(el('div', 'jobs-empty', jobs.length ? '没有符合当前筛选的任务。\n试试其他状态或清空搜索。' : '还没有生成任务\n选中生成节点，点击「开始生成」。'));
  const write = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  filtered.forEach((job, index) => {
    let view = jobViews.get(job.id);
    if (!view) { view = newJobView(job.id); jobViews.set(job.id, view); }
    view.card.hidden = false;
    write(view.title, jobTitle(job)); write(view.status, jobStatusLabel(job)); view.status.className = `job-tag ${job.status}`;
    write(view.elapsed, elapsedText(job));
    const progress = job.status === 'unknown' ? null : progressPercent(job.progress); view.bar.style.width = `${job.status === 'completed' ? 100 : progress ?? 0}%`;
    const active = isJobActive(job);
    view.track.classList.toggle('indeterminate', active && progress === null);
    view.livePreview.hidden = !active || !job.preview_url;
    if (active && job.preview_url && view.livePreview.getAttribute('src') !== job.preview_url) view.livePreview.src = job.preview_url;
    view.previewStatus.hidden = !active; write(view.previewStatus, previewStatusText(job));
    view.track.classList.toggle('is-stale', active && Boolean(job.progress_stale || job.progress_connected === false || job.client_connection_lost));
    const progressValue = job.status === 'completed' ? 100 : progress;
    if (progressValue === null) view.track.removeAttribute('aria-valuenow'); else view.track.setAttribute('aria-valuenow', String(Math.round(progressValue)));
    view.track.setAttribute('aria-valuetext', active ? liveProgressText(job) : STATUS_NAMES[job.status] || job.status);
    view.state.hidden = !active;
    write(view.state, liveProgressText(job));
    write(view.error, String(job.error || '')); view.error.hidden = !job.error;
    const warnings = [jobStateDetail(job), job.retry_warning, job.storage_warning].filter(Boolean).join('\n'); write(view.warning, warnings); view.warning.hidden = !warnings;
    const attached = !!resultForJob(job.id);
    const provenance = [job.retry_of ? `来自任务 ${String(job.retry_of).slice(0, 8)} · 保留原始参数` : '', !attached ? '尚未放入当前画布，可直接添加结果或复用参数' : ''].filter(Boolean).join('\n');
    write(view.provenance, provenance); view.provenance.hidden = !provenance;
    const signature = JSON.stringify(job.outputs || []);
    if (view.outputSignature !== signature) {
      releaseMedia(view.thumbs); view.thumbs.replaceChildren();
      (job.outputs || []).forEach(output => { const item = button('', '', () => preview(output), `预览 ${output.filename || '输出'}`); item.append(outputMedia(output, '')); view.thumbs.append(item); });
      view.outputSignature = signature;
    }
    view.thumbs.hidden = !job.outputs?.length;
    write(view.locate, attached ? '定位画布' : '放入画布'); view.locate.setAttribute('aria-label', attached ? '定位画布' : '放入画布'); view.locate.disabled = !attached && graph.nodes.length >= 500;
    view.reuse.disabled = !job.can_reuse || reusing.has(job.id); write(view.reuse, reusing.has(job.id) ? '正在读取…' : '复用参数');
    view.retry.hidden = active; view.retry.disabled = active || !job.can_retry || retrying.has(job.id); write(view.retry, retrying.has(job.id) ? '正在提交…' : retryRequests.has(job.id) ? '查询 / 重试请求' : '再次生成');
    view.cancel.hidden = !active;
    view.cancel.disabled = !canCancelJob(job) || controllingJobs.has(job.id); write(view.cancel, cancelActionLabel(job));
    view.refresh.hidden = !canRefreshJob(job); view.refresh.disabled = controllingJobs.has(job.id);
    if (list.children[index] !== view.card) list.insertBefore(view.card, list.children[index] || null);
  });
  updateNodeJobStatus();
}

async function pollJobs() {
  if (pollBusy || !csrf) return;
  pollBusy = true;
  try {
    const response = await api('/api/jobs');
    const incoming = Array.isArray(response.jobs) ? response.jobs : [];
    let outputsChanged = false;
    jobs = incoming;
    for (const node of graph.nodes.filter(item => item.type === 'result' && item.data.jobId)) {
      const job = jobs.find(item => item.id === node.data.jobId);
      if (job?.status === 'completed' && JSON.stringify(node.data.outputs) !== JSON.stringify(job.outputs || [])) { node.data.outputs = clone(job.outputs || []); outputsChanged = true; }
    }
    renderJobs();
    if (outputsChanged) { renderNodes(); if (singleSelected()?.type === 'result') renderInspector(); save(); }
  } catch {
    for (const job of jobs) if (isJobActive(job)) {
      job.progress_connected = false; job.progress_stale = Boolean(job.stage);
      job.preview_stale = Boolean(job.preview_url); job.client_connection_lost = true;
    }
    renderJobs();
  }
  finally { pollBusy = false; studio?.refresh(); }
}
function switchTab(tab) {
  const properties = tab === 'properties';
  $(properties ? '#jobs-panel' : '#properties-panel').querySelectorAll('video,audio').forEach(media => media.pause());
  $('#tab-properties').classList.toggle('active', properties); $('#tab-properties').setAttribute('aria-selected', String(properties));
  $('#tab-jobs').classList.toggle('active', !properties); $('#tab-jobs').setAttribute('aria-selected', String(!properties));
  $('#properties-panel').hidden = !properties; $('#jobs-panel').hidden = properties;
}
function chooseReference(id = null) { uploadTarget = {id, identity: currentCanvasIdentity()}; $('#reference-input').click(); }
let resultReferenceDialog = null, resultReferenceOpening = false;
async function passResultToWorkflow(source, output) {
  if (resultReferenceOpening) return;
  resultReferenceOpening = true;
  const identity = currentCanvasIdentity();
  try {
    resultReferenceDialog?.close();
    resultReferenceDialog = await openResultReferenceDialog({ source, initialOutputId: output?.output_id, api,
      current: () => {
        if (currentCanvasIdentity() !== identity || getNode(source.id) !== source) throw new Error('画布或结果节点已变化，请重新选择产物');
        return { graph, canvasId: identity, backend: settings.backend_url };
      },
      apply: ({ reference, edge }, ticket) => {
        placeNewNodes([reference]);
        mutate(() => { graph.nodes.push(reference); graph.edges.push(edge); selected = new Set([ticket.target.id]); });
        revealInspector(); switchTab('properties'); centerOnNode(ticket.target);
        toast('参考素材已连接，可进入工作流查看或继续调参；尚未开始生成');
      },
    });
  } finally { resultReferenceOpening = false; }
}
let resultEditBusy = false;
async function editOutput(source, output, kind) {
  if (resultEditBusy) { toast('正在接入图片，请稍候…'); return; }
  resultEditBusy = true;
  const identity = currentCanvasIdentity();
  try {
    toast('正在把图片接入编辑…');
    const { reference, target, edge, assertCurrent } = await prepareResultEdit({ source, outputId: output?.output_id, kind, api,
      position: { x: source.x + nodeSize(source).width + 444, y: source.y },
      current: () => {
        if (currentCanvasIdentity() !== identity || getNode(source.id) !== source) throw new Error('画布或结果节点已变化，请重新选择产物');
        return { graph, canvasId: identity, backend: settings.backend_url };
      },
    });
    assertCurrent(); placeNewNodes([reference, target]);
    mutate(() => { graph.nodes.push(reference, target); graph.edges.push(edge); selected = new Set([target.id]); });
    centerOnNode(target); revealInspector(); switchTab('properties'); toast('图片已接入编辑目标，可继续添加参考和调参；尚未开始生成');
  } finally { resultEditBusy = false; }
}
async function uploadImage(file) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('参考素材支持 PNG、JPG、WebP 图片。视频输出可在生成后预览。');
  if (file.size > 20 * 1024 * 1024) throw new Error('初版单张参考图上限为 20 MiB，请先缩小图片。');
  toast(`正在导入 ${file.name}…`);
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('无法读取素材')); reader.readAsDataURL(file); });
  const uploadBackend = settings.backend_url;
  const uploaded = await api('/api/upload', { name: file.name, data });
  if (!uploaded?.name || !uploaded.url) throw new Error('上传服务没有返回有效素材引用');
  if (!uploaded.backend || uploaded.backend !== uploadBackend || settings.backend_url !== uploadBackend) throw new Error('上传期间推理引擎发生了切换，或服务未确认图片来源。本次图片不会写入画布，请在目标引擎下重新上传。');
  return uploaded;
}
async function importReferenceFiles(files, targetId = null, point = null, identity = currentCanvasIdentity()) {
  if (!files.length) return;
  const target = targetId ? getNode(targetId) : null;
  if (identity !== currentCanvasIdentity() || targetId && target?.type !== 'reference') throw new Error('原参考节点或画布已改变，请重新选择素材');
  if (graph.nodes.length + files.length - (target ? 1 : 0) > 500) throw new Error('素材数量超过画布剩余容量，请减少选择或整理节点');
  const origin = point || (target ? {x: target.x + 360, y: target.y} : viewPoint(canvas.getBoundingClientRect().left + 60, canvas.getBoundingClientRect().top + 120));
  const ticket = Symbol('media import');
  if (target) referenceImportTickets.set(targetId,ticket);
  let count = 0, lastImported = null;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    let destination = null, previewURL = null;
    try {
      if (target && (getNode(targetId) !== target || referenceImportTickets.get(targetId) !== ticket)) break;
      if (currentCanvasIdentity() !== identity) throw new Error('画布已切换，素材未放入新画布');
      const mediaType = validateMediaFile(file);
      // Reuse collision-aware placement, reserving space for media that loads
      // later. Preserve the viewport during drops and multi-file preparation.
      destination = index === 0 && target ? target : addNode('reference', {title:file.name.replace(/\.[^.]+$/, '').slice(0,50),mediaType}, importPosition(origin,index-(target?1:0)),false,false);
      referenceImportTickets.set(destination.id,ticket);
      previewURL = URL.createObjectURL(file);
      referenceImports.set(destination.id,{ticket,previewURL,mediaType,message:'预览已就绪 · 正在保存到客户端…'}); renderNodes();
      const asset = await storeLocalMedia(file);
      if (target && (getNode(targetId) !== target || referenceImportTickets.get(targetId) !== ticket)) break;
      if (!/^[a-f0-9]{64}$/.test(asset?.asset_id || '') || asset.media_type !== mediaType) throw new Error('客户端没有返回有效的本地素材');
      if (currentCanvasIdentity() !== identity) throw new Error('画布已切换，本地素材已保存，请在目标画布重新选择');
      if (getNode(destination.id) !== destination || referenceImportTickets.get(destination.id) !== ticket) continue;
      const values = {localAssetId:asset.asset_id, localMedia:true, localFilename:file.name, name:'', uploadBackend:'', url:`/api/assets/media/${asset.asset_id}`, mediaType};
      const candidate=clone(graph);Object.assign(candidate.nodes.find(n=>n.id===destination.id).data,values);
      try{parseGraph(serializeGraph(candidate));}catch(error){throw new Error(`素材与现有输入端口不匹配，请先断开对应连线：${error.message}`);}
      referenceImports.delete(destination.id); mutate(() => Object.assign(destination.data, values));
      count++; lastImported = destination;
    } catch(error) {
      if (destination && getNode(destination.id) === destination && referenceImports.get(destination.id)?.ticket === ticket) { referenceImports.set(destination.id, {ticket,message:`保存失败：${error.message}。请重新选择素材。`,error:true}); renderNodes(); }
      reportError(new Error(`${file.name}：${error.message}`));
      if (currentCanvasIdentity() !== identity) break;
    } finally { if (previewURL) URL.revokeObjectURL(previewURL); }
  }
  if (count) {
    if (!point && !target && lastImported && getNode(lastImported.id) === lastImported && currentCanvasIdentity() === identity) centerOnNode(lastImported);
    toast(`已将 ${count} 个素材保存到客户端，推理引擎未启动也可预览`);
  }
}
async function storeLocalMedia(file) {
  validateMediaFile(file);
  const response = await fetch(`/api/assets/media?name=${encodeURIComponent(file.name)}`, {method:'POST',headers:{'Content-Type':mediaFileContentType(file),'X-FW-Token':csrf},body:file});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `保存素材失败（${response.status}）`);
  return result;
}
async function prepareCanvasImages(targets, options = {}) {
  const frozen = clone(options.graph || graph), projection = options.projection || frozen;
  const before = serializeGraph(frozen), identity = options.canvasId || currentCanvasIdentity(), backend = options.backend || settings.backend_url;
  const guard = () => { if (identity !== currentCanvasIdentity() || backend !== settings.backend_url || before !== serializeGraph(graph)) throw new Error('准备素材期间画布或引擎已变化，未提交生成，请重新运行'); };
  guard(); assertCanvasMediaReady(targets, projection, !!options.execution);
  const updates = await prepareLocalImages(projection, targets, backend, async (...args) => {
    guard(); const result = await api(...args); guard(); return result;
  });
  guard(); assertCanvasMediaReady(targets, projection, !!options.execution);
  for (const update of updates) Object.assign(frozen.nodes.find(node => node.id === update.id).data, {name:update.name,uploadBackend:update.uploadBackend});
  if (updates.length) mutate(() => { for (const update of updates) Object.assign(getNode(update.id).data, {name:update.name,uploadBackend:update.uploadBackend}); });
  return frozen;
}

canvas.addEventListener('dblclick', event => {
  if (event.button !== 0 || event.target.closest('.node,button,input,textarea,select,video,audio,a,[data-edge-id],.edge-line')) return;
  event.preventDefault(); cancelConnection(); openNodeMenu(event.clientX, event.clientY);
});
canvas.addEventListener('contextmenu', event => {
  if (event.target.closest('input,textarea,select,[contenteditable=true],video,audio,a')) return;
  event.preventDefault(); openNodeMenu(event.clientX, event.clientY, event.target.closest('.node')?.dataset.nodeId || null);
});
document.addEventListener('pointerdown', event => { if (nodeMenu && !nodeMenu.contains(event.target)) closeNodeMenu(); }, true);
document.addEventListener('pointerdown', () => { if (nodeActionPress.cancel()) requestAnimationFrame(renderNodes); }, true);
document.addEventListener('pointerup', event => { if (nodeActionPress.release(event.pointerId, event.target)) renderNodes(); }, true);
document.addEventListener('pointercancel', event => { if (nodeActionPress.cancel(event.pointerId)) renderNodes(); }, true);
window.addEventListener('blur', () => { if (nodeActionPress.cancel()) renderNodes(); });
window.addEventListener('resize', () => closeNodeMenu());
canvas.addEventListener('wheel', event => {
  if (event.target.closest('textarea,select') && !event.ctrlKey) return;
  closeNodeMenu();
  event.preventDefault();
  const rect = canvas.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .0015), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });
canvas.addEventListener('pointerdown', event => {
  finishKeyboardMove();
  if (event.button !== 0 && event.button !== 1) return;
  const card = event.target.closest('.node');
  const interactive = event.target.closest('button,input,textarea,select,video,audio,a');
  if (event.button === 0 && !spaceDown && tool !== 'hand' && event.target.closest('[data-edge-id],.edge-line')) return;
  if (card && event.button === 0 && !spaceDown && tool !== 'hand') {
    revealInspector();
    if (interactive && !selected.has(card.dataset.nodeId)) {
      selected = new Set([card.dataset.nodeId]); selectedEdge = null; renderSelection(); renderInspector(); switchTab('properties');
    }
  }
  if (interactive && event.button !== 1 && !spaceDown) return;
  if (connecting && !card && event.button === 0) { cancelConnection(); return; }
  const point = viewPoint(event.clientX, event.clientY);
  if (spaceDown || event.button === 1 || tool === 'hand') {
    pointer = { mode: 'pan', x: event.clientX, y: event.clientY, startX: viewport.x, startY: viewport.y, distance: 0 };
    canvas.classList.add('panning');
  } else if (!card) {
    const rect = canvas.getBoundingClientRect(); pointer = { mode: 'box', x: event.clientX - rect.left, y: event.clientY - rect.top, previous: event.shiftKey ? new Set(selected) : new Set() };
    selected = new Set(pointer.previous); selectedEdge = null; renderSelection(); renderEdges();
    const box = $('#selection-box'); box.hidden = false; box.style.left = `${pointer.x}px`; box.style.top = `${pointer.y}px`; box.style.width = '0'; box.style.height = '0';
  } else if (card) {
    const id = card.dataset.nodeId;
    if (event.shiftKey) { if (selected.has(id)) selected.delete(id); else selected.add(id); }
    else if (!selected.has(id)) selected = new Set([id]);
    selectedEdge = null; renderSelection(); renderInspector(); switchTab('properties');
    if (event.target.closest('.node-header') && selected.has(id)) pointer = { mode: 'drag', start: point, before: snapshot(), positions: graph.nodes.filter(node => selected.has(node.id)).map(node => ({ id: node.id, x: node.x, y: node.y })) };
  }
  if (pointer) { canvas.focus({ preventScroll: true }); canvas.setPointerCapture(event.pointerId); event.preventDefault(); }
});
canvas.addEventListener('pointermove', event => {
  const point = viewPoint(event.clientX, event.clientY);
  if (portDrag && event.pointerId === portDrag.id && Math.hypot(event.clientX-portDrag.x,event.clientY-portDrag.y)>4) portDrag.moved = true;
  if (connecting) { connecting.point = point; renderEdges(); }
  if (!pointer) return;
  if (pointer.mode === 'pan') {
    viewport.x = pointer.startX + event.clientX - pointer.x; viewport.y = pointer.startY + event.clientY - pointer.y; pointer.distance = Math.abs(event.clientX - pointer.x) + Math.abs(event.clientY - pointer.y); applyViewport();
  } else if (pointer.mode === 'drag') {
    for (const position of moveSelection(pointer.positions, Math.round(point.x - pointer.start.x), Math.round(point.y - pointer.start.y))) { const node = getNode(position.id); Object.assign(node, position); const element = document.getElementById(`fw-node-${node.id}`); element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; }
    renderEdges();
  } else {
    const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const left = Math.min(pointer.x, x), top = Math.min(pointer.y, y), right = Math.max(pointer.x, x), bottom = Math.max(pointer.y, y);
    const box = $('#selection-box'); Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    selected = new Set(pointer.previous);
    graph.nodes.forEach(node => { const size = nodeSize(node); const nx = node.x * viewport.scale + viewport.x, ny = node.y * viewport.scale + viewport.y; if (nx + size.width * viewport.scale >= left && nx <= right && ny + size.height * viewport.scale >= top && ny <= bottom) selected.add(node.id); });
    selectedEdge = null; renderSelection();
  }
});
function finishPointer(event) {
  if (portDrag && event.pointerId === portDrag.id) {
    const drag = portDrag; portDrag = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (drag.moved || event.type === 'pointercancel') {
      suppressPortClick = true; setTimeout(()=>{suppressPortClick=false;},0);
      const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('.port.input');
      const node = getNode(target?.closest('.node')?.dataset.nodeId);
      if (event.type !== 'pointercancel' && node) Promise.resolve().then(()=>finishConnection(node,target.dataset.field)).catch(error=>{cancelConnection();reportError(error);});
      else cancelConnection();
    }
    return;
  }
  if (!pointer) return;
  if (pointer.mode === 'drag') pushHistory(pointer.before);
  if (pointer.mode === 'pan') save();
  pointer = null; $('#selection-box').hidden = true; canvas.classList.remove('panning'); renderInspector();
  contentLayout?.resume();
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', finishPointer);
canvas.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
function clearImageDrop() { canvas.classList.remove('image-drop-active'); nodesLayer.querySelectorAll('.image-drop-target').forEach(node => node.classList.remove('image-drop-target')); }
canvas.addEventListener('dragover', event => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; clearImageDrop(); canvas.classList.add('image-drop-active');
  const card = event.target.closest('.node'); if (getNode(card?.dataset.nodeId)?.type === 'reference') card.classList.add('image-drop-target');
});
canvas.addEventListener('dragleave', event => { if (!canvas.contains(event.relatedTarget)) clearImageDrop(); });
canvas.addEventListener('drop', event => {
  event.preventDefault(); clearImageDrop();
  const card = event.target.closest('.node'), id = card?.dataset.nodeId;
  importReferenceFiles(Array.from(event.dataTransfer?.files || []), getNode(id)?.type === 'reference' ? id : null, viewPoint(event.clientX,event.clientY)).catch(reportError);
});
function finishKeyboardMove() { if (keyboardMoveBefore !== null) { pushHistory(keyboardMoveBefore); keyboardMoveBefore = null; contentLayout?.resume(); } }
document.addEventListener('keydown', event => {
  const editing = event.target.closest('input,textarea,select,[contenteditable=true]');
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return;
    if (nodeMenu) closeNodeMenu(true);
    else if (canvasIsActive()) { cancelConnection(); toggleCanvasFocus(false); }
    return;
  }
  if (editing || document.querySelector('dialog[open]') || nodeMenu || !canvasIsActive()) return;
  const command = event.ctrlKey || event.metaKey;
  const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key);
  if (!arrow) finishKeyboardMove();
  if (event.code === 'Space') { event.preventDefault(); spaceDown = true; canvas.classList.add('hand'); }
  if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (command && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
  else if (command && event.key.toLowerCase() === 'd') { event.preventDefault(); try { duplicateSelection(); } catch (error) { reportError(error); } }
  else if (command && event.key.toLowerCase() === 'c') { event.preventDefault(); copyCanvasSelection(); }
  else if (command && event.key.toLowerCase() === 'v') { event.preventDefault(); try { pasteCanvasSelection(); } catch (error) { reportError(error); } }
  else if (command && event.key.toLowerCase() === 's') { event.preventDefault(); workspaceTools.openCanvases().catch(reportError); }
  else if (command && event.key.toLowerCase() === 'a') { event.preventDefault(); selected = new Set(graph.nodes.map(node => node.id)); renderSelection(); renderInspector(); }
  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelection(); }
  else if (event.key === 'F2') { event.preventDefault(); renameCanvasSelection(); }
  else if (!command && event.key.toLowerCase() === 'f') { event.preventDefault(); fitView(event.shiftKey); }
  else if (!command && event.key === '0') { event.preventDefault(); zoom(1 / viewport.scale); }
  else if (!command && ['+', '='].includes(event.key)) { event.preventDefault(); zoom(1.15); }
  else if (!command && event.key === '-') { event.preventDefault(); zoom(1 / 1.15); }
  else if (arrow && !command && !event.altKey && selected.size) {
    event.preventDefault(); if (keyboardMoveBefore === null) keyboardMoveBefore = snapshot();
    const step = event.shiftKey ? 20 : 1, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    moveSelection(graph.nodes.filter(node => selected.has(node.id)), dx, dy).forEach(position => Object.assign(getNode(position.id), position));
    renderNodes(); save();
  }
});
document.addEventListener('keyup', event => { if (event.key.startsWith('Arrow')) finishKeyboardMove(); if (event.code === 'Space') { spaceDown = false; canvas.classList.toggle('hand', tool === 'hand'); } });
window.addEventListener('blur', () => { finishKeyboardMove(); spaceDown = false; closeNodeMenu(); canvas.classList.toggle('hand', tool === 'hand'); });
window.addEventListener('beforeunload', event => { const saved = save(true); releaseMedia(document); if (!saved || nativeEditor.isOpen()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { save(true); if ($('#preview-dialog').open) $('#preview-dialog').close(); clearPreview(); if ($('#aiDialog').open) $('#aiDialog').close(); clearAiConnection(); document.querySelectorAll('video,audio').forEach(media => media.pause()); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { save(true); if ($('#preview-dialog').open) $('#preview-dialog').close(); clearPreview(); document.querySelectorAll('video,audio').forEach(media => media.pause()); }
});
new ResizeObserver(() => { applyViewport(); }).observe(canvas);
contentLayout = createContentLayout({
  identity: ensureCanvasIdentity,
  read: () => graph.nodes.flatMap(node => {
    const element = document.getElementById(`fw-node-${node.id}`);
    return element ? [{ id: node.id, node, x: node.x, y: node.y, width: element.offsetWidth, height: element.offsetHeight, element }] : [];
  }),
  busy: () => !!pointer || keyboardMoveBefore !== null || !!draftEditing ||
    !!document.activeElement?.matches('input,textarea,select,[contenteditable=true]'),
  apply: positions => {
    for (const position of positions) {
      const node = getNode(position.id); Object.assign(node, position);
      const card = document.getElementById(`fw-node-${node.id}`);
      if (card) { card.style.left = `${node.x}px`; card.style.top = `${node.y}px`; }
    }
    renderEdges();
  },
  commit: positions => {
    history.push(layoutHistoryEntry(positions)); if (history.length > 80) history.shift();
    future = []; save(); updateHistory();
  },
  onError: reportError,
  schedule: requestAnimationFrame,
  observe: callback => new ResizeObserver(callback),
});
document.addEventListener('focusout', () => requestAnimationFrame(() => contentLayout.resume()));
document.querySelectorAll('[data-close]').forEach(element => element.addEventListener('click', () => element.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('#preview-dialog').addEventListener('close', clearPreview);
$('#aiDialog').addEventListener('close', clearAiConnection);
bind('#aiConnectBtn', openAiConnection);
bind('#copyMcpUrl', () => copyText($('#mcpUrl').value, '已复制 MCP 接入地址'));
bind('#copyMcpConfig', () => copyText($('#mcpConfig').textContent, '已复制含本次接入令牌的配置，请仅粘贴到可信 AI 客户端'));
bind('#tool-select', () => { tool = 'select'; canvas.classList.remove('hand'); $('#tool-select').classList.add('active'); $('#tool-hand').classList.remove('active'); $('#tool-select').setAttribute('aria-pressed', 'true'); $('#tool-hand').setAttribute('aria-pressed', 'false'); $('#canvas-box-select')?.setAttribute('aria-pressed', 'false'); });
bind('#tool-hand', () => { tool = 'hand'; canvas.classList.add('hand'); $('#tool-hand').classList.add('active'); $('#tool-select').classList.remove('active'); $('#tool-hand').setAttribute('aria-pressed', 'true'); $('#tool-select').setAttribute('aria-pressed', 'false'); $('#canvas-box-select')?.setAttribute('aria-pressed', 'false'); });
bind('#add-prompt', () => addNode('prompt'));
bind('#add-reference', () => chooseReference());
bind('#add-video', () => addNode('generation'));
bind('#add-image', () => addNode('generation', { title: 'SDXL 图片生成', kind: 'sdxl', width: 1024, height: 1024, steps: 25, cfg: 7 }));
bind('#add-result', () => addNode('result'));
bind('#load-demo', () => { if (workflowCanvas.isRunning()) throw new Error('请先停止后续调度，再载入其他画布'); mutate(() => { replaceCanvasIdentity(); graph = createDemo(); selected = new Set([graph.nodes[1].id]); }); fitView(); });
bind('#undo', undo); bind('#redo', redo); bind('#zoom-in', () => zoom(1.15)); bind('#zoom-out', () => zoom(1 / 1.15)); bind('#zoom-reset', () => zoom(1 / viewport.scale)); bind('#fit-view', fitView); bind('#minimap-button', fitView);
bind('#save-project', exportProject); bind('#open-project', () => $('#project-input').click()); bind('#help-button', () => $('#help-dialog').showModal());
bind('#tab-properties', () => switchTab('properties')); bind('#tab-jobs', () => switchTab('jobs'));
$('#job-search').addEventListener('input', renderJobs); $('#job-status-filter').addEventListener('change', renderJobs);
$('#package-search').addEventListener('input', renderPackageLibrary); $('#package-scope').addEventListener('change', renderPackageLibrary);
bind('#engine-status', () => runDiagnostics()); bind('#diagnostics-button', () => runDiagnostics()); bind('#diagnostic-refresh', () => runDiagnostics(getNode(diagnosticNodeId) || selectedGeneration(), true)); bind('#copy-repair', () => copyText($('#repair-prompt').value, '已复制脱敏修复提示词，可交给 AI 助手'));
bind('#discovery-open', () => runDiagnostics());
bind('#export-diagnostics', () => { downloadJSON(publicChecksReport(diagnosticChecks, knownLocalPaths(), { mode: getNode(diagnosticNodeId)?.data.kind, repair_prompt: workflowRepair }), `frameweave-environment-${new Date().toISOString().slice(0, 10)}.json`); toast('已导出脱敏状态摘要，不包含本机路径或原始检查明细'); });
bind('#settings-button', () => openSettings());
bind('#packages-button', openPackages); bind('#import-package', () => $('#package-input').click()); bind('#refresh-packages', () => loadPackages({ force: true }));
bind('#package-current-node', packageCurrentNode);
bind('#package-select-recommended', () => { if (packageDraft) { const ids = new Set(initialEditorFieldIds(packageDraft.fields)); packageDraft.fields.forEach(item => { item.selected = ids.has(item.id); }); renderPackageDraft(); } });
bind('#package-select-all', () => { if (packageDraft) { packageDraft.fields.forEach(item => { item.selected = true; }); renderPackageDraft(); } });
$('#package-input').addEventListener('change', event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  $('#import-package').disabled = true; inspectPackageFile(file).catch(reportError).finally(() => { $('#import-package').disabled = false; });
});
$('#package-editor-form').addEventListener('submit', event => {
  event.preventDefault(); if (!packageDraft) return;
  (async () => {
    const openingDraft = packageDraft, identity = currentCanvasIdentity(), targetGraph = graph;
    const ensureCurrent = () => {
      if (identity !== currentCanvasIdentity() || targetGraph !== graph) throw new Error('画布已切换，工作流未放入新画布；已保存的包仍保留在本机库');
      if (openingDraft !== packageDraft) throw new Error('工作流编辑对象已切换；已保存的包仍保留在本机库');
    };
    const fields = packageDraft.fields.filter(item => item.selected).map(({ selected: _selected, recommended: _recommended, ...definition }) => definition);
    $('#save-package').disabled = true;
    try {
      const name = $('#package-name').value.trim(), description = $('#package-description').value.trim();
      const unchanged = packageDraft.sourceJSON && packageDraft.originalEditor === stableStringify({ name, description, fields: packageDraft.fields });
      const result = await api('/api/packages', unchanged ? { source_json: packageDraft.sourceJSON } : { name, description, prompt: packageDraft.prompt, fields });
      if (!result.package?.id) throw new Error('本地服务没有返回有效的工作流包');
      rememberPackageDefinition(result.package); await loadPackages(); ensureCurrent();
      await addPackageNode(result.package, { ensureCurrent }); if (packageDraft === openingDraft) packageDraft = null;
    } finally { $('#save-package').disabled = false; }
  })().catch(reportError);
});
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  (async () => {
    const next = { performance_profile: $('#performance-profile').value, auto_update: $('#auto-update').checked, auto_start_engine: $('#engine-autostart').checked, backend_url: $('#backend-url').value.trim(), model_roots: $('#model-roots').value.split('\n').map(line => line.trim()).filter(Boolean), comfy_roots: $('#comfy-roots').value.split('\n').map(line => line.trim()).filter(Boolean) };
    await pollJobs(); if (next.backend_url !== settings.backend_url && !canUseBackend(next.backend_url)) throw new Error('有未结束或待确认任务，只能恢复原任务所属引擎。');
    const result = await api('/api/settings', next);
    settings = result.settings || next;
    $('#settings-dialog').close(); await refreshEngine(true); renderInspector();
    await scanEnvironment();
  })().catch(reportError);
});
$('#project-input').addEventListener('change', event => {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  importCanvasFile(file).catch(reportError);
});
$('#reference-input').addEventListener('change', event => {
  const files = [...(event.target.files || [])]; const target = uploadTarget; event.target.value = ''; uploadTarget = null;
  importReferenceFiles(files, target?.id, null, target?.identity).catch(reportError);
});
$('#workflow-input').addEventListener('change', event => {
  const file = event.target.files?.[0]; const target = workflowTarget; event.target.value = ''; if (!file) return;
  (async () => {
    if (file.size > 8 * 1024 * 1024) throw new Error('API 工作流最大为 8 MiB。');
    const parsed = parseJSONWithSafeNumbers(await file.text());
    const prompt = apiPromptFromDocument(parsed);
    if (getNode(target)) await importApiInterface({ prompt }, file.name.replace(/\.json$/i, ''), getNode(target));
  })().catch(reportError);
});

async function initialize() {
  try {
    const pending = JSON.parse(localStorage.getItem(RETRY_REQUESTS_KEY) || '[]');
    if (Array.isArray(pending)) for (const pair of pending.slice(-200)) {
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[0].length <= 120 && typeof pair[1] === 'string' && /^[\da-f-]{36}$/i.test(pair[1])) retryRequests.set(...pair);
    }
  } catch { /* Invalid retry metadata never prevents restoring the canvas. */ }
  try {
    const cached = localStorage.getItem(STORAGE_KEY);
    if (cached) { const parsed = parseGraph(cached); graph = { nodes: parsed.nodes, edges: parsed.edges }; viewport = parsed.viewport; selected = new Set([graph.nodes.find(node => node.type === 'generation')?.id].filter(Boolean)); restored = true; }
    try {
      const ports = JSON.parse(localStorage.getItem(PORT_VIEW_STORAGE_KEY) || 'null');
      if (restored && ports?.canvasIdentity === currentCanvasIdentity() && Array.isArray(ports.nodes)) {
        for (const id of ports.nodes) if (typeof id === 'string' && getNode(id)) expandedInputs.add(id);
        restorePortViews(ports.views);
      }
    } catch { /* Invalid presentation state never prevents graph recovery. */ }
    if (restored) { const cachedTitle = localStorage.getItem(TITLE_STORAGE_KEY); if (cachedTitle !== null) setProjectTitle(cachedTitle); }
    const cachedJobs = JSON.parse(localStorage.getItem(JOB_MAP_KEY) || '{}'); if (cachedJobs && typeof cachedJobs === 'object' && !Array.isArray(cachedJobs)) jobNodes = cachedJobs;
  } catch { toast('本地画布记录无效，已打开安全示例。可重新导入备份。', true); }
  renderAll();
  // A new canvas opens at native 100% text size; fitting is an explicit action.
  try {
    const bootstrap = await api('/api/bootstrap'); csrf = bootstrap.csrf; settings = { ...settings, ...bootstrap.settings };
    if (bootstrap.version) $('.alpha').textContent = bootstrap.version;
    workspaceTools.showRecovery(bootstrap.recovery_warnings || []);
    await studio.init();
    await refreshEngine(); renderInspector(); await pollJobs();
    loadPackages().catch(reportError);
    scanEnvironment().catch(error => toast(`自动环境发现未完成：${error.message}`, true));
  } catch (error) { $('#engine-label').textContent = '本地服务不可用'; $('#engine-status').classList.add('offline'); reportError(new Error(`无法连接棱光本地服务：${error.message}`)); }
  setInterval(() => { if (!document.hidden) pollJobs(); }, 1800);
  setInterval(() => { if (!document.hidden) refreshEngine(); }, 15000);
  // A minimized editor still owns its draft and workflow scheduler.
  setInterval(() => { api('/api/heartbeat').catch(() => {}); }, 30000);
}
const updateCenter = createUpdateCenter({ api, reportError, beforeExit: () => { if (hasActiveJobs() || workflowCanvas.isRunning() || studio.hasPending()) throw new Error('请等待生成与画布调度完成，并查询待确认提交后再退出。'); if (!save(true)) throw new Error('浏览器草稿保存失败，本次退出已取消。请先导出或保存本地画布版本，确认后再手动关闭窗口。'); } });
const engineCenter = createEngineCenter({ api, settings: () => settings, connect: useBackend, toast, reportError });
const hubCenter = createHubCenter({ api, reportError, downloadJSON, toast,
  selectedRequest: () => selectedHubRequest({ graph: () => graph, selectedIds: () => [...selected],
    backend: () => settings.backend_url, canvasIdentity: currentCanvasIdentity, ensurePackageDefinition }) });
$('#hub-connection-open').addEventListener('click', () => hubCenter.open().catch(reportError));
initializeCanvasActions();
studio = createGenerationStudio({ api, engine: () => engine, jobs: () => jobs, controlJob, isJobControlling: id => controllingJobs.has(id), refreshEngine, refreshJobs: pollJobs, toast, reportError, preview, placeJob: placeJobOnCanvas, addRecipe: installRecipe, canvasIdentity: currentCanvasIdentity, canvasSnapshot: snapshot, prepareH3Package: (document, guard) => inspectPackageDocument(document, document.name, '', guard), catalog, openSettings, copyText, storeLocalMedia, packages: () => packages, loadPackages, openPackages, settings: () => settings, outputLocation: (id, index, open = false) => api(`/api/jobs/${encodeURIComponent(id)}/output-location`, { index, open }), performancePreset: () => settings.performance_profile || 'auto' });
workflowCanvas = createWorkflowCanvas({ api, graph: () => graph, viewport: () => viewport, title: () => projectTitle, canvasIdentity: currentCanvasIdentity, selectedIds: () => [...selected], packages: () => packages, ensurePackageDefinition, rememberPackageDefinition, engine: () => engine, loadPackages, openPackages, downloadJSON, toast, reportError, prepareBackend: prepareWorkflowBackend, prepareInputs: prepareCanvasImages,
  connect: (source, target, options) => mutate(() => connect(graph, source, target, options)),
  setGraph: (incoming, title) => { studio.open('canvas'); mutate(() => { replaceCanvasIdentity(); graph = { nodes: incoming.nodes, edges: incoming.edges }; viewport = incoming.viewport; selected.clear(); selectedEdge = null; setProjectTitle(importedProjectTitle(title, '导入的工作流集合')); }); applyViewport(); save(true); },
  onJob: acceptCanvasWorkflowJob });
workflowCanvas.init();
const workflowConfigurations = createWorkflowConfigurations({api, toast, bundle: nodeId => workflowCanvas.buildBundle(nodeId),
  async install(bundle, target) {
    if (workflowCanvas.isRunning() || nativeEditor.isOpen()) throw new Error('请先结束当前画布调度或关闭内部编辑器，再载入配置');
    const identity = currentCanvasIdentity();
    const canReplace = () => target && getNode(target.id) === target && !target.data.package_id && !graph.edges.some(edge => edge.source === target.id || edge.target === target.id);
    const checkCapacity = () => { if (!canReplace() && graph.nodes.length >= 500) throw new Error('画布最多 500 个节点，请先移除节点再载入配置'); };
    checkCapacity();
    const incoming = parseGraph(bundle.canvas).nodes[0];
    const entry = bundle.packages.find(item => item.id === incoming.data.package_id);
    const {package: pack} = await api('/api/packages', entry.source_json ? {source_json:entry.source_json} : entry.document);
    rememberPackageDefinition(pack);
    let editorId = '';
    if (incoming.data.editor_id) {
      const editor = bundle.editors.find(item => item.id === incoming.data.editor_id);
      editorId = (await api('/api/editor-workflows', {name:editor.name, source_json:editor.source_json})).id;
    }
    await loadPackages();
    if (identity !== currentCanvasIdentity()) throw new Error('画布已切换，配置未放入新画布；已登记的工作流仍在包库');
    checkCapacity();
    const replace = canReplace();
    const node = replace ? target : await addPackageNode(pack);
    mutate(() => {
      node.data = {...structuredClone(incoming.data), package_id:pack.id,
        packageFields:pack.fields.map(cachedPackageField), ...(editorId ? {editor_id:editorId} : {})};
      selected = new Set([node.id]); selectedEdge = null;
    });
    revealInspector(); switchTab('properties');
    toast(replace ? '已载入完整配置，外层参数可直接调整；原导入文件仍保留' : '已添加配置节点；生成前仍会检查引擎、模型与输入');
  }
});
const configurationButton = button('我的工作流配置', 'button quiet', () => workflowConfigurations.choose());
configurationButton.id = 'workflow-configurations-button'; $('#packages-dialog .package-library-toolbar').append(configurationButton);
const workspaceTools = createWorkspaceTools({ api, workflow: () => workflowCanvas, title: () => projectTitle, setTitle: title => { setProjectTitle(title); save(true); }, jobs: () => jobs, settings: () => settings, refreshJobs: pollJobs, outputMedia, mediaURL, reuseJob, toast, reportError });
workspaceTools.init();
initialize();
