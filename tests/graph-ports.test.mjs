import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNode, connect, canConnect, generationInputPorts, edgeInputField,
  generationPayload, serializeGraph, parseGraph, removeNodes, removeEdges, duplicateNodes,
  sourceOutputType,
} from '../web/graph.mjs';

test('historical preview files cannot revive a removed output but can confirm an existing unknown sink', () => {
  const owner=createNode('generation',0,0,{kind:'package',editor_outputs:['keep'],editor_output_fields:[{id:'keep',mediaType:'unknown'}]});
  const result=createNode('result',300,0,{outputs:[{type:'audio',node_id:'removed',filename:'old.wav'},{type:'audio',node_id:'keep',filename:'current.wav'}]});
  const target=createNode('generation',600,0,{kind:'package',packageFields:[{id:'voice',label:'声音',type:'audio'}]});
  const graph={nodes:[owner,result,target],edges:[]};
  connect(graph,owner.id,result.id);
  assert.equal(sourceOutputType(result,{sourceOutput:'removed'},'audio',graph),null);
  assert.equal(canConnect(graph,result.id,target.id,{sourceOutput:'removed',targetField:'voice'}).ok,false);
  assert.equal(sourceOutputType(result,{sourceOutput:'keep'},'audio',graph),'audio');
  assert.equal(canConnect(graph,result.id,target.id,{sourceOutput:'keep',targetField:'voice'}).ok,true);
  result.data.outputs=result.data.outputs.filter(item=>item.node_id==='removed');
  assert.equal(sourceOutputType(result,{},'audio',graph),null);
  assert.equal(canConnect(graph,result.id,target.id,{sourceField:'audio',targetField:'voice'}).ok,false);
  owner.data.editor_outputs=[];
  assert.equal(sourceOutputType(result,{sourceOutput:'keep'},'audio',graph),null);
});

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

test('audio references bind one audio field, fan out to another and cannot bind images or scalar controls', () => {
  const source = createNode('reference', 0, 0, { mediaType: 'audio', name: 'input/voice.wav' });
  const target = createNode('generation', 300, 0, { kind: 'package', package_id: 'p-audio', packageFields: [
    { id: 'voice', type: 'audio', label: '声音' }, { id: 'other', type: 'audio', label: '另一声音' },
    { id: 'image', type: 'image', label: '图片' }, { id: 'scalar', type: 'number', label: '长度' },
  ] });
  const graph = { nodes: [source, target], edges: [] };
  connect(graph, source.id, target.id, { targetField: 'voice', sourceField: 'audio' });
  assert.match(canConnect(graph, source.id, target.id, { targetField: 'voice' }).reason, /已有连接/);
  assert.equal(canConnect(graph, source.id, target.id, { targetField: 'image' }).ok, false);
  assert.equal(canConnect(graph, source.id, target.id, { targetField: 'scalar' }).ok, false);
  connect(graph, source.id, target.id, { targetField: 'other' });
  const restored = parseGraph(serializeGraph(graph));
  assert.equal(restored.edges[0].sourceField, 'audio');
  assert.deepEqual(generationPayload(restored, target.id).values, { voice: 'input/voice.wav', other: 'input/voice.wav' });
});

test('unknown sinks cannot acquire a type from their target or sourceField but completed files prove their type', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-source',
    editor_output_fields: [{ id: 'mystery', mediaType: 'unknown' }] });
  const target = createNode('generation', 300, 0, { kind: 'package', package_id: 'p-audio',
    packageFields: [{ id: 'voice', type: 'audio', label: '声音' }] });
  const graph = { nodes: [source, target], edges: [] };
  for (const sourceField of [undefined, 'audio', 'image']) {
    const options = { targetField: 'voice', ...(sourceField ? { sourceField } : {}) };
    assert.match(canConnect(graph, source.id, target.id, options).reason, /类型未知/);
  }
  source.data.outputs = [{ type: 'audio', node_id: 'mystery', filename: 'voice.wav', output_id: 'stable-file' }];
  connect(graph, source.id, target.id, { targetField: 'voice', sourceField: 'audio', sourceOutput: 'mystery' });
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.nodes[0].data.outputs, source.data.outputs);
  assert.equal(sourceOutputType(restored.nodes[0], restored.edges[0], 'audio', restored), 'audio');
  assert.equal(canConnect({ nodes: graph.nodes, edges: [] }, source.id, target.id,
    { targetField: 'voice', sourceOutput: 'missing' }).ok, false);
  assert.deepEqual(generationPayload(restored, target.id, { edgeImages: { [graph.edges[0].id]: 'input/fresh.wav' } }).values, { voice: 'input/fresh.wav' });
});

