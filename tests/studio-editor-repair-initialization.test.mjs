import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { restoreStudioInitializationRepairs, initializeStudioEditorData, studioEditorRecord } from '../web/studio-editor-state.mjs';

const clone = value => structuredClone(value);
const backend = 'http://127.0.0.1:8188', editorId = `e-${'3'.repeat(24)}`, packageId = `p-${'1'.repeat(24)}`;
function fixture() {
  const fields = [
    { id: 'prefix', label: '文件名', node_id: '2', input: 'filename_prefix', type: 'text', default: 'video/test' },
    { id: 'format', label: '格式', node_id: '2', input: 'format', type: 'select', options: ['mp4'], default: 'mp4' },
    { id: 'codec', label: '编码', node_id: '2', input: 'format.codec', type: 'select', options: ['h264', 'av1'], default: 'h264' },
  ];
  const raw = { '1': { class_type: 'VideoSource', inputs: {} }, '2': { class_type: 'SaveVideo', inputs: {
    video: ['1', 0], filename_prefix: 'video/test', format: 'mp4' } } };
  const document = { version: 0.4, nodes: [{ id: 1, type: 'VideoSource', widgets_values: [] },
    { id: 2, type: 'SaveVideo', widgets_values: ['video/test', 'mp4'] }], links: [[1, 1, 0, 2, 0, 'VIDEO']] };
  const source = { id: 'codec', node_id: '2', input: 'format.codec', source: 'explicit_missing_input', origin_revision: 1, status: 'restored' };
  const compiled = { workflow: clone(document), output: clone(raw), controls: fields.slice(0, 2).map(field => ({
    node_id: '2', input: field.input, widget_node_id: '2', widget_name: field.input })) };
  const prompt = clone(raw); prompt['2'].inputs['format.codec'] = 'h264';
  const pack = { id: packageId, name: 'Repaired source', prompt: clone(prompt), fields: clone(fields) };
  const target = { data: { editor_id: editorId, package_id: packageId, editor_backend: backend,
    packageValues: { prefix: 'video/test', format: 'mp4', codec: 'av1' }, editor_baseline: {}, editor_controls: [] } };
  const workflow = { id: editorId, revision: 3, document: clone(document), repair_sources: [{ ...source, status: 'saved' }] };
  const session = { session_id: 'current-native-session', backend_url: backend };
  const response = { prompt: clone(prompt), fields: clone(fields), repair_sources: [clone(source)] };
  const calls = [], hooks = {};
  const context = { workflow, session, assertCurrent: async () => hooks.current?.(), compile: async () => hooks.compile?.() || clone(compiled),
    api: async (path, body) => { calls.push({ path, body: clone(body) }); await hooks.api?.(); return clone(response); } };
  return { target, pack, compiled, workflow, session, document, response, calls, hooks, context,
    verify: () => restoreStudioInitializationRepairs(target, compiled, context) };
}

test('fresh local restoration establishes an execution-only baseline without editing native source or external values', async () => {
  const h = fixture(), before = clone(h.target.data), native = clone(h.compiled);
  const executionOnly = await h.verify();
  assert.deepEqual(executionOnly, [{ id: 'codec', node_id: '2', input: 'format.codec', type: 'select' }]);
  assert.equal(h.calls[0].path, `/api/editor-workflows/${editorId}/interface`);
  assert.deepEqual(h.calls[0].body, { session_id: h.session.session_id, base_revision: 3,
    document: native.workflow, prompt: native.output, previous_package_id: packageId });
  const result = initializeStudioEditorData(h.target.data, h.pack, h.compiled);
  assert.deepEqual(result.editor_baseline, { prefix: 'video/test', format: 'mp4', codec: 'h264' });
  assert.deepEqual(result.packageValues, before.packageValues);
  assert.deepEqual(result.editor_controls, native.controls);
  assert.deepEqual(h.compiled, native); assert.deepEqual(h.target.data, before);
  const record = studioEditorRecord(result, 3);
  assert.equal(record.editor_controls.some(control => control.input === 'format.codec'), false);
  assert.equal(Object.hasOwn(record, 'session_id'), false); assert.equal(Object.hasOwn(record, 'repair_sources'), false);
  assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /无法确认/, 'a consumed receipt cannot be reused');
});

