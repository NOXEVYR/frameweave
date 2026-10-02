import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createNativeEditorMedia } from '../web/native-editor-media.mjs';
import { createEditorMediaPreview } from '../web/editor-media-preview.mjs';
import { createEditorSessionProjection } from '../web/editor-session-projection.mjs';

const bridge=(await readFile(new URL('../web/native-editor-bridge.js',import.meta.url),'utf8')).replace(/^import .*;$/gm,'')
  .replace("import('/prism-editor-media.mjs')",'Promise.resolve({createNativeEditorMedia:mediaFactory})')
  .replace("import('/prism-editor-media-preview.mjs')",'Promise.resolve({createEditorMediaPreview:previewFactory})');
const copy=value=>JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag){Object.assign(this,{tagName:tag,children:[],attributes:new Map(),listeners:new Map(),dataset:{},hidden:false,isConnected:true,operations:[]});
    const values=new Map(),priorities=new Map();this.style={setProperty:(k,v,p='')=>{values.set(k,v);priorities.set(k,p);},getPropertyValue:k=>values.get(k)||'',getPropertyPriority:k=>priorities.get(k)||''};}
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}} appendChild(item){this.append(item);return item;}
  replaceChildren(...items){for(const item of this.children)item.parentElement=null;this.children=[];this.append(...items);}
  setAttribute(k,v){this.attributes.set(k,String(v));} removeAttribute(k){this.attributes.delete(k);if(k==='src')this._src='';}
  addEventListener(k,v){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(v);} removeEventListener(k,v){this.listeners.get(k)?.delete(v);}
  emit(k){for(const callback of [...this.listeners.get(k)||[]])callback({target:this});}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(item=>item!==this);this.parentElement=null;}
  querySelectorAll(selector){return this.children.filter(item=>selector.split(',').includes(item.tagName.toLowerCase()));}
  pause(){this.operations.push('pause');} load(){this.operations.push('load');}
  set src(value){this._src=value;} get src(){return this._src||'';}
}
async function fixture({type='image',mask=false,shared=false,promoted=false,deep=false,navigation=false,exposures=[],exposureProof=true,noComparator=false,noCanvasHook=false}={}){
  const input=type==='video'?'file':type,classType=mask?'LoadImageMask':{image:'LoadImage',video:'LoadVideo',audio:'LoadAudio'}[type];
  const ext={image:'png',video:'mp4',audio:'wav'}[type],native=`native/N.${ext}`,connected=`refs/C.${ext}`;
  const resources=[],handlers=new Map(),replies=[],waiters=new Map(),frames=[];let implementation,preview,sequence=0,extension;
  const body=new Element('body'),document={body,querySelector:()=>null,addEventListener:(k,v)=>handlers.set(`doc:${k}`,v),removeEventListener:(k)=>handlers.delete(`doc:${k}`),
    createElement(tag){const item=new Element(tag);if(['img','video','audio'].includes(tag))resources.push(item);return item;}};
  class MediaNode {
    constructor(id=4){Object.assign(this,{id,type:classType,comfyClass:classType,mode:0,title:'唯一子图素材',inputs:[{name:input,widget:{name:input},link:null}],
      widgets:[{name:input,type:'combo',value:native,options:{values:[]}}],imgs:['native-presentation'],hideOutputImages:false});
      if(mask){this.inputs.push({name:'channel',widget:{name:'channel'},link:null});this.widgets.push({name:'channel',type:'combo',value:'alpha',options:{values:['alpha','red','green','blue']}});}
      if(type==='audio')this.widgets.push({name:'audioUI',element:new Element('AUDIO'),options:{serialize:false}});}
    addDOMWidget(name,_type,element){const widget={name,element,options:{serialize:false}};this.widgets.push(widget);return widget;}
    serialize(){return{id:this.id,type:this.type,mode:0,widgets_values:this.widgets.filter(widget=>widget.options?.serialize!==false).map(widget=>widget.value)};}
  }
  MediaNode.nodeData={input:{required:{[input]:[[],{[`${type}_upload`]:true}]}}};
  if(mask)MediaNode.nodeData.input.required.channel=[['alpha','red','green','blue'],{}];
  const leaf=new MediaNode(),other=new MediaNode(5);
  const scope=(id,nodes)=>({id,_nodes:nodes,links:new Map(),getNodeById(id){return this._nodes.find(item=>String(item.id)===String(id));},getLink(id){return this.links.get(id);},
    beforeChange(){},afterChange(){this.onAfterChange?.(this);},change(){}});
  const inside=scope('child-definition',[leaf,other]);leaf.graph=other.graph=inside;
  const host=(id,subgraph)=>({id,type:subgraph.id,mode:0,subgraph,inputs:[],widgets:[],properties:{},isSubgraphNode:()=>true,
    serialize(){return{id:this.id,type:this.type,mode:0,widgets_values:this.widgets.map(widget=>widget.value),properties:exposureProof?{previewExposures:copy(exposures)}:{}};}});
  const middle=deep?host(2,inside):null,outerScope=deep?scope('middle-definition',[middle]):inside;
  if(middle)middle.graph=outerScope;
  const first=host(6,outerScope),second=host(7,outerScope),root=scope('root',shared?[first,second]:[first]);first.graph=second.graph=root;
  if(promoted){leaf.inputs[0].link=1;inside.links.set(1,{originIsIoNode:true,origin_slot:0,origin_id:-10,target_id:4,target_slot:0});
    for(const item of [first,second]) {
      item.inputs=[{name:'instance-media',widget:{name:'instance-media'},link:null}];
      item.widgets=[{name:'instance-media',type:'combo',value:item===first?native:`native/B.${ext}`,options:{values:[]}}];
    }}
  const serializeScope=value=>({id:value.id,nodes:value._nodes.map(node=>node.serialize()),links:[]});
  root.serialize=()=>({nodes:root._nodes.map(node=>node.serialize()),links:[],definitions:{subgraphs:[serializeScope(inside),...(deep?[serializeScope(outerScope)]:[])]}});
  const nodeId=deep?'6:2:4':'6:4';
  const canvas={graph:root,selected_nodes:{},canvas:{isConnected:true},setGraph(next){this.selected_nodes={};this.graph=next;return 'native-setGraph-result';},setDirty(){}};
  if(navigation){
    canvas.canvas.dispatchEvent=event=>{handlers.get(`doc:${event.type}`)?.({...event,target:canvas.canvas});return true;};
    canvas.openSubgraph=function(subgraph,fromNode){const detail={subgraph,closingGraph:this.graph,fromNode};
      if(this.canvas.dispatchEvent({type:'subgraph-opening',detail})){
        this.setGraph(subgraph);this.canvas.dispatchEvent({type:'subgraph-opened',detail});
      }
    };
  }
  if(noCanvasHook)delete canvas.setGraph;
  const app={graph:root,rootGraphOrUndefined:root,canvas,canvasOrUndefined:canvas,registerExtension(value){extension=value;},
    async graphToPrompt(){return{workflow:root.serialize(),output:Object.fromEntries(root._nodes.flatMap(node=>inside._nodes.map(child=>[`${node.id}:${deep?'2:':''}${child.id}`,{class_type:classType,inputs:{[input]:promoted&&child===leaf?node.widgets[0].value:child.widgets[0].value,...(mask?{channel:child.widgets[1].value}:{})}}])))};},
    async loadGraphData(value){const saved=value.definitions.subgraphs.find(item=>item.id===inside.id);for(const child of inside._nodes){const values=saved.nodes.find(item=>item.id===child.id).widgets_values;child.widgets.filter(widget=>widget.options?.serialize!==false).forEach((widget,index)=>{widget.value=values[index];});child.onAdded?.(inside);}}};
  const parent={postMessage(message){const reply=copy(message);replies.push(reply);const waiter=waiters.get(reply.requestId);if(waiter){waiters.delete(reply.requestId);waiter(reply);}}};
  const timers=[],window={parent,app,__PRISM_EDITOR__:{parentOrigin:'http://127.0.0.1:8874',bridgeNonce:'nested-media',backendUrl:'http://127.0.0.1:8188',mediaProtocol:1},
    LiteGraph:{registered_node_types:{[classType]:MediaNode}},crypto:webcrypto,addEventListener:(k,v)=>handlers.set(k,v),removeEventListener:k=>handlers.delete(k),
    requestAnimationFrame:callback=>frames.push(callback),setTimeout:callback=>timers.push(callback)};
  vm.runInNewContext(bridge,{app,window,document,TextEncoder,setTimeout,
    mediaFactory(args){if(noComparator)delete args.sameMappingProof;return implementation=createNativeEditorMedia(args);},
    previewFactory(args){return preview=createEditorMediaPreview(args);}});
  extension.setup();while(timers.length)timers.shift()();
  for(let i=0;i<20&&!replies.some(item=>item.action==='ready');i++)await new Promise(setImmediate);
  const request=async(action,args={})=>{const requestId=`nested-${++sequence}`,promise=new Promise(resolve=>waiters.set(requestId,resolve));
    handlers.get('message')({source:parent,origin:window.__PRISM_EDITOR__.parentOrigin,data:{source:'prism-parent',nonce:'nested-media',requestId,action,...copy(args)}});return promise;};
  assert.equal((await request('load',{document:root.serialize()})).error,undefined);
  const binding={field_id:'reference',node_id:nodeId,input,class_type:classType,type,value:connected,media_owner:{name:connected,media_type:type,backend:window.__PRISM_EDITOR__.backendUrl}};
  const capture=()=>request('captureMedia',{bindings:[binding]});
  const select=(node=leaf)=>{canvas.setGraph(inside);canvas.selected_nodes={[node.id]:node};canvas.onSelectionChange?.(canvas.selected_nodes);implementation.refreshPreview();};
  const selectOnly=node=>{canvas.selected_nodes={[node.id]:node};canvas.onSelectionChange?.(canvas.selected_nodes);implementation.refreshPreview();};
  const enter=host=>{canvas.setGraph(root);canvas.openSubgraph(host.subgraph,host);selectOnly(leaf);};
  return {type,input,classType,native,connected,nodeId,binding,request,capture,select,selectOnly,enter,app,canvas,root,inside,outerScope,first,second,middle,leaf,other,exposures,MediaNode,resources,frames,handlers,replies,
    media:()=>implementation,preview:()=>preview,currentMedia:()=>resources.at(-1)};
}

