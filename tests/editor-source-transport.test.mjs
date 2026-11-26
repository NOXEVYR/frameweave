import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, serializeGraph } from '../web/graph.mjs';
import { createWorkflowCanvas } from '../web/workflow-canvas.mjs';

const editorId = `e-${'a'.repeat(24)}`, newId = `e-${'b'.repeat(24)}`;
const source = JSON.stringify({ version: 0.4, nodes: [], links: [], groups: [{ title: 'Retain native UI' }] });
function fixture(origin) {
  const graph = { nodes: [createNode('generation', 0, 0, { kind: 'package', editor_id: editorId })], edges: [] };
  const state = { graph, calls: [], created: [], installed: [], exported: null };
  const host = { graph: () => state.graph, viewport: () => ({ x: 0, y: 0, scale: 1 }), title: () => 'Workflow',
    canvasIdentity: () => 'source-canvas', engine: () => ({ backend_url: 'http://127.0.0.1:8188' }),
    loadPackages: async () => {}, toast() {}, downloadJSON: raw => { state.exported = JSON.parse(raw); },
    setGraph: incoming => { state.graph = incoming; state.installed.push(incoming); },
    api: async (path, body) => {
      state.calls.push(path);
      if (path === `/api/editor-workflows/${editorId}`) return { id: editorId, name: 'Origin', source_json: source, ...(origin ? { source_kind: origin } : {}) };
      if (path === '/api/editor-workflows/inspect') return { nodes: 0, links: 0 };
      if (path === '/api/editor-workflows') { state.created.push(body); return { id: newId }; }
      throw Error(`Unexpected endpoint ${path}`);
    } };
  return { state, controller: createWorkflowCanvas(host) };
}
const file = document => { const raw = JSON.stringify(document); return { name: 'workflow.json', size: new TextEncoder().encode(raw).length, text: async () => raw }; };

for (const origin of ['native', 'api', 'unknown', undefined]) test(`actual collection retains ${origin || 'legacy unknown'} provenance without guessing from visual JSON`, async () => {
  const { state, controller } = fixture(origin);
  await controller.exportBundle();
  assert.equal(state.exported.editors[0].source_kind, origin || 'unknown');
  assert.equal(state.exported.editors[0].source_json, source);
  await controller.importBundle(file(state.exported));
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].source_kind, origin || 'unknown');
  assert.equal(state.created[0].source_json, source);
  assert.equal(state.graph.nodes[0].data.editor_id, newId);
  assert(state.calls.every(path => path.startsWith('/api/editor-workflows')));
});

test('invalid origin is rejected before creating any editor or replacing the canvas', async () => {
  const { state, controller } = fixture('native');
  await controller.exportBundle();
  const before = serializeGraph(state.graph);
  state.exported.editors[0].source_kind = 'guessed';
  await assert.rejects(controller.importBundle(file(state.exported)), /来源类型/);
  assert.equal(serializeGraph(state.graph), before);
  assert.deepEqual(state.created, []);
  assert.deepEqual(state.installed, []);
});
