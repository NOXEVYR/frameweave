import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../web/native-editor-bridge.js', import.meta.url), 'utf8')).replace("import { app } from '/scripts/app.js';", '');
const copy = value => JSON.parse(JSON.stringify(value));
const document = () => ({ nodes: [{ id: 1, type: 'Known', mode: 4, widgets_values: { seed: 8 } }], links: [], extra: { ue_links: [1] } });
function harness(options = {}) {
  const replies = [], calls = [], timers = [];
  let listener, extension, current = document();
  const app = {
    graph: { serialize: () => current },
    registerExtension: value => { extension = value; },
    async loadGraphData(value) { calls.push('load'); if (options.load) await options.load(value); current = value; },
    async graphToPrompt() { calls.push('compile'); return { workflow: current, output: { 1: { class_type: 'Known', inputs: {} } } }; },
  };
  const parent = { postMessage: (message, origin) => replies.push({ message: copy(message), origin }) };
  const window = { parent, __PRISM_EDITOR__: { parentOrigin: 'http://127.0.0.1:8766', bridgeNonce: 'private-session' }, LiteGraph: { registered_node_types: { Known: {} } }, addEventListener: (_name, callback) => { listener = callback; }, setTimeout: callback => timers.push(callback) };
  vm.runInNewContext(source, { app, window, setTimeout });
  const emit = (action, requestId, data = {}, overrides = {}) => listener({ source: parent, origin: window.__PRISM_EDITOR__.parentOrigin, data: { source: 'prism-parent', nonce: 'private-session', action, requestId, ...data }, ...overrides });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const start = () => { extension.setup(); while (timers.length) timers.shift()(); };
  return { app, window, parent, replies, calls, emit, flush, start, current: () => current };
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

test('compile maps only direct matching writable scalar widgets, never connected or nested inputs', async () => {
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
  assert.deepEqual(result.unmapped.map(item => item.reason), ['connected_input', 'widget_not_found', 'nested_node_not_supported']);
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
