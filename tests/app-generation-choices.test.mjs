import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { modelCandidates, samplingCandidates } from '../web/canvas-generation-choices.mjs';
const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const part = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
class Element {
  constructor(tag, cls, text) { Object.assign(this, { tag, className: cls, textContent: text, children: [], dataset: {}, listeners: {}, value: '', disabled: false }); }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(key, value) { this.listeners[key] = value; }
}
function fixture({ online = true, models = { checkpoint: ['sdxl-current'] }, current = 'missing-old' } = {}) {
  const node = { id: 'node', data: { kind: 'sdxl', models: { checkpoint: current }, sampler: 'obsolete-sampler', scheduler: 'simple' } };
  const state = { mutations: 0, errors: [], notes: [], ownerCurrent: true };
  const context = vm.createContext({ modelCandidates, samplingCandidates, node,
    engine: { online, models, generation_options: { model_families: { checkpoint: { 'sdxl-current': 'sdxl' } }, samplers: ['euler'], schedulers: ['simple'] } },
    parameterRenderGuard: { current: () => state.ownerCurrent }, draftEditing: null,
    el: (tag, cls, text) => new Element(tag, cls, text), button(text, cls, action) { const item = new Element('button', cls, text); item.action = action; return item; }, toast: (...args) => state.notes.push(args), reportError: error => state.errors.push(error),
    mutate(fn) { fn(); state.mutations++; }, editNode(id, key, value) { assert.equal(id, node.id); node.data[key] = value; state.mutations++; },
  });
  vm.runInContext(part('function bindDraft(', 'function section(') + part('function catalog(', 'const interfaceViews =') + part('function renderLoraFields(', 'function deleteSelection('), context);
  const input = wrapper => wrapper.children.find(child => child.tag === 'select');
  const change = (control, value) => { control.value = value; control.listeners.change(); };
  return { context, node, state, input, change };
}
test('missing current model is retained disabled and excluded from the real candidate count', () => {
  const h = fixture(), wrapper = h.context.modelField(h.node, 'Checkpoint 主模型', 'checkpoint'), select = h.input(wrapper);
  const old = select.children.find(option => option.value === 'missing-old');
  assert.equal(old.disabled, true); assert.match(old.textContent, /已保留/); assert.equal(select.value, 'missing-old');
  assert.match(wrapper.children[1].textContent, /^1 个目录候选/); assert.match(wrapper.children[1].textContent, /不代表权重已验证/);
  assert.equal(h.node.data.models.checkpoint, 'missing-old'); assert.equal(h.state.mutations, 0);
});
test('offline cached directory is not presented as available and the old model remains intact', () => {
  const h = fixture({ online: false, current: 'sdxl-current' }), wrapper = h.context.modelField(h.node, '模型', 'checkpoint'), select = h.input(wrapper);
  assert.equal(select.children.find(option => option.value === 'sdxl-current').disabled, true);
  assert.match(wrapper.children[1].textContent, /引擎未连接/); assert.equal(h.node.data.models.checkpoint, 'sdxl-current');
});
for (const expiry of ['offline', 'removed', 'family']) test(`a model selection rechecks the current catalog after ${expiry}`, () => {
  const h = fixture(), select = h.input(h.context.modelField(h.node, '模型', 'checkpoint'));
  if (expiry === 'offline') h.context.engine.online = false;
  if (expiry === 'removed') h.context.engine.models.checkpoint = [];
  if (expiry === 'family') h.context.engine.generation_options.model_families.checkpoint['sdxl-current'] = 'sd15';
  h.change(select, 'sdxl-current');
  assert.equal(h.node.data.models.checkpoint, 'missing-old'); assert.equal(select.value, 'missing-old'); assert.equal(h.state.mutations, 0); assert.equal(h.state.notes.length, 1);
});
test('valid model change and explicit clearing use the existing node override without rewriting other values', () => {
  const h = fixture(), select = h.input(h.context.modelField(h.node, '模型', 'checkpoint'));
  h.node.data.models.vae = 'keep-vae'; h.change(select, 'sdxl-current'); assert.equal(h.node.data.models.checkpoint, 'sdxl-current');
  h.context.engine.online = false; h.change(select, ''); assert.equal(h.node.data.models.checkpoint, ''); assert.equal(h.node.data.models.vae, 'keep-vae'); assert.equal(h.state.mutations, 2);
});
test('sampling uses backend declarations and preserves a removed sampler as disabled without creating new defaults', () => {
  const h = fixture(), wrapper = h.context.samplingField(h.node, '采样器', 'sampler', 'euler'), select = h.input(wrapper);
  assert.deepEqual(select.children.map(option => [option.value, !!option.disabled]), [['obsolete-sampler', true], ['euler', false]]);
  assert.match(wrapper.children[1].textContent, /^1 个引擎声明选项/); assert.equal(h.node.data.sampler, 'obsolete-sampler');
  h.context.engine.generation_options.samplers = []; h.change(select, 'euler');
  assert.equal(h.node.data.sampler, 'obsolete-sampler'); assert.equal(select.value, 'obsolete-sampler'); assert.equal(h.state.mutations, 0);
});
test('retired field ownership rejects a queued change and restores its accepted visible value', () => {
  const h = fixture(), select = h.input(h.context.modelField(h.node, '模型', 'checkpoint')); h.state.ownerCurrent = false;
  h.change(select, 'sdxl-current'); assert.equal(select.value, 'missing-old'); assert.equal(h.state.mutations, 0);
});

test('multiple LoRA retains stale names disabled and rechecks current loader choices for changes and additions', () => {
  const h = fixture(), wrap = new Element('div'); h.node.data.loras = [{ name: 'missing-lora', strength_model: 0.5 }];
  h.context.engine.generation_options.lora_loaders = { LoraLoader: { names: ['live-lora'] } };
  h.context.renderLoraFields(wrap, h.node);
  const flatten = item => [item, ...item.children.flatMap(flatten)], all = flatten(wrap);
  const select = all.find(item => item.tag === 'select');
  assert.equal(select.children.find(item => item.value === 'missing-lora').disabled, true);
  const add = all.find(item => item.tag === 'button' && item.textContent === '＋ 添加 LoRA'); assert.equal(add.disabled, false);
  h.context.engine.generation_options.lora_loaders.LoraLoader.names = [];
  h.change(select, 'live-lora'); assert.equal(select.value, 'missing-lora'); assert.equal(h.node.data.loras[0].name, 'missing-lora');
  add.action(); assert.equal(h.node.data.loras.length, 1);
  h.context.engine.generation_options.lora_loaders.LoraLoader.names = ['fresh-lora']; add.action();
  assert.equal(h.node.data.loras.length, 2); assert.equal(h.node.data.loras[1].name, 'fresh-lora');
});
