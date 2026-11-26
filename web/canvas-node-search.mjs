/** A short-lived, local index. Never serializes a canvas or calls the backend. */
export function indexCanvasNodes(nodes) {
  return nodes.map(node => {
    const data = node.data || {}, title = String(data.title || '未命名节点');
    const text = [data.text, data.positive, data.negative,
      ...(data.packageFields || []).filter(field => field.type === 'text').map(field => data.packageValues?.[field.id])]
      .filter(value => typeof value === 'string' && value).join('\n');
    return { node, title, text, searchable: `${title}\n${text}`.toLowerCase() };
  });
}

export function findCanvasNodes(index, query) {
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.length ? index.filter(row => terms.every(term => row.searchable.includes(term))) : index;
}

const MAX_VISIBLE = 100;
/** Owns only the search dialog; selection and navigation remain with the host. */
export function createCanvasNodeSearch(host, { document = globalThis.document, Observer = globalThis.MutationObserver } = {}) {
  const el = (tag, cls, text) => {
    const item = document.createElement(tag); if (cls) item.className = cls;
    if (text !== undefined) item.textContent = text; return item;
  };
  const dialog = el('dialog', 'modal canvas-node-search'); dialog.id = 'canvas-node-search-dialog';
  dialog.setAttribute('aria-labelledby', 'canvas-node-search-title');
  const heading = el('div', 'modal-heading'), title = el('h2', '', '查找节点'); title.id = 'canvas-node-search-title';
  const dismiss = el('button', 'close-button', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', '关闭节点查找');
  heading.append(title, dismiss);
  const label = el('label', 'field'), input = el('input'); input.id = 'canvas-node-search-input'; input.type = 'search';
  input.maxLength = 120; input.autocomplete = 'off'; input.spellcheck = false;
  input.placeholder = '搜索标题或提示词，支持中文'; input.setAttribute('aria-label', '搜索当前画布节点标题或提示词');
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-controls', 'canvas-node-search-results');
  label.append(input);
  const status = el('p', 'form-note'); status.id = 'canvas-node-search-status'; status.setAttribute('role', 'status');
  const list = el('div', 'canvas-node-search-results'); list.id = 'canvas-node-search-results'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '匹配节点');
  const pages = el('div', 'modal-actions'); pages.setAttribute('role', 'group'); pages.setAttribute('aria-label', '节点查找结果分页');
  const previous = el('button', 'button quiet compact', '上一页'), next = el('button', 'button quiet compact', '下一页');
  previous.id = 'canvas-node-search-previous'; next.id = 'canvas-node-search-next'; previous.type = next.type = 'button';
  pages.append(previous, next);
  dialog.append(heading, label, status, list, pages, el('p', 'field-help', '↑ ↓ 选择（可跨页） · Enter 定位 · Esc 返回画布'));
  document.body.append(dialog);
  let ticket = null, index = [], matches = [], buttons = [], active = 0, page = 0, total = 0, composing = false, previousFocus = null, observer = null;
  const current = () => {
    const now = host.read();
    return !!ticket && now.active && now.identity === ticket.identity && now.graph === ticket.graph;
  };
  function close({ restoreFocus = true } = {}) {
    const restore = restoreFocus && current() && previousFocus?.isConnected;
    ticket = null; index = []; matches = []; buttons = []; composing = false; page = 0; total = 0;
    observer?.disconnect(); observer = null;
    list.replaceChildren(); input.removeAttribute('aria-activedescendant'); input.setAttribute('aria-expanded', 'false');
    if (dialog.open) dialog.close();
    if (restore) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function checkContext() { if (ticket && !current()) close({ restoreFocus: false }); return !!ticket; }
  function choose(position) {
    if (composing) return;
    const row = matches[position], owner = ticket;
    if (!current() || !row || owner.graph.nodes.find(node => node.id === row.node.id) !== row.node) {
      close({ restoreFocus: false }); host.onStale?.(); return;
    }
    close({ restoreFocus: false });
    try { host.onSelect(row.node, owner); } catch (error) { host.reportError?.(error); }
  }
  function highlight(position, scroll = false) {
    active = Math.max(0, Math.min(buttons.length - 1, position));
    buttons.forEach((button, i) => { button.setAttribute('aria-selected', String(i === active)); button.classList.toggle('active', i === active); });
    if (buttons[active]) { input.setAttribute('aria-activedescendant', buttons[active].id); if (scroll) buttons[active].scrollIntoView?.({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }
  function render({ resetPage = true } = {}) {
    if (!checkContext() || composing) return;
    const found = findCanvasNodes(index, input.value); total = found.length;
    page = resetPage ? 0 : Math.min(page, Math.max(0, Math.ceil(total / MAX_VISIBLE) - 1));
    const offset = page * MAX_VISIBLE; matches = found.slice(offset, offset + MAX_VISIBLE);
    status.textContent = !found.length ? '没有匹配的节点，试试其他标题或提示词。'
      : `找到 ${total} 个节点 · 显示 ${offset + 1}–${offset + matches.length}`;
    pages.hidden = total <= MAX_VISIBLE; previous.disabled = page === 0; next.disabled = offset + MAX_VISIBLE >= total;
    const term = input.value.trim().toLowerCase().split(/\s+/)[0];
    buttons = matches.map((row, i) => {
      const button = el('button', 'canvas-node-search-result'); button.type = 'button'; button.id = `canvas-node-search-option-${i}`;
      button.tabIndex = -1; button.setAttribute('role', 'option');
      const at = term ? row.text.toLowerCase().indexOf(term) : 0, start = Math.max(0, at - 35);
      const excerpt = row.text.slice(start, start + 140).replace(/\s+/g, ' ');
      button.append(el('strong', '', row.title), el('span', '', excerpt ? `${start ? '…' : ''}${excerpt}${row.text.length > start + 140 ? '…' : ''}` : '无提示词正文'));
      button.addEventListener('click', () => { if (matches[i] === row) choose(i); }); return button;
    });
    list.replaceChildren(...buttons); list.scrollTop = 0; highlight(0);
  }
  function turnPage(direction) {
    if (composing || !checkContext() || (direction < 0 && page === 0) || (direction > 0 && (page + 1) * MAX_VISIBLE >= total)) return;
    page += direction; render({ resetPage: false }); input.focus();
  }
  previous.addEventListener('click', () => turnPage(-1)); next.addEventListener('click', () => turnPage(1));
  dismiss.addEventListener('click', () => { if (!composing) close(); });
  input.addEventListener('input', render);
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; render(); });
  dialog.addEventListener('keydown', event => {
    if (event.isComposing || composing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.target === input && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'ArrowDown' && active === buttons.length - 1 && (page + 1) * MAX_VISIBLE < total) turnPage(1);
      else if (event.key === 'ArrowUp' && active === 0 && page > 0) { turnPage(-1); highlight(buttons.length - 1, true); }
      else highlight(active + (event.key === 'ArrowDown' ? 1 : -1), true);
    }
    else if (event.target === input && event.key === 'Enter') { event.preventDefault(); if (matches.length) choose(active); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!composing) close(); });
  dialog.addEventListener('close', () => { if (!dialog.open && ticket) close(); });
  return {
    open() {
      const now = host.read(); if (!now.active || document.querySelector('dialog[open]')) return false;
      previousFocus = document.activeElement; ticket = now; composing = false; input.value = '';
      index = indexCanvasNodes(now.graph.nodes); render(); dialog.showModal(); input.setAttribute('aria-expanded', 'true'); input.focus();
      if (typeof Observer === 'function') { observer = new Observer(checkContext); observer.observe(document.body, { attributes: true, attributeFilter: ['data-workspace', 'data-canvas-view'] }); }
      return true;
    },
    close, checkContext,
  };
}
