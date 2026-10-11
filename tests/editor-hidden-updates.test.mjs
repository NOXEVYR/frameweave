import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHiddenUpdates, mergeHiddenUpdates } from '../web/editor-hidden-updates.mjs';
import { createNode, serializeGraph, parseGraph } from '../web/graph.mjs';
const width = {field:{id:'width',node_id:'1',input:'width',label:'宽度',type:'integer'},value:77,baseline:10};
test('hidden edits retain baseline through canvas reload and later interface edits',()=>{
  const node=createNode('generation',0,0,{kind:'package',package_id:'p-test',editor_hidden_updates:[width]});
  const restored=parseGraph(serializeGraph({nodes:[node],edges:[]}));
  assert.deepEqual(restored.nodes[0].data.editor_hidden_updates,[width]);
  assert.deepEqual(mergeHiddenUpdates([width],[],false,[]),[width]);
  assert.deepEqual(mergeHiddenUpdates([width],[],true,[]),[]);
  assert.deepEqual(mergeHiddenUpdates([width],[],false,[width.field]),[]);
});
test('hidden edits reject links, media, duplicate bindings and unbounded retention',()=>{
  assert.throws(()=>normalizeHiddenUpdates([{...width,value:['9',0]}]),/基础值/);
  assert.throws(()=>normalizeHiddenUpdates([{...width,field:{...width.field,type:'image'}}]),/素材/);
  assert.throws(()=>normalizeHiddenUpdates([width,width]),/重复/);
  assert.throws(()=>normalizeHiddenUpdates(Array(4097).fill(width)),/4096/);
  assert.throws(()=>normalizeHiddenUpdates([{...width,value:Infinity}]),/基础值/);
});
