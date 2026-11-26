import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubCenter } from '../web/hub-center.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.value = ''; this.disabled = false; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(v => v !== child); child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute() {}
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  emit(name) { for (const fn of this.events[name] || []) fn({ target: this }); }
  click() { if (!this.disabled) this.emit('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || selector === child.tagName || selector === '[data-hub-mutation]' && child.dataset.hubMutation); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('independent review: an in-flight enable can be explicitly paused before its probe returns', async t => {
  const before = ['document', 'setInterval', 'clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const body = new Element('body');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, hidden: false, createElement: tag => new Element(tag) } });
  globalThis.setInterval = () => 1; globalThis.clearInterval = () => {};
  t.after(() => { for (const [key, descriptor] of before) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const calls = [], state = { configured: true, enabled: false, busy: false, capabilities: [], executions: { items: [] } };
  let finishEnable;
  const center = createHubCenter({ api: async (path, data) => {
    calls.push([path, data]);
    if (path.endsWith('/enabled') && data.enabled) return new Promise(resolve => finishEnable = resolve);
    if (path.endsWith('/enabled')) return structuredClone(state);
    return structuredClone(state);
  }, reportError: () => {}, downloadJSON: () => {}, selectedRequest: async () => null });
  t.after(() => { finishEnable?.(structuredClone(state)); center.close(); });
  await center.open();
  const toggle = body.querySelectorAll('button').find(button => button.textContent.includes('自动接收任务'));
  toggle.click(); await tick();
  assert.equal(calls.filter(([path, data]) => path.endsWith('/enabled') && data.enabled).length, 1);
  assert.equal(toggle.disabled, false, '用户应能在开启核对期间暂停，而不是等开启成功');
  toggle.click(); await tick();
  assert.equal(calls.filter(([path, data]) => path.endsWith('/enabled') && data.enabled === false).length, 1);
  finishEnable({ ...structuredClone(state), enabled: true }); await tick();
  assert.match(body.textContent, /已暂停后续调度/);
  assert.doesNotMatch(body.textContent, /已启用：只自动接收/);
});
