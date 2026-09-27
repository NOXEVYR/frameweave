/** User-facing choices for exposing native ComfyUI controls on the outer canvas. */

export const EDITOR_INTERFACE_GROUPS = Object.freeze([
  '模型与编码器', '提示词', '媒体', '采样尺寸', '其他',
]);
export const EDITOR_INTERFACE_FIELD_LIMIT = 64;
const FIELD_DISCONNECT = null;

const idOf = value => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return idOf(value.id ?? value.fieldId ?? value.field_id ?? value.outputId ?? value.output_id);
  return String(value);
};
const fieldId = field => idOf(field?.id ?? field?.fieldId ?? field?.field_id ?? field);
const outputId = output => idOf(output?.id ?? output?.outputId ?? output?.output_id ?? output);
const plainObjectEntries = value => value instanceof Map ? [...value.entries()] :
  (value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : []);
const hasKey = (value, key) => value instanceof Map ? value.has(key) :
  !!value && typeof value === 'object' && Object.hasOwn(value, key);
const getKey = (value, key) => value instanceof Map ? value.get(key) : value?.[key];
const normalizedType = value => String(value ?? '').trim().toLowerCase();
const typeOf = field => Array.isArray(field?.type) ? field.type.map(normalizedType).filter(Boolean).join('|') : normalizedType(field?.type);
const mediaTokens = field => [field?.type, field?.mediaType, field?.input, field?.label]
  .flatMap(value => Array.isArray(value) ? value : [value]).map(normalizedType);

export function isRequiredEditorMediaField(field) {
  return mediaTokens(field).some(value => value === 'image' || value === 'audio');
}

export function editorFieldGroup(field) {
  if (EDITOR_INTERFACE_GROUPS.includes(field?.group)) return field.group;
  const type = typeOf(field);
  const text = [field?.input, field?.label, field?.type].flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => value !== undefined && value !== null).join(' ').toLowerCase();
  if (mediaTokens(field).some(value => ['image', 'audio', 'video', 'mask'].includes(value))) return '媒体';
  if (/model|checkpoint|ckpt|vae|lora|clip|encoder|unet|diffusion|safetensor|gguf/.test(`${type} ${text}`)) return '模型与编码器';
  if (/prompt|positive|negative|caption|text|文本|提示词|正向|反向/.test(text)) return '提示词';
  if (/width|height|size|seed|steps|cfg|sampler|scheduler|denoise|noise|batch|fps|seconds|frames|shift|尺寸|采样|种子|步数|强度/.test(text)) return '采样尺寸';
  return '其他';
}

export function editorFieldTypeCompatible(left, right) {
  const a = normalizedType(typeof left === 'object' && left !== null ? left.type : left);
  const b = normalizedType(typeof right === 'object' && right !== null ? right.type : right);
  return !!a && !!b && a === b;
}

function sameKnownType(left, right) {
  const a = typeOf(left), b = typeOf(right);
  return !a || !b || a === b;
}

function previousFieldId(item) {
  return typeof item === 'string' || typeof item === 'number' ? String(item) : fieldId(item);
}

export function initialEditorFieldIds(fields, previousFields = [], previousValues = {}, previousBaseline = {}) {
  const candidates = Array.isArray(fields) ? fields : [];
  const previous = Array.isArray(previousFields) ? previousFields : [];
  const previousById = new Map(previous.map(item => [previousFieldId(item), item]).filter(([id]) => id));
  const previousIds = new Set((previous.length
    ? previous.filter(item => item?.selected !== false).map(previousFieldId)
    : [
      ...plainObjectEntries(previousValues).map(([key]) => String(key)),
      ...plainObjectEntries(previousBaseline).map(([key]) => String(key)),
    ]).filter(Boolean));
  const hasPrevious = previous.length > 0 || plainObjectEntries(previousValues).length > 0 ||
    plainObjectEntries(previousBaseline).length > 0;
  const required = candidates.filter(isRequiredEditorMediaField);
  const wanted = hasPrevious
    ? candidates.filter(field => {
      const id = fieldId(field), old = previousById.get(id);
      return previousIds.has(id) && (!old || typeof old !== 'object' || sameKnownType(old, field));
    })
    : [
      ...candidates.filter(field => editorFieldGroup(field) === '模型与编码器'),
      ...candidates.filter(field => editorFieldGroup(field) === '提示词'),
      ...candidates.filter(field => editorFieldGroup(field) === '采样尺寸'),
      ...candidates.filter(field => field.recommended === true && editorFieldGroup(field) === '其他'),
    ];
  const ordered = [...required, ...wanted.filter(field => !required.includes(field))];
  const capped = required.length > EDITOR_INTERFACE_FIELD_LIMIT
    ? required : ordered.slice(0, EDITOR_INTERFACE_FIELD_LIMIT);
  return capped.map(fieldId).filter(Boolean);
}

