import test from 'node:test';
import assert from 'node:assert/strict';
import { editorErrorMessage } from '../web/native-workflow-editor.mjs';

test('native import differences identify structural inputs without displaying values', () => {
  const message = editorErrorMessage({message:'未无损转换',result:{semantic_mismatch:{issues:[
    {code:'added_input',node_id:'5',input:'codec',value:'PRIVATE_MEDIA'},
    {code:'value_changed',node_id:'6',input:'prompt',before:'PRIVATE_PROMPT'},
    {code:'added_input',node_id:'../../secret',input:'not a safe name'},
  ]}}});
  assert.match(message,/新增输入 5.codec/);
  assert.match(message,/输入值改变 6.prompt/);
  assert.match(message,/原始内容已保留/);
  assert.doesNotMatch(message,/PRIVATE|secret|not a safe name/);
  assert.equal(editorErrorMessage(new Error('普通错误')), '普通错误');
});
