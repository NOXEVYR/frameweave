import test from 'node:test';
import assert from 'node:assert/strict';
import { hostHarness, makeNode, BACKEND, OTHER } from './helpers/editor-host-harness.mjs';
import { generationPayload } from '../web/graph.mjs';

const clone = structuredClone;
const EDITOR_ID = `e-${'c'.repeat(24)}`;
function fixture({ kind = 'sdxl', own = {}, legacy = false, media = false, bind = false } = {}) {
  const h = hostHarness({ kind, fields: [], values: {} });
  Object.assign(h.node.data, { positive: 'OWN POS', negative: 'OWN NEG', inputLabels: { positive: '镜头描述', negative: '排除内容' }, ...own });
  const a = makeNode('source-a', 'prompt', { text: 'CONNECTED A', negative: 'NEGATIVE A' });
  const b = makeNode('source-b', 'prompt', { text: 'CONNECTED B', negative: 'NEGATIVE B' });
  h.sandbox.graph.nodes.push(a, b);
  h.sandbox.graph.edges.push({ id: 'edge-a', source: a.id, target: h.node.id, ...(legacy ? {} : { targetField: 'positive', sourceField: 'text' }) });
  if (legacy) h.sandbox.graph.edges.push({ id: 'edge-b', source: b.id, target: h.node.id });
  else h.sandbox.graph.edges.push({ id: 'edge-b', source: b.id, target: h.node.id, targetField: 'negative', sourceField: 'negative' });
  if (media) {
    const reference = makeNode('reference', 'reference', { name: '', localAssetId: 'a'.repeat(64), mediaType: 'image', role: 'reference' });
    h.sandbox.graph.nodes.push(reference); h.reference = reference;
    h.sandbox.graph.edges.push({ id: 'media-edge', source: reference.id, target: h.node.id, targetField: 'image_3', sourceField: 'image' });
    h.node.data.inputLabels.image_3 = '人物参考';
  }
  const state = h.state;
  const scalar = (id, node_id, input, type, label) => ({ id, node_id, input, type, label: label || id });
  function prepared(payload) {
    const own = payload.preset_request;
    const prompt = {
      '1': { class_type: 'CLIPTextEncode', inputs: { text: own.positive || '' }, _meta: { title: 'Own positive' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: own.negative || '' } },
      '3': { class_type: 'KSampler', inputs: { seed: own.seed, steps: own.steps } },
      '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] }, extension: { preserved: true } },
    };
    const fields = [scalar('positive-field', '1', 'text', 'text', 'Positive'), scalar('negative-field', '2', 'text', 'text', 'Negative'),
      scalar('seed-field', '3', 'seed', 'integer'), scalar('steps-field', '3', 'steps', 'integer')];
    const receipt = [
      { logical_id: 'positive', type: 'text', targets: [{ node_id: '1', input: 'text', type: 'text', field_id: 'positive-field' }] },
      { logical_id: 'negative', type: 'text', targets: [{ node_id: '2', input: 'text', type: 'text', field_id: 'negative-field' }] },
      { logical_id: 'seed', type: 'integer', targets: [{ node_id: '3', input: 'seed', type: 'integer', field_id: 'seed-field' }] },
      { logical_id: 'steps', type: 'integer', targets: [{ node_id: '3', input: 'steps', type: 'integer', field_id: 'steps-field' }] },
    ];
    for (const slot of payload.reference_slots) {
      const node_id = String(20 + slot.index), id = `media-${slot.index}`;
      prompt[node_id] = { class_type: 'LoadImage', inputs: { image: own.references?.[slot.index] || '' } };
      fields.push(scalar(id, node_id, 'image', 'image', slot.port_id));
      receipt.push({ logical_id: slot.port_id, type: 'image', targets: [{ node_id, input: 'image', type: 'image', field_id: id }] });
    }
    return { backend_url: h.sandbox.settings.backend_url, source_kind: 'preset', source_revision: null,
      source_request: clone(own), source_document: { prompt }, prompt: clone(prompt), fields, receipt, receipt_complete: true,
      outputs: [{ id: '9', class_type: 'SaveImage', label: 'Result', mediaType: 'image' }], pending: clone(payload.pending || []), overrides: [], diagnostics: [], status: 'materialized' };
  }
  state.onApi = async (path, payload) => {
    if (state.interceptor) { const result = await state.interceptor(path, payload); if (result !== undefined) return result; }
    if (path === '/api/editor-workflows') return { id: EDITOR_ID };
    if (path === '/api/editor-prepare' && payload.preset_request) {
      state.prepared = prepared(payload);
      if (state.prepareTransform) state.prepareTransform(state.prepared, payload);
      return clone(state.prepared);
    }
    if (path === '/api/editor-prepare' && payload.package_id && state.boundPackage) {
      assert.equal(payload.package_id, state.boundPackage.id);
      const prompt = clone(state.boundPackage.prompt);
      for (const item of payload.overrides || []) prompt[item.node_id].inputs[item.input] = item.value;
      return { backend_url: h.sandbox.settings.backend_url, source_revision: payload.package_id,
        source_document: { prompt: clone(state.boundPackage.prompt) }, prompt,
        overrides: clone(payload.overrides || []), pending: clone(payload.pending || []) };
    }
    if (path === '/api/interfaces/inspect') {
      const result = { fields: clone(state.prepared.fields), outputs: clone(state.prepared.outputs) };
      if (state.inspectTransform) state.inspectTransform(result);
      return result;
    }
    if (path === '/api/interfaces/apply') {
      const fields = clone(payload.fields), prompt = clone(payload.prompt);
      const values = Object.fromEntries(fields.map(field => [field.id, prompt[field.node_id].inputs[field.input]]));
      state.boundPackage = { id: `p-${'a'.repeat(24)}`, name: 'Bound preset', fields, prompt };
      return { backend_url: h.sandbox.settings.backend_url, package: clone(state.boundPackage),
        values, baseline: clone(values), output_nodes: ['9'], requires_resolution: false };
    }
  };
  state.onOpenApi = async (draft, baseline, bindFn) => {
    await state.host.ensureBackend(draft); await state.host.ensureInstance(draft);
    state.session = await state.host.prepareSession(draft, { id: draft.data.editor_id, revision: 1 });
    if (state.beforeBinding) await state.beforeBinding(draft, baseline);
    if (bind) await bindFn({ output: clone(baseline), controls: [{ node_id: '1', input: 'text', widget_node_id: '1', widget_name: 'text' }] });
  };
  return { ...h, a, b };
}
const requests = (h, path) => h.state.calls.filter(call => call.path === path);
const unchanged = /编辑准备期间.*已变化|画布、节点或连线已变化/;
function assertNoExecution(h) {
  assert(h.state.calls.every(call => !/compile|upload|backend-input|\/jobs/.test(call.path)));
}

