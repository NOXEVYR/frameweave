import { app } from '/scripts/app.js';
// Isolated editor extension has no access to main-app static module routes.
// Kept equal to interface-limits.mjs by the capacity regression tests.
const MAX_INTERFACE_FIELDS = 4096;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;

// Loaded last through ComfyUI's extension list, inside a separate editor origin.
// The proxy remains the enforcement boundary for execution and backend writes.
const config = window.__PRISM_EDITOR__;
const state = { ready: false, loaded: false, claimed: false, source: null, lostOnLoad: [], pending: 0, seen: new Set(), tail: Promise.resolve(), nativeTail: Promise.resolve() };
const authorizedLoads = new WeakSet();
let additionReview = null;
const mappingReceipts = new Map(), mappingBindings = new Map(), mappingLifecycles = new WeakMap();
let mappingSerial = 0;
const clone = value => JSON.parse(JSON.stringify(value));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Older running proxies serve the latest bridge but do not know these routes.
// Never request new modules unless this proxy explicitly advertises the protocol.
const noMedia = { arm() {}, isolateNode() {}, reset() {}, refreshPreview() {}, observe() {}, authorize() { return false; },
  capture(bindings) { return { captured: [], unsupported: (bindings || []).map(item => ({ field_id: item.field_id, reason: 'media_capture_not_supported' })) }; } };
let media = noMedia, mediaBootstrapped = config?.mediaProtocol !== 1, mediaBootstrap = null;
function bootstrapMedia() {
  if (mediaBootstrapped) return Promise.resolve();
  return mediaBootstrap ||= Promise.all([import('/prism-editor-media.mjs'), import('/prism-editor-media-preview.mjs')])
    .then(async ([module, preview]) => {
      let frontendCapability, createExposureIsolation;
      if (config?.promotedAudioProtocol === 1) {
        try {
          const [capabilities, exposures] = await Promise.all([import('/prism-editor-frontend-capabilities.mjs'), import('/prism-editor-preview-exposures.mjs')]);
          frontendCapability = await capabilities.discoverNativeFrontendCapabilities({ app, window, document,
            location: window.location, fetch: window.fetch.bind(window) });
          if (frontendCapability.supported) createExposureIsolation = exposures.createPreviewExposureIsolation;
        } catch { /* Unknown frontend profiles keep the existing safe fallback. */ }
      }
      const implementation = module.createNativeEditorMedia({ app, window, document: typeof document === 'undefined' ? null : document,
        graph, findWidget, sameMappingProof, config, createPreview: preview.createEditorMediaPreview, frontendCapability, createExposureIsolation });
      if (implementation.arm() === false) { implementation.destroy?.(); return; }
      media = implementation;
    }).catch(() => { media = noMedia; }).finally(() => { mediaBootstrapped = true; });
}
function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validateApiPrompt(value) {
  let prompt;
  try {
    const raw = JSON.stringify(value);
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 16 * 1024 * 1024) throw new Error();
    prompt = JSON.parse(raw);
  } catch { throw new Error('invalid-api-prompt'); }
  if (!isRecord(prompt) || !Object.keys(prompt).length
      || Object.values(prompt).some(node => !isRecord(node)
        || typeof node.class_type !== 'string' || !node.class_type
        || !isRecord(node.inputs))) throw new Error('invalid-api-prompt');
  return prompt;
}
function isExplicitOptionalDefault(nodeId, classType, input, value) {
  if (!['string', 'number', 'boolean'].includes(typeof value) ||
      typeof value === 'number' && !Number.isFinite(value) || nodeId.includes(':')) return false;
  const root = graph(), registry = window.LiteGraph?.registered_node_types;
  const node = root?.getNodeById?.(nodeId) || (root?._nodes || root?.nodes || []).find(item => String(item.id) === nodeId);
  const registered = registry?.[classType], constructor = node?.constructor, data = constructor?.nodeData;
  if (!node || (node.comfyClass || node.type) !== classType || !registered ||
      (registered !== constructor && registered.nodeData !== data) || !isRecord(data?.input?.optional) ||
      !Object.hasOwn(data.input.optional, input)) return false;
  const spec = data.input.optional[input];
  if (!Array.isArray(spec) || !isRecord(spec[1]) || !Object.hasOwn(spec[1], 'default') ||
      !Object.is(spec[1].default, value) || spec[1].multiselect) return false;
  const [kind, meta] = spec;
  if (kind === 'STRING') return typeof value === 'string';
  if (kind === 'BOOLEAN') return typeof value === 'boolean';
  if (kind === 'INT') return Number.isSafeInteger(value);
  if (kind === 'FLOAT') return typeof value === 'number';
  const options = Array.isArray(kind) ? kind : kind === 'COMBO' ? meta.options :
    kind === 'COMFY_DYNAMICCOMBO_V3' && Array.isArray(meta.options) ? meta.options.map(item => item?.key) : null;
  return Array.isArray(options) && options.some(item => Object.is(item, value));
}
function compareApiPrompts(expected, actual) {
  const expectedPrompt = validateApiPrompt(expected);
  const actualPrompt = validateApiPrompt(actual);
  for (const [nodeId, expectedNode] of Object.entries(expectedPrompt)) {
    const actualNode = actualPrompt[nodeId];
    const actualMeta = actualNode?._meta;
    const expectedMeta = expectedNode._meta;
    // ComfyUI's graphToPrompt adds its UI title to every node. Ignore only
    // that newly-added display field; declared titles and all other metadata
    // remain part of the semantic comparison.
    if (isRecord(actualMeta) &&
        !(isRecord(expectedMeta) && Object.hasOwn(expectedMeta, 'title')) &&
        typeof actualMeta.title === 'string' && actualMeta.title.length > 0) {
      delete actualMeta.title;
      if (!isRecord(expectedMeta) && Object.keys(actualMeta).length === 0) delete actualNode._meta;
    }
  }
  const issues = [];
  let mismatchCount = 0;
  const safeKey = key => /^[A-Za-z0-9_:.-]{1,100}$/.test(key) ? key : '[非标准结构标识]';
  const add = (code, nodeId, key, kind = 'input') => {
    mismatchCount++;
    if (issues.length < 64) issues.push({ code, node_id: safeKey(nodeId), ...(key === undefined ? {} : { [kind]: safeKey(key) }) });
  };
  for (const id of new Set([...Object.keys(expectedPrompt), ...Object.keys(actualPrompt)])) {
    const left = expectedPrompt[id], right = actualPrompt[id];
    if (!left) { add('added_node', id); continue; }
    if (!right) { add('missing_node', id); continue; }
    if (left.class_type !== right.class_type) add('class_changed', id);
    for (const key of new Set([...Object.keys(left.inputs), ...Object.keys(right.inputs)])) {
      if (!Object.hasOwn(left.inputs, key)) {
        if (!isExplicitOptionalDefault(id, right.class_type, key, right.inputs[key])) add('added_input', id, key);
      }
      else if (!Object.hasOwn(right.inputs, key)) add('missing_input', id, key);
      else if (canonicalJSON(left.inputs[key]) !== canonicalJSON(right.inputs[key])) add('value_changed', id, key);
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      if (['class_type', 'inputs'].includes(key)) continue;
      if (canonicalJSON(left[key]) !== canonicalJSON(right[key])) add(key === '_meta' ? 'metadata_changed' : 'node_field_changed', id, key, 'field');
    }
  }
  return { equivalent: mismatchCount === 0, issues, mismatch_count: mismatchCount, truncated: mismatchCount > issues.length };
}
function apiPromptsEquivalent(expected, actual) {
  return compareApiPrompts(expected, actual).equivalent;
}

