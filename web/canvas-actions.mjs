/** Canvas editing operations. They never submit jobs or alter the source graph. */
import { makeId, parseGraph, serializeGraph } from './graph.mjs';

const LIMIT = 1e7;
const copy = value => JSON.parse(JSON.stringify(value));

export function selectionBounds(nodes, sizeOf) {
  if (!nodes.length) return null;
  return nodes.reduce((box, node) => {
    const size = sizeOf(node);
    return { minX: Math.min(box.minX, node.x), minY: Math.min(box.minY, node.y), maxX: Math.max(box.maxX, node.x + size.width), maxY: Math.max(box.maxY, node.y + size.height) };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

export function copySelection(graph, ids) {
  const selected = new Set(ids);
  return copy({ nodes: graph.nodes.filter(node => selected.has(node.id)), edges: graph.edges.filter(edge => selected.has(edge.source) && selected.has(edge.target)) });
}

export function pasteSelection(fragment, position, currentCount = 0) {
  if (!fragment?.nodes?.length) return { nodes: [], edges: [] };
  if (fragment.nodes.length + currentCount > 500) throw new Error('粘贴后超过 500 个节点，请先整理画布。');
  const validated = parseGraph(serializeGraph(fragment));
  const ids = new Map(validated.nodes.map(node => [node.id, makeId()]));
  const minX = Math.min(...validated.nodes.map(node => node.x)), minY = Math.min(...validated.nodes.map(node => node.y));
  const maxX = Math.max(...validated.nodes.map(node => node.x)), maxY = Math.max(...validated.nodes.map(node => node.y));
  // Clamp the whole fragment, preserving relative positions at imported limits.
  const dx = Math.max(-LIMIT - minX, Math.min(LIMIT - maxX, position.x - minX));
  const dy = Math.max(-LIMIT - minY, Math.min(LIMIT - maxY, position.y - minY));
  return {
    nodes: validated.nodes.map(node => {
      const next = { ...node, id: ids.get(node.id), x: node.x + dx, y: node.y + dy, data: copy(node.data) };
      // A copied result is an editable placeholder, never a second owner of a job.
      if (next.type === 'result') { next.data.outputs = []; next.data.jobId = ''; }
      return next;
    }),
    edges: validated.edges.map(edge => ({ ...edge, id: makeId('edge'), source: ids.get(edge.source), target: ids.get(edge.target) })),
  };
}

export function moveSelection(nodes, dx, dy) {
  if (!nodes.length) return [];
  dx = Math.max(-LIMIT - Math.min(...nodes.map(node => node.x)), Math.min(LIMIT - Math.max(...nodes.map(node => node.x)), dx));
  dy = Math.max(-LIMIT - Math.min(...nodes.map(node => node.y)), Math.min(LIMIT - Math.max(...nodes.map(node => node.y)), dy));
  return nodes.map(node => ({ id: node.id, x: node.x + dx, y: node.y + dy }));
}

export function arrangeSelection(nodes, mode, sizeOf) {
  if (!['left', 'right', 'top', 'bottom', 'horizontal', 'vertical'].includes(mode)) throw new Error('未知排列操作');
  if (nodes.length < (['horizontal', 'vertical'].includes(mode) ? 3 : 2)) return [];
  const bounds = selectionBounds(nodes, sizeOf);
  const positions = nodes.map(node => ({ id: node.id, x: node.x, y: node.y, ...sizeOf(node) }));
  if (mode === 'left') positions.forEach(node => { node.x = bounds.minX; });
  if (mode === 'right') positions.forEach(node => { node.x = bounds.maxX - node.width; });
  if (mode === 'top') positions.forEach(node => { node.y = bounds.minY; });
  if (mode === 'bottom') positions.forEach(node => { node.y = bounds.maxY - node.height; });
  if (mode === 'horizontal' || mode === 'vertical') {
    const axis = mode === 'horizontal' ? 'x' : 'y', dimension = mode === 'horizontal' ? 'width' : 'height';
    positions.sort((a, b) => a[axis] - b[axis]);
    const first = positions[0], last = positions.at(-1);
    const space = last[axis] + last[dimension] - first[axis] - positions.reduce((sum, item) => sum + item[dimension], 0);
    const gap = Math.max(32, space / (positions.length - 1));
    let next = first[axis];
    positions.forEach(node => { node[axis] = next; next += node[dimension] + gap; });
  }
  if (positions.some(node => Math.abs(node.x) > LIMIT || Math.abs(node.y) > LIMIT)) throw new Error('已到画布坐标边界，请先将节点移回中心。');
  return positions.map(({ id, x, y }) => ({ id, x: Math.round(x), y: Math.round(y) }));
}

export function clampMenuPosition(point, size, viewport, margin = 8) {
  return { x: Math.max(margin, Math.min(point.x, viewport.width - size.width - margin)), y: Math.max(margin, Math.min(point.y, viewport.height - size.height - margin)) };
}
