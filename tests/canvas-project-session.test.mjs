import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasProjectName, createCanvasProjectSession } from '../web/canvas-project-session.mjs';

function fixture({ active = true, phase = '', choice = { action: 'discard' } } = {}) {
  const s = { active, identity: 'first', title: '画布 A', graph: { nodes: [{ text: 'A' }], edges: [] },
    viewport: { x: 1, y: 2, scale: 1 }, backend: 'loopback-A', draftSaved: true,
    records: [], installed: [], views: [], flushes: 0, blocked: false, flushOK: true };
  let release, reached, sequence = 0;
  const waiting = new Promise(resolve => { reached = resolve; });
  const gate = async name => { if (phase === name) { reached(); await new Promise(resolve => { release = resolve; }); } };
  const signature = () => JSON.stringify([s.graph, s.viewport, s.title]);
  const capture = () => ({ identity: s.identity, graph: s.graph, signature: signature(), backend: s.backend });
  const host = {
    readCurrent: () => ({ active: s.active, title: s.title, identity: s.identity, signature: signature(), draftSaved: s.draftSaved, busy: s.blocked }),
    capture,
    assertCurrent(ticket) { assert(ticket && ticket.identity === s.identity && ticket.graph === s.graph && ticket.signature === signature() && ticket.backend === s.backend, '画布已变化'); },
    assertCanReplace() { if (s.blocked) throw new Error('调度进行中'); },
    flush() { s.flushes++; return s.flushOK; },
    async confirmSwitch() { await gate('confirm'); return choice; },
    async buildBundle() { const document = { name: s.title, canvas: structuredClone(s.graph), packages: [] }; await gate('build'); return document; },
    async saveDocument(document) {
      const record = { id: (++sequence).toString(16).padStart(32, '0'), name: document.name, document: structuredClone(document) };
      s.records.push(record); await gate('save'); return record;
    },
    commitSaved(record, name) { s.title = name; s.draftSaved = true; return capture(); },
    emptyDocument: name => ({ name, canvas: { nodes: [], edges: [] }, packages: [] }),
    async loadDocument(id) { const record = { id, document: { name: '画布 B', canvas: { nodes: [{ text: 'B' }], edges: [] }, packages: [] } }; await gate('load'); return record; },
    installCreated(document, record, ticket) { host.assertCurrent(ticket); s.graph = structuredClone(document.canvas); s.title = document.name; s.identity = record.id; s.active = true; s.installed.push(record.id); return capture(); },
    async installOpened(document, record, ticket) { host.assertCurrent(ticket); s.graph = structuredClone(document.canvas); s.title = document.name; s.identity = record.id; s.active = true; s.installed.push(record.id); const committed = capture(); await gate('installed'); return committed; },
    showEditor() { s.views.push('editor'); },
    showManagement() { s.views.push('management'); },
    onStateChange() {},
  };
  return { s, host, controller: createCanvasProjectSession(host), waiting, release: () => release(), capture };
}

test('inactive first entry never creates a canvas; legacy draft does not invent a saved baseline', () => {
  const empty = fixture({ active: false }), legacy = fixture();
  assert.equal(empty.controller.readCurrent().dirty, false); assert.deepEqual(empty.s.records, []);
  assert.throws(() => empty.controller.continue(), /没有可继续/);
  assert.equal(legacy.controller.readCurrent().dirty, true); assert.equal(legacy.controller.readCurrent().savedVersionId, null);
});

for (const stored of [null, '{broken legacy draft']) test(`inactive ${stored === null ? 'first entry' : 'damaged legacy draft'} checks shared composition before any version write`, async () => {
  const f = fixture({ active: false }), raw = new Map(stored === null ? [] : [['frameweave.canvas.v1', stored]]);
  let composing = true;
  f.host.flush = () => { f.s.flushes++; if (composing) throw Object.assign(new Error('请先完成输入法'), { code: 'busy' }); return true; };
  const before = [...raw];
  await assert.rejects(f.controller.create('半成品名称'), /输入法/);
  assert.deepEqual(f.s.records, []); assert.deepEqual(f.s.installed, []); assert.deepEqual([...raw], before);
  assert.equal(f.controller.readCurrent().busy, false); assert.equal(f.s.flushes, 1);
  composing = false; await f.controller.create('完整中文名称');
  assert.equal(f.s.records.length, 1); assert.equal(f.s.records[0].name, '完整中文名称');
  assert.deepEqual([...raw], before, 'session does not touch existing browser keys; host owns installation');
});

