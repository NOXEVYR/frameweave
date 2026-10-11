import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNode, stableStringify } from '../web/graph.mjs';
import { defaultValues, parsePackageDocument } from '../web/packages.mjs';
import { cachedPackageField } from '../web/canvas-port-layout.mjs';
import { createContentLayout } from '../web/canvas-content-layout.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing app entry ${start}`);
  return source.slice(first, last);
};
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const clone = structuredClone;
const tick = () => new Promise(setImmediate);
const backend = 'http://127.0.0.1:8188';
function harness() {
  const pack = { id: `p-${'a'.repeat(24)}`, name: 'Imported AUDIO workflow', format: 'frameweave-workflow', version: 1,
    prompt: { '1': { class_type: 'LoadAudio', inputs: { audio: '' } } },
    fields: [{ id: 'voice', label: 'Voice reference', type: 'audio', node_id: '1', input: 'audio', default: '' }] };
  const output = { id: 'audio:2:0', node_id: '2', slot: 0, type: 'audio', label: 'Audio output' };
  const original = { nodes: [{ ...createNode('prompt', 0, 0, { text: 'keep existing' }), id: 'original' }], edges: [] };
  const calls = [], notes = [], library = new Map(), elements = new Map(), hooks = {};
  const state = { saves: 0, renders: 0 };
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { value: '', listeners: {}, close() {}, addEventListener(event, fn) { this.listeners[event] = fn; } });
    return elements.get(key);
  };
  const context = vm.createContext({ graph: clone(original), canvasIdentity: 'original-canvas', projectTitle: 'Existing canvas',
    jobNodes: { 'existing-job': 'original' }, selected: new Set(['original']), selectedEdge: null, history: [], future: [], draftEditing: null,
    expandedInputs: new Set(), portBindings: new Map(), savedPortViews: () => [], restorePortViews() {}, contentLayout: null,
    viewport: { x: 12, y: 16, scale: 1 }, settings: { backend_url: backend }, packageNodeAdds: new Map(), packageDraft: null,
    createNode, cachedPackageField, defaultValues, parsePackageDocument, stableStringify, structuredClone, Set, Map, $, CANVAS_ID_KEY: 'canvas-id',
    localStorage: { setItem() {} }, ensureCanvasIdentity: () => context.canvasIdentity, currentCanvasIdentity: () => context.canvasIdentity,
    getNode: id => context.graph.nodes.find(node => node.id === id), singleSelected: () => context.selected.size === 1 ? context.getNode([...context.selected][0]) : null,
    setProjectTitle: value => { context.projectTitle = value; }, finishKeyboardMove() {},
    save() { state.saves++; }, renderNodes() { state.renders++; }, renderInspector() {}, renderAll() {},
    bounds: () => ({ maxX: 300 }), canvas: { clientWidth: 1000, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    viewPoint: (x, y) => ({ x, y }), placeNewNodes() {}, revealInspector() {}, centerOnNode() {}, applyViewport() {}, switchTab() {},
    studio: { open() {} }, toast: (...message) => notes.push(message), choosePngWorkflow() {}, editorDocument: () => null,
    readWorkflowFile: async () => { await hooks.stage?.('file'); return { sourceJSON: JSON.stringify(pack), name: pack.name }; },
    rememberPackageDefinition: value => { library.set(value.id, value); return value; },
    ensurePackageDefinition: async () => { await hooks.stage?.('definition'); return pack; },
    loadPackages: async () => { calls.push({ path: 'loadPackages' }); await hooks.stage?.('library'); },
    api: async (path, body) => {
      calls.push({ path, body: clone(body) });
      await hooks.stage?.(path === '/api/packages' ? 'package' : 'inspect');
      if (path === '/api/packages') { library.set(pack.id, pack); return { package: pack }; }
      if (path === '/api/interfaces/inspect') return { outputs: [clone(output)] };
      throw new Error(`Unexpected API ${path}`);
    }, reportError: error => state.error = error,
  });
  vm.runInContext(section('function snapshot(', 'function save(') +
    section('function undo(', 'function viewPoint(') + section('function addNode(', 'function renderLoraFields(') +
    section('async function addPackageNode(', 'async function exportPackage(') +
    section('async function inspectPackageFile(', 'const canvasInspection =') +
    section("$('#package-editor-form').addEventListener('submit'", "$('#settings-form').addEventListener('submit'"), context);
  return { context, original, pack, output, calls, notes, library, elements, hooks, state,
    run: () => context.inspectPackageFile({ name: 'audio.json' }),
    submit: () => elements.get('#package-editor-form').listeners.submit({ preventDefault() {} }) };
}

