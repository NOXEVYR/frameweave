import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect, canConnect, generationPayload, serializeGraph, parseGraph, duplicateNodes, removeEdges } from '../web/graph.mjs';
import { textContributionIdentity, recordTextContribution } from '../web/text-input-composition.mjs';
import { projectEditorInputs } from '../web/editor-preparation.mjs';
import { planExecution, projectExecution } from '../web/execution-scope.mjs';
import { configurationBundle } from '../web/workflow-configurations.mjs';
import { applyEditorInterfaceGraph } from '../web/editor-canvas-interface.mjs';
import { createWorkflowRunner } from '../web/workflow-runner.mjs';
import { preparePresetEditGraph } from '../web/preset-edit-graph.mjs';
import { collectPresetEditRequest } from '../web/preset-edit-request.mjs';

const backend = 'http://127.0.0.1:8188';
const fields = [{ id: 'neg', label: '负向', type: 'text', node_id: '1', input: 'text' }, { id: 'extra', label: '其它', type: 'text', node_id: '2', input: 'text' }];
const context = { sourceType: 'prompt', fieldType: 'text', composition: 'comma' };
function fixture() {
  const a = { ...createNode('prompt', 0, 0, { text: 'A', negative: 'NEG A' }), id: 'a' };
  const b = { ...createNode('prompt', 0, 0, { text: 'B', negative: 'NEG B' }), id: 'b' };
  const target = { ...createNode('generation', 100, 100, { kind: 'package', package_id: 'p-0123456789abcdef01234567',
    packageFields: fields, packageValues: { neg: 'OWN', extra: '' }, packageTextCompositions: { neg: 'comma', extra: 'paragraphs' } }), id: 'target' };
  const graph = { nodes: [a, b, target], edges: [
    { id: 'first', source: 'a', target: 'target', targetField: 'neg', sourceField: 'negative' },
    { id: 'middle', source: 'b', target: 'target', targetField: 'neg', sourceField: 'negative' },
    { id: 'second', source: 'a', target: 'target', targetField: 'neg', sourceField: 'negative', sourceOccurrence: 1 },
  ] };
  return { graph, a, b, target };
}
const projection = graph => projectEditorInputs(graph, 'target', { fields, backend, canvasId: 'c' });
async function planned(graph, api = () => {}) {
  return planExecution(graph, ['target'], backend, async (path, body) => {
    api(path, body);
    return { backend_url: backend, package_id: graph.nodes.find(n => n.id === 'target').data.package_id,
      execution: { selected_outputs: ['1'], node_ids: ['1'], active_field_ids: ['neg'] } };
  });
}

test('implicit and explicit occurrence zero share one identity; positive occurrences are independent', () => {
  const edge = fixture().graph.edges[0], explicit = { ...edge, sourceOccurrence: 0 };
  assert.equal(textContributionIdentity(edge, context), textContributionIdentity(explicit, context));
  assert.notEqual(textContributionIdentity(edge, context), textContributionIdentity({ ...edge, sourceOccurrence: 1 }, context));
  const seen = new Set(); recordTextContribution(seen, edge, context);
  assert.throws(() => recordTextContribution(seen, explicit, context), /身份/);
});

test('generation and editor projection preserve repeated text contributions and separate stored fallback', () => {
  const { graph, target } = fixture(), before = structuredClone(graph), payload = generationPayload(graph, 'target'), projected = projection(graph);
  assert.equal(payload.values.neg, 'NEG A, NEG B, NEG A, OWN'); assert.deepEqual(projected.pending, []);
  const value = projected.overrides.find(item => item.field_id === 'neg'); assert.equal(value.value, payload.values.neg);
  assert.deepEqual(value.edge_ids, ['first', 'middle', 'second']); assert.equal(value.stored_fallback, 'OWN');
  assert.equal(target.data.packageValues.neg, 'OWN'); assert.deepEqual(graph, before);
});

