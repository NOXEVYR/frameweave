import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INTERFACE_FIELDS, INTERFACE_PAGE_SIZE, DEFAULT_INTERFACE_FIELDS } from '../web/interface-limits.mjs';
import { createNode, parseGraph, serializeGraph, generationPayload } from '../web/graph.mjs';
import { normalizeHiddenUpdates, mergeHiddenUpdates } from '../web/editor-hidden-updates.mjs';
import { applyEditorInterfaceGraph } from '../web/editor-canvas-interface.mjs';
import { planExecution, projectExecution } from '../web/execution-scope.mjs';
import { createEditorSessionProjection } from '../web/editor-session-projection.mjs';

const backend = 'http://127.0.0.1:8188';
const fields = count => Array.from({ length: count }, (_, index) => ({ id: `f${index}`, node_id: '1', input: `v${index}`, type: 'text', label: `参数 ${index}`, presentation: 'control' }));
const hidden = count => fields(count).map(({ presentation, ...field }) => ({ field, value: `新值 ${field.id}`, baseline: `原值 ${field.id}` }));
const graph = count => ({ nodes: [createNode('generation', 0, 0, { kind: 'package', package_id: 'p-capacity',
  packageFields: fields(count).map(({ node_id, input, ...field }) => field), packageValues: Object.fromEntries(fields(count).map(field => [field.id, `值 ${field.id}`])),
  inputLabels: Object.fromEntries(fields(count).map(field => [field.id, field.label])), editor_outputs: ['1'] })], edges: [] });

test('presentation defaults are independent from complete interface capacity', () => {
  assert.equal(MAX_INTERFACE_FIELDS, 4096);
  assert.equal(INTERFACE_PAGE_SIZE, 64); assert.equal(DEFAULT_INTERFACE_FIELDS, 64);
});

for (const count of [65, 256, 4096]) {
  test(`${count} cached fields and labels survive canvas, payload, execution and interface application`, async () => {
    const source = graph(count), before = structuredClone(source);
    const restored = parseGraph(serializeGraph(source));
    assert.equal(restored.nodes[0].data.packageFields.length, count);
    assert.deepEqual(restored.nodes[0].data.inputLabels, before.nodes[0].data.inputLabels);
    assert.deepEqual(generationPayload(restored, restored.nodes[0].id).values, before.nodes[0].data.packageValues);
    const execution = await planExecution(restored, [restored.nodes[0].id], backend, async () => ({ backend_url: backend,
      package_id: 'p-capacity', execution: { selected_outputs: ['1'], node_ids: ['1'], active_field_ids: fields(count).map(field => field.id) } }));
    assert.equal(execution.packages[restored.nodes[0].id].active_field_ids.length, count);
    assert.equal(projectExecution(restored, execution).nodes[0].data.packageFields.length, count);
    const applied = applyEditorInterfaceGraph(restored, restored.nodes[0].id, { package: { id: 'p-next', fields: fields(count) },
      values: before.nodes[0].data.packageValues, baseline: before.nodes[0].data.packageValues, backend_url: backend,
      output_nodes: ['1'], outputs: [{ id: '1', mediaType: 'image', label: '结果' }], controls: fields(count).map(field => ({
        node_id: '1', input: field.input, widget_node_id: '1', widget_name: field.input })) });
    assert.equal(applied.nodes[0].data.packageFields.length, count);
    assert.equal(applied.nodes[0].data.editor_controls.length, count);
    assert.deepEqual(source, before);
  });
  test(`${count} media owners and hidden scalar edits retain every record`, () => {
    const source = graph(count);
    source.nodes[0].data.packageFields = fields(count).map(field => ({ ...field, type: 'image' }));
    source.nodes[0].data.packageMediaBackends = Object.fromEntries(fields(count).map(field => [field.id, { name: `${field.id}.png`, backend }]));
    assert.equal(Object.keys(parseGraph(serializeGraph(source)).nodes[0].data.packageMediaBackends).length, count);
    const updates = hidden(count);
    assert.deepEqual(normalizeHiddenUpdates(updates), updates);
    assert.deepEqual(mergeHiddenUpdates([], updates, false, []), updates);
    source.nodes[0].data.editor_hidden_updates = updates;
    assert.deepEqual(parseGraph(serializeGraph(source)).nodes[0].data.editor_hidden_updates, updates);
  });
}

test('4097 fields, labels, owners, hidden records and execution fields reject without source changes', async () => {
  const source = graph(4097), before = structuredClone(source);
  assert.throws(() => parseGraph(serializeGraph(source)), /4096/);
  await assert.rejects(planExecution(source, [source.nodes[0].id], backend, async () => assert.fail('oversize graph must stop before planning')), /缓存字段/);
  for (const [key, value, pattern] of [['inputLabels', source.nodes[0].data.inputLabels, /端口名称/],
    ['packageMediaBackends', Object.fromEntries(fields(4097).map(field => [field.id, { name: `${field.id}.png`, backend }])), /来源/],
    ['editor_controls', fields(4097).map(field => ({ node_id: '1', input: field.input, widget_node_id: '1', widget_name: field.input })), /控件映射/],
    ['editor_hidden_updates', hidden(4097), /4096/]]) {
    const small = graph(1); small.nodes[0].data[key] = value;
    assert.throws(() => parseGraph(serializeGraph(small)), pattern);
  }
  assert.throws(() => normalizeHiddenUpdates(hidden(4097)), /4096/);
  const small = graph(4096);
  await assert.rejects(planExecution(small, [small.nodes[0].id], backend, async () => ({ backend_url: backend, package_id: 'p-capacity',
    execution: { selected_outputs: ['1'], node_ids: ['1'], active_field_ids: fields(4097).map(field => field.id) } })), /字段 ID/);
  assert.deepEqual(source, before);
});

