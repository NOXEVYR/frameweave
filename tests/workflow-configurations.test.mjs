import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationBundle, configuredNodes } from '../web/workflow-configurations.mjs';
import { connect, createNode, parseGraph, serializeGraph } from '../web/graph.mjs';

const PACKAGE_ID = 'p-0123456789abcdef01234567';
const EDITOR_ID = `e-${'a'.repeat(24)}`;
const BACKEND = 'http://127.0.0.1:8188';

function makeBundle() {
  const prompt = createNode('prompt', 20, 30, {
    text: 'A prompt connected from the canvas.', negative: 'Avoid titles and watermarks.',
  });
  const reference = createNode('reference', 20, 180, {
    name: 'PRIVATE_MEDIA_IMAGE_NAME.png', mediaType: 'image',
  });
  const generation = createNode('generation', 300, 40, {
    title: 'Original outer node', kind: 'package', package_id: PACKAGE_ID,
    editor_id: EDITOR_ID, editor_backend: BACKEND,
    packageFields: [
      { id: 'prompt-field', label: 'Prompt', type: 'text' },
      { id: 'negative-field', label: 'Negative prompt', type: 'text' },
      { id: 'image-field', label: 'Reference', type: 'image' },
      { id: 'audio-field', label: 'Audio', type: 'audio' },
      { id: 'video-field', label: 'Video', type: 'video' },
      { id: 'quality-field', label: 'Quality', type: 'number' },
    ],
    packageValues: {
      'prompt-field': 'old prompt',
      'negative-field': 'old negative prompt',
      'image-field': 'PRIVATE_MEDIA_IMAGE_NAME.png',
      'audio-field': 'PRIVATE_MEDIA_AUDIO_NAME.wav',
      'video-field': 'PRIVATE_MEDIA_VIDEO_NAME.mp4',
      'quality-field': 0.7,
    },
    packageMediaBackends: {
      'image-field': { name: 'PRIVATE_MEDIA_IMAGE_NAME.png', backend: BACKEND },
      'audio-field': { name: 'PRIVATE_MEDIA_AUDIO_NAME.wav', backend: BACKEND },
      'video-field': { name: 'PRIVATE_MEDIA_VIDEO_NAME.mp4', backend: BACKEND, preview_url: `/api/media/${'b'.repeat(32)}` },
    },
    editor_baseline: { 'prompt-field': 'baseline prompt', 'quality-field': 0.5 },
    editor_controls: [{ node_id: 'inner-node', input: 'prompt', widget_node_id: '10', widget_name: 'text' }],
    editor_outputs: ['inner-output'],
    editor_output_fields: ['IMAGE'],
  });
  const graph = { nodes: [prompt, reference, generation], edges: [] };
  connect(graph, prompt.id, generation.id, { targetField: 'prompt-field' });
  connect(graph, prompt.id, generation.id, { targetField: 'negative-field', sourceField: 'negative' });
  connect(graph, reference.id, generation.id, { targetField: 'image-field' });

  const pack = {
    id: PACKAGE_ID, content_id: 'stable-content-id', name: 'Internal package',
    format: 'frameweave-workflow', version: 1,
    prompt: { 'inner-node': { class_type: 'PromptNode', inputs: { text: 'Internal workflow' } } },
    fields: [{ id: 'prompt-field', label: 'Prompt', node_id: 'inner-node', input: 'text', type: 'text', default: 'Internal workflow' }],
  };
  const editor = { id: EDITOR_ID, name: 'Internal editor document', revision: 4 };
  return {
    canvas: serializeGraph(graph), packages: [pack], editors: [editor],
  };
}

