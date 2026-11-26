import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canvasContentArea, canvasChromeOffsets } from '../web/canvas-layout.mjs';
import { createWorkflowCanvas } from '../web/workflow-canvas.mjs';
import { createNode } from '../web/graph.mjs';

const canvas = { left:166, top:124, right:920, bottom:720, width:754, height:596 };
const rect = (x,y,width,height,kind) => ({left:canvas.left+x,top:canvas.top+y,right:canvas.left+x+width,bottom:canvas.top+y+height,width,height,kind});
const bounded = area => { assert(area.x >= 0 && area.y >= 0); assert(area.width >= 0 && area.height >= 0); assert(area.x + area.width <= canvas.width); assert(area.y + area.height <= canvas.height); };
const intersects = (area, other) => area.x < other.right-canvas.left && area.x+area.width > other.left-canvas.left && area.y < other.bottom-canvas.top && area.y+area.height > other.top-canvas.top;

test('real narrow screenshot chrome reserves toolbar height, while right expanded history is local', () => {
  const top = rect(22,118,610,78,'top'), panel = rect(350,204,360,180,'obstacle');
  const input = structuredClone([top,panel]);
  const area = canvasContentArea(canvas,[top,panel]); bounded(area);
  assert(area.y >= 214); assert.equal(area.y,214); assert(!intersects(area,panel));
  assert.deepEqual([top,panel],input);
});

test('minimap and footer share a bounded fit/center region without deducting entire minimap height', () => {
  const top=rect(22,118,600,45,'top'), map=rect(598,451,136,78,'obstacle'), footer=rect(20,543,714,36,'bottom');
  const area=canvasContentArea(canvas,[top,map,footer]); bounded(area);
  assert(!intersects(area,map)); assert(!intersects(area,footer)); assert(area.y+area.height <= 531);
  assert(area.y+area.height > 451); // largest region uses the space beside the map
});

test('actual expanded-history geometry prefers a tall clear side for a 304x454 card, a broad bottom for wide content', () => {
  // Screenshot phase7e-layout-details-1280.png: centered 360px history,
  // a 136x78 minimap and the footer leave a wide short bottom and tall right.
  const overlays=[rect(22,118,483,45,'top'),rect(147,170,358,180,'obstacle'),rect(598,451,136,78,'obstacle'),rect(20,543,714,36,'bottom')];
  const before=structuredClone(overlays), tallSize={width:304,height:454}, wideSize={width:1000,height:300};
  const legacy=canvasContentArea(canvas,overlays), tall=canvasContentArea(canvas,overlays,tallSize), wide=canvasContentArea(canvas,overlays,wideSize);
  assert.deepEqual(legacy,{x:32,y:362,width:554,height:169});
  assert.deepEqual(tall,{x:517,y:181,width:205,height:258});
  assert.deepEqual(wide,legacy);
  assert(tall.width*tall.height < legacy.width*legacy.height); // area alone chose the wrong region
  assert(Math.min(tall.width/304,tall.height/454) > .56);
  assert(Math.min(legacy.width/304,legacy.height/454) < .38);
  for(const area of [legacy,tall,wide]) { bounded(area); for(const overlay of overlays) assert(!intersects(area,overlay)); }
  assert.deepEqual(overlays,before); assert.deepEqual(tallSize,{width:304,height:454});
});

test('invalid optional content dimensions preserve the legacy maximum-area ranking', () => {
  const overlays=[rect(22,118,483,45,'top'),rect(147,170,358,180,'obstacle')], expected=canvasContentArea(canvas,overlays);
  for(const size of [null,{}, {width:0,height:454},{width:304,height:-1},{width:Infinity,height:454},{width:'304',height:454},{width:304,height:NaN}]) assert.deepEqual(canvasContentArea(canvas,overlays,size),expected);
});

test('hidden/off-canvas rectangles do not consume space', () => {
  const toolbar=rect(22,118,500,45,'top'), hidden=rect(0,0,0,0,'top'), outside=rect(800,0,100,100,'obstacle');
  assert.deepEqual(canvasContentArea(canvas,[toolbar,hidden,outside]),canvasContentArea(canvas,[toolbar]));
});

