import test from 'node:test';
import assert from 'node:assert/strict';
import * as state from '../web/job-state.mjs';
import { liveProgressText, previewStatusText } from '../web/job-progress.mjs';

const original = 'http://127.0.0.1:8188', other = 'http://127.0.0.1:8189';
for (const cancel of ['requesting', 'requested', 'uncertain']) test(`${cancel} keeps the job active and cannot confirm or repeat cancellation`, () => {
  const job = { status: 'running', cancellation: { id: crypto.randomUUID(), state: cancel }, progress: 30 };
  assert.equal(state.isJobActive(job), true); assert.equal(state.isJobTerminal(job), false);
  assert.equal(state.canCancelJob(job), false); assert.equal(state.canRefreshJob(job), true);
  assert.match(state.jobStatusLabel(job), /取消/); assert.doesNotMatch(liveProgressText(job), /任务已取消/);
});
test('unknown keeps identity and existing outputs active and cannot be cancelled or retried by labels', () => {
  const job = { id: 'owned', status: 'unknown', backend: original, outputs: [{ filename: 'partial.png' }] }, before = structuredClone(job);
  assert.equal(state.isJobActive(job), true); assert.equal(state.canCancelJob(job), false);
  assert.match(liveProgressText(job), /查询原任务/); assert.match(previewStatusText(job), /不是最终结果/);
  assert.equal(state.canSwitchJobBackend([job], other, original), false);
  assert.deepEqual(job, before);
});
test('unavailable cancellation is not terminal and may be explicitly retried only when backend allows', () => {
  const job = { status: 'running', can_cancel: true, cancellation: { state: 'unavailable' } };
  assert.equal(state.canCancelJob(job), true); assert.match(state.cancelActionLabel(job), /重试安全取消/);
  assert.match(state.cancellationText(job), /无法安全取消/);
  assert.equal(state.canCancelJob({ ...job, can_cancel: false }), false);
});
test('native success, failure and confirmed cancel override an earlier cancellation request', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const job = { status, cancellation: { state: 'requested', message: '旧的取消请求文字' } };
    assert.equal(state.isJobActive(job), false); assert.equal(state.canCancelJob(job), false);
    assert.equal(state.canRefreshJob(job), false); assert.doesNotMatch(state.jobStateDetail(job), /旧的/);
  }
  assert.match(state.jobStateDetail({ status: 'completed', cancellation: {} }), /自然完成/);
});
test('only the common original backend can be restored while unresolved jobs remain', () => {
  const jobs = [{ status: 'unknown', backend: original }, { status: 'running', backend: original }];
  assert.equal(state.canSwitchJobBackend(jobs, original, other), true);
  assert.equal(state.canSwitchJobBackend(jobs, 'http://localhost:8188/', other), true);
  assert.equal(state.canSwitchJobBackend(jobs, 'http://127.0.0.1:8190', other), false);
  assert.equal(state.canSwitchJobBackend([...jobs, { status: 'unknown', backend: other }], original, other), false);
  assert.equal(state.canSwitchJobBackend([{ status: 'completed', backend: original }], other, original), true);
});
test('cancellation identity requires a real UUID, not a label or filename', () => {
  assert.equal(state.cancellationId({ cancellation: { id: 'cancelled' } }), null);
  const id = crypto.randomUUID(); assert.equal(state.cancellationId({ cancellation: { id } }), id);
});
