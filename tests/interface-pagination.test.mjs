import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { interfacePage, interfaceSearch } from '../web/interface-pagination.mjs';
import { INTERFACE_PAGE_SIZE } from '../web/interface-limits.mjs';
import { inputPortCandidates, visibleInputPorts, portExpansionPositions, CANVAS_PORT_PAGE_SIZE } from '../web/canvas-port-layout.mjs';
import { initialEditorFieldIds } from '../web/editor-interface-panel.mjs';

const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const part=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
class Element {
  constructor(tag, cls='', text='') { Object.assign(this,{tagName:tag,className:cls,textContent:text,children:[],listeners:{},dataset:{},style:{},value:'',disabled:false}); this.classList={toggle(){},add(){}}; }
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=[];this.append(...items);}
  setAttribute(name,value){this[name]=String(value);}
  addEventListener(name,fn){this.listeners[name]=fn;}
  emit(name){this.listeners[name]?.({target:this});}
  querySelectorAll(){return flatten(this).filter(item=>['input','textarea','select','button'].includes(item.tagName));}
  click(){if(!this.disabled)this.emit('click');}
  close(){} showModal(){}
  closest(){return null;}
}
const flatten=root=>[root,...root.children.flatMap(flatten)];
function harness(fields, type='boolean') {
  const node={id:'target',type:'generation',data:{title:'测试工作流',kind:'package',package_id:'pack',packageValues:{}}};
  const pack={id:'pack',fields}, wrap=new Element('div'), elements=new Map();
  const $=selector=>{if(!elements.has(selector))elements.set(selector,new Element('div'));return elements.get(selector);};
  const sandbox={interfacePage,interfaceSearch,INTERFACE_PAGE_SIZE,CANVAS_PORT_PAGE_SIZE,inputPortCandidates,visibleInputPorts,portExpansionPositions,initialEditorFieldIds,
    activeSidebarPackage:null,currentCanvasIdentity:()=> 'canvas',packageCatalog:{peek:()=>pack},
    packages:[pack],packagesLoaded:true,node,pack,wrap,$, settings:{backend_url:'http://127.0.0.1:8188'},
    packageDraft:null,expandedInputs:new Set(),graph:{nodes:[node],edges:[]},
    getNode:id=>sandbox.graph.nodes.find(item=>item.id===id),edgeInputField:(_graph,edge)=>edge.targetField,
    generationInputPorts:()=>fields, defaultValues:items=>Object.fromEntries(items.map(item=>[item.id,item.default??false])),
    nodeSize:()=>({width:304,height:300}),
    fieldType:item=>item.type,coerceFieldValue:(_item,value)=>value,mutate:fn=>fn(),renderEdges(){},
    packageMediaOwner:()=> 'canvas:target', packageMediaTransfers:{state(){},discard(){}}, workflowConfigurations:{},
    workflowCanvas:{describeInput:(_id,definition)=>{const edge=sandbox.graph.edges.find(item=>item.targetField===definition.id);return edge?{text:'source',edge}:null;}},
    el:(tag,cls,text)=>new Element(tag,cls,text),section(){},
    button:(text,cls,action)=>{const button=new Element('button',cls,text);button.addEventListener('click',action);return button;},
    field:(label,value,change,options={})=>{const row=new Element('label','field',label);row.options=options;const input=new Element('input');input.value=value;input.addEventListener('change',()=>change(input.value));row.append(input);return row;},
    port:(_node,_direction,id)=>{const item=new Element('button','port');item.dataset.field=id;return item;},
    renderInspector(){wrap.replaceChildren();sandbox.renderPackageInputs(wrap,node);},
    api:async()=>({prompt:{'1':{class_type:'Test',inputs:{}}},fields}),
    stableStringify:JSON.stringify,mediaURL:()=>null,outputMedia(){throw Error('unexpected media');},draftEditing:false,reportError:error=>{throw error;},
  };
  vm.createContext(sandbox);
  vm.runInContext(part('const interfaceViews =','async function loadPackages(')+part('function inputPorts(','function cancelConnection(')+part('function renderPackageDraft(','async function inspectPackageFile('),sandbox);
  return {sandbox,node,wrap,pack,$,find:(root,predicate)=>flatten(root).find(predicate),aria:(root,label)=>flatten(root).find(item=>item['aria-label']===label),button:(root,label)=>flatten(root).find(item=>item.tagName==='button'&&item.textContent===label)};
}
const fields=(count,type='boolean')=>Array.from({length:count},(_,i)=>({id:`field-${i}`,label:`输入 ${i}`,node_id:String(i+1),input:`custom_${i}`,type,recommended:true,presentation:'port'}));

test('pure pagination clamps invalid pages without changing or truncating full model',()=>{
  const all=fields(4096);const first=interfacePage(all),last=interfacePage(all,999);
  assert.equal(first.items.length,64);assert.equal(last.page,63);assert.equal(last.items[63],all[4095]);
  assert.equal(interfacePage([],9).pages,1);assert.equal(interfacePage(all,-1).page,0);
  assert.equal(interfaceSearch(all,'field-4095')[0],all[4095]);assert.equal(all.length,4096);
});

