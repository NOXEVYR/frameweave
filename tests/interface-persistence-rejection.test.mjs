import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { configureWorkflowInterface } from '../web/workflow-interface-controller.mjs';

const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const apiSource = appSource.slice(appSource.indexOf('async function api('), appSource.indexOf('function getNode('));
const nativeGlue = appSource.slice(appSource.indexOf('function captureNativeInterfaceTarget('), appSource.indexOf('async function configureNativePanel('));
const proof = { persisted: false, persistence_stage: 'prewrite' };
function requestError(payload, status = 400) {
  return Object.assign(new Error('apply rejected'), { status, payload });
}
function harness({ compiled = { workflow: {}, output: {}, controls: [] } } = {}) {
  const info = { fields: [], outputs: [] };
  const selection = { fields: [], output_nodes: [], rebindings: {}, output_rebindings: {} };
  const result = { package: { id: 'new-package', fields: [] }, values: {}, baseline: {}, output_nodes: [] };
  const state = { mutations: 0, inspections: 0, guards: 0, result, selection, info, compiled };
  const deps = {
    async api(path) {
      if (path.endsWith('/interface')) { state.inspections++; return info; }
      state.mutations++;
      return state.onMutation ? state.onMutation() : result;
    },
    toast() {},
    chooseEditorInterface: async () => selection,
    autoEditorInterfaceSelection: () => selection,
    completeInterfaceInputs: async () => ({ info, selection, missing_values: {} }),
    resolveEditorConflicts: async () => ({ field: 'outer' }),
  };
  const options = { compiled, session: { session_id: 'session', base_revision: 1 },
    assertCurrent() { state.guards++; } };
  const data = { editor_id: 'editor', package_id: 'package', packageValues: {}, editor_baseline: {} };
  return { state, deps, options, data, run: () => configureWorkflowInterface(deps, data, options) };
}
async function rejectsWithState(run, persisted, requiresReopen = false) {
  await assert.rejects(run, error => {
    assert.equal(error.persisted, persisted);
    assert.equal(error.requiresReopen === true, requiresReopen);
    return true;
  });
}

test('all preflight failures are explicitly unwritten and send zero mutations', async () => {
  const failures = [
    h => { h.options.assertCurrent = undefined; },
    h => { h.options.assertCurrent = () => { throw new Error('initial guard'); }; },
    h => { h.deps.api = async () => { throw requestError({}, 502); }; },
    h => { h.deps.chooseEditorInterface = async () => { throw new Error('selection'); }; },
    h => { h.deps.completeInterfaceInputs = async () => { throw new Error('repair'); }; },
    h => { h.options.assertCurrent = () => { if (++h.state.guards === 3) throw new Error('before mutation'); }; },
    h => { h.state.compiled.ignored_ui_inputs = ['ui']; h.deps.toast = () => { throw new Error('preflight toast'); }; },
  ];
  for (const fail of failures) {
    const h = harness(); fail(h);
    await rejectsWithState(h.run, false);
    assert.equal(h.state.mutations, 0);
  }
});

test('real app API payload with prewrite proof propagates explicit rejection through controller', async () => {
  for (const status of [400, 502]) {
    const h = harness();
    const apiSandbox = { AbortController, setTimeout, clearTimeout, csrf: 'test-only',
      fetch: async path => path.endsWith('/interface')
        ? { ok: true, status: 200, json: async () => h.state.info }
        : { ok: false, status, json: async () => ({ error: 'validation rejected', ...proof }) } };
    vm.runInNewContext(apiSource, apiSandbox);
    h.deps.api = apiSandbox.api;
    await assert.rejects(h.run, error => {
      assert.equal(error.persisted, false);
      assert.equal(error.status, status);
      assert.equal(error.payload.persistence_stage, 'prewrite');
      return true;
    });
  }
});

test('only strict false plus fixed prewrite proof releases a mutation rejection', async () => {
  for (const payload of [proof, { ...proof, error: 'missing images' }]) {
    const h = harness(); h.state.onMutation = () => { throw requestError(payload); };
    await rejectsWithState(h.run, false);
    assert.equal(h.state.mutations, 1);
  }
  for (const payload of [{}, { persisted: false }, { persistence_stage: 'prewrite' },
    { persisted: 'false', persistence_stage: 'prewrite' }, { persisted: 0, persistence_stage: 'prewrite' },
    { persisted: false, persistence_stage: 'writing' }, { persisted: true, persistence_stage: 'prewrite' }]) {
    const h = harness(); h.state.onMutation = () => { throw requestError(payload); };
    await rejectsWithState(h.run, 'unknown');
    assert.equal(h.state.mutations, 1);
  }
  const h = harness(); h.state.onMutation = () => { throw Object.assign(requestError({}), { persisted: false }); };
  await rejectsWithState(h.run, 'unknown');
});

test('bare HTTP errors, disconnect, timeout and invalid JSON remain unknown', async () => {
  const failures = [
    async () => { throw new TypeError('network disconnected'); },
    async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; },
    async () => ({ ok: false, status: 400, json: async () => { throw new SyntaxError('invalid JSON'); } }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid success JSON'); } }),
    async () => ({ ok: false, status: 502, json: async () => ({ error: 'write interrupted' }) }),
  ];
  for (const fetch of failures) {
    const h = harness();
    const apiSandbox = { AbortController, setTimeout, clearTimeout, csrf: 'test-only', fetch };
    vm.runInNewContext(apiSource, apiSandbox);
    const inspection = h.deps.api;
    h.deps.api = path => path.endsWith('/interface') ? inspection(path) : apiSandbox.api(path, {});
    await rejectsWithState(h.run, 'unknown');
  }
});

