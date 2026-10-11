import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, generationPayload } from '../web/graph.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';
import { EDITOR_PREPARATION_SOURCE_LIMIT, EDITOR_PREPARATION_RESULT_LIMIT, editorPreparationBackend, captureEditorPreparationTarget, assertEditorPreparationTarget, projectEditorInputs } from '../web/editor-preparation.mjs';

const BACKEND = 'http://127.0.0.1:8188', OTHER = 'http://127.0.0.1:8189';
const field = (id, type = 'text', more = {}) => ({ id, node_id: '12', input: id, label: id, type, ...more });
const node = (id, type, data = {}) => ({ ...createNode(type, 0, 0, data), id });
function fixture(fields = [field('prompt')], values = {}) {
  const target = node('target', 'generation', { kind: 'package', package_id: 'p-test', packageValues: values,
    packageFields: fields.map(({ id, label, type }) => ({ id, label, type })), editor_baseline: {} });
  const graph = { nodes: [target], edges: [] };
  const options = { fields, backend: BACKEND, canvasId: 'canvas', sourceRevision: 7,
    referenceImports: new Map(), mediaTransfers: createMediaTransfers() };
  return { graph, target, options, project: () => projectEditorInputs(graph, 'target', options) };
}
function connect(f, source, targetField, more = {}) {
  f.graph.nodes.push(source);
  const edge = { id: `edge-${f.graph.edges.length}`, source: source.id, target: 'target', ...(targetField ? { targetField } : {}), ...more };
  f.graph.edges.push(edge); return edge;
}
const byId = result => new Map(result.overrides.map(item => [item.field_id, item]));

test('target-only backend choice ignores incompatible and malformed upstream engines', () => {
  const f = fixture();
  connect(f, node('upstream', 'generation', { editor_backend: OTHER }), 'prompt');
  f.graph.nodes.push({ id: 'broken-island', type: 'unknown', get data() { throw new Error('Unrelated data read'); } });
  f.graph.edges.push({ source: 'missing', target: 'broken-island' });
  assert.equal(editorPreparationBackend(f.graph, 'target', 'http://localhost:8188/'), BACKEND);
  f.target.data.editor_backend = OTHER;
  assert.equal(editorPreparationBackend(f.graph, 'target', BACKEND), OTHER);
  delete f.target.data.editor_backend;
  assert.throws(() => editorPreparationBackend(f.graph, 'target', 'https://example.test'));
  assert.throws(() => editorPreparationBackend(f.graph, 'target', 'http://example.test'));
});

test('explicit stored scalar values retain types, fallback and baseline without mutation', () => {
  const f = fixture([field('count', 'integer'), field('enabled', 'boolean'), field('prompt'),
    field('mode', 'select', { options: [0, false, 'custom'] })], { count: 0, enabled: false, prompt: '', mode: 0 });
  f.target.data.editor_baseline = { count: 2, enabled: true, prompt: 'old', mode: 'custom' };
  const before = structuredClone(f.graph), result = f.project(), values = byId(result);
  assert.equal(values.get('count').value, 0); assert.equal(values.get('enabled').value, false);
  assert.equal(values.get('prompt').value, ''); assert.equal(values.get('mode').value, 0);
  assert.equal(values.get('prompt').stored_fallback, ''); assert.equal(values.get('prompt').baseline, 'old');
  assert.deepEqual(result.pending, []); assert.deepEqual(f.graph, before);
  values.get('count').value = 999; result.source.data.packageValues.count = 999;
  assert.deepEqual(f.graph, before, 'returned projection is detached from source data');
});

test('invalid own values stay in source and become diagnostics without numeric coercion or enum guessing', () => {
  const f = fixture([field('count', 'integer', { min: 0 }), field('mode', 'select', { options: ['one', 'two'] }), field('prompt')],
    { count: '12', mode: 'old-model-name', prompt: false, unknown: 3 });
  const result = f.project();
  assert.deepEqual(result.overrides, []);
  assert.deepEqual(result.pending.map(item => [item.field_id, item.reason]),
    [['count', 'invalid_value'], ['mode', 'enum_unavailable'], ['prompt', 'invalid_value'], ['unknown', 'mapping_unavailable']]);
  assert.equal(result.source.data.packageValues.mode, 'old-model-name');
});

