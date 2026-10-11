import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmEditorAdditions, resolveConnectedEditorValues, createNativeWorkflowEditor } from '../web/native-workflow-editor.mjs';

const EDITOR_ID = `e-${'c'.repeat(24)}`;
const BACKEND = 'http://127.0.0.1:8188';

// Independent minimal DOM harness: existing editor tests stay untouched.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map();
    this.parentElement = null; this.textContent = ''; this.hidden = false; this.disabled = false;
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) };
  }
  append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  async emit(name, event = {}) { await Promise.all([...(this.listeners.get(name) || [])].map(callback => callback(event))); }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit('close'); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
    this.parentElement = null;
  }
  click() { if (!this.disabled) return this.onclick?.({ target: this }); }
}

const elements = root => [root, ...root.children.flatMap(elements)];
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) { const result = predicate(); if (result) return result; await flush(); }
  assert.fail(`Timed out waiting for ${label}`);
}

function harness() {
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const messages = [], calls = [], body = new Element('body'), listeners = new Map();
  const document = { body, createElement(tag) {
    const element = new Element(tag);
    if (tag === 'iframe') element.contentWindow = { postMessage: (message, origin) => messages.push({ message, origin }) };
    return element;
  } };
  const window = {
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    async emit(name, event) { await Promise.all([...(listeners.get(name) || [])].map(callback => callback(event))); },
  };
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
  const session = { session_id: 'addition-session', backend_url: BACKEND,
    origin: 'http://127.0.0.1:8766', url: 'http://127.0.0.1:8766/editor', bridgeNonce: 'addition-nonce' };
  const workflow = { id: EDITOR_ID, name: 'Explicit frontend additions', revision: 7,
    document: { version: 0.4, nodes: [], links: [], extra: { source: 'unchanged bootstrap' } }, nodes: 0 };
  const node = { id: 'outer-node', data: { editor_id: EDITOR_ID, packageValues: {}, editor_baseline: {}, editor_controls: [] } };
  const host = {
    async api(path, payload) {
      calls.push({ kind: 'api', path, payload: structuredClone(payload) });
      if (path === `/api/editor-workflows/${EDITOR_ID}`) return workflow;
      if (path.endsWith('/session')) return session;
      if (path.endsWith('/draft')) { workflow.revision = 8; workflow.document = structuredClone(payload.document); return { revision: 8 }; }
      if (path === '/api/editor-sessions/close') return { closed: true };
      throw new Error(`Unexpected API path: ${path}`);
    },
    async ensureBackend() { return BACKEND; }, async ensureInstance() {}, fields() { return []; },
    async applyInterface(...args) { calls.push({ kind: 'applyInterface', args }); return { applied: true }; },
    async applied(...args) { calls.push({ kind: 'applied', args }); },
    toast(message) { calls.push({ kind: 'toast', message }); }, releaseSession() {},
  };
  const editor = createNativeWorkflowEditor(host);
  return { document, window, messages, calls, session, workflow, node, host, editor,
    bound: 0,
    async restore() {
      const discard = elements(body).find(item => item.textContent === '放弃未保存修改并返回');
      if (editor.isOpen() && discard) await discard.click();
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else delete globalThis.window;
    } };
}

const buttons = (h, text) => elements(h.document.body).find(item => item.tagName === 'button' && item.textContent === text);
const commands = (h, action) => h.messages.filter(item => item.message.action === action);
const drafts = h => h.calls.filter(call => call.path?.endsWith('/draft'));
const reviewDialog = h => elements(h.document.body).find(item => item.attributes['aria-label'] === '复核前端新增参数');

