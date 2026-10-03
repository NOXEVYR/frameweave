/** One compile/selection/merge transaction for canvas and independent workspaces. */
export async function configureWorkflowInterface({ api, toast, chooseEditorInterface,
  autoEditorInterfaceSelection, resolveEditorConflicts, completeInterfaceInputs }, data,
  { compiled = null, session = null, automatic = false, syncBaseline = [], previousFields = [],
    connections = [], assertCurrent } = {}) {
  if (typeof assertCurrent !== 'function') throw new Error('工作流编辑缺少当前目标校验');
  assertCurrent();
  if (compiled?.ignored_ui_inputs?.length) toast(`已识别并排除 ${compiled.ignored_ui_inputs.length} 个仅用于界面操作的控件；原工作流保留`);
  const previousBaseline = structuredClone(data.editor_baseline || {});
  // This option is local editor state, never an arbitrary addition to the
  // session HTTP payload. Recheck both the previous field and clean native
  // compile before replacing a single field's three-way merge base.
  if (compiled && session?.session_id && Array.isArray(syncBaseline)) {
    const fields = [...previousFields, ...(data.editor_hidden_updates || []).map(item => item.field)];
    const fieldsById = new Map(), controlsByBinding = new Map(), ownerCounts = new Map(), baselineCounts = new Map();
    for (const field of fields) { const matches = fieldsById.get(field.id) || []; matches.push(field); fieldsById.set(field.id, matches); }
    for (const control of compiled.controls || []) {
      const binding = JSON.stringify([control.node_id, control.input]), target = JSON.stringify([control.widget_node_id, control.widget_name]);
      const matches = controlsByBinding.get(binding) || []; matches.push(control); controlsByBinding.set(binding, matches);
      ownerCounts.set(target, (ownerCounts.get(target) || 0) + 1);
    }
    for (const item of syncBaseline) if (item) baselineCounts.set(item.field_id, (baselineCounts.get(item.field_id) || 0) + 1);
    const hiddenById = new Map((data.editor_hidden_updates || []).map(item => [item.field.id, item]));
    const seen = new Set();
    for (const item of syncBaseline) {
      if (!item || seen.has(item.field_id)) continue;
      seen.add(item.field_id);
      const matches = fieldsById.get(item.field_id) || [];
      const field = matches[0], definition = compiled.output?.[item.node_id];
      const controls = controlsByBinding.get(JSON.stringify([item.node_id, item.input])) || [];
      const hidden = hiddenById.get(item.field_id);
      const ownValue = hidden ? hidden.value : data.packageValues?.[item.field_id];
      if (baselineCounts.get(item.field_id) !== 1 || matches.length !== 1 || field.node_id !== item.node_id || field.input !== item.input || field.type !== item.type ||
          definition?.class_type !== item.class_type || !Object.hasOwn(definition.inputs || {}, item.input) ||
          controls.length !== 1 || ownerCounts.get(JSON.stringify([item.widget_node_id, item.widget_name])) !== 1 || controls[0].widget_node_id !== item.widget_node_id || controls[0].widget_name !== item.widget_name ||
          !Object.is(ownValue, item.value) || item.value !== null && !['string', 'number', 'boolean'].includes(typeof item.value)) continue;
      previousBaseline[item.field_id] = item.value;
    }
  }
  const prefix = `/api/editor-workflows/${data.editor_id}`;
  const inspectionPayload = { previous_package_id: data.package_id || null,
    ...(compiled ? { prompt: compiled.output } : { package_id: data.package_id, values: data.packageValues, previous_baseline: data.editor_baseline }) };
  let info = await api(`${prefix}/interface`, inspectionPayload);
  assertCurrent();
  if (info.migrations?.length) toast(`已按当前节点定义对齐 ${info.migrations.length} 个参数名；未改动原文件或参数值`);
  const oldOutputs = (data.editor_output_fields || []).filter(item => (data.editor_outputs || []).includes(item.id));
  if (!compiled) info.outputs = info.outputs.map(item => ({ ...item, label: oldOutputs.find(old => old.id === item.id)?.label || item.label }));
  const options = { ...info, previousFields, previousValues: data.packageValues, previousBaseline, selectedOutputs: oldOutputs.length ? oldOutputs : data.editor_outputs || [], connections };
  let selection = (automatic ? autoEditorInterfaceSelection(options) : null) || await chooseEditorInterface(options);
  if (!selection) return null;
  const repaired = await completeInterfaceInputs(info, selection, { path: `${prefix}/interface`, payload: inspectionPayload, options, ensureCurrent: () => assertCurrent() });
  if (!repaired) return null;
  ({ info, selection } = repaired);
  assertCurrent();
  const payload = { ...(session ? { session_id: session.session_id, base_revision: session.base_revision } : {}), missing_values: repaired.missing_values, fields: selection.fields, output_nodes: selection.output_nodes, rebindings: selection.rebindings,
    ...(compiled?.connected_resolutions ? { connected_resolutions: compiled.connected_resolutions } : {}),
    previous_package_id: data.package_id || null, previous_values: data.packageValues || {}, previous_baseline: previousBaseline,
    ...(compiled ? { document: compiled.workflow, prompt: compiled.output } : { package_id: data.package_id, values: data.packageValues, backend_url: data.editor_backend }) };
  let result = await api(`${prefix}/${compiled ? 'apply' : 'configure'}`, payload);
  if (result.requires_resolution) {
    const resolutions = await resolveEditorConflicts(result.changes.conflicts);
    if (!resolutions) return null;
    assertCurrent();
    result = await api(`${prefix}/${compiled ? 'apply' : 'configure'}`, { ...payload, resolutions });
    if (result.requires_resolution) throw new Error('仍有参数冲突未选择，请重新配置');
  }
  assertCurrent();
  if (result.readiness?.issues?.length) toast(`外部接口已建立；生成前还需修复：${result.readiness.issues[0].message || result.readiness.issues[0]}`, true);
  const controls = (compiled?.controls || data.editor_controls || []).map(control => {
    const copy = { ...control }; delete copy.media_receipt; delete copy.mapping_receipt; return copy;
  });
  const invalidated_media_fields = (Array.isArray(compiled?.connected_resolutions) ? compiled.connected_resolutions : []).filter(item => item.choice === 'inner' && item.media_owner_invalidated === true).map(item => item.field_id);
  return { ...result, outputs: info.outputs, controls, invalidated_media_fields, rebindings: selection.rebindings, output_rebindings: selection.output_rebindings };
}