test('ordinary dragging cannot add an accidental repeated source, including after first occurrence is removed', () => {
  const { graph } = fixture(); const options = { targetField: 'neg', sourceField: 'negative' };
  assert.equal(canConnect(graph, 'a', 'target', options).ok, false);
  assert.equal(canConnect(graph, 'a', 'target', { ...options, sourceOccurrence: 0 }).ok, false);
  assert.equal(canConnect(graph, 'a', 'target', { ...options, sourceOccurrence: 1 }).ok, false);
  assert.equal(canConnect(graph, 'a', 'target', { ...options, sourceOccurrence: 2 }).ok, true);
  removeEdges(graph, ['first']); assert.equal(graph.edges.find(item => item.id === 'second').sourceOccurrence, 1);
  assert.equal(canConnect(graph, 'a', 'target', options).ok, false);
  assert.equal(generationPayload(graph, 'target').values.neg, 'NEG B, NEG A, OWN');
});

test('occurrence gaps and edge reordering retain IDs, respect graph order, and never renumber', () => {
  const { graph } = fixture(); graph.edges[2].sourceOccurrence = 2000;
  graph.edges = [graph.edges[2], graph.edges[0], graph.edges[1]];
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.edges.map(edge => [edge.id, edge.sourceOccurrence]), [['second', 2000], ['first', undefined], ['middle', undefined]]);
  assert.equal(generationPayload(restored, 'target').values.neg, 'NEG A, NEG A, NEG B, OWN');
});

test('fanout uses independent target-field identities and retains duplicate occurrence for every field', () => {
  const { graph } = fixture();
  graph.edges.push(...graph.edges.filter(edge => edge.source === 'a').map(edge => ({ ...edge, id: `${edge.id}-fanout`, targetField: 'extra' })));
  const values = generationPayload(graph, 'target').values;
  assert.equal(values.extra, 'NEG A\n\nNEG A'); assert.equal(values.neg, 'NEG A, NEG B, NEG A, OWN');
  assert.deepEqual(projection(graph).pending, []);
});

test('real legacy plus explicit negative preset migration assigns independent fanout occurrence identities', () => {
  const a = { ...createNode('prompt', 0, 0, { text: 'SOURCE', negative: 'NEG A' }), id: 'a' };
  const target = { ...createNode('generation', 0, 0, { kind: 'sdxl', positive: 'OWN P', negative: 'OWN N' }), id: 'target' };
  const graph = { nodes: [a, target], edges: [{ id: 'legacy', source: 'a', target: 'target' },
    { id: 'explicit', source: 'a', target: 'target', sourceField: 'negative', targetField: 'negative' }] };
  const collected = collectPresetEditRequest(graph, 'target', { backend });
  const candidate = (id, node_id) => ({ id, node_id, input: 'text', type: 'text', label: id });
  const actual = [candidate('pos', '1'), candidate('neg_one', '2'), candidate('neg_two', '3')];
  const prepared = { backend_url: backend, receipt_complete: true, source_request: collected.preset_request,
    source_document: { prompt: { '1': { class_type: 'Text', inputs: { text: 'OWN P' } },
      '2': { class_type: 'Text', inputs: { text: 'OWN N' } }, '3': { class_type: 'Text', inputs: { text: 'OWN N' } } } },
    fields: actual, receipt: [ { logical_id: 'positive', type: 'text', targets: [{ node_id: '1', input: 'text', type: 'text' }] },
      { logical_id: 'negative', type: 'text', targets: [{ node_id: '2', input: 'text', type: 'text' }, { node_id: '3', input: 'text', type: 'text' }] } ], outputs: [], pending: [] };
  const before = structuredClone(graph), expected = generationPayload(graph, 'target');
  const shadow = preparePresetEditGraph(graph, 'target', prepared, collected); shadow.target.data.package_id = 'p-0123456789abcdef01234567';
  const payload = generationPayload(shadow.graph, 'target');
  assert.equal(payload.values.pos, expected.positive); assert.equal(payload.values.neg_one, expected.negative); assert.equal(payload.values.neg_two, expected.negative);
  assert.equal(expected.negative, 'NEG A, NEG A, OWN N'); assert(shadow.graph.edges.some(edge => edge.id === 'legacy')); assert(shadow.graph.edges.some(edge => edge.id === 'explicit'));
  for (const field of ['neg_one', 'neg_two']) assert.deepEqual(shadow.graph.edges.filter(edge => edge.targetField === field).map(edge => edge.sourceOccurrence ?? 0), [0, 1]);
  const projection = projectEditorInputs(shadow.graph, 'target', { fields: actual, backend, canvasId: 'c' });
  assert.deepEqual(projection.pending, []); assert.equal(projection.overrides.find(item => item.field_id === 'neg_two').value, expected.negative);
  assert.deepEqual(graph, before); assert.equal(shadow.target.data.packageValues.neg_two, 'OWN N');
});

