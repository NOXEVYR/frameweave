import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedPackageField, visibleInputPorts, outputChoices, portExpansionPositions } from '../web/canvas-port-layout.mjs';
import { createNode, connect, parseGraph, serializeGraph, generationInputPorts } from '../web/graph.mjs';

test('port growth displaces only the local collision chain, independent of selection and graph order', () => {
  const rectangles = [
    { id: 'next', x: 400, y: 973, width: 286, height: 299 },
    { id: 'source', x: 30, y: 80, width: 286, height: 299 },
    { id: 'target', x: 400, y: 80, width: 304, height: 557 },
    { id: 'below', x: 400, y: 673, width: 286, height: 299, selected: true },
    { id: 'far', x: 400, y: 2000, width: 286, height: 299 },
    { id: 'above', x: 400, y: -400, width: 286, height: 299 },
  ];
  const original = structuredClone(rectangles);
  assert.deepEqual(portExpansionPositions(rectangles, 'target', 619), [
    { id: 'below', x: 400, y: 735 }, { id: 'next', x: 400, y: 1070 },
  ]);
  assert.deepEqual(rectangles, original);
  assert.deepEqual(portExpansionPositions(rectangles, 'target', 557), []);
  assert.deepEqual(portExpansionPositions(rectangles, 'target', 400), []);
});

test('growth closes newly insufficient gaps and follows horizontally staggered neighbours', () => {
  const rectangles = [
    { id: 'target', x: 0, y: 0, width: 304, height: 300 },
    { id: 'a', x: 200, y: 336, width: 304, height: 299 },
    { id: 'b', x: 450, y: 671, width: 304, height: 299 },
    { id: 'side', x: 800, y: 400, width: 286, height: 299 },
  ];
  assert.deepEqual(portExpansionPositions(rectangles, 'target', 310), [
    { id: 'a', x: 200, y: 346 }, { id: 'b', x: 450, y: 681 },
  ]);
});

test('port growth fails atomically at the graph coordinate boundary', () => {
  const rectangles = [
    { id: 'target', x: 0, y: 9999400, width: 304, height: 300 },
    { id: 'a', x: 0, y: 9999736, width: 304, height: 299 },
  ];
  const before = structuredClone(rectangles);
  assert.throws(() => portExpansionPositions(rectangles, 'target', 700), /坐标边界/);
  assert.deepEqual(rectangles, before);
});

test('compact multimodal nodes expose each media kind and prefer declared prompts over file names', () => {
  const fields = [
    { id: 'prefix', type: 'text', label: '文件前缀' },
    { id: 'picture1', type: 'image', label: '场景' },
    { id: 'picture2', type: 'image', label: '人物' },
    { id: 'prompt', type: 'text', role: 'prompt', label: '描述' },
    { id: 'video1', type: 'video', label: '动作参考' },
    { id: 'video2', type: 'video', label: '镜头参考' },
    { id: 'audio1', type: 'audio', label: '声音' },
  ];
  const before = structuredClone(fields);
  assert.deepEqual(visibleInputPorts(fields).visible.map(item => item.id), ['picture1', 'prompt', 'video1', 'audio1']);
  const connected = visibleInputPorts(fields, ['prefix', 'video2']);
  assert.deepEqual(connected.visible.map(item => item.id), ['prefix', 'picture1', 'prompt', 'video1', 'video2', 'audio1']);
  assert.equal(connected.hidden, 1);
  assert.deepEqual(visibleInputPorts(fields, [], true).visible, fields);
  assert.deepEqual(fields, before, 'display selection must not change binding order or definitions');
});

test('canvas pages keep eight unconnected sockets readable while every connected field stays anchored', () => {
  const fields = Array.from({ length: 70 }, (_, i) => ({ id: `field-${i}`, type: 'image', label: `图像 ${i}` }));
  const connected = ['field-6', 'field-69'];
  const original = structuredClone(fields), seen = [];
  const first = visibleInputPorts(fields, connected, true);
  assert.equal(first.page.pages, 9);
  for (let page = 0; page < first.page.pages; page++) {
    const result = visibleInputPorts(fields, connected, true, 4, { page });
    assert.ok(result.page.items.length <= 8);
    assert.ok(connected.every(id => result.visible.some(field => field.id === id)));
    assert.equal(result.visible.length, result.page.items.length + connected.length);
    seen.push(...result.page.items.map(field => field.id));
  }
  assert.deepEqual(seen, fields.filter(field => !connected.includes(field.id)).map(field => field.id));
  const filtered = visibleInputPorts(fields, connected, true, 4, { query: 'field-68', page: 8 });
  assert.deepEqual(filtered.visible.map(field => field.id), ['field-6', 'field-68', 'field-69']);
  assert.deepEqual(fields, original);
});

