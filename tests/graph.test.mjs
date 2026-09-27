import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, createDemo, connect, canConnect, removeNodes, duplicateNodes, generationPayload, executionOrder, recipeGraph, serializeGraph, parseGraph, stableStringify, progressPercent, validateExecutionMediaBackends } from '../web/graph.mjs';

test('Qwen 2.1 canvas preserves model identity and reference order rather than video frame roles', () => {
  const target = createNode('generation', 0, 0, { kind: 'qwen21_edit', models: { dit: 'qwen_image_2.1_variant.safetensors' }, width: 1024, height: 1024 });
  const first = createNode('reference', 0, 0, { name: 'target.png', role: 'end' });
  const second = createNode('reference', 0, 0, { name: 'reference.png', role: 'start' });
  const graph = { nodes: [target, first, second], edges: [] };
  connect(graph, first.id, target.id); connect(graph, second.id, target.id);
  const restored = parseGraph(serializeGraph(graph));
  const payload = generationPayload(restored, target.id);
  assert.deepEqual(payload.references, ['target.png', 'reference.png']);
  assert.equal(Object.hasOwn(payload, 'reference_roles'), false);
  assert.equal(payload.models.dit, 'qwen_image_2.1_variant.safetensors');
  target.data.kind = 'qwen21_t2i';
  assert.throws(() => generationPayload(graph, target.id), /不接收参考图/);
  target.data.kind = 'qwen21_edit'; second.data.name = '';
  assert.throws(() => generationPayload(graph, target.id), /尚未上传/);
  second.data.name = 'reference.png'; target.data.denoise = .5;
  assert.throws(() => generationPayload(graph, target.id), /denoise=1/);
});

test('canvas serialization is stable and retains all generation controls', () => {
  const graph = createDemo();
  const generation = graph.nodes.find(node => node.type === 'generation');
  Object.assign(generation.data, { sampler: 'dpmpp_2m', scheduler: 'karras', lora_strength: .65, denoise: .8, seed: 9007199254740000, models: { lora: 'h3-style.safetensors', dit: 'h3-fl2va.safetensors' } });
  const initial = serializeGraph(graph, { x: -121.5, y: 202, scale: .7 });
  const restored = parseGraph(initial);
  assert.equal(serializeGraph(restored, restored.viewport), initial);
  assert.deepEqual(restored.nodes.find(node => node.id === generation.id).data, generation.data);
  assert.equal(stableStringify({ z: 2, a: { y: 4, x: 1 } }), stableStringify({ a: { x: 1, y: 4 }, z: 2 }));
});

test('removing any node cleans both incoming and outgoing edges', () => {
  const graph = createDemo();
  const generation = graph.nodes.find(node => node.type === 'generation');
  assert.equal(graph.edges.length, 2);
  removeNodes(graph, [generation.id]);
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(graph.edges, []);
});

test('connections reject self loops, duplicates, invalid directions and cycles', () => {
  const graph = createDemo();
  const [prompt, generation, result] = graph.nodes;
  assert.throws(() => connect(graph, prompt.id, prompt.id), /自身/);
  assert.throws(() => connect(graph, prompt.id, generation.id), /已存在/);
  assert.throws(() => connect(graph, result.id, prompt.id), /连接顺序/);
  const polluted = { nodes: [prompt, generation], edges: [{ id: 'reverse', source: generation.id, target: prompt.id }] };
  assert.equal(canConnect(polluted, prompt.id, generation.id).ok, false);
  assert.match(canConnect(polluted, prompt.id, generation.id).reason, /循环/);
});

