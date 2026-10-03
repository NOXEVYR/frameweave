import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createNativeEditorMedia } from '../web/native-editor-media.mjs';

function fixture({ kind = 'LoadImage', metadata = { image_upload: true }, extraMedia = false, observerThrows = false } = {}) {
  const observers = [], listeners = new Map(), frames = [], shown = [], previewState = { identity: '' };
  class Node {
    constructor() {
      this.id = 1; this.type = this.comfyClass = kind; this.title = 'Native'; this.imgs = ['native-own-preview'];
      this.widgets = [{ name: 'image', type: 'combo', value: 'own.png' }];
      if (extraMedia) this.widgets.push({ name: 'second', type: 'combo', value: 'other.png' });
    }
    addDOMWidget(name, _type, element) { const widget = { name, element }; this.widgets.push(widget); return widget; }
  }
  Node.nodeData = { input: { required: { image: [[], metadata], ...(extraMedia ? { second: [[], { image_upload: true }] } : {}) } } };
  const node = new Node(), root = { _nodes: [node] }, selected = {}, app = { canvas: { selected_nodes: selected } };
  node.graph = root;
  const element = tag => {
    const properties = new Map(), priorities = new Map();
    return { tagName: tag.toUpperCase(), hidden: false, autoplay: true, paused: 0,
      style: { setProperty(key, value, priority = '') { properties.set(key, value); priorities.set(key, priority); },
        getPropertyValue(key) { return properties.get(key) || ''; }, getPropertyPriority(key) { return priorities.get(key) || ''; } },
      pause() { this.paused++; }, querySelectorAll() { return []; }, setAttribute() {}, remove() {} };
  };
  const document = { createElement: element, body: { appendChild() {} }, addEventListener(event, callback) { listeners.set(event, callback); } };
  const window = { crypto: webcrypto, LiteGraph: { registered_node_types: { [kind]: Node } }, requestAnimationFrame(callback) { frames.push(callback); },
    addEventListener(event, callback) { listeners.set(event, callback); },
    MutationObserver: class { constructor(callback) { if (observerThrows) throw new Error('observer unavailable'); this.callback = callback; this.targets = new Set(); this.disconnected = false; observers.push(this); }
      observe(target) { this.targets.add(target); } disconnect() { this.targets.clear(); this.disconnected = true; } } };
  const media = createNativeEditorMedia({ app, window, document, graph: () => root, config: { backendUrl: 'http://127.0.0.1:8188' },
    findWidget(id, input) { const owner = root._nodes.find(node => String(node.id) === id); const widget = owner?.widgets.find(widget => widget.name === input); return widget ? { node: owner, owner, widget } : { reason: 'missing' }; },
    createPreview() { return { show(item) { Object.assign(previewState, item); shown.push(item); }, clear() { previewState.identity = ''; }, getState() { return previewState; }, destroy() {} }; } });
  return { media, node, Node, root, selected, observers, listeners, frames, shown, element };
}

test('uncaptured standard media selected after arm still has a controlled own preview', () => {
  const h = fixture(); h.media.arm(); h.selected['1'] = h.node; h.media.refreshPreview();
  assert.equal(h.node.imgs, undefined); assert.equal(h.shown[0].filename, 'own.png');
});

test('unsupported CORE upload transport preserves its existing native preview rather than hiding without replacement', () => {
  const h = fixture({ metadata: { image_upload: true, image_folder: 'output' } });
  h.media.arm(); h.selected['1'] = h.node; h.media.refreshPreview();
  assert.deepEqual(h.node.imgs, ['native-own-preview']);
  assert.notEqual(h.node.hideOutputImages, true); assert.equal(h.shown.length, 0);
});

test('CORE node with multiple media slots does not lose all native previews when the single-preview adapter cannot select a slot', () => {
  const h = fixture({ extraMedia: true }); h.media.arm(); h.selected['1'] = h.node; h.media.refreshPreview();
  assert.ok(h.shown.length > 0 || h.node.imgs?.length > 0);
});

