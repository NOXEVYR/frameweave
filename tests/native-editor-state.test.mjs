import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode, parseGraph, serializeGraph, generationPayload, connect } from '../web/graph.mjs';
import { workflowBackendTarget } from '../web/editor-backend-picker.mjs';
import { editorDocument, createNativeWorkflowEditor } from '../web/native-workflow-editor.mjs';
import { editorConnectionSummary, applyEditorInterfaceGraph } from '../web/editor-canvas-interface.mjs';

test('cancelling engine choice leaves shared workflow identity untouched', async () => {
  let forks = 0;
  const node = {data:{editor_id:'shared'}};
  const editor = createNativeWorkflowEditor({api:async()=>({id:'shared'}),
    ensureBackend:async()=>false, ensureInstance:async()=>{forks++;node.data.editor_id='copy';}});
  await editor.open(node);
  assert.equal(forks,0); assert.equal(node.data.editor_id,'shared'); assert.equal(editor.isOpen(),false);
});

test('imported editor backend aliases use the same identity as uploaded media', () => {
  const node = createNode('generation', 0, 0, {kind:'package', package_id:'p-'+'a'.repeat(24),
    editor_backend:'http://localhost:8188', packageFields:[{id:'ref',label:'Reference',type:'image'}],
    packageValues:{ref:'same.png'},packageMediaBackends:{ref:{name:'same.png',backend:'http://127.0.0.1:8188'}}});
  const restored = parseGraph(serializeGraph({nodes:[node],edges:[]}));
  assert.equal(restored.nodes[0].data.editor_backend,'http://127.0.0.1:8188');
  assert.equal(workflowBackendTarget(restored,[node.id],'http://127.0.0.1:8188'),'http://127.0.0.1:8188');
  const ipv6='http://[0:0:0:0:0:0:0:1]:8188';
  node.data.editor_backend=ipv6;node.data.packageMediaBackends.ref.backend=ipv6;
  const v6= parseGraph(serializeGraph({nodes:[node],edges:[]}));
  assert.equal(v6.nodes[0].data.editor_backend,ipv6);
  assert.equal(workflowBackendTarget(v6,[node.id],ipv6),ipv6);
});

test('editor refuses a session switched by another window and closes it', async () => {
  const closed = [];
  const node = {data:{editor_id:'flow'}};
  const editor = createNativeWorkflowEditor({
    ensureBackend:async()=>'http://127.0.0.1:8188', ensureInstance:async()=>{},
    api:async(path,body)=>{
      if(path.endsWith('/session'))return{session_id:'new',backend_url:'http://127.0.0.1:8189'};
      if(path.endsWith('/close')){closed.push(body.session_id);return{};}
      return{id:'flow'};
    }});
  await assert.rejects(editor.open(node), /其他窗口/);
  assert.deepEqual(closed,['new']);assert.equal(editor.isOpen(),false);
});

test('legacy output wires through preview require explicit stable branch migration', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '1'.repeat(24) });
  const preview = createNode('result', 300, 0);
  const target = createNode('generation', 600, 0, { kind: 'package', package_id: 'p-' + '2'.repeat(24), packageFields: [{ id: 'image', label: 'Image', type: 'image' }] });
  const graph = { nodes: [source, preview, target], edges: [] };
  connect(graph, source.id, preview.id);
  // Persisted legacy data predates typed output contracts; new unknown wires
  // are intentionally rejected, but this old wire must still be migratable.
  graph.edges.push({id:'legacy-output-edge',source:preview.id,target:target.id,targetField:'image',outputIndex:3});
  const key = editorConnectionSummary(graph, source.id, [])[0].outputId;
  assert.equal(key, `legacy-${graph.edges[1].id}`);
  const result = { package: { id: source.data.package_id, fields: [] }, values: {}, baseline: {}, backend_url: 'http://127.0.0.1:8188', output_nodes: ['7'], outputs: [{ id: '7', label: 'Final', mediaType: 'image' }] };
  assert.throws(() => applyEditorInterfaceGraph(graph, source.id, result), /输出连线/);
  const updated = applyEditorInterfaceGraph(graph, source.id, { ...result, output_rebindings: { [key]: '7' } });
  assert.equal(updated.edges[1].sourceOutput, '7');
  assert.equal(updated.edges[1].outputIndex, 0);
  assert.equal(graph.edges[1].outputIndex, 3);
  assert.equal(graph.edges[1].sourceOutput, undefined);
});

