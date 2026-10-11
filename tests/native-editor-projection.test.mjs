import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorkflowEditor } from '../web/native-workflow-editor.mjs';

const EDITOR = `e-${'d'.repeat(24)}`, BACKEND = 'http://127.0.0.1:8188';
const clone = value => structuredClone(value);
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map();
    this.parentElement = null; this.textContent = ''; this.hidden = false; this.disabled = false;
    const classes = new Set();
    this.classList = { add: (...items) => items.forEach(item => classes.add(item)),
      remove: (...items) => items.forEach(item => classes.delete(item)), contains: item => classes.has(item) };
  }
  append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  async emit(name, event = {}) { await Promise.all([...this.listeners.get(name) || []].map(callback => callback(event))); }
  showModal() { this.open = true; } close() { this.open = false; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
  click() { if (!this.disabled) return this.onclick?.({ target: this }); }
}
const elements = root => [root, ...root.children.flatMap(elements)];
const button = (h, label) => elements(h.body).find(item => item.tagName === 'button' && item.textContent === label);

function harness({ native = 'draft N', baseline = 'old B', fallback = 'own F', mediaType = null, supportsMedia = true,
  supportsMapping = false, supportsNestedMedia = false, supportsFitView = false, executionId = '1' } = {}) {
  const input = mediaType || 'text', classType = mediaType ? 'LoadMedia' : 'TextNode', fieldId = mediaType ? 'media' : 'prompt';
  let mediaReceipt = null, mappingReceipt = null, captureCount = 0;
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const body = new Element('body'), listeners = new Map(), calls = [], errors = [], hooks = {};
  let graph = { version: 0.4, nodes: [{ id: 1, type: classType, title: 'Prompt', widgets_values: [native] }], links: [], extra: { preserved: 'native' } };
  const session = { session_id: 'projection-session', backend_url: BACKEND, origin: 'http://127.0.0.1:8766', url: 'http://127.0.0.1:8766/editor', bridgeNonce: 'projection-nonce' };
  const workflow = { id: EDITOR, name: 'Connected projection', revision: 3, document: clone(graph), nodes: 1 };
  const node = { id: 'outer-node', data: { editor_id: EDITOR, packageValues: { [fieldId]: fallback }, editor_baseline: { [fieldId]: baseline }, editor_controls: mediaType ? [{node_id:executionId,input,widget_node_id:executionId,widget_name:input}] : [] } };
  const provenance = [{ field_id: fieldId, node_id: executionId, input, class_type: classType, type: mediaType || 'text', origin: 'connected', value: mediaType ? 'connected.png' : 'source C',
    ...(mediaType ? {media_owner:{name:'connected.png',backend:BACKEND,media_type:mediaType}} : {}),
    edge_id: 'edge1', source_id: 'source1', stored_fallback: fallback, baseline }];
  const window = { addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    async emit(name, event) { await Promise.all([...listeners.get(name) || []].map(callback => callback(event))); } };
  const compile = () => ({ workflow: { ...clone(graph), extra: { ...graph.extra, frontendVersion: 'official-test' } },
    output: { [executionId]: { class_type: classType, inputs: { [input]: graph.nodes[0].widgets_values[0] }, _meta: { title: 'Prompt' } } },
    controls: [{ node_id: executionId, input, widget_node_id: executionId, widget_name: input, ...(mediaReceipt ? {media_receipt:mediaReceipt} : {}),
      ...(mappingReceipt ? {mapping_receipt:mappingReceipt} : {}) }], unmapped: [] });
  const document = { body, createElement(tag) {
    const element = new Element(tag);
    if (tag === 'iframe') element.contentWindow = { postMessage(message, origin) {
      calls.push({ kind: 'bridge', action: message.action, args: clone(message) });
      void Promise.resolve().then(async () => {
        let result, error;
        try {
          await hooks.bridgeBefore?.(message.action, message);
          if (message.action === 'load') { graph = clone(message.document); result = { nodes: graph.nodes.length, missing: [] }; }
          else if (message.action === 'fitView') result = { fitted: true };
          else if (message.action === 'compile') result = compile();
          else if (message.action === 'snapshot') result = { workflow: clone(graph), nodes: 1, missing: [] };
          else if (message.action === 'captureMedia') {
            mediaReceipt = `receipt-${++captureCount}`;
            result = {captured:message.bindings.map(binding=>({field_id:binding.field_id,node_id:executionId,input,type:mediaType,receipt:mediaReceipt,native_value:graph.nodes[0].widgets_values[0],preview_state:'pending'})),unsupported:[]};
          } else if (message.action === 'captureMappings') {
            mappingReceipt = `mapping-${++captureCount}`;
            result = {captured:message.bindings.map(binding=>({...binding,receipt:mappingReceipt,native_value:graph.nodes[0].widgets_values[0]})),unsupported:[]};
          } else if (message.action === 'patch') {
            for (const patch of message.patches) {
              assert.equal(patch.node_id, executionId); assert.equal(patch.widget_name, input);
              if (mediaType) assert.equal(patch.media_receipt,mediaReceipt);
              if (mappingReceipt) assert.equal(patch.mapping_receipt,mappingReceipt);
              assert.equal(graph.nodes[0].widgets_values[0], patch.expected_value);
              graph.nodes[0].widgets_values[0] = patch.value;
            }
            result = { applied: message.patches.map(patch => ({ node_id: patch.node_id, widget_name: patch.widget_name })), unsupported: [] };
          } else if (message.action === 'importApi') {
            graph = { version: 0.4, nodes: [{ id: 1, type: 'TextNode', title: 'Prompt', widgets_values: [message.prompt['1'].inputs.text] }], links: [], extra: { imported: true } };
            result = { ...compile(), workflow: clone(graph), nodes: 1, missing: [] };
          } else throw new Error(`unexpected bridge action ${message.action}`);
          result = await hooks.bridgeAfter?.(message.action, message, result) || result;
        } catch (failure) { error = failure.message; errors.push(failure); }
        await window.emit('message', { source: element.contentWindow, origin: session.origin,
          data: { source: 'prism-editor', nonce: session.bridgeNonce, requestId: message.requestId, result, ...(error ? { error } : {}) } });
      });
    } };
    return element;
  } };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
  let current = true, choices = { prompt: 'inner' };
  const host = {
    async api(path, payload) {
      calls.push({ kind: 'api', path, payload: clone(payload), display: graph.nodes[0].widgets_values[0] });
      if (path === `/api/editor-workflows/${EDITOR}`) return workflow;
      if (path.endsWith('/session')) return session;
      if (path.endsWith('/draft')) {
        workflow.document = clone(payload.document); workflow.revision++;
        await hooks.afterDraftWrite?.(payload); return { revision: workflow.revision };
      }
      if (path === '/api/editor-sessions/close') return { closed: true };
      throw new Error(`unexpected API ${path}`);
    },
    async prepareSession() { return { provenance: clone(provenance), ownMedia: mediaType ? [{...clone(provenance[0]),origin:'own',value:fallback,media_owner:{name:fallback,backend:BACKEND,media_type:mediaType}}] : [], pending: [], assertCurrent() { if (!current) throw new Error('direct source changed'); } }; },
    async ensureBackend(node, workflow, force) { return force ? null : BACKEND; }, async ensureInstance() {}, fields() { return mediaType ? [{id:fieldId,node_id:executionId,input,label:'Reference',type:mediaType}] : []; },
    async resolveConnectedConflicts(conflicts) { calls.push({ kind: 'resolve', conflicts: clone(conflicts) }); return hooks.resolve ? hooks.resolve(conflicts) : choices; },
    async applyInterface(node, result) { calls.push({ kind: 'apply', result: clone(result) }); return hooks.apply ? hooks.apply(result) : { applied: true }; },
    async applied() { calls.push({ kind: 'applied' }); }, toast(text) { calls.push({ kind: 'toast', text }); },
    downloadJSON(value, filename) { calls.push({ kind: 'download', value: clone(value), filename }); }, releaseSession() {},
  };
  const editor = createNativeWorkflowEditor(host);
  return { editor, node, host, body, calls, hooks, errors, workflow, provenance,
    value: () => graph.nodes[0].widgets_values[0], setValue: value => { graph.nodes[0].widgets_values[0] = value; },
    setChoices: value => { choices = value; }, setCurrent: value => { current = value; },
    async open(prompt = null) {
      if (prompt) await editor.openApiPrompt(node, prompt, async () => {
        await hooks.beforePresetBind?.(); calls.push({ kind: 'bound' });
      }); else await editor.open(node);
      const frame = elements(body).find(item => item.tagName === 'iframe');
      await window.emit('message', { source: frame.contentWindow, origin: session.origin,
        data: { source: 'prism-editor', nonce: session.bridgeNonce, action: 'ready', capabilities:{media_capture:supportsMedia?1:0,mapping_capture:supportsMapping?1:0,
          media_nested_capture:supportsNestedMedia?1:0,fit_view:supportsFitView?1:0} } });
    },
    async restore() {
      if (editor.isOpen()) await button(this, '放弃未保存修改并返回').click();
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
    }
  };
}
const drafts = h => h.calls.filter(call => call.path?.endsWith('/draft'));
const closes = h => h.calls.filter(call => call.path === '/api/editor-sessions/close');

