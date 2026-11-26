import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { liveProgressText, elapsedText, previewStatusText, updateLiveProgress } from '../web/job-progress.mjs';
import { isJobActive, jobStatusLabel, jobStateDetail } from '../web/job-state.mjs';

test('sampling reports actual node steps and marks retained records during reconnect', () => {
  const job = { status: 'running', stage: '采样中', execution_node: 'sampler', step: 5, steps: 20, progress_connected: true };
  assert.match(liveProgressText(job), /节点 sampler · 5 \/ 20 步/);
  assert.doesNotMatch(liveProgressText(job), /上次进度/);
  assert.match(liveProgressText({ ...job, progress_stale: true }), /上次进度.*等待后端新进度事件/);
  assert.match(liveProgressText({ ...job, progress_connected: false }), /上次进度.*实时通道未连接/);
  assert.match(liveProgressText({ ...job, preview_url: '/preview', preview_stale: true }), /预览为上次接收/);
});

test('queued tasks still expose disconnected transport and no fabricated percentage', () => {
  const label = liveProgressText({ status: 'queued', progress_connected: false });
  assert.match(label, /等待引擎执行.*实时通道未连接/);
  assert.doesNotMatch(label, /%/);
});

test('early execution events do not claim the task is still waiting to start a preview', () => {
  for (const execution of [{ execution_node: '2' }, { execution_nodes: ['2', '3'] }]) {
    assert.match(previewStatusText({ status: 'queued', ...execution }), /已报告执行节点/);
    assert.doesNotMatch(previewStatusText({ status: 'queued', ...execution }), /排队中/);
  }
  assert.match(previewStatusText({ status: 'queued', execution_nodes: [] }), /排队中/);
  assert.match(previewStatusText({ status: 'completed', execution_node: '2', outputs: [{}] }), /生成已完成/);
});

test('elapsed formats backend duration and guards invalid records', () => {
  assert.equal(elapsedText({ elapsed: 65.9 }), '累计耗时 1 分 5 秒');
  assert.equal(elapsedText({ elapsed: 0, status: 'queued' }), '排队耗时 0 分 0 秒');
  assert.equal(elapsedText({ elapsed: 5, started_at: 1, status: 'running' }), '执行耗时 0 分 5 秒');
  for (const elapsed of [undefined, NaN, Infinity, -1, '65']) assert.equal(elapsedText({ elapsed }), '耗时待同步');
});

test('queue rank, node label and missing preview explain actual state', () => {
  assert.match(liveProgressText({status:'queued',queue_position:2}), /待执行队列第 2 位/);
  assert.match(liveProgressText({status:'running',execution_node:'9',execution_label:'视频解码'}), /节点 9（视频解码）/);
  assert.match(previewStatusText({status:'running'}), /后端尚未提供/);
  assert.match(previewStatusText({preview_url:'/p',preview_stale:true}), /上次收到/);
});

test('step events retain the same image, stale marking and failed frames recover on next preview', () => {
  const attributes = new Map(), classes = new Set(); let loads=0;
  const image = {hidden:true,getAttribute:key=>attributes.get(key),removeAttribute:key=>attributes.delete(key),set src(value){attributes.set('src',value);loads++;}};
  const bar = {classList:{toggle(key,on){if(on)classes.add(key);else classes.delete(key);}},setAttribute(key,value){this[key]=value;},removeAttribute(key){delete this[key];}};
  const elements={image,bar,detail:{},caption:{}};
  const job={status:'running',progress:25,step:1,steps:4,stage:'采样中',progress_connected:true,preview_url:'/preview?v=1'};
  updateLiveProgress(elements,job);
  updateLiveProgress(elements,{...job,progress:50,step:2});
  assert.equal(loads,1);assert.equal(bar.value,50);assert.match(bar['aria-valuetext'],/2 \/ 4/);
  image.onerror();assert.equal(image.hidden,true);
  updateLiveProgress(elements,{...job,progress_stale:true});
  assert.equal(image.hidden,true);assert.equal(classes.has('is-stale'),true);assert.match(elements.caption.textContent,/暂不可用/);
  updateLiveProgress(elements,{...job,preview_url:'/preview?v=2'});
  image.onload();assert.equal(image.hidden,false);assert.equal(loads,2);
  updateLiveProgress(elements,{...job,preview_url:null,progress:null});
  assert.equal(image.hidden,true);assert.equal(attributes.has('src'),false);assert.equal('value' in bar,false);
});

test('a newly queued task without any preview can update before its first frame', () => {
  const attrs = new Map();
  const image = { hidden: false, getAttribute: key => attrs.get(key), removeAttribute: key => attrs.delete(key), set src(value) { attrs.set('src', value); } };
  const bar = { classList: { toggle() {} }, setAttribute() {}, removeAttribute(key) { delete this[key]; } };
  const elements = { image, bar, detail: {}, caption: {} };
  updateLiveProgress(elements, { status: 'queued', queue_position: 1 });
  assert.equal(image.hidden, true);
  assert.match(elements.detail.textContent, /队列第 1 位/);
  updateLiveProgress(elements, { status: 'running', step: 1, steps: 2, progress: 50 });
  assert.equal(bar.value, 50);
  assert.equal(image.hidden, true);
  updateLiveProgress(elements, { status: 'running', preview_url: '/first-frame' });
  assert.equal(attrs.get('src'), '/first-frame');
  assert.equal(image.hidden, false);
});

