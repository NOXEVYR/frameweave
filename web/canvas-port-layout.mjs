/** Presentation only: hidden controls remain valid bindings in saved graphs. */
import { interfacePage, interfaceSearch } from './interface-pagination.mjs';

// Canvas sockets need readable neighbours and wire targets at normal zoom.
// The complete parameter editor keeps its larger, independent page size.
export const CANVAS_PORT_PAGE_SIZE = 8;

/** Make room only below a growing card. Canvas coordinates, never screen pixels.
 * The initiating card and unrelated columns stay put; each displaced neighbour
 * becomes a blocker for the following cards. The caller owns history/storage.
 */
export function portExpansionPositions(rectangles, nodeId, height, gap = 36) {
  const owner = rectangles.find(rect => rect.id === nodeId);
  if (!owner || !Number.isFinite(height) || height <= owner.height) return [];
  const blockers = [{ ...owner, height }], positions = [];
  const below = rectangles.filter(rect => rect.id !== nodeId && rect.y >= owner.y)
    .sort((a, b) => a.y - b.y || String(a.id).localeCompare(String(b.id)));
  for (const rect of below) {
    let y = rect.y;
    let previous;
    do {
      previous = y;
      for (const blocker of blockers) {
        if (rect.x < blocker.x + blocker.width && rect.x + rect.width > blocker.x &&
            y < blocker.y + blocker.height + gap && y + rect.height > blocker.y) {
          y = Math.max(y, Math.ceil(blocker.y + blocker.height + gap));
        }
      }
    } while (y !== previous);
    if (y === rect.y) continue;
    // Graph import accepts coordinates only within this bound. Fail before the
    // caller applies any moves so a boundary canvas stays fully recoverable.
    if (y > 1e7) throw new Error('端口展开后空间不足，请先将此处节点移离画布坐标边界');
    blockers.push({ ...rect, y });
    positions.push({ id: rect.id, x: rect.x, y });
  }
  return positions;
}
export function cachedPackageField({ id, label, type, presentation, role, group }) {
  return { id, label, type, ...(presentation ? { presentation } : {}),
    ...(role ? { role } : {}), ...(group ? { group } : {}) };
}

export function inputPortCandidates(fields, connectedIds = []) {
  const connected = new Set(connectedIds);
  return fields.filter(field => ['text', 'image', 'video', 'audio'].includes(field.type) &&
    (field.presentation !== 'control' || connected.has(field.id)));
}

export function visibleInputPorts(fields, connectedIds = [], expanded = false, limit = 4, view = {}) {
  const connected = new Set(connectedIds);
  const candidates = inputPortCandidates(fields, connected);
  // Never collapse a connected socket: wires must terminate at their real label.
  const page = interfacePage(interfaceSearch(candidates.filter(field => !connected.has(field.id)), view.query), view.page, CANVAS_PORT_PAGE_SIZE);
  const visibleIds = new Set(page.items.map(field => field.id));
  // A compact multimodal node must advertise every input kind. Keep binding
  // order intact, but reserve a slot per kind before filling remaining slots.
  const compactIds = new Set();
  const compactCandidates = candidates.filter(field => field.presentation !== 'control');
  for (const type of ['text', 'image', 'video', 'audio']) {
    const field = type === 'text'
      ? compactCandidates.find(item => item.type === type && ['prompt', 'positive_prompt', 'negative_prompt'].includes(item.role)) || compactCandidates.find(item => item.type === type)
      : compactCandidates.find(item => item.type === type);
    if (field && compactIds.size < limit) compactIds.add(field.id);
  }
  for (const field of compactCandidates) if (compactIds.size < limit) compactIds.add(field.id);
  const visible = expanded ? candidates.filter(field => connected.has(field.id) || visibleIds.has(field.id)) :
    candidates.filter(field => compactIds.has(field.id) || connected.has(field.id));
  return { visible, total: candidates.length, hidden: candidates.length - visible.length, page };
}

export function outputChoices(graph, sourceId, mediaType) {
  const source = graph.nodes.find(node => node.id === sourceId);
  const owner = source?.type === 'result'
    ? graph.nodes.find(node => node.type === 'generation' && graph.edges.some(edge => edge.source === node.id && edge.target === sourceId))
    : source;
  const selected = Array.isArray(owner?.data.editor_outputs) ? new Set(owner.data.editor_outputs) : null;
  const choices = (owner?.data.editor_output_fields || []).filter(item =>
    (!selected || selected.has(item.id)) && item.mediaType === mediaType);
  const actual = (source?.data.outputs?.length ? source.data.outputs : owner?.data.outputs || []).filter(item => item.type === mediaType && (!selected || selected.has(item.node_id)));
  return { choices, actual, ambiguous: choices.length > 1 || actual.length > 1 };
}
