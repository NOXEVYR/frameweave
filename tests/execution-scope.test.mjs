import test from 'node:test';
import assert from 'node:assert/strict';
import { planExecution, projectExecution } from '../web/execution-scope.mjs';
import { executionOrder, generationPayload, validateExecutionMediaBackends } from '../web/graph.mjs';

const backend = 'http://127.0.0.1:8188';
const otherBackend = 'http://127.0.0.1:8288';
const clone = value => JSON.parse(JSON.stringify(value));
const node = (id, type, data = {}) => ({ id, type, x: 0, y: 0, data });
const field = (id, type = 'image') => ({ id, type, label: id });
const generation = (id, data = {}) => node(id, 'generation', { kind: 'package', package_id: `p-${id}`,
  packageValues: {}, packageFields: [], ...data });
const edge = (id, source, target, targetField, options = {}) => ({ id, source, target,
  ...(targetField ? { targetField } : {}), ...options });
const scope = (package_id, selected_outputs, active_field_ids = [], node_ids = selected_outputs) => ({
  package_id, selected_outputs, node_ids, active_field_ids,
});

function fixture() {
  return { schema: 'frameweave.canvas.v1', title: '保留完整原图', nodes: [
    node('text-a', 'prompt', { text: '当前文本', negative: '当前负向' }),
    node('ref-a', 'reference', { name: '', localAssetId: 'local-a', mediaType: 'image', importState: 'ready' }),
    generation('draft-b', { package_id: '', editor_backend: otherBackend }),
    generation('target', { packageValues: { text_a: '', image_a: '', image_b: 'other.png', untouched: 7 },
      packageFields: [field('text_a', 'text'), field('image_a'), field('image_b')], editor_outputs: ['save_a'],
      editor_output_fields: [{ id: 'save_a', mediaType: 'image' }, { id: 'save_b', mediaType: 'image' }],
      packageMediaBackends: { image_a: { name: 'a.png', backend }, image_b: { name: 'other.png', backend: otherBackend } },
      apiPrompt: { raw: '完整内部源图原文' } }),
  ], edges: [edge('prompt-a', 'text-a', 'target', 'text_a', { sourceField: 'text' }),
    edge('input-a', 'ref-a', 'target', 'image_a'), edge('input-b', 'draft-b', 'target', 'image_b', { sourceField: 'image' })] };
}

function mockApi(graph, plans = {}) {
  const calls = [];
  const api = async (path, body) => {
    assert.equal(path, '/api/execution-plan');
    calls.push(clone(body));
    const target = graph.nodes.find(item => item.data.package_id === body.request.package_id);
    assert.ok(target, 'only known packages are planned');
    const selected = body.request.output_nodes || ['save_a', 'save_b'];
    const provided = plans[target.id];
    const result = typeof provided === 'function' ? provided(body) : provided
      || scope(target.data.package_id, selected, target.id === 'target'
        ? selected.includes('save_b') ? ['text_a', 'image_a', 'image_b'] : ['text_a', 'image_a'] : []);
    return { backend_url: backend, package_id: target.data.package_id,
      execution: { ...clone(result), output_nodes: [...result.selected_outputs], ignored_node_ids: [], warnings: [] } };
  };
  return { api, calls };
}

test('A excludes inactive unbuilt/other-backend upstream and keeps full source and values', async () => {
  const graph = fixture(), before = clone(graph), { api, calls } = mockApi(graph);
  const execution = await planExecution(graph, ['target'], backend, api);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { backend_url: backend, request: { kind: 'package', package_id: 'p-target',
    values: { text_a: '当前文本', image_a: '', image_b: '', untouched: 7 }, output_nodes: ['save_a'] } });
  assert.deepEqual(execution.node_ids, ['text-a', 'ref-a', 'target']);
  assert.deepEqual(execution.edge_ids, ['prompt-a', 'input-a']);
  const projected = projectExecution(graph, execution, ['target']);
  assert.equal(projected.title, graph.title);
  assert.deepEqual(executionOrder(projected, ['target']), ['target']);
  const target = projected.nodes.find(item => item.id === 'target');
  assert.deepEqual(target.data.packageFields.map(item => item.id), ['text_a', 'image_a']);
  assert.deepEqual(Object.keys(target.data.packageMediaBackends), ['image_a']);
  assert.deepEqual(target.data.packageValues, before.nodes.at(-1).data.packageValues);
  assert.deepEqual(target.data.apiPrompt, before.nodes.at(-1).data.apiPrompt);
  assert.equal(validateExecutionMediaBackends(projected, ['target'], backend, backend), true);
  target.data.packageValues.image_b = 'copy-only.png'; projected.edges[0].sourceField = 'negative';
  assert.deepEqual(graph, before);
});

