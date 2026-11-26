import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { newDraft, restoreDraft } from '../web/studio-state.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';
import { resultReferenceOutputs, transferOwnedOutput } from '../web/result-reference.mjs';
import { studioOutputSize } from '../web/generation-studio.mjs';

const source = await readFile(new URL('../web/generation-studio.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('  async function useImageOutput('), source.indexOf('  function resultPanel('));
const backend = 'http://127.0.0.1:8188';
test('studio history reports the final refined dimensions without replacing preserved first-stage parameters', () => {
  const summary = { width: 512, height: 512, refine: { enabled: true, width: 640, height: 768 } };
  assert.equal(studioOutputSize(summary), '640 × 768 · 二次重绘');
  assert.equal(summary.width, 512);
  assert.equal(studioOutputSize({ width: 512, height: 256 }), '512 × 256');
  assert.equal(studioOutputSize(), '— × —');
});
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function setup(mode = 'img2img', kind = 'qwen21_edit') {
  const refs = ['old.png', 'scene.png', 'character.png'].slice(0, mode === 'video' ? 2 : kind === 'sdxl_i2i' ? 1 : 3)
    .map(name => ({ name, label: name, backend, url: `/api/media/${'a'.repeat(32)}` }));
  const draft = { ...newDraft(mode, kind), positive: 'keep my edited prompt', references: refs, seed: 123, models: { dit: 'keep-model' } };
  const output = { output_id: `o-${'b'.repeat(64)}`, type: 'image', filename: 'render.png', node_id: '7',
    url: `/api/media/${'c'.repeat(32)}`, subfolder: '', storage_type: 'output' };
  const job = { id: 'source-job', backend, status: 'completed', outputs: [output] };
  const response = { source_job: job.id, output_id: output.output_id, backend, media_type: 'image', name: 'input/render.png', url: `/api/media/${'d'.repeat(32)}` };
  const calls = [], saved = [], opened = [], hooks = {};
  const context = vm.createContext({
    resultTransfers: new Set(), drafts: { [mode]: draft }, kindDrafts: {}, active: 'txt2img', navigationEpoch: 0,
    activeBackend: backend, mediaBackendEpoch: 0, selectedJobs: {}, mediaTransfers: createMediaTransfers(),
    newDraft, restoreDraft, structuredClone, resultReferenceOutputs, transferOwnedOutput,
    backend: () => context.activeBackend, syncAudioBackendContext: () => context.activeBackend,
    mediaOwner: (value, key) => `${key}:${value.kind}`, refresh() {}, render() {},
    save() { saved.push(structuredClone(context.drafts)); }, open(value) { opened.push(value); context.active = value; context.navigationEpoch++; },
    host: { toast() {}, async api(path, data) {
      calls.push({ path, data }); await hooks.before?.(path, data);
      if (path === '/api/status') return { online: hooks.online !== false, backend_url: context.activeBackend };
      if (path === '/api/jobs') return { jobs: [job] };
      if (path.endsWith('/image-input')) return response;
      throw new Error(`Unexpected API: ${path}`);
    } },
  });
  vm.runInContext(body, context);
  return { context, mode, draft, output, job, response, calls, saved, opened, hooks,
    run: () => context.useImageOutput(job, output.output_id, mode),
    uploading: () => calls.filter(item => item.path.endsWith('/image-input')) };
}

for (const [mode, kind] of [['img2img', 'qwen21_edit'], ['img2img', 'sdxl_i2i'], ['video', 'h3_i2v']]) {
  test(`${kind}: reuse replaces only target/first frame, retaining other references, model and edited parameters`, async () => {
    const h = setup(mode, kind), before = structuredClone(h.draft);
    await h.run(); const next = h.context.drafts[mode];
    assert.equal(next.references[0].name, h.response.name);
    assert.deepEqual(structuredClone(next.references.slice(1)), before.references.slice(1));
    for (const key of ['positive', 'negative', 'models', 'seed', 'refine', 'loras']) assert.deepEqual(next[key], before[key]);
    assert.deepEqual(h.draft, before); assert.equal(h.saved.length, 1); assert.deepEqual(h.opened, [mode]);
    assert.equal(h.uploading()[0].data.output_id, h.output.output_id);
    assert.ok(h.calls.every(item => !item.path.includes('generate')));
    assert.equal(h.context.resultTransfers.size, 0);
  });
}

test('video first frame restores cached H3 mode and end frame without overwriting text-to-video draft', async () => {
  const h = setup('video', 'h3_t2v'); h.draft.references = [];
  const cached = { ...newDraft('video', 'h3_i2v'), seed: 456, positive: 'cached i2v prompt', references: [
    { name: 'start.png', url: '/api/media/old', backend }, { name: 'end.png', url: '/api/media/end', backend }] };
  h.context.kindDrafts.video = { h3_i2v: cached };
  await h.run();
  assert.equal(h.context.drafts.video.kind, 'h3_i2v'); assert.equal(h.context.drafts.video.seed, 456);
  assert.equal(h.context.drafts.video.references[1].name, 'end.png');
  assert.deepEqual(h.context.kindDrafts.video.h3_t2v, h.draft);
  assert.equal(cached.references[0].name, 'start.png');
});

for (const change of ['draft-replaced', 'prompt-edited', 'refs-reordered', 'model-edited', 'kind-cache', 'navigation', 'selection', 'backend', 'backend-round-trip', 'new-upload']) {
  test(`late transfer cannot overwrite ${change}`, async () => {
    const h = setup(), original = structuredClone(h.draft);
    h.hooks.before = path => {
      if (!path.endsWith('/image-input')) return;
      if (change === 'draft-replaced') h.context.drafts.img2img = { ...newDraft('img2img'), positive: 'new user draft' };
      if (change === 'prompt-edited') h.draft.positive = 'user typed during transfer';
      if (change === 'refs-reordered') h.draft.references.reverse();
      if (change === 'model-edited') h.draft.models.dit = 'new-user-model';
      if (change === 'kind-cache') h.context.kindDrafts.img2img = { qwen21_edit: structuredClone(h.draft) };
      if (change === 'navigation') h.context.navigationEpoch++;
      if (change === 'selection') h.context.selectedJobs.txt2img = 'another-job';
      if (change === 'backend') h.context.activeBackend = 'http://127.0.0.1:8189';
      if (change === 'backend-round-trip') h.context.mediaBackendEpoch++;
      if (change === 'new-upload') h.context.mediaTransfers.start('img2img:qwen21_edit', 'references', 'new user upload');
    };
    await assert.rejects(h.run(), /已变化/);
    assert.equal(h.saved.length, 0); assert.equal(h.opened.length, 0); assert.equal(h.context.resultTransfers.size, 0);
    assert.ok(h.context.drafts.img2img.references.every(ref => ref.name !== h.response.name));
    if (change === 'prompt-edited') assert.equal(h.draft.positive, 'user typed during transfer');
    if (change === 'new-upload') assert.equal(h.context.mediaTransfers.state('img2img:qwen21_edit', 'references').label, 'new user upload');
    if (change === 'navigation') assert.deepEqual(h.draft, original);
  });
}

test('duplicate result clicks submit one transfer; pending upload prevents accidental generation of old references', async () => {
  const h = setup(), started = deferred(), release = deferred();
  h.hooks.before = async path => { if (path.endsWith('/image-input')) { started.resolve(); await release.promise; } };
  const promise = h.run(); await started.promise;
  await h.run(); assert.equal(h.uploading().length, 1);
  assert.throws(() => h.context.mediaTransfers.assertReady(['img2img:qwen21_edit']), /正在上传/);
  release.resolve(); await promise;
  assert.doesNotThrow(() => h.context.mediaTransfers.assertReady(['img2img:qwen21_edit']));
  assert.equal(h.saved.length, 1);
});

test('existing failed or pending user upload is not superseded by result reuse', async () => {
  const h = setup(); const ticket = h.context.mediaTransfers.start('img2img:qwen21_edit', 'references', 'user image');
  h.context.mediaTransfers.fail(ticket, new Error('network'));
  await assert.rejects(h.run(), /上传失败/); assert.equal(h.calls.length, 0); assert.equal(h.saved.length, 0);
  assert.equal(h.context.mediaTransfers.state(ticket.owner, ticket.field), ticket);
});

for (const [field, value] of [['source_job', 'other'], ['output_id', 'wrong'], ['media_type', 'video'], ['backend', 'http://127.0.0.1:8189'], ['name', '../outside.png'], ['url', 'https://example.test/image']]) {
  test(`mismatched ${field} receipt preserves drafts and never auto-retries`, async () => {
    const h = setup(), before = structuredClone(h.draft); h.response[field] = value;
    await assert.rejects(h.run());
    assert.deepEqual(h.draft, before); assert.equal(h.saved.length, 0); assert.equal(h.uploading().length, 1);
    assert.equal(h.context.resultTransfers.size, 0);
    assert.doesNotThrow(() => h.context.mediaTransfers.assertReady(['img2img:qwen21_edit']));
  });
}

test('branch/batch reorder still sends stable output identity; source replacement is rejected', async () => {
  const h = setup(), other = { ...h.output, output_id: `o-${'e'.repeat(64)}`, filename: 'other.png' };
  h.job.outputs.unshift(other);
  h.hooks.before = path => { if (path === '/api/jobs') h.job.outputs.reverse(); };
  await h.run(); assert.equal(h.uploading()[0].data.output_index, 1); assert.equal(h.uploading()[0].data.output_id, h.output.output_id);
  const stale = setup(); stale.hooks.before = path => { if (path === '/api/jobs') stale.job.outputs[0] = { ...stale.output, filename: 'changed.png' }; };
  await assert.rejects(stale.run(), /产物已变化/); assert.equal(stale.uploading().length, 0);
});

test('offline engine and unknown/duplicate output identities do not upload or modify drafts', async () => {
  const h = setup(); h.hooks.online = false;
  await assert.rejects(h.run(), /未连接/); assert.equal(h.uploading().length, 0);
  for (const variant of ['duplicate', 'missing', 'incomplete']) {
    const item = setup();
    if (variant === 'duplicate') item.job.outputs.push({ ...item.output });
    if (variant === 'missing') item.output.output_id = '';
    if (variant === 'incomplete') item.job.status = 'running';
    await assert.rejects(item.run()); assert.equal(item.calls.length, 0); assert.equal(item.saved.length, 0);
  }
});
