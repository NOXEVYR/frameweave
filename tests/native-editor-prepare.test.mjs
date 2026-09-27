import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWorkflowEditor } from '../web/native-workflow-editor.mjs';

const EDITOR_ID = `e-${'b'.repeat(24)}`;
const BACKEND = 'http://127.0.0.1:8188';

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.listeners = new Map();
    this.parentElement = null;
    this.isConnected = false;
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach(value => classes.add(value)),
      remove: (...values) => values.forEach(value => classes.delete(value)),
      contains: value => classes.has(value),
    };
  }

  append(...items) {
    for (const item of items) {
      item.parentElement = this;
      item.isConnected = this.isConnected;
      this.children.push(item);
    }
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  addEventListener(name, callback, options = {}) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push({ callback, once: Boolean(options.once) });
  }

  removeEventListener(name, callback) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.callback !== callback));
  }

  async emit(name, event = {}) {
    const entries = [...(this.listeners.get(name) || [])];
    const replies = entries.map(item => item.callback(event));
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => !item.once));
    await Promise.all(replies);
  }

  showModal() { this.open = true; }

  close() {
    this.open = false;
    void this.emit('close');
  }

  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      this.parentElement = null;
    }
  }

  click() {
    if (this.disabled || typeof this.onclick !== 'function') return undefined;
    return this.onclick({ target: this });
  }
}

function mockBrowser() {
  const messages = [];
  const body = new MockElement('body'); body.isConnected = true;
  const document = {
    body,
    createElement(tag) {
      const item = new MockElement(tag);
      if (tag === 'iframe') item.contentWindow = {
        postMessage: (message, origin) => messages.push({ message, origin }),
      };
      return item;
    },
  };
  const listeners = new Map();
  const window = {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    async emit(name, event) {
      await Promise.all([...(listeners.get(name) || [])].map(callback => callback(event)));
    },
  };
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { value: document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: window, configurable: true, writable: true });
  return {
    document, window, messages,
    restore() {
      if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument);
      else delete globalThis.document;
      if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
      else delete globalThis.window;
    },
  };
}

const allElements = root => [root, ...root.children.flatMap(allElements)];
const flush = () => new Promise(resolve => setImmediate(resolve));

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = predicate();
    if (value) return value;
    await flush();
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function harness({ backendChoice = BACKEND, sessionBackend = BACKEND, fields = [] } = {}) {
  const browser = mockBrowser();
  const calls = [];
  const workflow = {
    id: EDITOR_ID, name: 'Mock native workflow', revision: 7, nodes: 2,
    document: { nodes: [{ id: 1, type: 'Known', widgets_values: ['original'] }], links: [] },
  };
  const session = {
    session_id: 'session-1', backend_url: sessionBackend,
    origin: 'http://127.0.0.1:8766', url: 'http://127.0.0.1:8766/editor', bridgeNonce: 'session-nonce',
  };
  const node = {
    id: 'outer-node',
    data: {
      editor_id: EDITOR_ID,
      packageValues: { 'text-field': 'outer value' },
      editor_baseline: { 'text-field': 'baseline value' },
      editor_controls: [{ node_id: 'inside-1', input: 'text', widget_node_id: 'inside-1', widget_name: 'text' }],
    },
  };
  const host = {
    async api(path, payload) {
      calls.push({ kind: 'api', path, payload });
      if (path === `/api/editor-workflows/${EDITOR_ID}`) return workflow;
      if (path === `/api/editor-workflows/${EDITOR_ID}/session`) return session;
      if (path === `/api/editor-workflows/${EDITOR_ID}/draft`) {
        workflow.revision = 8;
        if (payload?.document) workflow.document = payload.document;
        return { revision: 8 };
      }
      if (path === `/api/editor-workflows/${EDITOR_ID}/export`) return { source_json: '{"nodes":[],"links":[]}' };
      if (path === '/api/editor-sessions/close') return { closed: true };
      throw new Error(`Unexpected API path: ${path}`);
    },
    async ensureBackend(...args) { calls.push({ kind: 'ensureBackend', args }); return backendChoice; },
    async ensureInstance(...args) { calls.push({ kind: 'ensureInstance', args }); },
    fields() { return fields; },
    async applyInterface(...args) { calls.push({ kind: 'applyInterface', args }); return { applied: true }; },
    async applied(...args) { calls.push({ kind: 'applied', args }); },
    downloadJSON(...args) { calls.push({ kind: 'downloadJSON', args }); },
    toast(message) { calls.push({ kind: 'toast', message }); },
    releaseSession(id) { calls.push({ kind: 'releaseSession', id }); },
  };
  return { browser, calls, workflow, session, node, host, editor: createNativeWorkflowEditor(host) };
}