test('the currently restored choice can differ from the old package scalar and default', async () => {
  const h = fixture();
  h.response.prompt['2'].inputs['format.codec'] = 'av1';
  await h.verify();
  const result = initializeStudioEditorData(h.target.data, h.pack, h.compiled);
  assert.equal(result.editor_baseline.codec, 'av1');
  assert.equal(result.packageValues.codec, 'av1');
  assert.equal(h.pack.prompt['2'].inputs['format.codec'], 'h264');
  assert.equal(h.pack.fields[2].default, 'h264');
  assert.equal(Object.hasOwn(h.compiled.output['2'].inputs, 'format.codec'), false);
  assert.equal(result.editor_controls.some(control => control.input === 'format.codec'), false);
});

test('only a missing own outer key takes the freshly restored execution-only value', async () => {
  for (const value of [undefined, '', false, 0, 'h264']) {
    const h = fixture(); h.response.prompt['2'].inputs['format.codec'] = 'av1';
    if (value === undefined) delete h.target.data.packageValues.codec;
    else h.target.data.packageValues.codec = value;
    await h.verify();
    const result = initializeStudioEditorData(h.target.data, h.pack, h.compiled);
    assert.equal(result.editor_baseline.codec, 'av1');
    assert.equal(result.packageValues.codec, value === undefined ? 'av1' : value);
    assert.equal(result.packageValues.prefix, 'video/test');
    assert.equal(result.editor_controls.some(control => control.input === 'format.codec'), false);
  }
});

test('caller repair summaries, package defaults, copied receipts and persistent metadata never initialize a missing input', async () => {
  const h = fixture();
  h.compiled.repair_sources = clone(h.response.repair_sources);
  h.target.data.repair_sources = clone(h.response.repair_sources);
  assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /无法确认/);
  await h.verify();
  assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, clone(h.compiled)), /无法确认/);
  assert.throws(() => initializeStudioEditorData(clone(h.target.data), h.pack, h.compiled), /无法确认/);
});

for (const change of ['native document', 'raw prompt', 'control mapping']) {
  test(`native ${change} change during the HTTP read blocks initialization`, async () => {
    const h = fixture();
    h.hooks.compile = () => {
      const changed = clone(h.compiled);
      if (change === 'native document') changed.workflow.nodes[1].widgets_values[0] = 'new';
      if (change === 'raw prompt') changed.output['2'].inputs.filename_prefix = 'new';
      if (change === 'control mapping') changed.controls[0].widget_name = 'other';
      return changed;
    };
    await assert.rejects(h.verify(), /内部图或控件映射已变化/);
    assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /无法确认/);
  });
}

for (const change of ['target object', 'target values', 'source revision', 'backend', 'session']) {
  test(`${change} change while restoration is pending cannot attach the response`, async () => {
    const h = fixture();
    h.hooks.api = () => {
      if (change === 'target object') h.target.data = clone(h.target.data);
      if (change === 'target values') h.target.data.packageValues.codec = 'h264';
      if (change === 'source revision') h.workflow.revision++;
      if (change === 'backend') h.session.backend_url = 'http://127.0.0.1:8189';
      if (change === 'session') h.session.session_id = 'replacement-session';
    };
    await assert.rejects(h.verify(), /已变化/);
  });
}

test('in-place changes after verification invalidate the weak receipt before consumption', async () => {
  for (const change of ['compiled', 'data', 'revision', 'session']) {
    const h = fixture(); await h.verify();
    if (change === 'compiled') h.compiled.output['2'].inputs.filename_prefix = 'changed';
    if (change === 'data') h.target.data.packageValues.codec = 'h264';
    if (change === 'revision') h.workflow.revision++;
    if (change === 'session') h.session.session_id = 'replaced';
    assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /无法确认/);
  }
});

test('stale or absent service restoration does not bypass the original missing-input rejection', async () => {
  for (const status of ['stale', 'inactive', 'native_value_present', 'saved', 'absent']) {
    const h = fixture();
    h.response.prompt = clone(h.compiled.output);
    h.response.repair_sources = status === 'absent' ? [] : [{ ...h.response.repair_sources[0], status }];
    assert.deepEqual(await h.verify(), []);
    assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /无法确认/);
  }
});

