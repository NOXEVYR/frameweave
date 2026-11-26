import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasManager } from '../web/canvas-manager.mjs';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {};
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.classList = { add: value => { this.className += ` ${value}`; } };
  }
  get textContent() { return this._text || ''; }
  set textContent(value) { this.children.forEach(child => { child.parent = null; }); this.children = []; this._text = String(value); }
  append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...children) { this.textContent = ''; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  focus() { document.activeElement = this; }
  getContext() { return null; }
  addEventListener(name, callback) { const callbacks = this.listeners.get(name) || []; callbacks.push(callback); this.listeners.set(name, callbacks); }
  async emit(name, properties = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...properties }; await Promise.all((this.listeners.get(name) || []).map(callback => callback(event))); await settle(); return event; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) { return this.descendants().find(node => node.id === selector.slice(1)); }
}
const text = node => [node.textContent, ...node.children.map(text)].filter(Boolean).join('\n');
const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const preview = { count: 1, nodes: [{ id: 'n1', type: 'reference', x: 0, y: 0, title: '原图' }], edges: [], image: `/api/media/${'a'.repeat(32)}` };
const project = (index = 1, name = `创作 ${index}`, changes = {}) => ({ id: index.toString(16).padStart(32, '0'), name, updatedAt: 1700000000 + index, nodeCount: index, preview: null, ...changes });
function fixture(t, options = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  const root = new Element('section'); root.hidden = true;
  let state = { active: false, busy: false, ...options.current };
  const calls = [], errors = [], actions = [];
  const host = { readCurrent: () => state, reportError: error => errors.push(error),
    listProjects: async () => { calls.push('listProjects'); return options.read ? options.read() : []; } };
  for (const [key, kind] of [['onCreate', 'create'], ['onOpen', 'open'], ['onContinue', 'continue'], ['onMode', 'mode'], ['onResults', 'results']]) {
    host[key] = async (...args) => { actions.push({ kind, args }); return options[kind] ? options[kind](...args) : true; };
  }
  const manager = createCanvasManager({ root, host }); t.after(() => manager.close());
  const node = id => root.querySelector(`#canvas-manager-${id}`);
  return { root, manager, calls, actions, errors, node, text: () => text(root),
    setCurrent: next => { state = { ...state, ...next }; manager.updateCurrent(); } };
}

test('homepage stays inert while closed and reads projects only after opening', async t => {
  const h = fixture(t); await h.manager.refresh();
  assert.equal(h.root.hidden, true); assert.deepEqual(h.calls, []); assert.deepEqual(h.actions, []);
  await h.manager.open(); assert.equal(h.root.hidden, false); assert.deepEqual(h.calls, ['listProjects']);
  assert.match(h.text(), /我的画布/); assert.match(h.text(), /最近画布/);
  assert.doesNotMatch(h.text(), /版本|保存为|新画布名称|选择创作方式/);
});

test('new canvas is one large native action, needs no name, and receives no arguments', async t => {
  const h = fixture(t); await h.manager.open(); const create = h.node('create');
  assert.equal(create.tagName, 'button'); assert.equal(create.type, 'button');
  assert.equal(document.activeElement, create); assert.equal(create.attributes['aria-label'], '新建画布');
  assert.equal(h.root.descendants().filter(node => node.attributes['aria-label'] === '新建画布').length, 1);
  await create.emit('click'); assert.deepEqual(h.actions, [{ kind: 'create', args: [] }]);
});

test('empty library has a readable next step without an additional create action', async t => {
  const h = fixture(t); await h.manager.open();
  assert.match(h.text(), /第一张画布，从这里开始/); assert.match(h.text(), /点击上方「新建画布」/);
  assert.equal(h.node('list').children.length, 1); assert.equal(h.node('list').children[0].tagName, 'div');
  assert.equal(h.node('continue'), undefined);
});

