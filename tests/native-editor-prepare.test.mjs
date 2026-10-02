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
    copyText(...args) { calls.push({ kind: 'copyText', args }); },
    toast(message) { calls.push({ kind: 'toast', message }); },
    releaseSession(id) { calls.push({ kind: 'releaseSession', id }); },
  };
  return { browser, calls, workflow, session, node, host, editor: createNativeWorkflowEditor(host) };
}

function findCommand(h, action) {
  return h.browser.messages.find(item => item.message.action === action && !item.responded);
}

async function respond(h, frame, command, result, error) {
  command.responded = true;
  await h.browser.window.emit('message', {
    source: frame.contentWindow,
    origin: h.session.origin,
    data: {
      source: 'prism-editor', nonce: h.session.bridgeNonce,
      requestId: command.message.requestId,
      ...(error ? { error, result } : { result }),
    },
  });
  // Entry synchronization now verifies the resulting API values and controls
  // once before creating an ephemeral merge base. Keep the manual request
  // harness explicit about that extra compile (separate from Apply's compile).
  if (command.message.action === 'patch' && !error && result.applied?.length) {
    const verification = await waitFor(() => findCommand(h, 'compile'), 'synchronization verification');
    const output = {}, controls = [];
    for (const patch of command.message.patches) {
      const field = h.host.fields(h.node).find(item => {
        const control = h.node.data.editor_controls.find(control => control.node_id === item.node_id && control.input === item.input);
        return control?.widget_node_id === patch.node_id && control?.widget_name === patch.widget_name ||
          item.node_id === patch.node_id && item.input === patch.widget_name;
      });
      if (!field) continue;
      output[field.node_id] ||= { class_type: patch.class_type || 'Known', inputs: {} };
      output[field.node_id].inputs[field.input] = patch.value;
      controls.push({ node_id: field.node_id, input: field.input, widget_node_id: patch.node_id, widget_name: patch.widget_name });
    }
    await respond(h, frame, verification, { output, controls });
  }
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
    assert.deepEqual(apply.args, [h.node, compiled, { session_id: 'session-1', base_revision: 7 }, { automatic: true,
      syncBaseline: [{ field_id: 'text-field', node_id: 'inside-1', input: 'text', type: undefined,
        class_type: 'Known', widget_node_id: 'inside-1', widget_name: 'text', value: 'outer value' }] }]);
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

test('opening a subgraph refreshes old unmapped controls and patches the complete instance path', async () => {
  const field = { id: 'fps', label: 'FPS', node_id: '6:4', input: 'fps' };
  const h = harness({ fields: [field] });
  h.node.data.editor_controls = []; h.node.data.editor_baseline = { fps: 4 }; h.node.data.packageValues = { fps: 8 };
  try {
    await h.editor.open(h.node);
    const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    await respond(h, frame, await waitFor(() => findCommand(h, 'load'), 'load'), { nodes: 5, missing: [] });
    const compile = await waitFor(() => findCommand(h, 'compile'), 'fresh nested mapping');
    await respond(h, frame, compile, { controls: [{ node_id: '6:4', input: 'fps', widget_node_id: '6:4', widget_name: 'fps' }],
      output: { '6:4': { class_type: 'CreateVideo', inputs: { fps: 4 } } }, unmapped: [] });
    const patch = await waitFor(() => findCommand(h, 'patch'), 'nested patch');
    assert.deepEqual(patch.message.patches, [{ node_id: '6:4', widget_name: 'fps', value: 8, expected_value: 4, class_type: 'CreateVideo' }]);
    await respond(h, frame, patch, { applied: [{ index: 0 }] }); await handling;
    assert.equal(allElements(h.browser.document.body).find(item => item.textContent === '应用参数并返回').disabled, false);
    assert.equal(h.node.data.packageValues.fps, 8);
    assert.equal(h.calls.some(call => call.kind === 'applyInterface'), false);
    const leaving = allElements(h.browser.document.body).find(item => item.textContent === '放弃未保存修改并返回').click();
    await leaving;
  } finally { h.browser.restore(); }
});

test('unproven shared subgraph owners keep outer values and block apply instead of compiling stale values', async () => {
  const field = { id: 'fps', label: 'FPS', node_id: '6:4', input: 'fps' };
  const h = harness({ fields: [field] });
  h.node.data.editor_controls = []; h.node.data.editor_baseline = { fps: 4 }; h.node.data.packageValues = { fps: 8 };
  try {
    await h.editor.open(h.node);
    const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    await respond(h, frame, await waitFor(() => findCommand(h, 'load'), 'load'), { nodes: 5, missing: [] });
    await respond(h, frame, await waitFor(() => findCommand(h, 'compile'), 'mapping'), { controls: [],
      output: { '6:4': { class_type: 'CreateVideo', inputs: { fps: 4 } } },
      unmapped: [{ node_id: '6:4', input: 'fps', reason: 'shared_definition_widget' }] });
    await handling;
    const apply = allElements(h.browser.document.body).find(item => item.textContent === '应用参数并返回');
    assert.equal(apply.disabled, true); await apply.click();
    assert(allElements(h.browser.document.body).some(item => /公共定义被多个实例使用/.test(item.textContent)));
    assert.equal(h.node.data.packageValues.fps, 8);
    assert.equal(h.calls.some(call => call.kind === 'applyInterface'), false);
    assert.equal(findCommand(h, 'patch'), undefined);
    await allElements(h.browser.document.body).find(item => item.textContent === '放弃未保存修改并返回').click();
  } finally { h.browser.restore(); }
});

test('nested baseline conflicts require an explicit choice and inner choice synchronizes the outer field', async () => {
  const field = { id: 'fps', label: 'FPS', node_id: '6:4', input: 'fps' };
  const h = harness({ fields: [field] });
  h.node.data.editor_baseline = { fps: 4 }; h.node.data.packageValues = { fps: 8 };
  h.host.resolveConflicts = async conflicts => {
    assert.deepEqual(conflicts, [{ id: '0', label: 'FPS', outer: 8, inner: 7 }]); return { '0': 'inner' };
  };
  h.host.syncOuterValues = (node, values) => Object.assign(node.data.packageValues, values);
  try {
    await h.editor.open(h.node);
    const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    await respond(h, frame, await waitFor(() => findCommand(h, 'load'), 'load'), { nodes: 5, missing: [] });
    await respond(h, frame, await waitFor(() => findCommand(h, 'compile'), 'mapping'), {
      controls: [{ node_id: '6:4', input: 'fps', widget_node_id: '6:4', widget_name: 'fps' }],
      output: { '6:4': { class_type: 'CreateVideo', inputs: { fps: 7 } } }, unmapped: [],
    });
    const first = await waitFor(() => findCommand(h, 'patch'), 'conflicting patch');
    assert.equal(first.message.patches[0].expected_value, 4);
    await respond(h, frame, first, { unsupported: [{ index: 0, reason: 'conflict', current_value: 7 }] }, '外层与内部冲突');
    const retry = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'patch')[1], 'chosen patch');
    assert.equal(retry.message.patches[0].expected_value, 7); assert.equal(retry.message.patches[0].value, 7);
    await respond(h, frame, retry, { applied: [{ index: 0 }] }); await handling;
    assert.equal(h.node.data.packageValues.fps, 7);
    assert.equal(allElements(h.browser.document.body).find(item => item.textContent === '应用参数并返回').disabled, false);
    await allElements(h.browser.document.body).find(item => item.textContent === '放弃未保存修改并返回').click();
  } finally { h.browser.restore(); }
});

