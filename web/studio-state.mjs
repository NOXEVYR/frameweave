/** Independent generation drafts: no canvas mutation, backend validation remains authoritative. */
export const STUDIO_MODES = {
  txt2img: { title: '文生图', subtitle: '把描述变成画面', kinds: [['sdxl', 'SDXL / 兼容 Checkpoint'], ['krea', 'Krea 2']] },
  img2img: { title: '图生图', subtitle: '用参考图重新创作', kinds: [['sdxl_i2i', 'SDXL · 图像重绘']] },
  video: { title: '视频生成', subtitle: '掌控画面、时长与运动', kinds: [['h3_t2v', 'H3 · 文生视频'], ['h3_i2v', 'H3 · 首尾帧视频'], ['h3_ref', 'H3 · 多图参考视频']] },
};
export function newDraft(mode, kind = STUDIO_MODES[mode]?.kinds[0][0]) {
  const video = mode === 'video', krea = kind === 'krea';
  return { kind, positive: '', negative: '', width: video ? 768 : 1024, height: video ? 448 : 1024,
    steps: video ? 20 : krea ? 8 : 25, cfg: video || krea ? 1 : 7, seed: 42, seconds: 5,
    sampler: 'euler', scheduler: 'simple', denoise: mode === 'img2img' ? .65 : 1,
    shift_video: 12, shift_audio: 3, ref_image_size: 'match', models: {}, loras: [], references: [] };
}
export function restoreDraft(mode, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || !STUDIO_MODES[mode].kinds.some(([kind]) => kind === source.kind)) return newDraft(mode);
  const draft = newDraft(mode, source.kind);
  for (const key of Object.keys(draft)) if (!['models', 'loras', 'references'].includes(key) && ['string', 'number'].includes(typeof source[key])) draft[key] = source[key];
  if (source.models && typeof source.models === 'object') for (const key of ['checkpoint', 'dit', 'text_encoder', 'vae', 'audio_vae']) if (typeof source.models[key] === 'string') draft.models[key] = source.models[key].slice(0, 1024);
  if (Array.isArray(source.loras)) draft.loras = source.loras.slice(0, 4).filter(item => item && typeof item.name === 'string').map(item => ({ name: item.name.slice(0, 1024), strength_model: item.strength_model ?? 1, ...(source.kind.startsWith('sdxl') ? { strength_clip: item.strength_clip ?? 1 } : {}) }));
  if (Array.isArray(source.references)) draft.references = source.references.slice(0, 9).filter(item => item && typeof item.name === 'string' && typeof item.url === 'string').map(item => ({ name: item.name.slice(0, 1024), url: item.url.slice(0, 2048), label: String(item.label || item.name).slice(0, 200), backend: typeof item.backend === 'string' ? item.backend : '' }));
  return draft;
}
export function buildStudioRequest(draft, backend = '') {
  if (!Object.values(STUDIO_MODES).some(mode => mode.kinds.some(([kind]) => kind === draft.kind))) throw new Error('不支持此生成模式');
  if (typeof draft.positive !== 'string' || !draft.positive.trim()) throw new Error('请填写正向提示词');
  const video = draft.kind.startsWith('h3'), imageEdit = draft.kind === 'sdxl_i2i';
  const read = (key, min, max, integer = false) => {
    const raw = draft[key], value = Number(raw);
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`参数 ${key} 超出范围或不是有效数字`);
    return value;
  };
  const request = { kind: draft.kind, positive: draft.positive, negative: draft.negative || '',
    width: read('width', 64, 4096, true), height: read('height', 64, 4096, true),
    steps: read('steps', 1, 200, true), cfg: read('cfg', 0, 100), seed: read('seed', 0, Number.MAX_SAFE_INTEGER, true),
    sampler: draft.sampler, scheduler: draft.scheduler, denoise: video || !imageEdit ? 1 : read('denoise', 0, 1),
    models: { ...(draft.models || {}) }, loras: (draft.loras || []).filter(item => item.name).map(item => ({ ...item })) };
  const step = video ? 32 : draft.kind === 'krea' ? 16 : 8;
  if (request.width % step || request.height % step) throw new Error(`当前模式的宽高须为 ${step} 的倍数`);
  const refs = draft.references || [];
  if (refs.some(ref => backend && ref.backend && ref.backend !== backend)) throw new Error('参考图来自另一个引擎，请重新上传到当前引擎');
  if (imageEdit && refs.length !== 1) throw new Error('图生图需要上传一张参考图片');
  if (draft.kind === 'h3_i2v' && (refs.length < 1 || refs.length > 2)) throw new Error('首尾帧视频需要一张首帧，可再添加一张尾帧');
  if (draft.kind === 'h3_ref' && (refs.length < 1 || refs.length > 9)) throw new Error('参考视频需要 1–9 张参考图片');
  if ((imageEdit || ['h3_i2v', 'h3_ref'].includes(draft.kind)) && refs.some(ref => !ref.name)) throw new Error('参考图尚未上传完成');
  if (imageEdit || ['h3_i2v', 'h3_ref'].includes(draft.kind)) {
    request.references = refs.map(ref => ref.name);
    request.reference_roles = refs.map((ref, index) => draft.kind === 'h3_i2v' ? index ? 'end' : 'start' : 'reference');
  }
  if (video) Object.assign(request, { seconds: read('seconds', 1, 30), fps: 24, shift_video: read('shift_video', .01, 100), shift_audio: read('shift_audio', .01, 100), ref_image_size: draft.ref_image_size || 'match' });
  if (video && request.sampler === 'dual_clock_euler' && (request.cfg !== 1 || request.negative.trim())) throw new Error('双时钟采样要求 CFG=1 且负向提示词为空');
  if (request.loras.length > 4) throw new Error('最多叠加 4 个 LoRA');
  if (request.loras.length && !draft.kind.startsWith('sdxl') && !request.models.dit) throw new Error('请先明确选择 DiT 主模型，再使用对应 LoRA');
  for (const lora of request.loras) {
    for (const key of ['strength_model', 'strength_clip']) {
      if (key === 'strength_clip' && (video || draft.kind === 'krea')) { if (lora[key] !== undefined && Number(lora[key]) !== 0) throw new Error('当前模式仅支持模型 LoRA，不支持 CLIP 强度'); delete lora[key]; continue; }
      if (lora[key] === undefined) lora[key] = 1;
      if (lora[key] === '' || !Number.isFinite(Number(lora[key])) || Number(lora[key]) < -10 || Number(lora[key]) > 10) throw new Error('LoRA 强度应在 -10 到 10 之间');
      lora[key] = Number(lora[key]);
    }
  }
  return request;
}
