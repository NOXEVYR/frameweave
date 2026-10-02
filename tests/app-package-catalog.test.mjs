import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createPackageCatalog } from '../web/package-catalog.mjs';
import { interfacePage, interfaceSearch } from '../web/interface-pagination.mjs';
import { INTERFACE_PAGE_SIZE } from '../web/interface-limits.mjs';
import { cachedPackageField } from '../web/canvas-port-layout.mjs';
import { audioPackageChoices } from '../web/audio-studio.mjs';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const part=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const full=(id)=>({id,name:`Package ${id}`,archived:true,fields:[{id:'custom-id',label:'人物参考',node_id:'1',input:'text',type:'text',default:'original'}],prompt:{'1':{class_type:'PrimitiveString',inputs:{value:'original'}}}});
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Element {
  constructor(tag,cls='',text=''){Object.assign(this,{tagName:tag,className:cls,textContent:text,children:[],dataset:{},style:{},listeners:{},value:'',disabled:false});}
  append(...items){this.children.push(...items);} replaceChildren(...items){this.children=[];this.append(...items);}
  addEventListener(name,fn){this.listeners[name]=fn;} setAttribute(name,value){this[name]=value;}
  querySelectorAll(){return flatten(this).filter(item=>['input','textarea','select','button'].includes(item.tagName));}
  close(){} contains(){return false;}
}
const flatten=root=>[root,...root.children.flatMap(flatten)];
function harness({budget,api: customApi}={}){
  const node={id:'node',type:'generation',data:{kind:'package',package_id:'p0',packageFields:[{id:'old-custom',label:'旧入口',type:'text'}],inputLabels:{'custom-id':'场景参考'},packageValues:{'custom-id':'用户外层值'}}};
  const state={documentHandlers:{},windowHandlers:{},actions:0,identity:'canvas',selection:node,rendered:0,saved:0,calls:[],created:[],elements:new Map(),wrap:new Element('div')};
  const sandbox={createPackageCatalog: options=>createPackageCatalog({...options,...budget}),interfacePage,interfaceSearch,INTERFACE_PAGE_SIZE,cachedPackageField,
    node,graph:{nodes:[node],edges:[]},selected:new Set([node.id]),viewport:{},canvas:{clientWidth:1000},packagesLoaded:false,editorLibrary:[],
    currentCanvasIdentity:()=>state.identity,singleSelected:()=>state.selection,getNode:id=>sandbox.graph.nodes.find(item=>item.id===id),
    api:async(path,body)=>{state.calls.push({path,body});if(customApi){const result=await customApi(path,body,state);if(result!==undefined)return result;}
      if(path==='/api/editor-workflows')return{workflows:[]};if(path.startsWith('/api/packages?'))return{packages:Array.from({length:20},(_,i)=>({...full(`p${i}`),fields:undefined,field_count:1,summary:true}))};
      if(path.startsWith('/api/packages/'))return{package:full(decodeURIComponent(path.split('/').at(-1)))};throw Error(path);},
    el:(tag,cls,text)=>new Element(tag,cls,text),button:(text,cls,action)=>{const item=new Element('button',cls,text);item.listeners.click=action;return item;},
    $:selector=>{if(!state.elements.has(selector))state.elements.set(selector,new Element('div'));return state.elements.get(selector);},document:{activeElement:null,addEventListener:(name,fn)=>{state.documentHandlers[name]=fn;}},window:{addEventListener:(name,fn)=>{state.windowHandlers[name]=fn;}},requestAnimationFrame:fn=>setImmediate(fn),
    section(){},field:(label)=>new Element('label','field',label),defaultValues:items=>Object.fromEntries(items.map(item=>[item.id,item.default])),fieldType:item=>item.type,
    packageMediaOwner:()=> 'canvas:node',packageMediaTransfers:{state(){},discard(){}},workflowCanvas:{describeInput(){return null;}},workflowConfigurations:{},
    coerceFieldValue:(_item,value)=>value,mutate:fn=>fn(),mediaURL:()=>null,outputMedia(){},toast(){},openPackages(){},openNodeWorkflow(){state.actions++;},nativeEditor:{},
    renderPackageLibrary(){},renderNodes(){},renderInspector(){state.rendered++;state.wrap.replaceChildren();if(state.selection?.data.kind==='package')sandbox.renderPackageInputs(state.wrap,state.selection);},
    studio:{open(){}},bounds:()=>({maxX:0}),addNode:(type,data)=>{const item={id:`created-${state.created.length}`,type,data,x:10,y:20};state.created.push(item);sandbox.graph.nodes.push(item);return item;},
    applyViewport(){},save(){state.saved++;},switchTab(){},
  };
  vm.createContext(sandbox);
  vm.runInContext(part('let packages = [];','let editorLibrary =')+part('const interfaceViews =','function packageMediaPreview(')+part('function packageMediaPreview(','async function loadPackages(')+part('async function loadPackages(','function renderPackageLibrary(')+part('async function addPackageNode(','async function exportPackage('),sandbox);
  const catalog=vm.runInContext('packageCatalog',sandbox);
  return{sandbox,state,node,catalog,summaries:()=>vm.runInContext('packages',sandbox),render:()=>sandbox.renderInspector(),text:()=>flatten(state.wrap).map(item=>item.textContent).join('\n')};
}

