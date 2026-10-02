import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNodeActionPress } from '../web/node-action-press.mjs';

// Execute the real app glue with isolated dependencies instead of asserting source strings.
const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const glue = appSource.slice(appSource.indexOf('function captureNativeInterfaceTarget('),
  appSource.indexOf('async function configureNativePanel('));
function harness() {
  const node = { id: 'node-1', data: { kind: 'package', editor_id: 'editor-1', package_id: 'package-1', packageValues: {} } };
  const selection = { fields: [], output_nodes: ['out'], rebindings: {}, output_rebindings: {} };
  const result = { package: { id: 'new-package', fields: [] }, values: {}, baseline: {}, output_nodes: ['out'] };
  const state = { identity: 'canvas-1', node, result, selection };
  const sandbox = {
    graph: { nodes: [node], edges: [] }, packages: [], calls: [], nativeSessionContexts: new WeakMap(),
    stableStringify: JSON.stringify, clone: structuredClone, currentCanvasIdentity: () => state.identity,
    getNode: id => sandbox.graph.nodes.find(item => item.id === id),
    generationInputPorts: () => [], editorConnectionSummary: () => [],
    autoEditorInterfaceSelection: () => selection, chooseEditorInterface: async () => selection,
    resolveEditorConflicts: async () => ({ field: 'outer' }), toast() {},
    async api(path, payload) {
      sandbox.calls.push({ path, payload });
      if (path.endsWith('/interface')) return { fields: [], outputs: [{ id: 'out' }] };
      if (state.onApply) return state.onApply();
      return result;
    },
  };
  sandbox.packageCatalog = { peek: id => sandbox.packages.find(pack => pack.id === id) };
  vm.runInNewContext(glue, sandbox);
  return { sandbox, state, node, compiled: { workflow: {}, output: {} } };
}

test('native application rejects a changed canvas, replacement node, edited parameter or modified connection after request', async () => {
  const changes = [
    h => { h.state.identity = 'canvas-2'; },
    h => { h.sandbox.graph.nodes = [structuredClone(h.node)]; },
    h => { h.node.data.title = 'Changed'; },
    h => { h.sandbox.graph.edges.push({ id: 'new-edge', source: 'a', target: h.node.id }); },
  ];
  for (const change of changes) {
    const h = harness();
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    h.state.onApply = async () => { entered(); await gate; return h.state.result; };
    const applying = h.sandbox.configureNativeInterface(h.node, h.compiled, { session_id: 'session' }, { automatic: true });
    await started; change(h); release();
    await assert.rejects(applying, /画布、节点或连线已变化/);
    assert.equal(h.node.data.package_id, 'package-1');
  }
});

test('native guard checks again after conflict selection before another write', async () => {
  const h = harness();
  h.state.onApply = () => ({ requires_resolution: true, changes: { conflicts: [{ id: 'field' }] } });
  h.sandbox.resolveEditorConflicts = async () => { h.state.identity = 'other-canvas'; return { field: 'outer' }; };
  await assert.rejects(h.sandbox.configureNativeInterface(h.node, h.compiled), /画布、节点或连线已变化/);
  assert.equal(h.sandbox.calls.filter(call => call.path.endsWith('/apply')).length, 1);
});

test('native guard accepts a cloned editor draft but pins the actual target and can reject a later stale application', async () => {
  const h = harness();
  const result = await h.sandbox.configureNativeInterface(structuredClone(h.node), h.compiled);
  assert.equal(result._canvas_guard.node, h.node);
  assert.doesNotThrow(() => h.sandbox.assertNativeInterfaceTarget(result._canvas_guard));
  h.node.data.packageValues.new_value = 42;
  assert.throws(() => h.sandbox.assertNativeInterfaceTarget(result._canvas_guard), /画布、节点或连线已变化/);
});

test('native host includes hidden controls and keeps hidden conflict choices out of runnable package values', () => {
  const field = { id: 'hidden-width', label: 'Width', node_id: '1', input: 'width', type: 'integer' };
  const node = { data: { package_id: 'pack', packageValues: { visible: 'keep' },
    editor_hidden_updates: [{ field, value: 77, baseline: 10 }] } };
  const sandbox = { packages: [{ id: 'pack', fields: [{ id: 'visible' }] }], mutate: callback => callback(),
    nativeSessionContexts: new WeakMap(), nativeSyncTargets: new WeakMap(), captureNativeInterfaceTarget: node => ({ node }), assertNativeInterfaceTarget() {} };
  sandbox.packageCatalog = { peek: id => sandbox.packages.find(pack => pack.id === id) };
  const hostGlue = appSource.slice(appSource.indexOf('  fields: node =>'), appSource.indexOf('  resolveConflicts:'));
  vm.runInNewContext(`this.host = ({${hostGlue}});`, sandbox);
  assert.deepEqual([...sandbox.host.fields(node)].map(item => item.id), ['visible', 'hidden-width']);
  sandbox.host.syncOuterValues(node, { 'hidden-width': 12, visible: 'new visible' });
  assert.deepEqual(JSON.parse(JSON.stringify(node.data.packageValues)), { visible: 'new visible' });
  assert.equal(node.data.editor_hidden_updates[0].value, 12);
  assert.equal(node.data.editor_hidden_updates[0].baseline, 10);
  sandbox.packages[0].fields = Array.from({ length: 64 }, (_, i) => ({ id: `visible-${i}` }));
  assert.equal(sandbox.host.fields(node).length, 65, 'complete synchronization candidates retain hidden fields beyond visible interface capacity');
});

