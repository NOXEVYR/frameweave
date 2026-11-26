import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect, parseGraph, serializeGraph } from '../web/graph.mjs';
import { createWorkflowRunner } from '../web/workflow-runner.mjs';

const BACKEND = 'http://127.0.0.1:8188';
const copy = value => value === undefined ? undefined : structuredClone(value);
const targetScope = { package_id: 'p-target', selected_outputs: ['save-a'], node_ids: ['load-a', 'save-a'], active_field_ids: ['image_a', 'text_a'] };

function branchGraph() {
  const ready = createNode('generation', 0, 0, { kind: 'sdxl', positive: 'Frozen upstream' }); ready.id = 'ready';
  const inactive = createNode('generation', 0, 200, { kind: 'package', package_id: '', editor_id: 'e-' + 'b'.repeat(24) }); inactive.id = 'inactive';
  const text = createNode('prompt', 200, 100, { text: 'Frozen text' }); text.id = 'text';
  const inactiveText = createNode('prompt', 200, 300, { text: 'Do not materialize' }); inactiveText.id = 'inactive-text';
  const target = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-target',
    packageFields: [
      { id: 'image_a', label: 'A', type: 'image' }, { id: 'image_b', label: 'B', type: 'image' },
      { id: 'text_a', label: 'Text A', type: 'text' }, { id: 'text_b', label: 'Text B', type: 'text' },
    ], packageValues: { image_a: '', image_b: '', text_a: '', text_b: 'Saved unused scalar' },
    packageMediaBackends: { image_b: { name: 'unused.png', backend: 'http://127.0.0.1:9999' } },
  }); target.id = 'target';
  const graph = { nodes: [ready, inactive, text, inactiveText, target], edges: [] };
  connect(graph, ready.id, target.id, { targetField: 'image_a' }); graph.edges.at(-1).id = 'active-media';
  connect(graph, text.id, target.id, { targetField: 'text_a' }); graph.edges.at(-1).id = 'active-text';
  connect(graph, inactiveText.id, target.id, { targetField: 'text_b' }); graph.edges.at(-1).id = 'inactive-text-edge';
  // An old unknown source must stay editable even while its target is unused.
  graph.edges.push({ id: 'inactive-media', source: inactive.id, target: target.id, targetField: 'image_b', sourceField: 'image', outputIndex: 0 });
  return graph;
}

const branchExecution = () => ({ version: 1, node_ids: ['ready', 'text', 'target'], edge_ids: ['active-media', 'active-text'], packages: { target: copy(targetScope) } });

function harness({ initial = null, execution = branchExecution(), hook, loseReply = false, failSave } = {}) {
  let disk = copy(initial);
  const calls = [], jobs = new Map(), requests = new Map();
  const control = { loseReply, compileError: null, drift: null, query: null, failSave };
  const api = async (path, body) => {
    calls.push({ path, body: copy(body) });
    const special = await hook?.(path, body, control); if (special !== undefined) return special;
    if (path === '/api/status') return { online: true, backend_url: BACKEND };
    if (path === '/api/compile') {
      if (control.compileError) throw new Error(control.compileError);
      const scope = Object.values(execution.packages).find(item => item.package_id === body.package_id);
      return { summary: { package_id: body.package_id, execution: { ...copy(scope), ...copy(control.drift) } } };
    }
    if (path === '/api/generate') {
      assert(disk.steps.some(step => step.request_id === body.request_id && JSON.stringify(step.request) === JSON.stringify(body.request)), 'persist exact request before dispatch');
      if (!requests.has(body.request_id)) {
        const job = { id: `job-${requests.size + 1}`, status: 'completed', outputs: [{ type: 'image', node_id: 'save-source', filename: 'fresh.png', output_id: 'fresh-id' }] };
        requests.set(body.request_id, job.id); jobs.set(job.id, job);
      }
      if (control.loseReply) { control.loseReply = false; throw new Error('lost acknowledgement'); }
      return { job_id: requests.get(body.request_id), status: 'queued' };
    }
    if (path === '/api/jobs') return { jobs: [...jobs.values()].map(copy) };
    if (path === '/api/requests/query') return control.query ? { state: control.query } : { state: 'accepted', job_id: requests.get(body.request_id) };
    if (path.endsWith('/image-input')) return { name: 'input/fresh.png', backend: BACKEND, output_id: body.output_id };
    throw new Error(`unexpected API ${path}`);
  };
  const config = { api, load: () => copy(disk), save: record => { if (control.failSave?.(record)) throw new Error('disk full'); disk = copy(record); }, wait: async () => {} };
  return { calls, control, config, make: () => createWorkflowRunner(config), disk: () => copy(disk) };
}

