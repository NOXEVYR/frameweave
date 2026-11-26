import test from 'node:test';
import assert from 'node:assert/strict';
import { activeMissingFields, chooseMissingInputValues, repairInterfaceInputs } from '../web/interface-repair.mjs';

// Small event/DOM harness, following the existing interface interaction tests.
// No browser, service, uploads or generation are involved.
class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = new Map();
    this.attributes = {}; this.value = ''; this.textContent = ''; this.disabled = false;
  }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  emit(name, extra = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const callback of this.listeners.get(name) || []) callback(event);
    return event;
  }
  click() { if (!this.disabled) { this.onclick?.({ target: this }); this.emit('click'); } }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
}
const flatten = root => [root, ...root.children.flatMap(flatten)];
function dom() {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const body = new Element('body');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { body, createElement: tag => new Element(tag) } });
  const all = () => flatten(body);
  return {
    body, all,
    aria: label => all().find(item => item.attributes['aria-label'] === label),
    button: label => all().find(item => item.tagName === 'button' && item.textContent === label),
    restore() {
      for (const item of [...body.children]) if (item.tagName === 'dialog') item.emit('cancel');
      if (old) Object.defineProperty(globalThis, 'document', old); else delete globalThis.document;
    },
  };
}
const field = (id, type = 'text', extra = {}) => ({ id, node_id: 'A', input: id, label: id, type, required: true, ...extra });
const selection = (fields = [], output_nodes = ['out-A']) => ({ fields, output_nodes, rebindings: {}, output_rebindings: {} });
const info = (missing_fields = [], fields = [], nodes = ['A']) => ({
  prompt: { A: { class_type: 'Params', inputs: { preserved: 'original' } } },
  fields, missing_fields, missing_issues: [], execution: { node_ids: nodes },
});
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
const unreachable = () => assert.fail('unexpected operation');

test('only missing fields in the selected execution nodes are repair candidates', () => {
  const a = field('a'), b = field('b', 'text', { node_id: 'B' });
  assert.deepEqual(activeMissingFields(info([a, b])), [a]);
  assert.deepEqual(activeMissingFields(info([a, b], [], ['B'])), [b]);
  assert.deepEqual(activeMissingFields({ missing_fields: [a] }), []);
});

test('an interface without missing inputs performs no repair or reconfirmation', async () => {
  const original = freeze(info()), chosen = freeze(selection());
  const result = await repairInterfaceInputs({ info: original, selection: chosen,
    inspect: unreachable, chooseValues: unreachable, chooseFields: unreachable });
  assert.equal(result.info, original); assert.equal(result.selection, chosen);
  assert.deepEqual(result.missing_values, {});
});

test('inactive missing branch is preserved without prompting for values or choosing defaults', async () => {
  const inactive = field('b', 'select', { node_id: 'B', options: ['first', 'second'], default: 'first' });
  const original = freeze(info([inactive]));
  const chosen = freeze(selection());
  let inspected;
  const result = await repairInterfaceInputs({ info: original, selection: chosen,
    inspect: async request => { inspected = structuredClone(request); return original; },
    chooseValues: unreachable, chooseFields: unreachable });
  assert.deepEqual(inspected, { output_nodes: ['out-A'], missing_values: {} });
  assert.equal(result.info, original); assert.deepEqual(result.missing_values, {});
  assert.equal(Object.hasOwn(original.prompt.A.inputs, 'b'), false);
});

test('cancel before repairing returns no applicable result and leaves source and selection intact', async () => {
  const original = freeze(info([field('seed', 'integer')])), chosen = freeze(selection());
  const before = JSON.stringify({ original, chosen }); let applyCount = 0;
  const result = await repairInterfaceInputs({ info: original, selection: chosen,
    inspect: async () => original, chooseValues: async () => null, chooseFields: unreachable });
  if (result) applyCount++;
  assert.equal(result, null); assert.equal(applyCount, 0);
  assert.equal(JSON.stringify({ original, chosen }), before);
});

