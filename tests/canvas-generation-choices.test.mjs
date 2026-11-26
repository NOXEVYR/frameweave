import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { modelCandidates, samplingCandidates } from '../web/canvas-generation-choices.mjs';

const engine = (models = {}, generation_options = {}) => ({ online: true, models, generation_options });
const node = (kind, sampler = 'euler') => ({ data: { kind, sampler } });

test('offline or unknown online state never returns cached model or invented sampling choices', () => {
  for (const status of [undefined, null, false, true, {}, { online: false }, { online: 'true' }]) {
    const e = typeof status === 'object' && status ? { models: { dit: ['cached'] }, generation_options: { samplers: ['cached'], schedulers: ['cached'] }, ...status } : status;
    assert.deepEqual(modelCandidates(e, 'dit', 'krea'), []);
    assert.deepEqual(samplingCandidates(e, node('h3_t2v'), 'sampler'), []);
  }
  assert.deepEqual(samplingCandidates(engine(), node('sdxl'), 'sampler'), []);
  assert.deepEqual(samplingCandidates(engine(), node('sdxl'), 'scheduler'), []);
});

test('model directories accept exact strings only, deduplicate without renaming, and reject malformed collections', () => {
  const names = ['custom A.safetensors', 1, null, { name: 'wrapped-file' }, '', 'custom A.safetensors', 'CUSTOM A.safetensors', 'folder\\name.safetensors'];
  const e = engine({ checkpoint: names });
  assert.deepEqual(modelCandidates(e, 'checkpoint', 'sdxl'), ['custom A.safetensors', 'CUSTOM A.safetensors', 'folder\\name.safetensors']);
  for (const value of [{ name: 'not-array' }, 'not-array', 1, true]) assert.deepEqual(modelCandidates(engine({ dit: value }), 'dit', 'krea'), []);
  assert.deepEqual(modelCandidates(engine({ checkpoints: ['legacy.safetensors'] }), 'checkpoint', 'sdxl'), ['legacy.safetensors']);
  assert.deepEqual(modelCandidates(engine({ checkpoint: {}, checkpoints: ['legacy.safetensors'] }), 'checkpoint', 'sdxl'), []);
  assert.deepEqual(modelCandidates(e, '__proto__', 'sdxl'), []);
});

test('known incompatible families are excluded across H3, SDXL and Krea while unknown custom names remain possible', () => {
  const names = ['custom', 'h3', 'sdxl', 'krea', 'flux', 'anima', 'qwen21'];
  const families = { custom: 'unknown', h3: 'h3', sdxl: 'sdxl', krea: 'krea', flux: 'flux', anima: 'anima', qwen21: 'qwen21' };
  const e = engine({ dit: names, checkpoint: names }, { model_families: { dit: families, checkpoint: families } });
  assert.deepEqual(new Set(modelCandidates(e, 'dit', 'h3_t2v')), new Set(['custom', 'h3']));
  assert.deepEqual(modelCandidates(e, 'checkpoint', 'sdxl_i2i'), ['custom', 'sdxl']);
  assert.deepEqual(modelCandidates(e, 'dit', 'krea'), ['custom', 'krea']);
  assert.deepEqual(modelCandidates(e, 'dit', 'qwen21_edit'), ['custom', 'qwen21']);
});

test('SDXL external CLIP roles use their own exact families and do not inherit generic SDXL or the opposite clip', () => {
  const names = ['custom', 'clip-l', 'clip-g', 'generic-sdxl', 'h3-encoder'];
  const families = { custom: 'unknown', 'clip-l': 'sdxl_clip_l', 'clip-g': 'sdxl_clip_g', 'generic-sdxl': 'sdxl', 'h3-encoder': 'h3' };
  const e = engine({ sdxl_clip_l: names, sdxl_clip_g: names }, { model_families: { sdxl_clip_l: families, sdxl_clip_g: families } });
  assert.deepEqual(modelCandidates(e, 'sdxl_clip_l', 'sdxl'), ['custom', 'clip-l']);
  assert.deepEqual(modelCandidates(e, 'sdxl_clip_g', 'sdxl'), ['custom', 'clip-g']);
});

test('Krea accepts Qwen Image VAE only for its VAE role, while Qwen 2.1 does not accept the earlier VAE family', () => {
  const names = ['custom', 'qwen_image_vae.safetensors', 'krea2-vae', 'qwen21-vae'];
  const families = { custom: 'unknown', 'qwen_image_vae.safetensors': 'qwen_image', 'krea2-vae': 'krea', 'qwen21-vae': 'qwen21' };
  const e = engine({ vae: names, dit: names }, { model_families: { vae: families, dit: families } });
  assert.deepEqual(new Set(modelCandidates(e, 'vae', 'krea')), new Set(['custom', 'qwen_image_vae.safetensors', 'krea2-vae']));
  assert.deepEqual(modelCandidates(e, 'dit', 'krea'), ['krea2-vae', 'custom']);
  assert.deepEqual(modelCandidates(e, 'vae', 'qwen21_t2i'), ['custom', 'qwen21-vae']);
});

