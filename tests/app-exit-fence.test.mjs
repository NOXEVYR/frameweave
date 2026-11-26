import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
function fixture() {
  const writes = [], timers = [], elements = [{ inert: false }], state = { changes: 0 };
  const context = vm.createContext({ exitUiFrozen: false, exitUiEpoch: 0, saveTimer: null,
    document: { body: { dataset: { workspace: 'canvas', canvasView: 'editor' } }, querySelectorAll: () => elements },
    clearTimeout() {}, setTimeout(callback) { timers.push(callback); return timers.length; },
    canvasProjectActive: true, canvasDraftSaved: false, graph: { nodes: [], edges: [] }, viewport: { x: 0, y: 0, scale: 1 },
    settings: { backend_url: 'backend' }, engine: { backend_url: 'backend' },
    ensureCanvasIdentity: () => 'canvas', currentCanvasIdentity: () => 'canvas', snapshot: () => 'snapshot',
    $: () => ({}), localStorage: { setItem: (...args) => writes.push(args) },
    serializeGraph: JSON.stringify, STORAGE_KEY: 'graph', PORT_VIEW_STORAGE_KEY: 'ports', JOB_MAP_KEY: 'jobs', TITLE_STORAGE_KEY: 'title',
    jobNodes: {}, projectTitle: 'Canvas', expandedInputs: new Set(), savedPortViews: () => [], canvasWorkspace: { update() {} },
  });
  vm.runInContext(part('function mutate(', 'function layoutHistoryEntry(') +
    part('function save(', 'function flushCanvasProject()') +
    part('function installCanvasProject(', 'function undo()') +
    part('function freezeAppForExit()', 'function renderEnvironment()'), context);
  return { context, state, writes, timers, elements };
}
test('frozen real mutate and install entry points reject before any model or draft change', () => {
  const h = fixture(); h.context.freezeAppForExit();
  assert.throws(() => h.context.mutate(() => h.state.changes++), error => error.code === 'busy');
  assert.throws(() => h.context.installCanvasProject({ nodes: [], edges: [] }, 'Late'), error => error.code === 'busy');
  assert.equal(h.context.save(true), false); assert.equal(h.state.changes, 0); assert.deepEqual(h.writes, []);
});
test('a delayed autosave from before an exit attempt stays invalid after explicit cancellation', () => {
  const h = fixture(); h.context.save(); assert.equal(h.timers.length, 1);
  const restore = h.context.freezeAppForExit(); restore();
  assert.equal(h.timers[0](), false); assert.deepEqual(h.writes, []);
  assert.equal(h.context.save(true), true); assert.equal(h.writes.length, 4);
  const epoch = h.context.exitUiEpoch; restore(); assert.equal(h.context.exitUiEpoch, epoch, 'restoration is idempotent');
});
for (const key of ['workspace', 'canvasView']) test(`a late canvas operation cannot navigate after ${key} changes`, () => {
  const h = fixture(), ticket = h.context.captureCanvasProject(); h.context.assertCanvasProjectCurrent(ticket);
  h.context.document.body.dataset[key] = 'another';
  assert.throws(() => h.context.assertCanvasProjectCurrent(ticket), /操作期间.*变化/);
});
test('a captured canvas ticket cannot survive a freeze/cancel cycle even when graph and UI are unchanged', () => {
  const h = fixture(), ticket = h.context.captureCanvasProject();
  h.context.freezeAppForExit()();
  assert.throws(() => h.context.assertCanvasProjectCurrent(ticket), error => error.code === 'busy');
  h.context.assertCanvasProjectCurrent(h.context.captureCanvasProject());
});
