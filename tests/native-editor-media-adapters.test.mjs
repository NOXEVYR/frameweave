import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { nativeMediaContract, createNativeEditorMedia } from '../web/native-editor-media.mjs';
import { vhsPreviewProfile, isolateVhsPreviewSurface } from '../web/native-editor-vhs-preview.mjs';

const cases = [
  ['VHS_LoadVideo', 'video', [['sample.mp4']], 'video'],
  ['LoadImage', 'image', [[]], 'image'],
  ['LoadAudio', 'audio', [[], {}], 'audio'],
  ['ThirdParty', 'file', ['COMBO', { video_upload: true }], 'video'],
  ['ThirdParty', 'file', ['STRING', { audio_upload: true }], 'audio'],
  ['ThirdParty', 'file', [[], { image_upload: true, allow_batch: true }], 'image'],
  ['ThirdParty', 'file', [[], {}], 'video'],
  ['VHS_LoadVideo', 'video', [[], { video_upload: false }], 'video'],
  ['VHS_LoadVideoPath', 'video', [[]], 'video'],
  ['ThirdParty', 'file', [[], { video_upload: true, remote: false }], 'video'],
  ['ThirdParty', 'file', [[], { video_upload: true, multiselect: true }], 'video'],
  ['ThirdParty', 'file', [[], { video_upload: true, folder: 'output' }], 'video'],
  ['ThirdParty', 'file', [[], { video_upload: true, upload: false }], 'video'],
  ['ThirdParty', 'file', [[], { video_upload: true, audio_upload: true }], 'video'],
  ['ThirdParty', 'file', [[], { video_upload: 'true' }], 'video'],
  ['ThirdParty', 'file', ['COMBO', { video_upload: true, options: [1] }], 'video'],
  ['ThirdParty', 'file', ['STRING', { video_upload: true }], 'video'],
];
test('the same single-file schema cases agree with the production Python contract', () => {
  const result = spawnSync('python', ['-c', 'import json,sys;from frameweave.media_contract import media_input_contract;print(json.dumps([media_input_contract(a,b,c) for a,b,c,d in json.load(sys.stdin)]))'],
    { cwd: new URL('..', import.meta.url), input: JSON.stringify(cases), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const contracts = JSON.parse(result.stdout);
  cases.forEach(([classType, input, spec, type], index) => {
    class Node {}
    Node.nodeData = { input: { required: { [input]: spec } } };
    const node = new Node(); node.type = classType;
    const contract = nativeMediaContract(node, input, type, { [classType]: Node });
    assert.equal(Boolean(contract), contracts[index].supported, JSON.stringify(cases[index]));
    if (contract) {
      assert.equal(contract.legacy, contracts[index].legacy);
      assert.equal(contract.transport, contracts[index].transport);
      assert.equal(contract.cardinality, 'single'); assert.equal(contract.storage_type, 'input');
    }
  });
});
test('constructor identity, duplicate groups and hidden bindings never become a schema capability', () => {
  class Node {} class Other {}
  Node.nodeData = Other.nodeData = { input: { required: { video: [[], { video_upload: true }] } } };
  const node = new Node(); node.type = 'ThirdParty';
  assert.equal(nativeMediaContract(node, 'video', 'video', { ThirdParty: Other }), null);
  Node.nodeData.input.optional = Node.nodeData.input.required;
  assert.equal(nativeMediaContract(node, 'video', 'video', { ThirdParty: Node }), null);
  delete Node.nodeData.input.optional; Node.nodeData.input.hidden = { video: 'STRING' };
  assert.equal(nativeMediaContract(node, 'video', 'video', { ThirdParty: Node }), null);
});

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.hidden = false; this.autoplay = true; this.attrs = new Map(); this.loads = 0; this.pauses = 0;
    const values = new Map(), priorities = new Map();
    this.style = { setProperty(k, v, p) { values.set(k, v); priorities.set(k, p); }, getPropertyValue: k => values.get(k), getPropertyPriority: k => priorities.get(k) };
  }
  appendChild(el) { el.parentElement = this; this.children.push(el); }
  querySelectorAll() { return this.children.flatMap(el => [el, ...el.querySelectorAll()]).filter(el => ['VIDEO', 'AUDIO'].includes(el.tagName)); }
  get src() { return this.attrs.get('src') || ''; } set src(value) { this.attrs.set('src', value); }
  setAttribute(name, value) { this.attrs.set(name, value); } removeAttribute(name) { this.attrs.delete(name); }
  pause() { this.pauses++; } load() { this.loads++; }
}
function fixture() {
  const element = new Element('DIV'), parentEl = new Element('DIV'), videoEl = new Element('VIDEO'), imgEl = new Element('IMG');
  element.appendChild(parentEl); parentEl.className = 'vhs_preview'; parentEl.appendChild(videoEl); parentEl.appendChild(imgEl);
  const timers = [], window = { setTimeout(callback, delay) { const item = { callback, delay }; timers.push(item); return item; }, clearTimeout(item) { item.cancelled = true; } };
  const calls = [], widget = { name: 'videopreview', type: 'preview', options: { serialize: false }, element, parentEl, videoEl, imgEl,
    value: { hidden: false, paused: false, params: { filename: 'N.mp4', type: 'input', format: 'video/mp4' } } };
  class Node {
    constructor() { this.id = 7; this.type = this.comfyClass = 'VHS_LoadVideo'; this.widgets = [{ name: 'video', type: 'combo', value: 'N.mp4' }, widget]; }
    serialize() { return { widgets_values: this.widgets.filter(w => w.options?.serialize !== false).map(w => w.value), preview_params: { ...widget.value.params } }; }
    addDOMWidget(name, type, element) { const item = { name, type, element }; this.widgets.push(item); return item; }
  }
  Node.nodeData = { input: { required: { video: [['N.mp4']] } } };
  const node = new Node(); let pending;
  // Independent synthetic scheduler, only used to test our presentation guard.
  widget.updateSource = function () { calls.push('source'); videoEl.src = widget.value.params.filename; };
  widget.callback = widget.updateSource;
  node.updateParameters = function (params, force) {
    Object.assign(widget.value.params, params); if (pending) window.clearTimeout(pending);
    if (force) widget.updateSource(); else pending = window.setTimeout(() => widget.updateSource(), 100);
  };
  const profile = { node, widget, element, parentEl, videoEl, imgEl, version: 'test-surface' };
  const flush = delay => { for (const timer of timers.filter(item => item.delay === delay && !item.done)) { timer.done = true; if (!timer.cancelled) timer.callback(); } };
  return { ...profile, Node, profile, window, timers, calls, flush };
}
test('unknown VHS function versions preserve native presentation and explain capture refusal', () => {
  const f = fixture(), root = { _nodes: [f.node] }; f.node.graph = root;
  f.window.crypto = webcrypto; f.window.LiteGraph = { registered_node_types: { VHS_LoadVideo: f.Node } };
  assert.equal(vhsPreviewProfile(f.node), null);
  const original = f.node.updateParameters, before = f.node.serialize();
  const media = createNativeEditorMedia({ app: { canvas: {} }, window: f.window, graph: () => root,
    findWidget: () => ({ node: f.node, owner: f.node, widget: f.node.widgets[0] }), config: { backendUrl: 'http://127.0.0.1:8188' } });
  media.arm();
  const result = media.capture([{ field_id: 'ref', node_id: '7', input: 'video', type: 'video', class_type: 'VHS_LoadVideo', value: 'C.mp4',
    media_owner: { name: 'C.mp4', media_type: 'video', backend: 'http://127.0.0.1:8188' } }], { 7: { class_type: 'VHS_LoadVideo', inputs: { video: 'N.mp4' } } });
  assert.equal(result.unsupported[0].reason, 'vhs_preview_adapter_unsupported');
  assert.equal(f.node.updateParameters, original); assert.equal(f.element.hidden, false); assert.deepEqual(f.node.serialize(), before); media.destroy();
});
test('surface guard drains old debounce, blocks late src writes and retains genuine parameter updates', () => {
  const f = fixture(), before = f.node.serialize(); f.videoEl.src = 'old.mp4'; f.imgEl.src = 'old.png';
  f.node.updateParameters({}, false);
  const guard = isolateVhsPreviewSurface(f.profile, f.window); assert(guard?.verify());
  assert.equal(f.videoEl.src, ''); assert.equal(f.imgEl.src, ''); assert.equal(f.videoEl.loads, 1);
  f.flush(100); assert.deepEqual(f.calls, []); assert.deepEqual(f.node.serialize(), before);
  f.node.updateParameters({ skip_first_frames: 3 }, false);
  assert.equal(f.widget.value.params.skip_first_frames, 3); assert.deepEqual(f.node.serialize().widgets_values, before.widgets_values);
  f.videoEl.src = 'late.mp4'; f.imgEl.setAttribute('src', 'late.png'); f.videoEl.autoplay = true; f.parentEl.hidden = false;
  f.node.video_query = { stale: true };
  assert.equal(f.videoEl.src, ''); assert.equal(f.imgEl.src, ''); assert.equal(f.videoEl.autoplay, false); assert.equal(f.parentEl.hidden, true); assert.equal(f.node.video_query, undefined);
  guard.release(); f.flush(100); assert.deepEqual(f.calls, []); f.flush(110);
  f.widget.updateSource(); assert.deepEqual(f.calls, ['source']); assert.equal(f.videoEl.src, 'N.mp4');
});
test('release restores exact descriptors after drain and preserves a concurrent replacement', () => {
  const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(f.widget, 'updateSource'), update = Object.getOwnPropertyDescriptor(f.node, 'updateParameters');
  const guard = isolateVhsPreviewSurface(f.profile, f.window), replacement = () => 'new owner';
  f.imgEl.setAttribute = replacement; assert.equal(guard.verify(), false);
  guard.release(); guard.release(); assert.equal(f.timers.filter(t => t.delay === 110).length, 1); f.flush(110);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.widget, 'updateSource'), descriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.node, 'updateParameters'), update);
  assert.equal(Object.getOwnPropertyDescriptor(f.videoEl, 'src'), undefined); assert.equal(f.imgEl.setAttribute, replacement);
});
test('unsupported descriptor is rejected before unloading or changing any native surface', () => {
  const f = fixture(); f.videoEl.src = 'original.mp4'; Object.defineProperty(f.widget, 'callback', { configurable: false, value: f.widget.callback });
  const before = f.node.updateParameters; assert.equal(isolateVhsPreviewSurface(f.profile, f.window), null);
  assert.equal(f.videoEl.src, 'original.mp4'); assert.equal(f.videoEl.loads, 0); assert.equal(f.node.updateParameters, before);
});
test('a removed object retains the barrier; synchronous re-add can establish a fresh lease', () => {
  const f = fixture(), first = isolateVhsPreviewSurface(f.profile, f.window); assert(first.verify());
  f.videoEl.src = 'removed-late.mp4'; assert.equal(f.videoEl.src, ''); first.release(true);
  const second = isolateVhsPreviewSurface(f.profile, f.window); assert(second.verify());
  f.flush(100); f.widget.callback(); assert.deepEqual(f.calls, []); second.release(); f.flush(110);
});
test('widget/DOM replacement revokes a lease even with unchanged filename and function descriptors', () => {
  for (const mode of ['widget', 'dom', 'duplicate', 'element', 'parent-chain']) {
    const f = fixture(), guard = isolateVhsPreviewSurface(f.profile, f.window);
    if (mode === 'widget') f.node.widgets[1] = { ...f.widget };
    if (mode === 'dom') f.widget.videoEl = new Element('VIDEO');
    if (mode === 'duplicate') f.node.widgets.push({ name: 'videopreview' });
    if (mode === 'element') f.widget.element = new Element('DIV');
    if (mode === 'parent-chain') f.parentEl.parentElement = new Element('DIV');
    assert.equal(guard.verify(), false); guard.release(true);
  }
});

