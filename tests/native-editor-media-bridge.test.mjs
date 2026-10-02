import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { createNativeEditorMedia } from '../web/native-editor-media.mjs';

const code = (await readFile(new URL('../web/native-editor-bridge.js', import.meta.url), 'utf8'))
  .replace("import { app } from '/scripts/app.js';", '')
  .replace("import('/prism-editor-media.mjs')", 'loadMediaFactory()')
  .replace("import('/prism-editor-media-preview.mjs')", 'loadPreviewFactory()');
const clone = value => JSON.parse(JSON.stringify(value));
async function harness({ protocol = 1, failImport = false, native = '', callback = () => {} } = {}) {
  const events = new Map(), replies = [], calls = []; let sequence = 0;
  class Node {
    constructor(values = [native, 42]) { this.id = 1; this.type = this.comfyClass = 'LoadImage';
      this.widgets = [{ name: 'image', type: 'combo', value: values[0], options: { values: [] }, callback },
        { name: 'seed', type: 'number', value: values[1], options: {} }]; }
    serialize() { return { id: this.id, type: this.type, widgets_values: this.widgets.map(w => w.value), mode: 0 }; }
  }
  Node.nodeData = { input: { required: { image: [[], { image_upload: true }], seed: ['INT', {}] } } };
  const root = { _nodes: [new Node()], serialize() { return { nodes: this._nodes.map(n => n.serialize()), links: [] }; },
    getNodeById(id) { return this._nodes.find(n => String(n.id) === String(id)); } };
  root._nodes.forEach(node => { node.graph = root; });
  const app = { rootGraph: root, graph: root, isGraphReady: true, vueAppReady: true,
    canvas: { graph: root, canvas: { isConnected: true }, selected_nodes: {}, setDirty() {} },
    registerExtension(extension) { this.extension = extension; },
    async loadGraphData(document) { calls.push('load'); root._nodes = document.nodes.map(n => new Node(n.widgets_values));
      root._nodes.forEach(n => { n.graph = root; n.onAdded?.(root); }); },
    async graphToPrompt() { calls.push('compile'); const n = root._nodes[0]; return { workflow: root.serialize(), output: { 1: { class_type: 'LoadImage', inputs: { image: n.widgets[0].value, seed: n.widgets[1].value } } } }; } };
  const parent = { postMessage(message) { replies.push(clone(message)); } };
  const config = { parentOrigin: 'http://127.0.0.1:8001', bridgeNonce: 'nonce', backendUrl: 'http://127.0.0.1:8188', mediaProtocol: protocol };
  const window = { parent, app, graph: root, __PRISM_EDITOR__: config,
    crypto: webcrypto, LiteGraph: { registered_node_types: { LoadImage: Node } },
    addEventListener: (event, callback) => events.set(event, callback), setTimeout: callback => callback() };
  const document = { querySelector: () => null };
  vm.runInNewContext(code, { app, window, document, TextEncoder, setTimeout,
    loadMediaFactory() { calls.push('media-import'); return failImport ? Promise.reject(new Error('missing route')) : Promise.resolve({ createNativeEditorMedia }); },
    loadPreviewFactory() { calls.push('preview-import'); return Promise.resolve({ createEditorMediaPreview: undefined }); } });
  app.extension.setup(); await new Promise(setImmediate);
  async function request(action, data = {}) {
    const requestId = `q${++sequence}`;
    events.get('message')({ source: parent, origin: config.parentOrigin,
      data: { source: 'prism-parent', nonce: 'nonce', action, requestId, ...clone(data) } });
    await new Promise(setImmediate);
    return replies.find(reply => reply.requestId === requestId);
  }
  const binding = value => ({ field_id: 'ref', node_id: '1', input: 'image', class_type: 'LoadImage', type: 'image', value,
    media_owner: { name: value, media_type: 'image', backend: config.backendUrl } });
  const patch = (receipt, value, expected_value) => ({ node_id: '1', widget_name: 'image', class_type: 'LoadImage', value, expected_value, media_receipt: receipt });
  await request('load', { document: root.serialize() });
  return { app, root, window, calls, replies, request, binding, patch, node: () => root._nodes[0] };
}
test('old proxy config imports no new modules and retains normal editor load/compile with capability zero', async () => {
  const h = await harness({ protocol: undefined });
  // undefined option uses default; test truly absent protocol with zero.
  const old = await harness({ protocol: 0 });
  assert(!old.calls.includes('media-import')); assert(!old.calls.includes('preview-import'));
  assert.equal(old.replies[0].capabilities.media_capture, 0);
  assert((await old.request('compile')).result.output); assert.equal(old.node().widgets[0].value, '');
  assert.equal(h.replies[0].capabilities.media_capture, 1);
});
test('module failure degrades capability before load without partial native isolation', async () => {
  const h = await harness({ failImport: true });
  assert.equal(h.replies[0].capabilities.media_capture, 0);
  assert.equal(Object.getOwnPropertyDescriptor(h.node(), 'imgs'), undefined);
  assert((await h.request('compile')).result.output);
});
test('capture does not write filename and compile echoes receipt only for current actual owner', async () => {
  const h = await harness({ native: 'missing-N.png' }), before = h.root.serialize();
  const result = (await h.request('captureMedia', { bindings: [h.binding('C.png')] })).result;
  assert.equal(result.captured[0].native_value, 'missing-N.png'); assert.deepEqual(h.root.serialize(), before);
  const compiled = (await h.request('compile')).result;
  assert.equal(compiled.controls.find(c => c.input === 'image').media_receipt, result.captured[0].receipt);
  h.node().widgets[0] = { ...h.node().widgets[0] };
  const replaced = (await h.request('compile')).result;
  assert.equal(replaced.controls.find(c => c.input === 'image').media_receipt, undefined);
});
test('exact receipt supports absent-enum C and empty/stale N cleanup/restore without broad combo relaxation', async () => {
  for (const native of ['', 'missing-N.png']) {
    const h = await harness({ native });
    const receipt = (await h.request('captureMedia', { bindings: [h.binding('C.png')] })).result.captured[0].receipt;
    for (const [value, expected] of [['C.png', native], [native, 'C.png'], ['C.png', native]]) {
      const result = await h.request('patch', { patches: [h.patch(receipt, value, expected)] });
      assert.equal(result.error, undefined); assert.equal(h.node().widgets[0].value, value);
    }
    const denied = await h.request('patch', { patches: [{ node_id: '1', widget_name: 'image', value: 'unowned.png' }] });
    assert.equal(denied.result.unsupported[0].reason, 'invalid_enum'); assert.equal(h.node().widgets[0].value, 'C.png');
  }
});
test('invalid last receipt or changed expected value prevents the entire batch before any writes', async () => {
  const h = await harness(), receipt = (await h.request('captureMedia', { bindings: [h.binding('C.png')] })).result.captured[0].receipt;
  const before = h.root.serialize();
  const invalid = await h.request('patch', { patches: [{ node_id: '1', widget_name: 'seed', value: 9 }, h.patch('bad', 'C.png', '')] });
  assert.equal(invalid.result.unsupported[0].reason, 'invalid_media_receipt'); assert.deepEqual(h.root.serialize(), before);
  h.node().widgets[0].value = 'inner.png';
  const conflict = await h.request('patch', { patches: [h.patch(receipt, 'C.png', '')] });
  assert.equal(conflict.result.unsupported[0].reason, 'conflict'); assert.equal(h.node().widgets[0].value, 'inner.png');
});
test('unexpected callback change to any sibling API input rolls the entire media patch back', async () => {
  const h = await harness({ callback(_value, _canvas, node) { node.widgets[1].value = 999; } });
  const before = h.root.serialize(), receipt = (await h.request('captureMedia', { bindings: [h.binding('C.png')] })).result.captured[0].receipt;
  const result = await h.request('patch', { patches: [h.patch(receipt, 'C.png', '')] });
  assert.equal(result.result.rolled_back, true); assert.equal(result.result.applied.length, 0); assert.deepEqual(h.root.serialize(), before);
  const compiled = (await h.request('compile')).result;
  assert.equal(compiled.controls.find(c => c.input === 'image').media_receipt, undefined);
});
test('own F then connected C recapture preserves current actual N and retires the previous capability', async () => {
  const h = await harness({ native: 'N.png' });
  const own = (await h.request('captureMedia', { bindings: [h.binding('F.png')] })).result.captured[0];
  assert.equal((await h.request('patch', { patches: [h.patch(own.receipt, 'F.png', 'N.png')] })).error, undefined);
  const connected = (await h.request('captureMedia', { bindings: [h.binding('C.png')] })).result.captured[0];
  assert.equal(connected.native_value, 'F.png');
  const old = await h.request('patch', { patches: [h.patch(own.receipt, 'F.png', 'F.png')] }); assert(old.error);
  assert.equal((await h.request('patch', { patches: [h.patch(connected.receipt, 'C.png', 'F.png')] })).error, undefined);
});
