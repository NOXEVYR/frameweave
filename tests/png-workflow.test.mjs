import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPngWorkflows, PNG_MAX_FILE_BYTES } from '../web/png-workflow.mjs';

// Independent bitwise CRC fixture builder (production uses a lookup table).
function chunk(type, data = Buffer.alloc(0)) {
  data = Buffer.from(data); const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, body, tail]);
}
const ihdr = chunk('IHDR', Buffer.from([0,0,0,1,0,0,0,1,8,6,0,0,0]));
const idat = chunk('IDAT', deflateSync(Buffer.from([0,0,0,0,0]))), iend = chunk('IEND');
const sig = Buffer.from([137,80,78,71,13,10,26,10]);
const native = '{ "version": 0.4, "nodes": [{"id":1}], "links": [] }';
const api = '{"1":{"class_type":"SaveImage","inputs":{"filename_prefix":"test"}}}';
const text = (key, source) => chunk('tEXt', Buffer.concat([Buffer.from(key + '\0'), Buffer.from(source, 'latin1')]));
const zipped = (key, source, suffix = Buffer.alloc(0)) => chunk('zTXt', Buffer.concat([Buffer.from(key + '\0\0'), deflateSync(Buffer.from(source, 'latin1')), suffix]));
const badZlib = size => {
  const compressed = deflateSync(Buffer.alloc(size, 120));
  compressed[compressed.length - 1] ^= 1;
  return compressed;
};
const international = (key, source, flag = 0, method = 0) => chunk('iTXt', Buffer.concat([Buffer.from(key + '\0'), Buffer.from([flag, method]), Buffer.from('zh\0翻译\0'), flag ? deflateSync(Buffer.from(source)) : Buffer.from(source)]));
const png = (...metadata) => Buffer.concat([sig, ihdr, ...metadata, idat, iend]);
const code = expected => error => error.code === expected;

