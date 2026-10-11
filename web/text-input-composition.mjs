import { MAX_INTERFACE_FIELDS } from './interface-limits.mjs';

const modes = new Map([['paragraphs', '\n\n'], ['comma', ', ']]);
const reserved = new Set(['__proto__', 'constructor', 'prototype']);

function edgeValue(edge, key, fallback) {
  const descriptor = Object.getOwnPropertyDescriptor(edge, key);
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('文本贡献身份必须为普通 JSON 字段');
  return descriptor.value;
}

/** Stable contribution identity; gaps/order changes never renumber stored edges. */
export function textSourceOccurrence(edge) {
  const occurrence = edgeValue(edge, 'sourceOccurrence', 0);
  if (!Number.isSafeInteger(occurrence) || occurrence < 0 || occurrence > 2000) throw new Error('文本贡献序号必须为 0 到 2000 的整数');
  return occurrence;
}

export function textContributionIdentity(edge, { sourceType, fieldType, composition } = {}) {
  const occurrence = textSourceOccurrence(edge);
  const composedText = sourceType === 'prompt' && fieldType === 'text' && modes.has(composition);
  if (Object.hasOwn(edge, 'sourceOccurrence') && !composedText) throw new Error('文本贡献序号只允许提示词连接已声明拼接规则的文本输入');
  if (!composedText) return null;
  const source = edgeValue(edge, 'source', ''), sourceField = edgeValue(edge, 'sourceField', 'text'), targetField = edgeValue(edge, 'targetField', '');
  if (typeof source !== 'string' || !source || typeof targetField !== 'string' || !targetField || !['text', 'negative'].includes(sourceField)) throw new Error('文本贡献绑定身份无效');
  return JSON.stringify([source, sourceField, targetField, occurrence]);
}

export function recordTextContribution(seen, edge, context) {
  const identity = textContributionIdentity(edge, context);
  if (identity !== null) {
    if (seen.has(identity)) throw new Error('相同文本贡献身份已连接，不能重复拼接');
    seen.add(identity);
  }
  return identity;
}

/** Canvas-only text composition. Package templates still receive plain values. */
export function normalizeTextCompositions(value, fields) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).length > MAX_INTERFACE_FIELDS) {
    throw new Error('文本输入拼接规则无效');
  }
  const byId = new Map();
  for (const field of fields || []) {
    if (byId.has(field.id)) throw new Error('文本输入拼接目标重复');
    byId.set(field.id, field);
  }
  const result = {};
  for (const [id, mode] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || reserved.has(id) || byId.get(id)?.type !== 'text' || !modes.has(mode)) {
      throw new Error('文本输入拼接规则必须绑定有效文本字段');
    }
    result[id] = mode;
  }
  return result;
}

export function composeTextInput(mode, incoming, own = '') {
  if (!Array.isArray(incoming) || incoming.length > 2000 || !modes.has(mode)) throw new Error('文本输入拼接模式无效');
  const values = [...incoming, own];
  if (values.some(value => typeof value !== 'string' || value.length > 100000)) throw new Error('文本输入必须是不超过 100000 字符的文本');
  const value = values.filter(Boolean).join(modes.get(mode));
  if (value.length > 64000) throw new Error('合并后的提示词超过工作流字段的 64000 字符上限');
  return value;
}

export function textCompositionOwn(values, id) {
  if (!values || !Object.hasOwn(values, id) || typeof values[id] !== 'string' || values[id].length > 64000) {
    throw new Error('文本拼接字段须保存自身文本（可以为空），不能猜测工作流默认值');
  }
  return values[id];
}

/** Explicitly removed modes may disappear; retained modes may not silently move. */
export function remapTextCompositions(value, previousFields, nextFields, rebindings = {}) {
  const previous = normalizeTextCompositions(value, previousFields), next = {};
  for (const [id, mode] of Object.entries(previous)) {
    const target = Object.hasOwn(rebindings, id) ? rebindings[id] : id;
    if (target === null) continue;
    if (Object.hasOwn(next, target)) throw new Error('多个文本拼接规则不能隐式合并到同一字段');
    next[target] = mode;
  }
  return normalizeTextCompositions(next, nextFields);
}