test('duplicate preserves selected internal connections and isolates result jobs', () => {
  const graph = createDemo();
  graph.nodes[2].data.outputs = [{ type: 'image', url: '/api/media/example', filename: 'test.png' }];
  graph.nodes[2].data.jobId = 'existing-job';
  const sourceIds = graph.nodes.map(node => node.id);
  const ids = duplicateNodes(graph, sourceIds);
  assert.equal(ids.length, 3);
  assert.equal(new Set([...sourceIds, ...ids]).size, 6);
  const clones = graph.nodes.filter(node => ids.includes(node.id));
  assert.equal(graph.edges.filter(edge => ids.includes(edge.source) && ids.includes(edge.target)).length, 2);
  assert.equal(graph.edges.filter(edge => sourceIds.includes(edge.source) && ids.includes(edge.target)).length, 0);
  assert.deepEqual(clones.find(node => node.type === 'result').data.outputs, []);
  assert.equal(clones.find(node => node.type === 'result').data.jobId, '');
});

test('payload combines connected prompts and preserves explicit reference roles', () => {
  const graph = createDemo(); const generation = graph.nodes[1];
  generation.data.kind = 'h3_i2v'; generation.data.positive = '缓慢推进';
  const end = createNode('reference', 0, 0, { role: 'end', name: 'end.png' });
  const start = createNode('reference', 0, 0, { role: 'start', name: 'start.png' });
  graph.nodes.push(end, start); connect(graph, end.id, generation.id); connect(graph, start.id, generation.id);
  const payload = generationPayload(graph, generation.id);
  assert.deepEqual(payload.references, ['start.png', 'end.png']);
  assert.deepEqual(payload.reference_roles, ['start', 'end']);
  assert.match(payload.positive, /温室/); assert.match(payload.positive, /缓慢推进/);
  assert.equal(payload.seed, 42); assert.equal(payload.fps, 24); assert.equal(payload.sampler, 'euler');
  assert.equal('title' in payload, false);
});

test('API format workflows round-trip without dropping advanced node inputs', () => {
  const graph = createDemo(); const node = graph.nodes[1];
  node.data.kind = 'api'; node.data.apiPrompt = { '7': { class_type: 'CustomNode', inputs: { nested: { values: [1, 'test', true] }, model: ['9', 0] }, _meta: { title: '用户节点' } } };
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(generationPayload(restored, node.id), { kind: 'api', prompt: node.data.apiPrompt });
});

test('invalid imports reject missing nodes, duplicate ids, unsupported types and NaN positions', () => {
  const original = JSON.parse(serializeGraph(createDemo()));
  const missing = structuredClone(original); missing.edges[0].source = 'missing'; assert.throws(() => parseGraph(missing), /不存在/);
  const duplicate = structuredClone(original); duplicate.nodes[1].id = duplicate.nodes[0].id; assert.throws(() => parseGraph(duplicate), /重复/);
  const type = structuredClone(original); type.nodes[0].type = 'script'; assert.throws(() => parseGraph(type), /不支持/);
  const position = structuredClone(original); position.nodes[0].x = 'Infinity'; assert.throws(() => parseGraph(position), /坐标/);
});

test('pending jobs keep null progress unknown and safely accept real backend counters', () => {
  assert.equal(progressPercent(null), null);
  assert.equal(progressPercent(undefined), null);
  assert.equal(progressPercent({ value: 1, max: 0 }), null);
  assert.equal(progressPercent({ value: 3, max: 20 }), 15);
  assert.equal(progressPercent({ value: 0, max: 20 }), 0);
  assert.equal(progressPercent(100), 100);
  assert.equal(progressPercent(NaN), null);
  assert.equal(progressPercent('25'), null);
});

