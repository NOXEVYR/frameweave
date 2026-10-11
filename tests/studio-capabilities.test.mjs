import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createSdxlCapabilities } from '../web/studio-capabilities.mjs';
import { newDraft } from '../web/studio-state.mjs';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.classList = { toggle() {} }; this.replacements = 0; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; this.replacements++; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  setAttribute(key, value) { this.attributes[key] = value; }
}
const find = (root, check) => check(root) ? root : root.children.map(child => find(child, check)).find(Boolean);
const supported = () => ({ generation_options: { sdxl_clip: { available: true, types: ['sdxl'], clip_name1: ['L'], clip_name2: ['G'] }, refine: { available: true, upscale_methods: ['nearest-exact', 'bilinear'] } } });
function setup(t, engine = {}, draft = newDraft('txt2img')) {
  const old = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) }; t.after(() => { if (old) globalThis.document = old; else delete globalThis.document; });
  const h = { engine, draft, changes: 0 }; h.controls = createSdxlCapabilities({ draft, engine: () => h.engine, onChange: () => h.changes++ });
  h.get = label => find(h.controls.encoders, e => e.attributes['aria-label'] === label) || find(h.controls.refine, e => e.attributes['aria-label'] === label);
  return h;
}
test('discovery enables stable encoder/refine controls without changing draft or surrounding UI', t => {
  const h = setup(t), before = structuredClone(h.draft), l = h.get('CLIP-L 文件'), toggle = h.get('启用高清二次重绘');
  assert.equal(l.disabled, true); assert.equal(toggle.disabled, true);
  h.controls.encoders.open = false; h.controls.refine.open = true; h.engine = supported(); h.controls.update();
  assert.equal(h.get('CLIP-L 文件'), l); assert.equal(l.disabled, false); assert.equal(toggle.disabled, false);
  assert.deepEqual(l.children.map(o => o.value), ['', 'L']); assert.equal(h.controls.encoders.open, false); assert.equal(h.controls.refine.open, true);
  assert.deepEqual(h.draft, before); assert.equal(h.changes, 0);
});
test('capability loss preserves explicit values, permits clearing overrides and disabling refinement', t => {
  const d = newDraft('txt2img'); Object.assign(d.models, { sdxl_clip_l: 'L', sdxl_clip_g: 'G' }); d.refine.enabled = true; d.refine.upscale_method = 'bilinear';
  const h = setup(t, supported(), d), before = structuredClone(d); h.engine = {}; h.controls.update();
  assert.deepEqual(d, before); assert.equal(h.get('CLIP-L 文件').value, 'L'); assert.equal(h.get('CLIP-L 文件').disabled, true);
  const toggle = h.get('启用高清二次重绘'); assert.equal(toggle.disabled, false); toggle.checked = false; toggle.listeners.change();
  assert.equal(d.refine.enabled, false); assert.equal(toggle.disabled, true);
  find(h.controls.encoders, e => e.tagName === 'button').listeners.click(); assert.deepEqual(d.models, {});
  assert.equal(d.refine.upscale_method, 'bilinear'); assert.equal(h.changes, 2);
});
test('methods refresh without silently replacing an unsupported selection', t => {
  const d = newDraft('txt2img'); d.refine.upscale_method = 'bilinear';
  const h = setup(t, supported(), d), select = h.get('潜空间放大方法');
  h.engine.generation_options.refine.upscale_methods = ['bislerp']; h.controls.update();
  assert.equal(select.value, 'bilinear'); assert.equal(d.refine.upscale_method, 'bilinear');
  assert.deepEqual(select.children.map(o => o.value), ['', 'bislerp', 'bilinear']); assert.equal(select.children.at(-1).disabled, true);
});
test('unchanged updates retain selector contents and partially typed numeric input', t => {
  const h = setup(t, supported()), select = h.get('CLIP-L 文件'), number = h.get('二次宽度 / px');
  const option = select.children[1], replacements = select.replacements; number.value = ''; number.listeners.input();
  h.controls.update(); h.controls.update();
  assert.equal(select.replacements, replacements); assert.equal(select.children[1], option); assert.equal(number.value, ''); assert.equal(h.draft.refine.width, '');
});
test('a default refinement method is chosen only by explicit user enable, not discovery', t => {
  const h = setup(t, supported()); assert.equal(h.draft.refine.upscale_method, '');
  const toggle = h.get('启用高清二次重绘'); toggle.checked = true; toggle.listeners.change();
  assert.equal(h.draft.refine.upscale_method, 'nearest-exact'); assert.equal(h.draft.refine.enabled, true);
});
test('SDXL type removal disables a loader even when available remains true', t => {
  const h = setup(t, supported()); h.engine.generation_options.sdxl_clip.types = ['flux']; h.controls.update(); assert.equal(h.get('CLIP-L 文件').disabled, true);
});
test('actual studio catalog refresh invokes capability update without rebuilding the panel', async () => {
  const source = await readFile(new URL('../web/generation-studio.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('  function updateCatalogs('), source.indexOf('  function buildRequest('));
  let updates = 0; const panel = { dataset: { studioMode: 'txt2img' }, updateCapabilities() { updates++; }, querySelectorAll() { return []; } };
  const context = vm.createContext({ samplerOptions: () => ({}), panel }); vm.runInContext(fn + '\nupdateCatalogs(panel);', context); assert.equal(updates, 1);
});
