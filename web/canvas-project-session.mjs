import { projectOf } from './canvas-project-catalog.mjs';
// Navigation uses the existing immutable canvas-version API. Graphs stay owned
// by the app; only the last explicitly saved in-memory signature is kept here.
export function canvasProjectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) {
    throw new Error('请填写 1–120 字的画布名称');
  }
  return value.trim();
}

export function createCanvasProjectSession(host) {
  let operation = '', baseline = null;
  const read = () => host.readCurrent();
  const state = () => {
    const current = read();
    return { ...current, dirty: !!current.active && (!baseline || baseline.identity !== current.identity || baseline.signature !== current.signature),
      busy: !!operation || !!current.busy, baselineKnown: !!baseline && baseline.identity === current.identity,
      savedVersionId: baseline?.identity === current.identity ? baseline.recordId : null };
  };
  const notify = () => host.onStateChange?.(state());
  const assertCurrent = ticket => { host.assertCurrent(ticket); host.assertCanReplace(); };
  const savedRecord = record => {
    if (!record || typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id)) {
      throw new Error('保存结果无法核实；当前草稿已保留，请刷新版本列表核对，不会自动重新保存');
    }
    return record;
  };
  async function transaction(label, action) {
    if (operation) throw new Error('已有画布操作进行中，请等待完成');
    host.assertCanReplace();
    // The shared flush also checks IME on the first/invalid-draft screen. An
    // inactive canvas must perform no draft writes, but still needs that guard
    // before a named empty version can be persisted.
    if (host.flush() === false) throw new Error('浏览器草稿保存失败，已取消画布切换，请先导出或保存本地版本');
    operation = label;
    try { notify(); return await action(host.capture()); }
    finally { operation = ''; notify(); }
  }
  async function saveTicket(ticket, name) {
    const title = canvasProjectName(name);
    assertCurrent(ticket);
    const document = await host.buildBundle();
    assertCurrent(ticket);
    document.name = title;
    const record = savedRecord(await host.saveDocument(document));
    // Saving creates a retained immutable version. A late response must never
    // rename, mark clean, or navigate a different/currently edited canvas.
    assertCurrent(ticket);
    const committed = host.commitSaved(record, title);
    assertCurrent(committed);
    const current = read();
    baseline = { identity: current.identity, signature: current.signature, recordId: record.id };
    notify();
    return { record, ticket: committed };
  }
  async function protect(ticket) {
    if (!state().dirty) return ticket;
    const choice = await host.confirmSwitch({ title: read().title });
    assertCurrent(ticket);
    if (!choice || choice.action === 'cancel') return null;
    if (choice.action === 'discard') return ticket;
    if (choice.action !== 'save') throw new Error('画布切换选择无效，当前内容已保留');
    const saved = await saveTicket(ticket, choice.name);
    assertCurrent(saved.ticket);
    return saved.ticket;
  }
  function remember(record) {
    const current = read();
    baseline = { identity: current.identity, signature: current.signature, recordId: record.id };
    notify();
  }
  return {
    readCurrent: state,
    update: notify,
    invalidateBaseline() { baseline = null; notify(); },
    async save(name) {
      if (!read().active) throw new Error('请先新建或打开画布');
      return transaction('save', async ticket => { await saveTicket(ticket, name); return true; });
    },
    async create(name, { preserveDraft = false } = {}) {
      const title = canvasProjectName(name);
      return transaction('create', async ticket => {
        if (preserveDraft && state().dirty) ticket = (await saveTicket(ticket, read().title)).ticket;
        else if (!preserveDraft) ticket = await protect(ticket);
        if (!ticket) return false;
        assertCurrent(ticket);
        const document = host.emptyDocument(title);
        const record = savedRecord(await host.saveDocument(document));
        assertCurrent(ticket);
        const committed = await host.installCreated(document, record, ticket);
        assertCurrent(committed);
        host.bindProject?.(committed.identity, projectOf(document, record.id));
        remember(record); host.showEditor(); return true;
      });
    },
    async changeVersion(item, isCurrent, action, name) {
      const title = canvasProjectName(name);
      if (!['rename', 'copy'].includes(action)) throw new Error('画布操作无效');
      if (!isCurrent && !/^[a-f0-9]{32}$/.test(item?.id || '')) throw new Error('画布项目无效');
      if (isCurrent && (!read().active || item.currentIdentity !== undefined && item.currentIdentity !== read().identity || item.id && read().projectId !== item.id)) {
        throw new Error('当前画布已变化，请重新打开菜单');
      }
      return transaction(action, async ticket => {
        if (isCurrent && action === 'rename') { await saveTicket(ticket, title); return true; }
        let document;
        if (isCurrent) {
          if (!read().active || item.id && read().projectId !== item.id) throw new Error('当前画布已变化，请重新打开菜单');
          document = await host.buildBundle();
        } else {
          const versionId = item.latestId || item.id;
          const record = await host.loadDocument(versionId);
          if (record?.id !== versionId || !record.document || projectOf(record.document, record.id) !== item.id) {
            throw new Error('画布版本身份无法核实，请刷新后重试');
          }
          document = record.document;
        }
        assertCurrent(ticket);
        const projectId = action === 'copy' ? crypto.randomUUID().replaceAll('-', '') : item.id;
        const copy = { ...structuredClone(document), name: title, project_id: projectId };
        savedRecord(await host.saveDocument(copy));
        assertCurrent(ticket);
        return true;
      });
    },
    async open(id, { preserveDraft = false } = {}) {
      if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new Error('画布版本 ID 无效');
      return transaction('open', async ticket => {
        if (preserveDraft && state().dirty) ticket = (await saveTicket(ticket, read().title)).ticket;
        else if (!preserveDraft) ticket = await protect(ticket);
        if (!ticket) return false;
        const record = await host.loadDocument(id);
        assertCurrent(ticket);
        if (!record || record.id !== id || !record.document) throw new Error('画布版本读取失败，当前内容已保留');
        const committed = await host.installOpened(record.document, record, ticket);
        assertCurrent(committed);
        host.bindProject?.(committed.identity, projectOf(record.document, record.id));
        remember(record); host.showEditor(); return true;
      });
    },
    continue() {
      if (!read().active) throw new Error('没有可继续的浏览器草稿，请先新建或打开画布');
      if (operation) throw new Error('请等待当前画布操作完成');
      host.showEditor(); return true;
    },
    async showManagement() {
      if (operation) throw new Error('请等待当前画布操作完成');
      if (read().active && host.flush() === false) throw new Error('浏览器草稿保存失败，已留在当前画布');
      await host.showManagement(); notify(); return true;
    },
  };
}
