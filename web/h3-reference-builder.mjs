/** Assemble into the existing workflow-package editor, without submitting a job. */
const KEYS = ['kind', 'positive', 'negative', 'models', 'seed', 'width', 'height', 'steps',
  'cfg', 'denoise', 'sampler', 'scheduler', 'seconds', 'fps', 'loras', 'shift_video',
  'shift_audio', 'ref_image_size'];
const TIMING_CONDITION = '按已审计的 H3/VHS 语义估算，需源视频能加载满上限、24 fps 逐帧读取、不跳过起始帧、format=None，且节点实现未变；同源音轨需源文件确有音轨。实际加载帧数、声轨样本与编码跨度需解码确认；object_info 不能证明运行时已截帧。';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const seconds = value => String(Number(value.toFixed(3)));

/** Conditional estimates from the CURRENT graph and interface values, never media metadata. */
export function h3ReferenceTiming(document, values = {}) {
  if (!object(document) || !object(document.prompt)) return [];
  const prompt = document.prompt, fields = Array.isArray(document.fields) ? document.fields : [];
  values = object(values) ? values : {};
  const boundFields = (nodeId, name) => fields.filter(item => object(item) && item.node_id === nodeId && item.input === name);
  const value = (nodeId, name) => {
    const inputs = prompt[nodeId]?.inputs;
    // Do not estimate a removed or linked input through a stale UI default.
    if (!object(inputs) || !Object.hasOwn(inputs, name) || (inputs[name] !== null && typeof inputs[name] === 'object')) return undefined;
    const bindings = boundFields(nodeId, name);
    if (bindings.length > 1) return undefined;
    const field = bindings[0];
    if (field && typeof field.id === 'string' && Object.hasOwn(values, field.id)) return values[field.id];
    if (field && Object.hasOwn(field, 'default')) return field.default;
    return inputs[name];
  };
  const result = [];
  for (const [conditioningId, node] of Object.entries(prompt)) {
    if (!object(node) || node.class_type !== 'MiniMaxH3ReferenceToVideo' || !object(node.inputs)) continue;
    const names = Object.keys(node.inputs).filter(name => name.startsWith('ref_videos.'));
    for (const name of names) {
      const link = node.inputs[name], linked = Array.isArray(link) && link.length === 2 && typeof link[0] === 'string' && link[1] === 0;
      const sourceId = linked ? link[0] : null, source = prompt[sourceId];
      const mediaFields = boundFields(sourceId, 'video'), mediaField = mediaFields.length === 1 ? mediaFields[0] : undefined;
      const label = typeof mediaField?.label === 'string' ? mediaField.label.trim() : '';
      const videoLabel = label || (sourceId !== null ? `参考视频（节点 ${sourceId}）` : `参考视频（${name}）`);
      const numbered = label.match(/^参考视频(\d+)$/);
      const soundtrack = linked && Object.entries(node.inputs).some(([key, other]) => key.startsWith('ref_video_audios.') &&
        Array.isArray(other) && other.length === 2 && other[0] === sourceId && other[1] === 2);
      const cap = value(sourceId, 'frame_load_cap'), length = value(conditioningId, 'length');
      const known = linked && object(source) && source.class_type === 'VHS_LoadVideo' && integer(cap, 5) && integer(length, 5) &&
        value(sourceId, 'force_rate') === 24 && value(sourceId, 'select_every_nth') === 1 &&
        value(sourceId, 'skip_first_frames') === 0 && value(sourceId, 'format') === 'None';
      const item = { conditioning_node_id: conditioningId, source_node_id: sourceId, video_input: name,
        video_label: videoLabel, video_ordinal: numbered ? Number(numbered[1]) : null,
        soundtrack, estimate_status: known ? 'conditional' : 'unknown', runtime_verified: false, condition: TIMING_CONDITION,
        frame_load_cap: integer(cap, 0) ? cap : null, output_frames: integer(length, 5) ? length : null, fps: known ? 24 : null,
        loaded_seconds_estimate: null, effective_frames_estimate: null, effective_seconds_estimate: null,
        discarded_frames_estimate: null, soundtrack_seconds_estimate: null, span_difference_seconds_estimate: null };
      if (known) {
        const effective = Math.floor((Math.min(cap, length) - 5) / 17) * 17 + 5;
        Object.assign(item, { loaded_seconds_estimate: cap / 24, effective_frames_estimate: effective,
          effective_seconds_estimate: effective / 24, discarded_frames_estimate: cap - effective,
          soundtrack_seconds_estimate: soundtrack ? cap / 24 : null,
          span_difference_seconds_estimate: soundtrack ? (cap - effective) / 24 : null });
        item.message = `${videoLabel}：条件估算读取上限 ${cap} 帧 / ${seconds(cap / 24)} 秒；H3 限于输出 ${length} 帧并向下对齐 17n+5，最多 ${effective} 帧 / 约 ${seconds(effective / 24)} 秒（比读取上限少 ${cap - effective} 帧）。`;
        if (soundtrack) item.message += `同源音轨输入的读取请求约 ${seconds(cap / 24)} 秒，按已审计语义不随 H3 视频再次裁短；参考声画跨度差估算 ${seconds((cap - effective) / 24)} 秒。`;
      } else item.message = `${videoLabel}：当前读取参数或输出帧数无法作 24 fps 条件估算（仅支持已知整数上限≥5、输出帧数≥5、不跳帧、逐帧读取及 format=None）；实际参考帧数与声轨跨度待解码确认。`;
      result.push(item);
    }
  }
  return result;
}

/** Lines for the package inspector: recompute after every scalar edit, not from prepare.summary. */
export function h3ReferenceTimingText(document, values = {}) {
  const timing = h3ReferenceTiming(document, values);
  return timing.length ? [...timing.map(item => item.message), TIMING_CONDITION] : [];
}

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
      guard(); status.textContent = ['工作流已准备；在参数选择窗口保存后，可在画布连线、调参或进入内部编辑。',
        ...h3ReferenceTimingText(result.document)].join(' ');
    } catch (error) {
      const message = /接口不存在|404/.test(error.message) ? '当前运行后台尚未加载多模态装配功能；只刷新页面不会更新后台，请使用已更新的客户端。' : error.message;
      status.textContent = message; host.reportError(new Error(message));
    } finally {
      const message = status.textContent; busy = false; update(); status.textContent = message;
    }
  });
  element.append(grid, videos, make('p', '仅对确实含有声轨的视频勾选声音。视频按 24 fps 有界取帧，参考画幅会中心裁切并缩放；新节点可调节参考宽高、读取帧数和起始位置。H3 参考视频先限于输出帧数，再按 17n+5 向下对齐；读取上限不等于有效参考帧数，同源声轨可能比视频参考更长。创建不会开始生成。', 'studio-help'), status, button);
  drawVideos(); update();
  return { element, update };
}