test('switching to B or all outputs visits B and requires its package', async () => {
  for (const selected of [['save_b'], undefined]) {
    const graph = fixture(); delete graph.nodes[2].data.editor_backend;
    if (selected) graph.nodes.at(-1).data.editor_outputs = selected;
    else delete graph.nodes.at(-1).data.editor_outputs;
    const { api, calls } = mockApi(graph);
    await assert.rejects(planExecution(graph, ['target'], backend, api), /尚未建立外层参数/);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request.output_nodes, selected);
  }
});

test('default live outputs are frozen explicitly; empty explicit outputs fail', async () => {
  const graph = fixture(); graph.nodes.splice(2, 1); graph.edges.pop(); delete graph.nodes.at(-1).data.editor_outputs;
  const { api } = mockApi(graph);
  const execution = await planExecution(graph, ['target'], backend, api);
  assert.deepEqual(execution.packages.target.selected_outputs, ['save_a', 'save_b']);
  assert.deepEqual(projectExecution(graph, execution, ['target']).nodes.at(-1).data.editor_outputs, ['save_a', 'save_b']);
  graph.nodes.at(-1).data.editor_outputs = [];
  await assert.rejects(planExecution(graph, ['target'], backend, api), /输出 ID无效/);
});

test('negative prompt overlays current text without filling future media or old outputs', async () => {
  const graph = fixture(); graph.edges[0].sourceField = 'negative';
  graph.nodes[1].data.name = 'existing-reference.png';
  const { api, calls } = mockApi(graph);
  await planExecution(graph, ['target'], backend, api);
  assert.equal(calls[0].request.values.text_a, '当前负向');
  assert.equal(calls[0].request.values.image_a, '');
  assert.equal(calls[0].request.values.image_b, '');
  assert.equal('request_id' in calls[0], false);
});

function sharedGraph() {
  return { nodes: [generation('shared', { editor_outputs: ['out'], editor_output_fields: [{ id: 'out', mediaType: 'unknown' }],
    outputs: [{ type: 'image', filename: 'historical.png', node_id: 'out' }] }),
    node('result', 'result', { outputs: [{ type: 'image', filename: 'historical-result.png' }] }),
    generation('left', { packageFields: [field('input'), field('unused')], packageValues: { input: '' }, editor_outputs: ['out'] }),
    generation('right', { packageFields: [field('input')], editor_outputs: ['out'] }),
    generation('extra', { editor_outputs: ['out'] })],
  edges: [edge('owner', 'shared', 'result'), edge('left-input', 'result', 'left', 'input', { sourceOutput: 'out', sourceField: 'image', outputIndex: 1 }),
    edge('right-input', 'shared', 'right', 'input', { sourceOutput: 'out', sourceField: 'image' }), edge('unused-extra', 'extra', 'left', 'unused')] };
}

test('result follows unique owner, unknown active edges survive, shared ancestor is planned once', async () => {
  const graph = sharedGraph(), before = clone(graph), plans = {
    shared: scope('p-shared', ['out']), left: scope('p-left', ['out'], ['input']), right: scope('p-right', ['out'], ['input']),
  };
  const { api, calls } = mockApi(graph, plans);
  const execution = await planExecution(graph, ['left', 'right'], backend, api);
  assert.deepEqual(calls.map(call => call.request.package_id), ['p-left', 'p-shared', 'p-right']);
  assert.deepEqual(execution.node_ids, ['shared', 'result', 'left', 'right']);
  const projected = projectExecution(graph, execution, ['left', 'right']);
  assert.deepEqual(executionOrder(projected, ['left', 'right']), ['shared', 'left', 'right']);
  assert.deepEqual(projected.edges[1], graph.edges[1]);
  assert.ok(calls.every(call => !Object.values(call.request.values).some(value => /historical/.test(value))));
  assert.deepEqual(graph, before);
});

