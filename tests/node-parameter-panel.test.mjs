import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeParameterPanel, nodeParameterPanelPosition } from '../web/node-parameter-panel.mjs';

// A small DOM fixture: moving nodes removes them from their old parent, event paths
// include capture and bubble phases, and removing focused DOM causes focusout.
// The panel itself supplies all placement and editing decisions under test.
class DOMEvent {
  constructor(type, properties = {}) {
    Object.assign(this, { type, bubbles: true, cancelable: true, defaultPrevented: false, eventPhase: 0 },
      type.startsWith('pointer') ? { button: 0, pointerId: 1 } : {}, properties);
    this.propagationStopped = false;
    this.immediateStopped = false;
  }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.propagationStopped = this.immediateStopped = true; }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  composedPath() { return [...this.path]; }
}

class DOMNode {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = document;
    this.parentNode = null;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.value = '';
    this.textContent = '';
    this.offsetHeight = 240;
    this.rect = { left: 0, top: 0, width: 100, height: 80, right: 100, bottom: 80 };
    this.hasRects = true;
    this.rectReads = 0;
  }
  get nextSibling() {
    return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  get isConnected() {
    let current = this;
    while (current?.parentNode) current = current.parentNode;
    return current === this.ownerDocument;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (before !== null && before.parentNode !== this) throw new Error('Reference node is not a child');
    if (node === before) return node;
    const from = node.parentNode;
    if (from) from.removeChild(node);
    const index = before === null ? this.children.length : this.children.indexOf(before);
    this.children.splice(index, 0, node);
    node.parentNode = this;
    this.ownerDocument.moves.push({ node, from, to: this });
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error('Node is not a child');
    if (node.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement.blur();
    this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) this.removeChild(child); this.append(...nodes); }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  matches(selectors) {
    return selectors.split(',').some(selector => selector.trim() === this.tagName.toLowerCase() ||
      selector.trim() === '[contenteditable=true]' && this.attributes.contenteditable === 'true');
  }
  addEventListener(type, callback, options = false) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    const listeners = this.listeners.get(type) || [];
    if (!listeners.some(item => item.callback === callback && item.capture === capture)) {
      listeners.push({ callback, capture, once: typeof options === 'object' && !!options.once });
    }
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, callback, options = false) {
    const capture = typeof options === 'boolean' ? options : !!options.capture;
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item.callback !== callback || item.capture !== capture));
  }
  dispatchEvent(event) {
    event.target = this;
    event.path = [];
    for (let node = this; node; node = node.parentNode) event.path.push(node);
    const invoke = (node, capture, phase) => {
      event.currentTarget = node;
      event.eventPhase = phase;
      for (const listener of [...(node.listeners.get(event.type) || [])]) {
        if (listener.capture !== capture) continue;
        listener.callback(event);
        if (listener.once) node.removeEventListener(event.type, listener.callback, capture);
        if (event.immediateStopped) break;
      }
    };
    for (const node of event.path.slice(1).reverse()) {
      invoke(node, true, 1);
      if (event.propagationStopped) break;
    }
    if (!event.propagationStopped) {
      invoke(this, true, 2);
      if (!event.immediateStopped) invoke(this, false, 2);
      if (event.bubbles && !event.propagationStopped) {
        for (const node of event.path.slice(1)) {
          invoke(node, false, 3);
          if (event.propagationStopped) break;
        }
      }
    }
    event.currentTarget = null;
    event.eventPhase = 0;
    if (!event.defaultPrevented) event.defaultAction?.(event);
    return !event.defaultPrevented;
  }
  focus() {
    if (this.ownerDocument.activeElement === this) return;
    this.ownerDocument.activeElement?.blur();
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new DOMEvent('focusin'));
  }
  blur() {
    if (this.ownerDocument.activeElement !== this) return;
    this.ownerDocument.activeElement = this.ownerDocument.body;
    this.dispatchEvent(new DOMEvent('focusout'));
  }
  getClientRects() {
    for (let node = this; node; node = node.parentNode) if (node.hidden) return [];
    return this.isConnected && this.hasRects ? [this.rect] : [];
  }
  getBoundingClientRect() { this.rectReads++; return { ...this.rect }; }
}

