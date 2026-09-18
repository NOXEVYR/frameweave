import test from 'node:test';
import assert from 'node:assert/strict';
import { filterJobs, filterPackages } from '../web/library.mjs';
import { recipeGraph, generationPayload, serializeGraph, parseGraph } from '../web/graph.mjs';

test('recorded image and H3 requests restore isolated controls and ordered image roles', () => {
  const request = { kind: 'h3_i2v', positive: 'camera moves gently', negative: 'flicker', seed: 2048, width: 768, height: 448, steps: 20, cfg: 1, seconds: 5, fps: 24, sampler: 'euler', scheduler: 'simple', denoise: 1, models: { dit: 'h3.safetensors' }, lora_strength: .5, references: ['start.png', 'end.png'], reference_roles: ['start', 'end'] };
  const first = recipeGraph({ request }), second = recipeGraph({ request });
  const restored = parseGraph(serializeGraph(first));
  assert.deepEqual(generationPayload(restored, first.generationId), request);
  assert.notEqual(first.generationId, second.generationId);
  first.nodes[0].data.models.dit = 'changed.safetensors';
  assert.equal(request.models.dit, 'h3.safetensors');
  assert.equal(first.nodes.filter(node => node.type === 'reference').length, 2);
});

test('package and legacy API recipes retain explicit values and advanced graph parameters', () => {
  const pack = { kind: 'package', package_id: 'p-stable', values: { scene: 'rainy street', count: 3, seed: 9007199254740000 } };
  const packaged = recipeGraph({ request: pack });
  assert.deepEqual(generationPayload(packaged, packaged.generationId), pack);
  const api = { kind: 'api', prompt: { '4': { class_type: 'CustomImage', inputs: { image: 'reference.png', settings: { factor: .9, values: [2, true] } } } } };
  const restored = recipeGraph({ request: api });
  assert.deepEqual(generationPayload(restored, restored.generationId), api);
  assert.equal(restored.nodes.length, 1);
  assert.throws(() => recipeGraph({ request: { kind: 'unrecognized' } }), /可复用/);
});

test('H3 advanced controls survive recipe, canvas save and payload round trips', () => {
  const request = { kind: 'h3_ref', positive: 'soft daylight', shift_video: 7.5, shift_audio: 2, ref_image_size: '512', references: ['portrait.png'], reference_roles: ['reference'], models: { lora: 'fallback.safetensors' }, lora: 'preferred.safetensors', lora_strength: .7 };
  const restored = recipeGraph({ request });
  const saved = parseGraph(serializeGraph(restored));
  const payload = generationPayload(saved, restored.generationId);
  assert.equal(payload.shift_video, 7.5);
  assert.equal(payload.shift_audio, 2);
  assert.equal(payload.ref_image_size, '512');
  assert.equal(payload.models.lora, 'preferred.safetensors');
  assert.equal(payload.lora_strength, .7);
  assert.equal(Object.hasOwn(payload, 'lora'), false);
  saved.nodes.find(node => node.id === restored.generationId).data.models.lora = 'edited.safetensors';
  assert.equal(generationPayload(saved, restored.generationId).models.lora, 'edited.safetensors');
  const standard = recipeGraph({ request: { kind: 'h3_t2v', positive: 'sunrise' } });
  const standardPayload = generationPayload(standard, standard.generationId);
  assert.equal(Object.hasOwn(standardPayload, 'shift_video'), false);
  assert.equal(Object.hasOwn(standardPayload, 'shift_audio'), false);
  assert.equal(Object.hasOwn(standardPayload, 'ref_image_size'), false);
  for (const invalid of [0, 101, '7.5', null]) assert.throws(() => recipeGraph({ request: { ...request, shift_video: invalid } }), /shift_video/);
});

test('task history filters by combined status and visible metadata without searching prompt content', () => {
  const jobs = [
    { id: 'done-1', kind: 'package', status: 'completed', summary: { package_name: '电影海报' }, prompt: 'private secret' },
    { id: 'failed-2', kind: 'h3_t2v', status: 'failed', error: 'Missing model' },
    { id: 'waiting-3', status: 'queued' }, { id: 'rendering-4', status: 'running' },
  ];
  assert.deepEqual(filterJobs(jobs, 'active').map(job => job.id), ['waiting-3', 'rendering-4']);
  assert.deepEqual(filterJobs(jobs, 'failed', 'ＭＩＳＳＩＮＧ').map(job => job.id), ['failed-2']);
  assert.equal(filterJobs(jobs, 'completed', '海报').length, 1);
  assert.equal(filterJobs(jobs, 'all', 'private').length, 0);
  assert.equal(filterJobs(jobs, 'all', '晨光', job => job.id === 'done-1' ? '晨光测试' : '').length, 1);
});

test('archival hides only the library entry and favorites preserve content identity', () => {
  const packages = [{ id: 'p-1', name: 'B', favorite: false }, { id: 'p-2', name: 'A', favorite: true }, { id: 'p-3', name: 'C', description: 'portrait', archived: true, favorite: true }];
  const snapshot = structuredClone(packages);
  assert.deepEqual(filterPackages(packages).map(pack => pack.id), ['p-2', 'p-1']);
  assert.deepEqual(filterPackages(packages, 'favorites').map(pack => pack.id), ['p-2']);
  assert.deepEqual(filterPackages(packages, 'archived', 'PORTRAIT').map(pack => pack.id), ['p-3']);
  assert.equal(packages.find(pack => pack.id === 'p-3').name, 'C');
  assert.deepEqual(packages, snapshot);
});
