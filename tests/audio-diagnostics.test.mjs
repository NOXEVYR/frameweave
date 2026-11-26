import test from 'node:test';
import assert from 'node:assert/strict';
import { audioDiagnosticView, renderAudioDiagnostics } from '../web/audio-diagnostics.mjs';
import { audioIntegrationRequest, audioPackageChoices, buildAudioPackageRequest } from '../web/audio-studio.mjs';

const backend = 'http://127.0.0.1:8188';
const missing = { code: 'missing_node', node_id: '19:32', class_type: 'VoiceDesign' };

test('live failure cannot be hidden by stale local package capability properties', () => {
  const local = { id: 'p', name: '本地名称', eligible: true, available: true, reason: null, diagnostics: [], fields: [] };
  const entry = { id: 'p', eligible: false, available: false, reason: '缺少节点', diagnostics: [missing], diagnostics_total: 1 };
  const choices = audioPackageChoices({ backend_url: backend, packages: [entry] }, [local], backend);
  assert.equal(choices.packages[0].name, '本地名称');
  assert.equal(choices.packages[0].eligible, false);
  assert.equal(audioDiagnosticView(choices.packages[0]).items[0].node_id, '19:32');
  assert.throws(() => buildAudioPackageRequest(choices.packages[0], { package_id: 'p', values: {} }, backend), /缺少节点/);
});

test('diagnostics retain nested node identity and dynamic inputs, never raw messages or values', () => {
  const view = audioDiagnosticView({ diagnostics: [{ ...missing, input: 'format.codec', message: 'C:\\private\\input.wav', value: 'private prompt' }] });
  assert.match(view.items[0].text, /19:32.*VoiceDesign.*format\.codec/);
  assert.doesNotMatch(JSON.stringify(view), /private|input\.wav/);
  const invalid = audioDiagnosticView({ diagnostics: [{ code: 'unknown private detail', node_id: 'x\nprivate',
    class_type: 'C:\\private\\model.safetensors', input: '../private.wav', reason: 'private prompt' }] });
  assert.equal(invalid.items[0].code, 'schema_incompatible');
  assert.doesNotMatch(JSON.stringify(invalid), /private|safetensors|wav/);
  for (const suffix of ['gguf', 'onnx', 'aac', 'm4a', 'wma', 'mov', 'mkv', 'avi']) {
    const hidden = audioDiagnosticView({ diagnostics: [{ code: 'missing_node', class_type: `private.${suffix}`, input: `private.${suffix}` }] });
    assert.doesNotMatch(JSON.stringify(hidden), /private/);
  }
});

test('bounded diagnostic display preserves true count and older backend compatibility', () => {
  assert.deepEqual(audioDiagnosticView({ issues: ['old'] }), { available: false, items: [], total: 0, truncated: false });
  const result = audioDiagnosticView({ diagnostics: Array.from({ length: 25 }, (_, n) => ({ ...missing, node_id: String(n) })), diagnostics_total: 30 });
  assert.equal(result.items.length, 20); assert.equal(result.total, 30); assert.equal(result.truncated, true);
  const forged = audioDiagnosticView({ diagnostics: [missing], diagnostics_total: -1 });
  assert.equal(forged.total, 1);
});

test('selected repair note excludes other package issues, names, paths and parameter values', () => {
  const cap = { outputs: [{ class_type: 'SaveAudio' }], packages: [
    { id: 'a', name: 'privateA', eligible: false, diagnostics: [missing], diagnostics_total: 1, prompt: 'privatePrompt' },
    { id: 'b', name: 'privateB', eligible: false, diagnostics: [{ code: 'missing_node', class_type: 'OtherNode' }], reason: 'private/path' },
    { id: 'ready', eligible: true, available: true },
  ] };
  const note = audioIntegrationRequest({ system: { comfyui_version: '0.37.4' } }, cap, 'a');
  assert.match(note, /VoiceDesign/); assert.match(note, /当前选择/); assert.match(note, /当前可用 1 个/);
  assert.doesNotMatch(note, /OtherNode|private/);
  const stale = audioIntegrationRequest({}, cap, 'gone');
  assert.match(stale, /刷新音频能力/); assert.doesNotMatch(stale, /VoiceDesign|OtherNode/);
  assert.match(audioIntegrationRequest({}, cap, 'ready'), /通过本次节点和 AUDIO 输出检查/);
});

test('global clipboard diagnostics stop at twenty and explain omitted findings', () => {
  const cap = { packages: Array.from({ length: 30 }, (_, n) => ({ id: `p${n}`, eligible: false,
    diagnostics: [{ code: 'missing_input', node_id: String(n), input: 'language' }], diagnostics_total: 1 })) };
  const note = audioIntegrationRequest({}, cap);
  assert.equal(note.match(/\[missing_input\]/g).length, 20); assert.match(note, /只列出前 20 项/);
  assert.doesNotMatch(note, /节点 20/);
});

test('diagnostic renderer uses visible text and exposes the remaining issue count', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  class Element { constructor(tag) { this.tagName = tag; this.children = []; } append(...children) { this.children.push(...children); } }
  globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete globalThis.document; });
  const container = new Element('section');
  renderAudioDiagnostics(container, { diagnostics: [missing], diagnostics_total: 22, diagnostics_truncated: true });
  const detail = container.children[0]; assert.equal(detail.open, true);
  assert.match(detail.children[0].textContent, /22 项/);
  assert.match(detail.children[1].children[0].textContent, /VoiceDesign/);
  assert.match(detail.children[2].textContent, /显示 1 项/);
  const empty = new Element('section'); renderAudioDiagnostics(empty, { diagnostics: [] }); assert.equal(empty.children.length, 0);
});
