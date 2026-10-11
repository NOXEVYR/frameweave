import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePresetEditGraph } from '../web/preset-edit-graph.mjs';
import { collectPresetEditRequest } from '../web/preset-edit-request.mjs';
import { createNode, generationPayload, parseGraph, serializeGraph } from '../web/graph.mjs';

const backend = 'http://127.0.0.1:8188';
function node(graph, type, id, data = {}) {
  const result = createNode(type, 0, 0, data); result.id = id; graph.nodes.push(result); return result;
}
function edge(graph, id, source, targetField, extra = {}) {
  graph.edges.push({ id, source, target: 'target', ...(targetField ? { targetField } : {}), ...extra });
}
function fixture(kind = 'sdxl', data = {}) {
  const graph = { nodes: [], edges: [], extension: { keep: '原始元数据' } };
  const target = node(graph, 'generation', 'target', { kind, positive: 'OWN', negative: 'OWN NEG', ...data });
  const prepared = { backend_url: backend, receipt_complete: true, source_document: { prompt: {} }, fields: [], receipt: [], outputs: [], pending: [] };
  function field(logical, id, value, type = 'text', extra = {}) {
    const node_id = String(prepared.fields.length + 1), input = 'value';
    const current = { id, node_id, input, type, label: logical, default: 'NOT N', ...extra };
    prepared.fields.push(current); prepared.source_document.prompt[node_id] = { class_type: 'Fixture', inputs: { [input]: value }, _meta: { keep: 'N' } };
    const row = prepared.receipt.find(item => item.logical_id === logical);
    const binding = { node_id, input, type };
    if (row) row.targets.push(binding); else prepared.receipt.push({ logical_id: logical, type, targets: [binding] });
    return current;
  }
  field('positive', 'actual-positive', data.positive ?? 'OWN'); field('negative', 'actual-negative', data.negative ?? 'OWN NEG');
  field('seed', 'actual-seed', 42, 'integer');
  prepared.source_document.prompt.sink = { class_type: kind.startsWith('h3_') ? 'SaveVideo' : 'SaveImage', inputs: {}, _meta: { title: '完整输出' } };
  prepared.outputs.push({ id: 'sink', mediaType: kind.startsWith('h3_') ? 'video' : 'image', label: '输出' });
  prepared.source_request = collectPresetEditRequest(graph, 'target', { backend }).preset_request;
  return { graph, target, prepared, field };
}
const collect = graph => collectPresetEditRequest(graph, 'target', { backend });
const prepare = (f, request = collect(f.graph)) => preparePresetEditGraph(f.graph, 'target', f.prepared, request);

test('isolated shadow preserves full N and unrelated metadata; target aliases the owned graph node', () => {
  const f = fixture(); f.prepared.prompt = { overwritten: 'C IS NOT N' };
  node(f.graph, 'prompt', 'unrelated', { text: 'unchanged', extension: { extra: 7 } });
  const before = JSON.stringify(f), result = prepare(f);
  assert.equal(JSON.stringify(f), before); assert.equal(result.target, result.graph.nodes.find(item => item.id === 'target'));
  assert.deepEqual(result.source_document, f.prepared.source_document); assert.deepEqual(result.graph.extension, f.graph.extension);
  assert.deepEqual(result.graph.nodes[1], f.graph.nodes[1]); assert.equal(result.target.data.packageValues['actual-positive'], 'OWN');
  result.target.data.editor_id = 'e-0123456789abcdef01234567'; assert.equal(result.graph.nodes[0].data.editor_id, result.target.data.editor_id);
  assert.equal(f.target.data.editor_id, undefined); assert.equal(result.target.data.package_id, '');
});

