import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStudioEditorResult,
  initializeStudioEditorData,
  restoreStudioEditorBindings,
  restoreStudioEditorMetadata,
  studioEditorRecovery,
  clearStudioEditorRecovery,
  studioEditorData,
  studioEditorRecord,
} from '../web/studio-editor-state.mjs';

const backend = 'http://127.0.0.1:8188';
const otherBackend = 'http://127.0.0.1:8189';
const oldPackageId = `p-${'1'.repeat(24)}`;
const newPackageId = `p-${'2'.repeat(24)}`;
const editorId = `e-${'3'.repeat(24)}`;
const textField = { id: 'f_text', label: '文本', type: 'text', node_id: '1', input: 'text', default: 'base text' };
const audioField = { id: 'f_audio', label: '参考音频', type: 'audio', node_id: '2', input: 'audio', default: '', required: false };
const pack = {
  id: oldPackageId, name: '本地声音包', fields: [textField, audioField],
  prompt: {
    '1': { class_type: 'TextNode', inputs: { text: 'base text' } },
    '2': { class_type: 'LoadAudio', inputs: { audio: '' } },
  },
};
const controls = [
  { node_id: '1', input: 'text', widget_node_id: '1', widget_name: 'text' },
  { node_id: '2', input: 'audio', widget_node_id: '2', widget_name: 'audio' },
];

test('restoring per-package recovery retains both uncertain sources and drops malformed entries', () => {
  const first = { package_id: oldPackageId, editor_id: editorId, revision: 2, reason: 'unknown' };
  const second = { package_id: newPackageId, editor_id: editorId, revision: 3, reason: 'binding_failed' };
  const recovered = restoreStudioEditorMetadata({ editorRecovery: first, editorRecoveries: {
    [newPackageId]: { ...second, session_id: 'never persist' }, invalid: { ...second, package_id: 'invalid' },
  } });
  assert.deepEqual(studioEditorRecovery(recovered, oldPackageId), first);
  assert.deepEqual(studioEditorRecovery(recovered, newPackageId), second);
  assert.equal(Object.keys(recovered.editorRecoveries).length, 2);
  clearStudioEditorRecovery(recovered, newPackageId);
  assert.deepEqual(studioEditorRecovery(recovered, oldPackageId), first);
  assert.equal(studioEditorRecovery(recovered, newPackageId), null);
});

function editorData(overrides = {}) {
  return {
    editor_id: editorId,
    package_id: oldPackageId,
    editor_backend: backend,
    editor_baseline: { f_text: 'base text', f_audio: '' },
    editor_controls: structuredClone(controls),
    editor_outputs: ['9'],
    editor_output_fields: [{ id: '9', label: '音频输出', mediaType: 'audio' }],
    editor_hidden_updates: [],
    ...overrides,
  };
}

function draft(overrides = {}) {
  return {
    package_id: oldPackageId,
    values: { f_text: '工作台中未提交的文本', f_audio: 'voice/reference.wav' },
    valuesByPackage: { [oldPackageId]: { f_text: '旧缓存文本' } },
    mediaBackends: { f_audio: backend },
    mediaBackendsByPackage: { [oldPackageId]: { f_audio: backend } },
    mediaPreviewsByPackage: {
      [oldPackageId]: {
        f_audio: { name: 'voice/reference.wav', backend, type: 'audio', url: `/api/media/${'a'.repeat(32)}` },
      },
    },
    editorBindings: {
      [oldPackageId]: studioEditorRecord(editorData(), 4, { sourceKind: 'native' }),
    },
    ...overrides,
  };
}

function compiled(overrides = {}) {
  return {
    output: {
      '1': { class_type: 'TextNode', inputs: { text: 'base text' } },
      '2': { class_type: 'LoadAudio', inputs: { audio: '' } },
    },
    controls: structuredClone(controls),
    ...overrides,
  };
}

test('studio editor record keeps bounded source metadata and restore drops malformed bindings independently', () => {
  const record = studioEditorRecord({
    ...editorData(),
    editor_controls: controls.map(item => ({ ...item, media_receipt: 'private upload receipt', mapping_receipt: 'private mapping receipt' })),
    editor_session: 'must not persist',
    bridge_nonce: 'must not persist',
  }, 7, { sourceKind: 'api' });
  assert.equal(record.source_kind, 'api');
  assert.equal(record.initialized, true);
  assert.equal(record.revision, 7);
  assert.equal(Object.hasOwn(record, 'editor_session'), false);
  assert.equal(Object.hasOwn(record, 'bridge_nonce'), false);
  assert.equal(Object.hasOwn(record.editor_controls[0], 'media_receipt'), false);
  assert.equal(Object.hasOwn(record.editor_controls[0], 'mapping_receipt'), false);

  const badId = `p-${'4'.repeat(24)}`;
  const restored = restoreStudioEditorBindings({
    [oldPackageId]: record,
    [badId]: { ...record, package_id: oldPackageId },
    [`p-${'5'.repeat(24)}`]: { ...record, editor_backend: 'https://remote.invalid' },
  });
  assert.deepEqual(Object.keys(restored), [oldPackageId]);
  assert.equal(restored[oldPackageId].source_kind, 'api');
  assert.deepEqual(restoreStudioEditorBindings([]), {});
  assert.deepEqual(restoreStudioEditorBindings(Object.fromEntries(Array.from({ length: 201 }, (_, index) => [
    `p-${String(index).padStart(24, '0')}`, record,
  ]))), {});
});

