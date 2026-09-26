import { STUDIO_MODES, newDraft, restoreDraft, buildStudioRequest, performanceSuggestion } from './studio-state.mjs';
import { audioIntegrationRequest, audioPackageChoices, buildAudioPackageRequest, renderAudioFields, initialAudioValues } from './audio-studio.mjs';

const STORAGE = 'prismcanvas.studio.v1';
const node = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };
const labels = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '待确认' };
const safeURL = value => { try { const url = new URL(value, location.origin); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } };

export function studioModelNames(names, families, key, kind, search = '') {
  const family = kind.startsWith('h3') ? 'h3' : kind.startsWith('sdxl') ? 'sdxl' : kind.startsWith('qwen21') ? 'qwen21' : kind;
  const query = String(search).trim().toLowerCase();
  return names.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean).filter(name => {
    if (query && !name.toLowerCase().includes(query)) return false;
    const known = families?.[name];
    if (known && known !== 'unknown' && known !== family && !(family === 'krea' && key === 'vae' && known === 'qwen_image')) return false;
    if (family === 'qwen21' && known !== 'qwen21' && !query) return false;
    if (family === 'h3' && key === 'dit' && (kind === 'h3_ref' ? /fl2va/i.test(name) : /ref2va/i.test(name))) return false;
    return true;
  });
}

