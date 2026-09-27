/** Actual backend events only; sampling steps are not whole-workflow completion. */
export function liveProgressText(job) {
  if (job.status === 'queued' && !job.stage) return '等待引擎执行';
  const stage = job.stage || '推理进行中';
  const step = Number.isFinite(job.step) && Number.isFinite(job.steps) ? ` · ${job.step} / ${job.steps} 步` : '';
  const node = job.execution_node ? ` · 节点 ${job.execution_node}` : '';
  const state = job.progress_connected === false ? ' · 实时通道未连接，正在查询任务状态' : !step ? ' · 等待后端进度事件' : '';
  return stage+node+step+state;
}
