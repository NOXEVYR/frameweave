import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createNode, generationPayload } from '../web/graph.mjs';

const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const part = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
class Element extends EventTarget {
  constructor(tag, document) { super(); Object.assign(this, { tagName: tag.toUpperCase(), ownerDocument: document, children: [], dataset: {}, style: {}, className: '', value: '', listeners: new Map() }); }
  addEventListener(type, listener, options) { super.addEventListener(type, listener, options); if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  append(...children) { for (const child of children) { child.remove(); child.parentNode = this; this.children.push(child); } }
  remove() { if (this.parentNode) { const p = this.parentNode; p.children.splice(p.children.indexOf(this), 1); this.parentNode = null; } }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  setAttribute(key, value) { this[key] = value; }
  contains(item) { return item === this || this.children.some(child => child.contains(item)); }
  matches(selector) { return selector.split(',').some(token => { token = token.trim(); if (token[0] === '.') return this.className.split(' ').includes(token.slice(1)); if (token[0] === '#') return this.id === token.slice(1); return token.toUpperCase() === this.tagName; }); }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelector(selector) { return this.children.find(child => child.matches(selector)) || this.children.map(child => child.querySelector(selector)).find(Boolean) || null; }
  checkValidity() { return true; }
  focus() { this.ownerDocument.activeElement = this; this.dispatchEvent(new Event('focus')); }
  blur() { this.ownerDocument.activeElement = null; this.dispatchEvent(new Event('blur')); }
  fire(type) { const event = new Event(type, { cancelable: true }); this.dispatchEvent(event); return event; }
}
const flatten = root => [root, ...root.children.flatMap(flatten)];
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const document = { activeElement: null, body: { dataset: { workspace: 'canvas', canvasView: 'editing' }, classList: { contains: name => name === 'inspector-open' && state.inspectorOpen } }, createElement: tag => new Element(tag, document), getElementById: () => ({}) };
  const content = new Element('div', document); content.id = 'inspector-content';
  const node = createNode('generation', 0, 0, { kind: 'sdxl', positive: 'original', seed: 7 }); node.id = 'same';
  const state = { identity: 'canvas-A', redraws: 0, mutations: 0, runs: 0, composing: false, deferred: null, syncs: [], tasks: [] };
  const sandbox = { window: { matchMedia: () => ({ matches: !!state.compact }) }, exitUiFrozen: false, exitUiEpoch: 0, document, graph: { nodes: [node], edges: [] }, canvas: { offsetParent: {} }, selected: new Set([node.id]), selectedEdge: null,
    settings: { backend_url: 'http://127.0.0.1:8188' }, engine: { models: {}, generation_options: {} }, parameterOwner: null, parameterRenderGuard: null,
    activeSidebarPackage: null, sidebarPackageLoads: new WeakMap(), packageCatalog: { peek() {} }, spaceDown: false, tool: 'select', draftEditing: null,
    currentCanvasIdentity: () => state.identity, singleSelected: () => sandbox.selected.size === 1 ? sandbox.graph.nodes.find(item => sandbox.selected.has(item.id)) : null,
    getNode: id => sandbox.graph.nodes.find(item => item.id === id), $: () => content,
    queueMicrotask: callback => state.tasks.push(callback), reportError: error => { throw error; }, toast() {}, renderNodes() {}, updateNodeJobStatus() {},
    mutate: callback => { callback(); state.mutations++; },
    nodeParameterPanel: { isComposing: () => state.composing, blocked: () => content.contains(document.activeElement), contains: target => content.contains(target),
      defer: (callback, options) => { state.deferred = { callback, options }; }, finishEditing: () => { document.activeElement?.blur(); },
      sync: options => state.syncs.push(options), suspend() {}, reset() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(part('function el(', 'function bind(') + part('function editNode(', 'function section(')
    + part('function parameterBindingSignature(', 'function renderInspectorContent(')
    + part('function canvasIsActive(', 'function updateCanvasActions('), sandbox);
  sandbox.renderInspectorContent = () => {
    state.redraws++; content.replaceChildren(); const wrap = sandbox.el('div', 'inspector-content-wrap');
    const selected = sandbox.singleSelected(); if (!selected || sandbox.selectedEdge) { content.append(wrap); return; }
    wrap.append(sandbox.field('正向提示词', selected.data.positive, value => sandbox.editNode(selected.id, 'positive', value), { multiline: true }),
      sandbox.field('随机种子', selected.data.seed, value => sandbox.editNode(selected.id, 'seed', value), { number: true, min: 0 }),
      sandbox.button('开始生成', 'inspector-run', () => { state.runs++; })); content.append(wrap);
  };
  const input = label => flatten(content).find(item => item['aria-label'] === label);
  const button = () => flatten(content).find(item => item.tagName === 'BUTTON');
  const render = () => sandbox.renderInspector(); render();
  return { sandbox, state, node, document, content, input, button, render, owner: () => sandbox.parameterOwner, flush: () => { for (const callback of state.tasks.splice(0)) callback(); } };
}

test('actual field callbacks edit one graph owner and preserve empty text and numeric zero in the existing generation payload', () => {
  const h = harness(), text = h.input('正向提示词'), seed = h.input('随机种子');
  text.value = ''; text.fire('input'); seed.value = '0'; seed.fire('change');
  assert.equal(h.node.data.positive, ''); assert.equal(h.node.data.seed, 0); assert.equal(h.state.mutations, 2);
  const payload = generationPayload(h.sandbox.graph, h.node.id); assert.equal(payload.positive, ''); assert.equal(payload.seed, 0);
  assert.equal(flatten(h.content).filter(item => item.tagName === 'TEXTAREA').length, 1);
});

for (const [name, expire] of [
  ['another canvas with the same node ID', h => { h.state.identity = 'canvas-B'; h.sandbox.graph.nodes = [{ ...h.node, data: { ...h.node.data, positive: 'new canvas' } }]; }],
  ['replaced node object', h => { h.sandbox.graph.nodes = [{ ...h.node, data: { ...h.node.data, positive: 'replacement' } }]; }],
  ['changed source signature', h => { h.node.data.package_id = 'different-source'; }],
  ['management view', h => { h.document.body.dataset.canvasView = 'management'; }],
]) test(`retired detached input/change/blur/click cannot edit or run after ${name}`, async () => {
  const h = harness(), text = h.input('正向提示词'), seed = h.input('随机种子'), run = h.button();
  const callbacks = [...text.listeners.get('input')]; text.remove(); seed.remove(); run.remove(); expire(h);
  const before = JSON.stringify(h.sandbox.graph); text.value = 'late'; seed.value = '42';
  assert.equal(text.fire('input').defaultPrevented, true); seed.fire('change'); text.fire('blur'); run.fire('click');
  // A captured old live-draft callback is guarded even when invoked without DOM dispatch.
  callbacks.at(-1)(); await tick(); h.flush();
  assert.equal(JSON.stringify(h.sandbox.graph), before); assert.equal(h.state.mutations, 0); assert.equal(h.state.runs, 0); assert.equal(h.state.redraws, 1);
});

test('a queued button action rechecks its owner before the microtask can submit', async () => {
  const h = harness(); h.button().fire('click'); h.state.identity = 'canvas-B'; await tick(); assert.equal(h.state.runs, 0);
});

test('an individually detached old control is inert even if its canvas, node and source remain current', async () => {
  const h = harness(), text = h.input('正向提示词'), run = h.button(); text.remove(); run.remove();
  text.value = 'detached'; text.fire('input'); text.fire('change'); run.fire('click'); await tick();
  assert.equal(h.node.data.positive, 'original'); assert.equal(h.state.mutations, 0); assert.equal(h.state.runs, 0);
});

test('same owner keeps focused controls and defers external refresh until editing leaves', () => {
  const h = harness(), input = h.input('正向提示词'); input.focus(); input.value = 'draft'; input.fire('input');
  h.render(); assert.equal(h.input('正向提示词'), input); assert.equal(h.state.redraws, 1); assert(h.state.deferred);
  input.blur(); h.flush(); assert.equal(h.node.data.positive, 'draft'); assert.equal(h.state.redraws, 2);
  const mutations = h.state.mutations; input.value = 'retired'; input.fire('input'); assert.equal(h.state.mutations, mutations);
});

test('IME source replacement preserves old DOM until composition ends, then old callbacks stay inert', () => {
  const h = harness(), input = h.input('正向提示词'); input.focus(); h.state.composing = true;
  h.sandbox.graph.nodes = [{ ...h.node, data: { ...h.node.data, positive: 'restored' } }]; h.render();
  assert.equal(h.input('正向提示词'), input); assert.equal(h.state.redraws, 1); assert.equal(h.state.deferred.options.compositionOnly, true);
  input.value = 'late IME'; input.fire('input'); assert.equal(h.sandbox.graph.nodes[0].data.positive, 'restored');
  h.state.composing = false; h.state.deferred.callback(); assert.equal(h.state.redraws, 2); assert.notEqual(h.input('正向提示词'), input);
});

test('schema redraw retires callbacks but keeps the selected-node docking identity', () => {
  const h = harness(), owner = h.owner(), input = h.input('正向提示词'); h.node.data.custom_size = true; h.render();
  assert.notEqual(h.owner(), owner); assert.equal(h.owner().binding, owner.binding); assert.equal(owner.current(), false);
  input.value = 'retired'; input.fire('change'); assert.equal(h.node.data.positive, 'original');
});

test('multi-selection and selected edges revoke the old parameter owner', () => {
  const h = harness(), old = h.input('正向提示词'); const second = createNode('prompt'); h.sandbox.graph.nodes.push(second); h.sandbox.selected.add(second.id); h.render();
  old.value = 'late'; old.fire('input'); assert.equal(h.node.data.positive, 'original'); assert.equal(h.owner(), null);
  h.sandbox.selected = new Set([h.node.id]); h.render(); const next = h.input('正向提示词'); h.sandbox.selectedEdge = 'edge'; h.render();
  next.value = 'late edge'; next.fire('change'); assert.equal(h.node.data.positive, 'original'); assert.equal(h.owner(), null);
});

test('actual document keyboard handler leaves docked original parameter inputs and buttons to native editing', () => {
  const h = harness(); let listener; h.document.addEventListener = (_type, callback) => { listener = callback; };
  vm.runInContext(part("document.addEventListener('keydown', event => {", "document.addEventListener('keyup', event => {"), h.sandbox);
  const before = JSON.stringify(h.sandbox.graph);
  for (const target of [h.input('正向提示词'), h.input('随机种子'), h.button()]) for (const key of ['Escape', 'Delete', 'ArrowLeft', ' ', 'z']) {
    let prevented = false;
    listener({ target, key, code: key === ' ' ? 'Space' : key, ctrlKey: key === 'z', defaultPrevented: false, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, `${target.tagName} ${key} native behavior`);
  }
  assert.equal(JSON.stringify(h.sandbox.graph), before); assert.equal(h.sandbox.spaceDown, false);
});

for (const cancelled of [false, true]) test(`queued parameter action spanning ${cancelled ? 'cancelled' : 'pending'} exit never runs`, async () => {
  const h = harness(); h.button().fire('click'); h.sandbox.exitUiEpoch++; h.sandbox.exitUiFrozen = true;
  if (cancelled) { h.sandbox.exitUiEpoch++; h.sandbox.exitUiFrozen = false; }
  await tick(); assert.equal(h.state.runs, 0);
  if (cancelled) { h.button().fire('click'); await tick(); assert.equal(h.state.runs, 1, 'fresh user action after cancellation is usable'); }
});
test('frozen parameter owner rejects actual input and click before mutation or generation', async () => {
  const h = harness(); h.sandbox.exitUiFrozen = true; const input = h.input('正向提示词');
  input.value = 'late'; input.fire('input'); h.button().fire('click'); await tick();
  assert.equal(h.node.data.positive, 'original'); assert.equal(h.state.mutations, 0); assert.equal(h.state.runs, 0);
});

test('the dock and the floating panel never claim the same parameter fields', () => {
  const h = harness();
  assert.equal(h.state.syncs.at(-1).enabled, true);
  h.state.inspectorOpen = true;
  h.sandbox.refreshNodeParameterPanel();
  assert.equal(h.state.syncs.at(-1).enabled, false);
  h.state.inspectorOpen = false;
  h.state.compact = true;
  h.sandbox.refreshNodeParameterPanel();
  assert.equal(h.state.syncs.at(-1).enabled, false);
});
