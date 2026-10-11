import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaTransfers } from '../web/media-transfers.mjs';
import { assertReferenceImportsReady } from '../web/canvas-images.mjs';

test('uploads and failures block only dependent owners until applied or explicitly discarded', () => {
  const transfers = createMediaTransfers();
  const first = transfers.start('canvas:node', 'scene', '场景视频');
  assert.throws(() => transfers.assertReady(['canvas:node']), /正在上传/);
  assert.doesNotThrow(() => transfers.assertReady(['other:node']));
  transfers.fail(first, new Error('network'));
  assert.throws(() => transfers.assertReady(['canvas:node']), /上传失败/);
  const second = transfers.start('canvas:node', 'scene', '新场景视频');
  assert.equal(transfers.finish(first), false);
  transfers.fail(first, new Error('late error'));
  assert.equal(transfers.state('canvas:node', 'scene').status, 'pending');
  assert.equal(transfers.finish(second), true);
  assert.doesNotThrow(() => transfers.assertReady(['canvas:node']));
  const cancelled = transfers.start('canvas:node', 'scene', '取消的素材');
  transfers.discard('canvas:node', 'scene');
  assert.equal(transfers.current(cancelled), false);
});

test('one completed field does not release a different unfinished image/audio/video', () => {
  const transfers = createMediaTransfers();
  const image = transfers.start('node', 'image', '图片');
  transfers.start('node', 'audio', '声音');
  transfers.finish(image);
  assert.throws(() => transfers.assertReady(['node']), /声音/);
});

test('execution scope ignores uploads on inactive fields but does not clear their tickets', () => {
  const transfers = createMediaTransfers();
  const inactive = transfers.start('canvas:node', 'branch_b', '另一分支声音');
  transfers.fail(inactive, new Error('offline'));
  assert.doesNotThrow(() => transfers.assertReady(['canvas:node'], new Map([['canvas:node', new Set(['branch_a'])]])));
  assert.throws(() => transfers.assertReady(['canvas:node'], new Map([['canvas:node', new Set(['branch_b'])]])), /另一分支声音.*上传失败/);
  assert.throws(() => transfers.assertReady(['canvas:node']), /上传失败/);
  assert.equal(transfers.current(inactive), true);
});

test('new preview with old underlying asset blocks all downstream generation and editor preparation', () => {
  const graph = { nodes: [{id:'ref',type:'reference',data:{title:'替换中的人物图',name:'old.png'}},{id:'edit',type:'generation',data:{}},{id:'next',type:'generation',data:{}},{id:'unrelated',type:'generation',data:{}}],edges:[{source:'ref',target:'edit'},{source:'edit',target:'next'}] };
  const imports = new Map([['ref', {previewURL:'blob:new',error:false}]]);
  assert.throws(() => assertReferenceImportsReady(graph,['next'],imports), /尚未成功保存/);
  assert.doesNotThrow(() => assertReferenceImportsReady(graph,['unrelated'],imports));
  imports.set('ref',{error:true});
  assert.throws(() => assertReferenceImportsReady(graph,['edit'],imports), /替换中的人物图/);
  imports.delete('ref');
  assert.doesNotThrow(() => assertReferenceImportsReady(graph,['next'],imports));
});
