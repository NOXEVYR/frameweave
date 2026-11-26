import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNode, parseGraph, serializeGraph, generationPayload } from '../web/graph.mjs';
import { prepareResultEdit } from '../web/result-edit.mjs';
import { captureResultReference, transferResultReference } from '../web/result-reference.mjs';

const backend='http://127.0.0.1:8188';
const clone=value=>structuredClone(value);
const appSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const editEntry=appSource.slice(appSource.indexOf('let resultEditBusy = false;'),appSource.indexOf('\nasync function uploadImage(',appSource.indexOf('let resultEditBusy = false;')));
function fixture() {
  const output={type:'image',node_id:'sink-7',filename:'exact.png',subfolder:'branch-b',storage_type:'output',output_id:`o-${'1'.repeat(64)}`,url:`/api/media/${'2'.repeat(32)}`};
  const job={id:'independent-edit-review',status:'completed',backend,outputs:[output]};
  const source=createNode('result',30,50,{jobId:job.id,outputs:clone(job.outputs)});
  const state={graph:{nodes:[source],edges:[]},canvasId:'review-canvas',backend};
  const calls=[],hooks={};
  const reply={media_type:'image',backend,source_job:job.id,output_id:output.output_id,name:'input/exact.png',url:`/api/media/${'3'.repeat(32)}`};
  async function api(path,data) {
    calls.push({path,data:clone(data)}); await hooks.before?.(path,data);
    if(path==='/api/status')return {online:true,backend_url:backend};
    if(path==='/api/jobs')return {jobs:[job]};
    if(path.endsWith('/image-input'))return clone(reply);
    assert.fail(`Unexpected API ${path}`);
  }
  const current=()=>state;
  const run=()=>prepareResultEdit({source,outputId:output.output_id,kind:'qwen21_edit',api,current});
  return {output,job,source,state,calls,hooks,reply,api,current,run};
}
function appHarness(h,{afterPrepare}={}) {
  const history=[],notes=[];
  const context={api:h.api,prepareResultEdit:async options=>{const fragment=await prepareResultEdit(options);afterPrepare?.();return fragment;},
    get graph(){return h.state.graph;},get settings(){return {backend_url:h.state.backend};},
    currentCanvasIdentity:()=>h.state.canvasId,getNode:id=>h.state.graph.nodes.find(node=>node.id===id),
    nodeSize:()=>({width:300,height:400}),placeNewNodes:()=>{},centerOnNode:()=>{},revealInspector:()=>{},switchTab:()=>{},
    toast:value=>notes.push(value),mutate:callback=>{history.push(clone(h.state.graph));callback();},Set};
  vm.createContext(context);vm.runInContext(`${editEntry}\nthis.editOutputForReview=editOutput;`,context);
  return {history,notes,run:()=>context.editOutputForReview(h.source,h.output,'qwen21_edit')};
}

test('actual app quick-edit entry rejects concurrent clicks and commits one complete undoable fragment without generation',async()=>{
  const h=fixture(),app=appHarness(h);let release,started;
  const ready=new Promise(resolve=>{started=resolve;});
  h.hooks.before=async path=>{if(path.endsWith('/image-input')){started();await new Promise(resolve=>{release=resolve;});}};
  const pending=app.run();await ready;
  assert.equal(h.state.graph.nodes.length,1);assert.equal(app.history.length,0);
  await app.run();assert.equal(h.calls.filter(call=>call.path.endsWith('/image-input')).length,1);
  release();await pending;
  assert.equal(app.history.length,1);assert.equal(h.state.graph.nodes.length,3);assert.equal(h.state.graph.edges.length,1);
  const target=h.state.graph.nodes.find(node=>node.type==='generation');
  assert.equal(generationPayload(h.state.graph,target.id).references[0],h.reply.name);
  h.state.graph=clone(app.history[0]);assert.equal(h.state.graph.nodes.length,1);assert.equal(h.state.graph.edges.length,0);
  assert.ok(h.calls.every(call=>['/api/status','/api/jobs',`/api/jobs/${h.job.id}/image-input`].includes(call.path)));
});