test('SDXL image-to-image and four independent LoRA controls survive canvas and recipe round trips', () => {
  const graph = createDemo(), node = graph.nodes[1];
  const stack = [
    { name: '风格/纸上晨光.safetensors', strength_model: .65, strength_clip: .4 },
    { name: '角色/小鸟.safetensors', strength_model: 0, strength_clip: -1.2 },
    { name: '线条.safetensors' },
    { name: 'detail.safetensors', strength_model: -10, strength_clip: 10 },
  ];
  Object.assign(node.data, { kind: 'sdxl_i2i', positive: '保持原图构图。🌅', negative: '模糊', denoise: .45, loras: stack });
  const reference = createNode('reference', 0, 0, { name: 'input/庭院.png', role: 'reference' });
  graph.nodes.push(reference); connect(graph, reference.id, node.id);
  const text = serializeGraph(graph), restored = parseGraph(text);
  assert.equal(serializeGraph(restored), text);
  const request = generationPayload(restored, node.id);
  assert.deepEqual(request.loras, stack);
  assert.equal(request.kind, 'sdxl_i2i');
  assert.equal(request.denoise, .45);
  assert.deepEqual(request.references, ['input/庭院.png']);
  assert.equal(request.positive, `${graph.nodes[0].data.text}\n\n保持原图构图。🌅`);
  assert.equal(request.negative, `${graph.nodes[0].data.negative}, 模糊`);
  const fragment = recipeGraph({ title: '重新创作', request });
  assert.deepEqual(generationPayload(parseGraph(serializeGraph(fragment)), fragment.generationId), request);
  request.loras[0].strength_model = 7;
  assert.equal(restored.nodes[1].data.loras[0].strength_model, .65);
});

test('optional LoRA stack preserves legacy selections and explicit empty stack disables them', () => {
  const graph = createDemo(), node = graph.nodes[1];
  node.data.models.lora = 'legacy.safetensors'; node.data.lora_strength = .7;
  let restored = parseGraph(serializeGraph(graph)), request = generationPayload(restored, node.id);
  assert.equal(Object.hasOwn(request, 'loras'), false);
  assert.equal(request.models.lora, 'legacy.safetensors');
  assert.equal(request.lora_strength, .7);
  node.data.lora = 'preferred.safetensors'; node.data.loras = [];
  restored = parseGraph(serializeGraph(graph)); request = generationPayload(restored, node.id);
  assert.deepEqual(request.loras, []);
  assert.equal(request.models.lora, 'preferred.safetensors');
  assert.equal(Object.hasOwn(request, 'lora'), false);
});

test('LoRA import and payload validation reject malformed stacks without silently dropping settings', () => {
  const graph = createDemo(), node = graph.nodes[1]; node.data.kind = 'sdxl';
  const invalid = [null, {}, 'style', Array.from({ length: 5 }, () => ({ name: 'style' })),
    [null], ['style'], [{ name: '' }], [{ name: ' ' }], [{ name: 8 }], [{ name: 'x'.repeat(1025) }],
    [{ name: 'style', strength_model: true }], [{ name: 'style', strength_model: '.5' }],
    [{ name: 'style', strength_model: 10.1 }], [{ name: 'style', strength_clip: -10.1 }],
    [{ name: 'style', strength_clip: null }], [{ name: 'style', strength: .5 }],
    JSON.parse('[{"name":"style","__proto__":{"polluted":true}}]')];
  for (const stack of invalid) {
    node.data.loras = stack;
    assert.throws(() => parseGraph(serializeGraph(graph)), /LoRA/);
    assert.throws(() => generationPayload(graph, node.id), /LoRA/);
  }
  node.data.loras = [{ name: 'style', strength_model: NaN }];
  assert.throws(() => generationPayload(graph, node.id), /LoRA/);
});

test('H3 and Krea LoRA stacks reject unsupported CLIP strength and preserve zero model strengths', () => {
  const graph = createDemo(), node = graph.nodes[1];
  for (const kind of ['h3_t2v', 'h3_i2v', 'h3_ref', 'krea']) {
    node.data.kind = kind; node.data.loras = [{ name: 'style', strength_model: 0, strength_clip: 0 }];
    assert.deepEqual(generationPayload(parseGraph(serializeGraph(graph)), node.id).loras, node.data.loras);
    node.data.loras[0].strength_clip = .1;
    assert.throws(() => parseGraph(serializeGraph(graph)), /CLIP/);
    assert.throws(() => generationPayload(graph, node.id), /CLIP/);
  }
});

