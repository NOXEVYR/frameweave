import test from 'node:test';
import assert from 'node:assert/strict';
import { contentGrowthPositions, createContentLayout } from '../web/canvas-content-layout.mjs';
const rect = (id, x, y, height = 100) => ({ id, x, y, width: 100, height });

test('multiple growing owners and staggered chains solve together, independent of input order', () => {
  const before = [rect('a', 0, 0), rect('b', 70, 136), rect('c', 140, 272), rect('far', 400, 136)];
  const current = before.map(r => ({ ...r, height: ['a', 'b'].includes(r.id) ? 200 : r.height }));
  assert.deepEqual(contentGrowthPositions(before, current), [{ id: 'b', x: 70, y: 236 }, { id: 'c', x: 140, y: 472 }]);
  assert.deepEqual(contentGrowthPositions(before.reverse(), current.reverse()), [{ id: 'b', x: 70, y: 236 }, { id: 'c', x: 140, y: 472 }]);
});
test('old overlap remains untouched while newly invaded separate neighbours move', () => {
  const before = [rect('a', 0, 0), rect('overlap', 0, 50), rect('below', 0, 180), rect('above', 0, -100)];
  assert.deepEqual(contentGrowthPositions(before, before.map(r => r.id === 'a' ? { ...r, height: 300 } : r)), [{ id: 'below', x: 0, y: 336 }]);
  assert.deepEqual(contentGrowthPositions(before, before), []);
  assert.deepEqual(contentGrowthPositions(before, before.map(r => ({ ...r, height: 50 }))), []);
});

test('a later growing branch cannot push a card into an earlier displaced branch', () => {
  const before = [rect('root', 50, 0), rect('a', 0, 136), rect('b', -100, 272), rect('d', -50, 408)];
  const current = before.map(rect => ({ ...rect, height: rect.id === 'root' ? 1100 : rect.id === 'b' ? 800 : rect.height }));
  assert.deepEqual(contentGrowthPositions(before, current), [{ id: 'a', x: 0, y: 1136 }, { id: 'd', x: -50, y: 1272 }]);
});
test('a whole multi-owner plan fails before applying any coordinate at the boundary', () => {
  const before = [rect('a', 0, 0), rect('b', 0, 136), rect('x', 400, 9999700), rect('y', 400, 9999900)];
  const current = before.map(r => ['a', 'x'].includes(r.id) ? { ...r, height: 500 } : r);
  const original = structuredClone(before);
  assert.throws(() => contentGrowthPositions(before, current), /坐标边界/);
  assert.deepEqual(before, original);
});

