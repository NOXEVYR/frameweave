import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { STUDIO_MODES, newDraft, buildStudioRequest } from '../web/studio-state.mjs';
import { elapsedText, updateLiveProgress } from '../web/job-progress.mjs';
import { buildAudioPackageRequest, renderAudioFields } from '../web/audio-studio.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';
import { studioModeForKind } from '../web/studio-recipes.mjs';
import { studioOutputSize } from '../web/generation-studio.mjs';
import * as jobState from '../web/job-state.mjs';

const source = await readFile(new URL('../web/generation-studio.mjs', import.meta.url), 'utf8');
const functions = (start, end) => {
  const offset = source.indexOf(start);
  assert.ok(offset >= 0, `Missing actual studio function ${start}`);
  const finish = source.indexOf(end, offset);
  assert.ok(finish > offset, `Missing actual studio function boundary ${end}`);
  return source.slice(offset, finish);
};
const backend = 'http://127.0.0.1:8188';
class Element {
  constructor(tag, className = '', text) {
    this.tagName = tag.toUpperCase(); this.className = className; this.textContent = text;
    this.children = []; this.listeners = {}; this.attributes = {}; this.classList = { add() {} };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
const find = (element, match) => match(element) ? element : element.children?.map(child => find(child, match)).find(Boolean);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class Reader { readAsDataURL() { this.result = 'data:image/png;base64,dGVzdA=='; this.onload(); } }

// Execute the real closure functions, with only DOM, transport and persistence replaced.
// The real request builders and upload tickets are shared with the renderer under test.
function studio(mode, api) {
  const draft = { ...newDraft(mode, mode === 'img2img' ? 'qwen21_edit' : 'h3_i2v'), positive: 'test',
    references: [{ name: 'old.png', backend }], models: mode === 'video' ? { dit: 'h3.safetensors' } : {} };
  const errors = [], dispatched = [], saved = [], container = new Element('div');
  const context = vm.createContext({
    drafts: { [mode]: draft }, mode, activeBackend: backend, mediaBackendEpoch: 0, audioContextEpoch: 0, audioObservedBackend: null, mediaTransfers: createMediaTransfers(),
    busy: new Set(), recipeTransfers: new Set(), pending: {}, backend: () => context.activeBackend,
    node: (tag, css, text) => new Element(tag, css, text), pause() {}, safeURL: value => value,
    action(text, css, callback) { const button = new Element('button', css, text); button.listeners.click = callback; return button; },
    FileReader: Reader, refresh() {}, save() { saved.push(structuredClone(context.drafts)); },
    host: { api, toast() {}, reportError: error => errors.push(error), engine: () => ({ online: true, generation_options: {} }) },
    validateSelectedQwenModels() {}, buildStudioRequest, buildAudioPackageRequest,
    crypto: { randomUUID: () => 'fixed-request-id' },
    dispatchPending: async key => { dispatched.push(structuredClone(context.pending[key])); },
  });
  vm.runInContext(functions('  function mediaOwner(', '  const save =') +
    functions('  function syncAudioBackendContext(', '  function newAudioDraft(') +
    functions('  function references(', '  function render(') +
    functions('  function buildRequest(', '  async function inspect(') +
    functions('  async function submit(', '  async function dispatchPending('), context);
  context.references(mode, container);
  return { context, container, draft, errors, dispatched, saved,
    input: () => find(container, item => item.tagName === 'INPUT' && item.type === 'file'),
    keep: () => find(container, item => item.className?.includes('studio-keep-media')) };
}
const file = name => ({ name, size: 20, type: 'image/png' });

test('image/video studio actual upload callback blocks request building and submission of old references', async t => {
  for (const mode of ['img2img', 'video']) await t.test(mode, async () => {
    const started = deferred(), result = deferred();
    const view = studio(mode, () => { started.resolve(); return result.promise; });
    const before = structuredClone(view.draft.references), input = view.input(); input.files = [file('new.png')];
    const uploading = input.listeners.change(); await started.promise;
    assert.deepEqual(view.draft.references, before);
    assert.throws(() => view.context.buildRequest(mode), /正在上传/);
    await assert.rejects(() => view.context.submit(mode), /正在上传/);
    assert.equal(view.dispatched.length, 0); assert.deepEqual(Object.keys(view.context.pending), []);
    result.resolve({ name: 'new.png', backend }); await uploading;
    await view.context.submit(mode);
    assert.deepEqual(view.dispatched[0].request.references, ['old.png', 'new.png']);
    assert.equal(view.dispatched[0].request_id, 'fixed-request-id');
  });
});

test('studio batch failure keeps the complete original list and requires explicit recovery before submit', async () => {
  let attempts = 0;
  const view = studio('img2img', async () => {
    if (++attempts === 2) throw new Error('第二张图片上传失败');
    return { name: 'first-new.png', backend };
  });
  const input = view.input(); input.files = [file('first.png'), file('second.png')];
  await input.listeners.change();
  assert.deepEqual(view.draft.references.map(ref => ref.name), ['old.png']);
  assert.throws(() => view.context.buildRequest('img2img'), /上传失败/);
  await assert.rejects(() => view.context.submit('img2img'), /上传失败/);
  assert.equal(view.dispatched.length, 0); assert.equal(view.errors.length, 1);
  assert.match(view.keep().textContent, /保留原参考图/); view.keep().listeners.click();
  await view.context.submit('img2img');
  assert.deepEqual(view.dispatched[0].request.references, ['old.png']);
});

test('studio can reselect after failure and discards superseded or explicitly abandoned responses', async () => {
  const first = deferred(), second = deferred(), firstStarted = deferred(), secondStarted = deferred();
  let attempts = 0;
  const view = studio('img2img', () => {
    if (++attempts === 1) { firstStarted.resolve(); return first.promise; }
    if (attempts === 2) { secondStarted.resolve(); return second.promise; }
    return Promise.resolve({ name: 'retry.png', backend });
  });
  let input = view.input(); input.files = [file('first.png')]; const uploadingFirst = input.listeners.change(); await firstStarted.promise;
  input = view.input(); input.files = [file('second.png')]; const uploadingSecond = input.listeners.change(); await secondStarted.promise;
  second.reject(new Error('最新上传失败')); await uploadingSecond;
  first.resolve({ name: 'first.png', backend }); await uploadingFirst;
  assert.throws(() => view.context.buildRequest('img2img'), /上传失败/);
  assert.deepEqual(view.draft.references.map(ref => ref.name), ['old.png']);
  input = view.input(); input.files = [file('retry.png')]; const retry = input.listeners.change();
  await retry;
  assert.deepEqual(Array.from(view.context.buildRequest('img2img').references), ['old.png', 'retry.png']);
  assert.equal(view.keep(), undefined);
});

test('studio preserving originals while an upload is pending invalidates its eventual success', async () => {
  const started = deferred(), result = deferred();
  const view = studio('img2img', () => { started.resolve(); return result.promise; });
  const input = view.input(); input.files = [file('new.png')]; const uploading = input.listeners.change(); await started.promise;
  view.keep().listeners.click(); await view.context.submit('img2img');
  result.resolve({ name: 'new.png', backend }); await uploading;
  assert.deepEqual(view.draft.references.map(ref => ref.name), ['old.png']);
  assert.deepEqual(view.dispatched[0].request.references, ['old.png']);
  assert.equal(view.errors.length, 0);
});

test('studio discards uploads after switching engines even if the original engine is restored', async () => {
  const started = deferred(), result = deferred();
  const view = studio('video', () => { started.resolve(); return result.promise; });
  const input = view.input(); input.files = [file('new.png')]; const uploading = input.listeners.change(); await started.promise;
  view.context.activeBackend = 'http://127.0.0.1:8189';
  view.context.syncAudioBackendContext();
  view.context.activeBackend = backend;
  result.resolve({ name: 'new.png', backend }); await uploading;
  assert.deepEqual(view.draft.references.map(ref => ref.name), ['old.png']);
  await assert.rejects(() => view.context.submit('video'), /上传失败/);
  assert.equal(view.dispatched.length, 0);
});

test('restoring a kind draft while its old upload is pending still blocks the old references', async () => {
  const started = deferred(), result = deferred();
  const view = studio('img2img', () => { started.resolve(); return result.promise; });
  const input = view.input(); input.files = [file('new.png')]; const uploading = input.listeners.change(); await started.promise;
  view.context.drafts.img2img = structuredClone(view.draft);
  await assert.rejects(() => view.context.submit('img2img'), /正在上传/);
  result.resolve({ name: 'new.png', backend }); await uploading;
  await assert.rejects(() => view.context.submit('img2img'), /上传失败/);
  view.context.references('img2img', view.container); view.keep().listeners.click();
  await view.context.submit('img2img');
  assert.deepEqual(view.dispatched[0].request.references, ['old.png']);
});

test('audio studio actual submit does not freeze old audio package values during upload', async t => {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  globalThis.document = { createElement: tag => new Element(tag) }; globalThis.FileReader = Reader;
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldReader) Object.defineProperty(globalThis, 'FileReader', oldReader); else delete globalThis.FileReader;
  });
  const pack = { id: 'voice', eligible: true, fields: [{ id: 'ref', type: 'audio', required: true }] };
  const draft = { package_id: pack.id, values: { ref: 'old.wav' }, mediaBackends: { ref: backend } };
  const view = studio('img2img', () => {}), container = new Element('div'), started = deferred(), result = deferred();
  Object.assign(view.context, { audioDrafts: { voice: draft }, audioCapabilitiesBackend: backend, audioChoices: { stale: false }, currentAudioPackage: () => pack });
  renderAudioFields(container, { pack, draft, backend, api: () => { started.resolve(); return result.promise; }, onChange() {}, reportError: error => view.errors.push(error) });
  const input = find(container, item => item.tagName === 'INPUT'); input.files = [{ name: 'new.wav', size: 20, type: 'audio/wav' }];
  const uploading = input.listeners.change(); await started.promise;
  await assert.rejects(() => view.context.submit('audio_voice'), /正在上传/);
  assert.equal(view.dispatched.length, 0); assert.deepEqual(Object.keys(view.context.pending), []);
  result.resolve({ name: 'new.wav', backend }); await uploading;
  await view.context.submit('audio_voice');
  assert.equal(view.dispatched[0].request.values.ref, 'new.wav');
});

