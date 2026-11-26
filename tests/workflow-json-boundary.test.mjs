import test from 'node:test';
import assert from 'node:assert/strict';
import { apiPromptFromDocument, parseJSONWithSafeNumbers, parsePackageDocument } from '../web/packages.mjs';

test('workflow raw JSON rejects duplicate node, nested input and escaped equivalent keys before loss', () => {
  for (const source of [
    '{"1":{"class_type":"A","inputs":{}},"1":{"class_type":"B","inputs":{}}}',
    '{"1":{"class_type":"A","inputs":{"seed":1,"seed":2}}}',
    '{"prompt":{"private secret":1,"private\\u0020secret":2}}',
    '{"items":[{"input":1,"input":2}]}',
  ]) {
    assert.throws(() => parseJSONWithSafeNumbers(source), error => /重复字段.*字符位置/.test(error.message) && !error.message.includes('secret'));
    assert.throws(() => parsePackageDocument(source), /重复字段/);
  }
});

test('key scanning preserves quoted punctuation, nested sibling keys, arrays and exact source semantics', () => {
  const source = '{"items":[{"seed":1},{"seed":2}],"text":"\\\"seed\\\":3,{[]} \\\\ end","键":false,"nested":{"键":null}}';
  assert.deepEqual(parseJSONWithSafeNumbers(source), JSON.parse(source));
  assert.deepEqual(parseJSONWithSafeNumbers('"{\\\"x\\\":1,\\\"x\\\":2}"'), '{"x":1,"x":2}');
  assert.deepEqual(parseJSONWithSafeNumbers('[1,0,false,null,{"":1}]'), [1, 0, false, null, { '': 1 }]);
  assert.throws(() => parseJSONWithSafeNumbers('{"seed":9007199254740993}'), /安全范围/);
  for (const source of ['{"a" 1}', '[1,]', '{"a":"unfinished}', '{"a":1,}']) assert.throws(() => parseJSONWithSafeNumbers(source));
  assert.throws(() => parseJSONWithSafeNumbers('['.repeat(257) + '0' + ']'.repeat(257)), /256/);
});

test('conflicting API carriers are refused while semantically equal carriers retain original wrappers', () => {
  const namedNodes = { prompt: { class_type: 'Example', inputs: {} }, workflow: { class_type: 'Example', inputs: { value: 2 } } };
  assert.equal(apiPromptFromDocument(namedNodes), namedNodes);
  const prompt = { '1': { class_type: 'Text', inputs: { text: 'hello', seed: 2 }, _meta: { title: 'first' } } };
  const reversed = { '1': { _meta: { title: 'first' }, inputs: { seed: 2, text: 'hello' }, class_type: 'Text' } };
  const document = { prompt, workflow: reversed, private_metadata: { preserved: true } };
  assert.equal(apiPromptFromDocument(document), prompt);
  assert.deepEqual(parsePackageDocument(JSON.stringify(document)), document);
  const changed = structuredClone(prompt); changed['1'].inputs.seed = 3;
  assert.throws(() => apiPromptFromDocument({ prompt, workflow: changed }), /不同的 prompt 和 workflow/);
  assert.throws(() => parsePackageDocument(JSON.stringify({ prompt, workflow: { nodes: [], links: [] } })), /单一 API/);
  const batchA = { '1': { class_type: 'Test', inputs: { values: [1, 2] } } };
  const batchB = { '1': { class_type: 'Test', inputs: { values: [2, 1] } } };
  assert.throws(() => apiPromptFromDocument({ prompt: batchA, workflow: batchB }), /不同/);
  assert.deepEqual(document.workflow, reversed);
  const signedZero = parseJSONWithSafeNumbers('{"prompt":{"1":{"class_type":"Example","inputs":{"value":-0}}},"workflow":{"1":{"class_type":"Example","inputs":{"value":0}}}}');
  assert.equal(apiPromptFromDocument(signedZero), signedZero.prompt);
});
