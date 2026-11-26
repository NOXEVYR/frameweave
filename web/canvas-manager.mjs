import { renderCanvasPreview } from './canvas-preview.mjs';
import { createCardActions, getCardPreferences } from './canvas-card-actions.mjs';

const element = (tag, className = '', text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const validCount = value => Number.isSafeInteger(value) && value >= 0;
function checkedProjects(items) {
  if (!Array.isArray(items)) throw new Error('画布列表无效');
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
        typeof item.name !== 'string' || !item.name.trim() || !Number.isFinite(item.updatedAt) ||
        item.updatedAt <= 0 || !Number.isFinite(new Date(item.updatedAt * 1000).getTime()) || !validCount(item.nodeCount)) throw new Error('画布列表无效');
    ids.add(item.id);
  }
  return items.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createCanvasManager({ root, host }) {
  if (!root || !host) throw new Error('画布首页缺少容器或接口');
  let projects = [], revision = 0, loading = false, pending = false, composing = false, loaded = false, readFailed = false, committedSearch = '', unreadable = 0;
  const controls = new Set(), cardControls = new Set();
  const current = () => host.readCurrent() || {};
  root.classList.add('canvas-manager');
  root.setAttribute('aria-label', '我的画布');
  const heading = element('header', 'canvas-manager-heading');
  heading.append(element('h1', '', '我的画布'));
  const actionState = element('p', 'canvas-manager-action-state');
  actionState.id = 'canvas-manager-action-state';
  actionState.setAttribute('role', 'status'); actionState.setAttribute('aria-live', 'polite');

  async function runAction(kind, callback) {
    if (root.hidden || pending || current().busy || composing || kind === 'continue' && current().active !== true) return false;
    pending = true; actionState.textContent = '正在打开，请稍候…'; updateControls();
    try {
      const result = await callback();
      if (!root.hidden) actionState.textContent = result === false ? '操作已取消，当前画布已保留。' : '';
      return result !== false;
    } catch (error) {
      if (!root.hidden) actionState.textContent = '操作未完成，请检查提示后重试。';
      host.reportError(error); return false;
    } finally { pending = false; updateCurrent(); }
  }
  function button(label, id, callback, className = '') {
    const node = element('button', className, label); node.type = 'button'; node.id = `canvas-manager-${id}`;
    node.addEventListener('click', event => {
      if (event.isComposing || node.disabled || root.hidden || composing || pending || current().busy) return;
      return callback();
    });
    controls.add(node); return node;
  }
  const launch = element('section', 'canvas-manager-launch'); launch.setAttribute('aria-label', '开始创作');
  const create = button(undefined, 'create', () => runAction('create', () => host.onCreate()), 'canvas-manager-create');
  create.setAttribute('aria-label', '新建画布');
  const createCopy = element('span', 'canvas-manager-create-copy');
  createCopy.append(element('span', 'canvas-manager-create-title', '新建画布'));
  const createPlus = element('span', 'canvas-manager-create-plus', '+'); createPlus.setAttribute('aria-hidden', 'true');
  const createArt = element('span', 'canvas-manager-create-art'); createArt.setAttribute('aria-hidden', 'true');
  createArt.append(element('span', 'canvas-manager-art-sheet'), element('span', 'canvas-manager-art-sheet'), element('span', 'canvas-manager-art-dot'));
  create.append(createPlus, createCopy, createArt);
  launch.append(create);

  const recent = element('section', 'canvas-manager-recent'); recent.setAttribute('aria-label', '最近画布');
  const toolbar = element('div', 'canvas-manager-toolbar');
  toolbar.append(element('h2', '', '最近画布'));
  const searchBox = element('div', 'canvas-manager-search-box');
  const search = element('input'); search.id = 'canvas-manager-search'; search.type = 'search'; search.maxLength = 120;
  search.placeholder = '搜索画布'; search.setAttribute('aria-label', '搜索最近画布'); search.setAttribute('aria-controls', 'canvas-manager-list');
  const clear = button('清空', 'search-clear', () => { search.value = ''; search.focus(); renderProjects(); }, 'canvas-manager-text-button');
  searchBox.append(search, clear);
  const reload = button('刷新', 'refresh', () => refresh(), 'canvas-manager-text-button');
  const folderFilter=element('select','canvas-folder-filter');folderFilter.setAttribute('aria-label','筛选画布文件夹');
  let chosenFolder='';
  const folderNames=()=>[...new Set(projects.map(p=>getCardPreferences(p.id).folder).filter(Boolean))].sort();
  const menu=createCardActions({host,refresh,folders:folderNames,onBusyChange:updateControls});
  folderFilter.addEventListener('change',()=>{chosenFolder=folderFilter.value;renderProjects();});
  toolbar.append(folderFilter,searchBox, reload);
  const listState = element('p', 'canvas-manager-list-state'); listState.id = 'canvas-manager-list-state';
  listState.setAttribute('role', 'status'); listState.setAttribute('aria-live', 'polite');
  const list = element('div', 'canvas-manager-list'); list.id = 'canvas-manager-list';
  recent.append(toolbar, listState, list);
  root.replaceChildren(heading, launch, actionState, recent);

  function updateControls() {
    const busy = pending || current().busy === true || menu.isWorking();
    for (const node of controls) node.disabled = busy || composing || (loading && cardControls.has(node));
    search.disabled = busy;
    reload.disabled = busy || composing || loading;
    clear.hidden = !search.value;
    root.setAttribute('aria-busy', String(pending || loading));
  }
  function draftStatus(state) {
    return state.draftSaved === true ? '草稿已保存' : '草稿待保存';
  }
  function projectCard(item, state, isCurrent, isDraft = false) {
    const card = element('article', 'canvas-manager-card');
    const open = button(undefined, isDraft ? 'continue' : `open-${item.id}`, () => runAction(isCurrent ? 'continue' : 'open', () => isCurrent ? host.onContinue() : host.onOpen(item.id, item.latestId || item.id)), 'canvas-manager-project');
    cardControls.add(open);
    open.setAttribute('aria-label', `${isCurrent ? '继续编辑' : '打开画布'}：${item.name}${isDraft ? '，最近草稿' : ''}`);
    const visual = element('span', 'canvas-manager-card-visual');
    visual.append(renderCanvasPreview(isCurrent ? state.preview ?? item.preview : item.preview));
    const cover=getCardPreferences(item.id).cover;
    if(typeof cover==='string' && /^data:image\/(webp|png);base64,/.test(cover)){
      const image=element('img','canvas-custom-cover');image.src=cover;image.alt='自选画布封面';visual.replaceChildren(image);
    }
    if (isCurrent) visual.append(element('span', `canvas-manager-current-badge${state.draftSaved === true ? '' : ' is-unsaved'}`, isDraft ? '最近草稿' : '当前画布'));
    const caption = element('span', 'canvas-manager-card-caption');
    caption.append(element('span', 'canvas-manager-card-title', item.name));
    const meta = element('span', 'canvas-manager-card-meta');
    const nodeCount = isCurrent && validCount(state.nodeCount) ? state.nodeCount : item.nodeCount;
    if (isCurrent) meta.append(element('span', 'canvas-manager-draft-state', draftStatus(state)));
    else {
      const date = new Date(item.updatedAt * 1000);
      const time = element('time', '', date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
      time.setAttribute('datetime', date.toISOString()); meta.append(time);
    }
    if (validCount(nodeCount)) meta.append(element('span', '', `${nodeCount} 个节点`));
    caption.append(meta); open.append(visual, caption); card.append(open);
    const more=button('⋯',isDraft?'more-draft':`more-${item.id}`,()=>menu.open(more,{...item,...(isCurrent?{currentIdentity:state.identity}:{})},isCurrent,isDraft),'canvas-card-more');
    more.setAttribute('aria-label',`${item.name}的更多操作`);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');
    cardControls.add(more);card.append(more);return card;
  }
  function renderProjects() {
    menu.close();
    const focusedCard = cardControls.has(document.activeElement) ? document.activeElement.id : null;
    for (const node of cardControls) controls.delete(node);
    cardControls.clear(); list.replaceChildren();
    if (!composing) committedSearch = search.value;
    const state = current(), query = committedSearch.trim().toLocaleLowerCase();
    const matches = name => !query || name.toLocaleLowerCase().includes(query);
    // Only a durable project identity can associate a draft with a saved canvas.
    const linked = state.active === true && typeof state.projectId === 'string' ? projects.find(item => item.id === state.projectId) : null;
    const folders=folderNames();const removed=projects.some(p=>getCardPreferences(p.id).hidden);
    if(chosenFolder && !(chosenFolder===':hidden' ? removed : folders.includes(chosenFolder.slice(2))))chosenFolder='';
    folderFilter.replaceChildren();
    for(const [value,label] of [['','全部画布'],...folders.map(name=>['f:'+name,name]),...(removed?[[ ':hidden','已移除']]:[])]){
      const option=element('option','',label);option.value=value;folderFilter.append(option);
    }
    folderFilter.value=chosenFolder;folderFilter.hidden=!folders.length&&!removed;
    let visible = 0;
    if (!chosenFolder && state.active === true && !linked && matches(String(state.title || '未命名画布'))) {
      list.append(projectCard({ name: String(state.title || '未命名画布'), nodeCount: state.nodeCount, preview: state.preview }, state, true, true)); visible++;
    }
    for (const item of projects) {
      const prefs=getCardPreferences(item.id);
      if(chosenFolder===':hidden'?!prefs.hidden:prefs.hidden || (chosenFolder && 'f:'+prefs.folder!==chosenFolder))continue;
      const isCurrent = item === linked;
      const shown = isCurrent ? { ...item, name: String(state.title || item.name) } : item;
      if (!matches(shown.name)) continue;
      list.append(projectCard(shown, state, isCurrent)); visible++;
    }
    if (query.length > 120) {
      list.replaceChildren(); visible = 0; listState.textContent = '搜索名称最多 120 个字符。';
    } else if (composing) listState.textContent = '输入法编辑中，完成后再搜索。';
    else if (loading) listState.textContent = '正在读取最近画布…';
    else if (readFailed) listState.textContent = '最近画布暂时无法读取，请点击刷新重试。当前草稿已保留。';
    else if (loaded) {
      const summary = query ? `找到 ${visible} 张画布` : visible ? `${visible} 张画布 · 按最近更新排列` : '';
      const warning = unreadable ? `有 ${unreadable} 份保存记录暂时无法完整读取，原文件已保留。可点击刷新重试。` : '';
      listState.textContent = [summary, warning].filter(Boolean).join('。');
    }
    else listState.textContent = '';
    if (!visible && loaded && !loading && !readFailed && !composing && query.length <= 120) {
      const empty = element('div', 'canvas-manager-empty');
      const symbol = element('span', 'canvas-manager-empty-symbol', '＋'); symbol.setAttribute('aria-hidden', 'true');
      empty.append(symbol,
        element('h3', '', unreadable ? query ? '没有找到可读取的画布' : '保存记录暂时无法读取' : query ? '没有找到这张画布' : '第一张画布，从这里开始'),
        element('p', '', unreadable ? '原文件已保留。点击「刷新」重试，或稍后再次打开。' : query ? '换个名称试试，或清空搜索查看全部画布。' : '点击上方「新建画布」，把你的第一个想法放进来。')); 
      list.append(empty);
    }
    updateControls();
    if (focusedCard) [...cardControls].find(node => node.id === focusedCard)?.focus({ preventScroll: true });
  }
  function updateCurrent() { renderProjects(); }
  async function refresh() {
    if (root.hidden || composing || pending || current().busy) return;
    const requestRevision = ++revision;
    loading = true; readFailed = false; renderProjects();
    try {
      const listing = await host.listProjects();
      const items = checkedProjects(Array.isArray(listing) ? listing : listing?.projects);
      const unavailable = Array.isArray(listing) ? 0 : listing?.unreadable;
      if (!validCount(unavailable)) throw new Error('不可读取画布记录数量无效');
      if (requestRevision !== revision || root.hidden) return;
      projects = items; unreadable = unavailable; loaded = true;
    } catch (error) {
      if (requestRevision !== revision || root.hidden) return;
      readFailed = true; host.reportError(error);
    } finally {
      if (requestRevision === revision) { loading = false; renderProjects(); }
    }
  }
  search.addEventListener('input', () => { if (!composing && !pending && !current().busy) renderProjects(); });
  search.addEventListener('compositionstart', () => { composing = true; listState.textContent = '输入法编辑中，完成后再搜索。'; updateControls(); });
  search.addEventListener('compositionend', () => { composing = false; renderProjects(); });
  search.addEventListener('keydown', event => {
    if (event.isComposing || composing || pending || current().busy) return;
    if (event.key === 'Enter') { event.preventDefault(); renderProjects(); }
    if (event.key === 'Escape' && search.value) { event.preventDefault(); search.value = ''; renderProjects(); }
  });
  function close() { menu.close();revision++; loading = false; composing = false; root.hidden = true; updateControls(); }
  async function open() {
    root.hidden = false; search.value = ''; actionState.textContent = ''; composing = false;
    updateCurrent(); create.focus({ preventScroll: true }); await refresh();
  }
  updateCurrent();
  return { open, close, updateCurrent, refresh };
}