test('one normal package import is one complete undo and redo including outputs, identity, jobs and selection', async () => {
  const h = harness(), before = clone(h.context.graph), originalJobs = clone(h.context.jobNodes);
  await h.run();
  assert.equal(h.context.history.length, 1);
  const installed = clone(h.context.graph.nodes.at(-1));
  assert.deepEqual(installed.data.editor_outputs, [h.output.id]);
  assert.deepEqual(installed.data.editor_output_fields, [h.output]);
  h.context.undo();
  assert.deepEqual(clone(h.context.graph), before);
  assert.deepEqual([...h.context.selected], ['original']);
  assert.equal(h.context.canvasIdentity, 'original-canvas');
  assert.deepEqual(clone(h.context.jobNodes), originalJobs);
  assert.equal(h.context.projectTitle, 'Existing canvas');
  assert.ok(h.library.has(h.pack.id), 'canvas undo never deletes the local package');
  h.context.redo();
  assert.deepEqual(clone(h.context.graph.nodes.at(-1)), installed);
  assert.deepEqual([...h.context.selected], [installed.id]);
  assert.equal(h.context.history.length, 1);
  assert.ok(h.calls.every(call => ['/api/packages', '/api/interfaces/inspect', 'loadPackages'].includes(call.path)));
});

test('asynchronous content-layout undo and redo only replay coordinates while newer media, tasks and edges survive', () => {
  const h = harness(), node = h.context.graph.nodes[0];
  const before = h.context.layoutHistoryEntry([{ id: node.id, x: node.x, y: node.y }]);
  h.context.history.push(before); node.y = 900;
  node.data.outputs = [{ filename: 'new-backend-output' }]; node.data.text = 'new media and parameters';
  h.context.jobNodes = { 'new-job': node.id };
  h.context.graph.edges.push({ id: 'new-live-edge', source: node.id, target: 'other' });
  const factual = clone({ data: node.data, edges: h.context.graph.edges, jobs: h.context.jobNodes });
  h.context.undo();
  assert.equal(node.y, 0); assert.equal(h.context.graph.nodes[0], node, 'layout replay keeps the live node object');
  assert.deepEqual(clone({ data: node.data, edges: h.context.graph.edges, jobs: h.context.jobNodes }), factual);
  node.data.outputs.push({ filename: 'arrived-after-undo' });
  h.context.redo(); assert.equal(node.y, 900); assert.equal(node.data.outputs.at(-1).filename, 'arrived-after-undo');
  assert.deepEqual(clone(h.context.graph.edges), factual.edges); assert.deepEqual(clone(h.context.jobNodes), factual.jobs);
});

test('coordinate-only history cannot move same-id nodes in another canvas identity', () => {
  const h = harness(), node = h.context.graph.nodes[0];
  h.context.history.push({ ...h.context.layoutHistoryEntry([{ id: node.id, x: 0, y: 0 }]), canvasIdentity: 'different-canvas' });
  node.y = 900; h.context.undo(); assert.equal(node.y, 900);
});

test('continued live typing and unchanged blur commit do not absorb deferred backend growth into draft history', () => {
  const h = harness(), owner = h.context.graph.nodes[0];
  const below = { ...createNode('prompt', 0, 136), id: 'below' }; h.context.graph.nodes.push(below);
  let height = 100, focused = true, notify;
  const frames = [];
  const layout = createContentLayout({
    read: () => h.context.graph.nodes.map(node => ({ id: node.id, node, x: node.x, y: node.y, width: 100, height: node === owner ? height : 100 })),
    identity: () => h.context.canvasIdentity, busy: () => focused,
    apply: positions => positions.forEach(p => Object.assign(h.context.getNode(p.id), p)),
    commit: positions => h.context.history.push(h.context.layoutHistoryEntry(positions)),
    onError: error => { throw error; }, schedule: callback => frames.push(callback),
    observe: callback => { notify = callback; return { observe() {}, unobserve() {}, disconnect() {} }; },
  });
  h.context.contentLayout = layout; h.context.renderNodes = () => layout.rendered();
  focused = false; layout.rendered(); focused = true;
  height = 200; owner.data.outputs = [{ filename: 'arrived-preview' }]; notify();
  h.context.draftEditing = { recorded: false };
  h.context.mutate(() => { owner.data.text = 'continued typing'; });
  h.context.draftEditing = null;
  assert.equal(below.y, 136); assert.equal(h.context.history.length, 1);
  h.context.mutate(() => { owner.data.text = 'continued typing'; });
  assert.equal(below.y, 136); assert.equal(h.context.history.length, 1);
  focused = false; layout.resume(); while (frames.length) frames.shift()();
  assert.equal(below.y, 236); assert.equal(h.context.history.length, 2);
  assert.equal(h.context.history.at(-1).kind, 'content-layout');
  h.context.undo(); assert.equal(below.y, 136); assert.equal(owner.data.text, 'continued typing');
  assert.equal(owner.data.outputs[0].filename, 'arrived-preview');
});