test('host mapping capability enables nested scalar display, guards no-op save and strips receipts before apply', async () => {
  const h = harness({executionId:'6:4',supportsMapping:true,native:'source C'});
  try {
    await h.open();
    const captureIndex = h.calls.findIndex(call=>call.action==='captureMappings');
    assert.ok(captureIndex>=0); assert.equal(h.errors.length,0);
    await button(h,'保存内部草稿').click();
    assert.equal(drafts(h).length,1); assert.equal(h.value(),'source C');
    const guarded = h.calls.slice(captureIndex+1).filter(call=>['compile','snapshot'].includes(call.action));
    assert.ok(guarded.length>=4); assert.ok(guarded.every(call=>call.args.mapping_receipts?.[0].node_id==='6:4'));
    await button(h,'应用参数并返回').click();
    const applied=h.calls.find(call=>call.kind==='apply');
    assert.equal(applied.result.controls[0].mapping_receipt,undefined);
    assert.equal(JSON.stringify(applied.result).includes('mapping-1'),false);
  } finally {await h.restore();}
});

test('old host bridge never sends captureMappings and preserves nested N with an explicit deferred explanation', async () => {
  const h=harness({executionId:'6:4',supportsMapping:false});
  try {
    await h.open(); assert.equal(h.value(),'draft N');
    assert.equal(h.calls.some(call=>call.action==='captureMappings'),false);
    assert.ok(elements(h.body).some(item=>/此子图输入尚不能安全临时显示/.test(item.textContent)));
    await button(h,'保存内部草稿').click(); assert.equal(drafts(h).length,1);
  } finally {await h.restore();}
});