export function initialEditorOutputIds(outputs, selectedOutputs = []) {
  const candidates = Array.isArray(outputs) ? outputs : [];
  const selected = Array.isArray(selectedOutputs) ? selectedOutputs : [];
  if (!selected.length) return candidates.map(outputId).filter(Boolean);
  const priorIds = new Set(selected.map(outputId).filter(Boolean));
  return candidates.map(outputId).filter(id => id && priorIds.has(id));
}

function fieldDisplay(field, fallbackId = '') {
  return {
    id: fieldId(field) || fallbackId,
    label: String(field?.label ?? field?.input ?? fallbackId ?? '旧参数'),
    type: field?.type,
    node_id: field?.node_id,
    input: field?.input,
  };
}

function connectionCounts(connections, direction, property) {
  const counts = new Map();
  for (const item of Array.isArray(connections) ? connections : []) {
    if (item?.direction !== direction) continue;
    const id = idOf(item?.[property]);
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function candidateFieldsFor(oldField, candidates, oldId) {
  const oldType = typeOf(oldField);
  if (!oldType) return [];
  return candidates.filter(candidate => fieldId(candidate) !== oldId && typeOf(candidate) === oldType);
}

export function deriveEditorRebindings({
  fields = [], previousFields = [], selectedFieldIds = [], outputs = [], selectedOutputIds = [],
  selectedOutputs = [], connections = [],
} = {}) {
  const fieldList = Array.isArray(fields) ? fields : [];
  const outputList = Array.isArray(outputs) ? outputs : [];
  const selectedFields = new Set((selectedFieldIds || []).map(idOf).filter(Boolean));
  const selectedOutputSet = new Set((selectedOutputIds || []).map(idOf).filter(Boolean));
  const previousById = new Map((Array.isArray(previousFields) ? previousFields : [])
    .filter(item => item?.selected !== false).map(item => [previousFieldId(item), item]).filter(([id]) => id));
  const selectedOutputById = new Map((Array.isArray(selectedOutputs) ? selectedOutputs : [])
    .map(item => [outputId(item), item]).filter(([id]) => id));
  const inputCounts = connectionCounts(connections, 'input', 'fieldId');
  const outputCounts = connectionCounts(connections, 'output', 'outputId');
  const inputConnections = new Map();
  const outputConnections = new Map();
  for (const connection of Array.isArray(connections) ? connections : []) {
    if (connection?.direction === 'input') {
      const id = idOf(connection.fieldId);
      if (id && !inputConnections.has(id)) inputConnections.set(id, connection);
    } else if (connection?.direction === 'output') {
      const id = idOf(connection.outputId ?? connection.output_id ?? connection.id);
      if (id && !outputConnections.has(id)) outputConnections.set(id, connection);
    }
  }

  const inputIds = new Set([...previousById.keys(), ...inputCounts.keys()]);
  const inputRebindings = [];
  for (const id of inputIds) {
    const current = fieldList.find(item => fieldId(item) === id);
    const prior = previousById.get(id);
    const connection = inputConnections.get(id);
    const old = prior && typeof prior === 'object' ? prior : connection || current || { id };
    const oldType = typeOf(old) || typeOf(connection) || typeOf(current);
    const typeChanged = !!current && !!oldType && !!typeOf(current) && oldType !== typeOf(current);
    const connected = inputCounts.get(id) || 0;
    if (current && selectedFields.has(id) && !typeChanged) continue;
    const removedOrChanged = !current || typeChanged;
    if (!removedOrChanged && !connected) continue;
    const descriptor = fieldDisplay(old, id);
    descriptor.type = old.type ?? connection?.type ?? current?.type;
    descriptor.connected = connected;
    descriptor.reason = !current ? 'removed' : typeChanged ? 'type_changed' : 'not_exposed';
    descriptor.candidates = candidateFieldsFor(descriptor, fieldList, id);
    inputRebindings.push(descriptor);
  }

  const outputIds = new Set(outputCounts.keys());
  const outputRebindings = [];
  for (const id of outputIds) {
    const current = outputList.find(item => outputId(item) === id);
    const prior = selectedOutputById.get(id);
    const connection = outputConnections.get(id);
    const oldMediaType = normalizedType(prior?.mediaType) || normalizedType(connection?.mediaType) || normalizedType(prior?.type);
    const currentMediaType = normalizedType(current?.mediaType ?? current?.type);
    const typeChanged = !!current && !!oldMediaType && !!currentMediaType && oldMediaType !== currentMediaType;
    if (selectedOutputSet.has(id) && current && !typeChanged) continue;
    const old = prior && typeof prior === 'object' ? prior : connection || current || { id };
    const mediaType = oldMediaType || normalizedType(old.mediaType ?? old.type ?? currentMediaType);
    const descriptor = {
      id,
      label: String(old.label ?? connection?.label ?? current?.label ?? id),
      mediaType,
      connected: outputCounts.get(id) || 0,
      reason: typeChanged ? 'type_changed' : !current ? 'removed' : 'not_selected',
      candidates: outputList.filter(candidate => {
        const candidateId = outputId(candidate);
        if (!candidateId || candidateId === id) return false;
        const candidateType = normalizedType(candidate.mediaType);
        return !mediaType || !candidateType || candidateType === mediaType;
      }),
    };
    outputRebindings.push(descriptor);
  }
  return { inputRebindings, outputRebindings };
}

export function shortValuePreview(value, limit = 72) {
  let text;
  if (value === undefined) text = '（无值）';
  else if (typeof value === 'string') text = value.replace(/\s+/g, ' ').trim() || '（空文本）';
  else {
    try { text = JSON.stringify(value); } catch { text = String(value); }
    if (text === undefined) text = String(value);
  }
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

function sameJsonValue(left, right) {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return Object.is(left, right); }
}

function element(tag, text = '', className = '') {
  const item = document.createElement(tag);
  if (text !== undefined && text !== null) item.textContent = String(text);
  if (className) item.className = className;
  return item;
}

const PANEL_STYLE = `
  .editor-interface-dialog{padding:0;border:1px solid #d1d8e5;border-radius:15px;color:#253b60;background:#fdfdfb;
    width:min(980px,calc(100vw - 28px));max-width:none;max-height:calc(100dvh - 28px);overflow:hidden;box-shadow:0 24px 90px #25345042}
  .editor-interface-dialog::backdrop{background:#26334d88;backdrop-filter:blur(3px)}
  .editor-interface-layout{display:grid;grid-template-rows:auto minmax(0,1fr) auto;max-height:calc(100dvh - 28px);min-height:min(560px,calc(100dvh - 28px))}
  .editor-interface-header,.editor-interface-footer{position:sticky;z-index:2;background:#fdfdfb;padding:15px 20px;display:flex;align-items:center;gap:12px}
  .editor-interface-header{top:0;border-bottom:1px solid #e0e5ed}.editor-interface-header-copy{min-width:0;flex:1}
  .editor-interface-header h2{margin:0;font-size:19px}.editor-interface-header p{margin:5px 0 0;color:#65748a;font-size:12px;line-height:1.55}
  .editor-interface-close{flex:0 0 auto}.editor-interface-body{overflow:auto;overscroll-behavior:contain;padding:16px 20px}
  .editor-interface-footer{bottom:0;justify-content:space-between;border-top:1px solid #e0e5ed}
  .editor-interface-footer .editor-interface-actions{display:flex;justify-content:flex-end;gap:8px;margin-left:auto}
  .editor-interface-status{margin:0;color:#66758d;font-size:12px;line-height:1.5}.editor-interface-status[data-error="true"]{color:#a34533}
  .editor-interface-toolbar{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:11px;align-items:center;margin-bottom:12px}
  .editor-interface-search{width:100%;min-height:36px;padding:8px 10px;border:1px solid #d2dceb;border-radius:8px;background:#fff;color:#263b5e}
  .editor-interface-tabs{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
  .editor-interface-tab{border:1px solid #d8dfeb;border-radius:99px;padding:6px 9px;background:#fff;color:#566987;font-size:11px;cursor:pointer}
  .editor-interface-tab[aria-pressed="true"]{background:#e9eefc;border-color:#aebfe9;color:#354e9d}
  .editor-interface-count{margin:5px 0 10px;color:#60708a;font-size:12px}
  .editor-interface-group{border:1px solid #e0e5ed;border-radius:10px;background:#fff;margin:10px 0;overflow:hidden}
  .editor-interface-group h3,.editor-interface-section h3{font-size:13px;margin:0;padding:10px 12px;color:#344968;background:#f4f6fa}
  .editor-interface-field{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(145px,230px);align-items:center;gap:10px;padding:9px 12px;border-top:1px solid #eef1f5}
  .editor-interface-field:first-of-type{border-top:0}.editor-interface-field input[type="checkbox"]{width:16px;height:16px;accent-color:#526fc8}
  .editor-interface-field-main{min-width:0}.editor-interface-field-title{font-size:12px;font-weight:600;overflow-wrap:anywhere}
  .editor-interface-field-meta{margin-top:3px;color:#7a879b;font-size:10px;overflow-wrap:anywhere}
  .editor-interface-field-name{width:100%;min-width:0;min-height:32px;padding:5px 8px;border:1px solid #d9e0eb;border-radius:6px;font-size:11px;color:#354866;background:#fff}
  .editor-interface-badge{display:inline-block;margin-left:5px;padding:2px 5px;border-radius:5px;background:#eef2fe;color:#566ca2;font-size:9px;font-weight:500}
  .editor-interface-section{border:1px solid #e0e5ed;border-radius:10px;background:#fff;margin-top:16px;overflow:hidden}
  .editor-interface-section>p{margin:10px 12px;color:#6c7990;font-size:11px;line-height:1.6}
  .editor-interface-output,.editor-interface-binding{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(190px,290px);align-items:center;gap:10px;padding:10px 12px;border-top:1px solid #eef1f5}
  .editor-interface-output input[type="checkbox"]{width:16px;height:16px;accent-color:#526fc8}
  .editor-interface-binding{grid-template-columns:minmax(0,1fr) minmax(220px,340px);align-items:start}
  .editor-interface-binding-main{min-width:0;font-size:12px;font-weight:600;overflow-wrap:anywhere}
  .editor-interface-binding-meta{display:block;margin-top:4px;color:#77849a;font-size:10px;font-weight:400;line-height:1.5}
  .editor-interface-binding select{width:100%;min-height:34px;padding:5px 8px;border:1px solid #d2dceb;border-radius:6px;background:#fff;color:#314968;font-size:11px}
  .editor-interface-empty{padding:14px 12px;color:#77849a;font-size:12px}.editor-interface-required{color:#9a5a36}
  .editor-interface-conflict-preview{display:block;color:#748198;font-size:10px;line-height:1.45;overflow-wrap:anywhere;margin-top:4px}
  .editor-interface-conflict select{grid-column:1/-1}.editor-interface-conflict{grid-template-columns:minmax(0,1fr) minmax(200px,310px)}
  @media(max-width:720px){.editor-interface-layout{min-height:calc(100dvh - 28px)}.editor-interface-header,.editor-interface-footer{padding:12px}
    .editor-interface-body{padding:12px}.editor-interface-toolbar{grid-template-columns:1fr}.editor-interface-tabs{justify-content:flex-start}
    .editor-interface-field{grid-template-columns:auto minmax(0,1fr)}.editor-interface-field-name{grid-column:2}
    .editor-interface-output{grid-template-columns:auto minmax(0,1fr)}.editor-interface-output .editor-interface-field-meta{grid-column:2}
    .editor-interface-binding,.editor-interface-conflict{grid-template-columns:1fr}.editor-interface-binding select{grid-column:1}
    .editor-interface-status{max-width:50vw}.editor-interface-header h2{font-size:16px}}
`;

function openPanel({ title, description, confirmLabel, render, canConfirm, value }) {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);
  return new Promise(resolve => {
    const dialog = element('dialog', '', 'editor-interface-dialog');
    const style = element('style', PANEL_STYLE);
    const layout = element('div', '', 'editor-interface-layout');
    const header = element('header', '', 'editor-interface-header');
    const copy = element('div', '', 'editor-interface-header-copy');
    const heading = element('h2', title);
    const subheading = element('p', description);
    const close = element('button', '×', 'close-button editor-interface-close');
    close.type = 'button'; close.setAttribute('aria-label', '关闭');
    copy.append(heading, subheading); header.append(copy, close);
    const body = element('div', '', 'editor-interface-body');
    const footer = element('footer', '', 'editor-interface-footer');
    const status = element('p', '', 'editor-interface-status'); status.setAttribute('role', 'status');
    const actions = element('div', '', 'editor-interface-actions');
    const cancel = element('button', '取消', 'button quiet'); cancel.type = 'button';
    const confirm = element('button', confirmLabel, 'button primary'); confirm.type = 'button';
    actions.append(cancel, confirm); footer.append(status, actions);
    layout.append(header, body, footer); dialog.append(style, layout);
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      dialog.removeEventListener('cancel', onCancel);
      dialog.close?.(); dialog.remove(); resolve(result);
    };
    const onCancel = event => { event.preventDefault(); finish(null); };
    const setStatus = (message, error = false) => {
      status.textContent = message || '';
      status.dataset.error = String(error);
    };
    const updateConfirm = () => { confirm.disabled = !canConfirm(); };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(null); }
    });
    close.addEventListener('click', () => finish(null));
    cancel.addEventListener('click', () => finish(null));
    confirm.addEventListener('click', () => {
      if (!canConfirm()) return;
      finish(value());
    });
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    render({ body, status: setStatus, updateConfirm });
    updateConfirm();
    close.focus?.();
  });
}

