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