// A frontend-generated value is a conversion, even when its widget happens to
// initialize to the first choice. Approval is limited to this exact conversion.
function reviewableApiAdditions(expected, actual, comparison) {
  if (comparison.equivalent || comparison.truncated ||
      comparison.issues.some(issue => issue.code !== 'added_input')) return null;
  const additions = [], proofs = [];
  for (const [nodeId, original] of Object.entries(expected)) {
    const next = actual[nodeId];
    if (!next || nodeId.includes(':') || !/^[A-Za-z0-9_.-]{1,100}$/.test(nodeId)) return null;
    const keys = Object.keys(next.inputs).filter(key => !Object.hasOwn(original.inputs, key));
    if (!keys.length) continue;
    const root = graph(), registry = window.LiteGraph?.registered_node_types;
    const node = root?.getNodeById?.(nodeId) || (root?._nodes || root?.nodes || []).find(item => String(item.id) === nodeId);
    const registered = registry?.[next.class_type], constructor = node?.constructor, data = constructor?.nodeData;
    if (!node || (node.comfyClass || node.type) !== next.class_type || !registered ||
        (registered !== constructor && registered.nodeData !== data) || !isRecord(data?.input)) return null;
    const active = new Map();
    let visited = 0, invalid = false;
    function walk(inputs, prefix = '', parents = [], depth = 0) {
      if (!isRecord(inputs) || depth > 16) { invalid = true; return; }
      for (const group of ['required', 'optional']) {
        if (inputs[group] === undefined) continue;
        if (!isRecord(inputs[group])) { invalid = true; return; }
        for (const [name, spec] of Object.entries(inputs[group])) {
          if (++visited > 4096) { invalid = true; return; }
          const path = prefix ? `${prefix}.${name}` : name;
          if (active.has(path) || Object.hasOwn(inputs.hidden || {}, name)) { invalid = true; return; }
          active.set(path, { spec, parents, group });
          if (Array.isArray(spec) && spec[0] === 'COMFY_DYNAMICCOMBO_V3' && Array.isArray(spec[1]?.options)) {
            const selected = spec[1].options.filter(option => Object.is(option?.key, next.inputs[path]));
            if (selected.length === 1) walk(selected[0].inputs, path,
              [...parents, { input: path, value: next.inputs[path], spec }], depth + 1);
            else if (selected.length > 1) invalid = true;
          }
        }
      }
    }
    walk(data.input);
    if (invalid) return null;
    for (const input of keys) {
      if (additions.length >= 64 || next.class_type.length > 200 || !/^[A-Za-z0-9_.-]{1,160}$/.test(input) ||
          /(?:^|[_.-])(image|audio|video|mask|file|filename|path|url|directory|folder|model|checkpoint|ckpt|lora|vae)(?:$|[_.-])/i.test(input)) return null;
      const declared = active.get(input), value = next.inputs[input];
      if (!declared || !Array.isArray(declared.spec)) return null;
      const [kind, rawMeta] = declared.spec, meta = isRecord(rawMeta) ? rawMeta : {};
      if (meta.forceInput || meta.multiselect || meta.image_upload || meta.audio_upload || meta.video_upload ||
          !['string', 'number', 'boolean'].includes(typeof value) ||
          typeof value === 'number' && !Number.isFinite(value) ||
          typeof value === 'string' && (value.length > 2048 || /[\\/]|^[a-z][a-z0-9+.-]*:/i.test(value))) return null;
      const options = Array.isArray(kind) ? kind : kind === 'COMBO' ? meta.options :
        kind === 'COMFY_DYNAMICCOMBO_V3' && Array.isArray(meta.options) ? meta.options.map(option => option?.key) : null;
      const valid = kind === 'STRING' ? typeof value === 'string' : kind === 'BOOLEAN' ? typeof value === 'boolean' :
        kind === 'INT' ? Number.isSafeInteger(value) : kind === 'FLOAT' ? typeof value === 'number' :
        Array.isArray(options) && options.some(option => Object.is(option, value));
      if (!valid || typeof value === 'number' &&
          (typeof meta.min === 'number' && value < meta.min || typeof meta.max === 'number' && value > meta.max)) return null;
      additions.push({ node_id: nodeId, class_type: next.class_type, input, value });
      proofs.push({ node_id: nodeId, input, ...declared });
    }
  }
  const proof = canonicalJSON(proofs);
  return additions.length && proof.length <= 256 * 1024 ? { additions, proof } : null;
}
function createAdditionReview(prompt, before, candidates) {
  const crypto = window.crypto;
  if (typeof crypto?.getRandomValues !== 'function') return null;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const review_id = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  additionReview = { review_id, prompt: canonicalJSON(prompt), before: canonicalJSON(before),
    additions: canonicalJSON(candidates.additions), proof: candidates.proof, expires: Date.now() + 5 * 60 * 1000 };
  return { review_id, added_inputs: candidates.additions };
}
function graph() {
  // New ComfyUI frontends expose non-logging readiness accessors. Prefer them:
  // reading `app.rootGraph`/`app.graph` while GraphCanvas is mounting logs an
  // initialization error and can hand API imports an unconfigured graph.
  if ('rootGraphOrUndefined' in app) return app.rootGraphOrUndefined || null;
  if (app.isGraphReady === false) return null;
  try { return app.rootGraph || app.graph || null; } catch { return null; }
}
function canvasReady(root) {
  let canvas;
  if ('canvasOrUndefined' in app) canvas = app.canvasOrUndefined;
  else {
    if (app.isGraphReady === false) return false;
    try { canvas = app.canvas; } catch { return false; }
  }
  if (!canvas) return false;
  const canvasRef = app.canvasElRef;
  if (canvasRef && !canvasRef.value) return false;
  const element = canvasRef?.value || canvas.canvas;
  if (element?.isConnected === false) return false;
  return !canvas.graph || !root || canvas.graph === root;
}
function frontendReady() {
  const root = graph();
  if (!root || !window.LiteGraph?.registered_node_types) return false;
  // ComfyUI's current GraphView sets the module-level canvas before publishing
  // the mounted app on window. The editor's Pinia canvas store is still null
  // during that gap, so `loadApiJson` would fail in beforeLoadNewGraph().
  if (window.app !== app) return false;
  if (window.graph && window.graph !== root) return false;
  if (app.vueAppReady === false) return false;
  // Current ComfyUI frontends keep this splash element mounted until the
  // startup workflow and restored tabs have finished loading. The app/canvas
  // objects become visible earlier, while startup can still clear the graph.
  if (typeof document !== 'undefined' && document.querySelector?.('#splash-loader')?.isConnected) return false;
  return canvasReady(root);
}
const blockedQueue = async () => { throw new Error('请返回棱光画布执行工作流；此窗口仅用于编辑。'); };

function send(message) {
  window.parent.postMessage(clone({ source: 'prism-editor', nonce: config.bridgeNonce, ...message }), config.parentOrigin);
}

function installDocumentGate() {
  const nativeLoad = app.loadGraphData;
  app.loadGraphData = function (document, ...args) {
    const authorized = document && typeof document === 'object' && authorizedLoads.delete(document);
    const replacesDocument = args[0] !== false;
    const receiver = this;
    const pending = state.nativeTail.then(() => {
      // GraphCanvas restores its startup document AFTER extension setup. That
      // restore may arrive arbitrarily late, so a timer is not an ownership
      // boundary. Parent loads claim this editor until it closes. Native undo
      // and redo use clean=false and continue to work through the same queue.
      if (!authorized && state.claimed && replacesDocument) {
        send({ action: 'notice', result: { message: '此编辑器已绑定当前工作流；新建、打开或切换完整工作流请返回外层画布。' } });
        return;
      }
      return nativeLoad.call(receiver, document, ...args);
    });
    // Await an already-running startup restore before applying a parent load.
    // A failed native operation must not poison later loads or undo/redo.
    state.nativeTail = pending.catch(() => {});
    return pending;
  };
}

function graphEntries(document) {
  const subgraphs = new Set(), entries = [], definitions = new Map();
  // Walk graph containers only; widget values and prompt text are not schemas.
  function walk(value, path) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value.nodes)) {
      for (const node of value.nodes) {
        entries.push({ node, path, key: JSON.stringify([path, String(node.id), node.type]) });
        walk(node.subgraph, `${path}/node:${node.id}`);
      }
    }
    const nestedDefinitions = value.definitions?.subgraphs;
    if (Array.isArray(nestedDefinitions)) for (const definition of nestedDefinitions) {
      if (typeof definition.id === 'string') {
        subgraphs.add(definition.id);
        definitions.set(definition.id, { graph: definition, path: `${path}/definition:${definition.id}` });
      }
      walk(definition, `${path}/definition:${definition.id}`);
    }
    for (const [name, definition] of Object.entries(value.extra?.groupNodes || {})) walk(definition, `${path}/group:${name}`);
  }
  walk(document, 'root');
  return { entries, subgraphs, definitions };
}