test('projects are sorted by update time, with native whole-card buttons and real previews', async t => {
  const h = fixture(t, { read: async () => [project(1), project(2, '最近作品', { preview })] }); await h.manager.open();
  const cards = h.node('list').children;
  assert.equal(cards.length, 2); assert.equal(cards[0].children[0], h.node(`open-${project(2).id}`));
  assert.match(text(cards[0]), /最近作品/); assert.equal(cards[0].children[0].tagName, 'button');
  const image = cards[0].descendants().find(node => node.tagName === 'img');
  assert.equal(image.src, preview.image); assert.equal(image.loading, 'lazy');
  assert(cards[0].descendants().some(node => node.tagName === 'canvas'));
  await h.node(`open-${project(2).id}`).emit('click');
  assert.deepEqual(h.actions, [{ kind: 'open', args: [project(2).id, project(2).id] }]);
  assert.equal(h.root.hidden, false, 'the host owns navigation');
});

test('same-name projects stay separate and exact identity selects the current draft', async t => {
  const h = fixture(t, { read: async () => [project(1, '同名'), project(2, '同名')], current: { active: true, title: '继续这个', projectId: project(1).id, draftSaved: true } });
  await h.manager.open(); assert.equal(h.node('list').children.length, 2);
  assert.equal(h.node('continue'), undefined); assert.match(text(h.node(`open-${project(1).id}`)), /当前画布/);
  assert.doesNotMatch(text(h.node(`open-${project(2).id}`)), /当前画布/);
  await h.node(`open-${project(1).id}`).emit('click'); await h.node(`open-${project(2).id}`).emit('click');
  assert.deepEqual(h.actions, [{ kind: 'continue', args: [] }, { kind: 'open', args: [project(2).id, project(2).id] }]);
});

test('unidentified and unmatched drafts remain independent even with an identical title', async t => {
  for (const projectId of [undefined, 'not-in-library']) {
    const h = fixture(t, { read: async () => [project(1, '同名')], current: { active: true, title: '同名', projectId, draftSaved: false } });
    await h.manager.open(); assert.equal(h.node('list').children.length, 2);
    assert.match(text(h.node('continue')), /最近草稿|草稿待保存/);
    await h.node('continue').emit('click'); assert.deepEqual(h.actions, [{ kind: 'continue', args: [] }]);
  }
});

test('current updates render live preview and status without rereading the library', async t => {
  const h = fixture(t, { read: async () => [project()], current: { active: true, title: '早期', projectId: project().id, draftSaved: true } });
  await h.manager.open(); h.setCurrent({ title: '正在编辑', draftSaved: false, nodeCount: 9, preview });
  const card = h.node(`open-${project().id}`);
  assert.match(text(card), /正在编辑/); assert.match(text(card), /草稿待保存/); assert.match(text(card), /9 个节点/);
  assert(card.descendants().some(node => node.src === preview.image)); assert.equal(h.calls.length, 1);
  h.setCurrent({ active: false }); assert.doesNotMatch(text(h.node(`open-${project().id}`)), /当前画布/);
});

test('unknown previews and empty previews remain distinguishable', async t => {
  const h = fixture(t, { read: async () => [project(1), project(2, '空项目', { preview: { count: 0, nodes: [] } })] });
  await h.manager.open(); assert.match(text(h.node(`open-${project(1).id}`)), /暂无预览/);
  assert.match(text(h.node(`open-${project(2).id}`)), /空白画布/);
});

test('busy state blocks all transitions and refresh, including programmatic events', async t => {
  const h = fixture(t, { read: async () => [project()], current: { active: true } }); await h.manager.open(); h.setCurrent({ busy: true });
  for (const id of ['create', 'continue', `open-${project().id}`, 'refresh']) {
    assert.equal(h.node(id).disabled, true); await h.node(id).emit('click');
  }
  await h.manager.refresh(); assert.deepEqual(h.actions, []); assert.equal(h.calls.length, 1);
  assert.equal(h.node('search').disabled, true); h.setCurrent({ busy: false }); assert.equal(h.node('create').disabled, false);
});

