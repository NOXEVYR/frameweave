import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorSessionProjection, importEditorBaseline } from '../web/editor-session-projection.mjs';

const clone = value => structuredClone(value);
function fixture({ native = 'draft N', connected = 'source C', type = 'text', extra = [] } = {}) {
  const provenance = [{ field_id: 'prompt', node_id: '1', input: 'text', class_type: 'TextNode', type,
    origin: 'connected', value: connected, edge_id: 'edge1', source_id: 'source1',
    stored_fallback: 'own F', baseline: 'old B' }, ...extra];
  const graph = { nodes: [{ id: '1', type: 'TextNode', widgets: [{ name: 'text', value: native }, { name: 'sibling', value: 'safe' }] }], metadata: { keep: true } };
  const calls = [], hooks = {}, counts = {}, saves = [];
  let sourceCurrent = true, guardCalls = 0;
  const compile = () => ({ workflow: clone(graph), output: { '1': { class_type: 'TextNode', inputs: Object.fromEntries(graph.nodes[0].widgets.map(widget => [widget.name, widget.value])), _meta: { keep: 'metadata' } } },
    controls: graph.nodes[0].widgets.map(widget => ({ node_id: '1', input: widget.name, widget_node_id: '1', widget_name: widget.name })) });
  const request = async (action, args = {}) => {
    calls.push({ action, args: clone(args) }); counts[action] = (counts[action] || 0) + 1;
    if (hooks.before) await hooks.before(action, args, counts[action]);
    let result;
    if (action === 'compile') result = compile();
    else if (action === 'snapshot') result = { workflow: clone(graph) };
    else if (action === 'patch') {
      for (const patch of args.patches) {
        const widgets = graph.nodes[0].widgets.filter(widget => widget.name === patch.widget_name);
        assert.equal(widgets.length, 1); assert.equal(patch.node_id, '1'); assert.equal(patch.class_type, 'TextNode');
        assert.ok(Object.hasOwn(patch, 'expected_value')); assert.equal(widgets[0].value, patch.expected_value);
      }
      for (const patch of args.patches) graph.nodes[0].widgets.find(widget => widget.name === patch.widget_name).value = patch.value;
      result = { applied: args.patches.map(patch => ({ node_id: patch.node_id, widget_name: patch.widget_name })), unsupported: [] };
    } else throw new Error(`unexpected action ${action}`);
    if (hooks.after) result = await hooks.after(action, args, counts[action], result) || result;
    return result;
  };
  const session = createEditorSessionProjection({ request, provenance, assertCurrent: () => {
    guardCalls++; if (!sourceCurrent) throw new Error('direct source changed');
  } });
  const value = () => graph.nodes[0].widgets.find(widget => widget.name === 'text').value;
  const store = async payload => { saves.push(clone(payload)); return { revision: saves.length }; };
  return { session, provenance, graph, calls, hooks, saves, counts, value, store, request,
    setCurrent: value => { sourceCurrent = value; }, guardCount: () => guardCalls };
}

test('connected display is transient; persistence restores entry N, preserving F and B', async () => {
  const f = fixture(); const before = clone(f.provenance);
  const initialized = await f.session.initialize(); assert.equal(f.value(), 'source C');
  assert.equal(initialized.applied[0].native_pre_overlay, 'draft N');
  const result = await f.session.persist(f.store);
  assert.equal(result.status, 'persisted'); assert.equal(result.persisted, true); assert.equal(result.store_attempted, true);
  assert.equal(f.saves[0].output['1'].inputs.text, 'draft N'); assert.equal(f.saves[0].workflow.nodes[0].widgets[0].value, 'draft N');
  assert.equal(f.value(), 'source C'); assert.deepEqual(f.provenance, before);
  assert.equal(f.saves[0].provenance[0].stored_fallback, 'own F'); assert.equal(f.saves[0].provenance[0].baseline, 'old B');
  assert.equal(f.session.getState().locked, false);
});

for (const [native, connected, type] of [[false, true, 'boolean'], [0, 5, 'integer'], ['', 'C', 'text'], [1.5, 2.5, 'number']]) {
  test(`entry scalar ${JSON.stringify(native)} keeps its type and absence of fallback`, async () => {
    const f = fixture({ native, connected, type }); delete f.provenance[0].stored_fallback;
    // The constructor clones its inputs; create a fresh session with the absence.
    const session = createEditorSessionProjection({ request: f.request, provenance: f.provenance, assertCurrent() {} });
    await session.initialize(); await session.prepare(f.store);
    assert.equal(f.saves[0].output['1'].inputs.text, native);
    assert.equal(Object.hasOwn(f.saves[0].provenance[0], 'stored_fallback'), false);
    assert.equal(f.value(), connected);
  });
}