for(const type of ['image','video','audio'])test(`unique nested ${type}: isolate only captured leaf, C/N roundtrip uses real bridge and active child preview`,async()=>{
  const h=await fixture({type}),before=copy(h.root.serialize());await h.request('compile');
  assert.deepEqual(h.leaf.imgs,['native-presentation']);assert.deepEqual(h.other.imgs,['native-presentation']);
  const reply=await h.capture();assert.equal(reply.error,undefined);assert.equal(reply.result.captured.length,1);
  assert.deepEqual(h.root.serialize(),before);assert.equal(h.leaf.imgs,undefined);assert.deepEqual(h.other.imgs,['native-presentation']);
  assert.equal(h.preview().getState().status,'empty');h.select();assert.equal(h.preview().getState().filename,h.native);
  const receipt=reply.result.captured[0].receipt;
  for(const value of [h.connected,h.native,h.connected]){
    const response=await h.request('patch',{patches:[{node_id:h.nodeId,widget_name:h.input,class_type:h.classType,media_receipt:receipt,value,expected_value:h.leaf.widgets[0].value}]});
    assert.equal(response.error,undefined);assert.equal(h.preview().getState().filename,value);
    assert.match(h.preview().getState().identity,new RegExp(`^${h.nodeId}:`));
  }
  const late=h.currentMedia(),callback=[...late.listeners.get(type==='image'?'load':type==='video'?'loadeddata':'loadedmetadata')][0];
  assert.equal(h.canvas.setGraph(h.root),'native-setGraph-result');assert.equal(h.preview().getState().status,'empty');callback();
  assert.equal(h.preview().getState().status,'empty');assert.equal(late.src,'');
  h.media().destroy();
});

