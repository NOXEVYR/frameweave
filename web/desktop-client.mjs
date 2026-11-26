// Commands originate from the local owner's tray, never from URL fragments.
export function desktopStatus(value) {
  if (!value || value.version !== 1 || typeof value.supported !== 'boolean' || typeof value.tray_ready !== 'boolean' ||
      !['background', 'idle_exit'].includes(value.close_action) || !['background', 'idle_exit'].includes(value.effective_close_action) ||
      value.idle_grace_seconds !== 180 || value.heartbeat_seconds !== 30 || value.command_timeout_seconds !== 60 ||
      typeof value.settings_available !== 'boolean' || typeof value.command_pending !== 'boolean' || typeof value.last_error !== 'string') return null;
  if (value.tray_ready && !value.supported || value.effective_close_action !==
      (value.supported && value.tray_ready && value.close_action === 'background' ? 'background' : 'idle_exit')) return null;
  return value;
}

export function createDesktopClient({ api, beforeExit, openSettings, freezeForExit = () => () => {},
  onStatus = () => {}, onExit = () => {}, toast = () => {}, reportError = () => {} }) {
  let sessionId = null, inFlight = null, stopped = false, legacy = false, awaitingExit = null;
  const handled = new Set();
  async function acknowledge(command, approved, reason) {
    return api('/api/desktop/complete', { session_id: sessionId, command_id: command.id, approved, reason });
  }
  async function commandReceived(command) {
    if (!command) return;
    if (typeof command.id !== 'string' || !/^[a-f0-9]{32}$/.test(command.id) || handled.has(command.id)) return;
    handled.add(command.id); if (handled.size > 32) handled.delete(handled.values().next().value);
    if (command.action === 'settings') {
      if (typeof openSettings !== 'function') { await acknowledge(command, false, 'unsupported'); return; }
      try { await openSettings(); await acknowledge(command, true, 'handled'); }
      catch (error) { await acknowledge(command, false, 'client-error'); reportError(error); }
      return;
    }
    if (command.action !== 'exit') { await acknowledge(command, false, 'unsupported'); return; }
    let restore = () => {}, approvalSent = false;
    try {
      // Check/flush IME and unsaved inputs before inert can blur a composing
      // control. Freeze synchronously before yielding to a successful guard.
      const prepared = beforeExit();
      restore = freezeForExit();
      await prepared;
      if (stopped) { restore(); await acknowledge(command, false, 'cancelled'); return; }
      approvalSent = true; awaitingExit = { id: command.id, restore };
      const response = await acknowledge(command, true, 'handled');
      if (stopped) return;
      if (response?.ok === true && response.exiting === true) { stopped = true; onExit(); return; }
      if (response?.ok === false && response.exiting === false) {
        awaitingExit = null; restore(); toast(response.error || '退出未完成，应用和后台任务仍保留', true);
      } else toast('退出正在等待其他页面或服务确认，编辑暂时冻结；取消或超时得到核实后恢复', true);
    } catch (error) {
      if (stopped && approvalSent) return;
      const reason = error?.code === 'draft-save-failed' ? 'draft-save-failed' : error?.code === 'busy' ? 'busy' : 'client-error';
      if (!approvalSent) {
        restore();
        try { await acknowledge(command, false, reason); } catch { /* Unconfirmed acknowledgements never authorize exit. */ }
      } else toast('退出结果尚未确认，编辑暂时冻结；请核对托盘或重新打开棱光，不会自动重试退出', true);
      reportError(error);
    }
  }
  async function perform() {
    if (stopped) return;
    if (legacy) { await api('/api/heartbeat'); return; }
    let result;
    try { result = await api('/api/desktop/heartbeat', { ...(sessionId ? { session_id: sessionId } : {}), settings_available: typeof openSettings === 'function' }); }
    catch (error) {
      if (error?.status === 404) { legacy = true; await api('/api/heartbeat'); return; }
      throw error;
    }
    if (stopped) return;
    const status = desktopStatus(result?.desktop);
    if (!status || typeof result?.session_id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.session_id)) {
      throw new Error('桌面状态暂不可核实；不会依据未知响应退出应用');
    }
    sessionId = result.session_id; onStatus(status);
    // A positive ACK can remain live while another registered page checks its
    // draft. A lost ACK reply also grants no authority to resume editing. Only
    // an owner-issued fresh heartbeat confirming the command is gone can
    // release this page; a committed shutdown rejects further heartbeats.
    if (awaitingExit && result.command === null && !status.command_pending) {
      const pendingExit = awaitingExit; awaitingExit = null; pendingExit.restore();
      toast('退出已取消或确认已超时，后台仍保留，可以继续编辑', true);
    }
    if (typeof result.notice === 'string' && result.notice) toast(result.notice);
    await commandReceived(result.command);
  }
  return {
    pulse() {
      if (stopped) return Promise.resolve();
      if (!inFlight) inFlight = perform().finally(() => { inFlight = null; });
      return inFlight;
    },
    stop() { stopped = true; },
    state: () => ({ stopped, legacy, registered: !!sessionId, awaitingExit: !!awaitingExit }),
  };
}