function lostDuringLoad(source, loaded) {
  const before = graphEntries(source), after = graphEntries(loaded), preserved = new Map(), paired = new Map();
  const counts = entries => {
    const result = new Map();
    for (const { node } of entries) result.set(String(node.id), (result.get(String(node.id)) || 0) + 1);
    return result;
  };
  const oldIds = counts(before.entries), newIds = counts(after.entries);
  const keyOf = (path, node) => JSON.stringify([path, String(node.id), node.type]);
  function pairDefinition(oldId, newId) {
    const old = before.definitions.get(oldId), next = after.definitions.get(newId);
    if (!old || !next) return false;
    if (paired.has(oldId)) return paired.get(oldId) === newId;
    if ([...paired.values()].includes(newId)) return false;
    paired.set(oldId, newId);
    align(old.graph, next.graph, old.path, next.path, true);
    return true;
  }
  function align(oldGraph, newGraph, oldPath, newPath, definition = false) {
    const oldNodes = oldGraph?.nodes || [], newNodes = newGraph?.nodes || [];
    if (!Array.isArray(oldNodes) || !Array.isArray(newNodes)) return;
    const available = new Map(), used = new Set();
    for (const node of newNodes) {
      const id = String(node.id); if (!available.has(id)) available.set(id, []); available.get(id).push(node);
    }
    for (const [index, node] of oldNodes.entries()) {
      let candidate = available.get(String(node.id))?.find(item => !used.has(item));
      // Official deduplication only renumbers conflicting nodes within a
      // definition. It retains array order and all nodes; root IDs stay fixed.
      if (!candidate && definition && oldNodes.length === newNodes.length && oldIds.get(String(node.id)) > 1) {
        const positional = newNodes[index];
        if (positional && !used.has(positional) && !oldIds.has(String(positional.id)) && newIds.get(String(positional.id)) === 1) candidate = positional;
      }
      if (!candidate) continue;
      const sameType = node.type === candidate.type;
      const subgraphType = before.definitions.has(node.type) && after.definitions.has(candidate.type);
      if (!sameType && !subgraphType) continue;
      if (subgraphType && !pairDefinition(node.type, candidate.type)) continue;
      used.add(candidate);
      const key = keyOf(oldPath, node); preserved.set(key, (preserved.get(key) || 0) + 1);
      if (node.subgraph) align(node.subgraph, candidate.subgraph, `${oldPath}/node:${node.id}`, `${newPath}/node:${candidate.id}`);
    }
    for (const [name, group] of Object.entries(oldGraph?.extra?.groupNodes || {})) {
      align(group, newGraph?.extra?.groupNodes?.[name], `${oldPath}/group:${name}`, `${newPath}/group:${name}`);
    }
  }
  align(source, loaded, 'root', 'root');
  for (const [id] of before.definitions) if (!paired.has(id) && after.definitions.has(id)) pairDefinition(id, id);
  // Unreferenced legacy definitions can also be UUID-normalized and hoisted.
  // Only a unique complete shape can identify those; ambiguity is not guessed.
  const shape = (definition, definitions) => canonicalJSON([definition.name,
    (definition.nodes || []).map(node => [definitions.has(node.type) ? '@subgraph' : node.type, node.widgets_values, node.mode ?? 0])]);
  for (const [id, old] of before.definitions) {
    if (paired.has(id)) continue;
    const matches = [...after.definitions].filter(([nextId, next]) => ![...paired.values()].includes(nextId) &&
      shape(old.graph, before.definitions) === shape(next.graph, after.definitions));
    if (matches.length === 1) pairDefinition(id, matches[0][0]);
  }
  return before.entries.filter(entry => {
    const remaining = preserved.get(entry.key) || 0;
    if (remaining) { preserved.set(entry.key, remaining - 1); return false; }
    return true;
  })
    .map(({ node, path }) => ({ node_id: String(node.id), type: String(node.type || '(unknown)'), graph_path: path }));
}

function inspect(document) {
  const registry = window.LiteGraph?.registered_node_types;
  if (!registry) throw new Error('registry');
  const missing = new Set(), { entries, subgraphs } = graphEntries(document);
  for (const { node } of entries) {
    if (typeof node.type !== 'string' || (!Object.hasOwn(registry, node.type) && !subgraphs.has(node.type))) missing.add(String(node.type || '(unknown)'));
  }
  return { missing: [...missing].sort(), nodes: document.nodes.length, links: Array.isArray(document.links) ? document.links.length : Object.keys(document.links || {}).length };
}

function summarize(document) {
  const summary = inspect(document);
  if (state.lostOnLoad.length) {
    summary.missing = [...new Set([...summary.missing, ...state.lostOnLoad.map(item => item.type)])].sort();
    summary.lost_on_load = state.lostOnLoad;
  }
  return summary;
}

// Short-lived lookup: rebuild after widget callbacks; never cache live owners.
function widgetLookup() {
  const scopes = new WeakMap(), widgets = new WeakMap(), inputs = new WeakMap();
  const schemaContents = new WeakMap(), optionContents = new WeakMap();
  const content = (cache, value) => {
    if (!value || typeof value !== 'object') return canonicalJSON(value);
    if (!cache.has(value)) cache.set(value, canonicalJSON(value));
    return cache.get(value);
  };
  const indexed = (cache, owner, items, keys) => {
    let index = cache.get(owner);
    if (!index) {
      index = new Map();
      for (const item of items) for (const key of new Set(keys(item))) {
        const matches = index.get(key) || []; matches.push(item); index.set(key, matches);
      }
      cache.set(owner, index);
    }
    return index;
  };
  return {
    nodes: scope => indexed(scopes, scope, scope._nodes || scope.nodes || [], node => [String(node.id)]),
    widgets: owner => indexed(widgets, owner, owner.widgets || [], widget => [widget.name]),
    inputs: owner => indexed(inputs, owner, owner.inputs || [], input => [input.name, input.widget?.name]),
    schemaContent: value => content(schemaContents, value),
    optionsContent: value => content(optionContents, value),
    occurrences: null,
  };
}
function localNode(scope, id, lookup = null) {
  const nodes = scope?._nodes || scope?.nodes;
  if (Array.isArray(nodes)) {
    const matches = lookup ? lookup.nodes(scope).get(String(id)) || [] : nodes.filter(node => String(node.id) === String(id));
    if (matches.length !== 1) return null;
    return matches[0];
  }
  return scope?.getNodeById?.(id) || null;
}

function instanceOccurrences(root) {
  const counts = new Map();
  let budget = 10000, invalid = false;
  function visit(scope, ancestors, depth) {
    if (!scope || depth > 32 || ancestors.has(scope) || --budget < 0) { invalid = true; return; }
    counts.set(scope, (counts.get(scope) || 0) + 1);
    const next = new Set(ancestors); next.add(scope);
    for (const node of scope._nodes || scope.nodes || []) {
      if (node.isSubgraphNode?.() === true) visit(node.subgraph, next, depth + 1);
      if (invalid) return;
    }
  }
  visit(root, new Set(), 0);
  return { counts, invalid };
}

// View-only operations use the active scope; compilation always uses graph().
// Reuse the installed frontend's immediate fitting API, without changing any
// selection, node position or widget value.
function fitEditorView(onlyWhenUnreadable = false) {
  const canvas = app.canvasOrUndefined || app.canvas, scope = canvas?.graph;
  const nodes = scope?._nodes || scope?.nodes || [];
  const ds = canvas?.ds, element = canvas?.canvas;
  const dpi = Number(window.devicePixelRatio) || 1;
  const width = element?.width / dpi, height = element?.height / dpi;
  if (!scope || !nodes.length || typeof ds?.fitToBounds !== 'function' ||
      !Number.isFinite(width) || !Number.isFinite(height) || width < 64 || height < 64) return { fitted: false };
  const boxes = [];
  for (const node of nodes) {
    let box = node.boundingRect;
    if (box?.every?.(value => value === 0)) { node.updateArea?.(); box = node.boundingRect; }
    if (!box) box = [node.pos?.[0], node.pos?.[1], node.size?.[0], node.size?.[1]];
    if (box.length !== 4 || !Array.from(box).every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return { fitted: false };
    boxes.push(Array.from(box));
  }
  if (onlyWhenUnreadable && Number.isFinite(ds.scale) && ds.scale > 0 &&
      ds.offset?.length === 2 && Array.from(ds.offset).every(Number.isFinite)) {
    const inset = Math.min(48, width * 0.1, height * 0.1);
    const readable = boxes.some(([x, y, w, h]) => {
      const left = (x + ds.offset[0]) * ds.scale, top = (y + ds.offset[1]) * ds.scale;
      const nw = w * ds.scale, nh = h * ds.scale;
      const visibleWidth = Math.max(0, Math.min(width - inset, left + nw) - Math.max(inset, left));
      const visibleHeight = Math.max(0, Math.min(height - inset, top + nh) - Math.max(inset, top));
      return visibleWidth >= Math.min(96, nw) && visibleHeight >= Math.min(64, nh) &&
        visibleWidth * visibleHeight >= Math.min(nw * nh * 0.5, width * height * 0.25);
    });
    if (readable) return { fitted: false };
  }
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box[0]); top = Math.min(top, box[1]);
    right = Math.max(right, box[0] + box[2]); bottom = Math.max(bottom, box[1] + box[3]);
  }
  ds.fitToBounds([left, top, right - left, bottom - top]);
  canvas.setDirty?.(true, true);
  return { fitted: true };
}

