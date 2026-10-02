import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { MAX_INTERFACE_FIELDS } from '../web/interface-limits.mjs';
import { createNativeEditorMedia } from '../web/native-editor-media.mjs';

const source = (await readFile(new URL('../web/native-editor-bridge.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
const copy = value => JSON.parse(JSON.stringify(value));
const document = () => ({ nodes: [{ id: 1, type: 'Known', mode: 4, widgets_values: { seed: 8 } }], links: [], extra: { ue_links: [1] } });
function harness(options = {}) {
  const replies = [], calls = [], timers = [];
  let listener, extension, current = document(), canvasReadyChecks = 0, vueReadyChecks = 0, windowAppChecks = 0;
  let splashPresent = Boolean(options.splashPresent);
  const rootGraph = { serialize: () => current };
  const appPrototype = {};
  const app = Object.assign(Object.create(appPrototype), {
    graph: rootGraph,
    registerExtension: value => { extension = value; },
    async loadGraphData(value) { calls.push('load'); if (options.load) await options.load(value); current = value; },
    async graphToPrompt() { calls.push('compile'); return { workflow: current, output: { 1: { class_type: 'Known', inputs: {} } } }; },
  });
  Object.defineProperties(app, {
    rootGraphOrUndefined: { get: () => app.rootGraph || rootGraph },
    canvasOrUndefined: { get: () => {
      canvasReadyChecks += 1;
      return options.canvasReadyAfter && canvasReadyChecks < options.canvasReadyAfter
        ? undefined : { graph: app.rootGraph || rootGraph, canvas: { isConnected: true } };
    } },
    canvasElRef: { get: () => ({ value: options.canvasReadyAfter && canvasReadyChecks < options.canvasReadyAfter ? null : { isConnected: true } }) },
    vueAppReady: { get: () => !options.vueReadyAfter || ++vueReadyChecks >= options.vueReadyAfter },
  });
  if (options.loadApiJson !== false) appPrototype.loadApiJson = async (prompt, name, settings) => {
    calls.push('importApi');
    options.loadApiJsonArguments?.(prompt, name, settings);
    if (options.loadApiJson) await options.loadApiJson(prompt, { get: () => current, set: value => { current = value; }, app });
  };
  const parent = { postMessage: (message, origin) => replies.push({ message: copy(message), origin }) };
  const window = { parent, app, graph: rootGraph, __PRISM_EDITOR__: { parentOrigin: 'http://127.0.0.1:8766', bridgeNonce: 'private-session' }, LiteGraph: { registered_node_types: { Known: {} } }, addEventListener: (_name, callback) => { listener = callback; }, setTimeout: callback => timers.push(callback) };
  window.crypto = webcrypto;
  if (options.windowAppReadyAfter) Object.defineProperty(window, 'app', { get: () =>
    ++windowAppChecks >= options.windowAppReadyAfter ? app : undefined });
  const documentObject = { querySelector: selector => selector === '#splash-loader' && splashPresent ? { isConnected: true } : null };
  vm.runInNewContext(source, { app, window, document: documentObject, setTimeout, clearTimeout, TextEncoder, createNativeEditorMedia,
    createEditorMediaPreview: undefined,
    Date: { now: () => options.now ? options.now() : Date.now() } });
  const emit = (action, requestId, data = {}, overrides = {}) => listener({ source: parent, origin: window.__PRISM_EDITOR__.parentOrigin, data: { source: 'prism-parent', nonce: 'private-session', action, requestId, ...data }, ...overrides });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const setup = () => extension.setup();
  const runNextTimer = () => timers.shift()?.();
  const start = () => { setup(); while (timers.length) runNextTimer(); };
  return { app, window, parent, replies, calls, emit, flush, setup, runNextTimer, start, current: () => current, setCurrent: value => { current = value; }, setSplashPresent: value => { splashPresent = value; }, canvasReadyChecks: () => canvasReadyChecks, windowAppChecks: () => windowAppChecks };
}

test('ready is deferred and authenticated; load preserves modes, object widgets and metadata', async () => {
  const h = harness(); assert.equal(h.replies.length, 0); h.start();
  assert.equal(h.replies[0].message.action, 'ready'); assert.equal(h.replies[0].origin, 'http://127.0.0.1:8766');
  const input = document(); h.emit('load', 'a', { document: input }); input.nodes[0].widgets_values.seed = 99;
  await h.flush(); assert.equal(h.current().nodes[0].widgets_values.seed, 8);
  assert.deepEqual(h.replies.at(-1).message.result, { missing: [], nodes: 1, links: 0 });
  h.emit('snapshot', 'b'); await h.flush();
  const snapshot = h.replies.at(-1).message.result.workflow;
  h.current().nodes[0].mode = 0; assert.equal(snapshot.nodes[0].mode, 4); assert.deepEqual(snapshot.extra.ue_links, [1]);
  await assert.rejects(h.app.queuePrompt(), /返回棱光/);
});

test('does not signal ready until the native canvas and its DOM element have mounted', () => {
  const h = harness({ canvasReadyAfter: 4, vueReadyAfter: 4 });
  h.start();
  assert.ok(h.canvasReadyChecks() >= 4); // Capability discovery may read the mounted canvas again.
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].message.action, 'ready');
});

test('does not signal ready until ComfyUI publishes the mounted app and graph', () => {
  const h = harness({ windowAppReadyAfter: 5 });
  h.start();
  assert.equal(h.windowAppChecks(), 5);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].message.action, 'ready');
});

test('does not signal ready until the ComfyUI startup splash disappears', () => {
  const h = harness({ splashPresent: true });
  h.setup();
  h.runNextTimer();
  assert.equal(h.replies.length, 0);
  h.setSplashPresent(false);
  h.runNextTimer();
  assert.equal(h.replies[0].message.action, 'ready');
});

test('rejects foreign source, origin, nonce and malformed request IDs without touching graph', async () => {
  const h = harness(); h.start();
  h.emit('load', 'a', { document: document() }, { source: {} });
  h.emit('load', 'b', { document: document() }, { origin: 'https://foreign.invalid' });
  h.emit('load', 'c', { nonce: 'wrong', document: document() }); h.emit('load', '', { document: document() });
  await h.flush(); assert.equal(h.calls.length, 0); assert.equal(h.replies.length, 1);
});

test('serializes load and compile, invokes extension replacement, and suppresses duplicate IDs', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ load: () => gate }); h.start();
  h.emit('load', 'load', { document: document() }); h.emit('compile', 'compile'); h.emit('load', 'load', { document: document() });
  await h.flush(); assert.deepEqual(h.calls, ['load']);
  let output = { 9: { class_type: 'Known', inputs: { value: 22 } } };
  h.app.graphToPrompt = async () => { h.calls.push('replacement'); return { workflow: h.current(), output }; };
  release(); await h.flush(); assert.deepEqual(h.calls, ['load', 'replacement']);
  assert(h.replies.some(reply => /重复/.test(reply.message.error || '')));
  const result = h.replies.find(reply => reply.message.action === 'compile').message.result;
  output[9].inputs.value = 99; assert.equal(result.output[9].inputs.value, 22);
});

test('retained nested missing placeholders can be deliberately deleted and rechecked', async () => {
  const h = harness(); h.start();
  const input = document(); input.definitions = { subgraphs: [{ id: 'nested', nodes: [{ id: 2, type: 'Absent' }], links: [] }] };
  input.nodes.push({ id: 3, type: 'nested' });
  h.emit('load', 'a', { document: input }); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.missing, ['Absent']);
  h.emit('compile', 'blocked'); await h.flush();
  assert.match(h.replies.at(-1).message.error, /缺失节点/);
  delete h.current().definitions; h.current().nodes.pop();
  h.emit('snapshot', 'check'); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.missing, []);
  h.emit('compile', 'b'); await h.flush();
  assert(h.replies.at(-1).message.result.output); assert.deepEqual(h.calls, ['load', 'compile']);
});

test('missing nodes dropped during native loading remain blocked even if their type becomes registered later', async () => {
  let drop = true;
  const h = harness({ load: value => { if (drop) value.nodes = value.nodes.filter(node => node.type !== 'Absent'); } }); h.start();
  const input = document(); input.nodes.push({ id: 2, type: 'Absent' });
  h.emit('load', 'a', { document: input }); await h.flush();
  const initial = h.replies.at(-1).message.result;
  assert.equal(initial.nodes, 1); assert.deepEqual(initial.missing, ['Absent']);
  assert.deepEqual(initial.lost_on_load, [{ node_id: '2', type: 'Absent', graph_path: 'root' }]);
  h.window.LiteGraph.registered_node_types.Absent = {};
  h.emit('snapshot', 'check'); h.emit('compile', 'b'); await h.flush();
  assert.deepEqual(h.replies.find(reply => reply.message.requestId === 'check').message.result.missing, ['Absent']);
  assert.match(h.replies.at(-1).message.error, /丢失/); assert.deepEqual(h.calls, ['load']);
  drop = false; h.emit('load', 'reload-original', { document: input }); h.emit('compile', 'c'); await h.flush();
  assert(h.replies.at(-1).message.result.output); assert.equal(h.current().nodes.length, 2);
});

test('registered nodes dropped on initial load stay blocked until the complete original graph is reloaded', async () => {
  let drop = true;
  const h = harness({ load: value => { if (drop) value.nodes = value.nodes.filter(node => node.id !== 2); } }); h.start();
  const input = document(); input.nodes.push({ id: 2, type: 'Known', widgets_values: [99] });
  h.emit('load', 'load', { document: input }); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.lost_on_load, [{ node_id: '2', type: 'Known', graph_path: 'root' }]);
  h.emit('compile', 'blocked'); await h.flush();
  assert.match(h.replies.at(-1).message.error, /丢失/);
  assert.equal(h.calls.includes('compile'), false);
  drop = false; h.emit('load', 'complete', { document: input }); h.emit('compile', 'allowed'); await h.flush();
  assert(h.replies.at(-1).message.result.output);
  assert.equal(h.current().nodes.length, 2);
});

test('duplicate identical source identities cannot hide a node dropped by frontend deduplication', async () => {
  const h = harness({ load: value => value.nodes.pop() }); h.start();
  h.emit('load', 'load', { document: { nodes: [{ id: 1, type: 'Known' }, { id: 1, type: 'Known' }], links: [] } }); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.lost_on_load, [{ node_id: '1', type: 'Known', graph_path: 'root' }]);
  h.emit('compile', 'blocked'); await h.flush(); assert.match(h.replies.at(-1).message.error, /丢失/);
});

test('official subgraph UUID normalization, definition hoisting and conflicting inner IDs do not count as node loss', async () => {
  const outerUUID = '11111111-1111-4111-8111-111111111111', innerUUID = '22222222-2222-4222-8222-222222222222';
  const input = { nodes: [{ id: 1, type: 'Known' }, { id: 7, type: 'legacy-outer' }], links: [], definitions: { subgraphs: [
    { id: 'legacy-outer', name: 'Outer', nodes: [{ id: 1, type: 'Known' }, { id: 8, type: 'legacy-inner' }], links: [],
      definitions: { subgraphs: [{ id: 'legacy-inner', name: 'Inner', nodes: [{ id: 2, type: 'Known' }], links: [] }] } },
  ] } };
  const h = harness({ load: value => {
    const outer = value.definitions.subgraphs[0], inner = outer.definitions.subgraphs[0];
    outer.id = outerUUID; inner.id = innerUUID; outer.nodes[0].id = 9;
    outer.nodes[1].type = innerUUID; value.nodes[1].type = outerUUID;
    delete outer.definitions; value.definitions.subgraphs.push(inner);
  } }); h.start();
  h.emit('load', 'migrated', { document: input }); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.missing, []);
  assert.equal(h.replies.at(-1).message.result.lost_on_load, undefined);
  h.emit('compile', 'compile'); await h.flush(); assert(h.replies.at(-1).message.result.output);
});