test('runAll retains every generation as explicit root even behind inactive input', async () => {
  const graph = sharedGraph(), plans = { shared: scope('p-shared', ['out']), left: scope('p-left', ['out'], ['input']),
    right: scope('p-right', ['out'], ['input']), extra: scope('p-extra', ['out']) };
  const { api, calls } = mockApi(graph, plans);
  const execution = await planExecution(graph, undefined, backend, api);
  assert.equal(calls.length, 4);
  assert.ok(execution.node_ids.includes('extra'));
  assert.equal(execution.edge_ids.includes('unused-extra'), false);
  assert.deepEqual(executionOrder(projectExecution(graph, execution), graph.nodes.filter(item => item.type === 'generation').map(item => item.id)),
    ['shared', 'left', 'right', 'extra']);
});

test('sourceOutput conflict fails before submission and never rewrites upstream outputs', async () => {
  const graph = sharedGraph(); graph.edges[1].sourceOutput = 'other';
  const before = clone(graph), { api } = mockApi(graph, { shared: scope('p-shared', ['out']), left: scope('p-left', ['out'], ['input']) });
  await assert.rejects(planExecution(graph, ['left'], backend, api), /绑定输出 other.*未选择此输出/);
  assert.deepEqual(graph, before);
});

test('result nodes reject zero or multiple owners; valid result can be explicit root', async () => {
  const graph = sharedGraph(), { api } = mockApi(graph, { shared: scope('p-shared', ['out']) });
  const execution = await planExecution(graph, ['result'], backend, api);
  assert.deepEqual(execution.node_ids, ['shared', 'result']);
  for (const edges of [[], [graph.edges[0], edge('second-owner', 'extra', 'result')]]) {
    const broken = { ...graph, edges };
    await assert.rejects(planExecution(broken, ['result'], backend, api), /唯一上游/);
  }
});

test('active foreign backend and mismatched response identity fail closed', async () => {
  const graph = fixture(); graph.nodes.at(-1).data.editor_outputs = ['save_b'];
  const { api } = mockApi(graph);
  await assert.rejects(planExecution(graph, ['target'], backend, api), /其他推理引擎/);
  for (const patch of [{ backend_url: otherBackend }, { package_id: 'p-swapped' }, { execution: null }]) {
    const clean = fixture(), mocked = mockApi(clean);
    await assert.rejects(planExecution(clean, ['target'], backend, async (...args) => ({ ...await mocked.api(...args), ...patch })), /身份.*不匹配/);
  }
});

test('async planning uses its captured source graph and normalizes equivalent backend identity', async () => {
  const graph = fixture(), { api, calls } = mockApi(graph);
  const execution = await planExecution(graph, ['target'], 'http://localhost:8188/', async (...args) => {
    const response = await api(...args);
    graph.nodes.at(-1).data.editor_outputs = ['save_b']; graph.edges.pop();
    return response;
  });
  assert.deepEqual(execution.packages.target.selected_outputs, ['save_a']);
  assert.equal(calls[0].request.values.text_a, '当前文本');
  assert.throws(() => projectExecution(graph, execution, ['target']), /输出不匹配/);
});