function resolveExecutionNode(nodeId, lookup = null) {
  if (typeof nodeId !== 'string' && typeof nodeId !== 'number') return { reason: 'invalid_node_id' };
  const parts = String(nodeId).split(':');
  if (parts.length > 33 || parts.some(part => !part)) return { reason: 'invalid_instance_path' };
  let scope = graph();
  const hosts = [], scopes = [scope], visited = new Set();
  for (const id of parts.slice(0, -1)) {
    if (visited.has(scope)) return { reason: 'recursive_subgraph' };
    visited.add(scope);
    const host = localNode(scope, id, lookup);
    if (!host) return { reason: 'instance_not_found' };
    if (host.isSubgraphNode?.() !== true || !host.subgraph) return { reason: 'not_subgraph_instance' };
    hosts.push(host); scope = host.subgraph; scopes.push(scope);
  }
  const node = localNode(scope, parts.at(-1), lookup);
  if (!node) return { reason: 'node_not_found' };
  return { node, scope, hosts, scopes, parts };
}

function mappingLifecycle(node) {
  let marker = mappingLifecycles.get(node);
  if (marker) return marker;
  const descriptors = ['onAdded', 'onRemoved'].map(name => [name, Object.getOwnPropertyDescriptor(node, name), node[name]]);
  if (!Object.isExtensible(node) || descriptors.some(([, descriptor, original]) =>
    descriptor && (!descriptor.configurable || !Object.hasOwn(descriptor, 'value')) || original !== undefined && typeof original !== 'function')) return null;
  marker = { epoch: 0 };
  for (const [name, , original] of descriptors) Object.defineProperty(node, name, {
    configurable: true, enumerable: false, writable: true,
    value: function (...args) { marker.epoch++; return original?.apply(this, args); },
  });
  mappingLifecycles.set(node, marker);
  return marker;
}

function mappingNodeProof(node) {
  const lifecycle = mappingLifecycle(node);
  return { node, id: String(node.id), graph: node.graph, type: node.type, comfyClass: node.comfyClass, mode: node.mode,
    constructor: node.constructor, subgraph: node.subgraph, lifecycle, epoch: lifecycle?.epoch,
    onAdded: node.onAdded, onRemoved: node.onRemoved };
}

function mappingSlotProof(scope, owner, slot) {
  const link = slot?.link == null ? null : scope.getLink?.(slot.link) || scope.links?.get?.(slot.link) || scope.links?.[slot.link];
  return { scope, owner, slot: slot || null, link, linkId: slot?.link, name: slot?.name,
    locator: slot?.widget, widgetName: slot?.widget?.name, widgetId: slot?.widgetId,
    originIsIoNode: link?.originIsIoNode, originId: link?.origin_id, originSlot: link?.origin_slot,
    targetId: link?.target_id, targetSlot: link?.target_slot };
}

function sameMappingProof(before, after) {
  if (!before || !after) return false;
  for (const name of ['root', 'node', 'owner', 'widget', 'scope', 'widgetId', 'widgetName', 'widgetType',
    'schemaOwner', 'registered', 'schema', 'schemaInput', 'schemaContent', 'widgetOptions', 'widgetOptionsContent',
    'widgetDisabled', 'widgetReadOnly', 'widgetSerialize', 'widgetPath']) if (before[name] !== after[name]) return false;
  for (const name of ['nodes', 'slots']) {
    if (before[name].length !== after[name].length) return false;
    for (let index = 0; index < before[name].length; index++) {
      const a = before[name][index], b = after[name][index];
      if (Object.keys(a).some(key => a[key] !== b[key])) return false;
    }
  }
  return true;
}

function findWidget(nodeId, name, lookup = null, inspectUI = false) {
  const resolved = resolveExecutionNode(nodeId, lookup);
  if (resolved.reason) return resolved;
  const { node, parts, hosts } = resolved, slotsProof = [];
  let owner = node, scope = resolved.scope, widgetName = name, depth = hosts.length;
  const occurrences = depth ? lookup ? (lookup.occurrences ||= instanceOccurrences(graph())) : instanceOccurrences(graph()) : null;
  if (occurrences?.invalid) return { reason: 'instance_traversal_limit' };
  // A promoted input is an IO link to its containing instance. Follow that
  // actual slot/link chain, never a global search for a repeated child ID.
  while (true) {
    const slots = lookup ? lookup.inputs(owner).get(widgetName) || [] : (owner.inputs || []).filter(input => input.name === widgetName || input.widget?.name === widgetName);
    if (slots.length > 1) return { reason: 'ambiguous_input' };
    const slot = slots[0];
    slotsProof.push(mappingSlotProof(scope, owner, slot));
    if (slot?.link == null) break;
    const link = scope.getLink?.(slot.link) || scope.links?.get?.(slot.link) || scope.links?.[slot.link];
    if (!depth || !link?.originIsIoNode || !Number.isInteger(link.origin_slot)) return { reason: 'connected_input' };
    if (link.target_id !== undefined && String(link.target_id) !== String(owner.id) ||
        link.target_slot !== undefined && owner.inputs?.[link.target_slot] !== slot) return { reason: 'input_link_mismatch' };
    const host = hosts[depth - 1], hostSlot = host.inputs?.[link.origin_slot];
    if (!hostSlot || !hostSlot.widget || typeof hostSlot.widget.name !== 'string') return { reason: 'promoted_widget_not_found' };
    owner = host; depth--;
    scope = depth ? hosts[depth - 1].subgraph : graph();
    widgetName = hostSlot.widget.name;
  }
  if (hosts.length && occurrences.counts.get(scope) !== 1) return { reason: 'shared_definition_widget' };
  const candidates = lookup ? lookup.widgets(owner).get(widgetName) || [] : (owner.widgets || []).filter(widget => widget.name === widgetName);
  if (candidates.length !== 1) return { reason: candidates.length ? 'ambiguous_widget' : 'widget_not_found' };
  const widget = candidates[0];
  // Read-only UI filtering needs the same instance/promotion proof, including
  // nonserializing buttons. It never grants these widgets a write capability.
  if (String(widget.type).startsWith('converted-widget') || !inspectUI &&
      (widget.options?.serialize === false || widget.disabled || widget.options?.read_only)) return { reason: 'widget_not_writable' };
  if (!inspectUI && !['string', 'number', 'boolean'].includes(typeof widget.value)) return { reason: 'unsupported_widget_value' };
  const widgetPath = parts.slice(0, depth + 1).join(':');
  const schema = node.constructor?.nodeData, schemaInput = schema?.input;
  let mappingProof = null;
  try { mappingProof = { root: graph(), node, owner, widget, scope, widgetId: widget.widgetId,
    widgetName: widget.name, widgetType: widget.type, widgetPath,
    schemaOwner: node.constructor, registered: window.LiteGraph?.registered_node_types?.[node.comfyClass || node.type],
    schema, schemaInput, schemaContent: lookup ? lookup.schemaContent(schemaInput) : canonicalJSON(schemaInput),
    widgetOptions: widget.options, widgetOptionsContent: lookup ? lookup.optionsContent(widget.options) : canonicalJSON(widget.options),
    widgetDisabled: widget.disabled, widgetReadOnly: widget.options?.read_only, widgetSerialize: widget.options?.serialize,
    nodes: [...hosts, node].map(mappingNodeProof), slots: slotsProof }; }
  catch { /* Opaque extension metadata must not break ordinary legacy controls. */ }
  return { node, widget, owner, widget_path: widgetPath, mappingProof };
}

