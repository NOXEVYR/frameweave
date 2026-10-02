import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioWorkflowEditor } from '../web/studio-workflow-editor.mjs';
import { studioEditorRecord, studioEditorRecovery } from '../web/studio-editor-state.mjs';

const backend = 'http://127.0.0.1:8188';
const packageId = `p-${'1'.repeat(24)}`;
const nextPackageId = `p-${'2'.repeat(24)}`;
const packageBId = `p-${'4'.repeat(24)}`;
const packageCId = `p-${'5'.repeat(24)}`;
const editorId = `e-${'3'.repeat(24)}`;
const editorBId = `e-${'4'.repeat(24)}`;
const field = { id: 'f_text', label: '文本', type: 'text', node_id: '1', input: 'text', default: 'hello' };
const prompt = { '1': { class_type: 'TextNode', inputs: { text: 'hello' } } };
const pack = { id: packageId, name: '声音包', fields: [field], prompt };
const packB = { id: packageBId, name: '音乐包', fields: [field], prompt };
const source = { workflow_id: 'wf-native', revision: 2, backend_url: backend, document_sha256: 'a'.repeat(64), prompt_sha256: 'b'.repeat(64), source_kind: 'native' };
const document = { version: 0.4, nodes: [{ id: 1, type: 'TextNode' }], links: [], last_node_id: 1, last_link_id: 0 };

function record(overrides = {}) {
  return studioEditorRecord({ editor_id: editorId, package_id: packageId, editor_backend: backend,
    editor_baseline: {}, editor_controls: [], editor_outputs: [], editor_output_fields: [], ...overrides }, 2,
  { initialized: true, sourceKind: 'native' });
}
function draft(overrides = {}) {
  return { package_id: packageId, values: { f_text: 'draft text' }, mediaBackends: {}, valuesByPackage: {},
    mediaBackendsByPackage: {}, mediaPreviewsByPackage: {}, editorBindings: {}, ...overrides };
}
function harness({ initial = draft(), sources = [source], choose, onOpen, failCommit = false, apiOverride } = {}) {
  const state = { active: 'audio', category: 'voice', epoch: 1, editEpoch: 1, navigationEpoch: 1,
    backend, draft: initial, mediaIssue: null };
  const calls = [], opened = []; let commitCount = 0;
  const context = { read: () => state, commit(next) { commitCount++; if (failCommit === true || failCommit === commitCount || typeof failCommit === 'function' && failCommit(commitCount, next)) throw new Error('disk full'); state.draft = next; },
    finished: outcome => calls.push(['finished', outcome]) };
  const host = {
    toast: (...args) => calls.push(['toast', ...args]),
    loadPackage: async id => { calls.push(['loadPackage', id]); return structuredClone(id === packageBId ? packB : id === packageCId ? { ...pack, id: packageCId, name: '更新包' } : pack); },
    chooseSource: async info => { calls.push(['chooseSource', info]); return typeof choose === 'function' ? choose(info) : choose ?? null; },
    registerTarget(target, adapter) { opened.push({ target, adapter }); calls.push(['register']); return () => calls.push(['unregister']); },
    async api(path, body) {
      calls.push(['api', path, body]);
      if (apiOverride) { const custom = await apiOverride(path, body, { sources, calls, state, document }); if (custom !== undefined) return custom; }
      if (path.endsWith('/editor-sources')) return { sources };
      if (path.endsWith('/fork-editor-source')) { const id = path.includes(packageBId) ? editorBId : editorId; return { workflow: { id, revision: 3, document: structuredClone(document) } }; }
      if (path === '/api/editor-workflows') { const id = body?.name === packB.name ? editorBId : editorId; return { id, revision: 1, document: structuredClone(document) }; }
      if (path === `/api/editor-workflows/${editorId}`) return { id: editorId, revision: 2, document: structuredClone(document) };
      if (path === `/api/editor-workflows/${editorBId}`) return { id: editorBId, revision: 3, document: structuredClone(document) };
      throw new Error(`unexpected API ${path}`);
    },
    configure: async () => ({}),
    editor: {
      async open(target) { calls.push(['editor.open', target]); await onOpen?.(opened.at(-1)); },
      async openApiPrompt(target, originalPrompt, assertCurrent) {
        calls.push(['editor.openApiPrompt', structuredClone(originalPrompt)]); assertCurrent(); await onOpen?.(opened.at(-1));
      },
    },
  };
  return { controller: createStudioWorkflowEditor(host), context, state, calls, opened, host };
}
const count = (calls, name) => calls.filter(item => item[0] === name).length;