test('very short canvas and fully covered canvas never invent a 100px region', () => {
  const small={left:0,top:0,right:70,bottom:35,width:70,height:35};
  const area=canvasContentArea(small,[{left:0,top:0,right:70,bottom:35,width:70,height:35,kind:'top'}]);
  assert.equal(area.height,0); assert(area.y+area.height<=35); assert(area.x+area.width<=70);
  const full=canvasContentArea(canvas,[rect(0,0,754,596,'obstacle')]);
  assert.equal(full.width*full.height,0); bounded(full);
});

test('multiple partial obstacles leave a clear region and negative world coordinates are unrelated', () => {
  const overlays=[rect(10,10,700,45,'top'),rect(500,100,220,190,'obstacle'),rect(600,450,136,78,'obstacle'),rect(20,543,714,36,'bottom')];
  const area=canvasContentArea(canvas,overlays); bounded(area);
  for(const overlay of overlays) assert(!intersects(area,overlay));
});

test('unexpected chrome count is bounded without silently ignoring the later obstacles', () => {
  const area=canvasContentArea(canvas,Array.from({length:9},(_,index)=>rect(index*20,80,10,10,'obstacle')));
  assert.equal(area.width*area.height,0); bounded(area);
});

test('chrome offsets follow actual banner/toolbar height, including wrapped controls', () => {
  const top=rect(22,17,700,34), actions=rect(22,66,680,88);
  assert.deepEqual(canvasChromeOffsets(canvas,{topline:top,actions}),{actionTop:63,workflowTop:159});
  assert.deepEqual(canvasChromeOffsets(canvas,{topline:top,banner:rect(22,64,700,80),actions}),{actionTop:156,workflowTop:252});
  assert.deepEqual(canvasChromeOffsets(canvas,{topline:top,banner:rect(22,64,0,0),actions}),{actionTop:63,workflowTop:159});
});

const descendants = item => [item,...item.children.flatMap(descendants)];
class Element {
  constructor(tag) { Object.assign(this,{tagName:tag,children:[],listeners:{},className:'',hidden:false,open:false,dataset:{},textContent:'',rect:rect(22,118,620,45)}); const values=new Map(); this.style={getPropertyValue:name=>values.get(name)||'',setProperty:(name,value)=>values.set(name,value)}; }
  append(...items) { for(const item of items) { item.parentElement=this; this.children.push(item); } }
  replaceChildren(...items) { this.children=[]; this.append(...items); }
  addEventListener(event,fn) { this.listeners[event]=fn; }
  closest(selector) { for(let item=this;item;item=item.parentElement) if(item.matches(selector)) return item; return null; }
  matches(selector) { return selector.startsWith('#') ? this.id===selector.slice(1) : selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tagName===selector; }
  querySelectorAll(selector) { const parts=selector.split(','); return descendants(this).slice(1).filter(item=>parts.some(part=>item.matches(part))); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
  getBoundingClientRect() { return this.rect; }
  getClientRects() { for(let item=this;item;item=item.parentElement) if(item.hidden) return []; return [this.rect]; }
}
function withDOM(fn,{status='completed',damaged=false,hostOverrides={}}={}) {
  const names=['document','localStorage','requestAnimationFrame','cancelAnimationFrame','ResizeObserver','MutationObserver'], old=Object.fromEntries(names.map(name=>[name,globalThis[name]]));
  const shell=new Element('section'); shell.className='canvas-shell'; shell.rect=canvas;
  const surface=new Element('div'); surface.id='canvas'; surface.rect=canvas;
  const top=new Element('div'); top.className='canvas-topline'; top.rect=rect(22,17,710,34);
  const actions=new Element('div'); actions.className='canvas-action-bar'; actions.rect=rect(22,66,680,44);
  const banner=new Element('div'); banner.className='discovery-banner'; banner.rect=rect(22,64,710,50); banner.hidden=true;
  shell.append(top,banner,actions,surface);
  const body=new Element('body'); body.append(shell);
  const frames=new Map(); let frameId=0; const observers=[];
  class Observer { constructor(fn){this.fn=fn;this.targets=[];this.disconnected=false;observers.push(this);} observe(item){this.targets.push(item);} disconnect(){this.disconnected=true;} }
  const node={...createNode('generation',0,0,{kind:'sdxl',title:'预设出图'}),id:'target'}, graph={nodes:[node],edges:[]};
  const record={schema:'frameweave.workflow-run.v1',id:'run',canvas_id:'one',backend:'http://127.0.0.1:8188',status,target_ids:['target'],graph,steps:[{node_id:'target',state:status==='completed'?'completed':'failed',job_id:'job',job_status:'completed',request_id:'11111111-1111-1111-1111-111111111111',request:{kind:'sdxl'},...(status==='failed'?{error:'缺失模型'}:{})}],...(status==='failed'?{error:'缺失模型'}:{})};
  const storage=new Map([['frameweave.workflow-run.v1',damaged?'broken':JSON.stringify(record)]]), errors=[]; let identity='one',calls=0;
  globalThis.document={body,createElement:tag=>new Element(tag),querySelector:selector=>body.querySelector(selector),querySelectorAll:selector=>body.querySelectorAll(selector)};
  globalThis.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  globalThis.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;}; globalThis.cancelAnimationFrame=id=>frames.delete(id);
  globalThis.ResizeObserver=Observer; globalThis.MutationObserver=Observer;
  const controller=createWorkflowCanvas({api:async()=>{calls++;throw Error('不允许请求');},graph:()=>graph,canvasIdentity:()=>identity,selectedIds:()=>[],reportError:error=>errors.push(error),downloadJSON(){},...hostOverrides});
  const flush=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
  const cleanup=()=>{ controller.destroyLayout(); for(const name of names) if(old[name]===undefined) delete globalThis[name]; else globalThis[name]=old[name]; };
  let result;
  try { controller.init(); flush(); result=fn({controller,surface,shell,top,actions,banner,body,observers,frames,errors,storage,flush,setIdentity:value=>identity=value,get calls(){return calls;}}); }
  catch(error) { cleanup(); throw error; }
  if(result?.then) return result.finally(cleanup);
  cleanup(); return result;
}
const text = item => descendants(item).map(child=>child.textContent).join(' ');