function fixture() {
  const document = new DOMNode('#document', null);
  document.ownerDocument = document;
  document.moves = [];
  document.createElement = tag => new DOMNode(tag, document);
  document.defaultView = new DOMNode('#window', document);
  document.body = document.createElement('body');
  document.append(document.body);
  document.activeElement = document.body;
  const canvas = document.createElement('main');
  canvas.rect = { left: 110, top: 70, width: 1000, height: 700, right: 1110, bottom: 770 };
  const world = document.createElement('div');
  const card = document.createElement('article');
  card.rect = { left: 310, top: 200, width: 240, height: 180, right: 550, bottom: 380 };
  const home = document.createElement('aside');
  const before = document.createElement('h2');
  const content = document.createElement('div');
  const after = document.createElement('footer');
  const input = document.createElement('textarea');
  const button = document.createElement('button');
  input.value = '原始参数';
  content.append(input, button);
  home.append(before, content, after);
  world.append(card);
  canvas.append(world);
  document.body.append(canvas, home);
  const callbacks = [];
  const observers = [];
  const schedule = callback => callbacks.push(callback);
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); this.disconnects = 0; observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); this.disconnects++; }
    deliver() { this.callback([]); }
  }
  let docked = 0;
  const dockReasons = [];
  let visibleArea = { x: 20, y: 30, width: 900, height: 610 };
  const panel = createNodeParameterPanel({ canvas, content, area: () => visibleArea,
    schedule, observe: ResizeObserver, onDock: context => { docked++; dockReasons.push(context.reason); } });
  const owner = {};
  const sync = (overrides = {}) => panel.sync({ token: owner, nodeId: 'node-a', label: '节点 A', card, ...overrides });
  const flushFrame = () => { for (const callback of callbacks.splice(0)) callback(); };
  const flushAll = () => {
    let limit = 20;
    while (callbacks.length && limit-- > 0) flushFrame();
    assert.equal(callbacks.length, 0, 'rAF callbacks must settle');
  };
  const emit = (target, type, properties) => { const event = new DOMEvent(type, properties); target.dispatchEvent(event); return event; };
  const contentMoves = () => document.moves.filter(move => move.node === content);
  return { document, canvas, world, card, home, before, content, after, input, button, panel, owner, sync,
    callbacks, observers, flushFrame, flushAll, emit, contentMoves, dockReasons, docked: () => docked,
    setArea: area => { visibleArea = area; } };
}

function assertBounds(position, canvas, height) {
  assert(position);
  for (const value of Object.values(position)) assert(Number.isFinite(value));
  assert(position.width > 0 && position.maxHeight > 0);
  assert(position.left >= 0 && position.top >= 0);
  assert(position.left + position.width <= canvas.width);
  assert(position.top + Math.min(position.maxHeight, height) <= canvas.height);
}

test('screen geometry stays in the usable canvas and never covers the visible owner', () => {
  const canvas = { left: 110, top: 70, width: 1000, height: 700 };
  const area = { x: 60, y: 40, width: 870, height: 580 };
  for (const anchor of [
    { left: 100, right: 240, top: 100, bottom: 240 }, { left: 310, right: 550, top: 200, bottom: 380 },
    { left: 1000, right: 1200, top: 500, bottom: 800 },
  ]) {
    for (const height of [1, 240, 900]) {
      const position = nodeParameterPanelPosition(canvas, anchor, area, height);
      assertBounds(position, canvas, height);
      assert(position.left >= area.x && position.left + position.width <= area.x + area.width);
      assert(position.top >= area.y && position.top + Math.min(position.maxHeight, height) <= area.y + area.height);
      const bottom = canvas.top + position.top + Math.min(position.maxHeight, Math.max(240, height));
      assert(bottom <= anchor.top - 12 || canvas.top + position.top >= anchor.bottom + 12);
    }
  }
});

test('invalid geometry and unusably small space are rejected instead of displaying a floating strip', () => {
  const canvas = { left: 0, top: 0, width: 1000, height: 700 };
  const anchor = { left: 100, right: 300, top: 100, bottom: 200 };
  const area = { x: 10, y: 10, width: 800, height: 500 };
  for (const key of ['left', 'top', 'width', 'height']) {
    for (const value of [NaN, Infinity, undefined]) assert.equal(nodeParameterPanelPosition({ ...canvas, [key]: value }, anchor, area), null);
  }
  for (const key of ['left', 'right', 'top', 'bottom']) {
    for (const value of [NaN, Infinity, undefined]) assert.equal(nodeParameterPanelPosition(canvas, { ...anchor, [key]: value }, area), null);
  }
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(nodeParameterPanelPosition(canvas, anchor, { ...area, [key]: NaN }), null);
  for (const size of [0, -1]) {
    assert.equal(nodeParameterPanelPosition({ ...canvas, width: size }, anchor, area), null);
    assert.equal(nodeParameterPanelPosition(canvas, anchor, { ...area, height: size }), null);
  }
  assert.equal(nodeParameterPanelPosition({ left: 0, top: 0, width: 8, height: 8 }, anchor), null);
  const tiny = { left: 0, top: 0, width: 2, height: 1 };
  assert.equal(nodeParameterPanelPosition(tiny, anchor, { x: 0, y: 0, width: 2, height: 1 }), null);
  for (const height of [NaN, Infinity, 0, -1]) assertBounds(nodeParameterPanelPosition(canvas, anchor, area, height), canvas, 240);
});

