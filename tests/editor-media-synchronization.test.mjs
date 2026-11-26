import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareOwnMediaSynchronization } from '../web/editor-media-synchronization.mjs';

function setup(type = 'image') {
  const field = { id: 'media', type, node_id: '4', input: type, label: '参考素材' };
  const proof = { field_id: field.id, type, origin: 'own', node_id: '4', input: type, class_type: 'Upload', value: `own.${type}`,
    media_owner: { name: `own.${type}`, media_type: type, backend: 'http://127.0.0.1:8188' } };
  let captured = false;
  const h = { current: true, calls: [], mutate: null,
    patches: [{ node_id: '4', widget_name: type, value: proof.value, expected_value: 'old baseline' }, { node_id: '5', widget_name: 'seed', value: 42 }],
    definitions: [field, { id: 'seed', type: 'integer' }], provenance: [proof],
    assertCurrent() { if (!h.current) throw new Error('source changed'); },
    async request(action, args) {
      h.calls.push({ action, args });
      let result;
      if (action === 'compile') result = { output: { 4: { class_type: 'Upload', inputs: { [type]: '' } }, 5: { class_type: 'Sampler', inputs: { seed: 10 } } },
        controls: [{ node_id: '4', input: type, widget_node_id: '4', widget_name: type, ...(captured ? { media_receipt: 'receipt' } : {}) }] };
      else if (action === 'captureMedia') {
        captured = true; result = { captured: [{ field_id: 'media', node_id: '4', input: type, type, receipt: 'receipt', native_value: '', preview_state: 'pending' }], unsupported: [] };
      } else throw new Error('must not patch/upload');
      return h.mutate?.(action, result) || result;
    }, run() { return prepareOwnMediaSynchronization(h); }
  }; return h;
}
for (const type of ['image', 'video', 'audio']) test(`${type} own value gets exact receipt while original fallback and scalar patch remain intact`, async () => {
  const h = setup(type), before = structuredClone(h.patches);
  const result = await h.run();
  assert.equal(result.pending.length, 0); assert.equal(result.patches[0].media_receipt, 'receipt');
  assert.equal(result.patches[0].class_type, 'Upload'); assert.equal(result.patches[0].expected_value, 'old baseline');
  assert.deepEqual(result.patches[1], before[1]); assert.deepEqual(h.patches, before);
  assert.deepEqual(h.calls.map(c => c.action), ['compile', 'captureMedia', 'compile']);
});
test('missing or foreign own proof cannot borrow connected proof; scalar still ready', async () => {
  for (const alter of [h => { h.provenance = []; }, h => { h.provenance[0].origin = 'connected'; }, h => { h.provenance[0].media_owner.name = 'foreign.png'; }, h => { h.provenance.push(structuredClone(h.provenance[0])); }]) {
    const h = setup(); alter(h); const result = await h.run();
    assert.equal(result.pending[0].reason, 'own_media_unproven'); assert.deepEqual(result.patches, [h.patches[1]]); assert.equal(h.calls.length, 0);
  }
});
test('unsupported old bridge defers media only without patching or inventing a receipt', async () => {
  const h = setup(); h.mutate = action => { if (action === 'captureMedia') throw new Error('unsupported'); };
  const result = await h.run(); assert.equal(result.pending[0].reason, 'media_capture_unavailable'); assert.deepEqual(result.patches, [h.patches[1]]);
});
test('source change while capture rejects remains fatal rather than an ordinary unsupported result', async () => {
  const h = setup(); h.mutate = action => { if (action === 'captureMedia') { h.current = false; throw new Error('unsupported'); } };
  await assert.rejects(h.run(), /source changed/);
});
test('capture cannot change another input under the guise of preview isolation', async () => {
  const h = setup(); let count = 0; h.mutate = (action, result) => {
    if (action === 'compile' && ++count === 2) result.output[5].inputs.seed = 20;
    return result;
  }; await assert.rejects(h.run(), /改变了内部工作流/);
});
test('forged, duplicate and stale identity receipts are rejected before any patch', async () => {
  for (const alter of [r => { r.captured[0].receipt = ''; }, r => { r.captured[0].native_value = 'baseline'; },
    r => { r.captured[0].node_id = '5'; }, r => { r.captured.push(structuredClone(r.captured[0])); },
    r => { r.captured[0].type = 'video'; }]) {
    const h = setup(); h.mutate = (action, result) => { if (action === 'captureMedia') alter(result); return result; };
    await assert.rejects(h.run(), /回执与当前内部控件不一致/);
  }
});
test('fresh compile must echo the receipt even if the current filename did not change', async () => {
  const h = setup(); h.mutate = (action, result) => { if (action === 'compile') delete result.controls[0].media_receipt; return result; };
  await assert.rejects(h.run(), /回执与当前内部控件不一致/);
});

for (const enabled of [false,true]) test(`own nested media requires explicit preview capability ${enabled}`, async () => {
  const h=setup(); h.mediaNestedCapture=enabled;
  h.patches[0].node_id=h.definitions[0].node_id=h.provenance[0].node_id='6:4';
  h.mutate=(action,result)=>{
    if(action==='compile'){
      result.output['6:4']=result.output[4];delete result.output[4];
      result.controls[0].node_id=result.controls[0].widget_node_id='6:4';
    }
    if(action==='captureMedia')result.captured[0].node_id='6:4';
    return result;
  };
  const result=await h.run();
  assert.equal(result.pending.length,enabled?0:1);
  assert.equal(result.patches.length,enabled?2:1);
  assert.equal(h.calls.some(call=>call.action==='captureMedia'),enabled);
  if(enabled){assert.equal(result.patches[0].node_id,'6:4');assert.equal(result.patches[0].media_receipt,'receipt');}
});
