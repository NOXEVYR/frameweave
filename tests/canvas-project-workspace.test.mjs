import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasProjectWorkspace } from '../web/canvas-project-workspace.mjs';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = new Map(); this.attributes = {};
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.dataset = {};
    this.classList = { add: value => { this.className += ` ${value}`; }, contains: value => this.className.split(/\s+/).includes(value) };
  }
  get textContent() { return this._text || ''; }
  set textContent(value) { this.children.forEach(child => { child.parent = null; }); this.children = []; this._text = String(value); }
  get childNodes() { return this.children; }
  get lastChild() { return this.children.at(-1); }
  append(...items) { for (const item of items) { item.remove(); item.parent = this; this.children.push(item); } }
  prepend(...items) { for (const item of [...items].reverse()) { item.remove(); item.parent = this; this.children.unshift(item); } }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...items) { this.textContent = ''; this.append(...items); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  setCustomValidity(value) { this.validityMessage = value; }
  reportValidity() { return !this.validityMessage; }
  focus() { globalThis.document.activeElement = this; }
  addEventListener(name, callback) { const list = this.listeners.get(name) || []; list.push(callback); this.listeners.set(name, list); }
  async emit(name) { await Promise.all((this.listeners.get(name) || []).map(callback => callback({ target: this, preventDefault() {} }))); await settle(); }
  showModal() { this.open = true; }
  close() { this.open = false; return this.emit('close'); }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const direct = selector.startsWith(':scope > '); if (direct) selector = selector.slice(9);
    return (direct ? this.children : this.descendants()).filter(item => selector.split(',').some(value => {
      if (value.startsWith('#')) return item.id === value.slice(1);
      const [tag, cls] = value.split('.'); return (!tag || item.tagName === tag) && (!cls || item.classList.contains(cls));
    }));
  }
}
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function fixture(t) {
  const previous = ['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const body = new Element('body'), workbench = new Element('main'), actions = new Element('div');
  workbench.className = 'workbench'; actions.className = 'project-actions'; workbench.append(actions); body.append(workbench);
  globalThis.document = { body, createElement: tag => new Element(tag), querySelector: selector => body.querySelector(selector), activeElement: null };
  globalThis.window = { dispatchEvent() {} };
  t.after(() => { for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  const state = { active: true, identity: 'old', title: '旧画布', content: '原有内容', draftSaved: true, records: [], views: [], errors: [] };
  const capture = () => ({ identity: state.identity, title: state.title, content: state.content });
  const host = {
    readCurrent: () => ({ ...capture(), signature: JSON.stringify(capture()), active: state.active, draftSaved: state.draftSaved, busy: false }),
    capture, assertCurrent: ticket => assert.deepEqual(ticket, capture()), assertCanReplace() {}, flush: () => true,
    buildBundle: async () => ({ name: state.title, content: state.content }),
    saveDocument: async document => { const record = { id: (state.records.length + 1).toString(16).padStart(32, '0'), document: structuredClone(document) }; state.records.push(record); return record; },
    commitSaved(record, name) { state.title = name; return capture(); },
    emptyDocument: name => ({ name, content: '' }),
    installCreated(document, record) { state.title = document.name; state.content = ''; state.identity = record.id; return capture(); },
    onEditor() { state.views.push('editor'); },
    api: async () => ({ canvases: [], total: 0, matched: 0, unreadable: 0, offset: 0, next_offset: null }),
    reportError: error => state.errors.push(error),
  };
  const workspace = createCanvasProjectWorkspace(host);
  t.after(() => workspace.manager.close());
  return { state, workspace, node: id => body.querySelector(`#${id}`) };
}

for (const action of ['save', 'discard', 'cancel']) test(`dirty-switch ${action} stays pending during Chinese composition and works after compositionend`, async t => {
  const h = fixture(t), promise = h.workspace.session.create('新画布'); await settle();
  const name = h.node('canvas-switch-name'), dialog = h.node('canvas-switch-dialog');
  name.value = '候选名称'; await name.emit('compositionstart');
  await h.node(`canvas-switch-${action}`).emit('click');
  assert.equal(dialog.open, true); assert.equal(h.workspace.session.readCurrent().busy, true);
  assert.deepEqual(h.state.records, []); assert.equal(h.state.content, '原有内容');
  name.value = '  完整中文名称  '; await name.emit('compositionend'); await h.node(`canvas-switch-${action}`).emit('click');
  assert.equal(await promise, action !== 'cancel'); assert.equal(dialog.open, false);
  assert.equal(h.workspace.session.readCurrent().busy, false);
  if (action === 'save') {
    assert.equal(h.state.records.length, 2); assert.equal(h.state.records[0].document.name, '完整中文名称');
    assert.equal(h.state.records[0].document.content, '原有内容');
  } else if (action === 'discard') assert.equal(h.state.records.length, 1);
  else { assert.deepEqual(h.state.records, []); assert.equal(h.state.content, '原有内容'); assert.deepEqual(h.state.views, []); }
});

test('composition Escape keeps the dirty-switch dialog open, and a completed input can cancel safely', async t => {
  const h = fixture(t), promise = h.workspace.session.create('新画布'); await settle();
  const name = h.node('canvas-switch-name'), dialog = h.node('canvas-switch-dialog');
  await name.emit('compositionstart'); await dialog.emit('cancel'); assert.equal(dialog.open, true);
  await name.emit('compositionend'); await dialog.emit('cancel'); assert.equal(await promise, false);
  assert.deepEqual(h.state.records, []); assert.equal(h.state.content, '原有内容');
});

test('external dialog close releases the transaction even if composition had not delivered its end event', async t => {
  const h = fixture(t), promise = h.workspace.session.create('新画布'); await settle();
  await h.node('canvas-switch-name').emit('compositionstart'); await h.node('canvas-switch-dialog').close();
  assert.equal(await promise, false); assert.equal(h.workspace.session.readCurrent().busy, false);
  assert.deepEqual(h.state.records, []); assert.equal(h.state.content, '原有内容');
});