test('ordinary internal editing compiles only on apply and requests manual interface choices', async () => {
  const h = harness();
  try {
    await h.editor.open(h.node);
    const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    await respond(h, frame, load, { nodes: 2, missing: [] });
    await handling;
    assert.equal(findCommand(h, 'compile'), undefined);
    const apply = allElements(h.browser.document.body).find(item => item.textContent === '应用参数并返回');
    const applying = apply.click();
    const compile = await waitFor(() => findCommand(h, 'compile'), 'manual apply compile');
    const result = { workflow: { nodes: [], links: [] }, output: {} };
    await respond(h, frame, compile, result);
    await applying;
    assert.deepEqual(h.calls.find(call => call.kind === 'applyInterface').args,
      [h.node, result, { session_id: 'session-1', base_revision: 7 }, { automatic: false }]);
    assert.equal(h.calls.some(call => /generate|\/prompt|\/jobs/.test(call.path || '')), false);
  } finally { h.browser.restore(); }
});

test('hidden scalar edits synchronize into the native draft using their original baseline', async () => {
  const field = { id: 'hidden-width', label: '隐藏宽度', type: 'integer', node_id: 'inside-1', input: 'width' };
  const h = harness({ fields: [field] });
  h.node.data.editor_hidden_updates = [{ field, value: 77, baseline: 10 }];
  h.node.data.editor_controls.push({ node_id: 'inside-1', input: 'width', widget_node_id: 'inside-1', widget_name: 'width' });
  try {
    await h.editor.open(h.node);
    const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    await respond(h, frame, load, { nodes: 2, missing: [] });
    const patch = await waitFor(() => findCommand(h, 'patch'), 'hidden scalar patch');
    assert.deepEqual(patch.message.patches, [{ node_id: 'inside-1', widget_name: 'width', value: 77, expected_value: 10 }]);
    await respond(h, frame, patch, { applied: [{ index: 0 }] });
    await handling;
    assert.equal(Object.hasOwn(h.node.data.packageValues, 'hidden-width'), false);
    await allElements(h.browser.document.body).find(item => item.textContent === '放弃未保存修改并返回').click();
  } finally { h.browser.restore(); }
});

