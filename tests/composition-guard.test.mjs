import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createCompositionGuard } from '../web/composition-guard.mjs';

// Native Node events exercise listener delivery and default-prevention behavior.
// A delegated composition event identifies its originating control via target.
class TestDocument extends EventTarget {
  added = [];
  removed = [];
  addEventListener(type, callback, options) {
    this.added.push({ type, callback, capture: options === true || !!options?.capture });
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback, options) {
    this.removed.push({ type, callback, capture: options === true || !!options?.capture });
    super.removeEventListener(type, callback, options);
  }
}

function control(document, id = 'prompt') {
  return { ownerDocument: document, id, blurCalls: 0, focusCalls: 0,
    blur() { this.blurCalls++; }, focus() { this.focusCalls++; } };
}

function event(type, source, properties = {}) {
  const result = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(result, 'target', { configurable: true, value: source });
  return Object.assign(result, properties);
}

function emit(document, type, source, properties) {
  const dispatched = event(type, source, properties);
  document.dispatchEvent(dispatched);
  return dispatched;
}

function fixture(t) {
  const document = new TestDocument(), guard = createCompositionGuard(document);
  t.after(() => guard.destroy());
  return { document, guard, field: control(document), other: control(document) };
}

test('an idle document and its controls are available for guarded actions', t => {
  const { guard, field, other } = fixture(t);
  assert.equal(guard.active(), false);
  assert.equal(guard.active(field), false);
  assert.equal(guard.active(other), false);
  assert.equal(guard.assert(), true);
});

test('overlapping compositions use control identity, even when field IDs match', t => {
  const { document, guard, field, other } = fixture(t);
  assert.equal(field.id, other.id);
  emit(document, 'compositionstart', field);
  emit(document, 'compositionstart', other);
  emit(document, 'compositionend', field);
  assert.equal(guard.active(field), false);
  assert.equal(guard.active(other), true);
  assert.equal(guard.active(), true);
  assert.throws(() => guard.assert(), error => error.code === 'busy');
  emit(document, 'compositionend', other);
  assert.equal(guard.active(), false);
  assert.equal(guard.assert(), true);
});

test('repeated starts from one control require only its actual end', t => {
  const { document, guard, field } = fixture(t);
  emit(document, 'compositionstart', field);
  emit(document, 'compositionstart', field);
  emit(document, 'compositionstart', field);
  assert.equal(guard.active(field), true);
  emit(document, 'compositionend', field);
  assert.equal(guard.active(), false);
});

test('an unmatched end neither creates state nor clears another control', t => {
  const { document, guard, field, other } = fixture(t);
  emit(document, 'compositionend', other);
  assert.equal(guard.active(), false);
  emit(document, 'compositionstart', field);
  emit(document, 'compositionend', other);
  assert.equal(guard.active(field), true);
  assert.equal(guard.active(other), false);
});

test('an empty or cancelled candidate remains guarded until compositionend', t => {
  const { document, guard, field } = fixture(t);
  emit(document, 'compositionstart', field);
  emit(document, 'compositionupdate', field, { data: '' });
  emit(document, 'input', field, { data: '', isComposing: false, inputType: 'deleteCompositionText' });
  assert.equal(guard.active(field), true);
  assert.throws(() => guard.assert(), error => error.code === 'busy');
  emit(document, 'compositionend', field, { data: '' });
  assert.equal(guard.active(field), false);
});

test('blur, focusout, visibility, Escape and event-loop turns do not cancel composition', async t => {
  const { document, guard, field } = fixture(t);
  emit(document, 'compositionstart', field);
  for (const type of ['blur', 'focusout', 'focusin', 'visibilitychange', 'pointercancel']) {
    emit(document, type, field);
    assert.equal(guard.active(field), true, type);
  }
  emit(document, 'keydown', field, { key: 'Escape', code: 'Escape', isComposing: true });
  emit(document, 'keyup', field, { key: 'Escape', code: 'Escape', isComposing: false });
  await setImmediate();
  assert.equal(guard.active(field), true);
  assert.equal(field.blurCalls, 0);
  assert.equal(field.focusCalls, 0);
});