test('legacy unknown edges import unchanged and require actual runtime type evidence before payload construction', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-source' });
  const target = createNode('generation', 300, 0, { kind: 'package', package_id: 'p-target',
    packageFields: [{ id: 'image', type: 'image', label: '图片' }] });
  const graph = { nodes: [source, target], edges: [{ id: 'legacy', source: source.id, target: target.id, targetField: 'image', sourceField: 'image', outputIndex: 1 }] };
  const loaded = parseGraph(serializeGraph(graph));
  assert.deepEqual(loaded.edges, graph.edges);
  assert.throws(() => generationPayload(loaded, target.id, { edgeImages: { legacy: 'input/fresh.png' } }), /类型未知/);
  assert.deepEqual(generationPayload(loaded, target.id, { edgeImages: { legacy: 'input/fresh.png' }, edgeMediaTypes: { legacy: 'image' } }).values, { image: 'input/fresh.png' });
  assert.throws(() => generationPayload(loaded, target.id, { edgeImages: { legacy: 'input/wrong.wav' }, edgeMediaTypes: { legacy: 'audio' } }), /不匹配/);
  const malformed = { ...graph, edges: [{ ...graph.edges[0], sourceField: 'video' }] };
  assert.throws(() => parseGraph(serializeGraph(malformed)), /不匹配/);
});

test('audio result output selection follows explicit sink types and filters unselected declared outputs', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-source', editor_outputs: ['voice'],
    editor_output_fields: [{ id: 'voice', mediaType: 'audio' }, { id: 'removed', mediaType: 'image' }] });
  const result = createNode('result', 150, 0);
  const target = createNode('generation', 300, 0, { kind: 'package', package_id: 'p-audio',
    packageFields: [{ id: 'audio', type: 'audio', label: '声音' }] });
  const graph = { nodes: [source, result, target], edges: [] };
  connect(graph, source.id, result.id);
  connect(graph, result.id, target.id, { targetField: 'audio', sourceField: 'audio', sourceOutput: 'voice', outputIndex: 1 });
  assert.equal(sourceOutputType(source, { sourceOutput: 'removed' }, 'image', graph), null);
  const loaded = parseGraph(serializeGraph(graph));
  assert.deepEqual(generationPayload(loaded, target.id, { edgeImages: { [graph.edges[1].id]: 'input/voice.wav' } }).values, { audio: 'input/voice.wav' });
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
    Object.fromEntries(Array.from({ length: 4097 }, (_, index) => ['slot_' + index, '端口 ' + index])),
  ]) {
    const broken = createNode('generation', 0, 0, { kind: 'qwen21_edit', inputLabels });
    assert.throws(() => parseGraph(serializeGraph({ nodes: [broken], edges: [] })), /端口名称/);
  }
  const malformed = { schema: 'frameweave.canvas.v1', nodes: [{ ...localVideo, data: { ...localVideo.data, localMedia: 'yes' } }], edges: [] };
  assert.throws(() => parseGraph(malformed), /本地媒体/);
});

function imageSlotGraph(kind, slots) {
  const target = createNode('generation', 0, 0, { kind });
  const sources = slots.map(slot => createNode('reference', 0, 0, { name: `input/${slot}.png` }));
  const graph = { nodes: [target, ...sources], edges: [] };
  slots.forEach((slot, index) => connect(graph, sources[index].id, target.id, { targetField: slot }));
  return { graph, target, sources };
}

test('Qwen edit requires its target and every earlier slot without compacting saved holes', () => {
  for (const [slots, missing] of [
    [[], ['image_1']],
    [['image_2'], ['image_1']],
    [['image_3', 'image_1'], ['image_2']],
    [['image_10', 'image_1'], Array.from({ length: 8 }, (_, index) => 'image_' + (index + 2))],
  ]) {
    const { graph, target } = imageSlotGraph('qwen21_edit', slots);
    target.data.inputLabels = { image_1: '我的编辑原图', image_2: '人物参考' };
    const serialized = serializeGraph(graph);
    const restored = parseGraph(serialized);
    assert.equal(serializeGraph(restored), serialized);
    for (const candidate of [graph, restored]) {
      assert.throws(() => generationPayload(candidate, target.id), error => {
        assert.match(error.message, /缺少图片输入端口/);
        missing.forEach(slot => assert.ok(error.message.includes(`（${slot}）`), error.message));
        assert.match(error.message, /不会自动前移/);
        if (missing.includes('image_1')) assert.match(error.message, /我的编辑原图/);
        return true;
      });
    }
  }
});

test('Qwen deletion keeps a surviving reference in its saved slot and requires the removed target', () => {
  const { graph, target, sources } = imageSlotGraph('qwen21_edit', ['image_2', 'image_1']);
  assert.deepEqual(generationPayload(graph, target.id).references, ['input/image_1.png', 'input/image_2.png']);
  removeNodes(graph, [sources[1].id]);
  const restored = parseGraph(serializeGraph(graph));
  assert.equal(edgeInputField(restored, restored.edges[0]), 'image_2');
  assert.throws(() => generationPayload(restored, target.id), /编辑目标（image_1）/);
});