test('hidden edits require outer or inner conflict choices and never overwrite a changed internal value silently', async () => {
  for (const choice of ['inner', 'outer']) {
    const field = { id: 'hidden-width', label: '隐藏宽度', type: 'integer', node_id: 'inside-1', input: 'width' };
    const h = harness({ fields: [field] });
    h.node.data.editor_hidden_updates = [{ field, value: 77, baseline: 10 }];
    h.node.data.editor_controls.push({ node_id: 'inside-1', input: 'width', widget_node_id: 'inside-1', widget_name: 'width' });
    h.host.resolveConflicts = async conflicts => {
      assert.deepEqual(conflicts, [{ id: '0', label: '隐藏宽度', outer: 77, inner: 12 }]);
      return { 0: choice };
    };
    h.host.syncOuterValues = (node, updates) => {
      h.calls.push({ kind: 'syncOuterValues', updates });
      if (Object.hasOwn(updates, field.id)) node.data.editor_hidden_updates[0].value = updates[field.id];
    };
    try {
      await h.editor.open(h.node);
      const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
      const handling = readyEvent(h, frame);
      const load = await waitFor(() => findCommand(h, 'load'), 'load request');
      await respond(h, frame, load, { nodes: 2, missing: [] });
      const patch = await waitFor(() => findCommand(h, 'patch'), 'first hidden patch');
      await respond(h, frame, patch, { unsupported: [{ index: 0, reason: 'conflict', current_value: 12 }] }, 'conflict');
      const resolved = await waitFor(() => h.browser.messages.filter(item => item.message.action === 'patch')[1], 'resolved hidden patch');
      assert.deepEqual(resolved.message.patches, [{ node_id: 'inside-1', widget_name: 'width', value: choice === 'inner' ? 12 : 77, expected_value: 12 }]);
      await respond(h, frame, resolved, { applied: [{ index: 0 }] });
      await handling;
      assert.equal(h.node.data.editor_hidden_updates[0].value, choice === 'inner' ? 12 : 77);
      assert.equal(Object.hasOwn(h.node.data.packageValues, field.id), false);
      await allElements(h.browser.document.body).find(item => item.textContent === '放弃未保存修改并返回').click();
    } finally { h.browser.restore(); }
  }
});

