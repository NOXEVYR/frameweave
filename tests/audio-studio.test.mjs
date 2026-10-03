import test from 'node:test';
import assert from 'node:assert/strict';
import { audioIntegrationRequest, audioMediaIssue, audioPackageChoices, audioUploadContextMatches, buildAudioPackageRequest, renderAudioFields } from '../web/audio-studio.mjs';

const backend = 'http://127.0.0.1:8188';
const packageDoc = { id: 'p-audio', name: '参考音频配音', fields: [
  { id: 'prompt', label: '台词', type: 'text', required: true },
  { id: 'voice_audio', label: '声音参考', type: 'audio', required: true },
  { id: 'steps', label: '采样步数', type: 'integer', required: true, default: 8, min: 1, max: 40 },
] };

test('audio package choices require the capability report to match the active backend and preserve ineligible reasons', () => {
  const report = { backend_url: backend, available: true, packages: [
    { id: packageDoc.id, name: 'Backend name', category: 'unclassified', eligible: true, available: true, audio_outputs: [{ type: 'audio' }] },
    { id: 'p-missing', name: 'Needs Audio VAE', eligible: false, available: false, reason: '缺少 AUDIO 解码器' },
  ] };
  const current = audioPackageChoices(report, [packageDoc], backend);
  assert.equal(current.stale, false);
  assert.equal(current.packages[0].fields[1].type, 'audio');
  assert.equal(current.packages[1].eligible, false);
  assert.match(current.packages[1].reason, /AUDIO 解码器/);
  assert.deepEqual(audioPackageChoices(report, [packageDoc], 'http://127.0.0.1:9999'), { stale: true, available: false, packages: [] });
});

test('audio package requests preserve scalar and uploaded media values without embedding file bytes', () => {
  const pack = { ...packageDoc, eligible: true, available: true };
  const draft = { package_id: pack.id, values: { prompt: '清晰温柔的旁白', voice_audio: 'input/voice.wav', steps: 12 }, mediaBackends: { voice_audio: backend } };
  assert.deepEqual(buildAudioPackageRequest(pack, draft, backend), {
    kind: 'package', package_id: pack.id,
    values: { prompt: '清晰温柔的旁白', steps: 12, voice_audio: 'input/voice.wav' },
  });
});

test('audio package requests refuse unsupported, missing, changed, or cross-backend inputs', () => {
  const pack = { ...packageDoc, eligible: true, available: true };
  const base = { package_id: pack.id, values: { prompt: '朗读内容', voice_audio: 'voice.wav', steps: 8 }, mediaBackends: { voice_audio: backend } };
  assert.throws(() => buildAudioPackageRequest({ ...pack, eligible: false, reason: '没有 AUDIO 输出' }, base, backend), /没有 AUDIO 输出/);
  assert.throws(() => buildAudioPackageRequest(pack, { ...base, package_id: 'p-other' }, backend), /已切换/);
  assert.throws(() => buildAudioPackageRequest(pack, { ...base, values: { ...base.values, voice_audio: '' } }, backend), /音频输入/);
  assert.throws(() => buildAudioPackageRequest(pack, { ...base, mediaBackends: { voice_audio: 'http://127.0.0.1:9999' } }, backend), /另一个推理引擎/);
});

test('audio integration note includes version, AUDIO classes and safe reasons but excludes private content', () => {
  const note = audioIntegrationRequest({ system: { comfyui_version: '0.3.26', name: 'C:\\private\\model.safetensors' } }, {
    outputs: [{ class_type: 'SaveAudio', input: 'audio' }, { class_type: '../private/model.safetensors', input: 'audio' }],
    packages: [
      { id: 'secret-id', name: 'private prompt and model', eligible: false, available: false,
        reason: '工作流包没有连接到 AUDIO 输入的后端输出节点', issues: ['C:\\private\\prompt.txt'] },
      { id: 'ready', name: 'local voice', eligible: true, available: true },
    ],
  });
  assert.match(note, /0\.3\.26/);
  assert.match(note, /SaveAudio/);
  assert.match(note, /当前可用 1 个/);
  assert.match(note, /工作流包没有连接到 AUDIO 输入的后端输出节点/);
  assert.doesNotMatch(note, /private|safetensors|secret-id|prompt\.txt|local voice/);
  assert.match(note, /不要自动下载模型/);
});