test('I differing from C requires a decision without calling storage or discarding I', async () => {
  const f = fixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'edited I';
  const result = await f.session.prepare(f.store);
  assert.equal(result.status, 'resolution_required'); assert.equal(result.persisted, false);
  assert.equal(result.conflicts[0].inner_value, 'edited I'); assert.equal(result.conflicts[0].native_pre_overlay, 'draft N');
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'edited I'); assert.equal(f.session.getState().busy, false);
});

for (const [choice, expected] of [['inner', 'edited I'], ['native', 'draft N']]) {
  test(`explicit ${choice} choice persists the chosen value and restores edited display`, async () => {
    const f = fixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'edited I';
    await f.session.prepare(f.store, { resolutions: { prompt: choice } });
    assert.equal(f.saves[0].output['1'].inputs.text, expected);
    assert.equal(f.saves[0].workflow.nodes[0].widgets[0].value, expected);
    assert.equal(f.saves[0].connected_resolutions[0].choice, choice);
    assert.equal(f.value(), 'edited I');
  });
}

test('stale or extra resolution IDs do not silently apply old decisions', async () => {
  const f = fixture(); await f.session.initialize();
  await assert.rejects(f.session.prepare(f.store, { resolutions: { prompt: 'inner' } }), error => error.code === 'invalid_resolution');
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'source C');
});

for (const cancelled of [null, false, { persisted: false }]) {
  test(`apply callback cancellation ${JSON.stringify(cancelled)} restores display without storing`, async () => {
    const f = fixture(); await f.session.initialize(); let payload;
    const result = await f.session.prepare(async clean => { payload = clean; return cancelled; });
    assert.equal(result.status, 'cancelled'); assert.equal(result.persisted, false);
    assert.equal(payload.output['1'].inputs.text, 'draft N'); assert.equal(f.value(), 'source C');
  });
}

test('store throw after a logical write reports unknown and restores display without resend', async () => {
  const f = fixture(); await f.session.initialize();
  const lostReply = new Error('response lost');
  await assert.rejects(f.session.persist(async payload => { f.saves.push(payload); throw lostReply; }), error => {
    assert.equal(error.persisted, 'unknown'); assert.equal(error.store_attempted, true); assert.equal(error.cause, lostReply);
    return true;
  });
  assert.equal(f.saves.length, 1); assert.equal(f.value(), 'source C'); assert.equal(f.session.getState().locked, false);
});

test('explicit durable outcome survives a callback error', async () => {
  const f = fixture(); await f.session.initialize();
  await assert.rejects(f.session.persist(async () => { const error = new Error('saved but bind refused'); error.persisted = true; throw error; }), error => error.persisted === true && error.store_attempted);
  assert.equal(f.value(), 'source C');
});

test('display restore failure distinguishes durable save, locks further persistence', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.before = (action, args, count) => { if (action === 'patch' && count === 3) throw new Error('restore failed'); };
  await assert.rejects(f.session.persist(f.store), error => error.code === 'display_restore_failed' && error.persisted === true && error.locked);
  assert.equal(f.saves.length, 1); assert.equal(f.value(), 'draft N');
  await assert.rejects(f.session.persist(f.store), error => error.code === 'session_locked'); assert.equal(f.saves.length, 1);
});

test('store error and display restore error both remain observable', async () => {
  const f = fixture(); await f.session.initialize(); const storeError = new Error('reply lost');
  f.hooks.before = (action, args, count) => { if (action === 'patch' && count === 3) throw new Error('restore failed'); };
  await assert.rejects(f.session.persist(async () => { throw storeError; }), error => error.persisted === 'unknown' && error.preparation_error === storeError && error.code === 'display_restore_failed');
});

test('cleanup patch failure never calls storage and locks even if display is recoverable', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.before = (action, args, count) => { if (action === 'patch' && count === 2) throw new Error('cleanup failed'); };
  await assert.rejects(f.session.persist(f.store), error => error.persisted === false && error.locked);
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'source C');
});

test('fresh named mapping follows widget reorder and never writes by stored index', async () => {
  const f = fixture(); await f.session.initialize(); f.graph.nodes[0].widgets.reverse();
  await f.session.persist(f.store);
  assert.equal(f.value(), 'source C'); assert.equal(f.graph.nodes[0].widgets.find(widget => widget.name === 'sibling').value, 'safe');
  for (const call of f.calls.filter(call => call.action === 'patch')) assert.equal(call.args.patches[0].widget_name, 'text');
});

