import { STUDIO_MODES, newDraft, restoreDraft, buildStudioRequest } from './studio-state.mjs';

const STORAGE = 'prismcanvas.studio.v1';
const node = (tag, className = '', text) => { const n = document.createElement(tag); n.className = className; if (text !== undefined) n.textContent = text; return n; };
const labels = { queued: '排队中', running: '生成中', completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '待确认' };
const safeURL = value => { try { const url = new URL(value, location.origin); return url.origin === location.origin && /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; } };

export function createGenerationStudio(host) {
  let active = 'canvas', drafts = Object.fromEntries(Object.keys(STUDIO_MODES).map(mode => [mode, newDraft(mode)]));
  let kindDrafts = {}, pending = {}, selectedJobs = {}, busy = new Set(), panels = new Map(), lastMedia = new Map(), lastCatalog = new Map(), initialized = false, storageWarned = false;
  const root = document.querySelector('#studio-root');
  const save = (critical = false) => {
    try { localStorage.setItem(STORAGE, JSON.stringify({ drafts, kindDrafts, pending, selectedJobs })); }
    catch { if (critical) throw new Error('无法保存提交记录，请先检查浏览器本地存储'); if (!storageWarned) { host.toast('工作台草稿保存失败，请导出参数后检查存储空间', true); storageWarned = true; } }
  };
  const action = (text, className, fn) => { const b = node('button', className, text); b.type = 'button'; b.addEventListener('click', () => Promise.resolve().then(fn).catch(host.reportError)); return b; };
  const pause = container => container?.querySelectorAll('video,audio').forEach(media => media.pause());
  const backend = () => host.engine().backend_url || '';
  function open(mode) {
    if (mode !== 'canvas' && !STUDIO_MODES[mode]) return;
    pause(root); active = mode; document.body.dataset.workspace = mode; document.body.classList.remove('canvas-focus');
    document.querySelectorAll('.workspace-nav[data-workspace]').forEach(button => { button.classList.toggle('active', button.dataset.workspace === mode); button.setAttribute('aria-pressed', String(button.dataset.workspace === mode)); });
    root.hidden = mode === 'canvas';
    if (mode !== 'canvas') {
      document.querySelectorAll('#canvas video,#canvas audio,#jobs-panel video,#jobs-panel audio').forEach(media => media.pause());
      if (!panels.has(mode)) render(mode);
      for (const [name, panel] of panels) panel.hidden = name !== mode;
      refresh();
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
  function setOptions(select, options, current) {
    select.replaceChildren();
    for (const item of options) { const [value, text] = Array.isArray(item) ? item : [item, item]; const opt = node('option', '', text); opt.value = value; select.append(opt); }
    if (current && !Array.from(select.options).some(option => option.value === current)) { const missing = node('option', '', `${current} · 当前列表未找到`); missing.value = current; select.append(missing); }
    select.value = current || '';
  }
  function values(key, mode) {
    const kind = drafts[mode].kind, family = kind.startsWith('h3') ? 'h3' : kind.startsWith('sdxl') ? 'sdxl' : kind;
    const families = host.engine().generation_options?.model_families?.[key] || {};
    const compatible = name => {
      const known = families[name];
      if (known && known !== 'unknown' && known !== family && !(family === 'krea' && key === 'vae' && known === 'qwen_image')) return false;
      if (family === 'h3' && key === 'dit' && (kind === 'h3_ref' ? /fl2va/i.test(name) : /ref2va/i.test(name))) return false;
      return true;
    };
    const loaders = host.engine().generation_options?.lora_loaders;
    if (key === 'lora' && loaders) {
      const dit = drafts[mode].models?.dit || '';
      if (!kind.startsWith('sdxl') && !dit) return [];
      const loader = kind.startsWith('sdxl') ? 'LoraLoader' : /int8|fp8|nvfp4|gguf/i.test(dit) && loaders.LoraLoaderBypassModelOnly ? 'LoraLoaderBypassModelOnly' : 'LoraLoaderModelOnly';
      return (loaders[loader]?.names || []).filter(compatible);
    }
    let list = host.engine().models?.[key] || (key === 'checkpoint' ? host.engine().models?.checkpoints : []) || [];
    list = list.map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
    const recommended = host.catalog(key, drafts[mode].kind) || [];
    return [...new Set([...recommended, ...list])].filter(compatible);
  }
  function modelSelector(mode, key, label, target, change) {
    const wrap = node('label', 'studio-field studio-model'), title = node('span', '', label), search = node('input'), select = node('select');
    search.type = 'search'; search.placeholder = '搜索本地文件名…'; search.setAttribute('aria-label', `搜索${label}`);
    select.setAttribute('aria-label', label); select.dataset.model = key;
    const update = () => {
      const current = target(), list = values(key, mode).filter(name => name.toLowerCase().includes(search.value.toLowerCase()));
      setOptions(select, [['', key === 'lora' ? '选择 LoRA 文件' : '自动匹配（可手动选择）'], ...list], current);
    };
    search.addEventListener('input', update); select.addEventListener('change', () => { change(select.value); save(); refresh(); });
    wrap.append(title, search, select); wrap.updateCatalog = update; update(); return wrap;
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
      row.append(image, node('span', '', `${draft.kind === 'h3_i2v' ? index ? '尾帧' : '首帧' : '参考图'} · ${ref.label || ref.name}`), action('移除', 'button quiet', () => { draft.references.splice(index, 1); save(); references(mode, container); })); container.append(row);
    });
    const input = node('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp'; input.multiple = draft.kind === 'h3_ref'; input.hidden = true;
    const upload = action(draft.references.length ? '＋ 添加图片' : '＋ 上传参考图片', 'button studio-upload', () => input.click());
    const limit = mode === 'img2img' ? 1 : draft.kind === 'h3_i2v' ? 2 : 9; upload.disabled = draft.references.length >= limit;
    input.addEventListener('change', async () => {
      upload.disabled = true;
      const startedBackend = backend();
      try {
        const files = Array.from(input.files).slice(0, limit - draft.references.length);
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
    container.append(input, upload, node('small', 'studio-help', mode === 'img2img' ? '根据宽高缩放参考图；去噪越低，越接近原图。' : '首尾帧按添加顺序排列；参考素材保留在你的推理引擎。'));
  }
  function render(mode) {
    const old = panels.get(mode); pause(old); old?.remove(); const draft = drafts[mode], config = STUDIO_MODES[mode];
    const panel = node('section', 'studio-panel'); panel.dataset.studioMode = mode;
    const header = node('header', 'studio-heading'), heading = node('div'); heading.append(node('span', 'eyebrow', 'GENERATION STUDIO'), node('h1', '', config.title), node('p', '', config.subtitle));
    const tools = node('div', 'studio-heading-actions'); tools.append(action('刷新模型', 'button quiet', async () => { await host.refreshEngine(true); updateCatalogs(panel); refresh(); }), action('引擎设置', 'button', () => host.openSettings()), action('开始生成', 'button primary studio-run-top', () => submit(mode))); header.append(heading, tools);
    const layout = node('div', 'studio-layout'), form = node('div', 'studio-form'), results = node('div', 'studio-results');
    const section = (title, hint = '') => { const block = node('section', 'studio-section'); block.append(node('h2', '', title)); if (hint) block.append(node('p', 'studio-help', hint)); form.append(block); return block; };
    const models = section('01  模型与风格', '模型列表来自当前本地推理引擎，无需复制模型到客户端。');
    const kindField = field(mode, '生成引擎', 'kind', { select: config.kinds, change: kind => {
      kindDrafts[mode] ||= {}; kindDrafts[mode][draft.kind] = structuredClone(draft);
      const cached = kindDrafts[mode][kind], next = cached ? restoreDraft(mode, cached) : newDraft(mode, kind);
      if (!cached) { next.positive = draft.positive; next.negative = draft.negative; }
      drafts[mode] = next; save(); render(mode); refresh();
    } }); models.append(kindField);
    const modelKeys = draft.kind.startsWith('sdxl') ? [['checkpoint', 'Checkpoint 主模型']] : [['dit', 'DiT 主模型'], ['text_encoder', '文本编码器'], ['vae', '图像 / 视频 VAE'], ...(mode === 'video' ? [['audio_vae', '音频 VAE']] : [])];
    modelKeys.forEach(([key, label]) => models.append(modelSelector(mode, key, label, () => draft.models[key], value => { draft.models[key] = value; })));
    const loras = node('details', 'studio-details'); loras.open = true; loras.append(node('summary', '', 'LoRA 叠加 · 最多 4 个')); const rows = node('div'); loraRows(mode, rows); loras.append(rows, node('small', 'studio-help', '选择与主模型架构兼容的 LoRA。文件名推荐不代表兼容性已验证；模型 / 文本强度可分别调整。')); models.append(loras);
    if (mode === 'img2img' || ['h3_i2v', 'h3_ref'].includes(draft.kind)) { const block = section('02  参考图片'); const refs = node('div'); references(mode, refs); block.append(refs); }
    const prompts = section('提示词'); prompts.append(field(mode, '正向提示词', 'positive', { multiline: true, rows: 6, placeholder: '描述主体、环境、光线、构图；视频可加入动作与运镜…' }), field(mode, '负向提示词', 'negative', { multiline: true, rows: 3, placeholder: '不希望出现的内容…' }), action('复制提示词', 'button quiet', () => host.copyText(`${draft.positive}${draft.negative ? `\n\n负向提示词：${draft.negative}` : ''}`)));
    const controls = section('画幅与采样'), presets = node('div', 'studio-presets');
    for (const [label, w, h] of [['方形', 1024, 1024], ['横屏', mode === 'video' ? 768 : 1216, mode === 'video' ? 448 : 832], ['竖屏', mode === 'video' ? 448 : 832, mode === 'video' ? 768 : 1216]]) presets.append(action(label, 'button quiet compact', () => { draft.width = w; draft.height = h; panel.querySelector('[name=width]').value = w; panel.querySelector('[name=height]').value = h; save(); }));
    controls.append(presets); const grid = node('div', 'studio-grid');
    for (const [label, key, min, max, step] of [['宽度 / px', 'width', 64, 4096, mode === 'video' ? 32 : draft.kind === 'krea' ? 16 : 8], ['高度 / px', 'height', 64, 4096, mode === 'video' ? 32 : draft.kind === 'krea' ? 16 : 8], ['采样步数', 'steps', 1, 200, 1], ['提示词引导 CFG', 'cfg', 0, 100, .1]]) grid.append(field(mode, label, key, { number: true, min, max, step }));
    const options = samplerOptions(mode);
    grid.append(field(mode, '采样器', 'sampler', { select: options.samplers?.length ? options.samplers : ['euler'] }), field(mode, '调度器', 'scheduler', { select: options.schedulers?.length ? options.schedulers : ['simple'] }));
    if (mode === 'img2img') grid.append(field(mode, '去噪强度', 'denoise', { number: true, min: 0, max: 1, step: .05, help: '低值保留原图，高值更自由地重绘。' }));
    if (mode === 'video') grid.append(field(mode, '时长 / 秒', 'seconds', { number: true, min: 1, max: 30, step: .1, help: 'H3 固定 24 fps，实际帧数以编译结果为准。' }));
    controls.append(grid, field(mode, '随机种子', 'seed', { number: true, min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 }), action('换一个随机种子', 'button quiet', () => { draft.seed = crypto.getRandomValues(new Uint32Array(1))[0]; panel.querySelector('[name=seed]').value = draft.seed; save(); }));
    if (mode === 'video') { const advanced = node('details', 'studio-details'); advanced.append(node('summary', '', '高级视频参数')); const g = node('div', 'studio-grid'); g.append(field(mode, '视频 Shift', 'shift_video', { number: true, min: .01, max: 100, step: .01 }), field(mode, '音频 Shift', 'shift_audio', { number: true, min: .01, max: 100, step: .01 })); if (draft.kind === 'h3_ref') g.append(field(mode, '参考图尺寸策略', 'ref_image_size', { select: ['match', 'max'] })); advanced.append(g); controls.append(advanced); }
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
  function samplerOptions(mode) {
    const options = host.engine().generation_options || {};
    if (mode !== 'video') return options;
    return { samplers: [...new Set([...(options.samplers || []), ...(options.h3_dual_clock?.samplers || [])])], schedulers: drafts[mode].sampler === 'dual_clock_euler' ? options.h3_dual_clock?.schedulers || [] : options.schedulers || [] };
  }
  function updateCatalogs(panel) {
    panel.querySelectorAll('.studio-model').forEach(wrap => wrap.updateCatalog());
    const mode = panel.dataset.studioMode, options = samplerOptions(mode);
    for (const [key, source] of [['sampler', options.samplers], ['scheduler', options.schedulers]]) if (source?.length) setOptions(panel.querySelector(`[name=${key}]`), source, drafts[mode][key]);
  }
  async function inspect(mode, type) {
    const request = buildStudioRequest(drafts[mode], backend()), panel = panels.get(mode), details = panel.querySelector('.studio-inspection');
    details.hidden = false; details.open = true; details.querySelector('pre').textContent = '正在检查本地引擎…';
    try { const result = await host.api(type === 'compile' ? '/api/compile' : '/api/diagnostics', request); details.querySelector('pre').textContent = type === 'diagnostics' ? result.repair_prompt || result.summary || JSON.stringify(result, null, 2) : JSON.stringify(result, null, 2); }
    catch (error) { details.querySelector('pre').textContent = error.message; throw error; }
  }
  async function submit(mode) {
    if (busy.has(mode) || pending[mode]) return;
    const request = buildStudioRequest(drafts[mode], backend());
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
  function resultPanel(mode, panel) {
    const matching = host.jobs().filter(job => STUDIO_MODES[mode].kinds.some(([kind]) => job.kind === kind) || selectedJobs[mode] === job.id).slice(0, 30);
    const chosen = matching.find(job => job.id === selectedJobs[mode]) || matching[0];
    const toolbar = panel.querySelector('.studio-result-toolbar'); toolbar.replaceChildren(node('h2', '', '生成结果'), node('span', 'studio-job-state', chosen ? labels[chosen.status] || chosen.status : '等待创作'));
    const history = panel.querySelector('.studio-history'); history.replaceChildren(node('h3', '', '最近任务'));
    for (const job of matching) { const item = action(`${labels[job.status] || job.status} · ${job.summary?.width || '—'} × ${job.summary?.height || '—'} · ${job.id.slice(0, 10)}`, `studio-history-item${job.id === chosen?.id ? ' selected' : ''}`, () => { selectedJobs[mode] = job.id; save(); refresh(); }); history.append(item); }
    const signature = JSON.stringify([chosen?.id, chosen?.status, chosen?.outputs, chosen?.error]);
    if (lastMedia.get(mode) === signature) return; lastMedia.set(mode, signature);
    const area = panel.querySelector('.studio-preview'); pause(area); area.replaceChildren();
    if (!chosen?.outputs?.length) { const empty = node('div', 'studio-result-empty'); empty.append(node('div', 'studio-prism', '◈'), node('h2', '', chosen ? labels[chosen.status] || '等待结果' : '你的下一张作品，从这里开始'), node('p', '', chosen?.error || (chosen ? '任务由本地推理引擎执行，可自由切换页面。' : '选择模型、写下提示词，再把画面交给棱光。'))); area.append(empty); }
    for (const output of chosen?.outputs || []) {
      const card = node('div', 'studio-output'), media = node(output.type === 'video' ? 'video' : output.type === 'audio' ? 'audio' : 'img');
      media.src = safeURL(output.url); if (media.tagName === 'IMG') media.alt = output.filename || '生成结果'; else { media.controls = true; media.preload = 'metadata'; }
      const controls = node('div', 'studio-output-actions'), download = node('a', 'button quiet', '保存文件'); download.href = safeURL(output.url); download.download = output.filename || ''; controls.append(action('放大查看', 'button quiet', () => host.preview(output)), download); card.append(media, controls); area.append(card);
    }
    if (chosen) {
      const actions = node('div', 'studio-result-actions');
      actions.append(action('结果放入画布', 'button', () => { open('canvas'); host.placeJob(chosen.id); }), action('参数放入画布', 'button quiet', async () => { const recipe = await host.api(`/api/jobs/${encodeURIComponent(chosen.id)}/recipe`); open('canvas'); host.addRecipe(recipe); }));
      if (['queued', 'running'].includes(chosen.status)) actions.append(action('取消此任务', 'button quiet', async () => { await host.api(`/api/jobs/${encodeURIComponent(chosen.id)}/cancel`, {}); await host.refreshJobs(); refresh(); })); area.append(actions);
    }
  }
  function refresh() {
    if (!initialized || active === 'canvas') return;
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
      } catch { host.toast('生成草稿读取失败，已保留原存储并打开默认表单', true); }
      initialized = true; document.querySelectorAll('.workspace-nav[data-workspace]').forEach(button => button.addEventListener('click', () => open(button.dataset.workspace)));
      document.querySelector('#toggle-inspector')?.addEventListener('click', () => { document.body.classList.toggle('inspector-open'); window.dispatchEvent(new Event('resize')); });
      open('canvas');
    }, open, refresh, destroy() { pause(root); panels.clear(); root.replaceChildren(); },
  };
}
