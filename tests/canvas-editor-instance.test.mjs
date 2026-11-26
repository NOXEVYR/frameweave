import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf('  async ensureInstance(node) {');
const implementation = source.slice(start, source.indexOf('\n  fields:', start));

function harness({ shared = true, staleAt = 0 } = {}) {
  const node = { id: 'canvas-one', data: { editor_id: 'local-source' } };
  const graph = { nodes: [node, ...(shared ? [{ id: 'canvas-two', data: { editor_id: 'local-source' } }] : [])] };
  const state = { calls: [], guards: 0, mutations: 0, rebases: 0 };
  const context = { assertCurrent() {
    if (++state.guards === staleAt) throw new Error('canvas changed');
  }, rebaseTarget() { state.rebases++; } };
  const nativeSessionContexts = new WeakMap([[node, context]]);
  const sandbox = { graph, nativeSessionContexts, mutate(action) { state.mutations++; action(); },
    async api(path, body) {
      state.calls.push({ path, body: body && structuredClone(body) });
      if (path === '/api/editor-workflows/local-source') return { id: 'local-source', revision: 7,
        source_json: 'unchanged current draft', repair_overlay: 'must never be forwarded' };
      if (path === '/api/editor-workflows/local-source/fork') return { workflow: { id: 'independent-copy', revision: 2 } };
      throw new Error(`unexpected ${path}`);
    } };
  const ensureInstance = vm.runInNewContext(`({${implementation}}).ensureInstance`, sandbox);
  return { node, graph, state, run: () => ensureInstance(node) };
}

test('actual shared canvas instance requests an exact local source fork and does not forward repair or source claims', async () => {
  const h = harness(); await h.run();
  assert.deepEqual(h.state.calls, [
    { path: '/api/editor-workflows/local-source', body: undefined },
    { path: '/api/editor-workflows/local-source/fork', body: { base_revision: 7 } },
  ]);
  assert.equal(h.node.data.editor_id, 'independent-copy');
  assert.equal(h.graph.nodes[1].data.editor_id, 'local-source');
  assert.equal(h.state.mutations, 1); assert.equal(h.state.rebases, 1);
});

test('an unshared canvas workflow is not forked', async () => {
  const h = harness({ shared: false }); await h.run();
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.mutations, 0);
  assert.equal(h.node.data.editor_id, 'local-source');
});

for (const staleAt of [2, 3]) test(`stale canvas after async source step ${staleAt - 1} cannot bind the copied instance`, async () => {
  const h = harness({ staleAt }); await assert.rejects(h.run(), /canvas changed/);
  assert.equal(h.node.data.editor_id, 'local-source');
  assert.equal(h.graph.nodes[1].data.editor_id, 'local-source');
  assert.equal(h.state.mutations, 0); assert.equal(h.state.rebases, 0);
  assert.equal(h.state.calls.length, staleAt - 1);
});