test('one original inspector subtree moves to the panel and returns to its original sibling slot', () => {
  const f = fixture();
  let inputs = 0;
  f.input.addEventListener('input', () => inputs++);
  assert.equal(f.panel.root.parentNode, f.canvas);
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.content.parentNode, f.home);
  f.sync();
  f.flushAll();
  assert.equal(f.content.parentNode, f.panel.root);
  assert.equal(f.panel.contains(f.input), true);
  assert.equal(f.panel.contains(f.card), false);
  assert.equal(f.panel.contains(null), false);
  assert.equal(f.panel.root.dataset.nodeId, 'node-a');
  const heading = f.panel.root.children[0];
  assert.equal(heading.children[0].textContent, '节点 A');
  assert.equal(f.panel.root.attributes['aria-labelledby'], heading.children[0].id);
  f.input.value = '已修改且保留的参数';
  f.emit(f.input, 'input');
  const moves = f.contentMoves().length;
  f.sync({ label: '更新节点名称' });
  f.sync({ label: '更新节点名称' });
  f.flushAll();
  assert.equal(f.contentMoves().length, moves, 'sync must not detach an already hosted subtree');
  assert.equal(f.panel.root.children.filter(node => node === f.content).length, 1);
  assert.equal(f.panel.hide(), true);
  assert.deepEqual(f.home.children, [f.before, f.content, f.after]);
  assert.equal(f.input.parentNode, f.content);
  assert.equal(f.input.value, '已修改且保留的参数');
  f.emit(f.input, 'input');
  assert.equal(inputs, 2, 'original handlers must survive both moves');
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.observers[0].targets.size, 0);
});

test('restoring the original subtree tolerates removal of its saved next sibling', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.after.remove();
  const newSibling = f.document.createElement('p');
  f.home.append(newSibling);
  f.panel.hide();
  assert.deepEqual(f.home.children, [f.before, newSibling, f.content]);
  f.flushAll();
});

test('docking suppresses the same owner until owner change or reset', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  const close = f.panel.root.children[0].children[1];
  f.emit(close, 'click');
  assert.equal(f.docked(), 1);
  assert.equal(f.content.parentNode, f.home);
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.hidden, true);
  const newOwner = {};
  f.sync({ token: newOwner, nodeId: 'node-b', label: '节点 B' }); f.flushAll();
  assert.equal(f.panel.root.hidden, false);
  assert.equal(f.panel.root.dataset.nodeId, 'node-b');
  f.emit(close, 'click');
  f.panel.reset();
  assert.equal(f.panel.root.dataset.nodeId, '');
  f.sync({ token: newOwner, nodeId: 'node-b' }); f.flushAll();
  assert.equal(f.panel.root.hidden, false);
  assert.equal(f.docked(), 2);
});

test('docking during IME waits for composition completion and invokes the dock action once', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.input.focus(); f.emit(f.input, 'compositionstart');
  const moves = f.contentMoves().length;
  f.emit(f.panel.root.children[0].children[1], 'click');
  f.flushAll();
  assert.equal(f.docked(), 0);
  assert.equal(f.contentMoves().length, moves);
  assert.equal(f.document.activeElement, f.input);
  f.emit(f.input, 'compositionend');
  assert.equal(f.docked(), 0);
  f.flushAll();
  assert.equal(f.docked(), 1);
  assert(f.content.parentNode === f.home, 'deferred dock must restore the original content');
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.hidden, true);
  f.panel.destroy();
  f.panel.dock();
  assert.equal(f.panel.hide(), false);
  f.flushAll();
  assert.equal(f.docked(), 1);
});

test('disabled, missing owner or missing card restores content without permanently suppressing its owner', () => {
  const f = fixture();
  for (const override of [{ enabled: false }, { token: null }, { card: null }]) {
    f.sync(); f.flushAll();
    f.sync(override); f.flushAll();
    assert.equal(f.panel.root.hidden, true);
    assert.equal(f.content.parentNode, f.home);
    f.sync(); f.flushAll();
    assert.equal(f.panel.root.hidden, false);
  }
});

