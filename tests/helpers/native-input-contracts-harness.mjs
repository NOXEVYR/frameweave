import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const bridge = (await readFile(new URL('../../web/native-editor-bridge.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
const clone = value => JSON.parse(JSON.stringify(value));

export async function fixture({ nested = false, shared = false } = {}) {
  class TextSource {}
  class GenericDynamic {}
  TextSource.nodeData = { input: { required: { text: ['STRING'] } } };
  GenericDynamic.nodeData = { input: { required: { width: ['INT'] } } };
  const source = Object.assign(new TextSource(), { id: 1, type: 'TextSource', comfyClass: 'TextSource', inputs: [],
    outputs: [{ name: 'text', type: 'STRING', links: [10] }], widgets: [{ name: 'text', type: 'text', value: 'A' }] });
  const target = Object.assign(new GenericDynamic(), { id: 2, type: 'GenericDynamic', comfyClass: 'GenericDynamic',
    inputs: [], outputs: [], widgets: [{ name: 'width', type: 'number', value: 1 }] });
  const link = { id: 10, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'STRING' };
  const scope = (id, nodes = []) => ({ id, nodes, links: new Map(), getLink(id) { return this.links.get(id); } });
  const inside = scope('definition', [source, target]);
  for (const node of inside.nodes) node.graph = inside;
  inside.links.set(10, link);
  const host = id => ({ id, type: 'definition', inputs: [], outputs: [], widgets: [], subgraph: inside, isSubgraphNode: () => true });
  let root = nested ? scope('root', shared ? [host(6), host(7)] : [host(6)]) : inside;
  for (const node of root.nodes) node.graph = root;
  const hooks = {}, replies = [], timers = []; let listener, extension, serial = 0;
  const serializeScope = scope => ({ version: 0.4, id: scope.id, nodes: scope.nodes.map(node => ({ id: node.id, type: node.type,
    inputs: clone(node.inputs), outputs: clone(node.outputs), widgets_values: node.widgets.map(widget => widget.value) })),
    links: [...scope.links.values()].map(link => [link.id, link.origin_id, link.origin_slot, link.target_id, link.target_slot, link.type]) });
  const serialize = () => {
    const document = serializeScope(root);
    if (nested) document.definitions = { subgraphs: [serializeScope(inside)] };
    return document;
  };
  root.serialize = serialize;
  function output() {
    const paths = nested ? root.nodes.map(node => `${node.id}:`) : [''];
    return Object.fromEntries(paths.flatMap(prefix => [[`${prefix}1`, { class_type: 'TextSource', inputs: { text: source.widgets[0].value } }],
      [`${prefix}2`, { class_type: 'GenericDynamic', inputs: { width: target.widgets[0].value,
        ...Object.fromEntries(target.inputs.filter(port => port.link != null).map(port => [port.name, [`${prefix}1`, 0]])) } }]]));
  }
  const app = { graph: root, registerExtension(value) { extension = value; },
    get rootGraphOrUndefined() { return root; }, get canvasOrUndefined() { return { graph: root, canvas: { isConnected: true } }; },
    async loadGraphData() {}, async graphToPrompt() { await hooks.compile?.(); const compiled = { workflow: serialize(), output: output() };
      await hooks.compiled?.(compiled); return compiled; } };
  const parent = { postMessage(message) { replies.push(clone(message)); } };
  const window = { app, parent, crypto: webcrypto,
    __PRISM_EDITOR__: { parentOrigin: 'http://127.0.0.1:8874', bridgeNonce: 'fixture' },
    LiteGraph: { registered_node_types: { TextSource, GenericDynamic } },
    addEventListener(_name, callback) { listener = callback; }, setTimeout(callback) { timers.push(callback); } };
  vm.runInNewContext(bridge, { app, window, document: { querySelector: () => null }, TextEncoder, setTimeout, clearTimeout });
  extension.setup(); while (timers.length) timers.shift()();
  async function request(action, data = {}) {
    const requestId = `req-${++serial}`;
    listener({ source: parent, origin: window.__PRISM_EDITOR__.parentOrigin,
      data: { source: 'prism-parent', nonce: 'fixture', requestId, action, ...data } });
    for (let attempts = 0; attempts < 40; attempts++) {
      await new Promise(resolve => setImmediate(resolve));
      const reply = replies.find(item => item.requestId === requestId); if (reply) return reply;
    }
    throw new Error('Bridge did not reply');
  }
  await request('load', { document: serialize() });
  // A generic extension callback creates actual slots; neither a count nor a
  // class-specific name is itself evidence of a target type.
  const add = (name = 'branch-z', type = 'STRING') => {
    target.inputs.push({ name, type, link: 10 }); link.target_slot = target.inputs.length - 1;
  };
  target.widgets[0].callback = () => add();
  target.widgets[0].callback();
  return { source, target, link, inside, root, hooks, app, window, request, serialize, output, add, GenericDynamic,
    replaceRoot() { root = { ...root, nodes: [...root.nodes] }; app.graph = root; } };
}

