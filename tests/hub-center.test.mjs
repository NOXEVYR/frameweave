import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubCenter, eligibleHubField, profileFromOffer } from '../web/hub-center.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.value = ''; this.disabled = false; this._text = ''; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child); child.parentElement = this; this.children.push(child); } }
  replaceChildren(...children) { this.children.forEach(child => child.parentElement = null); this.children = []; this.append(...children); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  emit(name) { for (const handler of this.events[name] || []) handler({target: this}); }
  click() { if (!this.disabled) this.emit('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || selector === child.tagName || selector === '[data-hub-mutation]' && child.dataset.hubMutation); }
}
const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const offerFixture = () => ({schema:'prismcanvas.hub-offer/1', backend:'http://127.0.0.1:8188',
  binding_sha256:'a'.repeat(64), template:{kind:'package',package_id:'p-test',values:{prompt:'private default'}},
  bindings:{input_1:['values','prompt']}, mapping:[{input:'input_1',label:'提示词',type:'text'}],notice:'已准备',
  declaration:{key:'prism.test',kind:'mcp_tool',domains:['image'],name:'Public',
    inputs:{type:'object',properties:{input_1:{type:'string',maxLength:12000}},required:[],additionalProperties:false},
    constraints:[`prismcanvas-binding-sha256:${'a'.repeat(64)}`]}});
function fixture(t, initial={}) {
  const body = new Element('body'), timers = new Set();
  const old = ['document','setInterval','clearInterval'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis,key)]);
  Object.defineProperty(globalThis,'document',{configurable:true,value:{body,hidden:false,createElement:tag=>new Element(tag)}});
  globalThis.setInterval = callback => { timers.add(callback); return callback; };
  globalThis.clearInterval = callback => timers.delete(callback);
  t.after(() => { for (const [key, descriptor] of old) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } });
  const state = {configured:false,enabled:false,busy:false,capabilities:[],executions:{items:[],has_more:false,next_after_execution_id:null},...initial};
  const calls = [], errors = [], downloads = [], handlers = new Map();
  const host = { api: async (path, data) => { calls.push([path,clone(data)]); return handlers.has(path) ? handlers.get(path)(data) : clone(state); },
    selectedRequest:async()=>({request:{kind:'package',package_id:'p-test',values:{prompt:'private default'}},title:'Example',backend_url:'http://127.0.0.1:8188',
      fields:[{id:'prompt',label:'提示词',type:'text'},{id:'image',label:'参考图',type:'image'}]}),
    reportError:error=>errors.push(error), downloadJSON:(data,name)=>downloads.push({data,name}) };
  const center = createHubCenter(host);
  t.after(()=>center.close());
  const nodes = () => body.querySelectorAll('*');
  return {center,body,state,calls,errors,handlers,downloads,timers,
    button:label=>nodes().find(item=>item.tagName==='button'&&item.textContent===label),
    field:id=>nodes().find(item=>item.dataset.fieldId===id),
    input:label=>nodes().find(item=>item.tagName==='label'&&item._text===label)?.children[0],
    file:()=>nodes().find(item=>item.type==='file')};
}

test('opening is local-only, fixed close is outside scroll and no grant is fetched',async t=>{
  const ui=fixture(t); await ui.center.open();
  assert.deepEqual(ui.calls.map(([path])=>path),['/api/hub-connection']);
  const close=ui.button('×'); assert.equal(close.parentElement.className,'modal-heading');
  assert.equal(ui.button('启用已开放能力，自动接收任务').disabled,true);
  assert.equal(ui.timers.size,1); close.click(); assert.equal(ui.timers.size,0);
});

test('wizard requires selected fields, keeps media fixed and exports declaration only',async t=>{
  const ui=fixture(t,{configured:true}); const offer=offerFixture();
  ui.handlers.set('/api/hub-connection/prepare-offer',()=>offer);
  await ui.center.open(); ui.button('读取画布选中的工作流').click(); await tick();
  assert.equal(ui.field('image').disabled,true); assert.equal(ui.field('prompt').checked,false);
  ui.button('校验并准备能力声明').click(); await tick(); assert.equal(ui.errors.length,1);
  ui.field('prompt').checked=true; ui.field('prompt').emit('change');
  ui.button('校验并准备能力声明').click(); await tick();
  ui.button('导出公开能力声明').click(); await tick();
  assert.deepEqual(ui.downloads[0].data,[offer.declaration]);
  assert.doesNotMatch(JSON.stringify(ui.downloads),/private default|127\.0\.0\.1|template|bindings/);
  assert.match(ui.body.textContent,/保留已有声明/);
  assert.equal(ui.calls.filter(([path])=>path.endsWith('/enabled')||path.endsWith('/step')).length,0);
});

test('changing fields during prepare discards the stale offer',async t=>{
  const ui=fixture(t,{configured:true}); let resolve;
  ui.handlers.set('/api/hub-connection/prepare-offer',()=>new Promise(r=>resolve=r));
  await ui.center.open(); ui.button('读取画布选中的工作流').click(); await tick();
  ui.field('prompt').checked=true; ui.field('prompt').emit('change');
  ui.button('校验并准备能力声明').click(); await tick();
  ui.input('对外能力名称').value='changed'; ui.input('对外能力名称').emit('input');
  resolve(offerFixture()); await tick(); assert.equal(ui.button('导出公开能力声明').disabled,true);
});