function elements() {
  const attrs=new Map(),classes=new Set();
  const image={hidden:true,getAttribute:key=>attrs.get(key),removeAttribute:key=>attrs.delete(key),set src(value){attrs.set('src',value);}};
  const bar={classList:{toggle(key,on){if(on)classes.add(key);else classes.delete(key);}},setAttribute(key,value){this[key]=value;},removeAttribute(key){delete this[key];}};
  return {image,bar,detail:{},caption:{},attrs,classes};
}

for(const status of ['completed','failed','cancelled']){
  test(`${status} overrides retained stage, transport and sampling labels consistently`,()=>{
    const job={status,stage:'执行结束，等待结果确认',step:2,steps:4,progress:50,cached_nodes:2,preview_url:'/preview',
      progress_connected:false,progress_stale:true,preview_stale:true,progress_identity_unknown:true,client_connection_lost:true,
      started_at:1,elapsed:2,outputs:status==='completed'?[{type:'video'}]:[]};
    const ui=elements();updateLiveProgress(ui,job);
    assert.equal(ui.detail.textContent,liveProgressText(job));assert.equal(ui.caption.textContent,previewStatusText(job));
    assert.doesNotMatch(ui.detail.textContent+ui.caption.textContent+ui.bar['aria-valuetext'],/等待|重连|采样|后端尚未提供|缓存|旧任务|上次|正在查询/);
    assert.equal(ui.image.hidden,true);assert.equal(ui.attrs.has('src'),false);assert.equal(ui.bar.hidden,true);assert.equal(ui.classes.has('is-stale'),false);
    if(status==='completed')assert.equal(ui.bar.value,100);else assert.equal('value'in ui.bar,false,'failed/cancelled must not fabricate completion');
  });

  test(`${status} rejects both late preview callback kinds from a running frame`,()=>{
    const ui=elements(),running={status:'running',preview_url:'/same-preview',progress:10};
    updateLiveProgress(ui,running);const lateLoad=ui.image.onload,lateError=ui.image.onerror;
    lateError();assert.match(ui.caption.textContent,/等待下一帧/);
    updateLiveProgress(ui,{...running,status,outputs:[{type:'image'}]});
    const caption=ui.caption.textContent;lateLoad();lateError();
    assert.equal(ui.caption.textContent,caption);assert.equal(ui.image.hidden,true);assert.equal(ui.attrs.has('src'),false);
    assert.equal(ui.image.onload,null);assert.equal(ui.image.onerror,null);
  });
}

test('completed without outputs explains missing final products without waiting for intermediate frames',()=>{
  assert.match(previewStatusText({status:'completed',outputs:[]}),/没有可预览产物.*输出节点/);
  const ui=elements();updateLiveProgress(ui,{status:'completed'});updateLiveProgress(ui,{status:'queued'});
  assert.equal(ui.bar.hidden,false);assert.match(ui.detail.textContent,/等待引擎执行/);
});

test('real canvas updater clears terminal DOM and intermediate frame events before hiding the live section',async()=>{
  const app=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
  const code=app.slice(app.indexOf('function updateNodeJobStatus('),app.indexOf('function jobTitle('));
  const ui=elements(),live={dataset:{liveNode:'target'},querySelector:selector=>({'.live-detail':ui.detail,'progress':ui.bar,'.live-preview':ui.image,'.live-preview-status':ui.caption})[selector]};
  const status={dataset:{nodeStatus:'target'},classList:{toggle(){}}};
  const sandbox={jobs:[{id:'job',status:'running',preview_url:'/frame',progress:25,elapsed:1}],jobNodes:{job:'target'},
    document:{querySelectorAll:selector=>selector==='[data-live-node]'?[live]:selector==='[data-node-status]'?[status]:[]},
    updateLiveProgress,isJobActive,jobStatusLabel,jobStateDetail,STATUS_NAMES:{completed:'已完成',running:'生成中',failed:'失败',cancelled:'已取消'},duration:seconds=>`${seconds}s`};
  vm.runInNewContext(code,sandbox);sandbox.updateNodeJobStatus();const lateError=ui.image.onerror;
  sandbox.jobs[0]={...sandbox.jobs[0],status:'completed',stage:'执行结束，等待结果确认',cached_nodes:2,outputs:[{type:'video'}]};
  sandbox.updateNodeJobStatus();lateError();
  assert.equal(live.hidden,true);assert.match(status.textContent,/✓ 已完成/);
  assert.equal(ui.detail.textContent,'任务已完成');assert.doesNotMatch(ui.caption.textContent,/等待|尚未提供/);assert.equal(ui.image.hidden,true);
});