test('deep unique nested media uses the entire instance path and requires every host exposure store to be empty',async()=>{
  const h=await fixture({deep:true});const response=await h.capture();assert.equal(response.result.captured.length,1);
  h.select();assert.match(h.preview().getState().identity,/^6:2:4:/);
  h.exposures.push({name:'preview',sourceNodeId:'4',sourcePreviewName:'image'});h.root.onAfterChange();
  assert.equal(h.preview().getState().status,'empty');assert.deepEqual(h.leaf.imgs,['native-presentation']);
  const again=await h.capture();assert.equal(again.result.unsupported[0].reason,'promoted_preview_not_isolated');
});

for(const options of [{shared:true},{promoted:true},{exposures:[{name:'any'}]},{exposureProof:false},{noComparator:true},{noCanvasHook:true}])test(`unproven child preview ${JSON.stringify(options)} keeps native surfaces and receives no receipt`,async()=>{
  const h=await fixture(options),before=copy(h.root.serialize()),images=h.leaf.imgs;
  const response=await h.capture();assert.equal(response.result.captured.length,0);assert.ok(response.result.unsupported[0].reason);
  assert.equal(h.leaf.imgs,images);assert.deepEqual(h.root.serialize(),before);
});

for(const change of ['host-remove','host-replace','becomes-shared','scope-replace','widget-replace','slot-replace'])test(`nested ${change} revokes capture and restores presentation without changing filenames`,async()=>{
  const h=await fixture(),receipt=(await h.capture()).result.captured[0].receipt;h.select();h.leaf.imgs=['late-native'];
  if(change==='host-remove')h.root._nodes=[];
  if(change==='host-replace')h.root._nodes[0]={...h.first};
  if(change==='becomes-shared')h.root._nodes.push(h.second);
  if(change==='scope-replace')h.first.subgraph={...h.inside};
  if(change==='widget-replace')h.leaf.widgets[0]={...h.leaf.widgets[0]};
  if(change==='slot-replace')h.leaf.inputs[0]={...h.leaf.inputs[0]};
  h.root.onAfterChange();assert.equal(h.preview().getState().status,'empty');assert.deepEqual(h.leaf.imgs,['late-native']);
  assert.equal(h.leaf.widgets[0].value,h.native);
  const denied=await h.request('patch',{patches:[{node_id:h.nodeId,widget_name:h.input,class_type:h.classType,media_receipt:receipt,value:h.connected}]});
  assert.ok(denied.error);assert.equal(h.leaf.widgets[0].value,h.native);
});

