import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNode, parseGraph, serializeGraph } from '../web/graph.mjs';
import { parseJSONWithSafeNumbers } from '../web/packages.mjs';
import { createWorkflowCanvas, validateCanvasStructure } from '../web/workflow-canvas.mjs';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const entry = app.slice(app.indexOf('const CANVAS_FILE_LIMIT ='), app.indexOf('async function compileNode('));
assert(entry.startsWith('const CANVAS_FILE_LIMIT ='), 'real app file entry must be present');
const LIMIT = 24 * 1024 * 1024;
const clone = structuredClone;
function canvas(composed = false) {
  const prompt = { ...createNode('prompt', 10, 20, { text: 'IMPORTED CONTENT' }), id: 'imported-prompt' };
  const graph = { nodes: [prompt], edges: [] };
  if (composed) {
    const target = { ...createNode('generation', 300, 20, { kind: 'package', package_id: `p-${'a'.repeat(24)}`,
      packageFields: [{ id: 'pos', type: 'text', label: 'Positive' }], packageValues: { pos: 'OWN' }, packageTextCompositions: { pos: 'paragraphs' } }), id: 'imported-target' };
    graph.nodes.push(target); graph.edges.push({ id: 'wire', source: prompt.id, target: target.id, targetField: 'pos', sourceField: 'text' });
  }
  return JSON.parse(serializeGraph(graph, { x: 40, y: 50, scale: 1.25 }));
}
function harness() {
  const initial = { ...createNode('prompt', 0, 0, { text: 'OLD CONTENT' }), id: 'old' };
  const state = { identity: 'original-canvas', busy: false, mutations: 0, saves: [], downloads: [], toasts: [], bundles: [], bundleReads: 0, bundleCommits: 0, api: [] };
  const sandbox = { graph: { nodes: [initial], edges: [] }, viewport: { x: 4, y: 7, scale: 1 }, projectTitle: 'ORIGINAL TITLE', selected: new Set(['old']), selectedEdge: 'old-edge',
    TextEncoder, parseJSONWithSafeNumbers, validateCanvasStructure, parseGraph, serializeGraph,
    currentCanvasIdentity: () => state.identity, replaceCanvasIdentity: () => { state.identity = 'new-canvas'; },
    mutate: fn => { state.mutations++; fn(); }, setProjectTitle: value => { sandbox.projectTitle = value; }, importedProjectTitle: name => name.replace(/\.json$/i, ''),
    applyViewport: () => { state.viewportApplied = true; }, save: forced => state.saves.push(forced), toast: message => state.toasts.push(message),
    downloadJSON: (value, name) => state.downloads.push({ value, name }),
  };
  const bundle = createWorkflowCanvas({ graph: () => sandbox.graph, viewport: () => sandbox.viewport, title: () => sandbox.projectTitle, canvasIdentity: () => state.identity, engine: () => ({ backend_url: 'http://127.0.0.1:8188' }),
    api: async path => { state.api.push(path); throw new Error(`Unexpected API ${path}`); }, loadPackages: async () => { if (state.onLoadPackages) await state.onLoadPackages(); }, toast: sandbox.toast,
    setGraph: (incoming, title) => { state.bundleCommits++; sandbox.graph = { nodes: incoming.nodes, edges: incoming.edges }; sandbox.viewport = incoming.viewport; sandbox.projectTitle = title; },
  });
  sandbox.workflowCanvas = { isRunning: () => state.busy || bundle.isRunning(), async importBundle(file) {
    state.bundles.push(file);
    return bundle.importBundle({ ...file, text: async () => { state.bundleReads++; return file.text(); } });
  } };
  vm.runInNewContext(entry, sandbox);
  return { sandbox, state, initial };
}
function file(source, { size = new TextEncoder().encode(source).length, duringRead = () => {} } = {}) {
  const result = { name: 'Imported.json', size, reads: 0, async text() { result.reads++; await duringRead(); return source; } };
  return result;
}
function unchanged(h, before) { assert.deepEqual(h.sandbox.graph, before); assert.equal(h.state.mutations, 0); assert.equal(h.state.bundleCommits, 0); assert.equal(h.state.downloads.length, 0); }

