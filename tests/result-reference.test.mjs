import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, parseGraph, serializeGraph, generationPayload, executionOrder } from '../web/graph.mjs';
import { projectEditorInputs } from '../web/editor-preparation.mjs';
import { resultReferenceOutputs, resultReferenceTargets, captureResultReference, assertResultReferenceCurrent, transferResultReference } from '../web/result-reference.mjs';
import { openResultReferenceDialog } from '../web/result-reference-dialog.mjs';

const backend = 'http://127.0.0.1:8188';
function fixture(type = 'image') {
  const output = { output_id: `o-${'a'.repeat(64)}`, node_id: '42', filename: `result.${{image:'png',video:'mp4',audio:'wav'}[type]}`,
    type, subfolder: 'test', storage_type: 'output', url: `/api/media/${'b'.repeat(32)}` };
  const job = { id: 'test-job', status: 'completed', backend, outputs: [output] };
  const source = createNode('result', 0, 0, { jobId: job.id, outputs: structuredClone(job.outputs) });
  const target = createNode('generation', 600, 0, { kind: 'package', package_id: `p-${'c'.repeat(24)}`, packageValues: { reference: 'own-file' },
    packageFields: [{ id: 'reference', label: '人物参考', type, node_id: '7', input: type === 'video' ? 'file' : type }] });
  const graph = { nodes: [source, target], edges: [] };
  const current = { graph, canvasId: 'test-canvas', backend };
  const args = { ...current, source, job, outputId: output.output_id, targetId: target.id, fieldId: 'reference' };
  const reply = { name: `input/${output.filename}`, url: `/api/media/${'e'.repeat(32)}`, backend, media_type: type, source_job: job.id,
    output_id: output.output_id, ...(type === 'image' ? {} : { asset_id: 'f'.repeat(64), package_id: target.data.package_id, field_id: 'reference' }) };
  const calls = [], hooks = {};
  async function api(path, data) {
    calls.push({ path, data }); await hooks.before?.(path, data);
    if (path === '/api/status') return { online: true, backend_url: current.backend };
    if (path === '/api/jobs') return { jobs: [job] };
    if (path.endsWith('-input')) return reply;
    throw new Error(`Unexpected API ${path}`);
  }
  return { type, output, job, source, target, graph, current, args, reply, calls, hooks, api };
}
for (const type of ['image', 'video', 'audio']) test(`${type}: exact result becomes a ready named reference without upstream rerun or fallback overwrite`, async () => {
  const h = fixture(type), ticket = captureResultReference(h.args), before = structuredClone(h.graph);
  const { reference, edge } = await transferResultReference(ticket, { api: h.api, current: () => h.current });
  assert.deepEqual(h.graph, before); assert.equal(reference.data.name, h.reply.name); assert.equal(reference.data.uploadBackend, backend);
  h.graph.nodes.push(reference); h.graph.edges.push(edge);
  assert.equal(edge.source, reference.id); assert.equal(edge.targetField, 'reference');
  assert.deepEqual(executionOrder(h.graph, [h.target.id]), [h.target.id]);
  assert.equal(generationPayload(h.graph, h.target.id).values.reference, h.reply.name);
  const projection = projectEditorInputs(h.graph, h.target.id, { fields: h.target.data.packageFields, backend, canvasId: 'test-canvas' });
  assert.equal(projection.pending.length, 0); assert.equal(projection.overrides[0].value, h.reply.name);
  assert.equal(projection.overrides[0].stored_fallback, 'own-file');
  assert.equal(projection.overrides[0].media_owner.media_type, type);
  assert.equal(h.calls.filter(item => item.path.endsWith('-input')).length, 1);
  assert.ok(h.calls.every(item => !item.path.includes('generate')));
  assert.doesNotThrow(() => parseGraph(serializeGraph(h.graph)));
});

test('output selection preserves branch and batch identity even after history reorder', async () => {
  const h = fixture();
  const other = { ...h.output, output_id: `o-${'f'.repeat(64)}`, node_id: '43', filename: 'other.png' };
  h.job.outputs.unshift(other); h.source.data.outputs = structuredClone(h.job.outputs);
  const ticket = captureResultReference(h.args); h.job.outputs.reverse();
  await transferResultReference(ticket, { api: h.api, current: () => h.current });
  const call = h.calls.find(item => item.path.endsWith('-input'));
  assert.equal(call.data.output_id, h.output.output_id); assert.equal(call.data.output_index, 1);
});

test('ambiguous, unowned and incomplete outputs are not offered', () => {
  const h = fixture(); h.job.outputs.push({ ...h.output }); assert.deepEqual(resultReferenceOutputs(h.job), []);
  h.job.outputs = [{ ...h.output, output_id: '' }, { ...h.output, url: 'https://example.test/file' }]; assert.deepEqual(resultReferenceOutputs(h.job), []);
  h.job.status = 'running'; assert.throws(() => resultReferenceOutputs(h.job), /已完成/);
});