test('image-to-image drafts can be saved but need exactly one uploaded image before submission', () => {
  const graph = createDemo(), node = graph.nodes[1]; node.data.kind = 'sdxl_i2i';
  assert.doesNotThrow(() => parseGraph(serializeGraph(graph)));
  assert.throws(() => generationPayload(graph, node.id), /1 张/);
  const reference = createNode('reference', 0, 0, { name: '' });
  graph.nodes.push(reference); connect(graph, reference.id, node.id);
  assert.throws(() => generationPayload(graph, node.id), /1 张/);
  reference.data.name = 'portrait.png';
  assert.deepEqual(generationPayload(graph, node.id).references, ['portrait.png']);
  reference.data.mediaType = 'video';
  assert.throws(() => generationPayload(graph, node.id), /图片参考素材/);
  reference.data.mediaType = 'image';
  for (const name of ['../portrait.png', '/tmp/portrait.png', 'C:\\portrait.png', 'a\0.png', 'images\\..\\secret.png']) {
    reference.data.name = name;
    assert.throws(() => generationPayload(graph, node.id), /相对名称/);
  }
  reference.data.name = 'portrait.png';
  const second = createNode('reference', 0, 0, { name: 'second.png' });
  graph.nodes.push(second); connect(graph, second.id, node.id);
  assert.throws(() => generationPayload(graph, node.id), /1 张/);
  removeNodes(graph, [second.id]); node.data.kind = 'sdxl';
  assert.deepEqual(generationPayload(graph, node.id).references, ['portrait.png']);
});

test('invalid root documents and imprecise seed strings cannot import as a different reproducible request', () => {
  for (const value of ['null', '[]', '"canvas"']) assert.throws(() => parseGraph(value), /有效/);
  const graph = createDemo(), node = graph.nodes[1];
  node.data.kind = 'invalid';
  assert.throws(() => generationPayload(graph, node.id), /模式/);
  node.data.kind = 'sdxl'; node.data.seed = '9007199254740993';
  assert.throws(() => parseGraph(serializeGraph(graph)), /随机种子/);
  assert.throws(() => generationPayload(graph, node.id), /随机种子/);
});

test('canvas zoom up to 300 percent survives save and reload while out-of-range scales are bounded', () => {
  const graph = createDemo();
  for (const scale of [.2, 1, 2.5, 3]) {
    const text = serializeGraph(graph, { x: -82, y: 70, scale });
    const restored = parseGraph(text);
    assert.equal(restored.viewport.scale, scale);
    assert.equal(serializeGraph(restored, restored.viewport), text);
  }
  assert.equal(parseGraph(serializeGraph(graph, { scale: 4 })).viewport.scale, 3);
  assert.equal(parseGraph(serializeGraph(graph, { scale: .1 })).viewport.scale, .2);
});

const workflowNode = (label, fields = ['image']) => createNode('generation', 0, 0, {
  title: label, kind: 'package', package_id: `p-${label}`,
  packageFields: fields.map(id => ({ id, label: id, type: 'image' })),
});

test('package image edges preserve independent output indices for the same upstream source', () => {
  const source = createNode('generation', 0, 0, { kind: 'sdxl' });
  const target = workflowNode('comparison', ['left', 'right']);
  const graph = { nodes: [source, target], edges: [] };
  connect(graph, source.id, target.id, { targetField: 'left', sourceField: 'image', outputIndex: 0 });
  connect(graph, source.id, target.id, { targetField: 'right', sourceField: 'image', outputIndex: 31 });
  const text = serializeGraph(graph), restored = parseGraph(text);
  assert.equal(serializeGraph(restored), text);
  assert.deepEqual(executionOrder(restored, [target.id]), [source.id, target.id]);
  const request = generationPayload(restored, target.id, { edgeImages: {
    [graph.edges[0].id]: 'input/first.png', [graph.edges[1].id]: 'input/last.png',
  } });
  assert.deepEqual(request.values, { left: 'input/first.png', right: 'input/last.png' });
});