test('child removal and same-object readd retire old receipt and guard late native callbacks until the new onAdded',async()=>{
  const h=await fixture(),old=(await h.capture()).result.captured[0].receipt;h.select();h.leaf.onRemoved?.();h.inside._nodes=h.inside._nodes.filter(node=>node!==h.leaf);
  h.leaf.imgs=['late-removed'];assert.equal(h.leaf.imgs,undefined);assert.equal(h.preview().getState().status,'empty');
  h.inside._nodes.push(h.leaf);h.leaf.onAdded(h.inside);assert.deepEqual(h.leaf.imgs,['late-removed']);
  const next=(await h.capture()).result.captured[0];assert.ok(next);assert.notEqual(next.receipt,old);
  const denied=await h.request('patch',{patches:[{node_id:h.nodeId,widget_name:h.input,class_type:h.classType,media_receipt:old,value:h.connected}]});assert.ok(denied.error);
});

test('a decoder finishing after a direct scope replacement cannot display its old selected node',async()=>{
  const h=await fixture();await h.capture();h.select();const old=h.currentMedia(),late=[...old.listeners.get('load')][0];
  h.canvas.graph=h.root;late();assert.equal(h.preview().getState().status,'empty');assert.equal(old.src,'');
});

test('a late decoder cannot mark old N ready after the current widget already changed to I',async()=>{
  const h=await fixture();await h.capture();h.select();const old=h.currentMedia(),late=[...old.listeners.get('load')][0];
  h.leaf.widgets[0].value='picked/I.png';late();assert.equal(h.preview().getState().status,'empty');assert.equal(old.src,'');
  h.media().refreshPreview();assert.equal(h.preview().getState().filename,'picked/I.png');
});

test('a host serializer cannot replace the instance during exposure verification and silently authorize its replacement',async()=>{
  const h=await fixture(),original=h.first.serialize;let count=0;
  h.first.serialize=function(){const result=original.call(this);if(++count===2)h.root._nodes[0]={...h.first};return result;};
  const reply=await h.capture();assert.ok(reply.error||reply.result.captured.length===0);assert.deepEqual(h.leaf.imgs,['native-presentation']);
});

test('a captured C becoming shared stays quarantined against late native image and DOM writes until re-entry',async()=>{
  const h=await fixture(),receipt=(await h.capture()).result.captured[0].receipt;h.select();
  const patch={node_id:h.nodeId,widget_name:h.input,class_type:h.classType,media_receipt:receipt,value:h.connected};
  assert.equal((await h.request('patch',{patches:[patch]})).error,undefined);
  h.root._nodes.push(h.second);h.root.onNodeAdded(h.second);
  assert.equal(h.preview().getState().status,'empty');assert.equal(h.leaf.widgets[0].value,h.connected);
  h.leaf.imgs=['late-C'];assert.equal(h.leaf.imgs,undefined);assert.equal(h.leaf.hideOutputImages,true);
  const surface=new Element('VIDEO');h.leaf.addDOMWidget('video-preview','video',surface);assert.equal(surface.hidden,true);
  assert.ok((await h.request('patch',{patches:[{...patch,value:h.native}]})).error);
  h.root._nodes.pop();h.root.onNodeRemoved(h.second);
  const recapture=await h.capture();assert.equal(recapture.result.captured.length,0);
  assert.equal(recapture.result.unsupported[0].reason,'nested_preview_context_changed');assert.equal(h.leaf.imgs,undefined);
  assert.equal(h.leaf.widgets[0].value,h.connected);
});

