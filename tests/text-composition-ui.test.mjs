import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNode, connect, removeEdges, generationPayload, parseGraph, serializeGraph, generationInputPorts, edgeInputField } from '../web/graph.mjs';
import { inputPortCandidates } from '../web/canvas-port-layout.mjs';
import { createWorkflowCanvas } from '../web/workflow-canvas.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';
import { coerceFieldValue, defaultValues } from '../web/packages.mjs';
import { interfacePage, interfaceSearch } from '../web/interface-pagination.mjs';
import { INTERFACE_PAGE_SIZE } from '../web/interface-limits.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const flatten = root => [root, ...root.children.flatMap(flatten)];
function sameRealmJSON(value) {
  if (!value || typeof value !== 'object') return;
  Object.setPrototypeOf(value, Array.isArray(value) ? Array.prototype : Object.prototype);
  for (const child of Object.values(value)) sameRealmJSON(child);
}
class Element {
  constructor(tag, cls = '', text = '') { Object.assign(this, { tagName: tag, className: cls, textContent: text, children: [], dataset: {}, style: {}, listeners: {}, value: '', disabled: false }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  setAttribute(name, value) { this[name] = value; }
  querySelectorAll() { return flatten(this).filter(item => ['input', 'textarea', 'select', 'button'].includes(item.tagName)); }
  closest() { return null; }
  checkValidity() { return true; }
}
function harness({ composition = 'paragraphs', connected = true, own = 'OWN' } = {}) {
  const definition = { id: 'pos', label: '正向内容', node_id: '1', input: 'text', type: 'text', default: 'WORKFLOW DEFAULT' };
  const node = { ...createNode('generation', 0, 0, { kind: 'package', package_id: 'pack', packageFields: [definition], packageValues: { pos: own }, ...(composition ? { packageTextCompositions: { pos: composition } } : {}) }), id: 'target' };
  const a = { ...createNode('prompt', 0, 0, { title: '场景描述', text: 'SCENE', negative: 'BAD SCENE' }), id: 'a' };
  const b = { ...createNode('prompt', 0, 0, { title: '人物描述', text: 'CHARACTER', negative: 'BAD CHARACTER' }), id: 'b' };
  const graph = { nodes: [a, b, node], edges: [] };
  if (connected) { connect(graph, 'a', node.id, { targetField: 'pos', sourceField: 'text' }); if (composition) connect(graph, 'b', node.id, { targetField: 'pos', sourceField: 'negative' }); }
  const pack = { id: 'pack', name: 'Workflow', fields: [definition] };
  const state = { wrap: new Element('div'), errors: [], toasts: [], renders: 0, mutations: 0 };
  const workflowCanvas = createWorkflowCanvas({ graph: () => graph });
  const sandbox = { graph, node, settings: { backend_url: 'http://127.0.0.1:8188' }, activeSidebarPackage: null, packageCatalog: { peek: () => pack }, currentCanvasIdentity: () => 'canvas', getNode: id => graph.nodes.find(n => n.id === id),
    packageMediaOwner: () => 'canvas:target', packageMediaTransfers: createMediaTransfers(), workflowCanvas, workflowConfigurations: {}, coerceFieldValue, defaultValues, fieldType: field => field.type,
    interfacePage, interfaceSearch, INTERFACE_PAGE_SIZE, generationInputPorts, edgeInputField, inputPortCandidates, draftEditing: null,
    el: (tag, cls, text) => new Element(tag, cls, text), button: (text, cls, fn) => { const item = new Element('button', cls, text); item.listeners.click = fn; return item; },
    section() {}, packageMediaPreview: () => null, mutate: fn => { state.mutations++; fn(); sameRealmJSON(graph); }, removeEdges,
    reportError: error => state.errors.push(error.message), toast: (message, error) => state.toasts.push({ message, error }),
    renderInspector() { state.renders++; state.wrap.replaceChildren(); sandbox.renderPackageInputs(state.wrap, node); },
    queueMicrotask, renderNodes() {}, nativeEditor: {}, openNodeWorkflow() {}, exportPackage() {},
  };
  vm.runInNewContext(part('function bindDraft(', 'function section(') + part('const interfaceViews =', 'function packageMediaPreview(') + part('function renderPackageInputs(', 'async function loadPackages('), sandbox);
  sandbox.renderInspector();
  const control = () => flatten(state.wrap).find(item => item.dataset.packageField === 'pos');
  const textarea = () => flatten(control()).find(item => item.tagName === 'textarea');
  const mode = () => flatten(state.wrap).find(item => item.tagName === 'select' && item['aria-label'] === '正向内容 · 合并方式');
  const button = text => flatten(state.wrap).find(item => item.tagName === 'button' && item.textContent === text);
  return { state, sandbox, node, graph, a, b, control, textarea, mode, button, workflowCanvas };
}

test('actual sidebar keeps own text editable and shows all ordered connected sources in composition mode', () => {
  const h = harness(), input = h.textarea();
  assert.equal(input.value, 'OWN'); assert.equal(input.disabled, false);
  const description = h.workflowCanvas.describeInput('target', { id: 'pos', type: 'text' });
  assert.equal(description.edges.length, 2); assert.match(description.text, /场景描述.*正向提示词.*人物描述.*负向提示词/);
  assert(flatten(h.control()).some(item => item.textContent.includes(description.text)));
  input.value = 'EDITED OWN'; input.listeners.input();
  assert.equal(h.node.data.packageValues.pos, 'EDITED OWN');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE\n\nBAD CHARACTER\n\nEDITED OWN');
  assert.deepEqual(h.state.errors, []);
});

test('composition switch changes separator with all sources retained, replace with multiple sources is refused', () => {
  const h = harness(), before = structuredClone(h.graph);
  h.mode().value = 'replace'; h.mode().listeners.change();
  assert.deepEqual(h.graph, before); assert.match(h.state.toasts.at(-1).message, /先保留一条/);
  h.mode().value = 'comma'; h.mode().listeners.change();
  assert.equal(h.node.data.packageTextCompositions.pos, 'comma');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE, BAD CHARACTER, OWN');
  assert.deepEqual(h.graph.edges, before.edges);
});

test('disconnect all returns to stored own text and leaves composition metadata for future reconnection', () => {
  const h = harness(); h.button('断开全部').listeners.click(); h.sandbox.renderInspector();
  assert.equal(h.graph.edges.length, 0); assert.equal(h.node.data.packageValues.pos, 'OWN');
  assert.equal(h.node.data.packageTextCompositions.pos, 'paragraphs');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'OWN');
  assert.equal(h.textarea().disabled, false);
  connect(h.graph, 'b', 'target', { targetField: 'pos', sourceField: 'text' });
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'CHARACTER\n\nOWN');
});

