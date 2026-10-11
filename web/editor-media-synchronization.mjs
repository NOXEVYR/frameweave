import { stableStringify } from './graph.mjs';

const MEDIA = new Set(['image', 'video', 'audio']);
const copy = value => structuredClone(value);

/** Prove own media before the normal conflict-aware patch batch. No uploads. */
export async function prepareOwnMediaSynchronization({ request, patches, definitions, provenance = [], assertCurrent, mediaNestedCapture = false }) {
  if (!Array.isArray(patches) || patches.length !== definitions?.length || typeof request !== 'function' || typeof assertCurrent !== 'function') throw new Error('素材同步缺少完整参数映射');
  const pending = [], candidates = [], receipts = new Map();
  for (let index = 0; index < patches.length; index++) {
    const field = definitions[index], patch = patches[index];
    if (!MEDIA.has(field.type)) continue;
    const proofs = provenance.filter(item => item.field_id === field.id && item.origin === 'own');
    const proof = proofs[0];
    if (proofs.length !== 1 || proof.type !== field.type || proof.node_id !== field.node_id || proof.input !== field.input ||
        patch.node_id !== field.node_id || patch.widget_name !== field.input || typeof proof.class_type !== 'string' ||
        !Object.is(proof.value, patch.value) || proof.media_owner?.name !== proof.value || proof.media_owner?.media_type !== field.type ||
        typeof proof.media_owner?.backend !== 'string' || field.node_id.includes(':') && mediaNestedCapture !== true) {
      pending.push({ field_id: field.id, label: field.label, reason: 'own_media_unproven' }); continue;
    }
    candidates.push({ index, proof: copy(proof) });
  }
  if (candidates.length) {
    await assertCurrent();
    const before = await request('compile'); await assertCurrent();
    let captured;
    try { captured = await request('captureMedia', { bindings: candidates.map(item => item.proof) }); }
    catch { await assertCurrent(); captured = { captured: [], unsupported: [] }; }
    await assertCurrent();
    if (!Array.isArray(captured?.captured) || !Array.isArray(captured?.unsupported)) throw new Error('素材同步能力响应无效，未应用外层修改');
    const after = await request('compile'); await assertCurrent();
    if (!before?.output || !after?.output || stableStringify(before.output) !== stableStringify(after.output)) throw new Error('素材能力检查改变了内部工作流，未应用外层修改');
    for (const { index, proof } of candidates) {
      const matches = captured.captured.filter(item => item.field_id === proof.field_id);
      const receipt = matches[0], value = after.output?.[proof.node_id]?.inputs?.[proof.input];
      const controls = (after.controls || []).filter(item => item.node_id === proof.node_id && item.input === proof.input);
      if (!matches.length) {
        pending.push({ field_id: proof.field_id, label: proof.label,
          reason: captured.unsupported.find(item => item.field_id === proof.field_id)?.reason || 'media_capture_unavailable' }); continue;
      }
      if (matches.length !== 1 || receipt.node_id !== proof.node_id || receipt.input !== proof.input || receipt.type !== proof.type ||
          typeof receipt.receipt !== 'string' || !receipt.receipt || receipt.receipt.length > 512 ||
          !Object.is(receipt.native_value, value) || after.output[proof.node_id].class_type !== proof.class_type ||
          controls.length !== 1 || controls[0].widget_node_id !== proof.node_id || controls[0].widget_name !== proof.input || controls[0].media_receipt !== receipt.receipt) {
        throw new Error('素材回执与当前内部控件不一致，未应用外层修改');
      }
      receipts.set(index, { media_receipt: receipt.receipt, class_type: proof.class_type });
    }
  }
  const readyPatches = [], readyDefinitions = [];
  for (let index = 0; index < patches.length; index++) {
    if (MEDIA.has(definitions[index].type) && !receipts.has(index)) continue;
    readyPatches.push({ ...patches[index], ...receipts.get(index) }); readyDefinitions.push(definitions[index]);
  }
  return { patches: readyPatches, definitions: readyDefinitions, pending };
}
