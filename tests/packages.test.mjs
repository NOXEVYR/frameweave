import test from 'node:test';
import assert from 'node:assert/strict';
import { packageValues, fieldType, defaultValues, coerceFieldValue, validateValues, parsePackageDocument, publicChecksReport, redactLocalText } from '../web/packages.mjs';
import { createNode, createDemo, connect, generationPayload, serializeGraph, parseGraph, canConnect } from '../web/graph.mjs';

test('workflow package nodes round-trip typed values and retain package identity', () => {
  const graph = { nodes: [createNode('generation', 30, 50, { kind: 'package', package_id: 'p-original', title: '海报生成', packageValues: { text: '清晨花园', seed: 42, enabled: false } })], edges: [] };
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(generationPayload(restored, graph.nodes[0].id), { kind: 'package', package_id: 'p-original', values: { text: '清晨花园', seed: 42, enabled: false } });
  assert.equal(restored.nodes[0].data.kind, 'package');
});

test('package nodes reject implicit prompt connections and missing package IDs', () => {
  const graph = createDemo(); graph.edges = []; graph.nodes[1].data.kind = 'package';
  assert.match(canConnect(graph, graph.nodes[0].id, graph.nodes[1].id).reason, /表单/);
  assert.equal(canConnect(graph, graph.nodes[1].id, graph.nodes[2].id).ok, true);
  assert.throws(() => generationPayload(graph, graph.nodes[1].id), /工作流包/);
});

test('previous canvas versions still import without package-only state leaking into H3 payloads', () => {
  const raw = JSON.parse(serializeGraph(createDemo()));
  delete raw.nodes[1].data.package_id; delete raw.nodes[1].data.packageValues;
  const restored = parseGraph(raw), payload = generationPayload(restored, restored.nodes[1].id);
  assert.equal(payload.kind, 'h3_t2v'); assert.equal('packageValues' in payload, false); assert.equal('package_id' in payload, false);
});

test('package input JSON rejects prototype keys, arrays and deep or non-finite data', () => {
  assert.throws(() => packageValues([]), /JSON 对象/);
  assert.throws(() => packageValues({ bad: Infinity }), /无效 JSON/);
  assert.throws(() => packageValues({ seed: 9007199254740992 }), /安全范围/);
  assert.throws(() => packageValues(JSON.parse('{"__proto__":{"polluted":true}}')), /字段名/);
  let deep = {}; for (let i = 0; i < 18; i++) deep = { value: deep };
  assert.throws(() => packageValues(deep), /过深/);
  const original = { fields: { prompt: 'a' }, values: [1, false, null] };
  assert.deepEqual(packageValues(original), original); assert.notEqual(packageValues(original), original);
});

test('typed fields preserve false and zero, validate safe integers, bounds and strict choices', () => {
  const fields = [{ id: 'seed', type: 'integer', default: 0, min: 0 }, { id: 'enabled', type: 'boolean', default: false }, { id: 'sampler', type: 'select', options: ['euler', 'heun'], default: 'euler' }];
  assert.deepEqual(defaultValues(fields), { seed: 0, enabled: false, sampler: 'euler' });
  assert.deepEqual(validateValues(fields, { seed: '123', enabled: true }), { seed: 123, enabled: true, sampler: 'euler' });
  assert.throws(() => coerceFieldValue(fields[0], '9007199254740993'), /整数/);
  assert.throws(() => coerceFieldValue(fields[0], -1), /范围/);
  assert.throws(() => coerceFieldValue(fields[1], 'false'), /开启或关闭/);
  assert.throws(() => coerceFieldValue(fields[2], 'invalid'), /可选值/);
  assert.throws(() => coerceFieldValue(fields[2], ''), /可选值/);
  assert.equal(fieldType({ type: 'INT' }), 'integer');
});

test('required image and text inputs cannot run blank', () => {
  assert.throws(() => coerceFieldValue({ type: 'image', required: true, label: '首帧' }, ''), /首帧/);
  assert.throws(() => coerceFieldValue({ type: 'text', required: true, label: '描述' }, '  '), /描述/);
  assert.equal(coerceFieldValue({ type: 'image', required: true }, 'input/portrait.png'), 'input/portrait.png');
});