test('H3 opposite FL2VA and Ref2VA DiT variants are excluded, rather than merely sorted behind the recommended variant', () => {
  const names = ['custom', 'minimax_h3_fl2va_int8.safetensors', 'minimax_h3_ref2va_int8.safetensors'];
  const e = engine({ dit: names }, { model_families: { dit: Object.fromEntries(names.map(name => [name, 'h3'])) } });
  assert.deepEqual(modelCandidates(e, 'dit', 'h3_ref'), ['minimax_h3_ref2va_int8.safetensors', 'custom']);
  assert.deepEqual(modelCandidates(e, 'dit', 'h3_i2v'), ['minimax_h3_fl2va_int8.safetensors', 'custom']);
  assert.deepEqual(modelCandidates(e, 'dit', 'h3_t2v'), ['minimax_h3_fl2va_int8.safetensors', 'custom']);
});

test('LoRA source is loader-specific: SDXL model-and-clip loader versus other families model-only union', () => {
  const e = engine({ lora: ['mixed-directory-not-authority'] }, { lora_loaders: {
    LoraLoader: { names: ['dual', 'shared', { name: 'wrong' }] },
    LoraLoaderModelOnly: { names: ['model', 'shared'] }, LoraLoaderBypassModelOnly: { names: ['quantized', 'model'] },
  } });
  assert.deepEqual(modelCandidates(e, 'lora', 'sdxl'), ['dual', 'shared']);
  assert.deepEqual(modelCandidates(e, 'lora', 'sdxl_i2i'), ['dual', 'shared']);
  assert.deepEqual(modelCandidates(e, 'lora', 'krea'), ['model', 'shared', 'quantized']);
  assert.deepEqual(modelCandidates(engine({ lora: ['mixed'] }), 'lora', 'h3_t2v'), []);
  assert.deepEqual(modelCandidates(engine({}, { lora_loaders: { LoraLoader: { names: 'not-array' } } }), 'lora', 'sdxl'), []);
});

test('LoRA family filtering still applies after loader selection and candidates never alter the backend data', () => {
  const e = engine({}, { lora_loaders: { LoraLoader: { names: ['custom', 'sdxl-style', 'flux-style'] } },
    model_families: { lora: { custom: 'unknown', 'sdxl-style': 'sdxl', 'flux-style': 'flux' } } });
  const before = structuredClone(e);
  assert.deepEqual(modelCandidates(e, 'lora', 'sdxl'), ['sdxl-style', 'custom']);
  assert.deepEqual(e, before);
});

test('sampling choices come only from actual declarations and preserve exact enum spelling and uniqueness', () => {
  const e = engine({}, { samplers: ['new_native', 'euler', 'euler', 1, { name: 'wrapped' }], schedulers: ['new_schedule', 'simple'] });
  assert.deepEqual(samplingCandidates(e, node('sdxl'), 'sampler'), ['new_native', 'euler']);
  assert.deepEqual(samplingCandidates(e, node('sdxl'), 'scheduler'), ['new_schedule', 'simple']);
  assert.deepEqual(samplingCandidates(e, node('sdxl'), 'missing'), []);
  assert.deepEqual(samplingCandidates(engine({}, { samplers: 'euler', schedulers: {} }), node('h3_ref'), 'sampler'), []);
});

test('H3 merges only the exact declared dual_clock_euler and switches to that sampler own scheduler list', () => {
  const e = engine({}, { samplers: ['euler', 'custom'], schedulers: ['simple', 'karras'],
    h3_dual_clock: { samplers: ['unexpected_dual', 'dual_clock_euler', 'dual_clock_euler'], schedulers: ['native_flow', 'custom_clock', 'native_flow'] } });
  assert.deepEqual(samplingCandidates(e, node('h3_t2v'), 'sampler'), ['euler', 'custom', 'dual_clock_euler']);
  assert.deepEqual(samplingCandidates(e, node('sdxl'), 'sampler'), ['euler', 'custom']);
  assert.deepEqual(samplingCandidates(e, node('qwen21_t2i'), 'sampler'), ['euler', 'custom']);
  assert.deepEqual(samplingCandidates(e, node('h3_ref', 'dual_clock_euler'), 'scheduler'), ['native_flow', 'custom_clock']);
  assert.deepEqual(samplingCandidates(e, node('h3_ref', 'euler'), 'scheduler'), ['simple', 'karras']);
  assert.deepEqual(samplingCandidates(e, { kind: 'h3_ref', sampler: 'dual_clock_euler' }, 'scheduler'), ['native_flow', 'custom_clock']);
});