function projection(h,{sameValue=false}={}){
  const calls=[],binding=copy(h.binding);if(sameValue){binding.value=h.native;binding.media_owner.name=h.native;}
  const request=async(action,args={})=>{calls.push({action,args:copy(args)});const reply=await h.request(action,args);
    if(reply.error)throw new Error(reply.error);return reply.result;};
  const session=createEditorSessionProjection({request,assertCurrent(){},mappingCapture:true,mediaNestedCapture:true,
    provenance:[{...binding,origin:'connected',stored_fallback:'fallback/F.png',baseline:'baseline/B.png'}]});
  return{session,calls};
}

for(const type of ['image','video','audio'])test(`real nested ${type} media and mapping capture cooperate with projection cleanup/save/redisplay`,async()=>{
  const h=await fixture({type}),{session,calls}=projection(h);h.select();
  const initialized=await session.initialize();assert.equal(initialized.unmapped.length,0);assert.equal(initialized.applied.length,1);
  const entry=initialized.applied[0];assert.ok(entry.media_receipt);assert.ok(entry.mapping_receipt);
  assert.ok(calls.findIndex(item=>item.action==='captureMedia')<calls.findIndex(item=>item.action==='captureMappings'));
  assert.equal(h.leaf.widgets[0].value,h.connected);assert.equal(h.preview().getState().filename,h.connected);
  let saved;const result=await session.prepare(value=>{saved=value;
    assert.equal(h.leaf.widgets[0].value,h.native);assert.equal(h.preview().getState().filename,h.native);return{revision:2};});
  assert.equal(result.persisted,true);assert.equal(saved.output[h.nodeId].inputs[h.input],h.native);
  assert.equal(saved.workflow.definitions.subgraphs[0].nodes[0].widgets_values[0],h.native);
  assert.equal(JSON.stringify(saved).includes('mapping_receipt'),false);assert.equal(JSON.stringify(saved).includes('media_receipt'),false);
  assert.equal(h.leaf.widgets[0].value,h.connected);assert.equal(h.preview().getState().filename,h.connected);
  const afterMapping=calls.slice(calls.findIndex(item=>item.action==='captureMappings')+1);
  for(const call of afterMapping.filter(item=>['compile','snapshot','patch'].includes(item.action)))assert.equal(call.args.mapping_receipts[0].receipt,entry.mapping_receipt);
  for(const call of calls.filter(item=>item.action==='patch'))assert.equal(call.args.patches[0].media_receipt,entry.media_receipt);
  assert.equal(calls.some(item=>/generate|prompt|queue|upload/i.test(item.action)),false);
});

test('zero-change nested media save still requires fresh mapping proof and never persists either capability',async()=>{
  const h=await fixture(),{session,calls}=projection(h,{sameValue:true});await session.initialize();
  let stored=0;await session.prepare(value=>{stored++;assert.equal(JSON.stringify(value).includes('_receipt'),false);return true;});
  assert.equal(stored,1);assert.equal(calls.some(item=>item.action==='patch'),false);
  const index=calls.findIndex(item=>item.action==='captureMappings');
  assert.ok(calls.slice(index+1).filter(item=>['compile','snapshot'].includes(item.action)).every(item=>item.args.mapping_receipts?.length===1));
  h.leaf.inputs[0]={...h.leaf.inputs[0]};await assert.rejects(session.prepare(()=>{stored++;}));assert.equal(stored,1);
  assert.equal(h.leaf.widgets[0].value,h.native);
});