test('viewport zoom changes anchor placement while parameter DOM stays outside the scaled world', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  const width = f.panel.root.style.width;
  for (const scale of [0.25, 1, 2.5]) {
    f.world.style.transform = `translate(15px, 30px) scale(${scale})`;
    f.card.rect = { left: 110 + 200 * scale, top: 70 + 120 * scale, width: 240 * scale,
      height: 180 * scale, right: 110 + 440 * scale, bottom: 70 + 300 * scale };
    f.panel.refresh(); f.flushAll();
    assert.equal(f.content.parentNode, f.panel.root);
    assert.equal(f.panel.root.parentNode, f.canvas);
    assert.equal(f.world.contains(f.content), false);
    assert.equal(f.panel.root.style.transform, undefined);
    assert.equal(f.panel.root.style.zoom, undefined);
    assert.equal(f.panel.root.style.width, width);
    assertBounds({ left: parseFloat(f.panel.root.style.left), top: parseFloat(f.panel.root.style.top),
      width: parseFloat(width), maxHeight: parseFloat(f.panel.root.style.maxHeight) }, f.canvas.rect, f.panel.root.offsetHeight);
  }
});

test('refreshes coalesce, observe the active anchor, and hide invalid canvas geometry', () => {
  const f = fixture();
  f.sync(); f.panel.refresh(); f.observers[0].deliver();
  assert.equal(f.callbacks.length, 1);
  assert.deepEqual([...f.observers[0].targets], [f.card, f.panel.root]);
  f.flushAll();
  assert.equal(f.canvas.rectReads, 1);
  const otherCard = f.document.createElement('article');
  otherCard.rect = { ...f.card.rect };
  f.world.append(otherCard);
  f.sync({ token: {}, card: otherCard }); f.flushAll();
  assert.deepEqual([...f.observers[0].targets], [otherCard, f.panel.root]);
  f.canvas.rect.width = 0;
  f.panel.refresh(); f.flushAll();
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.content.parentNode, f.home);
  assert.equal(f.observers[0].targets.size, 0);
});

test('limited free space enables a compact panel without covering the card', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.dataset.compact, 'false');
  f.setArea({ x: 20, y: 30, width: 600, height: 500 });
  f.observers[0].deliver(); f.flushAll();
  assert.equal(f.panel.root.dataset.compact, 'true');
  assert(parseFloat(f.panel.root.style.maxHeight) <= 208);
  assert.equal(f.panel.root.hidden, false);
  f.setArea({ x: 20, y: 30, width: 900, height: 610 });
  f.panel.refresh(); f.flushAll();
  assert.equal(f.panel.root.dataset.compact, 'false');
});

test('below is preferred and above is used when the card has no space beneath it', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.dataset.placement, 'below');
  assert(parseFloat(f.panel.root.style.top) + f.canvas.rect.top >= f.card.rect.bottom + 12);
  f.card.rect = { left: 310, right: 550, top: 500, bottom: 650, width: 240, height: 150 };
  f.panel.refresh(); f.flushAll();
  assert.equal(f.panel.root.dataset.placement, 'above');
  const panelBottom = parseFloat(f.panel.root.style.top) + f.panel.root.offsetHeight + f.canvas.rect.top;
  assert(panelBottom <= f.card.rect.top - 12);
  assert.equal(f.docked(), 0);
});

test('the measured hosted subtree, not the empty heading height, determines the upper position', () => {
  const f = fixture();
  f.card.rect = { left: 310, right: 550, top: 530, bottom: 690, width: 240, height: 160 };
  Object.defineProperty(f.panel.root, 'offsetHeight', { get() { return f.content.parentNode === f.panel.root ? 350 : 40; } });
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.dataset.placement, 'above');
  assert.equal(parseFloat(f.panel.root.style.top) + 350 + f.canvas.rect.top, f.card.rect.top - 12);
  assert.equal(f.content.parentNode === f.panel.root, true);
});

test('a card with no usable room on either side docks once without covering it or reopening on refresh', () => {
  const f = fixture();
  f.card.rect = { left: 310, right: 550, top: 180, bottom: 600, width: 240, height: 420 };
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.content.parentNode === f.home, true);
  assert.equal(f.panel.root.dataset.nodeId, 'node-a', 'hidden overlay metadata still names its current docked owner');
  assert.equal(f.contentMoves().length, 1, 'failed admission never detaches the sidebar controls');
  assert.deepEqual(f.dockReasons, ['space']);
  f.sync(); f.panel.refresh(); f.flushAll();
  assert.deepEqual(f.dockReasons, ['space']);
  f.sync({ token: {} }); f.flushAll();
  assert.deepEqual(f.dockReasons, ['space', 'space']);
});

