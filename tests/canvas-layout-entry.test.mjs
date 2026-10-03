import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { canvasContentArea } from '../web/canvas-layout.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function visibleCanvasArea('), source.indexOf('function drawMinimap()'));
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const element = (bounds, visible = true, collapsed = false) => ({ hidden: !visible, getClientRects: () => visible ? [bounds] : [], getBoundingClientRect: () => bounds,
  closest: selector => { assert.equal(selector, 'details:not([open])'); return collapsed ? { open: false } : null; } });
function fixture({ covered = false } = {}) {
  const canvasRect = rect(165, 124, 755, 596);
  const node = { id: 'node', x: 20, y: 80, data: { title: 'Keep' } };
  const groups = {
    '.canvas-topline,.canvas-action-bar,.discovery-banner,.workflow-canvas-toolbar': [element(rect(187, 141, 700, covered ? 650 : 142))],
    '.canvas-footer': [element(rect(187, 667, 710, 36))],
    '#minimap-button,.workflow-run-details,.workflow-menu-actions': [element(rect(760, 572, 140, 78)), element(rect(600, 300, 290, 300), false),
      element(rect(165, 124, 755, 596), true, true)],
  };
  const state = { reads: [], apply: 0, save: 0, toasts: [] };
  const shell = { querySelectorAll: selector => { state.reads.push(selector); return groups[selector]; } };
  const sandbox = { canvas: { getBoundingClientRect: () => canvasRect, closest: selector => { assert.equal(selector, '.canvas-shell'); return shell; },
    querySelectorAll() { assert.fail('sibling chrome belongs to the canvas shell'); } },
    document: { querySelectorAll() { assert.fail('layout must be scoped to its own canvas'); } }, canvasContentArea,
    graph: { nodes: [node], edges: [] }, selected: new Set(['node']), viewport: { x: 40, y: 10, scale: .8 },
    nodeSize: () => ({ width: 300, height: 260 }), selectionBounds: () => ({ minX: 20, minY: 80, maxX: 320, maxY: 340 }),
    applyViewport: () => { state.apply++; }, save: () => { state.save++; }, toast: message => { state.toasts.push(message); } };
  vm.runInNewContext(code, sandbox);
  return { sandbox, state, node, groups };
}

test('actual host measures visible local chrome and avoids the minimap without reserving collapsed details', () => {
  const f = fixture(), area = f.sandbox.visibleCanvasArea();
  assert.equal(f.state.reads.length, 3);
  assert.ok(area.y >= 159 && area.width > 0 && area.height > 0);
  const minimap = { x: 760 - 165, y: 572 - 124, width: 140, height: 78 };
  assert.ok(area.x + area.width <= minimap.x || area.y + area.height <= minimap.y || area.x >= minimap.x + minimap.width);
  assert.equal(f.state.apply, 0, 'measuring never moves the user viewport');
});

test('explicit fit and center use the same measured safe area without moving node coordinates', () => {
  const f = fixture(), before = structuredClone(f.node), area = f.sandbox.visibleCanvasArea();
  f.sandbox.fitView(true);
  const view = f.sandbox.viewport;
  assert.ok(f.node.y * view.scale + view.y >= area.y);
  assert.ok((f.node.x + 300) * view.scale + view.x <= area.x + area.width + .001);
  f.sandbox.centerOnNode(f.node);
  assert.ok(f.node.y * view.scale + view.y >= area.y);
  assert.deepEqual(f.node, before); assert.equal(f.state.apply, 2); assert.equal(f.state.save, 2);
});

test('fully obscured canvas leaves viewport and storage untouched for both fit and center', () => {
  const f = fixture({ covered: true }), before = structuredClone(f.sandbox.viewport);
  f.sandbox.fitView(); f.sandbox.centerOnNode(f.node);
  assert.deepEqual(f.sandbox.viewport, before);
  assert.equal(f.state.apply, 0); assert.equal(f.state.save, 0);
  assert.equal(f.state.toasts.length, 2); assert.match(f.state.toasts[0], /画布空间不足/);
});