test('legacy positive/negative plus explicit text keep order, own-last semantics and stable positive edge ID', () => {
  const f = fixture(); node(f.graph, 'prompt', 'explicit', { text: 'EXPLICIT' }); node(f.graph, 'prompt', 'legacy', { text: 'LEGACY', negative: 'LEGACY NEG' });
  edge(f.graph, 'explicit-edge', 'explicit', 'positive'); edge(f.graph, 'legacy-edge', 'legacy', null, { sourceField: 'negative' });
  const old = generationPayload(f.graph, 'target'), result = prepare(f); result.target.data.package_id = 'fixture';
  const next = generationPayload(result.graph, 'target');
  assert.equal(next.values['actual-positive'], old.positive); assert.equal(next.values['actual-negative'], old.negative);
  assert.equal(result.graph.edges.find(item => item.id === 'legacy-edge').sourceField, 'text');
  const negative = result.graph.edges.find(item => item.targetField === 'actual-negative');
  assert.notEqual(negative.id, 'legacy-edge'); assert.equal(negative.sourceField, 'negative');
  assert.deepEqual(result.target.data.packageTextCompositions, { 'actual-positive': 'paragraphs', 'actual-negative': 'comma' });
});

test('legacy and explicit duplicate negative contribution migrates losslessly without deduplication or mutation', () => {
  const f = fixture(); node(f.graph, 'prompt', 'p', { text: 'SOURCE', negative: 'NEG A' });
  edge(f.graph, 'legacy', 'p'); edge(f.graph, 'explicit-negative', 'p', 'negative', { sourceField: 'negative' });
  assert.equal(generationPayload(f.graph, 'target').negative, 'NEG A, NEG A, OWN NEG');
  const before = JSON.stringify(f);
  const result = prepare(f); result.target.data.package_id = 'fixture';
  assert.equal(generationPayload(result.graph, 'target').values['actual-negative'], 'NEG A, NEG A, OWN NEG');
  const negative = result.graph.edges.filter(item => item.targetField === 'actual-negative');
  assert.equal(negative[0].sourceOccurrence, undefined); assert.equal(negative[1].sourceOccurrence, 1);
  assert.equal(JSON.stringify(f), before); assert.equal(f.graph.edges.length, 2);
  assert.equal(generationPayload(f.graph, 'target').negative, 'NEG A, NEG A, OWN NEG');
});

test('text fanout maps each actual candidate independently without C in stored own values', () => {
  const f = fixture(); f.field('positive', 'second-positive', 'OWN'); node(f.graph, 'prompt', 'p', { text: 'CONNECTED', negative: '' }); edge(f.graph, 'original', 'p');
  const result = prepare(f); result.target.data.package_id = 'fixture'; const payload = generationPayload(result.graph, 'target');
  assert.equal(payload.values['actual-positive'], 'CONNECTED\n\nOWN'); assert.equal(payload.values['second-positive'], payload.values['actual-positive']);
  assert.equal(result.target.data.packageValues['second-positive'], 'OWN');
  assert.equal(new Set(result.graph.edges.map(item => item.id)).size, 3);
  assert.deepEqual(prepare(f).edge_migrations, result.edge_migrations); assert(result.graph.edges.every(item => item.id.length <= 120));
});

test('fresh user-confirmed field additions read actual converted N, never candidate defaults', () => {
  const f = fixture(); const addition = { id: 'added', node_id: 'extra', input: 'strength', type: 'number', label: '新增', default: .8 };
  f.prepared.fields.push(addition); f.prepared.source_document.prompt.extra = { class_type: 'NewNode', inputs: { strength: 0 }, _meta: { preserve: true } };
  assert.equal(prepare(f).target.data.packageValues.added, 0);
});

test('scalar fanout keeps original per-target N rather than copying a logical/default/C value', () => {
  const f = fixture(); f.field('seed', 'seed-secondary', 87, 'integer');
  const result = prepare(f); assert.equal(result.target.data.packageValues['actual-seed'], 42); assert.equal(result.target.data.packageValues['seed-secondary'], 87);
});

test('stale and empty model selections remain editable own literals', () => {
  const f = fixture(); f.field('models.dit', 'model', 'not-installed.safetensors', 'select', { options: ['new.safetensors'] });
  f.field('models.vae', 'vae', '', 'select', { options: [] });
  const result = prepare(f); assert.equal(result.target.data.packageValues.model, 'not-installed.safetensors'); assert.equal(result.target.data.packageValues.vae, '');
});

