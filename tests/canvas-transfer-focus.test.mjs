import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createNode, recipeGraph, connect } from '../web/graph.mjs';
import { canvasContentArea, placeFragment } from '../web/canvas-layout.mjs';
import { STUDIO_MODES } from '../web/studio-state.mjs';
import { studioModeForKind } from '../web/studio-recipes.mjs';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const studio = await readFile(new URL('../web/generation-studio.mjs', import.meta.url), 'utf8');
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const rect = (width, height) => ({ left: 166, top: 124, width, height, right: 166 + width, bottom: 124 + height });
class Element {
  constructor(tag, className = '', text = '') { this.tagName = tag.toUpperCase(); this.className = className; this.textContent = text; this.dataset = {}; this.children = []; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  querySelector(selector) { return this.children.find(item => selector.startsWith('.') && item.className.split(' ').includes(selector.slice(1))) || this.children.map(item => item.querySelector(selector)).find(Boolean) || null; }
  querySelectorAll() { return []; }
}
function harness(type = 'image', { existing = false, active = type === 'audio' ? 'audio' : type === 'video' ? 'video' : 'txt2img' } = {}) {
  const mode = type === 'audio' ? 'audio_voice' : active;
  const job = { id: `job-${type}`, kind: type === 'audio' ? 'package' : type === 'video' ? 'h3_t2v' : 'sdxl', backend: 'http://127.0.0.1:8188', status: 'completed', outputs: [{ type, filename: `output.${type}`, url: '/api/media/local' }] };
  const recipe = { request: { kind: job.kind, positive: 'saved prompt', width: 512, height: 512, seed: 9, package_id: 'voice', values: { text: 'saved audio' } } };
  const state = { centers: [], saves: 0, tabs: [], resize: 0, notes: [], beforeResize: null };
  const original = createNode('prompt', 30, 40, { text: 'keep edited canvas' });
  const oldResult = existing ? createNode('result', 9000, -2000, { jobId: job.id, outputs: job.outputs }) : null;
  const context = vm.createContext({
    graph: { nodes: [original, ...(oldResult ? [oldResult] : [])], edges: [] }, canvasIdentity: 'owned-canvas', selected: new Set([original.id]), selectedEdge: null,
    viewport: { x: 53, y: 99, scale: .8 }, jobs: [job], jobNodes: {}, KIND_NAMES: {}, clone: structuredClone,
    createNode, recipeGraph, connect, canvasContentArea, placeFragment, structuredClone, STUDIO_MODES, studioModeForKind, URL,
    active, navigationEpoch: 0, panels: new Map(), root: new Element('div'), pause() {}, syncAudioBackendContext: () => job.backend,
    mediaBackendEpoch: 0, selectedJobs: {}, drafts: {}, kindDrafts: {}, recipeTransfers: new Set(), lastMedia: new Map(),
    document: { body: { dataset: { workspace: active }, classList: { remove() {} } }, querySelectorAll: () => [], getElementById: () => null },
    window: { dispatchEvent() { state.resize++; state.beforeResize?.(); } }, Event: class { constructor(type) { this.type = type; } },
    canvas: {
      get clientWidth() { return context.document.body.dataset.workspace === 'canvas' ? 1274 : 0; },
      get clientHeight() { return context.document.body.dataset.workspace === 'canvas' ? 876 : 0; },
      getBoundingClientRect() { return rect(this.clientWidth, this.clientHeight); }, closest: () => ({ querySelectorAll: () => [] }),
    },
    currentCanvasIdentity: () => context.canvasIdentity, singleSelected: () => context.graph.nodes.find(node => context.selected.has(node.id)),
    snapshot: () => JSON.stringify([context.graph, [...context.selected], context.viewport]),
    getNode: id => context.graph.nodes.find(node => node.id === id),
    viewPoint: (x, y) => ({ x: (x - 166 - context.viewport.x) / context.viewport.scale, y: (y - 124 - context.viewport.y) / context.viewport.scale }),
    mutate: fn => fn(), renderJobs() {}, renderSelection() {}, renderInspector() {}, switchTab: tab => state.tabs.push(tab),
    applyViewport: () => state.centers.push({ ...context.viewport, workspace: context.document.body.dataset.workspace, width: context.canvas.clientWidth }),
    save: () => { state.saves++; }, toast: text => state.notes.push(text), refresh() {}, render() {}, refreshAudioCapabilities() {}, refreshAudio() {},
    backend: () => job.backend, node: (tag, cls, text) => new Element(tag, cls, text),
    ensurePackageDefinition: async id => ({ id, name: '声音包', fields: [{ id: 'text', type: 'text', label: '台词', node_id: '1', input: 'text' }], prompt: { '1': { class_type: 'SavedVoice', inputs: { text: '' } } } }),
    action: (text, cls, click) => Object.assign(new Element('button', cls, text), { click }),
    jobStatusLabel: () => '已完成', elapsedText: () => '', studioOutputSize: () => '', isJobActive: () => false, jobStateDetail: () => '',
    safeURL: value => value, resultReferenceOutputs: () => [], audioChoices: { packages: [] },
  });
  context.host = {
    jobs: () => context.jobs, api: async () => recipe, toast: context.toast,
    canvasIdentity: context.currentCanvasIdentity, canvasSnapshot: () => JSON.stringify(context.graph),
  };
  vm.runInContext(section(app, 'function nodeSize(', 'function bounds(')
    + section(app, 'function jobTitle(', 'async function reuseJob(')
    + section(studio, '  function open(', '  function field(')
    + section(studio, '  async function reuseRecipe(', '  function refresh('), context);
  context.host.placeJob = context.placeJobOnCanvas; context.host.addRecipe = context.installRecipe; context.host.focusCanvasNode = context.focusCanvasNode;
  context.host.prepareCanvasRecipe = context.prepareCanvasRecipe;
  const panel = new Element('div');
  panel.append(new Element('div', 'studio-result-toolbar'), new Element('div', 'studio-history'), new Element('div', 'studio-preview'));
  const result = () => {
    context.resultPanel(mode, panel);
    return panel.querySelector('.studio-result-actions').children.find(item => item.textContent === '结果放入画布').click();
  };
  return { context, state, original, job, oldResult, result, recipe: () => context.reuseRecipe(job, mode, 'canvas') };
}
function assertFocused(h, node) {
  assert.equal(h.context.selected.size, 1); assert.ok(h.context.selected.has(node.id));
  assert.equal(h.state.centers.length, 1, 'only visible canvas is centered');
  assert.equal(h.state.centers[0].workspace, 'canvas'); assert.equal(h.state.centers[0].width, 1274);
  const area = h.context.visibleCanvasArea(h.context.nodeSize(node)), view = h.context.viewport, size = h.context.nodeSize(node);
  assert.ok(node.x * view.scale + view.x >= area.x);
  assert.ok((node.x + size.width) * view.scale + view.x <= area.x + area.width);
  assert.ok(node.y * view.scale + view.y >= area.y, 'header stays inside the visible canvas');
  assert.deepEqual(h.state.tabs, ['properties']);
}
for (const type of ['image', 'video', 'audio']) {
  for (const existing of [false, true]) test(`${type} result transfer focuses ${existing ? 'existing' : 'new'} node after revealing real canvas`, () => {
    const h = harness(type, { existing }), before = structuredClone(h.original);
    h.result(); const node = h.context.resultForJob(h.job.id); assertFocused(h, node);
    if (existing) assert.equal(node, h.oldResult);
    assert.deepEqual(h.original, before);
    assert.equal(h.context.graph.nodes.length, 2);
  });
  test(`${type} recipe transfer focuses returned generation after successful install and reveal`, async () => {
    const h = harness(type), before = structuredClone(h.original); await h.recipe();
    assertFocused(h, h.context.graph.nodes.find(node => node.type === 'generation'));
    assert.deepEqual(h.original, before); assert.equal(h.context.recipeTransfers.size, 0);
  });
}
for (const operation of ['result', 'recipe']) test(`failed ${operation} transfer preserves studio page, graph, selection and viewport`, async () => {
  const h = harness('audio');
  h.context.graph.nodes = Array.from({ length: 500 }, (_, index) => ({ ...createNode('prompt', index, 0), id: `n-${index}` }));
  const before = JSON.stringify([h.context.graph, [...h.context.selected], h.context.viewport]);
  if (operation === 'recipe') await assert.rejects(h.recipe(), /已满/); else assert.throws(h.result, /已满/);
  assert.equal(h.context.document.body.dataset.workspace, 'audio'); assert.equal(h.state.resize, 0); assert.equal(h.state.centers.length, 0);
  assert.equal(JSON.stringify([h.context.graph, [...h.context.selected], h.context.viewport]), before);
});
test('ordinary navigation preserves the viewport and never centers the current selection', () => {
  const h = harness(), before = structuredClone(h.context.viewport);
  h.context.open('canvas'); h.context.open('video'); h.context.open('canvas');
  assert.deepEqual(h.context.viewport, before); assert.equal(h.state.centers.length, 0);
});
for (const change of ['delete', 'undo', 'new-canvas', 'selection', 'leave-page']) test(`resize-time ${change} cannot focus stale transferred object`, () => {
  const h = harness(); h.state.beforeResize = () => {
    const node = h.context.resultForJob(h.job.id);
    if (change === 'delete') h.context.graph.nodes = h.context.graph.nodes.filter(item => item !== node);
    if (change === 'undo') h.context.graph = structuredClone(h.context.graph);
    if (change === 'new-canvas') h.context.canvasIdentity = 'different-canvas';
    if (change === 'selection') h.context.selected = new Set([h.original.id]);
    if (change === 'leave-page') h.context.document.body.dataset.workspace = 'video';
  };
  h.result(); assert.equal(h.state.centers.length, 0);
});
test('auto-result focus=false retains its prior creation/selection and existing-result behavior', () => {
  const h = harness('image', { active: 'canvas' });
  const node = h.context.placeJobOnCanvas(h.job.id, false);
  assert.equal(h.state.centers.length, 1); assert.ok(h.context.selected.has(node.id)); assert.deepEqual(h.state.tabs, []);
  h.context.selected = new Set([h.original.id]);
  const before = structuredClone(h.context.viewport);
  h.context.placeJobOnCanvas(h.job.id, false);
  assert.equal(h.state.centers.length, 1); assert.deepEqual(h.context.viewport, before); assert.ok(h.context.selected.has(h.original.id));
});
