import test from 'node:test';
import assert from 'node:assert/strict';
import { packageNodePresentation } from '../web/package-node-presentation.mjs';

test('package overview counts the complete interface and distinguishes selected from default outputs', () => {
  const node = { data: { packageFields: [{ id: 'stale' }], editor_outputs: ['save-a'], editor_output_fields: [{ id: 'save-a' }, { id: 'save-b' }] } };
  const pack = { name: '双分支图片与音频工作流', fields: [{ id: 'image' }, { id: 'audio' }, { id: 'steps' }] };
  const original = structuredClone({ node, pack });
  const view = packageNodePresentation(node, pack);
  assert.equal(view.name, pack.name); assert.equal(view.inputs, '3 个输入参数'); assert.equal(view.outputs, '已选 1 个输出');
  assert.match(view.hint, /右侧调整参数/); assert.deepEqual({ node, pack }, original);
  delete node.data.editor_outputs; assert.equal(packageNodePresentation(node, pack).outputs, '全部 2 个输出');
  delete node.data.editor_output_fields; assert.equal(packageNodePresentation(node, pack).outputs, '全部输出');
});

test('unprepared nodes retain preparation guidance and explicit empty selections remain visible', () => {
  const node = { data: { editor_id: 'native', packageFields: [] } };
  const native = packageNodePresentation(node, null);
  assert.equal(native.name, '原生工作流 · 待准备'); assert.match(native.hint, /提取外层参数/);
  delete node.data.editor_id; delete node.data.packageFields;
  const missing = packageNodePresentation(node, null);
  assert.equal(missing.inputs, '输入参数待准备'); assert.match(missing.hint, /导入工作流包/);
  node.data.editor_outputs = [];
  assert.equal(packageNodePresentation(node, null).outputs, '未选择输出');
});
