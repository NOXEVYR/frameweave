/** Optional local worker: private credentials never enter browser storage. */
const BASE = '/api/hub-connection';
const copy = value => JSON.parse(JSON.stringify(value));
const MAX_GRANT = 32768;
const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
export function eligibleHubField(field) {
  if (['text', 'integer', 'number', 'boolean'].includes(field?.type)) return true;
  if (field?.type !== 'select' || !Array.isArray(field.options) || !field.options.length || field.options.length > 32) return false;
  return ['string', 'number', 'boolean'].some(kind => field.options.every(value => typeof value === kind
    && (kind !== 'string' || [...value].length <= 12000) && (kind !== 'number' || Number.isFinite(value))));
}
export function profileFromOffer(offer, remote) {
  if (offer?.schema !== 'prismcanvas.hub-offer/1' || !/^[a-f0-9]{32}$/.test(remote?.capability_id || '')
      || typeof remote.declaration_text !== 'string') throw new Error('能力声明响应无效，请重新核对。');
  const declaration = JSON.parse(remote.declaration_text);
  const marker = `prismcanvas-binding-sha256:${offer.binding_sha256}`;
  if (declaration.key !== offer.declaration.key || !Array.isArray(declaration.constraints)
      || declaration.constraints.filter(value => typeof value === 'string' && value.startsWith('prismcanvas-binding-sha256:')).length !== 1
      || !declaration.constraints.includes(marker)
      || canonical(declaration.inputs) !== canonical(offer.declaration.inputs)
      || canonical(declaration.domains) !== canonical(offer.declaration.domains)
      || declaration.kind !== offer.declaration.kind) throw new Error('Hub 声明与当前工作流配置不一致，请重新发布本次准备的声明。');
  return { schema: 'prismcanvas.hub-capability/1', capability_id: remote.capability_id,
    declaration_text: remote.declaration_text, backend: offer.backend, template: copy(offer.template),
    bindings: copy(offer.bindings), enabled: false };
}