test('changed mapping or missing widget blocks persistence without inventing a slot', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.after = (action, args, count, result) => { if (action === 'compile') result.controls[0].widget_name = 'sibling'; return result; };
  await assert.rejects(f.session.persist(f.store), error => error.code === 'mapping_changed');
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'source C');
});

test('dynamic patch changing a sibling is rejected by full API comparison', async () => {
  const f = fixture();
  f.hooks.after = (action, args, count, result) => { if (action === 'patch') f.graph.nodes[0].widgets[1].value = 'unexpected'; return result; };
  await assert.rejects(f.session.initialize(), error => error.code === 'unexpected_change');
  assert.equal(f.session.getState().locked, true); assert.equal(f.saves.length, 0);
});

test('snapshot and compile must correspond to the same graph before storage', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.after = (action, args, count, result) => { if (action === 'snapshot' && count === 1) result.workflow.metadata.keep = false; return result; };
  await assert.rejects(f.session.persist(f.store), error => error.code === 'snapshot_changed' && error.locked);
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'source C');
});

test('direct-source mutation during awaited compile prevents persistence', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.after = (action, args, count, result) => { if (action === 'compile') f.setCurrent(false); return result; };
  await assert.rejects(f.session.persist(f.store), /direct source changed/); assert.equal(f.saves.length, 0);
});

test('authorized target update after store does not reinterpret saved state', async () => {
  const f = fixture(); await f.session.initialize();
  const result = await f.session.persist(async payload => { f.saves.push(payload); f.setCurrent(false); return { revision: 2 }; });
  assert.equal(result.persisted, true); assert.equal(f.value(), 'source C');
});

test('new internal edit during storage is protected instead of overwritten by display restore', async () => {
  const f = fixture(); await f.session.initialize();
  await assert.rejects(f.session.persist(async payload => { f.saves.push(payload); f.graph.nodes[0].widgets[0].value = 'later edit'; return {}; }),
    error => error.code === 'display_restore_failed' && error.persisted === true && error.locked);
  assert.equal(f.value(), 'later edit');
});

test('media and nested overlays are explicitly unmapped and never falsely applied', async () => {
  const f = fixture({ extra: [
    { field_id: 'image', node_id: '2', input: 'image', class_type: 'LoadImage', type: 'image', origin: 'connected', value: 'file.png' },
    { field_id: 'nested', node_id: '4:5', input: 'text', class_type: 'TextNode', type: 'text', origin: 'connected', value: 'nested C' }
  ] });
  const result = await f.session.initialize();
  assert.equal(result.applied.length, 1); assert.deepEqual(result.unmapped.map(item => item.reason), ['media_owner_unverified', 'nested_display_not_supported']);
  await f.session.persist(f.store); assert.equal(f.saves[0].unmapped.length, 2);
  assert.equal(f.calls.filter(call => call.action === 'patch').every(call => call.args.patches.every(item => item.node_id === '1')), true);
});

test('own-value records are inert and input DTO is cloned at construction', async () => {
  const f = fixture({ extra: [{ field_id: 'sibling', origin: 'own', value: 'own update' }] });
  f.provenance[0].value = 'mutated DTO'; await f.session.initialize();
  assert.equal(f.value(), 'source C'); assert.equal(f.graph.nodes[0].widgets[1].value, 'safe');
});

test('baseline API conversion retains inactive branches and metadata, never sends connected C', async () => {
  const prompt = { '1': { class_type: 'TextNode', inputs: { text: 'nonconnected N' }, _meta: { keep: true } },
    '99': { class_type: 'Unused', inputs: { text: 'inactive' }, properties: { keep: true } } };
  const before = clone(prompt), args = { review_id: 'review1', accepted_added_inputs: [] }; let sent;
  await importEditorBaseline(async (action, payload) => { assert.equal(action, 'importApi'); sent = clone(payload); payload.prompt['1'].inputs.text = 'mutation'; return {}; }, prompt, args);
  assert.deepEqual(prompt, before); assert.deepEqual(sent.prompt, before); assert.deepEqual(args, { review_id: 'review1', accepted_added_inputs: [] });
  await assert.rejects(importEditorBaseline(async () => {}, prompt, { prompt }), /独立复核参数/);
});