test('package edge selectors reject invalid names, unsupported source fields and out-of-range indices', () => {
  const source = createNode('generation', 0, 0, { kind: 'sdxl' }), target = workflowNode('target');
  const graph = { nodes: [source, target], edges: [] };
  for (const outputIndex of [-1, 32, .5, '0', true, null, NaN, Infinity]) {
    assert.equal(canConnect(graph, source.id, target.id, { targetField: 'image', outputIndex }).ok, false);
  }
  for (const targetField of ['', '__proto__', 'constructor', 'prototype', 'a'.repeat(81), null]) {
    assert.equal(canConnect(graph, source.id, target.id, { targetField }).ok, false);
  }
  for (const sourceField of ['text', 'negative', 'filename', '', null, []]) {
    assert.equal(canConnect(graph, source.id, target.id, { targetField: 'image', sourceField }).ok, false);
  }
  assert.equal(canConnect(graph, source.id, target.id, null).ok, false);
  const result = createNode('result', 0, 0); graph.nodes.push(result);
  assert.equal(canConnect(graph, source.id, result.id, { targetField: 'image' }).ok, false);
  connect(graph, source.id, target.id, { targetField: 'image' });
  for (const patch of [{ outputIndex: 32 }, { sourceField: 'negative' }, { targetField: 'missing' }]) {
    const raw = JSON.parse(serializeGraph(graph)); Object.assign(raw.edges[0], patch);
    assert.throws(() => parseGraph(raw), /连接/);
  }
});

test('execution order walks result intermediates and shared dependencies exactly once', () => {
  const source = createNode('generation', 0, 0, { kind: 'sdxl' }), preview = createNode('result', 0, 0);
  const left = workflowNode('left'), right = workflowNode('right'), end = workflowNode('end', ['left', 'right']);
  const unused = workflowNode('unused');
  // Deliberately store consumers before producers to exercise true topological order.
  const graph = { nodes: [end, unused, right, left, preview, source], edges: [] };
  connect(graph, source.id, preview.id);
  connect(graph, preview.id, left.id, { targetField: 'image' });
  connect(graph, source.id, right.id, { targetField: 'image' });
  connect(graph, left.id, end.id, { targetField: 'left' });
  connect(graph, right.id, end.id, { targetField: 'right' });
  assert.deepEqual(executionOrder(graph, [end.id]), [source.id, left.id, right.id, end.id]);
  assert.deepEqual(executionOrder(graph, new Set([end.id, source.id, left.id])), [source.id, left.id, right.id, end.id]);
  assert.deepEqual(executionOrder(graph, [preview.id]), [source.id]);
  assert.deepEqual(executionOrder(graph, []), []);
  assert.equal(executionOrder(graph).includes(unused.id), true);
  assert.throws(() => executionOrder(graph, ['missing']), /不存在/);
  assert.throws(() => executionOrder(graph, end.id), /列表/);
});

test('package chains reject direct and result-mediated cycles at connect, import and execution boundaries', () => {
  const first = workflowNode('first'), second = workflowNode('second'), preview = createNode('result', 0, 0);
  const graph = { nodes: [first, second, preview], edges: [] };
  connect(graph, first.id, preview.id);
  connect(graph, preview.id, second.id, { targetField: 'image' });
  assert.match(canConnect(graph, second.id, first.id, { targetField: 'image' }).reason, /循环/);
  assert.match(canConnect(graph, first.id, first.id, { targetField: 'image' }).reason, /自身/);
  graph.edges.push({ id: 'cycle', source: second.id, target: first.id, targetField: 'image' });
  assert.throws(() => parseGraph(serializeGraph(graph)), /循环/);
  assert.throws(() => executionOrder(graph, [second.id]), /循环/);
  const broken = { nodes: [first], edges: [{ id: 'missing', source: 'lost', target: first.id }] };
  assert.throws(() => executionOrder(broken), /缺失节点/);
});

