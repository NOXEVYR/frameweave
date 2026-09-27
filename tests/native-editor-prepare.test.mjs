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
      if (path === '/api/editor-sessions/close') return { closed: true };
      throw new Error(`Unexpected API path: ${path}`);
    },
    async ensureBackend(...args) { calls.push({ kind: 'ensureBackend', args }); return backendChoice; },
    async ensureInstance(...args) { calls.push({ kind: 'ensureInstance', args }); },
    fields() { return fields; },
    async applyInterface(...args) { calls.push({ kind: 'applyInterface', args }); return { applied: true }; },
    async applied(...args) { calls.push({ kind: 'applied', args }); },
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
