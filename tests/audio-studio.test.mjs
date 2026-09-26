import test from 'node:test';
import assert from 'node:assert/strict';
import { audioIntegrationRequest, audioPackageChoices, buildAudioPackageRequest } from '../web/audio-studio.mjs';

const backend = 'http://127.0.0.1:8188';
const packageDoc = { id: 'p-audio', name: '参考音频配音', fields: [
  { id: 'prompt', label: '台词', type: 'text', required: true },
  { id: 'voice_audio', label: '声音参考', type: 'audio', required: true },
  { id: 'steps', label: '采样步数', type: 'integer', required: true, default: 8, min: 1, max: 40 },
] };

test('audio package choices require the capability report to match the active backend and preserve ineligible reasons', () => {
  const report = { backend_url: backend, available: true, packages: [
    { id: packageDoc.id, name: 'Backend name', category: 'unclassified', eligible: true, available: true, audio_outputs: [{ type: 'audio' }] },
    { id: 'p-missing', name: 'Needs Audio VAE', eligible: false, available: false, reason: '缺少 AUDIO 解码器' },
  ] };
  const current = audioPackageChoices(report, [packageDoc], backend);
  assert.equal(current.stale, false);
  assert.equal(current.packages[0].fields[1].type, 'audio');
  assert.equal(current.packages[1].eligible, false);
  assert.match(current.packages[1].reason, /AUDIO 解码器/);
  assert.deepEqual(audioPackageChoices(report, [packageDoc], 'http://127.0.0.1:9999'), { stale: true, available: false, packages: [] });
});

test('audio package requests preserve scalar and uploaded media values without embedding file bytes', () => {
  const pack = { ...packageDoc, eligible: true, available: true };
  const draft = { package_id: pack.id, values: { prompt: '清晰温柔的旁白', voice_audio: 'input/voice.wav', steps: 12 }, mediaBackends: { voice_audio: backend } };
  assert.deepEqual(buildAudioPackageRequest(pack, draft, backend), {
    kind: 'package', package_id: pack.id,
    values: { prompt: '清晰温柔的旁白', steps: 12, voice_audio: 'input/voice.wav' },
  });
});

test('audio package requests refuse unsupported, missing, changed, or cross-backend inputs', () => {
  const pack = { ...packageDoc, eligible: true, available: true };
  const base = { package_id: pack.id, values: { prompt: '朗读内容', voice_audio: 'voice.wav', steps: 8 }, mediaBackends: { voice_audio: backend } };
  assert.throws(() => buildAudioPackageRequest({ ...pack, eligible: false, reason: '没有 AUDIO 输出' }, base, backend), /没有 AUDIO 输出/);
  assert.throws(() => buildAudioPackageRequest(pack, { ...base, package_id: 'p-other' }, backend), /已切换/);
  assert.throws(() => buildAudioPackageRequest(pack, { ...base, values: { ...base.values, voice_audio: '' } }, backend), /音频输入/);
  assert.throws(() => buildAudioPackageRequest(pack, { ...base, mediaBackends: { voice_audio: 'http://127.0.0.1:9999' } }, backend), /另一个推理引擎/);
});

test('audio integration note includes version, AUDIO classes and safe reasons but excludes private content', () => {
  const note = audioIntegrationRequest({ system: { comfyui_version: '0.3.26', name: 'C:\\private\\model.safetensors' } }, {
    outputs: [{ class_type: 'SaveAudio', input: 'audio' }, { class_type: '../private/model.safetensors', input: 'audio' }],
    packages: [
      { id: 'secret-id', name: 'private prompt and model', eligible: false, available: false,
        reason: '工作流包没有连接到 AUDIO 输入的后端输出节点', issues: ['C:\\private\\prompt.txt'] },
      { id: 'ready', name: 'local voice', eligible: true, available: true },
    ],
  });
  assert.match(note, /0\.3\.26/);
  assert.match(note, /SaveAudio/);
  assert.match(note, /当前可用 1 个/);
  assert.match(note, /工作流包没有连接到 AUDIO 输入的后端输出节点/);
  assert.doesNotMatch(note, /private|safetensors|secret-id|prompt\.txt|local voice/);
  assert.match(note, /不要自动下载模型/);
});

test('audio integration note treats malformed versions and unknown backend reasons as untrusted', () => {
  const note = audioIntegrationRequest({ system: { comfyui_version: 'C:\\private\\model.safetensors' } }, {
    reason: 'private /prompt/ model.safetensors', packages: [{ eligible: false, reason: 'private /prompt/ model.safetensors' }],
  });
  assert.match(note, /未知/);
  assert.match(note, /暂无可安全汇总的原因/);
  assert.doesNotMatch(note, /private|safetensors|model/);
});