export function createHubCenter(host) {
  const create = (tag, cls = '', text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
  const dialog = create('dialog', 'modal framed-modal hub-modal'); dialog.setAttribute('aria-label', 'AI Hub 接入');
  const head = create('div', 'modal-heading'), heading = create('div');
  heading.append(create('span', 'eyebrow', 'OPTIONAL CONNECTION'), create('h2', '', 'AI Hub 接入'));
  const close = create('button', 'close-button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭 AI Hub 接入');
  close.addEventListener('click', () => dialog.close()); head.append(heading, close);
  const scroll = create('div', 'modal-scroll hub-body');
  const explanation = create('p', 'form-note', '棱光可独立使用。接入后，只执行你明确开放的本地工作流。导入授权、检查连接和准备能力都不会生成；启用接收后才会自动处理匹配任务。接收开关会保存在本机，重新打开软件后按此选择恢复。');
  const status = create('div', 'hub-status'); status.setAttribute('aria-live', 'polite');
  const note = create('p', 'form-note hub-notice'); note.setAttribute('role', 'status');
  const connectionActions = create('div', 'hub-actions');
  const file = create('input'); file.type = 'file'; file.accept = '.json,application/json'; file.hidden = true;
  let state = null, busy = false, serial = 0, openRevision = 0, wizardRevision = 0, selection = null, offer = null, remote = null;
  let cursor = null, rows = [], timer = null, executionPage = null, executionAfter = null;
  let enabling = false, enableRevision = 0;
  const gates = new WeakMap();
  function action(label, handler, { primary = false, mutation = true, allowBusy = false } = {}) {
    const b = create('button', `button ${primary ? 'primary' : 'quiet'} compact`, label); b.type = 'button';
    b.addEventListener('click', () => Promise.resolve(handler()).catch(error => { note.textContent = error.message; host.reportError(error); }));
    if (mutation) { b.dataset.hubMutation = 'true'; b.dataset.allowBusy = allowBusy ? 'true' : 'false'; }
    return b;
  }
  function controls() {
    for (const button of dialog.querySelectorAll('[data-hub-mutation]')) button.disabled = (busy || !!state?.busy) && button.dataset.allowBusy !== 'true' || !!gates.get(button)?.();
    probe.disabled ||= !state?.configured;
    toggle.disabled ||= !state?.configured || !state?.enabled && !enabling && (busy || !!state?.busy);
    toggle.textContent = state?.enabled || enabling ? '暂停接收与调度' : '启用已开放能力，自动接收任务';
    prepare.disabled ||= !selection;
    exportButton.disabled ||= !offer;
    verify.disabled ||= !offer || !state?.configured;
    saveCapability.disabled ||= !remote || !offer;
  }
  async function run(fn) {
    if (busy) return;
    busy = true; controls();
    try { return await fn(); }
    finally { busy = false; controls(); }
  }
  async function refresh() {
    const ticket = ++serial, opening = openRevision;
    let value;
    try { value = await host.api(BASE); }
    catch (error) {
      if (error.status === 404 && ticket === serial && opening === openRevision && dialog.open) {
        state = null; executionPage = null; renderStatus(); renderCapabilities(); renderExecutions(); controls();
        note.textContent = '当前运行的棱光服务尚未加载接入功能。请在任务结束后更新并重新打开客户端；仅刷新页面不会更新后台。';
        throw new Error(note.textContent);
      }
      throw error;
    }
    if (ticket !== serial || opening !== openRevision || !dialog.open) return;
    state = value; if (!executionAfter) executionPage = value.executions;
    renderStatus(); renderCapabilities(); renderExecutions(); controls();
  }
  const importButton = action('导入工作端授权文件', () => file.click());
  const probe = action('检查连接与授权', () => run(async () => {
    await host.api(`${BASE}/probe`, {}); await refresh(); note.textContent = '已完成只读连接与授权检查，没有领取或执行任务。';
  }));
  const toggle = action('启用已开放能力，自动接收任务', async () => {
    if (state?.enabled || enabling) {
      enableRevision++; enabling = false; controls();
      await host.api(`${BASE}/enabled`, { enabled: false }); await refresh();
      note.textContent = '已暂停后续调度；已经发出的生成可能继续，原任务与回执仍保留。'; return;
    }
    return run(async () => {
      const revision = ++enableRevision; enabling = true; controls();
      try {
        await host.api(`${BASE}/enabled`, { enabled: true }); await refresh();
        if (revision === enableRevision) note.textContent = '已启用：只自动接收已开放能力的任务。可随时暂停后续调度。';
      } catch (error) { if (revision === enableRevision) throw error; }
      finally { if (revision === enableRevision) enabling = false; }
    });
  }, { primary: true, allowBusy: true });
  connectionActions.append(importButton, probe, toggle, file);
  file.addEventListener('change', () => run(async () => {
    const chosen = file.files?.[0]; file.value = ''; if (!chosen) return;
    if (chosen.size > MAX_GRANT) throw new Error('授权文件超过 32 KiB，请选择 Hub 导出的单个工作端授权。');
    let raw = await chosen.text();
    try {
      if (new TextEncoder().encode(raw).byteLength > MAX_GRANT) throw new Error('授权文件超过 32 KiB。');
      await host.api(`${BASE}/grant`, { grant_json: raw });
    } finally { raw = ''; }
    offer = remote = null; rows = []; cursor = null; executionPage = executionAfter = null; mapping.replaceChildren(); renderInbox();
    await refresh(); note.textContent = '授权已保存在本机私有数据目录，接收保持关闭。接下来检查连接，再配置开放能力。';
  }).catch(error => { note.textContent = error.message; host.reportError(error); }));

  const wizard = create('section', 'hub-section');
  wizard.append(create('h3', '', '开放一个工作流'), create('p', 'field-help', '在画布选中已配置的工作流包，读取它的当前参数并选择允许外部调整的字段。填写公开说明，让调用方知道参数用途；说明和可选值会发布，固定参数留在本机。内部工作流改变后，需要重新准备并发布声明。'));
  const selectedLabel = create('p', 'form-note', '尚未读取画布中的工作流包。');
  const readSelected = action('读取画布选中的工作流', () => run(async () => {
    const opening = openRevision, result = await host.selectedRequest();
    if (opening !== openRevision || !dialog.open) return;
    selection = copy(result); wizardRevision++; offer = remote = null; mapping.replaceChildren();
    name.value = selection.title || '棱光工作流'; key.value = `prism.${selection.request.package_id.slice(2, 14)}`;
    selectedLabel.textContent = `${selection.title} · ${selection.fields.length} 个输入 · ${selection.backend_url}`;
    renderFields(); controls();
  }));
  const inputField = (label, type = 'text') => { const wrap = create('label', 'field', label), input = create(type === 'select' ? 'select' : 'input'); if (type !== 'select') input.type = type; wrap.append(input); wizard.append(wrap); return input; };
  wizard.append(readSelected, selectedLabel);
  const name = inputField('对外能力名称'), key = inputField('稳定能力标识（英文或数字）'), domain = inputField('用途', 'select');
  for (const [value, label] of [['image', '图片生成 / 编辑'], ['video', '视频生成'], ['audio', '声音 / 音乐']]) { const o = create('option', '', label); o.value = value; domain.append(o); }
  domain.value = 'image';
  const fields = create('div', 'hub-fields'), mapping = create('div', 'hub-mapping');
  fields.setAttribute('aria-label', '允许外部调整的参数');
  for (const input of [name, key, domain]) input.addEventListener('input', () => { wizardRevision++; offer = remote = null; mapping.replaceChildren(); controls(); });
  function renderFields() {
    fields.replaceChildren();
    for (const field of selection?.fields || []) {
      const row = create('div', 'hub-field'), label = create('label', 'hub-field-choice'), box = create('input'); box.type = 'checkbox'; box.dataset.fieldId = field.id;
      box.disabled = !eligibleHubField(field); box.checked = false;
      label.append(box, create('span', '', `${field.label} · ${field.type}${box.disabled ? ' · 保持本地固定' : ''}`)); row.append(label);
      let description;
      if (!box.disabled) {
        description = create('input'); description.type = 'text'; description.maxLength = 200;
        description.dataset.hubDescription = field.id; description.disabled = true;
        description.setAttribute('aria-label', `公开说明：${field.label}`);
        description.value = ({prompt:'画面或内容描述',negative:'不希望出现的内容',model:'模型选项',encoder:'编码器选项',lora:'LoRA 选项'})[field.role]
          || ({text:'文本参数',integer:'整数参数',number:'数值参数',boolean:'开关参数',select:'可选参数'})[field.type];
        description.placeholder = '公开说明（例如：场景描述、采样步数）';
        description.addEventListener('input', () => { wizardRevision++; offer = remote = null; mapping.replaceChildren(); controls(); }); row.append(description);
      }
      box.addEventListener('change', () => { if (description) description.disabled = !box.checked; wizardRevision++; offer = remote = null; mapping.replaceChildren(); controls(); });
      fields.append(row);
    }
  }
  const prepare = action('校验并准备能力声明', () => run(async () => {
    const opening = openRevision, source = selection, revision = wizardRevision;
    const ids = [...fields.querySelectorAll('input')].filter(input => input.checked && !input.disabled).map(input => input.dataset.fieldId);
    if (!ids.length || ids.length > 32) throw new Error('请选择 1–32 个外部可调整参数。');
    const descriptions = Object.fromEntries([...fields.querySelectorAll('input')]
      .filter(input => ids.includes(input.dataset.hubDescription)).map(input => [input.dataset.hubDescription, input.value.trim()]));
    const value = await host.api(`${BASE}/prepare-offer`, { request: source.request, backend_url: source.backend_url,
      name: name.value.trim(), key: key.value.trim(), domain: domain.value, field_ids: ids, field_descriptions: descriptions });
    if (opening !== openRevision || source !== selection || revision !== wizardRevision || !dialog.open) return;
    offer = value; remote = null; mapping.replaceChildren(create('p', 'form-note', offer.notice));
    for (const item of offer.mapping) mapping.append(create('div', 'hub-mapping-row', `${item.input} → ${item.label} (${item.type})`));
    note.textContent = '已校验当前工作流，没有生成。导出声明后，在 Hub 合并到此工作端的能力列表再发布，并填入返回的能力 ID；请保留已有声明，避免覆盖其他能力。';
  }));
  const exportButton = action('导出公开能力声明', () => {
    if (offer) host.downloadJSON([copy(offer.declaration)], `PrismCanvas-${offer.declaration.key}-capability.json`);
  });
  const capabilityId = inputField('Hub 发布后返回的能力 ID'); capabilityId.placeholder = '32 位能力 ID';
  capabilityId.addEventListener('input', () => { remote = null; controls(); });
  const verify = action('核对已发布声明', () => run(async () => {
    const expected = offer, id = capabilityId.value.trim(), opening = openRevision;
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('请填写 Hub 返回的 32 位能力 ID。');
    const value = await host.api(`${BASE}/read-capability`, { capability_id: id });
    if (expected !== offer || id !== capabilityId.value.trim() || opening !== openRevision || !dialog.open) return;
    profileFromOffer(offer, value); remote = value; note.textContent = '已核对发布客户端和冻结工作流摘要，可以保存为本机能力。';
  }));
  const saveCapability = action('保存能力（暂不启用）', () => run(async () => {
    const profile = profileFromOffer(offer, remote);
    await host.api(`${BASE}/capabilities`, { profile_json: JSON.stringify(profile) });
    await refresh(); note.textContent = '能力已保存且关闭。核对列表后，分别启用能力与自动接收。';
  }), { primary: true });
  const wizardActions = create('div', 'hub-actions'); wizardActions.append(prepare, exportButton);
  const publicationActions = create('div', 'hub-actions'); publicationActions.append(verify, saveCapability);
  wizard.append(fields, wizardActions, mapping, capabilityId.parentElement, publicationActions);
  const capabilities = create('section', 'hub-section'), capabilityList = create('div');
  capabilities.append(create('h3', '', '已保存的能力'), capabilityList);
  function renderCapabilities() {
    capabilityList.replaceChildren();
    for (const item of state?.capabilities || []) {
      const row = create('article', 'hub-row'), body = create('div');
      body.append(create('strong', '', item.name || item.capability_id), create('p', 'field-help', `${item.enabled ? '允许执行' : '未开放'} · ${item.package_id} · ${item.capability_id}`));
      const b = action(item.enabled ? '停用能力' : '允许执行此能力', () => run(async () => { await host.api(`${BASE}/enable-capability`, { capability_id: item.capability_id, enabled: !item.enabled }); await refresh(); }));
      const actions = create('div', 'hub-actions');
      actions.append(b, action('移除本机能力', () => run(async () => { await host.api(`${BASE}/remove-capability`, { capability_id: item.capability_id }); await refresh(); })));
      row.append(body, actions); capabilityList.append(row);
    }
    if (!state?.capabilities?.length) capabilityList.append(create('p', 'form-note', '还没有开放的工作流。'));
  }
  const inboxSection = create('section', 'hub-section'), inboxList = create('div');
  const inboxActions = create('div', 'hub-actions');
  const loadInbox = async more => run(async () => {
    const opening = openRevision;
    const page = await host.api(`${BASE}/inbox`, { limit: 10, ...(more && cursor ? { after_execution_id: cursor } : {}) });
    if (opening !== openRevision || !dialog.open) return;
    rows = page.items || []; cursor = page.has_more ? page.next_after_execution_id : null; renderInbox();
    note.textContent = '已只读查看当前授权范围的任务，没有因查询领取任务。翻页之间队列可能变化。';
  });
  const next = action('下一页', () => loadInbox(true));
  gates.set(next, () => !cursor || !state?.configured);
  inboxActions.append(action('查看待处理任务', () => loadInbox(false)), next);
  inboxSection.append(create('h3', '', '范围内的待处理任务'), inboxActions, inboxList);
  function renderInbox() {
    inboxList.replaceChildren(); next.disabled = busy || !cursor;
    for (const item of rows) {
      const row = create('article', 'hub-row');
      row.append(create('p', 'field-help', `${item.execution_id} · ${item.provider_state || item.dispatch_state || '待处理'} · 能力 ${item.capability_id}`));
      const b = action('接收并推进此任务', () => run(async () => { await host.api(`${BASE}/step`, { execution_id: item.execution_id }); await refresh(); }));
      gates.set(b, () => !state?.enabled); b.disabled = !state?.enabled; row.append(b); inboxList.append(row);
    }
    if (!rows.length) inboxList.append(create('p', 'form-note', '点击查看后显示此授权范围内的任务，不会读取其他工具的队列。'));
  }
  const executions = create('section', 'hub-section'), executionList = create('div');
  const executionActions = create('div', 'hub-actions');
  async function loadExecutions(after = null) {
    const opening = openRevision;
    const value = await host.api(`${BASE}/executions`, { limit: 10, ...(after ? { after_execution_id: after } : {}) });
    if (opening !== openRevision || !dialog.open) return;
    executionPage = value; executionAfter = after; renderExecutions();
  }
  const executionFirst = action('刷新本机记录', () => run(() => loadExecutions()));
  const executionNext = action('下一页记录', () => run(() => loadExecutions(executionPage?.next_after_execution_id)));
  gates.set(executionNext, () => !executionPage?.has_more || !executionPage?.next_after_execution_id);
  executionActions.append(executionFirst, executionNext);
  executions.append(create('h3', '', '本机执行与恢复'), executionActions, executionList);
  function renderExecutions() {
    executionList.replaceChildren();
    const items = executionPage?.items || [];
    for (const item of items) {
      const row = create('article', 'hub-row'); row.append(create('p', 'field-help', `${item.execution_id} · ${item.state || item.provider_state || '待查询'}`));
      if (!item.finished) row.append(action('查询并继续原任务', () => run(async () => { await host.api(`${BASE}/step`, { execution_id: item.execution_id }); await refresh(); await loadExecutions(executionAfter); })));
      executionList.append(row);
    }
    if (!items.length) executionList.append(create('p', 'form-note', '尚无执行记录。暂停、断线或重启后保留同一任务编号。'));
  }
  function renderStatus() {
    status.replaceChildren(create('strong', '', state?.enabled ? '已启用自动接收' : state?.configured ? '已配置 · 接收暂停' : '尚未接入'));
    if (state?.connection) status.append(create('p', 'field-help', `${state.connection.host}:${state.connection.port} · 工作端 ${state.connection.subject} · 范围 ${state.connection.scope}`));
    status.append(create('p', 'field-help', state?.busy ? '正在处理一次操作；暂停后不再准入新任务，已发出的操作允许收尾。' : '授权、固定参数与任务账本保存在本机。'));
    if (state?.last_error?.message) status.append(create('p', 'form-note', `连接或恢复提示：${state.last_error.message}`));
  }
  scroll.append(explanation, status, connectionActions, note, capabilities, wizard, inboxSection, executions);
  renderInbox();
  dialog.append(head, scroll); document.body.append(dialog);
  dialog.addEventListener('close', () => { openRevision++; serial++; if (timer) clearInterval(timer); timer = null; file.value = ''; });
  return {
    async open() {
      if (!dialog.open) { openRevision++; dialog.showModal(); }
      controls(); await refresh();
      if (dialog.open && !timer) timer = setInterval(() => { if (dialog.open && !document.hidden && !busy) refresh().catch(error => { note.textContent = error.message; }); }, 5000);
    },
    close: () => dialog.close(), refresh,
  };
}
