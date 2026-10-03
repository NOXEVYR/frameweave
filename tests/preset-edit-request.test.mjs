import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPresetEditRequest, PRESET_EDIT_REQUEST_LIMIT } from '../web/preset-edit-request.mjs';
import { createNode } from '../web/graph.mjs';

const currentBackend = 'http://127.0.0.1:8188';
function fixture(kind = 'sdxl', own = {}) {
  const node = createNode('generation', 0, 0, { kind, ...own }); node.id = 'target';
  return { graph: { nodes: [node], edges: [] }, node };
}
function source(graph, type, id, data) { const node = createNode(type, 0, 0, data); node.id = id; graph.nodes.push(node); return node; }
function edge(graph, id, sourceId, targetField, extra = {}) { graph.edges.push({ id, source: sourceId, target: 'target', ...(targetField ? { targetField } : {}), ...extra }); }
const collect = (graph, options = {}) => collectPresetEditRequest(graph, 'target', { backend: currentBackend, canvasId: 'canvas', ...options });
const logical = (result, id) => result.logical_inputs.find(item => item.logical_id === id);

for (const kind of ['h3_t2v', 'h3_i2v', 'h3_ref', 'sdxl', 'sdxl_i2i', 'krea', 'qwen21_t2i', 'qwen21_edit']) {
  test(`${kind} blank own request remains editable without upload, execution or model selection`, () => {
    const { graph, node } = fixture(kind);
    const before = JSON.stringify(graph), result = collect(graph);
    assert.equal(result.preset_request.kind, kind);
    assert.equal(result.preset_request.positive, ''); assert.deepEqual(result.preset_request.models, {});
    assert.equal(JSON.stringify(graph), before); assert.notEqual(result.preset_request.models, node.data.models);
    const expected = ['h3_i2v', 'h3_ref', 'sdxl_i2i', 'qwen21_edit'].includes(kind) ? 1 : 0;
    assert.equal(result.reference_slots.length, expected);
    assert.deepEqual(result.model_intents, {});
  });
}

test('keeps all explicit own parameters, LoRA strengths and refine intent, strips editor/runtime state', () => {
  const { graph, node } = fixture('sdxl', {
    positive: 'OWN', negative: 'OWN NEG', models: { checkpoint: 'models/old.safetensors', sdxl_clip_l: 'clip_l.safetensors', sdxl_clip_g: '', vae: '' },
    loras: [{ name: 'missing.safetensors', strength_model: -2, strength_clip: .5 }, { name: '', strength_model: 0, strength_clip: 0 }],
    refine: { enabled: true, width: 1536, height: 1536, steps: 12, denoise: .25, upscale_method: '' },
    extension: { kept: true }, inputLabels: { positive: '故事描述' }, editor_id: 'e-0123456789abcdef01234567', outputs: [{ type: 'image', url: '/private' }],
  });
  const result = collect(graph);
  for (const key of ['positive', 'negative', 'models', 'loras', 'refine', 'extension']) assert.deepEqual(result.preset_request[key], node.data[key]);
  for (const key of ['title', 'outputs', 'editor_id', 'apiPrompt', 'packageValues', 'inputLabels']) assert.equal(Object.hasOwn(result.preset_request, key), false);
  assert.equal(logical(result, 'positive').label, '故事描述');
  assert.deepEqual(result.model_intents, {}, 'nonempty CLIP own selection is sufficient builder intent, empty keys invent no mode');
  result.preset_request.models.checkpoint = 'changed'; assert.equal(node.data.models.checkpoint, 'models/old.safetensors');
});

test('negative connected to an empty own prompt creates topology intent without writing C into own', () => {
  const { graph } = fixture('krea'); source(graph, 'prompt', 'p', { text: 'SOURCE', negative: 'BAD' });
  edge(graph, 'e', 'p', 'negative', { sourceField: 'text' });
  const result = collect(graph);
  assert.deepEqual(result.input_intents, { negative: true }); assert.equal(result.preset_request.negative, '');
  assert.equal(logical(result, 'negative').contributors[0].source_field, 'text');
  assert.equal(JSON.stringify(result).includes('SOURCE'), false); assert.equal(JSON.stringify(result).includes('BAD'), false);
});

