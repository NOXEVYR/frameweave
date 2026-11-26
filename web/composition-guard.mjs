/** Observe IME lifecycle across this document without committing or cancelling it. */
export function createCompositionGuard(target = document) {
  if (!target?.addEventListener || !target?.removeEventListener) throw new Error('输入法守护缺少事件容器');
  const composing = new Set();
  let destroyed = false;
  const start = event => { if (!destroyed && event.target) composing.add(event.target); };
  const end = event => { if (!destroyed) composing.delete(event.target); };
  target.addEventListener('compositionstart', start, true);
  target.addEventListener('compositionend', end, true);
  return {
    active(element) { return element === undefined ? composing.size > 0 : composing.has(element); },
    assert(message = '请先完成当前输入法编辑，再继续操作') {
      if (composing.size) throw Object.assign(new Error(message), { code: 'busy' });
      return true;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      target.removeEventListener('compositionstart', start, true);
      target.removeEventListener('compositionend', end, true);
      composing.clear();
    },
  };
}
