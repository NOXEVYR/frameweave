const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function panelLayout(canvas, anchor, area, height = 240) {
  if (![canvas?.left, canvas?.top, canvas?.width, canvas?.height, anchor?.left, anchor?.right, anchor?.top, anchor?.bottom].every(Number.isFinite) || canvas.width <= 0 || canvas.height <= 0 || anchor.right <= anchor.left || anchor.bottom <= anchor.top) return { reason: 'unavailable' };
  const box = area || { x: 12, y: 12, width: canvas.width - 24, height: canvas.height - 24 };
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) return { reason: 'unavailable' };
  const left = Math.max(0, box.x), top = Math.max(0, box.y);
  const right = Math.min(canvas.width, box.x + box.width), bottom = Math.min(canvas.height, box.y + box.height);
  if (right <= left || bottom <= top) return { reason: 'unavailable' };
  const owner = { left: anchor.left - canvas.left, right: anchor.right - canvas.left, top: anchor.top - canvas.top, bottom: anchor.bottom - canvas.top };
  if (owner.right <= left || owner.left >= right || owner.bottom <= top || owner.top >= bottom) return { reason: 'offscreen' };
  const desiredHeight = Math.min(440, Math.max(240, Number.isFinite(height) && height > 0 ? height : 240));
  const below = bottom - Math.max(top, owner.bottom + 12), above = Math.min(bottom, owner.top - 12) - top;
  // A small scrollable panel is useful, but a heading-only strip is not. If
  // neither side has room, use the existing sidebar instead of covering its owner.
  const minimumHeight = 160;
  const side = below >= desiredHeight ? 'below' : above >= desiredHeight ? 'above' : below >= above ? 'below' : 'above';
  const maxHeight = Math.min(440, side === 'below' ? below : above);
  if (maxHeight < minimumHeight) return { reason: 'space' };
  const width = Math.min(825, right - left), displayedHeight = Math.min(maxHeight, desiredHeight);
  return { side, position: { left: clamp((owner.left + owner.right) / 2 - width / 2, left, right - width),
    top: side === 'below' ? Math.max(top, owner.bottom + 12) : Math.min(bottom, owner.top - 12) - displayedHeight, width, maxHeight } };
}

/** Screen coordinates only: never cover the visible owner or shrink parameter text. */
export function nodeParameterPanelPosition(canvas, anchor, area, height = 240) {
  return panelLayout(canvas, anchor, area, height).position || null;
}

