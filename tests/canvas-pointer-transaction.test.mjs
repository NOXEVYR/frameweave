import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { moveSelection } from '../web/canvas-actions.mjs';

// The optional path runs these same event-level regressions against a preserved
// source tree, without copying or modifying that tree or any browser user data.
const source = await readFile(process.env.PRISM_FRONTEND_BASELINE || new URL('../web/app.js', import.meta.url), 'utf8');
function part(from, to) {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  assert(start >= 0 && end > start, `missing app event section: ${from}`);
  return source.slice(start, end);
}
class Target {
  listeners = new Map();
  style = {};
  hidden = true;
  classList = { add() {}, remove() {}, toggle() {} };
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback); this.listeners.set(type, callbacks);
  }
  emit(type, properties = {}) {
    const event = { type, target: this, button: 0, pointerId: 1, clientX: 0, clientY: 0, key: '', code: '',
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...properties };
    for (const callback of this.listeners.get(type) || []) callback(event);
    return event;
  }
  closest() { return null; }
}
function harness() {
  const canvas = new Target(), document = new Target(), window = new Target();
  const node = { id: 'one', x: 0, y: 0, data: { text: 'retained prompt' } };
  const card = { dataset: { nodeId: node.id }, style: {} };
  const header = { closest(selector) { return selector === '.node' ? card : selector === '.node-header' ? this : null; } };
  const box = new Target(), controls = new Map([['#selection-box', box], ['#undo', {}], ['#redo', {}]]), captures = new Set(), history = [], future = [];
  const state = { saves: 0, resumed: 0, renders: 0, edges: 0, release: [], previewReads: 0 };
  const context = { canvas, document, window, pointer: null, portDrag: null, connecting: null, selected: new Set([node.id]), selectedEdge: null,
    keyboardMoveBefore: null, spaceDown: false, tool: 'select', nodeMenu: null, viewport: { x: 0, y: 0, scale: 1 },
    graph: { nodes: [node], edges: [] }, moveSelection, nodeParameterPanel: null,
    history, future, canvasIdentity: 'canvas-one', jobNodes: {}, projectTitle: 'Daily draft',
    expandedInputs: new Set(), portBindings: new Map(), referenceImports: new Map(), referenceImportTickets: new Map(),
    ensureCanvasIdentity: () => context.canvasIdentity, savedPortViews: () => [], restorePortViews() {},
    setProjectTitle: title => { context.projectTitle = title; },
    localStorage: { setItem() {} }, CANVAS_ID_KEY: 'test-canvas-identity',
    $: selector => { assert(controls.has(selector), `unexpected selector ${selector}`); return controls.get(selector); },
    viewPoint: (x, y) => ({ x: (x - context.viewport.x) / context.viewport.scale, y: (y - context.viewport.y) / context.viewport.scale }),
    getNode: id => context.graph.nodes.find(item => item.id === id), nodeSize: () => ({ width: 100, height: 80 }),
    deleteSelection() { const before = context.snapshot(); context.graph.nodes = context.graph.nodes.filter(item => !context.selected.has(item.id)); context.pushHistory(before); },
    save() { state.saves++; }, applyViewport() {}, zoom() {},
    renderInspector() { state.renders++; }, renderSelection() {}, renderNodes() {}, renderAll() {}, renderEdges() { state.edges++; }, refreshNodeParameterPanel() {},
    contentLayout: { reset() {}, resume() { state.resumed++; } }, revealInspector() {}, switchTab() {}, canvasIsActive: () => true,
    closeNodeMenu() {}, toggleCanvasFocus() {}, cancelConnection() { context.connecting = null; },
    moveConnectionPreview(point) { context.connecting.point = point; },
    reportError: error => { throw error; }, setTimeout: callback => { callback(); },
    copyCanvasSelection() {}, pasteCanvasSelection() {}, duplicateSelection() {}, renameCanvasSelection() {}, fitView() {},
    workspaceTools: { openCanvases() { throw Error('unexpected version action'); } },
  };
  Object.assign(canvas, { focus() {}, contains: target => target === canvas || target === header,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id),
    releasePointerCapture(id) { state.release.push(id); captures.delete(id); },
  });
  Object.assign(document, { querySelector: () => null,
    getElementById: () => card,
    elementFromPoint() { state.previewReads++; return null; },
  });
  vm.runInNewContext(part('function snapshot(', 'function mutate(')
    + part('function layoutHistoryEntry(', 'function save(')
    + part('function undo()', 'function viewPoint(')
    + part("canvas.addEventListener('wheel',", 'function clearImageDrop(')
    + part('function finishKeyboardMove()', "window.addEventListener('beforeunload',"), context);
  return { context, canvas, document, window, node, header, card, box, captures, history, future, state,
    down: (extra = {}) => canvas.emit('pointerdown', { target: header, ...extra }),
    move: (extra = {}) => canvas.emit('pointermove', { target: header, ...extra }),
    up: (extra = {}) => canvas.emit('pointerup', { target: header, ...extra }),
    key: (key, extra = {}) => document.emit('keydown', { target: canvas, key, ...extra }),
  };
}

