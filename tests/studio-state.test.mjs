import test from 'node:test';
import assert from 'node:assert/strict';
import { newDraft, restoreDraft, buildStudioRequest } from '../web/studio-state.mjs';
import { studioModelNames } from '../web/generation-studio.mjs';
test('independent text generation includes exact models and LoRA strengths', () => {
  const d = { ...newDraft('txt2img'), positive: '光与山', models: { checkpoint: 'XL.safetensors' }, loras: [{ name: 'style.safetensors', strength_model: .8, strength_clip: .4 }] };
  const r = buildStudioRequest(d);
  assert.equal(r.models.checkpoint, 'XL.safetensors'); assert.equal(r.loras[0].strength_clip, .4); assert.equal(r.denoise, 1);
});
test('image editing requires exactly one uploaded reference on the current backend', () => {
  const d = { ...newDraft('img2img'), positive: '修改色调' };
  assert.throws(() => buildStudioRequest(d), /一张/);
  d.references = [{ name: 'input.png', backend: 'A' }];
  assert.throws(() => buildStudioRequest(d, 'B'), /另一个/);
  assert.equal(buildStudioRequest(d, 'A').denoise, .65);
});
test('video roles and fixed rate survive request construction without embedding media', () => {
  const d = { ...newDraft('video', 'h3_i2v'), positive: '缓慢推进', references: [{ name: 'first.png' }, { name: 'last.png' }], loras: [{ name: 'turbo', strength_model: .9 }] };
  assert.throws(() => buildStudioRequest(d), /DiT/);
  d.models.dit = 'minimax_h3_fl2va_int8.safetensors';
  const r = buildStudioRequest(d);
  assert.deepEqual(r.reference_roles, ['start', 'end']); assert.equal(r.fps, 24); assert.equal(r.denoise, 1); assert.equal(r.loras[0].strength_clip, undefined);
  d.loras[0].strength_clip = 1; assert.throws(() => buildStudioRequest(d), /CLIP/);
});
test('empty, unsafe seed and invalid dimensions do not silently coerce', () => {
  const d = { ...newDraft('txt2img'), positive: 'test' };
  for (const patch of [{ width: '' }, { seed: 2 ** 53 }, { width: 1025 }, { cfg: NaN }, { steps: 0 }]) assert.throws(() => buildStudioRequest({ ...d, ...patch }));
});
test('malformed draft arrays recover without breaking navigation or losing valid text', () => {
  const d = restoreDraft('txt2img', { kind: 'sdxl', positive: '中文草稿', loras: null, references: 'bad', models: null });
  assert.equal(d.positive, '中文草稿'); assert.deepEqual(d.loras, []); assert.deepEqual(d.references, []); assert.deepEqual(d.models, {});
});
test('H3 dual clock and shift validation match the compiler boundary', () => {
  const d = { ...newDraft('video'), positive: 'test', sampler: 'dual_clock_euler', cfg: 2 };
  assert.throws(() => buildStudioRequest(d), /CFG/); d.cfg = 1; d.shift_video = 0; assert.throws(() => buildStudioRequest(d), /shift_video/);
});
test('Qwen Image 2.1 text-to-image defaults to native sampling and rejects references', () => {
  const d = { ...newDraft('txt2img', 'qwen21_t2i'), positive: '雨夜街道' };
  assert.equal(d.steps, 40); assert.equal(d.cfg, 1); assert.equal(d.denoise, 1);
  const r = buildStudioRequest(d);
  assert.equal(r.kind, 'qwen21_t2i'); assert.equal(r.sampler, 'euler'); assert.equal(r.scheduler, 'simple');
  assert.equal(r.width % 32, 0); assert.equal(r.height % 32, 0); assert.equal(r.denoise, 1);
  assert.equal('references' in r, false); assert.equal('custom_size' in r, false); assert.equal('ref_resolution' in r, false);
  const changedSampler = buildStudioRequest({ ...d, sampler: 'backend-sampler', scheduler: 'backend-scheduler', models: { dit: 'explicit-current-engine-choice' } });
  assert.equal(changedSampler.sampler, 'backend-sampler'); assert.equal(changedSampler.scheduler, 'backend-scheduler');
  assert.equal(changedSampler.models.dit, 'explicit-current-engine-choice');
  assert.throws(() => buildStudioRequest({ ...d, references: [{ name: 'ref.png' }] }), /不接受参考图片/);
  assert.throws(() => buildStudioRequest({ ...d, width: 1025 }), /32/);
});
test('Qwen Image 2.1 edit keeps ordered target and references with explicit size policy', () => {
  const d = { ...newDraft('img2img', 'qwen21_edit'), positive: '保留主体，调整背景', references: [
    { name: 'target.png', backend: 'A' }, { name: 'style.png', backend: 'A' },
  ] };
  assert.equal(d.denoise, 1); assert.equal(d.steps, 40); assert.equal(d.cfg, 1);
  let r = buildStudioRequest(d, 'A');
  assert.deepEqual(r.references, ['target.png', 'style.png']); assert.equal(r.denoise, 1);
  assert.equal(Object.hasOwn(r, 'reference_roles'), false);
  assert.equal(r.custom_size, false); assert.equal(r.ref_resolution, 1024); assert.equal(r.width, 1024); assert.equal(r.height, 1024);
  assert.equal(r.sampler, 'euler'); assert.equal(r.scheduler, 'simple');
  assert.throws(() => buildStudioRequest(d, 'B'), /另一个/);
  assert.throws(() => buildStudioRequest({ ...d, references: [] }), /1–10/);
  assert.throws(() => buildStudioRequest({ ...d, references: Array.from({ length: 11 }, (_, i) => ({ name: `ref${i}.png` })) }), /1–10/);
  assert.throws(() => buildStudioRequest({ ...d, ref_resolution: 33 }), /32 的倍数/);
  r = buildStudioRequest({ ...d, custom_size: true, width: 1280, height: 768, models: { dit: 'selected-dit' } }, 'A');
  assert.equal(r.custom_size, true); assert.equal(r.width, 1280); assert.equal(r.height, 768);
  assert.throws(() => buildStudioRequest({ ...d, custom_size: true, width: 1279 }), /32/);
  assert.throws(() => buildStudioRequest({ ...d, loras: [{ name: 'style.safetensors' }] }), /DiT/);
  const withLora = { ...d, models: { dit: 'selected-dit' }, loras: Array.from({ length: 4 }, (_, i) => ({ name: `selected-lora-${i}`, strength_model: .7 })) };
  assert.equal(buildStudioRequest(withLora, 'A').loras[0].strength_clip, undefined);
  assert.throws(() => buildStudioRequest({ ...withLora, loras: [...withLora.loras, { name: 'fifth.safetensors' }] }, 'A'), /最多叠加 4 个 LoRA/);
});
test('Qwen drafts restore independently with native defaults and no T2I references', () => {
  const t2i = restoreDraft('txt2img', { ...newDraft('txt2img', 'qwen21_t2i'), references: [{ name: 'old.png', url: '/old.png' }] });
  assert.equal(t2i.kind, 'qwen21_t2i'); assert.deepEqual(t2i.references, []); assert.equal(t2i.steps, 40); assert.equal(t2i.sampler, 'euler');
  const edit = restoreDraft('img2img', { ...newDraft('img2img', 'qwen21_edit'), custom_size: true, ref_resolution: 0, references: [{ name: 'target.png', url: '/target.png' }] });
  assert.equal(edit.custom_size, true); assert.equal(edit.ref_resolution, 0); assert.equal(edit.denoise, 1); assert.equal(edit.references.length, 1);
  assert.equal(newDraft('img2img', 'sdxl_i2i').denoise, .65);
});
test('Qwen model choices require known qwen21 family or an explicit search for unknown files', () => {
  const names = ['qwen21-dit', 'old-qwen-image', 'qwen25-text-encoder', 'custom-engine-file'];
  const families = { 'qwen21-dit': 'qwen21', 'old-qwen-image': 'qwen_image', 'qwen25-text-encoder': 'qwen25', 'custom-engine-file': 'unknown' };
  assert.deepEqual(studioModelNames(names, families, 'dit', 'qwen21'), ['qwen21-dit']);
  assert.deepEqual(studioModelNames(names, families, 'dit', 'qwen21', 'custom'), ['custom-engine-file']);
  assert.deepEqual(studioModelNames(names, families, 'dit', 'qwen21', 'qwen25'), []);
});