test('new host mapping capability cannot opt nested image input into media capture or display', async () => {
  const h=harness({executionId:'6:4',supportsMapping:true,supportsMedia:true,mediaType:'image',native:'own.png',baseline:'own.png',fallback:'own.png'});
  try {
    await h.open(); assert.equal(h.value(),'own.png'); assert.equal(h.errors.length,0);
    assert.equal(h.calls.some(call=>call.action==='captureMappings'||call.action==='captureMedia'||call.action==='patch'),false);
    assert.ok(elements(h.body).some(item=>/此子图输入尚不能安全临时显示/.test(item.textContent)));
  } finally {await h.restore();}
});

for (const mediaType of ['image', 'video', 'audio']) test(`${mediaType}: own F sync precedes C capture, draft stores F and display restores C`, async () => {
  const h=harness({native:'baseline.png',baseline:'baseline.png',fallback:'own.png',mediaType});
  try {
    await h.open(); assert.equal(h.value(),'connected.png'); assert.equal(h.errors.length,0);
    const captures=h.calls.filter(call=>call.action==='captureMedia');
    assert.equal(captures.length,2); assert.equal(captures[0].args.bindings[0].value,'own.png'); assert.equal(captures[1].args.bindings[0].value,'connected.png');
    await button(h,'保存内部草稿').click();
    assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0],'own.png'); assert.equal(h.value(),'connected.png');
    assert.equal(h.node.data.packageValues.media,'own.png');
  } finally {await h.restore();}
});