test('changed execution content and malformed restoration bindings are rejected', async () => {
  const mutations = [
    h => { h.response.prompt['2'].inputs.filename_prefix = 'unrelated change'; },
    h => { h.response.prompt['2'].class_type = 'OtherSave'; },
    h => { h.response.repair_sources.push(clone(h.response.repair_sources[0])); },
    h => { h.response.fields[2].node_id = '1'; },
    h => { h.response.fields[2].type = 'audio'; },
    h => { h.response.prompt['2'].inputs['format.codec'] = null; },
    h => { h.response.prompt['2'].inputs['format.codec'] = 9007199254740992; },
  ];
  for (const mutate of mutations) {
    const h = fixture(); mutate(h); await assert.rejects(h.verify(), /补参/);
    assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /无法确认/);
  }
});

test('repair proof never relaxes widget requirements for unrelated or existing native controls', async () => {
  for (const mode of ['unmapped ordinary field', 'duplicate ordinary field', 'control for missing repair', 'duplicate repair control']) {
    const h = fixture();
    if (mode === 'unmapped ordinary field') h.compiled.controls.shift();
    if (mode === 'duplicate ordinary field') h.compiled.controls.push(clone(h.compiled.controls[0]));
    if (mode.includes('repair control') || mode === 'control for missing repair') {
      h.compiled.controls.push({ node_id: '2', input: 'format.codec', widget_node_id: '2', widget_name: 'codec' });
      if (mode === 'duplicate repair control') h.compiled.controls.push(clone(h.compiled.controls.at(-1)));
    }
    await h.verify();
    assert.throws(() => initializeStudioEditorData(h.target.data, h.pack, h.compiled), /控件映射|无法确认/);
  }
});

// Run the production native dialog with its established postMessage fixture.
const nativeSource = await readFile(new URL('./native-editor-projection.test.mjs', import.meta.url), 'utf8');
const nativeFixture = nativeSource.slice(0, nativeSource.indexOf('\ntest('))
  .replace("'../web/native-workflow-editor.mjs'", JSON.stringify(new URL('../web/native-workflow-editor.mjs', import.meta.url).href))
  + '\nexport { harness, button, elements };';
const { harness, button, elements } = await import(`data:text/javascript;base64,${Buffer.from(nativeFixture).toString('base64')}`);

const studioSource = await readFile(new URL('./studio-workflow-editor.test.mjs', import.meta.url), 'utf8');
const studioFixture = studioSource.slice(0, studioSource.indexOf('\ntest('))
  .replace("'../web/studio-workflow-editor.mjs'", JSON.stringify(new URL('../web/studio-workflow-editor.mjs', import.meta.url).href))
  .replace("'../web/studio-editor-state.mjs'", JSON.stringify(new URL('../web/studio-editor-state.mjs', import.meta.url).href))
  + '\nexport { harness as studioHarness, draft as studioDraft };';
const { studioHarness, studioDraft } = await import(`data:text/javascript;base64,${Buffer.from(studioFixture).toString('base64')}`);

test('the production studio adapter persists a newly restored outer value and retains it on the next entry', async () => {
  const h = fixture(); h.response.prompt['2'].inputs['format.codec'] = 'av1';
  let entries = 0;
  const studio = studioHarness({ initial: studioDraft({ values: { prefix: 'video/test', format: 'mp4' } }),
    apiOverride: path => path === `/api/editor-workflows/${editorId}` ? { ...h.workflow, document: clone(h.document) } : undefined,
    onOpen: async ({ target, adapter }) => {
      if (++entries === 1) {
        const compiled = clone(h.compiled);
        await restoreStudioInitializationRepairs(target, compiled, { ...h.context,
          assertCurrent: () => adapter.ensureInstance(target, h.workflow) });
        adapter.initializeTarget(target, compiled, { workflow: h.workflow });
        assert.equal(studio.state.draft.values.codec, 'av1');
        assert.equal(studio.state.draft.editorBindings[packageId].editor_baseline.codec, 'av1');
        assert.equal(studio.state.draft.editorBindings[packageId].initialized, true);
        assert.equal(target.data.packageValues.codec, 'av1');
      } else {
        assert.equal(adapter.needsInitialization(target), false);
        assert.equal(target.data.packageValues.codec, 'av1');
        assert.equal(target.data.editor_baseline.codec, 'av1');
      }
      assert.equal(target.data.editor_controls.some(control => control.input === 'format.codec'), false);
      await adapter.closed(target, { reason: 'cancelled' });
    } });
  studio.host.loadPackage = async () => clone(h.pack);
  await studio.controller.open(studio.context);
  await studio.controller.open(studio.context);
  assert.equal(entries, 2);
  assert.equal(Object.hasOwn(h.compiled.output['2'].inputs, 'format.codec'), false);
});