test('arm failure cannot leave native preview descriptors changed while bootstrap falls back to noMedia', () => {
  const h = fixture({ observerThrows: true }); const before = Object.getOwnPropertyDescriptors(h.node);
  try { h.media.arm(); } catch { /* Bridge fallback currently catches arm failure. */ }
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.node, 'imgs'), before.imgs);
  assert.equal(Object.getOwnPropertyDescriptor(h.node, 'hideOutputImages'), before.hideOutputImages);
});

test('late videoContainer and changed hidden/style attributes are covered by actual factory guards', () => {
  const h = fixture(); h.media.arm(); const video = h.element('video'); h.node.videoContainer = video;
  assert.equal(video.hidden, true); assert.equal(video.style.getPropertyValue('display'), 'none'); assert.equal(video.autoplay, false);
  video.hidden = false; video.style.setProperty('display', 'block'); h.observers[0].callback();
  assert.equal(video.hidden, true); assert.equal(video.style.getPropertyPriority('display'), 'important');
});

const { readFile } = await import('node:fs/promises');
const bridgeFixture = await readFile(new URL('./native-editor-media-bridge.test.mjs', import.meta.url), 'utf8');
const factoryURL = new URL('../web/native-editor-media.mjs', import.meta.url).href;
const bridgeURL = new URL('../web/native-editor-bridge.js', import.meta.url).href;
const prefix = bridgeFixture.slice(0, bridgeFixture.indexOf("\ntest('old proxy config"))
  .replace("'../web/native-editor-media.mjs'", JSON.stringify(factoryURL))
  .replace("new URL('../web/native-editor-bridge.js', import.meta.url)", `new URL(${JSON.stringify(bridgeURL)})`)
  .replace('vm.runInNewContext(code,', "window.MutationObserver = class { constructor() { throw new Error('observer failed during bootstrap'); } }; vm.runInNewContext(code,")
  + '\nexport { harness };';
const { harness: bootstrapHarness } = await import(`data:text/javascript;base64,${Buffer.from(prefix).toString('base64')}`);

test('actual bridge environment isolation failure keeps normal load and defers capture without residual descriptors', async () => {
  const h = await bootstrapHarness({ native: 'N.png' });
  assert.equal(h.replies.find(reply => reply.action === 'ready').capabilities.media_capture, 0);
  assert.equal(h.replies.find(reply => reply.requestId === 'q1').error, undefined);
  assert.equal(h.node().imgs, undefined); // Original harness node has no imgs property.
  assert.equal(Object.getOwnPropertyDescriptor(h.node(), 'imgs'), undefined);
  const capture = await h.request('captureMedia', { bindings: [h.binding('C.png')] });
  assert.deepEqual(capture.result.captured, []);
  assert.equal(capture.result.unsupported[0].reason, 'media_capture_not_supported');
});

test('removed native media node disconnects its actual isolation observer', () => {
  const h = fixture(); h.media.arm(); const video = h.element('video'); h.node.videoContainer = video;
  const observer = h.observers[0]; assert.equal(observer.targets.has(video), true);
  h.root._nodes = []; h.node.onRemoved?.(); h.media.refreshPreview();
  assert.equal(observer.disconnected, true);
});

test('early wrapper preserves original nodeCreated once and suppresses its late rAF preview writes', () => {
  const h = fixture(); let created = 0;
  h.Node.prototype.onNodeCreated = function () {
    created++; this.imgs = ['initial']; h.frames.push(() => { this.imgs = ['late baseline']; this.videoContainer = h.element('video'); });
  };
  h.media.arm(); h.media.arm();
  const next = new h.Node(); next.onNodeCreated(); h.root._nodes = [next]; next.graph = h.root; next.onAdded?.(h.root); h.selected['1'] = next;
  while (h.frames.length) h.frames.shift()();
  assert.equal(created, 1); assert.equal(next.imgs, undefined); assert.equal(next.videoContainer.hidden, true);
  h.media.refreshPreview(); assert.equal(h.shown.at(-1).filename, 'own.png');
});

test('unknown plugin media is not isolated merely because its widgets resemble upload controls', () => {
  const h = fixture({ kind: 'PluginVideo' }); h.media.arm();
  assert.deepEqual(h.node.imgs, ['native-own-preview']); assert.equal(h.node.hideOutputImages, undefined);
});