test('audio integration note treats malformed versions and unknown backend reasons as untrusted', () => {
  const note = audioIntegrationRequest({ system: { comfyui_version: 'C:\\private\\model.safetensors' } }, {
    reason: 'private /prompt/ model.safetensors', packages: [{ eligible: false, reason: 'private /prompt/ model.safetensors' }],
  });
  assert.match(note, /未知/);
  assert.match(note, /暂无可安全汇总的原因/);
  assert.doesNotMatch(note, /private|safetensors|model/);
});

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = {}; this.attributes = {};
    this.classList = { add: value => { this.className = `${this.className || ''} ${value}`.trim(); } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function fakeDom(t) {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  globalThis.document = { createElement: tag => new FakeElement(tag) };
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:audio/wav;base64,dGVzdA=='; this.onload(); }
  };
  t.after(() => {
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldReader) Object.defineProperty(globalThis, 'FileReader', oldReader); else delete globalThis.FileReader;
  });
}

function walk(element, predicate) {
  if (predicate(element)) return element;
  for (const child of element.children || []) { const match = walk(child, predicate); if (match) return match; }
  return null;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function audioUploadView(t, { pack, draft, api, currentBackend = () => backend, isCurrent = () => true, errors = [] }) {
  fakeDom(t);
  const container = new FakeElement('div');
  renderAudioFields(container, { pack, draft, api, backend, currentBackend, isCurrent, onChange() {}, reportError: error => errors.push(error) });
  return { container, input: walk(container, item => item.tagName === 'INPUT' && item.type === 'file'), errors };
}

function uploadContext() {
  const draft = { package_id: 'p-audio', values: {}, mediaBackends: {} };
  const expected = { epoch: 1, category: 'voice', draft, packageId: 'p-audio', backend };
  const current = { ...expected, capabilitiesBackend: backend, stale: false, fields: packageDoc.fields };
  return { draft, expected, current };
}

test('delayed audio uploads are discarded after package, category, backend, or field changes', async t => {
  for (const change of ['package', 'category', 'backend', 'field']) {
    await t.test(`reject stale ${change} context`, async t => {
      let finishUpload, started;
      const apiStarted = new Promise(resolve => { started = resolve; });
      const apiResult = new Promise(resolve => { finishUpload = resolve; });
      const context = uploadContext();
      const api = (path, body) => { started({ path, body }); return apiResult; };
      const { input, errors } = audioUploadView(t, {
        pack: { ...packageDoc, fields: [packageDoc.fields[1]] }, draft: context.draft, api,
        isCurrent: ({ field }) => audioUploadContextMatches(context.expected, context.current, field.id),
      });
      input.files = [{ name: 'reference.wav', size: 8, type: 'audio/wav' }];
      const upload = input.listeners.change();
      const request = await apiStarted;
      assert.equal(request.path, '/api/upload-audio');
      if (change === 'package') context.current = { ...context.current, packageId: 'p-other' };
      if (change === 'category') context.current = { ...context.current, category: 'music', epoch: 2 };
      if (change === 'backend') context.current = { ...context.current, backend: 'http://127.0.0.1:9999', capabilitiesBackend: 'http://127.0.0.1:9999', epoch: 2 };
      if (change === 'field') context.current = { ...context.current, fields: [] };
      if (change === 'package') context.draft.package_id = 'p-other';
      finishUpload({ name: 'input/reference.wav', backend });
      await upload;
      assert.equal(context.draft.values.voice_audio, undefined);
      assert.equal(context.draft.mediaBackends.voice_audio, undefined);
      assert.equal(errors.length, 1);
      assert.match(errors[0].message, /已切换/);
    });
  }
});

test('same-field uploads commit only the latest selection when responses arrive in reverse order', async t => {
  const pack = { ...packageDoc, fields: [packageDoc.fields[1]] };
  const draft = { package_id: pack.id, values: {}, mediaBackends: {} };
  const errors = [];
  const firstStarted = deferred(), secondStarted = deferred(), firstResult = deferred(), secondResult = deferred();
  let requestCount = 0;
  const api = (path, body) => {
    const index = requestCount++;
    if (index === 0) { firstStarted.resolve({ path, body }); return firstResult.promise; }
    secondStarted.resolve({ path, body }); return secondResult.promise;
  };
  const { input } = audioUploadView(t, { pack, draft, api, errors });
  input.files = [{ name: 'reference-a.wav', size: 8, type: 'audio/wav' }];
  const first = input.listeners.change();
  assert.equal((await firstStarted.promise).body.name, 'reference-a.wav');
  input.files = [{ name: 'reference-b.wav', size: 8, type: 'audio/wav' }];
  const second = input.listeners.change();
  assert.equal((await secondStarted.promise).body.name, 'reference-b.wav');

  secondResult.resolve({ name: 'input/reference-b.wav', backend });
  await second;
  assert.equal(draft.values.voice_audio, 'input/reference-b.wav');
  firstResult.resolve({ name: 'input/reference-a.wav', backend });
  await first;
  assert.equal(draft.values.voice_audio, 'input/reference-b.wav');
  assert.deepEqual(draft.mediaBackends, { voice_audio: backend });
  assert.equal(errors.length, 0);
});

test('audio picker advertises and accepts only WAV, MP3, FLAC, and OGG', async t => {
  const pack = { ...packageDoc, fields: [packageDoc.fields[1]] };
  const draft = { package_id: pack.id, values: {}, mediaBackends: {} };
  const uploaded = [];
  const errors = [];
  const { container, input } = audioUploadView(t, {
    pack, draft, api: async (path, body) => { uploaded.push({ path, body }); return { name: `input/${body.name}`, backend }; }, errors,
  });
  assert.match(input.accept, /\.wav/); assert.match(input.accept, /\.mp3/); assert.match(input.accept, /\.flac/); assert.match(input.accept, /\.ogg/);
  assert.doesNotMatch(input.accept, /m4a|aac/i);
  assert.match(walk(container, item => item.className === 'audio-upload-name').textContent, /WAV、MP3、FLAC 或 OGG/);
  for (const extension of ['wav', 'mp3', 'flac', 'ogg']) {
    input.files = [{ name: `reference.${extension}`, size: 8, type: 'audio/octet-stream' }];
    await input.listeners.change();
    assert.equal(draft.values.voice_audio, `input/reference.${extension}`);
  }
  for (const extension of ['m4a', 'aac']) {
    input.files = [{ name: `reference.${extension}`, size: 8, type: 'audio/mp4' }];
    await input.listeners.change();
    assert.equal(draft.values.voice_audio, 'input/reference.ogg');
  }
  assert.equal(uploaded.length, 4);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(error => /WAV、MP3、FLAC、OGG/.test(error.message)));
});

