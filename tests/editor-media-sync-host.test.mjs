import test from 'node:test';
import assert from 'node:assert/strict';
import { hostHarness, makeNode, field, BACKEND } from './helpers/editor-host-harness.mjs';

function fixture() {
  const h = hostHarness({ fields: [field('image', 'image')], values: { image: 'own.png' }, bound: true });
  const source = makeNode('reference', 'reference', { mediaType: 'image', localMedia: true, localAssetId: 'a'.repeat(64), name: '', uploadBackend: '' });
  h.sandbox.graph.nodes.push(source); h.sandbox.graph.edges.push({ id: 'edge', source: source.id, target: h.node.id, targetField: 'image' });
  h.state.onApi = path => path.endsWith('/backend-input') ? { asset_id: 'a'.repeat(64), name: 'refs/synced.png', backend: BACKEND, media_type: 'image' } : undefined;
  return { ...h, source };
}
test('actual application glue commits reference only, preserving fallback and baseline', async () => {
  const h = fixture(), original = structuredClone(h.node.data);
  const card = { dataset: { syncMediaNode: h.node.id }, disabled: false, textContent: '' };
  h.sandbox.document.querySelectorAll = () => [card];
  await h.sandbox.syncEditorMedia(h.node);
  assert.equal(h.source.data.name, 'refs/synced.png'); assert.equal(h.source.data.uploadBackend, BACKEND);
  assert.deepEqual(h.node.data, original);
  assert.ok(h.state.calls.every(call => !/generate|prompt|queue/.test(call.path)));
  assert.equal(card.disabled, false); assert.equal(card.textContent, '同步参考素材到引擎');
});
test('actual application blocks sync during an existing editor session', async () => {
  const h = fixture(); h.sandbox.beginNativeEditorContext(h.node);
  await assert.rejects(h.sandbox.syncEditorMedia(h.node), /先返回画布/);
  assert.equal(h.state.calls.length, 0); assert.equal(h.source.data.name, '');
});
test('actual application blocks opening editor while a sync request is pending', async () => {
  const h = fixture(), delegate = h.state.onApi;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { entered = resolve; });
  h.state.onApi = async path => {
    if (!path.endsWith('/backend-input')) return;
    entered(); await gate; return delegate(path);
  };
  const running = h.sandbox.syncEditorMedia(h.node); await observed;
  assert.throws(() => h.sandbox.beginNativeEditorContext(h.node), /正在同步/);
  release(); await running;
  assert.doesNotThrow(() => h.sandbox.beginNativeEditorContext(h.node));
});
test('duplicate sync clicks share one transfer and late source replacement cannot commit', async () => {
  const h = fixture(), delegate = h.state.onApi;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; }), observed = new Promise(resolve => { entered = resolve; });
  h.state.onApi = async path => { if (!path.endsWith('/backend-input')) return; entered(); await gate; return delegate(path); };
  const first = h.sandbox.syncEditorMedia(h.node); await observed;
  const second = h.sandbox.syncEditorMedia(h.node);
  const firstFailure = assert.rejects(first, /已变化/), secondFailure = assert.rejects(second, /已变化/);
  h.source.data.localAssetId = 'b'.repeat(64); release(); await Promise.all([firstFailure, secondFailure]);
  assert.equal(h.state.calls.filter(call => call.path.endsWith('/backend-input')).length, 1);
  assert.equal(h.source.data.name, '');
});
