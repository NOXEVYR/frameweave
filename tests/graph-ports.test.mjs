import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNode, connect, canConnect, generationInputPorts, edgeInputField,
  generationPayload, serializeGraph, parseGraph,
} from '../web/graph.mjs';

test('built-in generator ports expose distinct ordered slots and saved labels override display names', () => {
  const qwen = createNode('generation', 0, 0, { kind: 'qwen21_edit', inputLabels: { image_1: '原图', image_2: '角色参考' } });
  const ports = generationInputPorts(qwen);
  assert.deepEqual(ports.slice(0, 4), [
    { id: 'positive', label: '正向提示词', type: 'text' },
    { id: 'negative', label: '负向提示词', type: 'text' },
    { id: 'image_1', label: '原图', type: 'image' },
    { id: 'image_2', label: '角色参考', type: 'image' },
  ]);
  assert.deepEqual(ports.slice(2).map(port => port.id), Array.from({ length: 10 }, (_, index) => 'image_' + (index + 1)));
  assert.deepEqual(generationInputPorts(createNode('generation', 0, 0, { kind: 'h3_i2v' })).slice(2).map(port => port.id), ['start_image', 'end_image']);
  assert.deepEqual(generationInputPorts(createNode('generation', 0, 0, { kind: 'h3_ref' })).slice(2).map(port => port.id), Array.from({ length: 9 }, (_, index) => 'ref_image_' + index));
  assert.deepEqual(generationInputPorts(createNode('generation', 0, 0, { kind: 'krea' })).slice(2).map(port => port.id), ['image_1', 'image_2', 'image_3']);
});

test('a generation result can feed multiple Qwen edit slots in explicit order through save and reload', () => {
  const source = createNode('generation', 0, 0, { kind: 'sdxl' });
  const result = createNode('result', 300, 0, { outputs: [
    { type: 'image', url: '/api/media/target.png' },
    { type: 'image', url: '/api/media/character.png' },
  ] });
  const target = createNode('generation', 600, 0, { kind: 'qwen21_edit' });
  const graph = { nodes: [source, result, target], edges: [] };
  connect(graph, source.id, result.id);
  connect(graph, result.id, target.id, { targetField: 'image_1', sourceField: 'image', outputIndex: 0 });
  connect(graph, result.id, target.id, { targetField: 'image_2', sourceField: 'image', outputIndex: 1 });
  const serialized = serializeGraph(graph);
  const restored = parseGraph(serialized);
  assert.equal(serializeGraph(restored), serialized);
  assert.deepEqual(restored.edges.slice(1).map(edge => edgeInputField(restored, edge)), ['image_1', 'image_2']);
  assert.deepEqual(generationPayload(restored, target.id, { edgeImages: {
    [graph.edges[1].id]: 'input/target.png',
    [graph.edges[2].id]: 'input/character.png',
  } }).references, ['input/target.png', 'input/character.png']);
});

test('input slots reject duplicate targets, text-image mismatches, and known video outputs to image slots', () => {
  const prompt = createNode('prompt', 0, 0);
  const image = createNode('reference', 0, 0, { name: 'input.png' });
  const target = createNode('generation', 300, 0, { kind: 'qwen21_edit' });
  const graph = { nodes: [prompt, image, target], edges: [] };
  assert.equal(canConnect(graph, prompt.id, target.id, { targetField: 'image_1' }).ok, false);
  assert.equal(canConnect(graph, image.id, target.id, { targetField: 'positive' }).ok, false);
  connect(graph, image.id, target.id, { targetField: 'image_1' });
  assert.match(canConnect(graph, prompt.id, target.id, { targetField: 'image_1' }).reason, /已有连接/);
  const videoResult = createNode('result', 0, 0, { outputs: [{ type: 'video', url: '/api/media/clip.mp4' }] });
  graph.nodes.push(videoResult);
  assert.match(canConnect(graph, videoResult.id, target.id, { targetField: 'image_2', sourceField: 'video' }).reason, /不匹配/);
  assert.equal(canConnect(graph, videoResult.id, target.id, { targetField: 'image_2', sourceField: 'image' }).ok, false);
});

