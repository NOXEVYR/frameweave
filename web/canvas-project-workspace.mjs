import { createProjectCatalog } from './canvas-project-catalog.mjs';
import { installProjectHistory } from './canvas-version-history.mjs';
import { createCanvasManager } from './canvas-manager.mjs';
import { canvasProjectName, createCanvasProjectSession } from './canvas-project-session.mjs';
import { frameDialog } from './workspace-tools.mjs';

const element = (tag, className = '', text) => {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function createCanvasProjectWorkspace(host) {
  const root = element('section'); root.id = 'canvas-manager'; root.hidden = true;
  document.querySelector('.workbench').append(root);
  const dialog = element('dialog', 'modal canvas-switch-modal'); dialog.id = 'canvas-switch-dialog';
  dialog.setAttribute('aria-label', '保留当前画布编辑');
  const heading = element('div', 'modal-heading'); heading.append(element('h2', '', '切换前保留当前编辑'));
  const explanation = element('p', 'muted', '当前内容已在浏览器草稿中编辑。可先保存一个命名版本再继续，明确放弃这些编辑，或取消切换。已有保存版本始终保留。');
  const field = element('label', 'field'), name = element('input'); name.id = 'canvas-switch-name'; name.required = true;
  name.maxLength = 120; name.setAttribute('aria-label', '当前画布的保存版本名称'); field.append(element('span', '', '保存版本名称'), name);
  const status = element('p', 'form-note'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const actions = element('div', 'modal-actions wrap-actions'); let pending = null, composing = false;
  const inputReady = () => {
    if (!composing) return true;
    status.textContent = '请先完成输入法编辑，再选择如何切换。'; return false;
  };
  function finish(choice) {
    if (!pending) return;
    const resolve = pending; pending = null; dialog.close(); resolve(choice);
  }
  function button(text, id, action, cls = 'button quiet') {
    const node = element('button', cls, text); node.type = 'button'; node.id = id;
    node.addEventListener('click', action); return node;
  }
  actions.append(button('取消切换', 'canvas-switch-cancel', () => { if (inputReady()) finish({ action: 'cancel' }); }),
    button('放弃当前编辑并继续', 'canvas-switch-discard', () => { if (inputReady()) finish({ action: 'discard' }); }),
    button('保存新版本并继续', 'canvas-switch-save', () => {
      if (!inputReady()) return;
      try { const title = canvasProjectName(name.value); finish({ action: 'save', name: title }); }
      catch (error) { status.textContent = error.message; name.focus(); }
    }, 'button primary'));
  name.addEventListener('compositionstart', () => { composing = true; });
  name.addEventListener('compositionend', () => { composing = false; });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) finish({ action: 'cancel' }); });
  dialog.addEventListener('close', () => { if (!dialog.open) finish({ action: 'cancel' }); });
  dialog.append(heading, explanation, field, status, actions); document.body.append(dialog); frameDialog(dialog);
  let manager;
  const showEditor = () => {
    document.body.dataset.canvasView = 'editor'; manager.close(); host.onEditor?.();
    window.dispatchEvent(new Event('resize'));
  };
  const showManagement = async () => {
    host.onManagement?.(); document.body.dataset.canvasView = 'management';
    window.dispatchEvent(new Event('resize')); await manager.open();
  };
  const session = createCanvasProjectSession({ ...host,
    async confirmSwitch({ title }) {
      if (pending) throw new Error('请先完成当前画布切换选择');
      name.value = title || ''; status.textContent = ''; composing = false;
      return new Promise(resolve => { pending = resolve; dialog.showModal(); name.focus(); });
    },
    showEditor,
    showManagement,
    onStateChange(state) { manager?.updateCurrent(); host.onStateChange?.(state); },
  });
  const catalog = createProjectCatalog(host.api);
  manager = createCanvasManager({ root, host: {
    listProjects: () => catalog.list(),
    readCurrent() {
      const state = session.readCurrent();
      return { ...state, preview: state.active && !root.hidden ? host.draftPreview?.() : null };
    },
    onContinue: () => session.continue(),
    onCreate: () => session.create('未命名画布', { preserveDraft: true }),
    onOpen: (projectId, versionId) => session.open(versionId || projectId, { preserveDraft: true }),
    changeVersion: (...args) => session.changeVersion(...args),
    reportError: host.reportError,
  } });
  installProjectHistory({ session, catalog, reportError: host.reportError });
  const back = button('← 我的画布', 'canvas-back-to-manager', () => session.showManagement().catch(host.reportError), 'button quiet compact');
  document.querySelector('.project-actions').prepend(back);
  return { session, showEditor, open: () => session.showManagement(), openInitial: showManagement,
    update: () => session.update(), manager };
}
