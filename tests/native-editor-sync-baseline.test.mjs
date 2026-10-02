import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Exercise the actual native editor lifecycle and actual application glue.
// The bridge and HTTP service are isolated; no jobs or local service are used.
const fixtureSource = await readFile(new URL('./native-editor-projection.test.mjs', import.meta.url), 'utf8');
const fixture = fixtureSource.slice(0, fixtureSource.indexOf('\ntest('))
  .replace("'../web/native-workflow-editor.mjs'", JSON.stringify(new URL('../web/native-workflow-editor.mjs', import.meta.url).href))
  .replace("executionId = '1'", "executionId = '1', inputName = 'text'")
  .replace("const input = mediaType || 'text'", 'const input = mediaType || inputName')
  .replace('error = failure.message; errors.push(failure);', 'error = failure.message; if (failure.result) result = failure.result; errors.push(failure);')
  + '\nexport { harness, button, drafts };';
const { harness, button, drafts } = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`);
const appSource = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const glue = appSource.slice(appSource.indexOf('function captureNativeInterfaceTarget('), appSource.indexOf('async function configureNativePanel('));
const copy = value => structuredClone(value);

function setup({ native = 15, baseline = 15, outer = 14, executionId = '1', input = 'duration', connected = false, hidden = false } = {}) {
  const h = harness({ native, baseline, fallback: outer, executionId, inputName: input, supportsMapping: true });
  const field = { id: 'prompt', node_id: executionId, input, label: input, type: input === 'seed' ? 'integer' : 'number' };
  h.node.data.kind = 'package'; h.node.data.package_id = 'package'; h.node.data.packageFields = hidden ? [] : [field];
  h.node.data.editor_controls = [{ node_id: executionId, input, widget_node_id: executionId, widget_name: input }];
  if (hidden) { h.node.data.editor_hidden_updates = [{ field, value: outer, baseline }]; h.node.data.packageValues = {}; h.node.data.editor_baseline = {}; }
  if (!connected) h.provenance.splice(0);
  else Object.assign(h.provenance[0], { type: field.type, value: 13 });
  h.host.fields = () => [field];
  h.host.syncOuterValues = (node, updates) => {
    if (hidden) node.data.editor_hidden_updates[0].value = updates.prompt;
    else Object.assign(node.data.packageValues, updates);
  };
  const requests = [], options = [], selections = [];
  const sandbox = {
    graph: { nodes: [h.node], edges: [] }, nativeSessionContexts: new WeakMap(),
    currentCanvasIdentity: () => 'canvas', stableStringify: JSON.stringify, clone: copy,
    getNode: id => sandbox.graph.nodes.find(node => node.id === id), generationInputPorts: () => [],
    packageCatalog: { peek: () => ({ fields: hidden ? [] : [field] }) }, editorConnectionSummary: () => [],
    autoEditorInterfaceSelection: () => ({ fields: [field], output_nodes: [], rebindings: {} }),
    chooseEditorInterface: async selection => { selections.push(copy(selection)); return { fields: [field], output_nodes: [], rebindings: {} }; },
    resolveEditorConflicts: async () => ({ prompt: 'inner' }), toast() {},
    async api(path, payload) {
      requests.push({ path, payload: copy(payload) });
      if (path.endsWith('/interface')) return { fields: [field], outputs: [] };
      // Isolate HTTP only. The old-baseline behavior reproduces the original
      // failure: outer B is retained when inner A equals baseline A.
      const inner = payload.prompt[executionId].inputs[input], previous = payload.previous_values.prompt;
      const value = previous !== undefined && !Object.is(previous, payload.previous_baseline.prompt) &&
        Object.is(inner, payload.previous_baseline.prompt) ? previous : inner;
      return { package: { id: 'applied', fields: [field] }, values: { prompt: value }, baseline: { prompt: inner } };
    },
  };
  vm.runInNewContext(glue, sandbox);
  h.host.applyInterface = (node, compiled, session, config) => {
    options.push(copy(config)); return sandbox.configureNativeInterface(node, compiled, session, config);
  };
  h.host.applied = (_node, result) => { h.node.data.packageValues = copy(result.values); h.node.data.editor_baseline = copy(result.baseline); };
  return Object.assign(h, { field, requests, options, selections, sandbox, applyPayload: () => requests.find(item => item.path.endsWith('/apply'))?.payload });
}

for (const executionId of ['1', '6:4']) {
  for (const [input, a, b] of [['duration', 15, 14], ['seed', 20261002, 20261003]]) {
    test(`${executionId} ${input}: A to outer B to synchronized B to inner A reaches real host application as A`, async () => {
      const h = setup({ executionId, input, native: a, baseline: a, outer: b }), before = copy(h.node.data);
      try {
        await h.open(); assert.equal(h.value(), b); assert.deepEqual(h.node.data, before);
        h.setValue(a); await button(h, '应用参数并返回').click();
        assert.equal(h.applyPayload().previous_baseline.prompt, b);
        assert.equal(h.applyPayload().previous_values.prompt, b);
        assert.equal(h.node.data.packageValues.prompt, a); assert.equal(h.node.data.editor_baseline.prompt, a);
        assert.equal(h.editor.isOpen(), false);
        assert.equal(h.requests.some(item => /jobs|generate|\/prompt/.test(item.path)), false);
        assert.equal(h.applyPayload().syncBaseline, undefined); assert.equal(h.applyPayload().automatic, undefined);
      } finally { await h.restore(); }
    });
  }
}

for (const label of ['保存内部草稿', '← 返回画布', '放弃未保存修改并返回']) {
  test(`${label} never advances the persisted baseline or writes session state into the draft`, async () => {
    const h = setup(), before = copy(h.node.data);
    try {
      await h.open(); await button(h, label).click();
      assert.deepEqual(h.node.data, before); assert.equal(h.requests.length, 0);
      assert.equal(JSON.stringify(drafts(h)).includes('syncBaseline'), false);
      if (label !== '放弃未保存修改并返回') assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 14);
    } finally { await h.restore(); }
  });
}

test('connected C remains display-only while the clean own B is the application merge baseline', async () => {
  const h = setup({ connected: true });
  try {
    await h.open(); assert.equal(h.value(), 13);
    h.setValue(15); await button(h, '应用参数并返回').click();
    assert.equal(h.applyPayload().prompt['1'].inputs.duration, 15);
    assert.equal(h.applyPayload().previous_baseline.prompt, 14);
    assert.equal(h.applyPayload().previous_values.prompt, 14);
    assert.equal(h.node.data.packageValues.prompt, 15);
    assert.equal(h.options[0].syncBaseline[0].value, 14);
  } finally { await h.restore(); }
});

for (const choice of ['inner', 'outer']) test(`entry conflict ${choice} choice establishes only the confirmed value as session baseline`, async () => {
  const h = setup({ native: 16 }), chosen = choice === 'inner' ? 16 : 14;
  let first = true;
  h.host.resolveConflicts = async () => ({ 0: choice });
  h.hooks.bridgeBefore = action => {
    if (action === 'patch' && first) {
      first = false; throw Object.assign(new Error('conflict'), { result: { applied: [], unsupported: [{ index: 0, reason: 'conflict', current_value: 16 }] } });
    }
  };
  try {
    await h.open(); assert.equal(h.value(), chosen); assert.equal(h.node.data.editor_baseline.prompt, 15);
    h.setValue(15); await button(h, '应用参数并返回').click();
    assert.equal(h.applyPayload().previous_baseline.prompt, chosen);
    assert.equal(h.applyPayload().previous_values.prompt, chosen); assert.equal(h.node.data.packageValues.prompt, 15);
  } finally { await h.restore(); }
});

test('hidden pending synchronization carries its own session baseline without adding a runnable canvas value', async () => {
  const h = setup({ hidden: true }), before = copy(h.node.data);
  try {
    await h.open(); assert.equal(h.value(), 14); assert.deepEqual(h.node.data, before);
    h.setValue(15); await button(h, '应用参数并返回').click();
    assert.equal(h.applyPayload().previous_baseline.prompt, 14);
    assert.deepEqual(h.applyPayload().previous_values, {});
  } finally { await h.restore(); }
});

for (const drift of ['widget', 'class', 'ambiguous binding', 'shared target']) test(`${drift} during apply conservatively retains the persisted merge base`, async () => {
  const h = setup(); let compiling = 0;
  h.hooks.bridgeAfter = (action, _message, result) => {
    if (action === 'compile' && ++compiling === 2) {
      if (drift === 'widget') result.controls[0].widget_name = 'other';
      if (drift === 'class') result.output['1'].class_type = 'Other';
      if (drift === 'ambiguous binding') result.controls.push(copy(result.controls[0]));
      if (drift === 'shared target') result.controls.push({ ...result.controls[0], input: 'other' });
    }
    return result;
  };
  try {
    await h.open(); h.setValue(15); await button(h, '应用参数并返回').click();
    assert.equal(h.options[0].syncBaseline[0].value, 14);
    assert.equal(h.applyPayload().previous_baseline.prompt, 15);
    assert.equal(h.node.data.packageValues.prompt, 14);
  } finally { await h.restore(); }
});

test('an unproven entry compile never promotes an outer override into a session baseline', async () => {
  const h = setup(); let first = true;
  h.hooks.bridgeAfter = (action, _message, result) => {
    if (action === 'compile' && first) { first = false; result.controls = []; }
    return result;
  };
  try {
    await h.open(); h.setValue(15); await button(h, '应用参数并返回').click();
    assert.equal(h.options[0].syncBaseline, undefined); assert.equal(h.applyPayload().previous_baseline.prompt, 15);
  } finally { await h.restore(); }
});

for (const otherValue of [14, 15]) test(`multiple API inputs sharing one target (other=${otherValue}) are not assigned an inferred synchronization base`, async () => {
  const h = setup();
  const other = { ...h.field, id: 'other', input: 'other' };
  h.host.fields = () => [h.field, other];
  h.node.data.packageValues.other = otherValue; h.node.data.editor_baseline.other = 15;
  h.node.data.editor_controls.push({ ...h.node.data.editor_controls[0], input: 'other' });
  try {
    await h.open(); assert.equal(h.value(), 15); assert.equal(h.calls.some(item => item.action === 'patch'), false);
    await button(h, '应用参数并返回').click();
    assert.equal(h.options[0].syncBaseline, undefined); assert.equal(h.applyPayload().previous_baseline.prompt, 15);
  } finally { await h.restore(); }
});

test('source changes during the awaited verification cannot establish or apply a stale session baseline', async () => {
  const h = setup();
  h.hooks.bridgeAfter = (action, _message, result) => { if (action === 'compile') h.setCurrent(false); return result; };
  try {
    await h.open(); await button(h, '应用参数并返回').click();
    assert.equal(h.requests.length, 0); assert.equal(h.node.data.editor_baseline.prompt, 15);
  } finally { await h.restore(); }
});

test('session payload allowlist excludes arbitrary options and mapping receipts are never persisted', async () => {
  const h = setup();
  try {
    const compiled = { workflow: {}, output: { 1: { class_type: 'TextNode', inputs: { duration: 15 } } },
      controls: [{ ...h.node.data.editor_controls[0], mapping_receipt: 'temporary', media_receipt: 'temporary-media' }] };
    const result = await h.sandbox.configureNativeInterface(h.node, compiled,
      { session_id: 'session', base_revision: 7, syncBaseline: { prompt: 999 }, arbitrary: true });
    assert.equal(h.applyPayload().syncBaseline, undefined); assert.equal(h.applyPayload().arbitrary, undefined);
    assert.equal(h.applyPayload().previous_baseline.prompt, 15);
    assert.equal(result.controls[0].mapping_receipt, undefined); assert.equal(result.controls[0].media_receipt, undefined);
    assert.equal(compiled.controls[0].mapping_receipt, 'temporary');
  } finally { await h.restore(); }
});
