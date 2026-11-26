import test from 'node:test';
import assert from 'node:assert/strict';
import { configureWorkflowInterface } from '../web/workflow-interface-controller.mjs';
import { createEditorSessionProjection } from '../web/editor-session-projection.mjs';
import { fixture } from './helpers/native-input-contracts-harness.mjs';


test('formal compiler observes a callback-created arbitrary name and carries exact target type/source outside prompt', async () => {
  const h = await fixture();
  const reply = await h.request('compile'); assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result.additional_inputs, { version: 1, nodes: { 2: { class_type: 'GenericDynamic',
    inputs: { 'branch-z': { type: 'STRING', accept: 'link', source: ['1', 0] } } } } });
  const proof = reply.result.native_input_observations.nodes['2'];
  assert.deepEqual(proof.instance_path, ['2']); assert.equal(proof.inputs['branch-z'].link_id, 10);
  assert.equal(proof.inputs['branch-z'].workflow_slot_index, 0);
  assert.equal(reply.result.output.additional_inputs, undefined); assert.deepEqual(reply.result.opaque_inputs, []);
  assert.equal(JSON.stringify(reply.result.additional_inputs).includes('fixture'), false);
});

for (const type of ['IMAGE,MASK', '*']) test(`target ${type} stays a union/wildcard without inferring from STRING source`, async () => {
  const h = await fixture(); h.target.inputs[0].type = type;
  const reply = await h.request('compile'); assert.equal(reply.result.additional_inputs.nodes['2'].inputs['branch-z'].type, type);
});

test('count-like scalar changes never synthesize names absent from actual slots', async () => {
  const h = await fixture(); h.target.widgets[0].value = 6;
  const reply = await h.request('compile');
  assert.deepEqual(Object.keys(reply.result.additional_inputs.nodes['2'].inputs), ['branch-z']);
  assert.equal(reply.result.output['2'].inputs.width, 6);
});

for (const [label, mutate] of [
  ['same ID target', h => { h.inside.nodes[1] = Object.assign(new h.GenericDynamic(), { ...h.target }); }],
  ['same ID port', h => { h.target.inputs[0] = { ...h.target.inputs[0] }; }],
  ['target type', h => { h.target.inputs[0].type = 'IMAGE'; }],
  ['target link', h => { h.inside.links.set(10, { ...h.link }); }],
  ['source output', h => { h.source.outputs[0] = { ...h.source.outputs[0] }; }],
  ['schema content', h => { h.GenericDynamic.nodeData.input.required.width[1] = { min: 2 }; }],
  ['driver scalar', h => { h.target.widgets[0].value = 3; }],
  ['remove add lifecycle', h => { h.target.onRemoved(); h.target.onAdded(); }],
]) test(`async compile ${label} mutation cannot authorize a dynamic link`, async () => {
  const h = await fixture(); h.hooks.compile = () => mutate(h);
  const reply = await h.request('compile'); assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result.additional_inputs.nodes, {});
  assert.equal(reply.result.opaque_inputs.length, 1);
  assert.deepEqual(reply.result.output['2'].inputs['branch-z'], ['1', 0], 'opaque data remains present');
});

test('root replacement during compile fails before returning an applicable observation', async () => {
  const h = await fixture(); h.hooks.compile = () => h.replaceRoot();
  const reply = await h.request('compile'); assert.match(reply.error, /实例已变化/); assert.equal(reply.result, undefined);
});

test('a getter hook changing a proved target during the final observation read retires the sidecar', async () => {
  const h = await fixture(); let reads = 0;
  Object.defineProperty(h.source.outputs[0], 'name', { enumerable: true, get() {
    if (++reads === 5) h.target.inputs[0] = { ...h.target.inputs[0] };
    return 'text';
  } });
  const reply = await h.request('compile'); assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result.additional_inputs.nodes, {});
  assert.equal(reply.result.opaque_inputs[0].reason, 'native_instance_changed_during_observation');
});

for (const [label, mutate] of [
  ['duplicate target name', h => h.target.inputs.push({ ...h.target.inputs[0] })],
  ['opaque target type', h => { h.target.inputs[0].type = ['STRING']; }],
  ['promoted IO route', h => { h.link.originIsIoNode = true; }],
  ['reroute execution source', h => { h.link.origin_id = 99; }],
]) test(`${label} remains opaque without inventing a mapping`, async () => {
  const h = await fixture(); mutate(h);
  const reply = await h.request('compile'); assert.equal(reply.error, undefined);
  assert.deepEqual(reply.result.additional_inputs.nodes, {}); assert.equal(reply.result.opaque_inputs.length, 1);
});

test('tampered official workflow slot/type/endpoints are rejected independently of live graph', async () => {
  const h = await fixture(); h.hooks.compiled = compiled => { compiled.workflow.links[0][4] = 8; };
  const reply = await h.request('compile'); assert.deepEqual(reply.result.additional_inputs.nodes, {});
  assert.equal(reply.result.opaque_inputs[0].reason, 'compiled_workflow_link_mapping_unproven');
});

