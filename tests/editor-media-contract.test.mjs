import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createEditorSessionProjection } from '../web/editor-session-projection.mjs';
import { createNativeEditorMedia } from '../web/native-editor-media.mjs';
import { createEditorMediaPreview } from '../web/editor-media-preview.mjs';

// Real bridge receive/handle/capture/patchWidgets are used. Only the official
// frontend's graph serialization and compilation are supplied as fixtures.
const bridge = (await readFile(new URL('../web/native-editor-bridge.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '')
  // Module resolution is the VM boundary; bootstrap/receipt logic remains real.
  .replace("import('/prism-editor-media.mjs')", 'Promise.resolve({createNativeEditorMedia})')
  .replace("import('/prism-editor-media-preview.mjs')", 'Promise.resolve({createEditorMediaPreview})');
const copy = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor(tag) {
    Object.assign(this, { tagName: tag, children: [], attributes: new Map(), listeners: new Map(), dataset: {}, textContent: '', hidden: false, open: false, isConnected: true, operations: [] });
    const values = new Map(), priorities = new Map();
    this.style = { setProperty: (name,value,priority='') => { values.set(name,value); priorities.set(name,priority); }, getPropertyValue: name=>values.get(name)||'', getPropertyPriority: name=>priorities.get(name)||'' };
  }
  append(...items) { for(const item of items){item.parentElement=this;this.children.push(item);} }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children=[]; this.append(...items); }
  setAttribute(name,value) { this.attributes.set(name,String(value)); }
  removeAttribute(name) { this.attributes.delete(name); if(name==='src') this._src=''; this.operations.push(`remove:${name}`); }
  addEventListener(name,fn) { if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn); }
  removeEventListener(name,fn) { this.listeners.get(name)?.delete(fn); }
  emit(name,event={}) { for(const fn of [...(this.listeners.get(name)||[])])fn({target:this,...event}); }
  remove() { if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(item=>item!==this);this.parentElement=null; }
  querySelectorAll(selector) { const tags=selector.split(',').map(value=>value.trim().toLowerCase());return descendants(this).slice(1).filter(item=>tags.includes(item.tagName.toLowerCase())); }
  set src(value) { this._src=value;this.operations.push(`src:${value}`); }
  get src() { return this._src||''; }
}
const descendants=root=>[root,...root.children.flatMap(descendants)];