test('result port type follows its current upstream even before generation or after an old preview', () => {
  const source = createNode('generation', 0, 0, { kind: 'h3_t2v' });
  const preview = createNode('result', 300, 0);
  const image = createNode('generation', 600, 0, { kind: 'qwen21_edit' });
  const video = createNode('generation', 600, 400, { kind: 'package', package_id: 'video', packageFields: [{ id: 'clip', label: '视频参考', type: 'video' }] });
  const graph = { nodes: [source, preview, image, video], edges: [] };
  connect(graph, source.id, preview.id);
  assert.equal(canConnect(graph, preview.id, image.id, { targetField: 'image_1' }).ok, false);
  preview.data.outputs = [{ type: 'image', url: '/api/media/old.png' }];
  assert.equal(canConnect(graph, preview.id, video.id, { targetField: 'clip', sourceField: 'video' }).ok, true);
  assert.equal(canConnect(graph, preview.id, image.id, { targetField: 'image_1' }).ok, false);
  source.data.kind = 'sdxl';
  assert.equal(canConnect(graph, preview.id, image.id, { targetField: 'image_1' }).ok, true);
  assert.equal(canConnect(graph, preview.id, video.id, { targetField: 'clip' }).ok, false);
});

test('legacy unbound image edges keep their stored order while exposing inferred slots', () => {
  const first = createNode('reference', 0, 0, { name: 'first.png' });
  const second = createNode('reference', 0, 0, { name: 'second.png' });
  const target = createNode('generation', 300, 0, { kind: 'qwen21_edit' });
  const graph = { nodes: [first, second, target], edges: [] };
  connect(graph, first.id, target.id);
  connect(graph, second.id, target.id);
  const restored = parseGraph(serializeGraph(graph));
  assert.equal(restored.edges[0].targetField, undefined);
  assert.deepEqual(restored.edges.map(edge => edgeInputField(restored, edge)), ['image_1', 'image_2']);
  assert.deepEqual(generationPayload(restored, target.id).references, ['first.png', 'second.png']);
});

test('package video ports accept video references and reject an image connected to video', () => {
  const target = createNode('generation', 300, 0, { kind: 'package', package_id: 'p-video', packageFields: [
    { id: 'clip', label: '输入视频', type: 'video' },
  ] });
  const video = createNode('reference', 0, 0, { name: 'input/clip.mp4', mediaType: 'video' });
  const image = createNode('reference', 0, 0, { name: 'input/frame.png', mediaType: 'image' });
  const graph = { nodes: [video, image, target], edges: [] };
  assert.deepEqual(generationInputPorts(target), [{ id: 'clip', label: '输入视频', type: 'video' }]);
  assert.equal(canConnect(graph, video.id, target.id, { targetField: 'clip', sourceField: 'video' }).ok, true);
  assert.equal(canConnect(graph, image.id, target.id, { targetField: 'clip', sourceField: 'image' }).ok, false);
  connect(graph, video.id, target.id, { targetField: 'clip', sourceField: 'video' });
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(generationPayload(restored, target.id).values, { clip: 'input/clip.mp4' });
});

test('input label maps are validated and local media references retain their media endpoint', () => {
  const validId = 'a'.repeat(64);
  const localVideo = createNode('reference', 0, 0, { localAssetId: validId, localMedia: true, mediaType: 'video' });
  const localImage = createNode('reference', 0, 0, { localAssetId: validId, mediaType: 'image' });
  const target = createNode('generation', 300, 0, { kind: 'qwen21_edit', inputLabels: { image_1: '原始帧' } });
  const restored = parseGraph(serializeGraph({ nodes: [localVideo, localImage, target], edges: [] }));
  assert.equal(restored.nodes[0].data.localMedia, true);
  assert.equal(restored.nodes[0].data.url, '/api/assets/media/' + validId);
  assert.equal(restored.nodes[1].data.url, '/api/assets/images/' + validId);
  assert.equal(generationInputPorts(restored.nodes[2])[2].label, '原始帧');
  for (const inputLabels of [
    { image_1: '' },
    { image_1: 'x'.repeat(81) },
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => ['slot_' + index, '端口 ' + index])),
  ]) {
    const broken = createNode('generation', 0, 0, { kind: 'qwen21_edit', inputLabels });
    assert.throws(() => parseGraph(serializeGraph({ nodes: [broken], edges: [] })), /端口名称/);
  }
  const malformed = { schema: 'frameweave.canvas.v1', nodes: [{ ...localVideo, data: { ...localVideo.data, localMedia: 'yes' } }], edges: [] };
  assert.throws(() => parseGraph(malformed), /本地媒体/);
});
