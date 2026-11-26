// Candidate names are live backend declarations, never proof of weight quality.
// Family rules follow frameweave/workflows.py::_check_family. The backend still
// validates the exact graph, loader options and model files before submission.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && item.length > 0))] : [];
const roles = new Set(['checkpoint', 'dit', 'text_encoder', 'vae', 'audio_vae', 'lora', 'sdxl_clip_l', 'sdxl_clip_g']);
const isH3 = kind => typeof kind === 'string' && kind.startsWith('h3_');
const isSDXL = kind => kind === 'sdxl' || kind === 'sdxl_i2i';

function compatible(name, role, kind, families) {
  const known = record(families) && Object.hasOwn(families, name) ? families[name] : 'unknown';
  const expected = ['sdxl_clip_l', 'sdxl_clip_g'].includes(role) ? role
    : isH3(kind) ? 'h3' : isSDXL(kind) ? 'sdxl' : ['qwen21_t2i', 'qwen21_edit'].includes(kind) ? 'qwen21' : kind;
  if (typeof known === 'string' && known && known !== 'unknown' && known !== expected &&
      !(kind === 'krea' && role === 'vae' && known === 'qwen_image')) return false;
  if (isH3(kind) && role === 'dit') {
    const lower = name.toLowerCase();
    if (kind === 'h3_ref' ? lower.includes('fl2va') : lower.includes('ref2va')) return false;
  }
  return true;
}

function preferred(name, role, kind) {
  const lower = name.toLowerCase().replaceAll('\\', '/');
  if (isH3(kind)) {
    if (role === 'dit') return /h3/.test(lower) && (kind === 'h3_ref' ? /ref/.test(lower) : /fl2v|fl2va|t2v/.test(lower)) && !/lora|turbo_4step|turbo_8step/.test(lower);
    if (role === 'text_encoder') return /minimax_h3|qwen3vl[_-]?32b|qwen3[_-]vl[_-]?32b/.test(lower);
    if (role === 'vae') return /minimax_h3.*video|h3.*video.*vae|h3.*vae.*video/.test(lower);
    if (role === 'audio_vae') return /h3.*audio|audio.*h3/.test(lower);
    if (role === 'lora') return /h3/.test(lower) && !(kind === 'h3_ref' ? /fl2v/.test(lower) : /ref2v/.test(lower));
  }
  if (kind === 'krea') {
    if (role === 'dit') return /krea2|krea_2/.test(lower) && !/lora/.test(lower);
    if (role === 'text_encoder') return /qwen3vl[_-]?4b|qwen3[_-]vl[_-]?4b/.test(lower);
    if (role === 'vae') return /qwen_image|qwen.*vae/.test(lower);
    if (role === 'lora') return /krea/.test(lower);
  }
  return isSDXL(kind) && role === 'lora' && /sdxl|pony|illustrious|noob|\bxl\b/.test(lower);
}

export function modelCandidates(engine, key, kind) {
  if (engine?.online !== true || !roles.has(key) || typeof kind !== 'string' || !kind) return [];
  const models = record(engine.models) ? engine.models : {};
  const options = record(engine.generation_options) ? engine.generation_options : {};
  let names;
  if (key === 'lora') {
    if (!record(options.lora_loaders)) return [];
    const loaders = isSDXL(kind) ? ['LoraLoader'] : ['LoraLoaderModelOnly', 'LoraLoaderBypassModelOnly'];
    names = [...new Set(loaders.flatMap(loader => strings(options.lora_loaders[loader]?.names)))];
  } else {
    names = strings(models[key] ?? (key === 'checkpoint' ? models.checkpoints : undefined));
  }
  const families = record(options.model_families) ? options.model_families[key] : null;
  const allowed = names.filter(name => compatible(name, key, kind, families));
  return [...allowed.filter(name => preferred(name, key, kind)), ...allowed.filter(name => !preferred(name, key, kind))];
}

export function samplingCandidates(engine, node, key) {
  if (engine?.online !== true || !['sampler', 'scheduler'].includes(key)) return [];
  const data = record(node?.data) ? node.data : record(node) ? node : {};
  const options = record(engine.generation_options) ? engine.generation_options : {};
  const native = strings(key === 'sampler' ? options.samplers : options.schedulers);
  if (!isH3(data.kind)) return native;
  const dual = record(options.h3_dual_clock) ? options.h3_dual_clock : {};
  const dualDeclared = strings(dual.samplers).includes('dual_clock_euler');
  if (key === 'sampler') {
    const h3Native = native.filter(name => name !== 'dual_clock_euler');
    return dualDeclared ? [...h3Native, 'dual_clock_euler'] : h3Native;
  }
  return data.sampler === 'dual_clock_euler' ? dualDeclared ? strings(dual.schedulers) : [] : native;
}
