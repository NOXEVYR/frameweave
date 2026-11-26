import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopStatus, createDesktopClient } from '../web/desktop-client.mjs';

const status = { version: 1, supported: true, tray_ready: true, close_action: 'background', effective_close_action: 'background',
  idle_grace_seconds: 180, heartbeat_seconds: 30, command_timeout_seconds: 60, settings_available: true,
  command_pending: false, last_error: '' };
const command = action => ({ id: 'a'.repeat(32), action });
function fixture(action = null) {
  const s = { calls: [], opened: 0, guarded: 0, frozen: 0, restored: 0, exited: 0, errors: [], toasts: [], statuses: [] };
  const host = {
    async api(path, body) {
      s.calls.push({ path, body });
      if (path === '/api/desktop/heartbeat') return { session_id: 's'.repeat(32), desktop: status, command: action ? command(action) : null, notice: '' };
      if (path === '/api/desktop/complete') return { ok: true, exiting: body.approved && action === 'exit' };
      if (path === '/api/heartbeat') return { ok: true };
      throw new Error('unexpected endpoint');
    },
    beforeExit() { s.guarded++; }, openSettings() { s.opened++; },
    freezeForExit() { s.frozen++; return () => { s.restored++; }; },
    onStatus(value) { s.statuses.push(value); }, onExit() { s.exited++; },
    toast(...args) { s.toasts.push(args); }, reportError(error) { s.errors.push(error.message); },
  };
  let client;
  return { s, host, get client() { return client ||= createDesktopClient(host); } };
}

test('desktop registration sends only supported UI capabilities and reuses the owner-issued session', async () => {
  const f = fixture(); await f.client.pulse(); await f.client.pulse();
  assert.deepEqual(f.s.calls[0].body, { settings_available: true });
  assert.deepEqual(f.s.calls[1].body, { settings_available: true, session_id: 's'.repeat(32) });
  assert.equal(f.client.state().registered, true); assert.equal(f.s.statuses.length, 2); assert.equal(f.s.exited, 0);
});

test('concurrent focus/heartbeat shares one request and one delivered command', async () => {
  const f = fixture('settings'); let release;
  const original = f.host.api;
  f.host.api = async (...args) => { if (args[0] === '/api/desktop/heartbeat') await new Promise(resolve => { release = resolve; }); return original(...args); };
  const a = f.client.pulse(), b = f.client.pulse(); assert.equal(a, b); release(); await a;
  assert.equal(f.s.opened, 1); assert.equal(f.s.calls.length, 2);
});

test('settings uses the actual callback and acknowledges once; duplicate command never reopens', async () => {
  const f = fixture('settings'); await f.client.pulse(); await f.client.pulse();
  assert.equal(f.s.opened, 1); assert.equal(f.s.calls.filter(x => x.path.endsWith('/complete')).length, 1);
  assert.equal(f.s.calls[1].body.approved, true); assert.equal(f.s.exited, 0);
});

test('exit freezes UI, flushes the shared guard, then approves the exact command before stopping', async () => {
  const f = fixture('exit'); await f.client.pulse();
  assert.equal(f.s.frozen, 1); assert.equal(f.s.guarded, 1); assert.equal(f.s.exited, 1); assert.equal(f.s.restored, 0);
  assert.deepEqual(f.s.calls[1].body, { session_id: 's'.repeat(32), command_id: 'a'.repeat(32), approved: true, reason: 'handled' });
  await f.client.pulse(); assert.equal(f.s.calls.length, 2);
});

for (const reason of ['busy', 'draft-save-failed']) test(`${reason} rejects exit and restores UI without losing the guard error`, async () => {
  const f = fixture('exit'); f.host.beforeExit = () => { throw Object.assign(new Error(reason), { code: reason }); };
  await f.client.pulse(); assert.equal(f.s.exited, 0); assert.equal(f.s.restored, 0); assert.equal(f.s.frozen, 0);
  assert.equal(f.s.calls[1].body.approved, false); assert.equal(f.s.calls[1].body.reason, reason); assert.deepEqual(f.s.errors, [reason]);
});

test('server refusal after approval restores editing and reports the retained service', async () => {
  const f = fixture('exit'), api = f.host.api;
  f.host.api = async (path, body) => path.endsWith('/complete') ? (f.s.calls.push({ path, body }), { ok: false, exiting: false, error: 'tasks still active' }) : api(path, body);
  await f.client.pulse(); assert.equal(f.s.exited, 0); assert.equal(f.s.restored, 1); assert.equal(f.s.toasts[0][0], 'tasks still active');
});

test('uncertain approved exit is not automatically retried or contradicted by another acknowledgement', async () => {
  const f = fixture('exit'), api = f.host.api;
  f.host.api = async (path, body) => { if (path.endsWith('/complete')) { f.s.calls.push({ path, body }); throw new Error('reply lost'); } return api(path, body); };
  await f.client.pulse(); await f.client.pulse(); assert.equal(f.s.calls.filter(x => x.path.endsWith('/complete')).length, 1);
  assert.equal(f.s.restored, 0); assert.equal(f.client.state().awaitingExit, true); assert.equal(f.s.exited, 0); assert.match(f.s.toasts[0][0], /不会自动重试/);
});

