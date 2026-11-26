import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkbenchCommands } from '../web/editor-workbench.mjs';

// A bounded event tree: capture/bubble order and explicit focus are significant
// here, especially when a command opens a dialog before the menu microtask runs.
class Element {
  constructor(tagName, id = '') {
    Object.assign(this, { tagName, id, children: [], listeners: new Map(), attributes: {}, open: false, disabled: false, textContent: '' });
    const classes = new Set();
    this.classList = { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) };
  }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  addEventListener(type, callback, options = false) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ callback, capture: options === true || options.capture === true }); this.listeners.set(type, listeners);
  }
  matches(selector) {
    const descendant = selector.lastIndexOf(' ');
    if (descendant !== -1) return this.matches(selector.slice(descendant + 1)) && !!this.parentElement?.closest(selector.slice(0, descendant));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const tag = selector.split('[')[0];
    if (tag && this.tagName !== tag) return false;
    return [...selector.matchAll(/\[([^\]]+)\]/g)].every(([, key]) => key === 'open' ? this.open : Object.hasOwn(this.attributes, key));
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { document.activeElement = this; }
  dispatch(type, properties = {}) {
    const event = { type, target: this, key: '', defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...properties };
    const path = []; for (let node = this; node; node = node.parentElement) path.push(node);
    const invoke = (node, capture) => { for (const listener of node.listeners.get(type) || []) if (listener.capture === capture) listener.callback(event); };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.propagationStopped) return event; }
    for (const node of path) { invoke(node, false); if (event.propagationStopped) break; }
    return event;
  }
  click() { if (!this.disabled) return this.dispatch('click'); }
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(t, options = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const doc = new Element('document'), body = new Element('body'); doc.body = body; doc.append(body); doc.activeElement = body;
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  const add = (tag, id, parent = body) => { const node = new Element(tag, id); parent.append(node); return node; };
  const saveButton = add('button', 'save-version'); saveButton.textContent = '保存版本';
  const toggle = add('button', 'toggle-inspector'), inspector = add('aside', 'editor-inspector');
  const close = add('button', 'close-inspector', inspector);
  const properties = add('button', 'tab-properties', inspector), jobs = add('button', 'tab-jobs', inspector);
  const field = add('input', 'inspector-field', inspector), outside = add('input', 'outside');
  const menus = [0, 1].map(index => {
    const menu = add('details', `menu-${index}`); menu.attributes['data-command-menu'] = '';
    return { menu, summary: add('summary', `summary-${index}`, menu), command: add('button', `command-${index}`, menu) };
  });
  const calls = { save: 0, saved: 0, errors: [], tabs: [], toggles: 0 }; let active = true;
  toggle.addEventListener('click', () => { calls.toggles++; body.classList.contains('inspector-open') ? body.classList.remove('inspector-open') : body.classList.add('inspector-open'); });
  installWorkbenchCommands({ active: () => active, save: () => { calls.save++; return options.save ? options.save() : true; },
    saved: () => calls.saved++, reportError: error => calls.errors.push(error), switchTab: tab => calls.tabs.push(tab) });
  return { doc, body, add, saveButton, toggle, inspector, close, properties, jobs, field, outside, menus, calls,
    setActive: value => { active = value; }, key: (properties = {}, target = outside) => target.dispatch('keydown', properties) };
}

test('repeated Ctrl+S and a concurrent save click share one pending save, then allow a later explicit save', async t => {
  const gate = deferred(), h = fixture(t, { save: () => gate.promise });
  assert.equal(h.key({ key: 's', ctrlKey: true }).defaultPrevented, true);
  assert.equal(h.saveButton.disabled, true); assert.equal(h.saveButton.textContent, '正在保存…');
  h.key({ key: 's', ctrlKey: true }); h.key({ key: 's', ctrlKey: true, repeat: true }); h.saveButton.click();
  assert.equal(h.calls.save, 1); assert.equal(h.calls.saved, 0);
  gate.resolve(true); await settle();
  assert.equal(h.calls.saved, 1); assert.equal(h.saveButton.disabled, false); assert.equal(h.saveButton.textContent, '保存版本');
  h.key({ key: 's', ctrlKey: true }); await settle(); assert.equal(h.calls.save, 2); assert.equal(h.calls.saved, 2);
});

test('a rejected save reports once and restores controls without retry; the next explicit command can succeed', async t => {
  const gate = deferred(), failure = new Error('保存未确认'); let attempt = 0;
  const h = fixture(t, { save: () => ++attempt === 1 ? gate.promise : true });
  h.key({ key: 's', ctrlKey: true }); h.key({ key: 's', ctrlKey: true });
  gate.reject(failure); await settle();
  assert.deepEqual(h.calls.errors, [failure]); assert.equal(h.calls.save, 1); assert.equal(h.calls.saved, 0);
  assert.equal(h.saveButton.disabled, false); assert.equal(h.saveButton.textContent, '保存版本');
  h.saveButton.click(); await settle(); assert.equal(h.calls.save, 2); assert.equal(h.calls.saved, 1);
});

test('cancelled and synchronously failed saves both release the save guard without claiming success', async t => {
  const failure = new Error('名称校验失败'); let attempt = 0;
  const h = fixture(t, { save: () => { if (++attempt === 1) return false; if (attempt === 2) throw failure; return true; } });
  for (let i = 0; i < 3; i++) { h.saveButton.click(); await settle(); assert.equal(h.saveButton.disabled, false); }
  assert.equal(h.calls.save, 3); assert.equal(h.calls.saved, 1); assert.deepEqual(h.calls.errors, [failure]);
});

