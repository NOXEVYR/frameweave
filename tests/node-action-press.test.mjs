import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNodeActionPress } from '../web/node-action-press.mjs';

function fixture() {
  const node={id:'node',data:{value:'before'}},card={},icon={},button={disabled:false,contains:target=>target===button||target===icon};
  let current=node;const press=createNodeActionPress({isCurrent:actual=>actual===current});
  return {node,card,icon,button,press,replace:()=>{current=structuredClone(node);},remove:()=>{current=null;}};
}

test('press keeps only its exact live card through model changes and a release over child icons',()=>{
  const h=fixture();h.press.begin(h.button,h.card,h.node,4);h.node.data.value='after';
  assert(h.press.preserves(h.card,h.node));assert(!h.press.preserves({},h.node));
  assert.equal(h.press.release(4,h.icon),false);assert(h.press.preserves(h.card,h.node));
  assert(h.press.activate(h.button,h.node));assert(!h.press.activate(h.button,h.node),'one pointer transaction activates once');
  assert(h.press.finish(h.button));assert(!h.press.preserves(h.card,h.node));
});

test('pointerup outside, cancellation and disabled controls cannot activate a pointer press',()=>{
  for(const cancel of ['outside','cancel','disabled']){
    const h=fixture();h.press.begin(h.button,h.card,h.node,4);
    if(cancel==='outside')assert(h.press.release(4,{}));
    if(cancel==='cancel')assert(h.press.cancel(4));
    if(cancel==='disabled'){h.button.disabled=true;assert(h.press.release(4,h.button));}
    assert(!h.press.activate(h.button,h.node));assert(!h.press.preserves(h.card,h.node));
  }
});

test('a different pointer cannot cancel or release the protected transaction',()=>{
  const h=fixture();h.press.begin(h.button,h.card,h.node,4);
  assert(!h.press.cancel(5));assert(!h.press.release(5,{}));assert(h.press.preserves(h.card,h.node));
});

test('same-id replacements and deleted nodes cannot preserve or activate their old buttons',()=>{
  for(const change of ['replace','remove']){
    const h=fixture();h.press.begin(h.button,h.card,h.node,4);h[change]();
    assert(!h.press.preserves(h.card,h.node));assert(!h.press.activate(h.button,h.node,true));
    assert(!h.press.activate(h.button,h.node));
  }
});

test('keyboard activation remains available without a mouse transaction and disabled buttons reject it',()=>{
  const h=fixture();assert(h.press.activate(h.button,h.node,true));h.button.disabled=true;
  assert(!h.press.activate(h.button,h.node,true));assert(!h.press.begin(h.button,h.card,h.node,1));
});