function promptFixture() {
  return { '2': { class_type: 'SaveVideo', inputs: { format: 'mp4', 'format.codec': 'h264' },
    _meta: { title: 'Original sink title', plugin: { keep: true } } } };
}
function reviewFixture(id = 'review-first', addedInputs = null) {
  return { review_id: id, added_inputs: addedInputs || [
    { node_id: '2', class_type: 'SaveVideo', input: 'format.codec.encoding', value: 'auto' },
    { node_id: '2', class_type: 'SaveVideo', input: 'codec', value: 'auto' },
  ] };
}
function reviewFailure(review) {
  return { review, semantic_mismatch: { issues: review.added_inputs.map(item => ({ code: 'added_input', node_id: item.node_id, input: item.input })) } };
}
async function respond(h, frame, command, result, error = null) {
  await h.window.emit('message', { source: frame.contentWindow, origin: h.session.origin,
    data: { source: 'prism-editor', nonce: h.session.bridgeNonce, requestId: command.message.requestId,
      result, ...(error ? { error } : {}) } });
}
async function firstImport(h, prompt, onPresetSaved = async () => { h.bound += 1; }) {
  await h.editor.openApiPrompt(h.node, prompt, onPresetSaved);
  const frame = elements(h.document.body).find(item => item.tagName === 'iframe');
  const handling = h.window.emit('message', { source: frame.contentWindow, origin: h.session.origin,
    data: { source: 'prism-editor', nonce: h.session.bridgeNonce, action: 'ready' } });
  const load = await waitFor(() => commands(h, 'load')[0], 'initial bootstrap');
  await respond(h, frame, load, { nodes: 0, missing: [] });
  const importing = await waitFor(() => commands(h, 'importApi')[0], 'initial API import');
  return { frame, handling, importing };
}
async function beginReview(h) {
  const reviewing = buttons(h, '复核新增参数').click();
  const dialog = await waitFor(() => reviewDialog(h), 'addition review dialog');
  return { reviewing, dialog };
}
async function confirmRetry(h, frame, ordinal) {
  const { reviewing, dialog } = await beginReview(h);
  elements(dialog).find(item => item.textContent === '确认补充并进入').click();
  const importing = await waitFor(() => commands(h, 'importApi')[ordinal], 'explicitly reviewed import');
  assert.equal(commands(h, 'load').length, 1, 'review retry preserves the quoted native snapshot');
  return { reviewing, importing };
}
function convertedFixture(prompt, review) {
  const output = structuredClone(prompt);
  for (const addition of review.added_inputs) output[addition.node_id].inputs[addition.input] = addition.value;
  return { workflow: { version: 0.4, nodes: [{ id: 2, type: 'SaveVideo', widgets_values: ['mp4', 'h264', 'auto', 'auto'] }], links: [] },
    output, accepted_added_inputs: structuredClone(review.added_inputs), controls: [], unmapped: [], missing: [], nodes: 1, links: 0 };
}
function assertUnbound(h) {
  assert.equal(h.bound, 0); assert.equal(drafts(h).length, 0);
  for (const label of ['应用参数并返回', '保存内部草稿', '导出完整工作流']) assert.equal(buttons(h, label).disabled, true);
  assert.equal(h.calls.some(call => call.kind === 'applyInterface' || call.kind === 'applied'), false);
  assert.equal(h.calls.some(call => /\/jobs|\/generate|\/prompt/.test(call.path || '')), false);
  assert.equal(buttons(h, '适应当前工作流').disabled, true, 'empty bootstrap is not an editable workflow');
  const panel = elements(h.document.body).find(item => item.className === 'native-editor-pending');
  assert.equal(panel.hidden, false, 'pending conversion explains the empty bootstrap');
}

test('unreviewed frontend additions fail closed without saving, binding, or retrying', async () => {
  const h = harness(), prompt = promptFixture(), before = structuredClone(prompt);
  try {
    const { frame, handling, importing } = await firstImport(h, prompt);
    assert.deepEqual(importing.message.prompt, before);
    assert.equal(Object.hasOwn(importing.message, 'accepted_added_inputs'), false);
    assert.equal(Object.hasOwn(importing.message, 'review_id'), false);
    await respond(h, frame, importing, reviewFailure(reviewFixture()), 'unproven frontend values');
    await handling; await flush();
    assertUnbound(h);
    assert.equal(buttons(h, '复核新增参数').hidden, false);
    assert.equal(reviewDialog(h), undefined);
    assert(elements(h.document.body).some(item => item.textContent === '确认 2 项新增参数后显示工作流'));
    assert.equal(buttons(h, '查看新增参数并继续').hidden, false);
    assert.equal(commands(h, 'importApi').length, 1);
    assert.deepEqual(prompt, before);
  } finally { await h.restore(); }
});