test('native application retains direct source witnesses when their data or object identity changes', async () => {
  for (const replace of [false, true]) {
    const h = harness(), source = { id: 'prompt', type: 'prompt', data: { text: 'before' } };
    h.sandbox.graph.nodes.push(source); h.sandbox.graph.edges.push({id:'edge',source:source.id,target:h.node.id,targetField:'text'});
    h.state.onApply = () => {
      if (replace) h.sandbox.graph.nodes[1] = structuredClone(source);
      else source.data.text = 'after';
      return h.state.result;
    };
    await assert.rejects(h.sandbox.configureNativeInterface(h.node, h.compiled), /画布、节点或连线已变化/);
  }
});

test('configure uses the existing session witness before capturing a new interface guard', async () => {
  const h = harness();
  h.sandbox.nativeSessionContexts.set(h.node, { assertCurrent() { throw new Error('direct source changed before configuration'); } });
  await assert.rejects(h.sandbox.configureNativeInterface(h.node, h.compiled), /direct source changed/);
  assert.equal(h.sandbox.calls.length, 0);
});

test('connected merge resolutions stay separate from stored fallback and baseline', async () => {
  const h = harness(); h.node.data.packageValues = {text:'fallback'}; h.node.data.editor_baseline = {text:'baseline'};
  h.compiled.connected_resolutions = {text:'internal'};
  await h.sandbox.configureNativeInterface(h.node, h.compiled);
  const payload = h.sandbox.calls.find(item=>item.path.endsWith('/apply')).payload;
  assert.deepEqual(payload.connected_resolutions, {text:'internal'});
  assert.deepEqual(payload.previous_values, {text:'fallback'}); assert.deepEqual(payload.previous_baseline, {text:'baseline'});
});

test('media conflict invalidation survives apply while ephemeral bridge receipts are not persisted', async () => {
  const h=harness();
  h.compiled.connected_resolutions=[{field_id:'image',choice:'inner',media_owner_invalidated:true},{field_id:'audio',choice:'native',media_owner_invalidated:true}];
  h.compiled.controls=[{node_id:'1',input:'image',widget_node_id:'1',widget_name:'image',media_receipt:'ephemeral'}];
  const result=await h.sandbox.configureNativeInterface(h.node,h.compiled);
  assert.deepEqual(Array.from(result.invalidated_media_fields),['image']);
  assert.equal(result.controls[0].media_receipt,undefined); assert.equal(h.compiled.controls[0].media_receipt,'ephemeral');
});

test('interface inspection sends the persisted previous package identity for both native and compiled flows', async () => {
  for (const compiled of [null, {workflow:{},output:{}}]) {
    const h=harness();
    await h.sandbox.configureNativeInterface(h.node,compiled);
    const payload=h.sandbox.calls.find(item=>item.path.endsWith('/interface')).payload;
    assert.equal(payload.previous_package_id,'package-1');assert.equal(payload.previousFields,undefined);
  }
  const h=harness();delete h.node.data.package_id;
  await h.sandbox.configureNativeInterface(h.node,h.compiled);
  assert.equal(h.sandbox.calls.find(item=>item.path.endsWith('/interface')).payload.previous_package_id,null);
});

test('card button keeps its target stable through pointerdown and runs its first click once', async () => {
  const listeners = new Map(), calls = [];
  const node = {id:'clicked'},card = { dataset: { nodeId: 'clicked' }, _node: node };
  const element = { closest: selector => selector === '.node' ? card : null, addEventListener: (name, fn) => listeners.set(name, fn) };
  const sandbox = { el: () => element, spaceDown: false, tool: 'select', selected: new Set(),
    reportError: error => { throw error; }, revealInspector: () => calls.push('reveal'),
    renderSelection: () => calls.push('select'), renderInspector: () => calls.push('render'), switchTab() {},renderNodes() {},
    nodeActionPress:createNodeActionPress({isCurrent:actual=>actual===node}) };
  const source = appSource.slice(appSource.indexOf('function button('), appSource.indexOf('function bind('));
  vm.runInNewContext(source, sandbox);
  sandbox.button('Manage', '', () => calls.push('action'));
  let stopped = 0;
  listeners.get('pointerdown')({ button: 0, stopPropagation: () => stopped++ });
  assert.equal(stopped, 1); assert.deepEqual(calls, []);
  listeners.get('click')({ stopPropagation() {} });
  await Promise.resolve();
  assert.equal(calls.filter(item => item === 'action').length, 1);
  assert.deepEqual([...sandbox.selected], ['clicked']);
  sandbox.spaceDown = true;
  listeners.get('pointerdown')({ button: 0, stopPropagation: () => stopped++ });
  assert.equal(stopped, 1);
});
