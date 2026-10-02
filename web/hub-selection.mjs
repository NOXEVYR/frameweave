import { generationPayload, stableStringify } from './graph.mjs';
import { workflowBackendTarget } from './editor-backend-picker.mjs';

/** Freeze exactly the selected package; reading never uploads or generates. */
export async function selectedHubRequest(host) {
  const graph = host.graph(), ids = host.selectedIds(), backend = host.backend(), identity = host.canvasIdentity();
  const node = ids.length === 1 ? graph.nodes.find(item => item.id === ids[0]) : null;
  if (node?.type !== 'generation' || node.data.kind !== 'package' || !node.data.package_id) {
    throw new Error('请在画布只选中一个已应用接口的工作流包，再读取当前配置。');
  }
  const before = stableStringify(graph), packageId = node.data.package_id;
  const pack = await host.ensurePackageDefinition(packageId);
  if (graph !== host.graph() || identity !== host.canvasIdentity() || backend !== host.backend()
      || stableStringify(graph) !== before || stableStringify(host.selectedIds()) !== stableStringify(ids)) {
    throw new Error('读取期间画布、选中节点或引擎已变化，请重新读取。');
  }
  if (pack.id !== packageId || !Array.isArray(pack.fields)) throw new Error('工作流包定义不一致，请重新读取。');
  const frozen = structuredClone(graph);
  frozen.nodes.find(item => item.id === node.id).data.packageFields = structuredClone(pack.fields);
  if (workflowBackendTarget(frozen, [node.id], backend) !== backend) throw new Error('请先切回此工作流的原推理引擎，再准备能力。');
  return { request: generationPayload(frozen, node.id), fields: structuredClone(pack.fields),
    title: node.data.title || pack.name, backend_url: backend };
}