test('serialization, duplication and rebind preserve occurrence metadata through v2', () => {
  const { graph, target } = fixture(), raw = JSON.parse(serializeGraph(graph)); assert.equal(raw.schema, 'frameweave.canvas.v2');
  assert.throws(() => parseGraph({ ...raw, schema: 'frameweave.canvas.v1' }), /v2/);
  const restored = parseGraph(raw), ids = duplicateNodes(restored, ['a', 'b', 'target']);
  const copiedTarget = restored.nodes.find(item => ids.includes(item.id) && item.type === 'generation');
  assert.equal(restored.edges.filter(item => item.target === copiedTarget.id).find(item => item.sourceOccurrence === 1).sourceOccurrence, 1);
  assert.equal(generationPayload(restored, copiedTarget.id).values.neg, 'NEG A, NEG B, NEG A, OWN');
  const next = fields.map(field => ({ ...field, id: `new_${field.id}` }));
  const rebound = applyEditorInterfaceGraph(graph, 'target', { package: { id: target.data.package_id, fields: next },
    values: { new_neg: 'OWN', new_extra: '' }, baseline: {}, backend_url: backend, outputs: [], output_nodes: [], rebindings: { neg: 'new_neg', extra: 'new_extra' } });
  assert.equal(rebound.edges.find(item => item.id === 'second').sourceOccurrence, 1);
  assert.equal(generationPayload(rebound, 'target').values.new_neg, 'NEG A, NEG B, NEG A, OWN');
});

test('schema guard also rejects explicit occurrence zero in v1 and malformed occurrence without a composition', () => {
  const f = fixture(); f.graph.edges = [{ ...f.graph.edges[0], sourceOccurrence: 0 }];
  const raw = JSON.parse(serializeGraph(f.graph)); assert.throws(() => parseGraph({ ...raw, schema: 'frameweave.canvas.v1' }), /v2/);
  delete f.target.data.packageTextCompositions; assert.throws(() => parseGraph(serializeGraph(f.graph)), /拼接规则/);
  assert.throws(() => generationPayload(f.graph, 'target'), /拼接规则/);
  const plain = fixture(); plain.graph.edges = []; delete plain.target.data.packageTextCompositions;
  assert.equal(JSON.parse(serializeGraph(plain.graph)).schema, 'frameweave.canvas.v1');
});

for (const value of [-1, 2001, 1.5, '1', null, true, {}, Number.MAX_SAFE_INTEGER + 1]) test(`invalid occurrence ${JSON.stringify(value)} cannot project or execute`, async () => {
  const { graph } = fixture(); graph.edges[2].sourceOccurrence = value;
  assert.throws(() => generationPayload(graph, 'target'), /贡献序号/);
  assert.throws(() => parseGraph(serializeGraph(graph)));
  assert.throws(() => projection(graph), /贡献序号/);
  let calls = 0; await assert.rejects(() => planned(graph, () => calls++), /贡献序号/); assert.equal(calls, 0);
});

test('same contribution identity duplicates reject rather than drop one contribution', async () => {
  const { graph } = fixture(); graph.edges.push({ ...graph.edges[2], id: 'illegal-second' });
  assert.throws(() => generationPayload(graph, 'target'), /相同文本来源/); assert.throws(() => parseGraph(serializeGraph(graph)), /相同文本来源/);
  assert(!projection(graph).overrides.some(item => item.field_id === 'neg'));
  await assert.rejects(() => planned(graph), /贡献身份/);
});