test('single same-backend native source is forked and opened as a workspace target', async () => {
  const h = harness({ onOpen: async ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }) });
  await h.controller.open({ ...h.context });
  assert.equal(count(h.calls, 'chooseSource'), 0);
  const fork = h.calls.find(item => item[0] === 'api' && item[1].endsWith('/fork-editor-source'));
  assert.deepEqual(fork[2], Object.fromEntries(['workflow_id', 'revision', 'backend_url', 'document_sha256', 'prompt_sha256'].map(key => [key, source[key]])));
  assert.equal(count(h.calls, 'editor.open'), 1);
  assert.equal(h.opened[0].target.editorTargetType, 'workspace');
  assert.equal(h.state.draft.editorBindings[packageId].source_kind, 'native');
  assert.equal(h.state.draft.editorBindings[packageId].initialized, false);
  assert.equal(h.controller.isOpen(), false);
});

test('ambiguous sources require selection; choosing API creates a conversion view from the saved prompt', async () => {
  const h = harness({ sources: [source, { ...source, workflow_id: 'wf-second' }], choose: { kind: 'api' },
    onOpen: async ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }) });
  await h.controller.open({ ...h.context });
  assert.equal(count(h.calls, 'chooseSource'), 1);
  assert.equal(count(h.calls, 'editor.openApiPrompt'), 1);
  assert.deepEqual(h.calls.find(item => item[0] === 'editor.openApiPrompt')[1], prompt);
  assert.equal(h.state.draft.editorBindings[packageId].source_kind, 'api');
  const created = h.calls.find(item => item[0] === 'api' && item[1] === '/api/editor-workflows');
  assert.equal(created[2].source_kind, 'api');
  assert.deepEqual(created[2].document.nodes, []);
});

test('persisted binding reopens the matching instance without forking another source', async () => {
  const initial = draft({ editorBindings: { [packageId]: record() } });
  const h = harness({ initial, onOpen: async ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }) });
  await h.controller.open({ ...h.context });
  assert.equal(count(h.calls, 'editor.open'), 1);
  assert.equal(count(h.calls, 'api') && h.calls.filter(item => item[0] === 'api').some(item => item[1].endsWith('/editor-sources')), false);
  assert.equal(count(h.calls, 'api') && h.calls.filter(item => item[0] === 'api').some(item => item[1].endsWith('/fork-editor-source')), false);
});

test('a missing editor instance offers a fresh recovery source but a network failure does not', async () => {
  for (const status of [404, 503]) {
    const h = harness({ initial: draft({ editorBindings: { [packageId]: record() } }), sources: [], choose: { kind: 'api' },
      onOpen: ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }) });
    const api = h.host.api;
    h.host.api = (path, body) => path === `/api/editor-workflows/${editorId}` ? Promise.reject(Object.assign(new Error('unavailable'), { status })) : api(path, body);
    if (status === 404) {
      await h.controller.open(h.context); assert.equal(count(h.calls, 'chooseSource'), 1); assert.equal(count(h.calls, 'editor.openApiPrompt'), 1);
      assert.equal(h.state.draft.editorHistory.length, 1);
    } else {
      await assert.rejects(h.controller.open(h.context), /unavailable/); assert.equal(count(h.calls, 'chooseSource'), 0);
    }
  }
});

test('pending media upload blocks entry before package or editor side effects', async () => {
  const h = harness(); h.state.mediaIssue = '素材上传仍在进行';
  await assert.rejects(h.controller.open({ ...h.context }), /素材上传仍在进行/);
  assert.equal(count(h.calls, 'loadPackage'), 0);
  assert.equal(count(h.calls, 'api'), 0);
  assert.equal(h.controller.isOpen(), false);
});

test('canceling source choice leaves package and bindings unchanged', async () => {
  const before = structuredClone(draft());
  const h = harness({ sources: [source, { ...source, workflow_id: 'wf-second' }], choose: null });
  await h.controller.open({ ...h.context });
  assert.deepEqual(h.state.draft, before);
  assert.equal(count(h.calls, 'editor.open'), 0);
  assert.equal(h.controller.isOpen(), false);
});