test('invalid duplicate input remaps do not mutate the existing canvas', () => {
  const a = createNode('prompt', 0, 0), b = createNode('prompt', 0, 200);
  const target = createNode('generation', 400, 0, { kind: 'package', package_id: 'p-' + '2'.repeat(24), packageFields: ['old', 'kept'].map(id => ({ id, label: id, type: 'text' })) });
  const graph = { nodes: [a, b, target], edges: [] };
  connect(graph, a.id, target.id, { targetField: 'old' }); connect(graph, b.id, target.id, { targetField: 'kept' });
  const before = serializeGraph(graph);
  assert.throws(() => applyEditorInterfaceGraph(graph, target.id, { package: { id: target.data.package_id, fields: [{ id: 'kept', label: 'kept', type: 'text' }] }, values: {}, baseline: {}, backend_url: 'http://127.0.0.1:8188', output_nodes: ['7'], outputs: [], rebindings: { old: 'kept' } }), /已有连接/);
  assert.equal(serializeGraph(graph), before);
});

test('native JSON accepts BOM and keeps bypassed nodes and object widgets', () => {
  const document = { version: .4, nodes: [{ id: 1, type: 'Example', mode: 4, widgets_values: { strength: .7 } }], links: [], extra: { custom: ['kept'] } };
  assert.deepEqual(editorDocument('\uFEFF' + JSON.stringify(document)), document);
  assert.equal(editorDocument('{"prompt":{}}'), null);
});

test('native document parsing rejects duplicate keys and unsafe integers through the shared JSON guard', () => {
  assert.throws(() => editorDocument('{"nodes":[],"nodes":[{"PRIVATE":"content"}]}'), /重复/);
  assert.throws(() => editorDocument('{"nodes":[],"\\u006eodes":[]}'), /重复/);
  assert.throws(() => editorDocument('{"nodes":[{"id":1,"widgets_values":[9007199254740993]}]}'), /整数|精度|安全/);
});

test('canvas keeps native controls, internal baseline and stable output identity', () => {
  const source = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '1'.repeat(24), editor_id: 'e-' + '2'.repeat(24),
    editor_backend: 'http://127.0.0.1:8188', packageFields: [], packageValues: {},
    editor_controls: [{ node_id: '1', input: 'clip_name', widget_node_id: '1', widget_name: 'clip_name' }],
    editor_baseline: { model: 'encoder-a' }, editor_outputs: ['7'], editor_output_fields: [{ id: '7', label: 'Final', mediaType: 'image' }] });
  const target = createNode('generation', 440, 0, { kind: 'package', package_id: 'p-' + '3'.repeat(24),
    packageFields: [{ id: 'reference', label: 'Reference', type: 'image' }], packageValues: {} });
  const graph = { nodes: [source, target], edges: [] };
  connect(graph, source.id, target.id, { targetField: 'reference', sourceField: 'image', outputIndex: 1, sourceOutput: '7' });
  const restored = parseGraph(serializeGraph(graph));
  assert.deepEqual(restored.nodes[0].data.editor_controls, source.data.editor_controls);
  assert.deepEqual(restored.nodes[0].data.editor_baseline, { model: 'encoder-a' });
  assert.equal(restored.edges[0].sourceOutput, '7');
  assert.deepEqual(generationPayload(restored, source.id).output_nodes, ['7']);
  assert.equal(generationPayload(restored, source.id).editor_backend, 'http://127.0.0.1:8188');
});

test('rebindings migrate image ownership only with the same filename and media type', () => {
  const backend = 'http://127.0.0.1:8188', nextBackend = 'http://127.0.0.1:8189';
  const node = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '4'.repeat(24),
    editor_backend: backend,
    packageFields: [
      { id: 'oldImage', label: '旧图片', type: 'image' },
      { id: 'changedType', label: '旧图像类型', type: 'image' },
      { id: 'removed', label: '已移除', type: 'image' },
    ],
    packageValues: { oldImage: 'same.png', changedType: 'type.png', removed: 'removed.png' },
    packageMediaBackends: {
      oldImage: { name: 'same.png', backend },
      changedType: { name: 'type.png', backend },
      removed: { name: 'removed.png', backend },
    } });
  const updated = applyEditorInterfaceGraph({ nodes: [node], edges: [] }, node.id, {
    package: { id: node.data.package_id, fields: [
      { id: 'newImage', label: '新图片', type: 'image' },
      { id: 'newAudio', label: '新音频', type: 'audio' },
    ] },
    values: { newImage: 'same.png', newAudio: 'type.png' }, baseline: {}, backend_url: nextBackend,
    output_nodes: [], outputs: [], rebindings: { oldImage: 'newImage', changedType: 'newAudio', removed: null },
  });
  assert.deepEqual(updated.nodes[0].data.packageMediaBackends, { newImage: { name: 'same.png', backend } });
  assert.throws(() => workflowBackendTarget(updated, [node.id], nextBackend), /请在目标引擎中重新上传/);
});

