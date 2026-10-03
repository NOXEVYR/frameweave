import { progressPercent } from './graph.mjs';
import { isJobTerminal, jobStateDetail } from './job-state.mjs';
const previewStates = new WeakMap();
const terminalLabels = { completed: '任务已完成', failed: '生成失败', cancelled: '任务已取消' };
const isTerminal = isJobTerminal;

/** Actual backend events only; sampling steps are not whole-workflow completion. */
export function liveProgressText(job) {
  if (isTerminal(job)) return [terminalLabels[job.status], jobStateDetail(job)].filter(Boolean).join(' · ');
  if (job.status === 'unknown') return jobStateDetail(job);
  const stage = job.stage || (job.status === 'queued' ? '等待引擎执行' : '推理进行中');
  const step = Number.isFinite(job.step) && Number.isFinite(job.steps) && job.steps > 0 && job.step >= 0 && job.step <= job.steps ? ` · ${job.step} / ${job.steps} 步` : '';
  const label = job.execution_label ? `（${job.execution_label}）` : '';
  const parallel = Array.isArray(job.execution_nodes) && job.execution_nodes.length > 1 ? ` · 节点 ${job.execution_nodes.slice(0,4).map(id => `${id}${job.execution_labels?.[id] ? `（${job.execution_labels[id]}）` : ''}`).join('、')}${job.execution_nodes.length > 4 ? ' 等' : ''}` : '';
  const node = job.execution_node ? ` · 节点 ${job.execution_node}${label}` : parallel;
  const queue = job.status === 'queued' && Number.isInteger(job.queue_position) && job.queue_position > 0 ? ` · 待执行队列第 ${job.queue_position} 位` : '';
  const cached = Number.isInteger(job.cached_nodes) && job.cached_nodes > 0 ? ` · ${job.cached_nodes} 个节点复用缓存` : '';
  const stale = job.progress_stale || job.progress_connected === false && Boolean(job.stage);
  const state = job.client_connection_lost ? ' · 与本机服务连接中断，正在重连，耗时暂停同步' : job.progress_identity_unknown ? ' · 旧任务实时订阅尚未恢复，正在查询任务状态' : job.progress_connected === false ? ' · 实时通道未连接，正在查询任务状态' : job.progress_stale || !step ? ' · 等待后端新进度事件' : '';
  const preview = job.preview_url && (job.preview_stale || job.progress_connected === false) ? ' · 预览为上次接收' : '';
  return [jobStateDetail(job), (stale ? '上次进度：' : '')+stage+node+queue+step+cached+state+preview].filter(Boolean).join(' · ');
}

export function elapsedText(job) {
  const label = job?.status === 'queued' ? '排队耗时' : job?.started_at ? '执行耗时' : '累计耗时';
  return Number.isFinite(job?.elapsed) && job.elapsed >= 0 ? `${label} ${Math.floor(job.elapsed / 60)} 分 ${Math.floor(job.elapsed % 60)} 秒` : '耗时待同步';
}

export function previewStatusText(job) {
  if (job?.status === 'unknown') return '任务状态待确认；保留的预览不是最终结果，请查询原任务。';
  if (isTerminal(job)) return job.status === 'completed'
    ? job.outputs?.length ? '生成已完成，请查看最终产物。' : '任务已完成；本次没有可预览产物，请检查输出节点。'
    : job.status === 'failed' ? '生成已失败；请在任务列表查看错误详情及已保存产物。' : '任务已取消，原始参数仍保留。';
  if (job.preview_url) return job.preview_stale || job.progress_connected === false || job.client_connection_lost
    ? '上次收到的中间预览，等待新画面；不是最终产物。'
    : '实时中间预览 · 不是最终产物。';
  if (job.status === 'queued' && (job.execution_node || job.execution_nodes?.length)) return '后端已报告执行节点，正在等待中间预览。';
  return job.status === 'queued' ? '排队中，开始执行后等待后端预览。'
    : '后端尚未提供中间预览；部分视频、音频或自定义节点只报告执行状态。';
}

/** Update existing elements, so sampling events do not recreate or flash images. */
export function updateLiveProgress(elements, job) {
  const { detail, bar, image, caption } = elements;
  const terminal = isTerminal(job);
  detail.textContent = liveProgressText(job);
  const value = terminal ? job.status === 'completed' ? 100 : null : job.status === 'unknown' ? null : progressPercent(job.progress);
  bar.hidden = terminal;
  if (value === null) bar.removeAttribute('value'); else bar.value = value;
  bar.setAttribute('aria-valuetext', `${detail.textContent}；${elapsedText(job)}`);
  const stale = !terminal && Boolean(job.progress_stale || job.progress_connected === false || job.client_connection_lost);
  bar.classList.toggle('is-stale', stale);
  caption.textContent = previewStatusText(job);
  const previous = previewStates.get(image);
  const state = {job, failed: !terminal && Boolean(previous && previous.job.preview_url === job.preview_url && previous.failed)};
  previewStates.set(image, state);
  if (terminal) {
    image.hidden = true; image.onload = image.onerror = null; image.removeAttribute('src'); return;
  }
  image.hidden = !job.preview_url || state.failed;
  if (state.failed) caption.textContent = '此帧预览暂不可用，等待下一帧；任务仍在同步状态。';
  if (!job.preview_url) { image.removeAttribute('src'); return; }
  if (image.getAttribute('src') !== job.preview_url) {
    const url = job.preview_url;
    image.onerror = () => { const latest = previewStates.get(image); if (!latest || isTerminal(latest.job) || latest.job.preview_url !== url) return; latest.failed = true; image.hidden = true; caption.textContent = '此帧预览暂不可用，等待下一帧；任务仍在同步状态。'; };
    image.onload = () => { const latest = previewStates.get(image); if (!latest || isTerminal(latest.job) || latest.job.preview_url !== url) return; latest.failed = false; image.hidden = false; caption.textContent = previewStatusText(latest.job); };
    image.src = job.preview_url;
  }
}