test('actual package refresh uses summaries, leaves canvas cached mappings and user labels untouched, and never saves/hydrates the whole library',async()=>{
  const h=harness();h.state.selection=null;const before=JSON.stringify(h.sandbox.graph);await h.sandbox.loadPackages();
  assert.equal(h.summaries().length,20);assert.equal(h.summaries()[0].field_count,1);assert.equal('fields'in h.summaries()[0],false);
  assert.equal(JSON.stringify(h.sandbox.graph),before);assert.equal(h.state.saved,0);assert.deepEqual(h.state.calls.map(item=>item.path).sort(),['/api/packages?summary=1','/api/editor-workflows'].sort());
});

test('actual sidebar shows loading, then complete custom-ID parameters without overwriting cached ports or outer values',async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();assert.match(h.text(),/按需读取/);
  gate.resolve({package:full('p0')});await tick();assert(flatten(h.state.wrap).some(item=>item.dataset.packageField==='custom-id'));
  assert.equal(h.node.data.packageFields[0].id,'old-custom');assert.equal(h.node.data.inputLabels['custom-id'],'场景参考');assert.equal(h.node.data.packageValues['custom-id'],'用户外层值');assert.equal(h.state.saved,0);
});

test('failed sidebar detail preserves old bindings and offers an explicit retry which actually rereads',async()=>{
  let attempts=0;const h=harness({api:path=>path==='/api/packages/p0'&&++attempts===1?Promise.reject(Error('missing file')):undefined});
  h.render();await tick();assert.match(h.text(),/无法读取.*missing file/);assert.equal(h.node.data.packageFields[0].id,'old-custom');
  flatten(h.state.wrap).find(item=>item.textContent==='重试读取工作流参数').listeners.click();await tick();assert.equal(attempts,2);assert(flatten(h.state.wrap).some(item=>item.dataset.packageField==='custom-id'));
});

for(const [name,change] of [['canvas',h=>{h.state.identity='other';}],['selection',h=>{h.state.selection=null;}],['node replacement',h=>{h.sandbox.graph.nodes=[{...h.node}];}],['package',h=>{h.node.data.package_id='p1';}]])test(`late sidebar detail cannot repaint a changed ${name}`,async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();const count=h.state.rendered;change(h);gate.resolve({package:full('p0')});await tick();assert.equal(h.state.rendered,count);assert.equal(h.state.saved,0);
});

test('selecting over 12 packages then returning to the earliest ready record reloads the evicted definition',async()=>{
  const h=harness();h.render();await tick();for(let i=1;i<13;i++){const node={id:`node-${i}`,type:'generation',data:{kind:'package',package_id:`p${i}`}};h.sandbox.graph.nodes.push(node);h.state.selection=node;h.render();await tick();}
  assert.equal(h.catalog.peek('p0'),null);h.state.selection=h.node;h.render();await tick();assert.equal(h.state.calls.filter(item=>item.path==='/api/packages/p0').length,2);assert(flatten(h.state.wrap).some(item=>item.dataset.packageField==='custom-id'));
});

test('force refreshing a current ready sidebar rereads its definition rather than staying in permanent loading',async()=>{
  const h=harness();h.render();await tick();await h.sandbox.loadPackages({force:true});await tick();
  assert(h.state.calls.some(item=>item.path==='/api/packages?summary=1&refresh=1'));assert.equal(h.state.calls.filter(item=>item.path==='/api/packages/p0').length,2);assert(flatten(h.state.wrap).some(item=>item.dataset.packageField==='custom-id'));
});

test('oversized uncached definition is usable in the current sidebar without an automatic fetch loop',async()=>{
  const h=harness({budget:{maxBytes:10}});h.render();await tick();assert.equal(h.catalog.peek('p0'),null);assert(flatten(h.state.wrap).some(item=>item.dataset.packageField==='custom-id'));h.render();await tick();assert.equal(h.state.calls.filter(item=>item.path==='/api/packages/p0').length,1);
});