test('LoadImageMask image and channel share fresh post-isolation mapping capture without cross-input fanout',async()=>{
  const h=await fixture({mask:true}),calls=[];
  const request=async(action,args={})=>{calls.push({action,args:copy(args)});const reply=await h.request(action,args);
    if(reply.error)throw new Error(reply.error);return reply.result;};
  const session=createEditorSessionProjection({request,assertCurrent(){},mappingCapture:true,mediaNestedCapture:true,
    provenance:[{...h.binding,origin:'connected'},
      {field_id:'mask_channel',node_id:h.nodeId,input:'channel',class_type:'LoadImageMask',type:'select',origin:'connected',value:'red'}]});
  h.select();const initialized=await session.initialize();assert.equal(initialized.unmapped.length,0);assert.equal(initialized.applied.length,2);
  const captures=calls.filter(item=>item.action==='captureMappings');assert.equal(captures.length,1);
  assert.deepEqual(captures[0].args.bindings.map(item=>item.input).sort(),['channel','image']);
  assert.ok(calls.findIndex(item=>item.action==='captureMedia')<calls.findIndex(item=>item.action==='captureMappings'));
  assert.equal(new Set(initialized.applied.map(item=>item.mapping_receipt)).size,2);
  assert.ok(initialized.applied.find(item=>item.input==='image').media_receipt);
  assert.equal(initialized.applied.find(item=>item.input==='channel').media_receipt,undefined);
  assert.deepEqual(h.leaf.widgets.map(widget=>widget.value),[h.connected,'red']);assert.equal(h.preview().getState().filename,h.connected);
  let stored;await session.prepare(value=>{stored=value;assert.deepEqual(h.leaf.widgets.map(widget=>widget.value),[h.native,'alpha']);return true;});
  assert.deepEqual(stored.output[h.nodeId].inputs,{image:h.native,channel:'alpha'});
  assert.deepEqual(stored.workflow.definitions.subgraphs[0].nodes[0].widgets_values,[h.native,'alpha']);
  assert.deepEqual(stored.output['6:5'].inputs,{image:h.native,channel:'alpha'});
  assert.equal(JSON.stringify(stored).includes('_receipt'),false);
  assert.deepEqual(h.leaf.widgets.map(widget=>widget.value),[h.connected,'red']);assert.equal(h.preview().getState().filename,h.connected);
  const patches=calls.filter(item=>item.action==='patch');assert.equal(patches.length,3);
  for(const item of patches){assert.equal(item.args.mapping_receipts.length,2);assert.equal(item.args.patches.length,2);
    assert.ok(item.args.patches.find(patch=>patch.widget_name==='image').media_receipt);
    assert.equal(item.args.patches.find(patch=>patch.widget_name==='channel').media_receipt,undefined);}
});

test('nested C context invalidation blocks projection persistence and quarantines late media instead of restoring to a new host',async()=>{
  const h=await fixture(),{session}=projection(h);h.select();await session.initialize();
  h.root._nodes.push(h.second);h.root.onNodeAdded(h.second);let stored=0;
  await assert.rejects(session.prepare(()=>{stored++;return true;}));assert.equal(stored,0);
  h.leaf.imgs=['late-connected'];assert.equal(h.leaf.imgs,undefined);assert.equal(h.preview().getState().status,'empty');
  assert.equal(h.leaf.widgets[0].value,h.connected);
  h.root._nodes.pop();h.root.onNodeRemoved(h.second);await assert.rejects(session.prepare(()=>{stored++;return true;}));assert.equal(stored,0);
});

test('nested selection requires actual selected object, and destroy restores native canvas and scope hook descriptors',async()=>{
  const h=await fixture();await h.capture();h.select();
  h.canvas.selected_nodes={4:{...h.leaf}};h.canvas.onSelectionChange();assert.equal(h.preview().getState().status,'empty');
  h.select();h.canvas.selected_nodes[5]=h.other;h.canvas.onSelectionChange();assert.equal(h.preview().getState().status,'empty');
  h.media().destroy();assert.equal(Object.hasOwn(h.root,'onAfterChange'),false);assert.equal(Object.hasOwn(h.inside,'onNodeAdded'),false);
  assert.equal(Object.hasOwn(h.canvas,'onSelectionChange'),false);assert.equal(h.canvas.setGraph(h.root),'native-setGraph-result');
});

function secondBinding(h) {
  const value=h.connected.replace('/C.','/D.');
  return {...h.binding,field_id:'second-reference',node_id:'7:4',value,media_owner:{...h.binding.media_owner,name:value}};
}