test('old 64-field canvases retain exact schema and values through an unchanged round trip', () => {
  const old = graph(64), encoded = serializeGraph(old);
  assert.equal(serializeGraph(parseGraph(encoded), parseGraph(encoded).viewport), encoded);
});

test('larger input interfaces do not enlarge the independent output or API node budgets', async () => {
  const source = graph(4096), target = source.nodes[0].id;
  for (const execution of [
    { selected_outputs: ['1'], node_ids: Array.from({ length: 1001 }, (_, index) => String(index + 1)), active_field_ids: [] },
    { selected_outputs: Array.from({ length: 65 }, (_, index) => String(index + 1)), node_ids: Array.from({ length: 65 }, (_, index) => String(index + 1)), active_field_ids: [] },
  ]) await assert.rejects(planExecution(source, [target], backend, async () => ({ backend_url: backend, package_id: 'p-capacity', execution })), /节点 ID|输出 ID/);
});

function sessionFixture(count, { text = index => `C${index}`, invalidResponse = false } = {}) {
  const own = Object.fromEntries(fields(count).map((field, index) => [field.input, `N${index}`]));
  let values = structuredClone(own); const calls = [], saves = [];
  const controls = fields(count).map(field => ({ node_id: '1', input: field.input, widget_node_id: '1', widget_name: field.input }));
  const output = () => ({ '1': { class_type: 'Known', inputs: structuredClone(values) } });
  const provenance = fields(count).map((field, index) => ({ field_id: field.id, node_id: '1', input: field.input, class_type: 'Known',
    type: 'text', origin: 'connected', value: text(index) }));
  const request = async (action, args) => {
    calls.push({ action, args: structuredClone(args) });
    if (action === 'compile') return { workflow: { nodes: [{ id: 1, widgets_values: Object.values(values) }] }, output: output(), controls };
    if (action === 'snapshot') return { workflow: { nodes: [{ id: 1, widgets_values: Object.values(values) }] } };
    if (action === 'patch') {
      const next = structuredClone(values);
      for (const patch of args.patches) { assert.equal(next[patch.widget_name], patch.expected_value); next[patch.widget_name] = patch.value; }
      values = next;
      const applied = args.patches.map(patch => ({ node_id: patch.node_id, widget_name: patch.widget_name }));
      if (invalidResponse) applied[applied.length - 1] = applied[0];
      return { applied, unsupported: [] };
    }
    assert.fail(action);
  };
  const session = createEditorSessionProjection({ request, provenance, assertCurrent() {} });
  return { session, calls, own, saves, values: () => values, store: async clean => { saves.push(clean); return true; } };
}

for (const count of [65, 256, 4096]) test(`${count} connected scalar overlays initialize, persist own values and restore display completely`, async () => {
  const fixture = sessionFixture(count);
  await fixture.session.initialize();
  assert.equal(fixture.values()[`v${count - 1}`], `C${count - 1}`);
  const saved = await fixture.session.persist(fixture.store);
  assert.equal(saved.persisted, true); assert.equal(fixture.session.getState().locked, false);
  assert.deepEqual(fixture.saves[0].output['1'].inputs, fixture.own);
  assert.equal(fixture.values()[`v${count - 1}`], `C${count - 1}`);
  assert.deepEqual(fixture.calls.filter(call => call.action === 'patch').map(call => call.args.patches.length), [count, count, count]);
});

test('oversize projection and duplicate last patch acknowledgement cannot be saved', async () => {
  assert.throws(() => sessionFixture(4097), /有效输入映射/);
  const fixture = sessionFixture(4096, { invalidResponse: true });
  await assert.rejects(fixture.session.initialize(), error => error.code === 'patch_unverified');
  assert.equal(fixture.session.getState().locked, true);
  await assert.rejects(fixture.session.persist(fixture.store), error => error.code === 'session_locked');
  assert.equal(fixture.saves.length, 0);
});

test('UTF8 patch byte budget rejects a valid scalar batch before any native mutation', async () => {
  const fixture = sessionFixture(65, { text: () => '汉'.repeat(16000) });
  await assert.rejects(fixture.session.initialize(), error => error.code === 'patch_byte_limit');
  assert.deepEqual(fixture.values(), fixture.own);
  assert.equal(fixture.calls.some(call => call.action === 'patch'), false);
  assert.equal(fixture.saves.length, 0);
});
