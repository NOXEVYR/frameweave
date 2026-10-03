import { parseGraph, serializeGraph, generationInputPorts, edgeInputField } from './graph.mjs';
import { cachedPackageField } from './canvas-port-layout.mjs';
import { mergeHiddenUpdates } from './editor-hidden-updates.mjs';
import { remapTextCompositions } from './text-input-composition.mjs';

export function editorOutputEdges(graph, nodeId) {
  const previews = new Set(graph.edges.filter(edge => edge.source === nodeId &&
    graph.nodes.find(node => node.id === edge.target)?.type === 'result').map(edge => edge.target));
  return graph.edges.filter(edge => (edge.source === nodeId || previews.has(edge.source)) &&
    graph.nodes.find(node => node.id === edge.target)?.type === 'generation');
}

export const editorOutputKey = edge => edge.sourceOutput || `legacy-${edge.id}`;

function remappedMediaOwners(data, fields, values, backend, rebindings, invalidated = []) {
  const oldFields = new Map((data.packageFields || []).map(field => [field.id, field]));
  const nextFields = new Map(fields.map(field => [field.id, field]));
  const oldValues = data.packageValues || {};
  const oldOwners = data.packageMediaBackends || {};
  const owners = {};
  const mediaTypes = new Set(['image', 'audio', 'video']);
  const engineChanged = Boolean(data.editor_backend && backend && data.editor_backend !== backend);
  if (!Array.isArray(invalidated) || invalidated.some(id => typeof id !== 'string')) throw new Error('媒体归属失效记录无效');
  const invalidatedIds = new Set(invalidated);

  for (const [oldId, oldField] of oldFields) {
    if (!mediaTypes.has(oldField.type)) continue;
    const nextId = Object.hasOwn(rebindings, oldId) ? rebindings[oldId] : oldId;
    if (!nextId) continue;
    if (invalidatedIds.has(oldId) || invalidatedIds.has(nextId)) continue;
    const nextField = nextFields.get(nextId);
    if (!nextField || nextField.type !== oldField.type) continue;

    const oldName = oldValues[oldId];
    const nextName = values?.[nextId];
    if (typeof oldName !== 'string' || !oldName || oldName !== nextName) continue;

    const prior = oldOwners[oldId];
    if (prior?.name === oldName && prior.backend) {
      owners[nextId] = { name: nextName, backend: prior.backend };
      if (!engineChanged && backend === prior.backend && nextId === oldId && !Object.hasOwn(rebindings, oldId) &&
          /^\/api\/media\/[a-f0-9]{32}$/.test(prior.preview_url || '')) owners[nextId].preview_url = prior.preview_url;
    } else if (engineChanged) {
      // Older canvases did not record media ownership. Keep the old editor's
      // engine as the conservative source so applying the interface on a new
      // engine cannot turn the inherited filename into an unowned input.
      owners[nextId] = { name: nextName, backend: data.editor_backend };
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
    const target = graph.nodes.find(node => node.id === edge.target);
    const expected = generationInputPorts(target).find(field => field.id === edgeInputField(graph, edge))?.type;
    return { direction: 'output', outputId: editorOutputKey(edge), mediaType: output?.mediaType || expected || 'unknown',
      label: output?.label || `旧图片连接 · ${graph.nodes.find(node => node.id === edge.target)?.data.title || edge.id}` };
  })];
}

/** Immutable instance transformation; the owning workspace validates its boundary. */
export function applyEditorInterfaceData(data, result) {
  const next = structuredClone(data);
  const fields = result.package.fields;
  const packageMediaBackends = remappedMediaOwners(data, fields, result.values, result.backend_url, result.rebindings || {}, result.invalidated_media_fields || []);
  const packageTextCompositions = remapTextCompositions(data.packageTextCompositions, data.packageFields, fields, result.rebindings || {});
  const hiddenUpdates = mergeHiddenUpdates(data.editor_hidden_updates || [], result.hidden_updates || [], result.hidden_updates_reset === true, fields);
  Object.assign(next, { package_id: result.package.id, packageValues: result.values,
    packageFields: fields.map(cachedPackageField),
    editor_backend: result.backend_url, editor_baseline: result.baseline,
    editor_outputs: result.output_nodes, editor_output_fields: result.outputs, packageMediaBackends, packageTextCompositions, editor_hidden_updates: hiddenUpdates });
  if (result.controls) next.editor_controls = result.controls;
  return structuredClone(next);
}

/** Validate the entire proposed graph before changing the live canvas. */
export function applyEditorInterfaceGraph(graph, nodeId, result, { preserveOutputIndices = false } = {}) {
  const copy = structuredClone(graph);
  const node = copy.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error('工作流节点已不存在');
  const valid = new Set(result.package.fields.map(field => field.id));
  const outputs = new Set(editorOutputEdges(copy, nodeId).map(edge => edge.id));
  node.data = applyEditorInterfaceData(node.data, result);
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
        // Only the verified initial preset migration preserves the same batch
        // ordinal. User-directed output branch changes keep their reset rule.
        if (!preserveOutputIndices) edge.outputIndex = 0;
      } else if (!edge.sourceOutput || !result.output_nodes.includes(edge.sourceOutput)) {
        throw new Error('输出连线尚未明确选择输出分支或解除');
      }
    }
    return true;
  });
  const checked = parseGraph(serializeGraph(copy));
  return { nodes: checked.nodes, edges: checked.edges };
}