const pluginPath = process.env.PRISM_VHS_CORE_PATH;
test('installed VHS functions: runtime capture, pending debounce, observer rollback, remove/readd and close', { skip: !pluginPath }, async () => {
  const source = await readFile(pluginPath, 'utf8');
  const fragment = source.slice(source.indexOf('function addVideoPreview('), source.indexOf('let copiedPath'));
  assert(fragment.startsWith('function addVideoPreview('));
  const parameters = fragment.slice(fragment.indexOf('this.updateParameters = ') + 24, fragment.indexOf('\n        previewWidget.updateSource =')).trim().replace(/;$/, '');
  const updateSource = fragment.slice(fragment.indexOf('previewWidget.updateSource = ') + 29, fragment.indexOf('\n        previewWidget.callback =')).trim();
  function installed() {
    const f = fixture(), network = [];
    const functions = Function('previewWidget', 'previewNode', 'app', 'isInput', 'api', 'fetch', 'setTimeout', 'clearTimeout', `let timeout = null; return [${parameters}, ${updateSource}];`)(
      f.widget, f.node, { ui: { settings: { getSettingValue: () => 'Always' } } }, true, { apiURL: value => value },
      async value => { network.push(value); return { json: async () => ({ source: {} }) }; }, f.window.setTimeout, f.window.clearTimeout);
    [f.node.updateParameters, f.widget.updateSource] = functions; f.widget.callback = f.widget.updateSource;
    return { ...f, network };
  }
  for (const failure of ['construct', 'observe']) {
    const f = installed(), root = { _nodes: [f.node] }; f.node.graph = root;
    const original = f.node.updateParameters, before = f.node.serialize();
    f.window.MutationObserver = class { constructor() { if (failure === 'construct') throw Error('observer unavailable'); } observe() { throw Error('cannot observe'); } disconnect() {} };
    f.window.LiteGraph = { registered_node_types: { VHS_LoadVideo: f.Node } };
    const media = createNativeEditorMedia({ app: { canvas: {} }, window: f.window, graph: () => root });
    assert(vhsPreviewProfile(f.node)); assert.equal(media.isolateNode(f.node), false);
    assert.equal(f.node.updateParameters, original); assert.deepEqual(f.node.serialize(), before); assert.equal(f.parentEl.hidden, false); assert.equal(f.videoEl.loads, 0); media.destroy();
  }
  const f = installed(), root = { _nodes: [f.node] }; f.node.graph = root;
  f.window.LiteGraph = { registered_node_types: { VHS_LoadVideo: f.Node } }; f.window.crypto = webcrypto;
  const original = f.node.updateParameters, before = f.node.serialize(); f.node.updateParameters({ skip_first_frames: 1 }, false);
  assert.equal(f.timers.filter(item => item.delay === 100 && !item.cancelled).length, 1);
  const media = createNativeEditorMedia({ app: { canvas: {} }, window: f.window, graph: () => root, config: { backendUrl: 'http://127.0.0.1:8188' },
    findWidget: () => ({ node: f.node, owner: f.node, widget: f.node.widgets[0] }) });
  media.arm(); f.flush(100); assert.deepEqual(f.network, []); assert.equal(f.videoEl.src, '');
  const binding = { field_id: 'ref', node_id: '7', input: 'video', type: 'video', class_type: 'VHS_LoadVideo', value: 'C.mp4',
    media_owner: { name: 'C.mp4', media_type: 'video', backend: 'http://127.0.0.1:8188' } };
  const output = { 7: { class_type: 'VHS_LoadVideo', inputs: { video: 'N.mp4' } } }, captured = media.capture([binding], output).captured[0];
  assert(captured?.receipt); assert(media.authorize({ node_id: '7', widget_name: 'video', class_type: 'VHS_LoadVideo', media_receipt: captured.receipt, value: 'C.mp4' }, { node: f.node, widget: f.node.widgets[0] }));
  assert.deepEqual(f.node.serialize().widgets_values, before.widgets_values); f.node.updateParameters({ filename: 'C.mp4' }, false); f.flush(100); assert.deepEqual(f.network, []);
  root._nodes = []; f.node.onRemoved(); f.videoEl.src = 'late.mp4'; assert.equal(f.videoEl.src, '');
  root._nodes = [f.node]; f.node.onAdded(root); assert.equal(media.capture([binding], output).captured.length, 1);
  media.destroy(); f.flush(100); assert.deepEqual(f.network, []); f.flush(110);
  assert.equal(f.node.updateParameters, original); assert.equal(f.element.hidden, false); assert.equal(f.videoEl.src, '');
});