test('pause remains usable while a worker operation is busy and error is readable',async t=>{
  const ui=fixture(t,{configured:true,enabled:true,busy:true,last_error:{code:'x',message:'检查原 Hub 服务'}});
  ui.handlers.set('/api/hub-connection/enabled',data=>{assert.equal(data.enabled,false);ui.state.enabled=false;return clone(ui.state);});
  await ui.center.open(); assert.match(ui.body.textContent,/检查原 Hub 服务/); assert.doesNotMatch(ui.body.textContent,/object Object/);
  const pause=ui.button('暂停接收与调度'); assert.equal(pause.disabled,false); pause.click(); await tick();
  assert.equal(ui.state.enabled,false); assert.equal(ui.calls.filter(([path])=>path.endsWith('/enabled')).length,1);
});

test('closing during initial status request leaves no polling timer',async t=>{
  const ui=fixture(t); let resolve;
  ui.handlers.set('/api/hub-connection',()=>new Promise(r=>resolve=r));
  const opening=ui.center.open(); ui.center.close(); resolve(clone(ui.state)); await opening;
  assert.equal(ui.timers.size,0);
});

test('older running backend explains missing feature without presenting it as a failed Hub connection',async t=>{
  const ui=fixture(t);ui.handlers.set('/api/hub-connection',()=>{throw Object.assign(new Error('not found'),{status:404});});
  await assert.rejects(ui.center.open(),/尚未加载接入功能/);
  assert.match(ui.body.textContent,/仅刷新页面不会更新后台/);
  assert.equal(ui.button('启用已开放能力，自动接收任务').disabled,true);assert.equal(ui.timers.size,0);
  assert.equal(ui.button('×').disabled,false);
});

test('inbox and local recovery pagination are bounded and do not claim on read',async t=>{
  const ui=fixture(t,{configured:true}); let inboxCalls=0;
  ui.handlers.set('/api/hub-connection/inbox',data=>{assert.equal(data.limit,10);inboxCalls++;if(inboxCalls===2)assert.equal(data.after_execution_id,'first');return{items:[{execution_id:'first',capability_id:'cap',dispatch_state:'queued_ready'}],has_more:inboxCalls===1,next_after_execution_id:inboxCalls===1?'first':null};});
  ui.handlers.set('/api/hub-connection/executions',data=>({items:[{execution_id:data.after_execution_id?'second':'first',state:'running',finished:false}],has_more:!data.after_execution_id,next_after_execution_id:data.after_execution_id?null:'first'}));
  await ui.center.open();ui.button('查看待处理任务').click();await tick();
  assert.equal(ui.button('接收并推进此任务').disabled,true);ui.button('下一页').click();await tick();
  assert.equal(ui.button('下一页').disabled,true);
  ui.button('刷新本机记录').click();await tick();ui.button('下一页记录').click();await tick();
  assert.match(ui.body.textContent,/second · running/);assert.equal(ui.button('下一页记录').disabled,true);
  assert.equal(ui.calls.filter(([path])=>path.endsWith('/step')).length,0);
});

test('grant import uses file content once, clears the picker and remains paused',async t=>{
  const ui=fixture(t);ui.handlers.set('/api/hub-connection/grant',data=>{assert.equal(data.grant_json,'{"token":"private"}');ui.state.configured=true;return clone(ui.state);});
  await ui.center.open();const file=ui.file();file.files=[{size:19,text:async()=>'\u007b"token":"private"}'}];file.value='private.json';file.emit('change');await tick();
  assert.equal(file.value,'');assert.equal(ui.state.enabled,false);assert.doesNotMatch(ui.body.textContent,/private/);
  file.files=[{size:32769,text:async()=>{throw Error('must not read');}}];file.emit('change');await tick();
  assert.match(ui.errors.at(-1).message,/32 KiB/);assert.equal(ui.calls.filter(([path])=>path.endsWith('/grant')).length,1);
});

test('published declaration must retain the same input schema and frozen binding',()=>{
  const offer=offerFixture(),remote={capability_id:'b'.repeat(32),declaration_text:JSON.stringify(offer.declaration)};
  const profile=profileFromOffer(offer,remote);assert.equal(profile.enabled,false);assert.equal(profile.template.values.prompt,'private default');
  for(const mutate of [d=>d.inputs.properties.input_1.maxLength=64000,d=>d.domains=['video'],d=>d.constraints=[],d=>d.key='other']){
    const declaration=clone(offer.declaration);mutate(declaration);
    assert.throws(()=>profileFromOffer(offer,{...remote,declaration_text:JSON.stringify(declaration)}),/不一致/);
  }
  const reordered=clone(offer.declaration);reordered.inputs={additionalProperties:false,required:[],properties:reordered.inputs.properties,type:'object'};
  assert.doesNotThrow(()=>profileFromOffer(offer,{...remote,declaration_text:JSON.stringify(reordered)}));
  assert.equal(eligibleHubField({type:'select',options:['a',1]}),false);
  assert.equal(eligibleHubField({type:'select',options:[Infinity]}),false);
});