test('offscreen owners do not leave a floating panel and reappear when panned back without dismissal', () => {
  for (const rectangle of [
    { left: -300, right: -100, top: 200, bottom: 380 },
    { left: 1200, right: 1400, top: 200, bottom: 380 },
    { left: 310, right: 550, top: -300, bottom: -100 },
    { left: 310, right: 550, top: 900, bottom: 1080 },
    // Still inside the canvas element, but wholly beneath its usable footer edge.
    { left: 310, right: 550, top: 720, bottom: 760 },
  ]) {
    const f = fixture(), original = { ...f.card.rect };
    f.sync(); f.flushAll();
    f.card.rect = { ...f.card.rect, ...rectangle };
    assert.equal(f.card.getClientRects().length, 1, 'offscreen does not mean detached');
    f.panel.refresh(); f.flushAll();
    assert.equal(f.panel.root.hidden, true);
    assert.equal(f.content.parentNode === f.home, true);
    assert.equal(f.docked(), 0);
    f.card.rect = original;
    f.panel.refresh(); f.flushAll();
    assert.equal(f.panel.root.hidden, false);
    assert.equal(f.content.parentNode === f.panel.root, true);
  }
});

test('partly visible cards may own a panel, but an area extending outside the canvas is clipped accurately', () => {
  const canvas = { left: 100, top: 100, width: 900, height: 700 };
  const area = { x: -100, y: -50, width: 700, height: 650 };
  const anchor = { left: 0, right: 200, top: 150, bottom: 300 };
  const position = nodeParameterPanelPosition(canvas, anchor, area);
  assertBounds(position, canvas, 240);
  assert.equal(position.left, 0);
  assert.equal(position.width, 600);
  assert(position.top + 240 <= 600);
  assert.equal(nodeParameterPanelPosition(canvas, { ...anchor, right: 100 }, area), null, 'edge contact without visible pixels is not an owner');
});

test('detached or invisible anchors do not read layout or emit invalid style positions', () => {
  for (const makeUnavailable of [f => f.card.remove(), f => { f.card.hasRects = false; }, f => { f.canvas.hasRects = false; }]) {
    const f = fixture();
    f.sync();
    makeUnavailable(f);
    f.flushAll();
    assert.equal(f.canvas.rectReads, 0);
    assert.equal(f.card.rectReads, 0);
    assert.equal(f.panel.root.style.left, undefined);
    assert.equal(f.panel.root.style.top, undefined);
  }
});

test('parameter gestures reach the native control and capture listeners without driving canvas bubble handlers', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  const types = ['pointerdown', 'wheel', 'dblclick', 'contextmenu', 'keydown', 'dragover', 'drop'];
  for (const type of types) {
    const calls = [];
    const capture = () => calls.push('document capture');
    const control = () => calls.push('control');
    const canvas = () => calls.push('canvas');
    f.document.addEventListener(type, capture, true);
    f.input.addEventListener(type, control);
    f.canvas.addEventListener(type, canvas);
    const event = f.emit(f.input, type, { defaultAction: () => calls.push('native default') });
    assert.deepEqual(calls, ['document capture', 'control', 'native default'], type);
    assert.equal(event.defaultPrevented, false, `${type} must retain its native behavior`);
    f.document.removeEventListener(type, capture, true);
    f.input.removeEventListener(type, control);
    f.canvas.removeEventListener(type, canvas);
  }
  f.emit(f.document, 'pointerup'); f.flushAll();
});

test('keyup retains the document cleanup and native control behavior for a Space press begun outside', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  let panning = true;
  const calls = [];
  f.input.addEventListener('keyup', () => calls.push('control'));
  f.document.addEventListener('keyup', event => {
    if (event.code === 'Space') { panning = false; calls.push('release existing pan'); }
  });
  const event = f.emit(f.input, 'keyup', { code: 'Space', defaultAction: () => calls.push('native default') });
  assert.equal(panning, false);
  assert.deepEqual(calls, ['control', 'release existing pan', 'native default']);
  assert.equal(event.defaultPrevented, false);
});

test('text editing and scrolling preserve their native handlers and default behavior', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  for (const type of ['input', 'change', 'scroll']) {
    const calls = [];
    const listener = () => calls.push('control');
    f.input.addEventListener(type, listener);
    const event = f.emit(f.input, type, { bubbles: type !== 'scroll', cancelable: false,
      defaultAction: () => calls.push('native default') });
    assert.deepEqual(calls, ['control', 'native default'], type);
    assert.equal(event.defaultPrevented, false);
    f.input.removeEventListener(type, listener);
  }
  f.input.addEventListener('keydown', event => event.preventDefault());
  let defaultRan = false;
  const canceled = f.emit(f.input, 'keydown', { defaultAction: () => { defaultRan = true; } });
  assert.equal(canceled.defaultPrevented, true, 'control-specific cancellation must still work');
  assert.equal(defaultRan, false);
});

