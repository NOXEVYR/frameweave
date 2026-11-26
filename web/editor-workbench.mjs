// Native disclosures own their keyboard focus. The canvas only handles gestures
// inside the drawing surface, so a command never starts a drag or zoom.
export function installWorkbenchCommands({ active, save, saved, reportError, switchTab }) {
  const find = selector => document.querySelector(selector);
  const saveButton = find('#save-version');
  let saving = false;
  async function saveVersion() {
    if (saving || !active()) return;
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = '正在保存…';
    try {
      if (await save()) saved();
    } catch (error) { reportError(error); }
    finally {
      saving = false;
      saveButton.disabled = false;
      saveButton.textContent = '保存版本';
    }
  }
  saveButton.addEventListener('click', saveVersion);
  const openMenus = () => Array.from(document.querySelectorAll('details[data-command-menu][open]'));
  const close = (menu, focus = false) => {
    menu.open = false;
    if (focus) menu.querySelector('summary')?.focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', event => {
    for (const menu of openMenus()) if (!menu.contains(event.target)) close(menu);
  }, true);
  document.addEventListener('toggle', event => {
    const target = event.target;
    if (!target.matches?.('details[data-command-menu][open]')) return;
    for (const menu of openMenus()) if (menu !== target) close(menu);
  }, true);
  document.addEventListener('click', event => {
    const command = event.target.closest('details[data-command-menu] button');
    if (!command || command.disabled) return;
    const menu = command.closest('details');
    queueMicrotask(() => close(menu, document.activeElement === command));
  }, true);
  const closeInspector = () => {
    const toggle = find('#toggle-inspector');
    if (document.body.classList.contains('inspector-open')) toggle.click();
    toggle.focus();
  };
  find('#close-inspector').addEventListener('click', closeInspector);
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229 || find('dialog[open]')) return;
    if (event.key === 'Escape') {
      const menu = openMenus().at(-1);
      if (menu) { event.preventDefault(); event.stopPropagation(); close(menu, true); }
      else if (event.target.closest('#editor-inspector')) { event.preventDefault(); event.stopPropagation(); closeInspector(); }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's' && active()) {
      event.preventDefault();
      if (!event.repeat) saveVersion();
    }
  }, true);
  const tabs = [find('#tab-properties'), find('#tab-jobs')];
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('keydown', event => {
      const next = { ArrowLeft: 1-index, ArrowRight: 1-index, Home: 0, End: 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      switchTab(next ? 'jobs' : 'properties');
      tabs[next].focus();
    });
  }
}