test('unreferenced legacy definitions can migrate but arbitrary nonconflicting node renumbering is not guessed', async () => {
  for (const renumber of [false, true]) {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const input = { nodes: [], links: [], definitions: { subgraphs: [{ id: 'legacy', name: 'Unused', nodes: [{ id: 2, type: 'Known' }], links: [] }] } };
    const h = harness({ load: value => { const definition = value.definitions.subgraphs[0]; definition.id = uuid;
      if (renumber) definition.nodes[0].id = 9; definition.nodes[0].mode = 0; } }); h.start();
    h.emit('load', 'load', { document: input }); await h.flush();
    const result = h.replies.at(-1).message.result;
    if (renumber) assert.deepEqual(result.lost_on_load, [{ node_id: '2', type: 'Known', graph_path: 'root/definition:legacy' }]);
    else assert.equal(result.lost_on_load, undefined);
  }
});

test('registered node lost inside a migrated subgraph is detected instead of being hidden by type counts', async () => {
  const uuid = '11111111-1111-4111-8111-111111111111';
  const input = { nodes: [{ id: 7, type: 'legacy' }], links: [], definitions: { subgraphs: [
    { id: 'legacy', nodes: [{ id: 1, type: 'Known' }, { id: 2, type: 'Known' }], links: [] },
  ] } };
  const h = harness({ load: value => { value.nodes[0].type = uuid; value.definitions.subgraphs[0].id = uuid; value.definitions.subgraphs[0].nodes.pop(); } }); h.start();
  h.emit('load', 'load', { document: input }); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.lost_on_load, [{ node_id: '2', type: 'Known', graph_path: 'root/definition:legacy' }]);
  h.emit('compile', 'blocked'); await h.flush(); assert.match(h.replies.at(-1).message.error, /丢失/);
  assert.equal(h.calls.includes('compile'), false);
});

test('a retained missing node can be replaced with a registered type, while undo restores its missing status', async () => {
  const h = harness(); h.start(); const input = document(); input.nodes.push({ id: 2, type: 'Absent' });
  h.emit('load', 'a', { document: input }); await h.flush();
  h.current().nodes[1].type = 'Known'; h.emit('snapshot', 'repaired'); h.emit('compile', 'b'); await h.flush();
  assert.deepEqual(h.replies.find(reply => reply.message.requestId === 'repaired').message.result.missing, []);
  assert(h.replies.at(-1).message.result.output);
  await h.app.loadGraphData(input, false, false); h.emit('snapshot', 'undo'); await h.flush();
  assert.deepEqual(h.replies.at(-1).message.result.missing, ['Absent']);
});

test('native exceptions do not leak prompts and failed loads invalidate earlier compile state', async () => {
  let fail = false;
  const h = harness({ load: () => { if (fail) throw new Error('PRIVATE PROMPT C:/private/token'); } });
  h.start(); h.emit('load', 'a', { document: document() }); await h.flush();
  fail = true;
  h.emit('load', 'b', { document: document() }); h.emit('compile', 'c'); await h.flush();
  assert.equal(h.replies.filter(reply => reply.message.error).length, 2);
  assert(!JSON.stringify(h.replies).includes('PRIVATE')); assert(!h.calls.includes('compile'));
});

test('uses the root graph while viewing a nested canvas and does not disable drawing', async () => {
  const h = harness(); h.start(); h.emit('load', 'a', { document: document() }); await h.flush();
  const root = document(); root.nodes.push({ id: 2, type: 'Known' }); h.app.rootGraph = { serialize: () => root };
  h.emit('snapshot', 'b'); await h.flush(); assert.equal(h.replies.at(-1).message.result.nodes, 2);
  assert.equal(typeof h.app.graph.serialize, 'function');
});

test('rejects an empty compiled graph and bounds an authenticated request backlog', async () => {
  const h = harness(); h.start(); h.emit('load', 'a', { document: document() }); await h.flush();
  h.app.graphToPrompt = async () => ({ workflow: h.current(), output: {} });
  h.emit('compile', 'b'); await h.flush(); assert.match(h.replies.at(-1).message.error, /编译失败/);
  let release; h.app.loadGraphData = () => new Promise(resolve => { release = resolve; });
  h.emit('load', 'pending', { document: document() });
  for (let i = 0; i < 40; i++) h.emit('snapshot', `snapshot-${i}`);
  await h.flush(); assert.equal(h.replies.filter(reply => /请求过多/.test(reply.message.error || '')).length, 9);
  release(); await h.flush();
});

test('waits for in-flight startup restore, blocks late startup replacement, and retains native undo', async () => {
  let finishStartup; const startupGate = new Promise(resolve => { finishStartup = resolve; });
  const startup = document(); startup.nodes.push({ id: 10, type: 'Known' });
  const h = harness({ load: value => value === startup ? startupGate : undefined }); h.start();
  const restoring = h.app.loadGraphData(startup);
  await h.flush(); assert.deepEqual(h.calls, ['load']);
  const owned = document(); owned.nodes[0].widgets_values.seed = 77;
  h.emit('load', 'owned', { document: owned }); h.emit('snapshot', 'after');
  await h.flush(); assert.deepEqual(h.calls, ['load'], 'parent must wait for native restore');
  finishStartup(); await restoring; await h.flush();
  assert.deepEqual(h.calls, ['load', 'load']);
  assert.equal(h.replies.find(reply => reply.message.requestId === 'after').message.result.nodes, 1);
  assert.equal(h.current().nodes[0].widgets_values.seed, 77);
  await h.app.loadGraphData(startup, true, true);
  assert.equal(h.current().nodes.length, 1, 'late startup graph must not replace owned document');
  assert.equal(h.replies.at(-1).message.action, 'notice');
  const undo = document(); undo.nodes[0].widgets_values.seed = 55;
  await h.app.loadGraphData(undo, false, false, { id: 'native-workflow' });
  assert.equal(h.current().nodes[0].widgets_values.seed, 55);
  h.emit('load', 'next-owned', { document: owned }); await h.flush();
  assert.equal(h.current().nodes[0].widgets_values.seed, 77, 'another authenticated parent load remains allowed');
});

test('a startup restore queued behind a parent claim is suppressed before touching the graph', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ load: () => gate }); h.start();
  const initial = h.app.loadGraphData(document()); await h.flush();
  const late = h.app.loadGraphData(document());
  h.emit('load', 'owned', { document: document() }); await h.flush();
  release(); await Promise.all([initial, late]); await h.flush();
  assert.deepEqual(h.calls, ['load', 'load'], 'only initial running restore and parent load execute');
});

async function widgetHarness() {
  const events = [];
  const node = {
    id: 1, type: 'Known', comfyClass: 'Known',
    inputs: [{ name: 'width', type: 'INT', widget: { name: 'width' }, link: null }],
    widgets: [
      { name: 'model', type: 'combo', value: 'model-a', options: { values: ['model-a', 'model-b'] }, callback(value) { events.push(['model', value]); } },
      { name: 'width', type: 'number', value: 512, options: { min: 64, max: 2048 } },
      { name: 'enabled', type: 'toggle', value: true, options: {} },
      { name: 'prompt', type: 'text', value: 'old', options: {} },
    ],
  };
  const h = harness({ load: document => {
    const values = document.nodes[0]?.widgets_values;
    if (Array.isArray(values)) node.widgets.forEach((widget, index) => { widget.value = values[index]; });
  } });
  h.app.graph.getNodeById = id => String(id) === '1' ? node : null;
  h.app.graph.serialize = () => ({ ...document(), nodes: [{ id: 1, type: 'Known', widgets_values: node.widgets.map(widget => widget.value) }] });
  h.app.graph.beforeChange = () => events.push('before'); h.app.graph.afterChange = () => events.push('after');
  h.app.graph.change = () => events.push('change');
  h.app.graphToPrompt = async () => ({ workflow: h.app.graph.serialize(), output: { 1: { class_type: 'Known', inputs: Object.fromEntries(node.widgets.map(widget => [widget.name, widget.value])) } } });
  h.start(); h.emit('load', 'load', { document: document() }); await h.flush();
  return { ...h, node, events };
}

async function subgraphHarness({ shared = false, deep = false, promoted = false, indirect = false } = {}) {
  class Known {}
  Known.nodeData = { input: { required: { fps: ['INT', {}], mode: [['a', 'b'], {}] } } };
  const leaf = Object.assign(new Known(), { id: 4, type: 'Known', comfyClass: 'Known', inputs: [], widgets: [
    { name: 'fps', type: 'number', value: 4, options: { min: 1, max: 60 } },
    { name: 'mode', type: 'combo', value: 'a', options: { values: ['a', 'b'] } },
  ] });
  const scope = (id, nodes) => ({ id, nodes, links: new Map(), getNodeById(key) { return this.nodes.find(node => String(node.id) === String(key)); }, getLink(key) { return this.links.get(key); } });
  const inside = scope('inner-definition', [leaf]);
  const host = (id, subgraph) => ({ id, type: subgraph.id, subgraph, isSubgraphNode: () => true, inputs: [], widgets: [] });
  let innerHost;
  const outer = deep || indirect ? scope('outer-definition', [innerHost = host(2, inside)]) : inside;
  const first = host(6, outer), second = host(7, outer);
  const root = scope('root', shared || indirect ? [first, second] : [first]);
  const promote = (container, parent, child, name) => {
    const index = parent.inputs.length, linkId = index + 1;
    container.links.set(linkId, { originIsIoNode: true, origin_slot: index });
    const existing = child.inputs.find(slot => slot.name === name);
    if (existing) existing.link = linkId;
    else child.inputs.push({ name, type: 'INT', link: linkId });
    parent.inputs.push({ name: 'instance-fps', widget: { name: 'instance-fps' }, link: null });
    parent.widgets.push({ name: 'instance-fps', type: 'number', value: 4, options: { min: 1, max: 60 } });
  };
  if (promoted) {
    if (deep || indirect) {
      promote(inside, innerHost, leaf, 'fps');
      promote(outer, first, innerHost, 'instance-fps');
      if (shared || indirect) { second.inputs = copy(first.inputs); second.widgets = copy(first.widgets); }
    } else {
      promote(inside, first, leaf, 'fps');
      if (shared) { second.inputs = copy(first.inputs); second.widgets = copy(first.widgets); }
    }
  }
  const serialize = () => {
    const definitions = [], seen = new Set();
    const nodes = graph => graph.nodes.map(node => ({ id: node.id, type: node.type, widgets_values: node.widgets.map(widget => widget.value) }));
    const visit = graph => {
      for (const node of graph.nodes) if (node.subgraph && !seen.has(node.subgraph)) {
        seen.add(node.subgraph); definitions.push({ id: node.subgraph.id, nodes: nodes(node.subgraph), links: [] }); visit(node.subgraph);
      }
    };
    visit(root);
    return { nodes: nodes(root), links: [], definitions: { subgraphs: definitions } };
  };
  const h = harness({ load: data => {
    const docs = new Map([['root', data], ...(data.definitions?.subgraphs || []).map(item => [item.id, item])]);
    const seen = new Set();
    const restore = graph => {
      if (seen.has(graph)) return; seen.add(graph);
      for (const node of graph.nodes) {
        const record = docs.get(graph.id)?.nodes.find(item => item.id === node.id);
        if (record) node.widgets.forEach((widget, index) => { widget.value = record.widgets_values[index]; });
        if (node.subgraph) restore(node.subgraph);
      }
    };
    restore(root);
  } });
  const output = () => {
    const result = {};
    const visit = (graph, path, hosts) => {
      for (const node of graph.nodes) {
        const id = [...path, node.id].join(':');
        if (node.subgraph) visit(node.subgraph, [...path, node.id], [...hosts, node]);
        else {
          const inputs = Object.fromEntries(node.widgets.map(widget => [widget.name, widget.value]));
          for (const slot of node.inputs) {
            let current = slot, currentGraph = graph, depth = hosts.length;
            while (current?.link != null && depth) {
              const link = currentGraph.links.get(current.link); if (!link?.originIsIoNode) break;
              const parent = hosts[--depth]; current = parent.inputs[link.origin_slot];
              currentGraph = depth ? hosts[depth - 1].subgraph : root;
              if (current?.link == null) inputs[slot.name] = parent.widgets.find(widget => widget.name === current.widget.name)?.value;
            }
          }
          result[id] = { class_type: node.comfyClass || node.type, inputs };
        }
      }
    };
    visit(root, [], []); return result;
  };
  Object.assign(h.app.graph, root, { serialize });
  h.window.LiteGraph.registered_node_types.Known = Known;
  h.app.graphToPrompt = async () => ({ workflow: serialize(), output: output() });
  h.start(); h.emit('load', 'load', { document: serialize() }); await h.flush();
  return { ...h, leaf, inside, outer, root, first, second, innerHost, serialize, output, path: deep || indirect ? '6:2:4' : '6:4' };
}