test('audio and image field callbacks block old values until upload succeeds or the user explicitly keeps them', async t => {
  for (const type of ['audio', 'image']) await t.test(type, async t => {
    const field = { id: 'ref', label: '参考素材', type, required: true };
    const pack = { id: `p-${type}`, eligible: true, fields: [field] };
    const draft = { package_id: pack.id, values: { ref: `old.${type === 'audio' ? 'wav' : 'png'}` }, mediaBackends: { ref: backend } };
    const before = structuredClone(draft), result = deferred(), started = deferred();
    const view = audioUploadView(t, { pack, draft, api: () => { started.resolve(); return result.promise; } });
    view.input.files = [{ name: type === 'audio' ? 'new.wav' : 'new.png', size: 20, type: type === 'audio' ? 'audio/wav' : 'image/png' }];
    const uploading = view.input.listeners.change(); await started.promise;
    assert.deepEqual(draft, before);
    assert.match(audioMediaIssue(draft), /正在上传/);
    assert.throws(() => buildAudioPackageRequest(pack, draft, backend), /正在上传/);
    result.reject(new Error('测试上传中断')); await uploading;
    assert.deepEqual(draft, before);
    assert.throws(() => buildAudioPackageRequest(pack, draft, backend), /上传失败/);
    assert.match(walk(view.container, item => item.className === 'audio-upload-name').textContent, /原值.*已保留/);
    const keep = walk(view.container, item => item.className?.includes('audio-keep-media'));
    assert.equal(keep.hidden, false); keep.listeners.click();
    assert.equal(buildAudioPackageRequest(pack, draft, backend).values.ref, before.values.ref);
    assert.equal(audioMediaIssue(draft), '');
  });
});