async function fixture({ type='image', native='draft/N.png', connected='refs/C.png', options=['listed.png'], unknown=false }={}) {
  const input=type, classType={image:'LoadImage',video:'LoadVideo',audio:'LoadAudio'}[type], body=new Element('body'), resources=[], previewStates=[], replies=[], calls=[], saves=[], waiters=new Map(), handlers=new Map(), timers=[];
  let preview, extension, serial=0, guarded=true;
  const hooks={};
  const document={body,querySelector:()=>null,addEventListener(name,fn){handlers.set(`document:${name}`,fn);},createElement(tag){const item=new Element(tag);if(['img','video','audio'].includes(tag)){resources.push(item);if(tag!=='img'){item.pause=()=>item.operations.push('pause');item.load=()=>item.operations.push('load');item.play=()=>item.operations.push('play');}}return item;}};
  class MediaNode {
    constructor(id,value){this.id=id;this.type=this.comfyClass=classType;this.title='角色参考';this.inputs=[{name:input,link:null}];this.widgets=[{name:input,type:'combo',value,options:{values:[...options]}}];
      if(type==='audio'){const surface=new Element('audio');surface.tagName='AUDIO';surface.pause=()=>surface.operations.push('pause');surface.autoplay=true;this.widgets.push({name:'audioUI',type:'dom',value:'',element:surface,options:{serialize:false}});}
      this.imgs=['native-runtime-preview'];this.onNodeCreated?.();}
  }
  MediaNode.nodeData={input:{required:{[input]:[[...options],{[`${type}_upload`]:true}]}}};
  class TextNode {
    constructor(){this.id=2;this.type=this.comfyClass='TextNode';this.title='Sibling';this.inputs=[{name:'text',link:null}];this.widgets=[{name:'text',type:'text',value:'UNCHANGED',options:{}}];}
  }
  TextNode.nodeData={input:{required:{text:['STRING',{}]}}};
  const registry={[classType]:unknown?class OtherConstructor{}:MediaNode,TextNode};
  const graph={_nodes:[new MediaNode(1,native),new TextNode()],links:{},getNodeById(id){return this._nodes.find(node=>String(node.id)===String(id));},
    serialize(){return{version:0.4,nodes:this._nodes.map(node=>({id:node.id,type:node.type,title:node.title,mode:0,widgets_values:node.widgets.filter(widget=>widget.options?.serialize!==false).map(widget=>widget.value)})),links:[],extra:{retained:'whole native metadata'}};},beforeChange(){},afterChange(){},change(){}};
  for(const node of graph._nodes){node.graph=graph;node.onAdded?.(graph);}
  const canvas={graph,canvas:{isConnected:true},selected_nodes:{1:graph.getNodeById(1)},setDirty(){}};
  const app={graph,rootGraphOrUndefined:graph,canvas,canvasOrUndefined:canvas,registerExtension(value){extension=value;},
    async graphToPrompt(){return{workflow:graph.serialize(),output:Object.fromEntries(graph._nodes.map(node=>[String(node.id),{class_type:node.type,inputs:Object.fromEntries(node.widgets.filter(widget=>widget.options?.serialize!==false).map(widget=>[widget.name,widget.value])),_meta:{title:node.title}}]))};},
    async loadGraphData(value){graph._nodes=value.nodes.map(node=>{const next=node.type===classType?new MediaNode(node.id,node.widgets_values[0]):new TextNode();next.widgets[0].value=node.widgets_values[0];next.title=node.title;return next;});for(const node of graph._nodes){node.graph=graph;node.onAdded?.(graph);}canvas.selected_nodes={1:graph.getNodeById(1)};hooks.afterLoad?.();}};
  const parent={postMessage(message,origin){const reply=copy(message);replies.push({message:reply,origin});const waiter=waiters.get(reply.requestId);if(waiter){waiters.delete(reply.requestId);reply.error?waiter.reject(Object.assign(Error(reply.error),{result:reply.result})):waiter.resolve(reply.result);}}};
  const window={app,parent,graph,__PRISM_EDITOR__:{parentOrigin:'http://127.0.0.1:8766',bridgeNonce:'contract-nonce',backendUrl:'http://127.0.0.1:8188',mediaProtocol:1},LiteGraph:{registered_node_types:registry},crypto:webcrypto,
    addEventListener(name,fn){handlers.set(name,fn);},setTimeout(fn){timers.push(fn);},requestAnimationFrame(fn){fn();}};
  vm.runInNewContext(bridge,{app,window,document,TextEncoder,createNativeEditorMedia,createEditorMediaPreview(args){preview=createEditorMediaPreview({...args,onState:state=>previewStates.push(copy(state))});return preview;}});
  extension.setup();while(timers.length)timers.shift()();
  for(let attempt=0;attempt<10&&!replies.some(reply=>reply.message.action==='ready');attempt++)await new Promise(resolve=>setImmediate(resolve));
  assert(replies.some(reply=>reply.message.action==='ready'));
  assert.equal(replies.find(reply=>reply.message.action==='ready').message.capabilities.media_capture,1);
  const request=async(action,args={})=>{
    calls.push({action,args:copy(args)});await hooks.before?.(action,args);
    const requestId=`contract-${++serial}`;
    const waiting=new Promise((resolve,reject)=>waiters.set(requestId,{resolve,reject}));
    handlers.get('message')({source:parent,origin:window.__PRISM_EDITOR__.parentOrigin,data:{source:'prism-parent',nonce:'contract-nonce',requestId,action,...copy(args)}});
    const result=await waiting;await hooks.after?.(action,args,result);return result;
  };
  await request('load',{document:graph.serialize()});
  const provenance=[{field_id:'reference',node_id:'1',input,class_type:classType,type,origin:'connected',value:connected,edge_id:'edge',source_id:'source',media_owner:{name:connected,backend:'http://127.0.0.1:8188',media_type:type},stored_fallback:'fallback/F',baseline:'baseline/B'}];
  const session=createEditorSessionProjection({request,provenance,assertCurrent(){if(!guarded)throw Error('source changed');}});
  const value=()=>graph.getNodeById(1).widgets[0].value;
  const store=async payload=>{saves.push(copy(payload));assert.equal(value(),payload.output['1'].inputs[input]);return{revision:saves.length};};
  return{session,request,graph,app,window,body,resources,previewStates,provenance,saves,calls,hooks,registry,MediaNode,value,store,preview:()=>preview,currentMedia:()=>resources.at(-1),
    replaceNode(){const prior=graph.getNodeById(1);graph._nodes[0]=new MediaNode(1,prior.widgets[0].value);graph._nodes[0].graph=graph;graph._nodes[0].onAdded?.(graph);},replaceWidget(){const node=graph.getNodeById(1);node.widgets[0]={...node.widgets[0],options:{values:[...options]}};},invalidateSource(){guarded=false;}};
}