test('configuration export is a single reusable package node and preserves its internal state', () => {
  const bundle = makeBundle();
  const before = structuredClone(bundle);
  const originalGraph = parseGraph(bundle.canvas);
  const originalNode = originalGraph.nodes.find(node => node.type === 'generation');

  const configuration = configurationBundle(bundle, originalNode.id, 'Reusable configuration');
  const savedGraph = parseGraph(configuration.canvas);
  const nodes = configuredNodes(configuration);

  assert.equal(configuration.schema, 'prismcanvas.project.v1');
  assert.equal(configuration.version, 1);
  assert.equal(configuration.configuration, true);
  assert.equal(configuration.name, 'Reusable configuration');
  assert.equal(savedGraph.nodes.length, 1);
  assert.deepEqual(savedGraph.edges, []);
  assert.equal(nodes.length, 1);

  const saved = nodes[0];
  assert.equal(saved.data.package_id, PACKAGE_ID);
  assert.equal(saved.data.title, 'Reusable configuration');
  assert.equal(saved.data.packageValues['prompt-field'], 'A prompt connected from the canvas.');
  assert.equal(saved.data.packageValues['negative-field'], 'Avoid titles and watermarks.');
  assert.equal(saved.data.packageValues['quality-field'], 0.7);
  assert.equal(saved.data.packageValues['image-field'], '');
  assert.equal(saved.data.packageValues['audio-field'], '');
  assert.equal(saved.data.packageValues['video-field'], '');
  assert.deepEqual(saved.data.packageMediaBackends, {});
  assert.deepEqual(saved.data.editor_baseline, originalNode.data.editor_baseline);
  assert.deepEqual(saved.data.editor_controls, originalNode.data.editor_controls);
  assert.equal(saved.data.editor_backend, BACKEND);
  assert.equal(saved.data.editor_id, EDITOR_ID);
  assert.deepEqual(saved.data.editor_outputs, ['inner-output']);
  assert.deepEqual(configuration.packages, [before.packages[0]]);
  assert.deepEqual(configuration.editors, [before.editors[0]]);
  assert.equal(JSON.stringify(configuration).includes('PRIVATE_MEDIA_'), false);
  assert.deepEqual(bundle, before, 'building a configuration must not mutate the source bundle');
});

test('configuration export refuses missing package or editor definitions without changing the source', () => {
  const base = makeBundle();
  const nodeId = parseGraph(base.canvas).nodes.find(node => node.type === 'generation').id;

  const missingPackage = structuredClone(base);
  missingPackage.packages = [];
  const packageBefore = structuredClone(missingPackage);
  assert.throws(() => configurationBundle(missingPackage, nodeId, 'Missing package'), /缺少工作流定义/);
  assert.deepEqual(missingPackage, packageBefore);

  const missingEditor = structuredClone(base);
  missingEditor.editors = [];
  const editorBefore = structuredClone(missingEditor);
  assert.throws(() => configurationBundle(missingEditor, nodeId, 'Missing editor'), /缺少工作流定义/);
  assert.deepEqual(missingEditor, editorBefore);
});

test('configuredNodes accepts the exported configuration and rejects unsupported bundle headers', () => {
  const bundle = makeBundle();
  const nodeId = parseGraph(bundle.canvas).nodes.find(node => node.type === 'generation').id;
  const configuration = configurationBundle(bundle, nodeId, 'Portable recipe');
  assert.deepEqual(configuredNodes(configuration).map(node => node.data.package_id), [PACKAGE_ID]);

  const graph = parseGraph(configuration.canvas);
  graph.nodes.push(createNode('prompt', 300, 0));
  graph.nodes.push(createNode('generation', 500, 0, { kind: 'h3_t2v' }));
  const mixedBundle = { ...configuration, canvas: serializeGraph(graph) };
  assert.deepEqual(configuredNodes(mixedBundle).map(node => node.data.package_id), [PACKAGE_ID]);

  assert.throws(() => configuredNodes({ ...configuration, schema: 'unknown' }), /配置记录格式无效/);
  assert.throws(() => configuredNodes({ ...configuration, version: 2 }), /配置记录格式无效/);
});