test('restore rejects deleted/added active edges, nodes, packages and malformed records', async () => {
  const graph = fixture(), { api } = mockApi(graph), execution = await planExecution(graph, ['target'], backend, api);
  const mutations = [
    state => state.edge_ids.pop(), state => state.edge_ids.push('input-b'), state => state.node_ids.pop(),
    state => state.node_ids.push('draft-b'), state => state.edge_ids.push('missing'),
    state => state.node_ids.push(state.node_ids[0]), state => delete state.packages.target,
    state => { state.packages['draft-b'] = scope('p-draft-b', ['out']); },
    state => { state.packages.target.package_id = 'wrong'; },
    state => { state.packages.target.active_field_ids = ['unknown']; },
    state => { state.packages.target.active_field_ids.push('image_a'); },
    state => { state.packages.target.selected_outputs = ['save_b']; },
    state => { state.packages.target.node_ids = []; }, state => { state.version = 2; },
    state => { state.order = ['target']; }, state => { state.packages.target.extra = true; },
  ];
  for (const mutate of mutations) {
    const invalid = clone(execution); mutate(invalid);
    assert.throws(() => projectExecution(graph, invalid, ['target']));
  }
  const deleted = clone(graph); deleted.edges.shift();
  assert.throws(() => projectExecution(deleted, execution, ['target']), /集合.*不匹配/);
  const added = clone(graph); added.edges.push(edge('added-active', 'text-a', 'target', 'text_a'));
  assert.throws(() => projectExecution(added, execution, ['target']), /集合.*不匹配/);
});

test('backend response validates fields/output references and optional binding metadata', async () => {
  const graph = fixture();
  for (const invalid of [scope('p-target', ['save_a'], ['missing']), scope('p-target', ['save_a', 'save_a']),
    scope('p-target', ['save_a'], ['image_a', 'image_a']), scope('p-target', ['save_a'], [], ['other']),
    scope('p-target', ['save_b']), scope('p-target', [], [])]) {
    const { api } = mockApi(graph, { target: invalid });
    await assert.rejects(planExecution(graph, ['target'], backend, api));
  }
  graph.nodes.at(-1).data.packageFields[0].node_id = 'text_node';
  const { api } = mockApi(graph);
  await assert.rejects(planExecution(graph, ['target'], backend, api), /字段与内部节点集合/);
});

test('structural corruption remains an error even in inactive islands', async () => {
  for (const alter of [
    graph => graph.nodes.push(clone(graph.nodes[0])), graph => graph.edges.push(clone(graph.edges[0])),
    graph => { graph.edges[2].source = 'missing'; }, graph => { graph.edges[2].targetField = 'missing'; },
    graph => graph.nodes[2].data.packageFields.push(field('duplicate'), field('duplicate')),
  ]) {
    const graph = fixture(); alter(graph); const { api, calls } = mockApi(graph);
    await assert.rejects(planExecution(graph, ['target'], backend, api)); assert.equal(calls.length, 0);
  }
});

test('active outer cycles fail via existing executionOrder; inactive cycles stay outside projection', async () => {
  const graph = { nodes: [generation('a', { packageFields: [field('input')], editor_outputs: ['out'] }),
    generation('b', { packageFields: [field('input')], editor_outputs: ['out'] }), generation('clean', { editor_outputs: ['out'] })],
    edges: [edge('a-b', 'a', 'b', 'input'), edge('b-a', 'b', 'a', 'input')] };
  const { api } = mockApi(graph, { a: scope('p-a', ['out'], ['input']), b: scope('p-b', ['out'], ['input']), clean: scope('p-clean', ['out']) });
  await assert.rejects(planExecution(graph, ['a'], backend, api), /不能形成循环/);
  const execution = await planExecution(graph, ['clean'], backend, api);
  assert.deepEqual(execution.node_ids, ['clean']);
});

test('builtin/API nodes keep existing outer dependency semantics without package plan calls', async () => {
  const graph = { nodes: [node('text', 'prompt', { text: 'hello', negative: '' }),
    node('built', 'generation', { kind: 'sdxl' }), node('raw', 'generation', { kind: 'api', apiPrompt: { a: {} } })],
    edges: [edge('text-built', 'text', 'built', 'positive')] };
  const { api, calls } = mockApi(graph);
  const execution = await planExecution(graph, new Set(['built', 'raw']), backend, api);
  assert.equal(calls.length, 0);
  assert.deepEqual(execution.packages, {});
  assert.deepEqual(executionOrder(projectExecution(graph, execution, ['built', 'raw']), ['built', 'raw']), ['built', 'raw']);
});

