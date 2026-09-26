/** Durable, sequential canvas orchestration. No model runtime or UI dependencies. */
import { executionOrder, generationPayload, parseGraph, serializeGraph } from './graph.mjs';

export const RUN_SCHEMA = 'frameweave.workflow-run.v1';
const copy = value => value === null || value === undefined ? value : JSON.parse(JSON.stringify(value));
const terminal = new Set(['completed', 'failed', 'cancelled']);
const stepStates = new Set(['pending', 'preparing', 'submitting', 'uncertain', 'running', 'completed', 'failed']);
const unsettled = state => state?.steps.some(step => ['submitting', 'uncertain'].includes(step.state) || step.job_id && !terminal.has(step.job_status));
const validateCanvasId = value => { if (value !== undefined && (typeof value !== 'string' || value.length > 120)) throw new Error('画布关联标识必须是不超过 120 个字符的字符串'); };
const normalizeBackend = value => {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请先连接本地推理引擎');
  const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('推理引擎地址无效');
  return url.href.replace(/\/$/, '');
};
class Pause extends Error {}
class StorageFailure extends Pause {}
class Failure extends Error {}

/** load is synchronous; save may be synchronous or return a promise. */
export function createWorkflowRunner({ api, load = () => null, save, onChange = () => {}, onJob = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (typeof api !== 'function' || typeof save !== 'function') throw new Error('工作流执行器需要 api 与持久保存回调');
  let state = null, busy = false, stopped = false, wake = null, saveQueue = Promise.resolve();
  const loaded = load();
  if (loaded && typeof loaded.then === 'function') throw new Error('工作流记录 load 必须同步返回');
  if (loaded) {
    state = copy(loaded);
    if (state.schema !== RUN_SCHEMA || !Array.isArray(state.steps) || !state.graph || !Array.isArray(state.target_ids)) throw new Error('工作流运行记录格式无效，请保留记录检查后恢复');
    validateCanvasId(state.canvas_id);
    state.graph = parseGraph(serializeGraph(state.graph));
    const order = executionOrder(state.graph, state.target_ids);
    if (order.length !== state.steps.length || state.steps.some((step, index) => step.node_id !== order[index] || !stepStates.has(step.state))) throw new Error('工作流运行记录的步骤顺序无效');
    state.backend = normalizeBackend(state.backend);
    for (const step of state.steps) {
      if (['submitting', 'uncertain', 'running', 'completed'].includes(step.state) && (!/^[\da-f-]{36}$/i.test(step.request_id || '') || !step.request || typeof step.request !== 'object')) throw new Error('工作流记录缺少原始请求证据，不能自动重建提交');
      if (['running', 'completed'].includes(step.state) && !step.job_id) throw new Error('工作流记录缺少已受理的任务 ID');
      step.image_inputs ||= {};
    }
    if (!['completed', 'failed'].includes(state.status) || unsettled(state)) { state.status = 'paused'; state.error = '已恢复运行记录；点击查询并继续后才会执行。'; }
  }
  const snapshot = () => copy(state);
  const notify = () => { try { Promise.resolve(onChange(snapshot())).catch(() => {}); } catch { /* UI observers cannot change submission identity. */ } };
  const observeJob = (step, job) => { try { Promise.resolve(onJob(step.node_id, copy(job))).catch(() => {}); } catch { /* Core evidence was persisted first. */ } };
  async function persist() {
    if (state) state.updated_at = new Date().toISOString();
    const record = snapshot(); notify();
    const operation = saveQueue.catch(() => {}).then(() => save(record)); saveQueue = operation;
    try { await operation; } catch (error) { throw new StorageFailure(`无法保存工作流运行记录：${error?.message || error}。已停止后续调度，保留原请求 ID。`); }
  }
  function guardStop() { if (stopped) throw new Pause('已停止后续调度；当前任务保留，可稍后查询并继续。'); }
  async function checkBackend() {
    guardStop();
    let status;
    try { status = await api('/api/status'); } catch (error) { throw new Pause(`无法确认当前推理引擎：${error.message}`); }
    guardStop();
    if (!status?.online) throw new Pause('推理引擎未连接或状态响应无效，已暂停工作流。');
    let backend;
    try { backend = normalizeBackend(status.backend_url); } catch { throw new Pause('当前服务未提供有效的推理引擎身份，已暂停工作流。'); }
    if (backend !== state.backend) throw new Pause('推理引擎已切换；请恢复原引擎后查询并继续，不能向新引擎重发。');
  }
  async function delay() {
    let resolveStop;
    const interruption = new Promise(resolve => { resolveStop = resolve; wake = resolve; });
    try { await Promise.race([wait(2000), interruption]); } finally { if (wake === resolveStop) wake = null; }
    guardStop();
  }
  function upstreamFor(edge) {
    const source = state.graph.nodes.find(node => node.id === edge.source);
    if (source?.type === 'generation') return source.id;
    if (source?.type !== 'result') return null;
    const candidates = state.graph.edges.filter(item => item.target === source.id).map(item => state.graph.nodes.find(node => node.id === item.source)).filter(node => node?.type === 'generation');
    if (candidates.length !== 1) throw new Failure('图片结果节点必须连接本次工作流的唯一上游生成节点，不能使用旧任务结果。');
    return candidates[0].id;
  }
  async function prepare(step) {
    step.state = 'preparing'; await persist();
    const edgeImages = {};
    for (const edge of state.graph.edges.filter(edge => edge.target === step.node_id)) {
      const upstreamId = upstreamFor(edge); if (!upstreamId) continue;
      const upstream = state.steps.find(item => item.node_id === upstreamId);
      if (!upstream || upstream.state !== 'completed' || !upstream.job_id) throw new Failure('上游任务尚未成功完成，不能继续下游。');
      const outputIndex = edge.outputIndex ?? 0;
      const images = (upstream.outputs || []).filter(output => output.type === 'image');
      if (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= images.length) throw new Failure('上游任务没有对应序号的图片输出；视频与音频不能直接作为图片输入。');
      let input = step.image_inputs[edge.id];
      if (!input || input.job_id !== upstream.job_id || input.output_index !== outputIndex) {
        await checkBackend(); guardStop();
        let uploaded;
        try { uploaded = await api(`/api/jobs/${encodeURIComponent(upstream.job_id)}/image-input`, { output_index: outputIndex }); }
        catch (error) { throw new Pause(`上游图片交接未完成：${error.message}。不会提交下游生成。`); }
        if (typeof uploaded?.name !== 'string' || !uploaded.name) throw new Failure('图片交接未返回有效输入名称');
        input = { job_id: upstream.job_id, output_index: outputIndex, name: uploaded.name, url: uploaded.url || '' };
        step.image_inputs[edge.id] = input; await persist();
      }
      edgeImages[edge.id] = input.name;
    }
    guardStop();
    step.request = generationPayload(state.graph, step.node_id, { edgeImages });
    step.request_id = globalThis.crypto.randomUUID();
    step.state = 'submitting'; await persist();
  }
  async function accept(step, result) {
    const id = result?.job_id || result?.id || result?.job?.id;
    if (typeof id !== 'string' || !id) throw new Pause('服务未返回任务 ID，保留原请求并查询，不能创建新请求。');
    step.job_id = id; step.job_status = result.job?.status || result.status || 'queued'; step.state = 'running'; step.error = '';
    try { await persist(); } catch (error) { step.state = 'uncertain'; throw error; }
    observeJob(step, result.job || { ...result, id });
  }
  async function submit(step) {
    await checkBackend(); guardStop();
    // Persist again before every dispatch, including an explicit not_found retry.
    step.state = 'submitting'; await persist(); guardStop();
    try { await accept(step, await api('/api/generate', { request_id: step.request_id, request: copy(step.request) })); }
    catch (error) {
      if (error.payload?.submission_state === 'rejected') { step.state = 'failed'; throw new Failure(`当前步骤未受理：${error.message}`); }
      step.state = 'uncertain';
      throw error instanceof StorageFailure ? error : new Pause(`提交结果待确认：${error.message}。保留原请求 ID，先查询再继续。`);
    }
  }
  async function recover(step) {
    await checkBackend();
    let result;
    try { result = await api('/api/requests/query', { request_id: step.request_id }); }
    catch (error) { throw new Pause(`原请求查询失败：${error.message}`); }
    guardStop();
    if (!result || typeof result !== 'object') throw new Pause('原请求查询返回无效数据；保留原请求证据，已暂停。');
    if (result.state === 'accepted') await accept(step, result);
    else if (result.state === 'not_found') await submit(step);
    else if (result.state === 'rejected' || result.submission_state === 'rejected') { step.state = 'failed'; throw new Failure('原请求已明确拒绝，下游未执行。'); }
    else { step.state = 'uncertain'; throw new Pause('原请求仍在处理或结果未知；已暂停，不会自动重发。'); }
  }
  async function poll(step) {
    while (true) {
      await checkBackend();
      let response;
      try { response = await api('/api/jobs'); } catch (error) { throw new Pause(`无法读取原任务状态：${error.message}`); }
      if (!Array.isArray(response?.jobs)) throw new Pause('原任务列表返回无效数据，已暂停后续步骤。');
      const job = response.jobs.find(job => job?.id === step.job_id);
      if (!job) throw new Pause('原任务不在当前任务列表中；保留任务与请求 ID，请核实原引擎历史。');
      const changed = step.job_status !== job.status;
      step.job_status = job.status;
      if (job.status === 'completed') {
        step.outputs = copy(job.outputs || []); step.state = 'completed'; step.error = ''; await persist(); observeJob(step, job); return;
      }
      if (['failed', 'cancelled'].includes(job.status)) { step.state = 'failed'; throw new Failure(`上游步骤${job.status === 'cancelled' ? '已取消' : '生成失败'}${job.error ? `：${job.error}` : ''}，后续步骤未执行。`); }
      if (!['queued', 'running'].includes(job.status)) throw new Pause('原任务状态未知，已暂停后续步骤。');
      if (changed) { await persist(); observeJob(step, job); }
      guardStop(); await delay();
    }
  }
  async function drive() {
    let current = null;
    try {
      state.status = 'running'; state.error = ''; await persist();
      for (const step of state.steps) {
        current = step; guardStop(); if (step.state === 'completed') continue;
        if (step.state === 'failed') throw new Failure(step.error || '原步骤失败，请检查参数后另建执行记录。');
        await checkBackend();
        if (['submitting', 'uncertain'].includes(step.state)) await recover(step);
        else if (step.state !== 'running') { await prepare(step); await submit(step); }
        guardStop(); await poll(step);
      }
      state.status = 'completed'; state.error = ''; await persist();
    } catch (error) {
      state.status = error instanceof Pause ? 'paused' : 'failed'; state.error = error?.message || String(error);
      if (current) { current.error = state.error; if (!(error instanceof Pause)) current.state = 'failed'; }
      try { await persist(); } catch (storage) { state.status = 'paused'; state.error = storage.message; notify(); }
    } finally { busy = false; wake = null; notify(); }
    return snapshot();
  }
  return {
    getState: snapshot,
    isRunning: () => busy,
    async start({ graph, targetIds, backend, canvasId }) {
      if (busy) throw new Error('工作流正在执行，请勿重复启动');
      if (state && (!['completed', 'failed'].includes(state.status) || unsettled(state))) throw new Error('已有未结束的运行记录，请查询并继续或安全清除记录');
      validateCanvasId(canvasId);
      const frozen = parseGraph(serializeGraph(graph));
      const targets = targetIds === undefined ? frozen.nodes.filter(node => node.type === 'generation').map(node => node.id) : [...targetIds];
      const order = executionOrder(frozen, targets); if (!order.length) throw new Error('请选择至少一个可执行生成节点');
      const normalized = normalizeBackend(backend), now = new Date().toISOString();
      state = { schema: RUN_SCHEMA, id: globalThis.crypto.randomUUID(), status: 'running', backend: normalized, graph: frozen, target_ids: targets, created_at: now, updated_at: now, error: '', steps: order.map(node_id => ({ node_id, state: 'pending', request_id: null, request: null, job_id: null, job_status: null, image_inputs: {} })) };
      if (canvasId !== undefined) state.canvas_id = canvasId;
      busy = true; stopped = false; return drive();
    },
    async resume() {
      if (busy) throw new Error('工作流正在执行，请勿重复恢复');
      if (!state) throw new Error('没有可恢复的工作流记录');
      if (state.status === 'completed') return snapshot();
      if (state.status === 'failed') throw new Error('此运行已失败，请修复参数后开始新的运行');
      busy = true; stopped = false; return drive();
    },
    async stop() {
      if (!state || !busy || ['completed', 'failed'].includes(state.status)) return snapshot();
      stopped = true; state.status = 'stopping'; state.error = '正在停止后续调度，当前生成任务继续保留。'; wake?.();
      try { await persist(); } catch (error) { state.error = error.message; notify(); }
      return snapshot();
    },
    async clear() {
      if (busy) throw new Error('请先停止后续调度，再清除运行记录');
      if (unsettled(state)) throw new Error('存在未确认请求或未结束任务，必须先查询原请求，不能清除证据');
      const before = state; state = null; busy = true;
      try { await persist(); } catch (error) { state = before; notify(); throw error; }
      finally { busy = false; notify(); }
      stopped = false; return null;
    },
  };
}
