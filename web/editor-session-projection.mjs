import { MAX_INTERFACE_FIELDS } from './interface-limits.mjs';
/** Session-only proven input overlays. All editor operations are injected; no canvas writes. */
const MEDIA = new Set(['image', 'video', 'audio']);
const PREVIEW_STATES = new Set(['pending', 'ready', 'failed', 'unsupported']);
const SCALAR = new Set(['text', 'integer', 'number', 'boolean', 'select']);
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const scalar = value => ['string', 'number', 'boolean'].includes(typeof value) &&
  (typeof value !== 'number' || Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)));

function copy(value) {
  let count = 0;
  const visit = (item, depth = 0) => {
    if (++count > 500000 || depth > 80) throw new Error('编辑会话数据超过安全预算');
    if (item === null || ['string', 'boolean'].includes(typeof item) || scalar(item)) return;
    if (!item || typeof item !== 'object' || !Array.isArray(item) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('编辑会话只接受安全 JSON 数据');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('编辑会话数组不能包含空槽位');
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 32 * 1024 * 1024) throw new Error('编辑会话数据超过 32 MiB');
  return JSON.parse(text);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const equal = (left, right) => canonical(left) === canonical(right);
function equalDocument(left, right) {
  // ComfyUI's animated fit/pan updates the root viewport between requests.
  // This is not an edit. Exempt only its known finite transform on BOTH sides;
  // retain every node, position, unknown metadata field and saved viewport.
  const viewport = value => record(value) && Object.keys(value).length === 2 &&
    own(value, 'scale') && typeof value.scale === 'number' && Number.isFinite(value.scale) && value.scale > 0 &&
    own(value, 'offset') && Array.isArray(value.offset) && value.offset.length === 2 &&
    value.offset.every(item => typeof item === 'number' && Number.isFinite(item));
  if (!record(left) || !record(right) || !record(left.extra) || !record(right.extra) ||
      !viewport(left.extra.ds) || !viewport(right.extra.ds)) return equal(left, right);
  return equal({ ...left, extra: { ...left.extra, ds: null } }, { ...right, extra: { ...right.extra, ds: null } });
}
const bindingKey = item => JSON.stringify([item.node_id, item.input]);
function validScalar(type, value) {
  return scalar(value) && (type === 'text' ? typeof value === 'string' && value.length <= 64000 :
    type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' :
      type === 'boolean' ? typeof value === 'boolean' : type === 'select');
}
const mediaLiteral = value => typeof value === 'string' && value.length <= 64000;
const mediaFilename = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
  !value.replaceAll('\\', '/').startsWith('/') && !/[:\u0000]/.test(value) &&
  !value.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..');
const validInput = (type, value) => MEDIA.has(type) ? mediaLiteral(value) : validScalar(type, value);
function mediaOwnerValid(item) {
  const owner = item.media_owner;
  return mediaFilename(item.value) && record(owner) && owner.name === item.value && owner.media_type === item.type &&
    typeof owner.backend === 'string' && owner.backend.length > 0 && owner.backend.length <= 512;
}

export class EditorSessionProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message); this.name = 'EditorSessionProjectionError'; this.code = code;
    Object.assign(this, details);
  }
}

/** Convert the full non-connected API template before starting any display overlay. */
export async function importEditorBaseline(request, baselinePrompt, args = {}) {
  if (typeof request !== 'function' || !record(baselinePrompt) || !record(args) || own(args, 'prompt')) {
    throw new Error('原生转换需要完整基准 API 与独立复核参数');
  }
  return request('importApi', { ...copy(args), prompt: copy(baselinePrompt) });
}

/**
 * Call initialize AFTER native own-value synchronization and baseline conversion.
 * provenance uses the preparation DTO's `value`; fallback/baseline stay inert.
 * assertCurrent must validate the frozen canvas/backend/direct-source identities.
 * prepare/persist serialize the complete cleanup/store/display-restore transaction.
 * callback receives matching workflow/output, plus explicit connected resolutions.
 * callback may return null/false/{persisted:false} when the user cancels.
 */