test('old bridge without media capability reports pending immediately and never sends an unanswered request', async () => {
  const h=harness({native:'baseline.png',baseline:'baseline.png',fallback:'own.png',mediaType:'image',supportsMedia:false});
  try {
    await h.open(); assert.equal(h.value(),'baseline.png');
    assert.equal(h.calls.some(call=>call.action==='captureMedia'),false);
    assert.equal(button(h,'应用参数并返回').disabled,true);
    assert.ok(elements(h.body).some(item=>/待处理|同步待确认/.test(item.textContent)));
    assert.equal(h.node.data.packageValues.media,'own.png');
  } finally {await h.restore();}
});

test('parent draft persistence captures native draft N rather than B or connected C', async () => {
  const h = harness(); const data = clone(h.node.data);
  try {
    await h.open(); assert.equal(h.value(), 'source C');
    await button(h, '保存内部草稿').click();
    assert.equal(drafts(h).length, 1); assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'draft N');
    assert.equal(drafts(h)[0].payload.document.extra.frontendVersion, 'official-test');
    assert.equal(h.value(), 'source C'); assert.deepEqual(h.node.data, data); assert.equal(h.editor.isOpen(), true);
  } finally { await h.restore(); }
});

for (const label of ['← 返回画布', '更换工作流引擎']) {
  test(`${label} persists clean N and restores C before closing the old session`, async () => {
    const h = harness();
    try {
      await h.open(); await button(h, label).click();
      assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'draft N');
      assert.equal(closes(h)[0].display, 'source C'); assert.equal(h.editor.isOpen(), false);
    } finally { await h.restore(); }
  });
}

test('parent apply receives a matched clean document/prompt, then restores display before close', async () => {
  const h = harness();
  try {
    await h.open(); await button(h, '应用参数并返回').click();
    const apply = h.calls.find(call => call.kind === 'apply');
    assert.equal(apply.result.workflow.nodes[0].widgets_values[0], 'draft N'); assert.equal(apply.result.output['1'].inputs.text, 'draft N');
    assert.equal(closes(h)[0].display, 'source C'); assert.equal(h.editor.isOpen(), false); assert.equal(drafts(h).length, 0);
  } finally { await h.restore(); }
});

test('parent export emits clean N and keeps connected C visible', async () => {
  const h = harness();
  try {
    await h.open(); await button(h, '导出完整工作流').click();
    assert.equal(h.calls.find(call => call.kind === 'download').value.nodes[0].widgets_values[0], 'draft N');
    assert.equal(h.value(), 'source C'); assert.equal(h.editor.isOpen(), true); assert.equal(drafts(h).length, 0);
  } finally { await h.restore(); }
});

test('explicit inner conflict choice persists I while own F and baseline B remain intact', async () => {
  const h = harness(); const data = clone(h.node.data);
  try {
    await h.open(); h.setValue('edited I'); await button(h, '保存内部草稿').click();
    assert.equal(h.calls.find(call => call.kind === 'resolve').conflicts[0].inner_value, 'edited I');
    assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'edited I');
    assert.equal(h.value(), 'edited I'); assert.deepEqual(h.node.data, data);
  } finally { await h.restore(); }
});

for (const label of ['保存内部草稿', '← 返回画布', '更换工作流引擎', '应用参数并返回', '导出完整工作流']) {
  test(`${label} conflict cancellation retains I, leaves editor open and writes nothing`, async () => {
    const h = harness();
    try {
      await h.open(); h.setValue('edited I'); h.setChoices(null); await button(h, label).click();
      assert.equal(h.value(), 'edited I'); assert.equal(h.editor.isOpen(), true);
      assert.equal(drafts(h).length, 0); assert.equal(closes(h).length, 0);
      assert.equal(h.calls.some(call => call.kind === 'apply' || call.kind === 'download'), false);
    } finally { await h.restore(); }
  });
}

