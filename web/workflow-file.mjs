import { extractPngWorkflows, PNG_MAX_FILE_BYTES } from './png-workflow.mjs';
import { EDITOR_LIMIT } from './native-workflow-editor.mjs';

/** Multiple PNG metadata records are alternatives, never an implicitly merged graph. */
export async function selectWorkflowCarrier(candidates, choose) {
  if (!candidates.length) throw new Error('这张 PNG 没有内嵌 ComfyUI 工作流。可以把它拖到画布作为参考素材，或从 ComfyUI 导出工作流 JSON。');
  const usable = candidates.filter(item => !item.error && ['native', 'api'].includes(item.kind));
  if (candidates.length === 1 && usable.length === 1 && !usable[0].duplicate) return usable[0];
  const selected = await choose(candidates);
  if (selected === null) return null;
  if (!usable.includes(selected)) throw new Error('没有选中有效的工作流内容，尚未导入。');
  return selected;
}

/** This is only the explicit workflow-import path; canvas image drops stay media. */
export async function readWorkflowFile(file, choose) {
  if (file.size > PNG_MAX_FILE_BYTES) throw new Error('工作流文件过大：PNG 最大为 32 MiB，JSON 最大为 16 MiB。');
  const prefix = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [137,80,78,71,13,10,26,10].every((byte, index) => prefix[index] === byte);
  const name = file.name.replace(/\.(json|png)$/i, '');
  if (png || /\.png$/i.test(file.name)) {
    const candidates = await extractPngWorkflows(new Uint8Array(await file.arrayBuffer()));
    const selected = await selectWorkflowCarrier(candidates, choose);
    return selected ? {...selected, name, container:'png'} : null;
  }
  if (file.size > EDITOR_LIMIT) throw new Error('工作流 JSON 最大为 16 MiB。');
  return {sourceJSON:await file.text(), name, container:'json'};
}
