/** Session-only suspension of proven standard audio previews on shared hosts. */
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nodes = scope => scope?._nodes || scope?.nodes || [];
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const READS = new Set(['getExposures', 'getExposuresAsPromotionShape', 'resolveChain']);

export function createPreviewExposureIsolation({ capability, app, window, document, graph, onInvalidate = () => {} }) {
  const leases = new Map(); let internal = 0, disposed = false, unsubscribe, observer, epoch = 0;
  const store = capability?.exposureStore;
  const available = () => !disposed && capability?.supported && capability.isCurrent() &&
    typeof window?.MutationObserver === 'function';
  const live = (lease, item) => graph() === lease.root && lease.root.id === lease.rootId && lease.scope.id === lease.scopeId &&
    item.host.graph === lease.root &&
    nodes(lease.root).includes(item.host) && item.host.subgraph === lease.scope && String(item.host.id) === item.id;
  const read = (lease, item) => store.getExposures(lease.rootId, item.id);
  function write(lease, item, value) {
    if (!capability.isCurrent()) throw new Error('preview-exposure-api-changed');
    internal++;
    try { store.setExposures(lease.rootId, item.id, copy(value)); }
    finally { internal--; }
  }
  function hostSet(root, scope) {
    const result = [], seen = new Set(), pending = [root]; let count = 0;
    while (pending.length) {
      const current = pending.pop(); if (seen.has(current)) continue; seen.add(current);
      for (const host of nodes(current)) {
        if (++count > 4096) throw new Error('preview-exposure-capacity');
        if (host.isSubgraphNode?.() !== true) continue;
        if (host.subgraph === scope) {
          if (current !== root || host.graph !== root) throw new Error('nested-preview-exposure-unsupported');
          result.push(host);
        }
        if (host.subgraph) pending.push(host.subgraph);
      }
    }
    return result;
  }
  function exactHosts(lease) {
    try { const current = hostSet(lease.root, lease.scope); return current.length === lease.items.length && current.every(host => lease.items.some(item => item.host === host)); }
    catch { return false; }
  }
  function unchangedPlan(lease) {
    return available() && lease.epoch === epoch && graph() === lease.root && lease.valid() && exactHosts(lease) && lease.items.every(item => {
      const current = Object.getOwnPropertyDescriptor(item.host, 'serialize');
      return live(lease, item) && item.host.serialize === item.original &&
        ['value', 'get', 'set', 'configurable', 'enumerable', 'writable'].every(key => current?.[key] === item.descriptor?.[key]) &&
        equal(read(lease, item), item.exposures) && equal(item.original.call(item.host)?.properties?.previewExposures, item.exposures) &&
        equal(read(lease, item), item.exposures);
    });
  }
  function verify(lease) {
    try { return available() && lease.epoch === epoch && lease.active && graph() === lease.root && lease.valid() && exactHosts(lease) &&
      nodes(lease.scope).includes(lease.leaf) && String(lease.leaf.id) === lease.leafId && lease.items.every(item => live(lease, item) &&
        item.host.serialize === item.wrapper && Array.isArray(read(lease, item)) && read(lease, item).length === 0); }
    catch { return false; }
  }
  function restoreDescriptor(item) {
    if (item.host.serialize !== item.wrapper) return;
    if (item.descriptor) Object.defineProperty(item.host, 'serialize', item.descriptor); else delete item.host.serialize;
  }
  function release(lease, reason = 'preview-exposure-changed') {
    if (lease.releasing || !lease.active && !lease.protected) return;
    lease.releasing = true;
    lease.active = false; lease.ready = false; let unresolved = false;
    for (const item of lease.items) {
      try {
        if (live(lease, item) && item.host.serialize === item.wrapper && Array.isArray(read(lease, item)) && !read(lease, item).length) {
          write(lease, item, item.exposures);
          if (!equal(read(lease, item), item.exposures)) throw new Error('preview-exposure-restore-failed');
        }
        restoreDescriptor(item);
      } catch { unresolved = true; }
    }
    // A failed native write must not make the temporary empty table persistent.
    // Keep our serializer projection until recovery or the iframe is discarded.
    lease.protected = unresolved;
    if (!unresolved) leases.delete(lease.leaf);
    lease.releasing = false;
    onInvalidate(lease.leaf, reason);
  }
  function surface(lease) {
    if (app.canvas?.graph !== lease.root) throw new Error('preview-view-changed');
    const mode = window.LiteGraph?.vueNodesMode;
    if (typeof mode !== 'boolean') throw new Error('preview-renderer-unproven');
    const panes = [...document.querySelectorAll('[data-testid="transform-pane"]')];
    if (!mode) { if (panes.length) throw new Error('preview-renderer-changing'); return []; }
    if (panes.length !== 1) throw new Error('preview-renderer-unproven');
    return lease.items.flatMap(item => {
      const hosts = [...panes[0].querySelectorAll(`.lg-node[data-node-id="${item.id}"]`)];
      if (hosts.length !== 1) throw new Error('preview-host-unproven');
      return [...hosts[0].querySelectorAll('audio,video')];
    });
  }
  function stop(element) { element.pause(); element.autoplay = false; element.removeAttribute('src'); element.load(); }
  function observe() {
    if (observer) return;
    observer = new window.MutationObserver(() => {
      for (const lease of [...leases.values()]) {
        if (!lease.ready) continue;
        if (!verify(lease)) { release(lease); continue; }
        if (app.canvas?.graph !== lease.root) continue;
        try { const unexpected = surface(lease); if (unexpected.length) { unexpected.forEach(stop); release(lease, 'preview-renderer-changed'); } }
        catch { release(lease, 'preview-renderer-changed'); }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function subscribe() {
    if (unsubscribe) return;
    unsubscribe = store.$onAction(({ name, args }) => {
      if (internal || READS.has(name)) return;
      // Restore before the action computes its edit, so removing an exposure
      // operates on the real table, never on our temporary empty one.
      for (const lease of [...leases.values()]) if (!args?.length || args[0] === lease.rootId || !['setExposures', 'addExposure', 'removeExposure', 'clearGraph'].includes(name)) release(lease);
    }, true);
    if (typeof unsubscribe !== 'function') throw new Error('preview-subscription-unavailable');
  }
  async function acquire(target, valid) {
    const leaf = target?.node, existing = leases.get(leaf);
    if (existing && verify(existing) && existing.ready) return true;
    if (existing) { release(existing); return false; }
    let lease;
    try {
      if (!available() || typeof valid !== 'function' || !valid() || target.owner === leaf ||
          target.mappingProof?.nodes?.length !== 2 || target.mappingProof.root !== graph() ||
          !['LoadAudio'].includes(leaf?.comfyClass || leaf?.type)) return false;
      const root = graph(), scope = leaf.graph;
      if (!id(root.id) || target.owner.graph !== root || target.owner.subgraph !== scope) return false;
      const hosts = hostSet(root, scope);
      if (!hosts.includes(target.owner) || !hosts.length) return false;
      lease = { root, rootId: root.id, scope, scopeId: scope.id, leaf, leafId: String(leaf.id), valid, epoch, active: false, ready: false, protected: false, items: [] };
      for (const host of hosts) {
        const key = String(host.id), descriptor = Object.getOwnPropertyDescriptor(host, 'serialize'), original = host.serialize;
        if (!id(key) || !Object.isExtensible(host) || typeof original !== 'function' ||
            descriptor && (!descriptor.configurable || !Object.hasOwn(descriptor, 'value'))) return false;
        const exposures = copy(store.getExposures(root.id, key));
        if (!Array.isArray(exposures) || exposures.length > 1 || !equal(exposures, original.call(host)?.properties?.previewExposures) ||
            exposures.some(exposure => Object.keys(exposure).sort().join(',') !== 'name,sourceNodeId,sourcePreviewName' ||
              typeof exposure.name !== 'string' || !exposure.name || String(exposure.sourceNodeId) !== String(leaf.id) || exposure.sourcePreviewName !== 'audioUI')) return false;
        lease.items.push({ host, id: key, exposures, descriptor, original });
      }
      if (!lease.items.some(item => item.exposures.length)) return false;
      await capability.nextTick();
      if (!unchangedPlan(lease)) return false;
      const oldPlayers = surface(lease);
      subscribe(); observe();
      if (!unchangedPlan(lease)) return false;
      lease.protected = true;
      for (const item of lease.items) {
        item.wrapper = function (...args) {
          const value = item.original.apply(this, args);
          if (this !== item.host) throw new Error('preview-exposure-owner-changed');
          // No silent overwrite of an out-of-band edit to the exposure store.
          if (!Array.isArray(read(lease, item)) || read(lease, item).length && !equal(read(lease, item), item.exposures)) throw new Error('preview-exposure-conflict');
          return { ...value, properties: { ...value.properties, previewExposures: copy(item.exposures) } };
        };
        Object.defineProperty(item.host, 'serialize', { configurable: true, writable: true, enumerable: false, value: item.wrapper });
      }
      lease.active = true; leases.set(leaf, lease);
      oldPlayers.forEach(stop);
      for (const item of lease.items) write(lease, item, []);
      await capability.nextTick();
      if (!verify(lease) || surface(lease).length || oldPlayers.some(element => element.isConnected || !element.paused)) throw new Error('preview-renderer-not-isolated');
      lease.ready = true; return true;
    } catch { if (lease) release(lease, 'preview-exposure-acquire-failed'); return false; }
  }
  function allows(target) {
    const lease = leases.get(target?.node);
    if (!lease) return false;
    if (!verify(lease)) { release(lease); return false; }
    return lease.ready && lease.items.some(item => item.host === target.owner);
  }
  function reset() { epoch++; for (const lease of [...leases.values()]) release(lease, 'preview-exposure-reset'); }
  function destroy() { reset(); observer?.disconnect(); unsubscribe?.(); observer = unsubscribe = null; disposed = true; }
  return { acquire, allows, reset, destroy };
}
