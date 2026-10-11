import { resultReferenceOutputs, resultReferenceTargets, resultReferenceOutputKey, captureResultReference, assertResultReferenceCurrent, transferResultReference } from './result-reference.mjs';
import { stableStringify } from './graph.mjs';

/** Named target and exact output selection; closing abandons application, not media ownership. */
export async function openResultReferenceDialog({ source, initialOutputId, api, current, apply, document = globalThis.document }) {
  const initial = current(), jobId = source.data.jobId;
  if (!initial.graph.nodes.includes(source)) throw new Error('结果节点已移除，请重新选择');
  const selectedOutput = initialOutputId ? source.data.outputs?.find(item => item.output_id === initialOutputId) : null;
  if (initialOutputId && !selectedOutput) throw new Error('所选产物已变化，请刷新后重新选择');
  const selectedIdentity = selectedOutput ? resultReferenceOutputKey(selectedOutput) : null;
  const response = await api('/api/jobs');
  const liveInitial = current();
  if (liveInitial.graph !== initial.graph || liveInitial.canvasId !== initial.canvasId || liveInitial.backend !== initial.backend
    || !liveInitial.graph.nodes.includes(source) || source.data.jobId !== jobId
    || selectedIdentity && !source.data.outputs?.some(item => resultReferenceOutputKey(item) === selectedIdentity)) {
    throw new Error('读取期间画布、任务或产物已变化，请重新选择');
  }
  const job = response?.jobs?.find(item => item.id === jobId);
  const outputs = resultReferenceOutputs(job);
  if (!outputs.length) throw new Error('此任务没有可核验的已完成媒体产物，请刷新生成队列');
  if (initialOutputId && !outputs.some(item => item.output_id === initialOutputId && resultReferenceOutputKey(item) === selectedIdentity)) {
    throw new Error('所选产物已变化或已移除，请刷新后重新选择');
  }
  const element = (tag, className = '', text = '') => {
    const item = document.createElement(tag); item.className = className; item.textContent = text; return item;
  };
  const dialog = element('dialog', 'modal packages-modal framed-modal'); dialog.setAttribute('aria-label', '传入工作流');
  let closed = false, busy = false, choices = [];
  const finish = () => { closed = true; if (dialog.open) dialog.close(); dialog.remove(); };
  const button = (text, action, className = 'button quiet') => {
    const item = element('button', className, text); item.type = 'button'; item.addEventListener('click', action); return item;
  };
  const heading = element('div', 'modal-heading');
  const close = button('×', finish, 'close-button'); close.setAttribute('aria-label', '关闭');
  heading.append(element('h2', '', '传入工作流'), close);
  const body = element('div', 'modal-scroll');
  body.append(element('p', 'form-note', '将已完成的产物存为独立参考素材，并连接到指定输入。后续可继续编辑，原任务不会重新生成。'));
  const field = (label, control) => { const row = element('label', 'field'); row.append(element('span', '', label), control); body.append(row); };
  const outputSelect = element('select'); outputSelect.setAttribute('aria-label', '选择产物');
  const typeLabel = { image: '图片', video: '视频', audio: '音频' };
  const branchCounts = new Map();
  for (const output of outputs) {
    const key = `${output.type}:${output.node_id || ''}`, index = (branchCounts.get(key) || 0) + 1; branchCounts.set(key, index);
    const option = element('option', '', `${typeLabel[output.type]} · 输出 ${output.node_id || '默认'} · 第 ${index} 项 · ${output.filename}`);
    option.value = output.output_id; outputSelect.append(option);
  }
  outputSelect.value = outputs.some(item => item.output_id === initialOutputId) ? initialOutputId : outputs[0].output_id;
  field('产物 / 输出分支 / 批次', outputSelect);
  const search = element('input'); search.type = 'search'; search.placeholder = '搜索工作流或输入名称'; search.setAttribute('aria-label', '搜索目标输入'); field('查找目标', search);
  const targetSelect = element('select'); targetSelect.setAttribute('aria-label', '目标工作流输入'); field('目标工作流 · 输入名称', targetSelect);
  const note = element('p', 'form-note'), error = element('p', 'workflow-run-error'); error.setAttribute('role', 'status'); body.append(note, error);
  const actions = element('div', 'modal-actions');
  const send = button('建立参考并连接', async () => {
    if (busy || closed) return;
    const choice = choices[Number(targetSelect.value)];
    if (targetSelect.value === '' || !choice) { error.textContent = '请先选择目标输入'; return; }
    busy = true; send.disabled = outputSelect.disabled = search.disabled = targetSelect.disabled = true;
    error.textContent = '正在传入素材…完成前不会修改画布。';
    const live = () => { if (closed) throw new Error('已关闭传入窗口，未修改画布'); return current(); };
    try {
      const context = live();
      if (!context.graph.nodes.includes(choice.node) || stableStringify(choice.node.data) !== choice.signature) {
        throw new Error('所选工作流或输入已变化，请重新选择目标输入');
      }
      const ticket = captureResultReference({ ...context, source, job, outputId: outputSelect.value, targetId: choice.node.id, fieldId: choice.field.id });
      const fragment = await transferResultReference(ticket, { api, current: live });
      assertResultReferenceCurrent(ticket, live()); apply(fragment, ticket); finish();
    } catch (cause) { if (!closed) error.textContent = cause.message; }
    finally { busy = false; if (!closed) { outputSelect.disabled = search.disabled = false; refreshTargets(); } }
  }, 'button primary');
  const refreshTargets = () => {
    if (busy) return;
    const previous = targetSelect.value === '' ? null : choices[Number(targetSelect.value)];
    const output = outputs.find(item => item.output_id === outputSelect.value);
    let context;
    try { context = current(); }
    catch (cause) {
      choices = []; targetSelect.replaceChildren(); targetSelect.disabled = send.disabled = true;
      error.textContent = cause.message; return;
    }
    const query = search.value.trim().toLowerCase();
    const all = resultReferenceTargets(context.graph, output.type, context.backend).filter(item => item.label.toLowerCase().includes(query));
    choices = all.slice(0, 64).map(item => ({ ...item, signature: stableStringify(item.node.data) })); targetSelect.replaceChildren();
    const placeholder = element('option', '', '请选择目标输入'); placeholder.value = ''; targetSelect.append(placeholder);
    for (const [index, choice] of choices.entries()) { const option = element('option', '', choice.label); option.value = String(index); targetSelect.append(option); }
    const retained = choices.findIndex(item => item.node === previous?.node && item.field.id === previous.field.id && item.signature === previous.signature);
    targetSelect.value = retained >= 0 ? String(retained) : '';
    targetSelect.disabled = !choices.length; send.disabled = !choices.length;
    note.textContent = all.length > 64 ? `找到 ${all.length} 个空闲输入，先显示 64 个；输入名称可缩小范围。`
      : all.length ? '列出当前引擎上类型匹配的空闲输入；已连线的输入需要先断开。' : '没有匹配的空闲输入。请先导入工作流、提取外层接口，或断开目标输入已有连线。';
  };
  outputSelect.addEventListener('change', refreshTargets); search.addEventListener('input', refreshTargets);
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
  actions.append(button('取消', finish), send); body.append(actions); dialog.append(heading, body);
  refreshTargets(); document.body.append(dialog); dialog.showModal(); outputSelect.focus();
  return { close: finish };
}
