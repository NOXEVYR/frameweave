const mediaLabels = { image: '图片', audio: '音频', video: '视频' };
function element(tag, css, text) {
  const item = document.createElement(tag);
  item.className = css;
  if (text !== undefined) item.textContent = text;
  return item;
}
function selectField(parent, label) {
  const field = element('label', 'field'), select = element('select', '');
  field.append(element('span', '', label), select);
  parent.append(field);
  return select;
}

export async function openWorkflowModels(host, mode) {
  const engine = host.engine(), backend = engine.backend_url, canvas = host.canvasIdentity();
  if (!engine.online) throw new Error('请在引擎设置中连接 ComfyUI，再读取模型目录');
  const dialog = element('dialog', 'modal'), content = element('div', 'modal-body');
  dialog.setAttribute('aria-label', '工作流与模型');
  const heading = element('h2', '', '工作流与模型');
  const picker = selectField(content, '本机工作流包');
  const outputs = selectField(content, '生成输出');
  const controls = element('div', ''), status = element('p', 'form-note');
  status.setAttribute('role', 'status');
  const actions = element('div', 'modal-actions');
  const library = element('button', 'button quiet', '导入工作流'), cancel = element('button', 'button quiet', '取消');
  const apply = element('button', 'button primary', '添加到当前画布');
  actions.append(library, cancel, apply);
  content.append(controls, status, actions);
  dialog.append(heading, content);
  document.body.append(dialog);
  let revision = 0, inputs = [], saving = false;
  const current = () => dialog.open && host.engine().backend_url === backend &&
    host.canvasIdentity() === canvas && document.body.dataset.workspace === mode;
  const requireCurrent = () => { if (!current()) throw new Error('工作台、画布或引擎已变化，请重新选择'); };
  const failure = error => { status.textContent = error.message; apply.disabled = true; };
  const call = (data = {}) => host.api('/api/packages/' + encodeURIComponent(picker.value) + '/model-options', { backend_url: backend, ...data });
  const reset = () => { inputs = []; controls.replaceChildren(); apply.disabled = true; };
  async function loadSlots() {
    const request = ++revision;
    reset();
    if (!outputs.value) return;
    status.textContent = '正在读取所选输出使用的模型加载器…';
    try {
      const result = await call({ output_id: outputs.value });
      if (request !== revision) return;
      requireCurrent();
      for (const slot of result.slots) {
        const select = selectField(controls, slot.class_type + ' #' + slot.node + ' · ' + slot.input);
        select.add(new Option('请选择模型', ''));
        for (const value of slot.options) select.add(new Option(value, value));
        select.value = slot.options.includes(slot.current) ? slot.current : '';
        inputs.push([slot.id, select]);
      }
      const update = () => { apply.disabled = saving || inputs.some(([, select]) => !select.value); };
      controls.onchange = update;
      status.textContent = inputs.length ? '模型来自当前引擎。添加后可在画布检查器中继续调整。' : '此输出没有声明可切换的模型，可以在内部编辑器中检查节点。';
      update();
    } catch (error) { if (request === revision) failure(error); }
  }
  async function loadOutputs() {
    const request = ++revision;
    reset(); outputs.replaceChildren(); status.textContent = picker.value ? '正在读取工作流输出…' : '选择一个工作流，或导入自己的工作流。';
    if (!picker.value) return;
    try {
      const result = await call();
      if (request !== revision) return;
      requireCurrent();
      for (const output of result.outputs) outputs.add(new Option((mediaLabels[output.mediaType] || '输出') + ' · ' + output.label + ' #' + output.id, output.id));
      const desired = mode === 'video' ? 'video' : mode === 'audio' ? 'audio' : 'image';
      const match = result.outputs.find(item => item.mediaType === desired);
      if (match) outputs.value = match.id;
      if (outputs.value) await loadSlots(); else status.textContent = '当前引擎没有识别到这个工作流的输出节点。';
    } catch (error) { if (request === revision) failure(error); }
  }
  apply.onclick = async () => {
    if (saving || apply.disabled) return;
    saving = true;
    apply.disabled = picker.disabled = outputs.disabled = true;
    for (const [, select] of inputs) select.disabled = true;
    const output = outputs.value;
    try {
      requireCurrent();
      const result = await call({ output_id: output, choices: Object.fromEntries(inputs.map(([id, select]) => [id, select.value])) });
      requireCurrent();
      await host.placeWorkflow(result, output, requireCurrent);
      dialog.close();
    } catch (error) {
      saving = picker.disabled = outputs.disabled = false;
      failure(error);
      if (current()) await loadSlotsAfterFailure(error.message);
    }
  };
  async function loadSlotsAfterFailure(message) {
    await loadSlots();
    status.textContent = message + '。已重新检查模型目录。';
  }
  picker.onchange = loadOutputs; outputs.onchange = loadSlots;
  cancel.onclick = () => dialog.close();
  library.onclick = () => { dialog.close(); host.openPackages().catch(host.reportError); };
  dialog.addEventListener('close', () => { revision++; dialog.remove(); }, { once: true });
  dialog.showModal();
  apply.disabled = true;
  status.textContent = '正在读取工作流包…';
  try {
    const { packages } = await host.api('/api/packages?summary=1');
    requireCurrent();
    picker.add(new Option('选择工作流', ''));
    for (const pack of packages.filter(item => !item.archived)) picker.add(new Option(pack.name, pack.id));
    status.textContent = picker.options.length > 1 ? '选择工作流后可查看对应的加载器和模型。' : '包库为空。先导入工作流并配置外部接口。';
  } catch (error) { failure(error); }
}