test('dynamic selectors and children are cumulatively replayed against the original source', async () => {
  const format = field('format', 'select', { options: ['mp4', 'webm'] });
  const codec = field('codec', 'select', { input: 'format.codec', options: ['auto', 'av1'] });
  const quality = field('quality', 'number', { input: 'format.codec.quality', min: 0, max: 63, default: 23 });
  const source = info([format]);
  source.prompt.A.plugin_data = { preserve: ['unknown', { value: false }] };
  source.prompt.B = { class_type: 'UnavailableExtension', inputs: { existing_link: ['A', 0], name: 'unselected.png' } };
  const original = freeze(source); const before = JSON.stringify(original);
  const inspectRequests = [], offered = []; let confirmCount = 0;
  const result = await repairInterfaceInputs({ info: original, selection: freeze(selection()),
    inspect: async request => {
      inspectRequests.push(structuredClone(request));
      const values = request.missing_values, prompt = structuredClone(original.prompt);
      for (const candidate of [format, codec, quality]) if (Object.hasOwn(values, candidate.id)) prompt.A.inputs[candidate.input] = values[candidate.id];
      const missing = !Object.hasOwn(values, 'format') ? [format] : !Object.hasOwn(values, 'codec') ? [codec] : !Object.hasOwn(values, 'quality') ? [quality] : [];
      return { ...info(missing, [format, codec, quality].filter(item => Object.hasOwn(values, item.id))), prompt };
    },
    chooseValues: async fields => {
      offered.push(fields.map(item => item.input));
      return fields[0].id === 'format' ? { format: 'webm' } : fields[0].id === 'codec' ? { codec: 'av1' } : { quality: '0' };
    },
    chooseFields: async (current, previous) => {
      confirmCount++; assert.deepEqual(current.missing_fields, []);
      assert.deepEqual(previous.fields.map(item => item.id), ['format', 'codec', 'quality']);
      return { ...previous, fields: [current.fields[1]], rebindings: { old: 'codec' } };
    },
  });
  assert.deepEqual(offered, [['format'], ['format.codec'], ['format.codec.quality']]);
  assert.deepEqual(inspectRequests.map(request => request.missing_values), [
    {}, { format: 'webm' }, { format: 'webm', codec: 'av1' },
    { format: 'webm', codec: 'av1', quality: 0 }, { format: 'webm', codec: 'av1', quality: 0 },
  ]);
  assert.equal(confirmCount, 1);
  assert.deepEqual(result.missing_values, { format: 'webm', codec: 'av1', quality: 0 });
  assert.deepEqual(result.selection.fields.map(item => item.id), ['codec']);
  assert.deepEqual(result.selection.rebindings, { old: 'codec' });
  assert.equal(result.info.prompt.A.inputs.preserved, 'original');
  assert.deepEqual(result.info.prompt.A.plugin_data, original.prompt.A.plugin_data);
  assert.deepEqual(result.info.prompt.B, original.prompt.B);
  assert.equal(JSON.stringify(original), before);
});

test('switching outputs withdraws old branch repairs and repairs only the newly active branch', async () => {
  const a = field('a', 'integer'), b = field('b', 'boolean', { node_id: 'B' });
  const original = freeze(info([a, b])); const requests = [], offered = [], notices = []; let confirmation = 0;
  const result = await repairInterfaceInputs({ info: original, selection: selection(),
    inspect: async request => {
      requests.push(structuredClone(request));
      const missing = [a, b].filter(item => !Object.hasOwn(request.missing_values, item.id));
      return info(missing, [a, b].filter(item => Object.hasOwn(request.missing_values, item.id)),
        request.output_nodes.includes('out-B') ? ['B'] : ['A']);
    },
    chooseValues: async fields => { offered.push(fields.map(item => item.id)); return fields[0].id === 'a' ? { a: 0 } : { b: false }; },
    chooseFields: async (current, previous) => { confirmation++; return { ...previous, fields: current.fields, output_nodes: ['out-B'] }; },
    notify: message => notices.push(message),
  });
  assert.deepEqual(offered, [['a'], ['b']]); assert.equal(confirmation, 2);
  assert.deepEqual(result.missing_values, { b: false });
  assert.deepEqual(result.selection.output_nodes, ['out-B']);
  assert.deepEqual(requests[2], { output_nodes: ['out-B'], missing_values: {} });
  assert(requests.slice(2).every(request => !Object.hasOwn(request.missing_values, 'a')));
  assert.equal(notices.length, 1); assert.match(notices[0], /补充值已撤回/);
  assert.equal(Object.hasOwn(original.prompt.A.inputs, 'a'), false);
});

