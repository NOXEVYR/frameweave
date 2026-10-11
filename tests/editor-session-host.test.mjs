import test from 'node:test';
import assert from 'node:assert/strict';
import { hostHarness, makeNode, field, BACKEND, OTHER } from './helpers/editor-host-harness.mjs';

function direct(h, type = 'prompt', data = {text:'connected'}) {
  const source = makeNode('direct',type,data);h.sandbox.graph.nodes.push(source);
  h.sandbox.graph.edges.push({id:'edge',source:source.id,target:h.node.id,targetField:type==='reference'?'image':'prompt'});return source;
}
const changed = /编辑准备期间.*已变化/;

test('session loads complete package fields and enriches connected provenance from actual prompt and mapping', async () => {
  const h=hostHarness({bound:true});direct(h);
  const session=await h.state.host.prepareSession(h.node,{revision:7});
  assert.equal(session.provenance[0].value,'connected');assert.equal(session.provenance[0].class_type,'RealClass');
  assert.equal(session.provenance[0].type,'text');assert.equal(session.provenance[0].stored_fallback,'fallback');
  assert.equal(h.node.data.packageValues.prompt,'fallback');assert.equal(h.node.data.editor_baseline.prompt,'original');
  assert.equal(h.state.host.fields(h.node)[0].node_id,'12');
});

test('field loading and connected proof requests retain the original early direct source witness', async () => {
  for(const route of ['/api/packages/pack','/api/editor-prepare']){
    const h=hostHarness({bound:true}),source=direct(h);
    h.state.onApi=path=>{if(path===route)source.data.text='changed';};
    await assert.rejects(h.state.host.prepareSession(h.node,{revision:7}),changed);
  }
});

test('source mutation before interface fields is detected rather than recaptured', async () => {
  const h=hostHarness({bound:true}),source=direct(h);
  await h.state.host.prepareSession(h.node,{revision:7});source.data.text='new';
  assert.throws(()=>h.state.host.fields(h.node),changed);
});

test('authorized own scalar saves rebase only target signature and survive successive workflow revision saves', async () => {
  const h=hostHarness({bound:true});direct(h);const workflow={revision:7};
  const session=await h.state.host.prepareSession(h.node,workflow);
  h.state.host.syncOuterValues(h.node,{prompt:'save-one'});workflow.revision++;
  assert.doesNotThrow(session.assertCurrent);
  h.state.host.syncOuterValues(h.node,{prompt:'save-two'});workflow.revision++;
  assert.doesNotThrow(session.assertCurrent);assert.equal(h.node.data.packageValues.prompt,'save-two');
  h.state.host.endSession(h.node);
  const reopened=await h.state.host.prepareSession(h.node,workflow);assert.doesNotThrow(reopened.assertCurrent);
});

test('authorized target rebase cannot erase replacement source identity or reference import tickets', async () => {
  for(const change of ['replace','ticket','transfer']){
    const h=hostHarness({bound:true,fields:[field('image','image')],values:{image:'old.png'}});
    const source=direct(h,'reference',{name:'new.png',mediaType:'image',uploadBackend:BACKEND});
    if(change==='ticket')h.sandbox.referenceImports.set(source.id,{ticket:Symbol('old'),message:'importing'});
    if(change==='transfer')h.sandbox.packageMediaTransfers.start('canvas:target','image','Image');
    const context=h.sandbox.beginNativeEditorContext(h.node);
    if(change==='replace')h.sandbox.graph.nodes[1]=structuredClone(source);
    if(change==='ticket')h.sandbox.referenceImports.set(source.id,{ticket:Symbol('new'),message:'importing'});
    if(change==='transfer')h.sandbox.packageMediaTransfers.start('canvas:target','image','Image');
    h.node.data.title='authorized own title';
    assert.throws(context.rebaseTarget,changed);assert.throws(context.assertCurrent,changed);
  }
});

test('sync refuses stale source before changing any fallback', async () => {
  const h=hostHarness({bound:true}),source=direct(h);await h.state.host.prepareSession(h.node,{revision:7});
  source.data.text='changed';assert.throws(()=>h.state.host.syncOuterValues(h.node,{prompt:'must not write'}),changed);
  assert.equal(h.node.data.packageValues.prompt,'fallback');
});