test('studio editor record rejects invalid identities, revisions, non-loopback backend, and incomplete control entries', () => {
  const base = editorData();
  assert.throws(() => studioEditorRecord({ ...base, editor_id: 'editor-1' }, 1), /标识或版本/);
  assert.throws(() => studioEditorRecord(base, 0), /标识或版本/);
  assert.throws(() => studioEditorRecord({ ...base, editor_backend: 'https://127.0.0.1:8188' }, 1), /地址无效/);
  assert.throws(() => studioEditorRecord({ ...base, editor_controls: [{ ...controls[0], widget_name: '' }] }, 1), /控件映射无效/);
  assert.throws(() => studioEditorRecord({ ...base, editor_baseline: { seed: Number.MAX_SAFE_INTEGER + 1 } }, 1), /安全范围/);
});

test('restored studio data projects only current fields and carries media owner only with the draft evidence', () => {
  const sourceDraft = draft();
  const record = studioEditorRecord(editorData(), 4, { sourceKind: 'native' });
  const projected = studioEditorData(sourceDraft, pack, backend, record);
  assert.equal(projected.editor_id, editorId);
  assert.equal(projected.package_id, oldPackageId);
  assert.deepEqual(projected.packageValues, sourceDraft.values);
  assert.deepEqual(projected.packageMediaBackends, {
    f_audio: { name: 'voice/reference.wav', backend },
  });
  assert.equal(projected.editor_baseline.f_text, 'base text');

  const unowned = studioEditorData({ ...sourceDraft, mediaBackends: {} }, pack, backend, record);
  assert.deepEqual(unowned.packageMediaBackends, {});
  assert.deepEqual(sourceDraft.values, { f_text: '工作台中未提交的文本', f_audio: 'voice/reference.wav' });
});

test('first source-copy initialization snapshots verified scalar baseline and strips transient mapping receipts', () => {
  const source = editorData({ editor_baseline: { f_text: 'old', f_audio: 'old.wav' } });
  const result = initializeStudioEditorData(source, pack, compiled({ controls: controls.map(item => ({
    ...item, media_receipt: 'transient', mapping_receipt: 'transient',
  })) }));
  assert.deepEqual(result.editor_baseline, { f_text: 'base text', f_audio: '' });
  assert.deepEqual(result.editor_controls, controls);
  assert.deepEqual(source.editor_baseline, { f_text: 'old', f_audio: 'old.wav' }, 'input source is unchanged');
});

test('first source-copy initialization requires one control mapping for every exposed field', () => {
  for (const [label, mappings] of [
    ['missing text mapping', [controls[1]]],
    ['duplicate text mapping', [controls[0], controls[0], controls[1]]],
    ['wrong input binding', [controls[0], { ...controls[1], input: 'other' }]],
    ['empty widget name', [controls[0], { ...controls[1], widget_name: '' }]],
    ['empty widget node', [controls[0], { ...controls[1], widget_node_id: '' }]],
  ]) {
    assert.throws(() => initializeStudioEditorData(editorData(), pack, compiled({ controls: mappings })), /控件映射|无法确认/,
      label);
  }
});

test('first source-copy initialization rejects missing nodes, changed classes, missing inputs, and non-scalars', () => {
  const cases = [
    compiled({ output: { '1': { class_type: 'TextNode', inputs: { text: 'ok' } } } }),
    compiled({ output: { '1': { class_type: 'OtherNode', inputs: { text: 'ok' } }, '2': { class_type: 'LoadAudio', inputs: { audio: '' } } } }),
    compiled({ output: { '1': { class_type: 'TextNode', inputs: {} }, '2': { class_type: 'LoadAudio', inputs: { audio: '' } } } }),
    compiled({ output: { '1': { class_type: 'TextNode', inputs: { text: ['2', 0] } }, '2': { class_type: 'LoadAudio', inputs: { audio: '' } } } }),
  ];
  for (const value of cases) assert.throws(() => initializeStudioEditorData(editorData(), pack, value), /无法确认/);
});

