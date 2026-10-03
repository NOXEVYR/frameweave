import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// Reuse the existing parent-UI harness definitions without executing its tests.
const fixtureURL = new URL('./native-editor-projection.test.mjs', import.meta.url);
const source = await readFile(fixtureURL, 'utf8');
const start = source.slice(0, source.indexOf("\nfor (const mediaType of ['image', 'video', 'audio'])"));
assert.ok(start.includes('function harness('));
const productURL = new URL('../web/native-workflow-editor.mjs', import.meta.url).href;
// Real bridge errors carry both message and result; preserve that shape when
// injecting a conflict rather than reducing it to a string-only fake error.
const shared = start.replace("'../web/native-workflow-editor.mjs'", JSON.stringify(productURL))
  .replace('error = failure.message; errors.push(failure);', 'error = failure.message; if (failure.result) result = failure.result; errors.push(failure);')
  + '\nexport { harness, button, drafts };';
const { harness, button, drafts } = await import(`data:text/javascript;base64,${Buffer.from(shared).toString('base64')}`);

test('failed own-media capture identity proof blocks apply rather than committing unsynchronized native N', async () => {
  const h = harness({ native: 'baseline.png', baseline: 'baseline.png', fallback: 'own.png', mediaType: 'image' });
  try {
    h.hooks.bridgeAfter = (action, message, result) => {
      if (action === 'captureMedia') result.captured[0].native_value = 'forged-baseline.png';
      return result;
    };
    await h.open();
    assert.equal(h.value(), 'baseline.png'); assert.equal(h.node.data.packageValues.media, 'own.png');
    assert.equal(h.calls.some(call => call.action === 'patch'), false);
    assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '应用参数并返回').click();
    assert.equal(h.calls.some(call => call.kind === 'apply'), false);
    assert.equal(drafts(h).length, 0);
  } finally { await h.restore(); }
});

test('failed own-media patch remains blocked through initialization error recovery', async () => {
  const h = harness({ native: 'baseline.png', baseline: 'baseline.png', fallback: 'own.png', mediaType: 'image' });
  try {
    h.hooks.bridgeBefore = action => { if (action === 'patch') throw new Error('own media patch refused'); };
    await h.open(); assert.equal(h.value(), 'baseline.png'); assert.equal(h.node.data.packageValues.media, 'own.png');
    assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '应用参数并返回').click(); assert.equal(h.calls.some(call => call.kind === 'apply'), false);
  } finally { await h.restore(); }
});

test('cancelled own-media conflict cannot clear the premarked apply block', async () => {
  const h = harness({ native: 'inner-edit.png', baseline: 'baseline.png', fallback: 'own.png', mediaType: 'image' });
  try {
    let choices = 0; h.host.resolveConflicts = async () => { choices++; return null; };
    h.hooks.bridgeBefore = action => {
      if (action === 'patch') {
        const error = new Error('conflict'); error.result = { applied: [], unsupported: [{ index: 0, reason: 'conflict', current_value: 'inner-edit.png' }] }; throw error;
      }
    };
    await h.open(); assert.equal(choices, 1); assert.equal(h.value(), 'inner-edit.png');
    assert.equal(h.node.data.packageValues.media, 'own.png'); assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '应用参数并返回').click(); assert.equal(h.calls.some(call => call.kind === 'apply'), false);
  } finally { await h.restore(); }
});

test('own-media guard failure cannot save or apply and explicit reopen permits a fresh proven session', async () => {
  const h = harness({ native: 'baseline.png', baseline: 'baseline.png', fallback: 'own.png', mediaType: 'image' });
  try {
    h.hooks.bridgeAfter = (action, message, result) => { if (action === 'captureMedia') h.setCurrent(false); return result; };
    await h.open(); assert.equal(h.value(), 'baseline.png'); assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 0);
    await button(h, '放弃未保存修改并返回').click(); assert.equal(h.editor.isOpen(), false);
    h.setCurrent(true); h.hooks.bridgeAfter = null;
    await h.open(); assert.equal(h.value(), 'connected.png'); assert.equal(button(h, '应用参数并返回').disabled, false);
  } finally { await h.restore(); }
});

const { hostHarness, field, makeNode, BACKEND, OTHER } = await import('./helpers/editor-host-harness.mjs');
const { applyEditorInterfaceGraph } = await import('../web/editor-canvas-interface.mjs');
for (const wrong of ['backend', 'source']) test(`second own preparation rejects wrong ${wrong} identity without modifying canvas`, async () => {
  const h = hostHarness({ bound: true, fields: [field('image', 'image')], values: { image: 'own.png' } });
  h.node.data.packageMediaBackends = { image: { name: 'own.png', backend: BACKEND } };
  const reference = makeNode('reference', 'reference', { name: 'connected.png', mediaType: 'image', uploadBackend: BACKEND });
  h.sandbox.graph.nodes.push(reference); h.sandbox.graph.edges.push({ id: 'edge', source: reference.id, target: h.node.id, targetField: 'image' });
  const before = structuredClone(h.sandbox.graph); let count = 0;
  h.state.onApi = (path, payload) => {
    if (path === '/api/editor-prepare' && ++count === 2) {
      const prompt = structuredClone(h.state.prompt); prompt['12'].inputs.image = 'own.png';
      return { backend_url: wrong === 'backend' ? OTHER : BACKEND, source_revision: wrong === 'source' ? 'wrong-package' : 'pack',
        prompt, overrides: structuredClone(payload.overrides), pending: [] };
    }
  };
  await assert.rejects(h.state.host.prepareSession(h.node, { revision: 7 }), /素材准备结果的来源或后端已变化/);
  assert.deepEqual(h.sandbox.graph, before);
});

for (const invalidated of ['image', 'renamed']) test(`same filename and field rebinding cannot inherit invalidated ${invalidated} owner`, () => {
  const h = hostHarness({ bound: true, fields: [field('image', 'image')], values: { image: 'same.png' } });
  h.node.data.editor_id = `e-${'a'.repeat(24)}`;
  h.node.data.packageMediaBackends = { image: { name: 'same.png', backend: OTHER, preview_url: '/api/media/' + 'a'.repeat(32) } };
  const result = { package: { id: 'new-pack', fields: [{ ...field('renamed', 'image'), input: 'image' }] }, values: { renamed: 'same.png' },
    baseline: { renamed: 'same.png' }, backend_url: BACKEND, output_nodes: [], outputs: [], rebindings: { image: 'renamed' }, invalidated_media_fields: [invalidated] };
  const changed = applyEditorInterfaceGraph(h.sandbox.graph, h.node.id, result);
  assert.deepEqual(changed.nodes[0].data.packageMediaBackends, {}); assert.equal(h.node.data.packageMediaBackends.image.backend, OTHER);
});