test('name is required, bounded and trimmed before any persistence', async () => {
  assert.equal(canvasProjectName('  命名画布  '), '命名画布');
  for (const bad of ['', '   ', null, '中'.repeat(121)]) {
    const f = fixture(); await assert.rejects(f.controller.create(bad), /1–120/); assert.deepEqual(f.s.records, []);
  }
});

test('new named canvases get independent immutable versions and empty graphs', async () => {
  const f = fixture({ active: false }); await f.controller.create('A'); const first = structuredClone(f.s.records[0]);
  await f.controller.create('B'); assert.equal(f.s.records.length, 2); assert.deepEqual(f.s.records[0], first);
  assert.notEqual(f.s.records[0].id, f.s.records[1].id); assert.equal(f.s.title, 'B'); assert.deepEqual(f.s.graph.nodes, []);
  assert.equal(f.controller.readCurrent().dirty, false); assert.equal(f.s.views.length, 2);
});

test('cancel preserves old content without any version write or navigation', async () => {
  const f = fixture({ choice: { action: 'cancel' } }), before = f.capture();
  assert.equal(await f.controller.create('B'), false); assert.deepEqual(f.capture(), before);
  assert.deepEqual(f.s.records, []); assert.deepEqual(f.s.installed, []); assert.deepEqual(f.s.views, []);
});

test('save-and-switch persists the old exact content before creating the new version', async () => {
  const f = fixture({ choice: { action: 'save', name: 'A 保留' } });
  await f.controller.create('B'); assert.equal(f.s.records.length, 2);
  assert.deepEqual(f.s.records[0].document.canvas.nodes, [{ text: 'A' }]); assert.equal(f.s.records[0].name, 'A 保留');
  assert.deepEqual(f.s.records[1].document.canvas.nodes, []); assert.equal(f.s.title, 'B');
});

test('explicit discard does not save old draft and never overwrites an existing version', async () => {
  const f = fixture(); await f.controller.save('A'); const saved = structuredClone(f.s.records[0]);
  f.s.graph.nodes[0].text = '未保存'; await f.controller.create('B');
  assert.equal(f.s.records.length, 2); assert.deepEqual(f.s.records[0], saved); assert.equal(f.s.title, 'B');
});

const mutations = [
  ['node edit', s => { s.graph.nodes[0].text = 'new value'; }],
  ['graph replacement', s => { s.graph = structuredClone(s.graph); }],
  ['identity', s => { s.identity = 'different'; }],
  ['title', s => { s.title = 'different'; }],
  ['viewport', s => { s.viewport.x += 10; }],
  ['backend', s => { s.backend = 'loopback-B'; }],
];
for (const [name, mutate] of mutations) for (const phase of ['confirm', 'load']) {
  test(`open rejects ${name} during ${phase}, preserving the edited current state`, async () => {
    const f = fixture({ phase }), promise = f.controller.open('b'.repeat(32)); await f.waiting;
    mutate(f.s); const current = f.capture(); f.release(); await assert.rejects(promise, /画布已变化/);
    assert.deepEqual(f.capture(), current); assert.deepEqual(f.s.installed, []); assert.deepEqual(f.s.views, []);
    assert.equal(f.controller.readCurrent().busy, false);
  });
}

