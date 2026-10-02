/** Transient upload tickets: old values stay intact but cannot run by accident. */
export function createMediaTransfers() {
  const entries = new Map();
  const key = (owner, field) => JSON.stringify([owner, field]);
  const state = (owner, field) => entries.get(key(owner, field));
  const current = ticket => state(ticket.owner, ticket.field) === ticket;
  return {
    state, current,
    start(owner, field, label) { const ticket = { owner, field, label, status: 'pending' }; entries.set(key(owner, field), ticket); return ticket; },
    finish(ticket) { if (!current(ticket)) return false; entries.delete(key(ticket.owner, ticket.field)); return true; },
    fail(ticket, error) { if (current(ticket)) { ticket.status = 'failed'; ticket.error = String(error?.message || error); } },
    discard(owner, field) { entries.delete(key(owner, field)); },
    assertReady(owners, fieldsByOwner = null) {
      const scope = new Set(owners);
      const blocked = [...entries.values()].find(ticket => scope.has(ticket.owner) &&
        (!fieldsByOwner?.has(ticket.owner) || fieldsByOwner.get(ticket.owner).has(ticket.field)));
      if (blocked) throw new Error(`“${blocked.label}”${blocked.status === 'pending' ? '正在上传' : '上传失败'}，尚未使用新素材。请等待完成、重新选择，或明确保留原值后再生成。`);
    },
  };
}
