import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect, serializeGraph } from '../web/graph.mjs';
import { createWorkflowCanvas, prepareCanvasConnection, prepareCanvasExecution } from '../web/workflow-canvas.mjs';

const backend = 'http://127.0.0.1:8188', otherBackend = 'http://127.0.0.1:8189';
const packageId = `p-${'a'.repeat(24)}`;
const fullDefinition = () => ({ id: packageId, name: '归档仍可使用', archived: true, fields: [
  { id: 'text', node_id: '1', input: 'text', label: '画面提示词', type: 'text', default: 'own' },
  { id: 'image', node_id: '3', input: 'image', label: '未启用人物参考', type: 'image', default: '' },
], prompt: { '1': { class_type: 'TextNode', inputs: { text: 'own' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
  '3': { class_type: 'LoadImage', inputs: { image: '' } }, '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } } } });

function fixture() {
  const full = fullDefinition();
  const prompt = createNode('prompt', 0, 0, { text: 'source text' });
  const target = createNode('generation', 400, 0, { kind: 'package', package_id: packageId,
    packageFields: full.fields.map(({ id, type, label }) => ({ id, type, label })), packageValues: { text: 'own', image: '' }, editor_outputs: ['2'] });
  const inactive = createNode('generation', 0, 300, { kind: 'package', package_id: '', packageFields: [] });
  const state = { graph: { nodes: [prompt, target, inactive], edges: [] }, identity: 'canvas-one', backend, details: [], calls: [], remembered: [], downloads: [], errors: [], installed: null };
  const host = { graph: () => state.graph, canvasIdentity: () => state.identity, engine: () => ({ backend_url: state.backend, online: true }),
    packages: () => Array.from({ length: 200 }, (_, index) => ({ id: index ? `p-${String(index).padStart(24, '0')}` : packageId, name: '摘要', summary: true, field_count: 4096 })),
    loadPackages: async () => { state.refreshed = (state.refreshed || 0) + 1; },
    async ensurePackageDefinition(id) { state.details.push(id); if (state.onDetail) await state.onDetail(); assert.equal(id, packageId); return structuredClone(state.full || full); },
    rememberPackageDefinition: definition => { state.remembered.push(structuredClone(definition)); },
    prepareInputs: async (_ids, options) => { state.prepared = options; return options.graph; },
    async api(path, body) {
      state.calls.push({ path, body: structuredClone(body) });
      if (state.onApi) { const result = await state.onApi(path, body); if (result !== undefined) return result; }
      if (path === '/api/execution-plan') return { backend_url: backend, package_id: packageId,
        execution: { selected_outputs: ['2'], node_ids: ['1', '2'], active_field_ids: ['text'] } };
      if (path.endsWith('/export')) return { document: structuredClone(full), source_json: JSON.stringify(full) };
      if (path === '/api/packages/inspect') return { prompt: structuredClone(full.prompt), fields: structuredClone(full.fields) };
      if (path === '/api/packages') return { package: structuredClone(full) };
      assert.fail(`unexpected route ${path}`);
    }, viewport: () => ({ x: 0, y: 0, scale: 1 }), title: () => '完整画布', toast() {},
    downloadJSON: (...args) => state.downloads.push(args), reportError: error => state.errors.push(error),
    connect: (...args) => connect(state.graph, ...args), setGraph: (...args) => { state.installed = args; } };
  return { state, host, full, prompt, target, inactive };
}

test('creating the canvas controller does not refresh or hydrate any of 200 summaries', () => {
  const h = fixture(); createWorkflowCanvas(h.host);
  assert.deepEqual(h.state.details, []); assert.equal(h.state.refreshed, undefined); assert.deepEqual(h.state.calls, []);
});

test('connection retrieves only the archived target definition, never trusts summary fields', async () => {
  const h = fixture(), original = serializeGraph(h.state.graph);
  const prepared = await prepareCanvasConnection(h.host, h.target.id);
  assert.deepEqual(h.state.details, [packageId]); assert.equal(h.state.refreshed, undefined);
  assert.deepEqual(prepared.fields.map(field => field.id), ['text', 'image']);
  assert.equal(prepared.fields[0].node_id, '1'); assert.equal(serializeGraph(h.state.graph), original);
});

test('404 details and an unloaded summary never erase cached ports or create a fixed-input shortcut', async () => {
  for (const result of ['404', 'summary', 'new-field', 'wrong-type', 'wrong-binding']) {
    const h = fixture();
    if (result === '404') h.state.onDetail = () => { throw new Error('工作流包未在本机安装'); };
    if (result === 'summary') h.state.full = { ...h.full, summary: true };
    if (result === 'new-field') h.state.full = { ...h.full, fields: [...h.full.fields, { id: 'new', type: 'text', label: '新增' }] };
    if (result === 'wrong-type') h.state.full = { ...h.full, fields: h.full.fields.map(field => ({ ...field, type: 'number' })) };
    if (result === 'wrong-binding') h.target.data.packageFields[0] = { ...h.target.data.packageFields[0], node_id: 'different', input: 'different' };
    const original = serializeGraph(h.state.graph);
    await assert.rejects(prepareCanvasConnection(h.host, h.target.id), /未在本机|摘要|映射不一致/);
    assert.equal(serializeGraph(h.state.graph), original);
  }
});

const changes = [
  ['canvas identity', h => { h.state.identity = 'other-canvas'; }],
  ['target value', h => { h.target.data.packageValues.text = 'changed'; }],
  ['target object', h => { h.state.graph.nodes[1] = structuredClone(h.target); }],
  ['backend', h => { h.state.backend = otherBackend; }],
  ['package', h => { h.target.data.package_id = `p-${'b'.repeat(24)}`; }],
];
for (const [name, change] of changes) test(`a slow connection detail rejects a changed ${name}`, async () => {
  const h = fixture(); let release; h.state.onDetail = () => new Promise(resolve => { release = resolve; });
  const opening = prepareCanvasConnection(h.host, h.target.id);
  change(h); const edited = serializeGraph(h.state.graph); release();
  await assert.rejects(opening, /已变化/); assert.equal(serializeGraph(h.state.graph), edited);
});

test('an open connection guard still refuses changes before the final connect action', async () => {
  const h = fixture(), prepared = await prepareCanvasConnection(h.host, h.target.id);
  prepared.assertCurrent(); h.target.data.title = 'new title';
  assert.throws(prepared.assertCurrent, /已变化/); assert.deepEqual(h.state.graph.edges, []);
});

test('run planning precedes detail hydration and does not fetch an invalid inactive upstream', async () => {
  const h = fixture();
  connect(h.state.graph, h.prompt.id, h.target.id, { targetField: 'text' });
  h.state.graph.edges.push({ id: 'inactive', source: h.inactive.id, target: h.target.id, targetField: 'image', sourceField: 'image' });
  h.state.onDetail = () => { assert.equal(h.state.calls.length, 1); assert.equal(h.state.calls[0].path, '/api/execution-plan'); };
  const before = serializeGraph(h.state.graph), prepared = await prepareCanvasExecution(h.host, [h.target.id]);
  assert.deepEqual(h.state.details, [packageId]); assert.equal(h.state.refreshed, undefined);
  assert.deepEqual(h.state.prepared.projection.edges.map(edge => edge.targetField), ['text']);
  assert.equal(prepared.graph.nodes.length, 3); assert.equal(prepared.graph.edges.length, 2);
  assert.equal(serializeGraph(h.state.graph), before);
});

for (const [name, change] of changes.filter(([name]) => name !== 'target object')) test(`a slow run detail rejects a changed ${name} before media preparation`, async () => {
  const h = fixture(); h.state.onDetail = () => change(h);
  await assert.rejects(prepareCanvasExecution(h.host, [h.target.id]), /已变化/);
  assert.equal(h.state.prepared, undefined); assert.deepEqual(h.state.calls.map(call => call.path), ['/api/execution-plan']);
});

test('run definition errors and explicit old binding mismatches stop before media work', async () => {
  for (const mode of ['404', 'summary', 'type', 'binding', 'node', 'missing-field']) {
    const h = fixture(), fields = structuredClone(h.full.fields);
    if (mode === '404') h.state.onDetail = () => { throw new Error('package 404'); };
    if (mode === 'summary') h.state.full = { ...h.full, summary: true };
    if (mode === 'type') { fields[0].type = 'integer'; h.state.full = { ...h.full, fields }; }
    if (mode === 'binding') h.target.data.packageFields[0].input = 'different';
    if (mode === 'node') h.state.full = { ...h.full, prompt: { '1': h.full.prompt['1'] } };
    if (mode === 'missing-field') h.state.full = { ...h.full, fields: [fields[1]] };
    const before = serializeGraph(h.state.graph);
    await assert.rejects(prepareCanvasExecution(h.host, [h.target.id]), /404|摘要|不一致/);
    assert.equal(h.state.prepared, undefined); assert.equal(serializeGraph(h.state.graph), before);
  }
});

test('a legitimately zero-field package has a full definition and can run; an unconfigured native cannot', async () => {
  const h = fixture(); h.target.data.packageFields = []; h.target.data.packageValues = {};
  h.state.full = { ...h.full, fields: [] };
  h.state.onApi = path => path === '/api/execution-plan' ? { backend_url: backend, package_id: packageId,
    execution: { selected_outputs: ['2'], node_ids: ['1', '2'], active_field_ids: [] } } : undefined;
  await prepareCanvasExecution(h.host, [h.target.id]); assert.deepEqual(h.state.details, [packageId]);
  h.target.data.package_id = ''; h.state.details = []; h.state.calls = [];
  await assert.rejects(prepareCanvasExecution(h.host, [h.target.id]), /尚未建立外层参数/);
  assert.deepEqual(h.state.details, []); assert.deepEqual(h.state.calls, []);
});

test('configuration export reads only referenced raw definitions without summary refresh or detail hydration', async () => {
  const h = fixture(); const controller = createWorkflowCanvas(h.host);
  connect(h.state.graph, h.prompt.id, h.target.id, { targetField: 'text' });
  const before = serializeGraph(h.state.graph), bundle = await controller.buildBundle(h.target.id);
  assert.deepEqual(h.state.calls.map(call => call.path), [`/api/packages/${packageId}/export`]);
  assert.equal(h.state.refreshed, undefined); assert.deepEqual(h.state.details, []);
  assert.equal(bundle.packages[0].source_json, JSON.stringify(h.full)); assert.equal(bundle.canvas.nodes.length, 2);
  assert.equal(serializeGraph(h.state.graph), before);
});

test('slow export rejects canvas/backend changes and never downloads an inconsistent bundle', async () => {
  for (const change of [h => { h.state.identity = 'other'; }, h => { h.target.data.title = 'changed'; }, h => { h.state.backend = otherBackend; }]) {
    const h = fixture(); h.state.onApi = path => { if (path.endsWith('/export')) change(h); };
    await assert.rejects(createWorkflowCanvas(h.host).exportBundle(), /已变化/); assert.deepEqual(h.state.downloads, []);
  }
});

function importFile(h) {
  const bundle = { schema: 'prismcanvas.project.v1', version: 1, name: 'Imported', canvas: JSON.parse(serializeGraph({ nodes: [h.target], edges: [] })),
    packages: [{ id: packageId, source_json: JSON.stringify(h.full) }] };
  const text = JSON.stringify(bundle); return { size: new TextEncoder().encode(text).length, name: 'bundle.json', text: async () => text };
}

test('import stores the full POST definition in the cache and keeps all fields after summary refresh', async () => {
  const h = fixture(), before = serializeGraph(h.state.graph); await createWorkflowCanvas(h.host).importBundle(importFile(h));
  assert.deepEqual(h.state.calls.map(call => call.path), ['/api/packages/inspect', '/api/packages']);
  assert.deepEqual(h.state.details, []); assert.deepEqual(h.state.remembered, [h.full]); assert.equal(h.state.refreshed, 1);
  assert.deepEqual(h.state.installed[0].nodes[0].data.packageFields, h.target.data.packageFields);
  assert.equal(serializeGraph(h.state.graph), before);
});

test('slow import and incomplete POST replies never replace the current canvas', async () => {
  for (const mode of ['canvas', 'backend', 'incomplete']) {
    const h = fixture(); h.state.onApi = path => {
      if (path !== '/api/packages') return;
      if (mode === 'canvas') h.state.identity = 'new-canvas';
      if (mode === 'backend') h.state.backend = otherBackend;
      if (mode === 'incomplete') return { package: { id: packageId, name: 'summary', summary: true } };
    };
    await assert.rejects(createWorkflowCanvas(h.host).importBundle(importFile(h)), /未替换|完整定义/);
    assert.equal(h.state.installed, null); assert.deepEqual(h.state.remembered, []);
  }
});

class ConnectionElement {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = new Map(); this._value = ''; }
  append(...items) { for (const item of items) { this.children.push(item); item.parent = this; } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute() {}
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  get options() { return this.children.filter(child => child.tagName === 'option'); }
  get value() { return this._value || this.options[0]?.value || ''; }
  set value(value) { this._value = value; }
  showModal() { this.open = true; }
  close() { this.open = false; for (const callback of this.listeners.get('close') || []) callback(); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  click() { for (const callback of this.listeners.get('click') || []) callback({ stopPropagation() {} }); }
}
async function connectionDOM(action) {
  const previous = globalThis.document, elements = [], body = new ConnectionElement('body');
  globalThis.document = { body, createElement(tag) { const element = new ConnectionElement(tag); elements.push(element); return element; } };
  try { await action(id => elements.find(element => element.id === id), body); }
  finally { globalThis.document = previous; }
}

test('actual connection submit uses fetched fields and refuses a target change after the dialog opens', async () => {
  await connectionDOM(async find => {
    const h = fixture(), controller = createWorkflowCanvas(h.host);
    await controller.connectNodes(h.prompt.id, h.target.id, 'text');
    assert.deepEqual(h.state.details, [packageId]); assert.equal(find('workflow-connect-field').value, 'text');
    h.target.data.packageValues.text = 'a later edit'; find('workflow-connect-submit').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.state.graph.edges, []); assert.match(h.state.errors[0].message, /已变化/);
  });
});

test('actual connection submit connects one chosen input without any summary refresh', async () => {
  await connectionDOM(async find => {
    const h = fixture(), controller = createWorkflowCanvas(h.host);
    await controller.connectNodes(h.prompt.id, h.target.id, 'text');
    find('workflow-connect-submit').click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.state.graph.edges.length, 1); assert.equal(h.state.graph.edges[0].targetField, 'text');
    assert.equal(h.state.refreshed, undefined); assert.deepEqual(h.state.errors, []);
  });
});
