import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePresetPrompt, presetPromptsEquivalent } from '../web/preset-editor.mjs';

test('validates and preserves unknown API prompt fields for native conversion', () => {
  const prompt = { 7: { class_type: 'CustomNode', inputs: { values: [1, ['8', 2]], extension: { flag: false } }, plugin_data: 'keep' } };
  assert.deepEqual(normalizePresetPrompt(prompt), prompt);
});

test('rejects malformed or oversized prompts before opening an editor session', () => {
  assert.throws(() => normalizePresetPrompt({}), /没有可转换/);
  assert.throws(() => normalizePresetPrompt({ 1: { class_type: 'MissingInputs' } }), /格式/);
  const large = { 1: { class_type: 'Large', inputs: { text: 'x'.repeat(16 * 1024 * 1024) } } };
  assert.throws(() => normalizePresetPrompt(large), /有效或可安全传输/);
});

test('semantic comparison ignores object key order but preserves IDs, arrays, and unknown fields', () => {
  const expected = { 1: { class_type: 'A', inputs: { values: [['2', 0], 1] }, plugin: { value: 5 } } };
  const reordered = { 1: { plugin: { value: 5 }, inputs: { values: [['2', 0], 1] }, class_type: 'A' } };
  assert.equal(presetPromptsEquivalent(expected, reordered), true);
  assert.equal(presetPromptsEquivalent(expected, { ...reordered, 2: { class_type: 'B', inputs: {} } }), false);
  assert.equal(presetPromptsEquivalent(expected, { 1: { ...reordered[1], plugin: { value: 6 } } }), false);
  assert.equal(presetPromptsEquivalent(expected, { 1: { ...reordered[1], inputs: { values: [[2, 0], 1] } } }), false);
});

test('permits only a frontend-added display title while retaining strict metadata comparison', () => {
  const expected = {
    1: { class_type: 'KSampler', inputs: { steps: 20 } },
    2: { class_type: 'NodeWithEmptyMeta', inputs: {}, _meta: {} },
  };
  const compiled = {
    1: { class_type: 'KSampler', inputs: { steps: 20 }, _meta: { title: 'KSampler' } },
    2: { class_type: 'NodeWithEmptyMeta', inputs: {}, _meta: { title: 'Custom display name' } },
  };
  assert.equal(presetPromptsEquivalent(expected, compiled), true);

  const declaredTitle = { 1: { class_type: 'KSampler', inputs: {}, _meta: { title: 'Original' } } };
  assert.equal(presetPromptsEquivalent(declaredTitle, {
    1: { class_type: 'KSampler', inputs: {}, _meta: { title: 'Changed' } },
  }), false);
  assert.equal(presetPromptsEquivalent({
    1: { class_type: 'KSampler', inputs: {}, _meta: { custom: 'preserve' } },
  }, {
    1: { class_type: 'KSampler', inputs: {}, _meta: { title: 'KSampler' } },
  }), false);
  assert.equal(presetPromptsEquivalent(expected, {
    1: { class_type: 'KSampler', inputs: { steps: 21 }, _meta: { title: 'KSampler' } },
    2: { class_type: 'NodeWithEmptyMeta', inputs: {}, _meta: { title: 'Custom display name' } },
  }), false);
});
