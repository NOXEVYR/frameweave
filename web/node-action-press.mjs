/** Preserve only the live card of a mouse/touch button press until activation. */
export function createNodeActionPress({ isCurrent }) {
  let pressed = null;
  return {
    begin(button, card, node, pointerId) {
      pressed = !button.disabled && isCurrent(node) ? { button, card, node, pointerId, released: false, activated: false } : null;
      return !!pressed;
    },
    preserves(card, node) {
      return !!pressed && pressed.card === card && pressed.node === node && isCurrent(node);
    },
    release(pointerId, target) {
      if (!pressed || pressed.pointerId !== pointerId) return false;
      if (!pressed.button.disabled && isCurrent(pressed.node) && pressed.button.contains(target)) {
        // Browser click follows pointerup. Keep the same DOM for that click;
        // do not refresh in a pointerup microtask and detach its target.
        pressed.released = true; return false;
      }
      pressed = null; return true;
    },
    cancel(pointerId = null) {
      if (!pressed || pointerId !== null && pressed.pointerId !== pointerId) return false;
      pressed = null; return true;
    },
    activate(button, node, keyboard = false) {
      if (button.disabled || !isCurrent(node)) { pressed = null; return false; }
      if (keyboard) { pressed = null; return true; }
      if (!pressed || pressed.button !== button || pressed.node !== node || !pressed.released || pressed.activated) return false;
      pressed.activated = true; return true;
    },
    finish(button) {
      if (!pressed || pressed.button !== button) return false;
      pressed = null; return true;
    },
  };
}
