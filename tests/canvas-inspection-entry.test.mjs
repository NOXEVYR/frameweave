import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { initialEditorFieldIds } from '../web/editor-interface-panel.mjs';
import { createNode } from '../web/graph.mjs';
import { createCanvasInspection, inspectWithDiscovery, captureRequestInspection } from '../web/canvas-inspection.mjs';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
function entry(name, next) {
  const start = source.indexOf(`async function ${name}(`), end = source.indexOf(`async function ${next}(`, start);
  assert(start >= 0 && end > start, `missing app entry ${name}`);
  return source.slice(start, end);
}
const BACKEND = 'http://127.0.0.1:8188';
const OTHER = 'http://127.0.0.1:9999';

function harness() {
  const node = createNode('generation', 0, 0, { kind: 'sdxl' }); node.id = 'target';
  const graph = { nodes: [node], edges: [] }, settings = { backend_url: BACKEND }, calls = [], elements = new Map();
  const control = { remote: BACKEND, canvasId: 'original', afterInspection: () => {}, duringPackage: () => {} };
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { open: false, textContent: '', value: '', disabled: false,
      showModal() { this.open = true; }, close() { this.open = false; }, contains() { return false; } });
    return elements.get(selector);
  };
  const api = async path => {
    calls.push({ path, backend: control.remote });
    if (path === '/api/status') return { online: true, backend_url: control.remote };
    if (path === '/api/diagnostics') return { summary: 'Backend A diagnostic', checks: [{ name: 'A-only check', status: 'ok' }] };
    if (path === '/api/compile') return { prompt: { a: { class_type: 'A_Node', inputs: {} } }, summary: 'A compiled' };
    if (path === '/api/packages/inspect') {
      control.duringPackage();
      return { prompt: { a: { class_type: 'A_Node', inputs: {} } }, fields: [{ id: 'b', label: 'schema field', type: 'text' }] };
    }
    throw new Error(`unexpected API ${path}`);
  };
  const inspector = createCanvasInspection({ api, graph: () => graph, backend: () => settings.backend_url, canvasIdentity: () => control.canvasId });
  let releaseDiscovery;
  const discovery = new Promise(resolve => { releaseDiscovery = resolve; });
  const context = { $, api, settings, graph, engine: {}, diagnosticBusy: false, diagnosticNodeId: null,
    workflowChecks: [], workflowRepair: '', environment: null, packageDraft: null, selectedGeneration: () => node,
    canvasIsActive: () => true, currentCanvasIdentity: () => control.canvasId, studio: {}, inspectWithDiscovery, captureRequestInspection,
    scanEnvironment: () => discovery, renderDiagnosticChecks() {}, renderEnvironment() {}, renderInspector() {},
    renderPackageDraft() {}, initialEditorFieldIds, fieldType: field => field.type, stableStringify: JSON.stringify,
    document: { activeElement: null, body: { dataset: { workspace: 'canvas' } } },
    refreshEngine: async () => { context.engine = await api('/api/status'); },
    canvasInspection: { compile: id => inspector.compile(id), diagnose: async id => {
      const result = await inspector.diagnose(id); control.afterInspection(); releaseDiscovery({ checks: [] }); return result;
    } },
  };
  vm.createContext(context);
  vm.runInContext(entry('runDiagnostics', 'runNode') + entry('inspectPackageDocument', 'inspectPackageFile')
    + entry('packageCurrentNode', 'openNodeWorkflow'), context);
  return { context, node, graph, control, settings, calls, $, releaseDiscovery };
}

test('actual diagnostics entry refuses results from backend A after delayed discovery sees backend B', async () => {
  const h = harness(); h.control.afterInspection = () => { h.control.remote = OTHER; };
  await h.context.runDiagnostics(h.node, true);
  assert.equal(h.context.engine.backend_url, OTHER);
  assert.equal(h.context.workflowChecks[0].status, 'unknown');
  assert.match(h.$('#diagnostic-summary').textContent, /推理引擎已变化/);
  assert(!h.context.workflowChecks.some(check => check.name === 'A-only check'));
});

test('actual diagnostics entry refuses imported canvas results while discovery is finishing', async () => {
  const h = harness(); h.control.afterInspection = () => { h.control.canvasId = 'new-canvas'; };
  await h.context.runDiagnostics(h.node, true);
  assert.equal(h.context.workflowChecks[0].status, 'unknown');
  assert.match(h.$('#diagnostic-summary').textContent, /画布或推理引擎已变化/);
});

test('actual package-current-node follow-up refuses package fields read after a remote backend switch', async () => {
  const h = harness(); h.control.duringPackage = () => { h.control.remote = OTHER; };
  await assert.rejects(h.context.packageCurrentNode(), /推理引擎已变化/);
  assert.equal(h.context.packageDraft, null);
  assert.equal(h.$('#package-editor-dialog').open, false);
  assert(h.calls.some(call => call.path === '/api/packages/inspect'));
});

test('actual package-current-node follow-up still opens a draft on an unchanged backend', async () => {
  const h = harness(); await h.context.packageCurrentNode();
  assert.equal(h.context.packageDraft.fields[0].label, 'schema field');
  assert.equal(h.$('#package-editor-dialog').open, true);
  assert(h.calls.every(call => ['/api/status', '/api/compile', '/api/packages/inspect'].includes(call.path)));
});

function studioHarness(change = () => {}) {
  const h = harness();
  h.context.canvasIsActive = () => false;
  h.context.document.body.dataset.workspace = 'txt2img';
  h.control.payload = { kind: 'sdxl', positive: 'original studio prompt' };
  h.context.studio = { diagnosticsRequest: () => structuredClone(h.control.payload) };
  h.context.scanEnvironment = async () => {
    await new Promise(resolve => setImmediate(resolve));
    change(h);
    return { checks: [] };
  };
  return h;
}

for (const [change, mutate] of [
  ['local backend', h => { h.settings.backend_url = h.control.remote = OTHER; }],
  ['remote backend', h => { h.control.remote = OTHER; }],
  ['studio draft', h => { h.control.payload.positive = 'edited during scan'; }],
  ['workspace', h => { h.context.document.body.dataset.workspace = 'canvas'; }],
]) test(`actual studio diagnostics entry refuses stale checks after delayed ${change} change`, async () => {
  const h = studioHarness(mutate);
  await h.context.runDiagnostics(null, true);
  assert.equal(h.context.workflowChecks[0].status, 'unknown');
  assert(!h.context.workflowChecks.some(check => check.name === 'A-only check'));
  assert.notEqual(h.$('#diagnostic-summary').textContent, 'Backend A diagnostic');
});

test('actual studio diagnostics entry applies checks with unchanged request, workspace and backend', async () => {
  const h = studioHarness(); await h.context.runDiagnostics(null, true);
  assert.equal(h.context.workflowChecks[0].name, 'A-only check');
  assert.equal(h.$('#diagnostic-summary').textContent, 'Backend A diagnostic');
  assert(h.calls.every(call => ['/api/status', '/api/diagnostics'].includes(call.path)));
});