test('scope skips an unprepared unknown upstream, retains all source data and freezes selected outputs', async () => {
  const graph = branchGraph(), untouched = copy(graph), original = parseGraph(serializeGraph(graph)), execution = branchExecution(), h = harness();
  const state = await h.make().start({ graph, execution, targetIds: ['target'], backend: BACKEND, canvasId: 'original-canvas' });
  assert.equal(state.status, 'completed'); assert.deepEqual(state.steps.map(step => step.node_id), ['ready', 'target']);
  assert.deepEqual(state.graph, original); assert.deepEqual(graph, untouched); assert.deepEqual(state.execution, execution);
  assert(!Object.hasOwn(state, 'executionGraph'));
  assert.equal(state.canvas_id, 'original-canvas');
  const requests = h.calls.filter(call => call.path === '/api/generate').map(call => call.body.request);
  assert.equal(requests.length, 2); assert.equal(h.calls.filter(call => call.path.endsWith('/image-input')).length, 1);
  assert.deepEqual(requests[1].output_nodes, ['save-a']);
  assert.deepEqual(requests[1].values, { image_a: 'input/fresh.png', image_b: '', text_a: 'Frozen text', text_b: 'Saved unused scalar' });
  assert.equal(h.calls.filter(call => call.path === '/api/compile').length, 1);
  assert(!h.calls.some(call => call.body?.request?.package_id === ''));
});

test('loaded new records restore the original scope and validate scope and step order synchronously', async () => {
  const h = harness({ loseReply: true }), graph = branchGraph(), execution = branchExecution();
  const paused = await h.make().start({ graph, execution, targetIds: ['target'], backend: BACKEND, canvasId: 'original-canvas' });
  assert.equal(paused.status, 'paused');
  graph.nodes.find(node => node.id === 'target').data.editor_outputs = ['save-b']; execution.packages.target.active_field_ids.push('image_b');
  const before = h.calls.length, restored = h.make();
  assert.equal(h.calls.length, before); assert.deepEqual(restored.getState().execution, branchExecution());
  const state = await restored.resume();
  assert.equal(state.status, 'completed'); assert.deepEqual(state.steps.map(step => step.node_id), ['ready', 'target']);
  assert.equal(state.steps[0].request_id, paused.steps[0].request_id); assert.deepEqual(state.steps[0].request, paused.steps[0].request);
  assert.equal(state.canvas_id, 'original-canvas'); assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 2);
  for (const mutate of [
    record => record.steps.reverse(),
    record => record.execution.node_ids.push('inactive'),
    record => record.execution.edge_ids.push('inactive-media'),
    record => record.execution.packages.target.package_id = 'different',
    record => record.execution.packages.target.active_field_ids.push('missing'),
    record => record.execution = null,
  ]) {
    const record = h.disk(); mutate(record);
    const bad = harness({ initial: record }); assert.throws(() => bad.make()); assert.equal(bad.calls.length, 0);
  }
});

test('schema drift in each frozen package identity dimension pauses before a new request exists', async () => {
  for (const drift of [
    { selected_outputs: ['save-b'] }, { node_ids: ['load-a', 'save-a', 'load-b'] },
    { active_field_ids: ['image_a', 'text_a', 'image_b'] }, { active_field_ids: ['image_a', 'image_a'] },
  ]) {
    const h = harness(); h.control.drift = drift;
    const paused = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
    assert.equal(paused.status, 'paused'); assert.match(paused.error, /执行范围已变化/);
    assert.equal(paused.steps[1].request, null); assert.equal(paused.steps[1].request_id, null);
    assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 1);
    assert.deepEqual(paused.execution, branchExecution());
    h.control.drift = null;
    assert.equal((await h.make().resume()).status, 'completed');
    assert.equal(h.calls.filter(call => call.path.endsWith('/image-input')).length, 1, 'reuse persisted media from same upstream job');
  }
  const h = harness({ hook: path => path === '/api/compile' ? { summary: { package_id: 'foreign', execution: copy(targetScope) } } : undefined });
  assert.equal((await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND })).status, 'paused');
});

