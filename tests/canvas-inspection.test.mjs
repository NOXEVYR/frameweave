import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, connect, serializeGraph } from '../web/graph.mjs';
import { createCanvasInspection, inspectWithDiscovery } from '../web/canvas-inspection.mjs';

const BACKEND = 'http://127.0.0.1:8188';
const targetScope = { selected_outputs: ['save-a'], node_ids: ['load-a', 'save-a'], active_field_ids: ['a', 'prompt'] };

function graphFixture({ reference = true, materialized = true, upstream = false } = {}) {
  const target = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-target', editor_outputs: ['save-a'],
    editor_output_fields: [{ id: 'save-a', mediaType: 'image' }, { id: 'save-b', mediaType: 'image' }],
    packageFields: [{ id: 'a', label: '活动图片', type: 'image' }, { id: 'b', label: '未选图片', type: 'image' }, { id: 'prompt', label: '文字', type: 'text' }],
    packageValues: { a: 'ready.png', b: 'unused.png', prompt: 'old text' },
    packageMediaBackends: { b: { name: 'unused.png', backend: 'http://127.0.0.1:9999' } },
  }); target.id = 'target';
  const inactive = createNode('generation', 0, 200, { kind: 'package', package_id: '' }); inactive.id = 'inactive';
  const text = createNode('prompt', 0, 400, { text: 'current text' }); text.id = 'text';
  const graph = { nodes: [inactive, text, target], edges: [] };
  connect(graph, text.id, target.id, { targetField: 'prompt' });
  graph.edges.push({ id: 'unused-edge', source: inactive.id, target: target.id, targetField: 'b', sourceField: 'image', outputIndex: 0 });
  if (upstream) {
    const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-source', outputs: [{ type: 'image', node_id: 'save-source', filename: 'historical.png' }] }); source.id = 'source';
    graph.nodes.push(source);
    graph.edges.push({ id: 'active-unknown', source: source.id, target: target.id, targetField: 'a', sourceField: 'image', sourceOutput: 'save-source', outputIndex: 0 });
  } else if (reference) {
    const ref = createNode('reference', 0, 0, { name: materialized ? 'ready.png' : '', uploadBackend: BACKEND, localAssetId: 'a'.repeat(32), mediaType: 'image' }); ref.id = 'reference';
    graph.nodes.push(ref); connect(graph, ref.id, target.id, { targetField: 'a' });
  }
  return graph;
}

function harness(options = {}) {
  let graph = options.graph || graphFixture(), backend = BACKEND, canvasId = 'original';
  const calls = [], mediaChecks = [];
  const control = { planError: null, remoteBackend: BACKEND, drift: null };
  const api = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    const special = await options.hook?.(path, body, control); if (special !== undefined) return special;
    if (path === '/api/status') return { online: true, backend_url: control.remoteBackend };
    if (path === '/api/execution-plan') {
      if (control.planError) throw new Error(control.planError);
      return { backend_url: BACKEND, package_id: body.request.package_id, execution: body.request.package_id === 'p-source'
        ? { selected_outputs: ['save-source'], node_ids: ['save-source'], active_field_ids: [] } : structuredClone(targetScope) };
    }
    if (path === '/api/compile') return { prompt: { compiled: {} }, summary: { package_id: 'p-target', execution: { ...structuredClone(targetScope), ...control.drift } } };
    if (path === '/api/diagnostics') return { checks: [{ category: 'workflow', status: 'ok' }], summary: 'active branch checked' };
    throw new Error(`forbidden API ${path}`);
  };
  const inspector = createCanvasInspection({ api, graph: () => graph, backend: () => backend, canvasIdentity: () => canvasId,
    assertMediaReady: (targets, projection, scoped) => { mediaChecks.push({ targets, projection, scoped }); options.assertMediaReady?.(targets, projection, scoped); } });
  return { inspector, api, calls, control, mediaChecks, graph: () => graph,
    setGraph: value => { graph = value; }, setBackend: value => { backend = value; }, setIdentity: value => { canvasId = value; } };
}

test('read-only diagnostics and compile ignore inactive unprepared unknown inputs while preserving source', async () => {
  const h = harness(), original = serializeGraph(h.graph());
  const diagnostic = await h.inspector.diagnose('target');
  assert.equal(diagnostic.result.summary, 'active branch checked');
  assert.deepEqual(diagnostic.request.output_nodes, ['save-a']);
  assert.deepEqual(diagnostic.request.values, { a: 'ready.png', b: 'unused.png', prompt: 'current text' });
  const compiled = await h.inspector.compile('target'); assert.deepEqual(compiled.result.prompt, { compiled: {} });
  assert.equal(serializeGraph(h.graph()), original);
  assert(h.mediaChecks.every(check => check.scoped && check.projection.nodes.every(node => node.id !== 'inactive')));
  assert(h.mediaChecks.every(check => check.projection.nodes.find(node => node.id === 'target').data.packageFields.every(field => field.id !== 'b')));
  assert(h.calls.every(call => ['/api/status', '/api/execution-plan', '/api/compile', '/api/diagnostics'].includes(call.path)));
  assert(!h.calls.some(call => call.body?.request?.package_id === ''));
});

