import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect } from '../web/graph.mjs';
import { createWorkflowRunner } from '../web/workflow-runner.mjs';

const BACKEND = 'http://127.0.0.1:8188';
const copy = value => value === null ? null : structuredClone(value);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function chain({ viaResult = false, outputIndex = 0 } = {}) {
  const first = createNode('generation', 0, 0, { kind: 'sdxl', positive: 'Frozen original' }); first.id = 'first';
  const second = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-image-chain', packageFields: [{ id: 'image', type: 'image', label: '图片', node_id: '1', input: 'image' }], packageValues: { image: 'old-image.png' } }); second.id = 'second';
  const result = createNode('result', 300, 0, { jobId: 'obsolete-job', outputs: [{ type: 'image', filename: 'obsolete.png', url: '/old.png' }] }); result.id = 'result';
  const unrelated = createNode('generation', 700, 0, { kind: 'sdxl', positive: 'Do not execute' }); unrelated.id = 'unrelated';
  const graph = { nodes: [first, second, unrelated, ...(viaResult ? [result] : [])], edges: [] };
  if (viaResult) connect(graph, first.id, result.id);
  connect(graph, viaResult ? result.id : first.id, second.id, { targetField: 'image', outputIndex });
  return graph;
}
function harness(options = {}) {
  let disk = options.initial ? copy(options.initial) : null;
  const calls = [], saves = [], accepted = [], changes = [], jobEvents = [], jobs = new Map(), requests = new Map();
  const control = { backend: BACKEND, online: true, queryState: null, loseReply: false, rejectSubmission: false, status: 'completed', outputs: [{ type: 'video', filename: 'not-an-image.mp4' }, { type: 'image', filename: 'actual.png', url: '/media/fresh.png' }], failSave: null, ...options.control };
  const baseAPI = async (path, body) => {
    calls.push({ path, body: copy(body) });
    if (options.apiHook) { const special = await options.apiHook(path, body, { jobs, requests, calls, control }); if (special !== undefined) return special; }
    if (path === '/api/status') return { online: control.online, backend_url: control.backend };
    if (path === '/api/generate') {
      assert(disk?.steps.some(step => step.request_id === body.request_id && JSON.stringify(step.request) === JSON.stringify(body.request)), 'generation happened before durable exact request evidence');
      if (control.rejectSubmission) { const error = new Error('invalid model'); error.payload = { submission_state: 'rejected' }; throw error; }
      if (!requests.has(body.request_id)) {
        const job = { id: `job-${requests.size + 1}`, status: control.status, outputs: copy(control.outputs) };
        requests.set(body.request_id, { job_id: job.id, request: copy(body.request) }); jobs.set(job.id, job); accepted.push(job.id);
      }
      if (control.loseReply) { control.loseReply = false; throw new Error('response connection lost'); }
      return { id: requests.get(body.request_id).job_id, status: 'queued' };
    }
    if (path === '/api/requests/query') {
      if (control.queryState) return { state: control.queryState };
      const request = requests.get(body.request_id);
      return request ? { state: 'accepted', job_id: request.job_id, job: copy(jobs.get(request.job_id)) } : { state: 'not_found' };
    }
    if (path === '/api/jobs') return { jobs: [...jobs.values()].map(copy) };
    const input = path.match(/^\/api\/jobs\/(.+)\/image-input$/);
    if (input) { assert(jobs.has(decodeURIComponent(input[1])), 'must use this run\'s job'); return { name: `inputs/${input[1]}-${body.output_index}.png`, url: '/media/input.png' }; }
    throw new Error(`unexpected API ${path}`);
  };
  const config = {
    api: baseAPI, load: () => copy(disk), save: async state => { saves.push(copy(state)); if (control.failSave?.(state, saves.length)) throw new Error('disk full'); disk = copy(state); },
    onChange: state => changes.push(copy(state)), onJob: (id, job) => { jobEvents.push([id, copy(job)]); options.onJob?.(id, job); }, wait: options.wait || (() => Promise.resolve()),
  };
  return { make: () => createWorkflowRunner(config), config, calls, saves, accepted, jobs, requests, control, changes, jobEvents, disk: () => copy(disk) };
}

