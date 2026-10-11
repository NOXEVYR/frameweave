import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const inspectGlue = source.slice(source.indexOf('async function inspectPackageDocument('), source.indexOf('async function inspectPackageFile('));
const saveGlue = source.slice(source.indexOf("$('#package-editor-form').addEventListener('submit'"), source.indexOf("$('#settings-form').addEventListener('submit'"));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const state = { identity: 'canvas-1', apiCalls: [], additions: [], errors: [], remembered: [], context: 'original' };
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, { value: '', disabled: false, textContent: '', events: {},
      addEventListener(name, fn) { this.events[name] = fn; }, close() {}, showModal() { state.opened = true; } });
    return elements.get(key);
  };
  const sandbox = { $: get, graph: { nodes: [], edges: [] }, packageDraft: { prompt: { old: true }, fields: [] },
    initialEditorFieldIds: fields => fields.map(field => field.id), renderPackageDraft() {}, stableStringify: JSON.stringify,
    currentCanvasIdentity: () => state.identity, reportError: error => state.errors.push(error.message),
    rememberPackageDefinition: pack => state.remembered.push(pack), loadPackages: async () => { if (state.loadError) throw state.loadError; },
    api: async (path, payload) => { state.apiCalls.push({ path, payload }); return state.response; },
    addPackageNode: async (pack, options) => { options.ensureCurrent(); state.additions.push(pack); },
  };
  vm.runInNewContext(inspectGlue + '\n' + saveGlue, sandbox);
  get('#package-name').value = 'H3'; get('#package-description').value = 'draft';
  const submit = () => get('#package-editor-form').events.submit({ preventDefault() {} });
  return { state, sandbox, get, submit };
}

test('H3 standard document retains labels and fixed rate constraints through the real inspect/save glue', async () => {
  const h = harness();
  const document = { format: 'frameweave-workflow', name: 'H3', prompt: { '1': { class_type: 'VHS_LoadVideo', inputs: { force_rate: 24 } } },
    fields: [{ id: 'rate', node_id: '1', input: 'force_rate', type: 'number', default: 24, min: 24, max: 24, label: '视频1 · 固定24fps' }] };
  h.state.response = structuredClone(document);
  await h.sandbox.inspectPackageDocument(document);
  assert.equal(h.state.opened, true);
  h.state.response = { package: { id: 'h3-package', ...document } };
  h.submit(); await settle();
  const saved = h.state.apiCalls.find(call => call.path === '/api/packages');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.payload.fields)), document.fields);
  assert.equal(h.state.additions.length, 1); assert.equal(h.sandbox.packageDraft, null);
});

test('late inspect response after H3 context changes preserves the prior draft and does not open a dialog', async () => {
  const h = harness(), pending = deferred(), prior = h.sandbox.packageDraft;
  h.state.response = pending.promise;
  const guard = () => { if (h.state.context !== 'original') throw new Error('source changed'); };
  const inspecting = h.sandbox.inspectPackageDocument({ format: 'frameweave-workflow' }, 'H3', '', guard);
  h.state.context = 'changed-engine-or-canvas'; pending.resolve({ prompt: {}, fields: [] });
  await assert.rejects(inspecting, /source changed/);
  assert.equal(h.sandbox.packageDraft, prior); assert.equal(h.state.opened, undefined);
});

test('package save failure or invalid receipt preserves the editing draft and restores the save control', async () => {
  for (const mode of ['failed', 'invalid']) {
    const h = harness(), pending = deferred(), prior = h.sandbox.packageDraft;
    h.state.response = pending.promise; h.submit();
    assert.equal(h.get('#save-package').disabled, true);
    if (mode === 'failed') pending.reject(new Error('disk write failed')); else pending.resolve({ package: {} });
    await settle();
    assert.equal(h.sandbox.packageDraft, prior); assert.equal(h.state.additions.length, 0);
    assert.equal(h.get('#save-package').disabled, false); assert.equal(h.state.errors.length, 1);
  }
});

test('saved package followed by catalog refresh failure remains recoverable without adding a canvas node', async () => {
  const h = harness(), prior = h.sandbox.packageDraft;
  h.state.response = { package: { id: 'saved-local' } }; h.state.loadError = new Error('catalog read failed');
  h.submit(); await settle();
  assert.equal(h.state.remembered[0].id, 'saved-local'); assert.equal(h.sandbox.packageDraft, prior);
  assert.equal(h.state.additions.length, 0); assert.equal(h.get('#save-package').disabled, false);
});

test('canvas or editing-draft replacement during save cannot attach a late H3 package to the new target', async () => {
  for (const change of [h => { h.state.identity = 'canvas-2'; }, h => { h.sandbox.packageDraft = { prompt: {}, fields: [] }; }]) {
    const h = harness(), pending = deferred(); h.state.response = pending.promise;
    h.submit(); change(h); pending.resolve({ package: { id: 'saved-local' } }); await settle();
    assert.equal(h.state.remembered[0].id, 'saved-local'); assert.equal(h.state.additions.length, 0);
    assert.equal(h.state.errors.length, 1); assert.equal(h.get('#save-package').disabled, false);
  }
});
