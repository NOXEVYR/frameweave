// Data-only setup: inspection and registration never start engines or submit jobs.
export function createVoiceEnvironmentCenter(host, root) {
  if (!root) return { refresh: async () => {} };
  const element = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const button = (label, action) => {
    const node = element('button', label, 'button quiet compact'); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  let busy = false, inspection = null, lastReport = null, inspectedValues = '';
  const fields = new Map();
  const list = element('div'), details = element('details'), report = element('div', '', 'voice-environment-report');
  report.setAttribute('aria-live', 'polite');
  details.append(element('summary', '接入已有 Qwen3-TTS 声音设计环境'));
  details.append(element('p', '只登记已有依赖与 VoiceDesign 权重，建立独立运行目录。完成后仍在棱光的声音页面生成和编辑工作流；不下载、不改主 ComfyUI。', 'field-help'));
  for (const [key, label, placeholder, defaultValue] of [
    ['name', '声音环境名称', '例如：本地声音设计', 'Qwen3-TTS 声音设计'],
    ['comfy_root', '已有 ComfyUI 目录', '包含 main.py 与 comfy 文件夹', ''],
    ['model_path', 'VoiceDesign 权重目录', '包含 config.json 与 speech_tokenizer', ''],
    ['host_python', 'ComfyUI Python（可选）', '留空识别便携版或 venv', ''],
    ['worker_python', '语音 Python（可选）', '留空复用上面的 Python', ''],
    ['dependency_dir', '语音依赖目录（可选）', '已有 qwen_tts 的 site-packages；留空使用语音 Python 自身依赖', ''],
    ['frontend_root', 'ComfyUI 前端目录（可选）', '留空识别已有 comfyui_frontend_package/static', ''],
    ['port', '独立声音引擎端口', '使用未占用的本机端口', '8191'],
  ]) {
    const row = element('label', '', 'field'), input = element('input');
    input.type = 'text'; input.value = defaultValue; input.placeholder = placeholder; input.dataset.voiceEnvironment = key;
    if (key === 'port') input.inputMode = 'numeric';
    row.append(element('span', label), input); fields.set(key, input); details.append(row);
  }
  const values = () => Object.fromEntries([...fields].map(([key, input]) => [key, key === 'port' ? Number(input.value) : input.value.trim()]));
  const run = async action => {
    if (busy) return;
    busy = true; update();
    try { await action(); } catch (error) { host.reportError(error); }
    finally { busy = false; update(); }
  };
  const render = result => {
    lastReport = result;
    report.replaceChildren(element('p', result.summary, 'form-note'));
    for (const item of result.checks || []) {
      const row = element('div', '', 'environment-card');
      const body = element('div', '', 'environment-card-body');
      body.append(element('strong', `${item.status === 'present' ? '✓' : '○'} ${item.label}`), element('span', item.detail, 'field-help'));
      row.append(body); report.append(row);
    }
    if (result.configuration_unchanged === false) report.prepend(element('p', '环境文件或适配器已变化。原设置已填回；请为新的独立副本选择另一个未登记端口，再检查并登记。原配置保留。', 'form-note'));
  };
  const inspect = button('检查已有环境', () => run(async () => {
    const input = values(), captured = JSON.stringify(input);
    const result = await host.api('/api/voice-environments/inspect', input);
    if (JSON.stringify(values()) !== captured) { inspection = null; return; }
    inspection = result; inspectedValues = captured; render(result);
  }));
  const register = button('登记到应用', () => run(async () => {
    if (!inspection?.ready_to_register || inspectedValues !== JSON.stringify(values())) throw new Error('配置已变化，请重新检查环境');
    const result = await host.api('/api/voice-environments/register', { ...values(), fingerprint: inspection.fingerprint });
    host.toast(result.message); await host.loadPackages?.(); await host.refreshEngines(); await refresh();
  }));
  const copy = button('复制环境修复说明', () => run(async () => {
    if (!lastReport?.repair_prompt) throw new Error('请先检查环境');
    await navigator.clipboard.writeText(lastReport.repair_prompt); host.toast('已复制脱敏检查说明');
  }));
  function update() {
    inspect.disabled = busy;
    register.disabled = busy || !inspection?.ready_to_register || inspectedValues !== JSON.stringify(values());
    copy.disabled = busy || !lastReport?.repair_prompt;
    for (const input of fields.values()) input.disabled = busy;
  }
  for (const input of fields.values()) input.addEventListener('input', () => { inspection = null; lastReport = null; report.replaceChildren(); update(); });
  const actions = element('div', '', 'modal-actions wrap-actions'); actions.append(inspect, register, copy);
  details.append(actions, report);
  root.append(element('h3', '声音运行环境'), element('p', '文件检查、引擎在线和真实出声是不同状态。声音设计目前使用独立 GPU 工作进程；主机显示 CPU 不代表语音不占显存。', 'field-help'), list, details);
  async function refresh() {
    let result;
    try { result = await host.api('/api/voice-environments'); }
    catch (error) { list.replaceChildren(element('p', `声音环境列表暂不可用：${error.message}`, 'form-note')); return; }
    list.replaceChildren();
    for (const item of result.environments || []) {
      const row = element('div', '', 'environment-card'), body = element('div', '', 'environment-card-body');
      body.append(element('strong', item.name), element('span', item.engine_registered === false ? '环境文件已准备，引擎登记未完成。重新检查后可重试登记；没有启动或生成。' : '已登记 · 复用已有文件 · 运行与生成状态以我的引擎和任务结果为准', 'field-help'));
      row.append(body, button('重新检查文件', () => run(async () => {
        const result = await host.api('/api/voice-environments/recheck', { id: item.id });
        for (const [key, input] of fields) input.value = result.settings?.[key] ?? (key === 'port' ? 8191 : key === 'name' ? item.name : '');
        inspection = result; inspectedValues = JSON.stringify(values()); details.open = true; render(result);
      })));
      list.append(row);
    }
    for (const issue of result.issues || []) list.append(element('p', issue, 'form-note'));
  }
  update(); return { refresh };
}
