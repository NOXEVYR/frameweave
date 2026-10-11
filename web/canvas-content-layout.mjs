/** Local presentation growth only. Existing overlaps and manual coordinates
 * are not an invitation to arrange the canvas. Solve a whole batch before
 * returning any positions, including all downstream collision chains. */
export function contentGrowthPositions(before, current, gap = 36) {
  const originals = new Map(before.map(rect => [rect.id, rect]));
  const blockers = [], positions = [];
  for (const rect of [...current].sort((a, b) => a.y - b.y || String(a.id).localeCompare(String(b.id)))) {
    const old = originals.get(rect.id) || rect;
    const growing = rect.height > old.height + .5;
    let y = rect.y;
    let previous;
    do {
      previous = y;
      for (const blocker of blockers) {
        // Preserve intentional old overlap. Only the formerly separate card
        // below this blocker can be displaced by its newly occupied space.
        if (old.y < blocker.old.y + blocker.old.height ||
            rect.x >= blocker.x + blocker.width || rect.x + rect.width <= blocker.x) continue;
        if (y < blocker.y + blocker.height + gap && y + rect.height > blocker.y)
          y = Math.max(y, Math.ceil(blocker.y + blocker.height + gap));
      }
      // A later branch can push this card into an earlier, displaced blocker.
      // y only advances to one of the finite blocker bottoms, so this pure
      // solve terminates without scheduling another DOM/resize pass.
    } while (y !== previous);
    if (y > 1e7) throw new Error('内容增高后空间不足，请先将此处节点移离画布坐标边界');
    if (y !== rect.y) positions.push({ id: rect.id, x: rect.x, y });
    if (growing || y !== rect.y) blockers.push({ ...rect, y, old });
  }
  return positions;
}

/** DOM ownership stays with the caller. Measurements survive card replacement,
 * but never cross canvas/node identity. Busy editing defers observation without
 * a polling loop; the caller resumes it after the gesture ends. */
export function createContentLayout({ read, identity, apply, commit, busy, onError, schedule, observe }) {
  let baselines = new Map(), canvasIdentity = null, synchronous = false, pending = false, queued = false;
  const observer = observe(() => request());
  let elements = new Set();
  const accept = rectangles => {
    baselines = new Map(rectangles.map(rect => [rect.id, { node: rect.node, width: rect.width, height: rect.height }]));
    const next = new Set(rectangles.map(rect => rect.element).filter(Boolean));
    for (const element of elements) if (!next.has(element)) observer.unobserve(element);
    for (const element of next) if (!elements.has(element)) observer.observe(element);
    elements = next;
  };
  const measure = () => {
    const nextIdentity = identity();
    if (canvasIdentity !== nextIdentity) { baselines.clear(); canvasIdentity = nextIdentity; }
    return read().filter(rect => rect.width > 0 && rect.height > 0);
  };
  function reconcile() {
    if (!synchronous && busy()) { pending = true; return; }
    pending = false;
    const rectangles = measure();
    // Rebase coordinates on the live graph, never the coordinates of a queued
    // observer notification. This protects a drag completed before this pass.
    const before = rectangles.map(rect => {
      const old = baselines.get(rect.id);
      // A synchronous interface transaction may replace the whole graph with
      // its validated clone. Stable IDs retain their measurements only inside
      // that transaction and canvas identity; asynchronous replacements do not.
      return old && (old.node === rect.node || synchronous)
        ? { ...rect, width: old.width, height: old.height } : rect;
    });
    try {
      const positions = contentGrowthPositions(before, rectangles);
      if (positions.length) {
        const previous = positions.map(position => {
          const rect = rectangles.find(item => item.id === position.id);
          return { id: rect.id, x: rect.x, y: rect.y };
        });
        apply(positions);
        if (!synchronous) commit(previous);
      }
      accept(rectangles);
    } catch (error) {
      if (synchronous) throw error;
      // Backend content is factual and cannot be rolled back. Accept its size
      // after a failed atomic plan so repeated notifications do not spam/retry.
      accept(rectangles); onError(error);
    }
  }
  function request() {
    pending = true;
    if (queued || synchronous || busy()) return;
    queued = true;
    schedule(() => { queued = false; if (pending) reconcile(); });
  }
  return {
    begin() { synchronous = true; },
    end() { synchronous = false; },
    rendered: reconcile,
    resume() { if (pending) request(); },
    reset() { baselines.clear(); canvasIdentity = null; pending = false; },
    captureViewChange() {
      const growth = measure().flatMap(rect => {
        const old = baselines.get(rect.id);
        return old && (old.node === rect.node || synchronous) && rect.height > old.height + .5
          ? [{ id: rect.id, node: rect.node, height: rect.height - old.height }] : [];
      });
      return { identity: canvasIdentity, growth };
    },
    rebase(viewBefore) {
      const rectangles = measure();
      pending = false; accept(rectangles);
      // Absorb only the size change caused by zoom. Content that grew before
      // the view changed still needs room after an active edit/drag finishes.
      // Capture and rebase run synchronously on either side of the CSS change.
      if (viewBefore?.identity !== canvasIdentity) return;
      for (const growth of viewBefore.growth) {
        const current = baselines.get(growth.id);
        if (current?.node !== growth.node) continue;
        current.height -= growth.height; pending = true;
      }
      if (pending) request();
    },
    destroy() { observer.disconnect(); baselines.clear(); elements.clear(); pending = false; },
  };
}