test('complete subgraph instance paths map and patch a unique leaf without touching the source snapshot', async () => {
  for (const deep of [false, true]) {
    const h = await subgraphHarness({ deep }); const original = copy(h.current());
    h.emit('compile', 'describe'); await h.flush();
    assert.deepEqual(h.replies.at(-1).message.result.controls[0], { node_id: h.path, input: 'fps', widget_node_id: h.path, widget_name: 'fps' });
    h.emit('patch', 'patch', { patches: [{ node_id: h.path, widget_name: 'fps', class_type: 'Known', value: 8, expected_value: 4 }] }); await h.flush();
    assert.equal(h.replies.at(-1).message.error, undefined);
    assert.equal(h.output()[h.path].inputs.fps, 8);
    assert.deepEqual(copy(h.current()), original);
    assert.equal(original.definitions.subgraphs.at(-1).nodes[0].widgets_values[0], 4);
  }
});

test('shared promoted hosts preserve independent values for the same leaf ID including deep promotions', async () => {
  for (const deep of [false, true]) {
    const h = await subgraphHarness({ shared: true, promoted: true, deep });
    h.emit('compile', 'describe'); await h.flush();
    assert.equal(h.replies.at(-1).message.result.controls.filter(item => item.input === 'fps').length, 2);
    h.emit('patch', 'patch', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8, expected_value: 4 }] }); await h.flush();
    assert.equal(h.replies.at(-1).message.error, undefined);
    assert.equal(h.first.widgets[0].value, 8); assert.equal(h.second.widgets[0].value, 4);
    assert.equal(h.leaf.widgets[0].value, 4);
    assert.equal(h.output()[deep ? '7:2:4' : '7:4'].inputs.fps, 4);
  }
});

test('reachable occurrence counts block direct and indirect reuse of a common definition', async () => {
  for (const options of [{ shared: true }, { indirect: true }]) {
    const h = await subgraphHarness(options);
    h.emit('compile', 'describe'); await h.flush();
    assert(h.replies.at(-1).message.result.unmapped.some(item => item.node_id === h.path && item.reason === 'shared_definition_widget'));
    h.emit('patch', 'patch', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
    assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'shared_definition_widget');
    assert.equal(h.leaf.widgets[0].value, 4);
  }
  const h = await subgraphHarness({ indirect: true, promoted: true });
  h.innerHost.inputs[0].link = null; // Promotion stops inside a parent used twice.
  h.emit('patch', 'shared-owner', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'shared_definition_widget');
  assert.equal(h.innerHost.widgets[0].value, 4);
});

test('path lookup never truncates IDs, checks classes and protects changed inner baselines', async () => {
  const h = await subgraphHarness({ deep: true });
  for (const [node_id, class_type, expected_value, reason] of [
    ['99:2:4', 'Known', 4, 'instance_not_found'], ['6:99:4', 'Known', 4, 'instance_not_found'],
    ['6:2:4', 'Wrong', 4, 'node_class_mismatch'], ['6:2:4', 'Known', 3, 'conflict'],
  ]) {
    h.emit('patch', node_id + reason, { patches: [{ node_id, widget_name: 'fps', class_type, value: 8, expected_value }] }); await h.flush();
    assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, reason);
    assert.equal(h.leaf.widgets[0].value, 4);
  }
  h.app.graphToPrompt = async () => ({ workflow: h.serialize(), output: { [h.path]: { class_type: 'Wrong', inputs: { fps: 4 } } } });
  h.emit('compile', 'mismatch'); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unmapped[0].reason, 'node_class_mismatch');
});

