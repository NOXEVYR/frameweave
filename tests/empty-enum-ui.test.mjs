import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { coerceFieldValue, coerceEditorFieldValue, validateValues, selectFieldState, defaultValues, fieldType, isSafeSelectLiteral } from '../web/packages.mjs';
import { preflightPresetInterfaceMigration } from '../web/preset-interface-receipt.mjs';
import { interfacePage, interfaceSearch } from '../web/interface-pagination.mjs';
import { INTERFACE_PAGE_SIZE } from '../web/interface-limits.mjs';
import { createMediaTransfers } from '../web/media-transfers.mjs';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const part = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const flatten = root => [root, ...root.children.flatMap(flatten)];
class Element {
  constructor(tag, cls = '', text = '') { Object.assign(this, { tagName: tag, className: cls, textContent: text, children: [], dataset: {}, style: {}, listeners: {}, value: '', disabled: false }); }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  setAttribute(name, value) { this[name] = value; }
  closest() { return null; }
  checkValidity() { return true; }
}
function harness(value, options = []) {
  const definition = { id: 'model', node_id: '1', input: 'unet_name', type: 'select', label: '主模型', options, default: 'DEFAULT MUST NOT REPLACE OWN' };
  const node = { id: 'target', data: { kind: 'package', package_id: 'pack', packageValues: { model: value } } };
  const pack = { id: 'pack', fields: [definition] }, state = { wrap: new Element('div'), mutations: 0, errors: [] };
  const sandbox = { selectFieldState, coerceFieldValue, defaultValues, fieldType, interfacePage, interfaceSearch, INTERFACE_PAGE_SIZE,
    activeSidebarPackage: null, currentCanvasIdentity: () => 'canvas', packageCatalog: { peek: () => pack }, packagesLoaded: true,
    packageMediaOwner: () => 'owner', packageMediaTransfers: createMediaTransfers(), packageMediaPreview: () => null, workflowConfigurations: {}, draftEditing: false,
    el: (tag, cls, text) => new Element(tag, cls, text), button: (text, cls, fn) => { const el = new Element('button', cls, text); el.listeners.click = fn; return el; }, section() {},
    mutate: fn => { state.mutations++; fn(); }, reportError: error => state.errors.push(error.message), queueMicrotask, renderNodes() {},
    renderInspector() { state.wrap.replaceChildren(); sandbox.renderPackageInputs(state.wrap, node); },
  };
  vm.runInNewContext(part('function bindDraft(', 'function section(') + part('const interfaceViews =', 'function renderInputPortSettings(') + part('function renderPackageInputs(', 'async function loadPackages('), sandbox);
  sandbox.renderInspector();
  const control = () => flatten(state.wrap).find(el => el.dataset.packageField === 'model');
  const input = () => flatten(control()).find(el => ['input', 'select'].includes(el.tagName));
  return { node, definition, state, sandbox, input, control };
}

test('empty static directory displays readonly original name and never writes a placeholder', () => {
  const h = harness('old.safetensors'), original = structuredClone(h.node);
  assert.equal(h.input().readOnly, true); assert.equal(h.input().value, 'old.safetensors');
  assert(flatten(h.control()).some(el => /目录为空.*不能用于生成/.test(el.textContent)));
  assert(flatten(h.control()).some(el => /管理外部接口.*重新编译候选/.test(el.textContent)));
  h.input().value = 'fake'; h.input().listeners.change();
  assert.deepEqual(h.node, original); assert.equal(h.state.mutations, 0);
  assert.throws(() => validateValues([h.definition], h.node.data.packageValues), /不在可选值/);
});