test('Qwen third image preserves earlier holes, distinct slots, labels and local pending', () => {
  const f = fixture('qwen21_edit', { inputLabels: { image_3: '人物参考' } });
  for (let i = 1; i <= 3; i++) f.field(`image_${i}`, `actual-image-${i}`, '', 'image');
  node(f.graph, 'reference', 'r', { name: '', localAssetId: 'a'.repeat(64), mediaType: 'image' }); edge(f.graph, 'ref-edge', 'r', 'image_3');
  const result = prepare(f);
  assert.equal(result.graph.edges[0].targetField, 'actual-image-3'); assert.equal(result.target.data.packageValues['actual-image-1'], '');
  assert.equal(result.target.data.inputLabels['actual-image-3'], '人物参考');
  assert(result.pending.some(item => item.field_id === 'actual-image-3' && item.reason === 'local_media_not_uploaded'));
  assert(result.pending.some(item => item.field_id === 'actual-image-1' && item.reason === 'media_missing'));
});

test('H3 end-only slot is not compressed into start and known N media ownership remaps', () => {
  const f = fixture('h3_i2v', { references: ['own.png'], reference_roles: ['end'], packageMediaBackends: { end_image: { name: 'own.png', backend } } });
  f.field('end_image', 'actual-end', 'own.png', 'image');
  const result = prepare(f); assert.deepEqual(result.logical_rebindings.end_image, ['actual-end']);
  assert.equal(result.logical_rebindings.start_image, undefined); assert.deepEqual(result.target.data.packageMediaBackends['actual-end'], { name: 'own.png', backend });
});

test('failed replacement keeps pending and never copies connected old filename into N', () => {
  const f = fixture('sdxl_i2i'); f.field('image_1', 'actual-image', '', 'image');
  node(f.graph, 'reference', 'r', { name: 'old.png', uploadBackend: backend }); edge(f.graph, 'ref-edge', 'r', 'image_1');
  const request = collectPresetEditRequest(f.graph, 'target', { backend, referenceImports: new Map([['r', { error: 'failed' }]]) });
  const result = prepare(f, request); assert.equal(result.target.data.packageValues['actual-image'], '');
  assert(result.pending.some(item => item.field_id === 'actual-image' && item.reason === 'import_failed'));
});

test('legacy preset LoRA stack is removed only from shadow; full N keeps real LoRA literals', () => {
  const f = fixture('sdxl', { loras: [{ name: 'local.safetensors', strength_model: .7, strength_clip: .4 }] });
  f.field('loras.0.strength_clip', 'real-clip-strength', .4, 'number');
  const result = prepare(f); assert.equal(result.target.data.loras, undefined); assert.equal(f.target.data.loras[0].strength_clip, .4);
  assert.equal(result.target.data.packageValues['real-clip-strength'], .4); assert.deepEqual(result.source_document, f.prepared.source_document);
});

for (const [name, mutate, pattern] of [
  ['legacy negative missing', f => { node(f.graph, 'prompt', 'p', { text: '', negative: '' }); edge(f.graph, 'e', 'p'); f.prepared.receipt.splice(1, 1); }, /negative/],
  ['media missing receipt', f => { node(f.graph, 'reference', 'r', { name: '' }); edge(f.graph, 'e', 'r', 'image_1'); }, /image_1/],
  ['ambiguous real candidate', f => { f.prepared.fields.push({ ...f.prepared.fields[0], id: 'duplicate' }); }, /绑定|候选/],
  ['class changed', f => { f.prepared.fields[0].class_type = 'Other'; }, /节点类型/],
  ['literal missing', f => { delete f.prepared.source_document.prompt['1'].inputs.value; }, /原始节点输入/],
  ['wrong literal type', f => { f.prepared.source_document.prompt['3'].inputs.value = '42'; }, /原始值类型/],
  ['unsafe media path', f => { f.field('image_1', 'media', '../private.png', 'image'); }, /相对名称/],
  ['unsafe integer', f => { f.prepared.source_document.prompt['3'].inputs.value = Number.MAX_SAFE_INTEGER + 1; }, /安全 JSON/],
  ['API node budget', f => { for (let i = 0; i < 1000; i++) f.prepared.source_document.prompt[`extra${i}`] = { class_type: 'Unknown', inputs: {} }; }, /原始 API 图/],
]) test(`${name} rejects without changing live/source data`, () => {
  const f = fixture(); mutate(f); const before = JSON.stringify(f); assert.throws(() => prepare(f), pattern); assert.equal(JSON.stringify(f), before);
});