test('package import accepts API JSON and versioned packages but explains ordinary ComfyUI exports', () => {
  const prompt = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a flower' } } };
  assert.deepEqual(parsePackageDocument(JSON.stringify(prompt)), prompt);
  assert.deepEqual(parsePackageDocument(JSON.stringify({ prompt })), { prompt });
  const pack = { format: 'frameweave-workflow', version: 1, prompt, fields: [] };
  assert.deepEqual(parsePackageDocument(JSON.stringify(pack)), pack);
  assert.throws(() => parsePackageDocument('{"nodes":[],"links":[]}'), /导出 API/);
  assert.throws(() => parsePackageDocument('{"format":"frameweave-workflow","version":2}'), /版本/);
  assert.throws(() => parsePackageDocument(JSON.stringify({ prompt: 'not a workflow' })), /API/);
  assert.throws(() => parsePackageDocument('{"1":{"class_type":"KSampler","inputs":{"seed":18446744073709551615}}}'), /随机种子/);
  assert.throws(() => parsePackageDocument(' '.repeat(2 * 1024 * 1024 + 1)), /2 MiB/);
});

test('public diagnostics retain unknown states and drop machine paths and unexpected fields', () => {
  const checks = [{ category: 'models', name: '模型文件', status: 'unknown', detail: '未确认 C:\\Users\\Private Person\\models\\file.bin，需检查', root: 'secret-root', machine_id: 'private' }];
  const report = publicChecksReport(checks);
  assert.equal(report.counts.unknown, 1); assert.equal(report.ready, false);
  assert.deepEqual(Object.keys(report).sort(), ['checked_at', 'counts', 'mode', 'ready', 'repair_prompt', 'scope', 'summary']);
  assert.equal(JSON.stringify(report).includes('Private Person'), false); assert.equal('checks' in report, false);
  assert.equal(JSON.stringify(report).includes('secret-root'), false);
  assert.equal(redactLocalText('配置 /home/alex/private-models，已跳过').includes('alex'), false);
  assert.equal(redactLocalText('配置 \\\\host\\share\\model.bin').includes('host'), false);
  assert.equal(redactLocalText('模型 G:/AI/my files/model.safetensors').includes('my files'), false);
});

const ports = () => [
  { id: 'scene', label: '画面描述', type: 'text' },
  { id: 'negative', label: '负向提示词', type: 'text' },
  { id: 'reference', label: '参考图片', type: 'image' },
  { id: 'seed', label: '种子', type: 'integer' },
];

function packageCanvas() {
  const prompt = createNode('prompt', 0, 0, { text: '清晨的纸上小鸟 🐦', negative: '低质量，文字' });
  const reference = createNode('reference', 0, 250, { name: 'input/bird.png' });
  const packaged = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-scene', packageFields: ports(), packageValues: { scene: 'form prompt', negative: 'form negative', seed: 0 } });
  return { nodes: [prompt, reference, packaged], edges: [] };
}

test('package ports preserve safe metadata and reject invalid, duplicate or reserved field definitions', () => {
  const graph = packageCanvas(), node = graph.nodes[2];
  node.data.packageFields[0].node_id = 'internal-node';
  node.data.packageFields[0].input = 'text';
  node.data.packageFields[0].script = 'never evaluate';
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.nodes[2].data.packageFields, ports());
  const valid = { id: 'a'.repeat(80), label: 'l'.repeat(120), type: 'text' };
  node.data.packageFields = [valid];
  assert.deepEqual(parseGraph(serializeGraph(graph)).nodes[2].data.packageFields, [valid]);
  const invalid = [null, {}, Array.from({ length: 65 }, (_, n) => ({ id: `f${n}`, label: 'field', type: 'text' })),
    [{ ...valid, id: 'a'.repeat(81) }], [{ ...valid, id: '中文' }], [{ ...valid, id: '__proto__' }],
    [{ ...valid, id: 'constructor' }], [{ ...valid, id: 'prototype' }], [{ ...valid, id: 'space id' }],
    [{ ...valid, label: 'l'.repeat(121) }], [{ ...valid, label: '' }], [{ ...valid, label: null }],
    [{ ...valid, type: 'script' }], [{ ...valid, type: {} }], [valid, valid]];
  for (const fields of invalid) {
    node.data.packageFields = fields;
    assert.throws(() => parseGraph(serializeGraph(graph)), /工作流包/);
  }
  node.data.packageFields = ['text', 'integer', 'number', 'boolean', 'select', 'image'].map((type, i) => ({ id: `f${i}`, label: type, type }));
  assert.equal(parseGraph(serializeGraph(graph)).nodes[2].data.packageFields.length, 6);
});

