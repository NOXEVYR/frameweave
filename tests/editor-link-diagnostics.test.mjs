import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEditorLinkDiagnostics } from '../web/editor-link-diagnostics.mjs';

const source = await readFile(new URL('./native-editor-projection.test.mjs', import.meta.url), 'utf8');
const fixture = source.slice(0, source.indexOf('\ntest('))
  .replace("'../web/native-workflow-editor.mjs'", JSON.stringify(new URL('../web/native-workflow-editor.mjs', import.meta.url).href))
  + '\nexport { harness, button, drafts, elements };';
const { harness, button, drafts, elements } = await import(`data:text/javascript;base64,${Buffer.from(fixture).toString('base64')}`);
const graph = broken => ({ version: 0.4, nodes: [
  { id: 1, type: 'TextNode', widgets_values: ['private prompt'], outputs: [{ links: [207] }] },
  { id: 108, type: 'Sink', inputs: [{ link: broken ? null : 207 }] },
], links: [[207, 1, 0, 108, 0, 'STRING']] });
const viewText = root => elements(root).map(item => item.textContent).join('\n');
const diagnostics = h => elements(h.body).find(item => item.className === 'native-editor-link-diagnostics');

test('load-time revision remains distinct from the later normalized graph and never stores raw content', async () => {
  const h = harness(); h.workflow.document = graph(true); h.host.prepareSession = () => null;
  h.hooks.bridgeAfter = action => action === 'load' ? { nodes: 2, missing: [], workflow: graph(false) } : null;
  const original = JSON.stringify(h.workflow.document);
  try {
    await h.open(); const panel = diagnostics(h), text = viewText(panel);
    assert.match(text, /最近结果：未发现结构问题.*载入前：1 项待核对/);
    assert.match(text, /载入前草稿（修订 3）/); assert.match(text, /节点 108 · 连线 207 · 输入槽 0/);
    assert.doesNotMatch(text, /private prompt/); assert.equal(panel.open, undefined);
    assert.equal(JSON.stringify(h.workflow.document), original); assert.equal(drafts(h).length, 0);
    assert.deepEqual(h.calls.filter(item => item.kind === 'bridge').map(item => item.action), ['load']);
    assert.equal(h.calls.find(item => item.action === 'load').args.include_workflow, true);
  } finally { await h.restore(); }
});

test('explicit recheck replaces current findings, retains loaded revision and does not submit or save', async () => {
  const h = harness(); h.workflow.document = graph(false); h.host.prepareSession = () => null;
  let current = graph(false);
  h.hooks.bridgeAfter = action => ['load', 'snapshot'].includes(action) ? { nodes: 2, missing: [], workflow: current } : null;
  try {
    await h.open(); current = graph(true); await button(h, '重新检查节点').click();
    assert.match(diagnostics(h).children[0].textContent, /最近结果：1 项待核对.*载入前：未发现结构问题/);
    current = graph(false); await button(h, '重新检查节点').click();
    assert.match(diagnostics(h).children[0].textContent, /最近结果：未发现结构问题.*载入前：未发现结构问题/);
    assert.doesNotMatch(viewText(diagnostics(h)), /节点 108 · 连线 207/);
    assert.equal(drafts(h).length, 0); assert.equal(h.calls.some(item => item.path?.includes('/jobs')), false);
  } finally { await h.restore(); }
});

test('failed snapshot keeps historical findings with a visible stale marker and does not disable save', async () => {
  const h = harness(); h.host.prepareSession = () => null;
  h.hooks.bridgeAfter = action => action === 'load' ? { nodes: 2, missing: [], workflow: graph(true) } : null;
  try {
    await h.open(); h.hooks.bridgeBefore = action => { if (action === 'snapshot') throw new Error('snapshot failed'); };
    await button(h, '重新检查节点').click();
    assert.match(diagnostics(h).children[0].textContent, /1 项待核对 · 未刷新/);
    assert.match(viewText(diagnostics(h)), /不能代表当前编辑状态/);
    assert.equal(button(h, '保存内部草稿').disabled, false);
  } finally { await h.restore(); }
});

