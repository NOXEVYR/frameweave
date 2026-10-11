import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePresetInterfaceReceipt as resolve, preflightPresetInterfaceMigration as preflight } from '../web/preset-interface-receipt.mjs';

const field = (id = 'actual', node = '1', input = 'text', type = 'text', extra = {}) =>
  ({ id, node_id: node, input, type, label: '实际字段', ...extra });
const receipt = (logical = 'positive', targets = [field()], extra = {}) =>
  ({ logical_id: logical, type: targets[0].type, targets: targets.map(({ node_id, input, type }) => ({ node_id, input, type })), ...extra });
const fixture = () => ({ receipt: [receipt()], fields: [field()], backend: 'http://127.0.0.1:8188' });
const codes = result => (result.issues || result.diagnostics).map(item => item.code);
const edge = (extra = {}) => ({ id: 'edge-1', source: 'source', logical_id: 'positive', source_field: 'text', ...extra });

test('exact bindings preserve actual custom IDs and fresh schema while receipt composition remains metadata', () => {
  const current = field('custom-prefix', '3', 'filename_prefix', 'text', { options: ['fresh'], default: 'N', min: 0, group: '输出' });
  const data = { receipt: [receipt('output_prefix', [current], { composition: { separator: '\n\n', own_position: 'last' } })], fields: [current] };
  const before = JSON.stringify(data), result = resolve(data);
  assert.equal(result.ok, true); assert.deepEqual(result.mappings[0].fields[0], current);
  assert.equal(result.mappings[0].fields[0].id, 'custom-prefix'); assert.equal(result.mappings[0].composition.separator, '\n\n');
  assert.equal(JSON.stringify(data), before); result.mappings[0].fields[0].label = '改变副本'; assert.equal(current.label, '实际字段');
});

test('model logical IDs use dotted paths without becoming fake candidate IDs', () => {
  const current = field('real-model', '1', 'unet_name', 'select', { options: ['selected'] });
  const result = preflight({ receipt: [receipt('models.dit', [current])], fields: [current], own_values: { 'models.dit': 'selected' } });
  assert.equal(result.ok, true); assert.deepEqual(result.value_updates, [{ field_id: 'real-model', value: 'selected' }]);
});

test('one logical scalar fans out to distinct real fields without joining or inventing identity', () => {
  const fields = [field('seed-main', '1', 'seed', 'integer', { min: 0, max: 100 }), field('seed-refine', '2', 'seed', 'integer', { min: 0, max: 100 })];
  const result = preflight({ receipt: [receipt('seed', fields)], fields, own_values: { seed: 42 } });
  assert.equal(result.ready_to_apply, true); assert.deepEqual(result.value_updates, fields.map(item => ({ field_id: item.id, value: 42 })));
  assert.deepEqual(result.selected_field_ids, fields.map(item => item.id));
});

test('last fanout target range failure keeps the whole group stored-only for repair', () => {
  const fields = [field('a', '1', 'seed', 'integer', { max: 100 }), field('b', '2', 'seed', 'integer', { max: 10 })];
  const result = preflight({ receipt: [receipt('seed', fields)], fields, own_values: { seed: 42 } });
  assert.equal(result.ready_to_apply, true); assert.equal(result.has_pending_values, true); assert.deepEqual(result.value_updates, []);
  assert.deepEqual(result.stored_own_values, { a: 42, b: 42 }); assert(result.pending.some(item => item.reason === 'range_unverified'));
});

for (const [name, mutate, code] of [
  ['target absent', f => { f.fields = []; }, 'target_missing'],
  ['same label different node', f => { f.fields = [field('other', '2')]; }, 'target_missing'],
  ['same label different input', f => { f.fields = [field('other', '1', 'other')]; }, 'target_missing'],
  ['type changed', f => { f.fields[0].type = 'integer'; }, 'target_type_changed'],
  ['duplicate candidate ID', f => { f.fields.push(field('actual', '2')); }, 'duplicate_candidate_id'],
  ['same binding two candidates', f => { f.fields.push(field('other')); }, 'ambiguous_candidate_binding'],
  ['same binding different type', f => { f.fields.push(field('other', '1', 'text', 'integer')); }, 'ambiguous_candidate_binding'],
  ['duplicate logical ID', f => { f.receipt.push(receipt()); }, 'duplicate_logical_id'],
  ['two logical inputs claim same target', f => { f.receipt.push(receipt('negative')); }, 'duplicate_receipt_binding'],
  ['duplicate target inside fanout', f => { f.receipt[0].targets.push({ ...f.receipt[0].targets[0] }); }, 'duplicate_receipt_binding'],
  ['incomplete target', f => { f.receipt[0].targets = [{}]; }, 'invalid_target'],
  ['target disagrees with logical type', f => { f.receipt[0].targets[0].type = 'image'; }, 'invalid_target'],
]) test(`resolver rejects ${name} with an explicit reason`, () => {
  const data = fixture(); mutate(data); const result = resolve(data); assert.equal(result.ok, false); assert(codes(result).includes(code));
});