for (const composed of [false, true]) test(`real file entry imports raw canvas ${composed ? 'v2' : 'v1'} and restores viewport without jobs`, async () => {
  const h = harness(), document = canvas(composed), input = file(JSON.stringify(document));
  await h.sandbox.importCanvasFile(input);
  assert.equal(input.reads, 1); assert.equal(h.sandbox.graph.nodes[0].data.text, 'IMPORTED CONTENT');
  assert.equal(h.sandbox.graph.nodes.length, composed ? 2 : 1); assert.equal(h.sandbox.viewport.scale, 1.25);
  assert.equal(h.sandbox.projectTitle, 'Imported'); assert.equal(h.sandbox.selected.size, 0); assert.equal(h.sandbox.selectedEdge, null);
  assert.equal(h.state.mutations, 1); assert.equal(h.state.bundles.length, 0); assert.deepEqual(h.state.api, []);
  if (composed) assert.equal(h.sandbox.graph.nodes[1].data.packageTextCompositions.pos, 'paragraphs');
});

test('full project dispatches to real existing bundle importer and reads original file exactly once', async () => {
  const h = harness(), document = { schema: 'prismcanvas.project.v1', version: 1, name: 'Bundle title', canvas: canvas(), packages: [] };
  const source = '\uFEFF' + JSON.stringify(document), input = file(source);
  await h.sandbox.importCanvasFile(input);
  assert.equal(input.reads, 1); assert.equal(h.state.bundleReads, 1); assert.equal(h.state.bundles.length, 1);
  assert.equal(h.state.bundles[0].size, new TextEncoder().encode(source).length); assert.equal(await h.state.bundles[0].text(), source.slice(1));
  assert.equal(h.state.bundleCommits, 1); assert.equal(h.state.mutations, 0); assert.equal(h.sandbox.projectTitle, 'Bundle title'); assert.deepEqual(h.state.api, []);
});

test('bundle failure never falls back to raw import or replaces current canvas', async () => {
  const h = harness(), before = clone(h.sandbox.graph), input = file(JSON.stringify({ schema: 'prismcanvas.project.v1', version: 99, canvas: canvas(), packages: [] }));
  await assert.rejects(h.sandbox.importCanvasFile(input), /画布集合/);
  unchanged(h, before); assert.equal(input.reads, 1); assert.equal(h.state.bundles.length, 1); assert.equal(h.sandbox.projectTitle, 'ORIGINAL TITLE'); assert.equal(h.state.saves.length, 0);
});

test('declared file size above 24 MiB refuses before reading, even if text would be valid', async () => {
  const h = harness(), before = clone(h.sandbox.graph), input = file(JSON.stringify(canvas()), { size: LIMIT + 1 });
  await assert.rejects(h.sandbox.importCanvasFile(input), /24 MiB/); assert.equal(input.reads, 0); unchanged(h, before);
});

test('actual UTF8 bytes override a forged small file size and are checked before JSON parsing', async () => {
  const h = harness(), before = clone(h.sandbox.graph), document = canvas(); document.extra = '中'.repeat(9 * 1024 * 1024);
  const source = JSON.stringify(document); assert(source.length < LIMIT); assert(new TextEncoder().encode(source).length > LIMIT);
  const input = file(source, { size: 1 }); await assert.rejects(h.sandbox.importCanvasFile(input), /24 MiB/);
  assert.equal(input.reads, 1); unchanged(h, before);
});

test('valid raw canvas above the former 8 MiB limit but below 24 MiB imports successfully', async () => {
  const h = harness(), document = canvas(); document.extra = 'x'.repeat(9 * 1024 * 1024);
  const source = JSON.stringify(document), input = file(source);
  assert(input.size > 8 * 1024 * 1024 && input.size < LIMIT);
  await h.sandbox.importCanvasFile(input); assert.equal(input.reads, 1); assert.equal(h.state.mutations, 1); assert.equal(h.sandbox.graph.nodes[0].id, 'imported-prompt');
});