test('cancelled apply selection restores C and keeps the editor open', async () => {
  const h = harness();
  try {
    await h.open(); h.hooks.apply = () => null; await button(h, '应用参数并返回').click();
    assert.equal(h.value(), 'source C'); assert.equal(h.editor.isOpen(), true); assert.equal(closes(h).length, 0);
  } finally { await h.restore(); }
});

test('unknown draft outcome disables storage and never retries a possible durable write', async () => {
  const h = harness();
  try {
    await h.open(); h.hooks.afterDraftWrite = () => { throw new Error('reply lost after durable write'); };
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 1); assert.equal(h.value(), 'source C');
    assert.equal(button(h, '保存内部草稿').disabled, true); assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 1);
    assert.ok(elements(h.body).some(item => /保存结果尚未确认/.test(item.textContent)));
  } finally { await h.restore(); }
});

test('direct source changes after entering prevent draft and apply', async () => {
  const h = harness();
  try {
    await h.open(); h.setCurrent(false); await button(h, '保存内部草稿').click(); await button(h, '应用参数并返回').click();
    assert.equal(drafts(h).length, 0); assert.equal(h.calls.some(call => call.kind === 'apply'), false);
    assert.equal(h.value(), 'source C'); assert.equal(h.editor.isOpen(), true);
  } finally { await h.restore(); }
});

test('I changed during conflict selection does not reuse the old inner choice', async () => {
  const h = harness();
  try {
    await h.open(); h.setValue('reviewed I'); h.hooks.resolve = () => { h.setValue('new I'); return { prompt: 'inner' }; };
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 0); assert.equal(h.value(), 'new I');
    assert.ok(elements(h.body).some(item => /输入在选择期间发生变化/.test(item.textContent)));
  } finally { await h.restore(); }
});

test('first API import saves the full nonconnected baseline before any C display patch', async () => {
  const h = harness(), prompt = { '1': { class_type: 'TextNode', inputs: { text: 'original API N' }, _meta: { title: 'Prompt' } } };
  const before = clone(prompt);
  try {
    await h.open(prompt);
    assert.equal(h.value(), 'source C'); assert.equal(drafts(h).length, 1);
    assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'original API N');
    const importIndex = h.calls.findIndex(call => call.action === 'importApi'), draftIndex = h.calls.findIndex(call => call.path?.endsWith('/draft')),
      patchIndex = h.calls.findIndex(call => call.action === 'patch');
    assert.ok(importIndex < draftIndex && draftIndex < patchIndex); assert.deepEqual(prompt, before);
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h)[1].payload.document.nodes[0].widgets_values[0], 'original API N');
  } finally { await h.restore(); }
});

test('raw metadata changes during preparation block storage and lock later save controls', async () => {
  const h = harness(); let snapshots = 0;
  try {
    await h.open(); h.hooks.bridgeAfter = (action, message, result) => {
      if (action === 'snapshot' && ++snapshots === 2) result.workflow.extra.changed = true; return result;
    };
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 0);
    assert.equal(button(h, '保存内部草稿').disabled, true); assert.equal(button(h, '应用参数并返回').disabled, true);
    assert.equal(h.value(), 'source C');
  } finally { await h.restore(); }
});

test('a direct-source change during an awaited bridge compile stops storage', async () => {
  const h = harness();
  try {
    await h.open(); h.hooks.bridgeAfter = async (action, message, result) => {
      if (action === 'compile') { await Promise.resolve(); h.setCurrent(false); } return result;
    };
    await button(h, '保存内部草稿').click();
    assert.equal(drafts(h).length, 0); assert.equal(h.value(), 'source C'); assert.equal(h.editor.isOpen(), true);
    assert.ok(elements(h.body).some(item => /direct source changed/.test(item.textContent)));
  } finally { await h.restore(); }
});

test('an apply callback may update authorized host state after storage without losing persisted status', async () => {
  const h = harness();
  try {
    await h.open(); h.hooks.apply = () => { h.setCurrent(false); return { applied: true }; };
    await button(h, '应用参数并返回').click();
    assert.equal(h.editor.isOpen(), false); assert.equal(closes(h)[0].display, 'source C');
    assert.equal(h.calls.some(call => call.kind === 'applied'), true);
  } finally { await h.restore(); }
});