test('selected downstream runs only its ancestors in order and transfers an image-only index from this run', async () => {
  const h = harness(), runner = h.make(), graph = chain({ viaResult: true });
  const state = await runner.start({ graph, targetIds: ['second'], backend: BACKEND });
  assert.equal(state.status, 'completed'); assert.deepEqual(state.steps.map(step => step.node_id), ['first', 'second']);
  const generated = h.calls.filter(call => call.path === '/api/generate');
  assert.equal(generated.length, 2); assert.equal(generated[1].body.request.values.image, 'inputs/job-1-0.png');
  assert.deepEqual(h.calls.find(call => call.path.includes('/image-input')).body, { output_index: 0 });
  assert(!h.calls.some(call => call.path.includes('obsolete-job'))); assert.equal(graph.nodes.find(node => node.id === 'result').data.jobId, 'obsolete-job');
  assert.equal(new Set(generated.map(call => call.body.request_id)).size, 2);
  assert.deepEqual(h.jobEvents.filter(([, job]) => job.status === 'completed').map(([id]) => id), ['first', 'second']);
});

test('a selected result target traces its generation, while multiple downstream edges reuse one upstream execution', async () => {
  const graph = chain({ viaResult: true }), third = createNode('generation', 800, 0, { kind: 'package', package_id: 'p-third', packageFields: [{ id: 'image', type: 'image', label: '图片', node_id: '1', input: 'image' }] }); third.id = 'third';
  graph.nodes.push(third); connect(graph, 'first', 'third', { targetField: 'image' });
  const h = harness(), runner = h.make();
  const state = await runner.start({ graph, targetIds: ['result', 'second', 'third'], backend: BACKEND });
  assert.equal(state.status, 'completed'); assert.deepEqual(state.steps.map(step => step.node_id), ['first', 'second', 'third']); assert.equal(h.accepted.length, 3);
  assert.equal(h.calls.filter(call => call.path.includes('/job-1/image-input')).length, 2);
});

test('an unavailable image output and a failed dependency both block downstream generation', async () => {
  for (const control of [{ outputs: [{ type: 'video', filename: 'movie.mp4' }] }, { status: 'failed' }, { status: 'cancelled' }]) {
    const h = harness({ control }), state = await h.make().start({ graph: chain(), targetIds: ['second'], backend: BACKEND });
    assert.equal(state.status, 'failed'); assert.equal(h.accepted.length, 1); assert.equal(h.calls.filter(call => call.path.includes('/image-input')).length, 0);
  }
  const h = harness(); const state = await h.make().start({ graph: chain({ outputIndex: 1 }), targetIds: ['second'], backend: BACKEND });
  assert.equal(state.status, 'failed'); assert.equal(h.accepted.length, 1);
});

test('concurrent start/resume buttons cannot dispatch duplicate runs and graph/request snapshots stay frozen', async () => {
  const gate = deferred(); let intercept = true;
  const h = harness({ apiHook: async path => { if (path === '/api/status' && intercept) { intercept = false; await gate.promise; } } });
  const runner = h.make(), graph = chain(); const active = runner.start({ graph, targetIds: ['first'], backend: BACKEND });
  assert(runner.isRunning()); await assert.rejects(runner.start({ graph, targetIds: ['first'], backend: BACKEND }), /重复/); await assert.rejects(runner.resume(), /重复/);
  graph.nodes[0].data.positive = 'edited after click'; const exposed = runner.getState(); exposed.graph.nodes[0].data.positive = 'external mutation';
  gate.resolve(); const state = await active; assert.equal(state.status, 'completed');
  assert.equal(h.calls.find(call => call.path === '/api/generate').body.request.positive, 'Frozen original'); assert.equal(h.accepted.length, 1);
});

test('lost submission reply restores only after explicit resume and queries the original request without resubmitting', async () => {
  const h = harness({ control: { loseReply: true } }), first = h.make();
  const paused = await first.start({ graph: chain(), targetIds: ['second'], backend: BACKEND });
  assert.equal(paused.status, 'paused'); assert.equal(paused.steps[0].state, 'uncertain'); assert.equal(h.accepted.length, 1);
  await assert.rejects(first.clear(), /未确认/); await assert.rejects(first.start({ graph: chain(), backend: BACKEND }), /未结束/);
  const callsBefore = h.calls.length, restored = h.make(); assert.equal(h.calls.length, callsBefore); assert.equal(restored.isRunning(), false); assert.equal(restored.getState().status, 'paused');
  const completed = await restored.resume(); assert.equal(completed.status, 'completed');
  const query = h.calls.find(call => call.path === '/api/requests/query'); assert.equal(query.body.request_id, paused.steps[0].request_id);
  assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 2); assert.equal(h.accepted.length, 2);
});