for (const count of [65, 256, 4096]) test(`${count} actual targets resolve with no truncation`, () => {
  const fields = Array.from({ length: count }, (_, index) => field(`f${index}`, String(index + 1), 'value', 'integer'));
  const result = resolve({ receipt: [receipt('seed', fields)], fields });
  assert.equal(result.ok, true); assert.equal(result.mappings[0].fields.length, count); assert.equal(result.mappings[0].fields.at(-1).id, `f${count - 1}`);
});

test('4097 candidates, logical rows or expanded targets are rejected', () => {
  const fields = Array.from({ length: 4097 }, (_, index) => field(`f${index}`, String(index + 1), 'value', 'integer'));
  assert.throws(() => resolve({ receipt: [receipt('seed', fields.slice(0, 4096))], fields }), /4096/);
  assert.throws(() => resolve({ receipt: [receipt('seed', fields)], fields: fields.slice(0, 4096) }), /4096/);
  assert.throws(() => resolve({ receipt: Array.from({ length: 4097 }, () => receipt()), fields: [] }), /4096/);
});

test('JSON budgets reject unsafe integers, prototypes, array holes and UTF8 overrun', () => {
  assert.throws(() => resolve({ ...fixture(), extra: undefined, fields: [field('actual', '1', 'text', 'text', { default: 2 ** 53 })] }), /JSON/);
  assert.throws(() => resolve({ receipt: [receipt()], fields: [JSON.parse('{"id":"actual","__proto__":{}}')] }), /保留字段名/);
  assert.throws(() => resolve({ receipt: [, receipt()], fields: [] }), /空槽/);
  assert.throws(() => resolve({ receipt: [receipt()], fields: [field('actual', '1', 'text', 'text', { note: '中'.repeat(710000) })] }), /2 MiB/);
  assert.throws(() => resolve({ receipt: [receipt()], fields: [new Date()] }), /JSON/);
});

test('safe named text connection produces a data-only edge plan and no connected value in own values', () => {
  const data = { ...fixture(), incoming_edges: [edge({ value: 'C must stay inert' })], own_values: { positive: '' } };
  const before = JSON.stringify(data), result = preflight(data);
  assert.equal(result.ready_to_apply, true); assert.equal(result.plan_only, true);
  assert.deepEqual(result.edge_migrations[0].field_ids, ['actual']); assert.equal(result.edge_migrations[0].source_field, 'text');
  assert.deepEqual(result.value_updates, [{ field_id: 'actual', value: '' }]); assert.equal(JSON.stringify(data), before);
});

for (const [name, incoming_edges, own_values] of [
  ['source plus own', [edge()], { positive: 'OWN' }],
  ['two explicit sources', [edge(), edge({ id: 'edge-2', source: 'other' })], {}],
  ['legacy source also contributes negative', [{ id: 'edge-1', source: 'source', logical_id: 'positive' }], {}],
]) test(`aggregation requirement for ${name} is a separate adapter todo, never C persisted as N`, () => {
  const result = preflight({ ...fixture(), incoming_edges, own_values });
  assert.equal(result.ok, true); assert.equal(result.needs_aggregation, true); assert.equal(result.ready_to_apply, false);
  assert(codes(result).includes('aggregation_required')); assert(result.unmapped.incoming_edges.length > 0);
  assert.deepEqual(result.value_updates, own_values.positive ? [{ field_id: 'actual', value: 'OWN' }] : []);
});