for (const phase of ['build', 'save']) test(`late save response during ${phase} cannot rename or mark another edit clean`, async () => {
  const f = fixture({ phase }), promise = f.controller.save('Saved old A'); await f.waiting;
  f.s.graph.nodes[0].text = 'new edit'; f.release(); await assert.rejects(promise, /画布已变化/);
  assert.equal(f.s.title, '画布 A'); assert.equal(f.s.graph.nodes[0].text, 'new edit'); assert.equal(f.controller.readCurrent().dirty, true);
  assert.equal(f.s.records.length, phase === 'build' ? 0 : 1); assert.deepEqual(f.s.views, []);
});

test('late empty-create response retains the immutable saved record without replacing a changed draft', async () => {
  const f = fixture({ phase: 'save' }), promise = f.controller.create('B'); await f.waiting;
  f.s.title = 'Changed A'; f.release(); await assert.rejects(promise, /画布已变化/);
  assert.equal(f.s.records.length, 1); assert.deepEqual(f.s.installed, []); assert.equal(f.s.title, 'Changed A');
});

test('changes after import installation do not become the saved baseline', async () => {
  const f = fixture({ phase: 'installed' }), promise = f.controller.open('b'.repeat(32)); await f.waiting;
  f.s.graph.nodes[0].text = 'edited B'; f.release(); await assert.rejects(promise, /画布已变化/);
  assert.equal(f.controller.readCurrent().dirty, true); assert.deepEqual(f.s.views, []);
});

test('draft flush failure refuses create/open/return with old content intact', async () => {
  for (const action of ['create', 'open', 'showManagement']) {
    const f = fixture(); f.s.flushOK = false; const before = f.capture();
    await assert.rejects(f.controller[action](action === 'open' ? 'b'.repeat(32) : 'B'), /草稿保存失败/);
    assert.deepEqual(f.capture(), before); assert.deepEqual(f.s.records, []); assert.deepEqual(f.s.views, []);
  }
});

test('failed or uncertain version save never retries or switches', async () => {
  const f = fixture({ choice: { action: 'save', name: 'A' } }); let calls = 0;
  f.host.saveDocument = async () => { calls++; throw new Error('response disconnected'); };
  await assert.rejects(f.controller.create('B'), /response disconnected/); assert.equal(calls, 1);
  assert.deepEqual(f.s.installed, []); assert.deepEqual(f.s.views, []); assert.equal(f.s.title, '画布 A');
});

test('malformed save result is not treated as confirmed and is not retried', async () => {
  const f = fixture({ active: false }); let calls = 0;
  f.host.saveDocument = async () => { calls++; return { id: '../wrong' }; };
  await assert.rejects(f.controller.create('B'), /无法核实/); assert.equal(calls, 1); assert.deepEqual(f.s.installed, []);
});

test('pending operation rejects duplicate actions; running/import guard blocks replacement', async () => {
  const f = fixture({ phase: 'load' }), promise = f.controller.open('b'.repeat(32)); await f.waiting;
  await assert.rejects(f.controller.create('C'), /操作进行中/); assert.throws(() => f.controller.continue(), /操作完成/);
  f.release(); await promise; assert.equal(f.s.installed.length, 1);
  f.s.blocked = true; await assert.rejects(f.controller.create('C'), /调度进行中/);
  assert.equal(f.s.installed.length, 1);
});

test('return/continue only changes view and preserves graph, history owner and version identity', async () => {
  const f = fixture(), before = f.capture(); await f.controller.showManagement(); f.controller.continue();
  assert.deepEqual(f.capture(), before); assert.deepEqual(f.s.views, ['management', 'editor']); assert.deepEqual(f.s.records, []);
});

test('save establishes only current exact baseline; later edit, undo identity or invalidation is dirty', async () => {
  const f = fixture(); await f.controller.save('A'); assert.equal(f.controller.readCurrent().dirty, false);
  f.s.graph.nodes[0].text = 'new'; assert.equal(f.controller.readCurrent().dirty, true);
  f.s.graph.nodes[0].text = 'A'; assert.equal(f.controller.readCurrent().dirty, false);
  f.s.identity = 'undo-other-project'; assert.equal(f.controller.readCurrent().dirty, true);
  assert.equal(f.controller.readCurrent().savedVersionId, null, 'another canvas must not expose this version as its own');
  f.controller.invalidateBaseline(); assert.equal(f.controller.readCurrent().savedVersionId, null);
});