function fieldSearchText(field) {
  return [fieldId(field), field.node_id, field.input, field.label, typeOf(field), editorFieldGroup(field)]
    .filter(value => value !== undefined && value !== null).join(' ').toLowerCase();
}

function idOptionText(item, id, labelKey = 'label') {
  const label = String(item?.[labelKey] ?? id);
  const mediaType = item?.mediaType ? ` · ${item.mediaType}` : '';
  return `${label} · ${id}${mediaType}`;
}

function appendRebindingRows({
  container, title, note, rows, kind, choices, allCandidates, selectedIds, onTarget,
}) {
  if (!rows.length) return;
  const section = element('section', '', 'editor-interface-section');
  section.append(element('h3', title), element('p', note));
  for (const row of rows) {
    const item = element('div', '', 'editor-interface-binding');
    const main = element('div', '', 'editor-interface-binding-main');
    main.append(element('span', row.label || row.id));
    const details = [];
    if (row.type || row.mediaType) details.push(`类型：${row.type ?? row.mediaType}`);
    details.push(row.connected ? `关联 ${row.connected} 条连线` : '当前无连线');
    if (kind === 'field' && row.reason === 'removed') details.push('字段已移除');
    if (kind === 'field' && row.reason === 'type_changed') details.push('字段类型已变化');
    if (row.reason === 'not_exposed') details.push('当前未暴露');
    if (kind === 'output' && row.reason === 'type_changed') details.push('输出媒体类型已变化');
    if (kind === 'output' && row.reason === 'removed') details.push('输出已移除');
    main.append(element('span', details.join(' · '), 'editor-interface-binding-meta'));
    if (row.valueSummary) main.append(element('span', row.valueSummary, 'editor-interface-binding-meta'));
    const select = element('select');
    select.setAttribute('aria-label', `${row.label || row.id} 的${kind === 'field' ? '字段' : '输出'}连线处理方式`);
    const blank = element('option', '请选择保留新连接或解除绑定'); blank.value = ''; select.append(blank);
    const candidates = row.candidates || allCandidates;
    for (const candidate of candidates) {
      const id = kind === 'field' ? fieldId(candidate) : outputId(candidate);
      if (!id || id === row.id) continue;
      const option = element('option', idOptionText(candidate, id)); option.value = JSON.stringify(id); select.append(option);
    }
    const disconnect = element('option', kind === 'field' ? '解除字段绑定（断开连线）' : '解除输出绑定（断开连线）');
    disconnect.value = 'null'; select.append(disconnect);
    if (choices.has(row.id)) select.value = JSON.stringify(choices.get(row.id));
    select.addEventListener('change', () => {
      if (!select.value) { choices.delete(row.id); onTarget(null, row); return; }
      const targetId = JSON.parse(select.value);
      choices.set(row.id, targetId === null ? FIELD_DISCONNECT : targetId);
      onTarget(targetId, row);
    });
    item.append(main, select); section.append(item);
  }
  container.append(section);
}