test('concurrent storage operations are serialized without duplicate callbacks', async () => {
  const f = fixture(); await f.session.initialize(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = f.session.persist(async () => { entered(); await new Promise(resolve => { release = resolve; }); return {}; });
  await started; await assert.rejects(f.session.persist(f.store), error => error.code === 'session_busy');
  release(); await pending; assert.equal(f.saves.length, 0);
});

test('duplicate connected field or binding is rejected before any overlay is written', async () => {
  const f = fixture(); const provenance = [...f.provenance, { ...f.provenance[0], field_id: 'other' }];
  const session = createEditorSessionProjection({ request: f.request, provenance, assertCurrent() {} });
  await assert.rejects(session.initialize(), error => error.code === 'ambiguous_provenance');
  assert.equal(f.value(), 'draft N'); assert.equal(f.calls.some(call => call.action === 'patch'), false);
});

test('unmapped top-level value is reported without pretending the C display succeeded', async () => {
  const f = fixture(); f.hooks.after = (action, args, count, result) => {
    if (action === 'compile') result.controls = []; return result;
  };
  const result = await f.session.initialize();
  assert.equal(result.applied.length, 0); assert.equal(result.unmapped[0].reason, 'mapping_changed');
  assert.equal(result.unmapped[0].applied, false); assert.equal(f.value(), 'draft N');
  await f.session.persist(f.store); assert.equal(f.saves[0].output['1'].inputs.text, 'draft N');
});

test('initialize source changes during patch lock the candidate and forbid storage', async () => {
  const f = fixture(); f.hooks.after = (action, args, count, result) => {
    if (action === 'patch') f.setCurrent(false); return result;
  };
  await assert.rejects(f.session.initialize(), /direct source changed/);
  assert.equal(f.session.getState().locked, true);
  await assert.rejects(f.session.persist(f.store), error => error.code === 'session_locked'); assert.equal(f.saves.length, 0);
});

test('a restore response missing one applied acknowledgement cannot authorize storage', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.after = (action, args, count, result) => {
    if (action === 'patch' && count === 2) result.applied = []; return result;
  };
  await assert.rejects(f.session.persist(f.store), error => error.code === 'patch_unverified' && error.locked);
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'source C');
});

test('post-cleanup compile failure is never followed by storage and locks the session', async () => {
  const f = fixture(); await f.session.initialize(); let failed = false;
  f.hooks.before = (action) => {
    if (action === 'compile' && f.counts.patch === 2 && !failed) { failed = true; throw new Error('compiler failed'); }
  };
  await assert.rejects(f.session.persist(f.store), error => error.locked && error.persisted === false);
  assert.equal(f.saves.length, 0); assert.equal(f.value(), 'source C');
});

test('snapshot API mutation between serial requests is blocked before storage', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.after = (action, args, count, result) => {
    if (action === 'snapshot') f.graph.nodes[0].widgets[1].value = 'changed between'; return result;
  };
  await assert.rejects(f.session.persist(f.store), error => error.locked && error.persisted === false);
  assert.equal(f.saves.length, 0);
});

test('a conflict choice cannot authorize I changed while its dialog was open', async () => {
  const f = fixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'reviewed I';
  const first = await f.session.prepare(f.store);
  f.graph.nodes[0].widgets[0].value = 'new I';
  const second = await f.session.prepare(f.store, { resolutions: { prompt: 'inner' }, expectedConflicts: first.conflicts });
  assert.equal(second.status, 'resolution_required'); assert.equal(second.stale_resolution, true);
  assert.equal(second.conflicts[0].inner_value, 'new I'); assert.equal(f.value(), 'new I'); assert.equal(f.saves.length, 0);
  await f.session.prepare(f.store, { resolutions: { prompt: 'inner' }, expectedConflicts: second.conflicts });
  assert.equal(f.saves[0].output['1'].inputs.text, 'new I');
});

test('a vanished conflict after review cannot reuse the old inner-save choice', async () => {
  const f = fixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'reviewed I';
  const first = await f.session.prepare(f.store); f.graph.nodes[0].widgets[0].value = 'source C';
  const result = await f.session.prepare(f.store, { resolutions: { prompt: 'inner' }, expectedConflicts: first.conflicts });
  assert.equal(result.stale_resolution, true); assert.deepEqual(result.conflicts, []); assert.equal(f.saves.length, 0);
});

test('conflict review snapshots require the exact binding, native and connected values', async () => {
  const f = fixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'edited I';
  const first = await f.session.prepare(f.store);
  for (const key of ['node_id', 'input', 'class_type', 'native_pre_overlay', 'value', 'inner_value']) {
    const wrong = clone(first.conflicts); wrong[0][key] = 'different';
    const result = await f.session.prepare(f.store, { resolutions: { prompt: 'inner' }, expectedConflicts: wrong });
    assert.equal(result.stale_resolution, true); assert.equal(f.saves.length, 0);
  }
});