for (const [action, phase] of [['create', 'save'], ['open', 'load'], ['save', 'build']]) {
  test(`${action} rechecks a newly started busy operation after its ${phase} wait`, async () => {
    const f = fixture({ phase }), promise = f.controller[action](action === 'open' ? 'b'.repeat(32) : 'B');
    await f.waiting; f.s.blocked = true; const before = f.capture(); f.release();
    await assert.rejects(promise, /调度进行中/);
    assert.deepEqual(f.capture(), before); assert.deepEqual(f.s.installed, []); assert.deepEqual(f.s.views, []);
    assert.equal(f.s.records.length, action === 'create' ? 1 : 0, 'already saved immutable versions remain retained');
  });
}

test('composition begun while a load is pending blocks installation even when the graph has not changed', async () => {
  const f = fixture({ phase: 'load' }); let composing = false;
  f.host.assertCanReplace = () => { if (composing) throw new Error('请先完成输入法'); };
  const promise = f.controller.open('b'.repeat(32)); await f.waiting; composing = true; f.release();
  await assert.rejects(promise, /输入法/); assert.deepEqual(f.s.installed, []); assert.equal(f.s.title, '画布 A');
});

test('failed old-version read leaves current draft and baseline ownership unchanged', async () => {
  const f = fixture(); await f.controller.save('A'); const before = f.capture(), savedId = f.controller.readCurrent().savedVersionId;
  f.host.loadDocument = async () => { throw new Error('旧画布暂不可读'); };
  await assert.rejects(f.controller.open('b'.repeat(32)), /暂不可读/);
  assert.deepEqual(f.capture(), before); assert.equal(f.controller.readCurrent().savedVersionId, savedId); assert.deepEqual(f.s.views, []);
});

for (const action of ['create', 'open']) test(`edit in the saved-commit microtask gap prevents ${action} replacement`, async () => {
  const f = fixture({ choice: { action: 'save', name: 'A 保留' } }); let edited = false;
  f.host.onStateChange = state => {
    if (!edited && state.savedVersionId) {
      edited = true; queueMicrotask(() => { f.s.graph.nodes[0].text = 'commit 之后的新编辑'; });
    }
  };
  await assert.rejects(f.controller[action](action === 'open' ? 'b'.repeat(32) : 'B'), /画布已变化/);
  assert.equal(f.s.records.length, 1); assert.deepEqual(f.s.installed, []); assert.deepEqual(f.s.views, []);
  assert.equal(f.s.records[0].document.canvas.nodes[0].text, 'A');
  assert.equal(f.s.graph.nodes[0].text, 'commit 之后的新编辑'); assert.equal(f.controller.readCurrent().dirty, true);
});

test('a failing state observer cannot leave the transaction lock held', async () => {
  const f = fixture({ active: false });
  f.host.onStateChange = () => { throw new Error('observer failed'); };
  await assert.rejects(f.controller.create('B'), /observer failed/); assert.equal(f.controller.readCurrent().busy, false);
  f.host.onStateChange = () => {}; await f.controller.create('B'); assert.equal(f.s.records.length, 1);
});

test('one-click create preserves dirty work as a version before opening an empty canvas', async () => {
  const f = fixture({active: false});
  await f.controller.create('先前工作');
  const first = f.s.records[0];
  f.s.graph.nodes.push({id:'pending'});
  await f.controller.create('未命名画布', {preserveDraft: true});
  assert.equal(f.s.records.length, 3);
  assert.equal(f.s.records[1].document.name, '先前工作');
  assert.equal(f.s.records[1].document.canvas.nodes.length, 1);
  assert.equal(first.document.canvas.nodes.length, 0);
  assert.deepEqual(f.s.graph.nodes, []);
});