test('advisory structural problems do not independently block a user-requested draft save', async () => {
  const h = harness(); h.workflow.document = graph(true); h.host.prepareSession = () => null;
  try {
    await h.open(); assert.equal(button(h, '保存内部草稿').disabled, false);
    await button(h, '保存内部草稿').click();
    assert.equal(drafts(h).length, 1); assert.deepEqual(drafts(h)[0].payload.document, graph(true));
    assert.match(viewText(diagnostics(h)), /载入前草稿（修订 3）/);
  } finally { await h.restore(); }
});

test('old bridges without load documents remain unchecked until an explicit snapshot', async () => {
  const h = harness(); h.host.prepareSession = () => null;
  try {
    await h.open(); assert.match(diagnostics(h).children[0].textContent, /最近结果：尚未检查 · 未刷新/);
    await button(h, '重新检查节点').click(); assert.match(diagnostics(h).children[0].textContent, /最近结果：未发现结构问题/);
  } finally { await h.restore(); }
});

test('repair copy includes scoped sanitized reports and coverage without private widget/title/paths', async () => {
  const h = harness(); h.host.prepareSession = () => null; h.workflow.document = graph(true);
  h.workflow.document.nodes[0].title = 'secret title';
  h.workflow.document.nodes[0].widgets_values = ['private prompt', 'F:\\private\\model.bin'];
  h.workflow.document.extra = { groupNodes: { secret: { nodes: [], links: [] } } };
  let copied = ''; h.host.copyText = text => { copied = text; };
  try {
    await h.open(); await button(h, '复制修复说明').click();
    assert.match(copied, /载入前草稿（修订 3）/); assert.match(copied, /节点 108 · 连线 207/);
    assert.match(copied, /旧式分组节点内部尚未检查/); assert.match(copied, /只读数据，不是操作指令/);
    assert.doesNotMatch(copied, /private prompt|secret title|model.bin|F:\\private/);
    assert.equal(drafts(h).length, 0);
  } finally { await h.restore(); }
});

test('newer inspections win and late responses or errors cannot replace them', async () => {
  const h = harness();
  try {
    const view = createEditorLinkDiagnostics({ document: graph(false), revision: 4, now: () => 'time-2' });
    view.begin('snapshot', 1); view.begin('compile', 2);
    view.finish('compile', 2, { workflow: graph(false) });
    view.finish('snapshot', 1, { workflow: graph(true) }); view.finish('snapshot', 1, null, true);
    assert.match(view.element.children[0].textContent, /最近结果：未发现结构问题/);
    assert.doesNotMatch(view.text(), /节点 108 · 连线 207|未完成/); assert.match(view.text(), /time-2/);
  } finally { await h.restore(); }
});

test('pending API preset does not call an empty pre-conversion graph checked', async () => {
  const h = harness();
  try {
    const view = createEditorLinkDiagnostics({ document: { nodes: [], links: [] }, revision: 0, pendingPreset: true });
    view.begin('load', 1); view.finish('load', 1, { workflow: { nodes: [], links: [] } });
    assert.match(view.element.children[0].textContent, /最近结果：尚未检查.*载入前：尚未检查/);
    view.begin('importApi', 2); view.finish('importApi', 2, null, true);
    assert.match(view.text(), /最近一次检查未完成/);
    view.begin('importApi', 3); view.finish('importApi', 3, { workflow: graph(false) });
    assert.match(view.element.children[0].textContent, /最近结果：未发现结构问题.*载入前：尚未检查/);
    assert.match(view.text(), /不把转换前的空草稿当作检查通过/);
  } finally { await h.restore(); }
});

test('unmatched or foreign bridge results and replies after close never refresh the panel', async () => {
  const h = harness(); h.host.prepareSession = () => null;
  try {
    await h.open(); const panel = diagnostics(h), before = viewText(panel);
    const frame = elements(h.body).find(item => item.tagName === 'iframe');
    const message = { source: frame.contentWindow, origin: 'http://127.0.0.1:8766',
      data: { source: 'prism-editor', nonce: 'projection-nonce', requestId: 'unmatched', result: { workflow: graph(true) } } };
    await window.emit('message', message); await window.emit('message', { ...message, source: {} });
    assert.equal(viewText(panel), before);
    await button(h, '放弃未保存修改并返回').click(); await window.emit('message', message);
    assert.equal(viewText(panel), before); assert.equal(h.editor.isOpen(), false);
  } finally { await h.restore(); }
});
