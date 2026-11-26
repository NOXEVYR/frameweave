import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { indexCanvasNodes, findCanvasNodes, createCanvasNodeSearch } from '../web/canvas-node-search.mjs';

class Element {
  children = []; listeners = new Map(); attributes = {}; isConnected = true; open = false; value = '';
  constructor(tag, document) { this.tagName = tag; this.document = document; this.className = ''; this.classList = { toggle() {} }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, action) { const list = this.listeners.get(type) || []; list.push(action); this.listeners.set(type, list); }
  emit(type, properties = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...properties };
    for (const action of this.listeners.get(type) || []) action(event); return event;
  }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  descendants() { return [this, ...this.children.flatMap(item => item.descendants())]; }
}
const node = (id, title, text) => ({ id, type: 'prompt', data: { title, text } });
function harness(nodes = [node('a', '早晨 温室', '窗边的晨光'), node('b', '雨夜街道', '微光照亮街道')]) {
  const document = { createElement(tag) { return new Element(tag, this); }, querySelector() { return this.body.descendants().find(item => item.tagName === 'dialog' && item.open) || null; } };
  document.body = new Element('body', document); const previous = new Element('button', document); previous.focus();
  const state = { active: true, identity: 'canvas-A', graph: { nodes, edges: [] }, selected: [], errors: [], stale: 0, observers: [] };
  class Observer { constructor(action) { this.action = action; state.observers.push(this); } observe() {} disconnect() { this.disconnected = true; } }
  const search = createCanvasNodeSearch({ read: () => ({ active: state.active, identity: state.identity, graph: state.graph }),
    onSelect(item, ticket) { state.selected.push({ item, ticket }); }, reportError: error => state.errors.push(error), onStale() { state.stale++; } }, { document, Observer });
  const element = id => document.body.descendants().find(item => item.id === id);
  const input = element('canvas-node-search-input'), dialog = element('canvas-node-search-dialog'), results = element('canvas-node-search-results');
  return { search, state, document, previous, input, dialog, results, element,
    query(value) { input.value = value; input.emit('input'); },
    key(key, extra = {}) { return dialog.emit('keydown', { target: input, key, ...extra }); },
  };
}

test('Chinese, case-insensitive multiword queries search titles and all declared prompt text without mutating nodes', () => {
  const nodes = [node('a', '清晨 Glass', '窗边晨光'), { id: 'b', data: { title: '图像生成', positive: '夜雨街道', negative: '文字水印', packageFields: [{ id: 'prompt', type: 'text' }, { id: 'seed', type: 'integer' }], packageValues: { prompt: '远处猫咪', seed: 42 } } }];
  const before = structuredClone(nodes), index = indexCanvasNodes(nodes);
  for (const query of ['清晨', 'GLASS 晨光', 'glass 窗边']) assert.equal(findCanvasNodes(index, query)[0].node, nodes[0]);
  for (const query of ['夜雨', '水印', '猫咪', '图像 猫咪']) assert.equal(findCanvasNodes(index, query)[0].node, nodes[1]);
  assert.equal(findCanvasNodes(index, '42').length, 0); assert.equal(findCanvasNodes(index, '[.*]').length, 0);
  assert.equal(findCanvasNodes(index, '  ').length, 2); assert.deepEqual(nodes, before);
});

test('a 500-node canvas matches every node while rendering at most 100 bounded snippets', () => {
  const h = harness(Array.from({ length: 500 }, (_, i) => node(String(i), `镜头 ${i}`, `正文 ${'夜雨街道 '.repeat(300)}`)));
  h.search.open(); assert.equal(h.results.children.length, 100); assert.match(h.element('canvas-node-search-status').textContent, /500.*100/);
  h.query('镜头 499'); assert.equal(h.results.children.length, 1); assert.equal(h.results.children[0].children[0].textContent, '镜头 499');
  assert(h.results.children[0].children[1].textContent.length <= 142);
  h.query('不存在的标题'); assert.equal(h.results.children.length, 0); h.key('Enter'); assert.equal(h.state.selected.length, 0);
});

test('arrow keys and Enter select the exact live result and release the index/dialog', () => {
  const h = harness(); h.search.open(); assert.equal(h.document.activeElement, h.input);
  assert.equal(h.key('ArrowDown').defaultPrevented, true); h.key('Enter');
  assert.equal(h.state.selected.length, 1); assert.equal(h.state.selected[0].item.id, 'b');
  assert.equal(h.dialog.open, false); assert.equal(h.results.children.length, 0);
  assert.equal(h.state.observers[0].disconnected, true); assert.deepEqual(h.state.errors, []);
});