test('focus blocks a deferred edit until finishEditing blurs the original control', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.input.focus();
  assert.equal(f.panel.blocked(), true);
  let applied = 0;
  f.panel.defer(() => applied++);
  f.flushAll();
  assert.equal(applied, 0);
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.panel.finishEditing(), true);
  assert.equal(f.document.activeElement, f.document.body);
  assert.equal(f.panel.blocked(), false);
  assert.equal(applied, 0, 'focusout resumes work on the next frame');
  f.flushAll();
  assert.equal(applied, 1);
  f.flushAll();
  assert.equal(applied, 1);
});

test('composition defers DOM restoration and preserves focus, text and the original subtree until completion', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.input.focus();
  f.emit(f.input, 'compositionstart');
  f.input.value = '正在输入中文';
  const moves = f.contentMoves().length;
  assert.equal(f.panel.isComposing(), true);
  assert.equal(f.panel.finishEditing(), false);
  assert.equal(f.panel.hide(), false);
  f.sync({ enabled: false });
  f.flushAll();
  assert.equal(f.contentMoves().length, moves);
  assert.equal(f.content.parentNode, f.panel.root);
  assert.equal(f.document.activeElement, f.input);
  assert.equal(f.input.value, '正在输入中文');
  f.emit(f.input, 'compositionend');
  assert.equal(f.panel.isComposing(), false);
  assert.equal(f.content.parentNode, f.panel.root, 'compositionend must not move DOM during event dispatch');
  f.flushAll();
  assert.equal(f.content.parentNode, f.home);
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.input.value, '正在输入中文');
});

test('composition-only deferred work resumes after composition while ordinary work waits for blur', () => {
  for (const compositionOnly of [false, true]) {
    const f = fixture();
    f.sync(); f.flushAll();
    f.input.focus(); f.emit(f.input, 'compositionstart');
    let applied = 0;
    f.panel.defer(() => applied++, { compositionOnly });
    f.flushAll();
    assert.equal(applied, 0);
    f.emit(f.input, 'compositionend'); f.flushAll();
    assert.equal(applied, compositionOnly ? 1 : 0);
    assert.equal(f.document.activeElement, f.input);
    f.input.blur(); f.flushAll();
    assert.equal(applied, 1);
  }
});

test('a hide requested during composition survives an already deferred parameter edit', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.input.focus(); f.emit(f.input, 'compositionstart');
  f.panel.defer(() => { f.input.value = '完成后的参数'; });
  assert.equal(f.panel.hide(), false);
  f.flushAll();
  assert.equal(f.content.parentNode, f.panel.root);
  assert.equal(f.document.activeElement, f.input);
  f.emit(f.input, 'compositionend'); f.flushAll();
  assert(f.content.parentNode === f.home, 'queued editing must not discard the deferred hide request');
  assert.equal(f.panel.root.hidden, true);
});

test('focus changes cannot invent composition completion or release pending owner work', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  const otherInput = f.document.createElement('input');
  f.content.append(otherInput);
  f.input.focus(); f.emit(f.input, 'compositionstart');
  let applied = 0;
  f.panel.defer(() => applied++);
  otherInput.focus(); f.flushAll();
  assert.equal(f.panel.isComposing(), true);
  assert.equal(applied, 0);
  f.after.focus();
  assert.equal(f.panel.isComposing(), true, 'focusout must wait for the focus destination');
  f.flushAll();
  assert.equal(f.panel.isComposing(), true);
  assert.equal(applied, 0);
  assert.equal(f.document.activeElement, f.after);
  f.emit(f.input, 'compositionend'); f.flushAll();
  assert.equal(f.panel.isComposing(), false);
  assert.equal(applied, 1);
});

test('an active composition keeps its visible controls fixed when the owner moves offscreen, then hides after its real end', () => {
  const f = fixture();
  f.sync(); f.flushAll(); f.input.focus(); f.emit(f.input, 'compositionstart');
  const styles = { ...f.panel.root.style }, moves = f.contentMoves().length;
  f.card.rect = { ...f.card.rect, left: 1300, right: 1540 };
  f.panel.refresh(); f.flushAll();
  assert.equal(f.panel.root.hidden, false);
  assert.equal(f.content.parentNode === f.panel.root, true);
  assert.equal(f.document.activeElement === f.input, true);
  assert.equal(f.contentMoves().length, moves);
  assert.deepEqual(f.panel.root.style, styles);
  f.input.value = '保留未结束的中文';
  f.emit(f.input, 'compositionend', { data: '中文' });
  assert.equal(f.panel.root.hidden, false, 'do not detach during the compositionend dispatch');
  f.flushAll();
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.content.parentNode === f.home, true);
  assert.equal(f.input.value, '保留未结束的中文');
});