test('compile errors and malformed summaries pause without dispatch or erasing the frozen plan', async () => {
  for (const response of [null, {}, { summary: {} }]) {
    const h = harness({ hook: path => path === '/api/compile' ? response : undefined });
    const state = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
    assert.equal(state.status, 'paused'); assert.equal(state.steps[1].request_id, null);
    assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 1);
  }
  const h = harness(); h.control.compileError = 'backend unavailable';
  const state = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
  assert.equal(state.status, 'paused'); assert.match(state.error, /无法核验冻结执行范围/);
  assert.deepEqual(state.execution, branchExecution());
});

test('accepted or uncertain planned requests recover without recompiling or rebuilding request and media', async () => {
  let loseTarget = true;
  const h = harness({ hook: (path, body, control) => { if (path === '/api/generate' && body.request.package_id === 'p-target' && loseTarget) { loseTarget = false; control.loseReply = true; } } });
  const paused = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
  assert.equal(paused.steps[1].state, 'uncertain'); const step = copy(paused.steps[1]);
  h.control.compileError = 'schema changed after dispatch';
  for (const query of ['unknown', 'pending']) {
    h.control.query = query; assert.equal((await h.make().resume()).status, 'paused');
    assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 2);
  }
  h.control.query = null;
  const completed = await h.make().resume(); assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[1].request_id, step.request_id); assert.deepEqual(completed.steps[1].request, step.request);
  assert.deepEqual(completed.steps[1].image_inputs, step.image_inputs);
  assert.equal(h.calls.filter(call => call.path === '/api/compile').length, 1);
  assert.equal(h.calls.filter(call => call.path.endsWith('/image-input')).length, 1);
});

test('planned not_found retries the identical durable request and running records only poll their original job', async () => {
  for (const running of [false, true]) {
    let loseTarget = true;
    const h = harness({ hook: (path, body, control) => { if (path === '/api/generate' && body.request.package_id === 'p-target' && loseTarget) { loseTarget = false; control.loseReply = true; } } });
    const paused = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
    const original = copy(paused.steps[1]); h.control.compileError = 'do not rebuild an existing request';
    let restored;
    if (running) {
      const record = h.disk(); record.steps[1].state = 'running'; record.steps[1].job_id = 'job-2'; record.steps[1].job_status = 'queued';
      restored = createWorkflowRunner({ ...h.config, load: () => record });
    } else { h.control.query = 'not_found'; restored = h.make(); }
    const completed = await restored.resume(); assert.equal(completed.status, 'completed');
    assert.equal(completed.steps[1].request_id, original.request_id); assert.deepEqual(completed.steps[1].request, original.request);
    assert.deepEqual(completed.steps[1].image_inputs, original.image_inputs);
    assert.equal(h.calls.filter(call => call.path === '/api/compile').length, 1);
    const generated = h.calls.filter(call => call.path === '/api/generate'); assert.equal(generated.length, running ? 2 : 3);
    if (!running) assert.deepEqual(generated[1].body, generated[2].body);
    assert.equal(h.calls.filter(call => call.path === '/api/requests/query').length, running ? 0 : 1);
  }
});

test('backend changes during compile pause before request identity and compile membership ignores ordering only', async () => {
  let switched = false;
  const h = harness({ hook: path => {
    if (path === '/api/compile') switched = true;
    if (path === '/api/status' && switched) return { online: true, backend_url: 'http://127.0.0.1:9999' };
  } });
  const paused = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
  assert.equal(paused.status, 'paused'); assert.match(paused.error, /推理引擎已切换/);
  assert.equal(paused.steps[1].request, null); assert.equal(paused.steps[1].request_id, null);
  assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 1);
  const reordered = harness(); reordered.control.drift = { node_ids: ['save-a', 'load-a'], active_field_ids: ['text_a', 'image_a'] };
  assert.equal((await reordered.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND })).status, 'completed');
});

