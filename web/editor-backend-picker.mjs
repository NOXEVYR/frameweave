import { executionOrder, validateExecutionMediaBackends } from './graph.mjs';

/** Before planning, only explicit roots can choose an engine. */
export function workflowRootBackendTarget(graph, targets, currentBackend) {
  const nodes = targets.map(id => graph.nodes.find(node => node.id === id && node.type === 'generation'));
  if (!nodes.length || nodes.some(node => !node)) throw new Error('请选择有效的生成节点');
  const required = new Set(nodes.map(node => node.data.editor_backend).filter(Boolean));
  if (required.size > 1) throw new Error('所选生成节点绑定了多个推理引擎，请分别运行或应用到同一引擎。');
  return [...required][0] || currentBackend;
}

export function runBackend(graph, targets) {
  const required = new Set(executionOrder(graph, targets).map(id =>
    graph.nodes.find(node => node.id === id)?.data.editor_backend).filter(Boolean));
  if (required.size > 1) throw new Error('这条执行链绑定了多个推理引擎，请分别运行，或把工作流重新应用到同一引擎。');
  return [...required][0] || null;
}

export function workflowBackendTarget(graph, targets, currentBackend) {
  const target = runBackend(graph, targets) || currentBackend;
  validateExecutionMediaBackends(graph, targets, currentBackend, target);
  return target;
}

export async function chooseWorkflowBackend(report, preferred, force = false) {
  const candidates = report.candidates || [];
  const bound = candidates.find(item => item.base_url === preferred && item.online);
  if (bound && !force) return bound.base_url;
  const online = candidates.filter(item => item.online).sort((a, b) => b.score - a.score || Number(b.base_url === report.current) - Number(a.base_url === report.current));
  if (!force && !preferred && online.length === 1 && online[0].base_url === report.current) return online[0].base_url;
  return new Promise(resolve => {
    const dialog = document.createElement('dialog'); dialog.className = 'workflow-connect-dialog';
    const header = document.createElement('div'); header.className = 'dialog-header';
    const title = document.createElement('h2'); title.textContent = '为这套工作流选择引擎';
    const close = document.createElement('button'); close.className = 'button quiet'; close.textContent = '返回画布';
    const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
    close.onclick = () => finish(null); header.append(title, close); dialog.append(header);
    const body = document.createElement('div'); body.className = 'workflow-connect-body';
    const note = document.createElement('p'); note.className = 'model-note';
    note.textContent = '不同引擎的扩展不互通。按实时接口选择匹配的引擎，并记住在此画布节点上。切换不会安装插件；有未完成任务时会阻止切换。'; body.append(note);
    for (const item of [...online, ...candidates.filter(item => !item.online)]) {
      const row = document.createElement('div'); row.className = 'environment-card';
      const content = document.createElement('div'); content.className = 'environment-card-body';
      const heading = document.createElement('strong'); heading.textContent = `${item.name}${item === online[0] ? ' · 匹配度最高' : ''}`;
      const detail = document.createElement('p'); detail.className = 'model-note';
      detail.textContent = item.online ? `${item.base_url} · 已识别 ${item.counts.matched}/${item.counts.required} 种节点；${item.counts.unresolved} 种待核对。` : `${item.base_url} · 服务未连接，请在设置中启动。`;
      content.append(heading, detail);
      if (item.online && item.counts.unresolved) { const missing = document.createElement('p'); missing.className = 'model-note'; missing.textContent = `待核对：${[...item.missing_frontend, ...item.unknown_types].join('、')}`; content.append(missing); }
      const button = document.createElement('button'); button.className = 'button primary'; button.textContent = '使用此引擎'; button.disabled = !item.online;
      button.onclick = () => finish(item.base_url); row.append(content, button); body.append(row);
    }
    const footnote = document.createElement('p'); footnote.className = 'model-note'; footnote.textContent = '节点匹配不代表模型、素材及参数已就绪，进入后还会继续检查。'; body.append(footnote);
    dialog.append(body); dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); }); document.body.append(dialog); dialog.showModal();
  });
}
