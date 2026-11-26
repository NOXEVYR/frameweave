export function createUpdateCenter(host) {
  const status = document.querySelector('#update-status');
  let busy = false;
  let exitState = 'idle';
  const exitButtons = ['update-install', 'app-exit'].map(id => document.querySelector(`#${id}`));
  let currentVersion = '', stagedVersion = '', autoUpdate = false;
  async function refresh() {
    if (busy || exitState !== 'idle') return;
    busy = true;
    try {
      const data = await host.api('/api/updates');
      if (exitState !== 'idle') return;
      currentVersion = data.current_version; stagedVersion = data.staged?.version || ''; autoUpdate = data.auto_update;
      status.textContent = data.error || data.last_error || (data.busy ? '正在检查 / 下载并校验…' : data.staged?.verified ? `版本 ${data.staged.version} 已校验，可退出安装` : data.update_available ? `发现 ${data.latest_version} · ${Math.round((data.release?.bytes || 0) / 1024 / 1024 * 10) / 10} MiB` : data.last_checked ? `当前 ${data.current_version} · 无更高版本` : `当前 ${data.current_version} · 尚未检查`);
      document.querySelector('#update-check').disabled = data.busy;
      if (data.staged?.recovery_note) status.textContent += ` ${data.staged.recovery_note}`;
      document.querySelector('#update-download').disabled = data.busy || !data.update_available || Boolean(data.staged?.verified);
      document.querySelector('#update-install').disabled = data.busy || !data.staged?.verified || !data.install_supported;
    } catch (error) { if (exitState === 'idle') status.textContent = error.message; }
    finally { busy = false; }
  }
  for (const [id, action] of [['update-check', 'check'], ['update-download', 'stage'], ['update-install', 'install'], ['app-exit', 'exit']]) {
    document.querySelector(`#${id}`).addEventListener('click', async event => {
      if (exitState !== 'idle') return;
      const leaving = action === 'install' || action === 'exit';
      const previousDisabled = exitButtons.map(button => button.disabled);
      let restore = null, requestSent = false;
      if (leaving) exitState = 'preparing';
      event.currentTarget.disabled = true;
      try {
        if (leaving) {
          // A synchronous IME/task refusal must leave the editor untouched.
          const prepared = host.beforeExit();
          restore = host.freezeForExit?.() || (() => {});
          exitButtons.forEach(button => { button.disabled = true; });
          await prepared;
          exitState = 'pending';
        }
        requestSent = true;
        const result = await host.api(action === 'exit' ? '/api/exit' : `/api/updates/${action}`, {});
        if (leaving) {
          if (result?.ok !== true || result?.exiting !== true) throw new Error('退出结果尚未确认');
          exitState = 'confirmed';
          status.textContent = action === 'install' ? '正在退出并更新。新版本将自动打开，旧版本保留。' : '已接受退出请求，正在退出；已启用的更新将在后台完成。若窗口未关闭且仍无法编辑，请使用浏览器刷新页面重新核实服务状态。';
          if (action === 'install' || (autoUpdate && stagedVersion)) {
            const previousVersion = currentVersion;
            let attempts = 0;
            const reconnect = setInterval(async () => {
              if (++attempts > 120) { clearInterval(reconnect); status.textContent = '更新启动尚未确认。旧程序和数据已保留；若窗口未关闭且仍无法编辑，请使用浏览器刷新页面重新核实服务状态。'; return; }
              try { const next = await host.api('/api/bootstrap'); if (next.version !== previousVersion) { clearInterval(reconnect); location.reload(); } } catch { /* Expected while the owned service restarts. */ }
            }, 1500);
          } else window.close();
        } else await refresh();
      } catch (error) {
        if (leaving) {
          if (!requestSent || [400, 403, 409].includes(error?.status)) {
            restore?.(); exitState = 'idle';
            exitButtons.forEach((button, index) => { button.disabled = previousDisabled[index]; });
          } else {
            exitState = 'unknown';
            status.textContent = '退出结果尚未确认；不会自动重试。若窗口未关闭且仍无法编辑，请使用浏览器刷新页面重新核实服务状态。';
            exitButtons.forEach(button => { button.disabled = true; });
          }
        } else event.currentTarget.disabled = false;
        host.reportError(error);
      }
    });
  }
  setInterval(() => { if (document.querySelector('#settings-dialog').open && !document.hidden) refresh(); }, 2500);
  return { refresh };
}
