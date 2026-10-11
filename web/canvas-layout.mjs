const visibleIn = (canvas, rect) => rect && [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0 && rect.right > canvas.left && rect.left < canvas.right && rect.bottom > canvas.top && rect.top < canvas.bottom;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Actual chrome positions only; this never changes a viewport or a node. */
export function canvasChromeOffsets(canvas, { topline, banner, actions } = {}) {
  const topEnd = Math.max(0, ...[topline, banner].filter(rect => visibleIn(canvas, rect)).map(rect => rect.bottom - canvas.top));
  const actionTop = Math.max(60, topEnd + 12);
  const actionHeight = visibleIn(canvas, actions) ? actions.height : 44;
  return { actionTop, workflowTop: actionTop + actionHeight + 8 };
}

/** Clear view rectangle, ranked by content fit when given a size, otherwise area. */
export function canvasContentArea(canvas, overlays = [], contentSize) {
  const width = Math.max(0, canvas.width), height = Math.max(0, canvas.height);
  const visible = overlays.filter(rect => visibleIn(canvas, rect));
  const margin = Math.min(32, width / 8);
  const top = clamp(Math.max(28, ...visible.filter(rect => !rect.kind || rect.kind === 'top').map(rect => rect.bottom - canvas.top + 18)), 0, height);
  const bottomOverlays = visible.filter(rect => rect.kind === 'bottom');
  const end = clamp(bottomOverlays.length ? Math.min(...bottomOverlays.map(rect => rect.top - canvas.top - 12)) : height - 72, top, height);
  let candidates = [{ x: margin, y: top, width: Math.max(0, width - margin * 2), height: end - top }];
  // Only fixed canvas chrome is accepted here, never workflow nodes. Bound work
  // independently of workflow size, even if a caller accidentally supplies more.
  const obstacles = visible.filter(rect => rect.kind === 'obstacle');
  if (obstacles.length > 8) return { x: margin, y: top, width: 0, height: 0 };
  for (const rect of obstacles) {
    const obstacle = { left: rect.left - canvas.left - 12, right: rect.right - canvas.left + 12, top: rect.top - canvas.top - 12, bottom: rect.bottom - canvas.top + 12 };
    const next = [];
    for (const area of candidates) {
      const right = area.x + area.width, bottom = area.y + area.height;
      if (obstacle.right <= area.x || obstacle.left >= right || obstacle.bottom <= area.y || obstacle.top >= bottom) { next.push(area); continue; }
      if (obstacle.left > area.x) next.push({ ...area, width: obstacle.left - area.x });
      if (obstacle.right < right) next.push({ ...area, x: obstacle.right, width: right - obstacle.right });
      if (obstacle.top > area.y) next.push({ ...area, height: obstacle.top - area.y });
      if (obstacle.bottom < bottom) next.push({ ...area, y: obstacle.bottom, height: bottom - obstacle.bottom });
    }
    candidates = next;
    if (!candidates.length) return { x: margin, y: top, width: 0, height: 0 };
  }
  const fit = contentSize && Number.isFinite(contentSize.width) && contentSize.width > 0 && Number.isFinite(contentSize.height) && contentSize.height > 0
    ? area => Math.min(area.width / contentSize.width, area.height / contentSize.height) : () => 0;
  return candidates.sort((a, b) => fit(b) - fit(a) || b.width * b.height - a.width * a.height || b.width - a.width)[0];
}

/** Find a nearby empty rectangle without moving existing canvas content. */
export function findFreePosition(occupied, size, preferred, gap = 36) {
  const limit = 1e7;
  preferred = { x: Math.max(-limit, Math.min(limit - size.width, preferred.x)), y: Math.max(-limit, Math.min(limit - size.height, preferred.y)) };
  const overlaps = point => occupied.some(rect => point.x < rect.x + rect.width + gap && point.x + size.width + gap > rect.x && point.y < rect.y + rect.height + gap && point.y + size.height + gap > rect.y);
  if (!overlaps(preferred)) return { ...preferred };
  const candidates = [];
  const seen = new Set();
  const add = (x, y) => {
    if (x < -limit || y < -limit || x + size.width > limit || y + size.height > limit) return;
    const key = `${x},${y}`;
    if (!seen.has(key)) { seen.add(key); candidates.push({ x, y }); }
  };
  for (const rect of occupied) {
    const left = rect.x - size.width - gap, right = rect.x + rect.width + gap;
    const above = rect.y - size.height - gap, below = rect.y + rect.height + gap;
    add(left, preferred.y); add(right, preferred.y);
    add(preferred.x, above); add(preferred.x, below);
    add(left, rect.y); add(right, rect.y);
    add(rect.x, above); add(rect.x, below);
  }
  // Imported canvases may sit at a coordinate boundary. Include a central
  // fallback so a new node never becomes impossible to restore after saving.
  add(0, 0);
  candidates.sort((a, b) => Math.hypot(a.x - preferred.x, a.y - preferred.y) - Math.hypot(b.x - preferred.x, b.y - preferred.y));
  // At least the candidate to the right of the furthest edge is unobstructed.
  return candidates.find(point => !overlaps(point));
}

/** Place a connected fragment as one box so relative positions remain intact. */
export function placeFragment(rectangles, occupied, preferred, gap = 36) {
  if (!rectangles.length) return [];
  const minX = Math.min(...rectangles.map(rect => rect.x));
  const minY = Math.min(...rectangles.map(rect => rect.y));
  const width = Math.max(...rectangles.map(rect => rect.x + rect.width)) - minX;
  const height = Math.max(...rectangles.map(rect => rect.y + rect.height)) - minY;
  const point = findFreePosition(occupied, { width, height }, preferred || { x: minX, y: minY }, gap);
  return rectangles.map(rect => ({ ...rect, x: rect.x + point.x - minX, y: rect.y + point.y - minY }));
}
