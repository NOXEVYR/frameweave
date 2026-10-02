import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackageCatalog } from '../web/package-catalog.mjs';
const full=(id,extra={})=>({id,name:`包 ${id}`,fields:[{id:'custom',type:'text',label:'自定义',node_id:'1',input:'text'}],prompt:{'1':{class_type:'PrimitiveString',inputs:{value:''}}},...extra});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('refresh stores only summaries including archived metadata and ignores legacy list fields as definitions',async()=>{
  const calls=[],catalog=createPackageCatalog({api:async path=>{calls.push(path);return path.includes('?')?{packages:[full('p',{archived:true,favorite:true})]}:{package:full('p')};}});
  const rows=await catalog.refresh();assert.equal(rows[0].summary,true);assert.equal(rows[0].field_count,1);assert.equal(rows[0].archived,true);
  assert.equal('fields' in rows[0],false);assert.equal('prompt' in rows[0],false);assert.equal(catalog.peek('p'),null);
  assert.equal((await catalog.ensure('p')).fields[0].id,'custom');assert.deepEqual(calls,['/api/packages?summary=1','/api/packages/p']);
});

test('same ID shares pending detail request and failure permits explicit immediate retry without an empty cached definition',async()=>{
  let requests=0;const first=defer(),catalog=createPackageCatalog({api:()=>++requests===1?first.promise:Promise.resolve({package:full('p')})});
  const one=catalog.ensure('p'),two=catalog.ensure('p');assert.equal(one,two);first.reject(new Error('offline'));
  await assert.rejects(one,/offline/);assert.equal(catalog.peek('p'),null);assert.equal((await catalog.ensure('p')).id,'p');assert.equal(requests,2);
});

test('details use four concurrent requests with bounded queue rather than rejecting ordinary bulk usage',async()=>{
  const gates=[],calls=[];const catalog=createPackageCatalog({api:path=>{const gate=defer();gates.push(gate);calls.push(path);return gate.promise;}});
  const jobs=Array.from({length:20},(_,i)=>catalog.ensure(`p${i}`));await tick();assert.equal(calls.length,4);
  for(let i=0;i<20;i++){gates[i].resolve({package:full(`p${i}`)});await tick();assert.equal(calls.length,Math.min(20,i+5));}
  assert.equal((await Promise.all(jobs)).length,20);
});

test('queue limit rejects only beyond its different-ID budget and duplicate queued ID retains its promise',async()=>{
  const gate=defer(),catalog=createPackageCatalog({api:()=>gate.promise,concurrency:1,maxPending:2});
  const first=catalog.ensure('a'),second=catalog.ensure('b');assert.equal(second,catalog.ensure('b'));
  await assert.rejects(catalog.ensure('c'),/稍后重试/);gate.resolve({package:full('a')});await first;
  await assert.rejects(second,/完整/);
});

test('LRU is capped by complete entry count and exact UTF8 bytes, not a source-file limit',async()=>{
  const a=full('a'),b=full('b'),c=full('c');const calls=[];const catalog=createPackageCatalog({maxEntries:2,api:async path=>{calls.push(path);return{package:full(path.split('/').at(-1))};}});
  catalog.remember(a);catalog.remember(b);catalog.peek('a');catalog.remember(c);assert.equal(catalog.peek('b'),null);assert(catalog.peek('a'));assert(catalog.peek('c'));
  await catalog.ensure('b');assert.equal(calls.length,1);
  const heavy=full('unicode',{description:'中'.repeat(50)}),size=new TextEncoder().encode(JSON.stringify(heavy)).length;
  const bytes=createPackageCatalog({api:async()=>({package:heavy}),maxBytes:size});bytes.remember(a);bytes.remember(heavy);assert.equal(bytes.peek('a'),null);assert.equal(bytes.peek('unicode').description,heavy.description);
  const oversized=createPackageCatalog({api:async()=>({package:heavy}),maxBytes:size-1});assert.equal((await oversized.ensure('unicode')).id,'unicode');assert.equal(oversized.peek('unicode'),null);
});

test('complete DTO validation rejects summaries, mismatched IDs, and missing prompt without caching them',async()=>{
  for(const value of [{id:'p',name:'p',summary:true},{id:'other',...full('other')},{id:'p',name:'p',fields:[]}]){
    const catalog=createPackageCatalog({api:async()=>({package:value})});await assert.rejects(catalog.ensure('p'),/完整/);assert.equal(catalog.peek('p'),null);
  }
});