for (const change of ['graph object', 'identity', 'node value', 'viewport', 'title', 'busy']) test(`changed ${change} while reading refuses stale replacement`, async () => {
  const h = harness(); let expected;
  const input = file(JSON.stringify(canvas()), { duringRead: () => {
    if (change === 'graph object') h.sandbox.graph = clone(h.sandbox.graph);
    if (change === 'identity') h.state.identity = 'different';
    if (change === 'node value') h.initial.data.text = 'USER NEW TEXT';
    if (change === 'viewport') h.sandbox.viewport.x++;
    if (change === 'title') h.sandbox.projectTitle = 'USER NEW TITLE';
    if (change === 'busy') h.state.busy = true;
    expected = clone(h.sandbox.graph);
  } });
  await assert.rejects(h.sandbox.importCanvasFile(input), /导入期间画布已变化/); unchanged(h, expected); assert.equal(input.reads, 1); assert.equal(h.state.saves.length, 0);
});

test('busy entry never reads or replaces a selected file', async () => {
  const h = harness(), before = clone(h.sandbox.graph), input = file(JSON.stringify(canvas())); h.state.busy = true;
  await assert.rejects(h.sandbox.importCanvasFile(input), /请先停止/); assert.equal(input.reads, 0); unchanged(h, before);
});

test('valid export keeps real canvas schema and viewport and downloads only after validation', () => {
  const h = harness(); h.sandbox.exportProject();
  assert.equal(h.state.downloads.length, 1); const downloaded = JSON.parse(h.state.downloads[0].value);
  assert.equal(downloaded.schema, 'frameweave.canvas.v1'); assert.deepEqual(downloaded.viewport, h.sandbox.viewport); assert.equal(downloaded.nodes[0].data.text, 'OLD CONTENT');
  assert.match(h.state.downloads[0].name, /^frameweave-canvas-\d{4}-\d{2}-\d{2}\.json$/); assert.deepEqual(h.state.saves, [true]); assert.deepEqual(h.state.api, []);
});

for (const invalid of ['bytes', 'depth', 'items', 'schema']) test(`export rejects invalid ${invalid} before downloading or saving`, () => {
  const h = harness();
  if (invalid === 'bytes') h.initial.data.extra = 'x'.repeat(LIMIT);
  if (invalid === 'depth') { let extra = {}; h.initial.data.extra = extra; for (let i = 0; i < 70; i++) { extra.next = {}; extra = extra.next; } }
  if (invalid === 'items') h.initial.data.extra = new Array(500001).fill(0);
  if (invalid === 'schema') h.initial.type = 'invalid-node';
  assert.throws(() => h.sandbox.exportProject(), invalid === 'bytes' ? /24 MiB/ : invalid === 'depth' ? /64 层/ : invalid === 'items' ? /500000/ : /不支持的节点/);
  assert.equal(h.state.downloads.length, 0); assert.equal(h.state.saves.length, 0); assert.equal(h.state.toasts.length, 0); assert.deepEqual(h.state.api, []);
});

for (const change of ['title', 'viewport']) test(`late bundle ${change} change after file read cannot be replaced during delegated await`, async () => {
  const h = harness(), before = clone(h.sandbox.graph);
  h.state.onLoadPackages = async () => {
    assert.equal(h.state.bundles.length, 1); assert.equal(h.state.bundleReads, 1);
    if (change === 'title') h.sandbox.projectTitle = 'USER TITLE AFTER READ';
    else h.sandbox.viewport = { x: 77, y: 88, scale: 2 };
  };
  const input = file(JSON.stringify({ schema: 'prismcanvas.project.v1', version: 1, name: 'Bundle', canvas: canvas(), packages: [] }));
  await assert.rejects(h.sandbox.importCanvasFile(input), /导入期间.*变化/); unchanged(h, before);
  if (change === 'title') assert.equal(h.sandbox.projectTitle, 'USER TITLE AFTER READ');
  else assert.deepEqual(h.sandbox.viewport, { x: 77, y: 88, scale: 2 });
  assert.equal(input.reads, 1); assert.equal(h.state.saves.length, 0);
});