function mappingSummary(previousValues, previousBaseline, id) {
  if (!hasKey(previousValues, id) || !hasKey(previousBaseline, id)) return '';
  const outer = getKey(previousValues, id), baseline = getKey(previousBaseline, id);
  if (sameJsonValue(outer, baseline)) return '';
  return `上次外层值：${shortValuePreview(outer, 46)} · 内部基线：${shortValuePreview(baseline, 46)}`;
}

export function editorInputTargetsUnique(connections, choices) {
  const mapping = choices instanceof Map ? choices : new Map(Object.entries(choices || {}));
  const mapped = [...mapping.values()].filter(value => value !== null);
  if (new Set(mapped).size !== mapped.length) return false;
  const targets = (connections || []).filter(item => item.direction === 'input' && item.fieldId)
    .map(item => mapping.has(item.fieldId) ? mapping.get(item.fieldId) : item.fieldId)
    .filter(value => value !== null);
  return new Set(targets).size === targets.length;
}

/** Open a review panel. It never performs a fetch, edits the graph, or submits a job. */
export async function chooseEditorInterface({
  fields, outputs, previousFields = [], previousValues = {}, previousBaseline = {},
  selectedOutputs = [], connections = [],
} = {}) {
  const candidates = (Array.isArray(fields) ? fields : []).filter(field => field && fieldId(field));
  const outputCandidates = (Array.isArray(outputs) ? outputs : []).filter(output => output && outputId(output));
  if (typeof document === 'undefined' || !document.body) return null;

  const selectedFieldIds = new Set(initialEditorFieldIds(candidates, previousFields, previousValues, previousBaseline));
  const selectedOutputIds = new Set(initialEditorOutputIds(outputCandidates, selectedOutputs));
  const requiredFieldIds = new Set(candidates.filter(isRequiredEditorMediaField).map(fieldId));
  const labels = new Map();
  const inputChoices = new Map();
  const outputChoices = new Map();
  let groupFilter = '全部';
  let searchText = '';
  let transientError = '';

  const getBindings = () => deriveEditorRebindings({
    fields: candidates, previousFields, selectedFieldIds: [...selectedFieldIds],
    outputs: outputCandidates, selectedOutputIds: [...selectedOutputIds], selectedOutputs, connections,
  });
  const hasValidBindings = (rows, choices, selected, kind) => rows.every(row => {
    if (!choices.has(row.id)) return false;
    const target = choices.get(row.id);
    if (target === null) return true;
    return selected.has(target) && (kind === 'output' || row.candidates.some(field => fieldId(field) === target));
  });
  const valid = () => {
    const { inputRebindings, outputRebindings } = getBindings();
    return selectedFieldIds.size <= EDITOR_INTERFACE_FIELD_LIMIT &&
      editorInputTargetsUnique(connections, inputChoices) &&
      [...requiredFieldIds].every(id => selectedFieldIds.has(id)) && selectedOutputIds.size >= 1 &&
      hasValidBindings(inputRebindings, inputChoices, selectedFieldIds, 'field') &&
      hasValidBindings(outputRebindings, outputChoices, selectedOutputIds, 'output');
  };

  return openPanel({
    title: '配置外层接口',
    description: '选择常用参数与输出。重绑字段时一并核对原值；重绑输出从新分支首张图开始，可回到连线设置修改序号。每条连线须明确保留、重绑或解除。',
    confirmLabel: '应用外层面板',
    canConfirm: valid,
    value: () => {
      const chosenFields = candidates.filter(field => selectedFieldIds.has(fieldId(field))).map(field => ({
        ...field, label: labels.has(fieldId(field)) ? labels.get(fieldId(field)) : field.label,
      }));
      const { inputRebindings, outputRebindings } = getBindings();
      return {
        fields: chosenFields,
        output_nodes: outputCandidates.map(outputId).filter(id => selectedOutputIds.has(id)),
        rebindings: Object.fromEntries(inputRebindings.map(row => [row.id, inputChoices.get(row.id)])),
        output_rebindings: Object.fromEntries(outputRebindings.map(row => [row.id, outputChoices.get(row.id)])),
      };
    },
    render({ body, status, updateConfirm }) {
      const toolbar = element('div', '', 'editor-interface-toolbar');
      const search = element('input', '', 'editor-interface-search');
      search.type = 'search'; search.placeholder = '搜索参数名、节点、类型…';
      search.setAttribute('aria-label', '搜索参数');
      const tabs = element('nav', '', 'editor-interface-tabs'); tabs.setAttribute('aria-label', '参数分类');
      const fieldCount = element('p', '', 'editor-interface-count');
      const fieldArea = element('div');
      const outputArea = element('div');
      const bindingArea = element('div');
      const setTabs = () => {
        tabs.replaceChildren();
        for (const group of ['全部', ...EDITOR_INTERFACE_GROUPS]) {
          const button = element('button', group, 'editor-interface-tab'); button.type = 'button';
          button.setAttribute('aria-pressed', String(groupFilter === group));
          button.addEventListener('click', () => { groupFilter = group; setTabs(); renderFields(); });
          tabs.append(button);
        }
      };
      const showStatus = () => {
        const { inputRebindings, outputRebindings } = getBindings();
        const unresolvedInputs = inputRebindings.filter(row => !inputChoices.has(row.id)).length;
        const unresolvedOutputs = outputRebindings.filter(row => !outputChoices.has(row.id)).length;
        const requiredMissing = [...requiredFieldIds].filter(id => !selectedFieldIds.has(id)).length;
        const invalidInputTargets = inputRebindings.some(row => inputChoices.has(row.id) &&
          inputChoices.get(row.id) !== null && !selectedFieldIds.has(inputChoices.get(row.id)));
        const invalidOutputTargets = outputRebindings.some(row => outputChoices.has(row.id) &&
          outputChoices.get(row.id) !== null && !selectedOutputIds.has(outputChoices.get(row.id)));
        const messages = [];
        if (selectedFieldIds.size > EDITOR_INTERFACE_FIELD_LIMIT) messages.push(`最多暴露 ${EDITOR_INTERFACE_FIELD_LIMIT} 个参数。`);
        if (requiredMissing) messages.push('所有 image/audio 媒体参数都必须保留。');
        if (!selectedOutputIds.size) messages.push('至少选择一个输出分支。');
        if (unresolvedInputs || unresolvedOutputs) messages.push(`请处理 ${unresolvedInputs + unresolvedOutputs} 项现有连线。`);
        if (invalidInputTargets || invalidOutputTargets) messages.push('重绑定目标也必须选入外层面板。');
        if (!editorInputTargetsUnique(connections, inputChoices)) messages.push('多个输入不能重绑到同一字段，请改选或解除其中一条。');
        if (transientError) messages.push(transientError);
        status(messages.join(' ') || `${selectedFieldIds.size}/${EDITOR_INTERFACE_FIELD_LIMIT} 个参数已选；${selectedOutputIds.size} 个输出已选。`, !!transientError);
        updateConfirm();
      };
      const renderFields = () => {
        const needle = searchText.trim().toLowerCase();
        fieldArea.replaceChildren();
        const visible = candidates.filter(field =>
          (groupFilter === '全部' || editorFieldGroup(field) === groupFilter) &&
          (!needle || fieldSearchText(field).includes(needle)));
        if (!visible.length) fieldArea.append(element('p', '没有匹配的参数。', 'editor-interface-empty'));
        for (const group of EDITOR_INTERFACE_GROUPS) {
          const groupItems = visible.filter(field => editorFieldGroup(field) === group);
          if (!groupItems.length) continue;
          const section = element('section', '', 'editor-interface-group');
          section.append(element('h3', `${group} · ${groupItems.length}`));
          for (const field of groupItems) {
            const id = fieldId(field), row = element('div', '', 'editor-interface-field');
            const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedFieldIds.has(id);
            checkbox.disabled = requiredFieldIds.has(id); checkbox.setAttribute('aria-label', `暴露参数 ${field.label || field.input || id}`);
            checkbox.addEventListener('change', () => {
              transientError = '';
              if (checkbox.checked && !selectedFieldIds.has(id) && selectedFieldIds.size >= EDITOR_INTERFACE_FIELD_LIMIT) {
                checkbox.checked = false; transientError = `最多暴露 ${EDITOR_INTERFACE_FIELD_LIMIT} 个参数，请先取消其他参数。`;
              } else if (checkbox.checked) selectedFieldIds.add(id);
              else selectedFieldIds.delete(id);
              renderFields(); renderOutputs(); renderBindings(); showStatus();
            });
            const info = element('div', '', 'editor-interface-field-main');
            const title = element('div', '', 'editor-interface-field-title');
            title.append(element('span', field.label || field.input || id));
            if (field.recommended === true) title.append(element('span', '推荐', 'editor-interface-badge'));
            if (requiredFieldIds.has(id)) title.append(element('span', '必选媒体', 'editor-interface-badge editor-interface-required'));
            const metaParts = [`节点 ${field.node_id ?? '—'}`, String(field.input ?? id), String(field.type ?? '未知类型')];
            info.append(title, element('div', metaParts.join(' · '), 'editor-interface-field-meta'));
            const name = element('input', '', 'editor-interface-field-name'); name.type = 'text';
            name.maxLength = 100; name.value = labels.get(id) ?? String(field.label ?? field.input ?? id);
            name.setAttribute('aria-label', `外层显示名称：${field.label || field.input || id}`);
            name.addEventListener('input', () => { labels.set(id, name.value.trim() || String(field.label ?? field.input ?? id)); });
            row.append(checkbox, info, name); section.append(row);
          }
          fieldArea.append(section);
        }
        fieldCount.textContent = `已选 ${selectedFieldIds.size}/${EDITOR_INTERFACE_FIELD_LIMIT} 个参数 · image/audio 必须暴露`;
      };
      const renderOutputs = () => {
        outputArea.replaceChildren();
        const section = element('section', '', 'editor-interface-section');
        section.append(element('h3', `输出分支 · ${selectedOutputIds.size} 个已选`),
          element('p', '至少保留一个输出。已连线的输出如被取消，需明确改接其他输出或解除连线。'));
        if (!outputCandidates.length) section.append(element('div', '当前工作流没有可用输出节点。', 'editor-interface-empty'));
        for (const output of outputCandidates) {
          const id = outputId(output), row = element('label', '', 'editor-interface-output');
          const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedOutputIds.has(id);
          checkbox.setAttribute('aria-label', `选择输出 ${output.label || id}`);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedOutputIds.add(id); else selectedOutputIds.delete(id);
            renderOutputs(); renderBindings(); showStatus();
          });
          const title = element('span', output.label || id);
          const meta = element('span', `${output.mediaType || '未知媒体'} · ${id}`, 'editor-interface-field-meta');
          row.append(checkbox, title, meta); section.append(row);
        }
        outputArea.append(section);
      };
      const activateTarget = (targetId, kind) => {
        transientError = '';
        if (targetId === null || targetId === undefined) { showStatus(); return; }
        if (kind === 'field' && !selectedFieldIds.has(targetId)) {
          if (selectedFieldIds.size >= EDITOR_INTERFACE_FIELD_LIMIT) {
            transientError = `已达到 ${EDITOR_INTERFACE_FIELD_LIMIT} 个参数上限；先取消一个，再选择这个重绑定目标。`;
          } else selectedFieldIds.add(targetId);
        }
        if (kind === 'output') selectedOutputIds.add(targetId);
        renderFields(); renderOutputs(); renderBindings(); showStatus();
      };
      const renderBindings = () => {
        bindingArea.replaceChildren();
        const { inputRebindings, outputRebindings } = getBindings();
        for (const row of inputRebindings) row.valueSummary = mappingSummary(previousValues, previousBaseline, row.id);
        appendRebindingRows({
          container: bindingArea, title: '外层输入连线处理',
          note: '旧字段已删除、类型变化或不再暴露。每项须明确选兼容字段或解除绑定。',
          rows: inputRebindings, kind: 'field', choices: inputChoices, allCandidates: candidates,
          selectedIds: selectedFieldIds, onTarget: target => activateTarget(target, 'field'),
        });
        appendRebindingRows({
          container: bindingArea, title: '输出连线处理',
          note: '这些输出仍有外层连线，但已取消选择或从内部工作流移除。请选择新输出或明确解除。',
          rows: outputRebindings, kind: 'output', choices: outputChoices, allCandidates: outputCandidates,
          selectedIds: selectedOutputIds, onTarget: target => activateTarget(target, 'output'),
        });
      };
      toolbar.append(search, tabs); body.append(toolbar, fieldCount, fieldArea, outputArea, bindingArea);
      search.addEventListener('input', () => { searchText = search.value; renderFields(); });
      setTabs(); renderFields(); renderOutputs(); renderBindings(); showStatus();
    },
  });
}