test('first builtin entry prepares own N, then projects C into a shadow session without editing old graph or generating', async () => {
  const h = fixture(), original = clone(h.sandbox.graph);
  await h.sandbox.openNodeWorkflow(h.node);
  const prepares = requests(h, '/api/editor-prepare'); assert.equal(prepares.length, 2);
  assert.equal(prepares[0].payload.preset_request.positive, 'OWN POS'); assert.equal(prepares[0].payload.preset_request.negative, 'OWN NEG');
  assert.equal(JSON.stringify(prepares[0].payload.preset_request).includes('CONNECTED'), false);
  assert.equal(h.state.baseline['1'].inputs.text, 'OWN POS'); assert.equal(h.state.baseline['2'].inputs.text, 'OWN NEG');
  assert.equal(h.state.session.provenance.find(item => item.field_id === 'positive-field').value, 'CONNECTED A\n\nOWN POS');
  assert.equal(h.state.session.provenance.find(item => item.field_id === 'negative-field').value, 'NEGATIVE B, OWN NEG');
  assert.deepEqual(h.sandbox.graph, original); assertNoExecution(h);
});

test('unuploaded multi-image intent keeps image3 port and holes in session pending without requiring upload to open', async () => {
  const h = fixture({ kind: 'qwen21_edit', media: true }); const original = clone(h.sandbox.graph);
  await h.sandbox.openNodeWorkflow(h.node);
  assert.deepEqual(requests(h, '/api/editor-prepare')[0].payload.reference_slots.map(slot => slot.port_id), ['image_1', 'image_2', 'image_3']);
  assert.equal(h.state.baseline['22'].inputs.image, '');
  assert(h.state.session.pending.some(item => item.field_id === 'media-2' && item.reason === 'local_only'));
  assert(h.state.session.pending.some(item => item.field_id === 'media-0'));
  assert.deepEqual(h.sandbox.graph, original); assertNoExecution(h);
});

