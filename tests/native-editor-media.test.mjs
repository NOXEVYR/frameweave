import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createNativeEditorMedia, nativeMediaContract, safeEditorMediaFilename } from '../web/native-editor-media.mjs';

function element(tag = 'DIV') {
  const values = new Map(), priorities = new Map();
  return { tagName: tag, hidden: false, autoplay: true, paused: 0,
    style: { setProperty(k, v, p) { values.set(k, v); priorities.set(k, p); },
      getPropertyValue: k => values.get(k), getPropertyPriority: k => priorities.get(k) },
    pause() { this.paused++; }, querySelectorAll: () => [] };
}
function fixture({ type = 'image', classType = 'LoadImage', native = '', meta = {}, spec, withPreview = false } = {}) {
  const input = type === 'audio' ? 'audio' : type === 'video' ? 'file' : 'image';
  class Node {
    constructor() { this.id = 1; this.type = this.comfyClass = classType;
      this.widgets = [{ name: input, type: 'combo', value: native, options: { values: [] } }];
      this.imgs = [{ src: 'N.png' }]; this.hideOutputImages = false; }
    addDOMWidget(name, kind, el) { const widget = { name, type: kind, element: el, serialize: false }; this.widgets.push(widget); return widget; }
    serialize() { return { id: this.id, type: this.type, widgets_values: this.widgets.filter(w => w.serialize !== false).map(w => w.value) }; }
  }
  Node.nodeData = { input: { required: { [input]: spec || (type === 'image' ? [[], { image_upload: true, ...meta }] :
    ['COMBO', { options: [], multiselect: false, [`${type}_upload`]: true, ...meta }]) } } };
  const node = new Node();
  if (type === 'audio') node.addDOMWidget('audioUI', 'audioUI', element('AUDIO'));
  let root = { _nodes: [node] };
  node.graph = root;
  const window = { LiteGraph: { registered_node_types: { [classType]: Node } }, crypto: webcrypto, addEventListener() {} };
  const app = { canvas: { selected_nodes: {} } }, config = { backendUrl: 'http://127.0.0.1:8188' };
  const findWidget = (id, name) => {
    const n = root._nodes.find(item => String(item.id) === String(id));
    const matches = n?.widgets.filter(widget => widget.name === name) || [];
    return matches.length === 1 ? { node: n, owner: n, widget: matches[0] } : { reason: 'missing' };
  };
  const events = new Map(), frames = [], shown = [], observers = [];
  window.requestAnimationFrame = callback => frames.push(callback);
  window.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.elements = new Set(); observers.push(this); }
    observe(el) { this.elements.add(el); }
  };
  let previewState = { status: 'empty' };
  const doc = withPreview ? { body: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, remove() {} }),
    addEventListener: (event, callback) => events.set(event, callback) } : null;
  const media = createNativeEditorMedia({ app, window, document: doc, graph: () => root, findWidget, config,
    createPreview: withPreview ? () => ({ show(value) { shown.push(value); previewState = { status: 'pending', ...value }; },
      clear() { previewState = { status: 'empty' }; }, destroy() {}, getState: () => ({ ...previewState }) }) : undefined });
  const output = () => ({ 1: { class_type: classType, inputs: { [input]: node.widgets[0].value } } });
  const binding = (value = 'C.png', extra = {}) => ({ field_id: 'f1', node_id: '1', input, class_type: classType, type, value,
    media_owner: { name: value, backend: config.backendUrl, media_type: type }, ...extra });
  const patch = (receipt, value) => ({ node_id: '1', widget_name: input, class_type: classType, media_receipt: receipt, value });
  return { media, node, Node, window, app, binding, output, patch, findWidget, input, root, events, frames, shown, observers,
    previewState: () => previewState,
    replaceRoot: value => { root = value; } };
}

