// Local project snapshots, result library and shared accessible dialog framing.
const el = (tag, cls = '', text) => { const e = document.createElement(tag); e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const storageCount = value => Number.isSafeInteger(value) && value >= 0;
function storageBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let number = value, unit = 0;
  while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
  return `${unit ? number.toFixed(1) : number} ${units[unit]}`;
}
function storageAssetText(value, label) {
  if (!value || !['ok', 'partial'].includes(value.status) || !storageCount(value.count) || !storageCount(value.bytes)) return `${label}：暂不可读`;
  return `${label}：${value.status === 'partial' ? '本次已统计 ' : ''}${value.count} 份 · ${storageBytes(value.bytes)}${value.status === 'partial' ? '（部分暂不可读）' : ''}`;
}
function storageSummaryText(data) {
  if (data?.version !== 1 || !['ok', 'partial', 'unavailable'].includes(data.status) || data.measurement !== 'logical_file_bytes') {
    return ['客户端素材占用：暂不可读，当前服务未提供可核验的摘要'];
  }
  const local = data.local_assets, registration = data.input_registration;
  let quota = '引擎输入素材登记：暂不可读，额度尚未核实';
  if (registration && storageCount(registration.count) && registration.limit === 10000) {
    if (registration.status === 'ok' && registration.protected === false && storageCount(registration.remaining) &&
        registration.remaining === Math.max(0, registration.limit - registration.count)) {
      quota = `引擎输入素材登记：${registration.count} / ${registration.limit} 条 · 剩余额度 ${registration.remaining} 条`;
    } else if (registration.status === 'unavailable' && registration.protected === true && registration.remaining === null) {
      quota = `引擎输入素材登记：已恢复 ${registration.count} 条，完整额度暂不可读；原始记录需要先保留备份`;
    }
  }
  return [storageAssetText(local, '客户端素材合计'), storageAssetText(local?.images, '图片副本'),
    storageAssetText(local?.media, '通用媒体副本'), quota];
}
export function frameDialog(dialog) {
  if (dialog.classList.contains('framed-modal')) return;
  const owner = dialog.querySelector(':scope > form') || dialog;
  const heading = owner.querySelector(':scope > .modal-heading');
  if (!heading) return;
  const body = el('div', 'modal-scroll');
  for (const child of [...owner.childNodes]) if (child !== heading) body.append(child);
  owner.append(heading, body); dialog.classList.add('framed-modal');
  dialog.addEventListener('close', () => dialog.querySelectorAll('video,audio').forEach(media => media.pause()));
}