for (const failure of ['blocked', 'receipt', 'mapping']) test(`${failure} first preparation keeps old graph and does not create a native draft`, async () => {
  const h = fixture(), original = clone(h.sandbox.graph);
  h.state.interceptor = (path, payload) => {
    if (path === '/api/editor-prepare' && payload.preset_request) return failure === 'blocked'
      ? { backend_url: BACKEND, source_kind: 'preset', status: 'blocked', blocked: [{ message: 'Missing registered schema' }] }
      : failure === 'receipt' ? { backend_url: BACKEND, source_kind: 'preset', status: 'materialized', receipt_complete: false }
        : { backend_url: BACKEND, source_kind: 'preset', source_request: clone(payload.preset_request), status: 'materialized', receipt_complete: true, source_document: { prompt: { '1': { class_type: 'Text', inputs: { text: 'OWN POS' } } } }, fields: [], receipt: [], outputs: [] };
  };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), /原参数|原节点|真实接口映射/);
  assert.deepEqual(h.sandbox.graph, original); assert.equal(requests(h, '/api/editor-workflows').length, 0); assert.equal(h.state.opened.length, 0); assertNoExecution(h);
});

for (const route of ['/api/editor-prepare', '/api/editor-workflows', `/api/editor-workflows/${EDITOR_ID}/backends`]) test(`early source witness rejects source changes during ${route}`, async () => {
  const h = fixture(); let expected;
  h.state.interceptor = path => { if (path === route) { h.a.data.text = 'USER CHANGED'; expected = clone(h.sandbox.graph); } };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), unchanged);
  assert.deepEqual(h.sandbox.graph, expected); assert.equal(h.node.data.editor_id, undefined); assert.equal(h.node.data.kind, 'sdxl'); assertNoExecution(h);
  assert.doesNotThrow(() => h.sandbox.beginNativeEditorContext(h.node).assertCurrent(), 'failure must release old context');
});

for (const change of ['node replacement', 'source replacement', 'canvas', 'parameters', 'edge', 'media ticket', 'backend']) test(`preparation awaits reject changed ${change} without binding old assumptions`, async () => {
  const h = fixture({ kind: 'qwen21_edit', media: true }); let expected;
  h.state.interceptor = (path, payload) => {
    if (path !== '/api/editor-prepare' || !payload.preset_request) return;
    if (change === 'node replacement') h.sandbox.graph.nodes[0] = clone(h.node);
    if (change === 'source replacement') h.sandbox.graph.nodes[1] = clone(h.a);
    if (change === 'canvas') h.state.identity = 'new-canvas';
    if (change === 'parameters') h.node.data.steps++;
    if (change === 'edge') h.sandbox.graph.edges[0].sourceField = 'negative';
    if (change === 'media ticket') h.sandbox.referenceImports.set(h.reference.id, { ticket: {}, message: 'New upload' });
    if (change === 'backend') h.sandbox.settings.backend_url = OTHER;
    expected = clone(h.sandbox.graph);
  };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), unchanged);
  assert.deepEqual(h.sandbox.graph, expected); assert.equal(requests(h, '/api/editor-workflows').length, 0); assertNoExecution(h);
});