test('explicit review displays exact additions then sends the frozen review ID and values', async () => {
  const h = harness(), prompt = promptFixture(), original = structuredClone(prompt), review = reviewFixture();
  const frozen = structuredClone(review);
  try {
    const { frame, handling, importing } = await firstImport(h, prompt);
    await respond(h, frame, importing, reviewFailure(review), 'unproven values'); await handling;
    // Mutating the received fixture must not change the candidate already shown.
    review.added_inputs[0].value = 'changed after reply';
    const { reviewing, dialog } = await beginReview(h);
    const visible = elements(dialog).map(item => item.textContent).join('\n');
    for (const addition of frozen.added_inputs) {
      assert(visible.includes(addition.class_type)); assert(visible.includes(addition.input));
      assert(visible.includes(JSON.stringify(addition.value)));
    }
    assert.equal(visible.includes('changed after reply'), false);
    assertUnbound(h);
    assert.equal(commands(h, 'load').length, 1);
    elements(dialog).find(item => item.textContent === '确认补充并进入').click();
    const retry = await waitFor(() => commands(h, 'importApi')[1], 'reviewed import');
    assert.equal(commands(h, 'load').length, 1);
    assert.deepEqual(retry.message.prompt, original);
    assert.equal(retry.message.review_id, frozen.review_id);
    assert.deepEqual(retry.message.accepted_added_inputs, frozen.added_inputs);
    assertUnbound(h);
    const converted = convertedFixture(prompt, frozen);
    await respond(h, frame, retry, converted); await reviewing;
    assert.equal(h.bound, 1); assert.equal(drafts(h).length, 1);
    assert.deepEqual(drafts(h)[0].payload, { document: converted.workflow, base_revision: 7 });
    assert.equal(buttons(h, '应用参数并返回').disabled, false);
    assert.equal(buttons(h, '复核新增参数').hidden, true);
    assert.equal(elements(h.document.body).find(item => item.className === 'native-editor-pending').hidden, true);
    assert(elements(h.document.body).some(item => /按确认补充 2 项/.test(item.textContent)));
    assert.deepEqual(prompt, original);
  } finally { await h.restore(); }
});

for (const cancel of ['button', 'close', 'escape']) {
  test(`addition review ${cancel} cancellation never retries or saves`, async () => {
    const h = harness();
    try {
      const { frame, handling, importing } = await firstImport(h, promptFixture());
      await respond(h, frame, importing, reviewFailure(reviewFixture()), 'unproven values'); await handling;
      const { reviewing, dialog } = await beginReview(h);
      if (cancel === 'button') elements(dialog).find(item => item.textContent === '取消，保留原工作流').click();
      else if (cancel === 'close') elements(dialog).find(item => item.attributes['aria-label'] === '关闭').click();
      else await dialog.emit('cancel', { preventDefault() {} });
      await reviewing; await flush();
      assertUnbound(h); assert.equal(reviewDialog(h), undefined);
      assert.equal(commands(h, 'load').length, 1); assert.equal(commands(h, 'importApi').length, 1);
      assert.equal(buttons(h, '复核新增参数').hidden, false);
    } finally { await h.restore(); }
  });
}

test('new retry differences require another review and never inherit the first acceptance', async () => {
  const h = harness(), prompt = promptFixture(), first = reviewFixture();
  const next = reviewFixture('review-second', [{ node_id: '2', class_type: 'SaveVideo', input: 'codec', value: 'av1' }]);
  try {
    const { frame, handling, importing } = await firstImport(h, prompt);
    await respond(h, frame, importing, reviewFailure(first), 'first delta'); await handling;
    const retry = await confirmRetry(h, frame, 1);
    assert.equal(retry.importing.message.review_id, first.review_id);
    await respond(h, frame, retry.importing, reviewFailure(next), 'fresh delta'); await retry.reviewing; await flush();
    assertUnbound(h);
    assert.equal(commands(h, 'importApi').length, 2); assert.equal(reviewDialog(h), undefined);
    assert.equal(buttons(h, '复核新增参数').hidden, false);
    const second = await confirmRetry(h, frame, 2);
    assert.equal(second.importing.message.review_id, next.review_id);
    assert.deepEqual(second.importing.message.accepted_added_inputs, next.added_inputs);
    assert.deepEqual(second.importing.message.prompt, prompt);
    await respond(h, frame, second.importing, convertedFixture(prompt, next)); await second.reviewing;
    assert.equal(h.bound, 1); assert.equal(drafts(h).length, 1);
  } finally { await h.restore(); }
});

