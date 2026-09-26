import test from 'node:test';
import assert from 'node:assert/strict';
import { newDraft, restoreDraft, buildStudioRequest } from '../web/studio-state.mjs';
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