test('verified conversion binds all fields, own values, labels, legacy dual contributions and media intents atomically', async () => {
  const h = fixture({ kind: 'qwen21_edit', legacy: true, media: true, bind: true });
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.node.data.kind, 'package'); assert.equal(h.node.data.editor_id, EDITOR_ID); assert.match(h.node.data.package_id, /^p-/);
  assert.equal(h.node.data.packageFields.length, 7); assert.equal(h.node.data.packageValues['positive-field'], 'OWN POS'); assert.equal(h.node.data.packageValues['negative-field'], 'OWN NEG');
  assert.equal(h.node.data.packageValues['seed-field'], 42); assert.equal(h.node.data.packageValues['media-2'], '');
  assert.equal(h.node.data.inputLabels['positive-field'], '镜头描述'); assert.equal(h.node.data.inputLabels['negative-field'], '排除内容'); assert.equal(h.node.data.inputLabels['media-2'], '人物参考');
  assert.equal(h.sandbox.graph.edges.filter(edge => edge.targetField === 'positive-field').length, 2);
  assert.equal(h.sandbox.graph.edges.filter(edge => edge.targetField === 'negative-field').length, 2);
  assert.equal(h.sandbox.graph.edges.find(edge => edge.id === 'media-edge').targetField, 'media-2');
  assert.equal(h.node.data.packageTextCompositions['positive-field'], 'paragraphs'); assert.equal(h.node.data.packageTextCompositions['negative-field'], 'comma');
  assert.doesNotThrow(h.state.session.assertCurrent); assertNoExecution(h);
  h.sandbox.graph.edges = h.sandbox.graph.edges.filter(edge => edge.id !== 'media-edge');
  const payload = generationPayload(h.sandbox.graph, h.node.id);
  assert.equal(payload.values['positive-field'], 'CONNECTED A\n\nCONNECTED B\n\nOWN POS');
  assert.equal(payload.values['negative-field'], 'NEGATIVE A, NEGATIVE B, OWN NEG');
});

test('after successful first bind, another open uses native package full fields and connected projection', async () => {
  const h = fixture({ bind: true }); await h.sandbox.openNodeWorkflow(h.node);
  h.state.host.endSession(h.state.opened[0]); h.state.onOpen = async node => { h.state.session = await h.state.host.prepareSession(node, { id: node.data.editor_id, revision: 2 }); };
  const count = requests(h, '/api/editor-prepare').filter(call => call.payload.preset_request).length;
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(requests(h, '/api/editor-prepare').filter(call => call.payload.preset_request).length, count);
  assert.equal(h.state.opened.at(-1), h.node); assert.equal(h.state.host.fields(h.node).length, 4);
  assert.equal(h.state.session.provenance[0].value, 'CONNECTED A\n\nOWN POS'); assertNoExecution(h);
});

for (const route of ['/api/interfaces/inspect', '/api/interfaces/apply']) test(`source change during first ${route} preserves user graph and does not commit package binding`, async () => {
  const h = fixture({ bind: true }); let expected;
  h.state.interceptor = path => { if (path === route) { h.a.data.negative = 'USER EDIT'; expected = clone(h.sandbox.graph); } };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), unchanged);
  assert.deepEqual(h.sandbox.graph, expected); assert.equal(h.node.data.editor_id, undefined); assert.equal(h.node.data.kind, 'sdxl'); assertNoExecution(h);
});

test('failed strict conversion or unresolved apply keeps the complete original graph', async () => {
  for (const reason of ['conversion', 'unresolved']) {
    const h = fixture({ bind: true }), original = clone(h.sandbox.graph);
    if (reason === 'conversion') h.state.onOpenApi = async () => { throw new Error('strict converted output differs'); };
    else h.state.interceptor = path => path === '/api/interfaces/apply' ? { backend_url: BACKEND, requires_resolution: true } : undefined;
    await assert.rejects(h.sandbox.openNodeWorkflow(h.node), /strict converted|首次外层绑定/);
    assert.deepEqual(h.sandbox.graph, original); assert.equal(h.node.data.editor_id, undefined); assertNoExecution(h);
  }
});

