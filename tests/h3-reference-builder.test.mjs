import test from 'node:test';
import assert from 'node:assert/strict';
import { createH3ReferenceBuilder, h3TemplateRequest } from '../web/h3-reference-builder.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.attrs = {}; this.textContent = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(key, fn) { (this.events[key] ||= []).push(fn); }
  querySelectorAll(tag) { return this.children.flatMap(item => [...(item.tagName === tag ? [item] : []), ...item.querySelectorAll(tag)]); }
  async fire(key) { for (const fn of this.events[key] || []) await fn(); }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function setup(t) {
  const old = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { globalThis.document = old; });
  const state = { context: 'original', draft: { kind: 'h3_ref', positive: 'test', models: {}, seed: 42, references: [{ name: 'old.png' }] },
    engine: { online: true, backend_url: 'http://127.0.0.1:8188', generation_options: { h3_reference: Object.fromEntries(['images', 'videos', 'audios', 'soundtracks'].map(key => [key, { available: true, max_count: 9 }])) } }, calls: [], applied: [], errors: [] };
  state.response = { backend_url: state.engine.backend_url, status: 'prepared', document: { format: 'frameweave-workflow', name: 'H3' } };
  const control = createH3ReferenceBuilder({ engine: () => state.engine, draft: () => state.draft, context: () => state.context,
    api: async (...args) => { state.calls.push(args); return state.response; }, reportError: error => state.errors.push(error.message),
    onPrepared: async (document, guard) => { guard(); state.applied.push(document); } });
  return { state, control, button: control.element.querySelectorAll('button')[0],
    select: name => control.element.querySelectorAll('select').find(item => item.attrs['aria-label'] === name) };
}

test('copies only template parameters and does not reuse media or mutate the studio draft', () => {
  const draft = { kind: 'h3_ref', positive: '', models: { dit: '' }, references: [{ name: 'old.png', backend: 'private' }], reference_roles: ['reference'], pending: 'do not copy' };
  const request = h3TemplateRequest(draft); assert.deepEqual(request, { kind: 'h3_ref', positive: '', models: { dit: '' } });
  request.models.dit = 'new'; assert.equal(draft.models.dit, '');
  assert.throws(() => h3TemplateRequest({ kind: 'h3_t2v' }), /H3/);
});

test('explicit topology produces a standard-package preparation only, with video soundtracks off by default', async t => {
  const h = setup(t); await h.button.fire('click');
  assert.equal(h.state.calls.length, 1); assert.equal(h.state.calls[0][0], '/api/h3-reference/prepare');
  assert.deepEqual(h.state.calls[0][1].layout, { image_count: 0, videos: [{ soundtrack: false }], audio_count: 0 });
  assert.equal(h.state.calls[0][1].preset_request.references, undefined);
  assert.equal(h.state.applied.length, 1); assert.deepEqual(h.state.draft.references, [{ name: 'old.png' }]);
});

test('video soundtrack pairing follows the selected slots; removed slots do not return enabled', async t => {
  const h = setup(t), count = h.select('参考视频数量'); count.value = '3'; await count.fire('change');
  const checks = h.control.element.querySelectorAll('input'); checks[1].checked = true; await checks[1].fire('change');
  await h.button.fire('click'); assert.deepEqual(h.state.calls[0][1].layout.videos, [{ soundtrack: false }, { soundtrack: true }, { soundtrack: false }]);
  count.value = '1'; await count.fire('change'); count.value = '3'; await count.fire('change');
  assert.deepEqual(h.control.element.querySelectorAll('input').map(item => item.checked), [false, false, false]);
});

test('empty topology is rejected before the API; audio-only topology is allowed', async t => {
  const h = setup(t); h.select('参考视频数量').value = '0'; await h.select('参考视频数量').fire('change');
  await h.button.fire('click'); assert.equal(h.state.calls.length, 0); assert.match(h.state.errors[0], /至少/);
  h.select('独立音频数量').value = '2'; await h.select('独立音频数量').fire('change'); await h.button.fire('click');
  assert.deepEqual(h.state.calls[0][1].layout, { image_count: 0, videos: [], audio_count: 2 });
});

test('duplicate clicks and late response after a changed draft cannot open the package editor', async t => {
  const h = setup(t), pending = deferred(); h.state.response = pending.promise;
  const click = h.button.fire('click'); await h.button.fire('click'); assert.equal(h.state.calls.length, 1);
  h.state.draft.seed = 43; pending.resolve({ backend_url: h.state.engine.backend_url, status: 'prepared', document: {} });
  await click; assert.equal(h.state.applied.length, 0); assert.match(h.state.errors[0], /已变化/); assert.equal(h.button.disabled, false);
});

test('canvas/navigation changes and foreign backend response are refused', async t => {
  const h = setup(t), pending = deferred(); h.state.response = pending.promise;
  const click = h.button.fire('click'); h.state.context = 'different-canvas'; pending.resolve({}); await click;
  assert.equal(h.state.applied.length, 0); assert.match(h.state.errors[0], /已变化/);
  h.state.response = { backend_url: 'http://127.0.0.1:8189', status: 'prepared', document: {} };
  await h.button.fire('click'); assert.match(h.state.errors[1], /其他引擎/);
});

test('missing capability and old backend errors remain specific; refresh does not alter topology', async t => {
  const h = setup(t);
  h.state.engine.generation_options = { h3_reference: { videos: { available: false, max_count: 0, reason: '缺少 24fps 视频加载协议' } } };
  h.control.update(); assert.match(h.control.element.querySelectorAll('p').map(item => item.textContent).join(' '), /24fps/);
  h.state.response = { backend_url: h.state.engine.backend_url, status: 'blocked', blocked: [{ message: '接口不存在 404' }] };
  await h.button.fire('click'); assert.match(h.state.errors[0], /只刷新页面/); assert.equal(h.state.applied.length, 0);
  h.state.engine.online = false; h.control.update(); assert.equal(h.button.disabled, true);
  assert.equal(h.select('参考视频数量').value, '1');
});

test('an old running backend disables the new action until it advertises the protocol', async t => {
  const h = setup(t), capability = h.state.engine.generation_options.h3_reference;
  delete h.state.engine.generation_options.h3_reference;
  h.control.update(); assert.equal(h.button.disabled, true);
  assert.match(h.control.element.querySelectorAll('p').map(item => item.textContent).join(' '), /仅刷新页面/);
  await h.button.fire('click'); assert.equal(h.state.calls.length, 0);
  h.state.engine.generation_options.h3_reference = capability;
  h.control.update(); assert.equal(h.button.disabled, false);
});
