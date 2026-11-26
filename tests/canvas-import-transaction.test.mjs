import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, serializeGraph, generationPayload } from '../web/graph.mjs';
import { createWorkflowCanvas } from '../web/workflow-canvas.mjs';

const backend = 'http://127.0.0.1:8188', packageId = `p-${'a'.repeat(24)}`;
function fixture(phase = '') {
  const fields = [{ id: 'neg', node_id: '1', input: 'text', type: 'text', label: '负向', default: 'OWN' }];
  const pack = { id: packageId, name: 'Imported package', fields, prompt: { '1': { class_type: 'Text', inputs: { text: 'OWN' } } } };
  const prompt = { ...createNode('prompt', 0, 0, { text: 'SOURCE', negative: 'NEG' }), id: 'source' };
  const target = { ...createNode('generation', 200, 0, { kind: 'package', package_id: packageId, packageFields: fields,
    packageValues: { neg: 'OWN' }, packageTextCompositions: { neg: 'comma' } }), id: 'target' };
  const incoming = { nodes: [prompt, target], edges: [
    { id: 'first', source: prompt.id, target: target.id, targetField: 'neg', sourceField: 'negative' },
    { id: 'second', source: prompt.id, target: target.id, targetField: 'neg', sourceField: 'negative', sourceOccurrence: 1 },
  ] };
  const document = { schema: 'prismcanvas.project.v1', version: 1, name: 'Imported',
    canvas: JSON.parse(serializeGraph(incoming, { x: 9, y: 8, scale: 1 })), packages: [{ id: packageId, source_json: JSON.stringify(pack) }] };
  const source = JSON.stringify(document);
  const state = { graph: { nodes: [createNode('prompt', 0, 0, { text: 'original' })], edges: [] }, identity: 'old-canvas', backend,
    viewport: { x: 1, y: 2, scale: 1 }, title: 'Original', calls: [], created: [], remembered: [], installed: [] };
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gate = async stage => {
    if (stage === phase) { reached(); await new Promise(resolve => { release = resolve; }); }
  };
  const host = { graph: () => state.graph, canvasIdentity: () => state.identity, engine: () => ({ backend_url: state.backend }),
    viewport: () => state.viewport, title: () => state.title,
    async api(path) {
      state.calls.push(path);
      if (path === '/api/packages/inspect') { await gate('inspect'); return { prompt: pack.prompt, fields }; }
      if (path === '/api/packages') { state.created.push(structuredClone(pack)); await gate('store'); return { package: pack }; }
      throw new Error(`unexpected mutation ${path}`);
    }, rememberPackageDefinition: value => state.remembered.push(structuredClone(value)), loadPackages: () => gate('catalog'), toast() {},
    setGraph: (graph, title) => { state.installed.push({ graph, title }); state.graph = graph; state.viewport = graph.viewport; state.title = title; state.identity = 'new-canvas'; } };
  const file = { name: 'bundle.json', size: new TextEncoder().encode(source).length, text: async () => { await gate('read'); return source; } };
  return { state, file, waiting, release: () => release(), controller: createWorkflowCanvas(host) };
}

const changes = [
  ['title', state => { state.title = 'USER TITLE'; }],
  ['viewport value', state => { state.viewport.x = 77; state.viewport.scale = 2; }],
  ['viewport replacement', state => { state.viewport = { x: 88, y: 99, scale: 2 }; }],
  ['node value', state => { state.graph.nodes[0].data.text = 'USER EDIT'; }],
  ['graph object', state => { state.graph = structuredClone(state.graph); }],
  ['canvas identity', state => { state.identity = 'USER CANVAS'; }],
  ['backend', state => { state.backend = 'http://127.0.0.1:8189'; }],
];
for (const phase of ['inspect', 'store', 'catalog']) for (const [name, change] of changes) {
  test(`actual collection controller refuses ${name} changed during ${phase} await`, async () => {
    const h = fixture(phase), importing = h.controller.importBundle(h.file);
    await h.waiting; change(h.state);
    const edited = { graph: serializeGraph(h.state.graph, h.state.viewport), title: h.state.title, identity: h.state.identity, backend: h.state.backend };
    h.release(); await assert.rejects(importing, /导入期间.*已变化/);
    assert.deepEqual(h.state.installed, []);
    assert.equal(serializeGraph(h.state.graph, h.state.viewport), edited.graph); assert.equal(h.state.title, edited.title);
    assert.equal(h.state.identity, edited.identity); assert.equal(h.state.backend, edited.backend);
    assert.equal(h.state.created.length, phase === 'inspect' ? 0 : 1, 'already stored definitions are preserved; no rollback deletes');
    assert.equal(h.controller.isRunning(), false, 'failed transaction releases its operation lock');
    assert(h.state.calls.every(path => ['/api/packages/inspect', '/api/packages'].includes(path)), 'no generation, upload, draft or deletion side effect');
  });
}

test('unchanged collection imports exact repeated text identity and v2 graph', async () => {
  const h = fixture(); await h.controller.importBundle(h.file);
  assert.equal(h.state.installed.length, 1); assert.equal(h.state.created.length, 1); assert.equal(h.state.title, 'Imported');
  assert.equal(h.state.graph.edges.find(edge => edge.id === 'second').sourceOccurrence, 1);
  assert.equal(generationPayload(h.state.graph, 'target').values.neg, 'NEG, NEG, OWN');
  assert.equal(JSON.parse(serializeGraph(h.state.graph)).schema, 'frameweave.canvas.v2');
});

test('hidden collection entry checks actual UTF8 bytes even when declared file size is tiny', async () => {
  const h = fixture(); h.file.size = 1;
  const source = JSON.stringify({ schema: 'prismcanvas.project.v1', version: 1, note: '中'.repeat(9 * 1024 * 1024) });
  h.file.text = async () => source;
  await assert.rejects(h.controller.importBundle(h.file), /24 MiB/); assert.deepEqual(h.state.calls, []); assert.deepEqual(h.state.installed, []);
  assert.equal(h.controller.isRunning(), false);
});

test('collection file read await also protects title and viewport before any package mutation', async () => {
  const h = fixture('read'), importing = h.controller.importBundle(h.file);
  await h.waiting; h.state.title = 'USER TITLE'; h.state.viewport.x = 77; h.release();
  await assert.rejects(importing, /已变化/); assert.equal(h.state.title, 'USER TITLE'); assert.equal(h.state.viewport.x, 77);
  assert.deepEqual(h.state.calls, []); assert.deepEqual(h.state.installed, []);
});