function harness() {
  const nodes = [rect('a', 0, 0), rect('b', 0, 136), rect('side', 400, 136)];
  nodes.forEach(node => { node.node = {}; node.element = {}; });
  const frames = [], commits = [], errors = [], observations = new Set();
  let observerCallback, isBusy = false, canvas = 'first';
  const layout = createContentLayout({ read: () => nodes, identity: () => canvas,
    apply: positions => positions.forEach(position => Object.assign(nodes.find(n => n.id === position.id), position)),
    commit: previous => commits.push(previous), busy: () => isBusy, onError: error => errors.push(error),
    schedule: callback => frames.push(callback), observe: callback => {
      observerCallback = callback;
      return { observe: element => observations.add(element), unobserve: element => observations.delete(element), disconnect: () => observations.clear() };
    },
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  return { nodes, layout, commits, errors, frames, observations, notify: () => observerCallback(), flush,
    busy: value => { isBusy = value; }, identity: value => { canvas = value; } };
}
test('observer batches growth once, follows current manual coordinates, then remains stable', () => {
  const h = harness(); h.layout.rendered(); h.nodes[0].height = 200;
  h.notify(); h.notify(); assert.equal(h.frames.length, 1);
  h.nodes[1].y = 210; h.flush();
  assert.deepEqual(h.commits, [[{ id: 'b', x: 0, y: 210 }]]); assert.equal(h.nodes[1].y, 236);
  for (let i = 0; i < 50; i++) { h.notify(); h.flush(); }
  assert.equal(h.nodes[1].y, 236); assert.equal(h.commits.length, 1);
  h.nodes[0].height = 100; h.notify(); h.flush(); assert.equal(h.nodes[1].y, 236);
});
test('editing defers asynchronous growth until release without polling or overwriting a moved neighbour', () => {
  const h = harness(); h.layout.rendered(); h.busy(true); h.nodes[0].height = 200; h.notify(); h.layout.rendered();
  assert.equal(h.frames.length, 0); assert.equal(h.nodes[1].y, 136); assert.equal(h.commits.length, 0);
  h.nodes[1].x = 400; h.busy(false); h.layout.resume(); h.flush();
  assert.equal(h.nodes[1].x, 400); assert.equal(h.nodes[1].y, 136); assert.equal(h.commits.length, 0);
});
test('synchronous growth belongs to caller history; reset, replacements and identities only establish baselines', () => {
  const h = harness(); h.layout.rendered(); h.layout.begin(); h.nodes[0].height = 200; h.layout.rendered(); h.layout.end();
  assert.equal(h.nodes[1].y, 236); assert.equal(h.commits.length, 0);
  h.layout.reset(); h.nodes[1].y = 136; h.layout.rendered(); h.notify(); h.flush(); assert.equal(h.nodes[1].y, 136);
  h.nodes[0].node = {}; h.nodes[0].height = 300; h.layout.rendered(); assert.equal(h.nodes[1].y, 136);
  h.identity('second'); h.nodes[0].height = 400; h.layout.rendered(); assert.equal(h.nodes[1].y, 136);
});
test('asynchronous boundary errors accept factual content once; synchronous errors remain atomic', () => {
  const h = harness(); h.nodes[0].y = 9999700; h.nodes[1].y = 9999900; h.layout.rendered(); h.nodes[0].height = 500;
  h.notify(); h.flush(); assert.equal(h.errors.length, 1); assert.equal(h.commits.length, 0); assert.equal(h.nodes[1].y, 9999900);
  h.notify(); h.flush(); assert.equal(h.errors.length, 1);
  h.layout.reset(); h.nodes[0].height = 100; h.layout.rendered(); h.layout.begin(); h.nodes[0].height = 500;
  assert.throws(() => h.layout.rendered(), /坐标边界/); assert.equal(h.nodes[1].y, 9999900); h.layout.end();
});

test('validated graph replacement inside one same-canvas synchronous transaction migrates stable-ID measurements', () => {
  const h = harness(); h.layout.rendered(); h.layout.begin();
  h.nodes.forEach(rect => { rect.node = {}; rect.element = {}; }); h.nodes[0].height = 250;
  h.layout.rendered(); h.layout.end();
  assert.equal(h.nodes[1].y, 286); assert.equal(h.commits.length, 0);
  h.layout.begin(); h.identity('new-import'); h.nodes[0].node = {}; h.nodes[0].height = 400; h.nodes[1].y = 136;
  h.layout.rendered(); h.layout.end(); assert.equal(h.nodes[1].y, 136);
});

test('zoom absorbs layout rounding but keeps deferred content growth until editing ends', () => {
  const h = harness(); h.layout.rendered(); h.busy(true);
  h.nodes[0].height = 200; h.notify();
  let viewBefore = h.layout.captureViewChange(); h.nodes[0].height = 206; h.layout.rebase(viewBefore);
  viewBefore = h.layout.captureViewChange(); h.nodes[0].height = 203; h.layout.rebase(viewBefore);
  h.notify(); h.flush(); assert.equal(h.nodes[1].y, 136); assert.equal(h.commits.length, 0);
  h.busy(false); h.layout.resume(); h.flush();
  assert.equal(h.nodes[1].y, 239); assert.equal(h.commits.length, 1);
  viewBefore = h.layout.captureViewChange(); h.nodes[0].height = 209; h.layout.rebase(viewBefore);
  h.notify(); h.flush(); assert.equal(h.nodes[1].y, 239); assert.equal(h.commits.length, 1);
});

test('view changes retain not-yet-observed growth, but never transfer it to a replacement or another canvas', () => {
  const h = harness(); h.layout.rendered(); h.nodes[0].height = 200;
  let viewBefore = h.layout.captureViewChange(); h.nodes[0].height = 206; h.layout.rebase(viewBefore); h.flush();
  assert.equal(h.nodes[1].y, 242); assert.equal(h.commits.length, 1);
  h.busy(true); h.nodes[0].height = 300; viewBefore = h.layout.captureViewChange();
  h.nodes[0].node = {}; h.nodes[0].height = 400; h.layout.rebase(viewBefore);
  h.busy(false); h.layout.resume(); h.notify(); h.flush(); assert.equal(h.nodes[1].y, 242);
  h.nodes[0].height = 500; viewBefore = h.layout.captureViewChange(); h.identity('new-canvas');
  h.layout.rebase(viewBefore); h.notify(); h.flush(); assert.equal(h.nodes[1].y, 242); assert.equal(h.commits.length, 1);
});