test('actual controller keeps completed state compact in the existing toolbar, no new overlay or jobs', () => withDOM(h=>{
  const toolbar=h.surface.querySelector('.workflow-canvas-toolbar'), panel=h.surface.querySelector('.workflow-run-panel');
  assert.equal(panel.tagName,'details'); assert.equal(panel.parentElement,toolbar); assert.equal(panel.open,false);
  assert.match(text(panel.querySelector('summary')),/全部完成.*1\/1 步/);
  assert(!text(panel.querySelector('summary')).includes('等待'));
  assert.match(text(panel.querySelector('.workflow-run-details')),/运行步骤与恢复.*预设出图.*清除运行记录/);
  assert.equal(h.calls,0); assert.equal(h.errors.length,0);
}));

test('closed menu and run details have an explicit display-none rule, independently of browser details layout', async () => {
  const css=await readFile(new URL('../web/workflow-canvas.css',import.meta.url),'utf8');
  assert.match(css,/\.workflow-canvas-menu:not\(\[open\]\)>\.workflow-menu-actions\s*,\s*\.workflow-run-panel:not\(\[open\]\)>\.workflow-run-details\s*\{\s*display:none;\s*\}/);
  withDOM(h=>{
    const panel=h.surface.querySelector('.workflow-run-panel'), menu=h.surface.querySelector('.workflow-canvas-menu');
    assert.equal(panel.open,false); assert.equal(menu.open,false);
    panel.open=true; h.setIdentity('two'); h.controller.refresh(); h.flush();
    assert.equal(panel.open,true); assert(panel.querySelector('.workflow-run-details')); assert.equal(h.calls,0);
  });
});

test('actual controller preserves expanded history across canvas changes, including recovery identity note', () => withDOM(h=>{
  const panel=h.surface.querySelector('.workflow-run-panel'); panel.open=true;
  h.setIdentity('two'); h.controller.refresh(); h.flush();
  assert.equal(panel.open,true); assert.match(text(panel.querySelector('summary')),/其他画布/);
  assert.match(text(panel.querySelector('.workflow-run-details')),/属于另一张画布/); assert.equal(h.calls,0);
}));

