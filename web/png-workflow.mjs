import { apiPromptFromDocument, parseJSONWithSafeNumbers, PACKAGE_LIMIT } from './packages.mjs';

export const PNG_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({ fileBytes: PNG_MAX_FILE_BYTES, metadataBytes: 16 * 1024 * 1024,
  totalMetadataBytes: 32 * 1024 * 1024, chunks: 4096, carriers: 32 });
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function abort(signal) { if (signal?.aborted) throw fail('aborted', 'PNG 工作流读取已取消'); }
function crc(bytes, start, end) {
  let value = 0xffffffff;
  for (let index = start; index < end; index++) value = crcTable[(value ^ bytes[index]) & 255] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
function latin1(bytes) {
  // WHATWG TextDecoder('latin1') maps to Windows-1252, whereas PNG uses ISO-8859-1.
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return text;
}
function utf8(bytes) { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }

/** Read a complete zlib stream with bounded output; never decode image pixels. */
async function inflateBounded(bytes, { maxBytes, signal, onDecodedBytes }) {
  if (typeof globalThis.DecompressionStream !== 'function') throw fail('compression_unavailable', '当前浏览器不支持 PNG 压缩元数据解码');
  abort(signal);
  const stream = new DecompressionStream('deflate');
  const reader = stream.readable.getReader(), writer = stream.writable.getWriter();
  const stop = () => { void reader.cancel().catch(() => {}); void writer.abort().catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  const parts = []; let size = 0;
  const reading = (async () => {
    for (;;) {
      abort(signal);
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // Account output before checksum validation can fail; failed streams cost bytes too.
      onDecodedBytes?.(value.byteLength);
      if (size > maxBytes) throw fail('metadata_budget', 'PNG 解压元数据超过允许的字节预算');
      parts.push(value);
    }
  })();
  const writing = (async () => {
    // Small writes bound decompressor work before the reader can cancel a bomb.
    for (let offset = 0; offset < bytes.length; offset += 256) {
      abort(signal); await writer.write(bytes.subarray(offset, offset + 256));
    }
    await writer.close();
  })();
  try {
    // Settle both sides after cancellation so a write/checksum error cannot hide a
    // reader budget error or leave a reader charging bytes after the next carrier.
    const results = await Promise.allSettled([reading, writing].map(task => task.catch(error => { stop(); throw error; })));
    abort(signal);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw errors.find(error => error.code === 'metadata_budget') || errors[0];
    const result = new Uint8Array(size); let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  } catch (error) { stop(); abort(signal); throw error; }
  finally { signal?.removeEventListener('abort', stop); }
}

function classify(sourceJSON) {
  if (new TextEncoder().encode(sourceJSON).length > DEFAULT_LIMITS.metadataBytes) throw fail('source_budget', 'PNG 工作流 JSON 最大为 16 MiB');
  const document = parseJSONWithSafeNumbers(sourceJSON.replace(/^\uFEFF/, ''));
  if (document && Array.isArray(document.nodes)) {
    if (!(document.version === 0.4 || typeof document.version === 'number' && document.version >= 1 && document.version < 2)) {
      throw fail('native_version', 'PNG 原生工作流版本不受支持');
    }
    if (document.nodes.length > 10000 || !Array.isArray(document.links) || document.links.length > 50000) {
      throw fail('native_structure', 'PNG 原生工作流节点或连线结构超出允许范围');
    }
    if (document.nodes.some(node => !node || typeof node !== 'object' || Array.isArray(node)) ||
      document.links.some(link => !link || typeof link !== 'object')) throw fail('native_structure', 'PNG 原生工作流节点或连线项目无效');
    const pending = [[document, 0]]; let items = 0;
    const validUnicode = text => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
    while (pending.length) {
      const [value, depth] = pending.pop();
      if (++items > 500000 || depth > 80) throw fail('native_structure', 'PNG 原生工作流 JSON 结构过深或项目过多');
      if (typeof value === 'string' && !validUnicode(value)) throw fail('text_encoding', 'PNG 工作流 JSON 包含无效 Unicode');
      if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
        if (!validUnicode(key)) throw fail('text_encoding', 'PNG 工作流 JSON 字段包含无效 Unicode');
        pending.push([child, depth + 1]);
      }
    }
    return { kind: 'native', nodeCount: document.nodes.length };
  }
  if (new TextEncoder().encode(sourceJSON).length > PACKAGE_LIMIT) throw fail('api_budget', 'PNG API 工作流最大为 2 MiB');
  const prompt = apiPromptFromDocument(document);
  return { kind: 'api', nodeCount: Object.keys(prompt).length };
}

/**
 * Data-only extraction. Container/budget errors throw; individual carrier errors
 * remain selectable diagnostics. Repeated keywords are retained, never merged.
 * limits can only tighten defaults; inflate is an injectable bounded test adapter.
 * Streaming adapters report every output chunk with onDecodedBytes, even on failure.
 */
export async function extractPngWorkflows(input, { signal, limits = {}, inflate = inflateBounded } = {}) {
  const budget = { ...DEFAULT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(budget, key) || !Number.isSafeInteger(value) || value < 1 || value > budget[key]) {
      throw fail('invalid_limits', 'PNG 预算参数只能收紧默认限制');
    }
    budget[key] = value;
  }
  abort(signal);
  const source = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!source) throw fail('invalid_input', 'PNG 内容必须是字节数组');
  if (source.length > budget.fileBytes) throw fail('file_budget', 'PNG 工作流文件最大为 32 MiB');
  const bytes = new Uint8Array(source); // Keep the async parse independent of caller mutations.
  if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) throw fail('signature', '文件不是有效 PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = []; let offset = 8, chunks = 0, totalDecoded = 0, sawHeader = false, sawEnd = false;
  let sawData = false, closedData = false, sawPalette = false, colorType = null;
  while (offset < bytes.length) {
    abort(signal);
    const chunkIndex = chunks++;
    if (chunks > budget.chunks) throw fail('chunk_budget', 'PNG 块数量超过允许范围');
    if (bytes.length - offset < 12) throw fail('truncated', 'PNG 块头或校验值被截断');
    const length = view.getUint32(offset);
    if (length > 0x7fffffff || length > bytes.length - offset - 12) throw fail('truncated', 'PNG 块长度无效或内容被截断');
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) throw fail('chunk_type', 'PNG 块类型无效');
    if (crc(bytes, offset + 4, offset + 8 + length) !== view.getUint32(offset + 8 + length)) throw fail('crc', `PNG ${type} 块 CRC 校验失败`);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (!sawHeader && type !== 'IHDR') throw fail('header', 'PNG 首块必须是 IHDR');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw fail('header', 'PNG IHDR 块重复或长度无效');
      sawHeader = true;
      const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const width = header.getUint32(0), height = header.getUint32(4), depth = data[8]; colorType = data[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[colorType]?.includes(depth) || data[10] || data[11] || data[12] > 1) {
        throw fail('header', 'PNG 图像头参数无效');
      }
    } else if (type === 'IEND') {
      if (length || !sawData || offset !== bytes.length) throw fail('end', 'PNG IEND 无效、缺少图像数据或包含不明尾部');
      sawEnd = true; break;
    } else if (type === 'IDAT') {
      if (closedData || colorType === 3 && !sawPalette) throw fail('data_order', 'PNG 图像数据块顺序无效');
      sawData = true;
    } else {
      if (sawData) closedData = true;
      if (type === 'PLTE') {
        if (sawPalette || sawData || !length || length % 3 || length > 768 || [0, 4].includes(colorType)) throw fail('palette', 'PNG 调色板无效');
        sawPalette = true;
      } else if (type[0] === type[0].toUpperCase()) throw fail('critical_chunk', `PNG 包含不支持的关键块 ${type}`);
      if (!['tEXt', 'zTXt', 'iTXt'].includes(type)) continue;
      const separator = data.indexOf(0);
      const key = separator < 0 ? null : latin1(data.subarray(0, separator));
      if (!['workflow', 'prompt'].includes(key)) continue;
      if (records.length >= budget.carriers) throw fail('carrier_budget', 'PNG 工作流载体数量超过允许范围');
      const record = { key, chunkIndex, sourceJSON: null, kind: null, nodeCount: 0, error: null };
      records.push(record);
      try {
        let payload = data.subarray(separator + 1), compressed = false, international = false;
        if (type === 'zTXt') {
          if (!payload.length || payload[0] !== 0) throw fail('compression_method', 'PNG zTXt 压缩方法不受支持');
          payload = payload.subarray(1); compressed = true;
        } else if (type === 'iTXt') {
          international = true;
          if (payload.length < 4 || payload[0] > 1) throw fail('text_header', 'PNG iTXt 头被截断或压缩标志无效');
          compressed = payload[0] === 1;
          if (compressed && payload[1] !== 0) throw fail('compression_method', 'PNG iTXt 压缩方法不受支持');
          // For uncompressed iTXt, decoders must ignore the method byte.
          const languageEnd = payload.indexOf(0, 2);
          const translatedEnd = languageEnd < 0 ? -1 : payload.indexOf(0, languageEnd + 1);
          if (translatedEnd < 0) throw fail('text_header', 'PNG iTXt 语言或翻译关键词被截断');
          if (!/^[A-Za-z0-9-]*$/.test(latin1(payload.subarray(2, languageEnd)))) throw fail('text_header', 'PNG iTXt 语言标记无效');
          utf8(payload.subarray(languageEnd + 1, translatedEnd));
          payload = payload.subarray(translatedEnd + 1);
        }
        const remaining = Math.min(budget.metadataBytes, budget.totalMetadataBytes - totalDecoded);
        if (remaining <= 0) throw fail('metadata_budget', 'PNG 元数据超过允许的字节预算');
        let carrierDecoded = 0, budgetError = null;
        const onDecodedBytes = count => {
          if (!Number.isSafeInteger(count) || count < 0) throw fail('inflate_result', 'PNG 解压器返回无效字节计数');
          carrierDecoded += count;
          totalDecoded += count; // Never roll this back when the carrier later fails.
          if (carrierDecoded > remaining) {
            budgetError = fail('metadata_budget', 'PNG 元数据超过允许的字节预算');
            throw budgetError;
          }
        };
        if (compressed) {
          try { payload = await inflate(payload, { maxBytes: remaining, signal, onDecodedBytes }); }
          catch (error) { throw budgetError || error; }
          if (budgetError) throw budgetError;
        }
        abort(signal);
        if (!(payload instanceof Uint8Array)) throw fail('inflate_result', 'PNG 解压器返回无效字节数组');
        // Preserve non-streaming test adapters while avoiding double charging
        // successful streaming output. Any reported work remains charged.
        onDecodedBytes(Math.max(0, payload.length - carrierDecoded));
        record.sourceJSON = international ? utf8(payload) : latin1(payload);
        if (record.sourceJSON.includes('\0')) throw fail('text_encoding', 'PNG 文本元数据包含 NUL 字符');
        Object.assign(record, classify(record.sourceJSON));
      } catch (error) {
        if (signal?.aborted || ['metadata_budget', 'aborted'].includes(error.code)) throw error;
        record.error = { code: error.code || 'carrier_invalid', message: error.message || 'PNG 工作流元数据无效' };
      }
    }
  }
  if (!sawEnd) throw fail('end', 'PNG 缺少完整 IEND 块');
  for (const record of records) if (records.filter(item => item.key === record.key).length > 1) record.duplicate = true;
  return records;
}