test('compact layout hides scalar controls without losing connected legacy text sockets', () => {
  const fields = Array.from({length:12}, (_,i)=>({id:`f${i}`,label:`输入${i}`,type:'image'}));
  fields.push({id:'model',label:'模型',type:'text',presentation:'control'});
  let result=visibleInputPorts(fields, ['f10','model']);
  assert.equal(result.visible.length,6);
  assert.deepEqual(result.visible.slice(-2).map(f=>f.id),['f10','model']);
  assert.equal(result.hidden,7);
  assert.equal(visibleInputPorts(fields, [], true).total,12);
});

test('presentation metadata survives graph round trips and does not invalidate existing control bindings',()=>{
  const field={id:'f1',label:'场景',type:'text',presentation:'control',role:'prompt',group:'提示词'};
  const a=createNode('prompt',0,0,{text:'scene'}), b=createNode('generation',400,0,{kind:'package',package_id:'p-demo',packageFields:[field]});
  const graph={nodes:[a,b],edges:[]}; connect(graph,a.id,b.id,{targetField:'f1',sourceField:'text'});
  const loaded=parseGraph(serializeGraph(graph));
  assert.deepEqual(generationInputPorts(loaded.nodes[1]),[field]);
  assert.equal(loaded.edges.length,1);
  assert.deepEqual(cachedPackageField({...field,default:'private',node_id:'1'}),field);
});

test('multi-output selection excludes removed and unknown branches and detects batches',()=>{
  const a=createNode('generation',0,0,{kind:'package',editor_outputs:['a','b','u'],editor_output_fields:[{id:'a',mediaType:'image'},{id:'b',mediaType:'image'},{id:'removed',mediaType:'image'},{id:'u',mediaType:'unknown'}]});
  const result=createNode('result',400,0);const graph={nodes:[a,result],edges:[{id:'preview',source:a.id,target:result.id}]};
  assert.deepEqual(outputChoices(graph,result.id,'image').choices.map(o=>o.id),['a','b']);
  assert.equal(outputChoices(graph,result.id,'image').ambiguous,true);
  assert.equal(outputChoices(graph,result.id,'video').choices.length,0);
  a.data.editor_outputs=['a'];a.data.outputs=[{type:'image',node_id:'a'},{type:'image',node_id:'a'}];
  assert.equal(outputChoices(graph,result.id,'image').ambiguous,true);
});

test('audio sockets remain visible and audio results expose their exact sink and batch records', () => {
  const fields = [{ id: 'voice', type: 'audio', label: '声音' }, { id: 'gain', type: 'number', label: '增益' }];
  assert.deepEqual(visibleInputPorts(fields).visible, [fields[0]]);
  const node = createNode('generation', 0, 0, { kind: 'package', editor_outputs: ['voice'],
    editor_output_fields: [{ id: 'voice', mediaType: 'audio' }, { id: 'removed', mediaType: 'audio' }],
    outputs: [{ type: 'audio', node_id: 'voice', output_id: 'first' }, { type: 'audio', node_id: 'voice', output_id: 'second' }, { type: 'image' }] });
  const result = outputChoices({ nodes: [node], edges: [] }, node.id, 'audio');
  assert.deepEqual(result.choices.map(item => item.id), ['voice']);
  assert.deepEqual(result.actual.map(item => item.output_id), ['first', 'second']);
  assert.equal(result.ambiguous, true);
  node.data.outputs.push({type:'audio',node_id:'removed',output_id:'stale'});
  assert.deepEqual(outputChoices({nodes:[node],edges:[]},node.id,'audio').actual.map(item=>item.output_id),['first','second']);
  node.data.editor_outputs=[];
  assert.deepEqual(outputChoices({nodes:[node],edges:[]},node.id,'audio'),{choices:[],actual:[],ambiguous:false});
});