const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
function appHarness() {
  const source={id:'source',data:{text:'before'}},node={id:'target',type:'generation',x:0,y:0,data:{kind:'package',title:'Target'}};
  const card={dataset:{nodeId:node.id},_node:node,_signature:'before',style:{},classList:{toggle(){}},contains:()=>false};
  const icon={},listeners=new Map(),documentEvents=new Map(),windowEvents=new Map(),microtasks=[],frames=[];
  const button={disabled:false,type:'',closest:selector=>selector==='.node'?card:null,contains:target=>target===button||target===icon,addEventListener:(name,fn)=>listeners.set(name,fn)};
  const inputListeners=new Map(),input={value:'before',readOnly:false,closest:()=>card,addEventListener:(name,fn)=>inputListeners.set(name,fn)};
  const state={source,node,card,button,icon,listeners,input,inputListeners,documentEvents,windowEvents,microtasks,frames,actions:[],redraws:0,history:0};
  const nodesLayer={children:[card]},labels={},sandbox={
    graph:{nodes:[node],edges:[{id:'edge',source:source.id,target:node.id}]},nodesLayer,packages:[],submitting:new Set(),referenceImports:new Map(),contentLayout:null,
    nodeActionPress:createNodeActionPress({isCurrent:actual=>sandbox.graph.nodes.includes(actual)}),getNode:id=>id===source.id?source:sandbox.graph.nodes.find(n=>n.id===id),
    selected:new Set(),expandedInputs:new Set(),portBindings:new Map(),portBindingSignature:()=>'',selectedEdge:null,spaceDown:false,tool:'select',draftEditing:null,node:source,text:input,workflowCanvas:null,
    document:{activeElement:{},addEventListener:(name,fn)=>documentEvents.set(name,fn)},window:{addEventListener:(name,fn)=>windowEvents.set(name,fn)},
    queueMicrotask:fn=>microtasks.push(fn),requestAnimationFrame:fn=>frames.push(fn),
    $:selector=>labels[selector]||=( {} ),updateCanvasActions(){},updateNodeJobStatus(){},renderEdges(){},
    el(tag){if(tag==='article')throw new Error('redraw-card');return button;},finishKeyboardMove(){},snapshot:()=>JSON.stringify({text:source.data.text}),
    pushHistory(before){if(sandbox.snapshotChanged(before))state.history++;},save(){},renderInspector(){},revealInspector(){},renderSelection(){},switchTab(){},reportError:error=>{throw error;},
  };
  const code=app.slice(app.indexOf('function button('),app.indexOf('function bind('))+
    app.slice(app.indexOf('function snapshotChanged('),app.indexOf('function restoreSnapshot('))+
    app.slice(app.indexOf('function mutate('),app.indexOf('function save('))+
    app.slice(app.indexOf('function renderNodes('),app.indexOf('function renderSelection('))+
    app.slice(app.indexOf('function bindDraft('),app.indexOf('function field('));
  vm.runInNewContext(code,sandbox);
  const renderer=sandbox.renderNodes;
  sandbox.renderNodes=()=>{try{renderer();}catch(error){if(error.message!=='redraw-card')throw error;state.redraws++;}};
  vm.runInNewContext(app.slice(app.indexOf("document.addEventListener('pointerdown', () => { if (nodeActionPress.cancel())"),
    app.indexOf("window.addEventListener('blur', () => { if (nodeActionPress.cancel())")+app.slice(app.indexOf("window.addEventListener('blur', () => { if (nodeActionPress.cancel())")).indexOf('\n')),sandbox);
  sandbox.button('Enter','',()=>state.actions.push(source.data.text));
  sandbox.bindDraft(input,value=>sandbox.mutate(()=>{source.data.text=value;},{inspector:false}));
  vm.runInNewContext(app.split('\n').find(line=>line.includes("text.addEventListener('change', () => mutate")),sandbox);
  return {state,sandbox,down:(buttonType=0)=>{
    documentEvents.get('pointerdown')({pointerId:7,target:button});
    listeners.get('pointerdown')({pointerId:7,button:buttonType,stopPropagation(){}});
  },up:target=>documentEvents.get('pointerup')({pointerId:7,target}),click:(detail=1)=>listeners.get('click')({detail,stopPropagation(){}})};
}

test('real app handlers keep a pressed target card through text change and blur, then dispatch the updated model exactly once',()=>{
  const h=appHarness();h.state.inputListeners.get('focus')();h.state.input.value='updated';h.state.inputListeners.get('input')();
  h.down();h.state.inputListeners.get('change')();h.state.inputListeners.get('blur')();h.state.microtasks.splice(0).forEach(fn=>fn());
  assert.equal(h.state.history,1,'draft input and the later change event share a single undo transaction');
  assert.equal(h.state.redraws,0,'actual renderNodes must retain pressed target despite changed source signature');
  h.up(h.state.icon);h.click();assert.deepEqual(h.state.actions,['updated']);assert.equal(h.state.redraws,1,'post-activation refresh rebuilds invalidated card');
  h.click();assert.deepEqual(h.state.actions,['updated'],'pointer click is not replayed after the press is released');
});

test('real app cleanup rejects pointer activation after outside release, cancel or window blur',()=>{
  for(const reason of ['outside','cancel','blur']){
    const h=appHarness();h.down();
    if(reason==='outside')h.up({});
    if(reason==='cancel')h.state.documentEvents.get('pointercancel')({pointerId:7});
    if(reason==='blur')h.state.windowEvents.get('blur')();
    h.click();assert.deepEqual(h.state.actions,[]);assert(h.state.redraws>0);
  }
});

test('middle-button, space and hand gestures create no protected card or action',()=>{
  for(const mode of ['middle','space','hand']){
    const h=appHarness();if(mode==='space')h.sandbox.spaceDown=true;if(mode==='hand')h.sandbox.tool='hand';
    h.down(mode==='middle'?1:0);assert(!h.sandbox.nodeActionPress.preserves(h.state.card,h.state.node));
    h.up(h.state.button);h.click();assert.deepEqual(h.state.actions,[]);
  }
});

test('keyboard clicks execute against the live node and a stale same-id node does not',()=>{
  const h=appHarness();h.click(0);assert.deepEqual(h.state.actions,['before']);
  h.sandbox.graph.nodes[0]=structuredClone(h.state.node);h.click(0);assert.deepEqual(h.state.actions,['before']);
});

test('disabled during a press cancels its activation without running the action',()=>{
  const h=appHarness();h.down();h.state.button.disabled=true;h.up(h.state.button);h.click();assert.deepEqual(h.state.actions,[]);
});
