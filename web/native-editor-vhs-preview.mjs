/** Versioned, fail-closed adapter for the observed VHS input-video preview. */
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fingerprint(fn) {
  if (typeof fn !== 'function') return '';
  let hash = 2166136261;
  for (const char of Function.prototype.toString.call(fn).replace(/\s/g, '')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash.toString(16);
}
function replaceable(owner, name) {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  return Object.isExtensible(owner) && (!descriptor || descriptor.configurable && own(descriptor, 'value'));
}

export function vhsPreviewProfile(node) {
  if ((node?.comfyClass || node?.type) !== 'VHS_LoadVideo') return null;
  const matches = (node.widgets || []).filter(widget => widget.name === 'videopreview');
  if (matches.length !== 1) return null;
  const widget = matches[0], { element, parentEl, videoEl, imgEl } = widget;
  if (widget.type !== 'preview' || widget.options?.serialize !== false || !record(widget.value?.params) ||
      element?.tagName !== 'DIV' || parentEl?.tagName !== 'DIV' || parentEl.className !== 'vhs_preview' ||
      videoEl?.tagName !== 'VIDEO' || imgEl?.tagName !== 'IMG' || parentEl.parentElement !== element ||
      videoEl.parentElement !== parentEl || imgEl.parentElement !== parentEl || widget.callback !== widget.updateSource ||
      fingerprint(node.updateParameters) !== 'e505a198' || fingerprint(widget.updateSource) !== '9acd0230') return null;
  return { version: 'vhs-input-video-1', node, widget, element, parentEl, videoEl, imgEl };
}

/** Presentation-only guard. The caller must prove the plugin profile first.
 * Exported separately so portable tests exercise our lifecycle without copying
 * the third-party GPL plugin implementation into this project.
 */
export function isolateVhsPreviewSurface(profile, window) {
  const { node, widget, element, parentEl, videoEl, imgEl } = profile;
  const fields = [[widget, 'updateSource'], [widget, 'callback'], [node, 'updateParameters'],
    [node, 'video_query'], [parentEl, 'hidden'], [videoEl, 'src'], [imgEl, 'src'], [videoEl, 'autoplay']];
  const methods = [[videoEl, 'setAttribute'], [imgEl, 'setAttribute']];
  if (typeof window?.setTimeout !== 'function' || typeof window?.clearTimeout !== 'function' ||
      fields.concat(methods).some(([owner, name]) => !replaceable(owner, name)) ||
      typeof videoEl.pause !== 'function' || typeof videoEl.load !== 'function' ||
      [videoEl, imgEl].some(el => typeof el.removeAttribute !== 'function' || typeof el.setAttribute !== 'function')) return null;
  const saved = [], installed = [];
  let released = false, timer;
  function define(owner, name, descriptor) {
    saved.push([owner, name, Object.getOwnPropertyDescriptor(owner, name)]);
    Object.defineProperty(owner, name, { configurable: true, enumerable: false, ...descriptor });
    installed.push([owner, name, Object.getOwnPropertyDescriptor(owner, name)]);
  }
  const same = (a, b) => a?.value === b?.value && a?.get === b?.get && a?.set === b?.set;
  function restore() {
    for (let index = saved.length - 1; index >= 0; index--) {
      const [owner, name, descriptor] = saved[index], proof = installed[index][2];
      if (!same(Object.getOwnPropertyDescriptor(owner, name), proof)) continue;
      if (descriptor) Object.defineProperty(owner, name, descriptor); else delete owner[name];
    }
  }
  try {
    const suppress = () => undefined;
    define(widget, 'updateSource', { writable: true, value: suppress });
    define(widget, 'callback', { writable: true, value: suppress });
    // Retain the original parameter updater: force the synchronous guarded
    // source path, so it clears its private debounce and schedules no new timer.
    const update = node.updateParameters;
    define(node, 'updateParameters', { writable: true, value: function (params) { return update.call(this, params, true); } });
    define(node, 'video_query', { get: () => undefined, set() {} });
    define(parentEl, 'hidden', { get: () => true, set() {} });
    define(videoEl, 'autoplay', { get: () => false, set() {} });
    for (const media of [videoEl, imgEl]) {
      define(media, 'src', { get: () => '', set() {} });
      const setAttribute = media.setAttribute;
      define(media, 'setAttribute', { writable: true, value: function (name, value) {
        if (String(name).toLowerCase() !== 'src') return setAttribute.call(this, name, value);
      } });
      media.removeAttribute('src');
    }
    videoEl.pause(); videoEl.load();
  } catch { restore(); return null; }
  return {
    version: profile.version,
    verify() {
      return !released && (node.widgets || []).filter(item => item.name === 'videopreview').length === 1 &&
        node.widgets.includes(widget) && widget.element === element && parentEl.parentElement === element &&
        widget.parentEl === parentEl && widget.videoEl === videoEl && widget.imgEl === imgEl &&
        videoEl.parentElement === parentEl && imgEl.parentElement === parentEl &&
        installed.every(([owner, name, proof]) => same(Object.getOwnPropertyDescriptor(owner, name), proof));
    },
    // Keep the barrier while the observed 100ms private debounce drains. A
    // removed node remains guarded until re-add, never just until onRemoved.
    release(immediate = false) {
      if (released) return; released = true;
      videoEl.pause(); videoEl.removeAttribute('src'); videoEl.load(); imgEl.removeAttribute('src');
      if (immediate) restore(); else timer = window.setTimeout(restore, 110);
    },
    cancelRelease() { if (timer !== undefined) window.clearTimeout(timer); released = false; },
  };
}