function findCommand(h, action) {
  return h.browser.messages.find(item => item.message.action === action);
}

async function respond(h, frame, command, result, error) {
  await h.browser.window.emit('message', {
    source: frame.contentWindow,
    origin: h.session.origin,
    data: {
      source: 'prism-editor', nonce: h.session.bridgeNonce,
      requestId: command.message.requestId,
      ...(error ? { error, result } : { result }),
    },
  });
}

function readyEvent(h, frame) {
  return h.browser.window.emit('message', {
    source: frame.contentWindow,
    origin: h.session.origin,
    data: { source: 'prism-editor', nonce: h.session.bridgeNonce, action: 'ready' },
  });
}

test('prepare loads, syncs, compiles, and applies fields without submitting generation', async () => {
  const field = { id: 'text-field', label: 'Prompt', node_id: 'inside-1', input: 'text' };
  const h = harness({ fields: [field] });
  try {
    await h.editor.prepare(h.node);
    const frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'native editor frame');
    const handling = readyEvent(h, frame);

    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    assert.equal(load.origin, h.session.origin);
    assert.deepEqual(load.message.document, h.workflow.document);
    await respond(h, frame, load, { nodes: 2, missing: [] });

    const patch = await waitFor(() => findCommand(h, 'patch'), 'outer value patch');
    assert.deepEqual(patch.message.patches, [{
      node_id: 'inside-1', widget_name: 'text', value: 'outer value', expected_value: 'baseline value',
    }]);
    await respond(h, frame, patch, { applied: [{ index: 0 }] });

    const compile = await waitFor(() => findCommand(h, 'compile'), 'automatic compile request');
    const compiled = { workflow: { nodes: [{ id: 1, type: 'Known' }], links: [] }, output: { 1: { class_type: 'Known', inputs: {} } } };
    await respond(h, frame, compile, compiled);
    await handling;
    await waitFor(() => h.calls.some(call => call.path === '/api/editor-sessions/close'), 'session close after apply');

    const apply = h.calls.find(call => call.kind === 'applyInterface');
    assert.deepEqual(apply.args, [h.node, compiled, { session_id: 'session-1', base_revision: 7 }]);
    assert.equal(h.calls.filter(call => call.kind === 'applied').length, 1);
    assert(h.calls.some(call => call.kind === 'toast' && /已应用内部参数/.test(call.message)));
    assert.deepEqual(h.calls.filter(call => call.kind === 'api').map(call => call.path), [
      `/api/editor-workflows/${EDITOR_ID}`,
      `/api/editor-workflows/${EDITOR_ID}/session`,
      '/api/editor-sessions/close',
    ]);
    assert.equal(h.calls.some(call => /generate|\/prompt|\/jobs/.test(call.path || '')), false);
    assert.equal(h.editor.isOpen(), false);
  } finally {
    h.browser.restore();
  }
});

test('prepare cancellation leaves before instance or session creation', async () => {
  const h = harness({ backendChoice: null });
  try {
    await h.editor.prepare(h.node);
    assert.deepEqual(h.calls.filter(call => call.kind === 'api').map(call => call.path), [
      `/api/editor-workflows/${EDITOR_ID}`,
    ]);
    assert.equal(h.calls.some(call => call.kind === 'ensureInstance'), false);
    assert.equal(h.browser.document.body.children.length, 0);
  } finally {
    h.browser.restore();
  }
});

