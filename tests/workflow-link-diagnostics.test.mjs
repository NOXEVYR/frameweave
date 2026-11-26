import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectWorkflowLinks } from '../web/workflow-link-diagnostics.mjs';

const copy = value => structuredClone(value);
const source = (id = 1, links = [7]) => ({ id, inputs: [], outputs: [{ links }] });
const target = (id = 2, link = 7) => ({ id, inputs: [{ link }], outputs: [] });
const tuple = (id = 7, from = 1, to = 2) => [id, from, 0, to, 0, 'IMAGE'];
const modern = (id = 7, from = 1, to = 2) => ({ id, origin_id: from, origin_slot: 0, target_id: to, target_slot: 0, type: 'IMAGE' });
const workflow = () => ({ version: 0.4, nodes: [source(), target()], links: [tuple()] });
const codes = report => report.issues.map(issue => issue.code);
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };

test('valid six-tuples inspect completely without changing frozen input or including content', () => {
  const document = workflow(); document.nodes[0].title = 'PRIVATE TITLE';
  document.nodes[0].widgets_values = ['PRIVATE PROMPT']; document.extra = { filename: 'PRIVATE FILE' };
  const before = copy(document); freeze(document);
  assert.deepEqual(inspectWorkflowLinks(document), { version: 1, coverage: 'complete',
    totals: { graphs: 1, nodes: 2, links: 1, issues: 0 }, issues: [], incomplete_reasons: [] });
  assert.deepEqual(document, before);
});

test('Goldfish-shaped disconnected target is generic and leaves the original reference null', () => {
  const document = { nodes: [source(142, [207]), { id: 108, inputs: Array.from({ length: 11 }, () => ({ link: null })) }],
    links: [[207, 142, 0, 108, 10, 'IMAGE']] };
  const before = copy(document), report = inspectWorkflowLinks(document);
  assert.deepEqual(codes(report), ['target_reference_mismatch']);
  assert.deepEqual(report.issues[0], { code: 'target_reference_mismatch', severity: 'warning', graph: 'root',
    node_id: '108', link_id: '207', slot: 10, direction: 'input', message: '全局链路与目标槽位的链路引用不一致。' });
  assert.deepEqual(document, before);
});

test('mixed link representations and scoped IDs support modern subgraph virtual IO', () => {
  const document = workflow(); document.links = [modern()];
  document.definitions = { subgraphs: [{ id: 'private graph name', nodes: [target(2, 7), source(1, [8])],
    inputs: [{ linkIds: [7] }], outputs: [{ linkIds: [8] }],
    inputNode: { id: -10 }, outputNode: { id: -20 }, links: [modern(7, -10, 2), tuple(8, 1, -20)] }] };
  const report = inspectWorkflowLinks(document);
  assert.equal(report.coverage, 'complete'); assert.deepEqual(report.issues, []);
  assert.deepEqual(report.totals, { graphs: 2, nodes: 4, links: 3, issues: 0 });
});

test('subgraph IO reciprocity, local endpoint and single-route input checks are symmetric', () => {
  const document = { nodes: [], links: [], definitions: { subgraphs: [{ nodes: [source(1, [7, 8])],
    inputs: [], outputs: [{ linkIds: [99, 8] }], links: [modern(7, 1, -20), modern(8, 1, -20)] }] } };
  const report = inspectWorkflowLinks(document);
  assert.deepEqual(codes(report), ['target_reference_mismatch', 'multiple_input_routes', 'missing_local_link']);
  assert.ok(report.issues.every(issue => issue.graph === 'subgraph-1'));
});

test('floating links have independent IDs and never require regular slot reciprocity or reroute node endpoints', () => {
  const document = workflow();
  document.floatingLinks = [
    { ...modern(7, -1, 2), origin_slot: -1, parentId: 999 },
    { ...modern(8, 1, -1), target_slot: -1, parentId: 888 },
  ];
  document.reroutes = [{ id: 888, parentId: 999, linkIds: [7], floating: { slotType: 'output' } }];
  document.extra = { reroutes: [{ id: 999 }], linkExtensions: [{ id: 7, parentId: 999 }] };
  const report = inspectWorkflowLinks(document);
  assert.equal(report.coverage, 'complete'); assert.deepEqual(report.issues, []); assert.equal(report.totals.links, 3);
});

test('malformed floating links report endpoint problems and invalid floating form', () => {
  const document = workflow(); document.floatingLinks = [{ ...modern(9, -1, 2), origin_slot: 0 }, modern(10)];
  const report = inspectWorkflowLinks(document);
  assert.equal(codes(report).filter(code => code === 'malformed_floating_link').length, 2);
  assert.ok(codes(report).includes('missing_endpoint'));
});