test('legacy prompt has both contributions and explicit/legacy order matches existing builtin semantics', () => {
  const { graph } = fixture('sdxl', { positive: 'OWN', negative: 'OWN NEG' });
  source(graph, 'prompt', 'explicit', { text: 'EXPLICIT', negative: '' });
  source(graph, 'prompt', 'legacy', { text: 'LEGACY', negative: 'LEGACY NEG' });
  edge(graph, 'explicit-edge', 'explicit', 'positive'); edge(graph, 'legacy-edge', 'legacy', null, { sourceField: 'negative' });
  const result = collect(graph);
  assert.deepEqual(result.input_intents, { positive: true, negative: true });
  assert.deepEqual(logical(result, 'positive').contributors.map(c => [c.edge_id, c.source_field, c.order, c.aggregation_order]), [['legacy-edge', 'text', 1, 0], ['explicit-edge', 'text', 0, 1]]);
  assert.equal(logical(result, 'negative').contributors[0].source_field, 'negative');
  assert.equal(logical(result, 'positive').separator, '\n\n'); assert.equal(logical(result, 'negative').separator, ', ');
  assert.equal(result.requires_aggregation, true); assert.equal(result.preset_request.positive, 'OWN');
  assert.equal(Object.hasOwn(result, 'migration'), false, 'collector records need; host owns migration policy');
});

test('empty legacy negative still declares input intent; future source edits cannot silently lose it', () => {
  const { graph } = fixture(); source(graph, 'prompt', 'p', { text: '', negative: '' }); edge(graph, 'e', 'p');
  const result = collect(graph);
  assert.deepEqual(result.input_intents, { positive: true, negative: true }); assert.equal(result.requires_aggregation, false);
});

test('own plus a connected source records aggregation even if current source text is empty', () => {
  const { graph } = fixture('sdxl', { positive: 'OWN' }); source(graph, 'prompt', 'p', { text: '' }); edge(graph, 'e', 'p', 'positive');
  assert.equal(collect(graph).requires_aggregation, true);
});

test('aggregate text bound is diagnosed without merging connected text into preserved own request', () => {
  const { graph } = fixture('sdxl', { positive: 'O'.repeat(60000) }); source(graph, 'prompt', 'p', { text: 'C'.repeat(60000) }); edge(graph, 'e', 'p', 'positive');
  const result = collect(graph);
  assert.equal(result.pending[0].reason, 'aggregate_text_limit');
  assert.equal(result.preset_request.positive.length, 60000);
  assert.equal(logical(result, 'positive').contributors[0].source_length, 60000);
  assert.equal(JSON.stringify(result).includes('CCC'), false);
});

test('H3 end-only intent stays end index one and does not instantiate start', () => {
  const { graph } = fixture('h3_i2v'); source(graph, 'reference', 'r', { name: '', localAssetId: 'a'.repeat(64), mediaType: 'image', role: 'end' }); edge(graph, 'e', 'r');
  const result = collect(graph);
  assert.deepEqual(result.reference_slots, [{ port_id: 'end_image', index: 1, ordinal: 2, role: 'end' }]);
  assert.equal(result.pending[0].reason, 'local_media_not_uploaded');
  assert.deepEqual(result.pending[0], { logical_id: 'end_image', port_id: 'end_image', reason: 'local_media_not_uploaded', edge_id: 'e', source_id: 'r', origin: 'connected' });
  assert.equal(Object.hasOwn(result.preset_request, 'references'), false);
});