test('official raw/compiled serialization differences pass only stable paired checks', async () => {
  const f = fixture();
  f.graph.nodes[0].inputs = [{ name: 'text', localized_name: '本地标签', widget: { name: 'text' }, link: null }];
  f.hooks.after = (action, args, count, result) => {
    if (action === 'compile') {
      result.workflow.nodes[0].inputs = [{ name: 'text', widget: { name: 'text' } }];
      result.workflow.extra = { frontendVersion: 'verified-official-version' };
    }
    return result;
  };
  await f.session.initialize(); await f.session.persist(f.store);
  assert.equal(f.saves[0].workflow.extra.frontendVersion, 'verified-official-version');
  assert.equal(Object.hasOwn(f.saves[0].workflow.nodes[0].inputs[0], 'localized_name'), false);
  assert.equal(f.graph.nodes[0].inputs[0].localized_name, '本地标签');
  assert.equal(f.saves[0].output['1'].inputs.text, 'draft N'); assert.equal(f.value(), 'source C');
});

test('a raw snapshot change with identical API and compiled workflow still prevents saving', async () => {
  const f = fixture(); await f.session.initialize();
  f.hooks.after = (action, args, count, result) => {
    if (action === 'snapshot' && count === 2) result.workflow.metadata.transient = 'changed'; return result;
  };
  await assert.rejects(f.session.persist(f.store), error => error.code === 'snapshot_changed' && error.locked);
  assert.equal(f.saves.length, 0);
});

function mediaFixture({ native = '', connected = 'refs/current.png', type = 'image', mixed = false } = {}) {
  const backend = 'http://127.0.0.1:8188';
  const classType = type === 'video' ? 'VHS_LoadVideo' : type === 'audio' ? 'LoadAudio' : 'LoadImage';
  const input = type === 'video' ? 'video' : type === 'audio' ? 'audio' : 'image';
  const provenance = [{ field_id: 'reference', node_id: '1', input, class_type: classType, type, origin: 'connected',
    value: connected, media_owner: { name: connected, backend, media_type: type }, baseline: 'old B', stored_fallback: 'own F' }];
  const graph = { nodes: [{ id: '1', type: classType, widgets: [{ name: input, value: native }], options: ['listed-old-file'] }], metadata: { keep: true } };
  if (mixed) {
    graph.nodes.push({ id: '2', type: 'TextNode', widgets: [{ name: 'text', value: 'scalar N' }] });
    provenance.push({ field_id: 'prompt', node_id: '2', input: 'text', class_type: 'TextNode', type: 'text', origin: 'connected', value: 'scalar C' });
  }
  const hooks = {}, calls = [], counts = {}, saves = [], receipts = new Map(); let current = true;
  const compile = () => {
    const output = {}, controls = [];
    for (const node of graph.nodes) {
      output[node.id] = { class_type: node.type, inputs: Object.fromEntries(node.widgets.map(widget => [widget.name, widget.value])) };
      for (const widget of node.widgets) {
        const receipt = [...receipts.values()].find(item => item.node === node && item.widget === widget);
        if (receipt) receipt.allowed.add(widget.value); // Real bridge observes I only during compile.
        controls.push({ node_id: node.id, input: widget.name, widget_node_id: node.id, widget_name: widget.name,
          ...(receipt ? { media_receipt: receipt.token } : {}) });
      }
    }
    return { workflow: clone(graph), output, controls };
  };
  const request = async (action, args = {}) => {
    calls.push({ action, args: clone(args) }); counts[action] = (counts[action] || 0) + 1;
    if (hooks.before) await hooks.before(action, args, counts[action]);
    let result;
    if (action === 'compile') result = compile();
    else if (action === 'snapshot') result = { workflow: clone(graph) };
    else if (action === 'captureMedia') {
      result = { captured: [], unsupported: [] };
      for (const binding of args.bindings) {
        const node = graph.nodes.find(node => node.id === binding.node_id), widget = node?.widgets.find(widget => widget.name === binding.input);
        assert.ok(node && widget); assert.equal(node.type, binding.class_type);
        assert.equal(binding.media_owner.name, binding.value); assert.equal(binding.media_owner.media_type, binding.type);
        if (binding.media_owner.backend !== backend) { result.unsupported.push({ field_id: binding.field_id, reason: 'media_backend_mismatch' }); continue; }
        const token = `media-receipt-${receipts.size + 1}`;
        receipts.set(token, { token, node, widget, allowed: new Set([widget.value, binding.value]) });
        result.captured.push({ field_id: binding.field_id, node_id: binding.node_id, input: binding.input, type: binding.type,
          receipt: token, native_value: widget.value, preview_state: 'pending' });
      }
    } else if (action === 'patch') {
      // Preflight the entire batch, including exact identities, before any write.
      for (const patch of args.patches) {
        const node = graph.nodes.find(node => node.id === patch.node_id), widget = node?.widgets.find(widget => widget.name === patch.widget_name);
        assert.ok(node && widget); assert.equal(patch.class_type, node.type); assert.equal(patch.expected_value, widget.value);
        if (node.id === '1') {
          const captured = receipts.get(patch.media_receipt);
          if (!captured || captured.node !== node || captured.widget !== widget || !captured.allowed.has(patch.value)) throw new Error('invalid media receipt');
        } else assert.equal(Object.hasOwn(patch, 'media_receipt'), false);
      }
      for (const patch of args.patches) graph.nodes.find(node => node.id === patch.node_id).widgets.find(widget => widget.name === patch.widget_name).value = patch.value;
      result = { applied: args.patches.map(patch => ({ node_id: patch.node_id, widget_name: patch.widget_name })), unsupported: [] };
    } else throw new Error(`unsupported action ${action}`);
    if (hooks.after) result = await hooks.after(action, args, counts[action], result) || result;
    return result;
  };
  const newSession = () => createEditorSessionProjection({ request, provenance, assertCurrent() { if (!current) throw new Error('source changed'); } });
  const session = newSession();
  return { session, newSession, request, graph, provenance, hooks, calls, counts, saves, receipts,
    value: () => graph.nodes[0].widgets[0].value, setCurrent: value => { current = value; },
    store: async payload => { saves.push(clone(payload)); return { revision: saves.length }; } };
}