test('unknown draft outcome without connected inputs also locks storage against resend', async () => {
  const h = harness();
  h.host.prepareSession = async () => ({ provenance: [], pending: [], assertCurrent() {} });
  try {
    await h.open(); h.hooks.afterDraftWrite = () => { throw new Error('reply lost after durable write'); };
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 1);
    assert.equal(button(h, '保存内部草稿').disabled, true); assert.equal(button(h, '应用参数并返回').disabled, true);
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 1);
    assert.ok(elements(h.body).some(item => /保存结果尚未确认/.test(item.textContent)));
  } finally { await h.restore(); }
});

test('initial API baseline save with a lost reply locks every retry path before overlay or bind', async () => {
  const h = harness(), prompt = { '1': { class_type: 'TextNode', inputs: { text: 'original API N' }, _meta: { title: 'Prompt' } } };
  try {
    h.hooks.afterDraftWrite = () => { throw new Error('initial baseline reply lost'); };
    await h.open(prompt); assert.equal(drafts(h).length, 1);
    assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'original API N');
    assert.equal(h.calls.some(call => call.kind === 'bound' || call.action === 'patch'), false);
    for (const label of ['保存内部草稿', '应用参数并返回', '导出完整工作流', '复核新增参数', '更换工作流引擎']) assert.equal(button(h, label).disabled, true);
    await button(h, '保存内部草稿').click(); assert.equal(drafts(h).length, 1);
    assert.ok(elements(h.body).some(item => /保存结果尚未确认/.test(item.textContent)));
  } finally { await h.restore(); }
});

test('initial binding failure reports the confirmed saved draft and blocks reopening the old candidate', async () => {
  const h = harness(), prompt = { '1': { class_type: 'TextNode', inputs: { text: 'original API N' }, _meta: { title: 'Prompt' } } };
  try {
    h.hooks.beforePresetBind = () => { throw new Error('source changed before bind'); };
    await h.open(prompt); assert.equal(drafts(h).length, 1); assert.equal(h.workflow.revision, 4);
    assert.equal(h.calls.some(call => call.kind === 'bound' || call.action === 'patch'), false);
    assert.ok(elements(h.body).some(item => /已保存/.test(item.textContent) && /绑定|画布/.test(item.textContent)));
    assert.equal(elements(h.body).some(item => /保存结果尚未确认/.test(item.textContent)), false);
    for (const label of ['保存内部草稿', '应用参数并返回', '复核新增参数', '更换工作流引擎']) assert.equal(button(h, label).disabled, true);
    await button(h, '更换工作流引擎').click(); await button(h, '复核新增参数').click(); assert.equal(drafts(h).length, 1);
  } finally { await h.restore(); }
});

test('apply saved successfully before outer binding failure retains confirmed revision and blocks resubmission', async () => {
  const h = harness();
  try {
    await h.open(); h.hooks.apply = () => ({ applied: true, workflow: { revision: 8 } });
    h.host.applied = async () => { throw new Error('canvas guard refused binding'); };
    await button(h, '应用参数并返回').click();
    assert.equal(h.workflow.revision, 8); assert.equal(h.value(), 'source C'); assert.equal(h.editor.isOpen(), true);
    assert.ok(elements(h.body).some(item => /已保存/.test(item.textContent) && /绑定|画布/.test(item.textContent)));
    assert.equal(elements(h.body).some(item => /保存结果尚未确认/.test(item.textContent)), false);
    for (const label of ['保存内部草稿', '应用参数并返回', '复核新增参数', '更换工作流引擎']) assert.equal(button(h, label).disabled, true);
    await button(h, '应用参数并返回').click(); assert.equal(h.calls.filter(call => call.kind === 'apply').length, 1);
  } finally { await h.restore(); }
});