export function createGenerationStudio(host) {
  let active = 'canvas', drafts = Object.fromEntries(Object.keys(STUDIO_MODES).map(mode => [mode, newDraft(mode)]));
  let kindDrafts = {}, pending = {}, selectedJobs = {}, busy = new Set(), panels = new Map(), lastMedia = new Map(), lastCatalog = new Map(), initialized = false, storageWarned = false;
  let audioDrafts = { voice: newAudioDraft(), music: newAudioDraft() }, audioCategory = 'voice', audioChoices = { stale: true, available: false, packages: [] }, audioCapability = null, audioCapabilitiesBackend = '', audioLoading = false, audioLoadError = '';
  const root = document.querySelector('#studio-root');
  const save = (critical = false) => {
    try { localStorage.setItem(STORAGE, JSON.stringify({ drafts, kindDrafts, pending, selectedJobs, audioDrafts, audioCategory })); }
    catch { if (critical) throw new Error('无法保存提交记录，请先检查浏览器本地存储'); if (!storageWarned) { host.toast('工作台草稿保存失败，请导出参数后检查存储空间', true); storageWarned = true; } }
  };
  const action = (text, className, fn) => { const b = node('button', className, text); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(fn).catch(host.reportError)); return b; };
  const pause = container => container?.querySelectorAll('video,audio').forEach(media => media.pause());
  const backend = () => host.engine().backend_url || '';
  function newAudioDraft() { return { package_id: '', values: {}, valuesByPackage: {}, mediaBackends: {}, mediaBackendsByPackage: {} }; }
  function open(mode) {
    if (mode !== 'canvas' && !STUDIO_MODES[mode] && mode !== 'audio') return;
    pause(root); active = mode; document.body.dataset.workspace = mode; document.body.classList.remove('canvas-focus');
    document.querySelectorAll('.workspace-nav[data-workspace]').forEach(button => { button.classList.toggle('active', button.dataset.workspace === mode); button.setAttribute('aria-pressed', String(button.dataset.workspace === mode)); });
    root.hidden = mode === 'canvas';
    if (mode !== 'canvas') {
      document.querySelectorAll('#canvas video,#canvas audio,#jobs-panel video,#jobs-panel audio').forEach(media => media.pause());
      if (!panels.has(mode)) render(mode);
      for (const [name, panel] of panels) panel.hidden = name !== mode;
      if (mode === 'audio') { refreshAudioCapabilities(); refreshAudio(); }
      else refresh();
    }
    window.dispatchEvent(new Event('resize'));
  }
  function field(mode, label, key, options = {}) {
    const wrap = node('label', 'studio-field'), title = node('span', '', label); wrap.append(title);
    const input = node(options.select ? 'select' : options.multiline ? 'textarea' : 'input');
    input.name = key; input.setAttribute('aria-label', label);
    if (options.select) setOptions(input, options.select, drafts[mode][key]);
    else {
      if (!options.multiline) input.type = options.number ? 'number' : 'text'; input.value = drafts[mode][key] ?? '';
      if (options.multiline) input.rows = options.rows || 4;
      for (const attr of ['min', 'max', 'step', 'placeholder']) if (options[attr] !== undefined) input.setAttribute(attr, options[attr]);
    }
    input.addEventListener(options.select ? 'change' : 'input', () => { if (options.change) { options.change(input.value); return; } drafts[mode][key] = options.number ? input.value === '' ? '' : Number(input.value) : input.value; save(); refresh(); });
    wrap.append(input); if (options.help) wrap.append(node('small', '', options.help)); return wrap;
  }
  function setOptions(select, options, current, preserveMissing = true) {
    select.replaceChildren();
    for (const item of options) { const [value, text] = Array.isArray(item) ? item : [item, item]; const opt = node('option', '', text); opt.value = value; select.append(opt); }
    if (preserveMissing && current && !Array.from(select.options).some(option => option.value === current)) { const missing = node('option', '', `${current} · 当前列表未找到`); missing.value = current; select.append(missing); }
    select.value = current || '';
  }
  function values(key, mode, search = '') {
    const kind = drafts[mode].kind;
    const families = host.engine().generation_options?.model_families?.[key] || {};
    const loaders = host.engine().generation_options?.lora_loaders;
    if (key === 'lora' && loaders) {
      const dit = drafts[mode].models?.dit || '';
      if (!kind.startsWith('sdxl') && !dit) return [];
      const loader = kind.startsWith('sdxl') ? 'LoraLoader' : /int8|fp8|nvfp4|gguf/i.test(dit) && loaders.LoraLoaderBypassModelOnly ? 'LoraLoaderBypassModelOnly' : 'LoraLoaderModelOnly';
      return studioModelNames(loaders[loader]?.names || [], families, key, kind, search);
    }
    let list = host.engine().models?.[key] || (key === 'checkpoint' ? host.engine().models?.checkpoints : []) || [];
    const recommended = kind.startsWith('qwen21') ? [] : host.catalog(key, drafts[mode].kind) || [];
    return studioModelNames([...new Set([...recommended, ...list])], families, key, kind, search);
  }
  function modelSelector(mode, key, label, target, change) {
    const wrap = node('label', 'studio-field studio-model'), title = node('span', '', label), search = node('input'), select = node('select');
    search.type = 'search'; search.placeholder = '搜索本地文件名…'; search.setAttribute('aria-label', `搜索${label}`);
    select.setAttribute('aria-label', label); select.dataset.model = key;
    const update = () => {
      const current = target(), kind = drafts[mode].kind, families = host.engine().generation_options?.model_families?.[key] || {}, known = families[current];
      const hiddenIncompatible = kind.startsWith('qwen21') && current && known && known !== 'unknown' && known !== 'qwen21';
      const list = values(key, mode, search.value);
      setOptions(select, [['', key === 'lora' ? '选择 LoRA 文件' : '自动匹配（可手动选择）'], ...list], hiddenIncompatible ? '' : current, !hiddenIncompatible);
    };
    search.addEventListener('input', update); select.addEventListener('change', () => { change(select.value); save(); refresh(); });
    wrap.append(title, search, select); wrap.updateCatalog = update; update(); return wrap;
  }
  function explicitModelSelector(mode, key, label, names, target, change) {
    const wrap = node('label', 'studio-field studio-model'), title = node('span', '', label), select = node('select');
    select.setAttribute('aria-label', label); select.dataset.model = key;
    const update = () => setOptions(select, [['', '不使用外置覆盖'], ...names.map(name => [name, name])], target());
    select.addEventListener('change', () => { change(select.value); save(); });
    wrap.append(title, select); wrap.updateCatalog = update; update(); return wrap;
  }
  function loraRows(mode, container) {
    container.replaceChildren(); const draft = drafts[mode], clip = draft.kind.startsWith('sdxl');
    draft.loras.forEach((item, index) => {
      const row = node('div', 'studio-lora-row');
      row.append(modelSelector(mode, 'lora', `LoRA ${index + 1}`, () => item.name, value => { item.name = value; }));
      const controls = node('div', 'studio-grid');
      for (const [key, label] of [['strength_model', '模型强度'], ...(clip ? [['strength_clip', '文本强度']] : [])]) {
        const wrap = node('label', 'studio-field', label), input = node('input'); input.type = 'number'; input.min = -10; input.max = 10; input.step = .05; input.value = item[key] ?? 1; input.setAttribute('aria-label', `LoRA ${index + 1} ${label}`);
        input.addEventListener('input', () => { item[key] = input.value === '' ? '' : Number(input.value); save(); }); wrap.append(input); controls.append(wrap);
      }
      controls.append(action('移除', 'button quiet', () => { draft.loras.splice(index, 1); save(); loraRows(mode, container); })); row.append(controls); container.append(row);
    });
    const add = action('＋ 添加 LoRA', 'button quiet', () => { if (draft.loras.length >= 4) return; if (!clip && !draft.models.dit) throw new Error('请先明确选择 DiT 主模型，再添加对应 LoRA'); draft.loras.push({ name: '', strength_model: 1, ...(clip ? { strength_clip: 1 } : {}) }); save(); loraRows(mode, container); });
    add.disabled = draft.loras.length >= 4; container.append(add);
  }
  function references(mode, container) {
    pause(container); container.replaceChildren(); const draft = drafts[mode];
    draft.references.forEach((ref, index) => {
      const row = node('div', 'studio-reference'); const image = node('img'); image.src = safeURL(ref.url); image.alt = ref.label || ref.name;
      const qwenEdit = draft.kind === 'qwen21_edit', label = qwenEdit ? index === 0 ? '编辑目标 · 图 1' : `参考图 · 图 ${index + 1}` : draft.kind === 'h3_i2v' ? index ? '尾帧' : '首帧' : '参考图';
      row.append(image, node('span', '', `${label} · ${ref.label || ref.name}`));
      if (qwenEdit) {
        const up = action('↑', 'button quiet compact', () => { [draft.references[index - 1], draft.references[index]] = [draft.references[index], draft.references[index - 1]]; save(); references(mode, container); });
        up.disabled = index === 0; up.setAttribute('aria-label', `图 ${index + 1} 上移`); up.title = '上移';
        const down = action('↓', 'button quiet compact', () => { [draft.references[index], draft.references[index + 1]] = [draft.references[index + 1], draft.references[index]]; save(); references(mode, container); });
        down.disabled = index === draft.references.length - 1; down.setAttribute('aria-label', `图 ${index + 1} 下移`); down.title = '下移'; row.append(up, down);
      }
      row.append(action('移除', 'button quiet', () => { draft.references.splice(index, 1); save(); references(mode, container); })); container.append(row);
    });
    const input = node('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.multiple = draft.kind === 'qwen21_edit' || draft.kind === 'h3_ref'; input.hidden = true;
    const upload = action(draft.references.length ? '＋ 添加图片' : '＋ 上传参考图片', 'button studio-upload', () => input.click());
    const limit = draft.kind === 'qwen21_edit' ? 10 : mode === 'img2img' ? 1 : draft.kind === 'h3_i2v' ? 2 : 9; upload.disabled = draft.references.length >= limit;
    input.addEventListener('change', async () => {
      upload.disabled = true;
      const startedBackend = backend();
      try {
        const selectedFiles = Array.from(input.files), remaining = limit - draft.references.length;
        if (selectedFiles.length > remaining) host.toast(`当前还可添加 ${remaining} 张图片，本次多选的 ${selectedFiles.length - remaining} 张不会上传`, true);
        const files = selectedFiles.slice(0, remaining);
        for (const file of files) {
          if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 20 * 1024 * 1024) throw new Error('参考图支持 PNG/JPEG/WebP，每张最多 20 MiB');
          const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
          const uploaded = await host.api('/api/upload', { data });
          if (drafts[mode] !== draft || startedBackend !== backend()) throw new Error('模式或引擎已切换，请重新选择参考图');
          draft.references.push({ ...uploaded, label: file.name, backend: startedBackend }); save();
        }
      } catch (error) { host.reportError(error); }
      finally { if (drafts[mode] === draft) references(mode, container); }
    });
    const help = draft.kind === 'qwen21_edit' ? 'Qwen Image 2.1 条件编辑：第 1 张是编辑目标，第 2–10 张依序作为参考；可用 ↑ / ↓ 调整顺序。固定完整采样（denoise=1），不使用 SDXL 低去噪重绘。' : mode === 'img2img' ? 'SDXL 重绘会根据画幅缩放参考图；去噪越低，越接近原图。' : '首尾帧按添加顺序排列；参考素材保留在你的推理引擎。';
    container.append(input, upload, node('small', 'studio-help', help));
  }
  function render(mode) {
    if (mode === 'audio') return renderAudio();
    const old = panels.get(mode); pause(old); old?.remove(); const draft = drafts[mode], config = STUDIO_MODES[mode];
    const panel = node('section', 'studio-panel'); panel.dataset.studioMode = mode;
    const header = node('header', 'studio-heading'), heading = node('div'); heading.append(node('span', 'eyebrow', 'GENERATION STUDIO'), node('h1', '', config.title), node('p', '', config.subtitle));
    const tools = node('div', 'studio-heading-actions'); tools.append(action('刷新模型', 'button quiet', async () => { await host.refreshEngine(true); updateCatalogs(panel); refresh(); }), action('引擎设置', 'button', () => host.openSettings()), action('开始生成', 'button primary studio-run-top', () => submit(mode))); header.append(heading, tools);
    const layout = node('div', 'studio-layout'), form = node('div', 'studio-form'), results = node('div', 'studio-results');
    const section = (title, hint = '') => { const block = node('section', 'studio-section'); block.append(node('h2', '', title)); if (hint) block.append(node('p', 'studio-help', hint)); form.append(block); return block; };
    const qwen21 = draft.kind.startsWith('qwen21');
    const models = section('01  模型与风格', qwen21 ? '模型列表来自当前引擎；默认只列出后端标记为 qwen21 的项。搜索可手动选择未分类文件，但需自行核对兼容性。已知其他架构会过滤。' : '模型列表来自当前本地推理引擎，无需复制模型到客户端。');
    const kindField = field(mode, '生成引擎', 'kind', { select: config.kinds, change: kind => {
      kindDrafts[mode] ||= {}; kindDrafts[mode][draft.kind] = structuredClone(draft);
      const cached = kindDrafts[mode][kind], next = cached ? restoreDraft(mode, cached) : newDraft(mode, kind);
      if (!cached) { next.positive = draft.positive; next.negative = draft.negative; }
      drafts[mode] = next; save(); render(mode); refresh();
    } }); models.append(kindField);
    const isSdxl = ['sdxl', 'sdxl_i2i'].includes(draft.kind);
    const modelKeys = isSdxl ? [['checkpoint', 'Checkpoint 主模型'], ['vae', '独立 VAE 覆盖']] : [['dit', 'DiT 主模型'], ['text_encoder', '文本编码器'], ['vae', '图像 / 视频 VAE'], ...(mode === 'video' ? [['audio_vae', '音频 VAE']] : [])];
    modelKeys.forEach(([key, label]) => models.append(modelSelector(mode, key, label, () => draft.models[key], value => { draft.models[key] = value; })));
    if (isSdxl) {
      const clip = host.engine().generation_options?.sdxl_clip || {};
      const clipBlock = node('details', 'studio-details'); clipBlock.open = !!clip.available;
      clipBlock.append(node('summary', '', 'SDXL 外置文本编码器'));
      if (clip.available && clip.types?.includes('sdxl')) {
        clipBlock.append(node('small', 'studio-help', '需要同时指定 CLIP-L 与 CLIP-G。留空则继续使用 Checkpoint 内置编码器。'));
        for (const [key, label, names] of [['sdxl_clip_l', 'CLIP-L 文件', clip.clip_name1 || []], ['sdxl_clip_g', 'CLIP-G 文件', clip.clip_name2 || []]]) {
          clipBlock.append(explicitModelSelector(mode, key, label, names, () => draft.models[key] || '', value => { draft.models[key] = value; }));
        }
      } else {
        clipBlock.append(node('p', 'studio-help disabled-capability', clip.reason || `当前后端未声明兼容的 DualCLIPLoader（缺少实时 SDXL 类型或编码器选项）。${(clip.missing || []).join('、')}`));
      }
      models.append(clipBlock);
    }
    const loras = node('details', 'studio-details'); loras.open = true; loras.append(node('summary', '', 'LoRA 叠加 · 最多 4 个')); const rows = node('div'); loraRows(mode, rows); loras.append(rows, node('small', 'studio-help', '选择与主模型架构兼容的 LoRA。文件名推荐不代表兼容性已验证；模型 / 文本强度可分别调整。')); models.append(loras);
    if (mode === 'img2img' || draft.kind === 'qwen21_edit' || ['h3_i2v', 'h3_ref'].includes(draft.kind)) { const block = section(draft.kind === 'qwen21_edit' ? '02  编辑目标与条件参考图' : '02  参考图片'); const refs = node('div'); references(mode, refs); block.append(refs); }
    const prompts = section('提示词'); prompts.append(field(mode, '正向提示词', 'positive', { multiline: true, rows: 6, placeholder: '描述主体、环境、光线、构图；视频可加入动作与运镜…' }), field(mode, '负向提示词', 'negative', { multiline: true, rows: 3, placeholder: '不希望出现的内容…' }), action('复制提示词', 'button quiet', () => host.copyText(`${draft.positive}${draft.negative ? `\n\n负向提示词：${draft.negative}` : ''}`)));
    const qwenEdit = draft.kind === 'qwen21_edit', controls = section(qwenEdit ? '尺寸策略与采样' : '画幅与采样'), presets = node('div', 'studio-presets');
    if (qwenEdit) {
      const wrap = node('label', 'studio-field'), title = node('span', '', '输出尺寸模式'), select = node('select'); select.setAttribute('aria-label', '输出尺寸模式');
      for (const [value, label] of [['false', '按编辑目标比例与参考分辨率'], ['true', '自定义宽度和高度']]) { const option = node('option', '', label); option.value = value; select.append(option); }
      select.value = String(draft.custom_size); select.addEventListener('change', () => { draft.custom_size = select.value === 'true'; save(); render(mode); refresh(); }); wrap.append(title, select); controls.append(wrap);
      controls.append(field(mode, '参考分辨率 / px', 'ref_resolution', { number: true, min: 0, max: 4096, step: 32, help: '控制条件参考图的面积预算；按首图模式同时决定输出尺寸。设为 0 保留输入尺寸并对齐 32。' }));
    }
    const showExplicitSize = !qwenEdit || draft.custom_size;
    if (showExplicitSize) {
      for (const [label, w, h] of [['方形', 1024, 1024], ['横屏', mode === 'video' ? 768 : 1216, mode === 'video' ? 448 : 832], ['竖屏', mode === 'video' ? 448 : 832, mode === 'video' ? 768 : 1216]]) presets.append(action(label, 'button quiet compact', () => { draft.width = w; draft.height = h; panel.querySelector('[name=width]').value = w; panel.querySelector('[name=height]').value = h; save(); }));
      presets.append(action('按 GPU 建议填充', 'button quiet compact', () => applyPerformancePlan(mode)));
      controls.append(presets);
    }
    const grid = node('div', 'studio-grid');
    const sizeStep = mode === 'video' || draft.kind.startsWith('qwen21') ? 32 : draft.kind === 'krea' ? 16 : 8;
    if (showExplicitSize) for (const [label, key] of [['宽度 / px', 'width'], ['高度 / px', 'height']]) grid.append(field(mode, label, key, { number: true, min: 64, max: 4096, step: sizeStep }));
    for (const [label, key, min, max, step] of [['采样步数', 'steps', 1, 200, 1], ['提示词引导 CFG', 'cfg', 0, 100, .1]]) grid.append(field(mode, label, key, { number: true, min, max, step }));
    const options = samplerOptions(mode);
    grid.append(field(mode, '采样器', 'sampler', { select: options.samplers?.length ? options.samplers : ['euler'] }), field(mode, '调度器', 'scheduler', { select: options.schedulers?.length ? options.schedulers : ['simple'] }));
    if (mode === 'img2img') grid.append(field(mode, '去噪强度', 'denoise', { number: true, min: 0, max: 1, step: .05, help: '低值保留原图，高值更自由地重绘。' }));
    if (mode === 'video') grid.append(field(mode, '时长 / 秒', 'seconds', { number: true, min: 1, max: 30, step: .1, help: 'H3 固定 24 fps，实际帧数以编译结果为准。' }));
    controls.append(grid, field(mode, '随机种子', 'seed', { number: true, min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }), action('换一个随机种子', 'button quiet', () => { draft.seed = crypto.getRandomValues(new Uint32Array(1))[0]; panel.querySelector('[name=seed]').value = draft.seed; save(); }));
    if (mode === 'video') { const advanced = node('details', 'studio-details'); advanced.append(node('summary', '', '高级视频参数')); const g = node('div', 'studio-grid'); g.append(field(mode, '视频 Shift', 'shift_video', { number: true, min: .01, max: 100, step: .01 }), field(mode, '音频 Shift', 'shift_audio', { number: true, min: .01, max: 100, step: .01 })); if (draft.kind === 'h3_ref') g.append(field(mode, '参考图尺寸策略', 'ref_image_size', { select: ['match', 'max'] })); advanced.append(g); controls.append(advanced); }
    if (isSdxl) {
      const capability = host.engine().generation_options?.refine || {};
      const refine = node('details', 'studio-details studio-refine'); refine.open = draft.refine.enabled === true && !!capability.available;
      refine.append(node('summary', '', '高清二次重绘'));
      if (!capability.available) refine.append(node('p', 'studio-help disabled-capability', capability.reason || `当前后端的实时 schema 不支持二次重绘。${(capability.missing || []).join('、')}`));
      else {
        const enabled = node('label', 'studio-field studio-check'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = draft.refine.enabled === true; checkbox.setAttribute('aria-label', '启用高清二次重绘');
        checkbox.addEventListener('change', () => { draft.refine.enabled = checkbox.checked; save(); refine.classList.toggle('enabled', checkbox.checked); });
        enabled.append(checkbox, node('span', '', '启用第二阶段潜空间放大与重绘')); refine.append(enabled);
        const grid = node('div', 'studio-grid');
        for (const [label, key, min, max, step] of [['二次宽度 / px', 'width', 64, 8192, 8], ['二次高度 / px', 'height', 64, 8192, 8], ['二次采样步数', 'steps', 1, 200, 1], ['二次去噪', 'denoise', 0, 1, .05]]) {
          const wrap = node('label', 'studio-field'), title = node('span', '', label), input = node('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = draft.refine[key]; input.setAttribute('aria-label', label);
          input.addEventListener('input', () => { draft.refine[key] = input.value === '' ? '' : Number(input.value); save(); }); wrap.append(title, input); grid.append(wrap);
        }
        refine.append(grid);
        const method = node('label', 'studio-field'); method.append(node('span', '', '潜空间放大方法'));
        const select = node('select'); setOptions(select, (capability.upscale_methods || []).map(value => [value, value]), draft.refine.upscale_method || capability.upscale_methods?.[0] || '', false);
        if (!draft.refine.upscale_method && capability.upscale_methods?.length) draft.refine.upscale_method = capability.upscale_methods[0];
        select.addEventListener('change', () => { draft.refine.upscale_method = select.value; save(); }); method.append(select); refine.append(method);
        refine.append(node('small', 'studio-help', '后端会将此阶段编译为同一冻结图中的潜空间放大与第二个采样器；目标宽高独立于首阶段。'));
      }
      controls.append(refine);
    }
    const footer = node('div', 'studio-submit');
    footer.append(action('检查依赖', 'button quiet', () => inspect(mode, 'diagnostics')), action('预览执行参数', 'button quiet', () => inspect(mode, 'compile')));
    const generate = action('开始生成', 'button primary studio-generate', () => submit(mode)); generate.dataset.studioGenerate = mode; footer.append(generate);
    const status = node('p', 'studio-operation'); status.setAttribute('aria-live', 'polite'); footer.append(status);
    const query = action('查询上次提交', 'button studio-query', () => queryPending(mode)); query.hidden = true; footer.append(query); form.append(footer);
    const resume = action('继续发送原请求', 'button studio-resume', () => dispatchPending(mode)); resume.hidden = true; footer.append(resume);
    const inspection = node('details', 'studio-inspection'); inspection.hidden = true; inspection.append(node('summary', '', '检查与执行参数')); const pre = node('pre'); inspection.append(pre); form.append(inspection);
    results.append(node('div', 'studio-result-toolbar')); const media = node('div', 'studio-preview'); results.append(media); const history = node('div', 'studio-history'); results.append(history);
    layout.append(form, results); panel.append(header, layout); root.append(panel); panels.set(mode, panel); lastMedia.delete(mode); lastCatalog.delete(mode); panel.hidden = active !== mode;
  }
  function saveAudioDrafts(critical = false) {
    try { localStorage.setItem(STORAGE, JSON.stringify({ drafts, kindDrafts, pending, selectedJobs, audioDrafts, audioCategory })); }
    catch { if (critical) throw new Error('无法保存音频提交记录，请检查浏览器本地存储'); if (!storageWarned) { host.toast('音频工作台草稿保存失败，请检查浏览器本地存储', true); storageWarned = true; } }
  }
  function audioKey() { return `audio_${audioCategory}`; }
  function currentAudioPackage(category = audioCategory) { return audioChoices.packages.find(pack => pack.id === audioDrafts[category]?.package_id) || null; }
  async function refreshAudioCapabilities(force = false) {
    const selectedBackend = backend();
    if (audioLoading || !force && audioCapabilitiesBackend === selectedBackend && !audioChoices.stale) return;
    audioLoading = true; audioLoadError = '';
    try {
      await host.loadPackages?.();
      audioCapability = await host.api('/api/audio-capabilities');
      audioCapabilitiesBackend = selectedBackend;
      audioChoices = audioPackageChoices(audioCapability, host.packages?.() || [], selectedBackend);
      if (audioChoices.stale) audioLoadError = '音频能力来自另一个推理引擎，请刷新后再选择工作流包';
    } catch (error) {
      audioChoices = { stale: true, available: false, packages: [] }; audioLoadError = error.message || '无法读取当前引擎的音频能力';
    } finally {
      audioLoading = false;
      if (active === 'audio') { renderAudio(); refreshAudio(); }
    }
  }
  function selectAudioPackage(category, packageId) {
    const draft = audioDrafts[category];
    if (draft.package_id) {
      draft.valuesByPackage[draft.package_id] = structuredClone(draft.values || {});
      draft.mediaBackendsByPackage[draft.package_id] = { ...(draft.mediaBackends || {}) };
    }
    draft.package_id = packageId;
    draft.values = structuredClone(draft.valuesByPackage[packageId] || initialAudioValues(audioChoices.packages.find(item => item.id === packageId)));
    draft.mediaBackends = { ...(draft.mediaBackendsByPackage[packageId] || {}) };
    saveAudioDrafts(); renderAudio(); refreshAudio();
  }
  function renderAudio() {
    const old = panels.get('audio'); pause(old); old?.remove();
    const panel = node('section', 'studio-panel audio-panel'); panel.dataset.studioMode = 'audio';
    const header = node('header', 'studio-heading'), heading = node('div');
    heading.append(node('span', 'eyebrow', 'LOCAL AUDIO WORKBENCH'), node('h1', '', '声音与音乐'), node('p', '', '使用已导入工作流包的动态表单；仅提交当前后端实时确认的 AUDIO 工作流。'));
    const tools = node('div', 'studio-heading-actions');
    tools.append(action('刷新音频能力', 'button quiet', () => refreshAudioCapabilities(true)), action('导入 / 修复工作流包', 'button quiet', () => host.openPackages?.()), action('引擎设置', 'button', () => host.openSettings()), action('开始生成', 'button primary studio-run-top', () => submit(audioKey())));
    header.append(heading, tools);
    const layout = node('div', 'studio-layout'), form = node('div', 'studio-form'), results = node('div', 'studio-results');
    const categoryTabs = node('div', 'audio-category-tabs');
    for (const [id, label] of [['voice', '声音'], ['music', '音乐']]) {
      const tab = action(label, `button audio-category-tab${audioCategory === id ? ' active' : ''}`, () => { audioCategory = id; saveAudioDrafts(); renderAudio(); refreshAudio(); });
      tab.setAttribute('aria-pressed', String(audioCategory === id)); categoryTabs.append(tab);
    }
    form.append(categoryTabs);
    const block = node('section', 'studio-section'); block.append(node('h2', '', audioCategory === 'voice' ? '声音工作流' : '音乐工作流'));
    const draft = audioDrafts[audioCategory];
    const picker = node('label', 'studio-field'), pickerTitle = node('span', '', 'AUDIO 工作流包'), select = node('select'); select.setAttribute('aria-label', `${audioCategory === 'voice' ? '声音' : '音乐'}工作流包`);
    const listed = audioChoices.packages || [];
    const options = [['', listed.length ? '选择一个工作流包' : '暂无本地工作流包']];
    for (const pack of listed) options.push([pack.id, `${pack.name || pack.id}${pack.eligible === true && pack.available !== false ? '' : ' · 当前不可用'}`]);
    setOptions(select, options, draft.package_id, false); select.disabled = audioLoading || audioChoices.stale || !listed.length;
    select.addEventListener('change', () => selectAudioPackage(audioCategory, select.value)); picker.append(pickerTitle, select);
    if (audioLoading) picker.append(node('small', 'studio-help', '正在读取工作流包与当前后端的实时 AUDIO 输出能力…'));
    else if (audioLoadError) picker.append(node('small', 'field-error', audioLoadError));
    else if (!listed.length) picker.append(node('small', 'studio-help', '本机没有已导入的工作流包，或当前后端尚未提供可检查的包清单。'));
    block.append(picker);
    const chosen = currentAudioPackage();
    if (chosen) {
      const supported = chosen.eligible === true && chosen.available !== false && !audioChoices.stale && audioCapabilitiesBackend === backend();
      block.append(node('p', supported ? 'studio-help audio-package-ready' : 'studio-help disabled-capability', supported ? `当前后端已确认 ${chosen.audio_outputs?.length || chosen.capability?.audio_outputs?.length || 1} 个 AUDIO 输出。此页面选择用途为“${audioCategory === 'voice' ? '声音' : '音乐'}”，工作流包本身不做自动用途猜测。` : chosen.reason || '此包尚未通过当前后端实时 schema 检查；不会尝试提交。'));
      if (chosen.requirements?.nodes?.length) block.append(node('small', 'studio-help', `所需节点：${chosen.requirements.nodes.join('、')}`));
      const dynamic = node('div', 'audio-package-fields');
      renderAudioFields(dynamic, { pack: chosen, draft, api: host.api, backend: backend(), currentBackend: backend, onChange: () => { draft.valuesByPackage[chosen.id] = structuredClone(draft.values); draft.mediaBackendsByPackage[chosen.id] = { ...draft.mediaBackends }; saveAudioDrafts(); refreshAudio(); }, reportError: host.reportError });
      block.append(dynamic);
    }
    if (!audioLoading && !listed.some(item => item.eligible === true && item.available !== false)) {
      const empty = node('div', 'audio-empty-state');
      empty.append(node('strong', '', '当前引擎尚未配置可用的声音 / 音乐生成工作流'));
      empty.append(node('p', '', '导入含有可连接 AUDIO 输出的工作流包，再刷新能力检查。当前页面不会假装生成，也不会自动下载模型或调用云端服务。'));
      block.append(empty);
      block.append(action('复制接入需求给 AI', 'button quiet audio-integration-copy', async () => {
        await host.copyText(audioIntegrationRequest(host.engine(), audioCapability), '已复制脱敏接入需求；不含路径、模型名单或提示词');
      }));
      if (listed.length) block.append(node('p', 'studio-help', '下拉列表仍保留了当前不可用的包及其校验原因；修复工作流输出连线后可刷新复查。'));
    }
    form.append(block);
    const footer = node('div', 'studio-submit');
    footer.append(action('检查依赖', 'button quiet', () => inspect(audioKey(), 'diagnostics')), action('预览执行参数', 'button quiet', () => inspect(audioKey(), 'compile')));
    const generate = action('开始生成', 'button primary studio-generate', () => submit(audioKey())); generate.dataset.studioGenerate = audioKey(); footer.append(generate);
    const status = node('p', 'studio-operation'); status.setAttribute('aria-live', 'polite'); footer.append(status);
    const query = action('查询上次提交', 'button studio-query', () => queryPending(audioKey())); query.hidden = true; footer.append(query);
    const resume = action('继续发送原请求', 'button studio-resume', () => dispatchPending(audioKey())); resume.hidden = true; footer.append(resume);
    const inspection = node('details', 'studio-inspection'); inspection.hidden = true; inspection.append(node('summary', '', '检查与执行参数')); inspection.append(node('pre')); form.append(footer, inspection);
    results.append(node('div', 'studio-result-toolbar')); const preview = node('div', 'studio-preview'); results.append(preview); const history = node('div', 'studio-history'); results.append(history);
    layout.append(form, results); panel.append(header, layout); root.append(panel); panels.set('audio', panel); lastMedia.delete(audioKey()); panel.hidden = active !== 'audio';
  }
  function refreshAudio() {
    if (!initialized || active !== 'audio') return;
    if (!audioLoading && audioCapabilitiesBackend !== backend()) { refreshAudioCapabilities(true); return; }
    const panel = panels.get('audio'); if (!panel) return;
    const key = audioKey(), draft = audioDrafts[audioCategory], pack = currentAudioPackage(), entry = pending[key], submitting = busy.has(key);
    const supported = !!pack && pack.eligible === true && pack.available !== false && !audioChoices.stale && audioCapabilitiesBackend === backend();
    const hasEligiblePackage = (audioChoices.packages || []).some(item => item.eligible === true && item.available !== false);
    const hasForeignMedia = Object.entries(draft.mediaBackends || {}).some(([field, owner]) => draft.values?.[field] && owner && owner !== backend());
    const generate = panel.querySelector('.studio-generate'), status = panel.querySelector('.studio-operation'), query = panel.querySelector('.studio-query'), resume = panel.querySelector('.studio-resume');
    generate.disabled = submitting || !!entry || !host.engine().online || !supported || hasForeignMedia;
    generate.textContent = submitting ? '正在处理…' : entry ? '上次提交待确认' : '开始生成';
    const topRun = panel.querySelector('.studio-run-top'); topRun.disabled = generate.disabled; topRun.textContent = generate.textContent;
    status.textContent = entry ? `原请求 ${entry.request_id.slice(0, 8)} · 请先查询，避免重复生成` : hasForeignMedia ? '音频/图片输入属于另一个推理引擎，请重新上传' : supported ? '本地 AUDIO 工作流 · 任务可在后台继续执行' : audioLoadError || (host.engine().online ? pack ? (pack.reason || '所选工作流包尚未通过当前引擎检查') : hasEligiblePackage ? `请选择一个${audioCategory === 'voice' ? '声音' : '音乐'}工作流包` : '当前引擎尚未配置可用的声音 / 音乐生成工作流' : '引擎未连接：先连接本地 ComfyUI，再检查工作流能力');
    query.hidden = !entry; query.disabled = submitting; resume.hidden = !entry?.canResume; resume.disabled = submitting;
    resultPanel(key, panel);
  }
  function samplerOptions(mode) {
    const options = host.engine().generation_options || {};
    if (mode !== 'video') return options;
    return { samplers: [...new Set([...(options.samplers || []), ...(options.h3_dual_clock?.samplers || [])])], schedulers: drafts[mode].sampler === 'dual_clock_euler' ? options.h3_dual_clock?.schedulers || [] : options.schedulers || [] };
  }
  async function applyPerformancePlan(mode) {
    const plan = await host.api('/api/performance-plan');
    const suggestion = performanceSuggestion(mode, plan);
    if (!suggestion) throw new Error(plan?.detail || '本地后端尚未给出有效的 GPU 参数建议');
    const draft = drafts[mode]; draft.width = suggestion.width; draft.height = suggestion.height;
    if (suggestion.seconds !== undefined) draft.seconds = suggestion.seconds;
    for (const key of ['width', 'height', 'seconds']) {
      const input = panels.get(mode)?.querySelector(`[name=${key}]`);
      if (input && suggestion[key] !== undefined) input.value = suggestion[key];
    }
    save();
    const profile = host.performancePreset?.() || plan.profile || 'auto';
    host.toast(`已按 GPU 建议填入尺寸${suggestion.seconds === undefined ? '' : '与视频时长'}（${profile}）；其余参数和草稿保持原值`);
  }
  function validateSelectedQwenModels(draft) {
    if (!draft.kind.startsWith('qwen21')) return;
    const families = host.engine().generation_options?.model_families || {};
    for (const key of ['dit', 'text_encoder', 'vae', 'lora']) {
      const selected = key === 'lora' ? (draft.loras || []).map(item => item.name).filter(Boolean) : [draft.models?.[key]].filter(Boolean);
      for (const name of selected) {
        const known = families[key]?.[name];
        if (known && known !== 'unknown' && known !== 'qwen21') throw new Error(`所选 ${key} 属于已知的 ${known} 架构，不兼容 Qwen Image 2.1；请重新选择`);
      }
    }
  }
  function updateCatalogs(panel) {
    panel.querySelectorAll('.studio-model').forEach(wrap => wrap.updateCatalog());
    const mode = panel.dataset.studioMode, options = samplerOptions(mode);
    for (const [key, source] of [['sampler', options.samplers], ['scheduler', options.schedulers]]) if (source?.length) setOptions(panel.querySelector(`[name=${key}]`), source, drafts[mode][key]);
  }
  function buildRequest(mode) {
    if (mode.startsWith('audio_')) {
      const category = mode.slice('audio_'.length), draft = audioDrafts[category], pack = currentAudioPackage(category);
      if (audioCapabilitiesBackend !== backend() || audioChoices.stale) throw new Error('请先刷新当前引擎的音频工作流能力');
      return buildAudioPackageRequest(pack, draft, backend());
    }
    validateSelectedQwenModels(drafts[mode]);
    return buildStudioRequest(drafts[mode], backend(), host.engine().generation_options || {});
  }
  async function inspect(mode, type) {
    const request = buildRequest(mode), panel = panels.get(mode.startsWith('audio_') ? 'audio' : mode), details = panel.querySelector('.studio-inspection');
    details.hidden = false; details.open = true; details.querySelector('pre').textContent = '正在检查本地引擎…';
    try { const result = await host.api(type === 'compile' ? '/api/compile' : '/api/diagnostics', request); details.querySelector('pre').textContent = type === 'diagnostics' ? result.repair_prompt || result.summary || JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2); }
    catch (error) { details.querySelector('pre').textContent = error.message; throw error; }
  }
  async function submit(mode) {
    if (busy.has(mode) || pending[mode]) return;
    const request = buildRequest(mode);
    if (!host.engine().online) throw new Error('本地引擎未连接，请先设置引擎地址');
    pending[mode] = { request_id: crypto.randomUUID(), request, backend: backend() };
    try { save(true); } catch (error) { delete pending[mode]; throw error; }
    await dispatchPending(mode);
  }
  async function dispatchPending(mode) {
    if (busy.has(mode) || !pending[mode]) return;
    const entry = pending[mode];
    if (entry.backend !== backend()) throw new Error('上次提交属于另一个引擎，请先恢复原引擎连接并查询原请求');
    busy.add(mode); refresh();
    try {
      const result = await host.api('/api/generate', { request_id: entry.request_id, request: entry.request });
      if (!result.id) throw new Error('服务未返回任务 ID，请查询原提交');
      selectedJobs[mode] = result.id; delete pending[mode]; save(); await host.refreshJobs(); host.toast('已提交生成，可继续编辑画布或其他生成页面');
    } catch (error) {
      if (error.payload?.submission_state === 'rejected') { delete pending[mode]; save(); host.reportError(new Error(`${error.message} 本次未受理，可以修改参数。`)); }
      else host.reportError(new Error(`${error.message} 请查询上次提交，避免重复生成。`));
    }
    finally { busy.delete(mode); refresh(); }
  }
  async function queryPending(mode) {
    const entry = pending[mode]; if (!entry || busy.has(mode)) return;
    busy.add(mode); refresh();
    try {
      const result = await host.api('/api/requests/query', { request_id: entry.request_id });
      if (result.state === 'accepted') { selectedJobs[mode] = result.job_id || result.job?.id; delete pending[mode]; save(); await host.refreshJobs(); host.toast('已找到原任务，未重新生成'); }
      else if (result.state === 'not_found') { entry.canResume = true; save(); host.toast('尚未找到持久记录，原请求可能仍在校验。继续查询，或使用原 ID 和原参数恢复提交。'); }
      else host.toast('提交结果仍待确认；保留原请求，请核实原后端队列与历史。', true);
    } finally { busy.delete(mode); refresh(); }
  }
  async function useImageOutput(job, imageIndex, targetMode) {
    if (job.backend !== backend()) throw new Error('结果属于另一个推理引擎，请切回原引擎后再导入为参考图');
    const output = await host.api(`/api/jobs/${encodeURIComponent(job.id)}/image-input`, { output_index: imageIndex });
    if (!output?.name || !output?.url || output.backend && output.backend !== backend()) throw new Error('当前引擎没有返回可用的图片输入；请确认任务结果仍属于此引擎');
    const draft = drafts[targetMode], targetKind = targetMode === 'video' ? 'h3_i2v' : draft.kind === 'qwen21_edit' ? 'qwen21_edit' : 'sdxl_i2i';
    if (draft.kind !== targetKind) {
      kindDrafts[targetMode] ||= {}; kindDrafts[targetMode][draft.kind] = structuredClone(draft);
      const previousText = { positive: draft.positive, negative: draft.negative };
      drafts[targetMode] = kindDrafts[targetMode][targetKind] ? restoreDraft(targetMode, kindDrafts[targetMode][targetKind]) : newDraft(targetMode, targetKind);
      drafts[targetMode].positive ||= previousText.positive; drafts[targetMode].negative ||= previousText.negative;
    }
    drafts[targetMode].references = [{ ...output, label: job.outputs.filter(item => item.type === 'image')[imageIndex]?.filename || output.name, backend: output.backend || backend() }];
    save(); render(targetMode); open(targetMode); host.toast(targetMode === 'video' ? '图片结果已设为 H3 视频首帧' : '图片结果已设为图生图目标');
  }
  function resultPanel(mode, panel) {
    const audioMode = mode.startsWith('audio_'), audioIds = new Set((audioChoices.packages || []).map(pack => pack.id));
    const matching = host.jobs().filter(job => audioMode
      ? (job.kind === 'package' && audioIds.has(job.summary?.package_id)) || (job.outputs || []).some(output => output.type === 'audio') || selectedJobs[mode] === job.id
      : STUDIO_MODES[mode].kinds.some(([kind]) => kind === job.kind) || selectedJobs[mode] === job.id).slice(0, 30);
    const chosen = matching.find(job => job.id === selectedJobs[mode]) || matching[0];
    const toolbar = panel.querySelector('.studio-result-toolbar'); toolbar.replaceChildren(node('h2', '', '生成结果'), node('span', 'studio-job-state', chosen ? labels[chosen.status] || chosen.status : '等待创作'));
    const history = panel.querySelector('.studio-history'); history.replaceChildren(node('h3', '', '最近任务'));
    for (const job of matching) { const item = action(`${labels[job.status] || job.status} · ${job.summary?.width || '—'} × ${job.summary?.height || '—'} · ${job.id.slice(0, 10)}`, `studio-history-item${job.id === chosen?.id ? ' selected' : ''}`, () => { selectedJobs[mode] = job.id; save(); refresh(); }); history.append(item); }
    const signature = JSON.stringify([chosen?.id, chosen?.status, chosen?.outputs, chosen?.error]);
    if (lastMedia.get(mode) === signature) return; lastMedia.set(mode, signature);
    const area = panel.querySelector('.studio-preview'); pause(area); area.replaceChildren();
    if (!chosen?.outputs?.length) {
      const empty = node('div', 'studio-result-empty');
      const audioMode = mode.startsWith('audio_'), category = mode === 'audio_music' ? '音乐' : '声音';
      empty.append(node('div', 'studio-prism', audioMode ? '♫' : '◈'), node('h2', '', chosen ? labels[chosen.status] || '等待结果' : audioMode ? `下一段${category}，从这里开始` : '你的下一张作品，从这里开始'), node('p', '', chosen?.error || (chosen ? '任务由本地推理引擎执行，可自由切换页面。' : audioMode ? '选择已验证 AUDIO 输出的工作流包，填写台词、音乐描述或参数，再在本机生成。' : '选择模型、写下提示词，再把画面交给棱光。'))); area.append(empty);
    }
    for (const [outputIndex, output] of (chosen?.outputs || []).entries()) {
      const card = node('div', 'studio-output'), media = node(output.type === 'video' ? 'video' : output.type === 'audio' ? 'audio' : 'img');
      media.src = safeURL(output.url); if (media.tagName === 'IMG') media.alt = output.filename || '生成结果'; else { media.controls = true; media.preload = 'metadata'; }
      const meta = node('div', 'studio-output-meta'), taskName = chosen.summary?.package_name || chosen.title || chosen.kind || '本地生成任务';
      let owner = '未知后端'; try { owner = new URL(chosen.backend).host || owner; } catch { /* Keep a generic label for old job records. */ }
      meta.append(node('strong', '', output.filename || `未命名输出 ${outputIndex + 1}`), node('span', '', `任务：${taskName} · ${chosen.id.slice(0, 10)}`), node('span', '', `后端：${owner}`));
      const controls = node('div', 'studio-output-actions'), download = node('a', 'button quiet', '下载文件'); download.href = safeURL(output.url); download.download = output.filename || ''; controls.append(download);
      if (output.type === 'image') controls.append(action('放大查看', 'button quiet', () => host.preview(output)));
      const locationInfo = node('small', 'studio-output-location');
      controls.append(action('显示输出位置', 'button quiet', async () => {
        if (!host.outputLocation) throw new Error('当前客户端没有注册本地输出位置接口');
        const result = await host.outputLocation(chosen.id, outputIndex, false);
        let locationBackend = '未知'; try { locationBackend = new URL(result?.backend_url).host; } catch { /* Older jobs may not expose an origin. */ }
        locationInfo.textContent = [result?.path || result?.directory || result?.detail, `文件：${result?.filename || output.filename || '未命名'}`, `后端：${locationBackend}`].filter(Boolean).join(' · ');
      }), action('打开输出目录', 'button quiet', async () => {
        if (!host.outputLocation) throw new Error('当前客户端没有注册本地输出位置接口');
        const result = await host.outputLocation(chosen.id, outputIndex, true);
        if (result?.opened === false || result?.open === false) throw new Error(result.message || '输出目录未打开；请确认这是当前客户端配置的本机目录');
        host.toast(result?.path || result?.output_path ? `已打开：${result.path || result.output_path}` : '已请求打开本机输出目录');
      }));
      if (output.type === 'image' && chosen.backend === backend()) {
        const imageIndex = chosen.outputs.slice(0, outputIndex).filter(item => item.type === 'image').length;
        controls.append(action('用作图生图目标', 'button quiet', () => useImageOutput(chosen, imageIndex, 'img2img')),
          action('用作视频首帧', 'button quiet', () => useImageOutput(chosen, imageIndex, 'video')));
      }
      card.append(meta, media, controls, locationInfo); area.append(card);
    }
    if (chosen) {
      const actions = node('div', 'studio-result-actions');
      actions.append(action('结果放入画布', 'button', () => { open('canvas'); host.placeJob(chosen.id); }), action('参数重新编辑', 'button quiet', async () => { const recipe = await host.api(`/api/jobs/${encodeURIComponent(chosen.id)}/recipe`); open('canvas'); host.addRecipe(recipe); }));
      if (['queued', 'running'].includes(chosen.status)) actions.append(action('取消此任务', 'button quiet', async () => { await host.api(`/api/jobs/${encodeURIComponent(chosen.id)}/cancel`, {}); await host.refreshJobs(); refresh(); })); area.append(actions);
    }
  }
  function refresh() {
    if (!initialized || active === 'canvas') return;
    if (active === 'audio') { refreshAudio(); return; }
    const panel = panels.get(active); if (!panel) return;
    const catalogSignature = JSON.stringify([host.engine().models, host.engine().generation_options, drafts[active].models?.dit, drafts[active].sampler]);
    if (lastCatalog.get(active) !== catalogSignature) { updateCatalogs(panel); lastCatalog.set(active, catalogSignature); }
    const submitting = busy.has(active), entry = pending[active], generate = panel.querySelector('.studio-generate'), status = panel.querySelector('.studio-operation'), query = panel.querySelector('.studio-query');
    generate.disabled = submitting || !!entry || !host.engine().online;
    generate.textContent = submitting ? '正在处理…' : entry ? '上次提交待确认' : '开始生成';
    const topRun = panel.querySelector('.studio-run-top'); topRun.disabled = generate.disabled; topRun.textContent = generate.textContent;
    status.textContent = entry ? `原请求 ${entry.request_id.slice(0, 8)} · 请先查询，避免重复生成` : host.engine().online ? '本地执行 · 支持切换页面继续工作' : '引擎未连接：打开引擎设置，连接本地 ComfyUI 后刷新模型';
    query.hidden = !entry; query.disabled = submitting;
    const resume = panel.querySelector('.studio-resume'); resume.hidden = !entry?.canResume; resume.disabled = submitting;
    resultPanel(active, panel);
  }
  return {
    init() {
      if (initialized) return;
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE) || '{}');
        for (const mode of Object.keys(drafts)) {
          drafts[mode] = restoreDraft(mode, saved.drafts?.[mode]); kindDrafts[mode] = {};
          for (const [kind] of STUDIO_MODES[mode].kinds) if (saved.kindDrafts?.[mode]?.[kind]?.kind === kind) kindDrafts[mode][kind] = restoreDraft(mode, saved.kindDrafts[mode][kind]);
        }
        pending = saved.pending && typeof saved.pending === 'object' && !Array.isArray(saved.pending) ? saved.pending : {}; selectedJobs = saved.selectedJobs || {};
        if (saved.audioDrafts && typeof saved.audioDrafts === 'object') {
          for (const category of ['voice', 'music']) {
            const source = saved.audioDrafts[category]; if (!source || typeof source !== 'object') continue;
            audioDrafts[category] = { ...newAudioDraft(), package_id: typeof source.package_id === 'string' ? source.package_id.slice(0, 200) : '', values: source.values && typeof source.values === 'object' && !Array.isArray(source.values) ? source.values : {}, valuesByPackage: source.valuesByPackage && typeof source.valuesByPackage === 'object' ? source.valuesByPackage : {}, mediaBackends: source.mediaBackends && typeof source.mediaBackends === 'object' ? source.mediaBackends : {}, mediaBackendsByPackage: source.mediaBackendsByPackage && typeof source.mediaBackendsByPackage === 'object' ? source.mediaBackendsByPackage : {} };
          }
          audioCategory = saved.audioCategory === 'music' ? 'music' : 'voice';
        }
      } catch { host.toast('生成草稿读取失败，已保留原存储并打开默认表单', true); }
      initialized = true; document.querySelectorAll('.workspace-nav[data-workspace]').forEach(button => button.addEventListener('click', () => open(button.dataset.workspace)));
      document.querySelector('#toggle-inspector')?.addEventListener('click', () => { document.body.classList.toggle('inspector-open'); window.dispatchEvent(new Event('resize')); });
      open('canvas');
    }, open, refresh, hasPending: () => busy.size > 0 || Object.keys(pending).length > 0,
    diagnosticsRequest() {
      if (active === 'audio') { try { return buildRequest(audioKey()); } catch { return null; } }
      const mode = STUDIO_MODES[active] ? active : 'txt2img', draft = drafts[mode];
      try { return buildRequest(mode); } catch { return { kind: draft.kind, models: { ...(draft.models || {}) } }; }
    },
    destroy() { pause(root); panels.clear(); root.replaceChildren(); },
  };
}
