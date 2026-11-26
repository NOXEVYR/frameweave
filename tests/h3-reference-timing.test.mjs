import test from 'node:test';
import assert from 'node:assert/strict';
import { h3ReferenceTiming, h3ReferenceTimingText } from '../web/h3-reference-builder.mjs';

function document(cap = 48, length = 124, soundtrack = true) {
  const inputs = { length, 'ref_videos.ref_video_0': ['video', 0] };
  if (soundtrack) inputs['ref_video_audios.ref_video_audio_0'] = ['video', 2];
  return { prompt: {
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs },
    video: { class_type: 'VHS_LoadVideo', inputs: { video: 'synthetic.mp4', force_rate: 24,
      frame_load_cap: cap, skip_first_frames: 0, select_every_nth: 1, format: 'None' } },
  }, fields: [] };
}

test('48 loaded frames conditionally yield at most 39 reference frames and a .375s soundtrack span gap', () => {
  const doc = document(), before = structuredClone(doc), timing = h3ReferenceTiming(doc)[0];
  assert.equal(timing.frame_load_cap, 48); assert.equal(timing.effective_frames_estimate, 39);
  assert.equal(timing.loaded_seconds_estimate, 2); assert.equal(timing.effective_seconds_estimate, 1.625);
  assert.equal(timing.soundtrack_seconds_estimate, 2); assert.equal(timing.span_difference_seconds_estimate, .375);
  assert.equal(timing.discarded_frames_estimate, 9); assert.equal(timing.estimate_status, 'conditional');
  assert.equal(timing.runtime_verified, false);
  const lines = h3ReferenceTimingText(doc).join(' ');
  assert.match(lines, /最多 39 帧/); assert.match(lines, /读取请求约 2 秒/); assert.match(lines, /跨度差估算 0.375 秒/);
  assert.match(lines, /加载满上限/); assert.match(lines, /object_info 不能证明运行时已截帧/);
  assert.deepEqual(doc, before);
});

test('downward alignment boundaries and shorter output limit are explicit', () => {
  for (const [cap, expected] of [[5, 5], [21, 5], [22, 22], [38, 22], [39, 39], [48, 39],
    [55, 39], [56, 56], [123, 107], [124, 124], [362, 362]]) {
    const timing = h3ReferenceTiming(document(cap, 480))[0];
    assert.equal(timing.effective_frames_estimate, expected, `cap ${cap}`);
    assert.equal(timing.discarded_frames_estimate, cap - expected);
  }
  const timing = h3ReferenceTiming(document(48, 22))[0];
  assert.equal(timing.effective_frames_estimate, 22); assert.equal(timing.span_difference_seconds_estimate, 26 / 24);
});

test('current outer cap and output values recompute the lines without mutating saved defaults or graph', () => {
  const doc = document(124);
  doc.fields = [{ id: 'cap', node_id: 'video', input: 'frame_load_cap', default: 124 },
    { id: 'length', node_id: 'h3', input: 'length', default: 124 }];
  const before = structuredClone(doc);
  assert.equal(h3ReferenceTiming(doc, { cap: 48 })[0].effective_frames_estimate, 39);
  assert.match(h3ReferenceTimingText(doc, { cap: 48 }).join(' '), /48 帧.*39 帧/);
  assert.match(h3ReferenceTimingText(doc, { cap: 39 }).join(' '), /39 帧.*跨度差估算 0 秒/);
  assert.equal(h3ReferenceTiming(doc, { cap: 56 })[0].effective_frames_estimate, 56);
  assert.equal(h3ReferenceTiming(doc, { cap: 48, length: 22 })[0].effective_frames_estimate, 22);
  assert.deepEqual(doc, before);
});

test('unbounded caps and changed skip, stride, rate, format or linked scalars have no numeric estimate', () => {
  const changes = [0, 4, true, 48.5, '48', ['other', 0], Infinity, NaN, Number.MAX_SAFE_INTEGER + 1].map(value => ['frame_load_cap', value]);
  changes.push(['force_rate', 0], ['force_rate', 30], ['select_every_nth', 2], ['skip_first_frames', 1],
    ['skip_first_frames', ['other', 0]], ['format', 'AnimateDiff']);
  for (const [name, value] of changes) {
    const doc = document(); doc.prompt.video.inputs[name] = value;
    const timing = h3ReferenceTiming(doc)[0];
    assert.equal(timing.estimate_status, 'unknown', name);
    for (const key of ['effective_frames_estimate', 'effective_seconds_estimate', 'soundtrack_seconds_estimate', 'span_difference_seconds_estimate']) assert.equal(timing[key], null);
    assert.equal(timing.runtime_verified, false);
    assert.doesNotMatch(h3ReferenceTimingText(doc).join(' '), /跨度差估算 \d/);
  }
  for (const length of [4, ['other', 0]]) assert.equal(h3ReferenceTiming(document(48, length))[0].estimate_status, 'unknown');
});

