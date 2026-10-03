import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImageFile, validateMediaFile, mediaFileContentType, importPosition, prepareLocalImages } from '../web/canvas-images.mjs';
import { createNode, serializeGraph, parseGraph, validateExecutionMediaBackends } from '../web/graph.mjs';

const asset = 'a'.repeat(64), backend = 'http://127.0.0.1:8189';
test('Windows image drops without MIME are accepted by extension, unsupported and oversized files rejected', () => {
  validateImageFile({name:'截图.PNG',type:'',size:100});
  validateImageFile({name:'unnamed',type:'image/webp',size:100});
  for(const file of [{name:'x.svg',size:100},{name:'x.png',size:0},{name:'x.jpg',size:20*1024*1024+1}]) assert.throws(()=>validateImageFile(file));
});
test('multiple files keep their drop origin and use distinct grid positions', () => {
  assert.deepEqual(importPosition({x:-100,y:250},0),{x:-100,y:250});
  assert.deepEqual(importPosition({x:-100,y:250},3),{x:-100,y:630});
});

test('audio drops accept supported files with bounded size and canonical browser MIME aliases', () => {
  for (const [name, type, expected] of [['VOICE.WAV','','audio/wav'], ['v.flac','audio/x-flac','audio/flac'], ['v','audio/mpeg','audio/mpeg'], ['v.ogg','','audio/ogg']]) {
    const file = {name,type,size:100};
    assert.equal(validateMediaFile(file),'audio');
    assert.equal(mediaFileContentType(file),expected);
  }
  assert.throws(()=>validateMediaFile({name:'large.wav',size:20*1024*1024+1}),/20 MiB/);
  assert.throws(()=>validateMediaFile({name:'empty.mp3',size:0}));
  assert.throws(()=>validateMediaFile({name:'unsupported.m4a',type:'audio/mp4',size:100}));
});

test('audio assets validate every target binding even if already uploaded to the same engine', async () => {
  const ref=createNode('reference',0,0,{mediaType:'audio',localMedia:true,localAssetId:asset,name:'old.wav',uploadBackend:backend});
  const first=createNode('generation',400,0,{kind:'package',package_id:'p1'});
  const second=createNode('generation',400,400,{kind:'package',package_id:'p2'});
  const value={nodes:[ref,first,second],edges:[{source:ref.id,target:first.id,targetField:'voice'},{source:ref.id,target:second.id,targetField:'music'}]};
  const calls=[];
  const updates=await prepareLocalImages(value,[first.id,second.id],backend,async(path,body)=>{
    calls.push({path,body});return {asset_id:asset,name:'new.wav',backend};
  });
  assert.deepEqual(calls.map(c=>c.body),[{package_id:'p1',field_id:'voice'},{package_id:'p2',field_id:'music'}]);
  assert.ok(calls.every(c=>c.path===`/api/assets/media/${asset}/backend-input`));
  assert.equal(updates[0].name,'new.wav');
  assert.equal(ref.data.name,'old.wav');
});
function graph() {
  const ref=createNode('reference',0,0,{localAssetId:asset,localFilename:'图.png',url:`/api/assets/images/${asset}`});
  const out=createNode('generation',400,0,{kind:'sdxl_i2i'});
  const other=createNode('reference',0,400,{localAssetId:'b'.repeat(64)});
  return {nodes:[ref,out,other],edges:[{id:'e',source:ref.id,target:out.id}]};
}
test('local ownership persists through canvas save and untrusted preview URL is not used', () => {
  const value=graph(); value.nodes[0].data.url='https://example.com/fake.png';
  const restored=parseGraph(serializeGraph(value));
  assert.equal(restored.nodes[0].data.localAssetId,asset);
  assert.equal(restored.nodes[0].data.url,`/api/assets/images/${asset}`);
  value.nodes[0].data.localAssetId='../bad';assert.throws(()=>parseGraph(serializeGraph(value)),/图片标识/);
});
test('only connected local assets are copied to selected engine without inference', async () => {
  const value=graph(),calls=[];
  const updates=await prepareLocalImages(value,[value.nodes[1].id],backend,async(path)=>{
    calls.push(path);return {asset_id:asset,name:'input.png',backend};
  });
  assert.deepEqual(calls,[`/api/assets/images/${asset}/backend-input`]);
  assert.equal(updates[0].name,'input.png');assert.equal(value.nodes[0].data.name,'');
});
test('local source supports engine switch while legacy foreign input stays protected', async () => {
  const value=graph();Object.assign(value.nodes[0].data,{name:'old.png',uploadBackend:'http://127.0.0.1:8188'});
  assert.equal(validateExecutionMediaBackends(value,[value.nodes[1].id],'http://127.0.0.1:8188',backend),true);
  await assert.rejects(prepareLocalImages(value,[value.nodes[1].id],backend,async()=>({asset_id:asset,name:'x.png',backend:'http://127.0.0.1:8188'})),/引擎/);
  delete value.nodes[0].data.localAssetId;
  assert.throws(()=>validateExecutionMediaBackends(value,[value.nodes[1].id],'http://127.0.0.1:8188',backend),/不会/);
});
