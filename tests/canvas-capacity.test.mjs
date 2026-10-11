import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CANVAS_ITEMS, validateCanvasStructure, createWorkflowCanvas } from '../web/workflow-canvas.mjs';
import { createNode } from '../web/graph.mjs';

const bundle = () => ({ schema:'prismcanvas.project.v1', version:1, name:'Budget', canvas:{nodes:[],edges:[]}, packages:[], padding:[] });
function count(document) {
  const pending=[document];let items=0;
  while(pending.length){const value=pending.pop();items++;if(value&&typeof value==='object')pending.push(...Object.values(value));}
  return items;
}

test('exact 500000 data items pass unchanged; one extra item requires splitting', () => {
  const document=bundle();document.padding=Array(MAX_CANVAS_ITEMS-count(document)).fill(null);
  assert.equal(validateCanvasStructure(document),document);
  document.padding.push(null);
  assert.throws(()=>validateCanvasStructure(document),/500000.*拆分/);
  assert.equal(document.padding.length,MAX_CANVAS_ITEMS-count(bundle())+1);
});

test('depth, cycles and invalid values fail before serialization', () => {
  const deep=bundle();let value=deep;for(let index=0;index<64;index++){value.nested={};value=value.nested;}
  assert.equal(validateCanvasStructure(deep),deep);value.nested={};
  const cyclic=bundle();cyclic.self=cyclic;
  for(const [document,message] of [[deep,/64.*拆分/],[cyclic,/有效的 JSON/],
    [{bad:undefined},/非 JSON/],[{bad:Infinity},/无效数字/],[{bad:Array(2)},/非 JSON/]])assert.throws(()=>validateCanvasStructure(document),message);
});

test('eight full control nodes export; ninth node is refused before download or mutation', async () => {
  const fields=Array.from({length:4096},(_,i)=>({id:`f${i}`,label:`Parameter ${i}`,type:'integer',presentation:'control',group:'Parameters',role:'settings'}));
  const values=Object.fromEntries(fields.map((f,i)=>[f.id,i]));
  const id='p-0123456789abcdef01234567';
  const data={kind:'package',package_id:id,packageFields:fields,packageValues:values,editor_baseline:structuredClone(values),
    editor_controls:fields.map((f,i)=>({node_id:String(Math.floor(i/512)),input:`value_${i}`,widget_node_id:String(Math.floor(i/512)),widget_name:`value_${i}`}))};
  const graph={nodes:Array.from({length:8},(_,index)=>createNode('generation',index*400,0,structuredClone(data))),edges:[]};
  const requests=[];let downloads=0;
  const workflow=createWorkflowCanvas({graph:()=>graph,viewport:()=>({x:0,y:0,scale:1}),title:()=> 'Large canvas',canvasIdentity:()=> 'canvas-1',engine:()=>({backend_url:'http://127.0.0.1:8188'}),loadPackages:async()=>{},
    api:async(path,body)=>{requests.push({path,body});return{document:{},source_json:'{"name":"Preserved source"}'};},
    downloadJSON:()=>{downloads++;},toast:()=>{}});
  await workflow.exportBundle();assert.equal(downloads,1);
  graph.nodes.push(createNode('generation',3200,0,structuredClone(data)));
  const before=JSON.stringify(graph);
  await assert.rejects(workflow.exportBundle(),/500000.*拆分/);
  assert.equal(downloads,1);assert.equal(JSON.stringify(graph),before);
  assert(requests.every(call=>call.path.endsWith('/export')),'only read-only source exports were requested');
});

test('import refuses excessive complete structure before package API writes', async () => {
  const document=bundle();document.padding=Array(MAX_CANVAS_ITEMS-count(document)+1).fill(null);
  const requests=[];
  const graph={nodes:[],edges:[]};
  const workflow=createWorkflowCanvas({graph:()=>graph,canvasIdentity:()=> 'canvas-1',engine:()=>({backend_url:'http://127.0.0.1:8188'}),api:async(...args)=>{requests.push(args);throw new Error('Unexpected API');}});
  await assert.rejects(workflow.importBundle({size:3000100,text:async()=>JSON.stringify(document)}),/500000.*拆分/);
  assert.deepEqual(requests,[]);
});

test('export retains independent 24 MiB byte budget and does not download on failure', async () => {
  const graph={nodes:Array.from({length:13},(_,index)=>createNode('generation',index*400,0,{
    kind:'package',package_id:`p-${String(index).padStart(24,'0')}`,packageFields:[],packageValues:{}})),edges:[]};
  const source_json=JSON.stringify({name:'Large source',prompt:{'1':{class_type:'Padding',inputs:{text:'x'.repeat(2*1024*1024-1024)}}},fields:[]});
  let downloads=0;
  const workflow=createWorkflowCanvas({graph:()=>graph,viewport:()=>({x:0,y:0,scale:1}),title:()=> 'Large bytes',canvasIdentity:()=> 'canvas-1',engine:()=>({backend_url:'http://127.0.0.1:8188'}),loadPackages:async()=>{},
    api:async()=>({document:{},source_json}),downloadJSON:()=>{downloads++;},toast:()=>{}});
  await assert.rejects(workflow.exportBundle(),/24 MiB/);
  assert.equal(downloads,0);
});