for (const code of ['value_changed', 'metadata_changed']) {
  test(`confirmed additions cannot bypass subsequent ${code} rejection`, async () => {
    const h = harness(), prompt = promptFixture(), before = structuredClone(prompt);
    try {
      const { frame, handling, importing } = await firstImport(h, prompt);
      await respond(h, frame, importing, reviewFailure(reviewFixture()), 'unproven values'); await handling;
      const retry = await confirmRetry(h, frame, 1);
      await respond(h, frame, retry.importing, { semantic_mismatch: { issues: [{ code, node_id: '2', input: 'format' }] } }, 'original content changed');
      await retry.reviewing; await flush();
      assertUnbound(h);
      assert.equal(buttons(h, '复核新增参数').hidden, true);
      assert.equal(commands(h, 'importApi').length, 2);
      assert.deepEqual(prompt, before);
      await buttons(h, '← 返回画布').click();
      assert.equal(drafts(h).length, 0); assert.equal(h.editor.isOpen(), false);
    } finally { await h.restore(); }
  });
}

test('review dialog preserves explicit false and zero display and requires a positive confirmation', async () => {
  const h = harness();
  try {
    const review = reviewFixture('scalar-review', [
      { node_id: '2', class_type: 'Params', input: 'enabled', value: false },
      { node_id: '2', class_type: 'Params', input: 'count', value: 0 },
    ]);
    const deciding = confirmEditorAdditions(review), dialog = reviewDialog(h);
    assert.deepEqual(elements(dialog).filter(item => item.tagName === 'pre').map(item => item.textContent), ['false', '0']);
    assert.deepEqual(h.messages, []); assert.deepEqual(h.calls, []);
    elements(dialog).find(item => item.textContent === '确认补充并进入').click();
    assert.equal(await deciding, true);
    assert.equal(reviewDialog(h), undefined);
  } finally { await h.restore(); }
});

for (const failure of ['draft', 'binding']) {
  test(`confirmed conversion ${failure} failure stays unbound and never reports success`, async () => {
    const h = harness(), prompt = promptFixture(), before = structuredClone(prompt), review = reviewFixture();
    const nativeBefore = structuredClone(h.workflow.document), nodeBefore = structuredClone(h.node);
    let bindingAttempts = 0;
    const api = h.host.api;
    if (failure === 'draft') {
      h.host.api = async (path, payload) => {
        if (path.endsWith('/draft')) {
          h.calls.push({ kind: 'api', path, payload: structuredClone(payload) });
          throw new Error('Draft storage refused the write');
        }
        return api(path, payload);
      };
    }
    try {
      const { frame, handling, importing } = await firstImport(h, prompt, async () => {
        bindingAttempts += 1;
        if (failure === 'binding') throw new Error('Outer binding rejected the converted revision');
        h.bound += 1;
      });
      await respond(h, frame, importing, reviewFailure(review), 'unproven values'); await handling;
      const retry = await confirmRetry(h, frame, 1), converted = convertedFixture(prompt, review);
      await respond(h, frame, retry.importing, converted); await retry.reviewing; await flush();
      assert.equal(h.bound, 0);
      assert.equal(bindingAttempts, failure === 'binding' ? 1 : 0,
        'binding must run only after draft storage succeeds');
      assert.equal(drafts(h).length, 1, 'the explicit retry attempts one draft write');
      assert.deepEqual(drafts(h)[0].payload, { document: converted.workflow, base_revision: 7 });
      if (failure === 'draft') {
        assert.deepEqual(h.workflow.document, nativeBefore);
        assert.equal(h.workflow.revision, 7);
      } else {
        assert.deepEqual(h.workflow.document, converted.workflow, 'saved draft remains recoverable despite unbound outer node');
        assert.equal(h.workflow.revision, 8);
      }
      for (const label of ['应用参数并返回', '保存内部草稿', '导出完整工作流']) {
        assert.equal(buttons(h, label).disabled, true, `${label} stays locked until binding succeeds`);
      }
      assert.equal(buttons(h, '复核新增参数').hidden, true);
      assert.equal(buttons(h, '放弃未保存修改并返回').hidden, false);
      const visible = elements(h.document.body).map(item => item.textContent).join('\n');
      assert(visible.includes(failure === 'draft' ? 'Draft storage refused' : 'Outer binding rejected'));
      assert.equal(/已按确认补充|预设已转换为|现在可继续编辑/.test(visible), false);
      assert.equal(h.calls.some(call => call.kind === 'applyInterface' || call.kind === 'applied'), false);
      assert.equal(h.calls.some(call => /\/jobs|\/generate|\/prompt/.test(call.path || '')), false);
      assert.deepEqual(prompt, before); assert.deepEqual(h.node, nodeBefore);
      await buttons(h, '← 返回画布').click();
      assert.equal(h.editor.isOpen(), false);
      assert.equal(drafts(h).length, 1, 'closing an unbound conversion does not auto-save another draft');
      assert.equal(commands(h, 'importApi').length, 2, 'storage and binding errors do not repeat conversion');
    } finally { await h.restore(); }
  });
}