/** Resolve outside edits against edits made inside the native workflow editor. */
export async function resolveEditorConflicts(conflicts) {
  const items = Array.isArray(conflicts) ? conflicts : [];
  if (!items.length) return {};
  if (typeof document === 'undefined' || !document.body) return null;
  const choices = new Map();
  const rawKeys = items.map((item, index) => String(item?.id ?? item?.index ?? index));
  const keyCounts = new Map();
  for (const key of rawKeys) keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
  const usedKeys = new Set();
  const keys = rawKeys.map((key, index) => {
    let unique = keyCounts.get(key) === 1 ? key : `#${index}`;
    while (usedKeys.has(unique)) unique = `#${index}-${usedKeys.size}`;
    usedKeys.add(unique);
    return unique;
  });
  return openPanel({
    title: '处理参数修改冲突',
    description: '参数两边都被修改，或原外层值不再符合新接口。逐项确认；也可以取消后返回修改。提示词仅显示短预览。',
    confirmLabel: '应用所选修改',
    canConfirm: () => items.every((_item, index) => choices.has(keys[index])),
    value: () => Object.fromEntries(keys.map(key => [key, choices.get(key)])),
    render({ body, status, updateConfirm }) {
      const section = element('section', '', 'editor-interface-section editor-interface-conflict-list');
      section.append(element('h3', `需要决定 · ${items.length} 项`));
      for (const [index, conflict] of items.entries()) {
        const key = keys[index];
        const row = element('div', '', 'editor-interface-binding editor-interface-conflict');
        const main = element('div', '', 'editor-interface-binding-main');
        main.append(element('span', conflict?.label ?? conflict?.fieldLabel ?? key));
        const pickValue = names => {
          for (const name of names) if (conflict && Object.hasOwn(conflict, name)) return conflict[name];
          return undefined;
        };
        const outer = pickValue(['outerValue', 'outer_value', 'outer']);
        const inner = pickValue(['innerValue', 'inner_value', 'inner']);
        main.append(element('span', `外层值：${shortValuePreview(outer)}`, 'editor-interface-conflict-preview'));
        main.append(element('span', `内部值：${shortValuePreview(inner)}`, 'editor-interface-conflict-preview'));
        if (conflict?.reason) main.append(element('span', `原外层值不可用：${conflict.reason}`, 'editor-interface-warning'));
        const select = element('select');
        select.setAttribute('aria-label', `${conflict?.label ?? key} 冲突处理方式`);
        const blank = element('option', '请选择保留哪一方'); blank.value = ''; select.append(blank);
        for (const [value, label] of [['outer', '采用外层值'], ['inner', '采用内部值']]) {
          if (Array.isArray(conflict?.allowed) && !conflict.allowed.includes(value)) continue;
          const option = element('option', label); option.value = value; select.append(option);
        }
        select.addEventListener('change', () => {
          if (select.value === 'outer' || select.value === 'inner') choices.set(key, select.value);
          else choices.delete(key);
          status(items.every((_item, itemIndex) => choices.has(keys[itemIndex])) ? '' : '请为每项冲突选择保留的一方。');
          updateConfirm();
        });
        row.append(main, select); section.append(row);
      }
      body.append(section);
      status('请为每项冲突选择保留的一方。');
      updateConfirm();
    },
  });
}