test('stale defaults never hide deleted or linked controls and duplicate bindings remain unknown', () => {
  for (const mode of ['deleted', 'linked', 'no-inputs', 'duplicate']) {
    const doc = document(); doc.fields = [{ id: 'cap', node_id: 'video', input: 'frame_load_cap', default: 48 }];
    if (mode === 'deleted') delete doc.prompt.video.inputs.frame_load_cap;
    if (mode === 'linked') doc.prompt.video.inputs.frame_load_cap = ['other', 0];
    if (mode === 'no-inputs') delete doc.prompt.video.inputs;
    if (mode === 'duplicate') doc.fields.push({ ...doc.fields[0], id: 'othercap', default: 39 });
    assert.equal(h3ReferenceTiming(doc, { cap: 48 })[0].estimate_status, 'unknown', mode);
  }
  const doc = document(); doc.fields = [{ id: 'length', node_id: 'h3', input: 'length', default: 124 }];
  doc.prompt.h3.inputs.length = ['other', 0];
  assert.equal(h3ReferenceTiming(doc, { length: 124 })[0].estimate_status, 'unknown');
});

test('same-loader pairing and actual field labels identify reordered dynamic names independently', () => {
  const doc = document(48, 124, false);
  doc.prompt.second = structuredClone(doc.prompt.video); doc.prompt.second.inputs.frame_load_cap = 56;
  doc.prompt.h3.inputs = { length: 124, 'ref_videos.ref_video_2': ['video', 0], 'ref_videos.ref_video_0': ['second', 0],
    'ref_video_audios.ref_video_audio_0': ['second', 2] };
  doc.fields = [{ id: 'video1', node_id: 'video', input: 'video', label: '参考视频1' },
    { id: 'video2', node_id: 'second', input: 'video', label: '参考视频2' }];
  const timing = h3ReferenceTiming(doc);
  assert.deepEqual(timing.map(item => [item.video_label, item.video_ordinal, item.video_input, item.effective_frames_estimate, item.soundtrack]),
    [['参考视频1', 1, 'ref_videos.ref_video_2', 39, false], ['参考视频2', 2, 'ref_videos.ref_video_0', 56, true]]);
  assert.equal(timing[0].span_difference_seconds_estimate, null);
  doc.prompt.h3.inputs['ref_video_audios.ref_video_audio_0'] = ['different', 2];
  assert.equal(h3ReferenceTiming(doc)[1].soundtrack, false);
  const wrongSlot = document(48, 124, false);
  wrongSlot.prompt.h3.inputs['ref_video_audios.ref_video_audio_1'] = ['video', 2];
  assert.equal(h3ReferenceTiming(wrongSlot)[0].soundtrack, true);
  assert.equal(h3ReferenceTiming(wrongSlot)[0].span_difference_seconds_estimate, .375);
  assert.match(h3ReferenceTiming(wrongSlot)[0].message, /同源音轨输入/);
});

test('API-only graph uses explicit source identity; no video or malformed graph stays safe', () => {
  assert.match(h3ReferenceTiming(document())[0].message, /节点 video/);
  assert.equal(h3ReferenceTiming(document())[0].video_ordinal, null);
  assert.deepEqual(h3ReferenceTimingText({ prompt: {} }), []); assert.deepEqual(h3ReferenceTiming(null), []);
  assert.deepEqual(h3ReferenceTiming({ prompt: { x: null } }), []);
  for (const value of [null, ['video', 1], ['missing', 0]]) {
    const doc = document(); doc.prompt.h3.inputs['ref_videos.ref_video_0'] = value;
    assert.equal(h3ReferenceTiming(doc)[0].estimate_status, 'unknown');
  }
  const doc = document(); doc.prompt.video.class_type = 'OtherVideoLoader';
  assert.equal(h3ReferenceTiming(doc)[0].estimate_status, 'unknown');
});
