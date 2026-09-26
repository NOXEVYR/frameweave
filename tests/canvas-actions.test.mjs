import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect, parseGraph, serializeGraph } from '../web/graph.mjs';
import { selectionBounds, copySelection, pasteSelection, moveSelection, arrangeSelection, clampMenuPosition } from '../web/canvas-actions.mjs';

const sizeOf = node => ({ width: node.width || 100, height: node.height || 80 });

test('copy/paste carries only selected internal connections and detaches result jobs', () => {
  const prompt = createNode('prompt', 20, 40, { text: '保留提示词' });
  const generation = createNode('generation', 400, 40, { models: { dit: 'local.safetensors' } });
  const result = createNode('result', 780, 40, { jobId: 'running-task', outputs: [{ type: 'image', url: '/media/one' }] });
  const outside = createNode('reference', 20, 400);
  const graph = { nodes: [prompt, generation, result, outside], edges: [] };
  connect(graph, prompt.id, generation.id); connect(graph, outside.id, generation.id); connect(graph, generation.id, result.id);
  const before = structuredClone(graph), clipboard = copySelection(graph, [prompt.id, generation.id, result.id]);
  const fragment = pasteSelection(clipboard, { x: 100, y: 200 }, graph.nodes.length);
  assert.deepEqual(graph, before);
  assert.equal(fragment.nodes.length, 3); assert.equal(fragment.edges.length, 2);
  assert.equal(fragment.nodes[0].x, 100); assert.equal(fragment.nodes[0].y, 200);
  assert.equal(fragment.nodes[1].x - fragment.nodes[0].x, 380);
  assert.ok(fragment.nodes.every(node => !graph.nodes.some(original => original.id === node.id)));
  assert.ok(fragment.edges.every(edge => fragment.nodes.some(node => node.id === edge.source) && fragment.nodes.some(node => node.id === edge.target)));
  assert.deepEqual(fragment.nodes[2].data.outputs, []); assert.equal(fragment.nodes[2].data.jobId, '');
  assert.equal(fragment.nodes[0].data.text, '保留提示词');
  assert.equal(fragment.nodes[1].data.models.dit, 'local.safetensors');
  assert.doesNotThrow(() => parseGraph(serializeGraph(fragment)));
  fragment.nodes[1].data.models.dit = 'changed';
  assert.equal(clipboard.nodes[1].data.models.dit, 'local.safetensors');
});

test('paste enforces graph capacity without mutating clipboard', () => {
  const clipboard = { nodes: [createNode('prompt', 0, 0), createNode('prompt', 200, 0)], edges: [] };
  const before = structuredClone(clipboard);
  assert.throws(() => pasteSelection(clipboard, { x: 0, y: 0 }, 499), /500/);
  assert.deepEqual(clipboard, before);
  assert.deepEqual(pasteSelection({ nodes: [], edges: [] }, { x: 0, y: 0 }), { nodes: [], edges: [] });
});

test('paste at a coordinate limit keeps the complete fragment importable', () => {
  const clipboard = { nodes: [createNode('prompt', 0, 0), createNode('prompt', 450, -300)], edges: [] };
  const fragment = pasteSelection(clipboard, { x: 1e7, y: -1e7 - 1000 });
  assert.equal(fragment.nodes[1].x - fragment.nodes[0].x, 450);
  assert.equal(fragment.nodes[1].y - fragment.nodes[0].y, -300);
  assert.doesNotThrow(() => parseGraph(serializeGraph(fragment)));
});

test('alignment uses displayed sizes while preserving nodes and graph data', () => {
  const nodes = [{ id: 'a', x: 10, y: 30, width: 100, height: 80 }, { id: 'b', x: 170, y: 110, width: 200, height: 120 }];
  const before = structuredClone(nodes);
  assert.deepEqual(selectionBounds(nodes, sizeOf), { minX: 10, minY: 30, maxX: 370, maxY: 230 });
  assert.deepEqual(arrangeSelection(nodes, 'right', sizeOf), [{ id: 'a', x: 270, y: 30 }, { id: 'b', x: 170, y: 110 }]);
  assert.deepEqual(arrangeSelection(nodes, 'left', sizeOf).map(node => node.x), [10, 10]);
  assert.deepEqual(arrangeSelection(nodes, 'top', sizeOf).map(node => node.y), [30, 30]);
  assert.deepEqual(arrangeSelection(nodes, 'bottom', sizeOf).map(node => node.y), [150, 110]);
  assert.deepEqual(nodes, before);
});

