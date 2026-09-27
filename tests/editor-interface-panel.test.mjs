import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EDITOR_INTERFACE_FIELD_LIMIT,
  chooseEditorInterface,
  deriveEditorRebindings,
  editorFieldGroup,
  editorFieldTypeCompatible,
  editorInputTargetsUnique,
  initialEditorFieldIds,
  initialEditorOutputIds,
  isRequiredEditorMediaField,
  resolveEditorConflicts,
  shortValuePreview,
} from '../web/editor-interface-panel.mjs';

test('input remapping cannot collide with another remap or a retained connection', () => {
  const connections = [{ direction: 'input', fieldId: 'old' }, { direction: 'input', fieldId: 'kept' }];
  assert.equal(editorInputTargetsUnique(connections, { old: 'kept' }), false);
  assert.equal(editorInputTargetsUnique(connections, { old: 'new', other: 'new' }), false);
  assert.equal(editorInputTargetsUnique(connections, { old: 'new', kept: null }), true);
});

test('classifies common ComfyUI controls and requires image/audio inputs', () => {
  const cases = [
    [{ id: 'ckpt', input: 'ckpt_name', type: 'STRING' }, '模型与编码器'],
    [{ id: 'vae', label: 'VAE', type: 'COMBO' }, '模型与编码器'],
    [{ id: 'lora', input: 'lora_name', type: 'STRING' }, '模型与编码器'],
    [{ id: 'clip', label: 'Text Encoder', type: 'COMBO' }, '模型与编码器'],
    [{ id: 'prompt', input: 'positive_prompt', type: 'STRING' }, '提示词'],
    [{ id: 'negative', label: '负向提示词', type: 'STRING' }, '提示词'],
    [{ id: 'seed', input: 'seed', type: 'INT' }, '采样尺寸'],
    [{ id: 'width', input: 'width', type: 'INT' }, '采样尺寸'],
    [{ id: 'misc', input: 'quality_mode', type: 'BOOLEAN' }, '其他'],
  ];
  for (const [field, group] of cases) assert.equal(editorFieldGroup(field), group, field.id);
  assert.equal(editorFieldGroup({ id: 'image', type: 'IMAGE' }), '媒体');
  assert.equal(editorFieldGroup({ id: 'audio', type: 'AUDIO' }), '媒体');
  assert.equal(isRequiredEditorMediaField({ id: 'image', type: 'IMAGE' }), true);
  assert.equal(isRequiredEditorMediaField({ id: 'audio', type: 'AUDIO' }), true);
  assert.equal(isRequiredEditorMediaField({ id: 'video', type: 'VIDEO' }), false);
});

test('first-time defaults prioritize required media and common model, prompt, and sampling controls under 64', () => {
  const fields = [
    { id: 'misc', input: 'other', type: 'BOOL', recommended: true },
    { id: 'width', input: 'width', type: 'INT' },
    { id: 'prompt', input: 'positive_prompt', type: 'STRING' },
    { id: 'lora', input: 'lora_name', type: 'STRING', recommended: false },
    { id: 'audio', input: 'audio', type: 'AUDIO' },
    { id: 'ckpt', input: 'ckpt_name', type: 'STRING', recommended: false },
    { id: 'image', input: 'image', type: 'IMAGE' },
    ...Array.from({ length: 70 }, (_item, index) => ({ id: `manual-${index}`, input: `custom_${index}`, type: 'BOOL' })),
  ];
  const selected = initialEditorFieldIds(fields);
  assert.ok(selected.includes('audio'));
  assert.ok(selected.includes('image'));
  assert.ok(selected.includes('ckpt'));
  assert.ok(selected.includes('lora'));
  assert.ok(selected.includes('prompt'));
  assert.ok(selected.includes('width'));
  assert.ok(selected.includes('misc'));
  assert.ok(selected.length <= EDITOR_INTERFACE_FIELD_LIMIT);
  assert.deepEqual(selected.slice(0, 2), ['audio', 'image']);
});

test('keeps prior selection without auto-expansion and drops a field whose type changed', () => {
  const fields = [
    { id: 'keep', input: 'custom', type: 'STRING', recommended: false },
    { id: 'changed', input: 'custom2', type: 'INT' },
    { id: 'unchecked', input: 'custom3', type: 'STRING' },
    { id: 'newRecommended', input: 'width', type: 'INT', recommended: true },
    { id: 'audio', input: 'audio', type: 'AUDIO' },
  ];
  const selected = initialEditorFieldIds(fields,
    [{ id: 'keep', type: 'STRING' }, { id: 'changed', type: 'STRING' }, { id: 'unchecked', type: 'STRING', selected: false }],
    { keep: 'outer', changed: 2, unchecked: 'still mapped in old value cache', removed: 'gone' },
    { keep: 'baseline', changed: 1 });
  assert.deepEqual(new Set(selected), new Set(['keep', 'audio']));
  assert.deepEqual(initialEditorFieldIds(fields, [{ id: 'newRecommended', type: 'INT' }]), ['audio', 'newRecommended']);
});

test('output defaults preserve available prior IDs and otherwise include every branch', () => {
  const outputs = [{ id: 'image-a' }, { id: 'image-b' }, { id: 'audio' }];
  assert.deepEqual(initialEditorOutputIds(outputs), ['image-a', 'image-b', 'audio']);
  assert.deepEqual(initialEditorOutputIds(outputs, ['image-b', 'removed']), ['image-b']);
  assert.equal(initialEditorOutputIds(outputs, []).length, 3);
});