test('reselecting after failure commits the new media and reopening the form retains the recovery state', async t => {
  const pack = { ...packageDoc, eligible: true, fields: [packageDoc.fields[1]] };
  const draft = { package_id: pack.id, values: { voice_audio: 'old.wav' }, mediaBackends: { voice_audio: backend } };
  let attempts = 0;
  const api = async () => { if (++attempts === 1) throw new Error('上传失败'); return { name: 'new.wav', backend }; };
  const view = audioUploadView(t, { pack, draft, api });
  view.input.files = [{ name: 'new.wav', size: 20, type: 'audio/wav' }]; await view.input.listeners.change();
  const reopened = new FakeElement('div');
  renderAudioFields(reopened, { pack, draft, api, backend, onChange() {}, reportError() {} });
  assert.equal(walk(reopened, item => item.className?.includes('audio-keep-media')).hidden, false);
  assert.throws(() => buildAudioPackageRequest(pack, draft, backend), /上传失败/);
  const input = walk(reopened, item => item.tagName === 'INPUT' && item.type === 'file');
  input.files = [{ name: 'new.wav', size: 20, type: 'audio/wav' }]; await input.listeners.change();
  assert.equal(buildAudioPackageRequest(pack, draft, backend).values.voice_audio, 'new.wav');
  assert.equal(draft.mediaBackends.voice_audio, backend);
});

test('explicitly keeping the old value invalidates an in-flight response', async t => {
  const pack = { ...packageDoc, eligible: true, fields: [packageDoc.fields[1]] };
  const draft = { package_id: pack.id, values: { voice_audio: 'old.wav' }, mediaBackends: { voice_audio: backend } };
  const result = deferred(), started = deferred();
  const { container, input, errors } = audioUploadView(t, { pack, draft, api: () => { started.resolve(); return result.promise; } });
  input.files = [{ name: 'new.wav', size: 20, type: 'audio/wav' }];
  const uploading = input.listeners.change(); await started.promise;
  walk(container, item => item.className?.includes('audio-keep-media')).listeners.click();
  assert.equal(buildAudioPackageRequest(pack, draft, backend).values.voice_audio, 'old.wav');
  result.resolve({ name: 'new.wav', backend }); await uploading;
  assert.equal(draft.values.voice_audio, 'old.wav'); assert.equal(errors.length, 0);
});

test('failed media tickets are scoped to their package and do not affect another package', async t => {
  const pack = { ...packageDoc, eligible: true, fields: [packageDoc.fields[1]] };
  const draft = { package_id: pack.id, values: { voice_audio: 'old.wav' }, mediaBackends: { voice_audio: backend } };
  const { input } = audioUploadView(t, { pack, draft, api: async () => { throw new Error('失败'); } });
  input.files = [{ name: 'new.wav', size: 20, type: 'audio/wav' }]; await input.listeners.change();
  draft.package_id = 'another';
  assert.equal(buildAudioPackageRequest({ ...pack, id: 'another' }, draft, backend).values.voice_audio, 'old.wav');
  draft.package_id = pack.id;
  assert.throws(() => buildAudioPackageRequest(pack, draft, backend), /上传失败/);
});
