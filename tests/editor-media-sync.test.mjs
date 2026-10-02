import test from 'node:test';
import assert from 'node:assert/strict';
import { stageEditorMediaSync } from '../web/editor-media-sync.mjs';
import { captureEditorPreparationTarget, assertEditorPreparationTarget } from '../web/editor-preparation.mjs';
import { createNode } from '../web/graph.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';

const backend = 'http://127.0.0.1:8188';
function fixture(type = 'image') {
  const fields = [{ id: 'scene', node_id: '4:3', input: 'file', type, label: '场景' }];
  const target = { ...createNode('generation', 0, 0, { kind: 'package', package_id: 'pack',
    packageFields: fields, packageValues: { scene: 'own.png' }, editor_baseline: { scene: 'native.png' } }), id: 'target' };
  const source = { ...createNode('reference', 0, 0, { mediaType: type, localMedia: true, localAssetId: 'a'.repeat(64),
    name: '', uploadBackend: '', url: '/api/assets/media/' + 'a'.repeat(64) }), id: 'source' };
  const graph = { nodes: [target, source], edges: [{ id: 'edge', source: 'source', target: 'target', targetField: 'scene' }] };
  const options = { fields, backend, canvasId: 'canvas', sourceRevision: 'pack', referenceImports: new Map(), mediaTransfers: createMediaTransfers() };
  const calls = [];
  const api = async (path, body) => {
    calls.push({ path, body });
    return { asset_id: path.split('/')[4], name: `refs/${path.split('/')[4]}.${type === 'image' ? 'png' : type === 'video' ? 'mp4' : 'wav'}`,
      backend, media_type: type, ...(type === 'image' ? {} : { package_id: body.package_id, field_id: body.field_id }) };
  };
  const guard = captureEditorPreparationTarget(graph, target.id, options);
  const check = () => assertEditorPreparationTarget(guard, graph, options);
  return { graph, source, target, options, calls, api, check };
}
for (const type of ['image', 'video', 'audio']) test(`${type}: explicit transfer stages direct source while preserving own/default/native state`, async () => {
  const f = fixture(type), before = structuredClone(f.graph);
  const result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api, f.check);
  assert.equal(result.updates.length, 1); assert.equal(result.pending.length, 0);
  assert.deepEqual(f.graph, before); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.expected_backend, backend);
  assert.equal(f.calls[0].body.field_id, type === 'image' ? undefined : 'scene');
  assert.ok(f.calls.every(call => call.path.endsWith('/backend-input')));
});
test('two images with distinct SHA retain role association and a shared image uploads once', async () => {
  const f = fixture();
  f.options.fields.push({ ...f.options.fields[0], id: 'person', node_id: '5:3' });
  f.graph.nodes.push({ ...structuredClone(f.source), id: 'person', data: { ...f.source.data, localAssetId: 'b'.repeat(64) } });
  f.graph.edges.push({ id: 'e2', source: 'person', target: 'target', targetField: 'person' });
  let result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.equal(result.updates[0].assetId, 'a'.repeat(64)); assert.equal(result.updates[1].assetId, 'b'.repeat(64));
  f.graph.edges[1].source = 'source'; f.calls.length = 0;
  result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.equal(f.calls.length, 1); assert.equal(result.updates.length, 1);
});
test('video validates each port even when one source connects to both', async () => {
  const f = fixture('video'); f.options.fields.push({ ...f.options.fields[0], id: 'motion', node_id: '5' });
  f.graph.edges.push({ id: 'e2', source: 'source', target: 'target', targetField: 'motion' });
  const result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.deepEqual(f.calls.map(call => call.body.field_id), ['scene', 'motion']); assert.equal(result.updates.length, 1);
});
test('current outer scalar values and connected values reach the live media contract', async () => {
  const f = fixture('video');
  f.options.fields.push({ id: 'mode', node_id: '4:3', input: 'mode', type: 'text' });
  f.target.data.packageValues.mode = 'new-mode';
  await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.equal(f.calls[0].body.values.mode, 'new-mode');
});
test('no ancestor traversal, no upstream run, no reusing generation history', async () => {
  const f = fixture();
  f.options.fields.push({ ...f.options.fields[0], id: 'future', node_id: '5' });
  f.graph.nodes.push({ ...createNode('generation', 0, 0, { kind: 'sdxl' }), id: 'upstream' },
    { ...structuredClone(f.source), id: 'ancestor', data: { ...f.source.data, localAssetId: 'b'.repeat(64) } });
  f.graph.edges.push({ id: 'up', source: 'upstream', target: 'target', targetField: 'future' },
    { id: 'far', source: 'ancestor', target: 'upstream', targetField: 'image' });
  const result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.equal(f.calls.length, 1); assert.equal(result.pending[0].reason, 'upstream_not_run');
});
for (const reason of ['duplicate', 'wrong-type', 'importing', 'failed-import', 'no-local-file', 'unknown-field']) test(`preflight ${reason} uploads nothing`, async () => {
  const f = fixture();
  if (reason === 'duplicate') f.graph.edges.push({ ...f.graph.edges[0], id: 'duplicate' });
  if (reason === 'wrong-type') f.options.fields[0].type = 'video';
  if (reason === 'importing') f.options.referenceImports.set('source', { ticket: {}, mediaType: 'image' });
  if (reason === 'failed-import') f.options.referenceImports.set('source', { error: 'disk' });
  if (reason === 'no-local-file') delete f.source.data.localAssetId;
  if (reason === 'unknown-field') f.graph.edges[0].targetField = 'missing';
  const result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.equal(f.calls.length, 0); assert.equal(result.updates.length, 0); assert.ok(result.pending.length);
});
for (const mutation of ['asset', 'edge', 'target', 'backend', 'canvas', 'ticket']) test(`late upload after ${mutation} change cannot commit`, async () => {
  const f = fixture(), api = async (...args) => {
    const result = await f.api(...args);
    if (mutation === 'asset') f.source.data.localAssetId = 'b'.repeat(64);
    if (mutation === 'edge') f.graph.edges[0].targetField = 'changed';
    if (mutation === 'target') f.target.data.package_id = 'new-package';
    if (mutation === 'backend') f.options.backend = 'http://127.0.0.1:8189';
    if (mutation === 'canvas') f.options.canvasId = 'other';
    if (mutation === 'ticket') f.options.referenceImports.set('source', { ticket: {} });
    return result;
  };
  await assert.rejects(stageEditorMediaSync(f.graph, 'target', f.options, api, f.check), /已变化/);
  assert.equal(f.source.data.name, ''); assert.equal(f.target.data.packageValues.scene, 'own.png');
});
for (const bad of ['asset', 'backend', 'type', 'path', 'field']) test(`invalid ${bad} receipt is rejected`, async () => {
  const f = fixture(bad === 'field' ? 'video' : 'image');
  const api = async (...args) => ({ ...await f.api(...args), ...{
    asset: { asset_id: 'c'.repeat(64) }, backend: { backend: 'http://127.0.0.1:8189' },
    type: { media_type: 'audio' }, path: { name: '../escape.png' }, field: { field_id: 'other' },
  }[bad] });
  await assert.rejects(stageEditorMediaSync(f.graph, 'target', f.options, api), /未改写画布/);
  assert.equal(f.source.data.name, '');
});
test('second upload failure returns no partial local updates', async () => {
  const f = fixture(); f.options.fields.push({ ...f.options.fields[0], id: 'person', node_id: '5' });
  f.graph.nodes.push({ ...structuredClone(f.source), id: 'person', data: { ...f.source.data, localAssetId: 'b'.repeat(64) } });
  f.graph.edges.push({ id: 'e2', source: 'person', target: 'target', targetField: 'person' });
  const before = structuredClone(f.graph);
  await assert.rejects(stageEditorMediaSync(f.graph, 'target', f.options, async (...args) => {
    if (f.calls.length) throw new Error('second failed'); return f.api(...args);
  }), /second failed/);
  assert.deepEqual(f.graph, before);
});
test('legacy image store uses its own endpoint and a foreign asset is reuploaded explicitly', async () => {
  const f = fixture(); f.source.data.localMedia = false;
  f.source.data.name = 'old.png'; f.source.data.uploadBackend = 'http://127.0.0.1:8189';
  const result = await stageEditorMediaSync(f.graph, 'target', f.options, f.api);
  assert.match(f.calls[0].path, /\/assets\/images\//); assert.equal(result.updates[0].uploadBackend, backend);
});