/** Owns placement and the original inspector DOM, never parameter values. */
export function createNodeParameterPanel({ canvas, content, area, onDock = () => {}, schedule = globalThis.requestAnimationFrame, observe = globalThis.ResizeObserver }) {
  const document = content.ownerDocument, home = content.parentNode, next = content.nextSibling;
  const view = document.defaultView;
  const root = document.createElement('section'); root.id = 'node-parameter-panel'; root.className = 'node-parameter-panel'; root.hidden = true;
  root.setAttribute('aria-label', '选中节点参数');
  const heading = document.createElement('div'); heading.className = 'node-parameter-panel-heading';
  const name = document.createElement('strong'); name.id = 'node-parameter-panel-title'; root.setAttribute('aria-labelledby', name.id);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'button quiet compact'; close.textContent = '在侧栏编辑'; close.dataset.parameterPanelDock = '';
  heading.append(name, close); root.append(heading); canvas.append(root);
  let owner = null, anchor = null, requested = null, suppressed = null, pending = null, restoreRequested = false, layoutRequested = false, frame = false, destroyed = false, pressed = null;
  const composing = new Set();
  const interacting = () => composing.size > 0 || pressed !== null;
  const contains = target => !!target && content.contains(target);
  const editing = () => contains(document.activeElement) && document.activeElement?.matches?.('input,textarea,select,button,a,summary,video,audio,[contenteditable=true]');
  const blocked = () => interacting() || editing();
  const tick = callback => { if (typeof schedule === 'function') schedule(callback); else queueMicrotask(callback); };
  function flush() {
    if (destroyed || interacting()) return;
    if (restoreRequested) { restoreRequested = false; restore(); root.hidden = true; observer?.disconnect(); }
    if (pending && (!editing() || pending.compositionOnly)) { const { callback } = pending; pending = null; callback(); }
    if (layoutRequested) refresh();
  }
  const resume = () => { if (!destroyed) tick(flush); };
  // Blur cannot prove that an IME session has ended. Keep the original visible
  // control until its actual compositionend, including a cancelled composition.
  const focusOut = resume;
  function refreshNow() {
    frame = false;
    if (destroyed) return;
    if (interacting()) { layoutRequested = true; return; }
    layoutRequested = false;
    if (!requested || !owner || suppressed === owner) return;
    root.dataset.nodeId = requested.nodeId || ''; name.textContent = requested.label || '节点参数';
    if (!anchor?.getClientRects?.().length || !canvas.getClientRects?.().length) { restore(); root.hidden = true; observer?.disconnect(); return; }
    const canvasRect = canvas.getBoundingClientRect(), anchorRect = anchor.getBoundingClientRect(), usable = area?.();
    let { position, side, reason } = panelLayout(canvasRect, anchorRect, usable, root.offsetHeight);
    if (!position) {
      if (reason === 'space') { dock('space'); return; }
      restore(); root.hidden = true;
      if (reason !== 'offscreen') observer?.disconnect();
      return;
    }
    root.style.width = `${position.width}px`; root.style.maxHeight = `${position.maxHeight}px`;
    root.dataset.compact = String(position.maxHeight < 240); root.dataset.placement = side;
    root.style.left = `${position.left}px`; root.style.top = `${position.top}px`;
    root.hidden = false;
    if (content.parentNode !== root) root.append(content);
    // A newly hosted subtree can be taller than the empty heading. Re-measure
    // before paint, especially above the card, so its real bottom never covers it.
    ({ position, side } = panelLayout(canvasRect, anchorRect, usable, root.offsetHeight));
    root.style.maxHeight = `${position.maxHeight}px`; root.style.top = `${position.top}px`;
    root.dataset.compact = String(position.maxHeight < 240); root.dataset.placement = side;
  }
  function refresh() { if (frame || destroyed) return; frame = true; tick(refreshNow); }
  const observer = typeof observe === 'function' ? new observe(refresh) : null;
  function restore() { if (content.parentNode !== home) home.insertBefore(content, next?.parentNode === home ? next : null); }
  function hide({ dismiss = false } = {}) {
    if (destroyed) return false;
    if (dismiss) suppressed = owner;
    requested = null; layoutRequested = false;
    if (interacting()) { restoreRequested = true; return false; }
    restoreRequested = false; restore(); root.hidden = true; observer?.disconnect(); return true;
  }
  function sync({ token, nodeId, label, card, enabled = true }) {
    if (destroyed) return;
    if (owner !== token) { owner = token; suppressed = null; pending = null; }
    anchor = card;
    if (!enabled || !token || !card || suppressed === token) { hide(); return; }
    requested = { nodeId, label }; restoreRequested = false;
    observer?.disconnect(); observer?.observe(card); observer?.observe(root); refresh();
  }
  const startComposition = event => { if (!destroyed && contains(event.target)) composing.add(event.target); };
  const endComposition = event => { composing.delete(event.target); resume(); };
  const press = event => { if (event.button === 0) pressed = event.pointerId; };
  const release = event => { if (pressed !== null && (event?.pointerId == null || event.pointerId === pressed)) { pressed = null; resume(); } };
  content.addEventListener('compositionstart', startComposition, true); content.addEventListener('compositionend', endComposition, true);
  content.addEventListener('focusout', focusOut, true); content.addEventListener('pointerdown', press, true);
  root.addEventListener('pointerdown', press, true);
  document.addEventListener('pointerup', release, true); document.addEventListener('pointercancel', release, true);
  view?.addEventListener('blur', release, true);
  const stop = event => event.stopPropagation();
  // keyup reaches the existing canvas cleanup for a Space press begun outside.
  for (const type of ['pointerdown', 'wheel', 'dblclick', 'contextmenu', 'keydown', 'dragover', 'drop']) root.addEventListener(type, stop);
  function dock(reason = 'manual') {
    if (destroyed) return;
    if (interacting()) { pending = { callback: () => dock(reason), compositionOnly: true }; return; }
    if (hide({ dismiss: true })) onDock({ reason });
  }
  close.addEventListener('click', () => dock());
  return { root, refresh, sync, hide, dock, suspend: () => hide(), contains, blocked, isComposing: () => composing.size > 0,
    defer(callback, { compositionOnly = false } = {}) { pending = { callback, compositionOnly }; resume(); },
    finishEditing() { if (composing.size) return false; if (contains(document.activeElement)) document.activeElement.blur?.(); return true; },
    reset() { pending = null; suppressed = null; pressed = null; owner = null; anchor = null; hide(); root.dataset.nodeId = ''; },
    destroy() { if (destroyed) return; composing.clear(); pressed = null; pending = null; hide(); destroyed = true; observer?.disconnect();
      content.removeEventListener('compositionstart', startComposition, true); content.removeEventListener('compositionend', endComposition, true);
      content.removeEventListener('focusout', focusOut, true); content.removeEventListener('pointerdown', press, true);
      root.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerup', release, true); document.removeEventListener('pointercancel', release, true); view?.removeEventListener('blur', release, true); root.remove(); }
  };
}
