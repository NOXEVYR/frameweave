import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect, canConnect, generationPayload, serializeGraph, parseGraph, duplicateNodes } from '../web/graph.mjs';
import { composeTextInput, normalizeTextCompositions, remapTextCompositions } from '../web/text-input-composition.mjs';
import { projectEditorInputs } from '../web/editor-preparation.mjs';
import { applyEditorInterfaceGraph } from '../web/editor-canvas-interface.mjs';
import { configurationBundle } from '../web/workflow-configurations.mjs';
import { planExecution, projectExecution } from '../web/execution-scope.mjs';
import { createWorkflowRunner } from '../web/workflow-runner.mjs';

const backend = 'http://127.0.0.1:8188';
const fields = [{id:'pos',label:'Positive',type:'text',node_id:'1',input:'text'}, {id:'neg',label:'Negative',type:'text',node_id:'2',input:'text'}];
function fixture() {
  const target = {...createNode('generation',100,100,{kind:'package',package_id:'p-0123456789abcdef01234567',packageFields:fields,packageValues:{pos:'OWN',neg:'OWN NEG'},packageTextCompositions:{pos:'paragraphs',neg:'comma'}}), id:'target'};
  const a = {...createNode('prompt',0,0,{text:'SOURCE A',negative:'NEG A'}),id:'a'};
  const b = {...createNode('prompt',0,200,{text:'SOURCE B',negative:'NEG B'}),id:'b'};
  const graph={nodes:[a,b,target],edges:[]};
  connect(graph,'a','target',{targetField:'pos',sourceField:'text'});
  connect(graph,'b','target',{targetField:'pos',sourceField:'text'});
  connect(graph,'a','target',{targetField:'neg',sourceField:'negative'});
  connect(graph,'b','target',{targetField:'neg',sourceField:'negative'});
  return {graph,target,a,b};
}
function project(graph) { return projectEditorInputs(graph,'target',{fields,backend,canvasId:'c'}); }

test('multiple text sources preserve ordered positive and negative aggregation and own values',()=>{
  const {graph,target}=fixture(), before=structuredClone(graph), payload=generationPayload(graph,'target');
  assert.deepEqual(payload.values,{pos:'SOURCE A\n\nSOURCE B\n\nOWN',neg:'NEG A, NEG B, OWN NEG'});
  assert.deepEqual(graph,before); assert.equal(target.data.packageValues.pos,'OWN');
  assert.equal(canConnect(graph,'a','target',{targetField:'pos'}).ok,false);
  assert.equal(canConnect(graph,'a','target',{targetField:'pos',sourceField:'negative'}).ok,true);
});
test('ordinary text fields retain single edge replacement and media cannot opt into composition',()=>{
  const {graph,target}=fixture(); delete target.data.packageTextCompositions;
  assert.throws(()=>generationPayload(graph,'target'),/已有连接/);
  graph.edges=graph.edges.filter(edge=>edge.source==='a');
  assert.deepEqual(generationPayload(graph,'target').values,{pos:'SOURCE A',neg:'NEG A'});
  assert.throws(()=>normalizeTextCompositions({pos:'paragraphs'},[{...fields[0],type:'image'}]));
});
test('join semantics skip empty strings but preserve whitespace and respect field length limits',()=>{
  assert.equal(composeTextInput('paragraphs',['','  ','B'],''),'  \n\nB');
  assert.equal(composeTextInput('comma',['A',''],'OWN'),'A, OWN');
  assert.throws(()=>composeTextInput('comma',['x'.repeat(64000)],'y'),/64000/);
  for(const value of [false,null,4,{},['wrong']]) assert.throws(()=>composeTextInput('comma',[value],''));
  assert.throws(()=>normalizeTextCompositions(JSON.parse('{"__proto__":"comma"}'),fields));
  assert.throws(()=>normalizeTextCompositions({pos:'eval'},fields));
});
test('serialized canvas and duplicate fragment retain composition without storing aggregate text',()=>{
  const {graph}=fixture(), restored=parseGraph(serializeGraph(graph));
  assert.equal(JSON.parse(serializeGraph(graph)).schema,'frameweave.canvas.v2');
  assert.throws(()=>parseGraph({...JSON.parse(serializeGraph(graph)),schema:'frameweave.canvas.v1'}),/v2/);
  assert.equal(JSON.parse(serializeGraph({nodes:graph.nodes.filter(n=>n.type==='prompt'),edges:[]})).schema,'frameweave.canvas.v1');
  assert.deepEqual(generationPayload(restored,'target'),generationPayload(graph,'target'));
  assert.deepEqual(restored.nodes.find(n=>n.id==='target').data.packageValues,{pos:'OWN',neg:'OWN NEG'});
  const ids=duplicateNodes(restored,['a','b','target']), target=restored.nodes.find(n=>ids.includes(n.id)&&n.type==='generation');
  assert.deepEqual(generationPayload(restored,target.id).values,generationPayload(graph,'target').values);
});
test('unknown own value cannot silently substitute empty for a nonempty package default',()=>{
  const {graph,target}=fixture(); delete target.data.packageValues.pos;
  assert.throws(()=>parseGraph(serializeGraph(graph)),/自身文本/);
  assert.throws(()=>generationPayload(graph,'target'),/自身文本/);
  const p=project(graph); assert(!p.overrides.some(item=>item.field_id==='pos'));
  assert(p.pending.some(item=>item.field_id==='pos'&&item.reason==='invalid_value'));
});
test('editor projection matches execution and retains independent fallback with all edge witnesses',()=>{
  const {graph}=fixture(), before=structuredClone(graph), p=project(graph);
  assert.deepEqual(p.pending,[]);
  assert.deepEqual(Object.fromEntries(p.overrides.map(item=>[item.field_id,item.value])),generationPayload(graph,'target').values);
  const pos=p.overrides.find(item=>item.field_id==='pos');
  assert.equal(pos.stored_fallback,'OWN'); assert.equal(pos.edge_ids.length,2);
  assert.deepEqual(graph,before);
});
test('invalid, duplicate or missing contributor blocks entire projected field instead of partial text',()=>{
  for(const change of [f=>{f.b.data.text=5;},f=>{f.graph.nodes=f.graph.nodes.filter(n=>n.id!=='b');},f=>{f.graph.edges.push({...f.graph.edges[0],id:'duplicate'});}]) {
    const f=fixture(); change(f); const p=project(f.graph);
    assert(p.pending.some(item=>item.field_id==='pos')); assert(!p.overrides.some(item=>item.field_id==='pos'));
  }
});
test('interface rebind retains mode and connections atomically; many old fields cannot implicitly merge',()=>{
  const {graph,target}=fixture(), next=fields.map(f=>({...f,id:`new_${f.id}`}));
  const result={package:{id:target.data.package_id,fields:next},values:{new_pos:'OWN',new_neg:'OWN NEG'},baseline:{},backend_url:backend,output_nodes:[],outputs:[],rebindings:{pos:'new_pos',neg:'new_neg'}};
  const updated=applyEditorInterfaceGraph(graph,'target',result);
  assert.deepEqual(updated.nodes.find(n=>n.id==='target').data.packageTextCompositions,{new_pos:'paragraphs',new_neg:'comma'});
  assert.deepEqual(generationPayload(updated,'target').values,{new_pos:'SOURCE A\n\nSOURCE B\n\nOWN',new_neg:'NEG A, NEG B, OWN NEG'});
  assert.throws(()=>remapTextCompositions({pos:'comma',neg:'comma'},fields,next,{pos:'new_pos',neg:'new_pos'}),/合并/);
  assert.throws(()=>applyEditorInterfaceGraph(graph,'target',{...result,rebindings:{pos:null,neg:'new_neg'},package:{...result.package,fields:[{...next[1],type:'integer'}]}}));
});
test('configuration snapshot captures effective text once while preserving future composition rule',()=>{
  const {graph,target}=fixture();
  const doc=configurationBundle({canvas:serializeGraph(graph),packages:[{id:target.data.package_id,source_json:'{}'}],editors:[]},'target','Joined config');
  const saved=parseGraph(doc.canvas), n=saved.nodes[0];
  assert.deepEqual(n.data.packageValues,generationPayload(graph,'target').values);
  assert.deepEqual(n.data.packageTextCompositions,target.data.packageTextCompositions);
  assert.deepEqual(saved.edges,[]);
  assert.deepEqual(generationPayload(saved,n.id).values,n.data.packageValues);
});

