/** Capabilities for isolated standard ComfyUI filename widgets. No uploads/jobs. */
const TYPES = new Set(['image', 'video', 'audio']);
const CORE = new Set(['LoadImage', 'LoadImageMask', 'LoadAudio', 'LoadVideo']);
const MAX_FIELDS = 4096;
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = item => JSON.stringify([item.node_id, item.input]);

export function safeEditorMediaFilename(value, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > 1024 || !value && !allowEmpty || value.includes(':') ||
      /[\u0000-\u001f\u007f]/.test(value) || /^(?:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(value) ||
      /\[(?:input|output|temp)\]/i.test(value) || /%(?:2e|2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false;
  return !value.split(/[\\/]/).some(part => part === '..' || part === '.' || !part && value !== '');
}

/** Proves the registered standard upload spec; a combo alone is insufficient. */
export function nativeMediaContract(node, input, type, registry) {
  const classType = node?.comfyClass || node?.type, constructor = node?.constructor;
  if (!TYPES.has(type) || !CORE.has(classType) || !registry || !own(registry, classType)) return null;
  const registered = registry[classType], data = constructor?.nodeData;
  if (!registered || registered !== constructor && registered.nodeData !== data || !record(data?.input)) return null;
  const matches = ['required', 'optional'].filter(group => own(data.input[group] || {}, input));
  if (matches.length !== 1 || own(data.input.hidden || {}, input)) return null;
  const spec = data.input[matches[0]][input];
  if (!Array.isArray(spec) || !record(spec[1])) return null;
  const [kind, meta] = spec;
  if (['image', 'video', 'audio'].some(media => own(meta, `${media}_upload`) && typeof meta[`${media}_upload`] !== 'boolean')) return null;
  const flags = ['image', 'video', 'audio'].filter(media => meta[`${media}_upload`] === true);
  if (flags.length !== 1 || flags[0] !== type || meta.multiselect || meta.allow_batch || meta.forceInput ||
      meta.remote || Object.keys(meta).some(key => /(?:url|endpoint|route|upload_path|upload_folder|custom_upload)/i.test(key))) return null;
  for (const field of ['image_folder', 'video_folder', 'audio_folder', 'folder', 'storage_type']) {
    if (own(meta, field) && meta[field] !== 'input') return null;
  }
  const options = Array.isArray(kind) ? kind : kind === 'COMBO' ? meta.options : null;
  if (!Array.isArray(options) || options.some(value => typeof value !== 'string')) return null;
  return { class_type: classType, input, type, specification: JSON.stringify(spec) };
}

export function createNativeEditorMedia({ app, window, document, graph, findWidget, sameMappingProof, config, createPreview }) {
  const receipts = new Map(), byBinding = new Map(), isolated = new WeakMap(), wrapped = new WeakSet(), liveIsolations = new Map();
  const viewHooks = new Map(), scopeHooks = new Map();
  let panel, preview, previewOwner = null, previewWidget = null, previewValue, previewEntry = null, refreshing = false, serial = 0, observerChecked = false, observerProbe, probeHandler, unavailable = false;
  let activeTrail = null, pendingTrail = null;
  const registry = () => window.LiteGraph?.registered_node_types;
  const canvas = () => app.canvasOrUndefined || app.canvas;
  function clearPreview(message) { previewOwner = null; previewWidget = null; previewValue = undefined; previewEntry = null; preview?.clear(message); }
  function validTrail(trail, scope = canvas()?.graph) {
    if (!trail || trail.root !== graph() || trail.canvas !== canvas() || trail.scope !== scope) return false;
    let parent = graph();
    for (const host of trail.hosts) {
      if (host.graph !== parent || !(parent?._nodes || parent?.nodes || []).includes(host) ||
          host.isSubgraphNode?.() !== true || !host.subgraph) return false;
      parent = host.subgraph;
    }
    return parent === scope;
  }
  function viewPath(scope) {
    if (scope === graph()) return [];
    return validTrail(activeTrail, scope) ? activeTrail.hosts.map(host => String(host.id)) : null;
  }
  function navigationAvailable() {
    return typeof document?.addEventListener === 'function' && typeof document?.removeEventListener === 'function' &&
      typeof canvas()?.openSubgraph === 'function' && typeof canvas()?.canvas?.dispatchEvent === 'function';
  }
  function subgraphOpening(event) {
    pendingTrail = null;
    const active = canvas(), detail = event?.detail, path = viewPath(active?.graph);
    if (event?.target !== active?.canvas || !detail || !path || detail.closingGraph !== active.graph ||
        detail.fromNode?.graph !== active.graph || !(active.graph?._nodes || active.graph?.nodes || []).includes(detail.fromNode) ||
        detail.fromNode.isSubgraphNode?.() !== true || detail.fromNode.subgraph !== detail.subgraph) return;
    pendingTrail = { root: graph(), canvas: active, scope: detail.subgraph, closing: detail.closingGraph,
      hosts: [...(active.graph === graph() ? [] : activeTrail.hosts), detail.fromNode] };
  }
  function subgraphOpened(event) {
    const next = pendingTrail; pendingTrail = null;
    if (event?.target !== canvas()?.canvas) return;
    activeTrail = next && next.closing === event.detail?.closingGraph && next.scope === event.detail?.subgraph &&
      next.hosts.at(-1) === event.detail?.fromNode && validTrail(next) ? next : null;
    clearPreview(); refreshPreview();
  }
  function restoreHooks(owner, hooks) {
    for (const { name, wrapper, descriptor } of hooks || []) if (owner[name] === wrapper) {
      if (descriptor) Object.defineProperty(owner, name, descriptor); else delete owner[name];
    }
  }
  function installHooks(owner, names, store, replaceNotifications = false) {
    if (!owner || !Object.isExtensible(owner)) return false;
    const known = store.get(owner);
    if (known?.every(({ name, wrapper }) => owner[name] === wrapper)) return true;
    const changed = known ? names.filter(name => owner[name] !== known.find(item => item.name === name)?.wrapper) : names;
    if (known && (!replaceNotifications || changed.some(name => !['onNodeAdded', 'onNodeRemoved'].includes(name)))) return false;
    const descriptors = changed.map(name => ({ name, descriptor: Object.getOwnPropertyDescriptor(owner, name), original: owner[name] }));
    if (descriptors.some(({ descriptor, original }) => descriptor && (!own(descriptor, 'value') || !descriptor.configurable) ||
        original !== undefined && typeof original !== 'function')) return false;
    const hooks = [];
    try {
      for (const descriptor of descriptors) {
        const item = { ...descriptor, active: true };
        const wrapper = function (...args) {
          let trail = null;
          if (!unavailable && item.active && item.name === 'setGraph') {
            // Breadcrumb navigation can return to an already proven ancestor.
            // A definition ID alone never identifies a shared instance.
            if (validTrail(activeTrail)) {
              const index = activeTrail.hosts.findIndex(host => host.subgraph === args[0]);
              if (index >= 0) trail = { ...activeTrail, scope: args[0], hosts: activeTrail.hosts.slice(0, index + 1) };
            }
            activeTrail = null; clearPreview();
          }
          try { return item.original?.apply(this, args); }
          finally {
            if (!unavailable && item.active && item.name === 'setGraph' && validTrail(trail)) activeTrail = trail;
            if (!unavailable && item.active) refreshPreview();
          }
        };
        Object.defineProperty(owner, item.name, { configurable: true, enumerable: false, writable: true, value: wrapper });
        item.wrapper = wrapper; hooks.push(item);
      }
      for (const item of known || []) if (changed.includes(item.name)) item.active = false;
      store.set(owner, [...(known || []).filter(item => !changed.includes(item.name)), ...hooks]); return true;
    } catch { restoreHooks(owner, hooks); return false; }
  }
  function nestedAvailable() {
    const active = canvas();
    return !unavailable && typeof sameMappingProof === 'function' && typeof createPreview === 'function' &&
      typeof document?.createElement === 'function' && typeof document?.body?.appendChild === 'function' &&
      !!active?.graph && typeof active.setGraph === 'function' && installHooks(active, ['setGraph', 'onSelectionChange', 'onAfterChange'], viewHooks);
  }
  function nestedReason(nodeId, target) {
    if (!nestedAvailable()) return 'nested_media_not_supported';
    if (target?.reason) return target.reason === 'shared_definition_widget' ? 'shared_definition_widget' : 'media_mapping_unproven';
    const promoted = target.owner !== target.node;
    if (promoted && !navigationAvailable()) return 'promoted_preview_not_isolated';
    const proof = target.mappingProof;
    if (!proof || proof.root !== graph() || proof.node !== target.node || proof.owner !== target.owner ||
        proof.widget !== target.widget || proof.scope !== target.owner.graph || proof.widgetPath !== target.widget_path ||
        !Array.isArray(proof.nodes) || proof.nodes.length < 2 || proof.nodes.some(item => !item.lifecycle)) return 'media_mapping_unproven';
    const ownerIndex = proof.nodes.findIndex(item => item.node === target.owner);
    if (ownerIndex < 0 || nodeId.split(':').slice(0, ownerIndex + 1).join(':') !== target.widget_path ||
        !promoted && target.widget_path !== nodeId) return 'media_mapping_unproven';
    // Live PreviewExposureStore is authoritative. SubgraphNode.serialize reads
    // it into this explicit property; node.properties may be an older snapshot.
    for (const { node: host } of proof.nodes.slice(0, -1)) {
      let exposed;
      try { exposed = host.serialize?.()?.properties?.previewExposures; }
      catch { return 'nested_preview_exposure_unproven'; }
      if (!Array.isArray(exposed)) return 'nested_preview_exposure_unproven';
      if (exposed.length) return 'promoted_preview_not_isolated';
    }
    return null;
  }
  function currentNested(marker) {
    const target = findWidget(marker.node_id, marker.input);
    if (nestedReason(marker.node_id, target) || !sameMappingProof(marker.mappingProof, target.mappingProof)) return null;
    if (!viewHooks.get(canvas())?.every(({ name, wrapper }) => canvas()[name] === wrapper)) return null;
    // The official view detaches/reattaches node-list notification callbacks
    // when navigating. Re-arm only those notifications after the complete
    // binding proof above; keep the current callback and its restore descriptor.
    for (const scope of marker.scopes) if (!installHooks(scope, ['onNodeAdded', 'onNodeRemoved', 'onAfterChange'], scopeHooks, true)) return null;
    return target;
  }
  function hideElement(element) {
    if (!element || !element.style || typeof element.style.setProperty !== 'function') return false;
    element.hidden = true;
    element.style.setProperty('display', 'none', 'important');
    element.querySelectorAll?.('audio,video').forEach(media => { media.pause?.(); media.autoplay = false; });
    if (element.tagName === 'AUDIO' || element.tagName === 'VIDEO') { element.pause?.(); element.autoplay = false; }
    return true;
  }
  function standardBindings(node) {
    const inputs = node?.constructor?.nodeData?.input, result = [];
    const names = new Set([...Object.keys(inputs?.required || {}), ...Object.keys(inputs?.optional || {})]);
    for (const input of names) for (const type of TYPES) {
      const contract = nativeMediaContract(node, input, type, registry());
      if (contract) result.push(contract);
    }
    return result;
  }
  function revokeNode(node) {
    for (const [key, entry] of byBinding) if (entry.node === node) {
      byBinding.delete(key); receipts.delete(entry.receipt);
    }
  }
  function retireIsolation(node, marker) {
    marker.observer?.disconnect?.(); marker.retired = true; liveIsolations.delete(node); revokeNode(node);
    if (previewOwner === node) clearPreview();
  }
  function releaseIsolation(node, marker) {
    // Keep a removed node guarded against late promises until it is actually
    // added again. At that boundary restore native presentation, not graph data.
    retireIsolation(node, marker);
    for (const [name, saved] of marker.saved) {
      const current = Object.getOwnPropertyDescriptor(node, name), proof = marker.proof[name];
      if (current?.get !== proof?.get || current?.set !== proof?.set) continue;
      if (saved) Object.defineProperty(node, name, { ...saved, value: marker.values.get(name) });
      else if (marker.written.has(name)) Object.defineProperty(node, name,
        { configurable: true, enumerable: true, writable: true, value: marker.values.get(name) });
      else delete node[name];
    }
    for (const [name, wrapper, saved] of [['addDOMWidget', marker.wrapper, marker.addDescriptor],
      ['onRemoved', marker.removalWrapper, marker.removalDescriptor]]) {
      if (!wrapper || node[name] !== wrapper) continue;
      if (saved) Object.defineProperty(node, name, saved); else delete node[name];
    }
    for (const [element, style] of marker.styles) {
      element.hidden = style.hidden;
      element.style?.setProperty?.('display', style.display, style.priority);
    }
    for (const [element, autoplay] of marker.autoplay) element.autoplay = autoplay;
    isolated.delete(node);
  }
  function isolateNode(node, nested = null) {
    if (unavailable || !node || !graph() || standardBindings(node).length !== 1 ||
        (nested ? nestedReason(nested.node_id, nested.target) : node.graph !== graph())) return false;
    if (isolated.has(node)) return verifyIsolation(node);
    if (nested && !sameMappingProof(nested.target.mappingProof, findWidget(nested.node_id, nested.input).mappingProof)) return false;
    if (!Object.isExtensible(node)) return false;
    const saved = new Map();
    for (const name of ['imgs', 'hideOutputImages', 'videoContainer']) {
      const descriptor = Object.getOwnPropertyDescriptor(node, name);
      if (descriptor && (!descriptor.configurable || !own(descriptor, 'value'))) return false;
      saved.set(name, descriptor);
    }
    const addDescriptor = Object.getOwnPropertyDescriptor(node, 'addDOMWidget');
    if (addDescriptor && (!own(addDescriptor, 'value') || !addDescriptor.writable)) return false;
    const marker = { elements: new Set(), originalAdd: node.addDOMWidget, proof: {}, identity: `native-${++serial}`,
      graph: graph(), saved, addDescriptor, values: new Map([...saved].map(([name, descriptor]) => [name, descriptor?.value])),
      written: new Set(), styles: new Map(), autoplay: new Map(), scope: node.graph,
      ...(nested ? { node_id: nested.node_id, input: nested.input, nested: true,
        promoted: nested.target.owner !== node, nativeValue: nested.target.widget.value,
        scopes: [...new Set(nested.target.mappingProof.nodes.map(item => item.graph))] } : {}) };
    if (nested && marker.scopes.some(scope => !installHooks(scope, ['onNodeAdded', 'onNodeRemoved', 'onAfterChange'], scopeHooks, true))) return false;
    let container = saved.get('videoContainer')?.value;
    for (const widget of node.widgets || []) if (['audioUI', 'video-preview'].includes(widget.name) && widget.element) marker.elements.add(widget.element);
    if (container) marker.elements.add(container);
    // Establish the observer before changing any presentation descriptors or DOM.
    // Construction/observe failures therefore preserve native preview and do not poison load.
    try {
      if (typeof window.MutationObserver === 'function') {
        const handler = () => {
          if (marker.retired) return;
          for (const element of marker.elements) {
            if (!element.hidden || element.style.getPropertyValue?.('display') !== 'none' ||
                element.style.getPropertyPriority?.('display') !== 'important') hideElement(element);
          }
        };
        if (observerProbe) { marker.observer = observerProbe; observerProbe = null; probeHandler = handler; }
        else marker.observer = new window.MutationObserver(handler);
        for (const element of marker.elements) marker.observer.observe(element, { attributes: true, attributeFilter: ['style', 'hidden'] });
      }
    } catch { marker.observer?.disconnect?.(); return false; }
    function rememberSurface(element) {
      if (!marker.styles.has(element)) marker.styles.set(element, { hidden: element.hidden,
        display: element.style?.getPropertyValue?.('display') || '', priority: element.style?.getPropertyPriority?.('display') || '' });
      const media = [...(element.querySelectorAll?.('audio,video') || [])];
      if (element.tagName === 'AUDIO' || element.tagName === 'VIDEO') media.push(element);
      for (const item of media) if (!marker.autoplay.has(item)) marker.autoplay.set(item, item.autoplay);
    }
    for (const element of marker.elements) rememberSurface(element);
    function protect(element) {
      rememberSurface(element);
      marker.elements.add(element);
      try { if (!marker.retired) marker.observer?.observe(element, { attributes: true, attributeFilter: ['style', 'hidden'] }); }
      catch { marker.failed = true; }
      if (!hideElement(element)) marker.failed = true;
    }
    try {
      const descriptors = {
        imgs: { configurable: true, enumerable: false, get: () => undefined,
          set: value => { marker.values.set('imgs', value); marker.written.add('imgs'); } },
        hideOutputImages: { configurable: true, enumerable: false, get: () => true,
          set: value => { marker.values.set('hideOutputImages', value); marker.written.add('hideOutputImages'); } },
        videoContainer: { configurable: true, enumerable: false, get: () => container,
          set: value => { container = value; marker.values.set('videoContainer', value); marker.written.add('videoContainer'); if (value) protect(value); } },
      };
      Object.defineProperties(node, descriptors);
      marker.proof = Object.fromEntries(Object.keys(descriptors).map(name => [name, Object.getOwnPropertyDescriptor(node, name)]));
      if (typeof marker.originalAdd === 'function') {
        const wrapper = function (name, ...args) {
          const widget = marker.originalAdd.call(this, name, ...args);
          if (['audioUI', 'video-preview'].includes(name) && widget?.element) protect(widget.element);
          return widget;
        };
        node.addDOMWidget = wrapper; marker.wrapper = wrapper;
      }
      for (const element of marker.elements) if (!hideElement(element)) throw new Error('unsupported_surface');
      isolated.set(node, marker);
      liveIsolations.set(node, marker);
      const removed = node.onRemoved;
      const removalDescriptor = Object.getOwnPropertyDescriptor(node, 'onRemoved');
      if ((!removalDescriptor || removalDescriptor.configurable && own(removalDescriptor, 'value')) &&
          (removed === undefined || typeof removed === 'function')) {
        marker.removalDescriptor = removalDescriptor;
        marker.removalWrapper = function (...args) {
          retireIsolation(node, marker);
          return removed?.apply(this, args);
        };
        Object.defineProperty(node, 'onRemoved', { configurable: true, enumerable: false, writable: true, value: marker.removalWrapper });
      }
      if (nested) {
        const fresh = findWidget(nested.node_id, nested.input);
        const expected = { ...nested.target.mappingProof, nodes: nested.target.mappingProof.nodes.map(item =>
          item.node === node && marker.removalWrapper ? { ...item, onRemoved: marker.removalWrapper } : item) };
        if (nestedReason(nested.node_id, fresh) || !sameMappingProof(expected, fresh.mappingProof)) throw new Error('nested_mapping_changed');
        marker.mappingProof = fresh.mappingProof;
      }
      const verified = verifyIsolation(node);
      if (nested && !verified) throw new Error('nested_isolation_changed');
      return verified;
    } catch {
      marker.observer?.disconnect?.();
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(node, name, descriptor); else delete node[name];
      }
      if (addDescriptor) Object.defineProperty(node, 'addDOMWidget', addDescriptor); else delete node.addDOMWidget;
      if (marker.removalWrapper && node.onRemoved === marker.removalWrapper) {
        if (marker.removalDescriptor) Object.defineProperty(node, 'onRemoved', marker.removalDescriptor); else delete node.onRemoved;
      }
      for (const [element, style] of marker.styles) {
        element.hidden = style.hidden; element.style?.setProperty?.('display', style.display, style.priority);
      }
      for (const [element, autoplay] of marker.autoplay) element.autoplay = autoplay;
      isolated.delete(node); liveIsolations.delete(node); return false;
    }
  }
  function verifyIsolation(node) {
    const marker = isolated.get(node);
    if (!marker || marker.failed || marker.retired || marker.quarantined || marker.graph !== graph() || node.graph !== marker.scope ||
        !(marker.scope?._nodes || marker.scope?.nodes || []).includes(node) || standardBindings(node).length !== 1 ||
        marker.nested && !currentNested(marker)) return false;
    for (const [name, proof] of Object.entries(marker.proof)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, name);
      if (descriptor?.get !== proof.get || descriptor?.set !== proof.set) return false;
    }
    if (marker.wrapper && node.addDOMWidget !== marker.wrapper) return false;
    for (const element of marker.elements) if (!hideElement(element)) return false;
    return node.imgs === undefined && node.hideOutputImages === true;
  }
  function arm() {
    if (unavailable) return false;
    // Environment failure is detected before prototype hooks or node isolation.
    if (!observerChecked) {
      observerChecked = true;
      if (typeof window.MutationObserver === 'function') {
        try { observerProbe = new window.MutationObserver(() => probeHandler?.()); }
        catch { unavailable = true; return false; }
      }
    }
    // Installed before every parent load/import; node construction is synchronous.
    for (const [classType, constructor] of Object.entries(registry() || {})) {
      if (!CORE.has(classType) || typeof constructor !== 'function' || wrapped.has(constructor)) continue;
      const original = constructor.prototype.onAdded;
      const descriptor = Object.getOwnPropertyDescriptor(constructor.prototype, 'onAdded');
      if (!Object.isExtensible(constructor.prototype) || descriptor && (!own(descriptor, 'value') || !descriptor.writable)) continue;
      constructor.prototype.onAdded = function (...args) {
        // LiteGraph.add has already assigned node.graph and inserted the node.
        // Isolate before any onAdded callback can enqueue media work. Constructor
        // onNodeCreated and child-graph additions retain their native previews.
        const marker = isolated.get(this);
        if (marker && (marker.retired || this.graph !== marker.graph)) releaseIsolation(this, marker);
        if (args[0] === graph() && this.graph === graph()) isolateNode(this);
        const result = original?.apply(this, args);
        return result;
      };
      wrapped.add(constructor);
    }
    pruneIsolations();
    for (const node of graph()?._nodes || graph()?.nodes || []) isolateNode(node);
    return true;
  }
  function resolve(entry) {
    if (graph() !== entry.graph) return null;
    const target = findWidget(entry.node_id, entry.input);
    if (target.reason || target.node !== entry.node || target.owner !== entry.owner || target.widget !== entry.widget ||
        (target.node.comfyClass || target.node.type) !== entry.class_type || !verifyIsolation(entry.node) ||
        entry.mappingProof && !sameMappingProof(entry.mappingProof, target.mappingProof)) return null;
    const contract = nativeMediaContract(entry.node, entry.input, entry.type, registry());
    return contract && contract.specification === entry.specification ? target : null;
  }
  function ensurePreview() {
    if (preview || typeof createPreview !== 'function' || !document?.createElement || !document.body?.appendChild) return;
    panel = document.createElement('aside');
    panel.setAttribute('data-prism-media-preview', '');
    panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:100000;max-width:320px;max-height:45vh;overflow:auto;background:#17212e;color:#fff;border:1px solid #55708f;border-radius:10px;padding:10px';
    document.body.appendChild(panel);
    preview = createPreview({ document, container: panel, onState: state => {
      // A decoder can finish after scope/selection/ownership changed, before a
      // scheduled DOM input refresh. Recheck at that callback, never revive it.
      if (state.status !== 'empty' && previewOwner) {
        const active = canvas(), scope = active?.graph || graph();
        const selected = active?.selected_nodes || {};
        if (previewOwner.graph !== scope || selected[String(previewOwner.id)] !== previewOwner ||
            Object.keys(selected).length !== 1 || previewWidget?.value !== previewValue ||
            (previewEntry ? !promotedSelected(previewEntry, previewOwner, scope) : !verifyIsolation(previewOwner))) clearPreview();
      }
    } });
  }
  function promotedSelected(entry, selected, scope) {
    const target = resolve(entry), path = viewPath(scope);
    if (!target || target.owner === target.node || !path) return false;
    const selectedPath = [...path, String(selected.id)].join(':');
    return selected === entry.node && selectedPath === entry.node_id ||
      selected === entry.owner && selectedPath === target.widget_path;
  }
  function refreshPreview() {
    if (unavailable || refreshing) return;
    refreshing = true;
    try {
    pruneIsolations(); ensurePreview();
    if (!preview) return;
    const active = canvas(), scope = active?.graph || graph(), selected = active?.selected_nodes || {};
    const nodes = scope?._nodes || scope?.nodes || [];
    const selectedNodes = nodes.filter(node => own(selected, String(node.id)) && selected[String(node.id)] === node);
    if (selectedNodes.length !== 1 || Object.keys(selected).length !== 1) { clearPreview(); return; }
    const node = selectedNodes[0];
    const promoted = [...byBinding.values()].filter(entry => entry.owner !== entry.node && promotedSelected(entry, node, scope));
    if (promoted.length) {
      // Multiple media slots on a selected host are ambiguous; selecting the
      // actual leaf inside its instance identifies the slot without guessing.
      if (promoted.length !== 1) { clearPreview('此实例有多个参考素材槽；请进入此实例，选中具体素材节点以预览。'); return; }
      if (!safeEditorMediaFilename(promoted[0].widget.value)) { clearPreview('当前实例的素材名称为空或无效；请检查对应的外层输入。'); return; }
      const entry = promoted[0], identity = `${entry.node_id}:${entry.receipt}:${entry.widget.value}`;
      previewOwner = node; previewWidget = entry.widget; previewValue = entry.widget.value; previewEntry = entry;
      if (preview.getState()?.identity !== identity) preview.show({ identity, type: entry.type, filename: entry.widget.value,
        label: entry.label || `${entry.owner.title || entry.owner.id} / ${entry.node.title || entry.input}` });
      return;
    }
    if (!verifyIsolation(node)) { clearPreview(); return; }
    const marker = isolated.get(node), nodeId = marker.nested ? marker.node_id : String(node.id);
    if (marker.promoted) {
      clearPreview('无法确定当前子图属于哪个实例；请返回上层，从具体实例进入，再选择素材节点。未修改任何参考素材。'); return;
    }
    const bindings = [];
    for (const widget of node.widgets || []) for (const type of TYPES) {
      const contract = nativeMediaContract(node, widget.name, type, registry());
      const target = contract && findWidget(nodeId, widget.name);
      if (contract && !target.reason && target.node === node && target.owner === node && target.widget === widget) bindings.push({ widget, contract });
    }
    if (bindings.length !== 1 || !safeEditorMediaFilename(bindings[0].widget.value)) { clearPreview(); return; }
    const { widget, contract } = bindings[0], candidate = byBinding.get(keyOf({ node_id: nodeId, input: widget.name }));
    if (marker.nested && widget.value !== marker.nativeValue) marker.contaminated = true;
    const entry = candidate && resolve(candidate) ? candidate : null;
    const identity = `${nodeId}:${entry?.receipt || marker.identity}:${widget.value}`;
    previewOwner = node; previewWidget = widget; previewValue = widget.value;
    if (preview.getState()?.identity !== identity) preview.show({ identity, type: contract.type, filename: widget.value,
      label: entry?.label || node.title || widget.name });
    } finally { refreshing = false; }
  }
  function capture(bindings, output) {
    if (!Array.isArray(bindings) || bindings.length > MAX_FIELDS || new TextEncoder().encode(JSON.stringify(bindings)).length > 2 * 1024 * 1024) throw new Error('invalid-media-bindings');
    const captured = [], unsupported = [], counts = new Map(), fieldCounts = new Map();
    prune();
    for (const item of bindings) {
      const key = keyOf(item || {}); counts.set(key, (counts.get(key) || 0) + 1);
      fieldCounts.set(item?.field_id, (fieldCounts.get(item?.field_id) || 0) + 1);
    }
    for (const binding of bindings) {
      const fail = reason => unsupported.push({ field_id: typeof binding?.field_id === 'string' ? binding.field_id : '', reason });
      if (!record(binding) || ['field_id', 'node_id', 'input', 'class_type'].some(name => typeof binding[name] !== 'string' || !binding[name] || binding[name].length > 200) ||
          !TYPES.has(binding.type)) { fail('invalid_media_binding'); continue; }
      const key = keyOf(binding);
      if (counts.get(key) !== 1 || fieldCounts.get(binding.field_id) !== 1) { fail('ambiguous_media_binding'); continue; }
      const owner = binding.media_owner;
      if (!safeEditorMediaFilename(binding.value) || !record(owner) || owner.name !== binding.value || owner.media_type !== binding.type || owner.backend !== config.backendUrl) { fail('media_owner_unproven'); continue; }
      let target = findWidget(binding.node_id, binding.input);
      const actual = output?.[binding.node_id], nested = binding.node_id.includes(':');
      if (nested) {
        if (isolated.get(target.node)?.quarantined) { fail('nested_preview_context_changed'); continue; }
        const reason = nestedReason(binding.node_id, target);
        if (reason) { fail(reason); continue; }
      }
      if (target.reason || !nested && target.owner !== target.node || (target.node.comfyClass || target.node.type) !== binding.class_type ||
          actual?.class_type !== binding.class_type || !own(actual.inputs || {}, binding.input) || actual.inputs[binding.input] !== target.widget.value) { fail('media_mapping_unproven'); continue; }
      const contract = nativeMediaContract(target.node, binding.input, binding.type, registry());
      if (!contract) { fail('media_contract_unsupported'); continue; }
      if (nested) {
        if (binding.type === 'audio') {
          const surfaces = (target.node.widgets || []).filter(widget => widget.name === 'audioUI');
          if (surfaces.length !== 1 || !surfaces[0].element?.style || typeof surfaces[0].element.style.setProperty !== 'function') {
            fail('native_preview_not_isolated'); continue;
          }
        }
        if (!isolateNode(target.node, { node_id: binding.node_id, input: binding.input, target })) { fail('native_preview_not_isolated'); continue; }
        target = findWidget(binding.node_id, binding.input);
        if (nestedReason(binding.node_id, target)) { fail('media_mapping_unproven'); continue; }
      }
      if (!safeEditorMediaFilename(target.widget.value, true) || !verifyIsolation(target.node)) { fail('native_preview_not_isolated'); continue; }
      if (binding.type === 'audio') {
        const surfaces = (target.node.widgets || []).filter(widget => widget.name === 'audioUI');
        if (surfaces.length !== 1 || !surfaces[0].element || !isolated.get(target.node)?.elements.has(surfaces[0].element)) {
          fail('native_preview_not_isolated'); continue;
        }
      }
      const old = byBinding.get(key); if (old) receipts.delete(old.receipt);
      if (!old && receipts.size >= MAX_FIELDS) { fail('media_capture_limit'); continue; }
      const bytes = new Uint8Array(24); window.crypto.getRandomValues(bytes);
      const receipt = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('') + `-${++serial}`;
      const entry = { ...binding, ...contract, receipt, graph: graph(), node: target.node, owner: target.owner, widget: target.widget,
        native_value: target.widget.value, observed_value: target.widget.value,
        ...(nested ? { mappingProof: target.mappingProof } : {}) };
      receipts.set(receipt, entry); byBinding.set(key, entry);
      captured.push({ field_id: binding.field_id, node_id: binding.node_id, input: binding.input, type: binding.type,
        receipt, native_value: entry.native_value, preview_state: 'pending' });
    }
    refreshPreview(); return { captured, unsupported };
  }
  function observe(output, controls) {
    prune();
    const index = new Map();
    for (const control of controls) {
      const key = keyOf(control), matches = index.get(key) || []; matches.push(control); index.set(key, matches);
    }
    for (const entry of byBinding.values()) {
      const target = resolve(entry), actual = output?.[entry.node_id];
      if (!target || actual?.class_type !== entry.class_type || actual.inputs?.[entry.input] !== entry.widget.value || !safeEditorMediaFilename(entry.widget.value, true)) continue;
      // N cleanup and C redisplay are transaction mechanics, not a new user I.
      // Retain the last proven I until it is restored after clean persistence.
      if (!Object.is(entry.widget.value, entry.native_value) && !Object.is(entry.widget.value, entry.value)) entry.observed_value = entry.widget.value;
      const matches = index.get(keyOf(entry)) || [];
      if (matches.length === 1) matches[0].media_receipt = entry.receipt;
    }
    refreshPreview(); return controls;
  }
  function authorize(patch, target) {
    const entry = receipts.get(patch.media_receipt);
    if (!entry || !resolve(entry) || target.node !== entry.node || target.widget !== entry.widget ||
        patch.node_id !== entry.node_id || patch.widget_name !== entry.input || patch.class_type !== entry.class_type ||
        ![entry.native_value, entry.value, entry.observed_value].some(value => Object.is(value, patch.value))) return false;
    const allowed = safeEditorMediaFilename(patch.value, patch.value === entry.native_value && patch.value === '');
    const marker = isolated.get(entry.node);
    if (allowed && marker?.nested && !marker.promoted && (patch.value !== marker.nativeValue || target.widget.value !== marker.nativeValue)) marker.contaminated = true;
    return allowed;
  }
  function prune() {
    pruneIsolations();
    for (const [key, entry] of byBinding) if (!resolve(entry)) { byBinding.delete(key); receipts.delete(entry.receipt); }
  }
  function pruneIsolations() {
    const current = new Set(graph()?._nodes || graph()?.nodes || []);
    for (const [node, marker] of liveIsolations) {
      if (marker.nested) {
        if (!(marker.scope?._nodes || marker.scope?.nodes || []).includes(node)) retireIsolation(node, marker);
        else if (!marker.quarantined && !currentNested(marker)) {
          // C/I may already have been written, and late native decoders can
          // still hold it. Never reveal that surface in a newly shared scope.
          // Keep presentation isolated until a real re-add/reload boundary;
          // recovery must not rewrite graph values merely to repair a preview.
          const widget = (node.widgets || []).find(item => item.name === marker.input);
          if (marker.contaminated || !marker.promoted && widget?.value !== marker.nativeValue) {
            marker.quarantined = true; revokeNode(node); if (previewOwner === node) clearPreview();
          } else releaseIsolation(node, marker);
        }
      } else if (!current.has(node)) retireIsolation(node, marker);
    }
  }
  function reset() { receipts.clear(); byBinding.clear(); activeTrail = pendingTrail = null; clearPreview(); }
  let refreshQueued = false;
  function schedulePreview(event) {
    // Closing/folding/playing the independent panel must not immediately reopen it.
    if (panel && event?.target && (event.target === panel || panel.contains?.(event.target))) return;
    if (refreshQueued) return;
    refreshQueued = true;
    (window.requestAnimationFrame || (callback => window.setTimeout(callback, 0)))(() => { refreshQueued = false; refreshPreview(); });
  }
  const events = ['pointerup', 'input', 'change', 'keyup'];
  for (const event of events) document?.addEventListener?.(event, schedulePreview);
  document?.addEventListener?.('subgraph-opening', subgraphOpening);
  document?.addEventListener?.('subgraph-opened', subgraphOpened);
  function destroy() {
    reset(); preview?.destroy(); panel?.remove(); observerProbe?.disconnect?.();
    for (const marker of liveIsolations.values()) { marker.observer?.disconnect?.(); marker.retired = true; }
    liveIsolations.clear();
    for (const hooks of [...viewHooks.values(), ...scopeHooks.values()]) for (const item of hooks) item.active = false;
    for (const [owner, hooks] of viewHooks) restoreHooks(owner, hooks);
    for (const [owner, hooks] of scopeHooks) restoreHooks(owner, hooks);
    viewHooks.clear(); scopeHooks.clear();
    for (const event of events) document?.removeEventListener?.(event, schedulePreview);
    document?.removeEventListener?.('subgraph-opening', subgraphOpening);
    document?.removeEventListener?.('subgraph-opened', subgraphOpened);
    window.removeEventListener?.('pagehide', destroy);
    unavailable = true;
  }
  window.addEventListener?.('pagehide', destroy);
  return { arm, isolateNode, capture, observe, authorize, reset, refreshPreview, destroy,
    get supportsNestedCapture() { return Boolean(nestedAvailable()); } };
}