test('cached public ports never substitute for full input mappings', () => {
  const f = fixture([field('prompt')], { prompt: 'fallback' });
  f.options.fields = f.target.data.packageFields;
  connect(f, node('text', 'prompt', { text: 'connected' }), 'prompt');
  const result = f.project();
  assert.deepEqual(result.overrides, []); assert(result.pending.every(item => item.reason === 'mapping_unavailable'));
});

test('connection text is session-derived and does not replace stored fallback or baseline', () => {
  const f = fixture([field('prompt'), field('negative')], { prompt: 'own text', negative: 'own negative' });
  f.target.data.editor_baseline = { prompt: 'original inside', negative: 'original negative' };
  const edge = connect(f, node('text', 'prompt', { text: 'current connection', negative: 'bad lighting' }), 'prompt');
  connect(f, node('neg', 'prompt', { text: 'unused', negative: '' }), 'negative', { sourceField: 'negative' });
  const before = structuredClone(f.graph), values = byId(f.project());
  assert.deepEqual(values.get('prompt'), { field_id: 'prompt', node_id: '12', input: 'prompt', value: 'current connection',
    origin: 'connected', stored_fallback: 'own text', baseline: 'original inside', edge_id: edge.id, source_id: 'text' });
  assert.equal(values.get('negative').value, ''); assert.deepEqual(f.graph, before);
});

test('invalid or duplicate connections do not use a stored fallback as the connected value', () => {
  const f = fixture([field('prompt')], { prompt: 'old fallback' });
  connect(f, node('text', 'prompt', { text: 123 }), 'prompt');
  assert.deepEqual(f.project().overrides, []);
  assert.equal(f.project().pending.at(-1).reason, 'invalid_value');
  connect(f, node('text2', 'prompt', { text: 'valid but ambiguous' }), 'prompt');
  assert.deepEqual(f.project().overrides, []);
  assert.equal(f.project().pending.filter(item => item.reason === 'ambiguous_connection').length, 2);
});

test('connected package text uses the package 64000-character limit rather than preset text limit', () => {
  const f = fixture([field('prompt')], { prompt: 'retained fallback' });
  const source = node('text', 'prompt', { text: 'x'.repeat(64001) }); connect(f, source, 'prompt');
  const result = f.project(); assert.deepEqual(result.overrides, []); assert.equal(result.pending[0].reason, 'invalid_value');
  assert.equal(result.source.data.packageValues.prompt, 'retained fallback');
  source.data.text = 'x'.repeat(64000); assert.equal(f.project().overrides[0].value.length, 64000);
});

test('duplicate field IDs and duplicate native bindings do not create ambiguous patches', () => {
  for (const fields of [[field('prompt'), field('prompt')], [field('prompt'), field('another', 'text', { input: 'prompt' })]]) {
    const f = fixture(fields, { prompt: 'own', another: 'second' });
    assert.deepEqual(f.project().overrides, []);
    assert(f.project().pending.every(item => item.reason === 'mapping_unavailable'));
  }
});

test('hidden scalar changes retain their own baseline while an unverified select remains pending', () => {
  const f = fixture([], {});
  f.target.data.editor_hidden_updates = [
    { field: field('hidden', 'number'), value: 0, baseline: 2 },
    { field: field('hiddenChoice', 'select'), value: 'preserved', baseline: 'prior' }];
  const result = f.project();
  assert.equal(result.overrides[0].origin, 'hidden'); assert.equal(result.overrides[0].value, 0);
  assert.equal(result.overrides[0].baseline, 2);
  assert.equal(result.pending[0].field_id, 'hiddenChoice'); assert.equal(result.pending[0].reason, 'invalid_value');
  assert.equal(result.source.data.editor_hidden_updates[1].value, 'preserved');
});

