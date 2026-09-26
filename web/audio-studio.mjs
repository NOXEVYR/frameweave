import { defaultValues, fieldType, validateValues } from './packages.mjs';

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const node = (tag, className = '', text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** Join local package documents with the live backend's AUDIO-schema result. */
export function audioPackageChoices(capability, packages, backend) {
  if (!capability || capability.backend_url !== backend || !Array.isArray(capability.packages)) return { stale: true, available: false, packages: [] };
  const local = new Map((packages || []).filter(item => item && typeof item.id === 'string').map(item => [item.id, item]));
  const choices = capability.packages.filter(item => item && typeof item.id === 'string').map(item => {
    const source = local.get(item.id);
    return source ? { ...item, ...source, capability: item, fields: source.fields || item.fields || [] } : { ...item, capability: item, fields: item.fields || [] };
  });
  return { stale: false, available: capability.available === true, packages: choices };
}

/** Validate a package-backed sound/music generation request without submitting it. */
export function buildAudioPackageRequest(pack, draft, backend) {
  if (!pack || typeof pack.id !== 'string') throw new Error('请选择本机已导入的音频工作流包');
  if (pack.eligible !== true || pack.available === false) throw new Error(pack.reason || '此工作流包尚未通过当前后端 AUDIO schema 检查');
  if (draft.package_id !== pack.id) throw new Error('工作流包已切换，请重新检查输入');
  for (const [field, owner] of Object.entries(draft.mediaBackends || {})) {
    if (draft.values?.[field] && owner && owner !== backend) throw new Error('音频或图片输入属于另一个推理引擎，请在当前引擎重新上传');
  }
  const values = validateValues((pack.fields || []).filter(field => field.type !== 'audio'), draft.values || {});
  for (const field of (pack.fields || []).filter(item => item.type === 'audio')) {
    const value = draft.values?.[field.id] ?? field.default ?? '';
    if (typeof value !== 'string' || value.length > 1024 || field.required && !value.trim()) throw new Error(`请填写「${field.label || field.id}」音频输入`);
    values[field.id] = value;
  }
  return { kind: 'package', package_id: pack.id, values };
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('无法读取所选本地素材'));
    reader.readAsDataURL(file);
  });
}

function typeOf(field) {
  return field?.type === 'audio' ? 'audio' : fieldType(field);
}

/** Render the data-only scalar/media bindings exposed by one imported workflow package. */
export function renderAudioFields(container, { pack, draft, api, backend, currentBackend = () => backend, onChange, reportError }) {
  container.replaceChildren();
  for (const field of pack?.fields || []) {
    const type = typeOf(field), label = field.label || field.id;
    const wrap = node('label', 'studio-field audio-package-field');
    wrap.append(node('span', '', label));
    let input;
    if (type === 'image' || type === 'audio') {
      input = node('input'); input.type = 'file'; input.accept = type === 'audio' ? 'audio/wav,audio/mpeg,audio/flac,audio/ogg,.wav,.mp3,.flac,.ogg' : 'image/png,image/jpeg,image/webp';
      input.setAttribute('aria-label', label);
      const value = draft.values?.[field.id] || '';
      const existing = node('small', 'audio-upload-name', value ? `已上传：${value}` : type === 'audio' ? '选择 WAV、MP3、FLAC、OGG、M4A 或 AAC 音频' : '选择 PNG、JPEG 或 WebP 图片');
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          const startedBackend = currentBackend();
          if (file.size > MAX_AUDIO_BYTES) throw new Error('输入素材每个最多 20 MiB');
          if (type === 'audio' && !/\.(wav|mp3|flac|ogg)$/i.test(file.name)) throw new Error('参考音频当前支持 WAV、MP3、FLAC、OGG');
          if (type === 'image' && !/^image\/(png|jpeg|webp)$/i.test(file.type)) throw new Error('图片输入支持 PNG、JPEG 或 WebP');
          const data = await readBase64(file);
          const uploaded = await api(type === 'audio' ? '/api/upload-audio' : '/api/upload', { name: file.name, data });
          if (!uploaded?.name || currentBackend() !== startedBackend || startedBackend !== backend || uploaded.backend && uploaded.backend !== startedBackend) throw new Error('上传素材没有绑定到当前推理引擎；请重新选择并上传');
          draft.values ||= {}; draft.mediaBackends ||= {};
          draft.values[field.id] = uploaded.name; draft.mediaBackends[field.id] = uploaded.backend || startedBackend;
          existing.textContent = `已上传：${file.name}`;
          onChange();
        } catch (error) { reportError(error); }
        finally { input.value = ''; }
      });
      wrap.append(input, existing);
      if (field.required && !value) wrap.append(node('small', 'field-error', '必需输入'));
    } else if (type === 'boolean') {
      wrap.classList.add('audio-package-toggle'); input = node('input'); input.type = 'checkbox'; input.checked = draft.values?.[field.id] ?? field.default ?? false;
      input.addEventListener('change', () => { draft.values ||= {}; draft.values[field.id] = input.checked; onChange(); }); wrap.append(input);
    } else if (type === 'select') {
      input = node('select');
      for (const optionValue of field.options || []) { const option = node('option', '', String(optionValue)); option.value = String(optionValue); input.append(option); }
      input.value = String(draft.values?.[field.id] ?? field.default ?? '');
      input.addEventListener('change', () => { const original = (field.options || []).find(value => String(value) === input.value); draft.values ||= {}; draft.values[field.id] = original; onChange(); }); wrap.append(input);
    } else {
      input = node(type === 'text' && /prompt|text|caption|歌词|文本|提示/i.test(`${field.id} ${label}`) ? 'textarea' : 'input');
      if (input.tagName === 'TEXTAREA') input.rows = 4;
      else input.type = type === 'integer' || type === 'number' ? 'number' : 'text';
      if (type === 'integer' || type === 'number') {
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        input.step = type === 'integer' ? '1' : 'any';
      }
      input.value = draft.values?.[field.id] ?? field.default ?? '';
      input.addEventListener('input', () => { draft.values ||= {}; draft.values[field.id] = type === 'integer' || type === 'number' ? (input.value === '' ? '' : Number(input.value)) : input.value; onChange(); });
      wrap.append(input);
    }
    if (field.description) wrap.append(node('small', '', field.description));
    container.append(wrap);
  }
}