test('double activation starts one transaction and cancellation restores controls', async t => {
  const gate = deferred(), h = fixture(t, { create: () => gate.promise }); await h.manager.open();
  const first = h.node('create').emit('click'); await settle();
  await h.node('create').emit('click');
  assert.deepEqual(h.actions, [{ kind: 'create', args: [] }]); assert.equal(h.node('create').disabled, true);
  gate.resolve(false); await first; assert.equal(h.node('create').disabled, false);
  assert.match(h.node('action-state').textContent, /已取消/); assert.equal(h.calls.length, 1);
});

test('action failure is reported once without an automatic retry', async t => {
  const failure = new Error('failed'), h = fixture(t, { create: async () => { throw failure; } });
  await h.manager.open(); await h.node('create').emit('click');
  assert.deepEqual(h.errors, [failure]); assert.equal(h.actions.length, 1); assert.match(h.node('action-state').textContent, /操作未完成/);
  assert.equal(h.node('create').disabled, false);
});

test('local search filters every project without additional reads and provides a clear no-match state', async t => {
  const h = fixture(t, { read: async () => [project(1, '月光海'), project(2, '森 林')] }); await h.manager.open();
  const input = h.node('search'); input.value = '月光'; await input.emit('input');
  assert.equal(h.node('list').children.length, 1); assert.match(h.node('list-state').textContent, /找到 1 张/);
  input.value = '没有的画布'; await input.emit('input'); assert.match(h.text(), /没有找到这张画布/);
  await h.node('search-clear').emit('click'); assert.equal(document.activeElement, input); assert.equal(input.value, '');
  assert.equal(h.node('list').children.length, 2); assert.equal(h.calls.length, 1);
});

test('IME candidates never filter or activate cards; committed Chinese filters normally', async t => {
  const h = fixture(t, { read: async () => [project(1, '中文创作'), project(2, '另一张')] }); await h.manager.open();
  const input = h.node('search'); input.value = 'zhong'; await input.emit('compositionstart'); await input.emit('input');
  assert.equal(input.disabled, false); assert.equal(h.node('create').disabled, true); assert.equal(h.node('list').children.length, 2);
  h.setCurrent({ title: '后台草稿状态变动' }); assert.equal(h.node('list').children.length, 2, 'host updates do not filter partial IME candidates');
  await h.node('create').emit('click'); await input.emit('keydown', { key: 'Enter', isComposing: true }); await input.emit('keydown', { key: 'Escape' });
  await h.manager.refresh(); assert.equal(input.value, 'zhong'); assert.equal(h.calls.length, 1); assert.deepEqual(h.actions, []);
  input.value = '中文'; await input.emit('compositionend'); await input.emit('input');
  assert.equal(h.node('list').children.length, 1); assert.match(h.text(), /中文创作/);
  assert.equal(h.node('create').disabled, false);
});

test('Enter filters, Escape clears search, and busy keyboard events preserve the current query', async t => {
  const h = fixture(t, { read: async () => [project()] }); await h.manager.open(); const input = h.node('search');
  input.value = '不存在'; assert.equal((await input.emit('keydown', { key: 'Enter' })).defaultPrevented, true);
  assert.match(h.text(), /没有找到/); assert.equal((await input.emit('keydown', { key: 'Escape' })).defaultPrevented, true);
  assert.equal(input.value, ''); input.value = '保留'; h.setCurrent({ busy: true });
  await input.emit('keydown', { key: 'Escape' }); assert.equal(input.value, '保留'); assert.equal(h.calls.length, 1);
});

test('late success or failure never overwrites newer results or releases newer loading state', async t => {
  const gates = [deferred(), deferred(), deferred(), deferred()]; let count = 0;
  const h = fixture(t, { read: () => gates[count++].promise }); const old = h.manager.open(), fresh = h.manager.refresh();
  gates[0].resolve([project(1, '迟到的画布')]); await old;
  assert.equal(h.node('refresh').disabled, true); assert.doesNotMatch(h.text(), /迟到的画布/);
  gates[1].resolve([project(2, '最新画布')]); await fresh; assert.match(h.text(), /最新画布/);
  const failedOld = h.manager.refresh(), latest = h.manager.refresh();
  gates[3].resolve([project(3, '最终画布')]); await latest; gates[2].reject(new Error('stale')); await failedOld;
  assert.match(h.text(), /最终画布/); assert.doesNotMatch(h.text(), /暂时无法读取/); assert.deepEqual(h.errors, []);
});

