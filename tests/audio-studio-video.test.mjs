import test from 'node:test';
import assert from 'node:assert/strict';
import { audioMediaIssue, audioUploadContextMatches, buildAudioPackageRequest, renderAudioFields, restoreAudioMediaPreviews } from '../web/audio-studio.mjs';

const BACKEND='http://127.0.0.1:8188',OTHER='http://127.0.0.1:8189',ASSET='a'.repeat(64),MEDIA='/api/media/'+'b'.repeat(32);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
class Element{
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.style={};this.classList={add(){}};this.pauses=0;}
  append(...items){this.children.push(...items);} replaceChildren(...items){this.children=items;}
  setAttribute(){} removeAttribute(name){if(name==='src')this.src='';}
  addEventListener(event,fn){this.listeners[event]=fn;} pause(){this.pauses++;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector.split(',').includes(child.tagName.toLowerCase())?[child]:[]),...child.querySelectorAll(selector)]);}
}
const find=(root,match)=>match(root)?root:root.children.map(child=>find(child,match)).find(Boolean);
function setup(t,{type='video',initial=true,store,api}={}){
  const previousDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const previousReader=Object.getOwnPropertyDescriptor(globalThis,'FileReader');
  const previousCreate=Object.getOwnPropertyDescriptor(URL,'createObjectURL'),previousRevoke=Object.getOwnPropertyDescriptor(URL,'revokeObjectURL');
  const blobs=[],revoked=[];let serial=0;
  globalThis.document={createElement:tag=>new Element(tag)};
  globalThis.FileReader=class{readAsDataURL(){this.result='data:application/octet-stream;base64,YWJj';this.onload();}};
  URL.createObjectURL=file=>{const url=`blob:test-${++serial}`;blobs.push({file,url});return url;};URL.revokeObjectURL=url=>revoked.push(url);
  t.after(()=>{for(const [key,descriptor] of [['document',previousDocument],['FileReader',previousReader]]){
    if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
    for(const [key,descriptor] of [['createObjectURL',previousCreate],['revokeObjectURL',previousRevoke]]){
      if(descriptor)Object.defineProperty(URL,key,descriptor);else delete URL[key];}});
  const field={id:'reference',label:'参考素材',type,node_id:'1',input:type==='video'?'file':type,required:true};
  const pack={id:'p-audio',eligible:true,available:true,fields:[field]},oldName=`old.${type==='video'?'mp4':type==='audio'?'wav':'png'}`;
  const oldURL='/api/assets/media/'+'c'.repeat(64);
  const draft={package_id:pack.id,values:initial?{reference:oldName}:{},mediaBackends:initial?{reference:BACKEND}:{},
    mediaPreviewsByPackage:initial?{[pack.id]:{reference:{name:oldName,backend:BACKEND,type,url:oldURL}}}:{}};
  const calls=[],errors=[],container=new Element('div');
  const h={pack,field,draft,calls,errors,container,blobs,revoked,current:true,backend:BACKEND,oldName,oldURL};
  const receipt=()=>({name:'input/new.mp4',url:MEDIA,backend:BACKEND,asset_id:ASSET,media_type:'video',package_id:pack.id,field_id:field.id});
  h.receipt=receipt;
  h.render=()=>renderAudioFields(container,{pack,draft,backend:BACKEND,currentBackend:()=>h.backend,isCurrent:()=>h.current,
    storeMedia:store===false?undefined:async file=>{calls.push({kind:'store',file});return store?store(file):{asset_id:ASSET,media_type:'video',mime:file.type||'video/mp4'};},
    api:async(path,body)=>{calls.push({kind:'api',path,body});return api?api(path,body):receipt();},onChange(){calls.push({kind:'change'});},reportError:error=>errors.push(error)});
  h.input=()=>find(container,item=>item.tagName==='INPUT'&&item.type==='file');h.preview=()=>find(container,item=>item.className==='audio-input-preview');
  h.keep=()=>find(container,item=>item.className?.includes('audio-keep-media'));h.status=()=>find(container,item=>item.className==='audio-upload-name').textContent;
  h.upload=(file={name:'new.mp4',type:'video/mp4',size:30*1024*1024})=>{h.input().files=[file];return h.input().listeners.change();};h.render();return h;
}

test('video uses local binary storage then exact package input receipt; pending preview never enables generation',async t=>{
  const stored=deferred(),uploaded=deferred();const h=setup(t,{store:()=>stored.promise,api:()=>uploaded.promise});
  const before=structuredClone(h.draft),run=h.upload();assert.match(h.input().accept,/\.mp4.*\.webm.*\.mov/);
  assert.equal(h.preview().src,'blob:test-1');assert.equal(h.preview().controls,true);assert.equal(h.preview().autoplay,false);assert.equal(h.preview().muted,true);
  assert.throws(()=>buildAudioPackageRequest(h.pack,h.draft,BACKEND),/正在上传/);assert.deepEqual(h.draft,before);
  stored.resolve({asset_id:ASSET,media_type:'video',mime:'video/mp4'});await new Promise(setImmediate);
  assert.equal(h.preview().src,`/api/assets/media/${ASSET}`);
  const call=h.calls.find(item=>item.kind==='api');assert.equal(call.path,`/api/assets/media/${ASSET}/backend-input`);assert.deepEqual(call.body,{package_id:h.pack.id,field_id:h.field.id});
  assert.deepEqual(h.draft,before);uploaded.resolve(h.receipt());await run;
  assert.equal(h.draft.values.reference,'input/new.mp4');assert.equal(h.draft.mediaBackends.reference,BACKEND);assert.equal(audioMediaIssue(h.draft),'');
  assert.equal(buildAudioPackageRequest(h.pack,h.draft,BACKEND).values.reference,'input/new.mp4');assert.deepEqual(h.revoked,['blob:test-1']);
  assert.deepEqual(h.draft.mediaPreviewsByPackage[h.pack.id].reference,{name:'input/new.mp4',backend:BACKEND,type:'video',url:`/api/assets/media/${ASSET}`});
  const old=h.preview();h.render();assert.ok(old.pauses>0);assert.equal(h.preview().src,`/api/assets/media/${ASSET}`);assert.match(h.status(),/当前引擎/);
  assert.equal(h.calls.filter(item=>item.kind==='store').length,1);assert.equal(h.calls.filter(item=>item.kind==='api').length,1);
});

test('required video hint follows pending upload and disappears on success without rebuilding the form',async t=>{
  const gate=deferred(),h=setup(t,{initial:false,api:()=>gate.promise});
  const hint=find(h.container,item=>item.className==='field-error');
  assert.equal(hint.hidden,false);assert.equal(hint.textContent,'必需输入');
  const run=h.upload();await new Promise(setImmediate);
  assert.equal(hint.hidden,false);assert.match(hint.textContent,/等待上传完成/);
  gate.resolve(h.receipt());await run;
  assert.equal(find(h.container,item=>item.className==='field-error'),hint);
  assert.equal(hint.hidden,true);assert.equal(h.draft.values.reference,'input/new.mp4');
});

test('failed replacement retains an existing required video without falsely reporting a missing input',async t=>{
  const gate=deferred(),h=setup(t,{api:()=>gate.promise});
  const hint=find(h.container,item=>item.className==='field-error'),run=h.upload();await new Promise(setImmediate);
  assert.equal(hint.hidden,true);gate.reject(new Error('upload unavailable'));await run;
  assert.equal(h.draft.values.reference,h.oldName);assert.equal(hint.hidden,true);
  assert.match(h.status(),/新素材上传失败.*已保留/);assert.match(audioMediaIssue(h.draft),/上传失败/);
  h.keep().listeners.click();assert.equal(hint.hidden,true);assert.equal(audioMediaIssue(h.draft),'');
});

for(const [name,type] of [['clip.mp4','video/mp4'],['clip.webm','video/webm'],['clip.mov','video/quicktime'],['clip.mp4','']])test(`video canonical MIME ${name}/${type||'inferred'} reaches storage`,async t=>{
  const h=setup(t);await h.upload({name,type,size:200*1024*1024});assert.equal(h.errors.length,0);assert.equal(h.draft.values.reference,'input/new.mp4');
});

test('video rejects unsupported MIME, wrong media type, empty and oversized files before storage',async t=>{
  const h=setup(t),before=structuredClone(h.draft);
  for(const file of [{name:'clip.mp4',type:'application/octet-stream',size:16},{name:'clip.wav',type:'audio/wav',size:16},
    {name:'clip.mp4',type:'video/mp4',size:0},{name:'clip.mp4',type:'video/mp4',size:200*1024*1024+1}])await h.upload(file);
  assert.equal(h.errors.length,4);assert.equal(h.calls.some(item=>item.kind==='store'||item.kind==='api'),false);assert.deepEqual(h.draft,before);
});

for(const bad of ['asset-id','asset-type','asset-mime'])test(`invalid local ${bad} receipt never starts backend transfer`,async t=>{
  const asset={asset_id:ASSET,media_type:'video',mime:'video/mp4'};asset[{'asset-id':'asset_id','asset-type':'media_type','asset-mime':'mime'}[bad]]='wrong';
  const h=setup(t,{store:async()=>asset}),before=structuredClone(h.draft);await h.upload();
  assert.equal(h.errors.length,1);assert.equal(h.calls.some(item=>item.kind==='api'),false);assert.deepEqual(h.draft,before);assert.equal(h.preview().src,h.oldURL);
});

for(const bad of ['backend','asset_id','media_type','package_id','field_id','name','url'])test(`wrong video input ${bad} receipt cannot commit or replace old preview`,async t=>{
  let h;h=setup(t,{api:async()=>({...h.receipt(),[bad]:bad==='name'?'../foreign.mp4':'wrong'})});const before=structuredClone(h.draft);await h.upload();
  assert.deepEqual(h.draft,before);assert.equal(h.errors.length,1);assert.match(audioMediaIssue(h.draft),/上传失败/);assert.equal(h.preview().src,h.oldURL);
});

for(const stage of ['store','input'])for(const change of ['backend','values','package','field','current'])test(`${change} change during ${stage} rejects late video without draft mutation`,async t=>{
  const gate=deferred();let h;
  h=setup(t,{store:stage==='store'?()=>gate.promise:undefined,api:stage==='input'?()=>gate.promise:undefined});const run=h.upload();
  if(stage==='input')await new Promise(setImmediate);
  if(change==='backend')h.backend=OTHER;if(change==='values')h.draft.values={reference:'user-new.mp4'};
  if(change==='package')h.draft.package_id='another';if(change==='field')h.field.input='another';if(change==='current')h.current=false;
  const afterChange=structuredClone(h.draft);
  gate.resolve(stage==='store'?{asset_id:ASSET,media_type:'video',mime:'video/mp4'}:h.receipt());await run;
  assert.deepEqual(h.draft,afterChange);assert.equal(h.errors.length,1);assert.equal(h.revoked.length,1);
  if(stage==='store')assert.equal(h.calls.some(item=>item.kind==='api'),false);
});

test('last video choice wins when input receipts finish in reverse order',async t=>{
  const first=deferred(),second=deferred();let count=0,h;
  h=setup(t,{api:()=>++count===1?first.promise:second.promise});const one=h.upload();await new Promise(setImmediate);
  const two=h.upload({name:'second.mp4',type:'video/mp4',size:16});await new Promise(setImmediate);
  second.resolve({...h.receipt(),name:'second.mp4'});await two;first.resolve({...h.receipt(),name:'first.mp4'});await one;
  assert.equal(h.draft.values.reference,'second.mp4');assert.equal(h.errors.length,0);assert.equal(h.revoked.length,2);
});

test('keep original video discards pending capability and failure preserves its recoverable preview',async t=>{
  const gate=deferred(),h=setup(t,{api:()=>gate.promise});const run=h.upload();await new Promise(setImmediate);
  h.keep().listeners.click();assert.equal(buildAudioPackageRequest(h.pack,h.draft,BACKEND).values.reference,h.oldName);assert.equal(h.preview().src,h.oldURL);
  gate.resolve(h.receipt());await run;assert.equal(h.draft.values.reference,h.oldName);assert.equal(h.errors.length,0);
});

test('missing binary host support explains failure without guessing another upload route',async t=>{
  const h=setup(t,{store:false});await h.upload();assert.match(h.errors[0].message,/本地视频存储能力/);assert.equal(h.calls.some(item=>item.kind==='api'),false);
});

for(const type of ['image','audio'])test(`${type} legacy upload gets a registered preview without trusting arbitrary URLs`,async t=>{
  const h=setup(t,{type,api:async()=>({name:type==='audio'?'new.wav':'new.png',backend:BACKEND,url:MEDIA})});
  await h.upload({name:type==='audio'?'new.wav':'new.png',type:type==='audio'?'audio/wav':'image/png',size:16});
  assert.equal(h.preview().src,MEDIA);assert.equal(h.errors.length,0);assert.equal(h.calls.some(item=>item.kind==='store'),false);
  if(type==='audio')assert.equal(h.preview().autoplay,false);
});

test('preview belongs to exact current filename/backend/type/package and foreign ownership remains visible',t=>{
  const h=setup(t);h.draft.mediaBackends.reference=OTHER;h.render();assert.match(h.status(),/另一个推理引擎/);assert.equal(h.preview().hidden,true);
  assert.throws(()=>buildAudioPackageRequest(h.pack,h.draft,BACKEND),/另一个推理引擎/);
  h.draft.mediaBackends.reference=BACKEND;h.draft.values.reference='changed.mp4';h.render();assert.equal(h.preview().hidden,true);
  h.draft.values.reference=h.oldName;h.draft.mediaPreviewsByPackage[h.pack.id].reference.type='audio';h.render();assert.equal(h.preview().hidden,true);
});

test('restore preview metadata strips unsafe records and prototype keys, bounds size, and cannot authorize stale values',()=>{
  const entry={name:'input/ref.mp4',backend:BACKEND,type:'video',url:`/api/assets/media/${ASSET}`};
  const restored=restoreAudioMediaPreviews({p:{v:entry}});assert.deepEqual(restored,{p:{v:entry}});assert.notEqual(restored.p.v,entry);
  for(const change of [{name:'../x.mp4'},{backend:'https://example.com'},{backend:'http://user:secret@127.0.0.1'},{type:'html'},{url:'https://example.com/video'},{url:'blob:old'}])assert.deepEqual(restoreAudioMediaPreviews({p:{v:{...entry,...change}}}),{});
  assert.deepEqual(restoreAudioMediaPreviews(JSON.parse('{"__proto__":{"v":{}},"p":{"constructor":{}}}')),{});
  assert.deepEqual(restoreAudioMediaPreviews([]),{});assert.deepEqual(restoreAudioMediaPreviews(Object.fromEntries(Array.from({length:129},(_,i)=>['p'+i,{}]))),{});
  assert.deepEqual(restoreAudioMediaPreviews({p:Object.fromEntries(Array.from({length:4097},(_,i)=>['f'+i,entry]))}),{});
});

test('audio context guard checks same-ID field content and rejects duplicate mappings',()=>{
  const draft={},field={id:'v',type:'video',node_id:'1',input:'file'};
  const expected={epoch:1,category:'voice',draft,packageId:'p',backend:BACKEND};const current={...expected,capabilitiesBackend:BACKEND,fields:[{...field}]};
  assert.equal(audioUploadContextMatches(expected,current,field),true);
  current.fields[0].input='other';assert.equal(audioUploadContextMatches(expected,current,field),false);
  current.fields=[field,{...field}];assert.equal(audioUploadContextMatches(expected,current,field),false);
});
