import { normalizePresetPrompt } from './preset-editor.mjs';
import { redactLocalText, parseJSONWithSafeNumbers } from './packages.mjs';
import { createEditorSessionProjection, importEditorBaseline } from './editor-session-projection.mjs';
import { prepareOwnMediaSynchronization } from './editor-media-synchronization.mjs';
import { editorTargetHost, editorLifecycle } from './editor-target-host.mjs';

/** Original ComfyUI documents live locally; native controls run on an isolated origin. */
export const EDITOR_LIMIT = 16 * 1024 * 1024;
export function editorErrorMessage(error) {
  const labels = { added_node: '新增节点', missing_node: '丢失节点', class_changed: '节点类型改变',
    added_input: '新增输入', missing_input: '丢失输入', value_changed: '输入值改变', metadata_changed: '节点元数据改变' };
  const issues = error?.result?.semantic_mismatch?.issues;
  if (!Array.isArray(issues) || !issues.length) return error.message;
  const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : '未标识';
  const details = issues.slice(0, 8).map(issue => `${labels[issue.code] || '结构变化'} ${identifier(issue.node_id)}${issue.input ? '.' + identifier(issue.input) : ''}`);
  return `${error.message} 回编译差异：${details.join('；')}。原始内容已保留；可在 ComfyUI 内确认默认参数后重新导出工作流。`;
}
export function editorDocument(text) {
  if (new TextEncoder().encode(text).length > EDITOR_LIMIT) throw new Error('原生工作流最大为 16 MiB');
  const value = parseJSONWithSafeNumbers(text.replace(/^\uFEFF/, ''));
  return value && Array.isArray(value.nodes) ? value : null;
}
export function confirmEditorAdditions(review) {
  return new Promise(resolve => {
    const el = (tag, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
    const dialog = el('dialog'); dialog.className = 'modal packages-modal native-additions-dialog';
    dialog.setAttribute('aria-label', '复核前端新增参数');
    const finish = accepted => { dialog.close(); dialog.remove(); resolve(accepted); };
    const button = (text, handler, primary = false) => { const item = el('button', text); item.type = 'button'; item.className = primary ? 'button primary' : 'button quiet'; item.onclick = handler; return item; };
    const heading = el('div'); heading.className = 'modal-heading';
    const close = button('×', () => finish(false)); close.setAttribute('aria-label', '关闭'); close.className = 'close-button';
    heading.append(el('h2', '复核前端新增参数'), close); dialog.append(heading);
    dialog.append(el('p', '当前 ComfyUI 前端为以下参数补充了值。它们没有足够的默认值依据，尚未自动接受。确认后建立新的内部草稿；原始执行图仍保留，不会启动生成。'));
    const list = el('div'); list.className = 'native-additions-list';
    for (const item of review.added_inputs) {
      const row = el('section'); row.className = 'native-addition-row';
      row.append(el('strong', `${item.class_type} · 节点 ${item.node_id}`), el('code', item.input), el('pre', JSON.stringify(item.value)));
      list.append(row);
    }
    dialog.append(list, el('p', '只有本次列出的新增值可以被接受。原有节点、输入、连线或元数据如有变化，转换仍会停止。'));
    const actions = el('div'); actions.className = 'modal-actions';
    actions.append(button('取消，保留原工作流', () => finish(false)), button('确认补充并进入', () => finish(true), true)); dialog.append(actions);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    document.body.append(dialog); dialog.showModal(); close.focus?.();
  });
}

export function resolveConnectedEditorValues(conflicts) {
  return new Promise(resolve => {
    const el = (tag, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
    const dialog = el('dialog'); dialog.className = 'modal packages-modal native-additions-dialog';
    dialog.setAttribute('aria-label', '保存连线输入的内部修改');
    const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
    const button = (text, handler, primary = false) => { const item = el('button', text); item.type = 'button'; item.className = primary ? 'button primary' : 'button quiet'; item.onclick = handler; return item; };
    const heading = el('div'); heading.className = 'modal-heading';
    const close = button('×', () => finish(null)); close.className = 'close-button'; close.setAttribute('aria-label', '关闭');
    heading.append(el('h2', '保存连线输入的内部修改'), close); dialog.append(heading);
    dialog.append(el('p', '这些输入来自画布连线，但你在内部修改了它们。连线保持连接，外层生成仍使用连线来源；这里决定保存哪一个内部值。'));
    const list = el('div'); list.className = 'native-additions-list';
    const choices = new Map();
    const confirm = button('按所选方式继续保存', () => finish(Object.fromEntries(choices)), true); confirm.disabled = true;
    for (const item of conflicts) {
      const row = el('section'); row.className = 'native-addition-row';
      row.append(el('strong', `${item.label || item.field_id} · ${item.node_id}.${item.input}`));
      for (const [label, value] of [['连线传入', item.value], ['本次内部修改', item.inner_value], ['进入前内部值', item.native_pre_overlay]]) {
        row.append(el('span', label), el('pre', JSON.stringify(value)));
      }
      const select = el('select'); select.setAttribute('aria-label', `${item.label || item.field_id} 的保存方式`);
      for (const [value, label] of [['', '请选择保存方式'], ['inner', '保存本次内部修改，连线仍优先'], ['native', '保留进入前的内部值']]) {
        const option = el('option', label); option.value = value; select.append(option);
      }
      select.onchange = () => { if (select.value) choices.set(item.field_id, select.value); else choices.delete(item.field_id); confirm.disabled = choices.size !== conflicts.length; };
      row.append(select); list.append(row);
    }
    dialog.append(list); const actions = el('div'); actions.className = 'modal-actions';
    actions.append(button('取消，继续编辑', () => finish(null)), confirm); dialog.append(actions);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    document.body.append(dialog); dialog.showModal(); close.focus?.();
  });
}

export function createNativeWorkflowEditor(host) {
  let active = null, opening = false;
  const element = (tag, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
  async function open(node, backendReady = false, preparation = false, presetPrompt = null, onPresetSaved = null) {
    if (active || opening) throw new Error('请先关闭当前内部工作流');
    const targetHost = editorTargetHost(host, node), lifecycle = editorLifecycle(targetHost, node);
    opening = true;
    try {
      await openEditor(node, backendReady, preparation, presetPrompt, onPresetSaved, targetHost, lifecycle);
      if (!active) await lifecycle.finish('cancelled');
    } catch (error) {
      if (active?.lifecycle === lifecycle) await active.close('failed');
      await lifecycle.finish('failed');
      throw error;
    } finally { opening = false; }
  }
  async function openEditor(node, backendReady, preparation, presetPrompt, onPresetSaved, host, lifecycle) {
    const targetLabel = host.targetLabel?.(node) || '画布';
    let workflow = await host.api(`/api/editor-workflows/${node.data.editor_id}`);
    const selectedBackend = backendReady || (host.ensureBackend ? await host.ensureBackend(node, workflow) : null);
    if (host.ensureBackend && !selectedBackend) return;
    await host.ensureInstance(node);
    const id = node.data.editor_id;
    if (id !== workflow.id) workflow = await host.api(`/api/editor-workflows/${id}`);
    const preparationContext = await host.prepareSession?.(node, workflow);
    let state = null;
    const assertCurrent = () => {
      if (state?.closed) throw new Error('内部编辑会话已关闭，请重新进入核对');
      return preparationContext?.assertCurrent?.();
    };
    await assertCurrent();
    const session = await host.api(`/api/editor-workflows/${id}/session`, {});
    try { await assertCurrent(); } catch (error) {
      await host.api('/api/editor-sessions/close', {session_id: session.session_id}); throw error;
    }
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
    let startup;
    state = { ready: false, busy: false, missing: [], pending: new Map(), session, frame, dialog,
      presetBound: !presetPrompt, hiddenSyncBlocked: [], nestedSyncBlocked: [], additionReview: null,
      projection: null, persistenceUnknown: false, bindingFailed: false, mediaCapture: false, mediaNestedCapture: false,
      mappingCapture: false, fitView: false, mediaSyncBlocked: [], mediaPending: [], lifecycle, close,
      closed: false, draftSaved: false, persisting: false, initializationBlocked: Boolean(host.needsInitialization?.(node)) };
    // Own values synchronized on entry become the merge base for this session
    // only. Draft saves, cancellation and connected display overlays must never
    // advance the persisted canvas baseline.
    state.syncBaseline = [];
    active = state;
    const releaseOnLeave = () => { void close('cancelled', true); };
    window.addEventListener('pagehide', releaseOnLeave, { once: true });
    function request(action, extra = {}) {
      if (state.closed) return Promise.reject(new Error('内部编辑会话已关闭，请重新进入核对'));
      if (action === 'captureMedia' && !state.mediaCapture) return Promise.reject(new Error('当前编辑会话未提供受控素材同步，请检查客户端版本与模块加载后重新进入'));
      if (action === 'captureMappings' && !state.mappingCapture) return Promise.reject(new Error('当前编辑会话未提供实例控件映射证明，请重新进入更新后的编辑器'));
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timeout = setTimeout(() => { state.pending.delete(requestId); reject(new Error('内部编辑器未响应；原始工作流仍保存在本地')); }, 45000);
        state.pending.set(requestId, { resolve, reject, timeout });
        frame.contentWindow.postMessage({ source: 'prism-parent', nonce: session.bridgeNonce, requestId, action, ...extra }, session.origin);
      });
    }
    function show(message) { if (!state.closed) status.textContent = message; }
    function refresh() {
      if (state.closed) return;
      const presetUnbound = Boolean(presetPrompt) && !state.presetBound;
      const projectionState = state.projection?.getState();
      const storageBlocked = Boolean(state.persistenceUnknown || state.bindingFailed || projectionState && (!projectionState.initialized || projectionState.locked));
      draft.disabled = apply.disabled = !state.ready || state.busy || !!state.missing.length || presetUnbound || storageBlocked;
      if (state.initializationBlocked || state.hiddenSyncBlocked.length || state.nestedSyncBlocked.length || state.mediaSyncBlocked.length) apply.disabled = true;
      original.disabled = state.busy || presetUnbound || storageBlocked;
      back.disabled = state.busy;
      reviewAdditions.disabled = state.busy || state.persistenceUnknown || state.bindingFailed || !state.additionReview || state.presetBound;
      switchEngine.disabled = state.busy || state.persistenceUnknown || state.bindingFailed;
      fitView.disabled = !state.ready || state.busy || !state.fitView;
    }
    async function action(callback) {
      if (state.busy || state.closed) return;
      state.busy = true; refresh();
      try { await callback(); } catch (error) {
        if (error.persisted === 'unknown') state.persistenceUnknown = true;
        if (error.requiresReopen) state.bindingFailed = true;
        show(`${editorErrorMessage(error)}${error.persisted === 'unknown' ? ' 保存结果尚未确认，已停止重复保存；请重新进入核对草稿版本。' : ''}`); discard.hidden = false;
      }
      finally { state.busy = false; refresh(); }
    }
    async function persistClean(store, snapshotOnly = false) {
      if (state.persistenceUnknown) throw new Error('上次保存结果尚未确认，请重新进入核对草稿版本。');
      if (state.bindingFailed) throw new Error(`内容已保存，但外层绑定未完成；请重新进入核对工作流与${targetLabel}。`);
      await assertCurrent();
      const guardedStore = async result => {
        await assertCurrent();
        state.persisting = true;
        try { return await store(result); }
        finally { state.persisting = false; }
      };
      if (!state.projection) {
        const result = await request(snapshotOnly ? 'snapshot' : 'compile');
        await assertCurrent();
        let value;
        try { value = await guardedStore(result); }
        catch (error) { if (![true, false, 'unknown'].includes(error.persisted)) error.persisted = 'unknown'; throw error; }
        return { persisted: value !== null && value !== false && value?.persisted !== false, value };
      }
      let result = await state.projection.prepare(guardedStore);
      if (result.status === 'resolution_required') {
        const choices = await (host.resolveConnectedConflicts || resolveConnectedEditorValues)(result.conflicts);
        if (!choices) return { persisted: false, status: 'cancelled' };
        result = await state.projection.prepare(guardedStore, { resolutions: choices, expectedConflicts: result.conflicts });
        if (result.status === 'resolution_required') throw new Error('内部输入在选择期间发生变化，请重新确认保存方式。');
      }
      return result;
    }
    async function saveDraft() {
      if (presetPrompt && !state.presetBound) throw new Error('预设尚未绑定到外层工作流，不能保存内部草稿。');
      const outcome = await persistClean(async result => {
        const saved = await host.api(`/api/editor-workflows/${id}/draft`, { document: result.workflow, base_revision: workflow.revision });
        workflow.revision = saved.revision; state.draftSaved = true; return saved;
      }, true);
      if (!outcome.persisted) { show('已取消保存；内部修改仍保留在当前编辑器。'); return false; }
      show('内部草稿已保存；外层继续使用上一次明确应用的参数。');
      return true;
    }
    async function close(reason = 'cancelled', leavingPage = false) {
      if (state.closed) return;
      state.closed = true;
      if (state.persisting) state.persistenceUnknown = true;
      clearTimeout(startup);
      window.removeEventListener('message', receive);
      window.removeEventListener('pagehide', releaseOnLeave);
      for (const item of state.pending.values()) { clearTimeout(item.timeout); item.reject(new Error('编辑器已关闭')); }
      state.pending.clear(); dialog.close(); dialog.remove();
      let sessionCleanup = 'confirmed';
      try {
        if (leavingPage) { host.releaseSession(session.session_id); sessionCleanup = 'requested'; }
        else await host.api('/api/editor-sessions/close', { session_id: session.session_id });
      } catch {
        sessionCleanup = 'unconfirmed';
        host.toast?.('编辑界面已关闭，后端会话清理尚未确认；已保存内容仍保留。', true);
      }
      try {
        await lifecycle.finish(state.persistenceUnknown || state.bindingFailed ? 'failed' : reason,
          { workflow: { id, revision: workflow.revision }, draftSaved: state.draftSaved,
            persistenceUnknown: state.persistenceUnknown, bindingFailed: state.bindingFailed, sessionCleanup });
      } finally {
        // Keep ownership until old cleanup completes. Otherwise its endSession
        // callback could remove the next session's guard for the same target.
        if (active === state) active = null;
      }
    }
    const back = element('button', `← 返回${targetLabel}`); back.className = 'button quiet';
    back.onclick = () => action(async () => {
      const saving = state.ready && !state.missing.length && (!presetPrompt || state.presetBound);
      if (saving && !await saveDraft()) return;
      await close(saving ? 'draft' : 'cancelled');
    });
    const draft = element('button', '保存内部草稿'); draft.className = 'button quiet'; draft.onclick = () => action(saveDraft);
    async function applyParameters() {
      if (state.initializationBlocked) throw new Error('首次控件映射尚未确认，请修复来源后重新进入；外层参数仍保留。');
      if (presetPrompt && !state.presetBound) throw new Error('预设尚未绑定到外层工作流，不能应用参数。');
      if (state.hiddenSyncBlocked.length) throw new Error('隐藏参数尚未安全同步，不能应用；请返回外层重新暴露该字段或修复控件映射。');
      if (state.nestedSyncBlocked.length) throw new Error('子图外层修改尚未安全同步，不能应用；请修复实例控件映射后重新进入。外层值仍保留。');
      if (state.mediaSyncBlocked.length) throw new Error('外层素材修改尚未安全同步，不能应用覆盖现有参数；请检查输入来源说明或加载新版编辑器后重新进入。');
      const outcome = await persistClean(async result => {
        const applied = await host.applyInterface(node, result, { session_id: session.session_id, base_revision: workflow.revision },
          { automatic: preparation, ...(state.syncBaseline.length ? { syncBaseline: structuredClone(state.syncBaseline) } : {}) });
        if (!applied) return null;
        if (Number.isSafeInteger(applied.workflow?.revision)) workflow.revision = applied.workflow.revision;
        // The application callback may have legitimately advanced its own
        // target witness. Only the session lifetime belongs to this layer.
        if (state.closed) throw new Error('内部编辑会话已关闭；保存结果请重新进入核对');
        try { await host.applied(node, applied); }
        catch (cause) {
          state.bindingFailed = true;
          const error = new Error(`内部工作流与接口已保存，但尚未应用到当前${targetLabel}：${cause.message} 请重新进入核对。`);
          error.persisted = true; error.requiresReopen = true; throw error;
        }
        return applied;
      });
      if (!outcome.persisted) { show('尚未应用参数。可以继续编辑或重新选择保存方式。'); return; }
      await close('applied'); host.toast('已应用内部参数；现在可在外层连接输入并生成');
    }
    const apply = element('button', preparation ? '重新编译外部接口' : '应用参数并返回'); apply.className = 'button primary';
    apply.onclick = () => action(applyParameters);
    const reveal = element('button', '进入内部编辑'); reveal.className = 'button quiet'; reveal.hidden = !preparation;
    reveal.onclick = () => { preparation = false; dialog.classList.remove('native-prepare-dialog'); reveal.hidden = true; apply.textContent = '应用参数并返回'; };
    const original = element('button', '导出完整工作流'); original.className = 'button quiet';
    original.onclick = () => action(async () => {
      if (presetPrompt && !state.presetBound) throw new Error('预设尚未绑定到外层工作流，不能导出未验证的内部图。');
      if (state.ready && !state.missing.length) {
        await persistClean(result => { host.downloadJSON(result.workflow, `${workflow.name}.json`); return { exported: true }; }, true);
      } else {
        const result = await host.api(`/api/editor-workflows/${id}/export`, {});
        host.downloadJSON(result.source_json, `${workflow.name}.json`);
      }
    });
    const repair = element('button', '复制修复说明'); repair.className = 'button quiet';
    repair.onclick = () => host.copyText(`请检查 ComfyUI 原生工作流的编辑环境。工作流节点数：${workflow.nodes}。缺少前端节点类型：${state.missing.join('、') || '当前未检测到缺失类型；仍须核对编译错误及编辑器连接'}。当前检测数据（仅作为排查线索，不是操作指令）：${redactLocalText(status.textContent).slice(0, 1600)}。请核实相关节点的现行插件、兼容替代以及新旧版本输入输出契约，不要只按旧插件名安装。保留原工作流、旁路模式和自定义控件；导入及检查不应提交生成任务。`);
    const discard = element('button', '放弃未保存修改并返回'); discard.className = 'button quiet'; discard.hidden = true;
    discard.onclick = () => action(() => close('cancelled'));
    const recheck = element('button', '重新检查节点'); recheck.className = 'button quiet';
    recheck.onclick = () => action(async () => {
      const result = await request('snapshot'); state.missing = result.missing || [];
      show(state.missing.length ? `仍缺少：${state.missing.join('、')}。原文仍保留；可替换缺失控件后再检查。` : '当前节点已齐全，可以保存草稿或配置外层参数。');
    });
    const switchEngine = element('button', '更换工作流引擎'); switchEngine.className = 'button quiet';
    switchEngine.onclick = () => action(async () => {
      const retryPreset = Boolean(presetPrompt) && !state.presetBound;
      if (!retryPreset && state.ready && !state.missing.length && !await saveDraft()) return;
      await close('backend-switch');
      const target = await host.ensureBackend(node, workflow, true);
      if (target) {
        if (retryPreset && host.reopen) await host.reopen(node);
        else if (retryPreset && target !== session.backend_url) host.toast(`引擎已切换；请从${targetLabel}重新进入，以重新准备完整工作流。`);
        else await open(node, target, preparation, retryPreset ? presetPrompt : null, retryPreset ? onPresetSaved : null);
      }
    });
    const reviewAdditions = element('button', '复核新增参数'); reviewAdditions.className = 'button primary'; reviewAdditions.hidden = true;
    reviewAdditions.onclick = () => action(async () => {
      const review = state.additionReview;
      if (!review || state.presetBound) return;
      if (!await confirmEditorAdditions(review)) return;
      if (active !== state || state.additionReview !== review) throw new Error('转换候选已变化，请重新复核。');
      await initializeEditor(review);
    });
    const fitView = element('button', '适应当前工作流'); fitView.className = 'button quiet';
    fitView.title = '将当前层级的全部节点放入视野；不改变节点、参数或连线';
    fitView.onclick = () => action(async () => {
      const result = await request('fitView');
      host.toast(result.fitted ? '已适应当前工作流视图' : '当前层级没有可适应的节点，或前端尚未提供视图能力');
    });
    buttons.append(back, switchEngine, reveal, fitView, original, repair, recheck, draft, apply, reviewAdditions, discard); header.append(title, buttons, status);
    const note = element('div', preparation ? `正在用 ${session.backend_url} 首次自动编译外部接口；需要确认的变更会打开接口管理。此过程不提交生成。` : `内部编辑器 · ${session.backend_url} · 调参后点击“应用参数并返回”，选择哪些输入外露到${targetLabel}。生成统一在外层进行；参考素材可在外层上传。`); note.className = 'native-editor-note';
    const sources = element('details'); sources.className = 'native-editor-sources'; sources.hidden = true;
    const sourceReasons = { upstream_not_run: '上游尚未生成；进入编辑不会自动运行它', source_missing: '直接输入节点已不存在',
      source_unavailable: '没有可核对的完整执行源；保留内部原图，请在接口管理检查映射',
      import_pending: '素材仍在导入，请等待上传完成后重新进入', import_failed: '素材导入失败，请返回画布重试',
      media_missing: '尚未选择素材', local_only: '素材仅保存在本地；返回画布点击“同步参考素材到引擎”，再进入查看', owner_unknown: '尚未确认素材所属引擎；可返回画布同步参考素材',
      other_backend: '素材来自另一个引擎；返回画布同步参考素材后重新进入', invalid_media: '素材名称或归属无效',
      media_type_mismatch: '连线素材类型与输入不同', mapping_unavailable: '当前输入映射不足，保留原内部值',
      ambiguous_connection: '有多条输入指向同一字段，需要明确选择', invalid_value: '输入值不符合当前字段要求',
      enum_unavailable: '当前没有可用选项或原值不在列表中；原值保留，生成前需补齐资源或重新选择',
      media_display_not_supported: '素材连线仍用于外层生成；本次内部编辑保留原素材值',
      media_capture_unavailable: '当前编辑会话未提供素材同步能力，保留原内部值；请检查客户端版本与模块加载后重新进入',
      own_media_unproven: '外层素材缺少同引擎上传证明，保留外层值和内部原素材；请回画布确认素材',
      media_preview_unproven: '无法隔离此节点的原生预览，暂不改写素材文件名',
      native_preview_not_isolated: '无法确认此节点的原生预览已隔离，暂不改写素材文件名',
      media_contract_unsupported: '此节点的素材控件尚无可验证的内部同步能力；外层连接仍保留',
      media_mapping_unproven: '素材字段与实际控件不匹配，保留原内部值',
      media_owner_unproven: '素材所属引擎或文件类型无法确认，请在外层重新选择素材',
      media_owner_unverified: '素材所属引擎或文件类型无法确认，请在外层重新选择素材',
      media_capture_unverified: '素材同步回执未通过核对，未将连线文件写入内部',
      media_native_value_changed: '素材在同步检查期间改变，请重新进入核对',
      nested_display_not_supported: '此子图输入尚不能安全临时显示，保留原内部值',
      nested_media_not_supported: '当前前端无法持续核对子图视图与预览，请重新进入受支持的编辑器；外层素材连线仍保留',
      nested_preview_context_changed: '子图归属已变化，旧预览保持隐藏以免串图；请重新进入恢复原生预览并核对素材',
      nested_preview_exposure_unproven: '无法核对子图的预览提升设置，保留内部原素材；外层连接仍可用于生成',
      nested_preview_exposure_unsupported: '此子图把预览提升到了宿主，暂不能独立隔离预览；保留内部原素材',
      promoted_preview_not_isolated: '素材控件已提升到宿主，但尚不能核对宿主预览归属；保留内部原素材',
      instance_context_ambiguous: '当前子图被多个实例使用，无法确定素材属于哪一个实例；请提升为明确的实例输入',
      shared_definition_widget: '多个实例共享此内部参数，请在工作流中将它提升为实例输入后重新进入',
      mapping_capture_unavailable: '当前编辑器尚未提供实例映射证明，保留内部值；请重新进入更新后的编辑器',
      mapping_capture_unverified: '实例映射回执未通过核对，保留原内部值',
      mapping_capture_byte_limit: '实例映射检查超过单次大小限制，保留原内部值',
      mapping_native_value_changed: '此实例参数在检查期间改变，请重新进入核对',
      mapping_receipt_changed: '实例控件已重建，保留原内部值；请重新进入以核对新映射',
      mapping_changed: '无法证明当前控件映射，未改写内部值', binding_changed: '当前节点或输入已改变，未改写内部值',
      scalar_value_unproven: '不能安全显示此输入值，保留原内部值', value_unproven: '当前内部值无法安全恢复，未施加覆盖' };
    function showSources(projected = { applied: [], unmapped: [] }) {
      const pending = [...(preparationContext?.pending || []), ...state.mediaPending, ...(projected.unmapped || [])];
      sources.replaceChildren?.();
      if (!pending.length && !projected.applied.length) return;
      sources.hidden = false;
      sources.append(element('summary', `输入来源：${projected.applied.length} 项临时显示 · ${pending.length} 项待处理`));
      const list = element('ul');
      for (const item of projected.applied) list.append(element('li', `${item.label || item.field_id}：${['image', 'video', 'audio'].includes(item.type) ? '连线素材文件名已同步，预览是否加载成功请查看内部素材面板；' : '来自画布连线；'}保存时保留原内部值，修改后可明确选择。`));
      for (const item of pending.slice(0, 32)) list.append(element('li', `${item.label || item.field_id || item.input || '输入'}：${sourceReasons[item.reason] || '当前版本尚无法确认此输入，请在外层接口管理核对。'}`));
      if (pending.length > 32) list.append(element('li', `另有 ${pending.length - 32} 项待处理；请在外层接口管理检查完整映射。`));
      sources.append(list);
    }
    header.append(sources);
    showSources();
    dialog.append(header, note, frame); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!state.busy) back.click(); });
    async function initializeEditor(review = null) {
        state.loading = true; state.busy = true; refresh(); clearTimeout(startup);
        try {
          const result = review ? state.loadedSummary : await request('load', { document: workflow.document });
          if (!result) throw new Error('编辑会话已变化，请关闭后重新进入。');
          state.loadedSummary = result;
          state.missing = Array.isArray(result.missing) ? result.missing : [];
          state.ready = true;
          show(state.missing.length ? `缺少 ${state.missing.length} 种前端节点：${state.missing.join('、')}。原文已保留；请切换到安装了这些扩展的后端，补齐后重新进入。` : `已载入 ${result.nodes} 个节点。内部草稿和外层已应用参数分别保存。`);
          if (!state.missing.length) {
            let presetSummary = '';
            if (presetPrompt) {
              show('正在使用 ComfyUI 已注册节点导入预设，并检查回编译结果…');
              await assertCurrent();
              const converted = await importEditorBaseline(request, presetPrompt, review ? { review_id: review.review_id, accepted_added_inputs: review.added_inputs } : {});
              await assertCurrent();
              state.additionReview = null; reviewAdditions.hidden = true;
              if (typeof onPresetSaved !== 'function') throw new Error('预设已转换，但尚未绑定到外层工作流；请关闭后从外层画布重新进入。');
              let saved;
              try {
                state.persisting = true;
                saved = await host.api(`/api/editor-workflows/${id}/draft`, {
                  document: converted.workflow, base_revision: workflow.revision,
                });
              } catch (error) {
                if (![true, false, 'unknown'].includes(error.persisted)) error.persisted = 'unknown';
                throw error;
              } finally { state.persisting = false; }
              workflow.revision = saved.revision; state.draftSaved = true;
              await assertCurrent();
              try { await onPresetSaved(converted); }
              catch (cause) {
                const error = new Error(`内部草稿已保存，外层绑定未完成：${cause.message} 请重新进入核对。`);
                error.persisted = true; error.requiresReopen = true; throw error;
              }
              state.presetBound = true;
              refresh();
              workflow.nodes = converted.nodes;
              state.missing = converted.missing || [];
              presetSummary = converted.accepted_added_inputs?.length ? `已按确认补充 ${converted.accepted_added_inputs.length} 项参数，转换为 ${converted.nodes} 个原生节点；原有内容已核对` : `预设已转换为 ${converted.nodes} 个原生节点，回编译与原 API 工作流一致`;
            }
            if (host.needsInitialization?.(node)) {
              const compiled = await request('compile'); await assertCurrent();
              if (typeof host.initializeTarget !== 'function') throw new Error('工作台尚未提供首次控件映射');
              await host.initializeTarget(node, compiled, { workflow: { id, revision: workflow.revision } });
              await assertCurrent(); state.initializationBlocked = false;
            }
            let patches = [], definitions = [];
            state.syncBaseline = [];
            const unmapped = [];
            state.mediaPending = []; state.mediaSyncBlocked = [];
            state.hiddenSyncBlocked = (node.data.editor_hidden_updates || []).map(item => item.field.id);
            const fields = host.fields(node);
            // Remain blocked through capture, conflict review, callbacks and
            // host rebase. An initialization error must not enable Apply on N
            // while the user's newer external F has never been synchronized.
            state.mediaSyncBlocked = fields.filter(field => {
              if (!['image', 'video', 'audio'].includes(field.type)) return false;
              const hidden = (node.data.editor_hidden_updates || []).find(item => item.field.id === field.id);
              return Boolean(hidden) || Object.hasOwn(node.data.editor_baseline || {}, field.id) &&
                JSON.stringify(node.data.packageValues?.[field.id]) !== JSON.stringify(node.data.editor_baseline[field.id]);
            }).map(field => field.id);
            const nestedFields = fields.filter(field => String(field.node_id).includes(':'));
            state.nestedSyncBlocked = nestedFields.filter(field => {
              const hidden = (node.data.editor_hidden_updates || []).find(item => item.field.id === field.id);
              return hidden || Object.hasOwn(node.data.editor_baseline || {}, field.id) &&
                JSON.stringify(node.data.packageValues?.[field.id]) !== JSON.stringify(node.data.editor_baseline[field.id]);
            }).map(field => field.id);
            // Saved controls may predate child-path support or a plugin may
            // have rebuilt its widgets. Resolve nested controls from this load.
            const nestedMapping = nestedFields.length ? await request('compile') : null;
            const indexControls = controls => {
              const index = new Map();
              for (const control of controls) {
                const key = JSON.stringify([control.node_id, control.input]), matches = index.get(key) || [];
                matches.push(control); index.set(key, matches);
              }
              return index;
            };
            const topControls = indexControls(node.data.editor_controls || []), nestedControls = indexControls(nestedMapping?.controls || []);
            const controlFor = field => (String(field.node_id).includes(':') ? nestedControls : topControls)
              .get(JSON.stringify([field.node_id, field.input])) || [];
            const targetOwners = new Map();
            for (const field of fields) {
              const controls = controlFor(field);
              if (controls.length !== 1) continue;
              const key = JSON.stringify([controls[0].widget_node_id, controls[0].widget_name]);
              targetOwners.set(key, (targetOwners.get(key) || 0) + 1);
            }
            const nestedReasons = { shared_definition_widget: '公共定义被多个实例使用，需先提升为实例参数',
              instance_not_found: '找不到指定子图实例', not_subgraph_instance: '路径中的节点不是子图实例',
              instance_traversal_limit: '子图含循环或超过检查预算', node_class_mismatch: '节点类型与编译结果不一致' };
            for (const field of fields) {
              const hidden = (node.data.editor_hidden_updates || []).find(item => item.field.id === field.id);
              if (!hidden && !Object.hasOwn(node.data.editor_baseline || {}, field.id)) continue;
              const value = hidden ? hidden.value : node.data.packageValues?.[field.id];
              const baseline = hidden ? hidden.baseline : node.data.editor_baseline[field.id];
              const nested = String(field.node_id).includes(':');
              const controls = controlFor(field), control = controls[0];
              const shared = control && targetOwners.get(JSON.stringify([control.widget_node_id, control.widget_name])) !== 1;
              if (controls.length !== 1 || shared) {
                if (hidden || JSON.stringify(value) !== JSON.stringify(baseline)) {
                  const reason = nestedMapping?.unmapped?.find(item => item.node_id === field.node_id && item.input === field.input)?.reason;
                  unmapped.push(`${field.label}${shared ? '（多个输入共享控件，保留原合并基线）' : nested ? `（${nestedReasons[reason] || '无法确认实例控件映射'}）` : ''}`);
                  if (['image', 'video', 'audio'].includes(field.type)) state.mediaPending.push({ field_id: field.id, label: field.label, reason: 'own_media_unproven' });
                }
                continue;
              }
              if (value === undefined || JSON.stringify(value) === JSON.stringify(baseline)) {
                if (hidden && value !== undefined) state.hiddenSyncBlocked = state.hiddenSyncBlocked.filter(id => id !== field.id);
                continue;
              }
              patches.push({ node_id: control.widget_node_id, widget_name: control.widget_name, value, expected_value: baseline,
                ...(nested ? { class_type: nestedMapping.output[field.node_id].class_type } : {}) }); definitions.push(field);
            }
            if (patches.length) {
              const mediaSync = await prepareOwnMediaSynchronization({ request, patches, definitions,
                provenance: preparationContext?.ownMedia || [], assertCurrent, mediaNestedCapture: state.mediaNestedCapture });
              patches = mediaSync.patches; definitions = mediaSync.definitions;
              state.mediaPending.push(...mediaSync.pending);
              for (const item of mediaSync.pending) unmapped.push(`${item.label || item.field_id}（素材同步待确认）`);
              showSources();
            }
            if (patches.length) {
              await assertCurrent();
              let patched;
              try { await request('patch', { patches }); }
              catch (error) {
                const unsupported = error.result?.unsupported || [];
                if (unsupported.length && unsupported.every(item => item.reason === 'conflict')) {
                  const conflicts = unsupported.map(item => ({ id: String(item.index), label: definitions[item.index].label, outer: patches[item.index].value, inner: item.current_value }));
                  const choices = await host.resolveConflicts(conflicts);
                  await assertCurrent();
                  if (!choices) throw new Error('外层与内部草稿有不同修改，尚未同步；请先解决冲突再应用。');
                  const updates = {};
                  for (const item of unsupported) {
                    if (!['inner', 'outer'].includes(choices[String(item.index)])) throw new Error('外层与内部冲突尚未明确选择，未建立同步基线。');
                    const patch = patches[item.index]; patch.expected_value = item.current_value;
                    if (choices[String(item.index)] === 'inner') { patch.value = item.current_value; updates[definitions[item.index].id] = item.current_value; }
                  }
                  await request('patch', { patches });
                  await assertCurrent(); host.syncOuterValues(node, updates);
                } else throw error;
              }
              await assertCurrent();
              patched = await request('compile'); await assertCurrent();
              const byBinding = new Map(), ownerCounts = new Map();
              for (const control of patched.controls || []) {
                const binding = JSON.stringify([control.node_id, control.input]);
                const target = JSON.stringify([control.widget_node_id, control.widget_name]);
                const matches = byBinding.get(binding) || []; matches.push(control); byBinding.set(binding, matches);
                ownerCounts.set(target, (ownerCounts.get(target) || 0) + 1);
              }
              for (const [index, field] of definitions.entries()) {
                const patch = patches[index], definition = patched.output?.[field.node_id];
                const controls = byBinding.get(JSON.stringify([field.node_id, field.input])) || [];
                if (controls.length !== 1 || controls[0].widget_node_id !== patch.node_id || controls[0].widget_name !== patch.widget_name ||
                    ownerCounts.get(JSON.stringify([patch.node_id, patch.widget_name])) !== 1 ||
                    typeof definition?.class_type !== 'string' || !Object.is(definition.inputs?.[field.input], patch.value) ||
                    patch.class_type && definition.class_type !== patch.class_type) {
                  if (['image', 'video', 'audio'].includes(field.type)) state.mediaPending.push({ field_id: field.id, label: field.label, reason: 'media_mapping_unproven' });
                  unmapped.push(`${field.label}（同步值与回编译映射未能一致核对，保留原合并基线）`); continue;
                }
                state.syncBaseline.push({ field_id: field.id, node_id: field.node_id, input: field.input, type: field.type,
                  class_type: definition.class_type, widget_node_id: patch.node_id, widget_name: patch.widget_name, value: patch.value });
              }
              // Only the final, successfully patched fields are synchronized.
              // The earlier media block list still describes preflight state.
              const synchronized = new Set(state.syncBaseline.map(field => field.field_id));
              state.hiddenSyncBlocked = state.hiddenSyncBlocked.filter(id => !synchronized.has(id));
              state.nestedSyncBlocked = state.nestedSyncBlocked.filter(id => !synchronized.has(id));
            }
            state.mediaSyncBlocked = state.mediaPending.map(item => item.field_id); showSources();
            if (state.hiddenSyncBlocked.length) {
              throw new Error('隐藏参数尚未安全同步，已阻止应用。请返回外层重新暴露该字段或修复控件映射；原接口和待同步值仍保留。');
            }
            if (state.nestedSyncBlocked.length) throw new Error(`子图外层修改尚未安全同步，已阻止应用：${unmapped.join('、')}。外层值和原接口仍保留；请修复或提升为实例参数后重新进入。`);
            await assertCurrent();
            let projectionSummary = '';
            if (preparationContext?.provenance?.some(item => item.origin === 'connected')) {
              state.projection = createEditorSessionProjection({ request, provenance: preparationContext.provenance, assertCurrent,
                mappingCapture: state.mappingCapture, mediaNestedCapture: state.mediaNestedCapture });
              let projected;
              try { projected = await state.projection.initialize(); }
              catch (error) {
                if (!state.projection.getState().locked) {
                  state.projection = null;
                  note.textContent += ' 连线值尚未临时显示，内部值未被覆盖；可以继续修复工作流。外层生成仍按连线取值。';
                }
                throw error;
              }
              showSources(projected);
              projectionSummary = ` 已临时显示 ${projected.applied.length} 项连线输入；保存时与内部备用值分别处理。${projected.unmapped.length ? `另有 ${projected.unmapped.length} 项暂无可证明的展示映射，保留原内部值。` : ''}`;
            }
            const pendingCount = preparationContext?.pending?.length || 0;
            if (projectionSummary || pendingCount) note.textContent += `${projectionSummary}${pendingCount ? ` ${pendingCount} 项输入待处理；进入编辑不会上传素材或运行上游。` : ''}`;
            show(`${presetSummary ? `${presetSummary}。` : `已载入 ${result.nodes} 个节点；`}${presetPrompt ? '现在可继续编辑，或点“应用参数并返回”同步外层参数。' : `已同步 ${patches.length} 项外层修改。${unmapped.length ? `以下特殊控件无法直接回写，外层覆盖值仍保留，应用时会核对：${unmapped.join('、')}` : '内部和外层使用同一组可映射参数。'}`}`);
            if (preparation) { show('正在首次自动编译外部接口…'); await applyParameters(); }
          } else if (preparation) {
            show(`无法建立外层参数：缺少 ${state.missing.length} 种节点（${state.missing.join('、')}）。可更换引擎、进入内部修复，或返回画布“复用已保存配置”。原文已保留。`);
          }
        } catch (error) {
          if (error.persisted === 'unknown') state.persistenceUnknown = true;
          if (error.requiresReopen) state.bindingFailed = true;
          const candidate = error.result?.review;
          state.additionReview = candidate && typeof candidate.review_id === 'string' && Array.isArray(candidate.added_inputs) && candidate.added_inputs.length > 0 && candidate.added_inputs.length <= 64 ? structuredClone(candidate) : null;
          reviewAdditions.hidden = !state.additionReview;
          show(state.hiddenSyncBlocked.length ? `隐藏参数尚未安全同步，已阻止应用。请返回外层重新暴露该字段或修复控件映射；原接口和待同步值仍保留。${editorErrorMessage(error)}` : editorErrorMessage(error));
          if (state.additionReview) show(`前端新增了 ${state.additionReview.added_inputs.length} 项已声明参数，尚未自动接受。请点击“复核新增参数”查看值并决定；原始内容仍保留。`);
          if (state.persistenceUnknown) show(`${editorErrorMessage(error)} 保存结果尚未确认，已停止重复保存；请重新进入核对草稿版本。`);
          discard.hidden = false;
        }
        state.busy = false; refresh();
    }
    async function receive(event) {
      if (active !== state || state.closed || event.source !== frame.contentWindow || event.origin !== session.origin || event.data?.source !== 'prism-editor' || event.data.nonce !== session.bridgeNonce) return;
      const message = event.data;
      if (message.action === 'notice') { note.textContent = `内部编辑器 · ${session.backend_url} · ${String(message.result?.message || message.message || '更换整个工作流请返回外层导入。')}`; return; }
      if (message.action === 'ready' && !state.loading) {
        state.mediaCapture = message.capabilities?.media_capture === 1;
        state.mappingCapture = message.capabilities?.mapping_capture === 1;
        state.mediaNestedCapture = state.mediaCapture && state.mappingCapture && message.capabilities?.media_nested_capture === 1;
        state.fitView = message.capabilities?.fit_view === 1;
        await initializeEditor(); return;
      }
      const pending = state.pending.get(message.requestId);
      if (!pending) return;
      state.pending.delete(message.requestId); clearTimeout(pending.timeout);
      if (message.error) { const error = new Error(message.error); error.result = message.result; pending.reject(error); } else pending.resolve(message.result);
    }
    window.addEventListener('message', receive);
    startup = setTimeout(() => show('原生编辑器加载超时。请检查所选 ComfyUI 服务是否启动、前端与扩展是否兼容；原始工作流已保留，可返回后更换后端再进入。'), 60000);
    refresh(); dialog.showModal(); frame.src = session.url;
  }
  async function openApiPrompt(node, prompt, onPresetSaved = null) {
    return open(node, false, false, normalizePresetPrompt(prompt), onPresetSaved);
  }
  return { open, openApiPrompt, prepare: node => open(node, false, true), applyToNode: host.applied, isOpen: () => !!active || opening };
}
