/** API prompts are converted by the live ComfyUI frontend, then checked whole. */
export const PRESET_PROMPT_LIMIT = 16 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Clone and validate ComfyUI's API prompt shape without dropping extension fields. */
export function normalizePresetPrompt(value) {
  if (!isRecord(value) || !Object.keys(value).length) throw new Error('预设没有可转换的 ComfyUI API 工作流');
  let text, prompt;
  try {
    text = JSON.stringify(value);
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > PRESET_PROMPT_LIMIT) {
      throw new Error('limit');
    }
    prompt = JSON.parse(text);
  } catch {
    throw new Error('预设 API 工作流不是有效或可安全传输的 JSON');
  }
  if (!isRecord(prompt) || !Object.keys(prompt).length
      || Object.values(prompt).some(node => !isRecord(node)
        || typeof node.class_type !== 'string' || !node.class_type
        || !isRecord(node.inputs))) {
    throw new Error('预设不符合 ComfyUI API 工作流格式');
  }
  return prompt;
}

/** Compare all node IDs, node classes, input values, links, and unknown fields. */
export function presetPromptsEquivalent(expected, actual) {
  try {
    const expectedPrompt = normalizePresetPrompt(expected);
    const actualPrompt = normalizePresetPrompt(actual);
    for (const [nodeId, expectedNode] of Object.entries(expectedPrompt)) {
      const actualNode = actualPrompt[nodeId];
      if (!actualNode) continue;
      const expectedMeta = expectedNode._meta;
      const actualMeta = actualNode._meta;
      if (isRecord(actualMeta) &&
          !(isRecord(expectedMeta) && Object.hasOwn(expectedMeta, 'title')) &&
          typeof actualMeta.title === 'string' && actualMeta.title.length > 0) {
        delete actualMeta.title;
        if (!isRecord(expectedMeta) && Object.keys(actualMeta).length === 0) {
          delete actualNode._meta;
        }
      }
    }
    return canonicalJSON(expectedPrompt) === canonicalJSON(actualPrompt);
  } catch {
    return false;
  }
}
