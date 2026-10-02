import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewExposureIsolation } from '../web/native-editor-preview-exposures.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
function fixture({vue=false}={}) {
  const root={id:'root',nodes:[]},scope={id:'definition',nodes:[]},leaf={id:1,type:'LoadAudio',graph:scope},table=new Map(),listeners=new Set(),observers=[],invalidations=[];
  let current=root,valid=true,capValid=true,tickHook;
  const original=[{name:'audioUI',sourceNodeId:'1',sourcePreviewName:'audioUI'}];scope.nodes.push(leaf);
  const get=(g,h)=>table.get(g+':'+h)||[],set=(g,h,value)=>table.set(g+':'+h,copy(value));
  const store={$id:'previewExposure',$onAction(fn){listeners.add(fn);return()=>listeners.delete(fn);},getExposures:get};
  const action=(name,fn)=>{store[name]=(...args)=>{for(const callback of [...listeners])callback({name,args});return fn(...args);};};
  action('setExposures',set);action('removeExposure',(g,h,name)=>set(g,h,get(g,h).filter(e=>e.name!==name)));
  action('addExposure',(g,h,value)=>set(g,h,[...get(g,h),value]));action('clearGraph',g=>{for(const key of [...table.keys()])if(key.startsWith(g+':'))table.delete(key);});
  const makeHost=(hostId,exposed=[])=>{const host={id:hostId,graph:root,subgraph:scope,isSubgraphNode:()=>true,serialize(){return{id:hostId,properties:{previewExposures:copy(get(root.id,String(hostId)))},widgets_values:['native.wav']};}};root.nodes.push(host);set(root.id,String(hostId),exposed);return host;};
  const a=makeHost(5,original),b=makeHost(6),descriptor=Object.getOwnPropertyDescriptor(a,'serialize');
  const player={paused:false,isConnected:true,autoplay:true,src:'native.wav',pause(){this.paused=true;},removeAttribute(){this.src='';},load(){}};
  const hosts=new Map([[a, [player]],[b,[]]]),pane={querySelectorAll(selector){const host=root.nodes.find(n=>selector.includes(`"${n.id}"`));return host?[{querySelectorAll:()=>hosts.get(host)||[]}]:[];}};
  const document={body:{},querySelectorAll:()=>vue?[pane]:[]},app={canvas:{graph:root}},window={LiteGraph:{vueNodesMode:vue},MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}};
  const capability={supported:true,isCurrent:()=>capValid,exposureStore:store,async nextTick(){if(tickHook)await tickHook();if(vue)for(const host of [a,b])if(!get(root.id,String(host.id)).length){for(const element of hosts.get(host)||[])element.isConnected=false;hosts.set(host,[]);}}};
  const manager=createPreviewExposureIsolation({capability,app,window,document,graph:()=>current,onInvalidate:(node,reason)=>invalidations.push({node,reason})});
  const target={node:leaf,owner:a,mappingProof:{root,nodes:[a,leaf]}},acquire=()=>manager.acquire(target,()=>valid);
  return{root,scope,leaf,a,b,store,table,original,descriptor,player,hosts,listeners,observers,invalidations,manager,target,acquire,makeHost,app,window,
    invalidate(){valid=false;},replaceRoot(){current={id:'new',nodes:[]};},breakAPI(){capValid=false;},tick(fn){tickHook=fn;}};
}
test('shared audio pauses all hosts, preserves saved defaults, then restores exact descriptors and exposures',async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);assert.equal(f.manager.allows(f.target),true);
  assert.deepEqual(f.store.getExposures('root','5'),[]);assert.deepEqual(f.a.serialize().properties.previewExposures,f.original);
  assert.deepEqual(f.a.serialize().widgets_values,['native.wav']);assert.deepEqual(f.b.serialize().properties.previewExposures,[]);
  f.manager.reset();assert.deepEqual(f.store.getExposures('root','5'),f.original);assert.deepEqual(Object.getOwnPropertyDescriptor(f.a,'serialize'),f.descriptor);
  f.manager.destroy();f.manager.destroy();assert.equal(f.listeners.size,0);assert.ok(f.observers.every(o=>o.disconnected));
});
test('Vue player is paused and unloaded before capability, then removed by awaited renderer flush',async()=>{
  const f=fixture({vue:true});assert.equal(await f.acquire(),true);assert.equal(f.player.paused,true);assert.equal(f.player.isConnected,false);assert.equal(f.player.src,'');assert.equal(f.player.autoplay,false);f.manager.destroy();
});
for(const action of ['remove','add','set','clear'])test(`user ${action} sees original exposure table and survives reset`,async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);let expected;
  if(action==='remove'){f.store.removeExposure('root','5','audioUI');expected=[];}
  if(action==='add'){const second={name:'custom',sourceNodeId:'3',sourcePreviewName:'preview'};f.store.addExposure('root','5',second);expected=[...f.original,second];}
  if(action==='set'){expected=[{name:'replacement',sourceNodeId:'2',sourcePreviewName:'other'}];f.store.setExposures('root','5',expected);}
  if(action==='clear'){f.store.clearGraph('root');expected=[];}
  assert.equal(f.manager.allows(f.target),false);f.manager.reset();assert.deepEqual(f.store.getExposures('root','5'),expected);f.manager.destroy();
});
for(const mode of ['unknown-preview','other-leaf','extra-field','multiple-exposures','deep-host','nested-alias'])test(`${mode} never changes exposures or serializer`,async()=>{
  const f=fixture();let value=copy(f.original);
  if(mode==='unknown-preview')value[0].sourcePreviewName='customAudio';
  if(mode==='other-leaf')value[0].sourceNodeId='99';
  if(mode==='extra-field')value[0].future=true;
  if(mode==='multiple-exposures')value.push({...value[0],name:'second'});
  if(mode==='deep-host')f.target.mappingProof.nodes.push({});
  if(mode==='nested-alias'){const middle={id:'middle',nodes:[{id:30,graph:null,subgraph:f.scope,isSubgraphNode:()=>true}]};middle.nodes[0].graph=middle;f.root.nodes.push({id:20,graph:f.root,subgraph:middle,isSubgraphNode:()=>true});}
  f.store.setExposures('root','5',value);assert.equal(await f.acquire(),false);assert.deepEqual(f.store.getExposures('root','5'),value);assert.deepEqual(Object.getOwnPropertyDescriptor(f.a,'serialize'),f.descriptor);f.manager.destroy();
});
test('a third shared instance is included and late instance addition revokes the whole lease',async()=>{
  const f=fixture(),third=f.makeHost(7,f.original);assert.equal(await f.acquire(),true);assert.deepEqual(f.store.getExposures('root','7'),[]);assert.deepEqual(third.serialize().properties.previewExposures,f.original);
  f.makeHost(8);assert.equal(f.manager.allows(f.target),false);assert.deepEqual(f.store.getExposures('root','7'),f.original);f.manager.destroy();
});
test('view change while awaiting flush does not grant permission or leave temporary state',async()=>{
  const f=fixture();f.tick(()=>{f.app.canvas.graph=f.scope;});assert.equal(await f.acquire(),false);assert.deepEqual(f.store.getExposures('root','5'),f.original);assert.deepEqual(Object.getOwnPropertyDescriptor(f.a,'serialize'),f.descriptor);f.manager.destroy();
});
test('mapping invalidation restores surviving hosts without resurrecting removed host exposures',async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);f.root.nodes=f.root.nodes.filter(n=>n!==f.a);f.invalidate();assert.equal(f.manager.allows(f.target),false);assert.deepEqual(f.store.getExposures('root','5'),[]);assert.deepEqual(Object.getOwnPropertyDescriptor(f.a,'serialize'),f.descriptor);f.manager.destroy();
});
test('out of band native change is not overwritten by save or release',async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);const changed=[{name:'changed',sourceNodeId:'9',sourcePreviewName:'native'}];f.table.set('root:5',changed);
  assert.throws(()=>f.a.serialize(),/conflict/);assert.equal(f.manager.allows(f.target),false);assert.deepEqual(f.store.getExposures('root','5'),changed);f.manager.destroy();
});
test('failed restore retains a serializer projection instead of saving a temporary empty table',async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);f.breakAPI();assert.equal(f.manager.allows(f.target),false);assert.deepEqual(f.a.serialize().properties.previewExposures,f.original);f.manager.destroy();
});
test('repeated capture reuses the lease without dropping its original table',async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);const original=f.a.serialize;assert.equal(await f.acquire(),true);assert.equal(f.a.serialize,original);f.manager.reset();assert.deepEqual(f.store.getExposures('root','5'),f.original);f.manager.destroy();
});
test('removing exposure during the first renderer await cannot be overwritten or resurrected',async()=>{
  const f=fixture();let calls=0;f.tick(()=>{if(++calls===1)f.store.removeExposure('root','5','audioUI');});
  assert.equal(await f.acquire(),false);assert.deepEqual(f.store.getExposures('root','5'),[]);assert.deepEqual(Object.getOwnPropertyDescriptor(f.a,'serialize'),f.descriptor);
  f.manager.reset();assert.deepEqual(f.store.getExposures('root','5'),[]);f.manager.destroy();
});
test('reset during an in-flight acquisition prevents its late commit',async()=>{
  const f=fixture();let resume;f.tick(()=>new Promise(resolve=>{resume=resolve;}));const pending=f.acquire();
  f.manager.reset();resume();assert.equal(await pending,false);assert.equal(f.manager.allows(f.target),false);assert.deepEqual(f.store.getExposures('root','5'),f.original);f.manager.destroy();
});
test('changing root identity cannot copy old preview configuration into the new graph key',async()=>{
  const f=fixture();assert.equal(await f.acquire(),true);f.root.id='replacement';assert.equal(f.manager.allows(f.target),false);
  f.manager.reset();assert.deepEqual(f.store.getExposures('replacement','5'),[]);f.manager.destroy();
});