test('not_found resumes with the original key and exact request, never a new logical submission', async () => {
  let firstAttempt = true;
  const h = harness({ apiHook: async path => { if (path === '/api/generate' && firstAttempt) { firstAttempt = false; throw new Error('request did not reach local service'); } } }), runner = h.make();
  const paused = await runner.start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); assert.equal(h.accepted.length, 0);
  const state = await h.make().resume(); assert.equal(state.status, 'completed'); assert.equal(h.accepted.length, 1);
  const generated = h.calls.filter(call => call.path === '/api/generate'); assert.equal(generated.length, 2); assert.deepEqual(generated[0].body, generated[1].body); assert.equal(generated[1].body.request_id, paused.steps[0].request_id);
});

test('pending and unknown request states pause without resending, while explicit rejection fails safely', async () => {
  for (const queryState of ['pending', 'unknown']) {
    const h = harness({ control: { loseReply: true } }); await h.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); h.control.queryState = queryState;
    const state = await h.make().resume(); assert.equal(state.status, 'paused'); assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 1);
  }
  const h = harness({ control: { rejectSubmission: true } }), runner = h.make();
  const state = await runner.start({ graph: chain(), targetIds: ['second'], backend: BACKEND }); assert.equal(state.status, 'failed'); assert.equal(h.accepted.length, 0);
  await runner.clear(); assert.equal(h.disk(), null);
});

test('storage failure before dispatch prevents generation and accepted-job persistence failure retains the original key', async () => {
  const before = harness({ control: { failSave: () => true } }), beforeRunner = before.make();
  const pausedBefore = await beforeRunner.start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); assert.equal(pausedBefore.status, 'paused'); assert.equal(before.calls.filter(call => call.path === '/api/generate').length, 0);
  const after = harness({ control: { failSave: state => state?.steps?.some(step => ['running', 'uncertain'].includes(step.state)) } }), afterRunner = after.make();
  const pausedAfter = await afterRunner.start({ graph: chain(), targetIds: ['second'], backend: BACKEND }); assert.equal(pausedAfter.status, 'paused'); assert.equal(pausedAfter.steps[0].state, 'uncertain'); assert.equal(after.accepted.length, 1);
  const key = pausedAfter.steps[0].request_id; assert.equal(after.disk().steps[0].state, 'submitting'); assert.equal(after.disk().steps[0].request_id, key);
  after.control.failSave = null; const completed = await after.make().resume(); assert.equal(completed.status, 'completed'); assert.equal(after.accepted.length, 2);
  assert.equal(after.calls.filter(call => call.path === '/api/generate' && call.body.request_id === key).length, 1);
});

test('stop preserves a running job, wakes polling, survives reload and resumes it without a second submission', async () => {
  const waiting = deferred(), hold = deferred();
  const h = harness({ control: { status: 'running' }, wait: () => { waiting.resolve(); return hold.promise; } }), runner = h.make();
  const running = runner.start({ graph: chain(), targetIds: ['second'], backend: BACKEND }); await waiting.promise;
  await runner.stop(); const stopped = await running; assert.equal(stopped.status, 'paused'); assert.equal(stopped.steps[0].job_id, 'job-1'); assert.equal(h.accepted.length, 1);
  assert(!h.calls.some(call => /cancel|interrupt/.test(call.path))); await assert.rejects(runner.clear(), /未结束任务/);
  const restored = h.make(); assert.equal(restored.isRunning(), false); h.jobs.get('job-1').status = 'completed'; h.control.status = 'completed'; hold.resolve();
  assert.equal((await restored.resume()).status, 'completed'); assert.equal(h.accepted.length, 2);
  assert.equal(h.calls.filter(call => call.path === '/api/generate').length, 2);
});

test('changing backend pauses before upload/downstream or recovery query, retaining the old run authority', async () => {
  const h = harness({ onJob: (_id, job) => { if (job.status === 'completed') h.control.backend = 'http://127.0.0.1:9000'; } }), runner = h.make();
  const paused = await runner.start({ graph: chain(), targetIds: ['second'], backend: BACKEND }); assert.equal(paused.status, 'paused'); assert.equal(h.accepted.length, 1); assert.equal(h.calls.filter(call => call.path.includes('/image-input')).length, 0);
  h.control.backend = BACKEND; h.config.onJob = () => {}; assert.equal((await h.make().resume()).status, 'completed'); assert.equal(h.accepted.length, 2);
  const uncertain = harness({ control: { loseReply: true } }); await uncertain.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); uncertain.control.backend = 'http://127.0.0.1:9999';
  assert.equal((await uncertain.make().resume()).status, 'paused'); assert.equal(uncertain.calls.filter(call => call.path === '/api/requests/query').length, 0);
});

test('UI observer errors never change the durable submission identity or cause a resubmit', async () => {
  const h = harness({ onJob: () => { throw new Error('UI rendering failed'); } });
  const state = await h.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); assert.equal(state.status, 'completed'); assert.equal(h.accepted.length, 1);
});

