import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { hostHarness, makeNode, field, BACKEND, OTHER } from './helpers/editor-host-harness.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const entry = source.slice(source.indexOf('async function openNodeWorkflow('), source.indexOf('function renderInspector('));

test('an existing native workflow opens for repair without requiring or preparing upstream media', async () => {
  const node = { id: 'target', data: { kind: 'package', editor_id: 'editor', package_id: 'pack' } };
  const calls = [];
  const context = { beginNativeEditorContext() {}, endNativeEditorSession() {}, nativeEditor: { open: async actual => { assert.equal(actual, node); calls.push('native'); } },
    assertCanvasMediaReady: () => { throw new Error('reference still missing or importing'); },
    prepareWorkflowBackend: () => { throw new Error('unrelated upstream engine'); },
    prepareCanvasImages: () => { throw new Error('must not upload to open native'); } };
  vm.runInNewContext(entry, context);
  await context.openNodeWorkflow(node);
  assert.deepEqual(calls, ['native']);
});

test('an unconfigured package still opens the library without preparing media', async () => {
  let opened = 0;
  const context = { openPackages: async () => { opened++; }, assertCanvasMediaReady: () => { throw new Error('must not prepare'); } };
  vm.runInNewContext(entry, context);
  await context.openNodeWorkflow({id:'empty',data:{kind:'package'}});
  assert.equal(opened, 1);
});

test('package entry prepares a full own baseline and projects direct connections only into the editor session', async () => {
  const h=hostHarness(),source=makeNode('text','prompt',{text:'connected'});
  h.sandbox.graph.nodes.push(source);h.sandbox.graph.edges.push({id:'edge',source:source.id,target:h.node.id,targetField:'prompt'});
  const original=structuredClone(h.node.data);
  await h.sandbox.openNodeWorkflow(h.node);
  const requests=h.state.calls.filter(item=>item.path==='/api/editor-prepare');
  assert.equal(requests.length,2);assert.equal(requests[0].payload.overrides[0].origin,'own');
  assert.equal(requests[0].payload.overrides[0].value,'fallback');assert.equal(requests[1].payload.overrides[0].value,'connected');
  assert.equal(h.state.baseline['12'].inputs.prompt,'fallback');assert.equal(h.state.session.provenance[0].value,'connected');
  assert.deepEqual(h.state.baseline.unfinished,h.state.prompt.unfinished);assert.deepEqual(h.state.baseline['12']._meta,h.state.prompt['12']._meta);
  assert.deepEqual(h.node.data,original);assert(h.state.calls.every(item=>!item.path.includes('/compile')&&!item.path.includes('/upload')&&!item.path.includes('/jobs')));
});

test('API entry retains all source nodes and metadata even when the backend has no online engine flag', async () => {
  const h=hostHarness({kind:'api',values:{}});
  await h.sandbox.openNodeWorkflow(h.node);
  assert.deepEqual(h.state.baseline,h.node.data.apiPrompt);assert(h.state.baseline.unfinished);
  assert.equal(h.state.calls.filter(item=>item.path==='/api/editor-prepare')[0].payload.document.prompt.unfinished.class_type,'FutureClass');
  assert.equal(h.node.data.editor_id,undefined);
});

test('first package baseline imports proven hidden updates but retains unmapped hidden values as pending', async () => {
  const h=hostHarness();
  h.node.data.editor_hidden_updates=[{field:field('prompt'),value:'own hidden',baseline:'inside'},
    {field:field('unmapped'),value:'retained unknown',baseline:'before'}];
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.state.baseline['12'].inputs.prompt,'own hidden');
  assert(h.state.session.pending.some(item=>item.field_id==='unmapped'&&item.reason==='mapping_unavailable'));
  assert.equal(h.node.data.editor_hidden_updates[1].value,'retained unknown');
});

test('early entry witness rejects changes during source reads, preparation, and bootstrap save before replacing the original', async () => {
  for(const route of ['/api/packages/pack','/api/editor-prepare','/api/editor-workflows']){
    const h=hostHarness(),source=makeNode('text','prompt',{text:'connected'});
    h.sandbox.graph.nodes.push(source);h.sandbox.graph.edges.push({id:'edge',source:source.id,target:h.node.id,targetField:'prompt'});
    h.state.onApi=path=>{if(path===route)source.data.text='changed during read';};
    await assert.rejects(h.sandbox.openNodeWorkflow(h.node),/编辑准备期间.*已变化/);
    assert.equal(h.node.data.editor_id,undefined);assert.equal(h.state.opened.length,0);
    const fresh=h.sandbox.beginNativeEditorContext(h.node);assert.doesNotThrow(fresh.assertCurrent,'failed entry releases the old context');
  }
});

test('binding reuses the entry witness and only rebases authorized editor identity after successful save', async () => {
  const h=hostHarness();await h.sandbox.openNodeWorkflow(h.node);
  h.state.bind();assert.equal(h.node.data.editor_id,'created');assert.doesNotThrow(h.state.session.assertCurrent);
  h.state.host.syncOuterValues(h.state.opened[0],{prompt:'saved inside'});assert.doesNotThrow(h.state.session.assertCurrent);
  assert.equal(h.node.data.packageValues.prompt,'saved inside');
});

test('direct source or material transaction changes while inside the first editor prevent binding', async () => {
  for(const change of ['text','identity','ticket']){
    const h=hostHarness(),source=makeNode('ref','reference',{name:'valid.png',mediaType:'image',uploadBackend:BACKEND});
    h.sandbox.graph.nodes.push(source);h.sandbox.graph.edges.push({id:'edge',source:source.id,target:h.node.id,targetField:'prompt'});
    await h.sandbox.openNodeWorkflow(h.node);
    if(change==='text')source.data.title='Changed';
    if(change==='identity')h.sandbox.graph.nodes[1]=structuredClone(source);
    if(change==='ticket')h.sandbox.referenceImports.set(source.id,{ticket:Symbol('new upload'),message:'uploading'});
    assert.throws(h.state.bind,/编辑准备期间.*已变化/);assert.equal(h.node.data.editor_id,undefined);
  }
});

test('root backend selection ignores an incompatible deeper workflow and does not upload a direct foreign reference', async () => {
  const h=hostHarness({fields:[field('image','image')],values:{image:''}});
  h.node.data.editor_backend=OTHER;
  const upstream=makeNode('upstream','generation',{editor_backend:BACKEND}),ref=makeNode('ref','reference',{name:'foreign.png',mediaType:'image',uploadBackend:BACKEND});
  h.sandbox.graph.nodes.push(upstream,ref);
  h.sandbox.graph.edges.push({id:'deep',source:upstream.id,target:ref.id},{id:'direct',source:ref.id,target:h.node.id,targetField:'image'});
  await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.sandbox.settings.backend_url,OTHER);assert(h.state.session.pending.some(item=>item.reason==='other_backend'));
  assert(h.state.calls.every(item=>!item.path.includes('/upload')));assert.equal(ref.data.uploadBackend,BACKEND);
});

test('first baseline rejects an explicit new backend before old prompt conversion and requires fresh entry', async () => {
  const h=hostHarness({kind:'api',values:{}});h.state.nextBackend=OTHER;
  await assert.rejects(h.sandbox.openNodeWorkflow(h.node),/首次转换的基准属于原推理引擎/);
  assert.equal(h.node.data.editor_id,undefined);assert.equal(h.state.session,null);
  h.state.nextBackend=null;await h.sandbox.openNodeWorkflow(h.node);
  assert.equal(h.sandbox.settings.backend_url,OTHER);assert.equal(h.state.session.provenance.length,0);
});

test('host reopen resolves the live graph object and prepares a fresh backend baseline', async () => {
  const h=hostHarness({kind:'api',values:{}});await h.sandbox.openNodeWorkflow(h.node);
  const draft=h.state.opened[0];h.state.host.endSession(draft);h.sandbox.settings.backend_url=OTHER;
  await h.state.host.reopen(draft);
  const prepares=h.state.calls.filter(item=>item.path==='/api/editor-prepare');
  assert.equal(prepares.at(-2).payload.backend_url,OTHER);assert.notEqual(h.state.opened[1],draft);
});