export function createEditorSessionProjection({ request, provenance = [], assertCurrent, mappingCapture = false, mediaNestedCapture = false }) {
  if (typeof request !== 'function' || typeof assertCurrent !== 'function' || !Array.isArray(provenance) || provenance.length > MAX_INTERFACE_FIELDS) {
    throw new Error('编辑会话需要请求函数、来源保护与有效输入映射');
  }
  const frozen = copy(provenance);
  // Only immutable, copied compile responses are indexed; each compile gets a new index.
  const controlIndexes = new WeakMap();
  function controlsAt(result, entry) {
    let index = controlIndexes.get(result);
    if (!index) {
      index = new Map();
      for (const control of result.controls) {
        const key = bindingKey(control), matches = index.get(key) || [];
        matches.push(control); index.set(key, matches);
      }
      controlIndexes.set(result, index);
    }
    return index.get(bindingKey(entry)) || [];
  }
  let busy = false, initialized = false, locked = false, lockReason = '', entries = [], unmapped = [];
  // Ephemeral guards bind an instance's actual controls, including no-op saves.
  // Never infer media support from this independent scalar mapping capability.
  let mappingGuards = [];

  const fail = (code, message, details = {}) => new EditorSessionProjectionError(code, message, details);
  function lock(error) { locked = true; lockReason = error.message; }
  async function guarded(action, args = {}, checkGuard = true) {
    if (checkGuard) await assertCurrent();
    const guardedArgs = mappingGuards.length && ['compile', 'snapshot', 'patch'].includes(action) ?
      { ...args, mapping_receipts: mappingGuards } : args;
    const result = copy(await request(action, copy(guardedArgs)));
    if (checkGuard) await assertCurrent();
    return result;
  }
  function validCompile(result) {
    if (!record(result) || !record(result.workflow) || !record(result.output) || !Array.isArray(result.controls)) {
      throw fail('invalid_compile', '原生编译结果不完整，无法核实会话覆盖');
    }
    return result;
  }
  async function compile(checkGuard = true) { return validCompile(await guarded('compile', {}, checkGuard)); }
  function target(result, entry) {
    const definition = result.output[entry.node_id];
    if (!record(definition) || definition.class_type !== entry.class_type || !record(definition.inputs) || !own(definition.inputs, entry.input)) {
      throw fail('binding_changed', `输入 ${entry.field_id} 的节点、类型或字段已变化`);
    }
    const value = definition.inputs[entry.input];
    if (!validInput(entry.type, value)) throw fail('value_unproven', `输入 ${entry.field_id} 的当前值无法安全恢复`);
    const controls = controlsAt(result, entry);
    if (!controls.length && result.unmapped?.some(item => item.node_id === entry.node_id && item.input === entry.input && item.reason === 'shared_definition_widget')) {
      throw fail('shared_definition_widget', `输入 ${entry.field_id} 使用共享子图定义，请先提升为实例参数`);
    }
    if (controls.length !== 1 || controls[0].widget_node_id !== entry.node_id || controls[0].widget_name !== entry.input) {
      throw fail('mapping_changed', `输入 ${entry.field_id} 的当前控件映射无法证明`);
    }
    if (MEDIA.has(entry.type) && entry.media_receipt && controls[0].media_receipt !== entry.media_receipt) {
      throw fail('media_receipt_changed', `输入 ${entry.field_id} 的媒体控件身份已变化`);
    }
    if (entry.mapping_receipt && controls[0].mapping_receipt !== entry.mapping_receipt) {
      throw fail('mapping_receipt_changed', `输入 ${entry.field_id} 的实例控件身份已变化`);
    }
    return { value, control: controls[0] };
  }
  async function patch(result, changes, checkGuard = true) {
    if (!changes.length) return result;
    const expected = copy(result.output), patches = changes.map(({ entry, value }) => {
      const current = target(result, entry);
      if (!validInput(entry.type, value)) throw fail('invalid_restore', `输入 ${entry.field_id} 的恢复值无效`);
      if (MEDIA.has(entry.type) && !entry.media_receipt) throw fail('media_capture_unverified', `输入 ${entry.field_id} 尚未取得媒体恢复授权`);
      expected[entry.node_id].inputs[entry.input] = value;
      return { node_id: current.control.widget_node_id, widget_name: current.control.widget_name,
        class_type: entry.class_type, expected_value: current.value, value,
        ...(entry.mapping_receipt ? { mapping_receipt: entry.mapping_receipt } : {}),
        ...(MEDIA.has(entry.type) ? { media_receipt: entry.media_receipt } : {}) };
    });
    if (new TextEncoder().encode(JSON.stringify({ patches })).length > 2 * 1024 * 1024) {
      throw fail('patch_byte_limit', '本次控件回写超过 2 MiB，未应用任何修改');
    }
    const response = await guarded('patch', { patches }, checkGuard);
    const applied = new Map();
    if (Array.isArray(response.applied)) for (const item of response.applied) {
      const key = JSON.stringify([item.node_id, item.widget_name]);
      applied.set(key, (applied.get(key) || 0) + 1);
    }
    if (!Array.isArray(response.applied) || response.applied.length !== patches.length ||
        !Array.isArray(response.unsupported) || response.unsupported.length ||
        patches.some(item => applied.get(JSON.stringify([item.node_id, item.widget_name])) !== 1)) {
      throw fail('patch_unverified', '控件恢复未完整确认，已停止保存');
    }
    const after = await compile(checkGuard);
    if (!equal(after.output, expected)) throw fail('unexpected_change', '控件恢复改变了未授权的输入或工作流结构，已停止保存');
    for (const { entry, value } of changes) if (!Object.is(target(after, entry).value, value)) {
      throw fail('restore_unverified', `输入 ${entry.field_id} 的恢复值未通过核实`);
    }
    return after;
  }
  async function matchedSnapshot(current) {
    const snapshot = await guarded('snapshot');
    const after = await compile();
    const lastSnapshot = await guarded('snapshot');
    // Official graphToPrompt removes localized slot labels, compresses widget
    // input slots and adds frontendVersion to its workflow. Compare each
    // serialization to its own fresh counterpart, never drop arbitrary fields.
    if (!record(snapshot.workflow) || !record(lastSnapshot.workflow) || !equalDocument(snapshot.workflow, lastSnapshot.workflow) ||
        !equalDocument(after.workflow, current.workflow) || !equal(after.output, current.output)) {
      throw fail('snapshot_changed', '快照与编译图不一致，未保存临时连线覆盖');
    }
    return after;
  }
  function withLockCheck() {
    if (locked) throw fail('session_locked', `编辑会话恢复失败，须重新进入：${lockReason}`, { locked: true, persisted: false });
    if (busy) throw fail('session_busy', '编辑会话正在处理另一项操作', { persisted: false });
  }
  async function captureNestedMappings(initial, candidates) {
    if (!candidates.length) return { current: initial, mapped: [], deferred: [] };
    const bindings = candidates.map(({ node_id, input, class_type }) => ({ node_id, input, class_type }));
    const deferred = reason => candidates.map(item => ({ ...item, reason, applied: false }));
    if (new TextEncoder().encode(JSON.stringify({ bindings })).length > 2 * 1024 * 1024) {
      return { current: initial, mapped: [], deferred: deferred('mapping_capture_byte_limit') };
    }
    await assertCurrent();
    let response;
    try { response = copy(await request('captureMappings', copy({ bindings }))); }
    catch { await assertCurrent(); return { current: await compile(), mapped: [], deferred: deferred('mapping_capture_unavailable') }; }
    await assertCurrent();
    const requested = new Map(candidates.map(item => [bindingKey(item), item]));
    const accepted = new Map(), rejected = new Map(), receipts = new Set();
    let invalid = !record(response) || !Array.isArray(response.captured) || !Array.isArray(response.unsupported);
    if (!invalid) {
      for (const item of response.captured) {
        const key = record(item) ? bindingKey(item) : '', entry = requested.get(key);
        if (!entry || accepted.has(key) || rejected.has(key) ||
            typeof item.receipt !== 'string' || !item.receipt || item.receipt.length > 512 || receipts.has(item.receipt) ||
            !validInput(entry.type, item.native_value)) { invalid = true; break; }
        receipts.add(item.receipt); accepted.set(key, item);
      }
      for (const item of response.unsupported) {
        const key = record(item) ? bindingKey(item) : '';
        if (!requested.has(key) || accepted.has(key) || rejected.has(key) ||
            typeof item.reason !== 'string' || !item.reason || item.reason.length > 200) { invalid = true; break; }
        rejected.set(key, item.reason);
      }
    }
    if (invalid) return { current: await compile(), mapped: [], deferred: deferred('mapping_capture_unverified') };
    mappingGuards = [...accepted.values()].map(({ node_id, input, receipt }) => ({ node_id, input, receipt }));
    let current;
    try { current = await compile(); }
    catch {
      mappingGuards = [];
      await assertCurrent();
      return { current: await compile(), mapped: [], deferred: deferred('mapping_capture_unverified') };
    }
    const mapped = [], pending = [];
    for (const entry of candidates) {
      const key = bindingKey(entry), captured = accepted.get(key);
      let reason = rejected.get(key) || (!captured ? 'mapping_capture_unverified' : null);
      const candidate = captured ? { ...entry, mapping_receipt: captured.receipt, native_pre_overlay: captured.native_value } : null;
      if (!reason) {
        try {
          if (!Object.is(target(initial, entry).value, captured.native_value) ||
              !Object.is(target(current, candidate).value, captured.native_value)) reason = 'mapping_native_value_changed';
        } catch (error) { reason = error.code; }
      }
      if (reason) pending.push({ ...entry, reason, applied: false }); else mapped.push(candidate);
    }
    mappingGuards = mapped.map(({ node_id, input, mapping_receipt }) => ({ node_id, input, receipt: mapping_receipt }));
    return { current, mapped, deferred: pending };
  }
  async function captureMedia(initial, candidates) {
    if (!candidates.length) return { current: initial, mapped: [], deferred: [] };
    const bindings = candidates.map(item => ({ field_id: item.field_id, node_id: item.node_id, input: item.input,
      class_type: item.class_type, type: item.type, value: item.value, media_owner: item.media_owner,
      ...(typeof item.label === 'string' ? { label: item.label } : {}) }));
    const deferred = reason => candidates.map(item => ({ ...item, reason, applied: false }));
    if (new TextEncoder().encode(JSON.stringify({ bindings })).length > 2 * 1024 * 1024) {
      return { current: initial, mapped: [], deferred: deferred('media_capture_byte_limit') };
    }
    // A previous bridge may not implement captureMedia. Keep scalar controls
    // usable, but never downgrade a failed source/context guard to deferred.
    await assertCurrent();
    let response;
    try { response = copy(await request('captureMedia', copy({ bindings }))); }
    catch { await assertCurrent(); return { current: await compile(), mapped: [], deferred: deferred('media_capture_unavailable') }; }
    await assertCurrent();
    const requested = new Map(candidates.map(item => [item.field_id, item]));
    const accepted = new Map(), rejected = new Map(), receipts = new Set();
    let invalid = !record(response) || !Array.isArray(response.captured) || !Array.isArray(response.unsupported);
    if (!invalid) {
      for (const item of response.captured) {
        const entry = requested.get(item?.field_id);
        if (!record(item) || !entry || accepted.has(item.field_id) || rejected.has(item.field_id) ||
            item.node_id !== entry.node_id || item.input !== entry.input || item.type !== entry.type ||
            typeof item.receipt !== 'string' || !item.receipt || item.receipt.length > 512 || receipts.has(item.receipt) ||
            !mediaLiteral(item.native_value) || !PREVIEW_STATES.has(item.preview_state)) { invalid = true; break; }
        receipts.add(item.receipt); accepted.set(item.field_id, item);
      }
      for (const item of response.unsupported) {
        if (!record(item) || !requested.has(item.field_id) || accepted.has(item.field_id) || rejected.has(item.field_id) ||
            typeof item.reason !== 'string' || !item.reason || item.reason.length > 200) { invalid = true; break; }
        rejected.set(item.field_id, item.reason);
      }
    }
    if (invalid) return { current: await compile(), mapped: [], deferred: deferred('media_capture_unverified') };
    const current = await compile(), mapped = [], pending = [];
    for (const entry of candidates) {
      const captured = accepted.get(entry.field_id);
      let reason = rejected.get(entry.field_id) || (!captured ? 'media_capture_unverified' : null);
      const candidate = captured ? { ...entry, media_receipt: captured.receipt,
        native_pre_overlay: captured.native_value, preview_state: captured.preview_state } : null;
      if (!reason) {
        try {
          if (!Object.is(target(initial, entry).value, captured.native_value) ||
              !Object.is(target(current, candidate).value, captured.native_value)) reason = 'media_native_value_changed';
        } catch (error) { reason = error.code; }
      }
      if (reason) pending.push({ ...entry, reason, applied: false });
      else mapped.push(candidate);
    }
    return { current, mapped, deferred: pending };
  }
  async function initialize() {
    withLockCheck();
    if (initialized) throw fail('already_initialized', '会话连线覆盖已初始化');
    busy = true;
    let mutating = false;
    try {
      const initial = await compile(), seenFields = new Set(), seenBindings = new Set();
      let mapped = [], deferred = [];
      const media = [], nested = [];
      for (const item of frozen) {
        if (item.origin !== 'connected') continue;
        const identifiers = ['field_id', 'node_id', 'input', 'class_type'];
        if (identifiers.some(key => typeof item[key] !== 'string' || !item[key] || item[key].length > 200)) {
          throw fail('invalid_provenance', '连线覆盖缺少有效字段或节点身份');
        }
        const key = bindingKey(item);
        if (seenFields.has(item.field_id) || seenBindings.has(key)) throw fail('ambiguous_provenance', '连线覆盖字段或控件重复');
        seenFields.add(item.field_id); seenBindings.add(key);
        let reason = item.node_id.includes(':') && (mappingCapture !== true || MEDIA.has(item.type) && mediaNestedCapture !== true) ? 'nested_display_not_supported' :
          MEDIA.has(item.type) ? !mediaOwnerValid(item) ? 'media_owner_unverified' : null :
            !SCALAR.has(item.type) || !validScalar(item.type, item.value) ? 'scalar_value_unproven' : null;
        let native;
        if (!reason) {
          try { native = target(initial, item).value; } catch (error) { reason = error.code; }
        }
        if (reason) deferred.push({ ...item, reason, applied: false });
        else if (MEDIA.has(item.type)) media.push(item);
        else if (item.node_id.includes(':')) nested.push(item);
        else mapped.push({ ...item, native_pre_overlay: native });
      }
      // Media isolation may wrap the leaf lifecycle. Establish it before taking
      // the final instance proof, including scalar fields on that same node.
      const captured = await captureMedia(initial, media);
      const nestedCapture = await captureNestedMappings(captured.current,
        nested.concat(captured.mapped.filter(item => item.node_id.includes(':'))));
      mapped = mapped.concat(captured.mapped.filter(item => !item.node_id.includes(':')));
      // Capture never changes filenames. Use the fresh pre-overlay scalar N if
      // the user edited a scalar while the media capability check was pending.
      mapped = mapped.map(item => ({ ...item, native_pre_overlay: target(nestedCapture.current, item).value })).concat(nestedCapture.mapped);
      deferred = deferred.concat(captured.deferred, nestedCapture.deferred);
      if (mapped.length > MAX_INTERFACE_FIELDS) throw fail('overlay_limit', `本次可证明连线覆盖超过 ${MAX_INTERFACE_FIELDS} 项，请缩小展示范围`);
      const changes = mapped.filter(item => !Object.is(item.native_pre_overlay, item.value)).map(entry => ({ entry, value: entry.value }));
      mutating = changes.length > 0;
      await patch(nestedCapture.current, changes);
      entries = mapped; unmapped = deferred; initialized = true;
      return { status: 'initialized', applied: copy(entries), unmapped: copy(unmapped), locked: false };
    } catch (error) { if (mutating) lock(error); throw error; }
    finally { busy = false; }
  }
  async function prepare(store, { resolutions = {}, expectedConflicts } = {}) {
    withLockCheck();
    if (!initialized) throw fail('not_initialized', '请先初始化编辑会话');
    if (typeof store !== 'function' || !record(resolutions)) throw new Error('持久化准备需要回调与明确冲突选择');
    const choices = copy(resolutions);
    if (expectedConflicts !== undefined && !Array.isArray(expectedConflicts)) throw new Error('冲突复核快照必须是数组');
    const reviewed = expectedConflicts === undefined ? undefined : copy(expectedConflicts);
    busy = true;
    let changed = false, persisted = false, callbackStarted = false, primaryError = null, display = [], result, cleanOutput = null;
    try {
      const current = await compile();
      const conflicts = [];
      for (const entry of entries) {
        const value = target(current, entry).value;
        display.push({ entry, value });
        if (!Object.is(value, entry.value)) conflicts.push({ ...entry, inner_value: value,
          message: '连线仍连接，生成继续使用源输入；请选择保存内部值或保留原内部备用值。' });
      }
      if (reviewed !== undefined && !equal(reviewed, conflicts)) {
        return { status: 'resolution_required', persisted: false, store_attempted: false,
          stale_resolution: true, conflicts: copy(conflicts), locked: false };
      }
      const conflictIDs = new Set(conflicts.map(item => item.field_id));
      if (Object.keys(choices).some(id => !conflictIDs.has(id) || !['inner', 'native'].includes(choices[id]))) {
        throw fail('invalid_resolution', '冲突选择与当前内部输入不一致');
      }
      if (conflicts.some(item => !own(choices, item.field_id))) {
        return { status: 'resolution_required', persisted: false, store_attempted: false, conflicts: copy(conflicts), locked: false };
      }
      const persistentChanges = display.map(({ entry, value }) => ({ entry,
        value: Object.is(value, entry.value) || choices[entry.field_id] === 'native' ? entry.native_pre_overlay : value }));
      const cleanup = persistentChanges.filter(item => !Object.is(target(current, item.entry).value, item.value));
      changed = cleanup.length > 0;
      let clean = await patch(current, cleanup);
      clean = await matchedSnapshot(clean);
      cleanOutput = copy(clean.output);
      await assertCurrent();
      callbackStarted = true;
      const controls = clean.controls.map(({ mapping_receipt, media_receipt, ...control }) => control);
      const storedUnmapped = unmapped.map(({ mapping_receipt, media_receipt, ...entry }) => entry);
      const returned = await store(copy({ ...clean, controls, connected_resolutions: conflicts.map(item => ({ field_id: item.field_id,
        choice: choices[item.field_id], native_pre_overlay: item.native_pre_overlay, inner_value: item.inner_value,
        connected_value: item.value,
        ...(MEDIA.has(item.type) && choices[item.field_id] === 'inner' ? { media_owner_invalidated: true } : {}) })), provenance: frozen, unmapped: storedUnmapped }));
      persisted = returned !== null && returned !== false && !(record(returned) && returned.persisted === false);
      result = { status: persisted ? 'persisted' : 'cancelled', persisted, store_attempted: true, value: returned, locked: false };
    } catch (error) {
      primaryError = error;
      // Once a store callback throws, its durable outcome is not known here.
      if (callbackStarted) persisted = [true, false, 'unknown'].includes(error.persisted) ? error.persisted : 'unknown';
    }
    finally {
      if (changed) {
        try {
          // Storage may intentionally update the host's target/revision. Do not
          // reinterpret that authorized change as a failed durable save.
          const current = await compile(false);
          if (cleanOutput && !equal(current.output, cleanOutput)) throw fail('restore_source_changed', '持久化期间内部工作流发生变化，未覆盖新的编辑值');
          const changes = display.filter(item => !Object.is(target(current, item.entry).value, item.value));
          await patch(current, changes, false);
        } catch (error) {
          lock(error);
          primaryError = fail('display_restore_failed', persisted === true ?
            '内容已持久化，但编辑器显示恢复失败；须重新进入。' : '编辑器显示恢复失败，须重新进入；请核对保存状态。',
          { persisted, store_attempted: callbackStarted, locked: true, cause: error, ...(primaryError ? { preparation_error: primaryError } : {}) });
        }
      }
      busy = false;
    }
    if (primaryError) {
      // Failed cleanup/verification may leave a graph whose overlay status is
      // uncertain even if the best-effort display restore succeeded.
      if (changed && !callbackStarted) lock(primaryError);
      throw fail(primaryError.code || 'prepare_failed', primaryError.message,
        { cause: primaryError, persisted, store_attempted: callbackStarted, locked, ...(primaryError.preparation_error ? { preparation_error: primaryError.preparation_error } : {}) });
    }
    return result;
  }
  return { initialize, prepare, persist: prepare,
    getState: () => ({ initialized, busy, locked, lock_reason: lockReason, applied: copy(entries), unmapped: copy(unmapped) }) };
}