test('approval waiting on another page stays frozen until a fresh owner heartbeat confirms cancellation', async () => {
  const f = fixture('exit'), api = f.host.api; let cancelled = false;
  f.host.api = async (path, body) => {
    if (path.endsWith('/complete')) { f.s.calls.push({ path, body }); return { ok: true, exiting: false }; }
    const value = await api(path, body);
    return path.endsWith('/heartbeat') ? { ...value, command: cancelled ? null : command('exit'), desktop: { ...status, command_pending: !cancelled } } : value;
  };
  await f.client.pulse(); await f.client.pulse();
  assert.equal(f.s.frozen, 1); assert.equal(f.s.restored, 0); assert.equal(f.client.state().awaitingExit, true);
  assert.equal(f.s.calls.filter(x => x.path.endsWith('/complete')).length, 1, 'never replay a positive approval');
  cancelled = true; await f.client.pulse();
  assert.equal(f.s.restored, 1); assert.equal(f.client.state().awaitingExit, false); assert.equal(f.s.exited, 0);
});

test('a lost approval reply followed by offline or invalid status cannot unlock newly unsafe edits', async () => {
  const f = fixture('exit'), api = f.host.api; let phase = 'approve';
  f.host.api = async (path, body) => {
    if (path.endsWith('/complete')) { f.s.calls.push({ path, body }); throw new Error('lost approval'); }
    if (phase === 'offline') throw new Error('offline');
    const value = await api(path, body);
    return phase === 'invalid' ? { ...value, desktop: { ...status, version: 99 } } : value;
  };
  await f.client.pulse(); phase = 'offline'; await assert.rejects(f.client.pulse(), /offline/);
  phase = 'invalid'; await assert.rejects(f.client.pulse(), /暂不可核实/);
  assert.equal(f.s.restored, 0); assert.equal(f.s.frozen, 1); assert.equal(f.client.state().awaitingExit, true);
  assert.equal(f.s.calls.filter(x => x.path.endsWith('/complete')).length, 1);
});

test('stop after sending approval suppresses a late exit callback and keeps editing protected', async () => {
  const f = fixture('exit'), api = f.host.api; let release, reached;
  const sent = new Promise(resolve => { reached = resolve; });
  f.host.api = async (path, body) => {
    if (path.endsWith('/complete')) { f.s.calls.push({ path, body }); reached(); return new Promise(resolve => { release = resolve; }); }
    return api(path, body);
  };
  const pending = f.client.pulse(); await sent; f.client.stop(); release({ ok: true, exiting: true }); await pending;
  assert.equal(f.s.exited, 0); assert.equal(f.s.restored, 0); assert.equal(f.s.frozen, 1);
});

test('stopping a pending heartbeat prevents a late command from opening settings or exiting', async () => {
  const f = fixture('exit'); let release; const api = f.host.api;
  f.host.api = async (...args) => { await new Promise(resolve => { release = resolve; }); return api(...args); };
  const pending = f.client.pulse(); f.client.stop(); release(); await pending;
  assert.equal(f.s.calls.length, 1); assert.equal(f.s.guarded, 0); assert.equal(f.s.exited, 0);
});

test('stop while awaiting the guard sends cancellation, never approval', async () => {
  const f = fixture('exit'); let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  f.host.beforeExit = async () => { reached(); await new Promise(resolve => { release = resolve; }); };
  const pending = f.client.pulse(); await waiting; f.client.stop(); release(); await pending;
  assert.equal(f.s.exited, 0); assert.equal(f.s.restored, 1); assert.equal(f.s.calls[1].body.approved, false); assert.equal(f.s.calls[1].body.reason, 'cancelled');
});

test('unsupported settings or future command cannot authorize an exit', async () => {
  for (const action of ['settings', 'future-command']) {
    const f = fixture(action); f.host.openSettings = null; const client = createDesktopClient(f.host); await client.pulse();
    assert.equal(f.s.exited, 0); assert.equal(f.s.calls[1].body.approved, false); assert.equal(f.s.calls[1].body.reason, 'unsupported');
  }
});

test('malformed command identifiers are ignored and cannot be interpolated into endpoints', async () => {
  const f = fixture(), api = f.host.api;
  f.host.api = async (...args) => ({ ...await api(...args), command: { id: '../exit', action: 'exit' } });
  await f.client.pulse(); assert.equal(f.s.calls.length, 1); assert.equal(f.s.exited, 0);
});

test('old server 404 falls back once to the original read-only heartbeat', async () => {
  const f = fixture(), api = f.host.api;
  f.host.api = async (...args) => { if (args[0] === '/api/desktop/heartbeat') { f.s.calls.push({ path: args[0] }); throw Object.assign(new Error('old server'), { status: 404 }); } return api(...args); };
  await f.client.pulse(); await f.client.pulse(); assert.equal(f.s.calls.filter(x => x.path.endsWith('/desktop/heartbeat')).length, 1);
  assert.equal(f.s.calls.filter(x => x.path === '/api/heartbeat').length, 2); assert.equal(f.client.state().legacy, true);
});

test('a network failure keeps the new protocol and is not mistaken for unsupported tray capability', async () => {
  const f = fixture(); f.host.api = async () => { throw new Error('offline'); };
  await assert.rejects(f.client.pulse(), /offline/); assert.equal(f.client.state().legacy, false); assert.equal(f.s.exited, 0);
});

test('invalid or contradictory desktop metadata never reaches the UI or approves commands', async () => {
  for (const patch of [{ version: 2 }, { tray_ready: true, supported: false }, { close_action: 'idle_exit', effective_close_action: 'background' }, { heartbeat_seconds: 1 }]) {
    const value = { ...status, ...patch }; assert.equal(desktopStatus(value), null);
    const f = fixture(), api = f.host.api;
    f.host.api = async (...args) => ({ ...await api(...args), desktop: value, command: command('exit') });
    await assert.rejects(f.client.pulse(), /暂不可核实/); assert.equal(f.s.statuses.length, 0); assert.equal(f.s.exited, 0);
  }
});
