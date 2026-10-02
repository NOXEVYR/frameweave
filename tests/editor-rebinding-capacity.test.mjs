import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveEditorRebindings } from '../web/editor-interface-panel.mjs';

test('replacing 4096 fields shares compatible candidates without quadratic classification or retained lists', () => {
  const count = 4096;
  let typeReads = 0;
  const fields = Array.from({ length: count }, (_, i) => ({ id: `new-${i}`,
    get type() { typeReads++; return 'text'; } }));
  const previousFields = Array.from({ length: count }, (_, i) => ({ id: `old-${i}`, type: 'text' }));
  const { inputRebindings } = deriveEditorRebindings({ fields, previousFields });
  assert.equal(inputRebindings.length, count);
  assert(typeReads < count * 10, `classification repeated ${typeReads} times`);
  const groups = new Set(inputRebindings.map(row => row.candidates));
  assert.equal(groups.size, 1);
  assert.deepEqual(inputRebindings.at(-1).candidates.map(field => field.id), fields.map(field => field.id));
  assert.equal(inputRebindings.at(-1).reason, 'removed');
});

test('hidden connected fields exclude themselves while changed, missing and unknown types keep exact matching', () => {
  const fields = [{ id: 'hidden', type: 'TEXT' }, { id: 'replacement', type: 'text' },
    { id: 'changed', type: 'image' }, { id: 'number', type: 'number' }];
  const previousFields = [{ id: 'hidden', type: 'text' }, { id: 'changed', type: 'text' },
    { id: 'removed', type: 'number' }, { id: 'unknown' }];
  const before = JSON.stringify({ fields, previousFields });
  const rows = deriveEditorRebindings({ fields, previousFields,
    connections: [{ direction: 'input', fieldId: 'hidden' }] }).inputRebindings;
  const candidates = Object.fromEntries(rows.map(row => [row.id, row.candidates.map(field => field.id)]));
  assert.deepEqual(candidates, { hidden: ['replacement'], changed: ['hidden', 'replacement'],
    removed: ['number'], unknown: [] });
  assert.equal(rows.find(row => row.id === 'hidden').connected, 1);
  assert.equal(JSON.stringify({ fields, previousFields }), before);
});