test('legacy groupNodes internal four-tuples are explicitly unchecked', () => {
  const document = workflow(); document.extra = { groupNodes: { 'PRIVATE': { nodes: [source()], links: [[0, 0, 1, 0]] } } };
  const report = inspectWorkflowLinks(document);
  assert.equal(report.coverage, 'partial'); assert.deepEqual(codes(report), ['legacy_group_nodes_unchecked']);
  assert.deepEqual(report.incomplete_reasons, ['legacy_group_nodes_unchecked']);
  assert.equal(report.totals.links, 1); assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('root node zero, string node IDs and null optional local links remain valid', () => {
  const document = { nodes: [source(0, [7]), target('zero', 7)], links: [tuple(7, 0, 'zero')] };
  assert.equal(inspectWorkflowLinks(document).totals.issues, 0);
  assert.equal(inspectWorkflowLinks({ nodes: [{ id: 0, inputs: [{ link: null }], outputs: [{ links: null }] }] }).totals.issues, 0);
});

test('official string slot indices normalize for tuples, objects, local references and floating endpoints', () => {
  for (const link of [[7, 1, '0', 2, '0', 'IMAGE'], { ...modern(), origin_slot: '0', target_slot: '0' }]) {
    const document = workflow(); document.links = [link];
    document.floatingLinks = [{ ...modern(9, -1, 2), origin_slot: '-1', target_slot: '0' }];
    const before = copy(document), report = inspectWorkflowLinks(document);
    assert.equal(report.coverage, 'complete'); assert.deepEqual(report.issues, []); assert.deepEqual(document, before);
  }
  const invalid = workflow(); invalid.links[0][2] = 'not-a-slot';
  assert.ok(codes(inspectWorkflowLinks(invalid)).includes('invalid_slot'));
});

test('number/string ID collisions and duplicate local IDs are diagnosed', () => {
  const document = workflow(); document.nodes.push(source('1'));
  document.links.push(tuple('7')); document.nodes[0].outputs[0].links.push('7');
  assert.deepEqual(codes(inspectWorkflowLinks(document)), ['duplicate_local_link', 'duplicate_node_id', 'duplicate_link_id']);
});

test('missing endpoints, invalid slots and stale local references have concrete diagnostic codes', () => {
  const document = { nodes: [source(1, [7, 9]), target(2, 8)],
    links: [tuple(7, 99, 2), { ...modern(8, 1, 2), target_slot: 5 }] };
  const report = inspectWorkflowLinks(document);
  for (const code of ['missing_endpoint', 'invalid_slot', 'target_reference_mismatch', 'source_reference_mismatch',
    'missing_local_link', 'local_endpoint_mismatch']) assert.ok(codes(report).includes(code), code);
});

test('multiple global routes into a normal input are detected once per slot', () => {
  const document = workflow(); document.nodes[0].outputs[0].links = [7, 8, 9]; document.links.push(tuple(8), tuple(9));
  const report = inspectWorkflowLinks(document);
  assert.equal(codes(report).filter(code => code === 'multiple_input_routes').length, 1);
});

test('unknown graph, link, slot and definition shapes report partial coverage', () => {
  for (const document of [null, { nodes: {} }, { nodes: [], links: {} }, { nodes: [], links: [[0, 0, 1, 0]] },
    { nodes: [{ id: 1, inputs: 'private' }] }, { nodes: [], definitions: [] }, { nodes: [], definitions: {} },
    { nodes: [], links: [{ id: 1 }] }]) {
    const report = inspectWorkflowLinks(document);
    assert.equal(report.coverage, 'partial'); assert.ok(report.incomplete_reasons.includes('unknown_shape'));
  }
});

test('schema-optional port metadata is incomplete evidence, not a proven broken link', () => {
  for (const mode of ['arrays', 'refs']) {
    const document = workflow();
    if (mode === 'arrays') { delete document.nodes[0].outputs; delete document.nodes[1].inputs; }
    else { delete document.nodes[0].outputs[0].links; delete document.nodes[1].inputs[0].link; }
    const report = inspectWorkflowLinks(document);
    assert.equal(report.coverage, 'partial');
    assert.deepEqual(codes(report), ['port_metadata_unavailable', 'port_metadata_unavailable']);
    assert.deepEqual(report.incomplete_reasons, ['port_metadata_unavailable']);
  }
  const explicit = workflow(); explicit.nodes[0].outputs[0].links = null; explicit.nodes[1].inputs[0].link = null;
  assert.deepEqual(codes(inspectWorkflowLinks(explicit)), ['source_reference_mismatch', 'target_reference_mismatch']);
  explicit.nodes[0].outputs = []; explicit.nodes[1].inputs = [];
  assert.deepEqual(codes(inspectWorkflowLinks(explicit)), ['invalid_slot', 'invalid_slot']);
});

test('malicious and oversized IDs are replaced by bounded opaque IDs', () => {
  const secret = '<script>PRIVATE prompt</script>' + 'x'.repeat(100000);
  const document = { nodes: [source(secret, [secret]), target(2, secret)], links: [tuple(secret, secret, 999)] };
  const report = inspectWorkflowLinks(document), encoded = JSON.stringify(report);
  assert.ok(!encoded.includes('PRIVATE')); assert.ok(!encoded.includes('<script>'));
  for (const issue of report.issues) for (const field of ['node_id', 'link_id', 'graph']) {
    if (issue[field] !== undefined) assert.match(issue[field], /^[A-Za-z0-9_.:-]{1,64}$/);
  }
  assert.deepEqual(report, inspectWorkflowLinks(document));
});

test('invalid IDs and unsafe slot values never enter the report', () => {
  const document = { nodes: [{ id: {} }], links: [tuple({}, {}, 2), { ...modern(), origin_slot: 'PRIVATE' }] };
  const report = inspectWorkflowLinks(document);
  assert.ok(codes(report).includes('invalid_node_id')); assert.ok(codes(report).includes('invalid_link_id'));
  assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});

test('traversal limits are explicit partial coverage and only clamp downward', () => {
  for (const [limits, reason] of [[{ nodes: 1 }, 'node_limit'], [{ links: 0 }, 'link_limit'],
    [{ structuralItems: 2 }, 'structural_item_limit']]) {
    const report = inspectWorkflowLinks(workflow(), { limits });
    assert.equal(report.coverage, 'partial'); assert.ok(report.incomplete_reasons.includes(reason));
  }
  const document = { nodes: [], definitions: { subgraphs: [{ nodes: [] }] } };
  const report = inspectWorkflowLinks(document, { limits: { depth: 0 } });
  assert.deepEqual(report.incomplete_reasons, ['depth_limit']); assert.equal(report.totals.graphs, 1);
  const many = { nodes: Array.from({ length: 10001 }, (_, id) => ({ id })) };
  const capped = inspectWorkflowLinks(many, { limits: { nodes: 20000 } });
  assert.equal(capped.totals.nodes, 10000); assert.deepEqual(capped.incomplete_reasons, ['node_limit']);
});

test('issue and byte limits cap output while preserving detected issue count', () => {
  const document = { nodes: [], links: Array.from({ length: 1000 }, (_, id) => tuple(id, id + 1, id + 2)) };
  const report = inspectWorkflowLinks(document);
  assert.equal(report.issues.length, 200); assert.equal(report.totals.issues, 2000);
  assert.deepEqual(report.incomplete_reasons, ['issue_limit']);
  assert.ok(new TextEncoder().encode(JSON.stringify(report)).length < 131072);
  const fewer = inspectWorkflowLinks(document, { limits: { issues: 1 } });
  assert.equal(fewer.issues.length, 1); assert.equal(fewer.totals.issues, 2000);
  const bytes = inspectWorkflowLinks(document, { limits: { reportBytes: 3000 } });
  assert.ok(bytes.incomplete_reasons.includes('report_byte_limit'));
  assert.ok(new TextEncoder().encode(JSON.stringify(bytes)).length <= 3000);
});

test('byte budgets smaller than the report envelope reject explicitly even for empty graphs', () => {
  for (const reportBytes of [0, 100, 2047]) {
    assert.throws(() => inspectWorkflowLinks({ nodes: [], links: [] }, { limits: { reportBytes } }), /at least 2048/);
  }
  const report = inspectWorkflowLinks({ nodes: [], links: [] }, { limits: { reportBytes: 2048 } });
  assert.ok(new TextEncoder().encode(JSON.stringify(report)).length <= 2048);
});

test('nested definitions and repeated graph objects terminate deterministically', () => {
  const document = { nodes: [], definitions: { subgraphs: [] } }; document.definitions.subgraphs.push(document);
  const report = inspectWorkflowLinks(document);
  assert.equal(report.totals.graphs, 1); assert.deepEqual(report.incomplete_reasons, ['repeated_graph_object']);
  let deep = { nodes: [] }; for (let i = 0; i < 100; i++) deep = { nodes: [], definitions: { subgraphs: [deep] } };
  const depth = inspectWorkflowLinks(deep);
  assert.equal(depth.totals.graphs, 81); assert.deepEqual(depth.incomplete_reasons, ['depth_limit']);
});

test('widgets, prompt data and arbitrary properties are never inspected', () => {
  const document = workflow();
  Object.defineProperty(document.nodes[0], 'widgets_values', { get() { throw new Error('private getter'); } });
  Object.defineProperty(document.nodes[0], 'properties', { get() { throw new Error('private getter'); } });
  assert.deepEqual(inspectWorkflowLinks(document).issues, []);
});