for (const [type, native, connected] of [['image', '', 'refs/new.png'], ['video', 'stale/old.mp4', 'refs/new.mp4'], ['audio', '', 'refs/new.wav']]) {
  test(`${type} captured N and unlisted C roundtrip without modifying fallback or source`, async () => {
    const f = mediaFixture({ type, native, connected }); const source = clone(f.provenance);
    const initial = await f.session.initialize();
    assert.equal(initial.applied[0].native_pre_overlay, native); assert.equal(initial.applied[0].preview_state, 'pending');
    assert.equal(f.value(), connected); assert.equal(f.graph.nodes[0].options.includes(connected), false);
    await f.session.persist(f.store);
    const field = f.provenance[0].input;
    assert.equal(f.saves[0].output['1'].inputs[field], native); assert.equal(f.saves[0].workflow.nodes[0].widgets[0].value, native);
    assert.equal(f.value(), connected); assert.deepEqual(f.provenance, source);
    assert.equal(f.calls.filter(call => call.action === 'patch').every(call => call.args.patches.every(item => item.media_receipt === initial.applied[0].media_receipt)), true);
    assert.equal(Object.hasOwn(f.saves[0].provenance[0], 'media_receipt'), false);
  });
}

for (const choice of ['inner', 'native']) {
  test(`media conflict ${choice} preserves I display and only inner invalidates connected owner`, async () => {
    const f = mediaFixture({ native: 'draft/original.png' }); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'picked/inner.png';
    const conflict = await f.session.prepare(f.store); assert.equal(conflict.status, 'resolution_required'); assert.equal(f.saves.length, 0);
    await f.session.prepare(f.store, { resolutions: { reference: choice }, expectedConflicts: conflict.conflicts });
    assert.equal(f.saves[0].output['1'].inputs.image, choice === 'inner' ? 'picked/inner.png' : 'draft/original.png');
    assert.equal(f.saves[0].connected_resolutions[0].media_owner_invalidated, choice === 'inner' ? true : undefined);
    assert.equal(Object.hasOwn(f.saves[0].connected_resolutions[0], 'media_owner'), false); assert.equal(f.value(), 'picked/inner.png');
  });
}

test('media cancel callback receives clean N and restores C without saving', async () => {
  const f = mediaFixture({ native: 'stale.png' }); await f.session.initialize(); let payload;
  const result = await f.session.prepare(async clean => { payload = clean; return null; });
  assert.equal(result.persisted, false); assert.equal(result.status, 'cancelled'); assert.equal(payload.output['1'].inputs.image, 'stale.png');
  assert.equal(f.value(), 'refs/current.png'); assert.equal(f.session.getState().locked, false);
});

test('media reply lost after logical write stays unknown and restores display without automatic retry', async () => {
  const f = mediaFixture(); await f.session.initialize();
  await assert.rejects(f.session.prepare(async payload => { f.saves.push(payload); throw new Error('reply lost'); }), error => error.persisted === 'unknown' && error.store_attempted);
  assert.equal(f.saves.length, 1); assert.equal(f.value(), 'refs/current.png');
  assert.equal(f.counts.patch, 3);
});

