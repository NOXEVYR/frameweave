import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEditorInterface, initialEditorFieldIds, resolveEditorConflicts } from '../web/editor-interface-panel.mjs';

// Exercise the panel's event handlers and returned contract without network or a browser dependency.
class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.dataset = {};
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, data = {}) { for (const callback of this.listeners.get(name) || []) callback({ target: this, ...data }); }
  click() { if (!this.disabled) this.emit('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
}
const flatten = root => [root, ...root.children.flatMap(flatten)];
function browser() {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = new Element('body');
  Object.defineProperty(globalThis, 'document', { value: { body, createElement: tag => new Element(tag) }, configurable: true });
  const find = predicate => flatten(body).find(predicate);
  return {
    body,
    aria: label => find(item => item.attributes['aria-label'] === label),
    button: label => find(item => item.tagName === 'button' && item.textContent === label),
    restore() { if (old) Object.defineProperty(globalThis, 'document', old); else delete globalThis.document; },
  };
}

test('manual panel retains custom names and chooses presentation independently of real field type', async () => {
  const ui = browser();
  const fields = [
    { id: 'prompt', label: '内部提示词', input: 'text', node_id: '1', type: 'text' },
    { id: 'image', label: '输入图', input: 'image', node_id: '2', type: 'image' },
    { id: 'video', label: '输入视频', input: 'video', node_id: '3', type: 'video' },
    { id: 'audio', label: '输入音频', input: 'audio', node_id: '4', type: 'audio', presentation: 'port' },
    { id: 'seed', label: '种子', input: 'seed', node_id: '5', type: 'integer', presentation: 'port' },
    { id: 'model', label: '模型', input: 'ckpt_name', node_id: '6', type: 'text' },
  ];
  const original = structuredClone(fields);
  try {
    const choosing = chooseEditorInterface({ fields, outputs: [{ id: 'out' }],
      previousFields: [{ id: 'prompt', type: 'text', label: '我的名称', presentation: 'control' },
        { id: 'seed', type: 'integer', label: '我的种子', presentation: 'control' }],
      previousValues: { prompt: '外层值' }, previousBaseline: { prompt: '基线' },
      connections: [{ direction: 'input', fieldId: 'prompt', type: 'text' }] });
    assert.equal(ui.aria('外层显示名称：我的名称').value, '我的名称');
    assert.equal(ui.aria('显示方式：我的名称').value, 'control');
    assert.equal(ui.aria('显示方式：输入音频').disabled, false);
    assert.deepEqual(ui.aria('显示方式：输入音频').children.map(option => option.value), ['control','port']);
    assert.deepEqual(ui.aria('显示方式：我的种子').children.map(option => option.value), ['control']);
    for (const label of ['输入图', '输入视频', '输入音频']) assert.equal(ui.aria(`暴露参数 ${label}`).disabled, true);

    const rename = ui.aria('外层显示名称：我的名称');
    rename.value = '新版名称'; rename.emit('input');
    const promptMode = ui.aria('显示方式：我的名称');
    promptMode.value = 'port'; promptMode.emit('change');
    const imageMode = ui.aria('显示方式：输入图');
    imageMode.value = 'control'; imageMode.emit('change');
    const videoMode = ui.aria('显示方式：输入视频');
    videoMode.value = 'control'; videoMode.emit('change');
    assert.equal(ui.button('应用外层面板').disabled, false);
    ui.button('应用外层面板').click();
    const selected = await choosing;
    assert.deepEqual(selected.fields.map(field => [field.id, field.label, field.type, field.presentation]), [
      ['prompt', '新版名称', 'text', 'port'], ['image', '输入图', 'image', 'control'],
      ['video', '输入视频', 'video', 'control'], ['audio', '输入音频', 'audio', 'port'],
      ['seed', '我的种子', 'integer', 'control'],
    ]);
    assert.deepEqual(selected.rebindings, {});
    assert.deepEqual(fields, original);
    assert.equal(ui.body.children.length, 0);
  } finally { ui.restore(); }
});

test('search and categories discover initially unexposed custom inputs and preserve edits across rerender', async () => {
  const ui = browser();
  try {
    const choosing = chooseEditorInterface({ fields: [
      { id: 'prompt', label: '提示词', input: 'text', type: 'text' },
      { id: 'custom', label: '插件选项', input: 'custom_mode', type: 'text' },
    ], outputs: [{ id: 'out' }] });
    assert.equal(ui.aria('暴露参数 插件选项').checked, false);
    ui.button('其他').click();
    assert.equal(ui.aria('暴露参数 提示词'), undefined);
    const search = ui.aria('搜索参数'); search.value = 'no-match'; search.emit('input');
    assert.equal(ui.aria('暴露参数 插件选项'), undefined);
    search.value = 'custom_mode'; search.emit('input');
    const checkbox = ui.aria('暴露参数 插件选项'); checkbox.checked = true; checkbox.emit('change');
    const rename = ui.aria('外层显示名称：插件选项'); rename.value = '我的插件值'; rename.emit('input');
    const mode = ui.aria('显示方式：插件选项'); mode.value = 'port'; mode.emit('change');
    ui.button('全部').click();
    search.value = ''; search.emit('input');
    assert.equal(ui.aria('外层显示名称：插件选项').value, '我的插件值');
    assert.equal(ui.aria('显示方式：插件选项').value, 'port');
    ui.button('应用外层面板').click();
    const selected = await choosing;
    assert.deepEqual(selected.fields.map(field => [field.id, field.label, field.presentation]), [
      ['prompt', '提示词', 'port'], ['custom', '我的插件值', 'port'],
    ]);
  } finally { ui.restore(); }
});

test('cancelling changed interface choices leaves the previous fields and values untouched', async () => {
  const ui = browser();
  const previousFields = [{ id: 'prompt', type: 'text', label: '原名称', presentation: 'port' }];
  const previousValues = { prompt: '原外层值' };
  try {
    const choosing = chooseEditorInterface({ fields: [{ id: 'prompt', type: 'text', input: 'text', label: '内部名称' }],
      outputs: [{ id: 'out' }], previousFields, previousValues });
    const rename = ui.aria('外层显示名称：原名称'); rename.value = '已改名'; rename.emit('input');
    const mode = ui.aria('显示方式：原名称'); mode.value = 'control'; mode.emit('change');
    ui.button('取消').click();
    assert.equal(await choosing, null);
    assert.deepEqual(previousFields, [{ id: 'prompt', type: 'text', label: '原名称', presentation: 'port' }]);
    assert.deepEqual(previousValues, { prompt: '原外层值' });
  } finally { ui.restore(); }
});

test('manual interface requires narrowing more than 64 output branches before applying', async () => {
  const ui = browser();
  try {
    const outputs = Array.from({ length: 65 }, (_, index) => ({ id: `out-${index}`, label: `输出 ${index}` }));
    const choosing = chooseEditorInterface({ fields: [], outputs });
    assert.equal(ui.button('应用外层面板').disabled, true);
    assert(flatten(ui.body).some(item => /最多选择 64 个输出分支/.test(item.textContent)));
    assert.equal(flatten(ui.body).filter(item => item.className === 'editor-interface-output').length, 64);
    ui.button('输出下一页').click();
    const last = ui.aria('选择输出 输出 64'); last.checked = false; last.emit('change');
    assert.equal(ui.button('应用外层面板').disabled, false);
    ui.button('应用外层面板').click();
    const result = await choosing;
    assert.deepEqual(result.output_nodes, outputs.slice(0, 64).map(output => output.id));
  } finally { ui.restore(); }
});


test('4096 candidates are paged but filtered bulk selection and edits preserve the complete interface', async () => {
  const ui = browser();
  const fields = Array.from({ length: 4096 }, (_, i) => ({ id: `field-${i}`, label: `参数 ${i}`, input: `seed_${i}`, node_id: `${i}`, type: 'text', recommended: true }));
  try {
    const choosing = chooseEditorInterface({ fields, outputs: [{ id: 'out' }] });
    const rows = () => flatten(ui.body).filter(item => item.className === 'editor-interface-field');
    assert.equal(rows().length, 64);
    assert.equal(initialEditorFieldIds(fields).length, 64);
    ui.button('勾选筛选结果').click();
    assert.equal(rows().length, 64);
    const rename = ui.aria('外层显示名称：参数 0'); rename.value = '我的第一页'; rename.emit('input');
    ui.button('参数下一页').click();
    assert.equal(rows().length, 64);
    const search = ui.aria('搜索参数'); search.value = 'field-4095'; search.emit('input');
    assert.equal(rows().length, 1);
    const last = ui.aria('外层显示名称：参数 4095'); last.value = '末页输入'; last.emit('input');
    const mode = ui.aria('显示方式：参数 4095'); mode.value = 'port'; mode.emit('change');
    search.value = ''; search.emit('input');
    assert.equal(ui.aria('外层显示名称：参数 0').value, '我的第一页');
    ui.button('应用外层面板').click();
    const selected = await choosing;
    assert.equal(selected.fields.length, 4096);
    assert.equal(selected.fields[0].label, '我的第一页');
    assert.equal(selected.fields[4095].label, '末页输入');
    assert.equal(selected.fields[4095].presentation, 'port');
    assert.equal(fields[0].label, '参数 0');
  } finally { ui.restore(); }
});

test('previous 4096 fields are retained and media do not consume a hard default budget', async () => {
  const fields = Array.from({ length: 4096 }, (_, i) => ({ id: `field-${i}`, type: 'boolean', recommended: false }));
  assert.equal(initialEditorFieldIds(fields, fields).length, 4096);
  assert.equal(initialEditorFieldIds(Array.from({ length: 100 }, (_, i) => ({ id: `media-${i}`, type: 'image' }))).length, 100);
  assert.deepEqual(initialEditorFieldIds([{ id: 'scalar', type: 'integer', label: 'image', recommended: false }]), []);
});

test('bulk deselection acts on all filtered pages but preserves mandatory media and connection safety', async () => {
  const ui = browser();
  const fields = [{ id: 'image', label: '输入图片', type: 'image' }, ...Array.from({ length: 130 }, (_, i) => ({ id: `text-${i}`, label: `text ${i}`, type: 'text', recommended: true }))];
  try {
    const choosing = chooseEditorInterface({ fields, previousFields: fields, outputs: [{ id: 'out' }], connections: [{ direction: 'input', fieldId: 'text-129', type: 'text' }] });
    ui.button('取消筛选结果').click();
    assert.equal(ui.aria('暴露参数 输入图片').checked, true);
    assert.equal(ui.button('应用外层面板').disabled, true);
    const treatment = ui.aria('text 129 的字段连线处理方式'); treatment.value = 'null'; treatment.emit('change');
    assert.equal(ui.button('应用外层面板').disabled, false);
    ui.button('应用外层面板').click();
    const result = await choosing;
    assert.deepEqual(result.fields.map(item => item.id), ['image']);
    assert.deepEqual(result.rebindings, { 'text-129': null });
  } finally { ui.restore(); }
});

test('many rebindings use paged rows and bounded searchable target options', async () => {
  const ui = browser();
  const fields = Array.from({ length: 4096 }, (_, i) => ({ id: `new-${i}`, label: `新 ${i}`, type: 'text', recommended: false }));
  const previousFields = Array.from({ length: 130 }, (_, i) => ({ id: `old-${i}`, label: `旧 ${i}`, type: 'text' }));
  try {
    const choosing = chooseEditorInterface({ fields, previousFields, outputs: [{ id: 'out' }] });
    assert.equal(flatten(ui.body).filter(item => item.className === 'editor-interface-binding').length, 64);
    const select = ui.aria('旧 0 的字段连线处理方式'); assert.equal(select.children.length, 66);
    const search = ui.aria('旧 0 搜索重绑目标'); search.value = 'new-4095'; search.emit('input');
    assert.equal(select.children.length, 3);
    select.value = JSON.stringify('new-4095'); select.emit('change');
    assert.equal(ui.aria('旧 0 的字段连线处理方式').value, JSON.stringify('new-4095'));
    ui.button('外层输入绑定处理下一页').click();
    assert.equal(flatten(ui.body).filter(item => item.className === 'editor-interface-binding').length, 64);
    ui.button('外层输入绑定处理上一页').click();
    assert.equal(ui.aria('旧 0 的字段连线处理方式').value, JSON.stringify('new-4095'));
    ui.button('取消').click(); assert.equal(await choosing, null);
  } finally { ui.restore(); }
});

test('conflict pagination retains earlier choices and refuses incomplete confirmation', async () => {
  const ui = browser();
  try {
    const resolving = resolveEditorConflicts(Array.from({ length: 65 }, (_, i) => ({ id: `${i}`, label: `冲突 ${i}`, outer: i, inner: i+1 })));
    assert.equal(flatten(ui.body).filter(item => item.className?.includes('editor-interface-conflict') && item.tagName === 'div').length, 64);
    for (let i=0; i<64; i++) { const select = ui.aria(`冲突 ${i} 冲突处理方式`); select.value = 'outer'; select.emit('change'); }
    assert.equal(ui.button('应用所选修改').disabled, true);
    ui.button('冲突下一页').click();
    const last = ui.aria('冲突 64 冲突处理方式'); last.value = 'inner'; last.emit('change');
    ui.button('冲突上一页').click(); assert.equal(ui.aria('冲突 0 冲突处理方式').value, 'outer');
    ui.button('应用所选修改').click(); const result = await resolving;
    assert.equal(Object.keys(result).length,65); assert.equal(result['64'],'inner');
  } finally { ui.restore(); }
});


test('output candidate search discovers a last branch without expanding the 64 output execution budget', async () => {
  const ui = browser();
  try {
    const outputs = Array.from({length:1000},(_,i)=>({id:`out-${i}`,label:`输出 ${i}`,mediaType:'image'}));
    const choosing = chooseEditorInterface({fields:[], outputs, selectedOutputs:['out-0']});
    const search = ui.aria('搜索输出分支');search.value='out-999';search.emit('input');
    assert.equal(flatten(ui.body).filter(item=>item.className==='editor-interface-output').length,1);
    const last=ui.aria('选择输出 输出 999');last.checked=true;last.emit('change');
    search.value='';search.emit('input');assert.equal(ui.aria('选择输出 输出 0').checked,true);
    ui.button('应用外层面板').click();assert.deepEqual((await choosing).output_nodes,['out-0','out-999']);
  } finally {ui.restore();}
});


test('parameter panel uses exact ID search without treating incidental hash fragments as node matches', async()=>{
  const ui=browser();
  try {
    const choosing=chooseEditorInterface({fields:[{id:'hash-950-random',node_id:'2',label:'其他',input:'value',type:'text'},
      {id:'actual-field',node_id:'950',label:'真正节点950',input:'width',type:'integer'}],outputs:[{id:'out'}]});
    const search=ui.aria('搜索参数');search.value='950';search.emit('input');
    assert.equal(ui.aria('暴露参数 其他'),undefined);assert(ui.aria('暴露参数 真正节点950'));
    search.value='hash-950-random';search.emit('input');assert(ui.aria('暴露参数 其他'));
    ui.button('取消').click();assert.equal(await choosing,null);
  } finally {ui.restore();}
});