test('planned result intermediaries retain historical previews while transferring from the fresh upstream job', async () => {
  const graph = branchGraph();
  const preview = createNode('result', 300, 0, { jobId: 'historical-job', outputs: [{ type: 'image', filename: 'old.png', output_id: 'old-id' }] }); preview.id = 'preview';
  graph.nodes.push(preview); graph.edges.find(edge => edge.id === 'active-media').source = 'preview';
  connect(graph, 'ready', 'preview'); graph.edges.at(-1).id = 'result-edge';
  const execution = branchExecution(); execution.node_ids.push('preview'); execution.edge_ids.push('result-edge');
  const h = harness(), state = await h.make().start({ graph, execution, targetIds: ['target'], backend: BACKEND });
  assert.equal(state.status, 'completed'); assert.deepEqual(state.steps.map(step => step.node_id), ['ready', 'target']);
  assert.equal(h.calls.find(call => call.path.endsWith('/image-input')).path, '/api/jobs/job-1/image-input');
  assert.equal(state.graph.nodes.find(node => node.id === 'preview').data.jobId, 'historical-job');
  assert.equal(state.steps[1].image_inputs['active-media'].output_id, 'fresh-id');
});

test('planned active legacy unknown edges hand off only fresh completed media of the correct type', async () => {
  for (const wrong of [false, true]) {
    const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-source' }); source.id = 'source';
    const target = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-target', packageFields: [{ id: 'image_a', label: 'A', type: 'image' }] }); target.id = 'target';
    const graph = { nodes: [source, target], edges: [{ id: 'old-unknown', source: 'source', target: 'target', targetField: 'image_a', sourceField: 'image', sourceOutput: 'save-source', outputIndex: 0 }] };
    const scope = { version: 1, node_ids: ['source', 'target'], edge_ids: ['old-unknown'], packages: {
      source: { package_id: 'p-source', selected_outputs: ['save-source'], node_ids: ['save-source'], active_field_ids: [] },
      target: { ...copy(targetScope), active_field_ids: ['image_a'] },
    } };
    const h = harness({ execution: scope, hook: path => path === '/api/jobs' && wrong ? { jobs: [{ id: 'job-1', status: 'completed', outputs: [{ type: 'video', node_id: 'save-source', filename: 'wrong.mp4' }] }] } : undefined });
    const state = await h.make().start({ graph, execution: scope, targetIds: ['target'], backend: BACKEND });
    assert.equal(state.status, wrong ? 'failed' : 'completed');
    assert.equal(h.calls.filter(call => call.path.endsWith('/image-input')).length, wrong ? 0 : 1);
    assert.equal(h.calls.filter(call => call.path === '/api/generate').length, wrong ? 1 : 2);
    assert.deepEqual(state.graph.edges, graph.edges);
  }
});

test('scope persistence failures cannot submit new or uncertain requests and retain their original identity', async () => {
  const blocked = harness({ failSave: () => true });
  assert.equal((await blocked.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND })).status, 'paused');
  assert.equal(blocked.calls.length, 0);
  const h = harness({ failSave: record => record.steps.some(step => step.node_id === 'target' && ['running', 'uncertain'].includes(step.state)) });
  const paused = await h.make().start({ graph: branchGraph(), execution: branchExecution(), targetIds: ['target'], backend: BACKEND });
  assert.equal(paused.status, 'paused'); assert.equal(paused.steps[1].state, 'uncertain');
  const requestId = paused.steps[1].request_id; assert.equal(h.disk().steps[1].request_id, requestId);
  h.control.failSave = null; h.control.compileError = 'no new compile allowed';
  const completed = await h.make().resume(); assert.equal(completed.status, 'completed'); assert.equal(completed.steps[1].request_id, requestId);
  assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 2);
});

test('runs without an execution plan retain legacy full-input validation', async () => {
  const h = harness();
  await assert.rejects(h.make().start({ graph: branchGraph(), targetIds: ['target'], backend: BACKEND }), /尚未建立外层参数/);
  assert.equal(h.calls.length, 0); assert.equal(h.disk(), null);
});