test('malformed recovery and job responses stay paused and cannot erase unsettled evidence', async () => {
  let malformedQuery = false;
  const recovery = harness({ control: { loseReply: true }, apiHook: async path => path === '/api/requests/query' && malformedQuery ? null : undefined });
  await recovery.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); malformedQuery = true;
  const runner = recovery.make(), paused = await runner.resume(); assert.equal(paused.status, 'paused'); assert.equal(paused.steps[0].state, 'uncertain'); await assert.rejects(runner.clear(), /未确认/);
  assert.equal(recovery.calls.filter(call => call.path === '/api/generate').length, 1);
  const missingJobs = harness({ apiHook: async path => path === '/api/jobs' ? { jobs: null } : undefined }), active = missingJobs.make();
  const badList = await active.start({ graph: chain(), targetIds: ['first'], backend: BACKEND }); assert.equal(badList.status, 'paused'); assert.equal(badList.steps[0].job_id, 'job-1');
  await assert.rejects(active.start({ graph: chain(), backend: BACKEND }), /未结束/); await assert.rejects(active.clear(), /未结束任务/);
});

test('clear is serialized with start and a failed clear restores its prior record', async () => {
  const h = harness(), runner = h.make(); await runner.start({ graph: chain(), targetIds: ['first'], backend: BACKEND });
  const hold = deferred(), reached = deferred(); h.control.failSave = state => { if (state === null) return true; return false; };
  await assert.rejects(runner.clear(), /保存/); assert.equal(runner.getState().status, 'completed'); assert.equal(h.disk().status, 'completed');
  h.control.failSave = null;
  const config = { ...h.config, save: async state => { if (state === null) { reached.resolve(); await hold.promise; } return h.config.save(state); } };
  const restored = createWorkflowRunner(config), clearing = restored.clear(); await reached.promise;
  await assert.rejects(restored.start({ graph: chain(), targetIds: ['first'], backend: BACKEND }), /重复/);
  hold.resolve(); await clearing; assert.equal(restored.getState(), null); assert.equal(h.disk(), null);
});

test('unchanged polling does not repaint observers, and request-evidence save failure prevents dispatch', async () => {
  let polls = 0;
  const h = harness({ control: { status: 'running' }, wait: async () => { polls++; if (polls === 3) h.jobs.get('job-1').status = 'completed'; } });
  assert.equal((await h.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND })).status, 'completed');
  assert.equal(polls, 3); assert.deepEqual(h.jobEvents.map(([, job]) => job.status), ['queued', 'running', 'completed']);
  let rejectEvidence = true;
  const blocked = harness({ control: { failSave: state => rejectEvidence && state?.steps.some(step => step.state === 'submitting') } }), runner = blocked.make();
  const paused = await runner.start({ graph: chain(), targetIds: ['first'], backend: BACKEND });
  assert.equal(paused.status, 'paused'); assert.equal(blocked.accepted.length, 0); assert(paused.steps[0].request_id);
  rejectEvidence = false; const completed = await runner.resume(); assert.equal(completed.status, 'completed');
  assert.equal(completed.steps[0].request_id, paused.steps[0].request_id); assert.equal(blocked.accepted.length, 1);
});

test('optional canvas identity is durable metadata through recovery and rejects invalid identifiers before side effects', async () => {
  const canvasId = '画'.repeat(120), h = harness({ control: { loseReply: true } });
  const paused = await h.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND, canvasId });
  assert.equal(paused.canvas_id, canvasId); assert.equal(h.disk().canvas_id, canvasId);
  const restored = h.make(); assert.equal(restored.getState().canvas_id, canvasId);
  const completed = await restored.resume(); assert.equal(completed.canvas_id, canvasId); assert.equal(h.accepted.length, 1);
  assert.equal(h.calls.find(call => call.path === '/api/generate').body.request.canvas_id, undefined);
  const legacy = harness(); await legacy.make().start({ graph: chain(), targetIds: ['first'], backend: BACKEND });
  assert(!Object.hasOwn(legacy.disk(), 'canvas_id')); assert(!Object.hasOwn(legacy.make().getState(), 'canvas_id'));
  for (const invalid of [null, 1, {}, 'x'.repeat(121)]) {
    const bad = harness(), runner = bad.make();
    await assert.rejects(runner.start({ graph: chain(), backend: BACKEND, canvasId: invalid }), /画布关联标识/);
    assert.equal(bad.calls.length, 0); assert.equal(bad.saves.length, 0); assert.equal(runner.getState(), null);
    assert.throws(() => harness({ initial: { ...h.disk(), canvas_id: invalid } }).make(), /画布关联标识/);
  }
});