test('altered collection order and source identity are rejected', () => {
  const f = fixture(); node(f.graph, 'prompt', 'p', { text: 'C' }); edge(f.graph, 'e', 'p');
  for (const key of ['aggregation_order', 'source_id']) {
    const request = collect(f.graph); request.logical_inputs[0].contributors[0][key] = key === 'source_id' ? 'other' : 99;
    assert.throws(() => prepare(f, request), /采集来源/);
  }
});

function downstream(f, viaResult = false) {
  node(f.graph, 'generation', 'down', { kind: 'qwen21_edit' });
  if (viaResult) { node(f.graph, 'result', 'preview'); f.graph.edges.push({ id: 'preview-edge', source: 'target', target: 'preview' }); }
  f.graph.edges.push({ id: 'outgoing', source: viaResult ? 'preview' : 'target', target: 'down', targetField: 'image_1' });
}
for (const viaResult of [false, true]) test(`unique image sink maps ${viaResult ? 'result-mediated' : 'direct'} legacy outgoing connection`, () => {
  const f = fixture(); downstream(f, viaResult); const result = prepare(f);
  assert.deepEqual(result.output_rebindings, { 'legacy-outgoing': 'sink' }); parseGraph(serializeGraph(result.graph));
});
test('preview with no generation consumer needs no forced output branch', () => {
  const f = fixture(); node(f.graph, 'result', 'preview'); f.graph.edges.push({ id: 'preview-edge', source: 'target', target: 'preview' });
  f.prepared.outputs.push({ id: 'second-sink', mediaType: 'image' }); f.prepared.source_document.prompt['second-sink'] = { class_type: 'SaveImage', inputs: {} };
  assert.deepEqual(prepare(f).output_rebindings, {});
});
test('explicit old sink ID stays exact rather than choosing another same-type sink', () => {
  const f = fixture(); downstream(f); f.graph.edges.at(-1).sourceOutput = 'sink';
  f.prepared.outputs.push({ id: 'other', mediaType: 'image' }); f.prepared.source_document.prompt.other = { class_type: 'SaveImage', inputs: {} };
  assert.deepEqual(prepare(f).output_rebindings, { sink: 'sink' });
});
for (const variant of ['missing', 'multiple', 'wrong-type']) test(`unproven ${variant} outgoing sink blocks before package persistence`, () => {
  const f = fixture(); downstream(f);
  if (variant === 'missing') f.prepared.outputs = [];
  if (variant === 'multiple') { f.prepared.outputs.push({ id: 'other', mediaType: 'image' }); f.prepared.source_document.prompt.other = { class_type: 'SaveImage', inputs: {} }; }
  if (variant === 'wrong-type') f.prepared.outputs[0].mediaType = 'video';
  const before = JSON.stringify(f); assert.throws(() => prepare(f), /手动选择|无法证明|不匹配/); assert.equal(JSON.stringify(f), before);
});

test('fanout expansion is bounded at 2000 edges before proposal can escape', () => {
  const f = fixture(); for (let i = 0; i < 700; i++) f.field('positive', `positive-${i}`, 'OWN');
  for (let i = 0; i < 3; i++) { node(f.graph, 'prompt', `p${i}`, { text: 'C' }); edge(f.graph, `e${i}`, `p${i}`); }
  assert.throws(() => prepare(f), /2000/);
});

test('unique video sink maps H3 output to a proved video input', () => {
  const f = fixture('h3_t2v');
  node(f.graph, 'generation', 'down', { kind: 'package', packageFields: [{ id: 'video', label: '视频参考', type: 'video' }], packageValues: { video: '' } });
  f.graph.edges.push({ id: 'video-out', source: 'target', target: 'down', targetField: 'video' });
  assert.deepEqual(prepare(f).output_rebindings, { 'legacy-video-out': 'sink' });
});