test('removing the first legacy reference freezes surviving inferred slots before save and reload', () => {
  const target = createNode('generation', 0, 0, { kind: 'qwen21_edit' });
  const first = createNode('reference', 0, 0, { name: 'first.png' });
  const second = createNode('reference', 0, 0, { name: 'second.png' });
  const graph = { nodes: [target, first, second], edges: [] };
  connect(graph, first.id, target.id);
  connect(graph, second.id, target.id);
  assert.deepEqual(generationPayload(graph, target.id).references, ['first.png', 'second.png']);
  removeNodes(graph, [first.id]);
  const restored = parseGraph(serializeGraph(graph));
  assert.equal(restored.edges[0].targetField, 'image_2');
  assert.throws(() => generationPayload(restored, target.id), /编辑目标（image_1）/);
});

test('removing a legacy edge keeps surviving slot numbers and leaves legacy prompt semantics intact', () => {
  const target = createNode('generation', 0, 0, { kind: 'qwen21_edit' });
  const prompt = createNode('prompt', 0, 0, { text: 'positive', negative: 'negative' });
  const sources = ['first.png', 'second.png', 'third.png'].map(name => createNode('reference', 0, 0, { name }));
  const graph = { nodes: [target, prompt, ...sources], edges: [] };
  connect(graph, prompt.id, target.id);
  sources.forEach(source => connect(graph, source.id, target.id));
  const deleted = graph.edges[2].id;
  assert.equal(removeEdges(graph, [deleted]), graph);
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.edges.slice(1).map(edge => edgeInputField(restored, edge)), ['image_1', 'image_3']);
  assert.equal(restored.edges[0].targetField, undefined);
  assert.throws(() => generationPayload(restored, target.id), /参考图 2（image_2）/);
  removeEdges(restored, [restored.edges[2].id]);
  const payload = generationPayload(restored, target.id);
  assert.deepEqual(payload.references, ['first.png']);
  assert.equal(payload.positive, 'positive');
  assert.equal(payload.negative, 'negative');
});

test('duplicating a partial legacy selection preserves the reference slot from the original canvas', () => {
  const target = createNode('generation', 0, 0, { kind: 'qwen21_edit' });
  const first = createNode('reference', 0, 0, { name: 'first.png' });
  const second = createNode('reference', 0, 0, { name: 'second.png' });
  const graph = { nodes: [target, first, second], edges: [] };
  connect(graph, first.id, target.id);
  connect(graph, second.id, target.id);
  const [targetId] = duplicateNodes(graph, [target.id, second.id]);
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(generationPayload(restored, target.id).references, ['first.png', 'second.png']);
  assert.equal(graph.edges[1].targetField, undefined);
  assert.equal(restored.edges.find(edge => edge.target === targetId).targetField, 'image_2');
  assert.throws(() => generationPayload(restored, targetId), /编辑目标（image_1）/);
});

test('Krea and H3 numbered references reject holes while preserving complete reference order', () => {
  for (const [kind, slots, missing] of [
    ['krea', ['image_2'], 'image_1'],
    ['krea', ['image_3', 'image_1'], 'image_2'],
    ['h3_ref', ['ref_image_1'], 'ref_image_0'],
    ['h3_ref', ['ref_image_2', 'ref_image_0'], 'ref_image_1'],
  ]) {
    const { graph, target } = imageSlotGraph(kind, slots);
    const restored = parseGraph(serializeGraph(graph));
    assert.throws(() => generationPayload(restored, target.id), error => error.message.includes(`（${missing}）`));
  }
  for (const kind of ['qwen21_edit', 'krea', 'h3_ref']) {
    const slots = generationInputPorts(createNode('generation', 0, 0, { kind })).filter(port => port.type === 'image').map(port => port.id);
    const { graph, target } = imageSlotGraph(kind, slots.toReversed());
    const restored = parseGraph(serializeGraph(graph));
    assert.deepEqual(generationPayload(restored, target.id).references, slots.map(slot => `input/${slot}.png`));
  }
  const { graph, target } = imageSlotGraph('krea', []);
  assert.deepEqual(generationPayload(graph, target.id).references, []);
});

test('H3 first and last frames keep explicit roles including a last-frame-only canvas', () => {
  for (const [slots, names, roles] of [
    [['end_image'], ['input/end_image.png'], ['end']],
    [['start_image'], ['input/start_image.png'], ['start']],
    [['end_image', 'start_image'], ['input/start_image.png', 'input/end_image.png'], ['start', 'end']],
  ]) {
    const { graph, target, sources } = imageSlotGraph('h3_i2v', slots);
    sources.forEach(source => source.data.role = source.data.name.includes('end_image') ? 'start' : 'end');
    const restored = parseGraph(serializeGraph(graph));
    const payload = generationPayload(restored, target.id);
    assert.deepEqual(payload.references, names);
    assert.deepEqual(payload.reference_roles, roles);
  }
});