test('expanding outputs probes the original scope first then replays repairs for still-active nodes', async () => {
  const a = field('a', 'integer'), b = field('b', 'boolean', { node_id: 'B' });
  const original = freeze(info([a, b])); const requests = [], offered = [];
  const result = await repairInterfaceInputs({ info: original, selection: selection(),
    inspect: async request => {
      requests.push(structuredClone(request));
      return info([a, b].filter(item => !Object.hasOwn(request.missing_values, item.id)),
        [a, b].filter(item => Object.hasOwn(request.missing_values, item.id)),
        request.output_nodes.includes('out-B') ? ['A', 'B'] : ['A']);
    },
    chooseValues: async fields => { offered.push(fields.map(item => item.id)); return fields[0].id === 'a' ? { a: 0 } : { b: false }; },
    chooseFields: async (_current, previous) => ({ ...previous, output_nodes: ['out-A', 'out-B'] }),
    notify: unreachable,
  });
  assert.deepEqual(offered, [['a'], ['b']]);
  assert.deepEqual(requests.slice(2, 4), [
    { output_nodes: ['out-A', 'out-B'], missing_values: {} },
    { output_nodes: ['out-A', 'out-B'], missing_values: { a: 0 } },
  ]);
  assert.deepEqual(result.missing_values, { a: 0, b: false });
});

test('cancel at the required field reconfirmation never produces an apply result', async () => {
  const original = freeze(info([field('enabled', 'boolean')])); let inspectCount = 0;
  const result = await repairInterfaceInputs({ info: original, selection: selection(),
    inspect: async request => { inspectCount++; return Object.hasOwn(request.missing_values, 'enabled') ? info([], [field('enabled', 'boolean')]) : original; },
    chooseValues: async () => ({ enabled: false }), chooseFields: async () => null });
  assert.equal(result, null); assert.equal(inspectCount, 2);
  assert.deepEqual(original.prompt.A.inputs, { preserved: 'original' });
});

test('empty, unknown and already supplied repair values cannot silently advance', async () => {
  for (const chosen of [{}, { other: 1 }]) {
    const original = info([field('seed', 'integer')]); let inspectCount = 0;
    await assert.rejects(repairInterfaceInputs({ info: original, selection: selection(),
      inspect: async () => { inspectCount++; return original; }, chooseValues: async () => chosen, chooseFields: unreachable }), /至少一项|缺失输入已改变/);
    assert.equal(inspectCount, 1);
  }
  const original = info([field('seed', 'integer')]); let calls = 0;
  await assert.rejects(repairInterfaceInputs({ info: original, selection: selection(), inspect: async () => original,
    chooseValues: async () => { calls++; return { seed: 0 }; }, chooseFields: unreachable }), /缺失输入已改变/);
  assert.equal(calls, 2);
});

test('a stale canvas guard stops repair after inspection before opening the values form', async () => {
  const original = info([field('seed', 'integer')]); let stale = false;
  await assert.rejects(repairInterfaceInputs({ info: original, selection: selection(),
    ensureCurrent: () => { if (stale) throw new Error('canvas changed'); },
    inspect: async () => { stale = true; return original; }, chooseValues: unreachable, chooseFields: unreachable }), /canvas changed/);
});

test('missing form leaves enums, booleans and schema defaults unset until explicitly chosen', async () => {
  const ui = dom(), fields = freeze([field('mode', 'select', { options: ['fast', 'slow'], default: 'fast' }),
    field('enabled', 'boolean', { default: false }), field('seed', 'integer', { default: 0 })]);
  try {
    const choosing = chooseMissingInputValues(fields);
    for (const id of ['mode', 'enabled', 'seed']) assert.equal(ui.aria(id).value, '');
    assert.equal(ui.aria('mode').children[0].value, '');
    ui.button('补齐并重新检查').click();
    assert.equal(ui.body.children.length, 1);
    assert.match(ui.all().find(item => item.attributes.role === 'alert').textContent, /不会自动选择默认值/);
    ui.button('取消，保留原工作流').click();
    assert.equal(await choosing, null); assert.equal(ui.body.children.length, 0);
  } finally { ui.restore(); }
});