test('one prompt can connect positive and negative text to different package inputs without merging them', () => {
  const graph = packageCanvas(), [prompt, reference, node] = graph.nodes;
  connect(graph, prompt.id, node.id, { targetField: 'scene', sourceField: 'text' });
  connect(graph, prompt.id, node.id, { targetField: 'negative', sourceField: 'negative' });
  connect(graph, reference.id, node.id, { targetField: 'reference', sourceField: 'image', outputIndex: 0 });
  const request = generationPayload(graph, node.id);
  assert.deepEqual(request, { kind: 'package', package_id: 'p-scene', values: {
    scene: prompt.data.text, negative: prompt.data.negative, reference: reference.data.name, seed: 0,
  } });
  assert.equal(node.data.packageValues.scene, 'form prompt');
  prompt.data.negative = '';
  assert.equal(generationPayload(graph, node.id).values.negative, '');
  const text = serializeGraph(graph), restored = parseGraph(text);
  assert.equal(serializeGraph(restored), text);
  assert.deepEqual(generationPayload(restored, node.id), generationPayload(graph, node.id));
});

test('package connections enforce declared types, single field ownership and source selectors', () => {
  const graph = packageCanvas(), [prompt, reference, node] = graph.nodes;
  for (const options of [{ targetField: 'reference' }, { targetField: 'seed' }, { targetField: 'missing' },
    { targetField: 'scene', sourceField: 'image' }, { targetField: 'scene', outputIndex: 1 }]) {
    assert.equal(canConnect(graph, prompt.id, node.id, options).ok, false);
  }
  assert.equal(canConnect(graph, reference.id, node.id, { targetField: 'scene' }).ok, false);
  assert.equal(canConnect(graph, reference.id, node.id, { targetField: 'reference', sourceField: 'negative' }).ok, false);
  reference.data.mediaType = 'video';
  assert.equal(canConnect(graph, reference.id, node.id, { targetField: 'reference' }).ok, false);
  reference.data.mediaType = 'image';
  connect(graph, prompt.id, node.id, { targetField: 'scene' });
  assert.equal(canConnect(graph, prompt.id, node.id, { targetField: 'negative' }).ok, true);
  const second = createNode('prompt', 0, 500); graph.nodes.push(second);
  assert.match(canConnect(graph, second.id, node.id, { targetField: 'scene' }).reason, /已有连接/);
  const raw = JSON.parse(serializeGraph(graph));
  raw.edges.push({ id: 'other-edge', source: second.id, target: node.id, targetField: 'scene' });
  assert.throws(() => parseGraph(raw), /已有连接/);
  assert.throws(() => generationPayload(raw, node.id), /已有连接/);
});

test('package image ports use uploaded references and explicit edge images, never filenames derived from URLs', () => {
  const graph = packageCanvas(), reference = graph.nodes[1], node = graph.nodes[2];
  connect(graph, reference.id, node.id, { targetField: 'reference' });
  reference.data.name = ''; reference.data.url = '/api/media/looks-like-an-image.png';
  assert.throws(() => generationPayload(graph, node.id), /图片待准备/);
  for (const value of ['../secret.png', './secret.png', '/tmp/secret.png', 'https://example.test/image.png', 'C:\\secret.png', 'x\0.png', 'x'.repeat(1025)]) {
    reference.data.name = value;
    assert.throws(() => generationPayload(graph, node.id), /相对名称/);
  }
  graph.edges = [];
  const result = createNode('result', 0, 500, { jobId: 'old-job', outputs: [{ type: 'image', url: '/api/media/private', filename: 'old.png' }] });
  graph.nodes.push(result);
  connect(graph, result.id, node.id, { targetField: 'reference', outputIndex: 2 });
  const edge = graph.edges[0];
  assert.throws(() => generationPayload(graph, node.id), /等待上游/);
  assert.throws(() => generationPayload(graph, node.id, { edgeImages: { [result.id]: 'wrong-binding.png' } }), /等待上游/);
  assert.throws(() => generationPayload(graph, node.id, { edgeImages: { [edge.id]: '/api/media/private' } }), /相对名称/);
  assert.throws(() => generationPayload(graph, node.id, { edgeImages: Object.create({ [edge.id]: 'inherited.png' }) }), /等待上游/);
  assert.equal(generationPayload(graph, node.id, { edgeImages: { [edge.id]: 'uploads/current.png' } }).values.reference, 'uploads/current.png');
});

test('cached package fields never enter native generation or API request payloads', () => {
  const graph = createDemo(), node = graph.nodes[1];
  node.data.packageFields = ports();
  assert.equal(Object.hasOwn(generationPayload(graph, node.id), 'packageFields'), false);
  node.data.kind = 'api'; node.data.apiPrompt = { '1': { class_type: 'Test', inputs: { text: 'hello' } } };
  assert.deepEqual(generationPayload(graph, node.id), { kind: 'api', prompt: node.data.apiPrompt });
});
