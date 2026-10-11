import test from 'node:test';
import assert from 'node:assert/strict';
import { readWorkflowFile, selectWorkflowCarrier } from '../web/workflow-file.mjs';

const native = () => ({key:'workflow',chunkIndex:1,kind:'native',sourceJSON:'{"nodes":[]}',error:null});
const api = () => ({key:'prompt',chunkIndex:2,kind:'api',sourceJSON:'{"1":{"class_type":"EmptyImage","inputs":{}}}',error:null});
test('one valid carrier preserves exact text without asking or merging', async () => {
  const entry=native();
  assert.equal(await selectWorkflowCarrier([entry],()=>{throw new Error('unexpected choice');}),entry);
});
test('native and prompt alternatives require explicit selection including damaged siblings', async () => {
  const first=native(), second=api(), damaged={...native(),chunkIndex:3,error:{code:'json',message:'invalid'}};
  const items=[first,second,damaged];
  assert.equal(await selectWorkflowCarrier(items,async offered=>{assert.equal(offered,items);return second;}),second);
  assert.equal(await selectWorkflowCarrier([first,damaged],async()=>null),null);
  assert.equal(await selectWorkflowCarrier([{...first,duplicate:true}],async()=>null),null);
});
test('no record and invalid or fabricated choices never import anything', async () => {
  await assert.rejects(selectWorkflowCarrier([],()=>null),/没有内嵌/);
  const item=api();
  await assert.rejects(selectWorkflowCarrier([native(),item],()=>({...item})),/没有选中/);
  const invalid={...native(),error:{message:'broken'}};
  await assert.rejects(selectWorkflowCarrier([invalid],()=>invalid),/没有选中/);
});
test('JSON keeps its raw source and existing 16 MiB bound', async () => {
  const text='{\n  "nodes": []\n}', file=new Blob([text]); file.name='test.json';
  const result=await readWorkflowFile(file,()=>{throw new Error('unexpected choice');});
  assert.equal(result.sourceJSON,text);assert.equal(result.name,'test');assert.equal(result.container,'json');
  const large=new Blob([new Uint8Array(16*1024*1024+1)]);large.name='large.json';
  await assert.rejects(readWorkflowFile(large,()=>null),/16 MiB/);
});
