import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as jobState from '../web/job-state.mjs';
import { liveProgressText, elapsedText, previewStatusText } from '../web/job-progress.mjs';
import { progressPercent } from '../web/graph.mjs';
import { filterJobs } from '../web/library.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('async function controlJob('), source.indexOf('function newJobView('));
const backend = 'http://127.0.0.1:8188';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture(api) {
  const calls = [], notices = [], context = { ...jobState, jobs: [{ id: 'owned', backend, status: 'running', outputs: [] }],
    controllingJobs: new Set(), renderJobs() {}, studio: { refresh() {} }, toast: value => notices.push(value),
    api: async (...args) => { calls.push(args); return api(...args); }, pollJobs: async () => {} };
  vm.runInNewContext(body, context); return { context, calls, notices, run: operation => context.controlJob('owned', operation) };
}
test('queue and studio share one in-flight control guard and never submit generation', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), first = f.run('cancel');
  assert.equal(f.context.controllingJobs.has('owned'), true); await f.run('cancel');
  assert.equal(f.calls.length, 1);
  gate.resolve({ ...f.context.jobs[0], cancellation: { id: crypto.randomUUID(), state: 'requested' } }); await first;
  assert.equal(f.context.jobs[0].status, 'running'); assert.equal(f.context.controllingJobs.size, 0);
  assert.match(f.notices[0], /取消已请求/); assert.equal(f.calls[0][0], '/api/jobs/owned/cancel');
});
test('unknown explicit query keeps original identity and outputs without a new request', async () => {
  const f = fixture(() => ({ ...f.context.jobs[0], status: 'unknown' }));
  f.context.jobs[0].status = 'unknown'; f.context.jobs[0].outputs = [{ filename: 'partial.png' }];
  await f.run('refresh'); assert.equal(f.calls[0][0], '/api/jobs/owned/refresh');
  assert.deepEqual(f.context.jobs[0].outputs, [{ filename: 'partial.png' }]);
  await assert.rejects(f.run('cancel'), /先查询原任务/); assert.equal(f.calls.length, 1);
});
test('late cancel acknowledgement cannot overwrite a newly completed job', async () => {
  const gate = deferred(), f = fixture(() => gate.promise), first = f.run('cancel');
  f.context.jobs[0] = { ...f.context.jobs[0], status: 'completed', outputs: [{ filename: 'final.png' }] };
  gate.resolve({ id: 'owned', backend, status: 'running', cancellation: { state: 'requested' }, outputs: [] });
  await first; assert.equal(f.context.jobs[0].status, 'completed'); assert.equal(f.context.jobs[0].outputs[0].filename, 'final.png');
});
test('foreign backend or job responses are never adopted', async () => {
  for (const changed of [{ id: 'another' }, { backend: 'http://127.0.0.1:8189' }]) {
    const f = fixture(() => ({ ...f.context.jobs[0], ...changed, status: 'cancelled' }));
    await assert.rejects(f.run('cancel'), /响应身份不一致/); assert.equal(f.context.jobs[0].status, 'running');
    assert.equal(f.context.controllingJobs.size, 0);
  }
});
test('lost cancellation response leaves state unresolved and releases only the UI lock', async () => {
  const f = fixture(() => { throw Error('connection lost'); });
  await assert.rejects(f.run('cancel'), /查询原任务/);
  assert.equal(f.context.jobs[0].status, 'running'); assert.equal(f.context.controllingJobs.size, 0);
  assert.equal(f.calls.length, 1);
});
test('active or unknown jobs cannot enter actual retry handler even if invoked directly', async () => {
  const code = source.slice(source.indexOf('async function retryJob('), source.indexOf('function saveRetryRequests('));
  for (const status of ['running', 'unknown']) {
    let touched = false;
    const context = { ...jobState, jobs: [{ id: 'owned', status }], retrying: new Set(), retryRequests: new Map(), api() { touched=true; } };
    vm.runInNewContext(code, context); await assert.rejects(context.retryJob('owned'), /不能换请求/); assert.equal(touched, false);
  }
});

test('actual queue renders unknown as active with original outputs, query and indeterminate progress', () => {
  const code = source.slice(source.indexOf('function renderJobs('), source.indexOf('async function pollJobs('));
  const element = () => ({ textContent: '', style: {}, attrs: new Map(), classes: new Set(),
    classList: { toggle(key, on) { if (on) this.owner.classes.add(key); else this.owner.classes.delete(key); } },
    setAttribute(key, value) { this.attrs.set(key, value); }, removeAttribute(key) { this.attrs.delete(key); },
    getAttribute(key) { return this.attrs.get(key); } });
  const fields = 'card title status elapsed track bar state error warning provenance livePreview previewStatus thumbs locate reuse retry cancel refresh'.split(' ');
  const view = Object.fromEntries(fields.map(key => [key, element()]));
  for (const item of Object.values(view)) item.classList.owner = item;
  const outputs = [{ type: 'image', filename: 'partial.png' }]; view.outputSignature = JSON.stringify(outputs);
  const list = { children: [view.card], querySelector: () => null };
  const els = { '#jobs-list': list, '#job-count': {}, '#jobs-filter-count': {}, '#job-status-filter': { value: 'active' }, '#job-search': { value: '' } };
  const context = { ...jobState, liveProgressText, elapsedText, previewStatusText, progressPercent, filterJobs,
    jobs: [{ id: 'owned', backend, status: 'unknown', outputs, progress: 99, can_retry: true, can_cancel: true }],
    $: selector => els[selector], jobViews: new Map([['owned', view]]), graph: { nodes: [] },
    jobTitle: () => '原任务', resultForJob: () => null, reusing: new Set(), retrying: new Set(), retryRequests: new Map(), controllingJobs: new Set(), updateNodeJobStatus() {} };
  vm.runInNewContext(code, context); context.renderJobs();
  assert.equal(els['#job-count'].textContent, '1'); assert.equal(view.status.textContent, '待确认');
  assert.equal(view.retry.hidden, true); assert.equal(view.retry.disabled, true); assert.equal(view.cancel.disabled, true);
  assert.equal(view.refresh.hidden, false); assert.equal(view.refresh.disabled, false);
  assert.equal(view.track.classes.has('indeterminate'), true); assert.equal(view.track.attrs.has('aria-valuenow'), false);
  assert.equal(view.bar.style.width, '0%'); assert.equal(view.thumbs.hidden, false);
  assert.match(view.warning.textContent, /不可重试此任务/); assert.deepEqual(context.jobs[0].outputs, outputs);
});
