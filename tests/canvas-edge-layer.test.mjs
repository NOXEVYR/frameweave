import test from 'node:test';
import assert from 'node:assert/strict';
import { createEdgeLayer } from '../web/canvas-edge-layer.mjs';

function harness() {
  let allocations = 0, writes = 0, click;
  const picks = [];
  const layer = {
    children: [],
    addEventListener(type, fn) { assert.equal(type, 'click'); click = fn; },
    replaceChildren(...elements) { this.children = elements; },
    append(element) { this.children.push(element); },
  };
  function make(tag, attributes) {
    allocations++;
    return {
      dataset: { edgeId: attributes['data-edge-id'] },
      classList: { toggle(name, value) { attributes[name] = value; } },
      getAttribute: name => attributes[name],
      setAttribute(name, value) { writes++; attributes[name] = value; },
      remove() { layer.children = layer.children.filter(element => element !== this); },
    };
  }
  const drawing = createEdgeLayer(layer, make, id => picks.push(id));
  return { layer, drawing, picks, counts: () => [allocations, writes],
    pick(target) { click({ target, stopPropagation() {} }); } };
}
const a = { id: 'a', curve: 'A' }, b = { id: 'b', curve: 'B' };

test('redrawing moves only changed paths and keeps hit targets live through reordering and deletion', () => {
  const { layer, drawing, counts, pick, picks } = harness();
  drawing.update([a, b], null, null);
  const [hitA, lineA, hitB, lineB] = layer.children;
  assert.deepEqual(counts(), [4, 4]);
  drawing.update([a, b], 'a', null);
  assert.deepEqual(counts(), [4, 4]);
  assert.equal(lineA.getAttribute('edge-selected'), true);
  pick(hitA); assert.deepEqual(picks, ['a']);
  drawing.update([b, { id: 'a', curve: 'A2' }], 'b', null);
  assert.deepEqual(counts(), [4, 6]);
  assert.deepEqual(layer.children, [hitB, lineB, hitA, lineA]);
  assert.equal(lineA.getAttribute('edge-selected'), false);
  assert.equal(hitA.getAttribute('d'), 'A2');
  drawing.update([b], null, null); pick(hitA); pick(hitB);
  assert.deepEqual(picks, ['a', 'b']);
  drawing.update([], null, null); assert.deepEqual(layer.children, []);
});

test('the connection preview stays last and updates without touching permanent paths', () => {
  const { drawing, layer, counts } = harness();
  drawing.update([a], null, 'draft');
  const preview = layer.children.at(-1);
  drawing.setDraft('changed');
  assert.equal(layer.children.at(-1), preview); assert.deepEqual(counts(), [3, 4]);
  drawing.update([a, b], null, 'changed');
  assert.equal(layer.children.at(-1), preview);
  drawing.setDraft(null); assert.equal(layer.children.length, 4);
  drawing.update([], null, null); assert.equal(layer.children.length, 0);
});