for (const type of ['image', 'video', 'audio']) test(`even occurrence zero is illegal for ${type} media input`, async () => {
  const { graph, target } = fixture(); const media = { id: 'media', type, label: type, node_id: '3', input: type };
  target.data.packageFields.push(media); target.data.packageValues.media = '';
  const reference = { ...createNode('reference', 0, 0, { mediaType: type, name: 'ready.bin', uploadBackend: backend }), id: 'ref' }; graph.nodes.push(reference);
  graph.edges = [{ id: 'media-edge', source: 'ref', target: 'target', targetField: 'media', sourceField: type, sourceOccurrence: 0 }];
  assert.throws(() => parseGraph(serializeGraph(graph)), /拼接规则/); assert.throws(() => generationPayload(graph, 'target'), /拼接规则/);
  const p = projectEditorInputs(graph, 'target', { fields: target.data.packageFields, backend, canvasId: 'c' }); assert(!p.overrides.some(item => item.field_id === 'media'));
  let calls = 0; await assert.rejects(() => planned(graph, () => calls++), /拼接规则/); assert.equal(calls, 0);
});

test('occurrence metadata cannot be attached to builtin or result-output edges', async () => {
  const { graph, target } = fixture(); target.data.kind = 'sdxl'; delete target.data.packageTextCompositions;
  graph.edges = [{ id: 'builtin-edge', source: 'a', target: 'target', targetField: 'negative', sourceOccurrence: 0 }];
  assert.throws(() => generationPayload(graph, 'target'), /拼接规则/); await assert.rejects(() => planned(graph), /拼接规则/);
  const result = { ...createNode('result', 0, 0), id: 'result' }; graph.nodes.push(result);
  graph.edges = [{ id: 'out', source: 'target', target: 'result', sourceOccurrence: 1 }];
  assert.throws(() => parseGraph(serializeGraph(graph)), /拼接规则/);
});

