import test from 'node:test';
import assert from 'node:assert/strict';
import {createNode, serializeGraph} from '../web/graph.mjs';
import {prepareCanvasExecution} from '../web/workflow-canvas.mjs';

const backend = 'http://127.0.0.1:8188';
function fixture() {
  const target = createNode('generation', 400, 0, {kind:'package', package_id:`p-${'a'.repeat(24)}`,
    packageFields:[{id:'a',label:'场景',type:'image'},{id:'b',label:'未启用人物',type:'image'}],
    packageValues:{a:'',b:'old.png'}, editor_outputs:['2']});
  const active = createNode('reference', 0, 0, {localAssetId:'a'.repeat(64),mediaType:'image'});
  const inactive = createNode('reference', 0, 400, {name:'old.png',uploadBackend:'http://127.0.0.1:8189',mediaType:'image'});
  const graph = {nodes:[target,active,inactive],edges:[
    {id:'edge-a',source:active.id,target:target.id,targetField:'a',sourceField:'image'},
    {id:'edge-b',source:inactive.id,target:target.id,targetField:'b',sourceField:'image'}]};
  const state = {graph,identity:'canvas-1',backend,calls:[],prepared:[]};
  const host = {graph:()=>state.graph, canvasIdentity:()=>state.identity,
    loadPackages:async()=>{}, engine:()=>({online:true,backend_url:state.backend}),
    async ensurePackageDefinition(id) {
      state.definitions = [...(state.definitions || []), id];
      if (state.onDefinition) await state.onDefinition();
      return { id, name:'完整工作流', fields:[
        {id:'a',label:'场景',type:'image',node_id:'1',input:'image'},
        {id:'b',label:'未启用人物',type:'image',node_id:'3',input:'image'}],
        prompt:{'1':{class_type:'LoadImage',inputs:{image:''}},'2':{class_type:'SaveImage',inputs:{images:['1',0]}},
          '3':{class_type:'LoadImage',inputs:{image:''}},'4':{class_type:'SaveImage',inputs:{images:['3',0]}}} };
    },
    async prepareBackend(ids, options) {state.anchor=options;},
    async api(path, body) {
      state.calls.push({path,body});
      if (state.onPlan) await state.onPlan();
      return {backend_url:backend,package_id:target.data.package_id,execution:{selected_outputs:['2'],node_ids:['1','2'],ignored_node_ids:['3','4'],active_field_ids:['a']}};
    },
    async prepareInputs(ids, options) {state.prepared.push(options);if(state.onInputs)return state.onInputs(options);return options.graph;}
  };
  return {host,state,target,active,inactive};
}

test('canvas preparation plans first, limits media work, and retains the complete source graph', async () => {
  const h=fixture(), before=serializeGraph(h.state.graph);
  const prepared=await prepareCanvasExecution(h.host,[h.target.id]);
  assert.equal(h.state.anchor.rootOnly,true);
  assert.equal(h.state.calls.length,1);
  assert.equal(h.state.calls[0].path,'/api/execution-plan');
  assert.deepEqual(h.state.definitions,[h.target.data.package_id]);
  assert.deepEqual(h.state.prepared[0].projection.edges.map(e=>e.id),['edge-a']);
  assert.deepEqual(h.state.prepared[0].projection.nodes.find(n=>n.id===h.target.id).data.packageFields.map(f=>f.id),['a']);
  assert.equal(prepared.graph.nodes.length,3);
  assert.equal(prepared.graph.edges.length,2);
  assert.equal(prepared.graph.nodes[0].data.packageValues.b,'old.png');
  assert.equal(serializeGraph(h.state.graph),before);
});

test('changes during planning abort before any media preparation or submission', async () => {
  for (const change of [h=>h.state.identity='new-canvas',h=>h.target.data.title='changed',h=>h.state.backend='http://127.0.0.1:8189']) {
    const h=fixture();h.state.onPlan=()=>change(h);
    await assert.rejects(prepareCanvasExecution(h.host,[h.target.id]),/已变化/);
    assert.equal(h.state.prepared.length,0);
    assert.equal(h.state.calls.length,1);
  }
});

test('backend preparation checks canvas identity even when node IDs and data are unchanged', async () => {
  const h=fixture();h.host.prepareBackend=async()=>{h.state.identity='replacement';};
  await assert.rejects(prepareCanvasExecution(h.host,[h.target.id]),/画布、连线或参数已变化/);
  assert.equal(h.state.calls.length,0);
});

test('materialized reference names are frozen, while edits during upload are rejected', async () => {
  const h=fixture();
  h.state.onInputs=options=>{
    const node=options.graph.nodes.find(n=>n.id===h.active.id);
    Object.assign(node.data,{name:'ready.png',uploadBackend:backend});
    Object.assign(h.active.data,{name:'ready.png',uploadBackend:backend});
    return options.graph;
  };
  const prepared=await prepareCanvasExecution(h.host,[h.target.id]);
  assert.equal(prepared.graph.nodes.find(n=>n.id===h.active.id).data.name,'ready.png');
  h.active.data.name='later.png';
  assert.equal(prepared.graph.nodes.find(n=>n.id===h.active.id).data.name,'ready.png');
  const changed=fixture();changed.state.onInputs=options=>{changed.target.data.title='edited while uploading';return options.graph;};
  await assert.rejects(prepareCanvasExecution(changed.host,[changed.target.id]),/已变化/);
});