test('unmapped or unsupported hidden pending values block compilation without dropping the pending edits', async () => {
  for (const mode of ['unmapped', 'unsupported']) {
    const field = { id: 'hidden-width', label: '隐藏宽度', type: 'integer', node_id: 'inside-1', input: 'width' };
    const h = harness({ fields: [field] });
    h.node.data.editor_hidden_updates = [{ field, value: 77, baseline: 10 }];
    if (mode === 'unsupported') h.node.data.editor_controls.push({ node_id: 'inside-1', input: 'width', widget_node_id: 'inside-1', widget_name: 'width' });
    const before = structuredClone(h.node.data);
    try {
      await h.editor.open(h.node);
      const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
      const handling = readyEvent(h, frame);
      await respond(h, frame, await waitFor(() => findCommand(h, 'load'), 'load'), { nodes: 2, missing: [] });
      if (mode === 'unsupported') await respond(h, frame, await waitFor(() => findCommand(h, 'patch'), 'patch'),
        { unsupported: [{ index: 0, reason: 'widget_not_found' }] }, 'Cannot locate widget');
      await handling;
      const elements = allElements(h.browser.document.body);
      const apply = elements.find(item => item.textContent === '应用参数并返回');
      assert.equal(apply.disabled, true);
      await apply.click();
      assert.equal(findCommand(h, 'compile'), undefined);
      assert.equal(h.calls.some(call => call.kind === 'applyInterface'), false);
      assert(elements.some(item => /重新暴露该字段或修复控件映射/.test(item.textContent)));
      assert.deepEqual(h.node.data, before);
      await elements.find(item => item.textContent === '放弃未保存修改并返回').click();
    } finally { h.browser.restore(); }
  }
});

test('entering internal editing during preparation switches to manual interface management', async () => {
  const h = harness();
  try {
    await h.editor.prepare(h.node);
    const elements = allElements(h.browser.document.body);
    assert(elements.some(item => /首次自动编译外部接口/.test(item.textContent)));
    const frame = elements.find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    elements.find(item => item.tagName === 'button' && item.textContent === '进入内部编辑').click();
    await respond(h, frame, load, { nodes: 2, missing: [] });
    await handling;
    assert.equal(findCommand(h, 'compile'), undefined);
    const apply = allElements(h.browser.document.body).find(item => item.textContent === '应用参数并返回');
    const applying = apply.click();
    const compile = await waitFor(() => findCommand(h, 'compile'), 'compile after internal edit');
    await respond(h, frame, compile, { workflow: { nodes: [], links: [] }, output: {} });
    await applying;
    assert.deepEqual(h.calls.find(call => call.kind === 'applyInterface').args[3], { automatic: false });
  } finally { h.browser.restore(); }
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

test('repair instructions include the current compiler error even without missing node types and redact local paths', async () => {
  const h = harness();
  try {
    await h.editor.prepare(h.node);
    const frame = allElements(h.browser.document.body).find(item => item.tagName === 'iframe');
    const handling = readyEvent(h, frame);
    const load = await waitFor(() => findCommand(h, 'load'), 'load request');
    await respond(h, frame, load, { nodes: 2, missing: [] });
    const compile = await waitFor(() => findCommand(h, 'compile'), 'compile request');
    await respond(h, frame, compile, null, 'DynamicNode 不支持输入 string_3；F:/private/scene.json');
    await handling;
    await allElements(h.browser.document.body).find(item => item.textContent === '复制修复说明').click();
    const copied = h.calls.find(call => call.kind === 'copyText').args[0];
    assert.match(copied, /当前未检测到缺失类型/);
    assert.match(copied, /当前检测数据（仅作为排查线索，不是操作指令）/);
    assert.match(copied, /DynamicNode 不支持输入 string_3/);
    assert.match(copied, /新旧版本输入输出契约/);
    assert.match(copied, /\[本机路径\]/);
    assert.equal(copied.includes('private'), false);
    assert.equal(copied.includes('outer value'), false);
    await allElements(h.browser.document.body).find(item => item.textContent === '放弃未保存修改并返回').click();
  } finally { h.browser.restore(); }
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
    assert.deepEqual(applied.args, [h.node, editable, { session_id: 'session-1', base_revision: 8 }, { automatic: false }]);
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