for(const type of ['image','video','audio']) {
  test(`real bridge + projection + preview ${type} N→C→N store→C preserves full native source`,async()=>{
    const extension={image:'png',video:'mp4',audio:'wav'}[type],native=`draft/N.${extension}`,connected=`refs/C.${extension}`,f=await fixture({type,native,connected});
    const original=copy(f.provenance),initialized=await f.session.initialize();assert.equal(initialized.applied.length,1);assert.equal(initialized.applied[0].native_pre_overlay,native);assert.equal(f.value(),connected);
    assert.equal(f.preview().getState().filename,connected);assert.equal(f.preview().getState().status,'pending');
    f.currentMedia().emit(type==='image'?'load':type==='video'?'loadeddata':'loadedmetadata');assert.equal(f.preview().getState().status,'ready');
    const result=await f.session.persist(f.store);assert.equal(result.persisted,true);assert.equal(f.saves[0].output['1'].inputs[type],native);assert.equal(f.saves[0].workflow.nodes[0].widgets_values[0],native);
    assert.equal(f.saves[0].output['2'].inputs.text,'UNCHANGED');assert.equal(f.saves[0].workflow.extra.retained,'whole native metadata');assert.equal(f.value(),connected);assert.deepEqual(f.provenance,original);
    assert.equal(Object.hasOwn(f.saves[0].provenance[0],'media_receipt'),false);assert.equal(f.preview().getState().filename,connected);assert.equal(f.preview().getState().status,'pending');
    assert.equal(f.graph.getNodeById(1).imgs,undefined);assert.equal(f.graph.getNodeById(1).hideOutputImages,true);
    if(type==='audio'){const surface=f.graph.getNodeById(1).widgets.find(widget=>widget.name==='audioUI').element;assert.equal(surface.hidden,true);assert.equal(surface.style.getPropertyValue('display'),'none');assert.equal(surface.style.getPropertyPriority('display'),'important');assert.equal(surface.autoplay,false);}
    assert(f.previewStates.some(state=>state.filename===native));assert(f.previewStates.filter(state=>state.filename===connected).length>=2);
    assert.equal(descendants(f.body).filter(item=>['img','video','audio'].includes(item.tagName)).length,1);assert(f.resources.every(media=>!media.operations.includes('play')));
    await assert.rejects(f.app.queuePrompt(),/返回棱光/);f.preview().destroy();
  });
}

for(const type of ['image','video','audio']) {
  test(`real ${type} receipt bypasses only its captured empty N/unlisted C, not ordinary enum writes`,async()=>{
    const f=await fixture({type,native:'',connected:`unlisted/C.${type}`,options:[]});await f.session.initialize();assert.equal(f.value(),`unlisted/C.${type}`);
    await assert.rejects(f.request('patch',{patches:[{node_id:'1',widget_name:type,class_type:{image:'LoadImage',video:'LoadVideo',audio:'LoadAudio'}[type],value:'invented/other',expected_value:f.value()}]}),/安全回写/);
    assert.equal(f.value(),`unlisted/C.${type}`);assert.equal(f.graph.getNodeById(1).widgets[0].options.values.length,0);
    await f.session.persist(f.store);assert.equal(f.saves[0].output['1'].inputs[type],'');assert.equal(f.value(),`unlisted/C.${type}`);f.preview().destroy();
  });
}