test('inactive media stays in payload values for backend strict boundaries, only active fields are consumed', async () => {
  const graph = fixture(); graph.nodes[1].data.name = 'ready.png';
  const { api } = mockApi(graph), execution = await planExecution(graph, ['target'], backend, api);
  const payload = generationPayload(projectExecution(graph, execution, ['target']), 'target');
  assert.deepEqual(payload.values, { text_a: '当前文本', image_a: 'ready.png', image_b: 'other.png', untouched: 7 });
  assert.deepEqual(payload.output_nodes, ['save_a']);
});

test('64 cached fields remain intact in source and selected fields alone appear in projection', async () => {
  const fields = Array.from({ length: 64 }, (_, index) => field(`f${index}`));
  const graph = { nodes: [generation('many', { packageFields: fields, packageValues: Object.fromEntries(fields.map(item => [item.id, ''])),
    editor_outputs: ['out'] })], edges: [] };
  const { api } = mockApi(graph, { many: scope('p-many', ['out'], ['f0', 'f63']) });
  const execution = await planExecution(graph, ['many'], backend, api);
  assert.equal(graph.nodes[0].data.packageFields.length, 64);
  const projected = projectExecution(graph, execution, ['many']);
  assert.deepEqual(projected.nodes[0].data.packageFields.map(item => item.id), ['f0', 'f63']);
  assert.equal(Object.keys(projected.nodes[0].data.packageValues).length, 64);
  graph.nodes[0].data.packageFields = Array.from({ length: 4097 }, (_, index) => field(`f${index}`));
  await assert.rejects(planExecution(graph, ['many'], backend, api), /缓存字段 ID无效/);
});

test('target lists require existing distinct roots and at least one generation dependency', async () => {
  const graph = fixture(), { api } = mockApi(graph);
  for (const targets of [[], ['missing'], ['target', 'target'], ['text-a'], 'target']) {
    await assert.rejects(planExecution(graph, targets, backend, api));
  }
});

test('root array is frozen across plan awaits and invalid form scalars are never normalized away', async () => {
  const graph = fixture(), targets = ['target'], { api } = mockApi(graph);
  const execution = await planExecution(graph, targets, backend, async (...args) => {
    targets.push('draft-b');
    return api(...args);
  });
  assert.equal(execution.node_ids.includes('draft-b'), false);
  for (const invalid of [undefined, NaN, Infinity, 9007199254740992]) {
    const source = fixture(); source.nodes.at(-1).data.packageValues.untouched = invalid;
    const mock = mockApi(source);
    await assert.rejects(planExecution(source, ['target'], backend, mock.api), /无效 JSON|安全范围/);
    assert.equal(mock.calls.length, 0);
  }
});

test('wired image/video/audio defer stale form names for references and future generation/results only in plan copy', async () => {
  for (const type of ['image', 'video', 'audio']) for (const sourceType of ['reference', 'generation', 'result']) {
    const upstream = generation('upstream', { editor_outputs: ['out'] });
    const source = sourceType === 'generation' ? upstream : node('source', sourceType,
      { mediaType: type, name: 'historical-reference', outputs: [{ type, filename: 'historical-result' }] });
    const target = generation('target', { packageFields: [field('input', type), field('local', type), field('scalar', 'integer')],
      packageValues: { input: 'old-deleted.bin', local: 'local-unchanged.bin', scalar: 0 }, editor_outputs: ['out'] });
    const graph = { nodes: sourceType === 'result' ? [upstream, source, target] : [source, target],
      edges: [edge('media', source.id, 'target', 'input'),
        ...(sourceType === 'result' ? [edge('owner', 'upstream', 'source')] : [])] };
    const before = clone(graph), mocked = mockApi(graph, { target: scope('p-target', ['out'], ['input', 'local', 'scalar']),
      upstream: scope('p-upstream', ['out']) });
    const execution = await planExecution(graph, ['target'], backend, async (path, body) => {
      if (body.request.package_id === 'p-target') {
        assert.equal(body.request.values.input, '', 'defer wired media instead of validating old-deleted.bin');
        assert.equal(body.request.values.local, 'local-unchanged.bin');
        assert.equal(body.request.values.scalar, 0);
      }
      return mocked.api(path, body);
    });
    assert.deepEqual(graph, before);
    assert.equal(projectExecution(graph, execution, ['target']).nodes.at(-1).data.packageValues.input, 'old-deleted.bin');
    if (sourceType === 'reference') {
      const payload = generationPayload(projectExecution(graph, execution, ['target']), 'target');
      assert.equal(payload.values.input, 'historical-reference', 'strict payload uses the actual prepared reference');
    }
  }
});

