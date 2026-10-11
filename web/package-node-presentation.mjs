/** Display metadata only. Never changes package fields, bindings or execution. */
export function packageNodePresentation(node, pack) {
  const data = node.data;
  const fields = pack?.fields || data.packageFields;
  const inputs = (pack || data.package_id) && Array.isArray(fields) ? `${fields.length} 个输入参数` : '输入参数待准备';
  const selected = data.editor_outputs;
  const declared = data.editor_output_fields;
  const outputs = Array.isArray(selected)
    ? selected.length ? `已选 ${selected.length} 个输出` : '未选择输出'
    : !pack && !data.package_id ? '输出待准备' : Array.isArray(declared) && declared.length ? `全部 ${declared.length} 个输出` : '全部输出';
  return {
    name: pack?.name || (data.package_id ? '已绑定工作流 · 包内容待载入' : data.editor_id ? '原生工作流 · 待准备' : '尚未选择工作流包'),
    inputs, outputs,
    hint: pack ? '选中节点，在右侧调整参数；命名接口可连接素材。'
      : data.package_id ? '保留已绑定的接口；载入包库后显示完整参数。' : data.editor_id ? '先提取外层参数，或复用已保存的工作流配置。' : '导入工作流包后，即可填写参数并连接素材。',
  };
}
