import { projectOwnEditorInputs } from './editor-preparation.mjs';
import { studioEditorRecord, studioEditorData, initializeStudioEditorData, applyStudioEditorResult, studioEditorRecovery, clearStudioEditorRecovery } from './studio-editor-state.mjs';

const clone = value => structuredClone(value);
const sourceKeys = ['workflow_id', 'revision', 'backend_url', 'document_sha256', 'prompt_sha256'];

/** Own one workbench draft for the entire dialog lifetime, not just open(). */
export function createStudioWorkflowEditor(host) {
  let busy = false;
  const unboundCopies = new WeakMap();
  async function open(context) {
    if (busy) throw new Error('请先关闭当前工作台内部编辑器');
    busy = true;
    let witness, target, unregister, ended = false, revision, sourceKind, initialized, pack;
    const snapshot = () => {
      const current = context.read();
      return { ...current, signature: JSON.stringify(current.draft) };
    };
    const assertCurrent = () => {
      if (ended) throw new Error('工作台编辑会话已结束');
      const current = snapshot();
      if (current.mediaIssue) throw new Error(current.mediaIssue);
      if (current.active !== 'audio' || current.draft !== witness.draft || current.signature !== witness.signature ||
          ['category', 'epoch', 'editEpoch', 'navigationEpoch', 'backend'].some(key => current[key] !== witness[key])) {
        throw new Error('工作台、包、参数、素材或引擎已变化；未覆盖当前草稿，请重新进入');
      }
    };
    // A synchronous, atomic local commit is the only permitted witness advance.
    const commit = next => {
      assertCurrent(); const copies = unboundCopies.get(witness.draft);
      context.commit(next); witness = snapshot();
      if (copies) unboundCopies.set(witness.draft, copies);
    };
    const finish = async outcome => {
      if (ended) return;
      try {
        assertCurrent();
        if (target && outcome.workflow?.id === target.data.editor_id && Number.isSafeInteger(outcome.workflow.revision)) {
          revision = outcome.workflow.revision;
          const next = clone(witness.draft); next.editorBindings ||= {};
          next.editorBindings[target.data.package_id] = studioEditorRecord(target.data, revision, { initialized, sourceKind });
          if (outcome.persistenceUnknown || outcome.bindingFailed) {
            next.editorRecoveries ||= {};
            if (next.editorRecovery) next.editorRecoveries[next.editorRecovery.package_id] ||= next.editorRecovery;
            next.editorRecovery = { package_id: target.data.package_id, editor_id: target.data.editor_id, revision,
              reason: outcome.persistenceUnknown ? 'unknown' : 'binding_failed' };
            next.editorRecoveries[target.data.package_id] = next.editorRecovery;
          }
          commit(next);
        }
      } catch (error) {
        host.toast(`内部来源仍保存在本机；工作台返回记录未更新：${error.message}`, true);
      } finally {
        ended = true; unregister?.(); busy = false; await context.finished?.(outcome);
      }
    };
    try {
      witness = snapshot(); assertCurrent();
      if (!witness.draft.package_id) throw new Error('请先选择工作流包');
      pack = await host.loadPackage(witness.draft.package_id); assertCurrent();
      if (pack.id !== witness.draft.package_id || !Array.isArray(pack.fields) || !pack.prompt) throw new Error('未取得完整工作流包，请刷新包库');
      let record = witness.draft.editorBindings?.[pack.id], workflow, apiPrompt = null;
      const copyKey = JSON.stringify([pack.id, witness.backend]);
      const stageCopy = (created, prompt) => {
        let copies = unboundCopies.get(witness.draft);
        if (!copies) { copies = new Map(); unboundCopies.set(witness.draft, copies); }
        copies.set(copyKey, { record: clone(created), prompt: clone(prompt) });
      };
      const bindCopy = (created, prompt) => {
        const prior = witness.draft, next = clone(prior); next.editorBindings ||= {};
        if (!Object.hasOwn(next.editorBindings, pack.id) && Object.keys(next.editorBindings).length >= 200) throw new Error('工作台编辑绑定已达 200 项，请先导出整理；原记录保留');
        if (next.editorBindings[pack.id]) {
          next.editorHistory ||= [];
          if (next.editorHistory.length >= 200) throw new Error('编辑副本记录已达 200 项；原来源仍保留，请先导出整理后再新建副本');
          next.editorHistory.push(clone(next.editorBindings[pack.id]));
        }
        next.editorBindings[pack.id] = created; clearStudioEditorRecovery(next, pack.id);
        stageCopy(created, prompt);
        try { commit(next); }
        catch (cause) {
          throw new Error(`编辑副本 ${created.editor_id} 已保存在本机，但工作台记录未写入：${cause.message}。修复存储后在当前页面重试可复用该副本；刷新会失去本页暂存定位，服务端副本仍保留。`);
        }
        unboundCopies.get(prior)?.delete(copyKey);
      };
      const unbound = unboundCopies.get(witness.draft)?.get(copyKey);
      const resumeCopy = unbound?.record.package_id === pack.id && unbound.record.editor_backend === witness.backend;
      let recovery = Boolean(studioEditorRecovery(witness.draft, pack.id));
      if (resumeCopy) {
        workflow = await host.api(`/api/editor-workflows/${unbound.record.editor_id}`); assertCurrent();
        if (workflow.id !== unbound.record.editor_id || workflow.revision !== unbound.record.revision) throw new Error('暂存编辑副本已有其他修改，请按副本 ID 核对已保存版本');
        record = unbound.record; apiPrompt = unbound.prompt; bindCopy(record, apiPrompt);
        revision = record.revision; initialized = record.initialized; sourceKind = record.source_kind;
      } else if (record && record.editor_backend === witness.backend && !recovery) {
        try { workflow = await host.api(`/api/editor-workflows/${record.editor_id}`); }
        catch (error) { if (error.status !== 404) throw error; recovery = true; }
        assertCurrent();
        recovery ||= workflow.id !== record.editor_id || workflow.revision !== record.revision;
      } else if (record) recovery = true;
      if (!resumeCopy && (!record || recovery)) {
        const report = await host.api(`/api/packages/${pack.id}/editor-sources`); assertCurrent();
        const sources = (report.sources || []).filter(item => item.backend_url === witness.backend);
        const choice = !recovery && sources.length === 1 ? { kind: 'source', source: sources[0] }
          : await host.chooseSource({ pack, sources, recovery, unreadable: report.unreadable, previous: record });
        assertCurrent();
        if (!choice) { await finish({ reason: 'cancelled' }); return; }
        if (!record && Object.keys(witness.draft.editorBindings || {}).length >= 200) throw new Error('工作台编辑绑定已达 200 项，请先导出整理；原记录保留');
        if (record && (witness.draft.editorHistory || []).length >= 200) throw new Error('编辑副本记录已达 200 项；请先导出整理后再新建副本');
        sourceKind = choice.kind === 'source' ? choice.source.source_kind : 'api';
        if (choice.kind === 'source') {
          if (!sources.includes(choice.source)) throw new Error('所选来源已变化，请重新进入');
          const copied = await host.api(`/api/packages/${pack.id}/fork-editor-source`, Object.fromEntries(sourceKeys.map(key => [key, choice.source[key]])));
          workflow = copied.workflow;
        } else if (choice.kind === 'api') {
          workflow = await host.api('/api/editor-workflows', { name: pack.name, source_kind: 'api',
            document: { version: 0.4, nodes: [], links: [], last_node_id: 0, last_link_id: 0 } });
          apiPrompt = clone(pack.prompt);
        } else throw new Error('工作流来源选择无效');
        revision = workflow.revision; initialized = false;
        const data = studioEditorData(witness.draft, pack, witness.backend);
        data.editor_id = workflow.id;
        record = studioEditorRecord(data, revision, { initialized, sourceKind });
        // The server-created copy survives a category/backend switch while its
        // response is in flight; attaching it still requires the original guard.
        stageCopy(record, apiPrompt);
        try { assertCurrent(); }
        catch (error) { throw new Error(`${error.message}。已保存副本 ${record.editor_id} 留在本页暂存，返回原包和引擎可继续；刷新不会删除服务端副本。`); }
        bindCopy(record, apiPrompt);
      } else if (!resumeCopy) {
        revision = record.revision; initialized = record.initialized; sourceKind = record.source_kind;
        // A cancelled API import may still own an empty, recoverable instance.
        if (!initialized && sourceKind === 'api' && !workflow.document?.nodes?.length) apiPrompt = clone(pack.prompt);
      }
      target = { editorTargetType: 'workspace', data: studioEditorData(witness.draft, pack, witness.backend, record) };
      const fields = () => {
        assertCurrent(); const list = clone(pack.fields), ids = new Set(list.map(field => field.id));
        for (const item of target.data.editor_hidden_updates || []) if (!ids.has(item.field.id)) list.push(clone(item.field));
        return list;
      };
      const adapter = {
        type: 'workspace', targetLabel: () => witness.category === 'voice' ? '声音工作台' : '音乐工作台',
        async ensureBackend(_target, current, force = false) {
          if (force) {
            host.toast('已有草稿保留。请切换引擎后从工作台重新进入，以核对新引擎的节点与素材。');
            await host.openSettings?.(); return null;
          }
          assertCurrent();
          if (current.id !== target.data.editor_id || current.revision !== revision) throw new Error('内部草稿版本已变化，请重新进入核对');
          return witness.backend;
        },
        ensureInstance: assertCurrent, fields,
        async prepareSession() {
          assertCurrent();
          const definitions = fields(), own = projectOwnEditorInputs(target.data, pack.fields, { backend: witness.backend });
          const prepared = await host.api('/api/editor-prepare', { package_id: pack.id, backend_url: witness.backend, overrides: own.overrides, pending: own.pending });
          assertCurrent();
          if (prepared.backend_url !== witness.backend || prepared.source_revision !== pack.id) throw new Error('内部编辑准备返回了不同的引擎或来源');
          const ownMedia = (prepared.overrides || []).filter(item => item.origin === 'own' && definitions.some(field => field.id === item.field_id && ['image', 'video', 'audio'].includes(field.type))).map(item => {
            const field = definitions.find(field => field.id === item.field_id), node = prepared.prompt?.[item.node_id];
            if (field.node_id !== item.node_id || field.input !== item.input || !node?.class_type || !Object.is(node.inputs?.[item.input], item.value)) throw new Error('工作台素材缺少匹配的执行图证明');
            return { ...item, type: field.type, label: field.label || field.id, class_type: node.class_type };
          });
          return { assertCurrent, provenance: [], ownMedia, pending: prepared.pending || own.pending };
        },
        needsInitialization: () => !initialized,
        initializeTarget(_target, compiled, detail) {
          assertCurrent();
          const data = initializeStudioEditorData(target.data, pack, compiled);
          revision = detail.workflow.revision;
          // Write before changing in-memory initialization so storage failure is retry-safe.
          const next = clone(witness.draft); next.editorBindings ||= {};
          next.editorBindings[pack.id] = studioEditorRecord(data, revision, { initialized: true, sourceKind });
          commit(next); target.data = data; initialized = true;
        },
        syncOuterValues(_target, updates) {
          assertCurrent(); const data = clone(target.data), next = clone(witness.draft);
          for (const [id, value] of Object.entries(updates)) {
            const hidden = data.editor_hidden_updates?.find(item => item.field.id === id);
            if (hidden) hidden.value = value; else { data.packageValues[id] = value; next.values[id] = value; }
            delete data.packageMediaBackends?.[id]; delete next.mediaBackends?.[id]; delete next.mediaPreviewsByPackage?.[pack.id]?.[id];
          }
          next.valuesByPackage[pack.id] = clone(next.values); next.mediaBackendsByPackage[pack.id] = clone(next.mediaBackends);
          next.editorBindings[pack.id] = studioEditorRecord(data, revision, { initialized, sourceKind });
          commit(next); target.data = data;
        },
        applyInterface(_target, compiled, session, options) {
          assertCurrent(); return host.configure(target.data, { ...options, compiled, session, previousFields: pack.fields, connections: [], assertCurrent });
        },
        applied(_target, result) {
          assertCurrent();
          if (result.backend_url !== witness.backend || !Number.isSafeInteger(result.workflow?.revision)) throw new Error('应用结果的引擎或版本无效');
          const updated = applyStudioEditorResult(witness.draft, target.data, result, result.workflow.revision, sourceKind);
          commit(updated.draft); target.data = updated.data; pack = clone(result.package); revision = result.workflow.revision;
        },
        endSession() {}, closed: (_target, outcome) => finish(outcome),
      };
      unregister = host.registerTarget(target, adapter);
      if (apiPrompt) await host.editor.openApiPrompt(target, apiPrompt, () => assertCurrent());
      else await host.editor.open(target);
    } catch (error) {
      if (!ended) await finish({ reason: 'failed' });
      throw error;
    }
  }
  return { open, isOpen: () => busy };
}

