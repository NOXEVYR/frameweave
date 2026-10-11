/** Session-only suspension of proven audio preview routes across shared subgraphs. */
const copy = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nodes = scope => scope?._nodes || scope?.nodes || [];
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const READS = new Set(['getExposures', 'getExposuresAsPromotionShape', 'resolveChain']);

export function createPreviewExposureIsolation({ capability, app, window, document, graph, onInvalidate = () => {} }) {
  const leases = new Map(), dependents = new Set(), revoked = new WeakSet(); let internal = 0, disposed = false, unsubscribe, observer, epoch = 0;
  const store = capability?.exposureStore;
  const available = () => !disposed && capability?.supported && capability.isCurrent() &&
    typeof window?.MutationObserver === 'function';
  const live = (lease, item) => graph() === lease.root && lease.root.id === lease.rootId && lease.scope.id === lease.scopeId &&
    item.host.graph === item.parent && nodes(item.parent).includes(item.host) &&
    item.host.subgraph === item.child && String(item.host.id) === item.id;
  const read = (lease, item) => store.getExposures(lease.rootId, item.id);
  function write(lease, item, value) {
    if (!capability.isCurrent()) throw new Error('preview-exposure-api-changed');
    internal++;
    try { store.setExposures(lease.rootId, item.id, copy(value)); }
    finally { internal--; }
  }
  function hostSet(root, scope) {
    const all = [], seen = new Set(), pending = [root], identities = new Map(); let count = 0;
    while (pending.length) {
      const current = pending.pop(); if (seen.has(current)) continue; seen.add(current);
      for (const host of nodes(current)) {
        if (++count > 4096) throw new Error('preview-exposure-capacity');
        if (host.isSubgraphNode?.() !== true) continue;
        if (host.graph !== current || !host.subgraph || !id(String(host.id))) throw new Error('preview-host-unproven');
        if (identities.has(String(host.id)) && identities.get(String(host.id)) !== host) throw new Error('preview-store-key-ambiguous');
        identities.set(String(host.id), host); all.push(host);
        if (host.subgraph) pending.push(host.subgraph);
      }
    }
    const result = [], scopes = new Set([scope]);
    // Include all ancestors, including other instances of a shared definition.
    // Each physical table is captured once even when A/B reach the same host.
    for (let changed = true; changed;) {
      changed = false;
      for (const host of all) if (scopes.has(host.subgraph) && !result.includes(host)) {
        result.push(host); scopes.add(host.graph); changed = true;
      }
    }
    if (!scopes.has(root)) throw new Error('preview-host-unreachable');
    const occurrences = [{ scope: root, path: [], parents: new Set() }]; let occurrencesRead = 0;
    while (occurrences.length) {
      const current = occurrences.pop();
      if (current.parents.has(current.scope) || current.path.length > 32) throw new Error('preview-route-cycle');
      const parents = new Set(current.parents); parents.add(current.scope);
      for (const host of nodes(current.scope)) {
        if (++occurrencesRead > 4096) throw new Error('preview-exposure-capacity');
        if (host.isSubgraphNode?.() !== true) continue;
        const path = [...current.path, String(host.id)], qualified = path.join(':');
        // This build stores durable tables by local host ID. An occurrence
        // override has different ownership and cannot use that table's lease.
        if (path.length > 1 && store.getExposures(root.id, qualified)?.length) throw new Error('preview-occurrence-override-unproven');
        occurrences.push({ scope: host.subgraph, path, parents });
      }
    }
    return result;
  }
  function table(root, host) {
    const value = store.getExposures(root.id, String(host.id));
    if (!Array.isArray(value) || value.length > 256 ||
        !equal(value, host.serialize?.()?.properties?.previewExposures)) throw new Error('preview-table-unproven');
    return value;
  }
  function route(root, host, exposure, depth = 0, seen = new Set()) {
    if (depth > 32 || !exposure || Object.keys(exposure).sort().join(',') !== 'name,sourceNodeId,sourcePreviewName' ||
        typeof exposure.name !== 'string' || !exposure.name || exposure.name.length > 200 ||
        typeof exposure.sourcePreviewName !== 'string' || !exposure.sourcePreviewName || exposure.sourcePreviewName.length > 200 ||
        !id(String(exposure.sourceNodeId))) throw new Error('preview-route-unproven');
    const children = nodes(host.subgraph).filter(node => String(node.id) === String(exposure.sourceNodeId));
    if (children.length !== 1) throw new Error('preview-route-unproven');
    const child = children[0];
    if (child.isSubgraphNode?.() !== true) return { node: child, name: exposure.sourcePreviewName };
    if (seen.has(child)) throw new Error('preview-route-cycle');
    const next = new Set(seen); next.add(child);
    const aliases = table(root, child).filter(item => item.name === exposure.sourcePreviewName);
    if (aliases.length !== 1) throw new Error('preview-route-unproven');
    return route(root, child, aliases[0], depth + 1, next);
  }
  function ancestry(target) {
    if (target?.mappingProof?.root !== graph() || !Array.isArray(target.mappingProof.nodes) ||
        target.mappingProof.nodes.length < 2 || target.mappingProof.nodes.length > 33) return null;
    const chain = target.mappingProof.nodes.map(item => item.node || item);
    let parent = graph();
    for (const host of chain.slice(0, -1)) {
      if (host.graph !== parent || !nodes(parent).includes(host) || host.isSubgraphNode?.() !== true || !host.subgraph) return null;
      parent = host.subgraph;
    }
    return chain.at(-1) === target.node && target.node.graph === parent && nodes(parent).includes(target.node) ? chain.slice(0, -1) : null;
  }
  function exactHosts(lease) {
    try { const current = hostSet(lease.root, lease.scope); return current.length === lease.items.length && current.every(host => lease.items.some(item => item.host === host)); }
    catch { return false; }
  }
  function unchangedPlan(lease) {
    return available() && lease.epoch === epoch && graph() === lease.root && app.canvas?.graph === lease.view && lease.valid() && exactHosts(lease) && lease.items.every(item => {
      const current = Object.getOwnPropertyDescriptor(item.host, 'serialize');
      return live(lease, item) && item.host.serialize === item.original &&
        ['value', 'get', 'set', 'configurable', 'enumerable', 'writable'].every(key => current?.[key] === item.descriptor?.[key]) &&
        equal(read(lease, item), item.exposures) && equal(item.original.call(item.host)?.properties?.previewExposures, item.exposures) &&
        equal(read(lease, item), item.exposures);
    });
  }
  function verify(lease) {
    try { return available() && lease.epoch === epoch && lease.active && graph() === lease.root &&
      (lease.ready || app.canvas?.graph === lease.view) && lease.valid() && exactHosts(lease) &&
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
    revoked.add(lease.leaf);
    for (const node of new Set([lease.leaf, ...dependents])) onInvalidate(node, reason);
    dependents.clear();
  }
  function surface(lease) {
    const visible = app.canvas?.graph;
    if (visible !== lease.root && visible !== lease.scope && !lease.items.some(item => item.parent === visible || item.child === visible)) throw new Error('preview-view-changed');
    const mode = window.LiteGraph?.vueNodesMode;
    if (typeof mode !== 'boolean') throw new Error('preview-renderer-unproven');
    const panes = [...document.querySelectorAll('[data-testid="transform-pane"]')];
    if (!mode) { if (panes.length) throw new Error('preview-renderer-changing'); return []; }
    if (panes.length !== 1) throw new Error('preview-renderer-unproven');
    return lease.items.filter(item => item.parent === visible).flatMap(item => {
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
      for (const node of dependents) onInvalidate(node, 'preview-exposure-changed');
      dependents.clear();
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
          !ancestry(target) || target.mappingProof.root !== graph() ||
          !['LoadAudio'].includes(leaf?.comfyClass || leaf?.type)) return false;
      const root = graph(), scope = leaf.graph;
      if (!id(root.id) || target.owner.graph !== root) return false;
      const hosts = hostSet(root, scope);
      if (!hosts.includes(target.owner) || !hosts.length) return false;
      lease = { root, rootId: root.id, scope, scopeId: scope.id, leaf, leafId: String(leaf.id), valid, epoch,
        view: app.canvas?.graph, active: false, ready: false, protected: false, items: [] };
      let exposureBytes = 0, exposureCount = 0;
      for (const host of hosts) {
        const key = String(host.id), descriptor = Object.getOwnPropertyDescriptor(host, 'serialize'), original = host.serialize;
        if (!id(key) || !Object.isExtensible(host) || typeof original !== 'function' ||
            descriptor && (!descriptor.configurable || !Object.hasOwn(descriptor, 'value'))) return false;
        const exposures = copy(store.getExposures(root.id, key));
        exposureBytes += new TextEncoder().encode(JSON.stringify(exposures)).length;
        exposureCount += Array.isArray(exposures) ? exposures.length : 0;
        if (exposureBytes > 2 * 1024 * 1024 || exposureCount > 4096) return false;
        if (!Array.isArray(exposures) || exposures.length > 256 || !equal(exposures, original.call(host)?.properties?.previewExposures) ||
            exposures.some(exposure => { const resolved = route(root, host, exposure); return resolved.node !== leaf || resolved.name !== 'audioUI'; })) return false;
        lease.items.push({ host, id: key, parent: host.graph, child: host.subgraph, exposures, descriptor, original });
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
      lease.ready = true; revoked.delete(leaf); return true;
    } catch { if (lease) release(lease, 'preview-exposure-acquire-failed'); return false; }
  }
  function allows(target) {
    try {
      if (!available()) return false;
      let invalid = false;
      for (const lease of [...leases.values()]) if (!verify(lease)) { release(lease); invalid = true; }
      if (invalid || revoked.has(target?.node)) return false;
      const hosts = ancestry(target); if (!hosts) return false;
      hostSet(graph(), target.node.graph);
      for (const host of hosts) {
        const covering = [...leases.values()].find(lease => lease.ready && lease.items.some(item => item.host === host));
        if (covering) continue;
        // Another media leaf's exposure cannot display this leaf. Prove the
        // actual route instead of blocking every image/video beside an audio UI.
        if (table(graph(), host).some(exposure => route(graph(), host, exposure).node === target.node)) return false;
      }
      subscribe(); dependents.add(target.node); return true;
    } catch { return false; }
  }
  function reset() { epoch++; for (const lease of [...leases.values()]) release(lease, 'preview-exposure-reset');
    for (const node of dependents) onInvalidate(node, 'preview-exposure-reset'); dependents.clear(); }
  function destroy() { reset(); observer?.disconnect(); unsubscribe?.(); observer = unsubscribe = null; disposed = true; }
  return { acquire, allows, reset, destroy };
}