for (const changedBinding of [{ node_id: '99' }, { input: 'otherInput' }, { type: 'select' }]) {
  test(`a reused hidden field ID never writes its value into changed ${Object.keys(changedBinding)[0]}`, () => {
    const f = fixture([field('prompt')]);
    const hiddenField = field('prompt', 'text', changedBinding);
    f.target.data.editor_hidden_updates = [{ field: hiddenField, value: 'old hidden value', baseline: 'original' }];
    const result = f.project(); assert.deepEqual(result.overrides, []);
    assert.equal(result.pending[0].origin, 'hidden'); assert.equal(result.pending[0].reason, 'mapping_unavailable');
    assert.deepEqual(result.source.data.editor_hidden_updates[0].field, hiddenField);
  });
}

test('duplicate hidden records cannot guess which baseline and value belong to the mapping', () => {
  const f = fixture([field('prompt')]);
  f.target.data.editor_hidden_updates = [
    { field: field('prompt'), value: 'first hidden value', baseline: 'first baseline' },
    { field: field('prompt'), value: 'second hidden value', baseline: 'second baseline' }];
  const result = f.project(); assert.deepEqual(result.overrides, []);
  assert.equal(result.pending[0].reason, 'mapping_unavailable');
  assert.equal(result.source.data.editor_hidden_updates.length, 2);
});

test('own media only projects an exact name and normalized engine proof', () => {
  const f = fixture([field('image', 'image'), field('music', 'audio'), field('clip', 'video')],
    { image: 'sub/image.png', music: 'sound.wav', clip: 'clip.mp4' });
  f.target.data.packageMediaBackends = {
    image: { name: 'sub/image.png', backend: 'http://localhost:8188/' },
    music: { name: 'different.wav', backend: BACKEND }, clip: { name: 'clip.mp4', backend: OTHER } };
  const result = f.project();
  assert.equal(result.overrides.length, 1); assert.equal(result.overrides[0].value, 'sub/image.png');
  assert.deepEqual(result.overrides[0].media_owner, { name: 'sub/image.png', backend: BACKEND, media_type: 'image' });
  assert.deepEqual(result.pending.map(item => item.reason), ['owner_unknown', 'other_backend']);
});

for (const status of ['pending', 'failed']) {
  test(`own media ${status} replacement blocks its retained old filename`, () => {
    const f = fixture([field('image', 'image')], { image: 'old.png' });
    f.target.data.packageMediaBackends = { image: { name: 'old.png', backend: BACKEND } };
    const ticket = f.options.mediaTransfers.start('canvas:target', 'image', 'new image');
    if (status === 'failed') f.options.mediaTransfers.fail(ticket, new Error('storage failed'));
    const result = f.project();
    assert.deepEqual(result.overrides, []); assert.equal(result.pending[0].reason, `import_${status}`);
    assert.equal(f.target.data.packageValues.image, 'old.png');
  });
}

test('reference media projects all three types with exact field identity and engine proof', () => {
  const f = fixture(['image', 'video', 'audio'].map(type => field(type, type)));
  for (const type of ['image', 'video', 'audio']) connect(f, node(type, 'reference',
    { name: `${type}.file`, mediaType: type, uploadBackend: BACKEND }), type);
  const result = f.project();
  assert.equal(result.overrides.length, 3);
  for (const type of ['image', 'video', 'audio']) assert.equal(byId(result).get(type).media_owner.media_type, type);
  assert.deepEqual(result.pending, []);
});

test('a proven reference covers stale own media ownership without changing the stored fallback', () => {
  const f = fixture([field('image', 'image')], { image: 'old.png' });
  connect(f, node('ref', 'reference', { name: 'new.png', uploadBackend: BACKEND }), 'image');
  const result = f.project(); assert.deepEqual(result.pending, []);
  assert.equal(result.overrides[0].value, 'new.png'); assert.equal(result.overrides[0].stored_fallback, 'old.png');
  assert.equal(result.overrides[0].origin, 'connected'); assert.equal(f.target.data.packageValues.image, 'old.png');
});