test('context retains target identity even when a same-id equal-data replacement is made', async () => {
  const h=hostHarness({bound:true});const session=await h.state.host.prepareSession(h.node,{revision:7});
  h.sandbox.graph.nodes[0]=structuredClone(h.node);assert.throws(session.assertCurrent,changed);
});

test('native with no proved package or API source opens with pending diagnostics and no preparation HTTP', async () => {
  const h=hostHarness({kind:'sdxl',bound:true});direct(h);
  const session=await h.state.host.prepareSession(h.node,{revision:7});
  assert.equal(session.provenance.length,0);assert.equal(h.state.calls.length,0);assert.doesNotThrow(session.assertCurrent);
});

test('session cleanup releases aliases without clearing another node context', async () => {
  const h=hostHarness({bound:true}),other=makeNode('other','generation',{kind:'sdxl',editor_id:'other'});
  h.sandbox.graph.nodes.push(other);const first=h.sandbox.beginNativeEditorContext(h.node),second=h.sandbox.beginNativeEditorContext(other);
  const alias=structuredClone(h.node);h.sandbox.aliasNativeEditorContext(first,alias);h.state.host.endSession(alias);
  assert.notEqual(h.sandbox.beginNativeEditorContext(h.node),first);assert.equal(h.sandbox.beginNativeEditorContext(other),second);
});

test('existing native backend selection accepts explicit switch but retains direct source identity', async () => {
  const h=hostHarness({bound:true});direct(h);const context=h.sandbox.beginNativeEditorContext(h.node);
  h.state.nextBackend=OTHER;await h.state.host.ensureBackend(h.node);assert.doesNotThrow(context.assertCurrent);
  assert.equal(h.sandbox.settings.backend_url,OTHER);
});

test('API baseline cannot silently accept another backend in the same conversion', async () => {
  const h=hostHarness({kind:'api'});const context=h.sandbox.beginNativeEditorContext(h.node);context.baselineBackend=BACKEND;
  h.node.data.editor_id='new';context.rebaseTarget();h.state.nextBackend=OTHER;
  await assert.rejects(h.state.host.ensureBackend(h.node),/首次转换的基准属于原推理引擎/);
});

test('connected media and its own fallback receive independent live preparation proofs', async () => {
  const h = hostHarness({bound:true,fields:[field('image','image')],values:{image:'own.png'}});
  h.node.data.packageMediaBackends={image:{name:'own.png',backend:BACKEND}};
  direct(h,'reference',{name:'connected.png',mediaType:'image',uploadBackend:BACKEND});
  const session=await h.state.host.prepareSession(h.node,{revision:7});
  assert.equal(session.provenance[0].value,'connected.png'); assert.equal(session.ownMedia[0].value,'own.png');
  assert.equal(session.ownMedia[0].class_type,'RealClass'); assert.equal(session.ownMedia[0].media_owner.name,'own.png');
  assert.equal(h.state.calls.filter(call=>call.path==='/api/editor-prepare').length,2);
  assert.equal(h.node.data.packageValues.image,'own.png'); assert(session.ownMedia!==session.provenance);
});

test('source change during the second own media preparation rejects the entire editing context', async () => {
  const h=hostHarness({bound:true,fields:[field('image','image')],values:{image:'own.png'}});
  h.node.data.packageMediaBackends={image:{name:'own.png',backend:BACKEND}};
  const source=direct(h,'reference',{name:'connected.png',mediaType:'image',uploadBackend:BACKEND});
  let count=0; h.state.onApi=path=>{if(path==='/api/editor-prepare'&&++count===2)source.data.name='changed.png';};
  await assert.rejects(h.state.host.prepareSession(h.node,{revision:7}),changed);
});

test('choosing an inner media value removes the old external upload owner and thumbnail', async () => {
  const h=hostHarness({bound:true,fields:[field('image','image')],values:{image:'own.png'}});
  h.node.data.packageMediaBackends={image:{name:'own.png',backend:BACKEND,preview_url:'/api/media/'+'a'.repeat(32)}};
  await h.state.host.prepareSession(h.node,{revision:7}); h.state.host.syncOuterValues(h.node,{image:'inner.png'});
  assert.equal(h.node.data.packageValues.image,'inner.png'); assert.equal(h.node.data.packageMediaBackends.image,undefined);
});