test('stale category, epoch, engine, draft identity, or draft values abort an in-flight source decision', async t => {
  for (const mutate of [
    state => { state.category = 'music'; }, state => { state.epoch++; }, state => { state.editEpoch++; },
    state => { state.navigationEpoch++; }, state => { state.backend = 'http://127.0.0.1:8189'; },
    state => { state.draft = structuredClone(state.draft); }, state => { state.draft.values.f_text = 'changed concurrently'; },
  ]) await t.test(mutate.toString(), async () => {
    let h;
    h = harness({ sources: [source, { ...source, workflow_id: 'wf-second' }], choose: async () => { mutate(h.state); return { kind: 'api' }; } });
    await assert.rejects(h.controller.open({ ...h.context }), /已变化/);
    assert.equal(count(h.calls, 'api'), 1, 'only the initial source-list request is allowed');
    assert.equal(count(h.calls, 'editor.open'), 0);
    assert.equal(h.controller.isOpen(), false);
  });
});

test('initialization stores a verified baseline before marking the instance initialized', async () => {
  const h = harness({ onOpen: async ({ target, adapter }) => {
    adapter.initializeTarget(target, { output: structuredClone(prompt), controls: [
      { node_id: '1', input: 'text', widget_node_id: '1', widget_name: 'text' },
    ] }, { workflow: { revision: 4 } });
    assert.equal(h.state.draft.editorBindings[packageId].initialized, true);
    assert.deepEqual(h.state.draft.editorBindings[packageId].editor_baseline, { f_text: 'hello' });
    await adapter.closed(target, { reason: 'cancelled' });
  } });
  await h.controller.open({ ...h.context });
  assert.equal(h.state.draft.editorBindings[packageId].revision, 4);
});

test('missing initial control mapping or local commit failure never marks initialization successful', async () => {
  for (const mode of ['mapping', 'commit']) {
    const h = harness({ failCommit: mode === 'commit' ? 2 : false, onOpen: async ({ target, adapter }) => {
      const invoke = () => adapter.initializeTarget(target, { output: structuredClone(prompt), controls: mode === 'mapping' ? [] : [
        { node_id: '1', input: 'text', widget_node_id: '1', widget_name: 'text' },
      ] }, { workflow: { revision: 4 } });
      assert.throws(invoke, mode === 'mapping' ? /控件映射/ : /disk full/);
      assert.equal(h.state.draft.editorBindings[packageId].initialized, false);
      await adapter.closed(target, { reason: 'cancelled' });
    } });
    await h.controller.open({ ...h.context });
  }
});

test('failure to persist a newly forked binding keeps the outer package unchanged and never opens the editor', async () => {
  const h = harness({ failCommit: 1 });
  await assert.rejects(h.controller.open(h.context), /disk full/);
  assert.equal(h.state.draft.package_id, packageId);
  assert.deepEqual(h.state.draft.editorBindings, {});
  assert.equal(count(h.calls, 'editor.open'), 0);
  assert.equal(h.controller.isOpen(), false);
});

test('retry after local binding failure reuses the already-created exact source copy', async () => {
  const h = harness({ failCommit: 1, onOpen: async ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }) });
  await assert.rejects(h.controller.open(h.context), error => error.message.includes(editorId) && /当前页面重试可复用/.test(error.message));
  const api = h.host.api;
  h.host.api = async (path, body) => path === `/api/editor-workflows/${editorId}` ? { id: editorId, revision: 3, document } : api(path, body);
  await h.controller.open(h.context);
  assert.equal(h.calls.filter(item => item[0] === 'api' && item[1].endsWith('/fork-editor-source')).length, 1);
  assert.equal(count(h.calls, 'editor.open'), 1);
  assert.equal(h.state.draft.editorBindings[packageId].editor_id, editorId);
  assert.equal(h.state.draft.editorBindings[packageId].revision, 3);
});

test('a source copy returned while the category changes is staged before the stale-context guard and reused on return', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ apiOverride: async (path, _body, { state }) => {
    if (path.endsWith('/fork-editor-source')) { state.category = 'music'; await gate; return { workflow: { id: editorId, revision: 3, document } }; }
    if (path === `/api/editor-workflows/${editorId}`) return { id: editorId, revision: 3, document };
    return undefined;
  }, onOpen: async ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }) });
  const opening = h.controller.open(h.context);
  await new Promise(resolve => setImmediate(resolve)); release();
  await assert.rejects(opening, /已变化/);
  h.state.category = 'voice';
  await h.controller.open(h.context);
  assert.equal(h.calls.filter(item => item[0] === 'api' && item[1].endsWith('/fork-editor-source')).length, 1);
  assert.equal(h.calls.filter(item => item[0] === 'api' && item[1] === `/api/editor-workflows/${editorId}`).length, 1);
  assert.equal(h.state.draft.editorBindings[packageId].editor_id, editorId);
});