test('prepare closes a session when its backend changed after selection', async () => {
  const h = harness({ backendChoice: BACKEND, sessionBackend: 'http://127.0.0.1:8189' });
  try {
    await assert.rejects(h.editor.prepare(h.node), /推理引擎已被其他窗口切换/);
    assert(h.calls.some(call => call.kind === 'api' && call.path === '/api/editor-sessions/close'
      && call.payload.session_id === 'session-1'));
    assert.equal(h.browser.document.body.children.length, 0);
    assert.equal(h.editor.isOpen(), false);
  } finally {
    h.browser.restore();
  }
});

test('automatic compile failure stays in the editor and can return without applying', async () => {
  const h = harness();
  try {
    await h.editor.prepare(h.node);
    const frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'native editor frame');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    await respond(h, frame, load, { nodes: 2, missing: [] });
    const compile = await waitFor(() => findCommand(h, 'compile'), 'automatic compile request');
    await respond(h, frame, compile, null, 'compile rejected by mock bridge');
    await handling;

    const elements = allElements(h.browser.document.body);
    const discard = elements.find(item => item.tagName === 'button' && item.textContent === '放弃未保存修改并返回');
    assert(discard, 'the recovery action should remain available');
    assert.equal(discard.hidden, false);
    assert(elements.some(item => item.tagName === 'p' && item.textContent === 'compile rejected by mock bridge'));
    assert.equal(h.calls.some(call => call.kind === 'applyInterface'), false);
    assert.equal(h.calls.some(call => call.path === '/api/editor-sessions/close'), false);

    await discard.click();
    assert(h.calls.some(call => call.kind === 'api' && call.path === '/api/editor-sessions/close'));
    assert.equal(h.editor.isOpen(), false);
  } finally {
    h.browser.restore();
  }
});

test('missing nodes keep original workflow export available while parameter actions remain disabled', async () => {
  const h = harness();
  try {
    await h.editor.open(h.node);
    const frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'native editor frame');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    await respond(h, frame, load, { nodes: 1, missing: ['UnknownNode'] });
    await handling;

    const elements = allElements(h.browser.document.body);
    assert.equal(elements.find(item => item.tagName === 'button' && item.textContent === '应用参数并返回').disabled, true);
    assert.equal(elements.find(item => item.tagName === 'button' && item.textContent === '保存内部草稿').disabled, true);
    const exportButton = elements.find(item => item.tagName === 'button' && item.textContent === '导出完整工作流');
    assert.equal(exportButton.disabled, false);
    await exportButton.click();
    assert(h.calls.some(call => call.path === `/api/editor-workflows/${EDITOR_ID}/export`));
    assert(h.calls.some(call => call.kind === 'downloadJSON'));
    assert.equal(h.browser.messages.some(item => item.message.action === 'snapshot'), false);
  } finally {
    h.browser.restore();
  }
});

test('preset entry imports through the bridge, persists the verified native graph, and reuses apply hooks', async () => {
  const h = harness();
  const prompt = { 1: { class_type: 'Known', inputs: { seed: 23, plugin_value: { keep: true } } } };
  const converted = { workflow: { nodes: [{ id: 1, type: 'Known', widgets_values: [23] }], links: [] }, output: prompt,
    controls: [{ node_id: '1', input: 'seed', widget_node_id: '1', widget_name: 'seed' }], unmapped: [], missing: [], nodes: 1, links: 0 };
  let boundCount = 0;
  try {
    await h.editor.openApiPrompt(h.node, prompt, async () => { boundCount += 1; });
    const frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'native editor frame');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'bootstrap load request');
    await respond(h, frame, load, { nodes: 0, missing: [] });
    const importing = await waitFor(() => findCommand(h, 'importApi'), 'native API prompt import');
    assert.deepEqual(importing.message.prompt, prompt);
    await respond(h, frame, importing, converted);
    await handling;
    assert.equal(boundCount, 1);

    const draft = h.calls.find(call => call.kind === 'api' && call.path.endsWith('/draft'));
    assert.deepEqual(draft.payload, { document: converted.workflow, base_revision: 7 });
    const elements = allElements(h.browser.document.body);
    assert(elements.some(item => item.tagName === 'p' && /回编译与原 API 工作流一致/.test(item.textContent)));
    assert.equal(h.calls.some(call => call.kind === 'applyInterface'), false);

    const applyButton = elements.find(item => item.tagName === 'button' && item.textContent === '应用参数并返回');
    const applying = applyButton.click();
    const compile = await waitFor(() => findCommand(h, 'compile'), 'native compile for outer interface');
    const editable = { workflow: converted.workflow, output: prompt, controls: converted.controls, unmapped: [] };
    await respond(h, frame, compile, editable);
    await applying;
    await waitFor(() => h.calls.some(call => call.kind === 'api' && call.path === '/api/editor-sessions/close'), 'session close after applying parameters');
    const applied = h.calls.find(call => call.kind === 'applyInterface');
    assert.deepEqual(applied.args, [h.node, editable, { session_id: 'session-1', base_revision: 8 }]);
    assert.equal(h.calls.filter(call => call.kind === 'applied').length, 1);
    assert.equal(h.calls.some(call => /generate|\/prompt|\/jobs/.test(call.path || '')), false);
  } finally {
    h.browser.restore();
  }
});

