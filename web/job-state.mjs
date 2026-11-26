/** Cancellation is intent until the original backend confirms a terminal job. */
const terminal = new Set(['completed', 'failed', 'cancelled']);
const pendingCancellation = new Set(['requesting', 'requested', 'uncertain']);
const names = { queued: '排队中', running: '生成中', unknown: '待确认', completed: '已完成', failed: '失败', cancelled: '已取消' };
export const isJobTerminal = job => !!job && terminal.has(job.status);
export const isJobActive = job => !!job && !isJobTerminal(job);
export const cancellationId = job => typeof job?.cancellation?.id === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(job.cancellation.id) ? job.cancellation.id : null;
export const isCancellationPending = job => isJobActive(job) && pendingCancellation.has(job.cancellation?.state);
export const canCancelJob = job => isJobActive(job) && job.can_cancel !== false && ['queued', 'running'].includes(job.status) && !isCancellationPending(job);
export const canRefreshJob = job => isJobActive(job);
export const cancelActionLabel = job => job?.status === 'unknown' ? '先查询原任务' : job?.cancellation?.state === 'unavailable' ? '重试安全取消' : isCancellationPending(job) ? '取消待确认' : '取消任务';

export function jobStatusLabel(job) {
  if (!job) return '等待提交';
  if (isJobTerminal(job)) return names[job.status];
  const cancel = { requesting: '正在请求取消', requested: '取消已请求', uncertain: '取消待确认' }[job.cancellation?.state];
  return cancel || names[job.status] || '待确认';
}

export function cancellationText(job) {
  if (!job?.cancellation) return '';
  if (job.status === 'completed') return '任务已自然完成，取消未阻止本次结果。';
  if (job.status === 'failed') return '原任务已确认失败，原始参数与已有产物仍保留。';
  if (job.status === 'cancelled') return '原任务已确认取消，原始参数与已有产物仍保留。';
  const fallback = { requesting: '正在请求取消，原任务状态仍需确认。', requested: '取消已请求，等待原引擎确认；任务仍可能完成。',
    uncertain: '取消结果待确认，请查询原任务；不会自动再次提交生成。', unavailable: '当前后端无法安全取消，任务仍可能继续；可查询状态或稍后重试。' }[job.cancellation.state];
  return typeof job.cancellation.message === 'string' && job.cancellation.message.trim()
    ? job.cancellation.message.slice(0, 1000) : fallback || '正在核对原任务的取消结果。';
}

export function jobStateDetail(job) {
  const cancellation = cancellationText(job);
  if (job?.status === 'unknown') return [cancellation, '原任务状态待确认，请查询原任务；不可重试此任务或切到新引擎。'].filter(Boolean).join(' ');
  return cancellation;
}

const backendKey = value => {
  try { const url = new URL(value); if (url.hostname === 'localhost') url.hostname = '127.0.0.1'; return url.href.replace(/\/$/, ''); }
  catch { return ''; }
};
export function canSwitchJobBackend(jobs, target, current) {
  const next = backendKey(target), now = backendKey(current);
  if (!next) return false;
  if (next === now) return true;
  const active = jobs.filter(isJobActive);
  return active.length === 0 || active.every(job => backendKey(job.backend) === next);
}