test('type compatibility compares normalized types', () => {
  assert.equal(editorFieldTypeCompatible(' STRING ', 'string'), true);
  assert.equal(editorFieldTypeCompatible({ type: 'IMAGE' }, { type: 'image' }), true);
  assert.equal(editorFieldTypeCompatible('STRING', 'INT'), false);
  assert.equal(editorFieldTypeCompatible('', 'STRING'), false);
});

test('derives explicit input rebindings for removed, changed, and hidden connected fields', () => {
  const fields = [
    { id: 'live', label: '仍暴露', type: 'STRING' },
    { id: 'replacement', label: '替代文本', type: 'STRING' },
    { id: 'replacementFloat', label: '替代浮点', type: 'FLOAT' },
    { id: 'hidden', label: '隐藏参数', type: 'FLOAT' },
    { id: 'changed', label: '改类型', type: 'INT' },
  ];
  const previousFields = [
    { id: 'live', label: '仍暴露', type: 'STRING' },
    { id: 'removed', label: '已删除提示词', type: 'STRING' },
    { id: 'changed', label: '旧整数', type: 'STRING' },
    { id: 'hidden', label: '隐藏参数', type: 'FLOAT' },
  ];
  const connections = [
    { direction: 'input', fieldId: 'live' },
    { direction: 'input', fieldId: 'removed' },
    { direction: 'input', fieldId: 'removed' },
    { direction: 'input', fieldId: 'changed' },
    { direction: 'input', fieldId: 'hidden' },
  ];
  const result = deriveEditorRebindings({
    fields, previousFields, selectedFieldIds: ['live'], connections,
  });
  const rows = new Map(result.inputRebindings.map(row => [row.id, row]));
  assert.equal(rows.has('live'), false);
  assert.equal(rows.get('removed').label, '已删除提示词');
  assert.equal(rows.get('removed').connected, 2);
  assert.deepEqual(rows.get('removed').candidates.map(field => field.id), ['live', 'replacement']);
  assert.equal(rows.get('changed').reason, 'type_changed');
  assert.equal(rows.get('changed').candidates.some(field => field.id === 'replacement'), true);
  assert.equal(rows.get('hidden').reason, 'not_exposed');
  assert.equal(rows.get('hidden').connected, 1);
  assert.deepEqual(rows.get('hidden').candidates.map(field => field.id), ['replacementFloat']);
});

test('requires connected removed outputs to map to a selected compatible output or detach', () => {
  const outputs = [
    { id: 'image-old', label: '旧图', mediaType: 'image' },
    { id: 'image-new', label: '新图', mediaType: 'image' },
    { id: 'video-new', label: '新视频', mediaType: 'video' },
    { id: 'audio', label: '音频', mediaType: 'audio' },
  ];
  const result = deriveEditorRebindings({
    outputs,
    selectedOutputIds: ['image-new', 'audio'],
    selectedOutputs: [{ id: 'image-old', label: '旧图', mediaType: 'image' }],
    connections: [
      { direction: 'output', outputId: 'image-old' },
      { direction: 'output', outputId: 'image-old' },
      { direction: 'output', outputId: 'deleted-video', label: '被删的视频输出', mediaType: 'video' },
      { direction: 'output', outputId: 'image-new' },
    ],
  });
  const rows = new Map(result.outputRebindings.map(row => [row.id, row]));
  assert.equal(rows.size, 2);
  assert.equal(rows.get('image-old').connected, 2);
  assert.deepEqual(rows.get('image-old').candidates.map(output => output.id), ['image-new']);
  assert.equal(rows.get('deleted-video').label, '被删的视频输出');
  assert.deepEqual(rows.get('deleted-video').candidates.map(output => output.id), ['video-new']);
});

test('detects a connected output whose stable ID now carries a different media type', () => {
  const result = deriveEditorRebindings({
    outputs: [
      { id: 'stable-output', label: '同ID的新视频', mediaType: 'video' },
      { id: 'image-alternative', label: '图像替代', mediaType: 'image' },
    ],
    selectedOutputIds: ['stable-output', 'image-alternative'],
    selectedOutputs: [{ id: 'stable-output', label: '原图像输出', mediaType: '' }],
    connections: [{ direction: 'output', outputId: 'stable-output', mediaType: 'image' }],
  });
  assert.equal(result.outputRebindings.length, 1);
  assert.equal(result.outputRebindings[0].id, 'stable-output');
  assert.equal(result.outputRebindings[0].reason, 'type_changed');
  assert.equal(result.outputRebindings[0].mediaType, 'image');
  assert.deepEqual(result.outputRebindings[0].candidates.map(output => output.id), ['image-alternative']);
});

test('previews are short and safe for long prompts and undefined values', () => {
  assert.equal(shortValuePreview('  many\nlines  '), 'many lines');
  assert.equal(shortValuePreview(undefined), '（无值）');
  assert.equal(shortValuePreview('x'.repeat(200), 24).length, 24);
  assert.equal(shortValuePreview({ text: 'hello' }), '{"text":"hello"}');
});

test('UI entry points remain inert without a DOM and make no network calls', async () => {
  assert.equal(await chooseEditorInterface({ fields: [], outputs: [] }), null);
  assert.equal(await resolveEditorConflicts([{ id: 'prompt', outerValue: 'a', innerValue: 'b' }]), null);
  assert.deepEqual(await resolveEditorConflicts([]), {});
});
