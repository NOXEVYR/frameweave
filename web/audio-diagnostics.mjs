const MESSAGES = new Map(Object.entries({
  invalid_graph: '工作流包没有可校验的 API 图', missing_node: '当前后端未注册此节点类型',
  invalid_node: '节点结构无效', invalid_schema: '当前节点定义无效', unsupported_api_node: '本地模式不支持此云端 API 节点',
  missing_input: '缺少必填输入', unsupported_input: '当前节点版本不再接受此输入',
  enum_unavailable: '当前后端的下拉选项目录为空', invalid_selection: '原选项不在当前后端列表中，请重新选择',
  missing_model: '模型未选择或已不在当前后端目录中', missing_media: '缺少参考素材',
  unsafe_resource: '资源引用无效，请重新选择', invalid_value_type: '输入类型与当前节点定义不符',
  value_out_of_range: '数值超出当前节点范围', missing_connection: '缺少必需连线',
  invalid_connection: '连线指向的节点或输出不存在', connection_type_mismatch: '连线两端的类型不匹配',
  schema_incompatible: '节点或参数与当前后端定义不兼容', no_audio_output: '工作流未连接到 AUDIO 输入的输出节点',
}));
const FILE_SUFFIX = /\.(?:safetensors|gguf|ckpt|pt|pth|bin|onnx|png|jpe?g|webp|gif|wav|mp3|flac|ogg|aac|m4a|wma|mp4|webm|mov|mkv|avi|json|txt)$/i;
const identifier = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_ :+.-]{0,127}$/.test(value) &&
  !value.includes('..') && !/^[A-Za-z]:/.test(value) && !FILE_SUFFIX.test(value) ? value : '';
const nodeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(value) && value.length <= 128 ? value : '';

/** Rebuild bounded messages from diagnostic codes; raw error text and input values never enter the clipboard. */
export function audioDiagnosticView(pack) {
  const report = pack?.capability || pack;
  if (!Array.isArray(report?.diagnostics)) return { available: false, items: [], total: 0, truncated: false };
  const source = report.diagnostics, items = [];
  for (const issue of source.slice(0, 20)) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) continue;
    const code = MESSAGES.has(issue.code) ? issue.code : 'schema_incompatible';
    const id = nodeId(issue.node_id), type = identifier(issue.class_type), input = identifier(issue.input);
    const place = [id ? `节点 ${id}` : '', type ? `类型 ${type}` : '', input ? `输入 ${input}` : ''].filter(Boolean).join(' · ');
    items.push({ code, ...(id ? { node_id: id } : {}), ...(type ? { class_type: type } : {}), ...(input ? { input } : {}),
      text: `${place ? `${place}：` : ''}${MESSAGES.get(code)}` });
  }
  const count = Number.isSafeInteger(report.diagnostics_total) && report.diagnostics_total >= 0 ? report.diagnostics_total : source.length;
  const total = Math.max(count, source.length, items.length);
  return { available: true, items, total, truncated: report.diagnostics_truncated === true || total > items.length };
}

export function renderAudioDiagnostics(container, pack) {
  const view = audioDiagnosticView(pack);
  if (!view.items.length && !view.total) return;
  const details = document.createElement('details'); details.className = 'audio-diagnostics'; details.open = true;
  const summary = document.createElement('summary'); summary.textContent = `检查发现 ${view.total} 项问题`; details.append(summary);
  const list = document.createElement('ul');
  for (const item of view.items) { const row = document.createElement('li'); row.textContent = item.text; list.append(row); }
  details.append(list);
  if (view.truncated) {
    const more = document.createElement('p'); more.textContent = `这里显示 ${view.items.length} 项；其余问题请修复后刷新，或在内部工作流中检查。`; details.append(more);
  }
  container.append(details);
}