test('failed preset conversion stays fail-closed and engine retry carries the original prompt and binding callback', async () => {
  const h = harness();
  const prompt = { 1: { class_type: 'Known', inputs: { seed: 23 } } };
  const converted = { workflow: { nodes: [{ id: 1, type: 'Known', widgets_values: [23] }], links: [] }, output: prompt,
    controls: [], unmapped: [], missing: [], nodes: 1, links: 0 };
  let boundCount = 0;
  try {
    await h.editor.openApiPrompt(h.node, prompt, async () => { boundCount += 1; });
    let frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'first editor iframe');
    let handling = readyEvent(h, frame);
    let load = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'load').at(-1), 'first bootstrap load');
    await respond(h, frame, load, { nodes: 0, missing: [] });
    let importing = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'importApi').at(-1), 'first preset import');
    await respond(h, frame, importing, null, 'temporary importer failure');
    await handling;

    let elements = allElements(h.browser.document.body);
    let apply = elements.find(item => item.tagName === 'button' && item.textContent === '应用参数并返回');
    let draft = elements.find(item => item.tagName === 'button' && item.textContent === '保存内部草稿');
    let exportButton = elements.find(item => item.tagName === 'button' && item.textContent === '导出完整工作流');
    let back = elements.find(item => item.tagName === 'button' && item.textContent === '← 返回画布');
    let switchEngine = elements.find(item => item.tagName === 'button' && item.textContent === '更换工作流引擎');
    assert.equal(apply.disabled, true);
    assert.equal(draft.disabled, true);
    assert.equal(exportButton.disabled, true);
    assert.equal(back.disabled, false);
    assert.equal(switchEngine.disabled, false);
    assert.equal(boundCount, 0);
    assert.equal(h.calls.some(call => call.path?.endsWith('/draft')), false);

    const switching = switchEngine.click();
    frame = await waitFor(() => allElements(h.browser.document.body).filter(item => item.tagName === 'iframe').at(-1), 'retry editor iframe');
    await switching;
    handling = readyEvent(h, frame);
    load = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'load').at(-1), 'retry bootstrap load');
    await respond(h, frame, load, { nodes: 0, missing: [] });
    importing = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'importApi').at(-1), 'retried preset import');
    assert.deepEqual(importing.message.prompt, prompt);
    await respond(h, frame, importing, converted);
    await handling;

    elements = allElements(h.browser.document.body);
    apply = elements.find(item => item.tagName === 'button' && item.textContent === '应用参数并返回');
    assert.equal(apply.disabled, false);
    assert.equal(boundCount, 1);
    assert.equal(h.browser.messages.filter(item => item.message.action === 'importApi').length, 2);
    assert.equal(h.calls.filter(call => call.path?.endsWith('/draft')).length, 1);
  } finally {
    h.browser.restore();
  }
});

