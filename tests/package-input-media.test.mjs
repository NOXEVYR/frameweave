import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { interfacePage, interfaceSearch } from '../web/interface-pagination.mjs';
import { INTERFACE_PAGE_SIZE } from '../web/interface-limits.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
class Element {
  constructor(tag, className = '', text = '') { Object.assign(this, { tagName: tag, className, textContent: text, children: [], dataset: {}, style: {}, listeners: {} }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children=[]; this.append(...items); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll() { return this.children.flatMap(item => [item, ...item.querySelectorAll()]).filter(item => ['input', 'textarea', 'select', 'button'].includes(item.tagName)); }
}
const elements = root => [root, ...root.children.flatMap(elements)];
function harness(type, url = `/api/media/${'a'.repeat(32)}`) {
  const backend = 'http://127.0.0.1:8188', field = { id: 'media', label: 'Reference', node_id: '1', input: 'media', type };
  const node = { id: 'node', data: { package_id: 'pack', packageValues: {} } }, wrap = new Element('div');
  const uploaded = { name: `uploaded.${{ image: 'png', audio: 'wav', video: 'mp4' }[type]}`, backend, url };
  const sandbox = { interfacePage, interfaceSearch, INTERFACE_PAGE_SIZE, URL, Uint8Array, btoa, location: { origin: 'http://127.0.0.1:8871' }, settings: { backend_url: backend },
    activeSidebarPackage: null, currentCanvasIdentity: () => 'canvas', packageCatalog: { peek: () => ({id:'pack',fields:[field]}) },
    packages: [{ id: 'pack', fields: [field] }], packagesLoaded: true, workflowConfigurations: {},
    defaultValues: () => ({ media: '' }), fieldType: field => field.type, coerceFieldValue: (_, value) => value,
    packageMediaOwner: () => 'canvas:node', packageMediaTransfers: createMediaTransfers(),
    currentCanvasIdentity: () => 'canvas', getNode: () => node, mutate: fn => fn(), draftEditing: false,
    el: (tag, cls, text) => new Element(tag, cls, text), button: (text, cls) => new Element('button', cls, text),
    field: label => new Element('label', 'field', label), section() {}, toast() {}, reportError: error => { throw error; },
    uploadImage: async () => uploaded, storeLocalMedia: async () => ({ asset_id: 'b'.repeat(64), media_type: type }),
    api: async () => uploaded, workflowCanvas: { describeInput: () => null },
    renderInspector() { wrap.children = []; sandbox.renderPackageInputs(wrap, node); },
  };
  vm.runInNewContext(part('function mediaURL(', 'async function api(') + part('function outputMedia(', 'function releaseMedia(') +
    part('const interfaceViews =', 'function packageMediaPreview(') + part('function packageMediaPreview(', 'async function loadPackages('), sandbox);
  sandbox.renderInspector();
  return { sandbox, wrap, node, field, uploaded };
}

test('image, audio and video uploads immediately render typed owned previews and an explicit success status', async () => {
  for (const type of ['image', 'audio', 'video']) {
    const h = harness(type);
    const fileInput = elements(h.wrap).find(item => item.tagName === 'input' && item.type === 'file');
    if (type === 'video') assert(elements(h.wrap).some(item => item.textContent === '选择参考视频'));
    fileInput.files = [{ size: 20, arrayBuffer: async () => new ArrayBuffer(20) }];
    fileInput.listeners.change();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    const media = elements(h.wrap).find(item => item.tagName === (type === 'image' ? 'img' : type));
    assert(media, `${type} preview missing`);
    assert.equal(media.src, `http://127.0.0.1:8871${h.uploaded.url}`);
    assert(elements(h.wrap).some(item => item.role === 'status' && /已上传并接入工作流/.test(item.textContent)));
    assert.equal(h.node.data.packageMediaBackends.media.preview_url, h.uploaded.url);
    h.sandbox.renderInspector();
    assert(elements(h.wrap).some(item => item.tagName === media.tagName));
    h.sandbox.settings.backend_url = 'http://127.0.0.1:8189'; h.sandbox.renderInspector();
    assert.equal(elements(h.wrap).some(item => item.tagName === media.tagName), false);
  }
});

test('preview rejects arbitrary URLs, stale filenames and unknown backend owners', () => {
  for (const url of ['https://evil.test/a.png', '/api/settings', `http://127.0.0.1:8871/api/media/${'a'.repeat(32)}`]) {
    const h = harness('image');
    h.node.data.packageMediaBackends = { media: { name: 'image.png', backend: h.sandbox.settings.backend_url, preview_url: url } };
    assert.equal(h.sandbox.packageMediaPreview(h.node, h.field, 'image.png'), null);
  }
  const h = harness('image');
  h.node.data.packageMediaBackends = { media: { name: 'old.png', backend: h.sandbox.settings.backend_url, preview_url: h.uploaded.url } };
  assert.equal(h.sandbox.packageMediaPreview(h.node, h.field, 'new.png'), null);
  delete h.node.data.packageMediaBackends.media.backend;
  assert.equal(h.sandbox.packageMediaPreview(h.node, h.field, 'old.png'), null);
});
