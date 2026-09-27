import { app } from '/scripts/app.js';

// Loaded last through ComfyUI's extension list, inside a separate editor origin.
// The proxy remains the enforcement boundary for execution and backend writes.
const config = window.__PRISM_EDITOR__;
const state = { ready: false, loaded: false, claimed: false, source: null, lostOnLoad: [], pending: 0, seen: new Set(), tail: Promise.resolve(), nativeTail: Promise.resolve() };
const authorizedLoads = new WeakSet();
const clone = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validateApiPrompt(value) {
  let prompt;
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 16 * 1024 * 1024) throw new Error();
    prompt = JSON.parse(raw);
  } catch { throw new Error('invalid-api-prompt'); }
  if (!isRecord(prompt) || !Object.keys(prompt).length
      || Object.values(prompt).some(node => !isRecord(node)
        || typeof node.class_type !== 'string' || !node.class_type
        || !isRecord(node.inputs))) throw new Error('invalid-api-prompt');
  return prompt;
}
function apiPromptsEquivalent(expected, actual) {
  const expectedPrompt = validateApiPrompt(expected);
  const actualPrompt = validateApiPrompt(actual);
  for (const [nodeId, expectedNode] of Object.entries(expectedPrompt)) {
    const actualNode = actualPrompt[nodeId];
    const actualMeta = actualNode?._meta;
    const expectedMeta = expectedNode._meta;
    // ComfyUI's graphToPrompt adds its UI title to every node. Ignore only
    // that newly-added display field; declared titles and all other metadata
    // remain part of the semantic comparison.
    if (isRecord(actualMeta) &&
        !(isRecord(expectedMeta) && Object.hasOwn(expectedMeta, 'title')) &&
        typeof actualMeta.title === 'string' && actualMeta.title.length > 0) {
      delete actualMeta.title;
      if (!isRecord(expectedMeta) && Object.keys(actualMeta).length === 0) delete actualNode._meta;
    }
  }
  return canonicalJSON(expectedPrompt) === canonicalJSON(actualPrompt);
}
function graph() {
  // New ComfyUI frontends expose non-logging readiness accessors. Prefer them:
  // reading `app.rootGraph`/`app.graph` while GraphCanvas is mounting logs an
  // initialization error and can hand API imports an unconfigured graph.
  if ('rootGraphOrUndefined' in app) return app.rootGraphOrUndefined || null;
  if (app.isGraphReady === false) return null;
  try { return app.rootGraph || app.graph || null; } catch { return null; }
}
function canvasReady(root) {
  let canvas;
  if ('canvasOrUndefined' in app) canvas = app.canvasOrUndefined;
  else {
    if (app.isGraphReady === false) return false;
    try { canvas = app.canvas; } catch { return false; }
  }
  if (!canvas) return false;
  const canvasRef = app.canvasElRef;
  if (canvasRef && !canvasRef.value) return false;
  const element = canvasRef?.value || canvas.canvas;
  if (element?.isConnected === false) return false;
  return !canvas.graph || !root || canvas.graph === root;
}
function frontendReady() {
  const root = graph();
  if (!root || !window.LiteGraph?.registered_node_types) return false;
  // ComfyUI's current GraphView sets the module-level canvas before publishing
  // the mounted app on window. The editor's Pinia canvas store is still null
  // during that gap, so `loadApiJson` would fail in beforeLoadNewGraph().
  if (window.app !== app) return false;
  if (window.graph && window.graph !== root) return false;
  if (app.vueAppReady === false) return false;
  // Current ComfyUI frontends keep this splash element mounted until the
  // startup workflow and restored tabs have finished loading. The app/canvas
  // objects become visible earlier, while startup can still clear the graph.
  if (typeof document !== 'undefined' && document.querySelector?.('#splash-loader')?.isConnected) return false;
  return canvasReady(root);
}
const blockedQueue = async () => { throw new Error('请返回棱光画布执行工作流；此窗口仅用于编辑。'); };