const mappingKey = (nodeId, input) => JSON.stringify([String(nodeId), input]);
function resetMappings() { mappingReceipts.clear(); mappingBindings.clear(); }
function forgetMapping(entry) {
  mappingReceipts.delete(entry.receipt);
  if (mappingBindings.get(mappingKey(entry.node_id, entry.input)) === entry) mappingBindings.delete(mappingKey(entry.node_id, entry.input));
}
function currentMapping(entry, lookup = null) {
  try {
    const target = findWidget(entry.node_id, entry.input, lookup);
    if (!target.reason && sameMappingProof(entry.proof, target.mappingProof)) return target;
  } catch { /* A removed or opaque mapping is never recoverable by matching IDs. */ }
  forgetMapping(entry); return null;
}
function captureMappings(bindings, output) {
  if (!Array.isArray(bindings) || bindings.length > MAX_INTERFACE_FIELDS || new TextEncoder().encode(JSON.stringify(bindings)).length > MAX_PATCH_BYTES) throw new Error('invalid-mapping-bindings');
  const captured = [], unsupported = [], counts = new Map(), lookup = widgetLookup();
  for (const entry of mappingBindings.values()) currentMapping(entry, lookup);
  for (const binding of bindings) { const key = mappingKey(binding?.node_id, binding?.input); counts.set(key, (counts.get(key) || 0) + 1); }
  for (const binding of bindings) {
    const identity = { node_id: binding?.node_id, input: binding?.input }, fail = reason => unsupported.push({ ...identity, reason });
    if (!isRecord(binding) || ['node_id', 'input', 'class_type'].some(name => typeof binding[name] !== 'string' || !binding[name] || binding[name].length > 200)) { fail('invalid_mapping_binding'); continue; }
    const key = mappingKey(binding.node_id, binding.input);
    if (counts.get(key) !== 1) { fail('ambiguous_mapping_binding'); continue; }
    const target = findWidget(binding.node_id, binding.input, lookup), definition = output?.[binding.node_id];
    if (target.reason) { fail(target.reason); continue; }
    if ((target.node.comfyClass || target.node.type) !== binding.class_type || definition?.class_type !== binding.class_type ||
        !Object.hasOwn(definition.inputs || {}, binding.input) || !Object.is(definition.inputs[binding.input], target.widget.value)) { fail('compiled_mapping_mismatch'); continue; }
    if (!target.mappingProof) { fail('mapping_proof_unavailable'); continue; }
    if (target.mappingProof.nodes.some(item => !item.lifecycle)) { fail('mapping_lifecycle_unavailable'); continue; }
    const old = mappingBindings.get(key);
    if (!old && mappingReceipts.size >= MAX_INTERFACE_FIELDS) { fail('mapping_capture_limit'); continue; }
    if (old) forgetMapping(old);
    const bytes = new Uint8Array(24); window.crypto.getRandomValues(bytes);
    const receipt = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') + `-m${++mappingSerial}`;
    const entry = { ...binding, receipt, proof: target.mappingProof };
    mappingBindings.set(key, entry); mappingReceipts.set(receipt, entry);
    captured.push({ ...identity, receipt, native_value: target.widget.value });
  }
  return { captured, unsupported };
}
function verifyRequestedMappings(items, output = null) {
  if (items === undefined) return;
  if (!Array.isArray(items) || items.length > MAX_INTERFACE_FIELDS || new TextEncoder().encode(JSON.stringify(items)).length > MAX_PATCH_BYTES) throw new Error('invalid-mapping-receipts');
  const seen = new Set(), lookup = widgetLookup();
  for (const item of items) {
    const entry = mappingReceipts.get(item?.receipt), key = mappingKey(item?.node_id, item?.input);
    const target = entry && currentMapping(entry, lookup);
    if (!target || seen.has(key) || entry.node_id !== item.node_id || entry.input !== item.input ||
        output && (output[entry.node_id]?.class_type !== entry.class_type || !Object.is(output[entry.node_id]?.inputs?.[entry.input], target.widget.value))) throw new Error('mapping-receipt-changed');
    seen.add(key);
  }
}

function uiWidgetReason(widget) {
  return widget?.type === 'button' ? 'undeclared_button_widget' :
    typeof window.Element === 'function' && widget?.element instanceof window.Element ? 'undeclared_dom_widget' :
      widget?.options?.serialize === false ? 'nonserializing_widget' : null;
}

async function stripUndeclaredUIInputs(value, expected = null) {
  // Some extensions serialize action buttons into graphToPrompt's API inputs.
  // Remove only proven frontend additions, from a copy of the API output.
  // Widget positions, display names and undeclared strings are not evidence.
  const output = clone(value), ignored_ui_inputs = [];
  const root = graph(), registry = window.LiteGraph?.registered_node_types;
  if (!root || !registry) return { output, ignored_ui_inputs };
  const candidates = [], lookup = widgetLookup();
  for (const [nodeId, definition] of Object.entries(output)) {
    if (!isRecord(definition?.inputs)) continue;
    const { node } = resolveExecutionNode(nodeId, lookup);
    if (!node || (node.comfyClass || node.type) !== definition.class_type) continue;
    const constructor = node.constructor, registered = registry[definition.class_type];
    const nodeData = constructor?.nodeData, specification = nodeData?.input;
    if (!Object.hasOwn(registry, definition.class_type) || !registered ||
        (registered !== constructor && registered.nodeData !== nodeData) ||
        !isRecord(specification)) continue;
    const groups = ['required', 'optional', 'hidden'].map(name => specification[name]);
    if (groups.some(group => group !== undefined && !isRecord(group))) continue;
    if (!Array.isArray(node.widgets)) continue;
    if (node.inputs !== undefined && !Array.isArray(node.inputs)) continue;
    for (const input of Object.keys(definition.inputs)) {
      // An original API parameter remains semantic data even if an extension
      // subsequently presents it using a button or removes its schema entry.
      if (isRecord(expected?.[nodeId]?.inputs) && Object.hasOwn(expected[nodeId].inputs, input)) continue;
      const widgets = (node.widgets || []).filter(widget => widget.name === input);
      if (widgets.length !== 1) continue;
      const widget = widgets[0];
      const reason = uiWidgetReason(widget);
      if (!reason) continue;
      const serialized = definition.inputs[input];
      if (Array.isArray(serialized) && serialized.length === 2 &&
          ['string', 'number'].includes(typeof serialized[0]) && Number.isInteger(serialized[1]) && serialized[1] >= 0) continue;
      const target = findWidget(nodeId, input, lookup, true);
      if (target.reason || !target.mappingProof || !uiWidgetReason(target.widget)) continue;
      candidates.push({ nodeId, input, reason, target, widget, widgetValue: widget.value,
        ownerValue: target.widget.value, classType: definition.class_type });
    }
  }
  // Frontend extensions mutate constructor.nodeData (including required upload
  // buttons). Only the same-origin backend's original object_info can prove an
  // API input undeclared. Fetch failures retain data for normal API validation.
  if (!candidates.length || typeof window.fetch !== 'function' ||
      typeof window.AbortController !== 'function') return { output, ignored_ui_inputs };
  const schemas = new Map();
  for (const { classType } of candidates) {
    if (schemas.has(classType) || schemas.size >= 64) continue;
    schemas.set(classType, (async () => {
      const controller = new window.AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await window.fetch(`/object_info/${encodeURIComponent(classType)}`, {
              method: 'GET', mode: 'same-origin', credentials: 'same-origin',
              redirect: 'error', cache: 'no-store', signal: controller.signal,
            });
            if (!response.ok) return null;
            const schema = (await response.json())?.[classType]?.input;
            if (!isRecord(schema)) return null;
            const groups = ['required', 'optional', 'hidden'].map(name => schema[name]);
            return groups.some(group => group !== undefined && !isRecord(group)) ? null : groups;
          })(),
          new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 2000); }),
        ]);
      } catch { return null; }
      finally { clearTimeout(timer); }
    })());
  }
  await Promise.all(schemas.values()); // All class probes share a two-second bound.
  const currentLookup = widgetLookup();
  for (const candidate of candidates) {
    const groups = await schemas.get(candidate.classType);
    if (!groups || groups.some(group => group && Object.hasOwn(group, candidate.input))) continue;
    // Dynamic definitions need expanded live names; absence from their top
    // level is not proof that an input is UI-only. Leave those graphs intact.
    if (groups.some(group => group && Object.values(group).some(spec =>
      Array.isArray(spec) && ['COMFY_DYNAMICCOMBO_V3', 'COMFY_AUTOGROW_V3'].includes(spec[0])))) continue;
    const current = findWidget(candidate.nodeId, candidate.input, currentLookup, true);
    const leafWidgets = (current.node?.widgets || []).filter(widget => widget.name === candidate.input);
    if (current.reason || !sameMappingProof(candidate.target.mappingProof, current.mappingProof) ||
        leafWidgets.length !== 1 || leafWidgets[0] !== candidate.widget ||
        uiWidgetReason(leafWidgets[0]) !== candidate.reason ||
        !Object.is(leafWidgets[0].value, candidate.widgetValue) ||
        !Object.is(current.widget.value, candidate.ownerValue) || !uiWidgetReason(current.widget)) continue;
    delete output[candidate.nodeId].inputs[candidate.input];
    ignored_ui_inputs.push({ node_id: candidate.nodeId, input: candidate.input, reason: candidate.reason });
  }
  return { output, ignored_ui_inputs };
}