test('missing or unsupported dual clock declarations never manufacture a sampler or fall back to a native scheduler for its old value', () => {
  for (const dual of [undefined, {}, { samplers: ['unexpected_dual'], schedulers: ['invented'] }, { samplers: 'dual_clock_euler' }]) {
    const e = engine({}, { samplers: ['euler'], schedulers: ['simple'], h3_dual_clock: dual });
    assert.deepEqual(samplingCandidates(e, node('h3_t2v'), 'sampler'), ['euler']);
    assert.deepEqual(samplingCandidates(e, node('h3_t2v', 'dual_clock_euler'), 'scheduler'), []);
  }
});

test('H3 cannot inherit native dual_clock_euler without the exact dual-clock declaration because the compiler routes it to that node', () => {
  const script = 'import json,sys\nsys.path.insert(0,"tests")\nfrom test_workflows import fixture\nfrom frameweave.workflows import compile_workflow,generation_options\ninfo=fixture()\ninfo["KSampler"]["input"]["required"]["sampler_name"][0].append("dual_clock_euler")\ndel info["MiniMaxH3DualClockSamplerT8"]\ntry:\n compile_workflow({"kind":"h3_t2v","positive":"Synthetic route check","sampler":"dual_clock_euler"},info)\n error=""\nexcept ValueError as exc:error=str(exc)\njson.dump({"options":generation_options(info),"error":error},sys.stdout)\n';
  const result = spawnSync('python', ['-c', script], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout), e = engine({}, actual.options);
  assert.match(actual.error, /MiniMaxH3DualClockSamplerT8/, 'the real backend still requires the special node despite the KSampler enum');
  for (const kind of ['h3_t2v', 'h3_i2v', 'h3_ref']) assert.deepEqual(samplingCandidates(e, node(kind), 'sampler'), ['euler', 'heun']);
  assert.deepEqual(samplingCandidates(e, node('sdxl'), 'sampler'), ['euler', 'heun', 'dual_clock_euler'], 'non-H3 native declarations remain unchanged');
  e.generation_options.h3_dual_clock.samplers = ['unexpected_dual'];
  assert.deepEqual(samplingCandidates(e, node('h3_t2v'), 'sampler'), ['euler', 'heun']);
  e.generation_options.h3_dual_clock.samplers = ['dual_clock_euler'];
  assert.deepEqual(samplingCandidates(e, node('h3_t2v'), 'sampler'), ['euler', 'heun', 'dual_clock_euler']);
});

test('known family and H3 subtype results agree with the actual backend _check_family across supported roles', () => {
  const names = ['custom-weights.safetensors', 'minimax_h3_fl2va_int8.safetensors', 'minimax_h3_ref2va_int8.safetensors',
    'qwen_image_2.1_vae.safetensors', 'qwen3vl_8b.safetensors', 'qwen_image_vae.safetensors',
    'krea2.safetensors', 'qwen3vl_4b.safetensors', 'sdxl_model.safetensors', 'clip_l.safetensors', 'clip_g.safetensors',
    'flux1-dev.safetensors', 'ae.safetensors', 'anima-1.safetensors', 'v1-5-pruned.safetensors'];
  const kinds = ['h3_t2v', 'h3_i2v', 'h3_ref', 'sdxl', 'sdxl_i2i', 'krea', 'qwen21_t2i', 'qwen21_edit'];
  const keys = ['checkpoint', 'dit', 'text_encoder', 'vae', 'audio_vae', 'sdxl_clip_l', 'sdxl_clip_g', 'lora'];
  const script = 'import json,sys\nfrom frameweave.workflows import _known_family,_check_family\nd=json.load(sys.stdin)\nresult=[]\nfor kind in d["kinds"]:\n for role in d["keys"]:\n  families={name:_known_family(name,role) or "unknown" for name in d["names"]}\n  allowed=[]\n  for name in d["names"]:\n   try:_check_family(name,role,kind)\n   except ValueError:continue\n   allowed.append(name)\n  result.append({"kind":kind,"role":role,"families":families,"allowed":allowed})\njson.dump(result,sys.stdout)\n';
  const result = spawnSync('python', ['-c', script], { cwd: fileURLToPath(new URL('../', import.meta.url)), input: JSON.stringify({ names, kinds, keys }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const cases = JSON.parse(result.stdout); assert.equal(cases.length, 64);
  for (const item of cases) {
    const e = engine({ [item.role]: names }, { model_families: { [item.role]: item.families },
      lora_loaders: { LoraLoader: { names }, LoraLoaderModelOnly: { names } } });
    assert.deepEqual(new Set(modelCandidates(e, item.role, item.kind)), new Set(item.allowed), `${item.kind}/${item.role}`);
  }
});