function send(message) {
  window.parent.postMessage(clone({ source: 'prism-editor', nonce: config.bridgeNonce, ...message }), config.parentOrigin);
}

function installDocumentGate() {
  const nativeLoad = app.loadGraphData;
  app.loadGraphData = function (document, ...args) {
    const authorized = document && typeof document === 'object' && authorizedLoads.delete(document);
    const replacesDocument = args[0] !== false;
    const receiver = this;
    const pending = state.nativeTail.then(() => {
      // GraphCanvas restores its startup document AFTER extension setup. That
      // restore may arrive arbitrarily late, so a timer is not an ownership
      // boundary. Parent loads claim this editor until it closes. Native undo
      // and redo use clean=false and continue to work through the same queue.
      if (!authorized && state.claimed && replacesDocument) {
        send({ action: 'notice', result: { message: '此编辑器已绑定当前工作流；新建、打开或切换完整工作流请返回外层画布。' } });
        return;
      }
      return nativeLoad.call(receiver, document, ...args);
    });
    // Await an already-running startup restore before applying a parent load.
    // A failed native operation must not poison later loads or undo/redo.
    state.nativeTail = pending.catch(() => {});
    return pending;
  };
}

function graphEntries(document) {
  const subgraphs = new Set(), entries = [];
  // Walk graph containers only; widget values and prompt text are not schemas.
  function walk(value, path) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.nodes)) {
      for (const node of value.nodes) {
        entries.push({ node, path, key: JSON.stringify([path, String(node.id), node.type]) });
        walk(node.subgraph, `${path}/node:${node.id}`);
      }
    }
    const definitions = value.definitions?.subgraphs;
    if (Array.isArray(definitions)) for (const definition of definitions) {
      if (typeof definition.id === 'string') subgraphs.add(definition.id);
      walk(definition, `${path}/definition:${definition.id}`);
    }
    for (const [name, definition] of Object.entries(value.extra?.groupNodes || {})) walk(definition, `${path}/group:${name}`);
  }
  walk(document, 'root');
  return { entries, subgraphs };
}

function inspect(document) {
  const registry = window.LiteGraph?.registered_node_types;
  if (!registry) throw new Error('registry');
  const missing = new Set(), { entries, subgraphs } = graphEntries(document);
  for (const { node } of entries) {
    if (typeof node.type !== 'string' || (!Object.hasOwn(registry, node.type) && !subgraphs.has(node.type))) missing.add(String(node.type || '(unknown)'));
  }
  return { missing: [...missing].sort(), nodes: document.nodes.length, links: Array.isArray(document.links) ? document.links.length : Object.keys(document.links || {}).length };
}

function summarize(document) {
  const summary = inspect(document);
  if (state.lostOnLoad.length) {
    summary.missing = [...new Set([...summary.missing, ...state.lostOnLoad.map(item => item.type)])].sort();
    summary.lost_on_load = state.lostOnLoad;
  }
  return summary;
}

function findWidget(nodeId, name) {
  if (typeof nodeId !== 'string' && typeof nodeId !== 'number') return { reason: 'invalid_node_id' };
  if (String(nodeId).includes(':')) return { reason: 'nested_node_not_supported' };
  const root = graph();
  const node = root.getNodeById?.(nodeId) || (root._nodes || root.nodes || []).find(item => String(item.id) === String(nodeId));
  if (!node) return { reason: 'node_not_found' };
  const candidates = (node.widgets || []).filter(widget => widget.name === name);
  if (candidates.length !== 1) return { reason: candidates.length ? 'ambiguous_widget' : 'widget_not_found' };
  const widget = candidates[0];
  if ((node.inputs || []).some(input => (input.name === name || input.widget?.name === name) && input.link != null)) return { reason: 'connected_input' };
  if (String(widget.type).startsWith('converted-widget') || widget.options?.serialize === false || widget.disabled || widget.options?.read_only) return { reason: 'widget_not_writable' };
  if (!['string', 'number', 'boolean'].includes(typeof widget.value)) return { reason: 'unsupported_widget_value' };
  return { node, widget };
}

