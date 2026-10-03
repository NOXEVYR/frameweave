/** Package metadata and complete definitions have separate storage and budgets. */
export function createPackageCatalog({ api, maxEntries = 12, maxBytes = 16 * 1024 * 1024,
  concurrency = 4, maxPending = 200 } = {}) {
  if (typeof api !== 'function') throw new TypeError('工作流包目录需要 API');
  if (![maxEntries, maxBytes, concurrency, maxPending].every(value => Number.isInteger(value) && value > 0)) {
    throw new TypeError('工作流包缓存预算无效');
  }
  const definitions = new Map(), pending = new Map(), queue = [];
  const revisions = new Map(), rememberedVersions = new Map();
  let version = 0, detailEpoch = 0;
  let rows = [], bytes = 0, active = 0, refreshing = null;
  const encoder = new TextEncoder();
  const idOf = id => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('工作流包 ID 无效');
    return id;
  };
  const summaryOf = item => {
    const id = idOf(item?.id);
    return Object.freeze({ id, name: String(item.name ?? ''), description: String(item.description ?? ''),
      format: item.format, version: item.version, created_at: item.created_at, updated_at: item.updated_at,
      favorite: item.favorite === true, archived: item.archived === true, summary: true,
      field_count: Array.isArray(item.fields) ? item.fields.length :
        Number.isInteger(item.field_count) && item.field_count >= 0 ? item.field_count : null });
  };
  const validate = (full, id = null) => {
    if (!full || typeof full !== 'object' || Array.isArray(full) || full.summary === true ||
      !Array.isArray(full.fields) || !full.prompt || typeof full.prompt !== 'object' || Array.isArray(full.prompt) ||
      typeof full.name !== 'string' || id && full.id !== id) throw new Error('服务没有返回完整工作流包定义，请重试');
    idOf(full.id); return full;
  };
  const peek = id => {
    const record = definitions.get(id);
    if (!record) return null;
    definitions.delete(id); definitions.set(id, record);
    return record.full;
  };
  const upsertSummary = full => {
    const row = summaryOf(full), index = rows.findIndex(item => item.id === row.id);
    if (index < 0) rows = [...rows, row]; else rows = rows.map((item, at) => at === index ? row : item);
  };
  const freeze = value => {
    if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  };
  const cache = (owned, size) => {
    const old = definitions.get(owned.id);
    if (old) { bytes -= old.bytes; definitions.delete(owned.id); }
    if (size <= maxBytes) {
      while (definitions.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = definitions.keys().next().value, record = definitions.get(oldest);
        if (!record) break;
        bytes -= record.bytes; definitions.delete(oldest);
      }
      definitions.set(owned.id, { full: owned, bytes: size }); bytes += size;
    }
    return owned;
  };
  const remember = full => {
    validate(full);
    const json = JSON.stringify(full), size = encoder.encode(json).byteLength;
    const owned = freeze(JSON.parse(json)); // Callers cannot mutate a shared cached definition.
    revisions.set(owned.id, (revisions.get(owned.id) || 0) + 1);
    rememberedVersions.set(owned.id, ++version);
    upsertSummary(owned);
    return cache(owned, size);
  };
  const drain = () => {
    while (active < concurrency && queue.length) {
      const task = queue.shift(); active++;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true; active--; pending.delete(task.id); drain();
      };
      Promise.resolve().then(() => api(`/api/packages/${encodeURIComponent(task.id)}`))
        .then(result => {
          if (task.epoch !== detailEpoch) throw new Error('包库已刷新，请重新读取工作流定义');
          const full = validate(result?.package, task.id);
          let value;
          if ((revisions.get(task.id) || 0) === task.revision) value = remember(full);
          else { value = peek(task.id); if (!value) throw new Error('工作流定义已更新，请重新读取'); }
          finish(); task.resolve(value);
        }).catch(error => { finish(); task.reject(error); });
    }
  };
  const ensure = id => {
    try { idOf(id); } catch (error) { return Promise.reject(error); }
    const cached = peek(id); if (cached) return Promise.resolve(cached);
    if (pending.has(id)) return pending.get(id);
    if (pending.size >= maxPending) return Promise.reject(new Error('正在加载的工作流包过多，请稍后重试'));
    const revision = revisions.get(id) || 0;
    const promise = new Promise((resolve, reject) => queue.push({ id, revision, epoch: detailEpoch, resolve, reject }));
    pending.set(id, promise); drain(); return promise;
  };
  const refresh = ({ force = false } = {}) => {
    if (refreshing) {
      if (force && !refreshing.force) return refreshing.promise.then(() => refresh({ force: true }));
      return refreshing.promise;
    }
    const startedVersion = version;
    const promise = Promise.resolve().then(() => api(`/api/packages?summary=1${force ? '&refresh=1' : ''}`))
      .then(result => {
        if (!Array.isArray(result?.packages)) throw new Error('服务没有返回工作流包目录，请重试');
        const fresh = new Map(result.packages.map(item => { const row = summaryOf(item); return [row.id, row]; }));
        // An import/apply/detail finishing after this list began has newer local evidence.
        for (const row of rows) if ((rememberedVersions.get(row.id) || 0) > startedVersion) fresh.set(row.id, row);
        const previous = new Map(rows.map(row => [row.id, row]));
        for (const [id, old] of previous) if (!fresh.has(id) || JSON.stringify(old) !== JSON.stringify(fresh.get(id))) revisions.set(id, (revisions.get(id) || 0) + 1);
        rows = [...fresh.values()]; // Old servers may return fields; never hydrate from this list.
        if (force) { definitions.clear(); bytes = 0; detailEpoch++; }
        else for (const [id, record] of [...definitions]) {
          const row = fresh.get(id);
          if (!row) { bytes -= record.bytes; definitions.delete(id); continue; }
          const { summary, field_count, ...metadata } = row;
          const present = Object.fromEntries(Object.entries(metadata).filter(([_key, value]) => value !== undefined));
          const merged = freeze({ ...record.full, ...present });
          cache(merged, encoder.encode(JSON.stringify(merged)).byteLength);
        }
        for (const id of revisions.keys()) if (!fresh.has(id) && !definitions.has(id) && !pending.has(id)) {
          revisions.delete(id); rememberedVersions.delete(id);
        }
        return rows.slice();
      }).finally(() => { if (refreshing?.promise === promise) refreshing = null; });
    refreshing = { promise, force }; return promise;
  };
  return { refresh, summaries: () => rows.slice(), peek, ensure, remember };
}
