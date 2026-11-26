import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateCenter } from '../web/update-center.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

function fixture(t) {
  const elements = new Map(['update-status', 'update-check', 'update-download', 'update-install', 'app-exit', 'settings-dialog']
    .map(id => [id, { disabled: false, textContent: '', open: true, addEventListener(type, handler) { this[type] = handler; } }]));
  const calls = [], errors = [], timers = [], events = [];
  let frozen = false, restores = 0, closes = 0;
  for (const [name, value] of Object.entries({
    document: { hidden: false, querySelector: selector => elements.get(selector.slice(1)) },
    window: { close() { closes++; } }, location: { reload() {} },
    setInterval: callback => { timers.push(callback); return timers.length; }, clearInterval() {},
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
  const host = {
    beforeExit() { events.push('guard'); },
    freezeForExit() { events.push('freeze'); frozen = true; return () => { events.push('restore'); frozen = false; restores++; }; },
    async api(path, body) {
      events.push(path); calls.push({ path, body });
      return path === '/api/updates' ? { current_version: '0.9.0', staged: { verified: true, version: '0.9.1' }, install_supported: true } : { ok: true, exiting: true };
    },
    reportError(error) { errors.push(error); },
  };
  const center = createUpdateCenter(host);
  return { host, center, calls, errors, timers, events, elements,
    click: id => elements.get(id).click({ currentTarget: elements.get(id) }),
    status: () => elements.get('update-status').textContent,
    state: () => ({ frozen, restores, closes }),
  };
}

test('unfinished IME refusal does not freeze, call an endpoint or disable exit permanently', async t => {
  const f = fixture(t), error = Object.assign(new Error('输入法组合输入尚未完成'), { code: 'busy' });
  f.host.beforeExit = () => { throw error; };
  await f.click('app-exit');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.state(), { frozen: false, restores: 0, closes: 0 });
  assert.equal(f.elements.get('app-exit').disabled, false); assert.equal(f.elements.get('update-install').disabled, false);
  assert.deepEqual(f.errors, [error]);
});

test('critical draft failure after an async guard freezes immediately then restores without posting', async t => {
  const f = fixture(t), guard = deferred(), error = Object.assign(new Error('草稿保存失败'), { code: 'draft-save-failed' });
  f.host.beforeExit = () => { f.events.push('guard'); return guard.promise; };
  const pending = f.click('app-exit');
  assert.deepEqual(f.events, ['guard', 'freeze']); assert.equal(f.state().frozen, true); assert.equal(f.calls.length, 0);
  guard.reject(error); await pending;
  assert.equal(f.state().frozen, false); assert.equal(f.state().restores, 1); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, [error]); assert.equal(f.elements.get('app-exit').disabled, false);
});

for (const [id, path] of [['app-exit', '/api/exit'], ['update-install', '/api/updates/install']]) {
  test(`${id} keeps editing frozen throughout guard and POST, and after confirmed exit`, async t => {
    const f = fixture(t), guard = deferred(), response = deferred();
    f.host.beforeExit = () => { f.events.push('guard'); return guard.promise; };
    f.host.api = (url, body) => { f.calls.push({ path: url, body }); return response.promise; };
    const pending = f.click(id);
    assert.equal(f.state().frozen, true); assert.equal(f.calls.length, 0);
    guard.resolve(); await Promise.resolve();
    assert.deepEqual(f.calls, [{ path, body: {} }]);
    assert.equal(f.state().frozen, true); assert.equal(f.elements.get('app-exit').disabled, true);
    assert.equal(f.elements.get('update-install').disabled, true);
    await f.click(id); assert.equal(f.calls.length, 1, 'cannot replay while waiting');
    response.resolve({ ok: true, exiting: true }); await pending;
    assert.equal(f.state().frozen, true); assert.equal(f.state().restores, 0);
    await f.center.refresh(); assert.equal(f.calls.length, 1);
    assert.match(f.status(), id === 'app-exit' ? /已接受退出请求，正在退出/ : /正在退出并更新/);
  });
}

for (const code of [400, 403, 409]) test(`explicit ${code} refusal restores editing and preserves the original disabled state`, async t => {
  const f = fixture(t), error = Object.assign(new Error('服务明确拒绝退出'), { status: code });
  f.elements.get('update-install').disabled = true;
  f.host.api = async (path, body) => { f.calls.push({ path, body }); throw error; };
  await f.click('app-exit');
  assert.equal(f.state().frozen, false); assert.equal(f.state().restores, 1);
  assert.equal(f.elements.get('app-exit').disabled, false); assert.equal(f.elements.get('update-install').disabled, true);
  assert.deepEqual(f.errors, [error]); assert.equal(f.calls.length, 1);
});

for (const value of ['lost', { ok: true, exiting: false }, { ok: 'true', exiting: true }, { ok: true, exiting: 1 }, null]) {
  test(`uncertain exit result ${JSON.stringify(value)} keeps editing frozen and never automatically retries`, async t => {
    const f = fixture(t);
    f.host.api = async (path, body) => { f.calls.push({ path, body }); if (value === 'lost') throw new Error('回复丢失'); return value; };
    await f.click('app-exit');
    assert.equal(f.state().frozen, true); assert.equal(f.state().restores, 0); assert.equal(f.state().closes, 0);
    assert.equal(f.elements.get('app-exit').disabled, true); assert.equal(f.elements.get('update-install').disabled, true);
    assert.match(f.status(), /不会自动重试.*浏览器刷新页面重新核实服务状态/);
    await f.click('app-exit'); await f.click('update-install'); await f.click('update-check');
    await f.center.refresh(); await f.timers[0]();
    assert.equal(f.calls.length, 1); assert.equal(f.errors.length, 1);
  });
}

test('a server error with an unknown exit outcome is not treated as an explicit rejection', async t => {
  const f = fixture(t);
  f.host.api = async (path, body) => { f.calls.push({ path, body }); throw Object.assign(new Error('server failure'), { status: 502 }); };
  await f.click('update-install');
  assert.equal(f.state().frozen, true); assert.equal(f.state().restores, 0); assert.equal(f.calls.length, 1);
  assert.match(f.status(), /退出结果尚未确认/);
});

for (const [id, path] of [['update-check', '/api/updates/check'], ['update-download', '/api/updates/stage']]) {
  test(`${id} preserves the ordinary update flow without invoking the exit guard or freezing`, async t => {
    const f = fixture(t); await f.click(id);
    assert.deepEqual(f.calls.map(call => call.path), [path, '/api/updates']);
    assert.equal(f.state().frozen, false); assert.equal(f.state().restores, 0);
    assert.equal(f.events.includes('guard'), false); assert.equal(f.events.includes('freeze'), false);
  });
}

test('an older refresh reply cannot overwrite uncertain exit feedback or reenable installation', async t => {
  const f = fixture(t), read = deferred();
  f.host.api = async (path, body) => { f.calls.push({ path, body }); if (path === '/api/updates') return read.promise; throw new Error('reply lost'); };
  const refreshing = f.center.refresh(); await f.click('app-exit');
  read.resolve({ current_version: '0.9.0', staged: { verified: true, version: '0.9.1' }, install_supported: true }); await refreshing;
  assert.match(f.status(), /不会自动重试/); assert.equal(f.elements.get('update-install').disabled, true);
  assert.equal(f.state().frozen, true); assert.equal(f.state().restores, 0);
});

test('accepted direct exit explains the explicit browser refresh fallback without automatically restoring or retrying', async t => {
  const f = fixture(t); await f.click('app-exit');
  assert.match(f.status(), /浏览器刷新页面重新核实服务状态/);
  assert.equal(f.state().restores, 0); assert.equal(f.calls.length, 1); assert.equal(f.state().frozen, true);
});