test('success is marked written before guard, toast and controls failures', async () => {
  for (const fail of [
    h => { h.options.assertCurrent = () => { if (h.state.mutations) throw new Error('changed after save'); }; },
    h => { h.state.result.readiness = { issues: ['blocked'] }; h.deps.toast = () => { throw new Error('toast failed'); }; },
    h => { h.state.compiled.controls.map = () => { throw new Error('controls failed'); }; },
  ]) {
    const h = harness(); fail(h);
    await rejectsWithState(h.run, true, true);
    assert.equal(h.state.mutations, 1);
  }
});

test('conflict resolution failure and cancellation prove no write after first request', async () => {
  for (const stage of ['resolver', 'guard', 'repeat', 'cancel']) {
    const h = harness();
    h.state.onMutation = () => ({ requires_resolution: true, changes: { conflicts: [{ id: 'field' }] }, ...proof });
    if (stage === 'resolver') h.deps.resolveEditorConflicts = async () => { throw new Error('resolver failed'); };
    if (stage === 'guard') h.options.assertCurrent = () => { if (h.state.mutations) throw new Error('stale conflict'); };
    if (stage === 'cancel') h.deps.resolveEditorConflicts = async () => null;
    if (stage === 'cancel') assert.equal(await h.run(), null);
    else await rejectsWithState(h.run, false);
    assert.equal(h.state.mutations, stage === 'repeat' ? 2 : 1);
  }
});

test('second conflict mutation resets unknown, while proof rejection remains false and success becomes written', async () => {
  for (const phase of ['disconnect', 'proof', 'success-guard']) {
    const h = harness();
    h.state.onMutation = () => {
      if (h.state.mutations === 1) return { requires_resolution: true, changes: { conflicts: [] }, ...proof };
      if (phase === 'disconnect') throw new Error('second write disconnected');
      if (phase === 'proof') throw requestError(proof);
      return h.state.result;
    };
    if (phase === 'success-guard') h.options.assertCurrent = () => { if (h.state.mutations === 2) throw new Error('second saved, local guard failed'); };
    await rejectsWithState(h.run, phase === 'disconnect' ? 'unknown' : phase === 'proof' ? false : true, phase === 'success-guard');
    assert.equal(h.state.mutations, 2);
  }
});

test('configure endpoint uses the same persistence classification without a native compile', async () => {
  const h = harness({ compiled: null });
  h.state.onMutation = () => { throw requestError(proof); };
  await rejectsWithState(h.run, false);
  assert.equal(h.state.mutations, 1);
});

test('native app wrapper preflight guard errors remain unwritten with zero API calls', async () => {
  for (const phase of ['context', 'capture', 'fields', 'clone']) {
    const node = { id: 'node', data: { kind: 'package', editor_id: 'editor', package_id: 'package' } };
    let calls = 0;
    const sandbox = { configureWorkflowInterface, nativeSessionContexts: new WeakMap(), graph: { nodes: [node], edges: [] },
      getNode: () => phase === 'capture' ? null : node, currentCanvasIdentity: () => 'canvas', stableStringify: JSON.stringify,
      clone: value => { if (phase === 'clone') throw new Error('clone failed'); return structuredClone(value); },
      packageCatalog: { peek() { if (phase === 'fields') throw new Error('fields failed'); return { fields: [] }; } },
      editorConnectionSummary: () => [], api: async () => { calls++; }, toast() {}, chooseEditorInterface() {},
      autoEditorInterfaceSelection() {}, resolveEditorConflicts() {} };
    if (phase === 'context') sandbox.nativeSessionContexts.set(node, { assertCurrent() { throw Object.assign(new Error('context stale'), { persisted: true }); } });
    vm.runInNewContext(nativeGlue, sandbox);
    await rejectsWithState(() => sandbox.configureNativeInterface(node, { workflow: {}, output: {} }), false);
    assert.equal(calls, 0);
  }
});

test('native app wrapper never converts an unclassified delegated failure into unwritten', async () => {
  for (const expected of ['unclassified', false, true, 'unknown']) {
    const node = { id: 'node', data: { kind: 'package', editor_id: 'editor', package_id: 'package' } };
    const error = new Error('delegated failure'); if (expected !== 'unclassified') error.persisted = expected;
    const sandbox = { configureWorkflowInterface: async () => { throw error; }, nativeSessionContexts: new WeakMap(),
      graph: { nodes: [node], edges: [] }, getNode: () => node, currentCanvasIdentity: () => 'canvas', stableStringify: JSON.stringify,
      clone: structuredClone, packageCatalog: { peek: () => ({ fields: [] }) }, editorConnectionSummary: () => [],
      api() {}, toast() {}, chooseEditorInterface() {}, autoEditorInterfaceSelection() {}, resolveEditorConflicts() {}, completeInterfaceInputs() {} };
    vm.runInNewContext(nativeGlue, sandbox);
    await rejectsWithState(() => sandbox.configureNativeInterface(node, { workflow: {}, output: {} }),
      expected === 'unclassified' ? 'unknown' : expected, expected === true);
  }
});