for (const [kind, slot, ids] of [['qwen21_edit', 'image_3', ['image_1', 'image_2', 'image_3']], ['krea', 'image_3', ['image_1', 'image_2', 'image_3']], ['h3_ref', 'ref_image_2', ['ref_image_0', 'ref_image_1', 'ref_image_2']]]) {
  test(`${kind} later connected reference preserves preceding holes`, () => {
    const { graph } = fixture(kind); source(graph, 'reference', 'r', { name: 'ready.png', uploadBackend: currentBackend }); edge(graph, 'e', 'r', slot);
    const result = collect(graph);
    assert.deepEqual(result.reference_slots.map(item => item.port_id), ids);
    assert.deepEqual(result.reference_slots.map(item => item.index), [0, 1, 2]);
    assert.deepEqual(result.pending.map(item => item.port_id), ids.slice(0, 2));
    assert.equal(JSON.stringify(result).includes('ready.png'), false, 'C media name never enters own data or slot intent');
  });
}

test('optional reference modes remain T2I until own or connected image intent exists', () => {
  for (const kind of ['sdxl', 'krea']) {
    const { graph } = fixture(kind); assert.deepEqual(collect(graph).reference_slots, []);
    source(graph, 'reference', 'r', { name: '' }); edge(graph, 'e', 'r', 'image_1');
    assert.equal(collect(graph).reference_slots.length, 1);
  }
});

test('own string references remain authority, empty names and end role retain own indexes', () => {
  const { graph } = fixture('h3_i2v', { references: ['', 'old.png'], reference_roles: ['start', 'end'], packageMediaBackends: { end_image: { name: 'old.png', backend: currentBackend } } });
  const result = collect(graph);
  assert.deepEqual(result.preset_request.references, ['', 'old.png']);
  assert.deepEqual(result.reference_slots.map(item => item.role), ['start', 'end']);
  assert.equal(logical(result, 'end_image').own_index, 1);
  assert.deepEqual(result.pending.map(item => [item.port_id, item.reason, item.origin]), [['start_image', 'media_missing', 'own']]);
  const ownEnd = fixture('h3_i2v', { references: ['old.png'], reference_roles: ['last_frame'] });
  assert.deepEqual(collect(ownEnd.graph).reference_slots, [{ port_id: 'end_image', index: 1, ordinal: 2, role: 'end' }]);
  assert.equal(logical(collect(ownEnd.graph), 'end_image').own_index, 0);
});

test('own Qwen holes preserve array and backend ownership pending, never renumber', () => {
  const { graph } = fixture('qwen21_edit', { references: ['', '', 'own.png'], custom_size: false, ref_resolution: 0 });
  const result = collect(graph);
  assert.deepEqual(result.preset_request.references, ['', '', 'own.png']);
  assert.equal(logical(result, 'image_3').own_index, 2);
  assert.equal(result.pending.find(item => item.port_id === 'image_3').reason, 'owner_unknown');
  assert.equal(result.preset_request.custom_size, false); assert.equal(result.preset_request.ref_resolution, 0);
});

test('custom own reference labels stay in request while physical topology slots retain standard roles', () => {
  for (const kind of ['h3_ref', 'krea', 'sdxl', 'sdxl_i2i']) {
    const { graph } = fixture(kind, { references: ['scene.png'], reference_roles: ['场景参考'] });
    const result = collect(graph);
    assert.deepEqual(result.preset_request.reference_roles, ['场景参考']);
    assert.equal(result.reference_slots[0].role, 'reference');
    assert.equal(logical(result, result.reference_slots[0].port_id).own_role, '场景参考');
  }
  assert.throws(() => collect(fixture('qwen21_edit', { references: ['scene.png'], reference_roles: ['场景参考'] }).graph), /Qwen/);
  assert.throws(() => collect(fixture('sdxl', { models: { unknown: 'model' } }).graph), /模型角色/);
});

