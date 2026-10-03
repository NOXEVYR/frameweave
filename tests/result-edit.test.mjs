import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, generationPayload, executionOrder, parseGraph, serializeGraph } from '../web/graph.mjs';
import { prepareResultEdit } from '../web/result-edit.mjs';
import { captureResultReference, transferResultReference } from '../web/result-reference.mjs';

const backend = 'http://127.0.0.1:8188';
function fixture() {
  const output = { type: 'image', filename: 'owned.png', subfolder: '', storage_type: 'output', node_id: '9',
    output_id: `o-${'a'.repeat(64)}`, url: `/api/media/${'b'.repeat(32)}` };
  const job = { id: 'quick-edit', status: 'completed', backend, outputs: [output] };
  const source = createNode('result', 0, 0, { jobId: job.id, outputs: structuredClone(job.outputs) });
  const graph = { nodes: [source], edges: [] }, state = { graph, canvasId: 'edit-canvas', backend };
  const calls = [], hooks = {};
  const reply = { name: 'edit/owned.png', url: `/api/media/${'c'.repeat(32)}`, media_type: 'image', backend,
    source_job: job.id, output_id: output.output_id };
  const current = () => state;
  async function api(path, data) {
    calls.push({ path, data }); await hooks.before?.(path, data);
    if (path === '/api/jobs') return { jobs: [job] };
    if (path === '/api/status') return { online: true, backend_url: backend };
    if (path.endsWith('/image-input')) return reply;
    throw new Error(`Unexpected request ${path}`);
  }
  const run = (kind = 'qwen21_edit') => prepareResultEdit({ source, outputId: output.output_id, kind, api, current });
  return { output, job, source, graph, state, calls, hooks, reply, api, current, run };
}

for (const kind of ['qwen21_edit', 'sdxl_i2i']) test(`${kind}: quick edit stages an owned reference and new target as one fragment`, async () => {
  const h = fixture(), original = structuredClone(h.graph);
  const fragment = await h.run(kind);
  assert.deepEqual(h.graph, original); fragment.assertCurrent();
  h.graph.nodes.push(fragment.reference, fragment.target); h.graph.edges.push(fragment.edge);
  assert.equal(fragment.target.data.kind, kind); assert.equal(fragment.edge.targetField, 'image_1');
  assert.equal(fragment.reference.data.uploadBackend, backend); assert.equal(fragment.reference.data.name, h.reply.name);
  assert.deepEqual(executionOrder(h.graph, [fragment.target.id]), [fragment.target.id]);
  assert.equal(generationPayload(h.graph, fragment.target.id).references[0], h.reply.name);
  assert.doesNotThrow(() => parseGraph(serializeGraph(h.graph)));
  assert.equal(h.calls.filter(item => item.data).length, 1);
  assert.ok(h.calls.every(item => ['/api/jobs', '/api/status', '/api/jobs/quick-edit/image-input'].includes(item.path)));
});

for (const change of ['job', 'output', 'canvas', 'backend', 'source']) test(`first history request cannot rebase quick edit after ${change} changes`, async () => {
  const h = fixture();
  h.hooks.before = path => {
    if (path !== '/api/jobs') return;
    if (change === 'job') h.source.data.jobId = 'other';
    if (change === 'output') h.source.data.outputs[0].filename = 'different.png';
    if (change === 'canvas') h.state.canvasId = 'different';
    if (change === 'backend') h.state.backend = 'http://127.0.0.1:8189';
    if (change === 'source') h.graph.nodes[0] = structuredClone(h.source);
  };
  await assert.rejects(h.run(), /变化/);
  assert.equal(h.calls.some(item => item.data), false); assert.equal(h.graph.nodes.length, 1);
});

for (const reason of ['network', 'receipt', 'capacity', 'canvas']) test(`${reason} failure leaves no dangling quick-edit node or connection`, async () => {
  const h = fixture();
  h.hooks.before = path => {
    if (!path.endsWith('/image-input')) return;
    if (reason === 'network') throw new Error('connection lost');
    if (reason === 'receipt') h.reply.output_id = `o-${'d'.repeat(64)}`;
    if (reason === 'capacity') while (h.graph.nodes.length < 499) h.graph.nodes.push(createNode('prompt', 0, 0));
    if (reason === 'canvas') h.state.graph = { nodes: [], edges: [] };
  };
  await assert.rejects(h.run());
  assert.equal(h.graph.nodes.some(node => node.type === 'generation' || node.type === 'reference'), false);
  assert.equal(h.graph.edges.length, 0); assert.equal(h.calls.filter(item => item.data).length, 1);
});

test('final application guard rejects a canvas switch after the prepared fragment resolves', async () => {
  const h = fixture(), fragment = await h.run(); h.state.canvasId = 'later';
  assert.throws(fragment.assertCurrent, /变化/); assert.equal(h.graph.nodes.length, 1);
});

test('quick edit requires a known preset and current owned image before any upload', async () => {
  const h = fixture(); await assert.rejects(h.run('h3_t2v'), /编辑方式/); assert.equal(h.calls.length, 0);
  h.job.status = 'running'; await assert.rejects(h.run(), /已完成/); assert.equal(h.calls.some(item => item.data), false);
});

test('a detached target cannot be adopted by the canvas during transfer', async () => {
  const h = fixture(), target = createNode('generation', 600, 0, { kind: 'sdxl_i2i' });
  const ticket = captureResultReference({ ...h.state, source: h.source, job: h.job, outputId: h.output.output_id,
    targetId: target.id, fieldId: 'image_1', newTarget: target });
  h.hooks.before = path => { if (path.endsWith('/image-input')) h.graph.nodes.push(structuredClone(target)); };
  await assert.rejects(transferResultReference(ticket, { api: h.api, current: h.current }), /变化/);
  assert.equal(h.graph.edges.length, 0); assert.equal(h.graph.nodes.filter(node => node.type === 'reference').length, 0);
});

test('a detached destination cannot change identity during transfer', async () => {
  const h = fixture(), target = createNode('generation', 600, 0, { kind: 'sdxl_i2i' });
  const ticket = captureResultReference({ ...h.state, source: h.source, job: h.job, outputId: h.output.output_id,
    targetId: target.id, fieldId: 'image_1', newTarget: target });
  h.hooks.before = path => { if (path.endsWith('/image-input')) target.id = 'replacement'; };
  await assert.rejects(transferResultReference(ticket, { api: h.api, current: h.current }), /变化/);
  assert.equal(h.graph.nodes.length, 1); assert.equal(h.graph.edges.length, 0);
});
