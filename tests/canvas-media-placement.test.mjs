import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNode, parseGraph, serializeGraph } from '../web/graph.mjs';
import { placeFragment } from '../web/canvas-layout.mjs';
import { importPosition, validateMediaFile } from '../web/canvas-images.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const entry = source.slice(source.indexOf('async function importReferenceFiles('), source.indexOf('async function storeLocalMedia('));
const add = source.slice(source.indexOf('function addNode('), source.indexOf('function renderLoraFields('));
const placement = source.slice(source.indexOf('function nodeSize('), source.indexOf('function visibleCanvasArea('));
function fixture() {
  const state = { centered: [], errors: [], revoked: [] };
  const sandbox = {
    graph: { nodes: [], edges: [] }, selected: new Set(), selectedEdge: null,
    referenceImports: new Map(), referenceImportTickets: new Map(),
    createNode, parseGraph, serializeGraph, importPosition, validateMediaFile, placeFragment,
    clone: structuredClone, currentCanvasIdentity: () => 'owned',
    document: { getElementById: () => null },
    canvas: { clientWidth: 1000, clientHeight: 800, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    viewPoint: (x, y) => ({ x, y }), mutate: fn => fn(), renderNodes() {}, revealInspector() {}, toast() {},
    centerOnNode: node => state.centered.push(node.id), reportError: error => state.errors.push(error.message),
    URL: { createObjectURL: () => 'blob:owned', revokeObjectURL: value => state.revoked.push(value) },
    storeLocalMedia: async file => ({ asset_id: (file.type.startsWith('video') ? 'b' : 'a').repeat(64), media_type: validateMediaFile(file) }),
  };
  sandbox.getNode = id => sandbox.graph.nodes.find(node => node.id === id);
  vm.runInNewContext(placement + add + entry, sandbox);
  return { sandbox, state };
}
const image = { name: 'image.png', type: 'image/png', size: 100 };
const video = { name: 'video.mp4', type: 'video/mp4', size: 100 };
const overlaps = (a, b) => a.x < b.x + 286 && a.x + 286 > b.x && a.y < b.y + 480 && a.y + 480 > b.y;

test('real import entry avoids prior and pending media while preserving existing node positions', async () => {
  const { sandbox: h, state } = fixture();
  await h.importReferenceFiles([image]);
  const first = { ...h.graph.nodes[0] };
  await h.importReferenceFiles([video, image]);
  assert.equal(h.graph.nodes.length, 3);
  assert.equal(h.graph.nodes[0].x, first.x); assert.equal(h.graph.nodes[0].y, first.y);
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) assert.equal(overlaps(h.graph.nodes[i], h.graph.nodes[j]), false);
  assert.equal(state.centered.length, 2, 'center once per completed picker batch');
  assert.equal(state.revoked.length, 3); assert.deepEqual(state.errors, []);
});

test('drop and replacement avoid viewport jumps, and replacement retains its node and bindings', async () => {
  const { sandbox: h, state } = fixture();
  await h.importReferenceFiles([image], null, { x: 80, y: 90 });
  const ref = h.graph.nodes[0], position = { x: ref.x, y: ref.y };
  const target = createNode('generation', 600, 0, { kind: 'sdxl_i2i' });
  h.graph.nodes.push(target); h.graph.edges.push({ id: 'wire', source: ref.id, target: target.id, targetField: 'image_1', sourceField: 'image' });
  const before = JSON.stringify(h.graph.edges);
  await h.importReferenceFiles([image], ref.id);
  assert.equal(h.graph.nodes.length, 2); assert.equal(h.graph.nodes[0], ref);
  assert.deepEqual({ x: ref.x, y: ref.y }, position); assert.equal(JSON.stringify(h.graph.edges), before);
  assert.equal(state.centered.length, 0); assert.deepEqual(state.errors, []);
});