for(const type of ['image','video','audio'])test(`shared promoted ${type}: actual bridge patches instance owners and previews the proven host path`,async()=>{
  const h=await fixture({type,shared:true,promoted:true,navigation:true}),before=copy(h.root.serialize()),b=secondBinding(h);
  const captured=await h.request('captureMedia',{bindings:[h.binding,b]});assert.equal(captured.error,undefined);
  assert.equal(captured.result.captured.length,2);assert.deepEqual(h.root.serialize(),before);
  const patch=(binding,index)=>({node_id:binding.node_id,widget_name:binding.input,class_type:binding.class_type,
    media_receipt:captured.result.captured[index].receipt,value:binding.value});
  assert.equal((await h.request('patch',{patches:[patch(h.binding,0),patch(b,1)]})).error,undefined);
  assert.equal(h.first.widgets[0].value,h.connected);assert.equal(h.second.widgets[0].value,b.value);
  assert.equal(h.leaf.widgets[0].value,h.native);assert.equal(h.leaf.imgs,undefined);
  for(const [host,binding]of [[h.first,h.binding],[h.second,b],[h.first,h.binding]]){
    h.canvas.setGraph(h.root);h.selectOnly(host);assert.equal(h.preview().getState().filename,binding.value);
    h.canvas.openSubgraph(h.inside,host);h.selectOnly(h.leaf);
    assert.equal(h.preview().getState().filename,binding.value);assert.ok(h.preview().getState().identity.startsWith(binding.node_id+':'));
  }
  const output=(await h.request('compile')).result.output;
  assert.equal(output[h.nodeId].inputs[h.input],h.connected);assert.equal(output[b.node_id].inputs[h.input],b.value);
  assert.equal(h.leaf.widgets[0].value,h.native);
});

test('shared promoted media requires exact opening host; direct definition navigation or unrelated events cannot borrow the last instance',async()=>{
  const h=await fixture({shared:true,promoted:true,navigation:true});await h.capture();h.enter(h.first);
  assert.equal(h.preview().getState().filename,h.native);
  h.canvas.setGraph(h.root);h.canvas.setGraph(h.inside);h.selectOnly(h.leaf);
  assert.equal(h.preview().getState().status,'empty');
  assert.match(h.preview().getState().message,/从具体实例进入/);
  h.canvas.canvas.dispatchEvent({type:'subgraph-opened',detail:{subgraph:h.inside,closingGraph:h.root,fromNode:h.first}});
  assert.equal(h.preview().getState().status,'empty');
  h.canvas.setGraph(h.root);h.canvas.openSubgraph(h.inside,{...h.first});h.selectOnly(h.leaf);
  assert.equal(h.preview().getState().status,'empty');
  h.enter(h.first);assert.equal(h.preview().getState().filename,h.native);
});

test('shared promoted media ignores late A decoder after selection changes to B and after widget changes',async()=>{
  const h=await fixture({shared:true,promoted:true,navigation:true}),b=secondBinding(h);
  await h.request('captureMedia',{bindings:[h.binding,b]});h.enter(h.first);
  const old=h.currentMedia(),late=[...old.listeners.get('load')][0];
  h.enter(h.second);const identity=h.preview().getState().identity;late();
  assert.equal(h.preview().getState().identity,identity);assert.equal(h.preview().getState().filename,h.second.widgets[0].value);
  assert.equal(old.src,'');
  const next=[...h.currentMedia().listeners.get('load')][0];h.second.widgets[0].value='native/changed.png';next();
  assert.equal(h.preview().getState().status,'empty');assert.equal(h.leaf.widgets[0].value,h.native);
});

for(const change of ['host-remove','widget-replace','slot-replace','preview-exposure'])test(`shared promoted ${change} revokes old receipts and preserves graph data`,async()=>{
  const h=await fixture({shared:true,promoted:true,navigation:true}),b=secondBinding(h);
  const captures=(await h.request('captureMedia',{bindings:[h.binding,b]})).result.captured;h.enter(h.first);
  if(change==='host-remove')h.root._nodes=h.root._nodes.filter(node=>node!==h.first);
  if(change==='widget-replace')h.first.widgets[0]={...h.first.widgets[0]};
  if(change==='slot-replace')h.first.inputs[0]={...h.first.inputs[0]};
  if(change==='preview-exposure')h.exposures.push({sourceNodeId:'4'});
  h.root.onAfterChange();assert.equal(h.preview().getState().status,'empty');
  const patch={node_id:h.nodeId,widget_name:h.input,class_type:h.classType,media_receipt:captures[0].receipt,value:h.connected};
  assert.ok((await h.request('patch',{patches:[patch]})).error);
  assert.equal(h.leaf.widgets[0].value,h.native);assert.equal(h.first.widgets[0].value,h.native);
  const captureB=(await h.request('captureMedia',{bindings:[b]})).result;
  if(change==='preview-exposure')assert.equal(captureB.captured.length,0);
  else{assert.equal(captureB.captured.length,1);h.enter(h.second);assert.equal(h.preview().getState().filename,h.second.widgets[0].value);}
});