test('official workflow may compress widget slots while keeping exact linked-port mapping', async () => {
  const h = await fixture(); h.target.inputs.unshift({ name: 'width', type: 'INT', link: null, widget: { name: 'width' } }); h.link.target_slot = 1;
  h.hooks.compiled = compiled => { compiled.workflow.nodes[1].inputs.shift(); compiled.workflow.links[0][4] = 0; };
  const reply = await h.request('compile'); assert.equal(reply.error, undefined);
  const observed = reply.result.native_input_observations.nodes['2'].inputs['branch-z'];
  assert.equal(observed.native_slot_index, 1); assert.equal(observed.workflow_slot_index, 0);
  assert.equal(reply.result.additional_inputs.nodes['2'].inputs['branch-z'].type, 'STRING');
});

test('shared subgraph instances receive independent accurate execution paths', async () => {
  const h = await fixture({ nested: true, shared: true }), reply = await h.request('compile'); assert.equal(reply.error, undefined);
  assert.deepEqual(Object.keys(reply.result.additional_inputs.nodes), ['6:2', '7:2']);
  assert.deepEqual(reply.result.additional_inputs.nodes['6:2'].inputs['branch-z'].source, ['6:1', 0]);
  assert.deepEqual(reply.result.additional_inputs.nodes['7:2'].inputs['branch-z'].source, ['7:1', 0]);
  assert.deepEqual(reply.result.native_input_observations.nodes['7:2'].instance_path, ['7', '2']);
});

test('equal shared leaf objects do not prove a source from another subgraph instance', async () => {
  const h = await fixture({ nested: true, shared: true });
  h.hooks.compiled = compiled => { compiled.output['6:2'].inputs['branch-z'] = ['7:1', 0]; };
  const reply = await h.request('compile'); assert.equal(reply.result.additional_inputs.nodes['6:2'], undefined);
  assert.ok(reply.result.additional_inputs.nodes['7:2']);
  assert.equal(reply.result.opaque_inputs[0].reason, 'native_source_execution_mapping_unproven');
});

test('recompilation and explicit reload rebuild bounded data observations without receipts', async () => {
  const h = await fixture(); const first = (await h.request('compile')).result;
  await h.request('load', { document: h.serialize() }); const second = (await h.request('compile')).result;
  assert.deepEqual(second.additional_inputs, first.additional_inputs);
  assert.deepEqual(second.native_input_observations, first.native_input_observations);
  assert.equal(JSON.stringify(second.native_input_observations).includes('receipt'), false);
});

test('controller carries compiled workflow and bounded observations through inspect and conflict retry apply', async () => {
  const h = await fixture(), compiled = (await h.request('compile')).result, calls = [];
  let applies = 0;
  const dependencies = { toast() {}, chooseEditorInterface: async () => ({ fields: [], output_nodes: ['2'], rebindings: {} }),
    autoEditorInterfaceSelection: () => null, resolveEditorConflicts: async () => ({}),
    completeInterfaceInputs: async (info, selection) => ({ info, selection, missing_values: {} }),
    async api(path, payload) {
      calls.push({ path, payload: structuredClone(payload) });
      if (path.endsWith('/interface')) return { fields: [], outputs: [{ id: '2' }] };
      if (++applies === 1) return { requires_resolution: true, changes: { conflicts: [] } };
      return { package: { id: 'pack' }, readiness: { issues: [] } };
    } };
  await configureWorkflowInterface(dependencies, { editor_id: 'flow', packageValues: {}, editor_baseline: {} },
    { compiled, session: { session_id: 'current', base_revision: 8 }, assertCurrent() {} });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.deepEqual(call.payload.additional_inputs, compiled.additional_inputs);
    assert.deepEqual(call.payload.native_input_observations, compiled.native_input_observations);
    assert.deepEqual(call.payload.document, compiled.workflow);
    assert.equal(call.payload.base_revision, 8); assert.equal(call.payload.session_id, 'current');
    assert.equal(call.payload.prompt.additional_inputs, undefined);
  }
});

test('projection refuses a sidecar-only change between clean compile and matched snapshot', async () => {
  const h = await fixture(); let compilations = 0, saves = 0;
  const projection = createEditorSessionProjection({ assertCurrent() {}, request: async (action, data) => {
    const reply = await h.request(action, data); if (reply.error) throw new Error(reply.error);
    if (action === 'compile' && ++compilations === 3) reply.result.additional_inputs.nodes['2'].inputs['branch-z'].type = 'IMAGE';
    return reply.result;
  } });
  await projection.initialize();
  await assert.rejects(projection.prepare(() => { saves++; }), /快照与编译图不一致/);
  assert.equal(saves, 0);
});