test('outer binding failure leaves preset actions locked and returning does not save an unbound graph', async () => {
  const h = harness();
  const prompt = { 1: { class_type: 'Known', inputs: { seed: 23 } } };
  const converted = { workflow: { nodes: [{ id: 1, type: 'Known', widgets_values: [23] }], links: [] }, output: prompt,
    controls: [], unmapped: [], missing: [], nodes: 1, links: 0 };
  try {
    await h.editor.openApiPrompt(h.node, prompt, async () => { throw new Error('outer node changed before binding'); });
    const frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'editor iframe');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'bootstrap load');
    await respond(h, frame, load, { nodes: 0, missing: [] });
    const importing = await waitFor(() => findCommand(h, 'importApi'), 'preset import');
    await respond(h, frame, importing, converted);
    await handling;

    const elements = allElements(h.browser.document.body);
    const apply = elements.find(item => item.tagName === 'button' && item.textContent === '应用参数并返回');
    const draft = elements.find(item => item.tagName === 'button' && item.textContent === '保存内部草稿');
    const exportButton = elements.find(item => item.tagName === 'button' && item.textContent === '导出完整工作流');
    const back = elements.find(item => item.tagName === 'button' && item.textContent === '← 返回画布');
    assert.equal(apply.disabled, true);
    assert.equal(draft.disabled, true);
    assert.equal(exportButton.disabled, true);
    assert(elements.some(item => item.tagName === 'p' && /outer node changed/.test(item.textContent)));
    assert.equal(h.calls.some(call => call.kind === 'applied'), false);

    await back.click();
    assert.equal(h.calls.filter(call => call.path?.endsWith('/draft')).length, 1);
    assert.equal(h.browser.messages.filter(item => item.message.action === 'snapshot').length, 0);
    assert.equal(h.editor.isOpen(), false);
  } finally {
    h.browser.restore();
  }
});

test('a bound preset switches engines from its saved native draft without replaying the API preset', async () => {
  const h = harness();
  const prompt = { 1: { class_type: 'Known', inputs: { seed: 23 } } };
  const converted = { workflow: { nodes: [{ id: 1, type: 'Known', widgets_values: [23] }], links: [] }, output: prompt,
    controls: [], unmapped: [], missing: [], nodes: 1, links: 0 };
  let boundCount = 0;
  try {
    await h.editor.openApiPrompt(h.node, prompt, async () => { boundCount += 1; });
    let frame = await waitFor(() => allElements(h.browser.document.body).find(item => item.tagName === 'iframe'), 'first editor iframe');
    let handling = readyEvent(h, frame);
    let load = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'load').at(-1), 'bootstrap load');
    await respond(h, frame, load, { nodes: 0, missing: [] });
    const importing = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'importApi').at(-1), 'preset import');
    await respond(h, frame, importing, converted);
    await handling;
    assert.equal(boundCount, 1);

    const switchEngine = allElements(h.browser.document.body).find(item => item.tagName === 'button' && item.textContent === '更换工作流引擎');
    const switching = switchEngine.click();
    const snapshot = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'snapshot').at(-1), 'saved draft snapshot');
    await respond(h, frame, snapshot, { workflow: converted.workflow, nodes: 1, missing: [] });
    await switching;

    frame = await waitFor(() => allElements(h.browser.document.body).filter(item => item.tagName === 'iframe').at(-1), 'second editor iframe');
    handling = readyEvent(h, frame);
    load = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'load').at(-1), 'saved native draft load');
    assert.deepEqual(load.message.document, converted.workflow);
    await respond(h, frame, load, { nodes: 1, missing: [] });
    await handling;
    assert.equal(h.browser.messages.filter(item => item.message.action === 'importApi').length, 1);
    assert.equal(boundCount, 1);
  } finally {
    h.browser.restore();
  }
});

test('preset entry rejects malformed API prompts before starting a session', async () => {
  const h = harness();
  try {
    await assert.rejects(h.editor.openApiPrompt(h.node, { 1: { class_type: 'Known' } }), /API 工作流格式/);
    assert.equal(h.calls.some(call => call.path?.endsWith('/session')), false);
    assert.equal(h.editor.isOpen(), false);
  } finally {
    h.browser.restore();
  }
});
