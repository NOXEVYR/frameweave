import { parseGraph, serializeGraph } from './graph.mjs';

export function editorOutputEdges(graph, nodeId) {
  const previews = new Set(graph.edges.filter(edge => edge.source === nodeId &&
    graph.nodes.find(node => node.id === edge.target)?.type === 'result').map(edge => edge.target));
  return graph.edges.filter(edge => (edge.source === nodeId || previews.has(edge.source)) &&
    graph.nodes.find(node => node.id === edge.target)?.type === 'generation');
}

export const editorOutputKey = edge => edge.sourceOutput || `legacy-${edge.id}`;

function remappedMediaOwners(node, fields, values, backend, rebindings) {
  const oldFields = new Map((node.data.packageFields || []).map(field => [field.id, field]));
  const nextFields = new Map(fields.map(field => [field.id, field]));
  const oldValues = node.data.packageValues || {};
  const oldOwners = node.data.packageMediaBackends || {};
  const owners = {};
  const mediaTypes = new Set(['image', 'audio']);
  const engineChanged = Boolean(node.data.editor_backend && backend && node.data.editor_backend !== backend);

  for (const [oldId, oldField] of oldFields) {
    if (!mediaTypes.has(oldField.type)) continue;
    const nextId = Object.hasOwn(rebindings, oldId) ? rebindings[oldId] : oldId;
    if (!nextId) continue;
    const nextField = nextFields.get(nextId);
    if (!nextField || nextField.type !== oldField.type) continue;

    const oldName = oldValues[oldId];
    const nextName = values?.[nextId];
    if (typeof oldName !== 'string' || !oldName || oldName !== nextName) continue;

    const prior = oldOwners[oldId];
    if (prior?.name === oldName && prior.backend) {
      owners[nextId] = { name: nextName, backend: prior.backend };
    } else if (engineChanged) {
      // Older canvases did not record media ownership. Keep the old editor's
      // engine as the conservative source so applying the interface on a new
      // engine cannot turn the inherited filename into an unowned input.
      owners[nextId] = { name: nextName, backend: node.data.editor_backend };
    }
  }
  return owners;
}

export function editorConnectionSummary(graph, nodeId, outputs) {
  const inputs = graph.edges.filter(edge => edge.target === nodeId).map(edge => ({
    direction: 'input', fieldId: edge.targetField,
    label: graph.nodes.find(node => node.id === edge.source)?.data.title || '相邻节点',
  }));
  return [...inputs, ...editorOutputEdges(graph, nodeId).map(edge => {
    const output = outputs.find(item => item.id === edge.sourceOutput);
    return { direction: 'output', outputId: editorOutputKey(edge), mediaType: output?.mediaType || 'image',
      label: output?.label || `旧图片连接 · ${graph.nodes.find(node => node.id === edge.target)?.data.title || edge.id}` };
  })];
}

/** Validate the entire proposed graph before changing the live canvas. */
export function applyEditorInterfaceGraph(graph, nodeId, result) {
  const copy = structuredClone(graph);
  const node = copy.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error('工作流节点已不存在');
  const fields = result.package.fields;
  const valid = new Set(fields.map(field => field.id));
  const outputs = new Set(editorOutputEdges(copy, nodeId).map(edge => edge.id));
  const packageMediaBackends = remappedMediaOwners(node, fields, result.values, result.backend_url, result.rebindings || {});
  Object.assign(node.data, { package_id: result.package.id, packageValues: result.values,
    packageFields: fields.map(({ id, label, type }) => ({ id, label, type })),
    editor_backend: result.backend_url, editor_baseline: result.baseline,
    editor_outputs: result.output_nodes, editor_output_fields: result.outputs, packageMediaBackends });
  if (result.controls) node.data.editor_controls = result.controls;
  copy.edges = copy.edges.filter(edge => {
    if (edge.target === nodeId && edge.targetField) {
      if (Object.hasOwn(result.rebindings || {}, edge.targetField)) {
        const target = result.rebindings[edge.targetField];
        if (target === null) return false;
        edge.targetField = target;
      }
      if (!valid.has(edge.targetField)) throw new Error('输入连线尚未明确重绑或解除');
    }
    if (outputs.has(edge.id)) {
      const key = editorOutputKey(edge);
      if (Object.hasOwn(result.output_rebindings || {}, key)) {
        const target = result.output_rebindings[key];
        if (target === null) return false;
        edge.sourceOutput = target;
        edge.outputIndex = 0;
      } else if (!edge.sourceOutput || !result.output_nodes.includes(edge.sourceOutput)) {
        throw new Error('输出连线尚未明确选择输出分支或解除');
      }
    }
    return true;
  });
  const checked = parseGraph(serializeGraph(copy));
  return { nodes: checked.nodes, edges: checked.edges };
}