for (const mismatch of ['source_request', 'reference_slots', 'input_intents', 'model_intents']) test(`prepared ${mismatch} mismatch rejects before native draft creation`, async () => {
  const h = fixture(), original = clone(h.sandbox.graph);
  h.state.prepareTransform = (response, payload) => {
    if (mismatch === 'source_request') response.source_request.positive = 'OTHER REQUEST';
    else {
      response.intents = Object.fromEntries(['reference_slots', 'input_intents', 'model_intents'].map(key => [key, clone(payload[key])]));
      response.intents[mismatch] = mismatch === 'reference_slots' ? [{ port_id: 'image_2', index: 1, ordinal: 2, role: 'reference' }] : { unexpected: true };
    }
  };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), /原始请求|准备意图/);
  assert.deepEqual(h.sandbox.graph, original); assert.equal(requests(h, '/api/editor-workflows').length, 0); assertNoExecution(h);
});

test('second connected preparation await retains the original source witness', async () => {
  const h = fixture(); let expected;
  h.state.interceptor = (path, payload) => {
    if (path === '/api/editor-prepare' && !payload.preset_request) { h.a.data.text = 'NEW C'; expected = clone(h.sandbox.graph); }
  };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), unchanged);
  assert.deepEqual(h.sandbox.graph, expected); assert.equal(h.node.data.kind, 'sdxl'); assert.equal(h.node.data.editor_id, undefined); assertNoExecution(h);
});

test('fresh inspected candidate IDs remap labels and connected ports by exact binding', async () => {
  const h = fixture({ bind: true });
  h.state.inspectTransform = info => { for (const field of info.fields) field.id = `fresh-${field.id}`; };
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.node.data.packageValues['fresh-positive-field'], 'OWN POS');
  assert.equal(h.node.data.packageValues['fresh-negative-field'], 'OWN NEG');
  assert.equal(h.node.data.inputLabels['fresh-positive-field'], '镜头描述');
  assert.equal(h.sandbox.graph.edges.find(edge => edge.id === 'edge-a').targetField, 'fresh-positive-field');
  assert.equal(h.sandbox.graph.edges.find(edge => edge.id === 'edge-b').targetField, 'fresh-negative-field');
  assert.equal(h.node.data.packageValues['positive-field'], undefined); assertNoExecution(h);
});

test('logical scalar fanout binds every authoritative field with its own literal value', async () => {
  const h = fixture({ bind: true });
  h.state.prepareTransform = response => {
    response.source_document.prompt['4'] = { class_type: 'KSampler', inputs: { seed: 42 } };
    response.prompt = clone(response.source_document.prompt);
    response.fields.push({ id: 'seed-second', node_id: '4', input: 'seed', type: 'integer', label: 'Second seed' });
    response.receipt.find(item => item.logical_id === 'seed').targets.push({ node_id: '4', input: 'seed', type: 'integer', field_id: 'seed-second' });
  };
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.node.data.packageFields.length, 5);
  assert.equal(h.node.data.packageValues['seed-field'], 42); assert.equal(h.node.data.packageValues['seed-second'], 42);
  assert.equal(requests(h, '/api/interfaces/apply')[0].payload.prompt['4'].inputs.seed, 42); assertNoExecution(h);
});

test('first verified migration preserves downstream selected output index one', async () => {
  const h = fixture({ bind: true });
  const downstream = makeNode('downstream', 'generation', { kind: 'qwen21_edit' });
  h.sandbox.graph.nodes.push(downstream);
  h.sandbox.graph.edges.push({ id: 'downstream-edge', source: h.node.id, target: downstream.id, sourceField: 'image', targetField: 'image_1', outputIndex: 1 });
  await h.sandbox.openNodeWorkflow(h.node);
  const edge = h.sandbox.graph.edges.find(item => item.id === 'downstream-edge');
  assert.equal(edge.sourceOutput, '9'); assert.equal(edge.outputIndex, 1); assert.equal(edge.targetField, 'image_1'); assertNoExecution(h);
});

