import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceTools } from '../web/workspace-tools.mjs';

class Element {
  constructor(tag) {
    this.tagName = tag.toLowerCase(); this.children = []; this.listeners = new Map(); this.attributes = {};
    this.className = ''; this.textContent = ''; this.dataset = {}; this.open = false; this.disabled = false;
    this.classList = { contains: value => this.className.split(/\s+/).includes(value),
      add: value => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), value])].join(' '); } };
  }
  get textContent() { return this._text || ''; }
  set textContent(value) { for (const item of [...this.children]) item.remove(); this._text = String(value); }
  get childNodes() { return this.children; }
  get lastChild() { return this.children.at(-1); }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  prepend(...items) { for (const item of [...items].reverse()) { item.remove(); item.parent = this; this.children.unshift(item); } }
  after(...items) { const parent = this.parent; let offset = parent.children.indexOf(this) + 1;
    for (const item of items) { item.remove(); item.parent = parent; parent.children.splice(offset++, 0, item); } }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...items) { for (const item of [...this.children]) item.remove(); this.textContent = ''; this.append(...items); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { const handlers = this.listeners.get(name) || []; handlers.push(callback); this.listeners.set(name, handlers); }
  async emit(name) { await Promise.all((this.listeners.get(name) || []).map(callback => callback({ target: this }))); }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const direct = selector.startsWith(':scope > '); if (direct) selector = selector.slice(9);
    const matches = item => selector.split(',').some(value => {
      if (value.startsWith('#')) return item.id === value.slice(1);
      const [tag, cls] = value.split('.'); return (!tag || item.tagName === tag) && (!cls || item.classList.contains(cls));
    });
    const all = direct ? [...this.children] : this.children.flatMap(child => [child, ...child.descendants()]);
    return all.filter(matches);
  }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const summary = () => ({ version: 1, status: 'ok', measurement: 'logical_file_bytes',
  local_assets: { status: 'ok', count: 3, bytes: 1049600,
    images: { status: 'ok', count: 2, bytes: 1024 }, media: { status: 'ok', count: 1, bytes: 1048576 } },
  input_registration: { status: 'ok', count: 7, limit: 10000, remaining: 9993, protected: false } });
const visibleText = element => [element.textContent, ...element.children.map(visibleText)].filter(Boolean).join('\n');

function fixture(t, read = async () => summary()) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = new Element('body'), settings = new Element('dialog'); settings.id = 'settings-dialog'; settings.className = 'modal';
  const form = new Element('form'); form.id = 'settings-form'; const heading = new Element('div'); heading.className = 'modal-heading';
  form.append(heading); settings.append(form);
  const projects = new Element('div'); projects.className = 'project-actions'; const actions = new Element('div'); actions.className = 'top-actions';
  body.append(projects, actions, settings);
  globalThis.document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector) };
  t.after(() => { if (prior) Object.defineProperty(globalThis, 'document', prior); else delete globalThis.document; });
  const calls = [], errors = [];
  const host = { settings: () => ({ performance_profile: 'auto' }), reportError: error => errors.push(error),
    api: async (path, payload) => { calls.push({ path, payload });
      if (path === '/api/performance-plan') return { detected: {}, detail: 'existing GPU description' };
      if (path === '/api/workspace/storage') return read();
      throw new Error('unexpected request'); } };
  const tools = createWorkspaceTools(host); tools.init();
  return { tools, settings, calls, errors, info: () => body.querySelector('#workspace-storage-info'),
    refresh: () => body.querySelector('#workspace-storage-refresh'), text: () => visibleText(body.querySelector('#workspace-storage-info')),
    open: () => { const pending = tools.refreshSettings(); settings.showModal(); return pending; } };
}

test('storage is read only on explicit settings open or manual refresh, with no init or closed-settings read', async t => {
  const h = fixture(t);
  assert.deepEqual(h.calls, []);
  await h.tools.refreshSettings(); assert.equal(h.calls.filter(call => call.path === '/api/workspace/storage').length, 0);
  await h.open();
  assert.equal(h.calls.filter(call => call.path === '/api/workspace/storage').length, 1);
  await h.refresh().emit('click');
  assert.equal(h.calls.filter(call => call.path === '/api/workspace/storage').length, 2);
  assert(h.calls.every(call => call.payload === undefined), 'storage UI performs no mutation request');
  assert.match(h.text(), /图片副本：2 份 · 1.0 KiB/); assert.match(h.text(), /通用媒体副本：1 份 · 1.0 MiB/);
  assert.match(h.text(), /7 \/ 10000 条 · 剩余额度 9993 条/);
  assert.equal(h.info().attributes.role, 'status'); assert.equal(h.refresh().disabled, false);
});

test('healthy empty stores are zero while unavailable stores are never presented as zero', async t => {
  let data = summary(); data.local_assets = { status: 'ok', count: 0, bytes: 0,
    images: { status: 'ok', count: 0, bytes: 0 }, media: { status: 'ok', count: 0, bytes: 0 } };
  const h = fixture(t, async () => data); await h.open(); assert.match(h.text(), /客户端素材合计：0 份 · 0 B/);
  data = { ...data, status: 'unavailable', local_assets: { status: 'unavailable', count: null, bytes: null,
    images: { status: 'unavailable', count: null, bytes: null }, media: { status: 'unavailable', count: null, bytes: null } },
    input_registration: { status: 'unavailable', count: null, limit: 10000, remaining: null, protected: false } };
  await h.refresh().emit('click'); assert.match(h.text(), /客户端素材合计：暂不可读/); assert.doesNotMatch(h.text(), /0 份|0 B|剩余额度/);
});