test('a composing sidebar control is not reparented into a new panel until its own composition ends', () => {
  const f = fixture();
  const other = f.document.createElement('textarea'); f.content.append(other);
  f.input.focus(); f.emit(f.input, 'compositionstart');
  f.sync(); f.flushAll();
  assert.equal(f.content.parentNode === f.home, true);
  assert.equal(f.panel.root.hidden, true);
  f.emit(other, 'compositionstart');
  f.emit(other, 'compositionend'); f.flushAll();
  assert.equal(f.panel.isComposing(), true, 'another target cannot complete the original session');
  assert.equal(f.content.parentNode === f.home, true);
  f.input.blur(); f.flushAll();
  assert.equal(f.panel.isComposing(), true, 'blur cannot clear an active composition');
  f.emit(f.input, 'compositionend', { data: '' }); f.flushAll();
  assert.equal(f.panel.isComposing(), false, 'a real cancellation end also releases placement');
  assert.equal(f.content.parentNode === f.panel.root, true);
  assert.equal(f.panel.root.hidden, false);
});

test('owner labels and placement remain bound to the visible old editor until composition completes', () => {
  const f = fixture();
  f.sync(); f.flushAll(); f.input.focus(); f.emit(f.input, 'compositionstart');
  const moves = f.contentMoves().length;
  let stale = 0; f.panel.defer(() => stale++);
  f.sync({ token: {}, nodeId: 'node-b', label: '节点 B' }); f.flushAll();
  assert.equal(f.panel.root.dataset.nodeId, 'node-a');
  assert.equal(f.panel.root.children[0].children[0].textContent, '节点 A');
  assert.equal(f.panel.root.hidden, false);
  assert.equal(f.contentMoves().length, moves);
  f.emit(f.input, 'compositionend'); f.flushAll();
  assert.equal(f.panel.root.dataset.nodeId, 'node-b');
  assert.equal(f.panel.root.children[0].children[0].textContent, '节点 B');
  assert.equal(stale, 0);
});

test('primary press postpones replacement through native click and ignores other pointer releases', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  const calls = [];
  f.button.addEventListener('click', () => calls.push('original button click'));
  f.emit(f.button, 'pointerdown', { pointerId: 7 });
  assert.equal(f.panel.blocked(), true);
  f.panel.defer(() => { calls.push('replace parameters'); f.content.replaceChildren(f.document.createElement('input')); });
  f.flushAll();
  assert.deepEqual(calls, []);
  f.emit(f.document, 'pointerup', { pointerId: 8 }); f.flushAll();
  assert.equal(f.panel.blocked(), true);
  assert.equal(f.button.parentNode, f.content);
  f.emit(f.button, 'pointerup', { pointerId: 7 });
  assert.equal(f.panel.blocked(), false);
  assert.deepEqual(calls, []);
  f.emit(f.button, 'click', { defaultAction: () => calls.push('native click default') });
  assert.deepEqual(calls, ['original button click', 'native click default']);
  assert.equal(f.button.parentNode, f.content);
  f.flushAll();
  assert.deepEqual(calls, ['original button click', 'native click default', 'replace parameters']);
  assert.equal(f.button.parentNode, null);
});

test('a held control or header keeps geometry fixed through native click before a deferred dock', () => {
  for (const targetName of ['button', 'heading']) {
    const f = fixture(); f.sync(); f.flushAll();
    const target = targetName === 'heading' ? f.panel.root.children[0] : f.button;
    const styles = { ...f.panel.root.style };
    f.emit(target, 'pointerdown', { pointerId: 21 });
    f.card.rect = { ...f.card.rect, top: 180, bottom: 600, height: 420 };
    f.panel.refresh(); f.flushAll();
    assert.deepEqual(f.panel.root.style, styles);
    assert.equal(f.panel.root.hidden, false);
    assert.equal(f.docked(), 0);
    f.emit(target, 'pointerup', { pointerId: 21 });
    let clicked = false;
    f.emit(target, 'click', { defaultAction: () => { clicked = true; assert.equal(f.content.parentNode === f.panel.root, true); } });
    assert.equal(clicked, true);
    assert.equal(f.docked(), 0);
    f.flushAll();
    assert.equal(f.panel.root.hidden, true);
    assert.deepEqual(f.dockReasons, ['space']);
  }
});