test('media durable save and failed display restore lock subsequent operations', async () => {
  const f = mediaFixture(); await f.session.initialize();
  f.hooks.before = (action, args, count) => { if (action === 'patch' && count === 3) throw new Error('receipt lost'); };
  await assert.rejects(f.session.persist(f.store), error => error.code === 'display_restore_failed' && error.persisted === true && error.locked);
  await assert.rejects(f.session.persist(f.store), error => error.code === 'session_locked'); assert.equal(f.saves.length, 1);
});

for (const mutation of [item => { item.media_owner.name = 'other.png'; }, item => { item.media_owner.media_type = 'video'; },
  item => { delete item.media_owner; }, item => { item.value = '../unsafe.png'; item.media_owner.name = item.value; }]) {
  test('media invalid local owner/name never requests capture or patches the media', async () => {
    const f = mediaFixture(); mutation(f.provenance[0]);
    const result = await f.newSession().initialize(); assert.equal(result.unmapped[0].reason, 'media_owner_unverified');
    assert.equal(f.calls.some(call => call.action === 'captureMedia' || call.action === 'patch'), false); assert.equal(f.value(), '');
  });
}

test('bridge independently rejects other-backend owner but still overlays scalar', async () => {
  const f = mediaFixture({ mixed: true }); f.provenance[0].media_owner.backend = 'http://127.0.0.1:8189';
  const result = await f.newSession().initialize(); assert.equal(result.unmapped[0].reason, 'media_backend_mismatch');
  assert.equal(result.applied.length, 1); assert.equal(f.value(), ''); assert.equal(f.graph.nodes[1].widgets[0].value, 'scalar C');
});

test('old bridge capture action rejection defers only media, preserving scalar and clean persistence', async () => {
  const f = mediaFixture({ mixed: true });
  f.hooks.before = action => { if (action === 'captureMedia') throw new Error('unknown action'); };
  const result = await f.session.initialize(); assert.equal(result.unmapped[0].reason, 'media_capture_unavailable');
  assert.equal(result.applied[0].field_id, 'prompt'); await f.session.persist(f.store);
  assert.equal(f.saves[0].output['1'].inputs.image, ''); assert.equal(f.saves[0].output['2'].inputs.text, 'scalar N');
});

for (const corrupt of [item => { item.receipt = ''; }, item => { item.receipt = 'x'.repeat(513); }, item => { item.input = 'other'; },
  item => { item.type = 'audio'; }, item => { item.native_value = false; }, item => { item.preview_state = 'invented'; }]) {
  test('malformed media capture proof never authorizes a patch', async () => {
    const f = mediaFixture(); f.hooks.after = (action, args, count, result) => { if (action === 'captureMedia') corrupt(result.captured[0]); return result; };
    const result = await f.session.initialize(); assert.equal(result.unmapped[0].reason, 'media_capture_unverified');
    assert.equal(f.value(), ''); assert.equal(f.calls.some(call => call.action === 'patch'), false);
  });
}

test('capture native literal must match before and after compile', async () => {
  const f = mediaFixture({ native: 'real.png' });
  f.hooks.after = (action, args, count, result) => { if (action === 'captureMedia') result.captured[0].native_value = 'old-baseline.png'; return result; };
  const result = await f.session.initialize(); assert.equal(result.unmapped[0].reason, 'media_native_value_changed'); assert.equal(f.value(), 'real.png');
});

test('media preview failed still permits exact filename synchronization after proven isolation', async () => {
  const f = mediaFixture(); f.hooks.after = (action, args, count, result) => { if (action === 'captureMedia') result.captured[0].preview_state = 'failed'; return result; };
  const result = await f.session.initialize(); assert.equal(result.applied[0].preview_state, 'failed'); assert.equal(f.value(), 'refs/current.png');
});

test('source changes during capture are fatal and never converted to media deferred', async () => {
  const f = mediaFixture({ mixed: true }); f.hooks.after = (action, args, count, result) => { if (action === 'captureMedia') f.setCurrent(false); return result; };
  await assert.rejects(f.session.initialize(), /source changed/); assert.equal(f.calls.some(call => call.action === 'patch'), false);
});

for (const native of ['', 'refs/current.png']) {
  test(`same-id media node replacement blocks storage even with ${native ? 'zero' : 'nonzero'} cleanup`, async () => {
    const f = mediaFixture({ native }); await f.session.initialize();
    f.graph.nodes[0] = clone(f.graph.nodes[0]);
    await assert.rejects(f.session.prepare(f.store), error => error.code === 'media_receipt_changed');
    assert.equal(f.saves.length, 0); assert.equal(f.value(), 'refs/current.png');
  });
}

