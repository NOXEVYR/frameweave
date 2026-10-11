import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedHubRequest } from '../web/hub-selection.mjs';
import { createNode, connect } from '../web/graph.mjs';

function fixture() {
  const fields=[{id:'prompt',type:'text',label:'Prompt',default:'default'}];
  const node=createNode('generation',0,0,{kind:'package',package_id:'p-test',packageFields:fields,packageValues:{prompt:'local'}});
  const prompt=createNode('prompt',0,0,{text:'connected'}),graph={nodes:[node,prompt],edges:[]};
  connect(graph,prompt.id,node.id,{targetField:'prompt'});
  const state={graph,ids:[node.id],identity:'canvas-a',backend:'http://127.0.0.1:8188'};
  const host={graph:()=>state.graph,selectedIds:()=>[...state.ids],canvasIdentity:()=>state.identity,backend:()=>state.backend,
    ensurePackageDefinition:async()=>({id:'p-test',fields,name:'Example'})};
  return {state,host,node,prompt};
}

test('reads only selected package with connected text and keeps original graph intact',async()=>{
  const {state,host}=fixture(),before=structuredClone(state.graph);const result=await selectedHubRequest(host);
  assert.equal(result.request.values.prompt,'connected');assert.deepEqual(state.graph,before);
  result.fields[0].label='changed';assert.equal(state.graph.nodes[0].data.packageFields[0].label,'Prompt');
});
test('rejects absent, multiple and unsupported selection instead of choosing first generation',async()=>{
  const {state,host,node,prompt}=fixture();
  for(const ids of [[],[node.id,prompt.id],[prompt.id]]){state.ids=ids;await assert.rejects(selectedHubRequest(host),/只选中一个/);}
});
test('asynchronous selection requires identical canvas, graph, parameters, selection and backend',async()=>{
  for(const change of [f=>f.state.identity='other',f=>f.node.data.packageValues.prompt='changed',f=>f.state.ids=[],f=>f.state.backend='http://127.0.0.1:8199',f=>f.state.graph=structuredClone(f.state.graph)]){
    const f=fixture();let resolve;f.host.ensurePackageDefinition=()=>new Promise(r=>resolve=r);
    const reading=selectedHubRequest(f.host);change(f);resolve({id:'p-test',fields:[],name:'Example'});
    await assert.rejects(reading,/已变化/);
  }
});
test('bound engine cannot be silently changed while exporting a capability',async()=>{
  const {host,node}=fixture();node.data.editor_backend='http://127.0.0.1:8199';
  await assert.rejects(selectedHubRequest(host),/原推理引擎/);
});
