import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createNode, recipeGraph, generationInputPorts, generationPayload, connect, serializeGraph, parseGraph, validateExecutionMediaBackends } from '../web/graph.mjs';
import { cachedPackageField, visibleInputPorts } from '../web/canvas-port-layout.mjs';
import { createPackageCatalog } from '../web/package-catalog.mjs';
import { studioModeForKind } from '../web/studio-recipes.mjs';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const studio = await readFile(new URL('../web/generation-studio.mjs', import.meta.url), 'utf8');
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const backend = 'http://127.0.0.1:8188', other = 'http://127.0.0.1:8189';
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function harness(entry = 'studio') {
  const values = { text: '原始台词', instruct: '轻声', language: 'Chinese', seed: 123, max_new_tokens: 256, image: 'input/target.png', audio: 'input/voice.wav', video: 'input/motion.mp4' };
  const fields = [['text', 'text', '台词'], ['instruct', 'text', '演绎指导'], ['language', 'select', '语言'], ['seed', 'integer', '种子'], ['max_new_tokens', 'integer', '长度'], ['image', 'image', '画面参考'], ['audio', 'audio', '声音参考'], ['video', 'video', '动作参考']]
    .map(([id, type, label]) => ({ id, type, label, node_id: '1', input: id, ...(id === 'instruct' ? { role: 'instruction', group: '表演' } : {}) }));
  const full = { id: `p-${'a'.repeat(24)}`, name: '通用历史工作流', fields, prompt: { '1': { class_type: 'HistoricalWorkflow', inputs: structuredClone(values) } } };
  const job = { id: 'saved-job', kind: 'package', backend, status: 'completed' };
  const recipe = { job_id: job.id, backend, request: { kind: 'package', package_id: full.id, values } };
  const original = createNode('generation', 20, 40, { kind: 'package', package_id: full.id, packageValues: { user: 'keep edits' }, packageFields: [{ id: 'unrelated-old-cache', type: 'text', label: '旧图接口' }] });
  const state = { calls: [], mutations: 0, opened: [], tabs: [], centers: [], beforeDetail: null, beforeRecipe: null, full, recipe, job };
  const context = vm.createContext({
    graph: { nodes: [original], edges: [] }, selected: new Set([original.id]), selectedEdge: null, canvasIdentity: 'canvas-one',
    viewport: { x: 20, y: 60, scale: 1 }, jobNodes: {}, jobs: [job], reusing: new Set(),
    active: entry === 'queue' ? 'canvas' : 'audio', navigationEpoch: 0, mediaBackendEpoch: 0, activeBackend: backend,
    document: { body: { dataset: { workspace: entry === 'queue' ? 'canvas' : 'audio' } } },
    selectedJobs: {}, drafts: {}, kindDrafts: {}, recipeTransfers: new Set(), studioModeForKind,
    syncAudioBackendContext: () => context.activeBackend, structuredClone, createNode, recipeGraph,
    currentCanvasIdentity: () => context.canvasIdentity,
    snapshot: () => JSON.stringify([context.canvasIdentity, context.graph, [...context.selected], context.selectedEdge, context.viewport]),
    getNode: id => context.graph.nodes.find(node => node.id === id), singleSelected: () => context.graph.nodes.find(node => context.selected.has(node.id)),
    canvas: { clientWidth: 1000, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    viewPoint: (x, y) => ({ x, y }), nodeSize: () => ({ width: 300 }), placementSize: () => ({ height: 440 }), placeNewNodes() {},
    mutate: fn => { state.mutations++; fn(); }, centerOnNode: node => state.centers.push(node.id), switchTab: tab => state.tabs.push(tab),
    save() {}, renderJobs() {}, toast() {}, refresh() {},
    open(mode, node) { state.opened.push({ mode, node }); context.active = mode; context.document.body.dataset.workspace = mode; },
  });
  context.api = async path => {
    state.calls.push(path);
    if (path.endsWith('/recipe')) { await state.beforeRecipe?.(); return state.recipe; }
    if (path.startsWith('/api/packages/')) { await state.beforeDetail?.(); return { package: state.full }; }
    throw new Error(`unexpected API: ${path}`);
  };
  const catalog = createPackageCatalog({ api: context.api });
  context.ensurePackageDefinition = id => catalog.ensure(id);
  vm.runInContext(section(app, 'async function prepareCanvasRecipe(', 'async function retryJob(')
    + section(studio, '  async function reuseRecipe(', '  function resultPanel('), context);
  context.host = { api: context.api, jobs: () => context.jobs, canvasIdentity: context.currentCanvasIdentity,
    canvasSnapshot: context.snapshot, toast() {}, prepareCanvasRecipe: context.prepareCanvasRecipe, addRecipe: context.installRecipe };
  return { context, state, original, full, fields, values, job, recipe, catalog, run: () => entry === 'queue' ? context.reuseJob(job.id) : context.reuseRecipe(job, 'audio_voice', 'canvas') };
}
for (const entry of ['queue', 'studio']) {
  test(`${entry}: complete package interfaces, exact values and original media owners survive connected export/refresh`, async () => {
    const h = harness(entry), beforeOriginal = structuredClone(h.original), beforePackage = structuredClone(h.full), beforeRecipe = structuredClone(h.recipe);
    await h.run(); const node = h.context.graph.nodes.find(item => item !== h.original);
    assert.deepEqual(structuredClone(node.data.packageFields), h.fields.map(cachedPackageField));
    assert.deepEqual(structuredClone(node.data.packageValues), h.values);
    assert.deepEqual(generationInputPorts(node).map(field => field.id), h.fields.map(field => field.id));
    assert.deepEqual(visibleInputPorts(node.data.packageFields, [], true).visible.map(field => field.id), ['text', 'instruct', 'image', 'audio', 'video']);
    for (const id of ['image', 'audio', 'video']) assert.deepEqual(structuredClone(node.data.packageMediaBackends[id]), { name: h.values[id], backend });
    assert.deepEqual(h.original, beforeOriginal); assert.deepEqual(h.full, beforePackage); assert.deepEqual(h.recipe, beforeRecipe);
    assert.deepEqual(h.state.calls, ['/api/jobs/saved-job/recipe', `/api/packages/${h.full.id}`]);
    assert.equal(h.state.mutations, 1); assert.equal(h.context.reusing.size, 0); assert.equal(h.context.recipeTransfers.size, 0);
    if (entry === 'studio') { assert.equal(h.state.opened[0].node, node); assert.equal(h.state.opened[0].mode, 'canvas'); }
    assert.deepEqual(generationPayload(h.context.graph, node.id), h.recipe.request);
    validateExecutionMediaBackends(h.context.graph, [node.id], backend, backend);
    assert.throws(() => validateExecutionMediaBackends(h.context.graph, [node.id], backend, other), /不会.*自动转移/);
    const prompt = createNode('prompt', 0, 0, { text: '连线后的台词' }); h.context.graph.nodes.push(prompt); connect(h.context.graph, prompt.id, node.id, { targetField: 'text' });
    for (const type of ['image', 'audio', 'video']) {
      const ref = createNode('reference', 0, 0, { name: `connected.${type}`, mediaType: type, uploadBackend: backend });
      h.context.graph.nodes.push(ref); connect(h.context.graph, ref.id, node.id, { targetField: type });
    }
    const restored = parseGraph(serializeGraph(h.context.graph));
    const payload = generationPayload(restored, node.id);
    assert.equal(payload.values.text, prompt.data.text); assert.equal(payload.values.instruct, h.values.instruct);
    for (const type of ['image', 'audio', 'video']) assert.equal(payload.values[type], `connected.${type}`);
    assert.deepEqual(restored.nodes.find(item => item.id === node.id).data.packageFields, h.fields.map(cachedPackageField));
    validateExecutionMediaBackends(restored, [node.id], backend, backend);
    assert.throws(() => validateExecutionMediaBackends(restored, [node.id], backend, other), /不会.*自动转移/);
  });
  for (const failure of ['offline', 'wrong-id', 'summary', 'bad-binding', 'duplicate-fields', 'unknown-value']) test(`${entry}: ${failure} complete definition never partially installs or switches page`, async () => {
    const h = harness(entry);
    if (failure === 'offline') h.state.beforeDetail = () => { throw new Error('offline'); };
    if (failure === 'wrong-id') h.full.id = 'foreign-package';
    if (failure === 'summary') h.full.summary = true;
    if (failure === 'bad-binding') h.full.fields[0].input = 'missing-binding';
    if (failure === 'duplicate-fields') h.full.fields.push({ ...h.full.fields[0] });
    if (failure === 'unknown-value') h.values.unknown = 'unrecorded interface';
    const before = h.context.snapshot(), workspace = h.context.document.body.dataset.workspace;
    await assert.rejects(h.run(), /offline|完整|映射|重复|不一致/);
    assert.equal(h.context.snapshot(), before); assert.equal(h.context.document.body.dataset.workspace, workspace);
    assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.opened, []); assert.deepEqual(h.state.tabs, []);
    assert.equal(h.context.reusing.size, 0); assert.equal(h.context.recipeTransfers.size, 0);
  });
  for (const change of ['canvas-id', 'same-id-graph', 'edit', 'selection', 'page', 'source-backend', 'source-removed']) test(`${entry}: ${change} during package detail fetch preserves current state`, async () => {
    const h = harness(entry); let expected;
    h.state.beforeDetail = () => {
      if (change === 'canvas-id') h.context.canvasIdentity = 'other-canvas';
      if (change === 'same-id-graph') h.context.graph = structuredClone(h.context.graph);
      if (change === 'edit') h.original.data.packageValues.user = 'new user edit';
      if (change === 'selection') h.context.selected.clear();
      if (change === 'page') { h.context.active = 'video'; h.context.navigationEpoch++; h.context.document.body.dataset.workspace = 'video'; }
      if (change === 'source-backend') h.job.backend = other;
      if (change === 'source-removed') h.context.jobs = [];
      expected = h.context.snapshot();
    };
    await assert.rejects(h.run(), /变化/);
    assert.equal(h.context.snapshot(), expected); assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.opened, []);
    assert.equal(h.context.reusing.size, 0); assert.equal(h.context.recipeTransfers.size, 0);
  });
  test(`${entry}: package detail retains duplicate-click lock and failed read permits explicit retry`, async () => {
    const h = harness(entry), gate = defer(); h.state.beforeDetail = () => gate.promise;
    const first = h.run(); await new Promise(resolve => setImmediate(resolve)); await h.run();
    assert.equal(h.state.calls.length, 2); h.context.selected.clear(); gate.resolve(); await assert.rejects(first, /变化/);
    h.state.beforeDetail = null; await h.run(); assert.equal(h.state.mutations, 1);
  });
  test(`${entry}: missing historical package keeps pure API fallback without inventing interfaces or fetching a package`, async () => {
    const h = harness(entry); h.state.recipe = { backend, job_id: h.job.id, request: { kind: 'api', prompt: h.full.prompt } };
    await h.run(); const node = h.context.graph.nodes.find(item => item !== h.original);
    assert.equal(node.data.kind, 'api'); assert.deepEqual(generationInputPorts(node), []);
    assert.deepEqual(generationPayload(h.context.graph, node.id), h.state.recipe.request); assert.deepEqual(h.state.calls, ['/api/jobs/saved-job/recipe']);
  });
}
test('package recipe rejects unsafe media or unknown owner before creating any fragment', () => {
  const h = harness();
  for (const name of ['../voice.wav', 'C:/private/voice.wav', '/absolute/voice.wav']) {
    assert.throws(() => recipeGraph({ ...h.recipe, request: { ...h.recipe.request, values: { ...h.values, audio: name } }, packageDefinition: h.full }), /相对名称|路径|文件/);
  }
  assert.throws(() => recipeGraph({ ...h.recipe, backend: undefined, packageDefinition: h.full }), /来源引擎/);
});
test('presentation controls stay hidden and empty media inputs do not invent ownership, values or previews', () => {
  const h = harness(); h.full.fields.find(field => field.id === 'instruct').presentation = 'control';
  const values = { text: h.values.text, instruct: h.values.instruct, audio: '' };
  const fragment = recipeGraph({ request: { ...h.recipe.request, values }, packageDefinition: h.full });
  const node = fragment.nodes[0];
  assert.deepEqual(node.data.packageValues, values); assert.deepEqual(node.data.packageMediaBackends, {});
  assert.deepEqual(visibleInputPorts(node.data.packageFields, [], true).visible.map(field => field.id), ['text', 'image', 'audio', 'video']);
});