test('same-name media widget replacement blocks storage, including inner zero-cleanup choice', async () => {
  const f = mediaFixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0] = { name: 'image', value: 'inner.png' };
  await assert.rejects(f.session.prepare(f.store, { resolutions: { reference: 'inner' } }), error => error.code === 'media_receipt_changed');
  assert.equal(f.saves.length, 0);
});

test('media I changed after conflict dialog requires a new review without storing', async () => {
  const f = mediaFixture(); await f.session.initialize(); f.graph.nodes[0].widgets[0].value = 'reviewed.png';
  const first = await f.session.prepare(f.store); f.graph.nodes[0].widgets[0].value = 'later.png';
  const second = await f.session.prepare(f.store, { resolutions: { reference: 'inner' }, expectedConflicts: first.conflicts });
  assert.equal(second.stale_resolution, true); assert.equal(second.conflicts[0].inner_value, 'later.png'); assert.equal(f.saves.length, 0);
});

test('scalar current native value is captured fresh after a media capability check', async () => {
  const f = mediaFixture({ mixed: true }); f.hooks.after = (action, args, count, result) => {
    if (action === 'captureMedia') f.graph.nodes[1].widgets[0].value = 'user fresh N'; return result;
  };
  await f.session.initialize(); await f.session.persist(f.store);
  assert.equal(f.saves[0].output['2'].inputs.text, 'user fresh N'); assert.equal(f.graph.nodes[1].widgets[0].value, 'scalar C');
});

for (const corrupt of [result => { result.captured.push(clone(result.captured[0])); },
  result => { result.unsupported.push({ field_id: 'reference', reason: 'also rejected' }); },
  result => { result.captured[0].field_id = 'unknown'; }, result => { result.captured = []; }]) {
  test('capture duplicate, contradictory, unknown or missing binding cannot partially apply media', async () => {
    const f = mediaFixture({ mixed: true }); f.hooks.after = (action, args, count, result) => { if (action === 'captureMedia') corrupt(result); return result; };
    const initial = await f.session.initialize(); assert.equal(initial.unmapped[0].reason, 'media_capture_unverified');
    assert.equal(f.value(), ''); assert.equal(f.graph.nodes[1].widgets[0].value, 'scalar C');
    assert.equal(f.calls.filter(call => call.action === 'patch').every(call => call.args.patches.every(item => item.node_id === '2')), true);
  });
}

test('capture success without a fresh actual-control receipt echo remains deferred', async () => {
  const f = mediaFixture(); f.hooks.after = (action, args, count, result) => {
    if (action === 'compile' && count >= 2) delete result.controls[0].media_receipt; return result;
  };
  const initial = await f.session.initialize(); assert.equal(initial.unmapped[0].reason, 'media_receipt_changed'); assert.equal(f.value(), '');
});

test('inner media edit during capture is preserved and does not become old captured N', async () => {
  const f = mediaFixture({ native: 'entry.png' }); f.hooks.after = (action, args, count, result) => {
    if (action === 'captureMedia') f.graph.nodes[0].widgets[0].value = 'edited-during-capture.png'; return result;
  };
  const initial = await f.session.initialize(); assert.equal(initial.unmapped[0].reason, 'media_native_value_changed');
  assert.equal(f.value(), 'edited-during-capture.png'); await f.session.persist(f.store);
  assert.equal(f.saves[0].output['1'].inputs.image, 'edited-during-capture.png');
});

test('a mixed scalar/media patch validates every receipt before changing any value', async () => {
  const f = mediaFixture({ mixed: true }); f.hooks.before = (action, args) => {
    if (action === 'patch') args.patches.find(item => Object.hasOwn(item, 'media_receipt')).media_receipt = 'forged';
  };
  await assert.rejects(f.session.initialize(), /invalid media receipt/);
  assert.equal(f.value(), ''); assert.equal(f.graph.nodes[1].widgets[0].value, 'scalar N'); assert.equal(f.session.getState().locked, true);
});

test('capture unavailable cannot make a simultaneous scalar edit restore an old value', async () => {
  const f = mediaFixture({ mixed: true }); f.hooks.before = action => {
    if (action === 'captureMedia') { f.graph.nodes[1].widgets[0].value = 'new own N'; throw new Error('old bridge'); }
  };
  await f.session.initialize(); await f.session.persist(f.store);
  assert.equal(f.saves[0].output['2'].inputs.text, 'new own N');
});
