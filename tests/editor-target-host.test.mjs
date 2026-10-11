import test from 'node:test';
import assert from 'node:assert/strict';
import { editorTargetHost, editorLifecycle } from '../web/editor-target-host.mjs';

const required = ['ensureBackend', 'ensureInstance', 'prepareSession', 'endSession', 'fields', 'syncOuterValues', 'applyInterface', 'applied', 'closed'];
const adapter = () => Object.fromEntries([['type', 'workspace'], ...required.map(name => [name, () => name])]);

test('legacy canvas keeps its actual host while explicit workspace cannot fall back to canvas', () => {
  const shared = { applied() { throw new Error('canvas must not be called'); } };
  assert.equal(editorTargetHost(shared, { data: {} }), shared);
  assert.throws(() => editorTargetHost(shared, { editorTargetType: 'workspace' }), /失效/);
});

test('workspace uses every owned callback and only inherits target-independent services', () => {
  const owned = adapter(), target = { editorTargetType: 'workspace' }, api = () => {};
  const shared = { api, forTarget(value) { assert.equal(value, target); return owned; } };
  for (const name of required) shared[name] = () => { throw new Error(`canvas ${name}`); };
  const host = editorTargetHost(shared, target);
  assert.equal(host.api, api); assert.equal(host.forTarget, undefined);
  for (const name of required) assert.equal(host[name](), name);
  assert.equal(shared.forTarget(target), owned);
});

for (const name of required) test(`workspace missing ${name} never borrows canvas implementation`, () => {
  const owned = adapter(); delete owned[name];
  assert.throws(() => editorTargetHost({ forTarget: () => owned, [name]: () => {} }, { editorTargetType: 'workspace' }), new RegExp(name));
});

test('adapter discriminator must match the explicit target', () => {
  for (const type of ['', 'canvas', null, 1]) assert.throws(() => editorTargetHost({ forTarget: () => ({ ...adapter(), type }) }, { editorTargetType: 'workspace' }), /不匹配/);
});

test('optional reopen and target label cannot inherit canvas navigation', () => {
  const owned = adapter(), target = { editorTargetType: 'workspace' };
  const shared = { forTarget: () => owned, reopen: () => { throw new Error('canvas navigation'); }, targetLabel: () => '画布' };
  const host = editorTargetHost(shared, target);
  assert.equal(host.reopen, undefined); assert.equal(host.targetLabel(target), '工作台');
  owned.reopen = () => 'workspace'; assert.equal(editorTargetHost(shared, target).reopen(), 'workspace');
});

test('concurrent finish calls end one session before reporting the first observed outcome', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const events = [], target = {};
  const life = editorLifecycle({ async endSession(value) { assert.equal(value, target); events.push('end'); await gate; },
    closed(value, result) { assert.equal(value, target); events.push(result); } }, target);
  const first = life.finish('applied', { workflow: { id: 'editor', revision: 4 }, reason: 'forged' });
  await life.finish('cancelled'); assert.deepEqual(events, ['end']);
  release(); await first;
  assert.deepEqual(events[1], { workflow: { id: 'editor', revision: 4 }, reason: 'applied' });
});

test('cleanup and notification failures do not suppress closed or reclassify a confirmed save', async () => {
  const outcomes = [], warnings = [];
  const life = editorLifecycle({ endSession() { throw new Error('guard cleanup'); },
    closed(_, outcome) { outcomes.push(outcome); throw new Error('draft view'); },
    toast(text) { warnings.push(text); throw new Error('notification'); } }, {});
  await life.finish('applied'); await life.finish('failed');
  assert.deepEqual(outcomes, [{ reason: 'applied' }]);
  assert.equal(warnings.length, 1); assert.match(warnings[0], /guard cleanup.*draft view/);
});