test('filename contract rejects unsafe paths, annotations and encoded traversal without guessing', () => {
  for (const name of ['', '../a.png', 'x/./a.png', 'C:\\a.png', '/x.png', 'https://host/x.png', 'x [output]', 'x [input]', 'a%2f..%2fx', 'a\u0000.png', 'folder/bad:name.png', 'a'.repeat(1025)]) assert.equal(safeEditorMediaFilename(name), false, name);
  for (const name of ['image.png', 'sub/图像.png', 'sub\\图像.png', 'old-model.png', 'none']) assert.equal(safeEditorMediaFilename(name), true, name);
  assert.equal(safeEditorMediaFilename('', true), true);
  assert.equal(safeEditorMediaFilename('a'.repeat(1024)), true);
});
test('live contract requires actual registered official class and exactly one standard upload flag', () => {
  const h = fixture(); assert(nativeMediaContract(h.node, h.input, 'image', h.window.LiteGraph.registered_node_types));
  for (const meta of [{ image_upload: false }, { image_upload: 'yes' }, { audio_upload: true }, { multiselect: true }, { image_folder: 'output' }, { upload_url: '/custom' }, { allow_batch: true }]) {
    const bad = fixture({ meta }); assert.equal(nativeMediaContract(bad.node, bad.input, 'image', bad.window.LiteGraph.registered_node_types), null);
  }
  const other = fixture({ classType: 'ThirdParty' }); other.media.arm(); assert.equal(other.media.capture([other.binding()], other.output()).captured.length, 0);
});
test('isolation before import suppresses both late Canvas imgs and Vue output flag without changing serialized values', async () => {
  const h = fixture({ native: 'N.png' }), before = h.node.serialize();
  h.media.arm(); assert.deepEqual(h.node.serialize(), before);
  h.node.imgs = [{ src: 'late-N.png' }]; h.node.hideOutputImages = false;
  await Promise.resolve(); assert.equal(h.node.imgs, undefined); assert.equal(h.node.hideOutputImages, true);
  assert.deepEqual(h.node.serialize(), before);
  const created = new h.Node(); created.graph = h.root; h.root._nodes.push(created); created.onAdded(h.root); created.imgs = [{ src: 'late-C.png' }];
  assert.equal(created.imgs, undefined); assert.equal(created.hideOutputImages, true);
});
test('native video DOM surfaces created after arming remain hidden, paused and absent from serialization', () => {
  const h = fixture({ type: 'video' }); h.media.arm(); const before = h.node.serialize();
  const el = element('VIDEO'); h.node.addDOMWidget('video-preview', 'video', el);
  assert.equal(el.hidden, true); assert.equal(el.style.getPropertyValue('display'), 'none'); assert.equal(el.autoplay, false);
  const container = element(); h.node.videoContainer = container;
  assert.equal(container.hidden, true); assert.deepEqual(h.node.serialize(), before);
});
test('unsupported descriptors never receive a media receipt', () => {
  const h = fixture(); Object.defineProperty(h.node, 'imgs', { configurable: false, value: [] });
  h.media.arm(); const result = h.media.capture([h.binding()], h.output());
  assert.equal(result.captured.length, 0); assert.equal(result.unsupported[0].reason, 'native_preview_not_isolated');
  assert.equal(h.node.widgets[0].value, '');
});
test('capture retains exact empty or stale N and does not write C or update combo options', () => {
  for (const native of ['', 'missing-N.png']) {
    const h = fixture({ native }); h.media.arm(); const before = h.node.serialize();
    const result = h.media.capture([h.binding()], h.output()), entry = result.captured[0];
    assert(entry.receipt); assert.equal(entry.native_value, native); assert.equal(entry.preview_state, 'pending');
    assert.deepEqual(h.node.serialize(), before); assert.deepEqual(h.node.widgets[0].options.values, []);
    assert.equal(h.media.authorize(h.patch(entry.receipt, 'C.png'), h.findWidget('1', h.input)), true);
    assert.equal(h.media.authorize(h.patch(entry.receipt, native), h.findWidget('1', h.input)), true);
    assert.equal(h.media.authorize(h.patch(entry.receipt, 'other.png'), h.findWidget('1', h.input)), false);
  }
});
test('capture rejects missing owner, wrong backend, type, owner filename, nested and API/widget mismatch', () => {
  for (const extra of [{ media_owner: null }, { media_owner: { name: 'C.png', backend: 'http://127.0.0.1:8189', media_type: 'image' } },
    { media_owner: { name: 'other.png', backend: 'http://127.0.0.1:8188', media_type: 'image' } },
    { media_owner: { name: 'C.png', backend: 'http://127.0.0.1:8188', media_type: 'video' } }, { node_id: '1:1' }]) {
    const h = fixture(); h.media.arm(); const result = h.media.capture([h.binding('C.png', extra)], h.output()); assert.equal(result.captured.length, 0);
  }
  const h = fixture(); h.media.arm(); const output = h.output(); output[1].inputs.image = 'different.png';
  assert.equal(h.media.capture([h.binding()], output).unsupported[0].reason, 'media_mapping_unproven');
});
test('receipt echo observes safe I only and replacement node/widget/graph or changed schema invalidates proof', () => {
  for (const change of ['node', 'widget', 'graph', 'schema', 'isolation']) {
    const h = fixture(); h.media.arm(); const receipt = h.media.capture([h.binding()], h.output()).captured[0].receipt;
    h.node.widgets[0].value = 'I.png'; const controls = [{ node_id: '1', input: h.input }]; h.media.observe(h.output(), controls);
    assert.equal(controls[0].media_receipt, receipt); assert(h.media.authorize(h.patch(receipt, 'I.png'), h.findWidget('1', h.input)));
    if (change === 'node') { const replacement = new h.Node(); replacement.graph = h.root; h.root._nodes[0] = replacement; }
    if (change === 'widget') h.node.widgets[0] = { ...h.node.widgets[0] };
    if (change === 'graph') h.replaceRoot({ _nodes: [h.node] });
    if (change === 'schema') h.Node.nodeData.input.required[h.input][1].image_upload = false;
    if (change === 'isolation') Object.defineProperty(h.node, 'hideOutputImages', { configurable: true, value: false });
    const after = [{ node_id: '1', input: h.input }]; h.media.observe(h.output(), after);
    assert.equal(after[0].media_receipt, undefined); assert.equal(h.media.authorize(h.patch(receipt, 'C.png'), h.findWidget('1', h.input)), false);
  }
});
test('own then connected recapture records actual new N and invalidates only old slot receipt', () => {
  const h = fixture({ native: 'N.png' }); h.media.arm(); const old = h.media.capture([h.binding('own.png')], h.output()).captured[0];
  h.node.widgets[0].value = 'own.png'; const controls = [{ node_id: '1', input: h.input }]; h.media.observe(h.output(), controls);
  const next = h.media.capture([h.binding('connected.png')], h.output()).captured[0];
  assert.equal(next.native_value, 'own.png'); assert.notEqual(next.receipt, old.receipt);
  assert.equal(h.media.authorize(h.patch(old.receipt, 'own.png'), h.findWidget('1', h.input)), false);
  assert.equal(h.media.authorize(h.patch(next.receipt, 'own.png'), h.findWidget('1', h.input)), true);
});
test('reset invalidates receipts but preserves runtime isolation against late promises', () => {
  const h = fixture(); h.media.arm(); const receipt = h.media.capture([h.binding()], h.output()).captured[0].receipt;
  h.media.reset(); assert.equal(h.media.authorize(h.patch(receipt, 'C.png'), h.findWidget('1', h.input)), false);
  h.node.imgs = [{ src: 'late-C.png' }]; assert.equal(h.node.imgs, undefined);
});
test('cleanup compile of N cannot erase the proven I needed to restore the visible internal choice', () => {
  const h = fixture({ native: 'N.png' }); h.media.arm(); const receipt = h.media.capture([h.binding()], h.output()).captured[0].receipt;
  h.node.widgets[0].value = 'picked/I.png'; h.media.observe(h.output(), [{ node_id: '1', input: h.input }]);
  h.node.widgets[0].value = 'N.png'; h.media.observe(h.output(), [{ node_id: '1', input: h.input }]);
  assert.equal(h.media.authorize(h.patch(receipt, 'picked/I.png'), h.findWidget('1', h.input)), true);
  assert.equal(h.media.authorize(h.patch(receipt, 'unknown.png'), h.findWidget('1', h.input)), false);
});
test('audio capture requires the real unique audioUI element, keeps it silent and hidden', () => {
  const h = fixture({ type: 'audio', native: 'old.wav' }); h.media.arm();
  assert.equal(h.node.widgets[1].element.hidden, true); assert.equal(h.node.widgets[1].element.autoplay, false);
  assert.equal(h.media.capture([h.binding('new.wav')], h.output()).captured.length, 1);
  h.node.widgets.pop(); assert.equal(h.media.capture([h.binding('new.wav')], h.output()).unsupported[0].reason, 'native_preview_not_isolated');
});
test('duplicate field identities and binding tuples cannot receive two current capabilities', () => {
  const h = fixture(); h.media.arm(); const result = h.media.capture([h.binding(), h.binding('other.png')], h.output());
  assert.equal(result.captured.length, 0); assert.equal(result.unsupported.length, 2);
  assert.equal(result.unsupported[0].reason, 'ambiguous_media_binding');
});
test('selected native media retains controlled N preview without any external capture or override', () => {
  const h = fixture({ native: 'N.png', withPreview: true }); h.media.arm();
  h.app.canvas.selected_nodes = { 1: h.node }; h.media.refreshPreview();
  assert.equal(h.previewState().filename, 'N.png'); assert.equal(h.shown.length, 1);
  assert.deepEqual(h.node.serialize().widgets_values, ['N.png']);
  h.app.canvas.selected_nodes = {}; h.media.refreshPreview(); assert.equal(h.previewState().status, 'empty');
});
test('keyboard and input/change schedule bounded refresh and selecting a nonmedia node clears the former preview', () => {
  const h = fixture({ native: 'N.png', withPreview: true }); h.media.arm();
  h.app.canvas.selected_nodes = { 1: h.node }; h.media.refreshPreview();
  h.node.widgets[0].value = 'keyboard-I.png';
  for (const name of ['input', 'change', 'keyup', 'pointerup']) h.events.get(name)();
  assert.equal(h.frames.length, 1); h.frames.shift()(); assert.equal(h.previewState().filename, 'keyboard-I.png');
  const prompt = { id: 2, type: 'Text', widgets: [] }; h.root._nodes.push(prompt); h.app.canvas.selected_nodes = { 2: prompt };
  h.events.get('keyup')(); h.frames.shift()(); assert.equal(h.previewState().status, 'empty');
});
test('same-ID replacement and stale selection cannot reuse an old native preview identity', () => {
  const h = fixture({ native: 'N.png', withPreview: true }); h.media.arm();
  h.app.canvas.selected_nodes = { 1: h.node }; h.media.refreshPreview(); const old = h.previewState().identity;
  const replacement = new h.Node(); replacement.graph = h.root; h.root._nodes[0] = replacement; replacement.onAdded(h.root);
  h.media.refreshPreview(); assert.equal(h.previewState().status, 'empty');
  h.app.canvas.selected_nodes = { 1: replacement }; h.media.refreshPreview();
  assert.equal(h.previewState().filename, 'N.png'); assert.notEqual(h.previewState().identity, old);
});
test('late videoContainer and DOM widget surfaces are observed and rehidden after style rewrites', () => {
  const h = fixture({ type: 'video' }); h.media.arm(); const surface = element('VIDEO'); h.node.videoContainer = surface;
  assert(h.observers[0].elements.has(surface));
  surface.hidden = false; surface.style.setProperty('display', 'block'); h.observers[0].callback();
  assert.equal(surface.hidden, true); assert.equal(surface.style.getPropertyPriority('display'), 'important');
  const later = element('VIDEO'); h.node.addDOMWidget('video-preview', 'video', later);
  assert(h.observers[0].elements.has(later));
});
test('4097 capture entries reject before generating any capability and byte limits include actual UTF8', () => {
  const h = fixture(); h.media.arm();
  assert.throws(() => h.media.capture(Array.from({ length: 4097 }, () => h.binding()), h.output()), /invalid-media-bindings/);
  assert.throws(() => h.media.capture([h.binding('C.png', { label: '界'.repeat(710000) })], h.output()), /invalid-media-bindings/);
  assert.equal(h.node.widgets[0].value, '');
});