test('nested dynamic widget callbacks are verified and unexpected sibling changes roll back', async () => {
  const h = await subgraphHarness();
  h.leaf.widgets[0].callback = () => { h.leaf.widgets[1].value = 'b'; };
  h.emit('patch', 'side-effect', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.deepEqual(h.leaf.widgets.map(widget => widget.value), [4, 'a']);
  h.leaf.widgets[0].callback = () => { h.leaf.widgets = h.leaf.widgets.map(widget => ({ ...widget })); };
  h.emit('patch', 'rebuilt', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.equal(h.output()[h.path].inputs.fps, 4);
  h.leaf.widgets[0].callback = () => { throw new Error('PRIVATE callback detail'); };
  h.emit('patch', 'throws', { patches: [{ node_id: h.path, widget_name: 'fps', value: 9 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.equal(h.leaf.widgets[0].value, 4);
  assert.equal(JSON.stringify(h.replies.at(-1)).includes('PRIVATE'), false);
});

test('a promoted owner that fans out to another API input cannot silently change the other input', async () => {
  const h = await subgraphHarness({ promoted: true });
  h.inside.nodes.push(Object.assign(Object.create(Object.getPrototypeOf(h.leaf)), {
    id: 5, type: 'Known', comfyClass: 'Known', inputs: copy(h.leaf.inputs), widgets: copy(h.leaf.widgets),
  }));
  h.emit('patch', 'fanout', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.equal(h.first.widgets[0].value, 4);
  assert.equal(h.output()['6:5'].inputs.fps, 4);
});

test('cycles and traversal budgets reject nested mapping without mutating any values', async () => {
  const h = await subgraphHarness();
  h.inside.nodes.push({ id: 12, type: h.inside.id, subgraph: h.inside, inputs: [], widgets: [], isSubgraphNode: () => true });
  h.app.graphToPrompt = async () => ({ workflow: {}, output: { [h.path]: { class_type: 'Known', inputs: { fps: 4 } } } });
  h.emit('patch', 'cycle', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'instance_traversal_limit');
  assert.equal(h.leaf.widgets[0].value, 4);
  h.emit('patch', 'depth', { patches: [{ node_id: Array(35).fill('6').join(':'), widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'invalid_instance_path');
  h.inside.nodes.pop();
  for (let index = 0; index < 10001; index++) h.root.nodes.push({ id: index + 100, type: h.inside.id, subgraph: h.inside, isSubgraphNode: () => true });
  h.emit('patch', 'wide-budget', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'instance_traversal_limit');
  assert.equal(h.leaf.widgets[0].value, 4);
});

test('unreferenced definitions do not count as reachable instance occurrences', async () => {
  const h = await subgraphHarness();
  h.app.graph._subgraphs = new Map([['unused', { nodes: [{ id: 99, subgraph: h.inside, isSubgraphNode: () => true }] }]]);
  h.emit('patch', 'reachable-only', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.error, undefined);
  assert.equal(h.leaf.widgets[0].value, 8);
});

test('compile maps writable scalar widgets and rejects connected inputs or missing instance paths', async () => {
  const h = await widgetHarness();
  h.node.inputs.push({ name: 'prompt', link: 7 });
  h.app.graphToPrompt = async () => ({ workflow: h.app.graph.serialize(), output: {
    1: { class_type: 'Known', inputs: { model: 'model-a', width: 512, enabled: true, prompt: 'old', hidden: 7, array: [1, 2] } },
    '3:1': { class_type: 'Known', inputs: { width: 512 } },
  } });
  h.emit('compile', 'compile'); await h.flush();
  const result = h.replies.at(-1).message.result;
  assert.deepEqual(result.controls.map(item => item.input), ['model', 'width', 'enabled']);
  assert.deepEqual(result.controls[0], { node_id: '1', input: 'model', widget_node_id: '1', widget_name: 'model' });
  assert.deepEqual(result.unmapped.map(item => item.reason), ['connected_input', 'widget_not_found', 'instance_not_found']);
});

test('patch validates the whole batch before applying, updates callbacks and exports current native values', async () => {
  const h = await widgetHarness();
  h.emit('patch', 'bad', { patches: [{ node_id: '1', widget_name: 'width', value: 768 }, { node_id: '1', widget_name: 'model', value: 'absent' }] }); await h.flush();
  assert.equal(h.node.widgets[1].value, 512); assert.deepEqual(h.replies.at(-1).message.result.applied, []);
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'invalid_enum');
  h.emit('patch', 'good', { patches: [{ node_id: '1', widget_name: 'width', value: 768 }, { node_id: '1', widget_name: 'model', value: 'model-b' }, { node_id: '1', widget_name: 'enabled', value: false }] });
  h.emit('compile', 'compile'); await h.flush();
  assert.equal(h.replies.find(reply => reply.message.requestId === 'good').message.result.applied.length, 3);
  assert.deepEqual(h.events, ['before', ['model', 'model-b'], 'after', 'change']);
  assert.equal(h.replies.at(-1).message.result.output[1].inputs.model, 'model-b');
  assert.equal(h.replies.at(-1).message.result.workflow.nodes[0].widgets_values[1], 768);
});

test('patch rejects enum/type/range/integer/link/duplicate errors and protects conflicting internal drafts', async () => {
  const h = await widgetHarness();
  h.node.inputs.push({ name: 'prompt', link: 5 });
  const cases = [
    [{ node_id: '1', widget_name: 'width', value: '768' }, 'type_mismatch'],
    [{ node_id: '1', widget_name: 'width', value: 4096 }, 'out_of_range'],
    [{ node_id: '1', widget_name: 'width', value: 100.5 }, 'integer_required'],
    [{ node_id: '1', widget_name: 'prompt', value: 'new' }, 'connected_input'],
    [{ node_id: '1', widget_name: 'model', value: 'model-b', expected_value: 'older-model' }, 'conflict'],
  ];
  for (const [index, [patch, reason]] of cases.entries()) {
    h.emit('patch', `bad-${index}`, { patches: [patch] }); await h.flush();
    const response = h.replies.at(-1).message; assert(response.error); assert.equal(response.result.unsupported[0].reason, reason);
    if (reason === 'conflict') assert.equal(response.result.unsupported[0].current_value, 'model-a');
  }
  h.emit('patch', 'duplicate', { patches: Array(2).fill({ node_id: '1', widget_name: 'width', value: 768 }) }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'duplicate_patch');
  h.emit('patch', 'resolve', { patches: [{ node_id: '1', widget_name: 'model', value: 'model-b', expected_value: 'model-a' }] }); await h.flush();
  assert.equal(h.node.widgets[0].value, 'model-b');
  h.emit('patch', 'already-set', { patches: [{ node_id: '1', widget_name: 'model', value: 'model-b', expected_value: 'obsolete' }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.applied.length, 1);
});

test('callback failure or callback rewriting a target rolls back the complete workflow', async () => {
  const h = await widgetHarness();
  h.node.widgets[0].callback = () => { h.node.widgets[3].value = 'side effect'; throw new Error('PRIVATE'); };
  h.emit('patch', 'throws', { patches: [{ node_id: '1', widget_name: 'model', value: 'model-b' }, { node_id: '1', widget_name: 'width', value: 768 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.deepEqual(h.node.widgets.map(widget => widget.value), ['model-a', 512, true, 'old']);
  h.node.widgets[0].callback = () => { h.node.widgets[1].value = 128; };
  h.emit('patch', 'rewrites', { patches: [{ node_id: '1', widget_name: 'model', value: 'model-b' }, { node_id: '1', widget_name: 'width', value: 768 }] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.deepEqual(h.node.widgets.map(widget => widget.value), ['model-a', 512, true, 'old']);
  assert(!JSON.stringify(h.replies).includes('PRIVATE'));
});

test('callback changes to enum constraints cannot report a now-invalid parameter as applied', async () => {
  const h = await widgetHarness();
  h.node.widgets[0].callback = () => { h.node.widgets[0].options.values = ['model-a']; };
  h.emit('patch', 'changed-enum', { patches: [{ node_id: '1', widget_name: 'model', value: 'model-b' }] }); await h.flush();
  const reply = h.replies.at(-1).message;
  assert(reply.error); assert.equal(reply.result.rolled_back, true); assert.deepEqual(reply.result.applied, []);
  assert.equal(h.node.widgets[0].value, 'model-a');
});

async function buttonHarness({ specification = { required: { text: ['STRING'] } }, importer = false } = {}) {
  function RegisteredNode() {}
  RegisteredNode.nodeData = { input: specification };
  const node = Object.assign(Object.create(RegisteredNode.prototype), {
    id: 1, type: 'Known', comfyClass: 'Known', inputs: [],
    widgets: [{ name: 'text', type: 'text', value: 'keep text' },
      { name: 'open_picker', type: 'button', value: 'UI button value' }],
  });
  const workflow = { nodes: [{ id: 1, type: 'Known', widgets_values: ['keep text', 'UI button value'],
    properties: { extension_state: { keep: true } } }], links: [] };
  const h = harness(importer ? { loadApiJson: (_prompt, { set }) => set(workflow) } : {});
  const backendSchema = { input: copy(specification) }, schemaRequests = [];
  h.window.AbortController = AbortController;
  h.window.fetch = async (url, options) => {
    schemaRequests.push({ url, options });
    return { ok: true, json: async () => ({ Known: copy(backendSchema) }) };
  };
  h.window.LiteGraph.registered_node_types.Known = RegisteredNode;
  h.app.graph.getNodeById = id => String(id) === '1' ? node : null;
  h.start(); h.emit('load', 'load', { document: workflow }); await h.flush();
  return { ...h, node, workflow, RegisteredNode, backendSchema, schemaRequests };
}

test('compile excludes only registered-schema-undeclared action buttons and leaves native documents intact', async () => {
  const h = await buttonHarness();
  const workflowBefore = copy(h.current());
  const output = { 1: { class_type: 'Known', inputs: {
    text: 'keep text', open_picker: 'UI button value', unknown_parameter: 'keep unknown string',
    extension_data: { keep: ['all', false] },
  }, _meta: { title: 'Keep title' } } };
  const outputBefore = copy(output);
  h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
  h.emit('compile', 'compile'); await h.flush();
  const result = h.replies.at(-1).message.result;
  assert.deepEqual(result.output, { 1: { ...output[1], inputs: {
    text: 'keep text', unknown_parameter: 'keep unknown string', extension_data: { keep: ['all', false] },
  } } });
  assert.deepEqual(result.ignored_ui_inputs, [{ node_id: '1', input: 'open_picker', reason: 'undeclared_button_widget' }]);
  assert.deepEqual(result.controls.map(control => control.input), ['text']);
  assert.deepEqual(result.workflow, workflowBefore);
  assert.deepEqual(copy(h.current()), workflowBefore);
  assert.deepEqual(output, outputBefore);
  assert.deepEqual(h.node.widgets[1], { name: 'open_picker', type: 'button', value: 'UI button value' });
});

test('declared required optional and hidden buttons remain API parameters', async () => {
  for (const group of ['required', 'optional', 'hidden']) {
    const h = await buttonHarness({ specification: { [group]: { open_picker: ['STRING'] } } });
    const output = { 1: { class_type: 'Known', inputs: { open_picker: 'keep declared value' } } };
    h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
    h.emit('compile', 'compile'); await h.flush();
    assert.deepEqual(h.replies.at(-1).message.result.output, output, group);
    assert.deepEqual(h.replies.at(-1).message.result.ignored_ui_inputs, [], group);
  }
});

test('proven DOM and explicitly nonserializing UI widgets are excluded but type labels and arbitrary objects are retained', async () => {
  for (const mode of ['real DOM', 'nonserializing', 'div label only', 'fake element']) {
    const h = await buttonHarness();
    class DOMElement {}
    h.window.Element = DOMElement;
    h.node.widgets[1].type = 'div';
    if (mode === 'real DOM') h.node.widgets[1].element = new DOMElement();
    if (mode === 'nonserializing') { h.node.widgets[1].type = 'custom-configuration'; h.node.widgets[1].options = { serialize: false }; }
    if (mode === 'fake element') h.node.widgets[1].element = { tagName: 'DIV', nodeType: 1 };
    const output = { 1: { class_type: 'Known', inputs: { text: 'keep text', open_picker: { configuration: ['keep in native workflow'] } } } };
    const original = copy(output);
    h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
    h.emit('compile', 'compile'); await h.flush();
    const result = h.replies.at(-1).message.result;
    if (mode === 'real DOM' || mode === 'nonserializing') {
      assert.deepEqual(result.output[1].inputs, { text: 'keep text' });
      assert.deepEqual(result.ignored_ui_inputs, [{ node_id: '1', input: 'open_picker',
        reason: mode === 'real DOM' ? 'undeclared_dom_widget' : 'nonserializing_widget' }]);
    } else {
      assert.deepEqual(result.output, original);
      assert.deepEqual(result.ignored_ui_inputs, []);
    }
    assert.deepEqual(output, original);
    assert.deepEqual(result.workflow.nodes[0].properties, { extension_state: { keep: true } });
  }
});

test('DOM UI filtering retains hidden schema fields, connected widgets and original expected API configuration', async () => {
  for (const safeguard of ['hidden declaration', 'connected input', 'expected configuration']) {
    const h = await buttonHarness({ importer: true });
    class DOMElement {}
    h.window.Element = DOMElement;
    h.node.widgets[1].type = 'div'; h.node.widgets[1].element = new DOMElement();
    if (safeguard === 'hidden declaration') h.backendSchema.input.hidden = { open_picker: 'EXTRA_PNGINFO' };
    if (safeguard === 'connected input') h.node.inputs.push({ name: 'open_picker', link: 5 });
    const output = { 1: { class_type: 'Known', inputs: { text: 'keep text', open_picker: { original: true } } } };
    h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
    if (safeguard === 'expected configuration') h.emit('importApi', 'import', { prompt: output });
    else h.emit('compile', 'compile');
    await h.flush();
    const response = h.replies.at(-1).message;
    assert.equal(response.error, undefined);
    assert.deepEqual(response.result.output, output, safeguard);
    assert.deepEqual(response.result.ignored_ui_inputs, [], safeguard);
  }
});

test('buttons are retained when their registered schema or unique widget and disconnected status cannot be proven', async () => {
  const cases = [
    ['missing constructor schema', h => { delete h.RegisteredNode.nodeData; }],
    ['missing input schema', h => { h.RegisteredNode.nodeData = {}; }],
    ['malformed schema group', h => { h.RegisteredNode.nodeData.input.hidden = []; }],
    ['not registered', h => { delete h.window.LiteGraph.registered_node_types.Known; }],
    ['different registered constructor', h => { h.window.LiteGraph.registered_node_types.Known = function OtherNode() {}; }],
    ['runtime class mismatch', h => { h.node.comfyClass = 'OtherClass'; }],
    ['real string widget', h => { h.node.widgets[1].type = 'text'; }],
    ['converted widget', h => { h.node.widgets[1].type = 'converted-widget'; }],
    ['ambiguous widgets', h => { h.node.widgets.push({ ...h.node.widgets[1] }); }],
    ['direct input link', h => { h.node.inputs.push({ name: 'open_picker', link: 0 }); }],
    ['widget input link', h => { h.node.inputs.push({ name: 'converted_slot', widget: { name: 'open_picker' }, link: 7 }); }],
    ['serialized API link', () => {}, ['2', 0]],
  ];
  for (const [label, change, value = 'keep unverified'] of cases) {
    const h = await buttonHarness(); change(h);
    const output = { 1: { class_type: 'Known', inputs: { open_picker: value } } };
    h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
    h.emit('compile', 'compile'); await h.flush();
    const reply = h.replies.at(-1).message;
    // A node removed from the registry is blocked before compilation.
    if (label === 'not registered') { assert.match(reply.error, /缺失节点/); continue; }
    assert.equal(reply.error, undefined, label);
    assert.deepEqual(reply.result.output, output, label);
    assert.deepEqual(reply.result.ignored_ui_inputs, [], label);
  }
});

test('API roundtrip permits only newly attached proven UI buttons and reports them without rewriting the workflow', async () => {
  const h = await buttonHarness({ importer: true });
  const expected = { 1: { class_type: 'Known', inputs: { text: 'keep text', extension_data: { keep: true } } } };
  const output = { 1: { class_type: 'Known', inputs: { ...expected[1].inputs, open_picker: 'UI button value' }, _meta: { title: 'Known' } } };
  const before = copy({ expected, output });
  h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
  h.emit('importApi', 'import', { prompt: expected }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.output, { 1: { ...expected[1], _meta: { title: 'Known' } } });
  assert.deepEqual(response.result.ignored_ui_inputs, [{ node_id: '1', input: 'open_picker', reason: 'undeclared_button_widget' }]);
  assert.deepEqual(response.result.workflow, h.workflow);
  assert.deepEqual(h.current(), h.workflow);
  assert.deepEqual({ expected, output }, before);
});

test('original expected API fields are never discarded even when they look like undeclared buttons', async () => {
  for (const actualValue of ['original API data', 'changed API data', undefined]) {
    const h = await buttonHarness({ importer: true });
    const before = copy(h.current());
    const expected = { 1: { class_type: 'Known', inputs: { text: 'keep text', open_picker: 'original API data' } } };
    const inputs = { text: 'keep text', ...(actualValue !== undefined ? { open_picker: actualValue } : {}) };
    h.app.graphToPrompt = async () => ({ workflow: h.current(), output: { 1: { class_type: 'Known', inputs } } });
    h.emit('importApi', 'import', { prompt: expected }); await h.flush();
    const response = h.replies.at(-1).message;
    if (actualValue === 'original API data') {
      assert.equal(response.error, undefined);
      assert.deepEqual(response.result.output, expected);
      assert.deepEqual(response.result.ignored_ui_inputs, []);
    } else {
      assert.match(response.error, /无损转换/);
      assert.deepEqual(copy(h.current()), before);
    }
    assert.deepEqual(expected[1].inputs, { text: 'keep text', open_picker: 'original API data' });
  }
});

async function promotedUIHarness({ deep = false, promoted = true, shared = false } = {}) {
  const h = await subgraphHarness({ deep, shared });
  const name = 'file_picker_action'; // Deliberately not the stock upload name.
  const button = () => ({ name, type: 'button', value: 'UI action', options: { serialize: false } });
  h.leaf.widgets.push(button());
  h.leaf.constructor.nodeData.input.required[name] = ['IMAGEUPLOAD', { image_upload: true, imageInputName: 'image' }];
  const promote = (scope, host, child) => {
    const index = host.inputs.length;
    let slot = child.inputs.find(input => input.name === name);
    if (slot) slot.link = 50;
    else { slot = { name, widget: { name }, link: 50 }; child.inputs.push(slot); }
    scope.links.set(50, { originIsIoNode: true, origin_id: -10, origin_slot: index,
      target_id: child.id, target_slot: child.inputs.indexOf(slot) });
    host.inputs.push({ name, widget: { name }, link: null }); host.widgets.push(button());
  };
  if (promoted) {
    if (deep) { promote(h.inside, h.innerHost, h.leaf); promote(h.outer, h.first, h.innerHost); }
    else promote(h.inside, h.first, h.leaf);
  }
  const backendSchema = { input: { required: { fps: ['INT'], mode: [['a', 'b']] } } };
  const schemaRequests = [];
  h.window.AbortController = AbortController;
  h.window.fetch = async (url, options) => {
    schemaRequests.push({ url, options });
    return { ok: true, json: async () => ({ Known: copy(backendSchema) }) };
  };
  return { ...h, name, backendSchema, schemaRequests };
}

test('backend schema excludes only proven nested UI actions across direct and deep promotion chains', async () => {
  for (const deep of [false, true]) {
    const h = await promotedUIHarness({ deep });
    const before = copy(h.serialize()), apiBefore = h.output();
    h.emit('compile', 'nested-ui'); await h.flush();
    const reply = h.replies.at(-1).message;
    assert.equal(reply.error, undefined);
    assert.equal(Object.hasOwn(reply.result.output[h.path].inputs, h.name), false, `deep=${deep}; ${JSON.stringify(h.schemaRequests.map(item => item.url))}`);
    assert.equal(reply.result.output[h.path].inputs.fps, 4);
    assert.deepEqual(reply.result.ignored_ui_inputs, [{ node_id: h.path, input: h.name, reason: 'undeclared_button_widget' }]);
    assert.deepEqual(h.serialize(), before);
    assert.deepEqual(h.output(), apiBefore);
    assert.equal(h.schemaRequests.length, 1);
    assert.equal(h.schemaRequests[0].url, '/object_info/Known');
    assert.equal(h.schemaRequests[0].options.mode, 'same-origin');
    assert.equal(h.schemaRequests[0].options.redirect, 'error');
    // Filtering cannot make a nonserializing promoted button writable.
    h.emit('patch', 'ui-patch', { patches: [{ node_id: h.path, widget_name: h.name, value: 'changed' }] }); await h.flush();
    assert.equal(h.replies.at(-1).message.result.applied.length, 0);
    assert.deepEqual(h.serialize(), before);
  }
});

test('authoritative required optional hidden and dynamic backend contracts preserve nested UI-looking inputs', async () => {
  for (const group of ['required', 'optional', 'hidden', 'dynamic']) {
    const h = await promotedUIHarness();
    if (group === 'dynamic') h.backendSchema.input.required.branch = ['COMFY_DYNAMICCOMBO_V3', { options: [] }];
    else h.backendSchema.input[group] = { ...(h.backendSchema.input[group] || {}), [h.name]: ['STRING'] };
    h.emit('compile', 'declared'); await h.flush();
    const result = h.replies.at(-1).message.result;
    assert.deepEqual(result.output, h.output(), group);
    assert.deepEqual(result.ignored_ui_inputs, [], group);
  }
});

test('UI schema requests deduplicate repeated classes and refresh on each compile', async () => {
  const h = await promotedUIHarness({ promoted: false });
  const second = Object.assign(Object.create(h.leaf.constructor.prototype), { ...h.leaf, id: 5,
    widgets: h.leaf.widgets.map(widget => ({ ...widget })), inputs: [] });
  h.inside.nodes.push(second);
  for (const requestId of ['first', 'second']) {
    h.emit('compile', requestId); await h.flush();
    const result = h.replies.at(-1).message.result;
    assert.equal(result.ignored_ui_inputs.length, 2);
  }
  assert.equal(h.schemaRequests.length, 2);
});

test('unproven linked shared ambiguous and changed promoted UI ownership is retained', async () => {
  for (const fault of ['host link', 'non IO link', 'wrong target', 'missing host widget',
    'duplicate leaf widget', 'shared direct leaf', 'changed while fetching', 'leaf changed while fetching', 'serialized link']) {
    const h = await promotedUIHarness({ promoted: fault !== 'shared direct leaf', shared: fault === 'shared direct leaf' });
    const compiled = h.output();
    h.app.graphToPrompt = async () => ({ workflow: h.serialize(), output: copy(compiled) });
    if (fault === 'host link') h.first.inputs[0].link = 77;
    if (fault === 'non IO link') h.inside.links.get(50).originIsIoNode = false;
    if (fault === 'wrong target') h.inside.links.get(50).target_id = 99;
    if (fault === 'missing host widget') h.first.widgets = [];
    if (fault === 'duplicate leaf widget') h.leaf.widgets.push({ ...h.leaf.widgets.at(-1) });
    if (fault === 'changed while fetching' || fault === 'leaf changed while fetching') {
      const fetch = h.window.fetch;
      h.window.fetch = async (...args) => {
        if (fault === 'changed while fetching') h.first.inputs[0].link = 77;
        else h.leaf.widgets[h.leaf.widgets.length - 1] = { ...h.leaf.widgets.at(-1) };
        return fetch(...args);
      };
    }
    if (fault === 'serialized link') h.app.graphToPrompt = async () => {
      const output = h.output(); output[h.path].inputs[h.name] = ['another-node', 0];
      return { workflow: h.serialize(), output };
    };
    h.emit('compile', 'unproven'); await h.flush();
    const result = h.replies.at(-1).message.result;
    assert.equal(Object.hasOwn(result.output[h.path].inputs, h.name), true, fault);
    assert.deepEqual(result.ignored_ui_inputs, [], fault);
  }
});

test('unavailable malformed rejected and timed-out authoritative schemas retain API data', async () => {
  for (const fault of ['network', 'http', 'invalid JSON', 'missing class', 'malformed group', 'timeout']) {
    const h = await promotedUIHarness();
    let signal;
    h.window.fetch = async (_url, options) => {
      signal = options.signal;
      if (fault === 'network') throw new Error('unavailable');
      if (fault === 'timeout') return new Promise(() => {});
      return { ok: fault !== 'http', json: async () => {
        if (fault === 'invalid JSON') throw new SyntaxError('bad JSON');
        if (fault === 'missing class') return {};
        if (fault === 'malformed group') return { Known: { input: { required: [] } } };
        return { Known: h.backendSchema };
      } };
    };
    h.emit('compile', fault); await h.flush();
    if (fault === 'timeout') {
      await new Promise(resolve => setTimeout(resolve, 2100));
      assert.equal(signal.aborted, true);
    }
    const result = h.replies.at(-1).message.result;
    assert.deepEqual(result.output, h.output(), fault);
    assert.deepEqual(result.ignored_ui_inputs, [], fault);
  }
});

test('API roundtrip still rejects unknown strings and unproven extra parameters after excluding a UI button', async () => {
  const h = await buttonHarness({ importer: true });
  const before = copy(h.current());
  h.app.graphToPrompt = async () => ({ workflow: h.current(), output: { 1: { class_type: 'Known', inputs: {
    text: 'keep text', open_picker: 'UI button value', unknown_extension_input: 'must not discard',
  } } } });
  h.emit('importApi', 'import', { prompt: { 1: { class_type: 'Known', inputs: { text: 'keep text' } } } }); await h.flush();
  assert.match(h.replies.at(-1).message.error, /无损转换/);
  assert.deepEqual(copy(h.current()), before);
});

test('imports API prompts through ComfyUI and returns the real native document and controls only after exact recompilation', async () => {
  const expected = { '1': { class_type: 'Known', inputs: { seed: 77, ref: ['2', 0], extension_data: { keep: ['all', false] } }, _meta: { title: 'Unknown metadata' } }, '2': { class_type: 'Known', inputs: { seed: 4 } } };
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [77] }, { id: 2, type: 'Known' }], links: [[1, 2, 0, 1, 0, 'IMAGE']] };
  const h = harness({
    loadApiJsonArguments: (_prompt, name, settings) => {
      assert.equal(name, 'PrismCanvas preset');
      assert.deepEqual(JSON.parse(JSON.stringify(settings)), { deferWarnings: true });
    },
    loadApiJson: (_prompt, graph) => graph.set(converted),
  }); h.start();
  h.emit('load', 'load', { document: document() }); await h.flush();
  h.app.graphToPrompt = async targetGraph => { h.calls.push('compileImported'); assert.equal(targetGraph, h.app.graph); return { workflow: converted, output: { '2': { class_type: 'Known', inputs: { seed: 4 } }, '1': { _meta: { title: 'Unknown metadata' }, inputs: { extension_data: { keep: ['all', false] }, ref: ['2', 0], seed: 77 }, class_type: 'Known' } } }; };
  h.emit('importApi', 'convert', { prompt: expected }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.workflow, converted);
  assert.deepEqual(response.result.output, expected);
  assert(h.calls.includes('importApi')); assert(h.calls.includes('compileImported'));
  assert.equal(h.current(), converted);
  assert.equal(h.calls.some(call => /queue|generate|prompt/i.test(call)), false);
});

test('awaits ComfyUI prototype importer when an extension instance wrapper drops its Promise', async () => {
  const expected = { 1: { class_type: 'Known', inputs: { seed: 4 } } };
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4] }], links: [] };
  const h = harness(); h.start();
  let importerFinished = false;
  Object.setPrototypeOf(h.app, {
    loadApiJson: async function (_prompt, name, settings) {
      assert.equal(name, 'PrismCanvas preset');
      assert.deepEqual(JSON.parse(JSON.stringify(settings)), { deferWarnings: true });
      await new Promise(resolve => setTimeout(resolve, 5));
      h.setCurrent(converted);
      importerFinished = true;
    },
  });
  h.app.loadApiJson = async () => { h.calls.push('brokenExtensionWrapper'); };
  h.emit('load', 'load', { document: document() }); await h.flush();
  h.app.graphToPrompt = async () => ({ workflow: converted, output: expected });
  h.emit('importApi', 'convert', { prompt: expected });
  await new Promise(resolve => setTimeout(resolve, 10));
  await h.flush();
  assert.equal(h.replies.at(-1).message.error, undefined);
  assert.equal(importerFinished, true);
  assert(!h.calls.includes('brokenExtensionWrapper'));
  assert.deepEqual(h.replies.at(-1).message.result.workflow, converted);
});

test('allows only a frontend-added display title during API prompt recompilation', async () => {
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4] }], links: [] };
  const run = async (expected, output) => {
    const h = harness({ loadApiJson: (_prompt, graph) => graph.set(converted) }); h.start();
    h.emit('load', 'load', { document: document() }); await h.flush();
    h.app.graphToPrompt = async () => ({ workflow: converted, output });
    h.emit('importApi', 'convert', { prompt: expected }); await h.flush();
    return { h, response: h.replies.at(-1).message };
  };

  const { h: accepted, response } = await run(
    { 1: { class_type: 'Known', inputs: { seed: 4 } } },
    { 1: { class_type: 'Known', inputs: { seed: 4 }, _meta: { title: 'Known' } } });
  assert.equal(response.error, undefined);
  assert.deepEqual(accepted.current(), converted);

  const declaredTitle = await run(
    { 1: { class_type: 'Known', inputs: {}, _meta: { title: 'Original' } } },
    { 1: { class_type: 'Known', inputs: {}, _meta: { title: 'Changed' } } });
  assert.match(declaredTitle.response.error, /无损转换/);
  assert.equal(JSON.stringify(declaredTitle.h.current()), JSON.stringify(document()));

  const unknownMetadata = await run(
    { 1: { class_type: 'Known', inputs: {}, _meta: { plugin: 'keep' } } },
    { 1: { class_type: 'Known', inputs: {}, _meta: { title: 'Known' } } });
  assert.match(unknownMetadata.response.error, /无损转换/);
  assert.equal(JSON.stringify(unknownMetadata.h.current()), JSON.stringify(document()));
});

test('recompiles the exact imported root graph instead of an unrelated active canvas', async () => {
  const expected = { 1: { class_type: 'Known', inputs: { seed: 4 } } };
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4] }], links: [] };
  const h = harness({ loadApiJson: (_prompt, { set }) => set(converted) }); h.start();
  h.emit('load', 'load', { document: document() }); await h.flush();
  h.app.graphToPrompt = async targetGraph => ({ workflow: converted,
    output: targetGraph === h.app.graph ? expected : {} });
  h.emit('importApi', 'convert', { prompt: expected }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.workflow, converted);
});

test('blocks an API importer full-document reset while retaining the claimed editor draft', async () => {
  const expected = { 1: { class_type: 'Known', inputs: { seed: 4 } } };
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4] }], links: [] };
  const h = harness({ loadApiJson: async (_prompt, { app, set }) => {
    await app.loadGraphData(undefined);
    await app.loadGraphData(undefined);
    set(converted);
  } });
  h.start();
  h.emit('load', 'load', { document: document() }); await h.flush();
  h.app.graphToPrompt = async () => ({ workflow: converted, output: expected });
  h.emit('importApi', 'convert', { prompt: expected }); await h.flush();
  assert.equal(h.replies.at(-1).message.error, undefined);
  assert.deepEqual(h.current(), converted);

  await h.app.loadGraphData(undefined);
  assert.equal(JSON.stringify(h.current()), JSON.stringify(converted));
  assert(h.replies.filter(reply => reply.message.action === 'notice').length >= 2);
});

