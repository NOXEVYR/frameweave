import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture() {
  const calls = [], elements = [{ inert: false }, { inert: true }];
  const state = { composing: false, jobs: false, running: false, pending: false, editor: false, manager: false,
    media: false, canvasSaved: true, studioSaved: true };
  const context = vm.createContext({ calls, state, exitUiFrozen: false, exitUiEpoch: 0, saveTimer: null, clearTimeout, packageNodeAdds: new Map(),
    compositionGuard: { assert(message) { calls.push('composition'); if (state.composing) throw Object.assign(new Error(message), { code: 'busy' }); } },
    hasActiveJobs: () => state.jobs, workflowCanvas: { isRunning: () => state.running },
    studio: { hasPending: () => state.pending, flushDrafts() { calls.push('studio'); if (!state.studioSaved) throw new Error('storage'); } },
    nativeEditor: { isOpen: () => state.editor }, canvasWorkspace: { session: { readCurrent: () => ({ busy: state.manager }) } },
    graph: { nodes: [{ id: 'synthetic' }] }, assertCanvasMediaReady() { calls.push('media'); if (state.media) throw new Error('pending-media'); },
    nodeParameterPanel: { finishEditing() { calls.push('finish'); return true; } },
    document: { activeElement: { closest: () => ({ blur() { calls.push('blur'); } }) }, querySelectorAll: () => elements },
    finishKeyboardMove() { calls.push('keyboard'); }, save() { calls.push('canvas'); return state.canvasSaved; },
  });
  vm.runInContext(section('function flushCanvasProject()', 'function assertCanvasProjectReplaceable()') +
    section('function assertAppExitReady()', 'function renderEnvironment()'), context);
  return { calls, state, context, elements };
}

test('global IME protection cancels exit and canvas flush before blur or any draft write', () => {
  const f = fixture(); f.state.composing = true;
  for (const action of ['assertAppExitReady', 'flushCanvasProject']) assert.throws(() => f.context[action](), error => error.code === 'busy');
  assert.deepEqual(f.calls, ['composition', 'composition']);
});
test('workspace draft failure rejects exit even when canvas draft saving succeeds', () => {
  const f = fixture(); f.state.studioSaved = false;
  assert.throws(() => f.context.assertAppExitReady(), error => error.code === 'draft-save-failed' && /工作台/.test(error.message));
  assert.equal(f.calls.at(-1), 'studio'); assert.ok(f.calls.includes('canvas'));
});
test('canvas draft failure cancels exit before studio flush', () => {
  const f = fixture(); f.state.canvasSaved = false;
  assert.throws(() => f.context.assertAppExitReady(), error => error.code === 'draft-save-failed');
  assert.equal(f.calls.includes('studio'), false);
});
for (const field of ['jobs', 'running', 'pending', 'editor', 'manager', 'media']) test(`${field} protects retained tasks or drafts before exit`, () => {
  const f = fixture(); f.state[field] = true;
  assert.throws(() => f.context.assertAppExitReady(), error => error.code === 'busy');
  assert.equal(f.calls.includes('canvas'), false); assert.equal(f.calls.includes('studio'), false);
});
test('shared freeze keeps all previous inert flags and blocks a second exit until restored', () => {
  const f = fixture(); f.context.assertAppExitReady(); const restore = f.context.freezeAppForExit();
  assert.deepEqual(f.elements.map(e => e.inert), [true, true]);
  assert.throws(() => f.context.assertAppExitReady(), error => error.code === 'busy');
  restore(); assert.deepEqual(f.elements.map(e => e.inert), [false, true]); f.context.assertAppExitReady();
});

test('a pending package hydration blocks exit before any draft is flushed', () => {
  const f = fixture(); f.context.packageNodeAdds.set('pending', {});
  assert.throws(() => f.context.assertAppExitReady(), error => error.code === 'busy');
  assert.equal(f.calls.includes('canvas'), false); assert.equal(f.calls.includes('studio'), false);
});