for (const phase of ['prepare', 'apply']) test(`wrong backend at ${phase} cannot bind a preset`, async () => {
  const h = fixture({ bind: true }), original = clone(h.sandbox.graph);
  if (phase === 'prepare') h.state.prepareTransform = response => { response.backend_url = OTHER; };
  else h.state.interceptor = path => path === '/api/interfaces/apply' ? { backend_url: OTHER, package: { id: `p-${'b'.repeat(24)}` } } : undefined;
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), /后端|引擎不一致|首次外层绑定/);
  assert.deepEqual(h.sandbox.graph, original); assert.equal(h.node.data.editor_id, undefined); assertNoExecution(h);
});

test('legacy plus explicit negative duplicate contribution migrates without deduplication or losing own N', async () => {
  const h = fixture({ legacy: true, bind: true });
  h.sandbox.graph.edges[1] = { id: 'edge-b', source: h.a.id, target: h.node.id, targetField: 'negative', sourceField: 'negative' };
  assert.equal(generationPayload(h.sandbox.graph, h.node.id).negative, 'NEGATIVE A, NEGATIVE A, OWN NEG');
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.node.data.kind, 'package');
  const migrated = h.sandbox.graph.edges.filter(edge => edge.targetField === 'negative-field');
  assert.equal(migrated.length, 2); assert.equal(migrated.filter(edge => edge.sourceOccurrence === 1).length, 1);
  assert.equal(generationPayload(h.sandbox.graph, h.node.id).values['negative-field'], 'NEGATIVE A, NEGATIVE A, OWN NEG');
  assert.equal(h.node.data.packageValues['negative-field'], 'OWN NEG'); assertNoExecution(h);
});

for (const route of ['/api/interfaces/inspect', '/api/interfaces/apply']) test(`${route} failure leaves the original builtin graph recoverable`, async () => {
  const h = fixture({ bind: true }), original = clone(h.sandbox.graph);
  const failure = route.endsWith('/inspect') ? 'inspection budget exceeded' : 'apply network reply lost';
  h.state.interceptor = path => { if (path === route) throw new Error(failure); };
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node), new RegExp(failure));
  assert.deepEqual(h.sandbox.graph, original); assert.equal(h.node.data.kind, 'sdxl'); assert.equal(h.node.data.editor_id, undefined); assertNoExecution(h);
});

test('empty static encoder enum survives first binding and native package reopening as its real own literal', async () => {
  const h = fixture({ bind: true, own: { models: { text_encoder: 'old-encoder.safetensors' } } });
  h.state.prepareTransform = response => {
    response.source_document.prompt['5'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'old-encoder.safetensors' } };
    response.prompt = clone(response.source_document.prompt);
    response.fields.push({ id: 'encoder-field', node_id: '5', input: 'clip_name', type: 'select', role: 'encoder', options: [], default: 'old-encoder.safetensors', label: '文本编码器' });
    response.receipt.push({ logical_id: 'models.text_encoder', type: 'select', targets: [{ node_id: '5', input: 'clip_name', type: 'select', field_id: 'encoder-field' }] });
    response.pending.push({ field_id: 'encoder-field', node_id: '5', input: 'clip_name', reason: 'enum_unavailable' });
  };
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.node.data.kind, 'package'); assert.equal(h.node.data.packageValues['encoder-field'], 'old-encoder.safetensors');
  assert.equal(h.node.data.packageFields.find(field => field.id === 'encoder-field').type, 'select');
  assert.deepEqual(h.state.boundPackage.fields.find(field => field.id === 'encoder-field').options, []);
  assert.equal(h.state.boundPackage.prompt['5'].inputs.clip_name, 'old-encoder.safetensors');
  h.state.host.endSession(h.state.opened[0]);
  h.state.onOpen = async node => { h.state.session = await h.state.host.prepareSession(node, { id: node.data.editor_id, revision: 2 }); };
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.state.host.fields(h.node).find(field => field.id === 'encoder-field').type, 'select');
  assert.equal(h.node.data.packageValues['encoder-field'], 'old-encoder.safetensors'); assertNoExecution(h);
});