function describeControls(output) {
  const controls = [], unmapped = [], lookup = widgetLookup();
  for (const entry of mappingBindings.values()) {
    const current = currentMapping(entry, lookup), definition = output?.[entry.node_id];
    if (!current || definition?.class_type !== entry.class_type || !Object.hasOwn(definition.inputs || {}, entry.input) ||
        !Object.is(definition.inputs[entry.input], current.widget.value)) forgetMapping(entry);
  }
  for (const [nodeId, definition] of Object.entries(output)) {
    for (const [input, value] of Object.entries(definition.inputs || {})) {
      if (value !== null && typeof value === 'object') continue;
      const target = findWidget(nodeId, input, lookup);
      let reason = target.reason;
      if (!reason && (target.node.comfyClass || target.node.type) !== definition.class_type) reason = 'node_class_mismatch';
      if (!reason && !Object.is(target.widget.value, value)) reason = 'serialized_value_differs';
      if (reason) unmapped.push({ node_id: nodeId, input, reason });
      else {
        const entry = mappingBindings.get(mappingKey(nodeId, input));
        const mapped = entry && currentMapping(entry, lookup);
        controls.push({ node_id: nodeId, input, widget_node_id: String(nodeId), widget_name: input,
          ...(mapped ? { mapping_receipt: entry.receipt } : {}) });
      }
    }
  }
  media.observe(output, controls);
  return { controls, unmapped };
}

function validateValue(node, widget, value, inputName = widget.name, lookup = null) {
  if (typeof value !== typeof widget.value || !['string', 'number', 'boolean'].includes(typeof value)) return 'type_mismatch';
  const options = widget.options || {};
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'invalid_number';
    const slot = lookup ? lookup.inputs(node).get(inputName)?.[0] : (node.inputs || []).find(input => input.name === inputName || input.widget?.name === inputName);
    const specification = node.constructor?.nodeData?.input;
    const declaredType = specification?.required?.[inputName]?.[0] || specification?.optional?.[inputName]?.[0] || slot?.type;
    if (declaredType === 'INT' && !Number.isSafeInteger(value)) return 'integer_required';
    if (typeof options.min === 'number' && value < options.min || typeof options.max === 'number' && value > options.max) return 'out_of_range';
  }
  if (widget.type === 'combo' || options.values !== undefined) {
    let values;
    try { values = typeof options.values === 'function' ? options.values.call(widget) : options.values; } catch { return 'enum_unavailable'; }
    if (!Array.isArray(values)) return 'enum_unavailable';
    if (!values.some(item => Object.is(item, value))) return 'invalid_enum';
  }
  return null;
}

async function patchWidgets(patches, requestedMappings) {
  verifyRequestedMappings(requestedMappings);
  const unsupported = [], prepared = [], seen = new Set(), owners = new Set(), lookup = widgetLookup();
  if (!Array.isArray(patches) || patches.length > MAX_INTERFACE_FIELDS) return { error: '参数回写格式无效。', result: { applied: [], unsupported: [{ reason: 'invalid_patches' }] } };
  if (new TextEncoder().encode(JSON.stringify({ patches })).length > MAX_PATCH_BYTES) return { error: '参数回写超过 2 MiB，本次未应用任何修改。', result: { applied: [], unsupported: [{ reason: 'patch_byte_limit' }] } };
  for (const [index, patch] of patches.entries()) {
    const identity = { index, node_id: patch?.node_id, widget_name: patch?.widget_name };
    if (!patch || typeof patch.widget_name !== 'string' || !patch.widget_name) {
      unsupported.push({ ...identity, reason: 'invalid_patch' }); continue;
    }
    const key = JSON.stringify([String(patch.node_id), patch.widget_name]);
    const target = findWidget(patch.node_id, patch.widget_name, lookup);
    const mapping = patch.mapping_receipt !== undefined && mappingReceipts.get(patch.mapping_receipt);
    const mappingAuthorized = mapping && mapping.node_id === String(patch.node_id) && mapping.input === patch.widget_name && currentMapping(mapping, lookup);
    const mediaAuthorized = patch.media_receipt !== undefined && !target.reason && media.authorize(patch, target);
    let reason = seen.has(key) ? 'duplicate_patch' : target.reason ||
      (patch.class_type && (target.node.comfyClass || target.node.type) !== patch.class_type ? 'node_class_mismatch' : null) ||
      (patch.mapping_receipt !== undefined && !mappingAuthorized ? 'invalid_mapping_receipt' : null) ||
      (patch.media_receipt !== undefined && !mediaAuthorized ? 'invalid_media_receipt' :
        mediaAuthorized ? null : validateValue(target.node, target.widget, patch.value, patch.widget_name, lookup));
    if (!reason && owners.has(target.widget)) reason = 'ambiguous_widget_owner';
    if (!reason && Object.hasOwn(patch, 'expected_value') && !Object.is(target.widget.value, patch.expected_value) && !Object.is(target.widget.value, patch.value)) reason = 'conflict';
    seen.add(key);
    if (reason) unsupported.push({ ...identity, reason, ...(reason === 'conflict' ? { current_value: target.widget.value } : {}) });
    else { owners.add(target.widget); prepared.push({ ...target, value: patch.value, previousValue: target.widget.value, identity, patch }); }
  }
  if (unsupported.length) return { error: '部分参数无法安全回写，本次未应用任何修改。', result: { applied: [], unsupported } };
  if (!prepared.length) return { result: { applied: [], unsupported: [] } };
  let expectedOutput = null;
  const needsProof = item => String(item.identity.node_id).includes(':') || item.patch.media_receipt !== undefined || item.patch.mapping_receipt !== undefined;
  if (prepared.some(needsProof)) {
    try {
      const compiled = await app.graphToPrompt(graph());
      expectedOutput = (await stripUndeclaredUIInputs(validateApiPrompt(compiled.output))).output;
      verifyRequestedMappings(requestedMappings, expectedOutput);
      const compiledLookup = widgetLookup();
      for (const item of prepared) {
        const current = findWidget(item.identity.node_id, item.identity.widget_name, compiledLookup);
        if (current.reason || needsProof(item) && !sameMappingProof(item.mappingProof, current.mappingProof)) throw new Error('mapping_changed_before_patch');
        // Compilation and authoritative schema reads both yield. A widget
        // can retain its identity while the user changes its scalar value.
        if (!Object.is(current.widget.value, item.previousValue) && !Object.is(current.widget.value, item.value)) {
          return { error: '内部参数在核验期间发生变化，请确认冲突后重试；本次未应用任何修改。',
            result: { applied: [], unsupported: [{ ...item.identity, reason: 'conflict', current_value: current.widget.value }] } };
        }
        const definition = expectedOutput[String(item.identity.node_id)];
        if (!definition || definition.class_type !== (item.node.comfyClass || item.node.type) ||
            !Object.hasOwn(definition.inputs, item.identity.widget_name) ||
            !Object.is(definition.inputs[item.identity.widget_name], item.previousValue) &&
              !(Object.is(current.widget.value, item.value) && Object.is(definition.inputs[item.identity.widget_name], item.value))) throw new Error('unproven_target');
        definition.inputs[item.identity.widget_name] = item.value;
        // Preserve an independently completed, identical edit during rollback.
        item.previousValue = current.widget.value;
      }
    } catch {
      return { error: '无法证明子图参数与编译结果对应，本次未修改工作流。', result: { applied: [], unsupported: prepared.map(({ identity }) => ({ ...identity, reason: 'compiled_target_mismatch' })) } };
    }
  }
  const root = graph();
  let wrote = false, before = null;
  try {
    root.beforeChange?.();
    verifyRequestedMappings(requestedMappings);
    const beforeWriteLookup = widgetLookup();
    for (const item of prepared) {
      const current = findWidget(item.identity.node_id, item.identity.widget_name, beforeWriteLookup);
      if (current.reason || current.widget !== item.widget || needsProof(item) &&
          !sameMappingProof(item.mappingProof, current.mappingProof)) throw new Error('mapping_changed_before_write');
      if (!Object.is(current.widget.value, item.previousValue) && !Object.is(current.widget.value, item.value)) {
        const error = new Error('value_changed_before_write');
        error.conflict = { ...item.identity, reason: 'conflict', current_value: current.widget.value };
        throw error;
      }
      item.previousValue = current.widget.value;
    }
    // beforeChange may have completed an identical edit. Capture the
    // rollback document only after confirming that current transaction base.
    before = clone(root.serialize());
    // Serialization is an extension hook too. If it changed a target, the
    // saved document may predate that edit, even when it now equals the request.
    verifyRequestedMappings(requestedMappings);
    const snapshotLookup = widgetLookup();
    for (const item of prepared) {
      const current = findWidget(item.identity.node_id, item.identity.widget_name, snapshotLookup);
      if (graph() !== root || current.reason || current.widget !== item.widget || needsProof(item) &&
          !sameMappingProof(item.mappingProof, current.mappingProof)) throw new Error('mapping_changed_during_snapshot');
      if (!Object.is(current.widget.value, item.previousValue)) {
        const error = new Error('value_changed_during_snapshot');
        error.conflict = { ...item.identity, reason: 'conflict', current_value: current.widget.value };
        throw error;
      }
    }
    wrote = true;
    for (const item of prepared) item.widget.value = item.value;
    for (const item of prepared) {
      if (typeof item.widget.callback === 'function') {
        const beforeCallback = findWidget(item.identity.node_id, item.identity.widget_name);
        if (needsProof(item) && (beforeCallback.reason || !sameMappingProof(item.mappingProof, beforeCallback.mappingProof))) throw new Error('mapping_changed_before_callback');
        await item.widget.callback.call(item.widget, item.value, app.canvas, item.owner);
        const current = findWidget(item.identity.node_id, item.identity.widget_name);
        if (needsProof(item) && (current.reason || !sameMappingProof(item.mappingProof, current.mappingProof))) throw new Error('mapping_changed_during_callback');
      }
    }
    if (expectedOutput) {
      const compiled = await app.graphToPrompt(graph());
      const actual = (await stripUndeclaredUIInputs(validateApiPrompt(compiled.output), expectedOutput)).output;
      // Promoted inputs can fan out and callbacks can rebuild dynamic branches.
      // Do not silently change any unrequested API parameter or sibling instance.
      if (canonicalJSON(actual) !== canonicalJSON(expectedOutput)) throw new Error('unexpected_semantic_change');
    }
    // A callback may rebuild widgets or change another selected value. Refuse
    // to report success unless every requested value still exists as requested.
    const verifiedLookup = widgetLookup();
    for (const item of prepared) {
      const actual = findWidget(item.identity.node_id, item.identity.widget_name, verifiedLookup);
      const valid = !actual.reason && (item.patch.media_receipt !== undefined ? media.authorize(item.patch, actual) :
        !validateValue(actual.node, actual.widget, item.value, item.identity.widget_name, verifiedLookup));
      if (actual.reason || actual.node !== item.node || actual.owner !== item.owner || needsProof(item) && !sameMappingProof(item.mappingProof, actual.mappingProof) || !Object.is(actual.widget.value, item.value) || !valid) throw new Error('dependency_changed');
    }
    root.afterChange?.();
    root.change?.();
    app.canvas?.setDirty?.(true, true);
    media.refreshPreview();
    const completedLookup = widgetLookup();
    for (const item of prepared) if (needsProof(item)) {
      const current = findWidget(item.identity.node_id, item.identity.widget_name, completedLookup);
      if (current.reason || !sameMappingProof(item.mappingProof, current.mappingProof) || !Object.is(current.widget.value, item.value)) throw new Error('mapping_changed_during_finalization');
    }
    verifyRequestedMappings(requestedMappings);
    return { result: { applied: prepared.map(({ identity }) => ({ node_id: String(identity.node_id), widget_name: identity.widget_name })), unsupported: [] } };
  } catch (error) {
    if (!wrote) {
      // No assignment belongs to this request yet. Restoring the older
      // document here would overwrite the edit that caused the conflict.
      try { root.afterChange?.(); } catch { /* Leave the current document intact. */ }
      return { error: '参数在写入前已变化，本次未应用任何修改；请重新确认当前值。',
        result: { applied: [], unsupported: error.conflict ? [error.conflict] :
          prepared.map(({ identity }) => ({ ...identity, reason: 'compiled_target_mismatch' })) } };
    }
    let rolledBack = false;
    resetMappings();
    // A projected widget setter can have been rebound to another store slot.
    // Restore directly only while its original ownership is still provable;
    // otherwise let the authorized document reload restore the saved graph.
    for (const item of prepared) {
      try {
        const current = findWidget(item.identity.node_id, item.identity.widget_name);
        if (!needsProof(item) || !current.reason && sameMappingProof(item.mappingProof, current.mappingProof)) item.widget.value = item.previousValue;
      } catch { /* Continue to the document rollback; do not guess another owner. */ }
    }
    try {
      if (graph() !== root) throw new Error('root_changed');
      authorizedLoads.add(before);
      await app.loadGraphData(before, false, false);
      root.afterChange?.();
      rolledBack = true;
    } catch { state.loaded = false; }
    return { error: rolledBack ? '控件联动失败，已恢复修改前的工作流。' : '控件联动失败且恢复失败，请重新加载工作流。', result: { applied: [], unsupported: prepared.map(({ identity }) => ({ ...identity, reason: 'callback_failed' })), rolled_back: rolledBack } };
  }
}