test('unresolved edges, values, labels and pending stay explicitly unmapped rather than disappear', () => {
  const data = { ...fixture(), incoming_edges: [edge({ logical_id: 'lost' })], own_values: { lost: 'literal' }, input_labels: { lost: '旧用途' }, pending: [{ field_id: 'lost', reason: 'upstream_not_run', edge_id: 'edge-1' }] };
  const result = preflight(data); assert.equal(result.ok, false);
  for (const key of ['incoming_edges', 'own_values', 'input_labels', 'pending']) assert.deepEqual(result.unmapped[key], data[key]);
});

test('media pending migrates full evidence and role holes without becoming a readiness claim', () => {
  const current = field('actual-image3', '9', 'image', 'image');
  const data = { receipt: [receipt('image_3', [current])], fields: [current], incoming_edges: [edge({ logical_id: 'image_3', source_field: 'image' })],
    pending: [{ field_id: 'image_3', reason: 'import_failed', origin: 'transaction', edge_id: 'edge-1', source_id: 'source', role: 'character', index: 2 }], input_labels: { image_3: '人物参考' } };
  const result = preflight(data); assert.equal(result.ready_to_apply, true); assert.equal(result.pending.length, 1);
  assert.deepEqual(result.pending[0], { ...data.pending[0], logical_id: 'image_3', field_id: 'actual-image3', node_id: '9', input: 'image', type: 'image' });
  assert.deepEqual(result.input_labels, { 'actual-image3': '人物参考' }); assert.deepEqual(result.selected_field_ids, ['actual-image3']);
});

test('empty own media remains empty and missing while selected, never populated from candidate default', () => {
  const current = field('image-actual', '1', 'image', 'image', { default: 'example.png', required: true });
  const result = preflight({ receipt: [receipt('start_image', [current])], fields: [current], own_values: { start_image: '' } });
  assert.equal(result.ok, true); assert.deepEqual(result.value_updates, [{ field_id: 'image-actual', value: '' }]);
  assert.equal(result.pending[0].reason, 'media_missing'); assert.deepEqual(result.selected_field_ids, ['image-actual']);
});

for (const otherBackend of [false, true]) test(`own media owner is preserved with ${otherBackend ? 'cross-backend pending' : 'same-backend proof'}`, () => {
  const current = field('image-actual', '1', 'image', 'image'), owner = { name: 'folder/original.png', backend: otherBackend ? 'http://127.0.0.1:8190' : 'http://localhost:8188' };
  const result = preflight({ receipt: [receipt('image_1', [current])], fields: [current], own_values: { image_1: owner.name }, media_owners: { image_1: owner }, backend: 'http://127.0.0.1:8188' });
  assert.equal(result.ok, true); assert.equal(result.media_owners['image-actual'].name, owner.name);
  assert.equal(result.media_owners['image-actual'].backend, otherBackend ? owner.backend : 'http://127.0.0.1:8188');
  assert.equal(result.pending.some(item => item.reason === 'other_backend'), otherBackend);
});

test('unknown or invalid media ownership keeps original literal/evidence but cannot imply uploaded readiness', () => {
  const current = field('image-actual', '1', 'image', 'image'), data = { receipt: [receipt('image_1', [current])], fields: [current], own_values: { image_1: 'original.png' } };
  const unknown = preflight(data); assert.equal(unknown.pending[0].reason, 'owner_unknown'); assert.equal(unknown.value_updates[0].value, 'original.png');
  const invalid = preflight({ ...data, media_owners: { image_1: { name: 'other.png', backend: 'http://127.0.0.1:8188' } } });
  assert.equal(invalid.ok, true); assert.equal(invalid.pending[0].reason, 'owner_unknown'); assert.deepEqual(invalid.media_owners, {});
  assert.deepEqual(invalid.unmapped.media_owners.image_1, { name: 'other.png', backend: 'http://127.0.0.1:8188' });
});

test('pending failed transfer is not removed by a valid old owner', () => {
  const current = field('image-actual', '1', 'image', 'image');
  const result = preflight({ receipt: [receipt('image_1', [current])], fields: [current], own_values: { image_1: 'old.png' }, media_owners: { image_1: { name: 'old.png', backend: 'http://127.0.0.1:8188' } }, backend: 'http://127.0.0.1:8188', pending: [{ field_id: 'image_1', origin: 'transaction', reason: 'import_pending' }] });
  assert.equal(result.pending[0].reason, 'import_pending'); assert.equal(result.pending[0].origin, 'transaction');
});

