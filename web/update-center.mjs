export function createUpdateCenter(host) {
  const status = document.querySelector('#update-status');
  let busy = false;
  let currentVersion = '', stagedVersion = '', autoUpdate = false;
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const data = await host.api('/api/updates');
      currentVersion = data.current_version; stagedVersion = data.staged?.version || ''; autoUpdate = data.auto_update;
      status.textContent = data.error || data.last_error || (data.busy ? '正在检查 / 下载并校验…' : data.staged?.verified ? `版本 ${data.staged.version} 已校验，可退出安装` : data.update_available ? `发现 ${data.latest_version} · ${Math.round((data.release?.bytes || 0) / 1024 / 1024 * 10) / 10} MiB` : data.last_checked ? `当前 ${data.current_version} · 无更高版本` : `当前 ${data.current_version} · 尚未检查`);
      document.querySelector('#update-check').disabled = data.busy;
      document.querySelector('#update-download').disabled = data.busy || !data.update_available || Boolean(data.staged?.verified);
      document.querySelector('#update-install').disabled = data.busy || !data.staged?.verified || !data.install_supported;
    } catch (error) { status.textContent = error.message; }
    finally { busy = false; }
  }
  for (const [id, action] of [['update-check', 'check'], ['update-download', 'stage'], ['update-install', 'install'], ['app-exit', 'exit']]) {
    document.querySelector(`#${id}`).addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      try {
        if (action === 'install' || action === 'exit') host.beforeExit();
        await host.api(action === 'exit' ? '/api/exit' : `/api/updates/${action}`, {});
        if (action === 'install' || action === 'exit') {
          status.textContent = action === 'install' ? '正在退出并更新。新版本将自动打开，旧版本保留。' : '棱光已退出；已启用的更新将在后台完成。';
          if (action === 'install' || (autoUpdate && stagedVersion)) {
            const previousVersion = currentVersion;
            let attempts = 0;
            const reconnect = setInterval(async () => {
              if (++attempts > 120) { clearInterval(reconnect); status.textContent = '更新启动尚未确认。旧程序和数据已保留，请重新打开棱光查看。'; return; }
              try { const next = await host.api('/api/bootstrap'); if (next.version !== previousVersion) { clearInterval(reconnect); location.reload(); } } catch { /* Expected while the owned service restarts. */ }
            }, 1500);
          } else window.close();
        } else await refresh();
      } catch (error) { host.reportError(error); event.currentTarget.disabled = false; }
    });
  }
  setInterval(() => { if (document.querySelector('#settings-dialog').open && !document.hidden) refresh(); }, 2500);
  return { refresh };
}
