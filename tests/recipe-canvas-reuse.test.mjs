import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createNode, recipeGraph, generationPayload } from '../web/graph.mjs';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const backend = 'http://127.0.0.1:8188', other = 'http://127.0.0.1:8189';
function harness() {
  const job = { id: 'owned-job', kind: 'sdxl_i2i', backend, status: 'completed' };
  const recipe = { request: { kind: job.kind, positive: 'saved prompt', width: 512, height: 512, steps: 8,
    seed: 123, references: ['reference.png'], denoise: .4 }, warnings: ['saved warning'] };
  const state = { calls: [], notes: [], installed: [], tabs: [], centers: [], mutations: 0, renders: 0, saves: 0, before: null };
  const original = { ...createNode('prompt', 0, 0, { text: 'keep user edits' }), id: 'original' };
  const context = vm.createContext({
    graph: { nodes: [original], edges: [] }, canvasIdentity: 'canvas-original', jobNodes: { earlier: original.id }, projectTitle: 'Original',
    expandedInputs: new Set(), savedPortViews: () => [],
    selected: new Set([original.id]), selectedEdge: null, jobs: [job], reusing: new Set(), document: { body: { dataset: { workspace: 'canvas' } } },
    ensureCanvasIdentity: () => context.canvasIdentity, currentCanvasIdentity: () => context.canvasIdentity,
    singleSelected: () => context.selected.size === 1 ? context.graph.nodes.find(node => context.selected.has(node.id)) : null,
    getNode: id => context.graph.nodes.find(node => node.id === id), recipeGraph: value => { state.installed.push(value); return recipeGraph(value); },
    canvas: { clientWidth: 1000, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    viewPoint: (x, y) => ({ x, y }), nodeSize: () => ({ width: 300 }), placementSize: () => ({ height: 200 }), placeNewNodes() {},
    mutate: callback => { state.mutations++; callback(); }, centerOnNode: node => state.centers.push(node.id), switchTab: tab => state.tabs.push(tab),
    save: () => { state.saves++; }, renderJobs: () => { state.renders++; }, toast: text => state.notes.push(text),
    api: async path => { state.calls.push(path); await state.before?.(); return recipe; },
  });
  vm.runInContext(section('function snapshot(', 'function snapshotChanged(') +
    section('function installRecipe(', 'async function retryJob('), context);
  return { context, state, job, recipe, run: () => context.reuseJob(job.id) };
}

const changes = [
  ['canvas identity', h => { h.context.canvasIdentity = 'new-canvas'; }],
  ['same-ID graph replacement', h => { h.context.graph = structuredClone(h.context.graph); }],
  ['node edit', h => { h.context.graph.nodes[0].data.text = 'new edit'; }],
  ['node selection', h => { h.context.selected.clear(); }],
  ['edge selection', h => { h.context.selectedEdge = 'selected-edge'; }],
  ['project title', h => { h.context.projectTitle = 'new title'; }],
  ['job mapping', h => { h.context.jobNodes.later = 'original'; }],
  ['workspace navigation', h => { h.context.document.body.dataset.workspace = 'img2img'; }],
  ['source removed', h => { h.context.jobs = []; }],
  ['source backend in place', h => { h.job.backend = other; }],
  ['source kind in place', h => { h.job.kind = 'h3_i2v'; }],
  ['source ID in place', h => { h.job.id = 'different'; }],
];
for (const [name, change] of changes) test(`queue recipe cannot install after ${name} during fetch`, async () => {
  const h = harness(); let expected;
  h.state.before = () => { change(h); expected = h.context.snapshot(); };
  await assert.rejects(h.run(), /变化/);
  assert.equal(h.context.snapshot(), expected);
  assert.equal(h.state.installed.length, 0); assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.tabs, []);
  assert.equal(h.context.reusing.size, 0); assert.equal(h.state.calls.length, 1);
});

test('old server recipe without backend retains the original input owner and never submits generation', async () => {
  const h = harness(); await h.run();
  const reference = h.context.graph.nodes.find(node => node.type === 'reference');
  const generation = h.context.graph.nodes.find(node => node.type === 'generation');
  assert.equal(reference.data.uploadBackend, backend); assert.equal(reference.data.name, 'reference.png');
  assert.equal(generationPayload(h.context.graph, generation.id).seed, 123);
  assert.equal(h.state.installed[0].backend, backend); assert.equal(h.recipe.backend, undefined, 'do not mutate server receipt');
  assert.equal(h.state.mutations, 1); assert.equal(h.context.reusing.size, 0);
  assert.deepEqual(h.state.calls, ['/api/jobs/owned-job/recipe']); assert.deepEqual(h.state.tabs, ['properties']);
});

test('normal polling can replace the job object and update progress without rejecting its stable identity', async () => {
  const h = harness(); h.state.before = () => { h.context.jobs = [{ ...h.job, status: 'running', progress: 40 }]; };
  await h.run(); assert.equal(h.state.mutations, 1);
});

for (const key of ['job_id', 'backend']) test(`foreign ${key} receipt cannot install a queue recipe`, async () => {
  const h = harness(); h.recipe[key] = key === 'backend' ? other : 'foreign';
  await assert.rejects(h.run(), /身份|后端|任务/); assert.equal(h.state.installed.length, 0); assert.equal(h.context.reusing.size, 0);
});

test('source no longer in the queue fails before any fetch', async () => {
  const h = harness(); h.context.jobs = [];
  await assert.rejects(h.run(), /任务/); assert.deepEqual(h.state.calls, []); assert.equal(h.context.reusing.size, 0);
});

test('duplicate clicks share one fetch and lock is released after rejection for an explicit retry', async () => {
  const h = harness(); let release;
  h.state.before = () => new Promise(resolve => { release = resolve; });
  const first = h.run(); await h.run(); assert.equal(h.state.calls.length, 1);
  h.context.selected.clear(); release(); await assert.rejects(first, /变化/);
  h.state.before = null; await h.run(); assert.equal(h.state.calls.length, 2); assert.equal(h.state.mutations, 1);
});

test('fetch and capacity failures both release the queue lock without changing the canvas or selected tab', async () => {
  for (const failure of ['fetch', 'capacity']) {
    const h = harness(); if (failure === 'fetch') h.state.before = () => { throw new Error('offline'); };
    else h.context.graph.nodes = Array.from({ length: 500 }, (_, index) => ({ ...createNode('prompt', 0, 0), id: `n-${index}` }));
    const before = h.context.snapshot(); await assert.rejects(h.run(), /offline|已满/);
    assert.equal(h.context.snapshot(), before); assert.equal(h.state.mutations, 0); assert.deepEqual(h.state.tabs, []);
    assert.equal(h.context.reusing.size, 0);
  }
});