test('rolls back when API importer finalization throws even after valid native nodes were built', async () => {
  const before = document();
  const expected = { 1: { class_type: 'Known', inputs: { seed: 4 } } };
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4] }], links: [] };
  const h = harness({ loadApiJson: (_prompt, { set }) => {
    set(converted);
    throw new Error('workflow tab activation failed after native nodes were built');
  } });
  h.start();
  h.emit('load', 'load', { document: document() }); await h.flush();
  h.app.graphToPrompt = async () => ({ workflow: converted, output: {
    1: { class_type: 'Known', inputs: { seed: 4 }, _meta: { title: 'Known' } },
  } });
  h.emit('importApi', 'convert', { prompt: expected }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.match(response.error, /无损转换/);
  assert.equal(JSON.stringify(h.current()), JSON.stringify(before));
  assert.deepEqual(h.calls, ['load', 'importApi', 'load']);
});

test('refuses a ComfyUI frontend without loadApiJson and leaves the bootstrap workflow intact', async () => {
  const h = harness({ loadApiJson: false }); h.start();
  h.app.loadApiJson = async () => { h.calls.push('unsafeInstanceImporter'); };
  const before = copy(h.current()); h.emit('load', 'load', { document: before }); await h.flush();
  h.emit('importApi', 'convert', { prompt: { 1: { class_type: 'Known', inputs: { seed: 4 } } } }); await h.flush();
  assert.match(h.replies.at(-1).message.error, /不支持 API 工作流导入/);
  assert.equal(JSON.stringify(h.current()), JSON.stringify(before));
  assert.deepEqual(h.calls, ['load']);
});