export function chooseStudioEditorSource({ pack, sources, recovery, unreadable }) {
  return new Promise(resolve => {
    const el = (tag, text = '') => { const element = document.createElement(tag); element.textContent = text; return element; };
    const dialog = el('dialog'); dialog.className = 'modal packages-modal native-additions-dialog'; dialog.setAttribute('aria-label', '选择工作流编辑来源');
    const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
    const button = (text, result) => { const item = el('button', text); item.type = 'button'; item.className = 'button quiet'; item.onclick = () => finish(result); return item; };
    const heading = el('div'); heading.className = 'modal-heading';
    const close = button('×', null); close.className = 'close-button'; close.setAttribute('aria-label', '关闭'); heading.append(el('h2', '进入工作流'), close);
    dialog.append(heading, el('p', pack.name), el('p', recovery ? '上次编辑版本、保存结果或引擎需要核对。选择已应用来源建立新的独立副本；旧编辑记录和外部参数保留，不会重复提交生成。' : '选择这套包的编辑来源。外部填写的参数会同步到独立编辑副本。'));
    for (const source of sources) dialog.append(button(`${source.source_kind === 'native' ? '原生工作流' : source.source_kind === 'api' ? '执行图转换来源' : '已有编辑来源'} · ${source.workflow_id.slice(-8)} · 版本 ${source.revision}${source.draft_newer ? '（另有未应用草稿）' : ''}`, { kind: 'source', source }));
    if (unreadable) dialog.append(el('p', '部分来源记录无法读取，未自动采用。'));
    dialog.append(el('p', '执行图副本可调整节点、参数与外部接口；不会还原原文件的分组、注释、旁路分支和完整布局。'), button('从执行图建立编辑副本', { kind: 'api' }), button('取消', null));
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); }); document.body.append(dialog); dialog.showModal(); close.focus?.();
  });
}