test('duplicating workflow packages retains all public port bindings and clears result ownership', () => {
  const source = createNode('generation', 10, 0, { kind: 'sdxl' }), preview = createNode('result', 50, 0, { jobId: 'old', outputs: [{ type: 'image', url: '/api/media/old' }] });
  const target = workflowNode('target'); target.x = 100;
  const graph = { nodes: [source, preview, target], edges: [] };
  connect(graph, source.id, preview.id);
  connect(graph, preview.id, target.id, { targetField: 'image', sourceField: 'image', outputIndex: 3 });
  const ids = duplicateNodes(graph, graph.nodes.map(node => node.id));
  const clone = graph.nodes.find(node => node.id === ids[2]);
  assert.deepEqual(clone.data.packageFields, target.data.packageFields);
  const bound = graph.edges.find(edge => edge.target === clone.id);
  assert.equal(bound.targetField, 'image'); assert.equal(bound.sourceField, 'image'); assert.equal(bound.outputIndex, 3);
  assert.deepEqual(graph.nodes.find(node => node.id === ids[1]).data.outputs, []);
  assert.equal(graph.nodes.find(node => node.id === ids[1]).data.jobId, '');
  clone.data.packageFields[0].label = 'changed';
  assert.equal(target.data.packageFields[0].label, 'image');
  assert.doesNotThrow(() => parseGraph(serializeGraph(graph)));
  assert.deepEqual(executionOrder(graph, [clone.id]), [ids[0], ids[2]]);
});


test('canvas preserves explicit refinement and audio package fields/results through reload', () => {
  const graph = { nodes: [createNode('generation', 0, 0, { kind: 'sdxl', refine: { enabled: true, width: 1536, height: 1536, steps: 12, denoise: .25, upscale_method: 'bilinear' } }), createNode('result', 500, 0, { outputs: [{ type: 'audio', url: '/api/media/test', filename: 'sample.wav' }] })], edges: [] };
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.nodes[0].data.refine, graph.nodes[0].data.refine);
  assert.equal(restored.nodes[1].data.outputs[0].type, 'audio');
});

