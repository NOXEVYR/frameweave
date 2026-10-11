/** Read-only canvas checks. Planning never materializes media or starts jobs. */
import { generationPayload, serializeGraph, validateExecutionMediaBackends } from './graph.mjs';
import { planExecution, projectExecution } from './execution-scope.mjs';

const backendIdentity = value => {
  const url = new URL(value);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.href.replace(/\/$/, '');
};
const sameIds = (actual, expected) => Array.isArray(actual) && actual.length === expected.length
  && new Set(actual).size === actual.length && actual.every(id => typeof id === 'string' && expected.includes(id));

/** Invoke discovery first, even if request preparation throws synchronously. */
export function inspectWithDiscovery(inspect, discover) {
  const discovery = Promise.resolve().then(discover);
  const inspection = Promise.resolve().then(inspect);
  return Promise.allSettled([inspection, discovery]);
}

/** A studio request has no canvas graph, but must still retain its owner. */
export function captureRequestInspection(host) {
  const backend = host.backend(), snapshot = JSON.stringify(host.context());
  const ensureCurrent = () => {
    if (backend !== host.backend() || snapshot !== JSON.stringify(host.context())) {
      throw new Error('检查期间工作台、参数或推理引擎已变化，请重新检查；未应用旧结果。');
    }
  };
  const checkBackend = async () => {
    ensureCurrent();
    const status = await host.api('/api/status'); ensureCurrent();
    if (typeof status?.backend_url !== 'string' || backendIdentity(status.backend_url) !== backendIdentity(backend)) {
      throw new Error('检查期间推理引擎已变化，请重新检查；未应用旧结果。');
    }
  };
  return { ensureCurrent, checkBackend };
}

export function createCanvasInspection(host) {
  function capture(nodeId) {
    const source = structuredClone(host.graph()), signature = serializeGraph(source);
    const backend = host.backend(), identity = host.canvasIdentity();
    const node = source.nodes.find(item => item.id === nodeId && item.type === 'generation');
    if (!node) throw new Error('请选择生成节点进行检查或导出');
    const ensureCurrent = () => {
      if (identity !== host.canvasIdentity() || backend !== host.backend() || signature !== serializeGraph(host.graph())) {
        throw new Error('检查期间画布或推理引擎已变化，请重新检查；未应用或导出旧结果。');
      }
    };
    async function checkBackend() {
      ensureCurrent();
      const status = await host.api('/api/status'); ensureCurrent();
      if (!status?.online || typeof status.backend_url !== 'string') throw new Error('当前推理引擎未连接，工作流检查待完成；仍可检查本地环境。');
      if (backendIdentity(status.backend_url) !== backendIdentity(backend)) throw new Error('检查期间推理引擎已变化，请连接原引擎后重新检查。');
    }
    const api = async (path, body) => {
      if (!['/api/execution-plan', '/api/compile', '/api/diagnostics'].includes(path)) throw new Error('画布检查仅允许只读计划、编译和诊断');
      ensureCurrent();
      let result;
      try { result = await host.api(path, body); }
      catch (error) { ensureCurrent(); throw error; }
      ensureCurrent(); await checkBackend(); return result;
    };
    return { source, node, backend, ensureCurrent, checkBackend, api };
  }

  async function prepare(nodeId) {
    const context = capture(nodeId);
    await context.checkBackend();
    const targets = [nodeId];
    const execution = await planExecution(context.source, targets, context.backend, context.api);
    context.ensureCurrent();
    const projection = projectExecution(context.source, execution, targets);
    host.assertMediaReady?.(targets, projection, true);
    validateExecutionMediaBackends(projection, targets, context.backend, context.backend);
    // Unlike generation, this path cannot copy client-owned files to an engine.
    for (const node of projection.nodes) if (node.type === 'reference' && node.data.name && node.data.uploadBackend
        && backendIdentity(node.data.uploadBackend) !== backendIdentity(context.backend)) {
      throw new Error(`活动参考素材「${node.data.title}」属于其他推理引擎；只读检查不会上传或切换引擎。`);
    }
    for (const edge of projection.edges.filter(item => item.target === nodeId)) {
      const source = projection.nodes.find(item => item.id === edge.source);
      const label = context.node.data.packageFields?.find(field => field.id === edge.targetField)?.label || edge.targetField || '媒体';
      if (source.type === 'reference' && !source.data.name) throw new Error(`活动输入「${label}」素材尚未传入当前引擎；请先运行以准备素材，只读检查不会上传。`);
      if (['generation', 'result'].includes(source.type)) throw new Error(`活动输入「${label}」等待本次上游生成与素材交接；只读检查不会启动上游或使用历史产物。`);
    }
    const request = generationPayload(projection, nodeId);
    context.ensureCurrent();
    return { ...context, execution, projection, request };
  }

  return {
    prepare,
    async compile(nodeId) {
      const context = await prepare(nodeId), result = await context.api('/api/compile', context.request);
      const frozen = context.execution.packages[nodeId];
      if (frozen && (result?.summary?.package_id !== frozen.package_id
          || !['selected_outputs', 'node_ids', 'active_field_ids'].every(key => sameIds(result?.summary?.execution?.[key], frozen[key])))) {
        throw new Error('实时编译范围已变化，请重新检查；未导出不同于本次计划的工作流。');
      }
      context.ensureCurrent(); return { ...context, result };
    },
    async diagnose(nodeId) {
      const context = await prepare(nodeId), result = await context.api('/api/diagnostics', context.request);
      context.ensureCurrent(); return { ...context, result };
    },
  };
}