test('sourceOccurrence accessor is rejected without executing it', async () => {
  const { graph } = fixture(); let reads = 0; const options = { targetField: 'extra', sourceField: 'text' };
  Object.defineProperty(options, 'sourceOccurrence', { enumerable: true, get() { reads++; return 1; } });
  assert.equal(canConnect(graph, 'a', 'target', options).ok, false); assert.equal(reads, 0);
  const edge = { source: 'a', targetField: 'neg', sourceField: 'negative' };
  Object.defineProperty(edge, 'sourceOccurrence', { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => textContributionIdentity(edge, context), /JSON/); assert.equal(reads, 0);
  graph.edges[2] = { ...graph.edges[2] };
  Object.defineProperty(graph.edges[2], 'sourceOccurrence', { enumerable: true, get() { reads++; return 1; } });
  assert.throws(() => generationPayload(graph, 'target'), /JSON/); assert.throws(() => serializeGraph(graph), /JSON/);
  assert.throws(() => parseGraph({ schema: 'frameweave.canvas.v2', ...graph }), /JSON/);
  assert.throws(() => projection(graph), /JSON/); await assert.rejects(() => planned(graph), /JSON/); assert.equal(reads, 0);
});

test('planning and active projection retain all repeated contributors without changing source', async () => {
  const { graph } = fixture(), before = structuredClone(graph); let request;
  const execution = await planned(graph, (path, body) => { request = body.request; });
  assert.equal(request.values.neg, 'NEG A, NEG B, NEG A, OWN');
  const active = projectExecution(graph, execution, ['target']); assert.equal(active.edges.length, 3);
  assert.equal(active.edges.find(item => item.id === 'second').sourceOccurrence, 1);
  assert.equal(generationPayload(active, 'target').values.neg, request.values.neg); assert.deepEqual(graph, before);
});

test('contribution identities are scoped per target across two packages with identical field IDs', async () => {
  const { graph, target } = fixture(), second = structuredClone(target); second.id = 'target-b'; second.data.packageValues.neg = 'OWN B'; graph.nodes.push(second);
  graph.edges.push(...graph.edges.map(edge => ({ ...edge, id: `${edge.id}-b`, target: second.id })));
  assert.equal(generationPayload(graph, 'target').values.neg, 'NEG A, NEG B, NEG A, OWN');
  assert.equal(generationPayload(graph, second.id).values.neg, 'NEG A, NEG B, NEG A, OWN B');
  for (const id of ['target', second.id]) {
    const projected = projectEditorInputs(graph, id, { fields, backend, canvasId: 'c' });
    assert.deepEqual(projected.pending, []); assert.equal(projected.overrides.find(item => item.field_id === 'neg').edge_ids.length, 3);
  }
  const calls = [];
  const execution = await planExecution(graph, ['target', second.id], backend, async (path, body) => {
    calls.push(body.request.values.neg);
    return { backend_url: backend, package_id: target.data.package_id, execution: { selected_outputs: ['1'], node_ids: ['1'], active_field_ids: ['neg'] } };
  });
  assert.deepEqual(calls, ['NEG A, NEG B, NEG A, OWN', 'NEG A, NEG B, NEG A, OWN B']);
  const active = projectExecution(graph, execution, ['target', second.id]); assert.equal(active.edges.length, 6);
  assert.equal(generationPayload(active, second.id).values.neg, calls[1]);
});

test('configuration snapshot captures repeated effective values once without persisting C in original own', () => {
  const { graph, target } = fixture(), before = structuredClone(graph);
  const saved = configurationBundle({ canvas: serializeGraph(graph), packages: [{ id: target.data.package_id, source_json: '{}' }], editors: [] }, 'target', '重复文本');
  const restored = parseGraph(saved.canvas); assert.equal(restored.nodes[0].data.packageValues.neg, 'NEG A, NEG B, NEG A, OWN');
  assert.equal(restored.edges.length, 0); assert.deepEqual(graph, before);
});

test('durable run keeps occurrence graph and exact request through resume without resubmission', async () => {
  const { graph } = fixture(); let disk, submissions = 0;
  const api = async (path, body) => {
    if (path === '/api/status') return { online: true, backend_url: backend };
    if (path === '/api/generate') { submissions++; assert.equal(body.request.values.neg, 'NEG A, NEG B, NEG A, OWN'); return { id: 'job', status: 'queued' }; }
    if (path === '/api/jobs') return { jobs: [{ id: 'job', status: 'completed', outputs: [] }] };
    throw new Error(path);
  };
  const runner = createWorkflowRunner({ api, save: state => { disk = structuredClone(state); }, wait: () => Promise.resolve() });
  assert.equal((await runner.start({ graph, targetIds: ['target'], backend })).schema, 'frameweave.workflow-run.v2');
  assert.equal(JSON.stringify(disk).includes('sourceOccurrence'), true);
  assert.equal((await createWorkflowRunner({ api, load: () => disk, save: () => {} }).resume()).status, 'completed'); assert.equal(submissions, 1);
});

test('empty/stale own enum stays pending with enum_unavailable; type failures retain invalid_value', () => {
  const { graph, target } = fixture(); graph.edges = []; target.data.packageTextCompositions = {};
  const model = { id: 'mode', type: 'select', label: '模型', node_id: '3', input: 'model', options: [] };
  target.data.packageFields.push(model);
  for (const value of ['', 'stale-model']) {
    target.data.packageValues.mode = value;
    const projected = projectEditorInputs(graph, 'target', { fields: [...fields, model], backend, canvasId: 'c' });
    assert(projected.pending.some(item => item.field_id === 'mode' && item.reason === 'enum_unavailable')); assert(!projected.overrides.some(item => item.field_id === 'mode'));
    assert.equal(projected.source.data.packageValues.mode, value);
  }
  target.data.packageValues.mode = { bad: 'type' };
  const projected = projectEditorInputs(graph, 'target', { fields: [...fields, model], backend, canvasId: 'c' });
  assert(projected.pending.some(item => item.field_id === 'mode' && item.reason === 'invalid_value'));
});
