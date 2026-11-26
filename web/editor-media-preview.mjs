const MEDIA_TYPES = new Set(['image', 'video', 'audio']);
const MEDIA_LABELS = { image: '图片', video: '视频', audio: '音频' };
const emptyVideoInfo = () => ({ videoWidth: null, videoHeight: null, durationSeconds: null, videoMetadataLoaded: false });

function videoInfoText(state) {
  if (state.status === 'failed') return '视频尺寸与时长不可用：预览加载失败';
  if (!state.videoMetadataLoaded) return '视频尺寸与时长尚未加载';
  const size = state.videoWidth !== null && state.videoHeight !== null
    ? `${state.videoWidth} × ${state.videoHeight} 像素` : '尺寸未知';
  const duration = state.durationSeconds;
  const time = duration === null ? '时长未知' : duration > 0 && duration < 0.001 ? '时长不足 0.001 秒'
    : `时长 ${duration.toFixed(3).replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '')} 秒`;
  return `当前预览：${size} · ${time}`;
}

function inputName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) return null;
  const path = value.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes(':') || /[\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..')
      || /\[(?:input|output|temp)\]\s*$/i.test(path)
      || /%(?:2e|2f|5c|00|3a)/i.test(path)) return null;
  const parts = path.split('/'), basename = parts.pop();
  const query = new URLSearchParams({ filename: basename, subfolder: parts.join('/'), type: 'input' });
  return { filename: path, url: `/view?${query}` };
}

