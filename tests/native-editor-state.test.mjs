import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, parseGraph, serializeGraph, generationPayload, connect } from '../web/graph.mjs';
import { editorDocument } from '../web/native-workflow-editor.mjs';
import { editorConnectionSummary, applyEditorInterfaceGraph } from '../web/editor-canvas-interface.mjs';

test('legacy output wires through preview require explicit stable branch migration', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '1'.repeat(24) });
  const preview = createNode('result', 300, 0);
  const target = createNode('generation', 600, 0, { kind: 'package', package_id: 'p-' + '2'.repeat(24), packageFields: [{ id: 'image', label: 'Image', type: 'image' }] });
  const graph = { nodes: [source, preview, target], edges: [] };
  connect(graph, source.id, preview.id);
  connect(graph, preview.id, target.id, { targetField: 'image', outputIndex: 3 });
  const key = editorConnectionSummary(graph, source.id, [])[0].outputId;
  assert.equal(key, `legacy-${graph.edges[1].id}`);
  const result = { package: { id: source.data.package_id, fields: [] }, values: {}, baseline: {}, backend_url: 'http://127.0.0.1:8188', output_nodes: ['7'], outputs: [{ id: '7', label: 'Final', mediaType: 'image' }] };
  assert.throws(() => applyEditorInterfaceGraph(graph, source.id, result), /输出连线/);
  const updated = applyEditorInterfaceGraph(graph, source.id, { ...result, output_rebindings: { [key]: '7' } });
  assert.equal(updated.edges[1].sourceOutput, '7');
  assert.equal(updated.edges[1].outputIndex, 0);
  assert.equal(graph.edges[1].outputIndex, 3);
  assert.equal(graph.edges[1].sourceOutput, undefined);
});

test('invalid duplicate input remaps do not mutate the existing canvas', () => {
  const a = createNode('prompt', 0, 0), b = createNode('prompt', 0, 200);
  const target = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-' + '2'.repeat(24), packageFields: ['old', 'kept'].map(id => ({ id, label: id, type: 'text' })) });
  const graph = { nodes: [a, b, target], edges: [] };
  connect(graph, a.id, target.id, { targetField: 'old' }); connect(graph, b.id, target.id, { targetField: 'kept' });
  const before = serializeGraph(graph);
  assert.throws(() => applyEditorInterfaceGraph(graph, target.id, { package: { id: target.data.package_id, fields: [{ id: 'kept', label: 'kept', type: 'text' }] }, values: {}, baseline: {}, backend_url: 'http://127.0.0.1:8188', output_nodes: ['7'], outputs: [], rebindings: { old: 'kept' } }), /已有连接/);
  assert.equal(serializeGraph(graph), before);
});

test('native JSON accepts BOM and keeps bypassed nodes and object widgets', () => {
  const document = { version: .4, nodes: [{ id: 1, type: 'Example', mode: 4, widgets_values: { strength: .7 } }], links: [], extra: { custom: ['kept'] } };
  assert.deepEqual(editorDocument('\uFEFF' + JSON.stringify(document)), document);
  assert.equal(editorDocument('{"prompt":{}}'), null);
});

test('canvas keeps native controls, internal baseline and stable output identity', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '1'.repeat(24), editor_id: 'e-' + '2'.repeat(24),
    editor_backend: 'http://127.0.0.1:8188', packageFields: [], packageValues: {},
    editor_controls: [{ node_id: '1', input: 'clip_name', widget_node_id: '1', widget_name: 'clip_name' }],
    editor_baseline: { model: 'encoder-a' }, editor_outputs: ['7'], editor_output_fields: [{ id: '7', label: 'Final', mediaType: 'image' }] });
  const target = createNode('generation', 440, 0, { kind: 'package', package_id: 'p-' + '3'.repeat(24),
    packageFields: [{ id: 'reference', label: 'Reference', type: 'image' }], packageValues: {} });
  const graph = { nodes: [source, target], edges: [] };
  connect(graph, source.id, target.id, { targetField: 'reference', sourceField: 'image', outputIndex: 1, sourceOutput: '7' });
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.nodes[0].data.editor_controls, source.data.editor_controls);
  assert.deepEqual(restored.nodes[0].data.editor_baseline, { model: 'encoder-a' });
  assert.equal(restored.edges[0].sourceOutput, '7');
  assert.deepEqual(generationPayload(restored, source.id).output_nodes, ['7']);
  assert.equal(generationPayload(restored, source.id).editor_backend, 'http://127.0.0.1:8188');
});
