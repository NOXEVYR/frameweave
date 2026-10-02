import { MAX_INTERFACE_FIELDS } from './interface-limits.mjs';
/** Pending scalar changes also survive when the user hides their controls. */
export function normalizeHiddenUpdates(updates = []) {
  if (!Array.isArray(updates) || updates.length > MAX_INTERFACE_FIELDS) throw new Error(`待同步的内部参数最多 ${MAX_INTERFACE_FIELDS} 项`);
  const ids = new Set(), bindings = new Set();
  return updates.map(item => {
    const source = item?.field;
    if (!source || typeof source !== 'object') throw new Error('内部参数同步记录无效');
    const field = {};
    for (const key of ['id', 'node_id', 'input', 'label', 'type']) {
      if (typeof source[key] !== 'string' || !source[key] || source[key].length > 160) throw new Error('内部参数绑定无效');
      field[key] = source[key];
    }
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(field.id) || ['__proto__','prototype','constructor'].includes(field.id)) throw new Error('内部参数 ID 无效');
    if (!['text','number','integer','select','boolean'].includes(field.type)) throw new Error('隐藏同步只支持普通参数，素材必须保留上传入口');
    const binding = JSON.stringify([field.node_id, field.input]);
    if (ids.has(field.id) || bindings.has(binding)) throw new Error('内部参数同步绑定重复');
    ids.add(field.id); bindings.add(binding);
    for (const value of [item.value, item.baseline]) {
      if (typeof value === 'string' && value.length <= 64000) continue;
      if (typeof value === 'boolean') continue;
      if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) continue;
      throw new Error('内部参数同步值必须为有限基础值');
    }
    return {field, value:item.value, baseline:item.baseline};
  });
}

export function mergeHiddenUpdates(previous, next, reset, visibleFields) {
  const existing = reset ? [] : normalizeHiddenUpdates(previous);
  const byBinding = new Map(existing.map(item => [JSON.stringify([item.field.node_id,item.field.input]),item]));
  for (const item of normalizeHiddenUpdates(next)) byBinding.set(JSON.stringify([item.field.node_id,item.field.input]),item);
  for (const field of visibleFields) byBinding.delete(JSON.stringify([field.node_id,field.input]));
  return normalizeHiddenUpdates([...byBinding.values()]);
}