test('close and reopen invalidate the old read and closed clicks stay inert', async t => {
  const oldGate = deferred(), nextGate = deferred(); let reads = 0;
  const h = fixture(t, { read: () => (++reads === 1 ? oldGate : nextGate).promise });
  const old = h.manager.open(); h.manager.close(); await h.node('create').emit('click'); const latest = h.manager.open();
  oldGate.resolve([project(1, '上次开窗')]); await old; assert.doesNotMatch(h.text(), /上次开窗/);
  nextGate.resolve([project(2, '重新打开')]); await latest;
  assert.match(h.text(), /重新打开/); assert.deepEqual(h.actions, []);
});

test('search during an initial read filters the eventual result without dropping the read', async t => {
  const gate = deferred(), h = fixture(t, { read: () => gate.promise }); const initial = h.manager.open();
  h.node('search').value = '月'; await h.node('search').emit('input'); gate.resolve([project(1, '月光'), project(2, '森林')]); await initial;
  assert.equal(h.node('list').children.length, 1); assert.match(h.text(), /月光/); assert.doesNotMatch(h.text(), /森林/);
});

test('read failures and malformed data show retryable unknown state rather than healthy empty state', async t => {
  let response = new Error('read failed');
  const h = fixture(t, { read: async () => { if (response instanceof Error) throw response; return response; } });
  await h.manager.open(); assert.match(h.text(), /暂时无法读取/); assert.doesNotMatch(h.text(), /第一张画布/);
  for (const bad of [null, [project(), project()], [project(1, '坏时间', { updatedAt: 1e20 })], [project(1, '坏节点', { nodeCount: -1 })]]) {
    response = bad; await h.manager.refresh(); assert.match(h.text(), /暂时无法读取/);
  }
  response = []; await h.manager.refresh(); assert.match(h.text(), /第一张画布/); assert.equal(h.errors.length, 5);
});

test('refresh failures preserve previously readable cards and any current draft', async t => {
  let fail = false; const h = fixture(t, { read: async () => { if (fail) throw new Error('offline'); return [project()]; }, current: { active: true, title: '未归属草稿' } });
  await h.manager.open(); fail = true; await h.manager.refresh();
  assert.equal(h.node('list').children.length, 2); assert.match(h.text(), /未归属草稿/); assert.match(h.text(), /暂时无法读取/);
});

test('untrusted titles remain literal text and preview module rejects external image paths', async t => {
  const h = fixture(t, { read: async () => [project(1, '<img src="https://example.invalid/private.jpg">', { preview: { nodes: [], image: 'https://example.invalid/secret' }, directory: '/private/runtime' })] });
  await h.manager.open(); assert.match(h.text(), /<img src=/); assert.doesNotMatch(h.text(), /private\/runtime|example.invalid\/secret/);
  assert.equal(h.root.descendants().filter(node => ['img', 'iframe', 'script'].includes(node.tagName)).length, 0);
});

test('current updates preserve keyboard card focus and release detached controls', async t => {
  const h = fixture(t, { read: async () => [project()] }); await h.manager.open();
  const detached = h.node(`open-${project().id}`); detached.focus(); h.setCurrent({ title: '不会打断焦点' });
  assert.equal(document.activeElement, h.node(`open-${project().id}`)); assert.notEqual(detached, document.activeElement);
  h.setCurrent({ busy: true }); assert.equal(detached.disabled, false); assert.equal(h.node(`open-${project().id}`).disabled, true);
});

test('homepage has no duplicate results navigation or promotional copy', async t => {
  const h = fixture(t); await h.manager.open();
  assert.equal(h.node('results'), undefined); assert.doesNotMatch(h.text(), /灵感之外|每一个想法|自由创作|生成作品/);
});