test('applying creates a new immutable package state and keeps old values, media owner, preview, and editor binding', () => {
  const sourceDraft = draft();
  const data = studioEditorData(sourceDraft, pack, backend, editorData());
  const nextFields = [
    { ...textField, default: 'new graph default' },
    { ...audioField, id: 'f_audio_next', node_id: '2', input: 'audio' },
  ];
  const result = {
    package: { id: newPackageId, name: '更新声音包', fields: nextFields },
    values: { f_text: '工作台中未提交的文本', f_audio_next: 'voice/reference.wav' },
    baseline: { f_text: 'new graph default', f_audio_next: '' },
    backend_url: backend,
    output_nodes: ['9'], outputs: [{ id: '9', label: '音频输出', mediaType: 'audio' }],
    rebindings: { f_audio: 'f_audio_next' }, output_rebindings: {},
  };
  const applied = applyStudioEditorResult(sourceDraft, data, result, 5, 'native');
  assert.equal(applied.draft.package_id, newPackageId);
  assert.deepEqual(applied.draft.values, result.values);
  assert.deepEqual(applied.draft.valuesByPackage[oldPackageId], sourceDraft.values);
  assert.deepEqual(applied.draft.mediaBackendsByPackage[oldPackageId], sourceDraft.mediaBackends);
  assert.deepEqual(applied.draft.editorBindings[oldPackageId], sourceDraft.editorBindings[oldPackageId]);
  assert.deepEqual(applied.draft.mediaBackends, { f_audio_next: backend }, 'explicit same-type rebinding retains only backend ownership');
  assert.equal(applied.draft.mediaPreviewsByPackage[oldPackageId].f_audio.url, sourceDraft.mediaPreviewsByPackage[oldPackageId].f_audio.url);
  assert.deepEqual(applied.draft.mediaPreviewsByPackage[newPackageId], {}, 'a rebound field does not inherit its preview proof');
  assert.equal(applied.draft.editorBindings[newPackageId].source_kind, 'native');
  assert.equal(applied.draft.editorBindings[newPackageId].revision, 5);
  assert.equal(applied.data.package_id, newPackageId);
  assert.equal(sourceDraft.package_id, oldPackageId, 'the caller draft is immutable');
});

test('media owner is not transferred across type/name changes or backend changes', () => {
  const sourceDraft = draft();
  const data = studioEditorData(sourceDraft, pack, backend, editorData());
  const cases = [
    { id: newPackageId, type: 'video', name: 'voice/reference.wav', backend: backend, expected: {} },
    { id: `p-${'6'.repeat(24)}`, type: 'audio', name: 'different.wav', backend, expected: {} },
    { id: `p-${'7'.repeat(24)}`, type: 'audio', name: 'voice/reference.wav', backend: otherBackend,
      expected: { f_audio_next: backend } },
  ];
  for (const item of cases) {
    const result = {
      package: { id: item.id, fields: [textField, { ...audioField, id: 'f_audio_next', type: item.type }] },
      values: { f_text: 'workbench', f_audio_next: item.name }, baseline: {}, backend_url: item.backend,
      output_nodes: ['9'], outputs: [], rebindings: { f_audio: 'f_audio_next' }, output_rebindings: {},
    };
    const applied = applyStudioEditorResult(sourceDraft, data, result, 5, 'api');
    assert.deepEqual(applied.draft.mediaBackends, item.expected);
  }
});

test('same unbound field keeps its preview only when package, value, type, and backend evidence still match', () => {
  const sourceDraft = draft();
  const data = studioEditorData(sourceDraft, pack, backend, editorData());
  const result = {
    package: { id: newPackageId, fields: [textField, audioField] },
    values: { f_text: 'workbench', f_audio: 'voice/reference.wav' }, baseline: {}, backend_url: backend,
    output_nodes: ['9'], outputs: [], rebindings: {}, output_rebindings: {},
  };
  const applied = applyStudioEditorResult(sourceDraft, data, result, 6, 'api');
  assert.deepEqual(applied.draft.mediaPreviewsByPackage[newPackageId], {
    f_audio: sourceDraft.mediaPreviewsByPackage[oldPackageId].f_audio,
  });

  const changed = applyStudioEditorResult(sourceDraft, data, {
    ...result, package: { ...result.package, id: `p-${'8'.repeat(24)}` },
    values: { ...result.values, f_audio: 'different.wav' },
  }, 6, 'api');
  assert.deepEqual(changed.draft.mediaPreviewsByPackage[`p-${'8'.repeat(24)}`], {});
});
