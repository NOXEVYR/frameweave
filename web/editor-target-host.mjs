const required = ['ensureBackend', 'ensureInstance', 'prepareSession', 'endSession',
  'fields', 'syncOuterValues', 'applyInterface', 'applied', 'closed'];

/** A workspace must supply its own ownership checks; canvas guards never substitute. */
export function editorTargetHost(shared, target) {
  const adapter = shared.forTarget?.(target);
  if (!adapter) {
    if (target?.editorTargetType) throw new Error('独立工作区编辑目标已失效，请从原页面重新进入');
    return shared;
  }
  if (adapter.type !== target?.editorTargetType || typeof adapter.type !== 'string' || !adapter.type) throw new Error('内部编辑目标类型不匹配');
  for (const name of required) if (typeof adapter[name] !== 'function') throw new Error(`内部编辑目标缺少 ${name}，未使用画布操作代替`);
  return { ...shared, ...adapter, forTarget: undefined, reopen: adapter.reopen,
    needsInitialization: adapter.needsInitialization, initializeTarget: adapter.initializeTarget,
    targetLabel: adapter.targetLabel || (() => '工作台') };
}

/** Closing notifications are observational: they must not rewrite a saved outcome. */
export function editorLifecycle(host, target) {
  let finished = false;
  return {
    async finish(reason, detail = {}) {
      if (finished) return;
      finished = true;
      const failures = [];
      try { await host.endSession?.(target); } catch (error) { failures.push(error); }
      try { await host.closed?.(target, { ...detail, reason }); } catch (error) { failures.push(error); }
      if (failures.length) {
        try { host.toast?.(`内部编辑已结束，但返回页面的状态通知失败：${failures.map(error => error?.message || String(error)).join('；')}。已保存内容仍保留，请刷新核对。`, true); }
        catch { /* A notification failure cannot turn a confirmed save into a retry. */ }
      }
    },
  };
}