test('audio capture rejected for unsupported presentation leaves the native audio surface visible', () => {
  const h = fixture({ kind: 'LoadAudio', metadata: { audio_upload: true } });
  const audio = h.element('audio'); h.node.addDOMWidget('audioUI', 'audio', audio);
  Object.defineProperty(h.node, 'imgs', { configurable: false, writable: true, value: ['native'] });
  h.media.arm();
  const result = h.media.capture([{ field_id: 'voice', node_id: '1', input: 'image', class_type: 'LoadAudio', type: 'audio', value: 'connected.wav',
    media_owner: { name: 'connected.wav', media_type: 'audio', backend: 'http://127.0.0.1:8188' } }],
  { '1': { class_type: 'LoadAudio', inputs: { image: 'own.png' } } });
  assert.equal(result.captured.length, 0); assert.equal(result.unsupported[0].reason, 'native_preview_not_isolated');
  assert.equal(audio.hidden, false); assert.equal(audio.style.getPropertyValue('display'), ''); assert.equal(audio.paused, 0);
});

test('CORE construction without graph ownership leaves native presentation intact until actual root add', () => {
  const h = fixture(); h.media.arm();
  const node = new h.Node(); node.onNodeCreated?.();
  assert.deepEqual(node.imgs, ['native-own-preview']);
  assert.equal(node.hideOutputImages, undefined);
  assert.equal(h.media.isolateNode(node), false);
  node.graph = h.root; h.root._nodes.push(node); node.onAdded?.(h.root);
  assert.equal(node.imgs, undefined); assert.equal(node.hideOutputImages, true);
});

test('native child graph standard media keeps original image and DOM preview after creation and add', () => {
  const h = fixture(); let added = 0;
  h.Node.prototype.onAdded = function (actual) { added++; assert.equal(this.graph, actual); this.imgs = ['child-added-preview']; };
  h.media.arm();
  const child = { _nodes: [] }, node = new h.Node(), video = h.element('video');
  node.videoContainer = video; node.onNodeCreated?.(); node.graph = child; child._nodes.push(node); node.onAdded?.(child);
  assert.equal(added, 1); assert.deepEqual(node.imgs, ['child-added-preview']);
  assert.equal(node.hideOutputImages, undefined); assert.equal(video.hidden, false);
  assert.equal(video.style.getPropertyValue('display'), '');
  assert.equal(h.media.isolateNode(node), false);
});

test('root onAdded callback runs once after isolation is established', () => {
  const h = fixture(); let added = 0;
  h.Node.prototype.onAdded = function (actual) { added++; assert.equal(this.graph, actual); assert.equal(this.hideOutputImages, true); this.imgs = ['callback-preview']; };
  h.media.arm(); h.media.arm(); const next = new h.Node(); next.onNodeCreated?.();
  next.graph = h.root; h.root._nodes.push(next); next.onAdded(h.root);
  assert.equal(added, 1); assert.equal(next.imgs, undefined);
});

test('same native object moved from root into child graph restores presentation and invalidates root receipt', () => {
  const h = fixture(); let removed = 0, added = 0;
  h.node.onRemoved = function () { removed++; this.imgs = ['latest-removed-preview']; };
  const removalDescriptor = Object.getOwnPropertyDescriptor(h.node, 'onRemoved'), originalAdd = h.node.addDOMWidget;
  h.Node.prototype.onAdded = function (owner) {
    added++; assert.equal(this.graph, owner); assert.deepEqual(this.imgs, ['latest-removed-preview']);
  };
  h.media.arm(); const video = h.element('video'); h.node.videoContainer = video;
  const lateAudio = h.element('audio'); h.node.addDOMWidget('audioUI', 'audioUI', lateAudio);
  const observer = h.observers[0];
  const result = h.media.capture([{ field_id: 'reference', node_id: '1', input: 'image', class_type: 'LoadImage', type: 'image', value: 'connected.png',
    media_owner: { name: 'connected.png', media_type: 'image', backend: 'http://127.0.0.1:8188' } }], { '1': { class_type: 'LoadImage', inputs: { image: 'own.png' } } });
  assert.equal(result.captured.length, 1);
  const child = { _nodes: [] }; h.root._nodes = []; h.node.onRemoved?.();
  assert.equal(h.node.imgs, undefined); // Removed objects stay protected until a real add.
  h.node.graph = child; child._nodes.push(h.node); h.node.onAdded?.(child);
  assert.equal(removed, 1); assert.equal(added, 1); assert.equal(h.node.addDOMWidget, originalAdd);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.node, 'onRemoved'), removalDescriptor);
  observer.callback(); // A previously queued observer cannot re-hide the child.
  h.media.refreshPreview();
  h.node.imgs = ['child-own-preview'];
  assert.deepEqual(h.node.imgs, ['child-own-preview']); assert.notEqual(h.node.hideOutputImages, true);
  assert.equal(video.hidden, false); assert.equal(video.style.getPropertyValue('display'), '');
  assert.equal(video.autoplay, true); assert.equal(lateAudio.hidden, false); assert.equal(lateAudio.autoplay, true);
  const patch = { node_id: '1', widget_name: 'image', class_type: 'LoadImage', value: 'connected.png', media_receipt: result.captured[0].receipt };
  assert.equal(h.media.authorize(patch, { node: h.node, owner: h.node, widget: h.node.widgets[0] }), false);
});