test('existing materialized local references can be checked but missing names never upload or reuse stale form values', async () => {
  const ready = harness(); await ready.inspector.compile('target');
  const missing = harness({ graph: graphFixture({ materialized: false }) });
  await assert.rejects(missing.inspector.compile('target'), /尚未传入当前引擎/);
  assert(!missing.calls.some(call => call.path === '/api/compile'));
  assert.equal(missing.calls.find(call => call.path === '/api/execution-plan').body.request.values.a, '');
  const foreign = harness(); foreign.graph().nodes.find(node => node.id === 'reference').data.uploadBackend = 'http://127.0.0.1:9999';
  await assert.rejects(foreign.inspector.diagnose('target'), /属于其他推理引擎/);
  assert(!foreign.calls.some(call => /upload|generate|jobs|settings/.test(call.path)));
});

test('active legacy unknown dependencies remain waiting for this run and never consume historical media', async () => {
  const h = harness({ graph: graphFixture({ upstream: true }) });
  await assert.rejects(h.inspector.diagnose('target'), /等待本次上游生成与素材交接/);
  await assert.rejects(h.inspector.compile('target'), /不会启动上游或使用历史产物/);
  assert.equal(h.calls.filter(call => call.path === '/api/execution-plan' && call.body.request.package_id === 'p-source').length, 2);
  assert(!h.calls.some(call => ['/api/diagnostics', '/api/compile'].includes(call.path)));
  h.graph().nodes.find(node => node.id === 'source').data.package_id = '';
  await assert.rejects(h.inspector.compile('target'), /尚未建立外层参数/);
});

test('environment discovery starts and finishes even if plan or synchronous request preparation fails', async () => {
  for (const synchronous of [false, true]) {
    const h = harness(); h.control.planError = 'active scope cannot be planned';
    const events = [];
    const [inspection, discovery] = await inspectWithDiscovery(() => {
      events.push('inspect');
      if (synchronous) throw new Error('cannot build request');
      return h.inspector.diagnose('target');
    }, async () => { events.push('scan'); await Promise.resolve(); events.push('scanned'); return { hardware: {} }; });
    assert.equal(inspection.status, 'rejected'); assert.equal(discovery.status, 'fulfilled');
    assert.equal(events[0], 'scan'); assert(events.includes('scanned'));
    assert(!h.calls.some(call => call.path === '/api/diagnostics'));
  }
  const [inspection, discovery] = await inspectWithDiscovery(() => ({ checks: [] }), () => { throw new Error('scan failed'); });
  assert.equal(inspection.status, 'fulfilled'); assert.equal(discovery.status, 'rejected');
});

test('full canvas edits, backend changes and imported canvas identity changes reject asynchronous results', async () => {
  for (const path of ['/api/status', '/api/execution-plan', '/api/diagnostics', '/api/compile']) for (const change of ['graph', 'backend', 'identity']) {
    let changed = false;
    const h = harness({ hook: async called => {
      if (called !== path || changed) return;
      changed = true;
      if (change === 'graph') h.graph().nodes.find(node => node.id === 'inactive').data.title = 'edited unused branch';
      if (change === 'backend') h.setBackend('http://127.0.0.1:9999');
      if (change === 'identity') h.setIdentity('imported-same-node-ids');
    } });
    const operation = path === '/api/diagnostics' ? h.inspector.diagnose('target') : h.inspector.compile('target');
    await assert.rejects(operation, /画布或推理引擎已变化/);
  }
});

test('remote backend switches, media readiness errors and live compile scope drift block export', async () => {
  const remote = harness({ hook: path => { if (path === '/api/compile') remote.control.remoteBackend = 'http://127.0.0.1:9999'; } });
  await assert.rejects(remote.inspector.compile('target'), /推理引擎已变化/);
  const blocked = harness({ assertMediaReady: (_ids, graph) => {
    assert(!graph.nodes.some(node => node.id === 'inactive')); throw new Error('active field transfer pending');
  } });
  await assert.rejects(blocked.inspector.compile('target'), /active field transfer pending/);
  assert(!blocked.calls.some(call => call.path === '/api/compile'));
  for (const drift of [{ node_ids: ['load-a', 'save-a', 'other'] }, { active_field_ids: ['a', 'prompt', 'b'] }, { selected_outputs: ['save-b'] }]) {
    const h = harness(); h.control.drift = drift;
    await assert.rejects(h.inspector.compile('target'), /实时编译范围已变化/);
  }
});

test('inspection context guards package-editor follow-up and delayed discovery before applying results', async () => {
  const h = harness(), context = await h.inspector.compile('target');
  h.setIdentity('new-canvas'); assert.throws(context.ensureCurrent, /未应用或导出旧结果/);
  const other = harness();
  const [inspection] = await inspectWithDiscovery(() => other.inspector.diagnose('target'), async () => {
    await new Promise(resolve => setImmediate(resolve)); other.graph().nodes[0].x++;
  });
  assert.equal(inspection.status, 'fulfilled');
  assert.throws(inspection.value.ensureCurrent, /画布或推理引擎已变化/);
});