test('pre-overlay compile failure allows native repair and clean save without connected display', async () => {
  const h = harness(); const data = clone(h.node.data); let compiles = 0;
  try {
    h.hooks.bridgeBefore = action => {
      if (action === 'compile' && ++compiles === 1) throw new Error('temporary compile failure before overlay');
    };
    await h.open();
    assert.equal(h.value(), 'draft N');
    assert.equal(h.calls.filter(call => call.action === 'patch').length, 0);
    h.setValue('repaired native I'); await button(h, '重新检查节点').click();
    for (const label of ['保存内部草稿', '应用参数并返回', '导出完整工作流']) assert.equal(button(h, label).disabled, false);
    await button(h, '保存内部草稿').click();
    assert.equal(drafts(h).length, 1);
    assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'repaired native I');
    assert.equal(h.calls.filter(call => call.action === 'patch').length, 0);
    assert.equal(h.value(), 'repaired native I'); assert.deepEqual(h.node.data, data);
    assert.ok(elements(h.body).some(item => /连线值尚未临时显示|未施加连线显示覆盖|未显示连线值/.test(item.textContent)));
  } finally { await h.restore(); }
});

test('failure after a connected patch locks persistence even after native repair and recheck', async () => {
  const h = harness(); let compiles = 0;
  try {
    h.hooks.bridgeBefore = action => {
      if (action === 'compile' && ++compiles === 2) throw new Error('compile verification failed after patch');
    };
    await h.open();
    assert.equal(h.calls.filter(call => call.action === 'patch').length, 1);
    assert.equal(h.value(), 'source C');
    h.setValue('native repair after uncertain overlay'); await button(h, '重新检查节点').click();
    for (const label of ['保存内部草稿', '应用参数并返回', '导出完整工作流']) assert.equal(button(h, label).disabled, true);
    await button(h, '保存内部草稿').click(); await button(h, '应用参数并返回').click();
    assert.equal(drafts(h).length, 0);
    assert.equal(h.calls.some(call => call.kind === 'apply' || call.kind === 'download'), false);
    assert.equal(h.editor.isOpen(), true);
  } finally { await h.restore(); }
});

for (const supportsFitView of [false, true]) test(`viewport host button capability ${supportsFitView} never compiles or saves`, async () => {
  const h = harness({ supportsFitView });
  try {
    await h.open(); const before = h.calls.length;
    assert.equal(button(h, '适应当前工作流').disabled, !supportsFitView);
    await button(h, '适应当前工作流').click();
    assert.deepEqual(h.calls.slice(before).map(call => call.action || call.kind), supportsFitView ? ['fitView', 'toast'] : []);
    assert.equal(h.value(), 'source C'); assert.equal(drafts(h).length, 0);
  } finally { await h.restore(); }
});
for (const mediaType of ['image', 'video', 'audio']) test(`nested ${mediaType} host takes preview proof before mapping and clean-saves N`, async () => {
  const h = harness({ mediaType, native:'N.png', executionId:'6:1', supportsMapping:true, supportsNestedMedia:true });
  // No own-value change in this fixture: only the C projection is under test.
  h.node.data.editor_baseline = {}; h.host.fields = () => [];
  try {
    await h.open(); assert.equal(h.value(), 'connected.png');
    const actions = h.calls.filter(call => call.kind === 'bridge').map(call => call.action);
    assert.ok(actions.indexOf('captureMedia') < actions.indexOf('captureMappings'));
    const firstPatch = h.calls.find(call => call.action === 'patch');
    assert.ok(firstPatch.args.patches[0].media_receipt); assert.ok(firstPatch.args.patches[0].mapping_receipt);
    await button(h, '保存内部草稿').click();
    assert.equal(drafts(h).length, 1); assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0], 'N.png');
    assert.equal(h.value(), 'connected.png'); assert.equal(h.errors.length, 0);
    await button(h, '应用参数并返回').click();
    const applied = h.calls.find(call => call.kind === 'apply');
    assert.ok(applied); assert.equal(applied.result.controls[0].media_receipt, undefined);
    assert.equal(applied.result.controls[0].mapping_receipt, undefined);
  } finally { await h.restore(); }
});
for (const omitted of ['media','mapping','nested']) test(`nested media refuses missing ${omitted} capability without changing N`, async () => {
  const h = harness({ mediaType:'image', native:'N.png', executionId:'6:1', supportsMedia:omitted!=='media',
    supportsMapping:omitted!=='mapping', supportsNestedMedia:omitted!=='nested' });
  h.node.data.editor_baseline={}; h.host.fields=()=>[];
  try {
    await h.open(); assert.equal(h.value(),'N.png');
    assert.equal(h.calls.some(call=>['captureMedia','captureMappings','patch'].includes(call.action)),false);
    await button(h,'保存内部草稿').click(); assert.equal(drafts(h).length,1);
  } finally { await h.restore(); }
});