test('output discovery happens off canvas until all node defaults can be committed together', async () => {
  const h = harness(), gate = deferred(); h.hooks.stage = stage => stage === 'inspect' ? gate.promise : undefined;
  const before = h.context.snapshot(), run = h.run(); await tick();
  assert.equal(h.context.snapshot(), before); assert.equal(h.context.history.length, 0);
  gate.resolve(); await run;
  assert.equal(h.context.graph.nodes.length, 2); assert.equal(h.context.history.length, 1);
});

test('unavailable output discovery still adds one repairable package node in a single undo', async () => {
  const h = harness(); h.hooks.stage = stage => { if (stage === 'inspect') throw new Error('backend offline'); };
  await h.run(); assert.equal(h.context.history.length, 1); assert.equal(h.context.graph.nodes.at(-1).data.package_id, h.pack.id);
  assert.deepEqual(clone(h.context.graph.nodes.at(-1).data.editor_outputs || []), []);
  assert.match(h.notes.flat().join(' '), /输出识别.*backend offline/);
  h.context.undo(); assert.equal(h.context.graph.nodes.length, 1); assert.ok(h.library.has(h.pack.id));
});

for (const stage of ['file', 'package', 'library', 'inspect']) for (const change of ['identity', 'same-ID graph replacement']) {
  test(`late ${stage} cannot install a package after ${change}`, async () => {
    const h = harness(); let after;
    h.hooks.stage = current => { if (current !== stage) return;
      if (change === 'identity') h.context.canvasIdentity = 'next-canvas';
      h.context.graph = clone(h.context.graph); h.context.graph.nodes[0].data.text = 'new target'; after = clone(h.context.graph);
    };
    await assert.rejects(h.run(), /画布已切换/);
    assert.deepEqual(clone(h.context.graph), after); assert.equal(h.context.history.length, 0);
    assert.equal(h.library.has(h.pack.id), stage !== 'file');
  });
}

test('an unrelated edit during discovery survives the import undo and retains its earlier history', async () => {
  const h = harness(), gate = deferred(); h.hooks.stage = stage => stage === 'inspect' ? gate.promise : undefined;
  const run = h.run(); await tick();
  h.context.mutate(() => { h.context.graph.nodes[0].data.text = 'user edited while loading'; });
  const userSnapshot = clone(h.context.graph); gate.resolve(); await run;
  assert.equal(h.context.history.length, 2); h.context.undo(); assert.deepEqual(clone(h.context.graph), userSnapshot);
  h.context.undo(); assert.equal(h.context.graph.nodes[0].data.text, 'keep existing');
});

test('a backend switch during discovery does not adopt outputs from the previous engine', async () => {
  const h = harness(); h.hooks.stage = stage => { if (stage === 'inspect') h.context.settings.backend_url = 'http://127.0.0.1:8189'; };
  await h.run(); assert.equal(h.context.history.length, 1);
  assert.deepEqual(clone(h.context.graph.nodes.at(-1).data.editor_outputs || []), []);
  assert.match(h.notes.flat().join(' '), /输出识别.*引擎/);
});

test('same-ID canvas replacement invalidates library hydration without deduplicating the new canvas request', async () => {
  const h = harness(), first = deferred(), second = deferred(); let count = 0;
  h.hooks.stage = stage => stage === 'definition' ? (++count === 1 ? first.promise : second.promise) : undefined;
  const a = h.context.addPackageNode({ id: h.pack.id });
  h.context.graph = clone(h.context.graph);
  const b = h.context.addPackageNode({ id: h.pack.id });
  first.resolve(); await assert.rejects(a, /画布已切换/); second.resolve(); await b;
  assert.equal(count, 2); assert.equal(h.context.graph.nodes.length, 2); assert.equal(h.context.history.length, 1);
});