test('planning deferral does not clear unconnected media or connected non-media/scalar data boundaries', async () => {
  const graph = { nodes: [generation('upstream', { editor_outputs: ['out'] }), generation('target', {
    packageFields: [field('media'), field('mode', 'select'), field('flag', 'boolean'), field('count', 'integer'), field('plain', 'text')],
    packageValues: { media: 'old-deleted.png', mode: 'invalid-choice', flag: false, count: 0, plain: 'preserve', unknown: 'preserve' },
    editor_outputs: ['out'],
  })], edges: [edge('scalar-wire', 'upstream', 'target', 'mode')] };
  const before = clone(graph);
  let calls = 0;
  await assert.rejects(planExecution(graph, ['target'], backend, async (path, body) => {
    calls++;
    assert.equal(path, '/api/execution-plan');
    assert.deepEqual(body.request.values, before.nodes[1].data.packageValues);
    throw new Error('strict planning rejects stale unconnected media and invalid scalar/unknown keys');
  }), /strict planning rejects/);
  assert.equal(calls, 1);
  assert.deepEqual(graph, before);
  graph.edges[0].targetField = 'unknown';
  await assert.rejects(planExecution(graph, ['target'], backend, async () => { calls++; }), /不存在的目标字段/);
  assert.equal(calls, 1, 'unknown target field must not be rewritten into a blank input');
});

test('connected media retains original strict type/path/length checks before planning deferral even when inactive', async () => {
  const invalidValues = [42, null, false, true, [], {}, '../escape.png', 'folder/../../escape.png', './image.png',
    'folder/./image.png', '..\\escape.png', 'folder\\..\\escape.png', '/image.png', '\\image.png',
    'C:/image.png', 'image.png:stream', 'x\0y', 'a'.repeat(1025), '😀'.repeat(1025)];
  for (const type of ['image', 'video', 'audio']) for (const active of [true, false]) for (const invalid of invalidValues) {
    const graph = { nodes: [generation('upstream', { editor_outputs: ['out'] }), generation('target', {
      packageFields: [field('media', type)], packageValues: { media: invalid }, editor_outputs: ['out'],
    })], edges: [edge('wired', 'upstream', 'target', 'media')] };
    const before = clone(graph), mocked = mockApi(graph, { target: scope('p-target', ['out'], active ? ['media'] : []),
      upstream: scope('p-upstream', ['out']) });
    await assert.rejects(planExecution(graph, ['target'], backend, mocked.api), /文本类型或长度|绝对路径或越界路径/);
    assert.equal(mocked.calls.length, 0, `${type}/${active} must reject before the endpoint or upstream is planned`);
    assert.deepEqual(graph, before);
  }
});

test('connected media accepts exactly compatible empty/default and relative names without narrowing Python constraints', async () => {
  const acceptedValues = ['', ' ', 'old-deleted.png', 'subfolder\\中文图片.png', 'subfolder//image.png',
    'folder/', '.hidden-file', 'emoji-😀.png', 'a'.repeat(1024), '😀'.repeat(1024)];
  for (const type of ['image', 'video', 'audio']) for (const value of [...acceptedValues, undefined]) {
    const form = value === undefined ? {} : { media: value };
    const graph = { nodes: [node('reference', 'reference', { mediaType: type, name: '' }), generation('target', {
      packageFields: [field('media', type)], packageValues: form, editor_outputs: ['out'],
    })], edges: [edge('wired', 'reference', 'target', 'media')] };
    const before = clone(graph), mocked = mockApi(graph, { target: scope('p-target', ['out'], ['media']) });
    await planExecution(graph, ['target'], backend, mocked.api);
    assert.equal(mocked.calls[0].request.values.media, '');
    assert.deepEqual(graph, before);
  }
});