test('semantic mismatch including an unknown field restores the bootstrap graph and does not return an editor conversion', async () => {
  const before = document(), converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4] }], links: [] };
  const h = harness({ loadApiJson: (_prompt, graph) => graph.set(converted) }); h.start();
  h.emit('load', 'load', { document: before }); await h.flush();
  h.app.graphToPrompt = async () => ({ workflow: converted, output: { 1: { class_type: 'Known', inputs: { seed: 4, unknown_from_extension: 'changed' } } } });
  h.emit('importApi', 'convert', { prompt: { 1: { class_type: 'Known', inputs: { seed: 4, unknown_from_extension: 'original' } } } }); await h.flush();
  assert.match(h.replies.at(-1).message.error, /无损转换/);
  assert.equal(JSON.stringify(h.current()), JSON.stringify(before));
  assert.deepEqual(h.calls, ['load', 'importApi', 'load']);
});

test('API mismatch reports bounded structure-only categories while retaining rollback and strict original fields', async () => {
  const expected = { 1: { class_type: 'Known', inputs: { seed: 7, removed: 'PRIVATE ORIGINAL CONTENT' }, _meta: { title: 'PRIVATE TITLE' } },
    3: { class_type: 'Known', inputs: {} } };
  const output = { 1: { class_type: 'Known', inputs: { seed: 8, extra: 'PRIVATE NEW CONTENT' }, _meta: { title: 'PRIVATE DIFFERENT TITLE' } },
    2: { class_type: 'Known', inputs: {} } };
  const h = harness({ loadApiJson: (_, graph) => graph.set({ nodes: [{ id: 1, type: 'Known' }], links: [] }) }); h.start();
  h.emit('load', 'load', { document: document() }); await h.flush(); const before = copy(h.current());
  h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
  h.emit('importApi', 'mismatch', { prompt: expected }); await h.flush();
  const reply = h.replies.at(-1).message;
  assert.match(reply.error, /无损转换/);
  assert.deepEqual(reply.result.semantic_mismatch.issues, [
    { code: 'value_changed', node_id: '1', input: 'seed' }, { code: 'missing_input', node_id: '1', input: 'removed' },
    { code: 'added_input', node_id: '1', input: 'extra' }, { code: 'metadata_changed', node_id: '1', field: '_meta' },
    { code: 'missing_node', node_id: '3' }, { code: 'added_node', node_id: '2' },
  ]);
  assert.equal(JSON.stringify(reply).includes('PRIVATE'), false);
  assert.deepEqual(copy(h.current()), before);
});

test('only newly materialized explicit scalar optional defaults can compare equal and remain in the native output', async () => {
  const variants = [
    { optional: ['FLOAT', { default: 0.7 }], value: 0.7, accepted: true },
    { optional: ['COMBO', { default: 'auto', options: ['auto', 'other'] }], value: 'auto', accepted: true },
    { optional: ['COMFY_DYNAMICCOMBO_V3', { default: 'auto', options: [{ key: 'auto', inputs: { required: {} } }] }], value: 'auto', accepted: true },
    { optional: ['FLOAT', { default: 0.7 }], value: 0.8 },
    { optional: ['FLOAT', {}], value: 0.7 },
    { optional: ['INT', { default: 'wrong' }], value: 'wrong' },
    { optional: ['COMBO', { options: ['auto', 'other'] }], value: 'auto' },
    { optional: ['FLOAT', { default: 0.7 }], value: 0.7, required: true },
    { optional: ['FLOAT', { default: 0.7 }], value: 0.7, original: 0.5 },
  ];
  for (const variant of variants) {
    const h = harness({ loadApiJson: (_, graph) => graph.set({ nodes: [{ id: 1, type: 'Known' }], links: [] }) }); h.start();
    class Registered {}
    Registered.nodeData = { input: { required: variant.required ? { extra: variant.optional } : {},
      optional: variant.required ? {} : { extra: variant.optional } } };
    const node = Object.assign(new Registered(), { id: 1, type: 'Known', widgets: [] });
    h.window.LiteGraph.registered_node_types.Known = Registered; h.app.graph._nodes = [node];
    h.emit('load', 'load', { document: document() }); await h.flush();
    const expected = { 1: { class_type: 'Known', inputs: { ...(variant.original === undefined ? {} : { extra: variant.original }) } } };
    const output = { 1: { class_type: 'Known', inputs: { extra: variant.value } } };
    h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
    h.emit('importApi', 'convert', { prompt: expected }); await h.flush();
    const reply = h.replies.at(-1).message;
    if (variant.accepted) { assert.equal(reply.error, undefined); assert.deepEqual(reply.result.output, output); }
    else { assert.match(reply.error, /无损转换/); assert.equal(reply.result.semantic_mismatch.issues[0].code, variant.original === undefined ? 'added_input' : 'value_changed'); }
    assert.deepEqual(output[1].inputs, { extra: variant.value });
  }
});

test('failed API import is rolled back even when the frontend throws after changing the graph', async () => {
  const before = document();
  const h = harness({ loadApiJson: (_prompt, graph) => { graph.set({ nodes: [], links: [] }); throw new Error('private node data'); } }); h.start();
  h.emit('load', 'load', { document: before }); await h.flush();
  h.emit('importApi', 'convert', { prompt: { 1: { class_type: 'Known', inputs: { seed: 4 } } } }); await h.flush();
  assert.match(h.replies.at(-1).message.error, /无损转换/);
  assert.equal(JSON.stringify(h.current()), JSON.stringify(before));
  assert(!JSON.stringify(h.replies).includes('private node data'));
});

async function additionHarness({ specification = { required: { seed: ['INT'], extra: ['COMBO', { options: ['auto', 'other'] }] } },
  inputs = { seed: 4, extra: 'auto' }, expected = { 1: { class_type: 'Known', inputs: { seed: 4 },
    _meta: { plugin: 'original' }, properties: { custom: true } } }, ...options } = {}) {
  let output = { 1: { ...copy(expected[1]), inputs: copy(inputs) } };
  const converted = { nodes: [{ id: 1, type: 'Known', widgets_values: [4, 'auto'] }], links: [], extra: { converted: true } };
  const h = harness({ ...options, loadApiJson: (prompt, graph) => {
    options.onImport?.(prompt);
    graph.set(copy(converted));
  } });
  class Registered {}
  Registered.nodeData = { input: specification };
  const node = Object.assign(new Registered(), { id: 1, type: 'Known', comfyClass: 'Known', inputs: [], widgets: [] });
  h.window.LiteGraph.registered_node_types.Known = Registered;
  h.app.graph._nodes = [node];
  h.app.graphToPrompt = async () => ({ workflow: h.current(), output });
  h.start(); h.emit('load', 'initial', { document: document() }); await h.flush();
  let sequence = 0;
  const attempt = async (acceptance = {}, prompt = expected) => {
    const requestId = `attempt-${++sequence}`;
    h.emit('importApi', requestId, { prompt, ...acceptance }); await h.flush();
    return h.replies.find(reply => reply.message.requestId === requestId).message;
  };
  return { ...h, Registered, expected, converted, attempt, setOutput: value => { output = value; }, output: () => output };
}
const acceptReview = review => ({ review_id: review.review_id, accepted_added_inputs: review.added_inputs });

test('declared additions require explicit confirmation and preserve every original input and field', async () => {
  const h = await additionHarness(), original = copy(h.expected), before = copy(h.current());
  const first = await h.attempt();
  assert.match(first.error, /无损转换/);
  assert.deepEqual(first.result.review.added_inputs, [{ node_id: '1', class_type: 'Known', input: 'extra', value: 'auto' }]);
  assert.match(first.result.review.review_id, /^[0-9a-f]{48}$/);
  assert.deepEqual(copy(h.current()), before);
  assert.equal(first.result.workflow, undefined);
  const accepted = await h.attempt(acceptReview(first.result.review));
  assert.equal(accepted.error, undefined);
  assert.deepEqual(accepted.result.accepted_added_inputs, first.result.review.added_inputs);
  assert.deepEqual(accepted.result.workflow, h.converted);
  assert.deepEqual(accepted.result.output[1], { ...original[1], inputs: { seed: 4, extra: 'auto' } });
  assert.deepEqual(h.expected, original);
  await assert.rejects(h.app.queuePrompt(), /返回棱光/);
});

