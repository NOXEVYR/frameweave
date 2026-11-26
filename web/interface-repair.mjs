import { coerceFieldValue, packageValues } from './packages.mjs';

export function activeMissingFields(info) {
  const active = new Set(info.execution?.node_ids || []);
  return (info.missing_fields || []).filter(field => active.has(field.node_id));
}

/** Repairs are replayed against the original graph; existing inputs are never overwritten. */
export async function repairInterfaceInputs({ info, selection, inspect, chooseValues, chooseFields, ensureCurrent = () => {}, notify = () => {} }) {
  if (!(info.missing_fields || []).length) return { info, selection, missing_values: {} };
  let values = {}, changed = false, outputKey = null;
  const bindings = new Map();
  for (;;) {
    ensureCurrent();
    const nextKey = JSON.stringify([...selection.output_nodes].sort());
    if (nextKey !== outputKey) {
      info = await inspect({ output_nodes: selection.output_nodes, missing_values: {} });
      ensureCurrent();
      const active = new Set(info.execution?.node_ids || []);
      const kept = Object.entries(values).filter(([id]) => active.has(bindings.get(id)));
      if (kept.length !== Object.keys(values).length) notify('所选输出已变化：不再参与执行的分支补充值已撤回，该分支保留原始参数。');
      values = Object.fromEntries(kept); outputKey = nextKey;
      if (kept.length) info = await inspect({ output_nodes: selection.output_nodes, missing_values: values });
    } else info = await inspect({ output_nodes: selection.output_nodes, missing_values: values });
    ensureCurrent();
    const fields = activeMissingFields(info);
    if (!fields.length) {
      if (changed) {
        const repaired = new Set(Object.keys(values));
        const retained = new Map(selection.fields.map(field => [field.id, field]));
        for (const field of info.fields) if (repaired.has(field.id)) retained.set(field.id, field);
        selection = await chooseFields(info, { ...selection, fields: [...retained.values()] });
        ensureCurrent();
        if (!selection) return null;
        changed = false;
        continue;
      }
      return { info, selection, missing_values: values };
    }
    const chosen = await chooseValues(fields, info.missing_issues || []);
    ensureCurrent();
    if (chosen === null) return null;
    const entries = Object.entries(packageValues(chosen));
    if (!entries.length) throw new Error('请明确填写至少一项缺失参数，或取消并保留原工作流。');
    const candidates = new Map(fields.map(field => [field.id, field]));
    const next = { ...values };
    for (const [id, value] of entries) {
      if (!candidates.has(id) || Object.hasOwn(values, id)) throw new Error('缺失输入已改变，请重新检查。');
      next[id] = coerceFieldValue(candidates.get(id), value);
      bindings.set(id, candidates.get(id).node_id);
    }
    values = packageValues(next); changed = true;
  }
}

/** Bounded form: unset booleans and enums remain unset until explicitly chosen. */
export function chooseMissingInputValues(fields) {
  return new Promise(resolve => {
    const el = (tag, text = '', className = '') => { const item = document.createElement(tag); item.textContent = text; item.className = className; return item; };
    const dialog = el('dialog', '', 'modal packages-modal interface-repair-dialog');
    dialog.setAttribute('aria-label', '补齐工作流参数');
    const finish = result => { if (dialog.open) dialog.close(); dialog.remove(); resolve(result); };
    const button = (text, action, primary = false) => { const item = el('button', text, primary ? 'button primary' : 'button quiet'); item.type = 'button'; item.onclick = action; return item; };
    const heading = el('div', '', 'modal-heading');
    const close = button('×', () => finish(null)); close.className = 'close-button'; close.setAttribute('aria-label', '关闭');
    heading.append(el('h2', '补齐工作流参数'), close); dialog.append(heading);
    dialog.append(el('p', '当前引擎要求以下参数，但原工作流没有提供。请明确填写；更改只用于新的接口版本，原文件保留。动态选项可能展开下一组参数。', 'form-note'));
    const page = fields.slice(0, 64), controls = [];
    if (fields.length > page.length) dialog.append(el('p', `共 ${fields.length} 项，先处理前 ${page.length} 项；提交后继续显示剩余项。`, 'form-note'));
    for (const field of page) {
      const row = el('label', '', 'field'); row.append(el('span', field.label || field.input));
      const options = field.type === 'boolean' ? [true, false] : field.options;
      let control;
      if (Array.isArray(options)) {
        control = el('select'); const empty = el('option', '请选择'); empty.value = ''; control.append(empty);
        options.forEach((value, index) => { const option = el('option', typeof value === 'boolean' ? value ? '开启' : '关闭' : String(value)); option.value = String(index); control.append(option); });
      } else {
        control = el('input'); control.type = ['integer', 'number'].includes(field.type) ? 'number' : 'text';
        if (control.type === 'number') { control.step = field.type === 'integer' ? '1' : 'any'; if (field.min !== undefined) control.min = field.min; if (field.max !== undefined) control.max = field.max; }
      }
      control.setAttribute('aria-label', field.label || field.input);
      row.append(control, el('small', `节点 ${field.node_id} · ${field.input}`, 'field-help'));
      if (Object.hasOwn(field, 'default')) row.append(button(`填入节点声明默认值：${String(field.default).slice(0, 60)}`, () => { control.value = Array.isArray(options) ? String(options.findIndex(value => Object.is(value, field.default))) : String(field.default); }));
      controls.push({ field, control, options }); dialog.append(row);
    }
    const error = el('p', '', 'workflow-run-error'); error.setAttribute('role', 'alert'); dialog.append(error);
    const footer = el('div', '', 'modal-actions');
    footer.append(button('取消，保留原工作流', () => finish(null)), button('补齐并重新检查', () => {
      try {
        const values = {};
        for (const { field, control, options } of controls) if (control.value !== '') values[field.id] = coerceFieldValue(field, Array.isArray(options) ? options[Number(control.value)] : control.value);
        if (!Object.keys(values).length) throw new Error('请先填写至少一项参数；不会自动选择默认值。');
        finish(values);
      } catch (reason) { error.textContent = reason.message; }
    }, true)); dialog.append(footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    document.body.append(dialog); dialog.showModal(); close.focus();
  });
}