test('partial scans show only statistics from this scan and protected registration exposes no usable quota', async t => {
  const data = summary(); data.status = 'partial'; data.local_assets.status = 'partial'; data.local_assets.media.status = 'partial';
  data.input_registration = { status: 'unavailable', count: 7, limit: 10000, remaining: null, protected: true };
  const h = fixture(t, async () => data); await h.open();
  assert.match(h.text(), /客户端素材合计：本次已统计 3 份.*部分暂不可读/);
  assert.match(h.text(), /通用媒体副本：本次已统计 1 份.*部分暂不可读/);
  assert.doesNotMatch(h.text(), /至少|原子|实时/);
  assert.match(h.text(), /已恢复 7 条，完整额度暂不可读/); assert.doesNotMatch(h.text(), /剩余额度|7 \/ 10000/);
});

test('unsupported schema and failed reads use a generic unknown state without leaking error paths or metadata', async t => {
  let value = { ...summary(), version: 2, path: '/private/provider', filename: 'private-name.mp4' };
  const h = fixture(t, async () => { if (value instanceof Error) throw value; return value; });
  await h.open(); assert.match(h.text(), /暂不可读.*未提供可核验/); assert.doesNotMatch(h.text(), /private|剩余额度|份/);
  value = new Error('/private/provider secret-file.mp4'); await h.refresh().emit('click');
  assert.match(h.text(), /暂不可读.*手动刷新/); assert.doesNotMatch(h.text(), /private|secret-file/); assert.equal(h.errors.length, 0);
  value = { ...summary(), path: '/private/provider', filename: 'private-name.mp4' }; await h.refresh().emit('click');
  assert.match(h.text(), /图片副本/); assert.doesNotMatch(h.text(), /private/);
});

test('malformed sizes and inconsistent registration numbers remain unknown instead of coercing or guessing', async t => {
  const data = summary(); data.local_assets.images.count = '2'; data.local_assets.media.bytes = Number.MAX_SAFE_INTEGER + 1;
  data.input_registration.remaining = 10000;
  const h = fixture(t, async () => data); await h.open();
  assert.match(h.text(), /图片副本：暂不可读/); assert.match(h.text(), /通用媒体副本：暂不可读/);
  assert.match(h.text(), /登记：暂不可读/); assert.doesNotMatch(h.text(), /剩余额度/);
});

test('registration counts above the limit remain visible with zero remaining quota and unsupported directory scans stay unknown', async t => {
  const data = summary(); data.status = 'partial'; data.local_assets = { status: 'unavailable', count: null, bytes: null,
    images: { status: 'unavailable', count: null, bytes: null }, media: { status: 'unavailable', count: null, bytes: null } };
  data.input_registration = { status: 'ok', count: 10001, limit: 10000, remaining: 0, protected: false };
  const h = fixture(t, async () => data); await h.open();
  assert.match(h.text(), /客户端素材合计：暂不可读/); assert.doesNotMatch(h.text(), /0 份|0 B/);
  assert.match(h.text(), /10001 \/ 10000 条 · 剩余额度 0 条/);
});

test('overlapping explicit refreshes ignore both late success and late failure while keeping the newest pending request disabled', async t => {
  const gates = [deferred(), deferred(), deferred(), deferred()], h = fixture(t, () => gates.shift().promise), [first, second, third, fourth] = [...gates];
  const old = h.open(); await Promise.resolve(); const fresh = h.tools.refreshSettings(); await Promise.resolve();
  const newest = summary(); newest.input_registration = { ...newest.input_registration, count: 9, remaining: 9991 };
  first.resolve(summary()); await old; assert.equal(h.refresh().disabled, true); assert.match(h.text(), /正在读取/);
  second.resolve(newest); await fresh; assert.match(h.text(), /9 \/ 10000/); assert.equal(h.refresh().disabled, false);
  const lateFailure = h.tools.refreshSettings(); await Promise.resolve();
  const current = h.tools.refreshSettings(); await Promise.resolve();
  fourth.resolve(summary()); await current; assert.match(h.text(), /7 \/ 10000/); assert.equal(h.refresh().disabled, false);
  third.reject(new Error('failed outdated request')); await lateFailure;
  assert.match(h.text(), /7 \/ 10000/); assert.doesNotMatch(h.text(), /暂不可读/); assert.equal(h.refresh().disabled, false);
});

test('closing settings invalidates an in-flight response and reopening requires a fresh read', async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const h = fixture(t, () => ++count === 1 ? first.promise : second.promise);
  const pending = h.open(); await Promise.resolve(); await h.settings.close();
  first.resolve(summary()); await pending; assert.match(h.text(), /打开设置/); assert.doesNotMatch(h.text(), /剩余额度/);
  const reopened = h.open(); await Promise.resolve(); assert.equal(count, 2);
  second.resolve(summary()); await reopened; assert.match(h.text(), /7 \/ 10000/);
  await h.settings.close(); assert.match(h.text(), /打开设置/); assert.doesNotMatch(h.text(), /剩余额度/);
});

test('a queued close event from the previous opening cannot invalidate the newly opened settings read', async t => {
  const gate = deferred(), h = fixture(t, () => gate.promise);
  const current = h.open(); await Promise.resolve();
  // Browser close events are queued: a prior close can arrive after showModal.
  await h.settings.emit('close'); assert.equal(h.settings.open, true); assert.equal(h.refresh().disabled, true);
  gate.resolve(summary()); await current; assert.match(h.text(), /7 \/ 10000/); assert.equal(h.refresh().disabled, false);
});
