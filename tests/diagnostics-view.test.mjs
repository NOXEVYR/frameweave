import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDiagnosticChecks } from '../web/diagnostics-view.mjs';
import { redactLocalText } from '../web/packages.mjs';

test('one discovery evidence is counted once; different evidence is preserved', () => {
  const local = [{ category: 'gpu', name: 'GPU', status: 'ok', detail: 'driver only' }];
  const workflow = [{ ...local[0], category: 'environment', id: 'environment.0' },
    { ...local[0], category: 'runtime', detail: 'torch CUDA device' },
    { ...local[0], category: 'environment', status: 'unknown' }];
  const result = mergeDiagnosticChecks(local, workflow);
  assert.equal(result.length, 3);
  assert.equal(result[0].category, 'gpu');
  assert.equal(result[1].detail, 'torch CUDA device');
  assert.equal(result[2].status, 'unknown');
  assert.equal(workflow.length, 3);
});

test('redaction preserves HTTPS documentation while hiding absolute and known local paths', () => {
  const url = 'https://docs.comfy.org/installation/system_requirements';
  assert.equal(redactLocalText(url), url);
  assert.equal(redactLocalText('http://127.0.0.1:8188'), 'http://127.0.0.1:8188');
  for (const path of ['C:\\private\\model.bin', 'F:/private/model.bin', '\\\\server\\private', '/home/private/file']) {
    assert.equal(redactLocalText(`${url}\n路径：${path}`), `${url}\n路径：[本机路径]`);
  }
  assert.equal(redactLocalText(`${url}\nrelative-private`, ['relative-private']), `${url}\n[本机路径]`);
});