test('execution planning uses joined text and filters inactive composition only in its derived graph',async()=>{
  const {graph,target}=fixture(), before=structuredClone(graph), calls=[];
  const execution=await planExecution(graph,['target'],backend,async(path,body)=>{
    calls.push(body); return {backend_url:backend,package_id:target.data.package_id,execution:{selected_outputs:['1'],node_ids:['1'],active_field_ids:['pos']}};
  });
  assert.deepEqual(calls[0].request.values,generationPayload(graph,'target').values);
  const projected=projectExecution(graph,execution,['target']);
  assert.deepEqual(projected.nodes.find(n=>n.id==='target').data.packageTextCompositions,{pos:'paragraphs'});
  assert.equal(projected.edges.length,2); assert.equal(generationPayload(projected,'target').values.pos,'SOURCE A\n\nSOURCE B\n\nOWN');
  assert.deepEqual(graph,before);
});

test('durable joined runs require v2 and recover the exact request without resubmission',async()=>{
  const {graph}=fixture(); let disk=null, submissions=0;
  const api=async(path,body)=>{
    if(path==='/api/status')return {online:true,backend_url:backend};
    if(path==='/api/generate') {submissions++; assert.equal(disk.schema,'frameweave.workflow-run.v2'); assert.equal(body.request.values.pos,'SOURCE A\n\nSOURCE B\n\nOWN'); return {id:'done',status:'queued'};}
    if(path==='/api/jobs')return {jobs:[{id:'done',status:'completed',outputs:[]}]};
    throw new Error(path);
  };
  const runner=createWorkflowRunner({api,save:s=>{disk=structuredClone(s);},wait:()=>Promise.resolve()});
  const result=await runner.start({graph,targetIds:['target'],backend});
  assert.equal(result.status,'completed'); assert.equal(result.schema,'frameweave.workflow-run.v2');
  const restored=createWorkflowRunner({api,load:()=>disk,save:()=>{}});
  assert.equal((await restored.resume()).status,'completed'); assert.equal(submissions,1);
  assert.throws(()=>createWorkflowRunner({api,load:()=>({...disk,schema:'frameweave.workflow-run.v1'}),save:()=>{}}),/v2/);
});