test('studio live result refreshes queue rank, execution label and reconnect state while retaining the same preview', () => {
  const view = studio('video', () => {}), context = view.context;
  let job = { id: 'job-1', kind: 'h3_i2v', status: 'queued', queue_position: 3, elapsed: 5, progress_connected: true, preview_url: '/preview?v=1' };
  const attributes = new Map(); let imageLoads = 0, updates = 0;
  const image = { getAttribute: key => attributes.get(key), removeAttribute: key => attributes.delete(key), set src(value) { attributes.set('src', value); imageLoads++; } };
  const bar = { classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; }, removeAttribute(key) { delete this[key]; } };
  const elements = { detail: {}, caption: {}, image, bar };
  const live = { dataset: { jobId: job.id }, querySelector: selector => ({ '.live-detail': elements.detail, progress: bar, '.live-preview': image, '.live-preview-status': elements.caption })[selector] };
  const cancel = {}, query = {};
  const area = { querySelector: selector => ({ '.studio-live-progress': live, '.studio-job-cancel': cancel, '.studio-job-refresh': query })[selector], replaceChildren() { assert.fail('An active preview must keep its existing elements'); } };
  const toolbar = new Element('div'), history = new Element('div');
  const panel = { querySelector: selector => ({ '.studio-result-toolbar': toolbar, '.studio-history': history, '.studio-preview': area })[selector] };
  Object.assign(context, jobState, { STUDIO_MODES, studioOutputSize, studioModeForKind, selectedJobs: {}, audioChoices: { packages: [] }, lastMedia: new Map(), elapsedText,
    labels: { queued: '排队中', running: '生成中' }, updateLiveProgress: (currentElements, currentJob) => { updates++; updateLiveProgress(currentElements, currentJob); } });
  context.host.jobs = () => [job];
  vm.runInContext(functions('  function resultPanel(', '  function refresh()'), context);
  context.resultPanel('video', panel); assert.match(elements.detail.textContent, /第 3 位/);
  job = { ...job, queue_position: 2 }; context.resultPanel('video', panel); assert.match(elements.detail.textContent, /第 2 位/);
  // Duration is intentionally outside the output signature; it must still reach the live bar.
  job = { ...job, elapsed: 65 }; context.resultPanel('video', panel); assert.match(bar['aria-valuetext'], /1 分 5 秒/);
  job = { ...job, status: 'running', execution_node: '9', execution_label: '视频解码', execution_nodes: ['9'], cached_nodes: ['1'] };
  context.resultPanel('video', panel); assert.match(elements.detail.textContent, /节点 9（视频解码）/);
  job = { ...job, execution_label: '声音解码', progress_identity_unknown: true }; context.resultPanel('video', panel);
  assert.match(elements.detail.textContent, /节点 9（声音解码）.*旧任务实时订阅尚未恢复/);
  assert.equal(updates, 5); assert.equal(imageLoads, 1);
  job = { ...job, cancellation: { id: crypto.randomUUID(), state: 'requested' } };
  context.resultPanel('video', panel); assert.match(elements.detail.textContent, /取消已请求/); assert.equal(cancel.disabled, true); assert.equal(query.hidden, false);
  job = { ...job, cancellation: { ...job.cancellation, state: 'unavailable' } };
  context.resultPanel('video', panel); assert.equal(cancel.disabled, false); assert.match(cancel.textContent, /重试安全取消/);
  job = { ...job, status: 'unknown', progress: 99 };
  context.resultPanel('video', panel); assert.equal(cancel.disabled, true); assert.match(elements.detail.textContent, /状态待确认/); assert.equal('value' in bar, false);
  assert.equal(imageLoads, 1);
});