test('valid connected text covers invalid own scalar diagnostics while preserving fallback', () => {
  const f = fixture([field('prompt')], { prompt: false });
  connect(f, node('text', 'prompt', { text: 'valid connected text' }), 'prompt');
  const result = f.project(); assert.deepEqual(result.pending, []);
  assert.equal(result.overrides[0].value, 'valid connected text'); assert.equal(result.overrides[0].stored_fallback, false);
  assert.equal(f.target.data.packageValues.prompt, false);
});

for (const status of ['pending', 'failed']) {
  test(`connected media cannot clear the target field's ${status} upload transaction`, () => {
    const f = fixture([field('image', 'image')], { image: 'old.png' });
    connect(f, node('ref', 'reference', { name: 'new.png', uploadBackend: BACKEND }), 'image');
    const ticket = f.options.mediaTransfers.start('canvas:target', 'image', 'new own media');
    if (status === 'failed') f.options.mediaTransfers.fail(ticket, 'cannot save');
    const result = f.project(); assert.deepEqual(result.overrides, []);
    assert(result.pending.some(item => item.reason === `import_${status}` && item.origin === 'transaction'));
    assert.equal(f.target.data.packageValues.image, 'old.png');
    assert.equal(f.options.mediaTransfers.state('canvas:target', 'image'), ticket);
  });
}

test('invalid or failed connections never restore a valid owned fallback as the effective value', () => {
  const f = fixture([field('image', 'image')], { image: 'old.png' });
  f.target.data.packageMediaBackends = { image: { name: 'old.png', backend: BACKEND } };
  const ref = node('ref', 'reference', { name: '../invalid.png', uploadBackend: BACKEND }); connect(f, ref, 'image');
  let result = f.project(); assert.deepEqual(result.overrides, []); assert.deepEqual(result.mediaOwners, {});
  assert.equal(result.pending.at(-1).reason, 'invalid_media'); assert.equal(result.pending.at(-1).origin, 'connected');
  ref.data.name = 'new.png'; f.options.referenceImports.set('ref', { ticket: Symbol('failed reference'), error: true });
  result = f.project(); assert.deepEqual(result.overrides, []); assert.deepEqual(result.mediaOwners, {});
  assert.equal(result.pending.at(-1).reason, 'import_failed'); assert.equal(f.target.data.packageValues.image, 'old.png');
});

test('valid connected text does not erase an unresolved hidden scalar diagnostic', () => {
  const f = fixture([field('prompt')], {});
  f.target.data.editor_hidden_updates = [{ field: field('prompt'), value: false, baseline: 'original' }];
  connect(f, node('text', 'prompt', { text: 'connection' }), 'prompt');
  const result = f.project(); assert.equal(result.overrides[0].value, 'connection');
  assert.equal(result.pending[0].origin, 'hidden'); assert.equal(result.pending[0].reason, 'invalid_value');
  assert.equal(result.source.data.editor_hidden_updates[0].value, false);
});

test('reference diagnostics distinguish local-only, owner, engine, type and invalid relative names', () => {
  const cases = [
    [{ name: '', localAssetId: 'a'.repeat(64) }, 'local_only'], [{ name: '' }, 'media_missing'],
    [{ name: 'old.png', uploadBackend: '' }, 'owner_unknown'], [{ name: 'old.png', uploadBackend: OTHER }, 'other_backend'],
    [{ name: '../old.png', uploadBackend: BACKEND }, 'invalid_media'], [{ name: 'C:\\secret.png', uploadBackend: BACKEND }, 'invalid_media'],
    [{ name: 'https://example.test/a.png', uploadBackend: BACKEND }, 'invalid_media'],
    [{ name: 'movie.mp4', uploadBackend: BACKEND, mediaType: 'video' }, 'media_type_mismatch'],
  ];
  for (const [data, reason] of cases) {
    const f = fixture([field('image', 'image')]); connect(f, node('ref', 'reference', data), 'image');
    const result = f.project(); assert.deepEqual(result.overrides, [], reason); assert.equal(result.pending[0].reason, reason);
  }
});