/** Session-only display; it never reads widgets, uploads, or submits workflows. */
export function createEditorMediaPreview({ document, container, onState } = {}) {
  if (!document?.createElement || !container?.append) throw new Error('媒体预览需要有效的 document 和 container');
  let generation = 0, active = null, listeners = [], destroyed = false;
  let state = { status: 'empty', identity: null, type: null, filename: '', label: '', ordinal: null, message: '选择一个参考素材槽以预览', generation, ...emptyVideoInfo() };
  const make = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  const panel = make('section'); panel.className = 'prism-editor-media-preview';
  panel.dataset.state = state.status;
  panel.setAttribute('aria-label', '当前参考素材预览');
  Object.assign(panel.style, { boxSizing: 'border-box', width: '100%', maxWidth: '360px', minWidth: '0', padding: '10px', border: '1px solid var(--line, #d3daea)', borderRadius: '10px', background: 'var(--panel, #ffffff)', color: 'var(--text, #1c284c)', font: '13px/1.5 system-ui,sans-serif' });
  const details = make('details'); details.open = true;
  const heading = make('summary', '参考素材预览');
  Object.assign(heading.style, { cursor: 'pointer', overflowWrap: 'anywhere' });
  const status = make('p', state.message); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  Object.assign(status.style, { margin: '8px 0', overflowWrap: 'anywhere' });
  const filenameLabel = make('p');
  Object.assign(filenameLabel.style, { margin: '6px 0', fontSize: '11px', color: 'var(--muted, #556380)', overflowWrap: 'anywhere' });
  const videoInfo = make('p'); videoInfo.className = 'prism-editor-video-info'; videoInfo.hidden = true;
  videoInfo.setAttribute('role', 'status'); videoInfo.setAttribute('aria-live', 'polite');
  videoInfo.setAttribute('aria-label', '当前视频尺寸与时长');
  Object.assign(videoInfo.style, { margin: '6px 0', fontSize: '11px', color: 'var(--muted, #556380)', overflowWrap: 'anywhere' });
  const viewport = make('div');
  Object.assign(viewport.style, { minWidth: '0', maxHeight: '240px', overflow: 'auto' });
  const close = make('button', '清除预览'); close.type = 'button'; close.setAttribute('aria-label', '清除当前素材预览');
  Object.assign(close.style, { marginTop: '8px', padding: '4px 8px', cursor: 'pointer' });
  details.append(heading, status, filenameLabel, videoInfo, viewport, close); panel.append(details); container.append(panel);
  const snapshot = () => ({ ...state });
  const notify = () => {
    status.textContent = state.message;
    heading.textContent = state.label ? `${state.ordinal ? `第 ${state.ordinal} 个槽 · ` : ''}${state.label} · ${MEDIA_LABELS[state.type] || '素材'}预览` : '参考素材预览';
    filenameLabel.textContent = state.filename;
    videoInfo.hidden = state.type !== 'video' || !state.filename;
    videoInfo.textContent = videoInfo.hidden ? '' : videoInfoText(state);
    panel.dataset.state = state.status;
    if (typeof onState === 'function') {
      try { Promise.resolve(onState(snapshot())).catch(() => {}); } catch { /* A display observer cannot change the resource lifecycle. */ }
    }
  };
  function release() {
    const old = active; active = null;
    for (const [name, listener] of listeners) old?.removeEventListener(name, listener);
    listeners = [];
    if (old) {
      try { old.pause?.(); } catch { /* Detached media may already be unavailable. */ }
      old.removeAttribute('src');
      try { old.load?.(); } catch { /* Resetting a detached decoder is best effort. */ }
      old.remove();
    }
    viewport.replaceChildren();
  }
  function clear(message) {
    if (destroyed) return snapshot();
    generation++; release();
    state = { status: 'empty', identity: null, type: null, filename: '', label: '', ordinal: null,
      message: typeof message === 'string' && message ? message.slice(0, 512) : '预览已清除；未修改参考槽', generation, ...emptyVideoInfo() };
    notify(); return snapshot();
  }
  function show(value = {}) {
    if (destroyed) return snapshot();
    generation++; release();
    const token = generation;
    const identity = typeof value?.identity === 'string' && value.identity.length > 0 && value.identity.length <= 8192 ? value.identity : null;
    const type = MEDIA_TYPES.has(value?.type) ? value.type : null;
    const label = typeof value?.label === 'string' ? value.label.slice(0, 1024) : '参考素材';
    const ordinal = Number.isSafeInteger(value?.ordinal) && value.ordinal > 0 ? value.ordinal : null;
    state = { status: 'unsupported', identity, type, filename: '', label, ordinal, message: '无法证明此槽是可预览的图片、视频或音频输入', generation, ...emptyVideoInfo() };
    if (!identity || !type) { notify(); return snapshot(); }
    if (value.filename === '') {
      state.status = 'empty'; state.message = '当前参考槽为空；未读取任何文件'; notify(); return snapshot();
    }
    const input = inputName(value.filename);
    if (!input) { state.message = '输入名称无效或不是安全的输入目录相对名称；未读取任何文件'; notify(); return snapshot(); }
    state.filename = input.filename; state.status = 'pending'; state.message = `正在加载${MEDIA_LABELS[type]}预览`;
    const media = make(type === 'image' ? 'img' : type); active = media;
    Object.assign(media.style, { display: 'block', maxWidth: '100%', width: type === 'audio' ? '100%' : 'auto', maxHeight: '230px', objectFit: 'contain' });
    if (type === 'image') media.alt = label || '参考图片';
    else { media.controls = true; media.autoplay = false; media.preload = 'metadata'; if (type === 'video') media.playsInline = true; }
    const current = () => !destroyed && generation === token && active === media;
    const readVideoInfo = (metadataEvent = false) => {
      if (type !== 'video' || !current() || !['pending', 'ready'].includes(state.status)
          || !metadataEvent && !state.videoMetadataLoaded && !(media.readyState >= 1)) return false;
      const width = Number.isSafeInteger(media.videoWidth) && media.videoWidth > 0 ? media.videoWidth : null;
      const height = Number.isSafeInteger(media.videoHeight) && media.videoHeight > 0 ? media.videoHeight : null;
      const duration = Number.isFinite(media.duration) && media.duration >= 0 ? media.duration : null;
      const changed = !state.videoMetadataLoaded || state.videoWidth !== width || state.videoHeight !== height || state.durationSeconds !== duration;
      Object.assign(state, { videoWidth: width, videoHeight: height, durationSeconds: duration, videoMetadataLoaded: true });
      return changed;
    };
    const ready = () => { if (!current() || state.status !== 'pending') return; readVideoInfo(true); state.status = 'ready'; state.message = `${MEDIA_LABELS[type]}预览已加载`; notify(); };
    const failed = () => { if (!current() || !['pending', 'ready'].includes(state.status)) return; state.status = 'failed'; state.message = `${MEDIA_LABELS[type]}预览加载失败；请检查输入文件是否存在及格式是否受支持`; Object.assign(state, emptyVideoInfo()); notify(); };
    listeners = [[type === 'image' ? 'load' : type === 'video' ? 'loadeddata' : 'loadedmetadata', ready], ['error', failed]];
    if (type === 'video') {
      const metadata = () => { if (readVideoInfo(true)) notify(); };
      const updated = () => { if (readVideoInfo()) notify(); };
      listeners.push(['loadedmetadata', metadata], ['durationchange', updated], ['resize', updated]);
    }
    for (const [name, listener] of listeners) media.addEventListener(name, listener);
    viewport.append(media); notify();
    // notify may synchronously clear/replace/destroy the preview. Never revive
    // that discarded resource after an observer changes the current selection.
    if (current()) media.src = input.url;
    return snapshot();
  }
  const pause = () => { if (!destroyed) { try { active?.pause?.(); } catch { /* Detached media may already be unavailable. */ } } };
  const onClose = () => clear();
  const onToggle = () => { if (!details.open) pause(); /* No automatic restart on expansion. */ };
  const onVisibility = () => { if (document.hidden === true || document.visibilityState === 'hidden') pause(); };
  close.addEventListener('click', onClose); details.addEventListener('toggle', onToggle);
  document.addEventListener?.('visibilitychange', onVisibility);
  function destroy() {
    if (destroyed) return;
    generation++; release(); destroyed = true;
    state = { status: 'empty', identity: null, type: null, filename: '', label: '', ordinal: null, message: '预览已关闭', generation, ...emptyVideoInfo() };
    close.removeEventListener('click', onClose); details.removeEventListener('toggle', onToggle);
    document.removeEventListener?.('visibilitychange', onVisibility);
    panel.remove(); notify();
  }
  return { show, clear, destroy, getState: snapshot };
}