function describeControls(output) {
  const controls = [], unmapped = [];
  for (const [nodeId, definition] of Object.entries(output)) {
    for (const [input, value] of Object.entries(definition.inputs || {})) {
      if (value !== null && typeof value === 'object') continue;
      const target = findWidget(nodeId, input);
      let reason = target.reason;
      if (!reason && (target.node.comfyClass || target.node.type) !== definition.class_type) reason = 'node_class_mismatch';
      if (!reason && !Object.is(target.widget.value, value)) reason = 'serialized_value_differs';
      if (reason) unmapped.push({ node_id: nodeId, input, reason });
      else controls.push({ node_id: nodeId, input, widget_node_id: String(target.node.id), widget_name: target.widget.name });
    }
  }
  return { controls, unmapped };
}

function validateValue(node, widget, value) {
  if (typeof value !== typeof widget.value || !['string', 'number', 'boolean'].includes(typeof value)) return 'type_mismatch';
  const options = widget.options || {};
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'invalid_number';
    const slot = (node.inputs || []).find(input => input.name === widget.name || input.widget?.name === widget.name);
    const specification = node.constructor?.nodeData?.input;
    const declaredType = specification?.required?.[widget.name]?.[0] || specification?.optional?.[widget.name]?.[0] || slot?.type;
    if (declaredType === 'INT' && !Number.isSafeInteger(value)) return 'integer_required';
    if (typeof options.min === 'number' && value < options.min || typeof options.max === 'number' && value > options.max) return 'out_of_range';
  }
  if (widget.type === 'combo' || options.values !== undefined) {
    let values;
    try { values = typeof options.values === 'function' ? options.values.call(widget) : options.values; } catch { return 'enum_unavailable'; }
    if (!Array.isArray(values)) return 'enum_unavailable';
    if (!values.some(item => Object.is(item, value))) return 'invalid_enum';
  }
  return null;
}

async function patchWidgets(patches) {
  const unsupported = [], prepared = [], seen = new Set();
  if (!Array.isArray(patches) || patches.length > 1000) return { error: '参数回写格式无效。', result: { applied: [], unsupported: [{ reason: 'invalid_patches' }] } };
  for (const [index, patch] of patches.entries()) {
    const identity = { index, node_id: patch?.node_id, widget_name: patch?.widget_name };
    if (!patch || typeof patch.widget_name !== 'string' || !patch.widget_name) {
      unsupported.push({ ...identity, reason: 'invalid_patch' }); continue;
    }
    const key = JSON.stringify([String(patch.node_id), patch.widget_name]);
    const target = findWidget(patch.node_id, patch.widget_name);
    let reason = seen.has(key) ? 'duplicate_patch' : target.reason || validateValue(target.node, target.widget, patch.value);
    if (!reason && Object.hasOwn(patch, 'expected_value') && !Object.is(target.widget.value, patch.expected_value) && !Object.is(target.widget.value, patch.value)) reason = 'conflict';
    seen.add(key);
    if (reason) unsupported.push({ ...identity, reason, ...(reason === 'conflict' ? { current_value: target.widget.value } : {}) });
    else prepared.push({ ...target, value: patch.value, previousValue: target.widget.value, identity });
  }
  if (unsupported.length) return { error: '部分参数无法安全回写，本次未应用任何修改。', result: { applied: [], unsupported } };
  if (!prepared.length) return { result: { applied: [], unsupported: [] } };
  const root = graph(), before = clone(root.serialize());
  try {
    root.beforeChange?.();
    for (const item of prepared) item.widget.value = item.value;
    for (const item of prepared) {
      await item.widget.callback?.call(item.widget, item.value, app.canvas, item.node);
    }
    // A callback may rebuild widgets or change another selected value. Refuse
    // to report success unless every requested value still exists as requested.
    for (const item of prepared) {
      const actual = findWidget(item.identity.node_id, item.identity.widget_name);
      if (actual.reason || !Object.is(actual.widget.value, item.value) || validateValue(actual.node, actual.widget, item.value)) throw new Error('dependency_changed');
    }
    root.afterChange?.();
    root.change?.();
    app.canvas?.setDirty?.(true, true);
    return { result: { applied: prepared.map(({ identity }) => ({ node_id: String(identity.node_id), widget_name: identity.widget_name })), unsupported: [] } };
  } catch (error) {
    let rolledBack = false;
    for (const item of prepared) item.widget.value = item.previousValue;
    try {
      authorizedLoads.add(before);
      await app.loadGraphData(before, false, false);
      root.afterChange?.();
      rolledBack = true;
    } catch { state.loaded = false; }
    return { error: rolledBack ? '控件联动失败，已恢复修改前的工作流。' : '控件联动失败且恢复失败，请重新加载工作流。', result: { applied: [], unsupported: prepared.map(({ identity }) => ({ ...identity, reason: 'callback_failed' })), rolled_back: rolledBack } };
  }
}