test('single carrier preserves raw JSON, kind and node count with typed input views', async () => {
  assert.equal(PNG_MAX_FILE_BYTES, 32 * 1024 * 1024);
  const file = png(text('prompt', api)); const container = Buffer.concat([Buffer.from([1]), file, Buffer.from([2])]);
  const [record] = await extractPngWorkflows(new Uint8Array(container.buffer, container.byteOffset + 1, file.length));
  assert.deepEqual(record, {key:'prompt',chunkIndex:1,sourceJSON:api,kind:'api',nodeCount:1,error:null});
  assert.deepEqual(await extractPngWorkflows(file.buffer.slice(file.byteOffset, file.byteOffset + file.length)), [record]);
});
test('PNG plain image and unrelated text do not become workflows', async () => {
  assert.deepEqual(await extractPngWorkflows(png(text('Comment', 'not JSON'), chunk('zTXt', Buffer.from('other\0\x07invalid')))), []);
});
test('native and API are independent alternatives, including compressed text', async () => {
  const records = await extractPngWorkflows(png(text('workflow', native), zipped('prompt', api)));
  assert.deepEqual(records.map(item => [item.key,item.kind,item.nodeCount,item.error]), [['workflow','native',1,null],['prompt','api',1,null]]);
  assert.equal(records[0].sourceJSON, native);
});
test('iTXt UTF-8 supports Unicode and uncompressed method byte must be ignored', async () => {
  const source = api.replace('test', '中文🙂');
  for (const [flag, method] of [[0,0],[0,253],[1,0]]) {
    const [record] = await extractPngWorkflows(png(international('prompt', source, flag, method)));
    assert.equal(record.sourceJSON, source); assert.equal(record.error, null);
  }
});
test('tEXt Latin-1 C1 bytes remain ISO-8859-1, never Windows-1252 substitutions', async () => {
  const source = api.replace('test', '\u0080\u0091é');
  assert.equal((await extractPngWorkflows(png(text('prompt', source))))[0].sourceJSON, source);
});
test('same-key carriers preserve every chunk and require explicit duplicate selection', async () => {
  const records = await extractPngWorkflows(png(text('prompt', api), text('prompt', api.replace('test','second')), text('prompt', '{')));
  assert.equal(records.length, 3); assert.deepEqual(records.map(item => item.chunkIndex), [1,2,3]);
  assert.ok(records.every(item => item.duplicate)); assert.equal(records[1].sourceJSON.includes('second'), true); assert.ok(records[2].error);
});
test('carrier JSON failure does not hide another valid carrier', async () => {
  const records = await extractPngWorkflows(png(text('workflow', '{'), text('prompt', api)));
  assert.ok(records[0].error); assert.equal(records[1].error, null);
});
test('safe JSON parser rejects duplicate keys including escaped keys and unsafe numbers', async () => {
  for (const source of ['{"nodes":[],"nodes":[],"version":0.4,"links":[]}', '{"x":1,"\\u0078":2}', api.replace('"test"','9007199254740992'), api.replace('"test"','1e999')]) {
    assert.ok((await extractPngWorkflows(png(text('prompt', source))))[0].error);
  }
});
test('API wrappers obey existing conflict rules and bare prompt node IDs remain legal', async () => {
  const graph = JSON.parse(api);
  assert.equal((await extractPngWorkflows(png(text('prompt', JSON.stringify({prompt:graph,workflow:graph})))))[0].error, null);
  assert.ok((await extractPngWorkflows(png(text('prompt', JSON.stringify({prompt:graph,workflow:{different:graph['1']}})))))[0].error);
  assert.equal((await extractPngWorkflows(png(text('prompt', JSON.stringify({prompt:graph['1']})))))[0].nodeCount, 1);
});
test('native version, malformed entries and Unicode/depth match storage boundaries', async () => {
  for (const source of ['{"nodes":[],"links":[],"version":3}', '{"nodes":[null],"links":[],"version":0.4}', '{"nodes":[],"links":[1],"version":0.4}', '{"nodes":[],"links":[],"version":0.4,"x":"\\ud800"}', '{"nodes":[],"links":[],"version":0.4,"x":' + '['.repeat(81) + '0' + ']'.repeat(81) + '}']) {
    assert.ok((await extractPngWorkflows(png(text('workflow', source))))[0].error);
  }
});
test('invalid encoding, text headers and compression methods are per-carrier errors', async () => {
  const broken = [chunk('iTXt',Buffer.from('workflow\0\x02\0\0\0{}')), chunk('iTXt',Buffer.from('workflow\0\0\0no-null')), chunk('zTXt',Buffer.from('workflow\0\x01abc')), international('workflow',native,1,1), chunk('iTXt',Buffer.concat([Buffer.from('workflow\0\0\0\0\0'),Buffer.from([0xff])])), text('workflow',native + '\0')];
  for (const carrier of broken) {
    const records = await extractPngWorkflows(png(carrier,text('prompt',api)));
    assert.ok(records[0].error); assert.equal(records[1].error,null);
  }
});
test('zlib checksum, truncation, trailing bytes and raw-deflate incompatibility remain errors', async () => {
  const compressed = deflateSync(Buffer.from(api)); const badChecksum = Buffer.from(compressed); badChecksum[badChecksum.length - 1] ^= 1;
  for (const payload of [compressed.subarray(0,compressed.length - 2),badChecksum,Buffer.concat([compressed,Buffer.from([1])]),compressed.subarray(2,compressed.length-4)]) {
    const records = await extractPngWorkflows(png(chunk('zTXt',Buffer.concat([Buffer.from('workflow\0\0'),payload])),text('prompt',api)));
    assert.ok(records[0].error); assert.equal(records[1].error,null);
  }
});
test('CRC is checked for every chunk, including unknown ancillary and empty chunks', async () => {
  for (const original of [png(text('prompt',api)),png(chunk('abCD',Buffer.from([1])))]) {
    const file = Buffer.from(original); file[41] ^= 1;
    await assert.rejects(extractPngWorkflows(file), code('crc'));
  }
  const file = png(); file[file.length - 1] ^= 1;
  await assert.rejects(extractPngWorkflows(file), code('crc'));
});
test('invalid signature, truncation, missing IEND, tail and unexpected critical blocks reject the container', async () => {
  await assert.rejects(extractPngWorkflows(Buffer.from('no')),code('signature'));
  for (const file of [png().subarray(0,10),png().subarray(0,-1)]) await assert.rejects(extractPngWorkflows(file),code('truncated'));
  await assert.rejects(extractPngWorkflows(png().subarray(0,-12)),code('end'));
  await assert.rejects(extractPngWorkflows(Buffer.concat([png(),Buffer.from([0])])),code('end'));
  await assert.rejects(extractPngWorkflows(png(chunk('ABCD'))),code('critical_chunk'));
  await assert.rejects(extractPngWorkflows(png(chunk('abcd'))),code('chunk_type'));
  const oversized = png(); oversized.writeUInt32BE(0x80000000,8);
  await assert.rejects(extractPngWorkflows(oversized),code('truncated'));
});
test('IHDR, palette and IDAT ordering are structurally checked without decoding pixels', async () => {
  await assert.rejects(extractPngWorkflows(Buffer.concat([sig,text('prompt',api),ihdr,idat,iend])),code('header'));
  await assert.rejects(extractPngWorkflows(png(ihdr)),code('header'));
  await assert.rejects(extractPngWorkflows(Buffer.concat([sig,ihdr,iend])),code('end'));
  await assert.rejects(extractPngWorkflows(Buffer.concat([sig,ihdr,idat,text('prompt',api),idat,iend])),code('data_order'));
  await assert.rejects(extractPngWorkflows(png(chunk('PLTE',Buffer.from([1])))),code('palette'));
  const badHeader = Buffer.from([0,0,0,0,0,0,0,1,8,6,0,0,0]);
  await assert.rejects(extractPngWorkflows(Buffer.concat([sig,chunk('IHDR',badHeader),idat,iend])),code('header'));
});
test('file, chunk and carrier budgets are hard errors and cannot be relaxed', async () => {
  await assert.rejects(extractPngWorkflows(png(),{limits:{fileBytes:20}}),code('file_budget'));
  await assert.rejects(extractPngWorkflows(png(),{limits:{chunks:2}}),code('chunk_budget'));
  await assert.rejects(extractPngWorkflows(png(text('prompt',api),text('workflow',native)),{limits:{carriers:1}}),code('carrier_budget'));
  await assert.rejects(extractPngWorkflows(png(),{limits:{fileBytes:PNG_MAX_FILE_BYTES+1}}),code('invalid_limits'));
});
test('uncompressed individual and aggregate metadata budgets reject the entire extraction', async () => {
  await assert.rejects(extractPngWorkflows(png(text('prompt',api)),{limits:{metadataBytes:10}}),code('metadata_budget'));
  await assert.rejects(extractPngWorkflows(png(text('prompt',api),text('workflow',native)),{limits:{totalMetadataBytes:api.length + native.length - 1}}),code('metadata_budget'));
});
test('compressed bombs stop at bounded output, including the actual default 16MiB budget', async () => {
  await assert.rejects(extractPngWorkflows(png(zipped('workflow','x'.repeat(20000))),{limits:{metadataBytes:1024}}),code('metadata_budget'));
  await assert.rejects(extractPngWorkflows(png(zipped('workflow','x'.repeat(16*1024*1024+1)))),code('metadata_budget'));
});
test('failed zlib checksum carriers still consume the aggregate decoded-byte budget', async () => {
  const broken = chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0'), badZlib(800 * 1024)]));
  await assert.rejects(extractPngWorkflows(png(broken, broken, broken), {
    limits: { metadataBytes: 1024 * 1024, totalMetadataBytes: 1024 * 1024 },
  }), code('metadata_budget'));
});
test('failed compressed iTXt carriers also consume aggregate bytes before checksum failure', async () => {
  const broken = chunk('iTXt', Buffer.concat([Buffer.from('workflow\0\x01\0\0\0'), badZlib(800 * 1024)]));
  await assert.rejects(extractPngWorkflows(png(broken, broken, broken), {
    limits: { metadataBytes: 1024 * 1024, totalMetadataBytes: 1024 * 1024 },
  }), code('metadata_budget'));
});
test('the default 32MiB aggregate budget rejects multiple failed streams below the individual cap', async () => {
  const broken = chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0'), badZlib(12 * 1024 * 1024)]));
  await assert.rejects(extractPngWorkflows(png(broken, broken, broken)), code('metadata_budget'));
});
test('a failed stream and subsequent plain text share the same decoded-byte budget', async () => {
  const broken = chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0'), badZlib(800 * 1024)]));
  const source = api.replace('test', 'x'.repeat(400 * 1024));
  await assert.rejects(extractPngWorkflows(png(broken, text('prompt', source)), {
    limits: { metadataBytes: 1024 * 1024, totalMetadataBytes: 1024 * 1024 },
  }), code('metadata_budget'));
});
test('a budget failure from a corrupted stream remains a hard container error', async () => {
  const broken = chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0'), badZlib(800 * 1024)]));
  await assert.rejects(extractPngWorkflows(png(broken, text('prompt', api)), {
    limits: { metadataBytes: 128 * 1024 },
  }), code('metadata_budget'));
});
test('a damaged stream within budget still allows explicit selection of another valid carrier', async () => {
  const broken = chunk('zTXt', Buffer.concat([Buffer.from('prompt\0\0'), badZlib(800 * 1024)]));
  const records = await extractPngWorkflows(png(broken, zipped('prompt', api)), {
    limits: { metadataBytes: 1024 * 1024, totalMetadataBytes: 1024 * 1024 },
  });
  assert.ok(records[0].error);
  assert.equal(records[0].sourceJSON, null);
  assert.equal(records[1].sourceJSON, api);
  assert.equal(records[1].error, null);
  assert.ok(records.every(record => record.duplicate));
});
test('successful streaming output is charged once and exact inclusive limits remain valid', async () => {
  const records = await extractPngWorkflows(png(zipped('workflow', native), zipped('prompt', api)), {
    limits: { metadataBytes: Math.max(native.length, api.length), totalMetadataBytes: native.length + api.length },
  });
  assert.deepEqual(records.map(record => record.error), [null, null]);
});
test('failed streaming adapters retain charges and stop before a third carrier', async () => {
  const allowances = [];
  await assert.rejects(extractPngWorkflows(png(zipped('workflow', native), zipped('workflow', native), zipped('prompt', api)), {
    limits: { metadataBytes: 100, totalMetadataBytes: 100 },
    inflate: async (_bytes, { maxBytes, onDecodedBytes }) => {
      allowances.push(maxBytes);
      onDecodedBytes(60);
      throw new Error('invalid checksum after output');
    },
  }), code('metadata_budget'));
  assert.deepEqual(allowances, [100, 40]);
});
test('an adapter cannot hide a budget error with a later stream error or returned payload', async () => {
  for (const returnPayload of [false, true]) {
    await assert.rejects(extractPngWorkflows(png(zipped('workflow', native)), {
      limits: { metadataBytes: 20 },
      inflate: async (_bytes, { onDecodedBytes }) => {
        try { onDecodedBytes(21); } catch { /* Simulate a masking adapter. */ }
        if (returnPayload) return new Uint8Array(0);
        throw new Error('checksum error');
      },
    }), code('metadata_budget'));
  }
});
test('a failed stream using the entire aggregate allowance cannot start another carrier', async () => {
  let calls = 0;
  await assert.rejects(extractPngWorkflows(png(zipped('workflow', native), zipped('prompt', api)), {
    limits: { metadataBytes: 100, totalMetadataBytes: 100 },
    inflate: async (_bytes, { onDecodedBytes }) => {
      calls++;
      onDecodedBytes(100);
      throw new Error('invalid checksum');
    },
  }), code('metadata_budget'));
  assert.equal(calls, 1);
});
test('injected inflate cannot bypass output limits, and receives remaining aggregate allowance', async () => {
  let maxBytes;
  await assert.rejects(extractPngWorkflows(png(zipped('workflow',native)),{limits:{metadataBytes:20},inflate:async (_bytes,options) => {maxBytes=options.maxBytes; return new Uint8Array(21);}}),code('metadata_budget'));
  assert.equal(maxBytes,20);
  await extractPngWorkflows(png(text('prompt',api),zipped('workflow',native)),{limits:{totalMetadataBytes:100},inflate:async (_bytes,options) => {maxBytes=options.maxBytes;return Buffer.from(native);}}).catch(error => assert.equal(error.code,'metadata_budget'));
  assert.equal(maxBytes,100-api.length);
});
test('cancellation is a hard error before and during asynchronous extraction', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractPngWorkflows(png(),{signal:controller.signal}),code('aborted'));
  const active = new AbortController();
  await assert.rejects(extractPngWorkflows(png(zipped('prompt',api)),{signal:active.signal,inflate:async () => {active.abort();return Buffer.from(api);}}),code('aborted'));
});
test('async extraction snapshots caller bytes and does not mutate original input', async () => {
  const file = png(zipped('prompt',api)), before = Buffer.from(file);
  const result = await extractPngWorkflows(file,{inflate:async () => {file.fill(0);return Buffer.from(api);}});
  assert.equal(result[0].error,null); assert.notDeepEqual(file,before);
  const untouched = png(text('prompt',api)), copy = Buffer.from(untouched); await extractPngWorkflows(untouched); assert.deepEqual(untouched,copy);
});
test('missing decompression capability does not hide compressed carrier error or block plain carrier', async () => {
  const original = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    const records = await extractPngWorkflows(png(zipped('workflow',native),text('prompt',api)));
    assert.equal(records[0].error.code,'compression_unavailable'); assert.equal(records[1].error,null);
  } finally { globalThis.DecompressionStream = original; }
});