test('an in-flight list finishing during IME uses the committed search instead of candidates', async t => {
  const gate = deferred(), h = fixture(t, { read: () => gate.promise }); const open = h.manager.open();
  const input = h.node('search'); await input.emit('compositionstart'); input.value = '候选拼音'; await input.emit('input');
  gate.resolve([project(1, '中文画布'), project(2, '另一个')]); await open;
  assert.equal(h.node('list').children.length, 2); assert.match(h.node('list-state').textContent, /输入法编辑中/);
  input.value = '中文'; await input.emit('compositionend'); assert.equal(h.node('list').children.length, 1);
});

test('a stale response cannot change the immutable opening target of the displayed project card', async t => {
  const oldGate = deferred(), freshGate = deferred(); let reads = 0;
  const h = fixture(t, { read: () => (++reads === 1 ? oldGate : freshGate).promise });
  const old = h.manager.open(), fresh = h.manager.refresh();
  freshGate.resolve([project(1, '最新画面', { latestId: 'b'.repeat(32), updatedAt: 1700000002 })]); await fresh;
  oldGate.resolve([project(1, '旧画面', { latestId: 'a'.repeat(32), updatedAt: 1700000001 })]); await old;
  assert.match(h.text(), /最新画面/); assert.doesNotMatch(h.text(), /旧画面/);
  await h.node(`open-${project(1).id}`).emit('click');
  assert.deepEqual(h.actions, [{ kind: 'open', args: [project(1).id, 'b'.repeat(32)] }]);
});

test('an unreadable-only library exposes retained records and refresh instead of a healthy first-use state', async t => {
  let listing = { projects: [], unreadable: 3 };
  const h = fixture(t, { read: async () => listing }); await h.manager.open();
  assert.match(h.node('list-state').textContent, /有 3 份保存记录暂时无法完整读取/);
  assert.match(h.text(), /原文件已保留/); assert.match(h.text(), /保存记录暂时无法读取/);
  assert.doesNotMatch(h.text(), /第一张画布，从这里开始/); assert.equal(h.node('refresh').disabled, false);
  listing = { projects: [project()], unreadable: 0 }; await h.node('refresh').emit('click');
  assert.equal(h.node('list').children.length, 1); assert.doesNotMatch(h.text(), /暂时无法完整读取/);
  assert.deepEqual(h.errors, []); assert.equal(h.calls.length, 2);
});

test('partial library warnings remain visible alongside cards and while filtering with no readable match', async t => {
  const h = fixture(t, { read: async () => ({ projects: [project()], unreadable: 2 }) }); await h.manager.open();
  assert(h.node(`open-${project().id}`)); assert.match(h.node('list-state').textContent, /2 份保存记录/);
  h.node('search').value = '找不到'; await h.node('search').emit('input');
  assert.match(h.text(), /没有找到可读取的画布/); assert.match(h.node('list-state').textContent, /2 份保存记录/);
  assert.doesNotMatch(h.text(), /第一张画布/); assert.equal(h.node('refresh').disabled, false);
});

test('invalid unreadable counts are treated as an unknown read failure', async t => {
  for (const unreadable of [-1, 1.5, undefined, '2']) {
    const h = fixture(t, { read: async () => ({ projects: [], unreadable }) }); await h.manager.open();
    assert.match(h.text(), /最近画布暂时无法读取/); assert.doesNotMatch(h.text(), /第一张画布/); assert.equal(h.errors.length, 1);
  }
});

test('stale unreadable counts cannot overwrite the accepted latest library status', async t => {
  const oldGate = deferred(), freshGate = deferred(); let reads = 0;
  const h = fixture(t, { read: () => (++reads === 1 ? oldGate : freshGate).promise });
  const old = h.manager.open(), fresh = h.manager.refresh();
  freshGate.resolve({ projects: [project()], unreadable: 0 }); await fresh;
  oldGate.resolve({ projects: [], unreadable: 8 }); await old;
  assert(h.node(`open-${project().id}`)); assert.doesNotMatch(h.text(), /8 份保存记录|保存记录暂时无法读取/);
});