test('a failed studio commit does not attach or persist the newly restored execution-only value', async () => {
  const h = fixture(); h.response.prompt['2'].inputs['format.codec'] = 'av1';
  const studio = studioHarness({ initial: studioDraft({ values: { prefix: 'video/test', format: 'mp4' } }), failCommit: 2,
    onOpen: async ({ target, adapter }) => {
      const before = clone(target.data), compiled = clone(h.compiled);
      await restoreStudioInitializationRepairs(target, compiled, { ...h.context,
        assertCurrent: () => adapter.ensureInstance(target, h.workflow) });
      assert.throws(() => adapter.initializeTarget(target, compiled, { workflow: h.workflow }), /disk full/);
      assert.deepEqual(target.data, before);
      assert.equal(Object.hasOwn(studio.state.draft.values, 'codec'), false);
      assert.equal(studio.state.draft.editorBindings[packageId].initialized, false);
      await adapter.closed(target, { reason: 'cancelled' });
    } });
  studio.host.loadPackage = async () => clone(h.pack);
  await studio.controller.open(studio.context);
});

test('source-fork dialog restores before initialization and explains execution-only inputs without a widget patch', async () => {
  const h = harness(), source = { id: 'prompt', node_id: '1', input: 'text', source: 'explicit_missing_input', origin_revision: 1, status: 'saved' };
  const field = { id: 'prompt', node_id: '1', input: 'text', type: 'text', label: '台词' };
  const pack = { id: packageId, fields: [field], prompt: { '1': { class_type: 'TextNode', inputs: { text: 'restored base' } } } };
  h.workflow.repair_sources = [source]; Object.assign(h.node.data, { package_id: packageId, editor_backend: backend, editor_baseline: {} });
  h.host.needsInitialization = () => true;
  h.host.prepareSession = async () => ({ provenance: [], ownMedia: [], pending: [], assertCurrent() {} });
  h.host.fields = () => [field];
  h.hooks.bridgeAfter = (action, args, result) => {
    if (action === 'compile') { result.output['1'].inputs = {}; result.controls = []; }
    return result;
  };
  const api = h.host.api;
  h.host.api = async (path, payload) => {
    if (path.endsWith('/interface')) {
      h.calls.push({ kind: 'restore', payload: clone(payload) });
      const prompt = clone(payload.prompt); prompt['1'].inputs.text = 'restored base';
      return { prompt, fields: [field], repair_sources: [{ ...source, status: 'restored' }] };
    }
    return api(path, payload);
  };
  h.host.initializeTarget = (target, compiled) => { h.calls.push({ kind: 'initialize' }); target.data = initializeStudioEditorData(target.data, pack, compiled); };
  try {
    await h.open();
    assert.equal(button(h, '应用参数并返回').disabled, false);
    assert.deepEqual(h.node.data.editor_baseline, { prompt: 'restored base' });
    assert.equal(h.node.data.packageValues.prompt, 'own F'); assert.deepEqual(h.node.data.editor_controls, []);
    assert.ok(h.calls.findIndex(call => call.kind === 'restore') < h.calls.findIndex(call => call.kind === 'initialize'));
    assert.equal(h.calls.some(call => call.action === 'patch'), false);
    assert.ok(elements(h.body).some(item => /仅作为外层执行参数.*没有对应控件/.test(item.textContent)));
    await button(h, '应用参数并返回').click();
    const applied = h.calls.find(call => call.kind === 'apply');
    assert.deepEqual(applied.result.output['1'].inputs, {}, 'apply still submits raw native compile so server restores its overlay');
    assert.equal(h.value(), 'draft N');
  } finally { await h.restore(); }
});