test('derived edge ID collision preserves unrelated edges and uses deterministic unique suffix', () => {
  const f = fixture(); node(f.graph, 'prompt', 'p', { text: 'SOURCE', negative: 'BAD' }); edge(f.graph, 'legacy', 'p');
  const first = prepare(f), reserved = first.graph.edges.find(item => item.sourceField === 'negative').id;
  node(f.graph, 'generation', 'unrelated', { kind: 'sdxl' });
  f.graph.edges.push({ id: reserved, source: 'p', target: 'unrelated', targetField: 'positive' });
  const result = prepare(f), negative = result.graph.edges.find(item => item.target === 'target' && item.sourceField === 'negative');
  assert.equal(negative.id, `${reserved}-1`); assert(result.graph.edges.some(item => item.id === reserved && item.target === 'unrelated'));
  assert.equal(new Set(result.graph.edges.map(item => item.id)).size, result.graph.edges.length);
});

for (const role of ['model', 'encoder', 'lora']) test(`fresh ${role} selection rejects absolute path without touching ordinary text`, () => {
  const f = fixture(); f.prepared.source_document.prompt['1'].inputs.value = 'F:\\reference is text';
  f.field('custom', 'dangerous', 'F:\\models\\private.safetensors', 'select', { role });
  assert.throws(() => prepare(f), /相对名称/);
});

test('receipt model role rejects unsafe path even without a fresh schema role', () => {
  const f = fixture(); f.field('models.dit', 'dangerous', '../model.safetensors', 'select');
  assert.throws(() => prepare(f), /相对名称/);
});

test('prepared getter is rejected without executing its source-document accessor', () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.prepared, 'source_document', { enumerable: true, get() { reads++; return {}; } });
  assert.throws(() => prepare(f), /安全 JSON/); assert.equal(reads, 0);
});

test('API source byte budget is measured as UTF8 and refuses an oversized full N', () => {
  const f = fixture(); f.prepared.source_document.prompt.sink._meta.large = '中文'.repeat(360000);
  assert.throws(() => prepare(f), /完整数据预算/);
});

test('prepared full N must be tied to the exact original own request', () => {
  const f = fixture(); f.prepared.source_request.positive = 'different own';
  const before = JSON.stringify(f); assert.throws(() => prepare(f), /原始请求/); assert.equal(JSON.stringify(f), before);
  delete f.prepared.source_request; assert.throws(() => prepare(f), /原始请求/);
});

for (const key of ['reference_slots', 'input_intents', 'model_intents']) test(`prepared ${key} cannot describe a different topology intent`, () => {
  const f = fixture(), collected = collect(f.graph);
  f.prepared.intents = Object.fromEntries(['reference_slots', 'input_intents', 'model_intents'].map(name => [name, collected[name]]));
  assert.doesNotThrow(() => prepare(f)); f.prepared.intents[key] = key === 'reference_slots' ? [{ port_id: 'image_1', index: 0, ordinal: 1, role: 'reference' }] : { unexpected: true };
  assert.throws(() => prepare(f), /准备意图/);
});

test('4096 actual fields preserve every N literal within the API node budget; 4097 refuses', () => {
  const f = fixture(); const prompt = f.prepared.source_document.prompt;
  prompt.bulk = { class_type: 'Controls', inputs: {} };
  const receipt = f.prepared.receipt.find(row => row.logical_id === 'seed');
  for (let i = 0; i < 4093; i++) {
    const input = `scalar_${i}`; prompt.bulk.inputs[input] = i;
    f.prepared.fields.push({ id: `real_${i}`, node_id: 'bulk', input, type: 'integer', label: input });
    receipt.targets.push({ node_id: 'bulk', input, type: 'integer' });
  }
  const result = prepare(f); assert.equal(result.fields.length, 4096); assert.equal(result.target.data.packageValues.real_4092, 4092);
  f.prepared.fields.push({ id: 'extra', node_id: 'bulk', input: 'extra', type: 'integer', label: 'extra' }); prompt.bulk.inputs.extra = 1;
  assert.throws(() => prepare(f), /候选|4096|预算/);
});