for(const change of ['node','widget']) for(const native of ['draft/N.png','refs/C.png']) {
  test(`same-ID replacement of real media ${change} invalidates receipt before storage, ${native==='refs/C.png'?'zero':'nonzero'} cleanup`,async()=>{
    const f=await fixture({native});await f.session.initialize();change==='node'?f.replaceNode():f.replaceWidget();
    await assert.rejects(f.session.persist(f.store),error=>error.code==='media_receipt_changed');assert.equal(f.saves.length,0);assert.equal(f.value(),'refs/C.png');f.preview()?.destroy();
  });
}

for(const type of ['image','video','audio']) for(const choice of ['native','inner']) {
  test(`real I ${type} ${choice} choice stores chosen literal and restores I display`,async()=>{
    const extension={image:'png',video:'mp4',audio:'wav'}[type], native=`draft/N.${extension}`, inner=`picked/I.${extension}`;
    const f=await fixture({type,native,connected:`refs/C.${extension}`});await f.session.initialize();f.graph.getNodeById(1).widgets[0].value=inner;
    const conflict=await f.session.prepare(f.store);assert.equal(conflict.status,'resolution_required');assert.equal(f.saves.length,0);assert.equal(f.preview().getState().filename,inner);
    await f.session.prepare(f.store,{resolutions:{reference:choice},expectedConflicts:conflict.conflicts});
    assert.equal(f.saves[0].output['1'].inputs[type],choice==='inner'?inner:native);assert.equal(f.value(),inner);assert.equal(f.preview().getState().filename,inner);
    assert.equal(f.saves[0].connected_resolutions[0].media_owner_invalidated,choice==='inner'?true:undefined);f.preview().destroy();
  });
}

test('real whole-compile check refuses media callback sibling side effects, with no successful save',async()=>{
  const f=await fixture();f.graph.getNodeById(1).widgets[0].callback=()=>{f.graph.getNodeById(2).widgets[0].value='UNREQUESTED';};
  await assert.rejects(f.session.initialize(),error=>error.result?.rolled_back===true&&error.result.unsupported.some(item=>item.reason==='callback_failed'));
  assert.equal(f.saves.length,0);assert.equal(f.graph.getNodeById(2).widgets[0].value,'UNCHANGED');assert.equal(f.value(),'draft/N.png');
  const writes=f.calls.filter(call=>call.action==='patch');assert.equal(writes.length,1);f.preview()?.destroy();
});

test('real registered-constructor mismatch leaves media unmapped instead of fabricating capture support',async()=>{
  const f=await fixture({unknown:true});const result=await f.session.initialize();assert.equal(result.applied.length,0);assert.match(result.unmapped[0].reason,/media_contract_unsupported/);assert.equal(f.value(),'draft/N.png');assert.equal(f.calls.some(call=>call.action==='patch'),false);f.preview()?.destroy();
});

test('real preview failure does not corrupt proven clean N persistence or invent a successful load',async()=>{
  const f=await fixture();await f.session.initialize();f.currentMedia().emit('error');assert.equal(f.preview().getState().status,'failed');
  await f.session.persist(f.store);assert.equal(f.saves[0].output['1'].inputs.image,'draft/N.png');assert.equal(f.value(),'refs/C.png');assert.equal(f.preview().getState().status,'pending');f.preview().destroy();
});

test('real capture reply cannot downgrade a changed direct-source guard into unsupported media',async()=>{
  const f=await fixture();f.hooks.after=action=>{if(action==='captureMedia')f.invalidateSource();};
  await assert.rejects(f.session.initialize(),/source changed/);assert.equal(f.calls.some(call=>call.action==='patch'),false);assert.equal(f.saves.length,0);assert.equal(f.value(),'draft/N.png');f.preview()?.destroy();
});