test('card rename of the current draft uses one immutable saved version and the exact live content', async () => {
  const f=fixture(), before=structuredClone(f.s.graph);
  await f.controller.changeVersion({currentIdentity:'first'},true,'rename','重命名后');
  assert.equal(f.s.title,'重命名后');assert.equal(f.s.records.length,1);assert.deepEqual(f.s.records[0].document.canvas,before);
  assert.equal(f.controller.readCurrent().dirty,false);assert.deepEqual(f.s.views,[]);
});

test('card copy retains the current draft and creates an independent project without navigating', async () => {
  const f=fixture(), before=f.capture();
  await f.controller.changeVersion({},true,'copy','独立副本');
  assert.deepEqual(f.capture(),before);assert.equal(f.s.records.length,1);
  assert.match(f.s.records[0].document.project_id,/^[a-f0-9]{32}$/);assert.equal(f.s.records[0].name,'独立副本');
  assert.deepEqual(f.s.records[0].document.canvas,f.s.graph);assert.deepEqual(f.s.installed,[]);assert.deepEqual(f.s.views,[]);
});

for(const action of ['rename','copy']) test(`card ${action} of another project retains its version and leaves the live canvas untouched`,async()=>{
  const f=fixture(), before=f.capture(), project='b'.repeat(32);
  const old=await f.host.loadDocument(project), source=structuredClone(old);f.host.loadDocument=async()=>old;
  await f.controller.changeVersion({id:project,latestId:project},false,action,'另一个名称');
  assert.deepEqual(old,source);assert.deepEqual(f.capture(),before);assert.equal(f.s.records.length,1);
  assert.equal(f.s.records[0].document.project_id===project,action==='rename');assert.deepEqual(f.s.installed,[]);
});

test('card write holds the session lock through persistence and rejects concurrent create, open and copy',async()=>{
  const f=fixture({phase:'save'}), promise=f.controller.changeVersion({},true,'copy','副本');await f.waiting;
  assert.equal(f.controller.readCurrent().busy,true);
  await assert.rejects(f.controller.create('并发'),/已有画布操作/);
  await assert.rejects(f.controller.open('b'.repeat(32)),/已有画布操作/);
  await assert.rejects(f.controller.changeVersion({},true,'copy','另一个副本'),/已有画布操作/);
  f.release();await promise;assert.equal(f.s.records.length,1);assert.equal(f.controller.readCurrent().busy,false);
});

test('card loading validates both exact saved version and logical project identity',async()=>{
  const f=fixture();f.host.loadDocument=async id=>({id,document:{project_id:'c'.repeat(32),name:'不属于该项目'}});
  await assert.rejects(f.controller.changeVersion({id:'b'.repeat(32)},false,'rename','名称'),/身份无法核实/);
  assert.deepEqual(f.s.records,[]);assert.equal(f.controller.readCurrent().busy,false);
});

test('a canvas change during card loading prevents persistence and keeps the changed draft',async()=>{
  const f=fixture({phase:'load'}),promise=f.controller.changeVersion({id:'b'.repeat(32)},false,'copy','副本');await f.waiting;
  f.s.graph.nodes[0].text='新的编辑';f.release();await assert.rejects(promise,/画布已变化/);
  assert.equal(f.s.graph.nodes[0].text,'新的编辑');assert.deepEqual(f.s.records,[]);
});

test('one-click card opening saves a dirty draft before replacing it, with no switch prompt',async()=>{
  const f=fixture({choice:{action:'cancel'}});
  await f.controller.open('b'.repeat(32),{preserveDraft:true});
  assert.equal(f.s.records.length,1);assert.equal(f.s.records[0].document.canvas.nodes[0].text,'A');
  assert.deepEqual(f.s.installed,['b'.repeat(32)]);assert.deepEqual(f.s.views,['editor']);
});

test('a stale current-card rename never renames the canvas now active in the workspace',async()=>{
  const f=fixture(),before=f.capture();
  await assert.rejects(f.controller.changeVersion({currentIdentity:'previous-canvas'},true,'rename','误改名称'),/画布已变化/);
  assert.deepEqual(f.capture(),before);assert.deepEqual(f.s.records,[]);
});
