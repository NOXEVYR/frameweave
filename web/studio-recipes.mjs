import { STUDIO_MODES, restoreDraft } from './studio-state.mjs';
import { createNode, parseGraph, serializeGraph } from './graph.mjs';

export const studioModeForKind = kind => Object.keys(STUDIO_MODES).find(mode => STUDIO_MODES[mode].kinds.some(([value]) => value === kind));

/** Restore recorded request values, never dimensions/approximations from a summary. */
export function draftFromStudioRecipe(recipe, job, knownReferences = []) {
  const request = recipe?.request, mode = studioModeForKind(request?.kind);
  if (!mode || request.kind !== job?.kind || !job.backend) throw new Error('此任务需要在画布工作流中编辑，无法还原为预设工作台');
  if (recipe.job_id && recipe.job_id !== job.id || recipe.backend && recipe.backend !== job.backend) throw new Error('参数记录与原任务身份不一致，请刷新后重试');
  const references = request.references ?? [], limit = request.kind === 'qwen21_edit' ? 10 : request.kind === 'h3_ref' ? 9 : request.kind === 'h3_i2v' ? 2 : request.kind === 'sdxl_i2i' ? 1 : 0;
  if (!Array.isArray(references) || references.length > limit || references.some(value => typeof value !== 'string' || !value)) throw new Error('历史参考图格式或数量无效，请在画布中检查完整参数');
  if (request.kind === 'h3_i2v' && request.reference_roles && JSON.stringify(request.reference_roles) !== JSON.stringify(references.map((_, index) => index ? 'end' : 'start'))) throw new Error('历史首尾帧角色无法安全映射，请复制到画布检查');
  const pool = [...(Array.isArray(recipe.references) ? recipe.references : []), ...knownReferences];
  const refs = references.map(name => {
    // Share the persisted canvas media path/backend validation boundary.
    const ref = createNode('generation', 0, 0, { packageMediaBackends: { reference: { name, backend: job.backend } } });
    parseGraph(serializeGraph({ nodes: [ref], edges: [] }));
    const metadata = pool.find(item => item?.name === name && item.backend === job.backend && /^\/api\/media\/[a-f0-9]{32}$/.test(item.url || ''));
    return { name, backend: job.backend, url: metadata?.url || '', label: name };
  });
  const restored = { ...request, references: refs };
  if (request.refine?.enabled === true) {
    restored.refine = { ...request.refine };
    for (const key of ['width', 'height', 'steps', 'denoise', 'upscale_method']) {
      if (Object.hasOwn(restored.refine, key)) continue;
      const value = recipe.summary?.refine?.enabled === true ? recipe.summary.refine[key] : undefined;
      if (key === 'upscale_method' ? typeof value !== 'string' || !value : typeof value !== 'number' || !Number.isFinite(value)) throw new Error('历史二次重绘参数不完整，请复制到画布检查原工作流');
      restored.refine[key] = value;
    }
  }
  if (!Object.hasOwn(request, 'loras') && (request.lora || request.models?.lora)) {
    const strength = request.lora_strength ?? 1;
    restored.loras = [{ name: request.lora || request.models.lora, strength_model: strength,
      ...(request.kind.startsWith('sdxl') ? { strength_clip: strength } : {}) }];
  }
  const draft = restoreDraft(mode, restored);
  if (draft.references.length !== refs.length) throw new Error('参考图未完整恢复，请在画布中检查参数');
  return { mode, draft, missingPreviews: refs.filter(ref => !ref.url).length };
}