test('save shortcuts respect IME, open dialogs, inactive workspaces and modified browser shortcuts', async t => {
  const h = fixture(t);
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { shiftKey: true }]) {
    assert.equal(h.key({ key: 's', ctrlKey: true, ...extra }).defaultPrevented, false);
  }
  h.setActive(false); assert.equal(h.key({ key: 's', ctrlKey: true }).defaultPrevented, false); h.saveButton.click();
  h.setActive(true); const dialog = h.add('dialog', 'modal'); dialog.open = true;
  assert.equal(h.key({ key: 's', ctrlKey: true }).defaultPrevented, false); dialog.open = false;
  assert.equal(h.key({ key: 's', ctrlKey: true, repeat: true }).defaultPrevented, true); assert.equal(h.calls.save, 0);
  assert.equal(h.key({ key: 'S', metaKey: true }).defaultPrevented, true); await settle(); assert.equal(h.calls.save, 1);
});

test('opening one native disclosure closes the other, and outside pointer dismissal preserves the current focus', t => {
  const h = fixture(t), [first, second] = h.menus;
  first.menu.open = true; second.menu.open = true; second.menu.dispatch('toggle');
  assert.equal(first.menu.open, false); assert.equal(second.menu.open, true);
  second.command.dispatch('pointerdown'); assert.equal(second.menu.open, true);
  h.outside.focus(); h.outside.dispatch('pointerdown'); assert.equal(second.menu.open, false); assert.equal(h.doc.activeElement, h.outside);
});

test('Escape closes a command menu and returns focus to its own summary before inspector dismissal', t => {
  const h = fixture(t), { menu, summary, command } = h.menus[0];
  h.body.classList.add('inspector-open'); menu.open = true; command.focus();
  const event = h.key({ key: 'Escape' }, command);
  assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true);
  assert.equal(menu.open, false); assert.equal(h.doc.activeElement, summary); assert.equal(h.calls.toggles, 0);
});

test('a focused menu command closes in a microtask and returns focus to its summary', async t => {
  const h = fixture(t), { menu, summary, command } = h.menus[0]; menu.open = true; command.focus();
  command.click(); assert.equal(menu.open, true); await settle();
  assert.equal(menu.open, false); assert.equal(h.doc.activeElement, summary);
});

test('menu dismissal never steals focus from the dialog opened by its command', async t => {
  const h = fixture(t), { menu, command } = h.menus[0];
  const dialog = h.add('dialog', 'command-dialog'), field = h.add('input', 'dialog-field', dialog);
  command.addEventListener('click', () => { dialog.open = true; field.focus(); });
  menu.open = true; command.focus(); command.click(); await settle();
  assert.equal(menu.open, false); assert.equal(dialog.open, true); assert.equal(h.doc.activeElement, field);
});

test('disabled commands do not dismiss a menu, including a synthetic captured click', async t => {
  const h = fixture(t), { menu, command } = h.menus[0]; menu.open = true; command.disabled = true;
  command.dispatch('click'); await settle(); assert.equal(menu.open, true);
});

test('inspector close button and nested Escape both return focus to the inspector toggle', t => {
  const h = fixture(t); h.body.classList.add('inspector-open'); h.close.click();
  assert.equal(h.body.classList.contains('inspector-open'), false); assert.equal(h.calls.toggles, 1); assert.equal(h.doc.activeElement, h.toggle);
  h.close.click(); assert.equal(h.calls.toggles, 1, 'closing an already closed inspector never reopens it');
  h.body.classList.add('inspector-open'); h.field.focus(); const event = h.key({ key: 'Escape' }, h.field);
  assert.equal(event.defaultPrevented, true); assert.equal(event.propagationStopped, true);
  assert.equal(h.calls.toggles, 2); assert.equal(h.doc.activeElement, h.toggle);
  assert.equal(h.key({ key: 'Escape' }).defaultPrevented, false);
});

test('composition and modal Escape leave both menus and inspector state intact', t => {
  const h = fixture(t), { menu } = h.menus[0]; menu.open = true; h.body.classList.add('inspector-open');
  for (const extra of [{ isComposing: true }, { keyCode: 229 }]) assert.equal(h.key({ key: 'Escape', ...extra }, h.field).defaultPrevented, false);
  const dialog = h.add('dialog', 'modal'); dialog.open = true;
  assert.equal(h.key({ key: 'Escape' }, h.field).defaultPrevented, false);
  assert.equal(menu.open, true); assert.equal(h.calls.toggles, 0);
});

test('inspector tabs support Left/Right wrapping and Home/End with matching panel choice and focus', t => {
  const h = fixture(t);
  for (const [origin, key, expected, tab] of [
    [h.properties, 'ArrowRight', 'jobs', h.jobs], [h.properties, 'ArrowLeft', 'jobs', h.jobs],
    [h.jobs, 'ArrowRight', 'properties', h.properties], [h.jobs, 'ArrowLeft', 'properties', h.properties],
    [h.jobs, 'Home', 'properties', h.properties], [h.properties, 'End', 'jobs', h.jobs],
  ]) {
    origin.focus(); const event = origin.dispatch('keydown', { key });
    assert.equal(event.defaultPrevented, true); assert.equal(h.calls.tabs.at(-1), expected); assert.equal(h.doc.activeElement, tab);
  }
  const count = h.calls.tabs.length;
  assert.equal(h.jobs.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(h.calls.tabs.length, count);
});
