import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/native-editor-bridge.js', import.meta.url), 'utf8');
const helper = source.slice(source.indexOf('function fitEditorView('), source.indexOf('function resolveExecutionNode('));
function fixture({ boxes = [[100, 900, 300, 350]], dpi = 1 } = {}) {
  const nodes = boxes.map(box => ({ boundingRect: new Float32Array(box) }));
  const graph = { _nodes: nodes }, calls = [];
  const canvas = { graph, canvas: { width: 1000 * dpi, height: 700 * dpi },
    selected_nodes: { keep: true }, ds: { scale: 1, offset: [0, 0], fitToBounds(box) { calls.push([...box]); } },
    setDirty(...args) { calls.push(args); } };
  const app = { canvasOrUndefined: canvas };
  const fit = vm.runInNewContext(`${helper}; fitEditorView`, { app, window: { devicePixelRatio: dpi } });
  return { app, canvas, graph, nodes, calls, fit };
}
test('initial load recovers fully off-screen and thin-edge-only nodes', () => {
  for (const y of [900, 680]) {
    const h = fixture({ boxes: [[100, y, 300, 350]] }), before = structuredClone(h.graph);
    assert.equal(h.fit(true).fitted, true);
    assert.deepEqual(h.calls[0], [100, y, 300, 350]);
    assert.deepEqual(h.graph, before); assert.deepEqual(h.canvas.selected_nodes, { keep: true });
  }
});
test('readable saved view stays untouched, including high DPI and huge nodes', () => {
  for (const [boxes, dpi] of [[[[100, 100, 300, 350]], 1], [[[100, 100, 300, 350]], 2], [[[-500, -500, 2000, 2000]], 1]]) {
    const h = fixture({ boxes, dpi }); assert.equal(h.fit(true).fitted, false); assert.equal(h.calls.length, 0);
  }
});
test('a small subgraph header touching the viewport edge is not considered usable', () => {
  const h = fixture({ boxes: [[600, 670, 140, 26]] });
  assert.equal(h.fit(true).fitted, true);
});
test('explicit fit uses the active child scope, regardless of selection or root', () => {
  const h = fixture(); h.app.rootGraph = h.graph;
  h.canvas.graph = { nodes: [{ boundingRect: [-30, 15, 200, 100] }, { boundingRect: [400, 300, 40, 50] }] };
  assert.equal(h.fit().fitted, true); assert.deepEqual(h.calls[0], [-30, 15, 470, 335]);
  assert.deepEqual(h.canvas.selected_nodes, { keep: true });
});
test('uninitialized bounds are updated using the frontend method before fitting', () => {
  const h = fixture({ boxes: [[0, 0, 0, 0]] });
  h.nodes[0].updateArea = function () { this.boundingRect = [0, 900, 100, 100]; };
  assert.equal(h.fit(true).fitted, true); assert.deepEqual(h.calls[0], [0, 900, 100, 100]);
});
test('empty, hidden, unsupported and invalid geometry scopes do not claim success', () => {
  for (const change of [h => { h.graph._nodes = []; }, h => { h.canvas.canvas.height = 0; },
    h => { delete h.canvas.ds.fitToBounds; }, h => { h.nodes[0].boundingRect[0] = NaN; },
    h => { h.nodes[0].boundingRect[2] = -1; }]) {
    const h = fixture(); change(h); assert.equal(h.fit().fitted, false); assert.equal(h.calls.length, 0);
  }
});