test('API importer mutations cannot rewrite the comparison baseline or quoted original prompt', async () => {
  const h = await additionHarness({ onImport: prompt => {
    prompt[1].inputs.seed = 99;
    prompt[1]._meta.plugin = 'changed';
    prompt[1].properties.custom = false;
  } });
  h.setOutput({ 1: { class_type: 'Known', inputs: { seed: 99, extra: 'auto' },
    _meta: { plugin: 'changed' }, properties: { custom: false } } });
  const first = await h.attempt();
  assert(first.error); assert.equal(first.result.review, undefined);
  assert(first.result.semantic_mismatch.issues.some(item => item.code === 'value_changed'));
  assert(first.result.semantic_mismatch.issues.some(item => item.code === 'metadata_changed'));
  assert.deepEqual(copy(h.current()), document());
  assert.equal(h.expected[1].inputs.seed, 4);
});

test('review never authorizes changed, removed or newly added nodes, metadata or existing parameters', async () => {
  const mutations = [
    output => { output[1].inputs.seed = 5; },
    output => { delete output[1].inputs.seed; },
    output => { output[1]._meta.plugin = 'changed'; },
    output => { output[1].properties.custom = false; },
    output => { output[1].class_type = 'Other'; },
    output => { output[2] = { class_type: 'Known', inputs: {} }; },
    output => { delete output[1]; output[2] = { class_type: 'Known', inputs: {} }; },
  ];
  for (const mutation of mutations) {
    const h = await additionHarness(), first = await h.attempt(), output = copy(h.output());
    mutation(output); h.setOutput(output);
    const retry = await h.attempt(acceptReview(first.result.review));
    assert(retry.error); assert.equal(retry.result.review, undefined);
    assert.deepEqual(copy(h.current()), document());
  }
});

test('wrong, altered, expired and already consumed quotes cannot accept a conversion', async () => {
  for (const kind of ['wrong id', 'changed value', 'reordered or extra candidate', 'expiry', 'consumed']) {
    let now = 1000;
    const h = await additionHarness({ now: () => now }), first = await h.attempt();
    const approval = acceptReview(copy(first.result.review));
    if (kind === 'wrong id') approval.review_id = '0'.repeat(48);
    if (kind === 'changed value') approval.accepted_added_inputs[0].value = 'other';
    if (kind === 'reordered or extra candidate') approval.accepted_added_inputs.push(copy(approval.accepted_added_inputs[0]));
    if (kind === 'expiry') now += 5 * 60 * 1000;
    if (kind === 'consumed') await h.attempt({ review_id: 'wrong', accepted_added_inputs: [] });
    const retry = await h.attempt(approval);
    assert(retry.error, kind); assert.deepEqual(copy(h.current()), document());
    assert.notEqual(retry.result.review.review_id, first.result.review.review_id);
  }
});

test('quotes are bound to the entire original API prompt and the restored native snapshot', async () => {
  for (const kind of ['original prompt', 'native snapshot']) {
    const h = await additionHarness(), first = await h.attempt();
    let prompt = h.expected;
    if (kind === 'original prompt') {
      prompt = copy(h.expected); prompt[1].properties.custom = 'new';
      const output = copy(h.output()); output[1].properties.custom = 'new'; h.setOutput(output);
    } else h.current().extra.changed = true;
    const before = copy(h.current());
    const retry = await h.attempt(acceptReview(first.result.review), prompt);
    assert(retry.error); assert.notEqual(retry.result.review.review_id, first.result.review.review_id);
    assert.deepEqual(copy(h.current()), before);
  }
});

test('changed schema, changed exact delta or disappearing additions require a new review', async () => {
  for (const kind of ['schema', 'value', 'extra field', 'disappeared']) {
    const h = await additionHarness(), first = await h.attempt();
    if (kind === 'schema') h.Registered.nodeData.input.required.extra[1].tooltip = 'new schema';
    if (kind === 'value') h.output()[1].inputs.extra = 'other';
    if (kind === 'extra field') {
      h.Registered.nodeData.input.optional = { another: ['BOOLEAN'] };
      h.output()[1].inputs.another = false;
    }
    if (kind === 'disappeared') delete h.output()[1].inputs.extra;
    const retry = await h.attempt(acceptReview(first.result.review));
    assert(retry.error, kind); assert.deepEqual(copy(h.current()), document());
    if (kind === 'disappeared') assert.equal(retry.result.review, undefined);
    else assert.notEqual(retry.result.review.review_id, first.result.review.review_id);
  }
});

test('dynamic nested additions are reviewed only for the selected parent with its schema proof', async () => {
  const specification = { required: { seed: ['INT'], format: ['COMFY_DYNAMICCOMBO_V3', { options: [
    { key: 'mp4', inputs: { required: { codec: ['COMFY_DYNAMICCOMBO_V3', { options: [
      { key: 'h264', inputs: { optional: { encoding: [['auto', 're-encode'], { hidden: true }] } } },
      { key: 'av1', inputs: { optional: { quality: ['INT', { min: 0, max: 63 }] } } },
    ] }] } } },
    { key: 'webm', inputs: { required: { quality: ['INT'] } } },
  ] }] } };
  const expected = { 1: { class_type: 'Known', inputs: { seed: 4, format: 'mp4', 'format.codec': 'h264' } } };
  const h = await additionHarness({ specification, expected,
    inputs: { ...expected[1].inputs, 'format.codec.encoding': 'auto' } });
  const first = await h.attempt();
  assert.equal(first.result.review.added_inputs[0].input, 'format.codec.encoding');
  specification.required.format[1].options[0].inputs.required.codec[1].options[0].inputs.optional.encoding[1].tooltip = 'schema changed';
  const stale = await h.attempt(acceptReview(first.result.review));
  assert(stale.error); assert.notEqual(stale.result.review.review_id, first.result.review.review_id);
  const accepted = await h.attempt(acceptReview(stale.result.review));
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.output[1].inputs['format.codec.encoding'], 'auto');
  h.output()[1].inputs['format.codec.quality'] = 8;
  const inactive = await h.attempt();
  assert(inactive.error); assert.equal(inactive.result.review, undefined);
});

test('system hidden inputs are rejected while optional UI hidden scalar fields can be explicitly reviewed', async () => {
  for (const kind of ['system hidden', 'overlapping hidden', 'optional UI hidden']) {
    const specification = { required: { seed: ['INT'] } };
    if (kind === 'system hidden') specification.hidden = { extra: 'PROMPT' };
    else specification.optional = { extra: [['auto', 'other'], { hidden: true }] };
    if (kind === 'overlapping hidden') specification.hidden = { extra: 'PROMPT' };
    const h = await additionHarness({ specification }), first = await h.attempt();
    assert(first.error);
    if (kind === 'optional UI hidden') {
      assert(first.result.review); assert.equal((await h.attempt(acceptReview(first.result.review))).error, undefined);
    } else assert.equal(first.result.review, undefined);
  }
});

test('unproven, media, path, connected, collection and invalid scalar additions never receive a quote', async () => {
  const variants = [
    { spec: ['STRING'], value: 'C:\\private\\file.png' },
    { spec: ['STRING'], value: 'https://example.test/' },
    { spec: ['STRING'], value: 'relative/file.png' },
    { spec: ['STRING'], value: 'data:text/plain,hello' },
    { spec: ['STRING'], value: 'x'.repeat(2049) },
    { spec: ['STRING'], value: ['1', 0] },
    { spec: ['STRING'], value: { value: 'auto' } },
    { spec: ['INT'], value: 1.5 },
    { spec: ['INT', { min: 2, max: 3 }], value: 4 },
    { spec: ['FLOAT'], value: '4' },
    { spec: ['BOOLEAN'], value: 0 },
    { spec: [['auto']], value: 'other' },
    { spec: ['IMAGE'], value: 'auto' },
    { spec: ['STRING', { forceInput: true }], value: 'auto' },
    { spec: [['auto'], { multiselect: true }], value: 'auto' },
    { spec: ['STRING', { image_upload: true }], value: 'auto' },
    { spec: ['STRING', { audio_upload: true }], value: 'auto' },
    { spec: ['STRING', { video_upload: true }], value: 'auto' },
    ...['image', 'reference_video', 'audio', 'mask', 'filename', 'model', 'checkpoint', 'lora', 'vae', 'output_path'].map(name =>
      ({ name, spec: ['STRING'], value: 'auto' })),
    { spec: undefined, value: 'auto' },
  ];
  for (const variant of variants) {
    const name = variant.name || 'extra';
    const h = await additionHarness({ specification: { required: { seed: ['INT'], ...(variant.spec ? { [name]: variant.spec } : {}) } },
      inputs: { seed: 4, [name]: variant.value } });
    const result = await h.attempt();
    assert(result.error, name); assert.equal(result.result.review, undefined, name); assert.deepEqual(copy(h.current()), document());
  }
});

test('false and zero scalar additions remain typed values through explicit acceptance', async () => {
  const h = await additionHarness({ specification: { required: { seed: ['INT'], enabled: ['BOOLEAN'], count: ['INT'] } },
    inputs: { seed: 4, enabled: false, count: 0 } });
  const first = await h.attempt();
  assert.deepEqual(first.result.review.added_inputs.map(item => item.value), [false, 0]);
  const accepted = await h.attempt(acceptReview(first.result.review));
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.result.output[1].inputs.enabled, false); assert.equal(accepted.result.output[1].inputs.count, 0);
});

test('review limits reject large addition sets and unavailable secure randomness', async () => {
  const specification = { required: { seed: ['INT'] } }, inputs = { seed: 4 };
  for (let index = 0; index < 65; index++) { specification.required[`extra${index}`] = ['INT']; inputs[`extra${index}`] = index; }
  const tooMany = await additionHarness({ specification, inputs });
  assert.equal((await tooMany.attempt()).result.review, undefined);
  const noCrypto = await additionHarness(); delete noCrypto.window.crypto;
  assert.equal((await noCrypto.attempt()).result.review, undefined);
});

test('failed rollback never produces a usable addition quote or allows compilation', async () => {
  let failRollback = false;
  const h = await additionHarness({ load: () => { if (failRollback) throw new Error('rollback failure'); } });
  failRollback = true;
  const first = await h.attempt();
  assert(first.error); assert.equal(first.result?.review, undefined);
  h.emit('compile', 'after-failed-rollback'); await h.flush();
  assert(h.replies.at(-1).message.error);
});

test('the SaveVideo nested encoding and legacy UI-hidden codec delta must be approved together', async () => {
  const specification = { required: { seed: ['INT'], format: ['COMFY_DYNAMICCOMBO_V3', { options: [
    { key: 'mp4', inputs: { required: { codec: ['COMFY_DYNAMICCOMBO_V3', { options: [
      { key: 'h264', inputs: { optional: { encoding: [['auto', 're-encode']] } } },
    ] }] } } },
  ] }] }, optional: { codec: [['auto', 'h264', 'av1'], { hidden: true }] } };
  const expected = { 1: { class_type: 'Known', inputs: { seed: 4, format: 'mp4', 'format.codec': 'h264' } } };
  const h = await additionHarness({ specification, expected,
    inputs: { ...expected[1].inputs, 'format.codec.encoding': 'auto', codec: 'auto' } });
  const first = await h.attempt();
  assert.deepEqual(first.result.review.added_inputs.map(item => item.input), ['format.codec.encoding', 'codec']);
  const incomplete = acceptReview(copy(first.result.review)); incomplete.accepted_added_inputs.pop();
  const refused = await h.attempt(incomplete); assert(refused.error);
  const accepted = await h.attempt(acceptReview(refused.result.review));
  assert.equal(accepted.error, undefined); assert.equal(accepted.result.accepted_added_inputs.length, 2);
  assert.equal(accepted.result.output[1].inputs['format.codec'], 'h264');
});

