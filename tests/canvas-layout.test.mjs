import test from 'node:test';
import assert from 'node:assert/strict';
import { findFreePosition, placeFragment, canvasContentArea } from '../web/canvas-layout.mjs';

function separate(first, second, gap = 36) {
  return first.x + first.width + gap <= second.x || second.x + second.width + gap <= first.x || first.y + first.height + gap <= second.y || second.y + second.height + gap <= first.y;
}

test('fitting and centering leave node headers below actual wrapped toolbars and status panels', () => {
  const canvas = { left: 165, top: 124, right: 920, bottom: 720, width: 755, height: 596 };
  const toolbar = { left: 190, top: 242, right: 500, bottom: 286, width: 310, height: 44 };
  const panel = { left: 540, top: 242, right: 900, bottom: 340, width: 360, height: 98 };
  const area = canvasContentArea(canvas, [toolbar, panel]);
  assert.ok(canvas.top + area.y > panel.bottom);
  assert.ok(canvas.top + area.y + area.height <= canvas.bottom - 60);
  const hidden = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const outside = { ...panel, left: 950, right: 1310 };
  assert.deepEqual(canvasContentArea(canvas, [toolbar, hidden, outside]), canvasContentArea(canvas, [toolbar]));
});

test('adding at the same viewport location preserves existing nodes and finds distinct space', () => {
  const occupied = [{ x: 0, y: 0, width: 338, height: 340 }, { x: 400, y: 0, width: 304, height: 480 }];
  const original = structuredClone(occupied);
  const preferred = { x: 120, y: 60 };
  const placed = [];
  for (let index = 0; index < 20; index++) {
    const rect = { ...findFreePosition([...occupied, ...placed], { width: 338, height: 340 }, preferred), width: 338, height: 340 };
    assert.ok([...occupied, ...placed].every(other => separate(rect, other)));
    placed.push(rect);
  }
  assert.deepEqual(occupied, original);
  assert.deepEqual(preferred, { x: 120, y: 60 });
});

test('a reused reference and generation fragment keeps its layout and leaves tall cards clear', () => {
  const occupied = [{ x: 10, y: -80, width: 338, height: 920 }, { x: 390, y: 20, width: 304, height: 440 }];
  const fragment = [{ id: 'generation', x: 350, y: 0, width: 304, height: 440 }, { id: 'start', x: 0, y: 0, width: 286, height: 300 }, { id: 'end', x: 0, y: 340, width: 286, height: 300 }];
  const before = structuredClone(fragment);
  const result = placeFragment(fragment, occupied, { x: 100, y: 0 });
  assert.ok(result.every(rect => occupied.every(other => separate(rect, other))));
  assert.equal(result[0].x - result[1].x, 350);
  assert.equal(result[2].y - result[1].y, 340);
  assert.deepEqual(result.map(rect => rect.id), fragment.map(rect => rect.id));
  assert.deepEqual(fragment, before);
});

test('empty canvases and already clear preferred positions stay where requested', () => {
  assert.deepEqual(findFreePosition([], { width: 304, height: 440 }, { x: -100, y: 200 }), { x: -100, y: 200 });
  assert.deepEqual(findFreePosition([{ x: 0, y: 0, width: 100, height: 100 }], { width: 100, height: 100 }, { x: 136, y: 0 }), { x: 136, y: 0 });
  assert.deepEqual(placeFragment([], [], { x: 0, y: 0 }), []);
});

test('nodes added beside an imported coordinate boundary remain importable', () => {
  const occupied = [{ x: 1e7, y: -1e7, width: 338, height: 340 }];
  const point = findFreePosition(occupied, { width: 338, height: 340 }, { x: 1e7 + 400, y: -1e7 - 50 });
  assert.ok(Math.abs(point.x) <= 1e7 && Math.abs(point.y) <= 1e7);
  assert.ok(separate({ ...point, width: 338, height: 340 }, occupied[0]));
});