test('reference replacement transaction wins over old uploaded or local asset evidence', () => {
  const f = fixture([field('image', 'image')]);
  connect(f, node('ref', 'reference', { name: 'old.png', uploadBackend: BACKEND, localAssetId: 'a'.repeat(64) }), 'image');
  const ticket = Symbol('real import ticket');
  f.options.referenceImports.set('ref', { ticket, previewURL: 'blob:new-preview', mediaType: 'image', message: 'saving' });
  assert.equal(f.project().pending[0].reason, 'import_pending');
  f.options.referenceImports.set('ref', { ticket, error: true, message: 'save failed' });
  assert.equal(f.project().pending[0].reason, 'import_failed');
  assert.equal(f.graph.nodes[1].data.name, 'old.png'); assert.deepEqual(f.project().overrides, []);
  f.options.referenceImports.delete('ref'); assert.equal(f.project().overrides[0].value, 'old.png');
});

test('upstream generations and result previews are pending even with historic successful outputs', () => {
  for (const type of ['generation', 'result']) {
    const f = fixture([field('image', 'image')], { image: 'fallback.png' });
    const source = node('upstream', type, { outputs: [{ type: 'image', filename: 'old.png', url: '/api/media/old', node_id: '9' }],
      jobId: 'completed-job', name: 'old.png', uploadBackend: BACKEND });
    connect(f, source, 'image', { sourceOutput: '9', outputIndex: 0 });
    const result = f.project(); assert.deepEqual(result.overrides, []);
    assert.equal(result.pending.at(-1).reason, 'upstream_not_run'); assert.equal(result.pending.at(-1).source_id, 'upstream');
  }
});

test('preset prompt combination follows existing positive and negative aggregation', () => {
  const f = fixture([], {}); Object.assign(f.target.data, { kind: 'h3_t2v', positive: 'own', negative: 'own negative' });
  connect(f, node('legacy', 'prompt', { text: 'legacy', negative: 'legacy negative' }));
  connect(f, node('pos', 'prompt', { text: 'explicit positive' }), 'positive');
  connect(f, node('neg', 'prompt', { negative: 'explicit negative' }), 'negative');
  const expected = generationPayload(f.graph, 'target'), result = f.project();
  assert.equal(result.presetInputs.positive, expected.positive); assert.equal(result.presetInputs.negative, expected.negative);
  assert.deepEqual(result.overrides, []); assert.deepEqual(result.pending, []);
});

test('legacy prompt links cannot coerce a malformed positive value through a valid negative sourceField', () => {
  const f = fixture([], {}); f.target.data.kind = 'h3_t2v';
  const prompt = node('legacy', 'prompt'); Object.assign(prompt.data, { text: 123, negative: 'valid negative' });
  connect(f, prompt, null, { sourceField: 'negative' });
  const result = f.project(); assert.equal(result.presetInputs.positive, '');
  assert.equal(result.pending[0].reason, 'invalid_value');
});

test('preset combined prompt limits stay explicit instead of reporting an overlong aggregate ready', () => {
  const f = fixture([], {}); f.target.data.kind = 'h3_t2v';
  connect(f, node('first', 'prompt', { text: 'a'.repeat(60000), negative: 'b'.repeat(60000) }));
  connect(f, node('second', 'prompt', { text: 'c'.repeat(60000), negative: 'd'.repeat(60000) }));
  const result = f.project();
  assert.equal(result.presetInputs.positive.length, 120002); assert.equal(result.presetInputs.negative.length, 120002);
  assert.deepEqual(result.pending.map(item => [item.field_id, item.reason]), [['positive', 'invalid_value'], ['negative', 'invalid_value']]);
  assert.equal(f.graph.nodes[1].data.text.length, 60000, 'original text is retained without truncation');
});