test('capture observation preserves the original event and delivers existing handlers once', t => {
  const document = new TestDocument(), field = control(document), calls = [];
  for (const type of ['compositionstart', 'compositionend']) {
    document.addEventListener(type, () => calls.push(`existing:${type}`), true);
  }
  const registrationStart = document.added.length;
  const guard = createCompositionGuard(document);
  t.after(() => guard.destroy());
  const registrations = document.added.slice(registrationStart);
  assert.deepEqual(registrations.map(({ type, capture }) => ({ type, capture })), [
    { type: 'compositionstart', capture: true }, { type: 'compositionend', capture: true },
  ]);
  for (const type of ['compositionstart', 'compositionend']) {
    document.addEventListener(type, () => calls.push(`following:${type}`));
  }
  for (const type of ['compositionstart', 'compositionend']) {
    const original = event(type, field), interventions = [];
    for (const name of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) {
      const nativeMethod = original[name].bind(original);
      original[name] = () => { interventions.push(name); nativeMethod(); };
    }
    assert.equal(document.dispatchEvent(original), true);
    assert.equal(original.defaultPrevented, false);
    assert.deepEqual(interventions, []);
    assert.equal(guard.active(field), type === 'compositionstart');
  }
  assert.deepEqual(calls, ['existing:compositionstart', 'following:compositionstart',
    'existing:compositionend', 'following:compositionend']);
  assert.equal(field.blurCalls, 0);
  assert.equal(field.focusCalls, 0);
});

test('assert exposes a busy error without committing or clearing the active composition', t => {
  const { document, guard, field } = fixture(t);
  emit(document, 'compositionstart', field);
  assert.throws(() => guard.assert('Finish the candidate first'), error => {
    assert.equal(error.message, 'Finish the candidate first');
    assert.equal(error.code, 'busy');
    return true;
  });
  assert.equal(guard.active(field), true);
  assert.equal(field.blurCalls, 0);
  emit(document, 'compositionend', field);
  assert.equal(guard.assert('Finish the candidate first'), true);
});

test('destroy unregisters capture listeners once and makes retained callbacks inert', () => {
  const document = new TestDocument(), field = control(document), guard = createCompositionGuard(document);
  const retained = [...document.added];
  emit(document, 'compositionstart', field);
  guard.destroy();
  guard.destroy();
  assert.deepEqual(document.removed, retained);
  assert.equal(guard.active(), false);
  emit(document, 'compositionstart', field);
  for (const { type, callback } of retained) {
    callback(event(type, field));
    assert.equal(guard.active(field), false, `late ${type}`);
  }
  assert.equal(guard.active(field), false);
  assert.equal(guard.assert(), true);
});

test('a replacement guard is unaffected by the destroyed guard’s late callbacks', t => {
  const document = new TestDocument(), field = control(document), old = createCompositionGuard(document);
  const retained = [...document.added];
  old.destroy();
  const current = createCompositionGuard(document);
  t.after(() => current.destroy());
  emit(document, 'compositionstart', field);
  for (const { type, callback } of retained) {
    callback(event(type, field));
    assert.equal(old.active(), false, `late ${type}`);
    assert.equal(current.active(field), true);
  }
  assert.equal(old.active(), false);
  assert.equal(current.active(field), true);
  emit(document, 'compositionend', field);
  assert.equal(current.active(), false);
});

test('the default document is resolved when the guard is created', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const document = new TestDocument(), field = control(document);
  let guard;
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: document });
    guard = createCompositionGuard();
    emit(document, 'compositionstart', field);
    assert.equal(guard.active(field), true);
    emit(document, 'compositionend', field);
    assert.equal(guard.active(), false);
  } finally {
    guard?.destroy();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
});

test('compositions and destruction in one document do not affect another document', t => {
  const firstDocument = new TestDocument(), secondDocument = new TestDocument();
  const first = createCompositionGuard(firstDocument), second = createCompositionGuard(secondDocument);
  t.after(() => { first.destroy(); second.destroy(); });
  const firstField = control(firstDocument), secondField = control(secondDocument);
  emit(firstDocument, 'compositionstart', firstField);
  assert.equal(second.active(), false);
  emit(secondDocument, 'compositionstart', secondField);
  emit(firstDocument, 'compositionend', firstField);
  assert.equal(second.active(secondField), true);
  first.destroy();
  assert.equal(second.active(secondField), true);
  assert.throws(() => second.assert(), error => error.code === 'busy');
  emit(secondDocument, 'compositionend', secondField);
  assert.equal(second.active(), false);
});
