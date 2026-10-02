/** Assemble into the existing workflow-package editor, without submitting a job. */
const KEYS = ['kind', 'positive', 'negative', 'models', 'seed', 'width', 'height', 'steps',
  'cfg', 'denoise', 'sampler', 'scheduler', 'seconds', 'fps', 'loras', 'shift_video',
  'shift_audio', 'ref_image_size'];

export function h3TemplateRequest(draft) {
  if (!draft || draft.kind !== 'h3_ref') throw new Error('请选择 H3 多图参考模式后建立多模态工作流');
  return structuredClone(Object.fromEntries(KEYS.filter(key => Object.hasOwn(draft, key)).map(key => [key, draft[key]])));
}

export function createH3ReferenceBuilder(host) {
  const element = document.createElement('details'); element.className = 'studio-details h3-reference-builder';
  const make = (tag, text, className = '') => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; item.className = className; return item; };
  element.append(make('summary', '创建多模态参考工作流'));
  element.append(make('p', '把图片、参考视频和独立音频组合成一个可编辑的工作流节点。沿用当前模型、提示词和采样参数；素材在新节点中上传或连入。', 'studio-help'));
  const grid = make('div', undefined, 'studio-grid'), controls = [], videos = make('div'), status = make('p', '', 'studio-help');
  status.setAttribute('role', 'status');
  let busy = false, revision = 0, soundtracks = [];
  const selectCount = (label, maximum, value) => {
    const wrap = make('label', undefined, 'studio-field'), select = make('select');
    select.setAttribute('aria-label', label);
    for (let i = 0; i <= maximum; i++) { const option = make('option', String(i)); option.value = String(i); select.append(option); }
    select.value = String(value); wrap.append(make('span', label), select); grid.append(wrap); controls.push(select);
    select.addEventListener('change', () => { revision++; update(); });
    return select;
  };
  const images = selectCount('参考图片数量', 9, 0), videoCount = selectCount('参考视频数量', 3, 1), audios = selectCount('独立音频数量', 3, 0);
  const drawVideos = () => {
    videos.replaceChildren(); const count = Number(videoCount.value);
    soundtracks = soundtracks.slice(0, count);
    while (soundtracks.length < count) soundtracks.push(false);
    for (let i = 0; i < count; i++) {
      const label = make('label', undefined, 'h3-soundtrack-option'), check = make('input');
      check.type = 'checkbox'; check.checked = soundtracks[i]; check.disabled = busy;
      check.setAttribute('aria-label', `使用参考视频 ${i + 1} 的声轨`);
      check.addEventListener('change', () => { soundtracks[i] = check.checked; revision++; update(); });
      label.append(check, make('span', `使用参考视频 ${i + 1} 的声轨`)); videos.append(label);
    }
  };
  videoCount.addEventListener('change', () => { drawVideos(); update(); });
  const button = make('button', '建立工作流并选择外层参数', 'button primary'); button.type = 'button';
  const capabilityNote = () => {
    const info = host.engine()?.generation_options?.h3_reference;
    if (!info) return '创建前将重新检查当前引擎的节点能力。';
    const requested = [[Number(images.value), 'images', '图片'], [Number(videoCount.value), 'videos', '视频'], [Number(audios.value), 'audios', '音频'],
      [soundtracks.some(Boolean) ? soundtracks.lastIndexOf(true) + 1 : 0, 'soundtracks', '视频声轨']];
    const issues = requested.filter(([count, key]) => count && (!info[key]?.available || count > info[key].max_count));
    return issues.length ? issues.map(([, key, label]) => `${label}：${info[key]?.reason || '当前引擎未提供所需输入或数量超限'}`).join('；') : '已识别所选参考类型；创建前仍会重新核对当前节点版本。';
  };
  function update() {
    for (const control of controls) control.disabled = busy;
    videos.querySelectorAll('input').forEach(control => { control.disabled = busy; });
    const engine = host.engine();
    const supportedProtocol = !!engine?.generation_options?.h3_reference;
    button.disabled = busy || !engine?.online || !supportedProtocol;
    button.textContent = busy ? '正在装配工作流…' : '建立工作流并选择外层参数';
    if (!busy) status.textContent = !engine?.online ? '引擎未连接：请先在设置中连接 ComfyUI，再刷新模型。'
      : !supportedProtocol ? '当前运行后台尚未加载多模态装配功能；仅刷新页面不会更新后台，请使用已更新的客户端。' : capabilityNote();
  }
  button.addEventListener('click', async () => {
    if (busy || button.disabled) return;
    const sourceStamp = host.context(), sourceDraft = JSON.stringify(host.draft()), version = revision;
    const isCurrent = () => host.context() === sourceStamp && JSON.stringify(host.draft()) === sourceDraft && revision === version;
    const guard = () => { if (!isCurrent()) throw new Error('工作台、画布、参数或引擎已变化，未应用旧的装配结果；请重新创建'); };
    busy = true; update();
    try {
      const layout = { image_count: Number(images.value), videos: soundtracks.map(soundtrack => ({ soundtrack })), audio_count: Number(audios.value) };
      if (!layout.image_count && !layout.videos.length && !layout.audio_count) throw new Error('至少选择一种参考素材');
      const backend = host.engine().backend_url;
      const result = await host.api('/api/h3-reference/prepare', { backend_url: backend, preset_request: h3TemplateRequest(host.draft()), layout });
      guard();
      if (result.backend_url !== backend) throw new Error('装配结果来自其他引擎，请重新创建');
      if (result.status !== 'prepared' || !result.document) throw new Error((result.blocked || []).map(item => item.message).join('；') || '尚不能装配所选参考输入，请检查当前引擎能力');
      await host.onPrepared(result.document, guard);
      guard(); status.textContent = '工作流已准备；在参数选择窗口保存后，可在画布连线、调参或进入内部编辑。';
    } catch (error) {
      const message = /接口不存在|404/.test(error.message) ? '当前运行后台尚未加载多模态装配功能；只刷新页面不会更新后台，请使用已更新的客户端。' : error.message;
      status.textContent = message; host.reportError(new Error(message));
    } finally {
      const message = status.textContent; busy = false; update(); status.textContent = message;
    }
  });
  element.append(grid, videos, make('p', '仅对确实含有声轨的视频勾选声音。视频按 24 fps 有界取帧，参考画幅会中心裁切并缩放；新节点可调节参考宽高、读取帧数和起始位置。创建不会开始生成。', 'studio-help'), status, button);
  drawVideos(); update();
  return { element, update };
}
