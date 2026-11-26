// Read-only diagnostics of serialized native Comfy graphs. This is advisory,
// not a schema validator or save gate. Never traverse widgets/properties/extra
// content. Formats verified against the installed official frontend sources:
// workflowSchema.ts, LGraph.ts, LLink.ts and SubgraphInput/Output.ts.
const MAX = Object.freeze({ nodes: 10000, links: 50000, structuralItems: 500000,
  depth: 80, issues: 200, reportBytes: 131072 });
const LABELS = Object.freeze({
  duplicate_node_id: '节点编号重复或发生类型碰撞。',
  duplicate_link_id: '链路编号重复或发生类型碰撞。',
  invalid_node_id: '节点编号格式无法识别。',
  invalid_link_id: '链路编号格式无法识别。',
  missing_endpoint: '全局链路引用了不存在的节点。',
  invalid_slot: '全局链路引用的槽位不存在或编号无效。',
  source_reference_mismatch: '全局链路与来源槽位的链路列表不一致。',
  target_reference_mismatch: '全局链路与目标槽位的链路引用不一致。',
  missing_local_link: '槽位引用了不存在的全局链路。',
  local_endpoint_mismatch: '槽位引用的全局链路指向其他端点。',
  multiple_input_routes: '同一输入槽位存在多条全局链路。',
  duplicate_local_link: '同一槽位重复引用了链路编号。',
  malformed_floating_link: '浮动链路的未连接端点格式无法识别。',
  unknown_shape: '部分链路结构无法识别，相关检查未完成。',
  legacy_group_nodes_unchecked: '旧式分组节点使用独立索引格式，内部链路尚未检查。',
  port_metadata_unavailable: '文档未保存此端口的完整连接信息，需载入前端后重新检查。',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idKey = value => typeof value === 'string' && value.length > 0 ? value
  : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const safeId = (value, kind, index) => {
  const key = idKey(value);
  return key !== null && key.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(key)
    ? key : `opaque-${kind}-${index}`;
};
const safeSlot = slot => Number.isSafeInteger(slot) && slot >= -1 && slot <= MAX.structuralItems ? slot : undefined;
// The official serialized slot schema also accepts strings via parseInt.
// Normalize this structural field only; never coerce IDs or widget values.
const slotIndex = value => typeof value === 'string' ? Number.parseInt(value) : value;

/**
 * Inspect plain, serialized native workflow data without modifying it.
 * options.limits may lower (never raise) any MAX budget. reportBytes must be
 * at least 2048 to leave room for the fixed report envelope and reason codes.
 * Counts are inspected
 * graphs/nodes/links and detected issues; issues[] may be shorter if capped.
 * graph is an opaque traversal scope, not a user-supplied graph name or ID.
 * Coverage concerns endpoint/slot reciprocity only, not reroute geometry,
 * types, executable reachability or plugin-specific embedded graphs.
 */
export function inspectWorkflowLinks(document, options = {}) {
  const requestedBytes = options?.limits?.reportBytes;
  if (Number.isSafeInteger(requestedBytes) && requestedBytes >= 0 && requestedBytes < 2048) {
    throw new RangeError('reportBytes must be at least 2048');
  }
  const limits = {};
  for (const [key, upper] of Object.entries(MAX)) {
    const value = options?.limits?.[key];
    limits[key] = Number.isSafeInteger(value) && value >= 0 ? Math.min(value, upper) : upper;
  }
  const report = { version: 1, coverage: 'complete', totals: { graphs: 0, nodes: 0, links: 0, issues: 0 },
    issues: [], incomplete_reasons: [] };
  const reasons = new Set(), visited = new WeakSet();
  let items = 0, issueBytes = 0, graphSerial = 0;
  const partial = reason => { report.coverage = 'partial'; reasons.add(reason); };
  const stop = reason => { partial(reason); throw budgetStop; };
  const budgetStop = {};
  const spend = () => { if (items >= limits.structuralItems) stop('structural_item_limit'); items++; };
  const add = (code, graph, data = {}) => {
    report.totals.issues++;
    const issue = { code, severity: 'warning', graph, ...data, message: LABELS[code] };
    // Serialize only our small, sanitized output record, never workflow data.
    const bytes = new TextEncoder().encode(JSON.stringify(issue)).length + 1;
    if (report.issues.length >= limits.issues) { partial('issue_limit'); return; }
    // Reserve room for the report envelope, counters and fixed reason codes.
    if (issueBytes + bytes + 2048 > limits.reportBytes) { partial('report_byte_limit'); return; }
    issueBytes += bytes; report.issues.push(issue);
  };
  const unknown = graph => { partial('unknown_shape'); add('unknown_shape', graph); };
  const readArray = (value, graph, optional = true) => {
    if (value === undefined && optional) return [];
    if (Array.isArray(value)) return value;
    unknown(graph); return [];
  };
  const parseLink = (raw, floating, graph, index) => {
    spend();
    if (report.totals.links >= limits.links) stop('link_limit');
    report.totals.links++;
    let link;
    if (Array.isArray(raw) && raw.length === 6 && !floating) {
      link = { id: raw[0], origin_id: raw[1], origin_slot: raw[2], target_id: raw[3], target_slot: raw[4] };
    } else if (object(raw) && ['id', 'origin_id', 'origin_slot', 'target_id', 'target_slot'].every(key => Object.hasOwn(raw, key))) {
      link = { id: raw.id, origin_id: raw.origin_id, origin_slot: raw.origin_slot, target_id: raw.target_id, target_slot: raw.target_slot };
    } else { unknown(graph); return null; }
    link.origin_slot = slotIndex(link.origin_slot); link.target_slot = slotIndex(link.target_slot);
    link.key = idKey(link.id); link.safe = safeId(link.id, 'link', index);
    if (link.key === null) { add('invalid_link_id', graph, { link_id: link.safe }); return null; }
    return link;
  };
  const inspect = (scope, graph, isSubgraph) => {
    report.totals.graphs++;
    const nodes = new Map(), links = new Map(), floating = new Map(), localSlots = [], unproven = new Set();
    const portUnknown = (node, direction, index) => {
      const key = JSON.stringify([node.key, direction, index]);
      partial('port_metadata_unavailable');
      if (unproven.has(key)) return;
      unproven.add(key);
      add('port_metadata_unavailable', graph, { node_id: node.safe, direction, ...(index === undefined ? {} : { slot: index }) });
    };
    let nodeIndex = 0, linkIndex = 0;
    const slotRefs = (raw, direction, virtual) => {
      if (virtual) return raw.linkIds === undefined ? [] : readArray(raw.linkIds, graph);
      if (direction === 'output') return raw.links == null ? [] : readArray(raw.links, graph);
      if (raw.link == null) return [];
      if (idKey(raw.link) === null) { unknown(graph); return []; }
      return [raw.link];
    };
    const slots = (rawSlots, node, direction, virtual = false) => {
      const list = readArray(rawSlots, graph), result = [];
      for (let index = 0; index < list.length; index++) {
        spend();
        const raw = list[index];
        if (!object(raw)) { unknown(graph); result.push(null); continue; }
        const referenceKey = virtual ? 'linkIds' : direction === 'output' ? 'links' : 'link';
        const refs = new Set(), slot = { node, direction, index, refs, refsKnown: raw[referenceKey] !== undefined };
        const data = { node_id: node.safe, slot: index, direction };
        for (const id of slotRefs(raw, direction, virtual)) {
          spend();
          const key = idKey(id);
          if (key === null) { unknown(graph); continue; }
          if (refs.has(key)) add('duplicate_local_link', graph, { ...data, link_id: safeId(id, 'reference', items) });
          refs.add(key);
        }
        result.push(slot); localSlots.push(slot);
      }
      return result;
    };
    for (const raw of readArray(scope.nodes, graph, false)) {
      spend();
      if (report.totals.nodes >= limits.nodes) stop('node_limit');
      report.totals.nodes++; nodeIndex++;
      if (!object(raw)) { unknown(graph); continue; }
      const key = idKey(raw.id), safe = safeId(raw.id, 'node', nodeIndex);
      if (key === null) { add('invalid_node_id', graph, { node_id: safe }); continue; }
      if (nodes.has(key)) { add('duplicate_node_id', graph, { node_id: safe }); continue; }
      const node = { key, safe }; nodes.set(key, node);
      node.inputsKnown = Array.isArray(raw.inputs); node.outputsKnown = Array.isArray(raw.outputs);
      node.inputs = slots(raw.inputs, node, 'input'); node.outputs = slots(raw.outputs, node, 'output');
    }
    if (isSubgraph) {
      for (const [key, rawSlots, direction] of [['-10', scope.inputs, 'output'], ['-20', scope.outputs, 'input']]) {
        if (nodes.has(key)) { add('duplicate_node_id', graph, { node_id: key }); continue; }
        const node = { key, safe: key, inputs: [], outputs: [], inputsKnown: true, outputsKnown: true }; nodes.set(key, node);
        node[direction === 'output' ? 'outputsKnown' : 'inputsKnown'] = Array.isArray(rawSlots);
        node[direction === 'output' ? 'outputs' : 'inputs'] = slots(rawSlots, node, direction, true);
      }
    }
    for (const [rawLinks, map, isFloating] of [[scope.links, links, false], [scope.floatingLinks, floating, true]]) {
      for (const raw of readArray(rawLinks, graph)) {
        const link = parseLink(raw, isFloating, graph, ++linkIndex);
        if (!link) continue;
        if (map.has(link.key)) { add('duplicate_link_id', graph, { link_id: link.safe }); continue; }
        map.set(link.key, link);
      }
    }
    const routes = new Map();
    const endpoint = (link, direction, isFloating) => {
      spend();
      const origin = direction === 'output', id = origin ? link.origin_id : link.target_id;
      const index = origin ? link.origin_slot : link.target_slot, key = idKey(id);
      const data = { link_id: link.safe, node_id: safeId(id, 'endpoint', items), direction };
      if (safeSlot(index) !== undefined) data.slot = index;
      if (isFloating && key === '-1' && index === -1) return null;
      const node = nodes.get(key);
      if (!node) { add('missing_endpoint', graph, data); return null; }
      if (!node[origin ? 'outputsKnown' : 'inputsKnown']) { portUnknown(node, direction); return null; }
      const list = origin ? node.outputs : node.inputs;
      if (!Number.isSafeInteger(index) || index < 0 || index >= list.length || !list[index]) {
        add('invalid_slot', graph, data); return null;
      }
      return list[index];
    };
    for (const link of links.values()) {
      const source = endpoint(link, 'output', false), target = endpoint(link, 'input', false);
      if (source && !source.refsKnown) portUnknown(source.node, 'output', source.index);
      else if (source && !source.refs.has(link.key)) add('source_reference_mismatch', graph,
        { node_id: source.node.safe, link_id: link.safe, slot: source.index, direction: 'output' });
      if (target) {
        if (!target.refsKnown) portUnknown(target.node, 'input', target.index);
        else if (!target.refs.has(link.key)) add('target_reference_mismatch', graph,
          { node_id: target.node.safe, link_id: link.safe, slot: target.index, direction: 'input' });
        const count = (routes.get(target) || 0) + 1; routes.set(target, count);
        if (count === 2) add('multiple_input_routes', graph,
          { node_id: target.node.safe, slot: target.index, direction: 'input' });
      }
    }
    for (const link of floating.values()) {
      const sourceEmpty = idKey(link.origin_id) === '-1' && link.origin_slot === -1;
      const targetEmpty = idKey(link.target_id) === '-1' && link.target_slot === -1;
      if (sourceEmpty === targetEmpty) add('malformed_floating_link', graph, { link_id: link.safe });
      endpoint(link, 'output', true); endpoint(link, 'input', true);
    }
    for (const slot of localSlots) {
      for (const key of slot.refs) {
        spend();
        const data = { node_id: slot.node.safe, link_id: safeId(key, 'reference', items), slot: slot.index, direction: slot.direction };
        const link = links.get(key);
        if (!link) { add('missing_local_link', graph, data); continue; }
        const origin = slot.direction === 'output';
        if (idKey(origin ? link.origin_id : link.target_id) !== slot.node.key ||
            (origin ? link.origin_slot : link.target_slot) !== slot.index) add('local_endpoint_mismatch', graph, data);
      }
    }
    if (object(scope.extra) && Object.hasOwn(scope.extra, 'groupNodes') && scope.extra.groupNodes != null) {
      partial('legacy_group_nodes_unchecked'); add('legacy_group_nodes_unchecked', graph);
    }
  };
  try {
    const stack = [{ scope: document, graph: 'root', depth: 0, isSubgraph: false }];
    while (stack.length) {
      const { scope, graph, depth, isSubgraph } = stack.pop(); spend();
      if (depth > limits.depth) { partial('depth_limit'); continue; }
      if (!object(scope)) { unknown(graph); continue; }
      if (visited.has(scope)) { partial('repeated_graph_object'); continue; }
      visited.add(scope);
      inspect(scope, graph, isSubgraph);
      if (scope.definitions === undefined) continue;
      if (!object(scope.definitions)) { unknown(graph); continue; }
      const children = readArray(scope.definitions.subgraphs, graph, false), pending = [];
      for (const child of children) {
        spend();
        pending.push({ scope: child, graph: `subgraph-${++graphSerial}`, depth: depth + 1, isSubgraph: true });
      }
      for (let index = pending.length - 1; index >= 0; index--) stack.push(pending[index]);
    }
  } catch (error) { if (error !== budgetStop) throw error; }
  report.incomplete_reasons = [...reasons];
  return report;
}