test('nonempty stale value has a disabled preserved item until explicit valid selection', () => {
  const h = harness('old.safetensors', ['new.safetensors']);
  assert.equal(h.input().value, 'preserved');
  const preserved = h.input().children.find(el => el.value === 'preserved');
  assert.equal(preserved.disabled, true); assert.match(preserved.textContent, /old.safetensors.*不可用/);
  for (const token of ['preserved', '', '-1', '01', '99']) { h.input().value = token; h.input().listeners.change(); }
  assert.equal(h.state.mutations, 0); assert.equal(h.node.data.packageValues.model, 'old.safetensors');
  h.input().value = '0'; h.input().listeners.change();
  assert.equal(h.node.data.packageValues.model, 'new.safetensors'); assert.equal(h.state.mutations, 1); assert.deepEqual(h.state.errors, []);
});

test('directory restoration does not select first model or modify field identity and stored value', () => {
  const h = harness('old.safetensors');
  h.definition.options = ['first.safetensors', 'old.safetensors']; h.sandbox.renderInspector();
  assert.equal(h.input().value, '1'); assert.equal(h.definition.id, 'model'); assert.equal(h.node.data.packageValues.model, 'old.safetensors'); assert.equal(h.state.mutations, 0);
  h.definition.options = ['first.safetensors']; h.sandbox.renderInspector();
  assert.equal(h.input().value, 'preserved'); assert.equal(h.node.data.packageValues.model, 'old.safetensors'); assert.equal(h.state.mutations, 0);
});

test('missing declaration is distinct from proved empty static directory', () => {
  assert.equal(selectFieldState({ type: 'select' }, '').state, 'unproven');
  assert.equal(selectFieldState({ type: 'select', options: [] }, '').state, 'empty');
  assert.equal(selectFieldState({ type: 'select', options: null }, false).state, 'unproven');
  assert.match(selectFieldState({ type: 'select' }, '').help, /管理外部接口.*重新编译候选/);
});

for (const value of ['', false, 0, 1.5]) test(`enum display and explicit choice preserve scalar type ${JSON.stringify(value)}`, () => {
  const h = harness(value, [value]); assert.equal(h.input().value, '0');
  h.input().listeners.change(); assert.equal(h.node.data.packageValues.model, value);
  assert.equal(typeof h.node.data.packageValues.model, typeof value);
  assert.equal(coerceEditorFieldValue({ type: 'select', options: [] }, value, { previousValue: value, allowPreservedLiteral: true }), value);
  assert.throws(() => coerceFieldValue({ type: 'select', options: [] }, value), /不在可选值/);
});

test('editing exception only preserves identical safe previous literal and never authorizes new invalid value', () => {
  const definition = { id: 'model', type: 'select', options: [] };
  assert.equal(coerceEditorFieldValue(definition, 'old', { previousValue: 'old', allowPreservedLiteral: true }), 'old');
  assert.throws(() => coerceEditorFieldValue(definition, 'other', { previousValue: 'old', allowPreservedLiteral: true }), /不在可选值/);
  assert.throws(() => coerceEditorFieldValue(definition, 'old', { previousValue: 'old' }), /不在可选值/);
  for (const value of [null, undefined, {}, [], Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, 'x'.repeat(64001)]) {
    assert.equal(isSafeSelectLiteral(value), false);
    assert.throws(() => coerceEditorFieldValue(definition, value, { previousValue: value, allowPreservedLiteral: true }));
  }
  assert.throws(() => validateValues([definition], { model: 'old' }), /不在可选值/);
});

test('receipt retains empty-directory own scalar as pending without converting select to text', () => {
  const field = { id: 'model', node_id: '1', input: 'unet_name', type: 'select', role: 'model', options: [] };
  const result = preflightPresetInterfaceMigration({ fields: [field], receipt: [{ logical_id: 'models.dit', type: 'select', targets: [{ node_id: '1', input: 'unet_name', type: 'select' }] }], own_values: { 'models.dit': 'old.safetensors' } });
  assert.equal(result.ok, true); assert.equal(result.stored_own_values.model, 'old.safetensors'); assert.deepEqual(result.value_updates, []);
  assert(result.pending.some(item => item.reason === 'selection_unverified')); assert.equal(field.type, 'select'); assert.deepEqual(field.options, []);
});