test('stale existing media is not evidence while replacement is pending or failed', () => {
  const { graph } = fixture('sdxl_i2i'); source(graph, 'reference', 'r', { name: 'old.png', uploadBackend: currentBackend }); edge(graph, 'e', 'r', 'image_1');
  for (const [transaction, reason] of [[{ ticket: {} }, 'import_pending'], [{ error: 'failed' }, 'import_failed']]) {
    const result = collect(graph, { referenceImports: new Map([['r', transaction]]) });
    assert.equal(result.pending[0].reason, reason); assert.equal(result.pending[0].origin, 'transaction');
    assert.equal(result.reference_slots.length, 1);
  }
  const result = collect(graph, { mediaTransfers: { state: (owner, field) => owner === 'canvas:target' && field === 'image_1' ? { status: 'failed' } : null } });
  assert.equal(result.pending[0].reason, 'import_failed');
});

test('media backend must be proved; localhost normalization matches existing protocol', () => {
  const { graph } = fixture('sdxl_i2i'); const ref = source(graph, 'reference', 'r', { name: 'x.png', uploadBackend: 'http://localhost:8188/' }); edge(graph, 'e', 'r');
  assert.deepEqual(collect(graph).pending, []);
  ref.data.uploadBackend = 'http://127.0.0.1:8189'; assert.equal(collect(graph).pending[0].reason, 'backend_mismatch');
  ref.data.uploadBackend = ''; assert.equal(collect(graph).pending[0].reason, 'owner_unknown');
});

test('direct upstream image has pending execution but collector never consults unrelated/deeper data', () => {
  const { graph } = fixture('qwen21_edit'); source(graph, 'generation', 'up', { kind: 'sdxl' }); edge(graph, 'e', 'up', 'image_1');
  const unrelated = { id: 'other', type: 'generation', get data() { throw new Error('unrelated data read'); } }; graph.nodes.push(unrelated);
  graph.edges.push({ id: 'deep', source: 'other', target: 'up' });
  assert.equal(collect(graph).pending[0].reason, 'upstream_not_run');
});

test('large upstream API source does not consume own request budget or read execution/history data', () => {
  const { graph } = fixture('qwen21_edit'); const up = source(graph, 'generation', 'up', { kind: 'package', editor_output_fields: [{ id: 'sink', mediaType: 'image' }] });
  Object.defineProperty(up.data, 'apiPrompt', { get() { throw new Error('API graph read'); } });
  Object.defineProperty(up.data, 'history', { get() { throw new Error('history read'); } });
  edge(graph, 'e', 'up', 'image_1');
  assert.equal(collect(graph).pending[0].reason, 'upstream_not_run');
});

test('unknown result output remains unproven and typed video refuses image input', () => {
  const { graph } = fixture('qwen21_edit'); const ref = source(graph, 'result', 'r', { outputs: [] }); edge(graph, 'e', 'r', 'image_1');
  assert.equal(collect(graph).pending[0].reason, 'media_type_unproven');
  ref.data.outputs = [{ type: 'video', url: '/api/media/result' }]; assert.throws(() => collect(graph), /不是图片/);
});

test('invalid source, cross-type target, duplicate explicit prompts and reference slots are refused without mutation', () => {
  const cases = [
    graph => edge(graph, 'e', 'missing', 'positive'),
    graph => { source(graph, 'prompt', 'p', { text: 'x' }); edge(graph, 'e', 'p', 'image_1'); },
    graph => { source(graph, 'prompt', 'p', { text: 'x' }); edge(graph, 'e', 'p', 'positive'); edge(graph, 'e2', 'p', 'positive'); },
    graph => { source(graph, 'reference', 'r', { name: '' }); edge(graph, 'e', 'r', 'image_1'); edge(graph, 'e2', 'r', 'image_1'); },
    graph => { source(graph, 'reference', 'r', { name: '', mediaType: 'video' }); edge(graph, 'e', 'r', 'image_1'); },
    graph => { source(graph, 'reference', 'r', { name: '' }); edge(graph, 'e', 'r', 'image_9'); },
    graph => { source(graph, 'reference', 'r', { name: '' }); edge(graph, 'e', 'r', 'image_1', { outputIndex: -1 }); },
    graph => { source(graph, 'reference', 'r', { name: '' }); edge(graph, 'e', 'r', 'image_1'); edge(graph, 'e', 'r', 'image_1'); },
  ];
  for (const arrange of cases) { const { graph } = fixture(); arrange(graph); const before = JSON.stringify(graph); assert.throws(() => collect(graph)); assert.equal(JSON.stringify(graph), before); }
});

