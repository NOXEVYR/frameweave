import test from 'node:test';
import assert from 'node:assert/strict';
import { createGenerationStudio } from '../web/generation-studio.mjs';
import { newDraft } from '../web/studio-state.mjs';

const key = 'prismcanvas.studio.v1';
function fixture(t, { value = '{}', failRead = false, failWrite = false } = {}) {
  const previous = Object.fromEntries(['document', 'window', 'localStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const [name, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  const state = { values: new Map([[key, value]]), writes: [], calls: [], toasts: [], failRead, failWrite };
  const root = { querySelectorAll: () => [] };
  globalThis.document = { querySelector: selector => selector === '#studio-root' ? root : null,
    querySelectorAll: () => [], body: { dataset: {}, classList: { remove() {} } } };
  globalThis.window = { dispatchEvent() {} };
  globalThis.localStorage = {
    getItem(name) { if (state.failRead) throw new Error('read failed'); return state.values.get(name) ?? null; },
    setItem(name, data) { state.writes.push({ name, data }); if (state.failWrite) throw new Error('quota failed'); state.values.set(name, data); },
  };
  const studio = createGenerationStudio({ engine: () => ({ backend_url: 'http://127.0.0.1:8188' }),
    api: (...args) => { state.calls.push(args); throw new Error('flush must not call transport'); },
    toast: (...args) => state.toasts.push(args), reportError: error => { throw error; } });
  return { studio, state };
}

test('uninitialized studio flush preserves the unread prior record without writing defaults', t => {
  const original = '{"unread":"must remain"}', f = fixture(t, { value: original });
  assert.equal(f.studio.flushDrafts(), true); assert.equal(f.state.values.get(key), original);
  assert.deepEqual(f.state.writes, []); assert.deepEqual(f.state.calls, []);
});

test('public studio flush writes the existing complete state, including frozen unknown submission and audio scalar literals', t => {
  const request = { request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'unknown',
    request: { kind: 'sdxl', positive: '', seed: 0, custom_size: false }, backend: 'http://127.0.0.1:8188' };
  const saved = { drafts: { txt2img: { ...newDraft('txt2img', 'sdxl'), positive: '', seed: 0 } },
    kindDrafts: { txt2img: { sdxl: { ...newDraft('txt2img', 'sdxl'), positive: 'cached kind' } } },
    pending: { txt2img: request }, selectedJobs: { txt2img: 'job-retained' },
    audioDrafts: { voice: { package_id: 'p-test', values: { text: '', flag: false, amount: 0 },
      valuesByPackage: { 'p-test': { text: 'cached voice', flag: false, amount: 0 } }, mediaBackends: {}, mediaBackendsByPackage: {} } },
    audioCategory: 'voice', recipeBackups: { txt2img: { ...newDraft('txt2img', 'sdxl'), positive: 'backup' } } };
  const f = fixture(t, { value: JSON.stringify(saved) }); f.studio.init(); const before = f.state.values.get(key);
  assert.equal(f.studio.hasPending(), true); assert.equal(f.studio.flushDrafts(), true);
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.writes[0].name, key);
  const written = JSON.parse(f.state.values.get(key));
  assert.deepEqual(Object.keys(written).sort(), ['drafts', 'kindDrafts', 'pending', 'selectedJobs', 'audioDrafts', 'audioCategory', 'recipeBackups'].sort());
  assert.equal(written.drafts.txt2img.positive, ''); assert.equal(written.drafts.txt2img.seed, 0);
  assert.equal(written.kindDrafts.txt2img.sdxl.positive, 'cached kind'); assert.deepEqual(written.pending.txt2img, request);
  assert.deepEqual(written.selectedJobs, saved.selectedJobs); assert.deepEqual(written.audioDrafts.voice.values, saved.audioDrafts.voice.values);
  assert.deepEqual(written.audioDrafts.voice.valuesByPackage, saved.audioDrafts.voice.valuesByPackage);
  assert.equal(written.audioCategory, 'voice'); assert.equal(written.recipeBackups.txt2img.positive, 'backup');
  assert.equal(f.studio.hasPending(), true); assert.deepEqual(f.state.calls, []); assert.notEqual(before, f.state.values.get(key));
});

test('critical flush propagates quota failure, preserves prior stored bytes and never retries or submits', t => {
  const f = fixture(t, { value: '{}', failWrite: true }); f.studio.init();
  assert.throws(() => f.studio.flushDrafts(), /无法保存/);
  assert.equal(f.state.writes.length, 1); assert.equal(f.state.values.get(key), '{}'); assert.deepEqual(f.state.calls, []);
  assert.equal(f.state.toasts.length, 0);
  f.state.failWrite = false; assert.equal(f.studio.flushDrafts(), true); assert.equal(f.state.writes.length, 2);
  assert.equal(JSON.parse(f.state.values.get(key)).audioCategory, 'voice');
});

for (const [reason, options] of [['malformed prior JSON', { value: '{invalid' }], ['failed prior read', { value: '{"original":true}', failRead: true }]]) {
  test(`critical flush refuses automatic overwrite after ${reason}`, t => {
    const f = fixture(t, options); const before = f.state.values.get(key); f.studio.init();
    assert.throws(() => f.studio.flushDrafts(), /原草稿未能读取/);
    assert.equal(f.state.values.get(key), before); assert.deepEqual(f.state.writes, []); assert.deepEqual(f.state.calls, []);
    assert.equal(f.state.toasts.length, 1);
  });
}