export function createWorkspaceTools(host) {
  const button = (text, id, fn, cls = 'button quiet') => { const b = el('button', cls, text); b.type = 'button'; b.id = id; b.addEventListener('click', () => Promise.resolve().then(fn).catch(host.reportError)); return b; };
  function dialog(id, title) {
    const d = el('dialog', 'modal workspace-library-modal'); d.id = id; d.setAttribute('aria-label', title);
    const head = el('div', 'modal-heading'); head.append(el('h2', '', title), button('×', `${id}-close`, () => d.close(), 'close-button'));
    head.lastChild.setAttribute('aria-label', '关闭'); d.append(head); document.body.append(d);
    d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close(); } });
    return d;
  }
  let library, results, gpuInfo, profile, name, list, location, resultList, resultFilter, saveButton;
  let snapshotBusy = false;
  let storageInfo, storageRefresh, storageRevision = 0, settingsDialog;
  let canvasOffset = 0, canvasSearch, previousCanvases, nextCanvases, listRevision = 0, searchTimer, recoveryDialog, recoveryButton;
  async function refreshCanvases() {
    const revision = ++listRevision;
    const data = await host.api(`/api/canvases?offset=${canvasOffset}&q=${encodeURIComponent(canvasSearch.value)}`);
    if (revision !== listRevision) return;
    previousCanvases.disabled = !canvasOffset; nextCanvases.disabled = data.next_offset == null;
    nextCanvases.dataset.offset = data.next_offset ?? '';
    location.textContent = `本地保存目录：${data.directory}。共 ${data.total} 个版本，匹配 ${data.matched ?? data.total} 个，显示 ${data.canvases.length ? canvasOffset + 1 : 0}–${canvasOffset + data.canvases.length}。${data.unreadable ? `另有 ${data.unreadable} 个记录暂不可读，原文件已保留。` : ''}`;
    list.replaceChildren();
    if (!data.canvases.length) list.append(el('p', 'muted', '还没有保存的画布。输入名称，保存当前画布与它引用的工作流包。'));
    for (const item of data.canvases) {
      const row = el('div', 'workspace-library-row'), body = el('div');
      body.append(el('strong', '', item.name), el('p', 'field-help', `${new Date(item.created_at * 1000).toLocaleString()} · ${item.nodes} 个节点`));
      const open = button('载入', `canvas-load-${item.id}`, async () => {
        if (snapshotBusy) return; snapshotBusy = true; open.disabled = true;
        try {
          if (host.openCanvasVersion) { if (await host.openCanvasVersion(item.id) === true) library.close(); }
          else { const record = await host.api(`/api/canvases/${item.id}`); await host.workflow().importBundle(new File([JSON.stringify(record.document)], `${item.name}.json`, { type: 'application/json' })); library.close(); }
        }
        finally { snapshotBusy = false; open.disabled = false; }
      });
      row.append(body, open); list.append(row);
    }
  }
  async function openCanvases() {
    if (host.openCanvasManagement) return host.openCanvasManagement();
    name.value = host.title(); canvasOffset = 0; canvasSearch.value = ''; library.showModal(); list.textContent = '正在读取画布库…'; await refreshCanvases();
  }
  async function saveCanvas() {
    if (snapshotBusy) return;
    const title = name.value.trim(); if (!title) { name.focus(); throw new Error('请填写画布名称'); }
    snapshotBusy = true; saveButton.disabled = true;
    try {
      if (host.saveCanvasVersion) { if (await host.saveCanvasVersion(title) === true) await refreshCanvases(); return; }
      const document = await host.workflow().buildBundle(); document.name = title;
      await host.api('/api/canvases', { document }); host.setTitle(title);
      canvasOffset = 0; canvasSearch.value = '';
      host.toast('已保存新版本，之前的画布版本仍保留'); await refreshCanvases();
    } finally { snapshotBusy = false; saveButton.disabled = false; }
  }
  async function renderResults() {
    resultList.querySelectorAll('video,audio').forEach(m => m.pause()); resultList.replaceChildren();
    const filter = resultFilter.value; let count = 0;
    for (const job of host.jobs()) for (const [index, output] of (job.outputs || []).entries()) {
      if (filter !== 'all' && output.type !== filter) continue;
      count++;
      const row = el('article', 'workspace-result');
      row.append(host.outputMedia(output, 'workspace-result-media', true), el('strong', '', output.filename || '生成结果'), el('p', 'field-help', `${job.kind || '工作流'} · ${job.id} · ${job.backend || ''}`));
      const actions = el('div', 'wrap-actions'), url = host.mediaURL(output.url);
      if (url) { const download = el('a', 'button quiet', '下载另存'); download.href = url; download.download = output.filename || 'result'; actions.append(download); }
      const detail = el('p', 'field-help path-text', '文件保存在生成此任务的引擎中。点击“文件位置”核实本机路径；下载可另存副本。');
      actions.append(button('文件位置', `result-location-${count}`, async () => {
        const found = await host.api(`/api/jobs/${encodeURIComponent(job.id)}/output-location`, { index, open: false });
        detail.textContent = [found.path, found.detail].filter(Boolean).join(' · ');
        if (found.can_open && !actions.querySelector('[data-open-folder]')) {
          const open = button('打开所在文件夹', `result-open-${count}`, () => host.api(`/api/jobs/${encodeURIComponent(job.id)}/output-location`, { index, open: true })); open.dataset.openFolder = ''; actions.append(open);
        }
      }));
      if (job.can_reuse) actions.append(button('参数放入画布', `result-recipe-${count}`, async () => { await host.reuseJob(job.id); results.close(); }));
      row.append(actions, detail); resultList.append(row);
    }
    if (!count) resultList.append(el('p', 'muted', '暂无此类生成结果。这里只列出本客户端的任务，生成完成后会自动出现在这里。'));
  }
  async function openResults() { results.showModal(); resultList.textContent = '正在读取生成结果…'; await host.refreshJobs(); await renderResults(); }
  async function refreshStorage() {
    // openSettings invokes refreshSettings just before showModal. Inspect the
    // dialog after that synchronous open, never from background status polling.
    await Promise.resolve();
    if (!settingsDialog?.open || !storageInfo) return;
    const revision = ++storageRevision;
    storageInfo.textContent = '正在读取客户端素材占用和登记额度…'; storageRefresh.disabled = true;
    try {
      const data = await host.api('/api/workspace/storage');
      if (revision !== storageRevision || !settingsDialog.open) return;
      storageInfo.replaceChildren(...storageSummaryText(data).map(text => el('p', 'field-help', text)));
    } catch {
      if (revision !== storageRevision || !settingsDialog.open) return;
      storageInfo.textContent = '客户端素材占用和登记额度暂不可读；可稍后手动刷新';
    } finally { if (revision === storageRevision) storageRefresh.disabled = false; }
  }
  async function refreshSettings() {
    const storageRead = refreshStorage();
    profile.value = host.settings().performance_profile || 'auto'; gpuInfo.textContent = '正在读取当前引擎 GPU…';
    try { const plan = await host.api('/api/performance-plan'); const d = plan.detected;
      gpuInfo.textContent = `${d.name || '尚未获取当前引擎 GPU'}${d.total_vram_mb != null ? ` · 总显存 ${(d.total_vram_mb / 1024).toFixed(1)} GiB` : ''}${d.available_vram_mb != null ? ` · 可用 ${(d.available_vram_mb / 1024).toFixed(1)} GiB` : ''}。${plan.detail}`;
    } catch (error) { gpuInfo.textContent = `硬件建议暂不可用：${error.message}`; }
    await storageRead;
  }
  function init() {
    library = dialog('canvas-library-dialog', '我的画布 · 本地版本');
    const field = el('label', 'field', '画布名称'); name = el('input'); name.id = 'canvas-save-name'; name.maxLength = 120; name.setAttribute('aria-label', '画布名称'); field.append(name);
    saveButton = button('保存当前画布为新版本', 'canvas-save-version', saveCanvas, 'button primary');
    list = el('div', 'workspace-library-list'); list.id = 'canvas-library-list'; location = el('p', 'field-help path-text');
    canvasSearch = el('input'); canvasSearch.type = 'search'; canvasSearch.placeholder = '搜索全部已保存画布'; canvasSearch.setAttribute('aria-label', '搜索全部画布');
    canvasSearch.addEventListener('input', () => { ++listRevision; clearTimeout(searchTimer); searchTimer = setTimeout(() => { canvasOffset = 0; refreshCanvases().catch(host.reportError); }, 200); });
    previousCanvases = button('上一页', 'canvas-previous', () => { canvasOffset = Math.max(0, canvasOffset - 200); return refreshCanvases(); });
    nextCanvases = button('下一页', 'canvas-next', () => { canvasOffset = Number(nextCanvases.dataset.offset); return refreshCanvases(); });
    const paging = el('div', 'wrap-actions'); paging.append(previousCanvases, nextCanvases);
    library.append(el('p', 'muted', '保存节点、连线、视角及引用的工作流定义；不复制模型或媒体。载入不会启动生成，原画布可以撤销恢复。'), field, saveButton, canvasSearch, location, list, paging); frameDialog(library);
    if (!host.openCanvasManagement) document.querySelector('.project-actions').prepend(button('我的画布 / 保存', 'canvas-library-button', openCanvases, 'button primary compact'));
    results = dialog('results-dialog', '生成产物');
    resultFilter = el('select'); resultFilter.id = 'result-media-filter'; resultFilter.setAttribute('aria-label', '产物类型');
    for (const [value, label] of [['all', '全部产物'], ['image', '图片'], ['video', '视频'], ['audio', '音频']]) { const option = el('option', '', label); option.value = value; resultFilter.append(option); }
    resultFilter.addEventListener('change', () => renderResults().catch(host.reportError));
    resultList = el('div', 'workspace-results'); results.append(resultFilter, button('刷新', 'results-refresh', openResults), resultList); frameDialog(results);
    const resultsNav = document.querySelector('#nav-results');
    if (resultsNav) resultsNav.addEventListener('click', () => openResults().catch(host.reportError));
    else document.querySelector('.top-actions').prepend(button('生成作品', 'results-button', openResults, 'button quiet compact'));
    const setting = document.querySelector('#settings-form'), head = setting.querySelector('.modal-heading');
    const section = el('section', 'workspace-settings'); section.append(el('h3', '', 'GPU 与参数建议'));
    profile = el('select'); profile.id = 'performance-profile'; profile.setAttribute('aria-label', '显存预算');
    for (const value of ['auto', '8', '12', '16', '24', '32', '48']) { const o = el('option', '', value === 'auto' ? '自动 · 当前 GPU 可用显存' : `${value} GiB 显存预算`); o.value = value; profile.append(o); }
    gpuInfo = el('p', 'field-help'); section.append(profile, gpuInfo, el('p', 'field-help', '保存预算后，在图片或视频生成页点击“按 GPU 建议填充”。保留你手动设置的模型、种子和提示词。'), button('快捷键与操作说明', 'settings-shortcuts', () => document.querySelector('#help-dialog').showModal()));
    const storageSection = el('section', 'workspace-settings'); storageSection.id = 'workspace-storage';
    storageInfo = el('div'); storageInfo.id = 'workspace-storage-info'; storageInfo.setAttribute('role', 'status'); storageInfo.setAttribute('aria-live', 'polite');
    storageInfo.textContent = '打开设置或点击刷新时读取客户端素材摘要';
    storageRefresh = button('刷新素材占用', 'workspace-storage-refresh', refreshStorage);
    storageSection.append(el('h3', '', '客户端素材与登记额度'), storageInfo, storageRefresh,
      el('p', 'field-help', '占用按客户端副本文件字节统计，可能包含尚未使用的副本；不包含模型或后端文件。登记额度用于引擎输入素材，并不代表磁盘剩余空间。'));
    settingsDialog = document.querySelector('#settings-dialog');
    settingsDialog?.addEventListener('close', () => { if (settingsDialog.open) return; storageRevision++; storageRefresh.disabled = false;
      storageInfo.textContent = '打开设置或点击刷新时读取客户端素材摘要'; });
    head.after(section, storageSection); document.querySelectorAll('dialog.modal').forEach(frameDialog);
    recoveryDialog = dialog('recovery-dialog', '本地记录恢复提醒');
    recoveryButton = button('查看本地记录恢复提醒', 'recovery-details', () => recoveryDialog.showModal());
    recoveryButton.hidden = true; section.append(recoveryButton);
  }
  function showRecovery(warnings) {
    if (!Array.isArray(warnings) || !warnings.length) return;
    for (const warning of warnings) recoveryDialog.append(el('p', 'form-note', warning));
    recoveryDialog.append(el('p', 'muted', '有效记录已恢复。请先保留恢复备份，避免直接删除或覆盖原文件；此提醒也可在软件设置中重新打开。'));
    frameDialog(recoveryDialog); recoveryButton.hidden = false; recoveryDialog.showModal();
  }
  return { init, openCanvases, openResults, refreshSettings, showRecovery };
}