test('a second pointer cannot move, finish or replace the active node drag', () => {
  const h = harness(); h.down({ pointerId: 7 }); h.move({ pointerId: 7, clientX: 30, clientY: 20 });
  const owner = h.context.pointer;
  h.move({ pointerId: 9, clientX: 500, clientY: 600 });
  assert.deepEqual([h.node.x, h.node.y], [30, 20]);
  h.up({ pointerId: 9 }); assert.equal(h.context.pointer, owner); assert.equal(h.history.length, 0);
  h.down({ pointerId: 9, clientX: 500, clientY: 600 }); assert.equal(h.context.pointer, owner);
  h.move({ pointerId: 7, clientX: 40, clientY: 50 }); h.up({ pointerId: 7 });
  assert.deepEqual([h.node.x, h.node.y], [40, 50]); assert.equal(h.history.length, 1);
  assert.equal(h.context.pointer, null); assert.deepEqual(h.state.release, [7]);
  h.key('z', { ctrlKey: true }); assert.equal(h.context.graph.nodes[0].x, 0);
  h.key('z', { ctrlKey: true, shiftKey: true }); assert.equal(h.context.graph.nodes[0].x, 40);
  assert.equal(h.context.graph.nodes[0].data.text, 'retained prompt');
});

for (const [name, key, extra] of [['delete', 'Delete', {}], ['undo', 'z', { ctrlKey: true }], ['redo', 'y', { ctrlKey: true }], ['arrow movement', 'ArrowRight', {}]]) {
  test(`keyboard ${name} cannot mutate an unfinished drag or add a mixed undo step`, () => {
    const h = harness();
    h.node.data.text = 'original'; const prior = h.context.snapshot();
    h.node.data.text = 'saved prior edit'; h.context.pushHistory(prior);
    if (name === 'redo') {
      const next = JSON.parse(h.context.snapshot()); next.graph.nodes[0].x = 800; next.graph.nodes[0].data.text = 'future value';
      h.context.future.push(JSON.stringify(next));
    }
    h.down(); h.move({ clientX: 30 }); const graph = JSON.stringify(h.context.graph);
    h.key(key, extra); assert.equal(JSON.stringify(h.context.graph), graph);
    assert.doesNotThrow(() => h.move({ clientX: 40 })); h.up(); assert.equal(h.history.length, 2);
    h.key('z', { ctrlKey: true }); assert.equal(h.context.graph.nodes[0].x, 0); assert.equal(h.context.graph.nodes[0].data.text, 'saved prior edit');
    h.key('z', { ctrlKey: true }); assert.equal(h.context.graph.nodes[0].data.text, 'original');
    h.key('y', { ctrlKey: true }); h.key('y', { ctrlKey: true });
    assert.equal(h.context.graph.nodes[0].x, 40); assert.equal(h.context.graph.nodes[0].data.text, 'saved prior edit');
  });
}

for (const interruption of ['blur', 'lostpointercapture']) {
  test(`${interruption} commits the last drag position once and releases the active gesture`, () => {
    const h = harness(); h.down({ pointerId: 3 }); h.move({ pointerId: 3, clientX: 80, clientY: 90 });
    if (interruption === 'blur') h.window.emit('blur'); else h.canvas.emit('lostpointercapture', { pointerId: 3 });
    assert.equal(h.context.pointer, null); assert.equal(h.history.length, 1); assert.equal(h.box.hidden, true);
    h.move({ pointerId: 3, clientX: 900 }); h.up({ pointerId: 3 });
    assert.deepEqual([h.node.x, h.node.y], [80, 90]); assert.equal(h.history.length, 1);
    h.key('z', { ctrlKey: true }); assert.equal(h.context.graph.nodes[0].x, 0);
    h.down({ pointerId: 4 }); h.move({ pointerId: 4, clientX: 20 }); h.up({ pointerId: 4 });
    assert.equal(h.context.graph.nodes[0].x, 20); assert.equal(h.context.future.length, 0);
  });
}

test('cancelled connection never hit-tests missing cancel-event coordinates or leaks its pointer capture', () => {
  const h = harness(); h.context.connecting = { source: 'one', point: { x: 0, y: 0 } };
  h.context.portDrag = { id: 8, x: 0, y: 0, moved: true }; h.captures.add(8);
  h.window.emit('blur');
  assert.equal(h.context.portDrag, null); assert.equal(h.context.connecting, null);
  assert.equal(h.state.previewReads, 0); assert.equal(h.captures.size, 0);
  assert.equal(h.history.length, 0);
});

test('unrelated pointer cannot distort connection preview or start a competing box selection', () => {
  const h = harness(); const point = { x: 15, y: 25 };
  h.context.connecting = { source: 'one', point }; h.context.portDrag = { id: 8, x: 0, y: 0, moved: false };
  h.move({ pointerId: 9, clientX: 500 }); assert.equal(h.context.connecting.point, point);
  h.canvas.emit('pointerdown', { pointerId: 9 }); assert.equal(h.context.pointer, null);
  assert.equal(h.context.selected.has('one'), true);
  h.move({ pointerId: 8, clientX: 50, clientY: 60 });
  assert.deepEqual([h.context.connecting.point.x, h.context.connecting.point.y], [50, 60]);
  assert.equal(h.context.portDrag.moved, true);
});

test('a pointer cancel leaves an untouched click out of history and preserves normal box/pan gestures', () => {
  const h = harness(); h.down(); h.canvas.emit('pointercancel'); assert.equal(h.history.length, 0);
  h.canvas.emit('pointerdown', { pointerId: 2, clientX: -10, clientY: -10 });
  h.canvas.emit('pointermove', { pointerId: 2, clientX: 100, clientY: 100 });
  h.canvas.emit('pointerup', { pointerId: 2 }); assert.equal(h.context.selected.has('one'), true);
  h.down({ pointerId: 3, button: 1 }); h.move({ pointerId: 3, clientX: 25, clientY: 35 }); h.up({ pointerId: 3 });
  assert.deepEqual([h.context.viewport.x, h.context.viewport.y], [25, 35]); assert.equal(h.history.length, 0);
});