test('distribution maintains outer span when there is room and expands crowded cards', () => {
  const spacious = [{ id: 'a', x: 0, y: 10 }, { id: 'b', x: 190, y: 20 }, { id: 'c', x: 600, y: 30 }];
  assert.deepEqual(arrangeSelection(spacious, 'horizontal', sizeOf).map(node => node.x), [0, 300, 600]);
  const crowded = spacious.map(node => ({ ...node, x: 0 }));
  assert.deepEqual(arrangeSelection(crowded, 'horizontal', sizeOf).map(node => node.x), [0, 132, 264]);
  assert.deepEqual(arrangeSelection(spacious, 'vertical', sizeOf).map(node => node.y), [10, 122, 234]);
  assert.deepEqual(arrangeSelection(spacious.slice(0, 2), 'horizontal', sizeOf), []);
  assert.throws(() => arrangeSelection(spacious, 'unknown', sizeOf), /未知/);
});

test('keyboard moves stop the whole selection at the canvas boundary', () => {
  const nodes = [{ id: 'a', x: 1e7 - 2, y: -1e7 + 5 }, { id: 'b', x: 1e7 - 40, y: -1e7 + 30 }];
  assert.deepEqual(moveSelection(nodes, 20, -20), [{ id: 'a', x: 1e7, y: -1e7 }, { id: 'b', x: 1e7 - 38, y: -1e7 + 25 }]);
  assert.equal(nodes[0].x, 1e7 - 2);
  assert.deepEqual(moveSelection([], 20, 20), []);
});

test('menu placement keeps the complete menu inside the visible viewport', () => {
  assert.deepEqual(clampMenuPosition({ x: 995, y: 700 }, { width: 240, height: 300 }, { width: 1000, height: 720 }), { x: 752, y: 412 });
  assert.deepEqual(clampMenuPosition({ x: -15, y: -40 }, { width: 240, height: 300 }, { width: 1000, height: 720 }), { x: 8, y: 8 });
  assert.deepEqual(clampMenuPosition({ x: 20, y: 30 }, { width: 240, height: 300 }, { width: 1000, height: 720 }), { x: 20, y: 30 });
});

test('canvas clipboard preserves package ports and edge field metadata without sharing result jobs', () => {
  const source = createNode('generation', 20, 0), result = createNode('result', 400, 0, { jobId: 'owned', outputs: [{ type: 'image', url: '/api/media/old' }] });
  const target = createNode('generation', 780, 0, { kind: 'package', package_id: 'p-image', packageFields: [{ id: 'image', label: '参考图片', type: 'image' }] });
  const graph = { nodes: [source, result, target], edges: [] };
  connect(graph, source.id, result.id);
  connect(graph, result.id, target.id, { targetField: 'image', sourceField: 'image', outputIndex: 2 });
  const clipboard = copySelection(graph, graph.nodes.map(node => node.id)), before = structuredClone(clipboard);
  const pasted = pasteSelection(clipboard, { x: 100, y: 100 }, 3);
  assert.deepEqual(clipboard, before);
  assert.deepEqual(pasted.nodes[2].data.packageFields, target.data.packageFields);
  assert.deepEqual({ ...pasted.edges[1], id: 'edge', source: 'source', target: 'target' }, {
    id: 'edge', source: 'source', target: 'target', targetField: 'image', sourceField: 'image', outputIndex: 2,
  });
  assert.notEqual(pasted.edges[1].id, clipboard.edges[1].id);
  assert.equal(pasted.nodes[1].data.jobId, ''); assert.deepEqual(pasted.nodes[1].data.outputs, []);
  assert.doesNotThrow(() => parseGraph(serializeGraph(pasted)));
  clipboard.edges[1].outputIndex = 32;
  assert.throws(() => pasteSelection(clipboard, { x: 0, y: 0 }), /序号/);
});