test('concurrent node additions share one complete definition and create only one node; a later intentional addition is still allowed',async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/new'?gate.promise:undefined});
  const a=h.sandbox.addPackageNode({id:'new',summary:true}),b=h.sandbox.addPackageNode({id:'new',summary:true});gate.resolve({package:full('new')});assert.equal(await a,await b);assert.equal(h.state.created.length,1);assert.equal(h.state.created[0].data.packageFields[0].id,'custom-id');
  await h.sandbox.addPackageNode({id:'new',summary:true});assert.equal(h.state.created.length,2);assert.equal(h.state.calls.filter(item=>item.path==='/api/packages/new').length,1);
});

test('node addition after a canvas switch refuses to put the loaded package on the new canvas',async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/new'?gate.promise:undefined});const adding=h.sandbox.addPackageNode({id:'new',summary:true});h.state.identity='new';gate.resolve({package:full('new')});await assert.rejects(adding,/画布已切换/);assert.equal(h.state.created.length,0);
});

test('audio capabilities retain complete field metadata while local catalog contains summaries only',()=>{
  const pack=full('audio'),backend='http://127.0.0.1:8188';const choices=audioPackageChoices({backend_url:backend,available:true,packages:[{...pack,eligible:true,available:true}]},[{id:'audio',name:'摘要名',summary:true,field_count:1}],backend);
  assert.equal(choices.packages[0].fields[0].id,'custom-id');assert.equal(choices.packages[0].eligible,true);assert.equal(choices.packages[0].name,'摘要名');
});


for(const outcome of ['success','error'])test(`sidebar ${outcome} waits for editing focus/IME to leave and then refreshes once`,async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();
  const panel=h.sandbox.$('#properties-panel'),input={matches:()=>true};panel.contains=item=>item===input;h.sandbox.document.activeElement=input;
  const count=h.state.rendered;if(outcome==='success')gate.resolve({package:full('p0')});else gate.reject(Error('missing'));
  await tick();assert.equal(h.state.rendered,count);assert.equal(typeof panel.listeners.focusout,'function');
  h.sandbox.document.activeElement=null;panel.listeners.focusout();await tick();assert.equal(h.state.rendered,count+1);
  assert.match(h.text(),outcome==='success'?/人物参考/:/无法读取.*missing/);
});

test('deferred sidebar focusout rechecks node/selection identity before any repaint',async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();const panel=h.sandbox.$('#properties-panel'),input={matches:()=>true};
  panel.contains=item=>item===input;h.sandbox.document.activeElement=input;gate.resolve({package:full('p0')});await tick();
  const count=h.state.rendered;h.state.selection=null;h.sandbox.document.activeElement=null;panel.listeners.focusout();await tick();assert.equal(h.state.rendered,count);
});


for(const outcome of ['success','error'])test(`delayed sidebar ${outcome} preserves a button held across animation frames until its original click dispatches once`,async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();
  const panel=h.sandbox.$('#properties-panel'),input={matches:()=>true};panel.contains=item=>item===input;h.sandbox.document.activeElement=input;
  const button=flatten(h.state.wrap).find(item=>item.textContent==='进入工作流 · 修复'),count=h.state.rendered;
  if(outcome==='success')gate.resolve({package:full('p0')});else gate.reject(Error('missing'));await tick();
  panel.listeners.pointerdown({button:0,pointerId:7});h.sandbox.document.activeElement=button;panel.listeners.focusout();await tick();
  assert.equal(h.state.rendered,count);assert(flatten(h.state.wrap).includes(button));assert.equal(h.state.actions,0);
  h.state.documentHandlers.pointerup({pointerId:7});assert.equal(h.state.rendered,count);button.listeners.click({detail:1});assert.equal(h.state.actions,1);
  await tick();assert.equal(h.state.rendered,count+1);assert.equal(h.state.actions,1);
});

for(const ending of ['pointercancel','blur'])test(`sidebar held-button ${ending} releases deferred content without executing any action`,async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();const panel=h.sandbox.$('#properties-panel');panel.listeners.pointerdown({button:0,pointerId:7});
  gate.resolve({package:full('p0')});await tick();const count=h.state.rendered;
  if(ending==='blur')h.state.windowHandlers.blur();else h.state.documentHandlers.pointercancel({pointerId:7});await tick();assert.equal(h.state.rendered,count+1);assert.equal(h.state.actions,0);
});

test('sidebar press ignores another pointer and release rechecks a replaced node',async()=>{
  const gate=defer(),h=harness({api:path=>path==='/api/packages/p0'?gate.promise:undefined});h.render();const panel=h.sandbox.$('#properties-panel');panel.listeners.pointerdown({button:0,pointerId:7});
  gate.resolve({package:full('p0')});await tick();const count=h.state.rendered;h.state.documentHandlers.pointerup({pointerId:8});await tick();assert.equal(h.state.rendered,count);
  h.sandbox.graph.nodes=[{...h.node}];h.state.documentHandlers.pointerup({pointerId:7});await tick();assert.equal(h.state.rendered,count);assert.equal(h.state.actions,0);
});
