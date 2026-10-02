import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createEditorSessionProjection } from '../web/editor-session-projection.mjs';

const bridge = (await readFile(new URL('../web/native-editor-bridge.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '');
const clone = value => JSON.parse(JSON.stringify(value));
async function fixture({ shared = false, promoted = false } = {}) {
  class Known {}
  Known.nodeData = { input: { required: { fps: ['INT', { min: 1, max: 60 }] } } };
  const leaf = Object.assign(new Known(), { id: 4, type: 'Known', comfyClass: 'Known', mode: 0,
    inputs: [], widgets: [{ name: 'fps', type: 'number', value: 4, options: { min: 1, max: 60 } }] });
  const scope = (id, nodes) => ({ id, nodes, links: new Map(), getLink(id) { return this.links.get(id); },
    getNodeById(id) { return this.nodes.find(node => String(node.id) === String(id)); } });
  const inside = scope('definition', [leaf]); leaf.graph = inside;
  const store = new Map();
  const host = id => ({ id, type: inside.id, subgraph: inside, inputs: [], widgets: [], isSubgraphNode: () => true });
  const first = host(6), second = host(7);
  let root = scope('root', shared ? [first, second] : [first]);
  for (const node of root.nodes) node.graph = root;
  if (promoted) {
    leaf.inputs = [{ name: 'fps', link: 1, widget: { name: 'fps' } }];
    inside.links.set(1, { originIsIoNode: true, origin_slot: 0, origin_id: -10, target_id: 4, target_slot: 0 });
    for (const node of [first, second]) {
      const slot = { name: 'instance-fps', widget: { name: 'instance-fps' }, widgetId: `root:${node.id}:instance-fps`, link: null };
      store.set(slot.widgetId, { value: 4, options: { min: 1, max: 60 } });
      slot._widget = { name: slot.name, widgetId: slot.widgetId, type: 'number',
        get value() { return store.get(slot.widgetId).value; }, set value(value) { store.get(slot.widgetId).value = value; },
        get options() { return store.get(slot.widgetId).options; }, callback(value) { store.get(slot.widgetId).value = value; } };
      node.inputs = [slot]; Object.defineProperty(node, 'widgets', { configurable: true, get: () => node.inputs.map(input => input._widget) });
    }
  }
  const serializeNodes = nodes => nodes.map(node => ({ id: node.id, type: node.type, widgets_values: node.widgets.map(widget => widget.value) }));
  const serialize = () => ({ nodes: serializeNodes(root.nodes), links: [], definitions: {
    subgraphs: [{ id: inside.id, nodes: serializeNodes(inside.nodes), links: [] }] } });
  root.serialize = serialize;
  const output = () => Object.fromEntries(root.nodes.map(node => [`${node.id}:4`, { class_type: 'Known', inputs: {
    fps: promoted ? node.widgets[0].value : inside.nodes[0].widgets[0].value,
  } }]));
  const hooks = {}, replies = [], timers = []; let listener, extension, serial = 0;
  const app = { registerExtension(value) { extension = value; }, graph: root,
    get rootGraphOrUndefined() { return root; }, get canvasOrUndefined() { return { graph: root, canvas: { isConnected: true } }; },
    async graphToPrompt() { await hooks.compile?.(); return { workflow: serialize(), output: output() }; },
    async loadGraphData(document) {
      await hooks.load?.(document);
      for (const node of root.nodes) {
        const data = document.nodes.find(item => item.id === node.id);
        node.widgets.forEach((widget, i) => { if (data?.widgets_values[i] !== undefined) widget.value = data.widgets_values[i]; });
      }
      const data = document.definitions?.subgraphs?.[0]?.nodes?.[0];
      if (data) inside.nodes[0].widgets[0].value = data.widgets_values[0];
    } };
  const parent = { postMessage(message) { replies.push(clone(message)); } };
  const window = { parent, app, crypto: webcrypto, __PRISM_EDITOR__: { parentOrigin: 'http://127.0.0.1:8874', bridgeNonce: 'test-nonce' },
    LiteGraph: { registered_node_types: { Known } }, addEventListener(_name, callback) { listener = callback; }, setTimeout(callback) { timers.push(callback); } };
  vm.runInNewContext(bridge, { app, window, document: { querySelector: () => null }, TextEncoder, setTimeout });
  extension.setup(); while (timers.length) timers.shift()();
  async function request(action, data = {}) {
    const requestId = `req-${++serial}`;
    listener({ source: parent, origin: window.__PRISM_EDITOR__.parentOrigin,
      data: { source: 'prism-parent', nonce: 'test-nonce', requestId, action, ...data } });
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
      const reply = replies.find(item => item.requestId === requestId); if (reply) return reply;
    }
    throw new Error('Bridge did not reply');
  }
  const loaded = await request('load', { document: serialize() }); assert.equal(loaded.error, undefined);
  const binding = { node_id: '6:4', input: 'fps', class_type: 'Known' };
  async function capture() {
    const response = await request('captureMappings', { bindings: [binding] });
    assert.equal(response.error, undefined); assert.equal(response.result.captured.length, 1);
    return response.result.captured[0];
  }
  return { leaf, Known, inside, first, second, root, store, hooks, app, window, replies, request, capture, binding, serialize, output,
    replaceRoot() { const previous = root; root = { ...root, nodes: [...root.nodes] }; app.graph = root; for (const node of root.nodes) node.graph = root; return previous; } };
}

function projectionFor(h, { value = 8, ids = ['6:4'], assertCurrent = () => {}, intercept } = {}) {
  const calls = [];
  const provenance = ids.map(node_id => ({ field_id:`fps-${node_id}`, node_id, input:'fps', class_type:'Known',
    type:'integer', origin:'connected', value, stored_fallback:3, baseline:2, edge_id:`edge-${node_id}`, source_id:'source' }));
  const projection = createEditorSessionProjection({ provenance, mappingCapture:true, assertCurrent,
    async request(action, args = {}) {
      calls.push({ action, args:clone(args) });
      const response = await h.request(action, args);
      if (response.error) throw Object.assign(new Error(response.error), { result:response.result });
      return intercept ? await intercept(action, response.result) : response.result;
    } });
  return { projection, calls, provenance };
}

test('full bridge and projection clean-save a unique nested scalar and restore C without persisting mapping receipts', async () => {
  const h=await fixture(), {projection,calls,provenance}=projectionFor(h), original=clone(provenance);
  assert.equal((await projection.initialize()).applied.length,1); assert.equal(h.leaf.widgets[0].value,8);
  let saved;
  assert.equal((await projection.prepare(result=>{saved=result;})).persisted,true);
  assert.equal(saved.output['6:4'].inputs.fps,4); assert.equal(saved.workflow.definitions.subgraphs[0].nodes[0].widgets_values[0],4);
  assert.equal(h.leaf.widgets[0].value,8); assert.deepEqual(provenance,original);
  assert.equal(saved.controls[0].mapping_receipt,undefined);
  const receipt=projection.getState().applied[0].mapping_receipt;
  assert.equal(JSON.stringify(saved).includes(receipt),false);
  const afterCapture=calls.slice(calls.findIndex(call=>call.action==='captureMappings')+1);
  assert.ok(afterCapture.filter(call=>['compile','snapshot','patch'].includes(call.action)).every(call=>call.args.mapping_receipts[0].receipt===receipt));
  assert.ok(afterCapture.filter(call=>call.action==='patch').every(call=>call.args.patches[0].mapping_receipt===receipt));
});

test('full bridge and projection overlay two promoted shared instances and preserve the shared leaf and both native fallbacks', async () => {
  const h=await fixture({shared:true,promoted:true}); h.second.widgets[0].value=5;
  const {projection}=projectionFor(h,{ids:['6:4','7:4']});
  assert.equal((await projection.initialize()).applied.length,2);
  assert.equal(h.first.widgets[0].value,8); assert.equal(h.second.widgets[0].value,8); assert.equal(h.leaf.widgets[0].value,4);
  await projection.prepare(result=>{
    assert.equal(result.output['6:4'].inputs.fps,4); assert.equal(result.output['7:4'].inputs.fps,5);
    assert.deepEqual(result.workflow.nodes.map(node=>node.widgets_values[0]),[4,5]);
  });
  assert.equal(h.first.widgets[0].value,8); assert.equal(h.second.widgets[0].value,8); assert.equal(h.leaf.widgets[0].value,4);
});

test('full bridge shared unpromoted parameters explain defer and never receive C', async () => {
  const h=await fixture({shared:true}), {projection,calls}=projectionFor(h);
  const result=await projection.initialize();
  assert.equal(result.applied.length,0); assert.equal(result.unmapped[0].reason,'shared_definition_widget');
  assert.equal(calls.some(call=>call.action==='captureMappings'||call.action==='patch'),false);
  assert.equal(h.leaf.widgets[0].value,4);
});

for (const stage of ['before-compile','during-snapshot']) test(`full bridge ${stage} same-ID slot replacement blocks a zero-change save`, async () => {
  const h=await fixture({promoted:true}), {projection,calls}=projectionFor(h,{value:4});
  await projection.initialize(); let saves=0;
  const replace=()=>{h.first.inputs[0]={...h.first.inputs[0]};};
  if(stage==='before-compile') replace();
  else {
    const serialize=h.root.serialize; let count=0;
    h.root.serialize=()=>{const result=serialize(); if(++count===2) replace(); return result;};
  }
  await assert.rejects(projection.prepare(()=>{saves++;}), /归属已变化.*重新进入/);
  assert.equal(saves,0); assert.equal(calls.some(call=>call.action==='patch'),false); assert.equal(h.first.widgets[0].value,4);
});

test('full bridge edited I can be explicitly saved without losing the instance guard on the no-cleanup path', async () => {
  const h=await fixture({promoted:true}), {projection}=projectionFor(h); await projection.initialize(); h.first.widgets[0].value=9;
  const required=await projection.prepare(()=>assert.fail('unreviewed conflict was saved'));
  assert.equal(required.status,'resolution_required');
  let saved;
  await projection.prepare(result=>{saved=result;}, {resolutions:{'fps-6:4':'inner'},expectedConflicts:required.conflicts});
  assert.equal(saved.output['6:4'].inputs.fps,9); assert.equal(h.first.widgets[0].value,9);
  assert.equal(saved.controls[0].mapping_receipt,undefined);
});

test('full bridge target replacement after durable save prevents display restore into the replacement and locks further writes', async () => {
  const h=await fixture({promoted:true}), {projection}=projectionFor(h); await projection.initialize(); let saves=0;
  await assert.rejects(projection.prepare(()=>{saves++;h.first.inputs[0]={...h.first.inputs[0]};}),error=>
    error.code==='display_restore_failed'&&error.persisted===true&&error.locked===true);
  assert.equal(saves,1); assert.equal(h.first.widgets[0].value,4);
  await assert.rejects(projection.prepare(()=>{saves++;}),/须重新进入/); assert.equal(saves,1);
});

test('full bridge source guard failure during mapping capture is never converted into a safe defer', async () => {
  const h=await fixture(); let current=true;
  const {projection,calls}=projectionFor(h,{assertCurrent(){if(!current)throw new Error('source replaced');},
    intercept(action,result){if(action==='captureMappings')current=false;return result;}});
  await assert.rejects(projection.initialize(),/source replaced/);
  assert.equal(calls.some(call=>call.action==='patch'),false); assert.equal(h.leaf.widgets[0].value,4);
});

for (const kind of ['duplicate','wrong-binding','wrong-type','reused-receipt']) test(`full bridge malformed ${kind} mapping acknowledgement cannot authorize an overlay`, async () => {
  const h=await fixture({promoted:true,shared:true});
  const {projection,calls}=projectionFor(h,{ids:['6:4','7:4'],intercept(action,result){
    if(action==='captureMappings') {
      if(kind==='duplicate')result.captured.push(result.captured[0]);
      if(kind==='wrong-binding')result.captured[0].input='other';
      if(kind==='wrong-type')result.captured[0].native_value='4';
      if(kind==='reused-receipt')result.captured[1].receipt=result.captured[0].receipt;
    } return result;
  }});
  const result=await projection.initialize(); assert.equal(result.applied.length,0);
  assert.ok(result.unmapped.every(item=>item.reason==='mapping_capture_unverified'));
  assert.equal(calls.some(call=>call.action==='patch'),false); assert.equal(h.first.widgets[0].value,4);
});

test('mapping capture and compile share schema canonicalization only within each fresh lookup', async () => {
  const h=await fixture(); let reads=0, marker='stable';
  h.Known.nodeData.input.proof_metadata={get marker(){reads++;return marker;}};
  const required=h.Known.nodeData.input.required;
  for(let index=0;index<512;index++) {
    const name=`value${index}`; required[name]=['INT',{min:1,max:60}]; h.leaf.widgets.push({name,type:'number',value:4,options:{min:1,max:60}});
  }
  h.app.graphToPrompt=async()=>({workflow:h.serialize(),output:{'6:4':{class_type:'Known',inputs:Object.fromEntries(h.leaf.widgets.map(widget=>[widget.name,widget.value]))}}});
  const response=await h.request('compile'); assert.equal(response.result.controls.length,513); assert.ok(reads<=2,`schema reads ${reads}`);
  reads=0;
  const captured=await h.request('captureMappings',{bindings:h.leaf.widgets.map(widget=>({node_id:'6:4',input:widget.name,class_type:'Known'}))});
  assert.equal(captured.result.captured.length,513); assert.ok(reads<=5,`capture schema reads ${reads}`);
  marker='changed';
  assert.ok((await h.request('snapshot',{mapping_receipts:[captured.result.captured[0]]})).error);
});

test('capture mappings is opt-in, echoes only current receipts and validates zero-patch snapshots', async () => {
  const h = await fixture(), original = h.serialize();
  assert.equal(h.replies[0].capabilities.mapping_capture, 1);
  assert.equal((await h.request('compile')).result.controls[0].mapping_receipt, undefined);
  const receipt = await h.capture(); assert.equal(receipt.native_value, 4);
  assert.equal((await h.request('compile')).result.controls[0].mapping_receipt, receipt.receipt);
  assert.equal((await h.request('snapshot', { mapping_receipts: [receipt] })).error, undefined);
  assert.deepEqual(h.serialize(), original);
});

test('promoted store-backed hosts keep independent instance values while the shared leaf stays unchanged', async () => {
  const h = await fixture({ promoted: true, shared: true }), receipt = await h.capture();
  const response = await h.request('patch', { patches: [{ node_id: '6:4', widget_name: 'fps', class_type: 'Known', expected_value: 4, value: 9, mapping_receipt: receipt.receipt }] });
  assert.equal(response.error, undefined); assert.equal(h.store.get('root:6:instance-fps').value, 9);
  assert.equal(h.store.get('root:7:instance-fps').value, 4); assert.equal(h.leaf.widgets[0].value, 4);
  assert.equal((await h.request('compile', { mapping_receipts: [receipt] })).error, undefined);
});

for (const change of ['root', 'host', 'leaf', 'scope', 'slot', 'link', 'widget', 'widget-id', 'schema-object', 'schema-content', 'registered-schema']) {
  test(`${change} identity change invalidates a receipt before a zero-change snapshot and never re-echoes it`, async () => {
    const h = await fixture({ promoted: true }), receipt = await h.capture();
    if (change === 'root') h.replaceRoot();
    if (change === 'host') h.root.nodes[0] = { ...h.first };
    if (change === 'leaf') h.inside.nodes[0] = Object.assign(new h.Known(), h.leaf);
    if (change === 'scope') h.first.subgraph = { ...h.inside };
    if (change === 'slot') h.first.inputs[0] = { ...h.first.inputs[0] };
    if (change === 'link') h.inside.links.set(1, { ...h.inside.links.get(1) });
    if (change === 'widget') h.first.inputs[0]._widget = { ...h.first.inputs[0]._widget };
    if (change === 'widget-id') { h.store.set('replacement-id', { value: 4, options: h.first.widgets[0].options }); h.first.inputs[0].widgetId = 'replacement-id'; }
    if (change === 'schema-object') h.Known.nodeData = clone(h.Known.nodeData);
    if (change === 'schema-content') h.Known.nodeData.input.required.fps[1].max = 50;
    if (change === 'registered-schema') h.window.LiteGraph.registered_node_types.Known = class Replacement {};
    assert.ok((await h.request('snapshot', { mapping_receipts: [receipt] })).error);
    const response = await h.request('compile');
    assert.equal(response.result.controls.find(item => item.node_id === '6:4')?.mapping_receipt, undefined);
    assert.equal(h.leaf.widgets[0].value, 4);
  });
}

test('same object removed then added back with matching ID and value cannot resurrect a captured mapping', async () => {
  const h = await fixture(), receipt = await h.capture();
  h.first.onRemoved(); h.root.nodes = []; h.first.graph = null;
  h.first.graph = h.root; h.root.nodes.push(h.first); h.first.onAdded(h.root);
  const response = await h.request('patch', { patches: [{ node_id: '6:4', widget_name: 'fps', value: 8, mapping_receipt: receipt.receipt }] });
  assert.equal(response.result.unsupported[0].reason, 'invalid_mapping_receipt'); assert.equal(h.leaf.widgets[0].value, 4);
  const fresh = await h.capture(); assert.notEqual(fresh.receipt, receipt.receipt);
});

test('a definition becoming shared refuses a formerly unique mapping without changing either occurrence', async () => {
  const h = await fixture(), receipt = await h.capture(); h.second.graph = h.root; h.root.nodes.push(h.second);
  assert.ok((await h.request('compile', { mapping_receipts: [receipt] })).error);
  const next = await h.request('captureMappings', { bindings: [h.binding] });
  assert.equal(next.result.unsupported[0].reason, 'shared_definition_widget'); assert.equal(h.leaf.widgets[0].value, 4);
});

test('async compile replacement rejects capture rather than capturing the new same-ID widget', async () => {
  const h = await fixture(); let once = true;
  h.hooks.compile = () => { if (once) { once = false; h.leaf.widgets[0] = { ...h.leaf.widgets[0] }; } };
  assert.ok((await h.request('captureMappings', { bindings: [h.binding] })).error);
  assert.equal((await h.request('compile')).result.controls[0].mapping_receipt, undefined);
});

test('a same-ID owner swapped during prepatch compilation receives no stale write or rollback write', async () => {
  const h = await fixture({ promoted: true }), receipt = await h.capture(); let replacements = 0, writes = 0;
  h.hooks.compile = () => {
    if (replacements++) return;
    const widget = { name: 'instance-fps', type: 'number', options: { min: 1, max: 60 }, get value() { return 4; }, set value(_value) { writes++; } };
    h.root.nodes[0] = { ...h.first, inputs: [...h.first.inputs], widgets: [widget] };
  };
  const response = await h.request('patch', { patches: [{ node_id: '6:4', widget_name: 'fps', value: 8, mapping_receipt: receipt.receipt }] });
  assert.equal(response.result.unsupported[0].reason, 'compiled_target_mismatch'); assert.equal(writes, 0);
});

test('mapping receipt cannot alias another slot and recapture retires the prior receipt', async () => {
  const h = await fixture({ promoted: true, shared: true }), old = await h.capture(), fresh = await h.capture();
  assert.notEqual(old.receipt, fresh.receipt);
  assert.ok((await h.request('snapshot', { mapping_receipts: [old] })).error);
  const response = await h.request('patch', { patches: [{ node_id: '7:4', widget_name: 'fps', value: 8, mapping_receipt: fresh.receipt }] });
  assert.equal(response.result.unsupported[0].reason, 'invalid_mapping_receipt');
});

test('all supplied session guards are checked even when their field is outside a patch batch or the batch is empty', async () => {
  const h=await fixture({shared:true,promoted:true});
  const first=await h.capture();
  const second=(await h.request('captureMappings',{bindings:[{...h.binding,node_id:'7:4'}]})).result.captured[0];
  h.second.inputs[0]={...h.second.inputs[0]};
  const mapping_receipts=[first,second];
  assert.ok((await h.request('patch',{patches:[],mapping_receipts})).error);
  assert.ok((await h.request('patch',{mapping_receipts,patches:[{node_id:'6:4',widget_name:'fps',value:8,mapping_receipt:first.receipt}]})).error);
  assert.equal(h.first.widgets[0].value,4);
});

test('final hooks replacing an unpatched captured sibling invalidate the whole guarded patch transaction', async () => {
  const h=await fixture({shared:true,promoted:true});
  const first=await h.capture();
  const second=(await h.request('captureMappings',{bindings:[{...h.binding,node_id:'7:4'}]})).result.captured[0];
  let once=true;
  h.root.afterChange=()=>{if(once){once=false;h.second.inputs[0]={...h.second.inputs[0]};}};
  const response=await h.request('patch',{mapping_receipts:[first,second],patches:[{node_id:'6:4',widget_name:'fps',value:8,mapping_receipt:first.receipt}]});
  assert.ok(response.error); assert.equal(response.result.rolled_back,true);
  assert.equal(h.first.widgets[0].value,4); assert.equal(h.second.widgets[0].value,4);
});

test('mapping capture rejects duplicate and oversized binding batches without minting any receipt', async () => {
  const h = await fixture();
  const duplicate = await h.request('captureMappings', { bindings: [h.binding, h.binding] });
  assert.equal(duplicate.result.captured.length, 0); assert.equal(duplicate.result.unsupported[0].reason, 'ambiguous_mapping_binding');
  assert.ok((await h.request('captureMappings', { bindings: Array.from({ length: 4097 }, () => h.binding) })).error);
  assert.ok((await h.request('captureMappings', { bindings: [{ ...h.binding, label: '界'.repeat(710000) }] })).error);
  assert.equal((await h.request('compile')).result.controls[0].mapping_receipt, undefined);
});

test('new mapping capability does not imply nested media capture is available', async () => {
  const h = await fixture(); const result = await h.request('captureMedia', { bindings: [{ ...h.binding, field_id: 'ref', type: 'image', value: 'C.png' }] });
  assert.equal(h.replies[0].capabilities.media_capture, 0); assert.equal(result.result.captured.length, 0);
});

test('callback store rebinding never receives a direct rollback write through the old projected widget', async () => {
  const h = await fixture({ promoted: true }), receipt = await h.capture();
  const slot = h.first.inputs[0]; let replacementWrites = 0;
  h.store.set('new-slot', { get value() { return 8; }, set value(_value) { replacementWrites++; }, options: slot._widget.options });
  slot._widget.callback = () => { slot.widgetId = 'new-slot'; };
  h.hooks.load = () => { throw new Error('stop before the native graph is reconstructed'); };
  const response = await h.request('patch', { patches: [{ node_id: '6:4', widget_name: 'fps', value: 8, mapping_receipt: receipt.receipt }] });
  assert.equal(response.result.rolled_back, false); assert.equal(replacementWrites, 0);
});

test('zero-change snapshot checks receipt again after serialization callbacks', async () => {
  const h = await fixture(), receipt = await h.capture();
  h.root.serialize = () => { h.root.nodes[0] = { ...h.first }; return h.serialize(); };
  assert.ok((await h.request('snapshot', { mapping_receipts: [receipt] })).error);
});

test('ordinary uncaptured controls remain readable when plugin options contain opaque cyclic metadata', async () => {
  const h = await fixture(); h.leaf.widgets[0].options.extension = h.leaf.widgets[0].options;
  const response = await h.request('compile'); assert.equal(response.error, undefined);
  assert.equal(response.result.controls[0].input, 'fps'); assert.equal(response.result.controls[0].mapping_receipt, undefined);
  const capture = await h.request('captureMappings', { bindings: [h.binding] });
  assert.ok(capture.error || capture.result.unsupported[0].reason === 'mapping_proof_unavailable');
});

test('afterChange cannot replace a same-ID promoted slot after verification and still report success', async () => {
  const h = await fixture({ promoted: true }), receipt = await h.capture(); let once = true;
  h.root.afterChange = () => { if (once) { once = false; h.first.inputs[0] = { ...h.first.inputs[0] }; } };
  const response = await h.request('patch', { patches: [{ node_id: '6:4', widget_name: 'fps', value: 8, mapping_receipt: receipt.receipt }] });
  assert.ok(response.error); assert.equal(response.result.applied.length, 0); assert.equal(response.result.rolled_back, true);
  assert.equal(h.first.widgets[0].value, 4);
});