test('preset named media slots preserve holes and never promote image 2 or swap start/end', () => {
  for (const [kind, slot] of [['qwen21_edit', 'image_2'], ['h3_i2v', 'end_image']]) {
    const f = fixture([], {}); f.target.data.kind = kind;
    connect(f, node('ref', 'reference', { name: 'second.png', uploadBackend: BACKEND }), slot);
    const result = f.project();
    assert.deepEqual(Object.keys(result.presetInputs.references), [slot]);
    assert.equal(result.presetInputs.references[slot].name, 'second.png');
    assert.deepEqual(result.pending, []);
  }
});

test('full API source preserves unknown metadata, unselected outputs and broken branches', () => {
  const f = fixture([], {}); Object.assign(f.target.data, { kind: 'api', apiPrompt: {
    A: { class_type: 'Known', inputs: { value: 3 }, _meta: { arbitrary: { retained: true } } },
    B: { class_type: 'UnknownPlugin', inputs: { missing: ['not-in-graph', 0] }, properties: { preserve: 'yes' } },
  } });
  const before = structuredClone(f.target.data.apiPrompt), result = f.project();
  assert.equal(result.source.kind, 'api'); assert.deepEqual(result.source.data.apiPrompt, before);
  assert.deepEqual(f.target.data.apiPrompt, before);
});

test('source capture supports native editor-size JSON above the backend API preparation budget', () => {
  const f = fixture([], {}); Object.assign(f.target.data, { kind: 'api', apiPrompt: {
    A: { class_type: 'UnknownPlugin', inputs: {}, _meta: { preserved: 'x'.repeat(3 * 1024 * 1024) } },
  } });
  const guard = captureEditorPreparationTarget(f.graph, 'target', f.options), result = f.project();
  assert.equal(assertEditorPreparationTarget(guard, f.graph, f.options), true);
  assert.equal(result.source.data.apiPrompt.A._meta.preserved.length, 3 * 1024 * 1024);
  assert.equal(EDITOR_PREPARATION_SOURCE_LIMIT, 16 * 1024 * 1024);
  assert.equal(EDITOR_PREPARATION_RESULT_LIMIT, 32 * 1024 * 1024);
  // This test never calls prepare_editor_document: its existing 2 MiB API
  // prompt boundary still applies independently in the Python service.
});

test('projection envelope has a separate budget and does not count repeated fallback as an API prompt', () => {
  const fields = Array.from({ length: 30 }, (_, index) => field(`text${index}`));
  const values = Object.fromEntries(fields.map(item => [item.id, 'x'.repeat(63000)]));
  const f = fixture(fields, values), result = f.project();
  assert.equal(result.overrides.length, 30);
  assert(new TextEncoder().encode(JSON.stringify(values)).length < 2 * 1024 * 1024);
  assert(new TextEncoder().encode(JSON.stringify(result)).length > 2 * 1024 * 1024);
  assert.deepEqual(f.target.data.packageValues, values);
  f.target.data.apiPrompt = { A: { class_type: 'Unknown', inputs: { text: 'x'.repeat(EDITOR_PREPARATION_SOURCE_LIMIT) } } };
  assert.throws(() => f.project(), /预算/);
});

test('capture guard ignores unrelated islands and deeper dependencies but detects direct changes', () => {
  const f = fixture([field('prompt')], { prompt: 'stored' });
  connect(f, node('text', 'prompt', { text: 'source' }), 'prompt');
  const deeper = node('deeper', 'reference', { name: 'invalid-unused.png', uploadBackend: OTHER });
  f.graph.nodes.push(deeper); f.graph.edges.push({ id: 'deeper-edge', source: 'deeper', target: 'text' });
  const guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
  deeper.data.name = 'changed'; f.graph.nodes.push({ id: 'unknown', type: 'invalid', get data() { throw new Error('Unexpected upstream inspection'); } });
  f.graph.edges.push({ id: 'broken-island', source: 'not-found', target: 'unknown' });
  assert.equal(assertEditorPreparationTarget(guard, f.graph, f.options), true);
  f.graph.nodes[1].data.text = 'changed while awaiting';
  assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options), /已变化/);
});