test('all 500 identical-title/content matches remain reachable through bounded pages and keyboard cross-page selection', () => {
  const nodes = Array.from({ length: 500 }, (_, i) => node(String(i), '重复镜头', '重复的中文提示词'));
  const h = harness(nodes); h.search.open(); h.query('重复');
  const oldButton = h.results.children[0], next = h.element('canvas-node-search-next'), previous = h.element('canvas-node-search-previous');
  assert.equal(previous.disabled, true);
  h.input.emit('compositionstart'); next.emit('click'); assert.match(h.element('canvas-node-search-status').textContent, /1–100/);
  h.input.emit('compositionend');
  for (let i = 0; i < 4; i++) { h.results.scrollTop = 800; next.emit('click'); assert.equal(h.results.children.length, 100); assert.equal(h.results.scrollTop, 0); }
  assert.match(h.element('canvas-node-search-status').textContent, /401–500/); assert.equal(next.disabled, true);
  oldButton.emit('click'); assert.equal(h.state.selected.length, 0, 'detached page button cannot choose another current row');
  for (let i = 0; i < 99; i++) h.key('ArrowDown');
  h.key('Enter'); assert.equal(h.state.selected[0].item, nodes[499]);
  h.search.open(); for (let i = 0; i < 100; i++) h.key('ArrowDown');
  assert.match(h.element('canvas-node-search-status').textContent, /101–200/);
  h.key('ArrowUp'); assert.match(h.element('canvas-node-search-status').textContent, /1–100/);
  h.key('Enter'); assert.equal(h.state.selected.at(-1).item, nodes[99]);
});

test('Chinese composition keeps candidate input, Enter, Escape, cancel and close button from selecting or closing', () => {
  const h = harness(); h.search.open(); h.input.emit('compositionstart'); h.query('雨夜');
  assert.equal(h.results.children.length, 2); h.key('Enter'); h.key('Escape'); h.dialog.emit('cancel');
  h.dialog.children[0].children[1].emit('click'); assert.equal(h.dialog.open, true); assert.equal(h.state.selected.length, 0);
  h.input.emit('compositionend'); assert.equal(h.results.children.length, 1);
  h.key('Enter', { isComposing: true }); h.key('Enter', { keyCode: 229 }); assert.equal(h.state.selected.length, 0);
  h.key('Enter'); assert.equal(h.state.selected[0].item.id, 'b');
});

test('Escape and native close restore the connected launch control, and reopen uses fresh node text', () => {
  const h = harness(); h.search.open(); h.key('Escape'); assert.equal(h.document.activeElement, h.previous);
  assert.equal(h.dialog.open, false); h.state.graph.nodes[0].data.text = '后来修改的台词';
  h.search.open(); h.query('修改的台词'); assert.equal(h.results.children.length, 1); h.dialog.close();
  assert.equal(h.document.activeElement, h.previous); assert.equal(h.results.children.length, 0);
});

for (const change of ['identity', 'graph', 'same-id replacement', 'deletion', 'workspace']) {
  test(`${change} cannot navigate a stale result or restore focus into a closed workspace`, () => {
    const h = harness(); h.search.open(); const oldButton = h.results.children[0];
    if (change === 'identity') h.state.identity = 'canvas-B';
    if (change === 'graph') h.state.graph = structuredClone(h.state.graph);
    if (change === 'same-id replacement') h.state.graph.nodes[0] = structuredClone(h.state.graph.nodes[0]);
    if (change === 'deletion') h.state.graph.nodes.shift();
    if (change === 'workspace') h.state.active = false;
    oldButton.emit('click'); assert.deepEqual(h.state.selected, []); assert.equal(h.dialog.open, false);
    assert.equal(h.state.stale, 1);
  });
}

test('context invalidation closes without polling; inactive canvases and existing dialogs cannot open search', () => {
  const h = harness(); h.state.active = false; assert.equal(h.search.open(), false);
  h.state.active = true; h.search.open(); assert.equal(h.search.open(), false);
  h.state.active = false; h.state.observers[0].action(); assert.equal(h.dialog.open, false); assert.equal(h.state.selected.length, 0);
});

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const start = source.indexOf("document.addEventListener('keydown', event => {", source.indexOf('function finishKeyboardMove()'));
const handler = source.slice(start, source.indexOf("document.addEventListener('keyup'", start));
function shortcut(options = {}) {
  let listener, opened = 0;
  const canvas = { contains: () => !options.outside }, target = { closest(selector) {
    if (options.editing && selector === 'input,textarea,select,[contenteditable=true]') return this;
    if (options.button && selector.startsWith('button,')) return this; return null;
  } };
  vm.runInNewContext(handler, { document: { addEventListener(type, fn) { listener = fn; }, querySelector: () => options.dialog || null },
    canvas, nodeParameterPanel: null, pointer: options.pointer || null, portDrag: null, nodeMenu: null,
    canvasIsActive: () => !options.inactive, canvasProjectActive: !options.unnamed,
    finishKeyboardMove() {}, openCanvasNodeSearch() { opened++; }, reportError: error => { throw error; } });
  const event = { target, key: 'f', code: 'KeyF', ctrlKey: !options.meta, metaKey: !!options.meta,
    altKey: !!options.alt, isComposing: !!options.composing, preventDefault() { this.defaultPrevented = true; } };
  listener(event); return { opened, prevented: !!event.defaultPrevented };
}
test('actual app Ctrl/Cmd+F is scoped to a named active canvas surface', () => {
  assert.deepEqual(shortcut(), { opened: 1, prevented: true }); assert.deepEqual(shortcut({ meta: true }), { opened: 1, prevented: true });
  for (const key of ['editing', 'button', 'outside', 'inactive', 'unnamed', 'composing', 'dialog', 'pointer', 'alt']) {
    assert.deepEqual(shortcut({ [key]: true }), { opened: 0, prevented: false }, key);
  }
});
