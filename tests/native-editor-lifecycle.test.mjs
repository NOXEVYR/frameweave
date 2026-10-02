import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Reuse the real editor/controller fixture, replacing only HTTP and the bridge.
const source = await readFile(new URL('./native-editor-projection.test.mjs', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('\ntest('))
  .replace("'../web/native-workflow-editor.mjs'", JSON.stringify(new URL('../web/native-workflow-editor.mjs', import.meta.url).href))
  + '\nexport { harness, button, drafts, closes, elements };';
const { harness, button, drafts, closes, elements } = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`);
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function observe(h) {
  const outcomes = [], events = [];
  h.host.endSession = target => { assert.equal(target, h.node); events.push('end'); };
  h.host.closed = (target, outcome) => { assert.equal(target, h.node); outcomes.push(outcome); events.push('closed'); };
  return { outcomes, events };
}

test('workspace adapter controls return label, apply and close without invoking canvas callbacks', async () => {
  const h = harness(); const owned = { ...h.host, type: 'workspace', targetLabel: () => '音频工作台' };
  const outcomes = []; owned.endSession = () => {}; owned.closed = (_, value) => outcomes.push(value); owned.syncOuterValues = () => {};
  h.node.editorTargetType = 'workspace'; h.host.forTarget = target => target === h.node ? owned : null;
  for (const name of ['prepareSession', 'ensureBackend', 'ensureInstance', 'fields', 'syncOuterValues', 'applyInterface', 'applied', 'endSession']) h.host[name] = () => { throw new Error(`unexpected canvas ${name}`); };
  try {
    await h.open(); assert.ok(button(h, '← 返回音频工作台')); assert.equal(button(h, '← 返回画布'), undefined);
    await button(h, '应用参数并返回').click();
    assert.equal(h.editor.isOpen(), false); assert.equal(closes(h).length, 1);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, 'applied');
    assert.equal(h.calls.filter(item => item.kind === 'applied').length, 1);
    assert.equal(h.calls.some(item => item.path?.includes('/jobs')), false);
  } finally { await h.restore(); }
});

for (const [label, reason, saved] of [['← 返回画布', 'draft', true], ['放弃未保存修改并返回', 'cancelled', false], ['应用参数并返回', 'applied', false], ['更换工作流引擎', 'backend-switch', true]]) {
  test(`${label} reports an exact single close outcome`, async () => {
    const h = harness(); const { outcomes, events } = observe(h);
    try {
      await h.open(); await button(h, label).click();
      assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, reason); assert.equal(outcomes[0].draftSaved, saved);
      assert.equal(outcomes[0].workflow.revision, saved ? 4 : 3); assert.equal(outcomes[0].sessionCleanup, 'confirmed');
      assert.equal(drafts(h).length, saved ? 1 : 0); assert.equal(closes(h).length, 1);
      assert.deepEqual(events, ['end', 'closed']);
    } finally { await h.restore(); }
  });
}

test('cancel during backend selection cleans ownership once without opening a bridge', async () => {
  const h = harness(); const { outcomes } = observe(h); h.host.ensureBackend = async () => null;
  try {
    await h.editor.open(h.node); assert.equal(h.editor.isOpen(), false); assert.equal(closes(h).length, 0);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, 'cancelled');
    assert.equal(elements(h.body).some(item => item.tagName === 'iframe'), false);
  } finally { await h.restore(); }
});

test('opening failure cleans ownership and permits a later fresh opening', async () => {
  const h = harness(); const { outcomes } = observe(h), prepare = h.host.prepareSession;
  h.host.prepareSession = () => { throw new Error('stale draft'); };
  try {
    await assert.rejects(h.editor.open(h.node), /stale draft/);
    assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, 'failed'); assert.equal(h.editor.isOpen(), false);
    h.host.prepareSession = prepare; await h.open(); await button(h, '放弃未保存修改并返回').click();
    assert.equal(outcomes.length, 2); assert.equal(outcomes[1].reason, 'cancelled');
  } finally { await h.restore(); }
});

test('old server cleanup must complete before reopening the same target', async () => {
  const h = harness(), gate = defer(), started = defer(); const { outcomes } = observe(h), api = h.host.api;
  h.host.api = async (path, payload) => { if (path === '/api/editor-sessions/close') { started.resolve(); await gate.promise; } return api(path, payload); };
  try {
    await h.open(); const closing = button(h, '放弃未保存修改并返回').click(); await started.promise;
    assert.equal(h.editor.isOpen(), true); await assert.rejects(h.editor.open(h.node), /先关闭/); assert.equal(outcomes.length, 0);
    gate.resolve(); await closing; assert.equal(h.editor.isOpen(), false); assert.equal(outcomes.length, 1);
    await h.open(); assert.equal(h.editor.isOpen(), true);
  } finally { gate.resolve(); await h.restore(); }
});

test('session cleanup failure remains a confirmed application with an explicit cleanup warning', async () => {
  const h = harness(); const { outcomes } = observe(h), api = h.host.api;
  h.host.api = (path, payload) => path === '/api/editor-sessions/close' ? Promise.reject(new Error('connection lost')) : api(path, payload);
  try {
    await h.open(); await button(h, '应用参数并返回').click();
    assert.equal(outcomes[0].reason, 'applied'); assert.equal(outcomes[0].sessionCleanup, 'unconfirmed');
    assert.equal(h.editor.isOpen(), false); assert.ok(h.calls.some(item => item.kind === 'toast' && /清理尚未确认/.test(item.text)));
  } finally { await h.restore(); }
});

test('API conversion records saved draft even when the user subsequently discards unpersisted changes', async () => {
  const h = harness(); const { outcomes } = observe(h);
  try {
    await h.open({ '1': { class_type: 'TextNode', inputs: { text: 'converted' } } });
    await button(h, '放弃未保存修改并返回').click();
    assert.equal(outcomes[0].reason, 'cancelled'); assert.equal(outcomes[0].draftSaved, true); assert.equal(outcomes[0].workflow.revision, 4);
  } finally { await h.restore(); }
});

test('leaving during application releases session and never binds the late response to a closed target', async () => {
  const h = harness(), started = defer(), gate = defer(); const { outcomes } = observe(h);
  const released = []; h.host.releaseSession = id => released.push(id);
  h.hooks.apply = async () => { started.resolve(); await gate.promise; return { workflow: { revision: 5 }, applied: true }; };
  try {
    await h.open(); const applying = button(h, '应用参数并返回').click(); await started.promise;
    await globalThis.window.emit('pagehide'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(released.length, 1); assert.equal(outcomes.length, 1); assert.equal(outcomes[0].reason, 'failed');
    assert.equal(outcomes[0].persistenceUnknown, true); assert.equal(outcomes[0].sessionCleanup, 'requested');
    gate.resolve(); await applying;
    assert.equal(h.calls.some(item => item.kind === 'applied'), false); assert.equal(outcomes.length, 1); assert.equal(closes(h).length, 0);
  } finally { gate.resolve(); await h.restore(); }
});

test('confirmed server application with failed outer binding reports failure and is not applied twice', async () => {
  const h = harness(); const { outcomes } = observe(h);
  h.host.applied = () => { throw new Error('workspace replaced'); };
  try {
    await h.open(); await button(h, '应用参数并返回').click();
    assert.equal(h.editor.isOpen(), true); assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '放弃未保存修改并返回').click();
    assert.equal(outcomes[0].reason, 'failed'); assert.equal(outcomes[0].bindingFailed, true); assert.equal(outcomes[0].persistenceUnknown, false);
    assert.equal(h.calls.filter(item => item.kind === 'apply').length, 1);
  } finally { await h.restore(); }
});

test('first workspace initialization is awaited before synchronization and a failure blocks application', async () => {
  const h = harness(); let initializeCalls = 0;
  h.host.needsInitialization = () => true;
  h.host.initializeTarget = () => { initializeCalls++; throw new Error('unproven first control mapping'); };
  try {
    await h.open();
    assert.equal(initializeCalls, 1);
    assert.equal(button(h, '应用参数并返回').disabled, true);
    assert.equal(h.calls.some(item => item.kind === 'apply'), false);
    await button(h, '放弃未保存修改并返回').click();
    assert.equal(h.editor.isOpen(), false);
  } finally { await h.restore(); }
});