test('explicit UI choices preserve typed false, numeric zero and enum zero', async () => {
  const ui = dom();
  try {
    const choosing = chooseMissingInputValues([field('enabled', 'boolean'), field('seed', 'integer', { min: 0 }),
      field('choice', 'select', { options: [false, 0, '0'] })]);
    ui.aria('enabled').value = '1'; ui.aria('seed').value = '0'; ui.aria('choice').value = '1';
    ui.button('补齐并重新检查').click();
    assert.deepEqual(await choosing, { enabled: false, seed: 0, choice: 0 });
    assert.equal(ui.body.children.length, 0);
  } finally { ui.restore(); }
});

test('schema defaults are applied only by their explicit buttons and untouched fields remain absent', async () => {
  const ui = dom();
  try {
    const choosing = chooseMissingInputValues([field('enabled', 'boolean', { default: false }),
      field('mode', 'select', { options: ['first', 'second'], default: 'second' }), field('seed', 'integer', { default: 0 })]);
    ui.button('填入节点声明默认值：false').click(); ui.button('填入节点声明默认值：0').click();
    assert.equal(ui.aria('mode').value, '');
    ui.button('补齐并重新检查').click();
    assert.deepEqual(await choosing, { enabled: false, seed: 0 });
  } finally { ui.restore(); }
});

test('invalid numeric values keep the form open without returning a repaired contract', async () => {
  const ui = dom();
  try {
    const choosing = chooseMissingInputValues([field('seed', 'integer', { min: 0, max: 10 })]);
    ui.aria('seed').value = '1.5'; ui.button('补齐并重新检查').click();
    assert.equal(ui.body.children.length, 1);
    assert.match(ui.all().find(item => item.attributes.role === 'alert').textContent, /整数/);
    ui.aria('seed').value = '11'; ui.button('补齐并重新检查').click();
    assert.match(ui.all().find(item => item.attributes.role === 'alert').textContent, /范围/);
    ui.button('取消，保留原工作流').click(); assert.equal(await choosing, null);
  } finally { ui.restore(); }
});

test('close and Escape cancel the form and remove the dialog without any defaults', async () => {
  for (const mode of ['close', 'escape']) {
    const ui = dom();
    try {
      const choosing = chooseMissingInputValues([field('mode', 'select', { options: ['first'], default: 'first' })]);
      if (mode === 'close') ui.aria('关闭').click();
      else assert.equal(ui.body.children[0].emit('cancel').defaultPrevented, true);
      assert.equal(await choosing, null); assert.equal(ui.body.children.length, 0);
    } finally { ui.restore(); }
  }
});

test('more than 64 missing controls are repaired across bounded forms and then reconfirmed', async () => {
  const ui = dom(), fields = Array.from({ length: 65 }, (_, index) => field(`f${index}`, 'integer'));
  const original = freeze(info(fields)); const pages = [], inspected = []; let confirms = 0;
  try {
    const result = await repairInterfaceInputs({ info: original, selection: selection(),
      inspect: async request => {
        inspected.push(structuredClone(request));
        return info(fields.filter(item => !Object.hasOwn(request.missing_values, item.id)),
          fields.filter(item => Object.hasOwn(request.missing_values, item.id)));
      },
      chooseValues: async remaining => {
        const choosing = chooseMissingInputValues(remaining);
        const controls = ui.all().filter(item => item.tagName === 'input'); pages.push(controls.length);
        assert(controls.length <= 64);
        if (remaining.length === 65) {
          assert.equal(ui.aria('f64'), undefined);
          assert(ui.all().some(item => /共 65 项，先处理前 64 项/.test(item.textContent)));
        }
        for (const control of controls) control.value = '0';
        ui.button('补齐并重新检查').click(); return choosing;
      },
      chooseFields: async (_current, previous) => { confirms++; assert.equal(previous.fields.length, 65); return { ...previous, fields: previous.fields.slice(0, 64) }; },
    });
    assert.deepEqual(pages, [64, 1]); assert.equal(confirms, 1);
    assert.equal(Object.keys(result.missing_values).length, 65);
    assert(Object.values(result.missing_values).every(value => value === 0));
    assert.equal(result.selection.fields.length, 64);
    assert.deepEqual(inspected.map(request => Object.keys(request.missing_values).length), [0, 64, 65, 65]);
    assert.equal(ui.body.children.length, 0);
    assert.deepEqual(original.prompt.A.inputs, { preserved: 'original' });
  } finally { ui.restore(); }
});
