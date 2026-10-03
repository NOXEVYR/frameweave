// One persistent workspace controls existing local engines; no model copies.
import { createVoiceEnvironmentCenter } from './voice-environment-center.mjs';
export function createEngineCenter(host) {
  const root = document.querySelector('#managed-engines');
  let pending = false;
  const voices = createVoiceEnvironmentCenter({ ...host, refreshEngines: refresh }, document.querySelector('#voice-environments'));
  const text = (tag, value, cls = '') => { const n = document.createElement(tag); n.textContent = value; n.className = cls; return n; };
  async function refresh() {
    if (pending) return;
    pending = true;
    try {
      const result = await host.api('/api/engines');
      root.replaceChildren();
      for (const item of result.profiles || []) {
        const row = text('div', '', 'environment-card');
        const body = text('div', '', 'environment-card-body');
        const current = item.base_url === host.settings().backend_url;
        body.append(text('strong', item.name), text('span', `${current ? '当前引擎 · ' : ''}${item.online ? '已就绪' : item.state === 'starting' ? '正在后台启动' : item.message || '尚未启动'}`, 'field-help'));
        const action = text('button', current && item.online ? '正在使用' : item.online ? '连接' : '后台启动', 'button quiet compact');
        action.type = 'button'; action.disabled = (current && item.online) || item.state === 'starting';
        action.addEventListener('click', async () => {
          action.disabled = true;
          try {
            if (item.online) await host.connect(item.base_url);
            else {
              const started = await host.api('/api/engines/start', { id: item.id });
              host.toast(started.online ? '引擎已就绪，可连接使用' : started.message || '已在后台启动；就绪后点击连接');
            }
          } catch (error) { host.reportError(error); }
          finally { await refresh(); }
        });
        row.append(body, action); root.append(row);
      }
      if (!result.profiles?.length) root.append(text('p', '尚未登记引擎。在下方接入已有 ComfyUI，一次配置后即可复用。', 'form-note'));
      await voices.refresh();
    } catch (error) { root.replaceChildren(text('p', error.message, 'form-note')); }
    finally { pending = false; }
  }
  document.querySelector('#register-engine').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      await host.api('/api/engines/register', { root: document.querySelector('#engine-install-root').value.trim(), port: Number(document.querySelector('#engine-port').value), name: '本地 ComfyUI' });
      await refresh(); host.toast('已登记到应用；模型和工作流仍使用原文件');
    } catch (error) { host.reportError(error); }
    finally { document.querySelector('#register-engine').disabled = false; }
  });
  document.querySelector('#engine-refresh').addEventListener('click', refresh);
  setInterval(() => { if (document.querySelector('#settings-dialog').open && !document.hidden) refresh(); }, 5000);
  return { refresh };
}