for(const type of ['image','video','audio'])test(`shared promoted ${type} projection cleans both instance overlays for persistence then restores display`,async()=>{
  const h=await fixture({type,shared:true,promoted:true,navigation:true}),b=secondBinding(h),calls=[];
  const originalB=h.second.widgets[0].value;
  const request=async(action,args={})=>{calls.push(action);const reply=await h.request(action,args);if(reply.error)throw new Error(reply.error);return reply.result;};
  const session=createEditorSessionProjection({request,assertCurrent(){},mappingCapture:true,mediaNestedCapture:true,
    provenance:[h.binding,b].map(item=>({...item,origin:'connected'}))});
  const initialized=await session.initialize();assert.equal(initialized.unmapped.length,0);assert.equal(initialized.applied.length,2);
  h.enter(h.second);assert.equal(h.preview().getState().filename,b.value);assert.equal(h.leaf.widgets[0].value,h.native);
  let saved;await session.prepare(value=>{saved=value;assert.equal(h.first.widgets[0].value,h.native);
    assert.equal(h.second.widgets[0].value,originalB);assert.equal(h.preview().getState().filename,originalB);return true;});
  assert.equal(saved.output[h.nodeId].inputs[h.input],h.native);assert.equal(saved.output[b.node_id].inputs[h.input],originalB);
  assert.equal(saved.workflow.nodes[0].widgets_values[0],h.native);assert.equal(saved.workflow.nodes[1].widgets_values[0],originalB);
  assert.equal(saved.workflow.definitions.subgraphs[0].nodes[0].widgets_values[0],h.native);
  assert.equal(JSON.stringify(saved).includes('_receipt'),false);
  assert.equal(JSON.stringify({workflow:saved.workflow,output:saved.output}).includes('refs/'),false);
  assert.equal(h.first.widgets[0].value,h.connected);assert.equal(h.second.widgets[0].value,b.value);
  assert.equal(h.preview().getState().filename,b.value);assert.equal(h.leaf.widgets[0].value,h.native);
  assert.equal(calls.some(action=>/generate|prompt|queue|upload/i.test(action)),false);
});

test('official view notification replacement preserves receipts after fresh binding proof and restores the latest callbacks',async()=>{
  const h=await fixture({shared:true,promoted:true,navigation:true}),b=secondBinding(h);
  const captures=(await h.request('captureMedia',{bindings:[h.binding,b]})).result.captured;h.enter(h.first);
  let added=0,removed=0;const onAdded=function(node){assert.equal(this,h.root);assert.equal(node,h.other);added++;return 'added';};
  const onRemoved=function(node){assert.equal(this,h.root);assert.equal(node,h.other);removed++;return 'removed';};
  h.root.onNodeAdded=onAdded;h.root.onNodeRemoved=onRemoved;
  h.media().refreshPreview();assert.equal(h.preview().getState().filename,h.native);assert.equal(h.leaf.imgs,undefined);
  assert.equal(h.root.onNodeAdded(h.other),'added');assert.equal(h.root.onNodeRemoved(h.other),'removed');assert.equal(added,1);assert.equal(removed,1);
  const patch={node_id:b.node_id,widget_name:b.input,class_type:b.class_type,media_receipt:captures[1].receipt,value:b.value};
  assert.equal((await h.request('patch',{patches:[patch]})).error,undefined);
  h.enter(h.second);assert.equal(h.preview().getState().filename,b.value);
  h.media().destroy();assert.equal(h.root.onNodeAdded,onAdded);assert.equal(h.root.onNodeRemoved,onRemoved);
});

for(const invalid of ['structure','readonly-callback','change-callback'])test(`notification renewal never conceals ${invalid} invalidation`,async()=>{
  const h=await fixture({shared:true,promoted:true,navigation:true});await h.capture();h.enter(h.first);
  if(invalid==='structure'){h.root.onNodeAdded=()=>{};h.first.widgets[0]={...h.first.widgets[0]};}
  if(invalid==='readonly-callback')Object.defineProperty(h.root,'onNodeAdded',{value:()=>{},configurable:false});
  if(invalid==='change-callback')h.root.onAfterChange=()=>{};
  h.media().refreshPreview();assert.equal(h.preview().getState().status,'empty');
  const current=(await h.request('compile')).result;assert.ok(current.controls.every(item=>!item.media_receipt));
  assert.equal(h.leaf.widgets[0].value,h.native);
});