test('upload previews survive unchanged interface application but are removed on rebind, value or engine changes', () => {
  const backend = 'http://127.0.0.1:8188', preview_url = `/api/media/${'a'.repeat(32)}`;
  const field = { id: 'image', label: 'Image', type: 'image' };
  const node = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '4'.repeat(24),
    editor_backend: backend, packageFields: [field], packageValues: { image: 'same.png' },
    packageMediaBackends: { image: { name: 'same.png', backend, preview_url } } });
  const result = { package: { id: node.data.package_id, fields: [field] }, values: { image: 'same.png' },
    baseline: {}, backend_url: backend, output_nodes: [], outputs: [] };
  const apply = options => applyEditorInterfaceGraph({ nodes: [node], edges: [] }, node.id, { ...result, ...options }).nodes[0].data;
  assert.equal(apply({}).packageMediaBackends.image.preview_url, preview_url);
  assert.equal(apply({ backend_url: 'http://127.0.0.1:8189' }).packageMediaBackends.image.preview_url, undefined);
  assert.deepEqual(apply({ values: { image: 'changed.png' } }).packageMediaBackends, {});
  assert.deepEqual(apply({ invalidated_media_fields: ['image'] }).packageMediaBackends, {});
  assert.deepEqual(apply({ package: { id: node.data.package_id, fields: [{ ...field, id: 'newImage' }] },
    values: { newImage: 'same.png' }, rebindings: { image: 'newImage' }, invalidated_media_fields: ['image'] }).packageMediaBackends, {});
  assert.equal(apply({ package: { id: node.data.package_id, fields: [{ ...field, id: 'newImage' }] },
    values: { newImage: 'same.png' }, rebindings: { image: 'newImage' } }).packageMediaBackends.newImage.preview_url, undefined);
});

test('legacy unowned media keeps its old engine and the execution guard rejects it after interface reapply', () => {
  const oldBackend = 'http://127.0.0.1:8188', newBackend = 'http://127.0.0.1:8189';
  const node = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '5'.repeat(24),
    editor_backend: oldBackend, packageFields: [{ id: 'oldRef', label: '旧参考图', type: 'image' }],
    packageValues: { oldRef: 'legacy.png' } });
  const updated = applyEditorInterfaceGraph({ nodes: [node], edges: [] }, node.id, {
    package: { id: node.data.package_id, fields: [{ id: 'newRef', label: '新参考图', type: 'image' }] },
    values: { newRef: 'legacy.png' }, baseline: {}, backend_url: newBackend,
    output_nodes: [], outputs: [], rebindings: { oldRef: 'newRef' },
  });
  assert.deepEqual(updated.nodes[0].data.packageMediaBackends, {
    newRef: { name: 'legacy.png', backend: oldBackend },
  });
  assert.throws(() => workflowBackendTarget(updated, [node.id], newBackend), /请在目标引擎中重新上传/);
});

test('audio ownership follows an unchanged audio field and obsolete or renamed media owners are discarded', () => {
  const backend = 'http://127.0.0.1:8188';
  const node = createNode('generation', 0, 0, { kind: 'package', package_id: 'p-' + '6'.repeat(24),
    editor_backend: backend,
    packageFields: [
      { id: 'oldAudio', label: '旧音频', type: 'audio' },
      { id: 'oldImage', label: '旧图片', type: 'image' },
      { id: 'unused', label: '未使用', type: 'audio' },
    ],
    packageValues: { oldAudio: 'voice.wav', oldImage: 'before.png', unused: 'unused.wav' },
    packageMediaBackends: {
      oldAudio: { name: 'voice.wav', backend },
      oldImage: { name: 'before.png', backend },
      unused: { name: 'unused.wav', backend },
    } });
  const updated = applyEditorInterfaceGraph({ nodes: [node], edges: [] }, node.id, {
    package: { id: node.data.package_id, fields: [
      { id: 'newAudio', label: '新音频', type: 'audio' },
      { id: 'newImage', label: '新图片', type: 'image' },
    ] },
    values: { newAudio: 'voice.wav', newImage: 'after.png' }, baseline: {}, backend_url: backend,
    output_nodes: [], outputs: [], rebindings: { oldAudio: 'newAudio', oldImage: 'newImage', unused: null },
  });
  assert.deepEqual(updated.nodes[0].data.packageMediaBackends, { newAudio: { name: 'voice.wav', backend } });
  assert.equal(workflowBackendTarget(updated, [node.id], backend), backend);
});