test('ambiguous or malformed dynamic schema and detached node identity do not produce a review', async () => {
  for (const kind of ['duplicate path', 'duplicate branch', 'detached constructor', 'proof too large']) {
    const h = await additionHarness();
    if (kind === 'duplicate path') h.Registered.nodeData.input.optional = { extra: ['STRING'] };
    if (kind === 'duplicate branch') {
      h.Registered.nodeData.input.required.extra = ['COMFY_DYNAMICCOMBO_V3', { options: [
        { key: 'auto', inputs: { required: {} } }, { key: 'auto', inputs: { required: {} } },
      ] }];
    }
    if (kind === 'detached constructor') h.window.LiteGraph.registered_node_types.Known = {};
    if (kind === 'proof too large') h.Registered.nodeData.input.required.extra[1].tooltip = 'x'.repeat(256 * 1024);
    const result = await h.attempt();
    assert(result.error); assert.equal(result.result.review, undefined, kind); assert.deepEqual(copy(h.current()), document());
  }
});

test('a successfully consumed quote cannot authorize a second import even with an identical bootstrap graph', async () => {
  const h = await additionHarness(), first = await h.attempt(), approval = acceptReview(first.result.review);
  assert.equal((await h.attempt(approval)).error, undefined);
  h.emit('load', 'restore-identical', { document: document() }); await h.flush();
  const replay = await h.attempt(approval);
  assert(replay.error); assert.notEqual(replay.result.review.review_id, first.result.review.review_id);
  assert.deepEqual(copy(h.current()), document());
});

async function capacityHarness(count) {
  const h = await widgetHarness();
  h.node.widgets = Array.from({ length: count }, (_, index) => ({ name: `value${index}`, type: 'number', value: index,
    options: { min: 0, max: 10000 } }));
  h.node.inputs = h.node.widgets.map(widget => ({ name: widget.name, type: 'INT', widget: { name: widget.name }, link: null }));
  let scans = 0;
  for (const collection of [h.node.widgets, h.node.inputs]) Object.defineProperty(collection, 'filter', {
    value(...args) { scans++; return Array.prototype.filter.apply(this, args); }, configurable: true,
  });
  const patches = h.node.widgets.map(widget => ({ node_id: '1', widget_name: widget.name, class_type: 'Known',
    expected_value: widget.value, value: widget.value + 1 }));
  return { ...h, patches, scans: () => scans };
}

test('isolated bridge field capacity matches main application shared constant', () => {
  assert.equal(Number(source.match(/const MAX_INTERFACE_FIELDS = (\d+);/)[1]), MAX_INTERFACE_FIELDS);
});

for (const count of [65, 256, 4096]) test(`${count} native widgets compile and patch as one complete indexed batch`, async () => {
  const h = await capacityHarness(count), original = copy(h.app.graph.serialize());
  h.emit('compile', 'before-capacity'); await h.flush();
  assert.equal(h.replies.at(-1).message.result.controls.length, count);
  h.emit('patch', 'capacity-patch', { patches: h.patches }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.error, undefined);
  assert.equal(response.result.applied.length, count); assert.equal(response.result.unsupported.length, 0);
  assert.equal(h.node.widgets[count - 1].value, count);
  assert.equal(h.scans(), 0, 'per-field full widget/input array scans would make large batches quadratic');
  assert.equal(original.nodes[0].widgets_values[count - 1], count - 1);
});

test('4097 native patches reject explicitly before beforeChange or any widget writes', async () => {
  const h = await capacityHarness(4097), original = copy(h.app.graph.serialize());
  h.emit('patch', 'capacity-overflow', { patches: h.patches }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.result.applied.length, 0); assert.equal(response.result.unsupported[0].reason, 'invalid_patches');
  assert.deepEqual(h.app.graph.serialize(), original); assert.deepEqual(h.events, []);
});

test('invalid last patch in 4096 batch rejects every earlier valid patch without mutation', async () => {
  const h = await capacityHarness(4096), original = copy(h.app.graph.serialize());
  h.patches.at(-1).expected_value = -1;
  h.emit('patch', 'last-invalid', { patches: h.patches }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.result.applied.length, 0); assert.equal(response.result.unsupported[0].index, 4095);
  assert.equal(response.result.unsupported[0].reason, 'conflict');
  assert.deepEqual(h.app.graph.serialize(), original); assert.deepEqual(h.events, []);
});

test('last callback failure in 4096 batch rolls back the complete native snapshot', async () => {
  const h = await capacityHarness(4096), original = copy(h.app.graph.serialize());
  h.node.widgets.at(-1).callback = () => { throw new Error('last callback failed'); };
  h.emit('patch', 'last-callback-failed', { patches: h.patches }); await h.flush();
  const response = h.replies.at(-1).message;
  assert.equal(response.result.applied.length, 0); assert.equal(response.result.unsupported.length, 4096);
  assert.equal(response.result.rolled_back, true); assert.deepEqual(h.app.graph.serialize(), original);
});

test('verification rebuilds the widget index after a callback replaces the complete array', async () => {
  const h = await capacityHarness(4096), original = copy(h.app.graph.serialize());
  h.node.widgets.at(-1).callback = () => {
    h.node.widgets = h.node.widgets.map(widget => ({ ...widget, options: { ...widget.options }, callback: undefined })).reverse();
    h.node.widgets[0].value = -1;
  };
  // Rollback is a native load, not an index write into stale replaced widgets.
  const load = h.app.loadGraphData;
  h.app.loadGraphData = async (...args) => {
    h.node.widgets.sort((left, right) => Number(left.name.slice(5)) - Number(right.name.slice(5)));
    return load(...args);
  };
  h.emit('patch', 'replaced-widgets', { patches: h.patches }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.rolled_back, true);
  assert.equal(h.replies.at(-1).message.result.applied.length, 0);
  assert.deepEqual(h.app.graph.serialize(), original);
});

test('native patch byte guard counts UTF8 and rejects an oversized valid scalar batch before writing', async () => {
  const h = await capacityHarness(65);
  h.node.widgets = h.node.widgets.map(widget => ({ ...widget, type: 'text', value: 'original', options: {} }));
  const original = copy(h.app.graph.serialize());
  const patches = h.node.widgets.map(widget => ({ node_id: '1', widget_name: widget.name, class_type: 'Known',
    expected_value: 'original', value: '汉'.repeat(16000) }));
  h.emit('patch', 'utf8-overflow', { patches }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'patch_byte_limit');
  assert.deepEqual(h.app.graph.serialize(), original); assert.deepEqual(h.events, []);
});

test('native patch accepts the exact 2 MiB JSON byte boundary and rejects one byte more atomically', async () => {
  const h = await widgetHarness();
  const patch = { node_id: '1', widget_name: 'prompt', class_type: 'Known', expected_value: 'old', value: '' };
  const overhead = new TextEncoder().encode(JSON.stringify({ patches: [patch] })).length;
  patch.value = 'x'.repeat(2 * 1024 * 1024 - overhead);
  assert.equal(new TextEncoder().encode(JSON.stringify({ patches: [patch] })).length, 2 * 1024 * 1024);
  h.emit('patch', 'exact-bytes', { patches: [patch] }); await h.flush();
  assert.equal(h.replies.at(-1).message.error, undefined);
  assert.equal(h.node.widgets.find(widget => widget.name === 'prompt').value.length, patch.value.length);
  const original = copy(h.app.graph.serialize());
  const next = { ...patch, expected_value: undefined, value: patch.value + 'x' }; delete next.expected_value;
  // Keep the same encoded envelope width so the rejection is exactly one byte over.
  next.expected_value = 'old';
  assert.equal(new TextEncoder().encode(JSON.stringify({ patches: [next] })).length, 2 * 1024 * 1024 + 1);
  h.emit('patch', 'one-byte-over', { patches: [next] }); await h.flush();
  assert.equal(h.replies.at(-1).message.result.unsupported[0].reason, 'patch_byte_limit');
  assert.deepEqual(h.app.graph.serialize(), original);
});


test('schema await cannot overwrite concurrent scalar edits and preserves identical completed edits', async () => {
  for (const concurrent of [6, 8]) {
    const h = await promotedUIHarness();
    const originalFetch = h.window.fetch;
    let calls = 0;
    h.window.fetch = async (...args) => {
      if (++calls === 1) h.leaf.widgets[0].value = concurrent;
      return originalFetch(...args);
    };
    const loads = h.calls.filter(x => x === 'load').length;
    h.emit('patch', 'await-change', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8, expected_value: 4 }] });
    await h.flush();
    const reply = h.replies.at(-1).message;
    assert.equal(h.leaf.widgets[0].value, concurrent);
    assert.equal(h.calls.filter(x => x === 'load').length, loads, 'must not reload an old snapshot over a concurrent value');
    if (concurrent === 6) {
      assert.deepEqual(reply.result.applied, []);
      assert.equal(reply.result.unsupported[0].reason, 'conflict');
      assert.equal(reply.result.unsupported[0].current_value, 6);
    } else assert.equal(reply.error, undefined);
  }
});

test('prewrite hooks cannot cause stale rollback when no requested assignments have occurred', async () => {
  const h = await subgraphHarness();
  const loads = h.calls.filter(x => x === 'load').length;
  h.app.graph.beforeChange = () => { h.leaf.widgets[0].value = 6; };
  h.emit('patch', 'hook-change', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8, expected_value: 4 },
    { node_id: h.path, widget_name: 'mode', value: 'b', expected_value: 'a' }] });
  await h.flush();
  const reply = h.replies.at(-1).message;
  assert.equal(reply.result.unsupported[0].reason, 'conflict');
  assert.deepEqual(reply.result.applied, []);
  assert.deepEqual(h.leaf.widgets.map(w => w.value), [6, 'a']);
  assert.equal(h.calls.filter(x => x === 'load').length, loads);
});


test('rollback snapshot retains an identical edit completed by beforeChange', async () => {
  const h = await subgraphHarness();
  h.app.graph.beforeChange = () => { h.leaf.widgets[0].value = 8; };
  h.leaf.widgets[0].callback = () => { throw new Error('test callback failure'); };
  h.emit('patch', 'same-hook-change', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8, expected_value: 4 },
    { node_id: h.path, widget_name: 'mode', value: 'b', expected_value: 'a' }] });
  await h.flush();
  const reply = h.replies.at(-1).message;
  assert.equal(reply.result.rolled_back, true);
  assert.deepEqual(reply.result.applied, []);
  assert.deepEqual(h.leaf.widgets.map(w => w.value), [8, 'a']);
});


test('serialization cannot create a stale rollback baseline for a changed target', async () => {
  for (const duringSnapshot of [6, 8]) {
    const h = await subgraphHarness();
    let transaction = false;
    h.app.graph.beforeChange = () => { transaction = true; };
    h.app.graph.serialize = () => {
      const previous = h.serialize();
      if (transaction) { transaction = false; h.leaf.widgets[0].value = duringSnapshot; }
      return previous;
    };
    const loads = h.calls.filter(x => x === 'load').length;
    h.emit('patch', 'snapshot-change', { patches: [{ node_id: h.path, widget_name: 'fps', value: 8, expected_value: 4 }] });
    await h.flush();
    const reply = h.replies.at(-1).message;
    assert.equal(reply.result.unsupported[0].reason, 'conflict');
    assert.deepEqual(reply.result.applied, []);
    assert.equal(h.leaf.widgets[0].value, duringSnapshot);
    assert.equal(h.calls.filter(x => x === 'load').length, loads);
  }
});
