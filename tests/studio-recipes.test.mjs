import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { draftFromStudioRecipe, studioModeForKind } from '../web/studio-recipes.mjs';
import { STUDIO_MODES, newDraft, restoreDraft, buildStudioRequest } from '../web/studio-state.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';
import { recipeGraph } from '../web/graph.mjs';

const backend = 'http://127.0.0.1:8188', other = 'http://127.0.0.1:8189', url = `/api/media/${'a'.repeat(32)}`;
const source = await readFile(new URL('../web/generation-studio.mjs', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('  function restoreRecipeDraft('), source.indexOf('  function resultPanel('));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
function setup(kind = 'sdxl', mode = studioModeForKind(kind)) {
  const draft = { ...newDraft(mode), positive: 'user unsaved prompt', seed: 111 };
  const request = { ...newDraft(mode, kind), positive: 'recorded prompt', width: 512, height: 512, seed: 987, references: [] };
  const job = { id: 'job-123', kind, backend, status: 'completed' };
  const recipe = { request, summary: { width: 'auto', height: 'auto' }, replayable: true, warnings: [] };
  const h = { job, recipe, draft, calls: [], saves: [], opened: [], added: [], before: null };
  const context = vm.createContext({
    drafts: { [mode]: draft }, kindDrafts: {}, recipeBackups: {}, recipeTransfers: new Set(),
    selectedJobs: {}, active: mode, navigationEpoch: 0, mediaBackendEpoch: 0, activeBackend: backend,
    canvasId: 'canvas-one', canvasState: 'initial-canvas', mediaTransfers: createMediaTransfers(),
    STUDIO_MODES, structuredClone, restoreDraft, studioModeForKind, draftFromStudioRecipe,
    syncAudioBackendContext: () => context.activeBackend, mediaOwner: (value, key) => `${key}:${value.kind}`,
    host: { jobs: () => [job], api: async path => { h.calls.push(path); await h.before?.(); return recipe; }, toast() {},
      canvasIdentity: () => context.canvasId, canvasSnapshot: () => context.canvasState, addRecipe: value => h.added.push(value) },
    save() { h.saves.push(structuredClone(context.drafts)); }, render() {}, refresh() {}, open(value) { h.opened.push(value); context.active = value; },
  });
  vm.runInContext(body, context); return Object.assign(h, { context, mode, run: destination => context.reuseRecipe(job, mode, destination || 'studio') });
}
test('restore uses exact request parameters; replacement is backed up and recoverable without generation', async () => {
  const h = setup(); h.recipe.request.refine = { enabled: true, width: 640, height: 768, steps: 4, denoise: .2, upscale_method: 'bislerp' };
  h.recipe.request.models = { checkpoint: 'model.safetensors', sdxl_clip_l: 'L', sdxl_clip_g: 'G' };
  h.recipe.request.loras = [{ name: 'style', strength_model: .7, strength_clip: .4 }];
  await h.run(); const next = h.context.drafts.txt2img;
  assert.equal(next.width, 512); assert.equal(next.seed, 987); assert.deepEqual(next.refine, h.recipe.request.refine); assert.deepEqual(next.models, h.recipe.request.models);
  assert.deepEqual(next.loras, h.recipe.request.loras); assert.deepEqual(h.context.recipeBackups.txt2img, h.draft);
  h.context.restoreRecipeDraft('txt2img'); assert.deepEqual(h.context.drafts.txt2img, h.draft); assert.equal(h.context.recipeBackups.txt2img, undefined);
  assert.equal(h.calls.length, 1); assert.equal(h.added.length, 0); assert.ok(h.calls.every(path => path.endsWith('/recipe')));
});
test('Qwen restoration keeps numeric first stage, custom size, ref resolution and every reference order', async () => {
  const h = setup('qwen21_edit'); h.recipe.request.custom_size = true; h.recipe.request.ref_resolution = 1536;
  h.recipe.request.references = ['target.png', 'scene.png', 'character.png'];
  h.recipe.references = h.recipe.request.references.map(name => ({ name, backend, url })); await h.run();
  const next = h.context.drafts.img2img; assert.equal(next.kind, 'qwen21_edit'); assert.equal(next.custom_size, true); assert.equal(next.ref_resolution, 1536);
  assert.deepEqual(next.references.map(ref => ref.name), h.recipe.request.references); assert.ok(next.references.every(ref => ref.backend === backend && ref.url === url));
  assert.deepEqual(buildStudioRequest(next, backend).references, h.recipe.request.references);
});
test('missing preview keeps named input and owner, foreign previews cannot be adopted', () => {
  const h = setup('h3_i2v'); h.recipe.request.references = ['start.png', 'end.png']; h.recipe.request.reference_roles = ['start', 'end'];
  h.recipe.references = [{ name: 'start.png', url, backend: other }, { name: 'end.png', backend, url: 'https://example.com/private' }];
  const value = draftFromStudioRecipe(h.recipe, h.job, [{ name: 'end.png', backend, url }]);
  assert.equal(value.missingPreviews, 1); assert.equal(value.draft.references[0].url, ''); assert.equal(value.draft.references[1].url, url);
  assert.throws(() => buildStudioRequest(value.draft, other), /另一个引擎/);
});
test('canvas recipe carries source backend so copied references cannot run on another engine', () => {
  const h = setup('sdxl_i2i'); h.recipe.request.references = ['input.png'];
  const graph = recipeGraph({ ...h.recipe, backend }); assert.equal(graph.nodes.find(node => node.type === 'reference').data.uploadBackend, backend);
});
for (const change of ['navigation', 'round-trip', 'selection', 'backend', 'backend-round-trip', 'draft-object', 'draft-prompt', 'cache-object', 'cache-value', 'upload', 'source-job']) {
  test(`late studio recipe preserves current state after ${change}`, async () => {
    const h = setup(); h.context.kindDrafts.txt2img = { sdxl: structuredClone(h.draft) };
    h.before = () => {
      if (change === 'navigation') h.context.active = 'canvas';
      if (change === 'round-trip') h.context.navigationEpoch++;
      if (change === 'selection') h.context.selectedJobs.txt2img = 'other';
      if (change === 'backend') h.context.activeBackend = other;
      if (change === 'backend-round-trip') h.context.mediaBackendEpoch++;
      if (change === 'draft-object') h.context.drafts.txt2img = structuredClone(h.draft);
      if (change === 'draft-prompt') h.draft.positive = 'typed during load';
      if (change === 'cache-object') h.context.kindDrafts.txt2img = structuredClone(h.context.kindDrafts.txt2img);
      if (change === 'cache-value') h.context.kindDrafts.txt2img.sdxl.seed++;
      if (change === 'upload') h.context.mediaTransfers.start('txt2img:sdxl', 'references', 'image');
      if (change === 'source-job') h.context.host.jobs = () => [];
    };
    await assert.rejects(h.run(), /变化|上传/); assert.equal(h.saves.length, 0); assert.equal(h.opened.length, 0); assert.equal(h.added.length, 0); assert.equal(h.context.recipeTransfers.size, 0);
  });
}
for (const change of ['canvas-id', 'canvas-content', 'navigation', 'backend']) test(`canvas copying rejects ${change} during fetch`, async () => {
  const h = setup(); h.before = () => {
    if (change === 'canvas-id') h.context.canvasId = 'different'; if (change === 'canvas-content') h.context.canvasState = 'edited';
    if (change === 'navigation') h.context.navigationEpoch++; if (change === 'backend') h.context.activeBackend = other;
  };
  await assert.rejects(h.run('canvas'), /变化/); assert.equal(h.added.length, 0); assert.equal(h.opened.length, 0);
});
test('duplicate clicks share one operation and a canvas copy cannot race an in-flight studio load', async () => {
  const h = setup(), gate = deferred(); h.before = () => gate.promise; const first = h.run();
  await h.run(); await h.run('canvas'); assert.equal(h.calls.length, 1); gate.resolve(); await first; assert.equal(h.saves.length, 1);
});
test('an in-flight parameter load blocks generation before any request is frozen', async () => {
  const h = setup(), gate = deferred(); h.before = () => gate.promise;
  vm.runInContext(source.slice(source.indexOf('  async function submit('), source.indexOf('  async function dispatchPending(')), h.context);
  const load = h.run(); await assert.rejects(h.context.submit(h.mode), /读取历史参数/);
  assert.equal(h.calls.length, 1); gate.resolve(); await load;
});
test('canvas copy installs before navigating; failed installation keeps original page', async () => {
  const h = setup(); h.context.host.addRecipe = () => { throw new Error('canvas full'); };
  await assert.rejects(h.run('canvas'), /canvas full/); assert.deepEqual(h.opened, []);
});
test('missing canvas hooks fail before fetching or editing', async () => {
  const h = setup(); delete h.context.host.canvasSnapshot; await assert.rejects(h.run('canvas'), /尚未准备好/); assert.equal(h.calls.length, 0);
});
for (const [field, value] of [['job_id', 'other'], ['backend', other]]) test(`wrong ${field} recipe receipt cannot overwrite draft`, async () => {
  const h = setup(); h.recipe[field] = value; await assert.rejects(h.run(), /身份不一致/); assert.equal(h.saves.length, 0);
});
for (const reference of ['../outside.png', 'C:/private.png', '/absolute.png']) test(`unsafe historical input ${reference} is refused`, () => {
  const h = setup('sdxl_i2i'); h.recipe.request.references = [reference]; assert.throws(() => draftFromStudioRecipe(h.recipe, h.job));
});
test('over-limit references and reversed H3 roles are never silently truncated/reordered', () => {
  const h = setup('h3_i2v'); h.recipe.request.references = ['first.png', 'last.png', 'extra.png']; assert.throws(() => draftFromStudioRecipe(h.recipe, h.job), /数量/);
  h.recipe.request.references.pop(); h.recipe.request.reference_roles = ['end', 'start']; assert.throws(() => draftFromStudioRecipe(h.recipe, h.job), /角色/);
});
test('legacy partial refinement uses only missing values from recorded resolved summary', () => {
  const h = setup(); h.recipe.request.refine = { enabled: true, width: 768 };
  h.recipe.summary.refine = { enabled: true, width: 1024, height: 1024, steps: 8, denoise: .3, upscale_method: 'bislerp' };
  const { draft } = draftFromStudioRecipe(h.recipe, h.job);
  assert.deepEqual(draft.refine, { ...h.recipe.summary.refine, width: 768 }); assert.equal(draft.width, 512);
  assert.equal(buildStudioRequest(draft, backend, { refine: { available: true, upscale_methods: ['bislerp'] } }).refine.steps, 8);
});
test('incomplete refinement without resolved evidence is not replaced with new-draft defaults', async () => {
  const h = setup(); h.recipe.request.refine = { enabled: true };
  await assert.rejects(h.run(), /参数不完整/); assert.equal(h.saves.length, 0); assert.equal(h.opened.length, 0);
});
test('legacy singular LoRA is converted without losing its strength; explicit list still wins', () => {
  const h = setup(); delete h.recipe.request.loras; h.recipe.request.models = { lora: 'style' }; h.recipe.request.lora_strength = .35;
  assert.deepEqual(draftFromStudioRecipe(h.recipe, h.job).draft.loras, [{ name: 'style', strength_model: .35, strength_clip: .35 }]);
  h.recipe.request.loras = []; assert.deepEqual(draftFromStudioRecipe(h.recipe, h.job).draft.loras, []);
});
