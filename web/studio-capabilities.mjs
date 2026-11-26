/** Stable capability controls: discovery never replaces the surrounding form or draft. */
const element = (tag, css = '', text) => { const value = document.createElement(tag); value.className = css; if (text !== undefined) value.textContent = text; return value; };
const names = values => [...new Set((Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? value : value?.name).filter(value => typeof value === 'string' && value))];

export function studioSdxlEncoderNames(engine, key) {
  return names(engine?.generation_options?.sdxl_clip?.[{ sdxl_clip_l: 'clip_name1', sdxl_clip_g: 'clip_name2' }[key]]);
}
export function studioExternalModelOptions(values, current) {
  const candidates = names(values);
  return [{ value: '', label: '不使用外置覆盖', disabled: false }, ...candidates.map(value => ({ value, label: value, disabled: false })),
    ...(current && !candidates.includes(current) ? [{ value: current, label: `${current} · 当前列表未找到`, disabled: true, missing: true }] : [])];
}
function options(select, choices, current) {
  const signature = JSON.stringify([choices, current || '']);
  if (select.choiceSignature === signature) return;
  select.replaceChildren(...choices.map(choice => {
    const option = element('option', '', choice.label); option.value = choice.value; option.disabled = !!choice.disabled;
    if (choice.missing) option.dataset.missing = 'true'; return option;
  }));
  select.value = current || ''; select.choiceSignature = signature;
}
export function createSdxlCapabilities({ draft, engine, onChange }) {
  const encoders = element('details', 'studio-details studio-encoders');
  const refine = element('details', 'studio-details studio-refine');
  encoders.open = !!engine()?.generation_options?.sdxl_clip?.available;
  refine.open = draft.refine.enabled === true;
  encoders.append(element('summary', '', 'SDXL 外置文本编码器'));
  const clipHint = element('p', 'studio-help'), clipFields = element('div'), clipSelects = new Map();
  for (const [key, label] of [['sdxl_clip_l', 'CLIP-L 文件'], ['sdxl_clip_g', 'CLIP-G 文件']]) {
    const wrap = element('label', 'studio-field'), select = element('select'); select.setAttribute('aria-label', label); select.dataset.model = key;
    select.addEventListener('change', () => { draft.models[key] = select.value; onChange(); update(); });
    wrap.append(element('span', '', label), select); clipFields.append(wrap); clipSelects.set(key, select);
  }
  const clear = element('button', 'button quiet', '清除外置编码器覆盖'); clear.type = 'button';
  clear.addEventListener('click', () => { delete draft.models.sdxl_clip_l; delete draft.models.sdxl_clip_g; onChange(); update(); });
  encoders.append(clipHint, clipFields, clear);
  refine.append(element('summary', '', '高清二次重绘'));
  const refineHint = element('p', 'studio-help'), toggle = element('label', 'studio-field studio-check'), enabled = element('input');
  enabled.type = 'checkbox'; enabled.setAttribute('aria-label', '启用高清二次重绘');
  enabled.addEventListener('change', () => {
    draft.refine.enabled = enabled.checked;
    if (enabled.checked && !draft.refine.upscale_method) draft.refine.upscale_method = names(engine()?.generation_options?.refine?.upscale_methods)[0] || '';
    onChange(); update();
  });
  toggle.append(enabled, element('span', '', '启用第二阶段潜空间放大与重绘'));
  const fields = element('div'), grid = element('div', 'studio-grid'), numbers = new Map();
  for (const [label, key, min, max, step] of [['二次宽度 / px', 'width', 64, 8192, 8], ['二次高度 / px', 'height', 64, 8192, 8], ['二次采样步数', 'steps', 1, 200, 1], ['二次去噪', 'denoise', 0, 1, .05]]) {
    const wrap = element('label', 'studio-field'), input = element('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step;
    input.value = draft.refine[key]; input.setAttribute('aria-label', label);
    input.addEventListener('input', () => { draft.refine[key] = input.value === '' ? '' : Number(input.value); onChange(); });
    wrap.append(element('span', '', label), input); grid.append(wrap); numbers.set(key, input);
  }
  const method = element('label', 'studio-field'), methodSelect = element('select'); methodSelect.setAttribute('aria-label', '潜空间放大方法');
  methodSelect.addEventListener('change', () => { draft.refine.upscale_method = methodSelect.value; onChange(); update(); });
  method.append(element('span', '', '潜空间放大方法'), methodSelect);
  fields.append(grid, method, element('small', 'studio-help', '目标宽高独立于首阶段；后端将放大与第二次采样编译为同一任务。'));
  refine.append(refineHint, toggle, fields);
  function update() {
    const capabilities = engine()?.generation_options || {}, clip = capabilities.sdxl_clip || {}, upscale = capabilities.refine || {};
    const hasClip = !!clip.available && Array.isArray(clip.types) && clip.types.includes('sdxl');
    const hasOverride = !!(draft.models.sdxl_clip_l || draft.models.sdxl_clip_g);
    clipHint.textContent = hasClip ? '同时指定 CLIP-L 与 CLIP-G；留空使用 Checkpoint 内置编码器。' : clip.reason || '当前后端没有可用的 SDXL 双编码器加载器。';
    clipHint.classList.toggle('disabled-capability', !hasClip); clipFields.hidden = !hasClip && !hasOverride; clear.hidden = !hasOverride;
    for (const [key, select] of clipSelects) { options(select, studioExternalModelOptions(hasClip ? studioSdxlEncoderNames(engine(), key) : [], draft.models[key]), draft.models[key]); select.disabled = !hasClip; }
    const hasRefine = !!upscale.available, checked = draft.refine.enabled === true;
    enabled.checked = checked; enabled.disabled = !hasRefine && !checked;
    refineHint.hidden = hasRefine; refineHint.textContent = upscale.reason || `当前后端不支持二次重绘。${(upscale.missing || []).join('、')}`;
    refineHint.classList.toggle('disabled-capability', !hasRefine); refine.classList.toggle('enabled', checked);
    fields.hidden = !hasRefine && !checked;
    for (const input of numbers.values()) input.disabled = !hasRefine;
    const methods = hasRefine ? names(upscale.upscale_methods) : [], current = draft.refine.upscale_method;
    options(methodSelect, [{ value: '', label: '请选择放大方法' }, ...methods.map(value => ({ value, label: value })),
      ...(current && !methods.includes(current) ? [{ value: current, label: `${current} · 当前后端不支持`, disabled: true, missing: true }] : [])], current);
    methodSelect.disabled = !hasRefine;
  }
  update(); return { encoders, refine, update };
}
