/** Quick-edit is a new destination of the common owned-output transfer. */
import { createNode } from './graph.mjs';
import { captureResultReference, assertResultReferenceCurrent, transferResultReference, resultReferenceOutputKey } from './result-reference.mjs';

const PRESETS = {
  qwen21_edit: { title: 'Qwen Image 2.1 · 多图编辑', steps: 40, denoise: 1 },
  sdxl_i2i: { title: 'SDXL · 图生图', steps: 25, denoise: .65 },
};

export async function prepareResultEdit({ source, outputId, kind, position, api, current }) {
  if (!Object.hasOwn(PRESETS, kind)) throw new Error('请选择支持的图片编辑方式');
  const { graph, canvasId, backend } = current(), jobId = source?.data?.jobId;
  const output = source?.data?.outputs?.find(item => item.output_id === outputId);
  if (source?.type !== 'result' || !graph.nodes.includes(source) || !outputId || output?.type !== 'image') throw new Error('请选择可核验的本地图片结果');
  if (graph.nodes.length > 498 || graph.edges.length >= 2000) throw new Error('画布容量不足，请整理节点后再接入编辑');
  const identity = resultReferenceOutputKey(output);
  const live = () => {
    const context = current();
    if (context.graph !== graph || context.canvasId !== canvasId || context.backend !== backend
      || !graph.nodes.includes(source) || source.data.jobId !== jobId
      || !source.data.outputs?.some(item => resultReferenceOutputKey(item) === identity)) {
      throw new Error('读取期间画布、任务或产物已变化，请重新选择');
    }
    return context;
  };
  const jobs = await api('/api/jobs');
  const context = live();
  const target = createNode('generation', position?.x ?? source.x + 760, position?.y ?? source.y,
    { kind, ...PRESETS[kind], width: 1024, height: 1024 });
  const ticket = captureResultReference({ ...context, source, job: jobs?.jobs?.find(item => item.id === jobId), outputId,
    targetId: target.id, fieldId: 'image_1', newTarget: target });
  const fragment = await transferResultReference(ticket, { api, current: live });
  live();
  return { ...fragment, assertCurrent: () => assertResultReferenceCurrent(ticket, live()) };
}
