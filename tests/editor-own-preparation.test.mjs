import test from 'node:test';
import assert from 'node:assert/strict';
import { projectOwnEditorInputs, projectEditorInputs } from '../web/editor-preparation.mjs';

const backend = 'http://127.0.0.1:8188';
const field = (id, type = 'text', extra = {}) => ({ id, node_id: '12', input: id, label: id, type, ...extra });
const project = (data, fields, extra = {}) => projectOwnEditorInputs(data, fields, { backend, ...extra });

test('independent workspace accepts its data directly and retains typed own values and merge baselines', () => {
  const data = { packageValues: { text: '', count: 0, enabled: false, choice: 0 }, editor_baseline: { count: 2 } };
  const fields = [field('text'), field('count', 'integer'), field('enabled', 'boolean'), field('choice', 'select', { options: [0, false] })];
  const before = structuredClone(data), result = project(data, fields);
  assert.deepEqual(result.pending, []); assert.deepEqual(result.overrides.map(item => item.value), ['', 0, false, 0]);
  assert.equal(result.overrides[1].baseline, 2); assert.equal(result.overrides[1].stored_fallback, 0);
  assert.equal(Object.hasOwn(result, 'targetId'), false); assert.deepEqual(data, before);
  result.overrides[0].value = 'new'; assert.deepEqual(data, before);
});

test('canvas own-only preparation and independent workbench share exactly the same media and scalar diagnostics', () => {
  const fields = [field('text'), field('image', 'image'), field('audio', 'audio'), field('video', 'video'), field('choice', 'select', { options: [] })];
  const data = { kind: 'package', packageValues: { text: 'hello', image: 'scene.png', audio: 'voice.wav', video: 'clip.mp4', choice: 'old' },
    packageMediaBackends: { image: { name: 'scene.png', backend }, audio: { name: 'voice.wav', backend: 'http://127.0.0.1:8189' }, video: { name: 'clip.mp4', backend } } };
  const transfer = { status: 'pending' }, state = id => id === 'video' ? transfer : null;
  const own = project(data, fields, { mediaState: state });
  const canvas = projectEditorInputs({ nodes: [{ id: 'target', type: 'generation', data }], edges: [] }, 'target',
    { fields, backend, canvasId: 'canvas', mediaTransfers: { state(owner, id) { assert.equal(owner, 'canvas:target'); return state(id); } } });
  for (const key of ['overrides', 'pending', 'mediaOwners', 'backend']) assert.deepEqual(own[key], canvas[key]);
  assert.deepEqual(own.pending.map(item => [item.field_id, item.reason]), [['audio', 'other_backend'], ['video', 'import_pending'], ['choice', 'enum_unavailable']]);
});

for (const type of ['image', 'video', 'audio']) test(`workspace ${type} refuses filename-only ownership and preserves upload transactions`, () => {
  const fields = [field('ref', type)], data = { packageValues: { ref: 'input.dat' } };
  assert.equal(project(data, fields).pending[0].reason, 'owner_unknown');
  data.packageMediaBackends = { ref: { name: 'input.dat', backend } };
  assert.equal(project(data, fields).mediaOwners.ref.media_type, type);
  assert.equal(project(data, fields, { mediaState: () => ({ status: 'failed' }) }).pending[0].reason, 'import_failed');
  assert.equal(project(data, fields, { mediaState: () => ({ status: 'pending' }) }).overrides.length, 0);
  data.packageValues.ref = '../input.dat'; data.packageMediaBackends.ref.name = '../input.dat';
  assert.equal(project(data, fields).pending[0].reason, 'invalid_media');
});

test('hidden edits keep their baseline without becoming public package inputs', () => {
  const data = { packageValues: { missing: 1 }, editor_hidden_updates: [{ field: field('duration', 'number'), value: 14, baseline: 15 }] };
  const result = project(data, []);
  assert.deepEqual(result.overrides, [{ field_id: 'duration', node_id: '12', input: 'duration', value: 14, origin: 'hidden', baseline: 15 }]);
  assert.deepEqual(data.packageValues, { missing: 1 }); assert.equal(result.pending[0].reason, 'mapping_unavailable');
});

test('public and hidden fields pointing at the same native input cannot create conflicting patches', () => {
  const fields = [field('visible')], data = { packageValues: { visible: 'public' },
    editor_hidden_updates: [{ field: field('hidden', 'text', { input: 'visible' }), value: 'hidden', baseline: 'old' }] };
  const result = project(data, fields);
  assert.deepEqual(result.overrides, []); assert.deepEqual(result.pending.map(item => item.reason), ['mapping_unavailable', 'mapping_unavailable']);
  assert.deepEqual(result.pending.map(item => item.origin), ['own', 'hidden']);
});

test('independent workspace enforces safe JSON, numeric ranges, field budget and loopback backend', () => {
  assert.throws(() => project({ packageValues: { value: 9007199254740992 } }, [field('value', 'integer')]), /JSON/);
  assert.throws(() => project({}, Array.from({ length: 4097 }, (_, i) => field(`field${i}`))), /映射/);
  assert.throws(() => project({}, [], { backend: 'http://external.test:8188' }));
  assert.equal(project({ packageValues: { count: -1 } }, [field('count', 'integer', { min: 0 })]).pending[0].reason, 'invalid_value');
  assert.equal(project({}, [], { backend: 'http://localhost:8188/' }).backend, backend);
});