test('rejects own object media, repeated H3 roles, wrong role/count and unsupported T2I references', () => {
  for (const [kind, own] of [['sdxl', { references: [{ name: 'studio.png', backend: currentBackend }] }], ['h3_i2v', { references: ['a', 'b'], reference_roles: ['start', 'first'] }], ['h3_i2v', { references: ['a'], reference_roles: [] }], ['qwen21_edit', { references: ['a'], reference_roles: ['end'] }], ['krea', { references: ['a', 'b', 'c', 'd'] }], ['h3_t2v', { references: ['a'] }], ['qwen21_t2i', { references: ['a'] }]]) {
    assert.throws(() => collect(fixture(kind, own).graph));
  }
});

test('rejects unsafe numbers, paths and invalid finite settings instead of defaulting or rounding', () => {
  for (const own of [{ seed: Number.MAX_SAFE_INTEGER + 1 }, { width: 33 }, { steps: 0 }, { cfg: NaN }, { denoise: 2 }, { width: '1024' }, { models: { checkpoint: '../bad' } }, { references: ['/bad'] }, { loras: [{ name: 'lora', strength_model: 11 }] }, { refine: { enabled: true, width: 33 } }]) {
    assert.throws(() => collect(fixture('sdxl', own).graph));
  }
  assert.throws(() => collect(fixture('h3_t2v', { fps: 30 }).graph), /24 fps/);
  assert.throws(() => collect(fixture('qwen21_edit', { denoise: .5 }).graph), /denoise/);
  assert.throws(() => collect(fixture('sdxl', { inputLabels: { image_1: { bad: true } } }).graph), /端口名称/);
  assert.equal(collect(fixture('h3_t2v', { seconds: 150 }).graph).preset_request.seconds, 150);
});

test('JSON boundary rejects accessors, cyclic data, unsafe prototypes and literal holes', () => {
  const { graph, node } = fixture();
  Object.defineProperty(node.data, 'extension', { enumerable: true, configurable: true, get() { throw new Error('getter executed'); } });
  assert.throws(() => collect(graph), /安全 JSON 字段/); delete node.data.extension;
  for (const extension of [new Date(), [, 1], { fn() {} }, JSON.parse('{"__proto__":{}}')]) {
    const f = fixture(); f.node.data.extension = extension; assert.throws(() => collect(f.graph), /JSON/);
  }
  const cycle = fixture(); cycle.node.data.extension = cycle.node.data; assert.throws(() => collect(cycle.graph), /过大|过深/);
});

test('2MiB request boundary counts UTF8 and the complete logical envelope', () => {
  const large = fixture(); large.node.data.extension = '汉'.repeat(Math.floor(PRESET_EDIT_REQUEST_LIMIT / 3));
  assert.throws(() => collect(large.graph), /2 MiB/);
  const small = fixture(); small.node.data.extension = '';
  const overhead = new TextEncoder().encode(JSON.stringify(small.node.data)).length;
  small.node.data.extension = 'x'.repeat(PRESET_EDIT_REQUEST_LIMIT - overhead - 1);
  assert.throws(() => collect(small.graph), /2 MiB/, 'request alone fits; returned logical information must fit too');
});

test('only eight builtin presets are accepted; canvas IDs and duplicated source IDs cannot fake targets', () => {
  for (const kind of ['api', 'package']) assert.throws(() => collect(fixture(kind).graph), /内置预设/);
  const { graph } = fixture(); graph.nodes.push(graph.nodes[0]); assert.throws(() => collect(graph), /内置预设/);
  const direct = fixture(); const p = source(direct.graph, 'prompt', 'p', { text: '' }); direct.graph.nodes.push({ ...p }); edge(direct.graph, 'e', 'p'); assert.throws(() => collect(direct.graph), /ID 重复/);
});
