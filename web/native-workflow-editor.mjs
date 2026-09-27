/** Original ComfyUI documents live locally; native controls run on an isolated origin. */
export const EDITOR_LIMIT = 16 * 1024 * 1024;
export function editorDocument(text) {
  if (new TextEncoder().encode(text).length > EDITOR_LIMIT) throw new Error('原生工作流最大为 16 MiB');
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  return value && Array.isArray(value.nodes) ? value : null;
}
export function createNativeWorkflowEditor(host) {
  let active = null, opening = false;
  const element = (tag, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
  async function open(node, backendReady = false, preparation = false) {
    if (active || opening) throw new Error('请先返回外层画布');
    opening = true;
    try { await openEditor(node, backendReady, preparation); } finally { opening = false; }
  }
  async function openEditor(node, backendReady, preparation) {
    let workflow = await host.api(`/api/editor-workflows/${node.data.editor_id}`);
    const selectedBackend = backendReady || (host.ensureBackend ? await host.ensureBackend(node, workflow) : null);
    if (host.ensureBackend && !selectedBackend) return;
    await host.ensureInstance(node);
    const id = node.data.editor_id;
    if (id !== workflow.id) workflow = await host.api(`/api/editor-workflows/${id}`);
    const session = await host.api(`/api/editor-workflows/${id}/session`, {});
    if (typeof selectedBackend === 'string' && session.backend_url !== selectedBackend) {
      await host.api('/api/editor-sessions/close', {session_id: session.session_id});
      throw new Error('推理引擎已被其他窗口切换，请重新选择后进入。');
    }
    const dialog = element('dialog'); dialog.className = 'native-workflow-dialog';
    if (preparation) dialog.classList.add('native-prepare-dialog');
    const header = element('header'), title = element('strong', workflow.name), status = element('p', '正在加载原生编辑器与扩展…');
    const buttons = element('div'); buttons.className = 'native-editor-actions';
    const frame = element('iframe'); frame.title = `${workflow.name} · 内部工作流`;
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-downloads allow-modals');
    frame.referrerPolicy = 'no-referrer';
    const state = { ready: false, busy: false, missing: [], pending: new Map(), session, frame, dialog };
    active = state;
    const releaseOnLeave = () => host.releaseSession(session.session_id);
    window.addEventListener('pagehide', releaseOnLeave, { once: true });
    function request(action, extra = {}) {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => { state.pending.delete(requestId); reject(new Error('内部编辑器未响应；原始工作流仍保存在本地')); }, 45000);
        state.pending.set(requestId, { resolve, reject, timeout });
        frame.contentWindow.postMessage({ source: 'prism-parent', nonce: session.bridgeNonce, requestId, action, ...extra }, session.origin);
      });
    }
    function show(message) { status.textContent = message; }
    function refresh() { draft.disabled = apply.disabled = !state.ready || state.busy || !!state.missing.length; back.disabled = state.busy; }
    async function action(callback) {
      if (state.busy) return;
      state.busy = true; refresh();
      try { await callback(); } catch (error) { show(error.message); discard.hidden = false; }
      finally { state.busy = false; refresh(); }
    }
    async function saveDraft() {
      const result = await request('snapshot');
      const saved = await host.api(`/api/editor-workflows/${id}/draft`, { document: result.workflow, base_revision: workflow.revision });
      workflow.revision = saved.revision;
      show('内部草稿已保存；外层继续使用上一次明确应用的参数。');
    }
    async function close() {
      clearTimeout(startup);
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', releaseOnLeave);
      for (const item of state.pending.values()) { clearTimeout(item.timeout); item.reject(new Error('编辑器已关闭')); }
      state.pending.clear(); dialog.close(); dialog.remove(); active = null;
      await host.api('/api/editor-sessions/close', { session_id: session.session_id });
    }
    const back = element('button', '← 返回画布'); back.className = 'button quiet';
    back.onclick = () => action(async () => { if (state.ready && !state.missing.length) await saveDraft(); await close(); });
    const draft = element('button', '保存内部草稿'); draft.className = 'button quiet'; draft.onclick = () => action(saveDraft);
    async function applyParameters() {
      const result = await request('compile');
      const applied = await host.applyInterface(node, result, { session_id: session.session_id, base_revision: workflow.revision });
      if (!applied) { show('尚未选择外层参数。可以重新提取，或返回画布使用已保存配置。'); return; }
      await host.applied(node, applied);
      await close(); host.toast('已应用内部参数；现在可在外层连接输入并生成');
    }
    const apply = element('button', preparation ? '重新提取外层参数' : '应用参数并返回'); apply.className = 'button primary';
    apply.onclick = () => action(applyParameters);
    const reveal = element('button', '进入内部编辑'); reveal.className = 'button quiet'; reveal.hidden = !preparation;
    reveal.onclick = () => { preparation = false; dialog.classList.remove('native-prepare-dialog'); reveal.hidden = true; apply.textContent = '应用参数并返回'; };
    const original = element('button', '导出完整工作流'); original.className = 'button quiet';
    original.onclick = () => action(async () => {
      if (state.ready && !state.missing.length) {
        const result = await request('snapshot'); host.downloadJSON(result.workflow, `${workflow.name}.json`);
      } else {
        const result = await host.api(`/api/editor-workflows/${id}/export`, {});
        host.downloadJSON(result.source_json, `${workflow.name}.json`);
      }
    });
    const repair = element('button', '复制修复说明'); repair.className = 'button quiet';
    repair.onclick = () => host.copyText(`请检查 ComfyUI 原生工作流的编辑环境。工作流节点数：${workflow.nodes}。缺少前端节点类型：${state.missing.join('、') || '尚未确认，请先检查编辑器连接'}。请核实这些类型的现行插件、兼容替代与输入输出契约，不要只按旧插件名安装。保留原工作流、旁路模式和自定义控件；导入及检查不应提交生成任务。`);
    const discard = element('button', '放弃未保存修改并返回'); discard.className = 'button quiet'; discard.hidden = true;
    discard.onclick = () => action(close);
    const recheck = element('button', '重新检查节点'); recheck.className = 'button quiet';
    recheck.onclick = () => action(async () => {
      const result = await request('snapshot'); state.missing = result.missing || [];
      show(state.missing.length ? `仍缺少：${state.missing.join('、')}。原文仍保留；可替换缺失控件后再检查。` : '当前节点已齐全，可以保存草稿或配置外层参数。');
    });
    const switchEngine = element('button', '更换工作流引擎'); switchEngine.className = 'button quiet';
    switchEngine.onclick = () => action(async () => {
      if (state.ready && !state.missing.length) await saveDraft();
      await close();
      const target = await host.ensureBackend(node, workflow, true);
      if (target) await open(node, target, preparation);
    });
    buttons.append(back, switchEngine, reveal, original, repair, recheck, draft, apply, discard); header.append(title, buttons, status);
    const note = element('div', preparation ? `正在用 ${session.backend_url} 解析工作流控件，随后选择要在外层显示的参数。此过程不生成图片或视频。` : `内部编辑器 · ${session.backend_url} · 调参后点击“应用参数并返回”。生成统一在外层进行；参考素材可在外层上传。`); note.className = 'native-editor-note';
    dialog.append(header, note, frame); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!state.busy) back.click(); });
    async function receive(event) {
      if (active !== state || event.source !== frame.contentWindow || event.origin !== session.origin || event.data?.source !== 'prism-editor' || event.data.nonce !== session.bridgeNonce) return;
      const message = event.data;
      if (message.action === 'notice') { note.textContent = `内部编辑器 · ${session.backend_url} · ${String(message.result?.message || message.message || '更换整个工作流请返回外层导入。')}`; return; }
      if (message.action === 'ready' && !state.loading) {
        state.loading = true; state.busy = true; refresh(); clearTimeout(startup);
        try {
          const result = await request('load', { document: workflow.document });
          state.missing = Array.isArray(result.missing) ? result.missing : [];
          state.ready = true;
          show(state.missing.length ? `缺少 ${state.missing.length} 种前端节点：${state.missing.join('、')}。原文已保留；请切换到安装了这些扩展的后端，补齐后重新进入。` : `已载入 ${result.nodes} 个节点。内部草稿和外层已应用参数分别保存。`);
          if (!state.missing.length) {
            const patches = [], unmapped = [], definitions = [];
            for (const field of host.fields(node)) {
              if (!Object.hasOwn(node.data.editor_baseline || {}, field.id)) continue;
              const value = node.data.packageValues?.[field.id], baseline = node.data.editor_baseline[field.id];
              if (value === undefined || JSON.stringify(value) === JSON.stringify(baseline)) continue;
              const control = (node.data.editor_controls || []).find(c => c.node_id === field.node_id && c.input === field.input);
              if (!control) { unmapped.push(field.label); continue; }
              patches.push({ node_id: control.widget_node_id, widget_name: control.widget_name, value, expected_value: baseline }); definitions.push(field);
            }
            if (patches.length) {
              try { await request('patch', { patches }); }
              catch (error) {
                const unsupported = error.result?.unsupported || [];
                if (unsupported.length && unsupported.every(item => item.reason === 'conflict')) {
                  const conflicts = unsupported.map(item => ({ id: String(item.index), label: definitions[item.index].label, outer: patches[item.index].value, inner: item.current_value }));
                  const choices = await host.resolveConflicts(conflicts);
                  if (!choices) throw new Error('外层与内部草稿有不同修改，尚未同步；请先解决冲突再应用。');
                  const updates = {};
                  for (const item of unsupported) {
                    const patch = patches[item.index]; patch.expected_value = item.current_value;
                    if (choices[String(item.index)] === 'inner') { patch.value = item.current_value; updates[definitions[item.index].id] = item.current_value; }
                  }
                  await request('patch', { patches }); host.syncOuterValues(node, updates);
                } else throw error;
              }
            }
            show(`已载入 ${result.nodes} 个节点；已同步 ${patches.length} 项外层修改。${unmapped.length ? `以下特殊控件无法直接回写，外层覆盖值仍保留，应用时会核对：${unmapped.join('、')}` : '内部和外层使用同一组可映射参数。'}`);
            if (preparation) { show('正在提取可编辑参数和输出…'); await applyParameters(); }
          } else if (preparation) {
            show(`无法建立外层参数：缺少 ${state.missing.length} 种节点（${state.missing.join('、')}）。可更换引擎、进入内部修复，或返回画布“复用已保存配置”。原文已保留。`);
          }
        } catch (error) { show(error.message); discard.hidden = false; }
        state.busy = false; refresh(); return;
      }
      const pending = state.pending.get(message.requestId);
      if (!pending) return;
      state.pending.delete(message.requestId); clearTimeout(pending.timeout);
      if (message.error) { const error = new Error(message.error); error.result = message.result; pending.reject(error); } else pending.resolve(message.result);
    }
    window.addEventListener('message', receive);
    const startup = setTimeout(() => show('原生编辑器加载超时。请检查所选 ComfyUI 服务是否启动、前端与扩展是否兼容；原始工作流已保留，可返回后更换后端再进入。'), 60000);
    refresh(); dialog.showModal(); frame.src = session.url;
  }
  return { open, prepare: node => open(node, false, true), applyToNode: host.applied, isOpen: () => !!active || opening };
}