test('actual app final application guard runs after the preparation promise resolves',async()=>{
  const h=fixture(),app=appHarness(h,{afterPrepare(){h.state.canvasId='next-canvas';}});
  await assert.rejects(app.run(),/变化/);assert.equal(app.history.length,0);assert.equal(h.state.graph.nodes.length,1);
});

test('actual app undo and readd under the same canvas ID cannot adopt an old asynchronous result',async()=>{
  const h=fixture(),app=appHarness(h);let once=true;
  h.hooks.before=path=>{if(once&&path.endsWith('/image-input')){once=false;h.state.graph=clone(h.state.graph);}};
  await assert.rejects(app.run(),/变化/);assert.equal(app.history.length,0);assert.equal(h.state.graph.nodes.length,1);
  assert.equal(h.calls.filter(call=>call.path.endsWith('/image-input')).length,1);
});

test('quick-edit busy flag is released after an uncertain transfer but the failed operation is never retried automatically',async()=>{
  const h=fixture(),app=appHarness(h);let fail=true;
  h.hooks.before=path=>{if(fail&&path.endsWith('/image-input'))throw new Error('reply lost');};
  await assert.rejects(app.run(),/手动重试/);assert.equal(app.history.length,0);
  assert.equal(h.calls.filter(call=>call.path.endsWith('/image-input')).length,1);
  fail=false;await app.run();assert.equal(app.history.length,1);
  assert.equal(h.calls.filter(call=>call.path.endsWith('/image-input')).length,2);
});

for(const count of [498,499])test(`quick edit reserves both nodes at the ${count}-node capacity boundary`,async()=>{
  const h=fixture();while(h.state.graph.nodes.length<count)h.state.graph.nodes.push(createNode('prompt',0,0));
  if(count===499){await assert.rejects(h.run(),/容量/);assert.equal(h.calls.length,0);return;}
  const fragment=await h.run();fragment.assertCurrent();
  h.state.graph.nodes.push(fragment.reference,fragment.target);h.state.graph.edges.push(fragment.edge);
  assert.equal(h.state.graph.nodes.length,500);assert.doesNotThrow(()=>parseGraph(serializeGraph(h.state.graph)));
});

test('last status response cannot rebase quick edit to another source output',async()=>{
  const h=fixture();let statuses=0;
  h.hooks.before=path=>{if(path==='/api/status'&&++statuses===2)h.source.data.outputs[0].node_id='different-sink';};
  await assert.rejects(h.run(),/变化/);assert.equal(h.state.graph.nodes.length,1);assert.equal(h.state.graph.edges.length,0);
});

test('a detached new destination cannot change its interface after capture even if the field ID remains the same',async()=>{
  const h=fixture(),target=createNode('generation',600,0,{kind:'qwen21_edit'});
  const ticket=captureResultReference({...h.state,source:h.source,job:h.job,outputId:h.output.output_id,targetId:target.id,fieldId:'image_1',newTarget:target});
  h.hooks.before=path=>{if(path==='/api/status')target.data.kind='sdxl_i2i';};
  await assert.rejects(transferResultReference(ticket,{api:h.api,current:h.current}),/变化/);
  assert.equal(h.calls.some(call=>call.path.endsWith('/image-input')),false);assert.equal(h.state.graph.nodes.length,1);
});

test('quick edit tracks exact branch and batch identity across history and canvas output reorders',async()=>{
  const h=fixture(),other={...h.output,node_id:'sink-8',filename:'other.png',output_id:`o-${'4'.repeat(64)}`};
  h.job.outputs=[other,h.output];h.source.data.outputs=clone(h.job.outputs);let jobReads=0;
  h.hooks.before=path=>{if(path==='/api/jobs'&&++jobReads===2){h.job.outputs.reverse();h.source.data.outputs.reverse();}};
  const fragment=await h.run();fragment.assertCurrent();
  const transfer=h.calls.find(call=>call.path.endsWith('/image-input'));
  assert.equal(transfer.data.output_id,h.output.output_id);assert.equal(transfer.data.output_index,1);
  assert.match(fragment.reference.data.title,/exact\.png/);assert.equal(h.state.graph.nodes.length,1);
});