async function importApiPrompt(value) {
  const prototypeImporter = Object.getPrototypeOf(app)?.loadApiJson;
  if (typeof prototypeImporter !== 'function') throw new Error('api-import-unavailable');
  const prompt = validateApiPrompt(value);
  await state.nativeTail;
  const before = clone(graph().serialize());
  try {
    // Invoke ComfyUI's awaited implementation directly. Some extension
    // instance wrappers call it without returning its Promise.
    await prototypeImporter.call(app, prompt, 'PrismCanvas preset', { deferWarnings: true });
    await state.nativeTail;
    const workflow = clone(graph().serialize());
    const summary = summarize(workflow);
    if (summary.missing.length) throw new Error('missing-node-types');
    // Pass the serialized root graph explicitly. Current ComfyUI frontends may
    // have another active canvas object while the native root graph is loaded.
    const compiled = await app.graphToPrompt(graph());
    if (!compiled?.workflow || !isRecord(compiled.output) || !Object.keys(compiled.output).length) {
      throw new Error('invalid-output');
    }
    // Deliberately include every API field, including fields unknown to this
    // bridge. Only object key order is irrelevant; arrays and IDs stay exact.
    if (!apiPromptsEquivalent(prompt, compiled.output)) {
      throw new Error('semantic-mismatch');
    }
    state.source = workflow;
    state.lostOnLoad = [];
    return { workflow, output: clone(compiled.output), ...describeControls(compiled.output), ...summary };
  } catch {
    try {
      authorizedLoads.add(before);
      await app.loadGraphData(before, false, false);
      await state.nativeTail;
      state.source = before;
      state.lostOnLoad = [];
      state.loaded = true;
    } catch {
      state.loaded = false;
      throw new Error('api-import-rollback-failed');
    }
    throw new Error('api-import-unverified');
  }
}