test('remember clones imported data and a late detail response cannot replace a newer explicit imported or metadata definition',async()=>{
  const gate=defer(),catalog=createPackageCatalog({api:()=>gate.promise});const loading=catalog.ensure('p');await tick();
  const newer=full('p',{archived:true,name:'新名称'});catalog.remember(newer);newer.fields[0].label='污染';
  gate.resolve({package:full('p',{archived:false})});const result=await loading;
  assert.equal(result.name,'新名称');assert.equal(result.archived,true);assert.equal(result.fields[0].label,'自定义');assert.equal(catalog.summaries()[0].archived,true);
});

test('refresh is deduplicated and an explicit force after pending normal refresh performs the force request',async()=>{
  const gate=defer(),calls=[];const catalog=createPackageCatalog({api:path=>{calls.push(path);return calls.length===1?gate.promise:Promise.resolve({packages:[]});}});
  const a=catalog.refresh(),b=catalog.refresh();assert.equal(a,b);const force=catalog.refresh({force:true});await tick();
  gate.resolve({packages:[]});await Promise.all([a,force]);assert.deepEqual(calls,['/api/packages?summary=1','/api/packages?summary=1&refresh=1']);
});


test('an old summary refresh cannot erase a newly imported package or newer archived metadata',async()=>{
  const gate=defer(),catalog=createPackageCatalog({api:()=>gate.promise});const refreshing=catalog.refresh();await tick();
  catalog.remember(full('new',{archived:true}));gate.resolve({packages:[full('old')]});await refreshing;
  assert.deepEqual(catalog.summaries().map(item=>item.id),['old','new']);assert.equal(catalog.summaries()[1].archived,true);
});

test('force refresh invalidates definitions and rejects old in-flight details; deleted entries cannot remain cache hits',async()=>{
  let detailCalls=0;const gate=defer(),catalog=createPackageCatalog({api:async path=>path.includes('?')?{packages:[]}:++detailCalls===1?gate.promise:Promise.reject(Error('deleted'))});
  catalog.remember(full('cached'));const pending=catalog.ensure('pending');await tick();await catalog.refresh({force:true});
  assert.equal(catalog.peek('cached'),null);gate.resolve({package:full('pending')});await assert.rejects(pending,/已刷新/);
  assert.equal(catalog.peek('pending'),null);await assert.rejects(catalog.ensure('cached'),/deleted/);
});

test('nonforce authoritative refresh prunes deleted cache and refreshes metadata while shared fields remain immutable',async()=>{
  const catalog=createPackageCatalog({api:async()=>({packages:[{...full('keep'),name:'新名字',archived:true}]})});
  catalog.remember(full('keep'));catalog.remember(full('gone'));await catalog.refresh();
  assert.equal(catalog.peek('gone'),null);const kept=catalog.peek('keep');assert.equal(kept.name,'新名字');assert.equal(kept.archived,true);
  assert.throws(()=>{kept.fields[0].label='污染';},TypeError);assert.throws(()=>{kept.name='污染';},TypeError);
});


test('ordinary refresh deleting a known package prevents its older in-flight detail from resurrecting the summary',async()=>{
  const gate=defer(),catalog=createPackageCatalog({maxEntries:1,api:path=>path.includes('?')?Promise.resolve({packages:[]}):gate.promise});
  catalog.remember(full('deleted'));catalog.remember(full('evict'));const pending=catalog.ensure('deleted');await tick();
  await catalog.refresh();gate.resolve({package:full('deleted')});await assert.rejects(pending,/已更新/);assert.equal(catalog.summaries().some(row=>row.id==='deleted'),false);
});

test('older detail cannot reverse refreshed archive metadata or return mutable stale fallback after newer entry eviction',async()=>{
  const gate=defer(),catalog=createPackageCatalog({maxEntries:1,api:path=>path.includes('?')?Promise.resolve({packages:[{...full('p'),archived:true}]}):gate.promise});
  catalog.remember(full('p'));catalog.remember(full('evict'));const pending=catalog.ensure('p');await tick();await catalog.refresh();gate.resolve({package:full('p',{archived:false})});
  await assert.rejects(pending,/已更新/);assert.equal(catalog.summaries()[0].archived,true);
  const second=defer(),other=createPackageCatalog({maxEntries:1,api:()=>second.promise});const loading=other.ensure('p');await tick();other.remember(full('p',{name:'new'}));other.remember(full('evict'));
  second.resolve({package:full('p',{name:'old'})});await assert.rejects(loading,/已更新/);assert.equal(other.summaries().find(row=>row.id==='p').name,'new');
});