async function importApiPrompt(value, acceptance = {}) {
  const previousReview = additionReview;
  additionReview = null; // Every attempt consumes the quote, including a failed retry.
  const prototypeImporter = Object.getPrototypeOf(app)?.loadApiJson;
  if (typeof prototypeImporter !== 'function') throw new Error('api-import-unavailable');
  const prompt = validateApiPrompt(value);
  await state.nativeTail;
  const before = clone(graph().serialize());
  resetMappings(); media.reset(); media.arm();
  try {
    // Invoke ComfyUI's awaited implementation directly. Some extension
    // instance wrappers call it without returning its Promise.
    // Extensions may mutate the argument during conversion. Keep the baseline
    // and any review quote bound to the validated original document.
    await prototypeImporter.call(app, clone(prompt), 'PrismCanvas preset', { deferWarnings: true });
    await state.nativeTail;
    const workflow = clone(graph().serialize());
    const summary = summarize(workflow);
    if (summary.missing.length) throw new Error('missing-node-types');
    // Pass the serialized root graph explicitly. Current ComfyUI frontends may
    // have another active canvas object while the native root graph is loaded.
    const compiled = await app.graphToPrompt(graph());
    if (!compiled?.workflow || !isRecord(compiled.output) || !Object.keys(compiled.output).length) {
      throw new Error('invalid-output');
    }
    const normalized = await stripUndeclaredUIInputs(compiled.output, prompt);
    // Preserve every original API field, including unknown extension data.
    // Only proven frontend-added buttons and titles are nonsemantic additions.
    const comparison = compareApiPrompts(prompt, normalized.output);
    let acceptedAdditions;
    if (!comparison.equivalent) {
      const candidates = reviewableApiAdditions(prompt, normalized.output, comparison);
      const accepted = candidates && previousReview && previousReview.expires > Date.now() &&
        acceptance.review_id === previousReview.review_id &&
        previousReview.prompt === canonicalJSON(prompt) && previousReview.before === canonicalJSON(before) &&
        previousReview.additions === canonicalJSON(acceptance.accepted_added_inputs) &&
        previousReview.additions === canonicalJSON(candidates.additions) && previousReview.proof === candidates.proof;
      if (!accepted) {
        const error = new Error('semantic-mismatch'); error.diagnostics = comparison;
        error.candidates = candidates; throw error;
      }
      // Keep the original comparison strict. Check the explicitly augmented
      // API independently so no existing field is authorized by the quote.
      const augmented = clone(prompt);
      for (const item of candidates.additions) Object.defineProperty(augmented[item.node_id].inputs, item.input,
        { value: item.value, enumerable: true, writable: true, configurable: true });
      if (!compareApiPrompts(augmented, normalized.output).equivalent) throw new Error('semantic-mismatch');
      acceptedAdditions = candidates.additions;
    } else if (acceptance.review_id !== undefined || acceptance.accepted_added_inputs !== undefined) {
      const error = new Error('semantic-mismatch'); error.diagnostics = comparison; throw error;
    }
    state.source = workflow;
    state.lostOnLoad = [];
    return { workflow, ...normalized, ...describeControls(normalized.output), ...summary,
      ...(acceptedAdditions ? { accepted_added_inputs: acceptedAdditions } : {}) };
  } catch (cause) {
    try {
      authorizedLoads.add(before);
      await app.loadGraphData(before, false, false);
      await state.nativeTail;
      state.source = before;
      state.lostOnLoad = [];
      state.loaded = true;
    } catch {
      state.loaded = false;
      throw new Error('api-import-rollback-failed');
    }
    const error = new Error('api-import-unverified');
    if (cause.diagnostics) {
      error.result = { semantic_mismatch: cause.diagnostics };
      if (cause.candidates) {
        const review = createAdditionReview(prompt, before, cause.candidates);
        if (review) error.result.review = review;
      }
    }
    throw error;
  }
}