test('nested own F is synchronized before connected C and becomes the new clean internal fallback', async () => {
  const h=harness({native:'old.png',baseline:'old.png',fallback:'own.png',mediaType:'image',
    executionId:'6:1',supportsMapping:true,supportsNestedMedia:true});
  try{
    await h.open(); assert.equal(h.errors.length,0); assert.equal(h.value(),'connected.png');
    const changes=h.calls.filter(call=>call.action==='patch').map(call=>call.args.patches[0].value);
    assert.deepEqual(changes,['own.png','connected.png']);
    await button(h,'保存内部草稿').click();
    assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0],'own.png');
    assert.equal(h.node.data.packageValues.media,'own.png');assert.equal(h.value(),'connected.png');
  }finally{await h.restore();}
});

test('nested media with no mapping proof stays N and never persists its unused preview receipt', async () => {
  const h=harness({native:'N.png',mediaType:'image',executionId:'6:1',supportsMapping:true,supportsNestedMedia:true});
  h.node.data.editor_baseline={};h.host.fields=()=>[];
  h.hooks.bridgeAfter=(action,message,result)=>action==='captureMappings'?{
    captured:[],unsupported:message.bindings.map(binding=>({...binding,reason:'mapping_proof_unavailable'}))}:result;
  try{
    await h.open();assert.equal(h.value(),'N.png');
    assert.equal(h.calls.some(call=>call.action==='patch'),false);
    await button(h,'应用参数并返回').click();
    const saved=h.calls.find(call=>call.kind==='apply');assert.ok(saved);
    assert.equal(saved.result.unmapped[0].reason,'mapping_proof_unavailable');
    assert.equal(JSON.stringify(saved.result).includes('receipt-'),false);
  }finally{await h.restore();}
});

for (const executionId of ['1','6:1']) test(`hidden media ${executionId} clears only its successful synchronization block before C and Apply`,async()=>{
  const h=harness({native:'old.png',baseline:'old.png',fallback:'own.png',mediaType:'image',
    executionId,supportsMapping:true,supportsNestedMedia:true});
  const field=h.host.fields(h.node)[0];
  h.node.data.editor_hidden_updates=[{field:clone(field),value:'own.png',baseline:'old.png'}];
  try{
    await h.open();assert.equal(h.errors.length,0);assert.equal(h.value(),'connected.png');
    assert.equal(button(h,'应用参数并返回').disabled,false);
    await button(h,'保存内部草稿').click();assert.equal(drafts(h)[0].payload.document.nodes[0].widgets_values[0],'own.png');
    await button(h,'应用参数并返回').click();
    assert.equal(h.calls.filter(call=>call.kind==='apply').length,1);assert.equal(h.editor.isOpen(),false);
  }finally{await h.restore();}
});
for (const executionId of ['1','6:1']) test(`hidden media ${executionId} without a receipt remains blocked and cannot apply`,async()=>{
  const h=harness({native:'old.png',baseline:'old.png',fallback:'own.png',mediaType:'image',
    executionId,supportsMapping:true,supportsNestedMedia:true});
  const field=h.host.fields(h.node)[0];
  h.node.data.editor_hidden_updates=[{field:clone(field),value:'own.png',baseline:'old.png'}];
  h.hooks.bridgeAfter=(action,message,result)=>action==='captureMedia'?{
    captured:[],unsupported:message.bindings.map(binding=>({field_id:binding.field_id,reason:'native_preview_not_isolated'}))}:result;
  try{
    await h.open();assert.equal(h.value(),'old.png');assert.equal(button(h,'应用参数并返回').disabled,true);
    assert.equal(h.calls.some(call=>call.action==='patch'),false);
    await button(h,'应用参数并返回').click();assert.equal(h.calls.some(call=>call.kind==='apply'),false);
  }finally{await h.restore();}
});