test('connected-value review has no implicit choice and preserves typed zero, false and empty values', async () => {
  const h = harness();
  try {
    const pending = resolveConnectedEditorValues([
      { field_id: 'count', node_id: '1', input: 'count', value: 0, inner_value: 7, native_pre_overlay: 3 },
      { field_id: 'enabled', node_id: '1', input: 'enabled', value: false, inner_value: true, native_pre_overlay: false },
      { field_id: 'text', node_id: '2', input: 'text', value: '', inner_value: '<script>plain text</script>', native_pre_overlay: 'N' },
    ]);
    const dialog = elements(h.document.body).find(item => item.attributes['aria-label'] === '保存连线输入的内部修改');
    const confirm = elements(dialog).find(item => item.textContent === '按所选方式继续保存');
    const selects = elements(dialog).filter(item => item.tagName === 'select');
    const printed = elements(dialog).filter(item => item.tagName === 'pre').map(item => item.textContent);
    assert(printed.includes('0')); assert(printed.includes('false')); assert(printed.includes('""'));
    assert(printed.includes('"<script>plain text</script>"'));
    assert.equal(confirm.disabled, true);
    selects[0].value = 'inner'; selects[0].onchange();
    selects[1].value = 'native'; selects[1].onchange();
    assert.equal(confirm.disabled, true);
    selects[2].value = 'native'; selects[2].onchange();
    assert.equal(confirm.disabled, false);
    selects[0].value = ''; selects[0].onchange(); assert.equal(confirm.disabled, true);
    selects[0].value = 'inner'; selects[0].onchange(); confirm.click();
    assert.deepEqual(await pending, { count: 'inner', enabled: 'native', text: 'native' });
    assert.equal(dialog.parentElement, null);
  } finally { await h.restore(); }
});

for (const cancel of ['button', 'close', 'escape']) {
  test(`connected-value review ${cancel} cancels without a default resolution`, async () => {
    const h = harness();
    try {
      const pending = resolveConnectedEditorValues([{ field_id: 'text', node_id: '1', input: 'text', value: 'C', inner_value: 'I', native_pre_overlay: 'N' }]);
      const dialog = elements(h.document.body).find(item => item.attributes['aria-label'] === '保存连线输入的内部修改');
      if (cancel === 'button') elements(dialog).find(item => item.textContent === '取消，继续编辑').click();
      else if (cancel === 'close') elements(dialog).find(item => item.attributes['aria-label'] === '关闭').click();
      else await dialog.emit('cancel', { preventDefault() {} });
      assert.equal(await pending, null); assert.equal(dialog.parentElement, null);
    } finally { await h.restore(); }
  });
}