test('an unbound A copy survives creating B and is reused when the same workbench draft returns to A', async () => {
  const h = harness({ failCommit: count => count === 1,
    onOpen: async ({ target, adapter }) => adapter.closed(target, { reason: 'cancelled' }),
    apiOverride: async path => path === `/api/editor-workflows/${editorId}`
      ? { id: editorId, revision: 3, document }
      : undefined });
  await assert.rejects(h.controller.open(h.context), /当前页面重试可复用/);
  const draftRef = h.state.draft;
  draftRef.package_id = packageBId; draftRef.values = { f_text: 'B value' };
  await h.controller.open(h.context);
  assert.equal(h.state.draft.package_id, packageBId);
  h.state.draft.package_id = packageId; h.state.draft.values = { f_text: 'A value' };
  await h.controller.open(h.context);
  assert.equal(h.state.draft.editorBindings[packageId].editor_id, editorId);
  assert.equal(h.calls.filter(item => item[0] === 'api' && item[1].endsWith('/fork-editor-source') && item[1].includes(packageId)).length, 1);
  assert.equal(h.calls.filter(item => item[0] === 'api' && item[1].endsWith('/fork-editor-source') && item[1].includes(packageBId)).length, 1);
});

test('creating and applying package B preserves package A recovery state', async () => {
  const marker = { package_id: packageId, editor_id: editorId, revision: 5, reason: 'binding_failed' };
  const initial = draft({ package_id: packageBId, values: { f_text: 'B draft' },
    editorRecovery: marker, editorBindings: { [packageId]: record() } });
  const h = harness({ initial, onOpen: async ({ target, adapter }) => {
    assert.deepEqual(studioEditorRecovery(h.state.draft, packageId), marker);
    adapter.applied(target, { package: { id: packageCId, name: 'B 新包', fields: [field] }, values: { f_text: 'B applied' },
      baseline: { f_text: 'B applied' }, backend_url: backend, output_nodes: [], outputs: [], rebindings: {}, output_rebindings: {},
      workflow: { id: editorBId, revision: 4 } });
    assert.deepEqual(studioEditorRecovery(h.state.draft, packageId), marker);
    await adapter.closed(target, { reason: 'applied', workflow: { id: editorBId, revision: 4 } });
  } });
  await h.controller.open(h.context);
  assert.deepEqual(studioEditorRecovery(h.state.draft, packageId), marker);
});

test('apply moves current selection to the returned package while preserving old package cache and binding', async () => {
  const oldRecord = record();
  const initial = draft({ editorBindings: { [packageId]: oldRecord }, valuesByPackage: { [packageId]: { f_text: 'old cache' } } });
  const h = harness({ initial, onOpen: async ({ target, adapter }) => {
    const result = { package: { id: nextPackageId, name: '更新包', fields: [field] }, values: { f_text: 'edited' }, baseline: { f_text: 'edited' },
      backend_url: backend, output_nodes: [], outputs: [], rebindings: {}, output_rebindings: {}, workflow: { id: editorId, revision: 3 } };
    adapter.applied(target, result);
    assert.equal(h.state.draft.package_id, nextPackageId);
    assert.deepEqual(h.state.draft.valuesByPackage[packageId], { f_text: 'draft text' });
    assert.equal(h.state.draft.editorBindings[packageId].editor_id, editorId);
    assert.equal(h.state.draft.editorBindings[nextPackageId].revision, 3);
    await adapter.closed(target, { reason: 'applied', workflow: { id: editorId, revision: 3 } });
  } });
  await h.controller.open({ ...h.context });
});

test('unknown persistence and failed local binding are retained as recovery markers on close', async t => {
  for (const [outcome, reason] of [[{ persistenceUnknown: true }, 'unknown'], [{ bindingFailed: true }, 'binding_failed']]) {
    await t.test(reason, async () => {
      const h = harness({ onOpen: async ({ target, adapter }) => {
        await adapter.closed(target, { reason: 'failed', workflow: { id: editorId, revision: 5 }, ...outcome });
      } });
      await h.controller.open({ ...h.context });
      assert.deepEqual(h.state.draft.editorRecovery, { package_id: packageId, editor_id: editorId, revision: 5, reason });
      assert.equal(h.state.draft.editorBindings[packageId].revision, 5);
    });
  }
});