test('single edge replace disables fallback editor but independent mode selector can restore editable composition', () => {
  const h = harness({ composition: null });
  assert.equal(h.textarea().disabled, true); assert.equal(h.mode().disabled, false);
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE');
  h.mode().value = 'paragraphs'; h.mode().listeners.change();
  assert.equal(h.textarea().disabled, false); assert.equal(h.node.data.packageValues.pos, 'OWN');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE\n\nOWN');
  h.mode().value = 'replace'; h.mode().listeners.change();
  assert.equal(h.textarea().disabled, true); assert.equal(h.node.data.packageValues.pos, 'OWN');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE');
});

test('after individual disconnect and reconnection, UI and execution follow durable edge order', () => {
  const h = harness(); removeEdges(h.graph, [h.graph.edges[0].id]);
  connect(h.graph, 'a', 'target', { targetField: 'pos', sourceField: 'text' }); h.sandbox.renderInspector();
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'BAD CHARACTER\n\nSCENE\n\nOWN');
  assert.match(h.workflowCanvas.describeInput('target', { id: 'pos', type: 'text' }).text, /^人物描述.*场景描述/);
  const saved = parseGraph(serializeGraph(h.graph));
  assert.equal(generationPayload(saved, 'target').values.pos, 'BAD CHARACTER\n\nSCENE\n\nOWN');
});

test('explicit v1 cannot silently accept composition, while ordinary v1 and mixed v2 graphs remain compatible', () => {
  const h = harness(), document = JSON.parse(serializeGraph(h.graph));
  assert.equal(document.schema, 'frameweave.canvas.v2');
  assert.equal(parseGraph(document).nodes.find(n => n.id === 'target').data.packageValues.pos, 'OWN');
  document.schema = 'frameweave.canvas.v1'; assert.throws(() => parseGraph(document), /v2/);
  const plain = harness({ composition: null, connected: false });
  assert.equal(JSON.parse(serializeGraph(plain.graph)).schema, 'frameweave.canvas.v1');
  assert.equal(parseGraph(serializeGraph(plain.graph)).nodes.length, 3);
});

test('actual port purpose panel lists every text source and disconnects the whole input without changing own fallback', () => {
  const h = harness(), wrap = new Element('div');
  h.sandbox.renderInputPortSettings(wrap, h.node);
  assert(flatten(wrap).some(item => /来自 场景描述、人物描述（负向）/.test(item.textContent)));
  const input = flatten(wrap).find(item => item.tagName === 'input' && item['aria-label'] === '正向内容');
  input.value = '场景 + 人物 + 自身'; input.listeners.input();
  assert.equal(h.node.data.inputLabels.pos, '场景 + 人物 + 自身');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE\n\nBAD CHARACTER\n\nOWN');
  const disconnect = flatten(wrap).find(item => item.tagName === 'button' && item.textContent === '断开此输入的全部连接');
  assert(disconnect); disconnect.listeners.click();
  assert.equal(h.graph.edges.length, 0); assert.equal(h.node.data.packageValues.pos, 'OWN');
  assert.equal(h.node.data.packageTextCompositions.pos, 'paragraphs');
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'OWN');
});

test('repeated prompt occurrence displays second reference and every source in both actual sidebar panels', () => {
  const h = harness();
  h.graph.edges.push({ ...h.graph.edges[0], id: 'repeat-a', sourceOccurrence: 1 }); h.sandbox.renderInspector();
  const description = h.workflowCanvas.describeInput('target', { id: 'pos', type: 'text' });
  assert.equal(description.edges.length, 3); assert.match(description.text, /场景描述.*人物描述.*场景描述.*第2次引用/);
  assert(flatten(h.control()).some(item => item.textContent.includes(description.text)));
  assert.equal(h.textarea().disabled, false); assert.equal(h.node.data.packageValues.pos, 'OWN');
  const wrap = new Element('div'); h.sandbox.renderInputPortSettings(wrap, h.node);
  assert(flatten(wrap).some(item => /来自 场景描述、人物描述（负向）、场景描述（第2次引用）/.test(item.textContent)));
  assert.equal(generationPayload(h.graph, 'target').values.pos, 'SCENE\n\nBAD CHARACTER\n\nSCENE\n\nOWN');
});