test('edge identity/type failures never produce a guessed migration', () => {
  for (const incoming_edges of [[edge({ source_field: 'video' })], [edge(), edge()], [edge({ source: '' })]]) {
    const result = preflight({ ...fixture(), incoming_edges }); assert.equal(result.ok, false); assert(result.unmapped.incoming_edges.length > 0);
  }
});

test('duplicate media sources are a blocking ambiguity rather than a text aggregation todo', () => {
  const current = field('image-actual', '1', 'image', 'image');
  const result = preflight({ receipt: [receipt('image_1', [current])], fields: [current], incoming_edges: [
    edge({ logical_id: 'image_1', source_field: 'image' }), edge({ id: 'edge-2', source: 'other', logical_id: 'image_1', source_field: 'image' }),
  ] });
  assert.equal(result.ok, false); assert.equal(result.needs_aggregation, false); assert(codes(result).includes('duplicate_media_input'));
});

test('unsafe own media path is retained for review and rejected without manufacturing ownership', () => {
  const current = field('image-actual', '1', 'image', 'image');
  for (const value of ['../secret.png', 'C:\\secret.png', '/secret.png', 'bad\0name.png']) {
    const result = preflight({ receipt: [receipt('image_1', [current])], fields: [current], own_values: { image_1: value } });
    assert.equal(result.ok, false); assert.deepEqual(result.value_updates, []); assert.equal(result.unmapped.own_values.image_1, value);
    assert.deepEqual(result.media_owners, {});
  }
});

test('4096-target own migration keeps the last value and last-target failure never returns a partial group', () => {
  const fields = Array.from({ length: 4096 }, (_, index) => field(`f${index}`, String(index + 1), 'seed', 'integer', { max: 100 }));
  const data = { receipt: [receipt('seed', fields)], fields, own_values: { seed: 42 } };
  const result = preflight(data); assert.equal(result.ok, true); assert.equal(result.value_updates.length, 4096);
  assert.deepEqual(result.value_updates.at(-1), { field_id: 'f4095', value: 42 });
  fields.at(-1).max = 10; const failed = preflight(data); assert.equal(failed.ok, true); assert.equal(failed.has_pending_values, true); assert.deepEqual(failed.value_updates, []);
  assert.equal(failed.stored_own_values.f4095, 42); assert.equal(data.own_values.seed, 42);
});

for (const value of ['', 'stale.safetensors']) test(`empty/stale select ${JSON.stringify(value)} stays literal and pending without selecting the first option`, () => {
  const current = field('model-actual', '1', 'unet_name', 'select', { options: ['first.safetensors'], default: 'first.safetensors' });
  const result = preflight({ receipt: [receipt('models.dit', [current])], fields: [current], own_values: { 'models.dit': value } });
  assert.equal(result.ok, true); assert.equal(result.ready_to_apply, true); assert.equal(result.has_pending_values, true);
  assert.deepEqual(result.value_updates, []); assert.equal(result.stored_own_values['model-actual'], value);
  assert.equal(result.pending[0].reason, 'selection_unverified');
});

test('wrong scalar types and absolute model paths block migration instead of becoming a resource warning', () => {
  const current = field('model-actual', '1', 'unet_name', 'select', { options: ['first'] });
  for (const value of [{ bad: true }, 'C:\\model.safetensors', '../model.safetensors']) {
    const result = preflight({ receipt: [receipt('models.dit', [current])], fields: [current], own_values: { 'models.dit': value } });
    assert.equal(result.ok, false); assert.deepEqual(result.value_updates, []); assert.deepEqual(result.stored_own_values, {});
    assert.deepEqual(result.unmapped.own_values['models.dit'], value);
  }
});

test('a connected media slot with empty own fallback can migrate, but this module makes no effective readiness claim', () => {
  const current = field('image-actual', '1', 'image', 'image');
  const result = preflight({ receipt: [receipt('image_1', [current])], fields: [current], own_values: { image_1: '' },
    incoming_edges: [edge({ logical_id: 'image_1', source_field: 'image' })], pending: [{ field_id: 'image_1', reason: 'local_only', origin: 'connected', source_id: 'source' }] });
  assert.equal(result.ready_to_apply, true); assert.equal(result.has_pending_values, true); assert.equal(result.edge_migrations.length, 1);
  assert(result.pending.some(item => item.reason === 'media_missing' && item.origin === 'own'));
  assert(result.pending.some(item => item.reason === 'local_only' && item.origin === 'connected'));
});