test('actual package sidebar renders at most 64 controls and preserves values through page, search and reopen',()=>{
  const h=harness(fields(4096));h.sandbox.renderInspector();
  const controls=()=>flatten(h.wrap).filter(item=>item.dataset.packageField);
  assert.equal(controls().length,64);
  const first=controls()[0].children[0];first.checked=true;first.emit('change');
  assert.equal(h.node.data.packageValues['field-0'],true);
  h.button(h.wrap,'工作流参数下一页').click();assert.equal(controls()[0].dataset.packageField,'field-64');
  const search=h.aria(h.wrap,'搜索工作流参数');search.value='field-4095';search.emit('input');
  assert.equal(controls().length,1);assert.equal(controls()[0].dataset.packageField,'field-4095');
  const last=controls()[0].children[0];last.checked=true;last.emit('change');
  h.sandbox.renderInspector();assert.equal(controls().length,1);assert.equal(controls()[0].children[0].checked,true);
  assert.equal(h.node.data.packageValues['field-0'],true);assert.equal(h.pack.fields.length,4096);
  const clear=h.aria(h.wrap,'搜索工作流参数');clear.value='';clear.emit('input');assert.equal(controls()[0].children[0].checked,true);
});

test('actual paged input purposes retain named bindings and expose the final connected field',()=>{
  const all=fields(4096,'image'),h=harness(all);h.sandbox.graph.nodes.push({id:'source',data:{title:'场景参考'}});
  h.sandbox.graph.edges.push({id:'edge',source:'source',target:'target',targetField:'field-4095'});
  h.sandbox.renderInputPortSettings(h.wrap,h.node);
  assert.equal(flatten(h.wrap).filter(item=>item.className==='field').length,64);
  const search=h.aria(h.wrap,'搜索输入用途');search.value='field-4095';search.emit('input');
  const row=h.find(h.wrap,item=>item.className==='field');assert.match(row.options.help,/场景参考/);
  row.children[0].value='人物参考';row.children[0].emit('change');
  assert.equal(h.node.data.inputLabels['field-4095'],'人物参考');assert.equal(h.sandbox.graph.edges[0].targetField,'field-4095');
});

test('actual card expansion pages unconnected sockets and search keeps exact connected anchors',()=>{
  const h=harness(fields(4096,'image'));
  h.sandbox.graph.edges.push({id:'connected',source:'source',target:'target',targetField:'field-4000'});
  h.sandbox.inputPorts(h.node,h.wrap);
  const sockets=()=>flatten(h.wrap).filter(item=>item.className==='port');
  assert.equal(sockets().length,5);assert(sockets().some(item=>item.dataset.field==='field-4000'));
  h.find(h.wrap,item=>item.className==='node-action port-overflow').click();assert.equal(sockets().length,9);
  h.button(h.wrap,'端口下一页').click();assert(sockets().some(item=>item.dataset.field==='field-4000'));
  assert(sockets().some(item=>item.dataset.field==='field-8'));
  const search=h.aria(h.wrap,'搜索画布输入端口');search.value='field-4095';search.emit('input');
  assert.deepEqual(sockets().map(item=>item.dataset.field),['field-4000','field-4095']);
  h.button(h.wrap,'收起未连接接口').click();assert.equal(sockets().length,5);assert.equal(h.sandbox.graph.edges.length,1);
});

test('canvas socket search is available when a small workflow exceeds the readable card page',()=>{
  const h=harness(fields(12,'image'));
  h.sandbox.inputPorts(h.node,h.wrap);
  h.find(h.wrap,item=>item.className==='node-action port-overflow').click();
  assert.equal(h.aria(h.wrap,'搜索画布输入端口').hidden,false);
  assert.equal(flatten(h.wrap).filter(item=>item.className==='port').length,8);
});

test('actual legacy import uses 64 soft defaults, preserves imported complete packages, and never executes',async()=>{
  const all=fields(4096),h=harness(all);
  await h.sandbox.inspectPackageDocument({prompt:{}},'large');assert.equal(h.sandbox.packageDraft.fields.filter(item=>item.selected).length,64);
  assert.equal(h.sandbox.packageDraft.fields.length,4096);
  await h.sandbox.inspectPackageDocument({format:'frameweave-workflow'},'retained','{}');
  assert.equal(h.sandbox.packageDraft.fields.filter(item=>item.selected).length,4096);
  assert.equal(h.$('#package-field-list').children[1].children.filter(item=>item.className?.startsWith('package-field-row')).length,64);
  assert.equal(h.sandbox.packageDraft.sourceJSON,'{}');
});

test('actual legacy bulk selection targets full filter and media are retained on deselection',()=>{
  const all=fields(130),h=harness(all);all.push({id:'media',label:'图片入口',node_id:'9',input:'image',type:'image',selected:true});
  h.sandbox.packageDraft={fields:all.map(item=>({...item,selected:true}))};h.sandbox.renderPackageDraft();
  const list=h.$('#package-field-list');h.button(list,'取消筛选结果').click();
  assert.equal(h.sandbox.packageDraft.fields.filter(item=>item.selected).length,1);
  const search=h.aria(list,'搜索包输入');search.value='field-129';search.emit('input');
  h.button(list,'勾选筛选结果').click();assert.equal(h.sandbox.packageDraft.fields[129].selected,true);
  const rename=h.aria(list,'输入名称 130.custom_129');rename.value='末页命名';rename.emit('change');
  h.sandbox.renderPackageDraft();assert.equal(h.aria(list,'输入名称 130.custom_129').value,'末页命名');
});


test('shared search ignores partial hash IDs but supports exact IDs and human readable substring matches',()=>{
  const all=[{id:'hash-950-deadbeef',node_id:'12',label:'其他输入',input:'seed',type:'integer'},
    {id:'hash-exact',node_id:'950',label:'输入尺寸',input:'width',type:'integer'},
    {id:'hash-custom',node_id:'13',label:'镜头950场景',input:'text',type:'text'}];
  assert.deepEqual(interfaceSearch(all,'950'),[all[1],all[2]]);
  assert.deepEqual(interfaceSearch(all,'hash-950-deadbeef'),[all[0]]);
  assert.deepEqual(interfaceSearch(all,'HASH-EXACT'),[all[1]]);
  assert.deepEqual(interfaceSearch(all,'width'),[all[1]]);
});