async function handle(message) {
  const { action, requestId } = message;
  try {
    if (!state.ready) throw new Error('not-ready');
    let result;
    if (action === 'load') {
      state.loaded = false;
      state.lostOnLoad = [];
      const document = clone(message.document);
      if (!document || !Array.isArray(document.nodes)) throw new Error('invalid-document');
      state.claimed = true;
      state.source = clone(document);
      authorizedLoads.add(document);
      await app.loadGraphData(document);
      const loaded = clone(graph().serialize());
      const missingTypes = new Set(inspect(state.source).missing);
      const loadedKeys = new Set(graphEntries(loaded).entries.map(entry => entry.key));
      // Only unexpected loss during the initial native load is sticky. A
      // placeholder that survived loading can later be replaced or deleted by
      // the user, and must then stop appearing in the current missing list.
      state.lostOnLoad = graphEntries(state.source).entries
        .filter(({ node, key }) => missingTypes.has(String(node.type || '(unknown)')) && !loadedKeys.has(key))
        .map(({ node, path }) => ({ node_id: String(node.id), type: String(node.type || '(unknown)'), graph_path: path }));
      result = summarize(loaded);
      state.loaded = true;
    } else {
      if (!state.loaded) throw new Error('not-loaded');
      await state.nativeTail;
      if (action === 'importApi') {
        result = await importApiPrompt(message.prompt);
      } else if (action === 'patch') {
        send({ requestId, action, ...await patchWidgets(message.patches) });
        return;
      }
      const workflow = clone(graph().serialize());
      const summary = summarize(workflow);
      if (action === 'snapshot') result = { workflow, ...summary };
      else if (action === 'compile') {
        if (summary.missing.length) {
          send({ requestId, action, error: state.lostOnLoad.length ? '原生加载时丢失了缺失节点，请补齐扩展并重新加载原始工作流。' : '工作流仍有缺失节点，请补齐扩展或在内部修复后重新检查。', result: summary });
          return;
        }
        // Extensions wrap this method during setup; use the current method.
        const compiled = await app.graphToPrompt();
        if (!compiled?.workflow || !compiled?.output || typeof compiled.output !== 'object' || !Object.keys(compiled.output).length) throw new Error('invalid-output');
        result = { workflow: compiled.workflow, output: compiled.output, ...describeControls(compiled.output) };
      } else if (action !== 'importApi') throw new Error('invalid-action');
    }
    send({ requestId, action, result });
  } catch (error) {
    // Native errors can include prompts, local paths, or entire node payloads.
    const errors = { load: '工作流加载失败，请检查文件格式与节点扩展。', snapshot: '无法保存编辑快照，请先成功加载工作流。', compile: '原生工作流编译失败，请检查节点与连线后重试。', patch: '参数回写失败，请先成功加载工作流并检查控件。', importApi: error.message === 'api-import-unavailable' ? '当前 ComfyUI 前端不支持 API 工作流导入，未修改原生工作流。' : error.message === 'api-import-rollback-failed' ? '预设转换失败且无法恢复临时图，请关闭此编辑器后重新打开原工作流。' : error.message === 'invalid-api-prompt' ? '预设 API 工作流格式无效，未修改原生工作流。' : 'ComfyUI 前端无法无损转换此预设，已恢复原工作流；预设内容仍保留。' };
    send({ requestId, action, error: errors[action] || '不支持的编辑器请求。' });
  }
}

function receive(event) {
  const message = event.data;
  if (event.source !== window.parent || event.origin !== config.parentOrigin || !message || message.source !== 'prism-parent' || message.nonce !== config.bridgeNonce) return;
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128 || !['load', 'snapshot', 'compile', 'patch', 'importApi'].includes(message.action)) return;
  if (state.seen.has(message.requestId)) {
    send({ requestId: message.requestId, action: message.action, error: '重复的编辑器请求已忽略。' });
    return;
  }
  if (state.seen.size >= 4096 || state.pending >= 32) {
    send({ requestId: message.requestId, action: message.action, error: '编辑器请求过多，请稍后重试或重新打开编辑器。' });
    return;
  }
  state.seen.add(message.requestId);
  let frozen;
  try { frozen = clone(message); } catch {
    send({ requestId: message.requestId, action: message.action, error: '编辑器请求格式无效。' });
    return;
  }
  state.pending += 1;
  state.tail = state.tail.then(() => handle(frozen)).catch(() => {}).finally(() => { state.pending -= 1; });
}

if (config && typeof config.parentOrigin === 'string' && typeof config.bridgeNonce === 'string' && config.bridgeNonce && window.parent !== window) {
  app.queuePrompt = blockedQueue;
  window.addEventListener('message', receive);
  app.registerExtension({
    name: 'PrismCanvas.NativeEditorBridge',
    setup() {
      installDocumentGate();
      // This task boundary only waits for the canvas/extension setup, NOT the
      // later startup restore. Document ownership above handles that lifecycle.
      let attempts = 0;
      const ready = () => {
        if (!frontendReady()) {
          if (++attempts < 2000) window.setTimeout(ready, 25);
          return;
        }
        app.queuePrompt = blockedQueue;
        state.ready = true;
        send({ action: 'ready' });
      };
      window.setTimeout(ready, 0);
    },
  });
}
