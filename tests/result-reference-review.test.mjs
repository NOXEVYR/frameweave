import test from 'node:test';
import assert from 'node:assert/strict';
import { createNode } from '../web/graph.mjs';
import { openResultReferenceDialog } from '../web/result-reference-dialog.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  showModal() { this.open = true; } close() { this.open = false; } remove() { this.removed = true; } focus() {}
}
const descendants = element => [element, ...element.children.flatMap(descendants)];
const backend = 'http://127.0.0.1:8188';
function fixture() {
  const output = { output_id: `o-${'a'.repeat(64)}`, node_id: '42', filename: 'result.png',
    type: 'image', subfolder: '', storage_type: 'output', url: `/api/media/${'b'.repeat(32)}` };
  const job = { id: 'review-job', status: 'completed', backend, outputs: [output] };
  const source = createNode('result', 0, 0, { jobId: job.id, outputs: structuredClone(job.outputs) });
  const target = createNode('generation', 600, 0, { title: '原工作流', kind: 'package', package_id: `p-${'c'.repeat(24)}`,
    packageValues: { ref: 'own.png' }, packageFields: [{ id: 'ref', type: 'image', label: '人物参考', node_id: '7', input: 'image' }] });
  const graph = { nodes: [source, target], edges: [] }, current = { graph, canvasId: 'review-canvas', backend };
  const document = { body: new Element('body'), createElement: tag => new Element(tag) }, applied = [], calls = [], hooks = {};
  const jobs = [job];
  async function api(path) {
    calls.push(path); await hooks.before?.(path);
    if (path === '/api/jobs') return { jobs };
    if (path === '/api/status') return { online: true, backend_url: backend };
    if (path.endsWith('/image-input')) return { name: 'input/result.png', url: `/api/media/${'e'.repeat(32)}`,
      backend, media_type: 'image', source_job: job.id, output_id: output.output_id };
    throw new Error(`Unexpected request: ${path}`);
  }
  const open = (initialOutputId = output.output_id) => openResultReferenceDialog({ source, initialOutputId, api,
    current: () => current, apply: fragment => applied.push(fragment), document });
  const controls = () => {
    const all = descendants(document.body);
    return { all, output: all.find(item => item['aria-label'] === '选择产物'),
      target: all.find(item => item['aria-label'] === '目标工作流输入'), search: all.find(item => item['aria-label'] === '搜索目标输入'),
      send: all.find(item => item.textContent === '建立参考并连接') };
  };
  return { output, job, source, target, graph, current, document, applied, calls, hooks, jobs, open, controls };
}

test('initial jobs await cannot silently retarget the clicked result node to another completed job', async () => {
  const h = fixture(); let release;
  h.hooks.before = path => path === '/api/jobs' ? new Promise(resolve => { release = resolve; }) : undefined;
  const pending = h.open();
  const nextOutput = { ...h.output, output_id: `o-${'f'.repeat(64)}`, filename: 'new-result.png' };
  h.jobs.push({ ...h.job, id: 'new-job', outputs: [nextOutput] });
  h.source.data.jobId = 'new-job'; h.source.data.outputs = [nextOutput]; release();
  await assert.rejects(pending, /变化|更换|重新/);
  assert.equal(h.applied.length, 0); assert.equal(h.calls.filter(path => path.endsWith('-input')).length, 0);
});

test('a vanished explicitly clicked output must not default to the first remaining output', async () => {
  const h = fixture(), clicked = h.output.output_id;
  h.job.outputs = [{ ...h.output, output_id: `o-${'f'.repeat(64)}`, filename: 'different-branch.png' }];
  h.source.data.outputs = structuredClone(h.job.outputs);
  await assert.rejects(h.open(clicked), /产物|变化|重新/);
  assert.equal(h.calls.filter(path => path.endsWith('-input')).length, 0);
});

test('a selected target deleted and replaced with the same ID requires reselection instead of uploading to the replacement', async () => {
  const h = fixture(); await h.open(); const controls = h.controls(); controls.target.value = '0';
  const replacement = structuredClone(h.target); replacement.data.title = '不同工作流';
  h.graph.nodes[1] = replacement;
  await controls.send.listeners.click();
  assert.equal(h.calls.filter(path => path.endsWith('-input')).length, 0);
  assert.equal(h.applied.length, 0);
});

test('target search reaches matching inputs beyond the first 64 without selecting one automatically', async () => {
  const h = fixture();
  for (let i = 0; i < 79; i++) h.graph.nodes.push(createNode('generation', i * 10, 0, { ...structuredClone(h.target.data), title: `工作流 ${i}` }));
  h.graph.nodes.at(-1).data.title = '唯一目标九十九';
  await h.open(); const controls = h.controls();
  assert.equal(controls.target.children.length, 65); assert.equal(controls.target.value, '');
  controls.search.value = '唯一目标九十九'; controls.search.listeners.input();
  assert.equal(controls.target.children.length, 2); assert.match(controls.target.children[1].textContent, /唯一目标九十九/);
  assert.equal(controls.target.value, ''); assert.equal(h.calls.filter(path => path.endsWith('-input')).length, 0);
});

test('changed input mapping under the same field ID is not silently accepted from a stale named choice', async () => {
  const h = fixture(); await h.open(); const controls = h.controls(); controls.target.value = '0';
  h.target.data.packageFields[0] = { ...h.target.data.packageFields[0], node_id: '88', label: '场景参考' };
  await controls.send.listeners.click();
  assert.equal(h.calls.filter(path => path.endsWith('-input')).length, 0);
  assert.equal(h.applied.length, 0);
});

test('search refresh clears a stale named selection after target replacement instead of rebasing it by ID', async () => {
  const h = fixture(); await h.open(); const controls = h.controls(); controls.target.value = '0';
  h.graph.nodes[1] = structuredClone(h.target);
  controls.search.listeners.input();
  assert.equal(controls.target.value, '');
  await controls.send.listeners.click();
  assert.equal(h.calls.filter(path => path.endsWith('-input')).length, 0);
});