test('failed state puts full error and restore controls in expandable history, not an extra panel', () => withDOM(h=>{
  const panel=h.surface.querySelector('.workflow-run-panel');
  assert.equal(panel.open,false); assert.match(text(panel.querySelector('summary')),/任务失败/);
  assert(!text(panel.querySelector('summary')).includes('缺失模型'));
  assert.match(text(panel.querySelector('.workflow-run-details')),/缺失模型.*查询并继续/); assert.equal(h.calls,0);
},{status:'failed'}));

test('new preparation failure opens its reason once, keeps old run, and allows manual collapse', () => withDOM(async h=>{
  const panel=h.surface.querySelector('.workflow-run-panel'), original=h.storage.get('frameweave.workflow-run.v1');
  assert.equal(panel.open,false);
  await assert.rejects(h.controller.run(['target']),/本地推理引擎未连接/);
  assert.equal(panel.open,true); assert.equal(panel.hidden,false);
  assert.match(text(panel.querySelector('.workflow-run-error')),/本地推理引擎未连接/);
  assert.match(text(panel.querySelector('summary')),/未开始生成/);
  panel.open=false; h.controller.refresh(); h.flush(); assert.equal(panel.open,false);
  h.setIdentity('two'); h.controller.refresh(); h.setIdentity('one'); h.controller.refresh();
  assert.equal(panel.open,false);
  await assert.rejects(h.controller.run(['target']),/本地推理引擎未连接/);
  assert.equal(panel.open,true); assert.equal(h.calls,0);
  assert.equal(h.storage.get('frameweave.workflow-run.v1'),original);
},{hostOverrides:{engine:()=>({online:false,backend_url:'http://127.0.0.1:8188'})}}));

test('preparation failing after canvas navigation does not open another canvas history', () => {
  let release; const preparing=new Promise(resolve=>{release=resolve;});
  return withDOM(async h=>{
    const panel=h.surface.querySelector('.workflow-run-panel'), pending=h.controller.run(['target']);
    h.setIdentity('two'); h.controller.refresh(); release();
    await assert.rejects(pending,/准备期间画布/);
    assert.equal(panel.open,false); assert.equal(h.calls,0);
    assert(!text(panel).includes('准备期间画布'));
  },{hostOverrides:{engine:()=>({online:true,backend_url:'http://127.0.0.1:8188'}),prepareBackend:()=>preparing}});
});

test('damaged record is preserved with compact recovery entry and does not send requests', () => withDOM(h=>{
  const panel=h.surface.querySelector('.workflow-run-panel'); assert.equal(panel.hidden,false); assert.equal(panel.open,false);
  assert.match(text(panel.querySelector('summary')),/暂不可读取/); assert.match(text(panel.querySelector('.workflow-run-details')),/导出原运行记录/);
  assert.equal(h.storage.get('frameweave.workflow-run.v1'),'broken'); assert.equal(h.calls,0); assert.equal(h.errors.length,1);
},{damaged:true}));

test('actual controller measures sibling chrome, observes wrap/visibility, and never modifies graph or viewport', () => withDOM(h=>{
  assert.equal(h.shell.style.getPropertyValue('--canvas-action-top'),'63px');
  assert.equal(h.shell.style.getPropertyValue('--workflow-toolbar-top'),'115px');
  assert(h.observers[0].targets.includes(h.actions)); assert(h.observers[0].targets.includes(h.surface));
  h.actions.rect=rect(22,66,680,88); h.banner.hidden=false;
  h.observers[0].fn(); h.observers[1].fn(); assert.equal(h.frames.size,1); h.flush();
  assert.equal(h.shell.style.getPropertyValue('--canvas-action-top'),'126px');
  assert.equal(h.shell.style.getPropertyValue('--workflow-toolbar-top'),'222px');
  const count=descendants(h.surface).filter(item=>item.className==='workflow-canvas-toolbar').length;
  h.controller.init(); h.flush(); assert.equal(descendants(h.surface).filter(item=>item.className==='workflow-canvas-toolbar').length,count);
  h.controller.destroyLayout(); assert(h.observers.every(observer=>observer.disconnected)); assert.equal(h.frames.size,0); assert.equal(h.calls,0);
}));