test('same root object remove and readd creates a fresh isolation and receipt without changing widget data', () => {
  const h = fixture(); let removed = 0, added = 0;
  h.node.onRemoved = () => { removed++; };
  h.Node.prototype.onAdded = function (owner) { added++; if (owner === h.root) assert.equal(this.hideOutputImages, true); };
  h.media.arm(); const video = h.element('video'); video.style.setProperty('display', 'grid', 'important'); h.node.videoContainer = video;
  const originalWidgets = h.node.widgets, originalValues = h.node.widgets.map(widget => widget.value), oldObserver = h.observers[0];
  const binding = { field_id: 'reference', node_id: '1', input: 'image', class_type: 'LoadImage', type: 'image', value: 'connected.png',
    media_owner: { name: 'connected.png', media_type: 'image', backend: 'http://127.0.0.1:8188' } };
  const output = { '1': { class_type: 'LoadImage', inputs: { image: 'own.png' } } };
  const old = h.media.capture([binding], output).captured[0];
  const patch = { node_id: '1', widget_name: 'image', class_type: 'LoadImage', value: 'connected.png', media_receipt: old.receipt };
  h.node.onRemoved();
  assert.equal(h.media.authorize(patch, { node: h.node, owner: h.node, widget: h.node.widgets[0] }), false);
  h.root._nodes = []; h.node.graph = null; h.node.imgs = ['late-removed'];
  assert.equal(h.node.imgs, undefined); assert.equal(oldObserver.disconnected, true);
  h.node.graph = h.root; h.root._nodes.push(h.node); h.node.onAdded(h.root);
  assert.equal(removed, 1); assert.equal(added, 1); assert.equal(h.node.imgs, undefined);
  assert.equal(video.hidden, true); assert.equal(video.style.getPropertyValue('display'), 'none');
  assert.notEqual(h.observers.at(-1), oldObserver); assert.equal(h.observers.at(-1).targets.has(video), true);
  const fresh = h.media.capture([binding], output).captured[0];
  assert.ok(fresh.receipt); assert.notEqual(fresh.receipt, old.receipt);
  assert.equal(h.media.authorize(patch, { node: h.node, owner: h.node, widget: h.node.widgets[0] }), false);
  assert.equal(h.media.authorize({ ...patch, media_receipt: fresh.receipt }, { node: h.node, owner: h.node, widget: h.node.widgets[0] }), true);
  assert.equal(h.node.widgets, originalWidgets); assert.deepEqual(h.node.widgets.map(widget => widget.value), originalValues);
  const child = { _nodes: [h.node] }; h.node.onRemoved(); h.root._nodes = []; h.node.graph = child;
  h.node.onAdded(child);
  assert.equal(removed, 2); assert.equal(added, 2); assert.deepEqual(h.node.imgs, ['late-removed']);
  assert.equal(video.hidden, false); assert.equal(video.style.getPropertyValue('display'), 'grid');
  assert.equal(video.style.getPropertyPriority('display'), 'important');
});