async function handle(message) {
  const { action, requestId } = message;
  try {
    if (!state.ready) throw new Error('not-ready');
    let result;
    if (action === 'load') {
      state.loaded = false;
      state.lostOnLoad = [];
      const document = clone(message.document);
      if (!document || !Array.isArray(document.nodes)) throw new Error('invalid-document');
      state.claimed = true;
      state.source = clone(document);
      resetMappings(); media.reset(); media.arm();
      authorizedLoads.add(document);
      await app.loadGraphData(document);
      try { fitEditorView(true); } catch { /* View helpers must never prevent document loading. */ }
      const loaded = clone(graph().serialize());
      // Unexpected loss of any node during the initial native load is sticky.
      // Official subgraph ID normalization is checked separately. A
      // placeholder that survived loading can later be replaced or deleted by
      // the user, and must then stop appearing in the current missing list.
      state.lostOnLoad = lostDuringLoad(state.source, loaded);
      result = summarize(loaded);
      state.loaded = true;
    } else {
      if (!state.loaded) throw new Error('not-loaded');
      await state.nativeTail;
      if (action === 'fitView') {
        send({ requestId, action, result: fitEditorView() }); return;
      }
      if (action === 'importApi') {
        result = await importApiPrompt(message.prompt, message);
      } else if (action === 'patch') {
        send({ requestId, action, ...await patchWidgets(message.patches, message.mapping_receipts) });
        return;
      } else if (action === 'captureMedia') {
        const beforeLookup = widgetLookup();
        const before = new Map((Array.isArray(message.bindings) ? message.bindings : []).map(item =>
          [mappingKey(item?.node_id, item?.input), findWidget(item?.node_id, item?.input, beforeLookup)]));
        const compiled = await app.graphToPrompt(graph());
        if (!compiled?.output) throw new Error('invalid-output');
        const afterLookup = widgetLookup();
        for (const item of message.bindings || []) {
          const original = before.get(mappingKey(item.node_id, item.input)), current = findWidget(item.node_id, item.input, afterLookup);
          if (!original.reason && (current.reason || !sameMappingProof(original.mappingProof, current.mappingProof))) throw new Error('mapping-receipt-changed');
        }
        await media.prepareCapture?.(message.bindings, compiled.output);
        result = media.capture(message.bindings, compiled.output);
      } else if (action === 'captureMappings') {
        // Compilation may run async extensions. Bind only the owners that were
        // present when this explicit capability request began.
        if (!Array.isArray(message.bindings) || message.bindings.length > MAX_INTERFACE_FIELDS || new TextEncoder().encode(JSON.stringify(message.bindings)).length > MAX_PATCH_BYTES) throw new Error('invalid-mapping-bindings');
        const beforeLookup = widgetLookup();
        const before = message.bindings.map(item => findWidget(item?.node_id, item?.input, beforeLookup));
        const compiled = await app.graphToPrompt(graph());
        const output = validateApiPrompt(compiled?.output);
        const afterLookup = widgetLookup();
        for (const [index, item] of message.bindings.entries()) {
          const current = findWidget(item?.node_id, item?.input, afterLookup);
          if (!before[index].reason && (current.reason || !sameMappingProof(before[index].mappingProof, current.mappingProof))) throw new Error('mapping-receipt-changed');
        }
        result = captureMappings(message.bindings, output);
      }
      verifyRequestedMappings(message.mapping_receipts);
      const workflow = clone(graph().serialize());
      const summary = summarize(workflow);
      if (action === 'snapshot') result = { workflow, ...summary };
      else if (action === 'compile') {
        if (summary.missing.length) {
          send({ requestId, action, error: state.lostOnLoad.length ? '原生加载时丢失或替换了节点，请检查前端兼容性并重新加载原始工作流。' : '工作流仍有缺失节点，请补齐扩展或在内部修复后重新检查。', result: summary });
          return;
        }
        // Extensions wrap this method during setup; use the current method.
        const compiled = await app.graphToPrompt(graph());
        if (!compiled?.workflow || !isRecord(compiled.output) || !Object.keys(compiled.output).length) throw new Error('invalid-output');
        const normalized = await stripUndeclaredUIInputs(compiled.output);
        verifyRequestedMappings(message.mapping_receipts, normalized.output);
        result = { workflow: compiled.workflow, ...normalized, ...describeControls(normalized.output) };
      } else if (!['importApi', 'captureMedia', 'captureMappings'].includes(action)) throw new Error('invalid-action');
    }
    verifyRequestedMappings(message.mapping_receipts);
    send({ requestId, action, result });
  } catch (error) {
    // Native errors can include prompts, local paths, or entire node payloads.
    const errors = { captureMappings: '实例控件映射无法核验，未修改工作流；请重新读取当前输入。', captureMedia: '素材控件映射已变化或无法核验，未修改工作流。', load: '工作流加载失败，请检查文件格式与节点扩展。', snapshot: '无法保存编辑快照，请先成功加载工作流。', compile: '原生工作流编译失败，请检查节点与连线后重试。', patch: '参数回写失败，请先成功加载工作流并检查控件。', importApi: error.message === 'api-import-unavailable' ? '当前 ComfyUI 前端不支持 API 工作流导入，未修改原生工作流。' : error.message === 'api-import-rollback-failed' ? '预设转换失败且无法恢复临时图，请关闭此编辑器后重新打开原工作流。' : error.message === 'invalid-api-prompt' ? '预设 API 工作流格式无效，未修改原生工作流。' : 'ComfyUI 前端无法无损转换此预设，已恢复原工作流；预设内容仍保留。' };
    const message = error.message === 'mapping-receipt-changed' ?
      '子图实例或控件归属已变化，旧会话不能继续保存或回写；请重新进入工作流核对，原已保存内容仍保留。' :
      action === 'fitView' ? '当前工作流视图尚未就绪，请等待前端加载后重试。' : errors[action] || '不支持的编辑器请求。';
    send({ requestId, action, error: message, ...(action === 'importApi' && error.result ? { result: error.result } : {}) });
  }
}

function receive(event) {
  const message = event.data;
  if (event.source !== window.parent || event.origin !== config.parentOrigin || !message || message.source !== 'prism-parent' || message.nonce !== config.bridgeNonce) return;
  if (typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128 || !['load', 'snapshot', 'compile', 'patch', 'importApi', 'captureMedia', 'captureMappings', 'fitView'].includes(message.action)) return;
  if (state.seen.has(message.requestId)) {
    send({ requestId: message.requestId, action: message.action, error: '重复的编辑器请求已忽略。' });
    return;
  }
  if (state.seen.size >= 4096 || state.pending >= 32) {
    send({ requestId: message.requestId, action: message.action, error: '编辑器请求过多，请稍后重试或重新打开编辑器。' });
    return;
  }
  state.seen.add(message.requestId);
  let frozen;
  try { frozen = clone(message); } catch {
    send({ requestId: message.requestId, action: message.action, error: '编辑器请求格式无效。' });
    return;
  }
  state.pending += 1;
  state.tail = state.tail.then(() => handle(frozen)).catch(() => {}).finally(() => { state.pending -= 1; });
}

if (config && typeof config.parentOrigin === 'string' && typeof config.bridgeNonce === 'string' && config.bridgeNonce && window.parent !== window) {
  app.queuePrompt = blockedQueue;
  window.addEventListener('message', receive);
  app.registerExtension({
    name: 'PrismCanvas.NativeEditorBridge',
    nodeCreated(node) { media.isolateNode(node); },
    setup() {
      media.arm();
      installDocumentGate();
      // This task boundary only waits for the canvas/extension setup, NOT the
      // later startup restore. Document ownership above handles that lifecycle.
      let attempts = 0;
      const ready = () => {
        if (!mediaBootstrapped) { bootstrapMedia().then(ready); return; }
        if (!frontendReady()) {
          if (++attempts < 2000) window.setTimeout(ready, 25);
          return;
        }
        app.queuePrompt = blockedQueue;
        state.ready = true;
        send({ action: 'ready', capabilities: { media_capture: media === noMedia ? 0 : 1, mapping_capture: 1,
          media_nested_capture: media.supportsNestedCapture === true ? 1 : 0,
          fit_view: typeof (app.canvasOrUndefined || app.canvas)?.ds?.fitToBounds === 'function' ? 1 : 0 } });
      };
      window.setTimeout(ready, 0);
    },
  });
}
