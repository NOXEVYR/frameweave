import test from 'node:test';
import assert from 'node:assert/strict';
import { runBackend, workflowBackendTarget, chooseWorkflowBackend } from '../web/editor-backend-picker.mjs';
import { createNode, connect } from '../web/graph.mjs';

test('bound workflow selects its remembered engine independently of the current one', async () => {
  const report = {current:'http://127.0.0.1:8189',candidates:[{base_url:'http://127.0.0.1:8188',online:true,score:.9}]};
  assert.equal(await chooseWorkflowBackend(report,'http://127.0.0.1:8188'),'http://127.0.0.1:8188');
});
test('execution includes upstream bindings and refuses incompatible multi-engine chains', () => {
  const a=createNode('generation',0,0,{editor_backend:'http://127.0.0.1:8188'});
  const b=createNode('generation',400,0,{editor_backend:'http://127.0.0.1:8189'});
  const graph={nodes:[a,b],edges:[]};
  assert.equal(runBackend(graph,[a.id]),a.data.editor_backend);
  assert.throws(()=>runBackend(graph,[a.id,b.id]),/多个推理引擎/);
  delete b.data.editor_backend;graph.edges.push({id:'edge',source:a.id,target:b.id});
  assert.equal(runBackend(graph,[b.id]),a.data.editor_backend);
});

test('backend preparation refuses switching when a required reference belongs to another engine', () => {
  const generation = createNode('generation', 300, 0, { editor_backend: 'http://127.0.0.1:8188' });
  const reference = createNode('reference', 0, 0, { name: 'portrait.png', uploadBackend: 'http://127.0.0.1:8189' });
  const graph = { nodes: [generation, reference], edges: [] };
  connect(graph, reference.id, generation.id);
  assert.throws(() => workflowBackendTarget(graph, [generation.id], 'http://127.0.0.1:8189'), /请在目标引擎中重新上传/);
  assert.throws(() => workflowBackendTarget(graph, [generation.id], 'http://127.0.0.1:8188'), /请在目标引擎中重新上传/);
  reference.data.uploadBackend = 'http://127.0.0.1:8188';
  assert.equal(workflowBackendTarget(graph, [generation.id], 'http://127.0.0.1:8189'), 'http://127.0.0.1:8188');
});

test('backend preparation ignores unrelated references and blocks legacy unowned input on automatic switch', () => {
  const generation = createNode('generation', 300, 0, { editor_backend: 'http://127.0.0.1:8188' });
  const required = createNode('reference', 0, 0, { name: 'legacy.png' });
  const unrelated = createNode('reference', 0, 400, { name: 'other.png', uploadBackend: 'http://127.0.0.1:8189' });
  const graph = { nodes: [generation, required, unrelated], edges: [] };
  connect(graph, required.id, generation.id);
  assert.throws(() => workflowBackendTarget(graph, [generation.id], 'http://127.0.0.1:8189'), /没有上传引擎记录/);
  assert.equal(workflowBackendTarget(graph, [generation.id], 'http://127.0.0.1:8188'), 'http://127.0.0.1:8188');
});