export function initialAudioValues(pack) {
  return defaultValues(pack?.fields || []);
}

const SAFE_AUDIO_REASONS = new Map([
  ['当前后端没有可验证的 AUDIO 输出节点', '当前后端没有可验证的 AUDIO 输出节点'],
  ['尚无通过当前后端校验的音频工作流包', '尚无通过当前后端校验的音频工作流包'],
  ['工作流包没有可校验的 API 图', '工作流包没有可校验的 API 图'],
  ['节点或参数与当前后端定义不兼容', '节点或参数与当前后端定义不兼容'],
  ['工作流包没有连接到 AUDIO 输入的后端输出节点', '工作流包没有连接到 AUDIO 输入的后端输出节点'],
  ['工作流包当前不可用于音频生成', '工作流包当前不可用于音频生成'],
]);

function safeComfyVersion(engine) {
  const candidate = engine?.system?.comfyui_version;
  return typeof candidate === 'string' && /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?(?:[-+][A-Za-z0-9.-]{1,24})?$/.test(candidate)
    ? candidate : '未知（请在本地环境检查中确认）';
}

/** Build a privacy-bounded integration note; never copy package names, paths, models, or prompts. */
export function audioIntegrationRequest(engine, capability) {
  const outputs = Array.isArray(capability?.outputs) ? capability.outputs : [];
  const classes = [...new Set(outputs.map(item => item?.class_type).filter(value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value)))].sort();
  const packages = Array.isArray(capability?.packages) ? capability.packages : [];
  const unavailable = packages.filter(item => item?.eligible !== true || item?.available === false);
  const reasons = [...new Set(unavailable.flatMap(item => [item?.reason, ...(Array.isArray(item?.issues) ? item.issues : [])])
    .map(reason => SAFE_AUDIO_REASONS.get(reason)).filter(Boolean))];
  if (!classes.length && capability?.reason) {
    const reason = SAFE_AUDIO_REASONS.get(capability.reason);
    if (reason) reasons.push(reason);
  }
  const lines = [
    '请为棱光 PrismCanvas 本地工作台规划声音/音乐工作流接入。',
    `本机 ComfyUI 版本：${safeComfyVersion(engine)}`,
    `实时 schema 检出的 AUDIO 输出节点类：${classes.length ? classes.join('、') : '未检出'}`,
    `已导入工作流包检查：${packages.length} 个；当前可用 ${packages.filter(item => item?.eligible === true && item?.available !== false).length} 个。`,
    `标准化的不可用原因：${reasons.length ? reasons.join('；') : '暂无可安全汇总的原因，请检查导入工作流的 AUDIO 输出连线与当前节点 schema。'}`,
    '约束：复用本机已有模型和环境；先核对当前 ComfyUI 版本、节点和工作流兼容性；不要自动下载模型、调用云端 API、安装节点、重启或改动现有配置。先给出需要导入的工作流包及可逆的接入步骤。',
  ];
  return lines.join('\n');
}
