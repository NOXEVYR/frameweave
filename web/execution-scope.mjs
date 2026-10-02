import { MAX_INTERFACE_FIELDS } from './interface-limits.mjs';
/** Frozen outer-canvas dependencies. Comfy ancestry remains a backend decision. */
import { executionOrder } from './graph.mjs';
import { packageValues } from './packages.mjs';
import { normalizeTextCompositions, composeTextInput, textCompositionOwn, recordTextContribution, textContributionIdentity, textSourceOccurrence } from './text-input-composition.mjs';

// Preserve invalid scalar values too: packageValues/the backend must reject
// them, rather than JSON cloning silently dropping undefined or replacing NaN.
const copy = value => structuredClone(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && !unsafe.has(value);
const sameSet = (left, right) => left.length === right.length && left.every(id => right.includes(id));

function ids(value, label, { empty = true, limit = 10000 } = {}) {
  if (!Array.isArray(value) || value.length > limit || !empty && !value.length || value.some(id => !validId(id))
      || new Set(value).size !== value.length) throw new Error(`${label}无效或重复`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key))
      || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`${label}格式无效`);
}

function backendIdentity(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('执行范围缺少推理引擎身份');
  let url;
  try { url = new URL(value); } catch { throw new Error('执行范围推理引擎地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || !['', '/'].includes(url.pathname)) throw new Error('执行范围推理引擎地址无效');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

function validateDeferredMediaValue(field, value) {
  // Match packages.validate_value(template=True) + diagnostics.safe_relative.
  // Python counts Unicode code points; do not impose a narrower UTF-16 limit
  // or reject legacy spaces, repeated separators, trailing slashes or suffixes.
  if (typeof value !== 'string' || [...value].length > 1024) {
    throw new Error(`工作流包媒体字段 ${field.id} 的文本类型或长度无效`);
  }
  if (!value) return;
  const name = value.replaceAll('\\', '/');
  if (name.startsWith('/') || name.includes(':') || name.includes('\0')
      || name.split('/').some(part => part === '.' || part === '..')) {
    throw new Error(`工作流包媒体字段 ${field.id} 不可使用绝对路径或越界路径`);
  }
}

function graphIndex(graph, targetIds) {
  if (!record(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('执行范围画布格式无效');
  ids(graph.nodes.map(node => node?.id), '画布节点 ID');
  ids(graph.edges.map(edge => edge?.id), '画布连线 ID');
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  for (const node of graph.nodes) {
    if (!['prompt', 'reference', 'generation', 'result'].includes(node.type) || !record(node.data)) throw new Error('执行范围画布节点格式无效');
    if (node.type === 'generation' && node.data.kind === 'package') {
      const fields = node.data.packageFields || [];
      if (!Array.isArray(fields)) throw new Error('工作流包缓存字段无效');
      ids(fields.map(field => field?.id), '工作流包缓存字段 ID', { limit: MAX_INTERFACE_FIELDS });
    }
  }
  for (const edge of graph.edges) {
    if (!record(edge) || !nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error('执行范围连线引用了不存在的节点');
    const target = nodes.get(edge.target);
    if (Object.hasOwn(edge, 'sourceOccurrence')) {
      const field = (target.data.packageFields || []).find(item => item.id === edge.targetField);
      const composition = target.type === 'generation' && target.data.kind === 'package'
        && normalizeTextCompositions(target.data.packageTextCompositions, target.data.packageFields)[edge.targetField];
      textContributionIdentity(edge, { sourceType: nodes.get(edge.source).type, fieldType: field?.type, composition });
    }
    if (target.type === 'generation' && target.data.kind === 'package'
        && !(target.data.packageFields || []).some(field => field.id === edge.targetField)) {
      throw new Error(`工作流包连线 ${edge.id} 引用了不存在的目标字段`);
    }
    incoming.get(edge.target).push(edge);
  }
  const targets = targetIds === undefined ? graph.nodes.filter(node => node.type === 'generation').map(node => node.id)
    : targetIds instanceof Set ? [...targetIds] : targetIds;
  ids(targets, '执行目标 ID', { empty: false });
  if (targets.some(id => !nodes.has(id))) throw new Error('选择的执行节点不存在');
  return { nodes, incoming, targets: [...targets] };
}

function validatePackage(node, scope) {
  const label = `工作流包 ${node.id} 执行范围`;
  exactKeys(scope, ['package_id', 'selected_outputs', 'node_ids', 'active_field_ids'], label);
  if (typeof node.data.package_id !== 'string' || !node.data.package_id) {
    throw new Error(`「${node.data.title || node.id}」尚未建立外层参数，请先提取参数或复用已保存配置；本次未启动任何节点。`);
  }
  if (scope.package_id !== node.data.package_id) throw new Error(`${label}的包身份不匹配`);
  ids(scope.selected_outputs, `${label}输出 ID`, { empty: false, limit: 64 });
  ids(scope.node_ids, `${label}内部节点 ID`, { empty: false, limit: 1000 });
  ids(scope.active_field_ids, `${label}字段 ID`, { limit: MAX_INTERFACE_FIELDS });
  if (scope.selected_outputs.some(id => !scope.node_ids.includes(id))) throw new Error(`${label}输出不在内部节点集合中`);
  const fields = node.data.packageFields || [];
  const fieldIds = new Set(fields.map(field => field.id)), activeIds = new Set(scope.active_field_ids), nodeIds = new Set(scope.node_ids);
  if (scope.active_field_ids.some(id => !fieldIds.has(id))) throw new Error(`${label}引用了不存在的缓存字段`);
  // Ordinary cachedPackageField entries omit node_id. Check bindings only when
  // present; never invent internal ancestors from labels, order or output types.
  for (const field of fields) {
    if (field.node_id !== undefined && activeIds.has(field.id) !== nodeIds.has(field.node_id)) {
      throw new Error(`${label}字段与内部节点集合不匹配`);
    }
  }
  if (Object.hasOwn(node.data, 'editor_outputs')) {
    ids(node.data.editor_outputs, `${label}显式输出 ID`, { empty: false, limit: 64 });
    if (!sameSet(scope.selected_outputs, node.data.editor_outputs)) throw new Error(`${label}与画布选择的输出不匹配`);
  }
  if (node.data.editor_output_fields !== undefined) {
    if (!Array.isArray(node.data.editor_output_fields)) throw new Error(`${label}缓存输出无效`);
    ids(node.data.editor_output_fields.map(field => field?.id), `${label}缓存输出 ID`, { limit: 64 });
    if (scope.selected_outputs.some(id => !node.data.editor_output_fields.some(field => field.id === id))) {
      throw new Error(`${label}引用了不存在的缓存输出`);
    }
  }
  return scope;
}

function dependencies(node, scope, index) {
  const incoming = index.incoming.get(node.id);
  if (node.type === 'result') {
    if (incoming.length !== 1 || index.nodes.get(incoming[0].source)?.type !== 'generation') {
      throw new Error('媒体结果节点必须连接本次工作流的唯一上游生成节点，不能使用旧任务结果。');
    }
    return incoming;
  }
  if (node.type !== 'generation') return [];
  const active = node.data.kind === 'package' ? new Set(scope.active_field_ids) : null;
  return active ? incoming.filter(edge => active.has(edge.targetField)) : incoming;
}

function validateOutputBindings(index, edgeIds, packages) {
  for (const edges of index.incoming.values()) for (const edge of edges) {
    if (!edgeIds.has(edge.id) || edge.sourceOutput === undefined) continue;
    if (!validId(edge.sourceOutput)) throw new Error(`连线 ${edge.id} 的输出绑定无效`);
    let owner = index.nodes.get(edge.source);
    if (owner.type === 'result') owner = index.nodes.get(index.incoming.get(owner.id)[0]?.source);
    if (owner?.type !== 'generation') throw new Error(`连线 ${edge.id} 的输出绑定缺少生成来源`);
    const selected = packages[owner.id]?.selected_outputs || owner.data.editor_outputs;
    if (selected !== undefined && (!Array.isArray(selected) || !selected.includes(edge.sourceOutput))) {
      throw new Error(`连线 ${edge.id} 绑定输出 ${edge.sourceOutput}，但上游「${owner.data.title || owner.id}」未选择此输出；请明确调整输出选择或连线。`);
    }
  }
}

function makeProjection(graph, nodeIds, edgeIds, packages) {
  const projected = copy(graph);
  projected.nodes = projected.nodes.filter(node => nodeIds.has(node.id));
  projected.edges = projected.edges.filter(edge => edgeIds.has(edge.id));
  for (const node of projected.nodes) {
    const scope = packages[node.id];
    if (!scope) continue;
    const activeIds = new Set(scope.active_field_ids);
    node.data.packageFields = (node.data.packageFields || []).filter(field => activeIds.has(field.id));
    if (node.data.packageTextCompositions !== undefined) {
      node.data.packageTextCompositions = Object.fromEntries(Object.entries(node.data.packageTextCompositions)
        .filter(([id]) => activeIds.has(id)));
    }
    if (node.data.packageMediaBackends !== undefined) {
      node.data.packageMediaBackends = Object.fromEntries(Object.entries(node.data.packageMediaBackends)
        .filter(([id]) => activeIds.has(id)));
    }
    node.data.editor_outputs = [...scope.selected_outputs];
  }
  return projected;
}

/** Validate a durable scope against its complete frozen source, then derive a copy. */
export function projectExecution(graph, execution, targetIds) {
  const index = graphIndex(graph, targetIds);
  exactKeys(execution, ['version', 'node_ids', 'edge_ids', 'packages'], '执行范围记录');
  if (execution.version !== 1 || !record(execution.packages)) throw new Error('执行范围记录版本或包映射无效');
  ids(execution.node_ids, '执行范围节点 ID', { empty: false });
  ids(execution.edge_ids, '执行范围连线 ID');
  for (const [id, scope] of Object.entries(execution.packages)) {
    const node = index.nodes.get(id);
    if (!validId(id) || node?.type !== 'generation' || node.data.kind !== 'package') throw new Error('执行范围引用了不存在的工作流包节点');
    validatePackage(node, scope);
  }
  const nodeIds = new Set(), edgeIds = new Set(), visitedPackages = new Set();
  const visit = id => {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    const node = index.nodes.get(id);
    let scope;
    if (node.type === 'generation' && node.data.kind === 'package') {
      if (!Object.hasOwn(execution.packages, id)) throw new Error(`执行范围缺少工作流包 ${id} 的计划`);
      scope = execution.packages[id]; visitedPackages.add(id);
    }
    for (const edge of dependencies(node, scope, index)) { edgeIds.add(edge.id); visit(edge.source); }
  };
  index.targets.forEach(visit);
  if (!sameSet([...nodeIds], execution.node_ids) || !sameSet([...edgeIds], execution.edge_ids)
      || !sameSet([...visitedPackages], Object.keys(execution.packages))) {
    throw new Error('执行范围节点、连线或包集合与目标依赖不匹配；不能删除活动连线或扩大冻结范围');
  }
  validateOutputBindings(index, edgeIds, execution.packages);
  const projected = makeProjection(graph, nodeIds, edgeIds, execution.packages);
  if (!executionOrder(projected, index.targets).length) throw new Error('请选择至少一个可执行生成节点');
  return projected;
}

/** Plan each reached package once; do not upload media or consume historical jobs. */
export async function planExecution(graph, targetIds, backend, api) {
  if (typeof api !== 'function') throw new Error('执行范围计划需要 api 回调');
  const expectedBackend = backendIdentity(backend);
  for (const edge of graph?.edges || []) if (Object.hasOwn(edge, 'sourceOccurrence')) textSourceOccurrence(edge);
  // Clone before the first await so callers can independently guard live edits.
  const source = copy(graph), index = graphIndex(source, targetIds);
  const nodeIds = new Set(), edgeIds = new Set(), packages = {};
  const visit = async id => {
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    const node = index.nodes.get(id);
    if (node.type === 'generation' && node.data.editor_backend
        && backendIdentity(node.data.editor_backend) !== expectedBackend) {
      throw new Error(`活动节点「${node.data.title || node.id}」绑定了其他推理引擎；请切换到同一引擎后重新运行。`);
    }
    let scope;
    if (node.type === 'generation' && node.data.kind === 'package') {
      if (typeof node.data.package_id !== 'string' || !node.data.package_id) {
        throw new Error(`「${node.data.title || node.id}」尚未建立外层参数，请先提取参数或复用已保存配置；本次未启动任何节点。`);
      }
      const values = packageValues(node.data.packageValues || {});
      const compositions = normalizeTextCompositions(node.data.packageTextCompositions, node.data.packageFields);
      const textInputs = new Map();
      const contributions = new Set();
      for (const field of Object.keys(compositions)) textCompositionOwn(values, field);
      for (const edge of index.incoming.get(id)) {
        const upstream = index.nodes.get(edge.source);
        const field = (node.data.packageFields || []).find(item => item.id === edge.targetField);
        recordTextContribution(contributions, edge, { sourceType: upstream.type, fieldType: field?.type, composition: compositions[edge.targetField] });
        if (upstream.type !== 'prompt') {
          // A wired media input will replace its form value during preparation.
          // Do not validate a stale form filename as if it were this run's input,
          // or invent the not-yet-uploaded reference/upstream output filename.
          if (['image', 'video', 'audio'].includes(field?.type)) {
            if (Object.hasOwn(values, field.id)) validateDeferredMediaValue(field, values[field.id]);
            values[field.id] = '';
          }
          continue;
        }
        const key = edge.sourceField || 'text', text = upstream.data[key];
        if (field?.type !== 'text' || !['text', 'negative'].includes(key) || typeof text !== 'string' || text.length > 100000) {
          throw new Error(`工作流包连线 ${edge.id} 的提示词字段无效`);
        }
        if (compositions[edge.targetField]) {
          if (!textInputs.has(edge.targetField)) textInputs.set(edge.targetField, []);
          const parts = textInputs.get(edge.targetField);
          parts.push({source:edge.source,key,text});
        } else values[edge.targetField] = text;
      }
      for (const [field, parts] of textInputs) values[field] = composeTextInput(compositions[field], parts.map(item => item.text), values[field]);
      const request = { kind: 'package', package_id: node.data.package_id, values: packageValues(values),
        ...(node.data.editor_backend ? { editor_backend: node.data.editor_backend } : {}),
        ...(Object.hasOwn(node.data, 'editor_outputs') ? { output_nodes: copy(node.data.editor_outputs) } : {}) };
      const response = await api('/api/execution-plan', { backend_url: backend, request });
      if (!record(response) || backendIdentity(response.backend_url) !== expectedBackend
          || response.package_id !== node.data.package_id || !record(response.execution)) {
        throw new Error(`工作流包 ${id} 的计划响应包身份或推理引擎不匹配`);
      }
      scope = { package_id: response.package_id, selected_outputs: response.execution.selected_outputs,
        node_ids: response.execution.node_ids, active_field_ids: response.execution.active_field_ids };
      validatePackage(node, scope);
      if (response.execution.output_nodes !== undefined) {
        ids(response.execution.output_nodes, '计划响应输出 ID', { empty: false, limit: 64 });
        if (!sameSet(response.execution.output_nodes, scope.selected_outputs)) throw new Error('计划响应输出集合不一致');
      }
      packages[id] = copy(scope);
    }
    for (const edge of dependencies(node, scope, index)) { edgeIds.add(edge.id); await visit(edge.source); }
  };
  for (const id of index.targets) await visit(id);
  const execution = { version: 1,
    node_ids: source.nodes.filter(node => nodeIds.has(node.id)).map(node => node.id),
    edge_ids: source.edges.filter(edge => edgeIds.has(edge.id)).map(edge => edge.id), packages };
  projectExecution(source, execution, index.targets);
  return execution;
}