test('a pending library addition cannot swallow a separate import with fully prepared output defaults', async () => {
  const h = harness(), gate = deferred(); h.hooks.stage = stage => stage === 'definition' ? gate.promise : undefined;
  const fromLibrary = h.context.addPackageNode({ id: h.pack.id });
  const node = await h.context.addPackageNode(h.pack, { nodeData: { editor_outputs: [h.output.id], editor_output_fields: [h.output] } });
  assert.deepEqual(clone(node.data.editor_outputs), [h.output.id]); assert.equal(h.context.graph.nodes.length, 2);
  gate.resolve(); const second = await fromLibrary;
  assert.notEqual(second, node); assert.equal(h.context.history.length, 2);
});

test('capacity failure after discovery never installs a partial node or changes history and library data', async () => {
  const h = harness(); h.context.graph.nodes = Array.from({ length: 500 }, (_, index) => ({ ...clone(h.original.nodes[0]), id: `existing-${index}` }));
  h.context.selected = new Set(['existing-4']); h.context.future = ['prior-redo'];
  const before = h.context.snapshot(); await assert.rejects(h.run(), /画布已满/);
  assert.equal(h.context.snapshot(), before); assert.equal(h.context.history.length, 0);
  assert.deepEqual([...h.context.future], ['prior-redo']); assert.ok(h.library.has(h.pack.id));
});

test('undo restores a previously selected edge and redo restores the imported node selection', async () => {
  const h = harness(); h.context.graph.nodes.push({ ...createNode('generation', 400, 0), id: 'target' });
  h.context.graph.edges.push({ id: 'original-edge', source: 'original', target: 'target' });
  h.context.selected = new Set(); h.context.selectedEdge = 'original-edge';
  await h.run(); const id = h.context.graph.nodes.at(-1).id;
  h.context.undo(); assert.equal(h.context.selectedEdge, 'original-edge'); assert.deepEqual([...h.context.selected], []);
  h.context.redo(); assert.equal(h.context.selectedEdge, null); assert.deepEqual([...h.context.selected], [id]);
});

test('package editor save keeps the package but refuses late node placement on a new target canvas', async () => {
  const h = harness(); h.context.packageDraft = { ...clone(h.pack), fields: h.pack.fields.map(field => ({ ...field, selected: true })) };
  h.context.$('#package-name').value = h.pack.name;
  const initialDraft = h.context.packageDraft;
  h.hooks.stage = stage => { if (stage === 'package') { h.context.graph = clone(h.context.graph); h.context.canvasIdentity = 'new-target'; } };
  h.submit(); await tick(); await tick();
  assert.match(h.state.error?.message || '', /画布已切换/);
  assert.equal(h.context.graph.nodes.length, 1); assert.equal(h.context.history.length, 0);
  assert.equal(h.context.packageDraft, initialDraft); assert.ok(h.library.has(h.pack.id));
});

test('selection-only changes do not add undo entries, erase redo or consume the draft-edit transaction', () => {
  const h = harness(); h.context.future = ['keep-redo'];
  h.context.mutate(() => { h.context.selected = new Set(); });
  assert.equal(h.context.history.length, 0); assert.deepEqual([...h.context.future], ['keep-redo']);
  h.context.selected = new Set(['original']); h.context.draftEditing = { recorded: false };
  h.context.mutate(() => { h.context.selected = new Set(); });
  assert.equal(h.context.history.length, 0); assert.deepEqual([...h.context.future], ['keep-redo']);
  assert.equal(h.context.draftEditing.recorded, false);
  h.context.mutate(() => { h.context.graph.nodes[0].data.text = 'edited'; });
  assert.equal(h.context.history.length, 1); assert.equal(h.context.draftEditing.recorded, true);
  h.context.mutate(() => { h.context.graph.nodes[0].data.text = 'edited again'; });
  assert.equal(h.context.history.length, 1);
});

test('restoring a legacy snapshot without selection still filters missing selections', () => {
  const h = harness(); h.context.history.push(JSON.stringify({ graph: h.original, canvasIdentity: 'legacy', jobNodes: {}, projectTitle: 'Legacy' }));
  h.context.selected.add('missing'); h.context.undo();
  assert.deepEqual([...h.context.selected], ['original']); assert.equal(h.context.canvasIdentity, 'legacy');
});