test('hide during a primary press preserves the target until the release and native click finish', () => {
  const f = fixture(); f.sync(); f.flushAll();
  f.emit(f.button, 'pointerdown', { pointerId: 22 });
  assert.equal(f.panel.hide(), false);
  f.flushAll();
  assert.equal(f.content.parentNode === f.panel.root, true);
  assert.equal(f.panel.root.hidden, false);
  f.emit(f.button, 'pointerup', { pointerId: 22 });
  f.emit(f.button, 'click', { defaultAction: () => assert.equal(f.content.parentNode === f.panel.root, true) });
  f.flushAll();
  assert.equal(f.content.parentNode === f.home, true);
  assert.equal(f.panel.root.hidden, true);
});

test('pointer cancellation resumes work and nonprimary presses do not block editing', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.emit(f.button, 'pointerdown', { button: 2, pointerId: 9 });
  assert.equal(f.panel.blocked(), false);
  f.emit(f.button, 'pointerdown', { pointerId: 10 });
  let applied = 0;
  f.panel.defer(() => applied++); f.flushAll();
  f.emit(f.document, 'pointercancel', { pointerId: 10 });
  assert.equal(applied, 0);
  f.flushAll();
  assert.equal(applied, 1);
  assert.equal(f.panel.blocked(), false);
});

test('window blur recovers a primary press whose pointerup was lost', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.emit(f.button, 'pointerdown', { pointerId: 11 });
  let applied = 0;
  f.panel.defer(() => applied++); f.flushAll();
  assert.equal(f.panel.blocked(), true);
  f.emit(f.document.defaultView, 'blur', { bubbles: false, cancelable: false });
  assert.equal(f.panel.blocked(), false);
  assert.equal(applied, 0);
  f.flushAll();
  assert.equal(applied, 1);
});

test('suspend restores content without dismissing the owner and reset clears a held pointer', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  assert.equal(f.panel.suspend(), true);
  assert.equal(f.content.parentNode, f.home);
  assert.equal(f.docked(), 0);
  f.sync(); f.flushAll();
  assert.equal(f.panel.root.hidden, false);
  f.emit(f.button, 'pointerdown', { pointerId: 12 });
  assert.equal(f.panel.blocked(), true);
  f.panel.reset();
  assert.equal(f.panel.blocked(), false);
  f.sync(); f.flushAll();
  let applied = 0;
  f.panel.defer(() => applied++); f.flushAll();
  assert.equal(applied, 1);
});

test('owner switch and reset discard pending edits from the previous owner', () => {
  const f = fixture();
  f.sync(); f.flushAll(); f.input.focus();
  let stale = 0;
  f.panel.defer(() => stale++);
  f.sync({ token: {}, nodeId: 'node-b' });
  f.input.blur(); f.flushAll();
  assert.equal(stale, 0);
  f.input.focus();
  f.panel.defer(() => stale++);
  f.panel.reset(); f.flushAll();
  assert.equal(stale, 0);
  assert.equal(f.panel.root.hidden, true);
  assert.equal(f.content.parentNode, f.home);
  assert.equal(f.panel.root.dataset.nodeId, '');
});

test('destroy restores the original DOM and makes queued frames, observer deliveries and editing callbacks inert', () => {
  const f = fixture();
  f.sync(); f.flushAll();
  f.input.focus(); f.emit(f.input, 'compositionstart');
  let applied = 0;
  f.panel.defer(() => applied++);
  f.panel.refresh();
  const layoutReads = f.canvas.rectReads;
  const styles = { ...f.panel.root.style };
  f.panel.destroy();
  assert.equal(f.content.parentNode, f.home);
  assert.deepEqual(f.home.children, [f.before, f.content, f.after]);
  assert.equal(f.panel.root.parentNode, null);
  assert.equal(f.observers[0].targets.size, 0);
  const queuedFrames = f.callbacks.length;
  f.observers[0].deliver();
  assert.equal(f.callbacks.length, queuedFrames, 'late ResizeObserver delivery cannot enqueue more layout work');
  f.emit(f.input, 'compositionstart');
  f.emit(f.input, 'compositionend');
  f.emit(f.document, 'pointerup');
  f.emit(f.document.defaultView, 'blur', { bubbles: false, cancelable: false });
  assert.equal(f.callbacks.length, queuedFrames, 'removed editing listeners cannot enqueue work');
  f.sync(); f.panel.refresh(); f.panel.destroy(); f.flushAll();
  assert.equal(applied, 0);
  assert.equal(f.canvas.rectReads, layoutReads);
  assert.deepEqual(f.panel.root.style, styles);
  assert.equal(f.panel.root.parentNode, null);
});
