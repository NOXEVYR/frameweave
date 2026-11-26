import test from 'node:test';
import assert from 'node:assert/strict';
import { engineBadge } from '../web/engine-badge.mjs';

test('registered offline, catalog failure and missing registration have distinct remedies', () => {
  const badge = state => engineBadge({ connection: { state, name: 'Studio' } }, false);
  assert.match(badge('offline').detail, /随应用启动已关闭/);
  assert.match(badge('starting').label, /启动中/);
  assert.match(badge('catalog_unavailable').label, /节点目录/);
  assert.notEqual(badge('offline').label, badge('unregistered').label);
  assert.match(engineBadge({ online: true, devices: [{ name: 'GPU' }] }).detail, /GPU/);
});