test('target list requires a compatible empty port on the selected backend', () => {
  const h = fixture('video'); assert.equal(resultReferenceTargets(h.graph, 'video', backend).length, 1);
  h.graph.edges.push({ id: 'occupied', source: h.source.id, target: h.target.id, targetField: 'reference' });
  assert.equal(resultReferenceTargets(h.graph, 'video', backend).length, 0); h.graph.edges = [];
  h.target.data.editor_backend = 'http://127.0.0.1:8189'; assert.equal(resultReferenceTargets(h.graph, 'video', backend).length, 0);
  h.target.data.editor_backend = backend; h.target.data.package_id = ''; assert.equal(resultReferenceTargets(h.graph, 'video', backend).length, 0);
});

for (const change of ['canvas', 'backend', 'source', 'target', 'field', 'edge']) test(`${change} changes during transfer leave canvas untouched`, async () => {
  const h = fixture(), ticket = captureResultReference(h.args);
  h.hooks.before = path => {
    if (!path.endsWith('-input')) return;
    if (change === 'canvas') h.current.canvasId = 'different';
    if (change === 'backend') h.current.backend = 'http://127.0.0.1:8189';
    if (change === 'source') h.source.data.outputs[0].filename = 'replaced.png';
    if (change === 'target') h.graph.nodes[1] = structuredClone(h.target);
    if (change === 'field') h.target.data.packageValues.reference = 'user-edited.png';
    if (change === 'edge') h.graph.edges.push({ id: 'other', source: h.source.id, target: h.target.id, targetField: 'reference' });
  };
  await assert.rejects(transferResultReference(ticket, { api: h.api, current: () => h.current }), /已变化/);
  assert.equal(h.graph.nodes.length, 2); assert.ok(h.graph.edges.length <= 1);
});

test('failed transfer is not retried and never falls back to old filename', async () => {
  const h = fixture(); h.hooks.before = path => { if (path.endsWith('-input')) throw new Error('network lost'); };
  await assert.rejects(transferResultReference(captureResultReference(h.args), { api: h.api, current: () => h.current }), /手动重试/);
  assert.equal(h.calls.filter(item => item.path.endsWith('-input')).length, 1); assert.equal(h.graph.nodes.length, 2);
});

for (const [name, value] of [['output_id', 'wrong'], ['source_job', 'wrong'], ['backend', 'http://127.0.0.1:8189'], ['media_type', 'audio'], ['name', '../unsafe.png'], ['url', 'https://example.test/a']]) test(`invalid ${name} receipt is not applied`, async () => {
  const h = fixture(); h.reply[name] = value;
  await assert.rejects(transferResultReference(captureResultReference(h.args), { api: h.api, current: () => h.current }));
  assert.equal(h.graph.nodes.length, 2);
});

test('moving nodes and panning do not invalidate an unchanged input transaction', () => {
  const h = fixture(), ticket = captureResultReference(h.args); h.target.x += 50; h.source.y += 10;
  assert.doesNotThrow(() => assertResultReferenceCurrent(ticket, h.current));
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  showModal() { this.open = true; } close() { this.open = false; } remove() { this.removed = true; } focus() {}
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
async function dialogFixture(type = 'image') {
  const h = fixture(type), document = { body: new Element('body'), createElement: tag => new Element(tag) }, applied = [];
  const dialog = await openResultReferenceDialog({ source: h.source, initialOutputId: h.output.output_id, api: h.api,
    current: () => h.current, apply: fragment => applied.push(fragment), document });
  const elements = descendants(document.body);
  return { ...h, document, dialog, elements, applied,
    target: elements.find(item => item['aria-label'] === '目标工作流输入'),
    send: elements.find(item => item.textContent === '建立参考并连接') };
}

test('actual dialog requires named choice then applies once; importing/opening alone sends no media', async () => {
  const h = await dialogFixture('audio');
  assert.equal(h.calls.filter(item => item.path.endsWith('-input')).length, 0);
  await h.send.listeners.click(); assert.equal(h.applied.length, 0);
  h.target.value = '0'; await h.send.listeners.click(); assert.equal(h.applied.length, 1);
  assert.equal(h.applied[0].reference.data.mediaType, 'audio');
});

test('actual dialog close during I/O discards late application and duplicate clicks do not upload twice', async () => {
  const h = await dialogFixture(); let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  h.hooks.before = async path => { if (path.endsWith('-input')) { started(); await new Promise(resolve => { release = resolve; }); } };
  h.target.value = '0'; const pending = h.send.listeners.click(); await ready;
  await h.send.listeners.click(); h.dialog.close(); release(); await pending;
  assert.equal(h.applied.length, 0); assert.equal(h.calls.filter(item => item.path.endsWith('-input')).length, 1);
});