test('reference upload engine identity survives canvas save and rejects cross-engine handoff', () => {
  const target = createNode('generation', 300, 0, { editor_backend: 'http://127.0.0.1:8188' });
  const reference = createNode('reference', 0, 0, { name: 'input/portrait.png', uploadBackend: 'http://127.0.0.1:8189' });
  const unrelated = createNode('reference', 0, 400, { name: 'input/unused.png', uploadBackend: 'http://127.0.0.1:8189' });
  const graph = { nodes: [target, reference, unrelated], edges: [] };
  connect(graph, reference.id, target.id);
  const restored = parseGraph(serializeGraph(graph));
  const restoredReference = restored.nodes.find(node => node.id === reference.id);
  assert.equal(restoredReference.data.uploadBackend, 'http://127.0.0.1:8189');
  assert.throws(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'), /目标引擎.*重新上传/);
  assert.throws(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8188', 'http://127.0.0.1:8188'), /目标引擎.*重新上传/);
  restoredReference.data.uploadBackend = 'http://127.0.0.1:8188';
  assert.doesNotThrow(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'));
});

test('backend identities normalize localhost and preserve explicit loopback ports including 80', () => {
  const references = [
    createNode('reference', 0, 0, { name: 'a.png', uploadBackend: 'http://127.0.0.2' }),
    createNode('reference', 0, 0, { name: 'b.png', uploadBackend: 'http://[::1]' }),
    createNode('reference', 0, 0, { name: 'c.png', uploadBackend: 'http://localhost:8188' }),
  ];
  const restored = parseGraph(serializeGraph({ nodes: references, edges: [] }));
  assert.deepEqual(restored.nodes.map(node => node.data.uploadBackend), [
    'http://127.0.0.2:80', 'http://[::1]:80', 'http://127.0.0.1:8188',
  ]);
  const target = createNode('generation', 300, 0, { editor_backend: 'http://127.0.0.2:80' });
  const sameEngine = createNode('reference', 0, 0, { name: 'same.png', uploadBackend: 'http://127.0.0.2' });
  const sameGraph = { nodes: [target, sameEngine], edges: [] };
  connect(sameGraph, sameEngine.id, target.id);
  const sameRestored = parseGraph(serializeGraph(sameGraph));
  assert.doesNotThrow(() => validateExecutionMediaBackends(sameRestored, [target.id], 'http://127.0.0.2:80', 'http://127.0.0.2:80'));
  references[0].data.uploadBackend = 'http://128.0.0.1:8188';
  assert.throws(() => parseGraph(serializeGraph({ nodes: references, edges: [] })), /本机回环地址/);
});

test('old reference nodes without an owner are blocked on engine switch but remain usable without a switch', () => {
  const target = createNode('generation', 300, 0, { editor_backend: 'http://127.0.0.1:8188' });
  const reference = createNode('reference', 0, 0, { name: 'legacy.png' });
  const graph = { nodes: [target, reference], edges: [] };
  connect(graph, reference.id, target.id);
  const restored = parseGraph(serializeGraph(graph));
  assert.equal(restored.nodes.find(node => node.id === reference.id).data.uploadBackend, undefined);
  assert.throws(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'), /没有上传引擎记录/);
  assert.doesNotThrow(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8188', 'http://127.0.0.1:8188'));
});

test('package image values preserve owner and are checked only when an image field supplies the value', () => {
  const target = createNode('generation', 300, 0, {
    kind: 'package', package_id: 'p-test', editor_backend: 'http://127.0.0.1:8188',
    packageFields: [{ id: 'image', label: '参考图', type: 'image' }],
    packageValues: { image: 'input/package.png' },
    packageMediaBackends: { image: { name: 'input/package.png', backend: 'http://localhost:8188' } },
  });
  const graph = { nodes: [target], edges: [] };
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.nodes[0].data.packageMediaBackends, {
    image: { name: 'input/package.png', backend: 'http://127.0.0.1:8188' },
  });
  assert.doesNotThrow(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'));
  restored.nodes[0].data.packageMediaBackends.image.backend = 'http://127.0.0.1:8189';
  assert.throws(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8188', 'http://127.0.0.1:8188'), /目标引擎.*重新上传/);
  restored.nodes[0].data.packageMediaBackends.image.backend = 'http://127.0.0.1:8188';
  restored.nodes[0].data.packageMediaBackends.image.name = 'old-filename.png';
  assert.throws(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'), /没有上传引擎记录/);
});

test('package audio values stop on a different engine and pass after upload to the target engine', () => {
  const target = createNode('generation', 300, 0, {
    kind: 'package', package_id: 'p-audio', editor_backend: 'http://127.0.0.1:8188',
    packageFields: [{ id: 'voice', label: '参考音频', type: 'audio' }],
    packageValues: { voice: 'input/voice.wav' },
    packageMediaBackends: { voice: { name: 'input/voice.wav', backend: 'http://127.0.0.1:8189' } },
  });
  const graph = { nodes: [target], edges: [] };
  const restored = parseGraph(serializeGraph(graph));
  assert.throws(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'), /目标引擎.*重新上传/);
  restored.nodes[0].data.packageMediaBackends.voice.backend = 'http://127.0.0.1:8188';
  assert.doesNotThrow(() => validateExecutionMediaBackends(restored, [target.id], 'http://127.0.0.1:8189', 'http://127.0.0.1:8188'));
});