for (const change of ['target clone', 'source clone', 'target data', 'edge', 'canvas', 'backend', 'revision']) {
  test(`capture guard rejects ${change} even when target ID remains unchanged`, () => {
    const f = fixture([field('prompt')], { prompt: 'stored' }); connect(f, node('text', 'prompt', { text: 'source' }), 'prompt');
    const guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
    if (change === 'target clone') f.graph.nodes[0] = structuredClone(f.graph.nodes[0]);
    else if (change === 'source clone') f.graph.nodes[1] = structuredClone(f.graph.nodes[1]);
    else if (change === 'target data') f.target.data.packageValues.prompt = 'changed';
    else if (change === 'edge') f.graph.edges[0].sourceField = 'negative';
    else if (change === 'canvas') f.options.canvasId = 'other canvas';
    else if (change === 'backend') f.options.backend = OTHER;
    else f.options.sourceRevision = 8;
    assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options), /已变化/);
  });
}

test('capture guard detects reference ticket replacement, completion and in-place failure', () => {
  const f = fixture([field('image', 'image')]); connect(f, node('ref', 'reference', { name: 'old.png', uploadBackend: BACKEND }), 'image');
  const record = { ticket: Symbol('old ticket'), message: 'saving' }; f.options.referenceImports.set('ref', record);
  let guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
  record.ticket = Symbol('new ticket'); assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options));
  guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
  record.error = true; assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options));
  guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
  f.options.referenceImports.delete('ref'); assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options));
});

test('capture guard detects own media transfers but ignores unrelated owner transactions', () => {
  const f = fixture([field('image', 'image')], { image: 'old.png' });
  const ticket = f.options.mediaTransfers.start('canvas:target', 'image', 'image');
  let guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
  f.options.mediaTransfers.start('canvas:unrelated', 'image', 'elsewhere');
  assert.equal(assertEditorPreparationTarget(guard, f.graph, f.options), true);
  f.options.mediaTransfers.fail(ticket, 'failed'); assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options));
  guard = captureEditorPreparationTarget(f.graph, 'target', f.options);
  f.options.mediaTransfers.finish(ticket); assert.throws(() => assertEditorPreparationTarget(guard, f.graph, f.options));
});

test('unsafe JSON data and ambiguous direct source identity fail before projection', () => {
  for (const value of [undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, () => 'script']) {
    const f = fixture([field('prompt')]); f.target.data.packageValues.prompt = value;
    assert.throws(() => f.project(), /JSON|数据/);
  }
  const f = fixture(); connect(f, node('text', 'prompt', { text: 'one' }), 'prompt');
  f.graph.nodes.push(node('text', 'prompt', { text: 'second' })); assert.throws(() => f.project(), /重复/);
  assert.throws(() => captureEditorPreparationTarget(f.graph, 'target', { backend: BACKEND }), /来源版本/);
});

test('editor preparation performs zero HTTP, upload, backend-input or runner operations', () => {
  const f = fixture([field('image', 'image'), field('video', 'video')], { image: 'fallback.png' });
  connect(f, node('ref', 'reference', { localAssetId: 'a'.repeat(64), name: '', mediaType: 'image' }), 'image');
  connect(f, node('upstream', 'generation', { editor_backend: OTHER }), 'video');
  const operations = [];
  const forbid = name => () => { operations.push(name); throw new Error(`Forbidden: ${name}`); };
  Object.assign(f.options, { api: forbid('HTTP'), upload: forbid('upload'), prepareCanvasImages: forbid('backend-input'), runner: forbid('runner') });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = forbid('fetch');
  const before = structuredClone(f.graph);
  try {
    const guard = captureEditorPreparationTarget(f.graph, 'target', f.options), result = f.project();
    assert.equal(assertEditorPreparationTarget(guard, f.graph, f.options), true);
    assert(result.pending.some(item => item.reason === 'local_only'));
    assert(result.pending.some(item => item.reason === 'upstream_not_run'));
    assert.deepEqual(operations, []); assert.deepEqual(f.graph, before);
  } finally { globalThis.fetch = originalFetch; }
});
