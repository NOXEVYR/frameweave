import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorMediaPreview } from '../web/editor-media-preview.mjs';

class Element {
  constructor(tag) { Object.assign(this, { tagName: tag, children: [], style: {}, dataset: {}, attributes: new Map(), listeners: new Map(), textContent: '', operations: [], open: false }); }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { for (const child of this.children) child.parent = null; this.children = []; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; this.operations.push('remove'); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this._src = ''; this.operations.push(`remove:${name}`); }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  emit(name) { for (const handler of [...(this.listeners.get(name) || [])]) handler({ target: this }); }
  set src(value) { this._src = value; this.operations.push(`src:${value}`); }
  get src() { return this._src || ''; }
}
const flatten = element => [element, ...element.children.flatMap(flatten)];
const text = element => flatten(element).map(item => item.textContent).join(' ');
function fixture(onState) {
  const resources = [], container = new Element('div'), states = [];
  const document = new Element('#document'); document.hidden = false; document.visibilityState = 'visible';
  document.createElement = tag => {
    const element = new Element(tag);
    if (['img', 'video', 'audio'].includes(tag)) {
      resources.push(element);
      if (tag !== 'img') { element.pause = () => element.operations.push('pause'); element.load = () => element.operations.push('load'); element.play = () => { element.operations.push('play'); return Promise.resolve(); }; }
    }
    return element;
  };
  const preview = createEditorMediaPreview({ document, container, onState: state => { states.push(state); return onState?.(state); } });
  const show = (filename = 'reference.png', type = 'image', identity = 'graph:node:widget') => preview.show({ identity, type, filename, label: '场景参考', ordinal: 2 });
  return { preview, document, container, resources, states, show, media: () => resources.at(-1), live: () => flatten(container).filter(item => ['img', 'video', 'audio'].includes(item.tagName)) };
}

test('image remains pending until its real load event and current slot/name are visible as text', () => {
  const f = fixture(), state = f.show('人物 #1.png');
  assert.equal(state.status, 'pending'); assert.equal(f.preview.getState().status, 'pending');
  assert.match(text(f.container), /第 2 个槽 · 场景参考 · 图片预览.*正在加载图片预览.*人物 #1.png/);
  f.media().emit('loadedmetadata'); assert.equal(f.preview.getState().status, 'pending');
  f.media().emit('load'); assert.equal(f.preview.getState().status, 'ready');
  f.media().emit('load'); assert.equal(f.states.filter(state => state.status === 'ready').length, 1);
});

test('filename encoding always uses one same-origin input endpoint and normalized relative path', () => {
  const f = fixture(); f.show('角色\\分镜 A\\脸 #1?&+.png');
  const src = f.media().src, url = new URL(src, 'http://127.0.0.1:8188');
  assert(src.startsWith('/view?')); assert.equal(url.origin, 'http://127.0.0.1:8188'); assert.equal(url.pathname, '/view');
  assert.equal(url.searchParams.get('filename'), '脸 #1?&+.png'); assert.equal(url.searchParams.get('subfolder'), '角色/分镜 A'); assert.equal(url.searchParams.get('type'), 'input');
  assert.equal([...url.searchParams.keys()].length, 3); assert.equal(f.preview.getState().filename, '角色/分镜 A/脸 #1?&+.png');
});

test('safe 1024 character filename is allowed but larger input names never assign a resource', () => {
  const f = fixture(); assert.equal(f.show(`${'a'.repeat(1020)}.png`).status, 'pending');
  const count = f.resources.length; assert.equal(f.show(`${'a'.repeat(1021)}.png`).status, 'unsupported');
  assert.equal(f.resources.length, count); assert.equal(f.live().length, 0);
});

test('absolute, URL, traversal, encoded traversal, annotations and control paths cannot load', () => {
  const f = fixture();
  for (const filename of ['/image.png', '\\image.png', 'C:\\image.png', '//server/share/file.png', 'https://evil.test/a.png', 'file:///tmp/x', 'data:image/png;base64,abc', 'blob:fake', '../x.png', 'a/../x.png', './x.png', 'a/./x.png', 'a//x.png', 'a/', '%2e%2e/x.png', 'a%2fx.png', 'a\0.png', 'a\n.png', 'x.png [input]', 'x.png [output]', 'x.png [temp]', '']) {
    const state = f.show(filename); assert.equal(state.status, filename === '' ? 'empty' : 'unsupported', filename); assert.equal(f.live().length, 0);
  }
  assert.equal(f.resources.length, 0);
});

test('unknown type, missing name and invalid identity are explicit unsupported, without creating media', () => {
  const f = fixture();
  for (const input of [{identity:'i',type:'unknown',filename:'x.png'}, {identity:'i',type:'image'}, {identity:{node:1},type:'image',filename:'x.png'}, {identity:'',type:'image',filename:'x.png'}, {identity:'i',type:'image',filename:42}]) assert.equal(f.preview.show(input).status, 'unsupported');
  assert.equal(f.resources.length, 0); assert.equal(f.preview.show({identity:'i',type:'audio',filename:'',label:'配乐'}).status, 'empty');
});

test('late N load/error callbacks cannot overwrite a newly selected C preview', () => {
  const f = fixture(); f.show('N.png'); const old = f.media(), lateLoad = [...old.listeners.get('load')][0], lateError = [...old.listeners.get('error')][0];
  f.show('C.png'); lateLoad(); lateError(); old.emit('load');
  assert.equal(f.preview.getState().filename, 'C.png'); assert.equal(f.preview.getState().status, 'pending');
  f.media().emit('load'); assert.equal(f.preview.getState().status, 'ready');
  assert.equal(old.src, ''); assert.equal(old.listeners.get('load').size, 0); assert.equal(f.live().length, 1);
});

test('C to N to C with identical slot identity still gives each resource an independent generation', () => {
  const f = fixture(); const snapshots = [], callbacks = [];
  for (const filename of ['C.png','N.png','C.png']) { snapshots.push(f.show(filename)); callbacks.push([...f.media().listeners.get('load')][0]); }
  assert(new Set(snapshots.map(state => state.generation)).size === 3);
  callbacks[0](); callbacks[1](); assert.equal(f.preview.getState().status, 'pending');
  callbacks[2](); assert.equal(f.preview.getState().status, 'ready'); assert.equal(f.preview.getState().filename, 'C.png');
  assert.equal(f.live().length, 1);
});

test('video waits for loadeddata; audio waits for loadedmetadata; neither starts playback', () => {
  for (const type of ['video','audio']) {
    const f = fixture(); f.show(type === 'video' ? 'ref.webm' : 'music.wav', type); const media = f.media();
    assert.equal(media.controls, true); assert.equal(media.autoplay, false); assert.equal(media.preload, 'metadata'); assert(!media.operations.includes('play'));
    media.emit(type === 'video' ? 'loadedmetadata' : 'loadeddata'); assert.equal(f.preview.getState().status, 'pending');
    media.emit(type === 'video' ? 'loadeddata' : 'loadedmetadata'); assert.equal(f.preview.getState().status, 'ready');
    assert(!media.operations.includes('play')); assert.equal(type === 'video' ? media.playsInline : undefined, type === 'video' ? true : undefined);
  }
});

test('video metadata shows browser dimensions and finite duration without marking undecoded video ready', () => {
  const f=fixture(); f.show('reference.mp4','video'); const media=f.media();
  assert.match(text(f.container),/视频尺寸与时长尚未加载/);
  assert.equal(f.preview.getState().videoWidth,null); assert.equal(f.preview.getState().durationSeconds,null);
  Object.assign(media,{videoWidth:160,videoHeight:112,duration:1.2345,readyState:1}); media.emit('loadedmetadata');
  const state=f.preview.getState();
  assert.equal(state.status,'pending'); assert.equal(state.videoMetadataLoaded,true);
  assert.equal(state.videoWidth,160); assert.equal(state.videoHeight,112); assert.equal(state.durationSeconds,1.2345);
  assert.match(text(f.container),/160 × 112 像素 · 时长 1\.234 秒/);
  media.emit('loadeddata'); assert.equal(f.preview.getState().status,'ready');
  assert.equal(f.preview.getState().durationSeconds,1.2345); assert(!media.operations.includes('play'));
  state.videoWidth=999; state.durationSeconds=0; assert.equal(f.preview.getState().videoWidth,160);
  assert.equal(f.preview.getState().durationSeconds,1.2345);
});

test('unknown duration and undecoded dimensions stay unknown; a real finite zero is not mistaken for missing metadata', () => {
  for(const duration of [NaN,Infinity,-1,'2',undefined]) {
    const f=fixture(); f.show('reference.mp4','video'); Object.assign(f.media(),{videoWidth:0,videoHeight:0,duration});
    f.media().emit('loadedmetadata'); f.media().emit('loadeddata');
    assert.equal(f.preview.getState().durationSeconds,null); assert.match(text(f.container),/尺寸未知 · 时长未知/);
    assert.equal(f.preview.getState().status,'ready'); assert.doesNotMatch(text(f.container),/时长 0 秒/);
  }
  const f=fixture(); f.show('reference.mp4','video'); Object.assign(f.media(),{videoWidth:96,videoHeight:64,duration:0});
  f.media().emit('loadedmetadata'); assert.equal(f.preview.getState().durationSeconds,0); assert.match(text(f.container),/时长 0 秒/);
  f.media().duration=0.0001; f.media().emit('durationchange');
  assert.equal(f.preview.getState().durationSeconds,0.0001); assert.match(text(f.container),/时长不足 0\.001 秒/);
});

test('duration and resize events refresh only current available browser facts, including finite to unknown transitions', () => {
  const f=fixture(); f.show('reference.mp4','video'); const media=f.media();
  Object.assign(media,{videoWidth:640,videoHeight:480,duration:3,readyState:0}); media.emit('durationchange'); media.emit('resize');
  assert.equal(f.preview.getState().videoMetadataLoaded,false); assert.match(text(f.container),/尚未加载/);
  media.readyState=1; media.emit('durationchange'); assert.equal(f.preview.getState().status,'pending');
  assert.equal(f.preview.getState().durationSeconds,3); media.emit('loadeddata');
  Object.assign(media,{videoWidth:1280,videoHeight:720,duration:5.75}); media.emit('resize');
  assert.match(text(f.container),/1280 × 720 像素 · 时长 5\.75 秒/);
  media.duration=Infinity; media.emit('durationchange'); assert.match(text(f.container),/1280 × 720 像素 · 时长未知/);
  assert.equal(f.preview.getState().durationSeconds,null); assert.equal(f.preview.getState().status,'ready');
  const count=f.states.length; media.emit('durationchange'); assert.equal(f.states.length,count);
});

test('video failure drops old metadata and late metadata events cannot resurrect it', () => {
  const f=fixture(); f.show('failed.mp4','video'); const media=f.media();
  Object.assign(media,{videoWidth:320,videoHeight:180,duration:2}); media.emit('loadeddata');
  const late=[...media.listeners.get('loadedmetadata')][0]; media.emit('error'); late(); media.emit('durationchange');
  assert.equal(f.preview.getState().status,'failed'); assert.equal(f.preview.getState().videoWidth,null);
  assert.equal(f.preview.getState().durationSeconds,null); assert.match(text(f.container),/视频尺寸与时长不可用：预览加载失败/);
  assert.doesNotMatch(text(f.container),/320 × 180/);
  f.show('recovered.mp4','video'); assert.equal(f.preview.getState().durationSeconds,null); assert.match(text(f.container),/尚未加载/);
});

test('C to N to C video replacements cannot reuse old browser facts or captured event callbacks', () => {
  const f=fixture(),retired=[];
  for(const [index,name] of ['C.mp4','N.mp4','C.mp4'].entries()) {
    f.show(name,'video'); assert.equal(f.preview.getState().durationSeconds,null);
    for(const callbacks of retired) for(const callback of callbacks) callback();
    assert.equal(f.preview.getState().durationSeconds,null);
    const media=f.media(); Object.assign(media,{videoWidth:160+index,videoHeight:112,duration:index+1});
    media.emit('loadeddata'); assert.equal(f.preview.getState().durationSeconds,index+1);
    retired.push(['loadedmetadata','durationchange','resize'].map(name=>[...media.listeners.get(name)][0]));
  }
  assert.equal(f.preview.getState().filename,'C.mp4'); assert.equal(f.live().length,1);
  for(const media of f.resources.slice(0,-1)) {
    assert.equal(media.src,''); for(const name of ['loadedmetadata','durationchange','resize']) assert.equal(media.listeners.get(name).size,0);
  }
});

test('clear, unsupported selection and destroy reset video facts; a reopened preview starts without stale information', () => {
  const f=fixture(); f.show('old.mp4','video'); Object.assign(f.media(),{videoWidth:160,videoHeight:112,duration:2}); f.media().emit('loadeddata');
  f.preview.clear(); assert.equal(f.preview.getState().durationSeconds,null); assert.doesNotMatch(text(f.container),/160 × 112/);
  f.show('../bad.mp4','video'); assert.equal(f.preview.getState().status,'unsupported'); assert.equal(f.preview.getState().videoWidth,null);
  assert.doesNotMatch(text(f.container),/160 × 112/);
  f.preview.destroy(); assert.equal(f.document.listeners.get('visibilitychange').size,0);
  const reopened=createEditorMediaPreview({document:f.document,container:f.container});
  reopened.show({identity:'graph:node:widget',type:'video',filename:'old.mp4'});
  assert.equal(reopened.getState().durationSeconds,null); assert.match(text(f.container),/尚未加载/);
  assert.equal(f.document.listeners.get('visibilitychange').size,1); reopened.destroy();
});

for(const operation of ['clear','replace','destroy']) test(`metadata observer ${operation} invalidates old facts and late events`, () => {
  let preview,acted=false;
  const f=fixture(state=>{if(state.videoMetadataLoaded&&!acted){acted=true;if(operation==='replace')preview.show({identity:'new',type:'video',filename:'new.mp4'});else preview[operation]();}});
  preview=f.preview; f.show('old.mp4','video'); const old=f.media(); Object.assign(old,{videoWidth:160,videoHeight:112,duration:2});
  const late=[...old.listeners.get('durationchange')][0]; old.emit('loadedmetadata'); late();
  assert.equal(preview.getState().durationSeconds,null); assert.equal(old.src,''); assert(!old.operations.includes('play'));
  if(operation==='replace') {assert.equal(preview.getState().filename,'new.mp4'); assert.equal(preview.getState().status,'pending');}
  else assert.equal(preview.getState().status,'empty');
});

for(const type of ['video','audio']) test(`owning document hidden pauses current ${type}, visible keeps its slot without restarting playback`, () => {
  const f=fixture(); f.show(`reference.${type}`,type); const media=f.media();
  if(type==='video')Object.assign(media,{videoWidth:160,videoHeight:112,duration:2});
  media.emit(type==='video'?'loadeddata':'loadedmetadata'); const before=f.preview.getState(),src=media.src;
  f.document.hidden=true; f.document.visibilityState='hidden'; f.document.emit('visibilitychange');
  assert.equal(media.operations.filter(op=>op==='pause').length,1); assert.equal(media.src,src);
  assert.deepEqual(f.preview.getState(),before); assert.equal(f.live().length,1);
  const operations=[...media.operations]; f.document.hidden=false; f.document.visibilityState='visible'; f.document.emit('visibilitychange');
  assert.deepEqual(media.operations,operations); assert(!media.operations.includes('play'));
});

test('hidden visibility acts only on the latest resource and destroying removes the owning document listener', () => {
  const f=fixture(); f.show('old.mp4','video'); const old=f.media(),late=[...old.listeners.get('loadedmetadata')][0];
  const visibility=[...f.document.listeners.get('visibilitychange')][0]; f.show('current.wav','audio');
  const before=[...old.operations]; f.document.hidden=true; f.document.visibilityState='hidden'; f.document.emit('visibilitychange'); late();
  assert.deepEqual(old.operations,before); assert.equal(f.preview.getState().filename,'current.wav');
  assert.equal(f.media().operations.filter(op=>op==='pause').length,1);
  f.preview.destroy(); const released=[...f.media().operations]; visibility(); f.document.emit('visibilitychange');
  assert.deepEqual(f.media().operations,released); assert.equal(f.document.listeners.get('visibilitychange').size,0);
});

test('replacing video or audio pauses, removes src and resets decoder before removing old resource', () => {
  for (const type of ['video','audio']) {
    const f = fixture(); f.show('original.bin', type); const old = f.media(); f.show('new.png');
    assert.deepEqual(old.operations.slice(-4), ['pause','remove:src','load','remove']); assert.equal(old.src, ''); assert.equal(f.live().length, 1);
  }
});

test('error becomes failed and an obsolete ready event cannot report success afterward', () => {
  const f = fixture(); f.show(); f.media().emit('error'); assert.equal(f.preview.getState().status, 'failed');
  assert.match(f.preview.getState().message, /加载失败.*输入文件.*格式/);
  f.media().emit('load'); assert.equal(f.preview.getState().status, 'failed');
  f.show('recovered.png'); f.media().emit('load'); assert.equal(f.preview.getState().status, 'ready');
  f.media().emit('error'); assert.equal(f.preview.getState().status, 'failed');
});

test('clear invalidates late events, removes the only resource and retains an empty visible panel', () => {
  const f = fixture(); f.show('video.mp4','video'); const old=f.media(), late=[...old.listeners.get('loadeddata')][0];
  const generation=f.preview.getState().generation; f.preview.clear(); late();
  assert.equal(f.preview.getState().status,'empty'); assert(f.preview.getState().generation>generation); assert.equal(f.live().length,0);
  assert.match(text(f.container),/预览已清除；未修改参考槽/); assert.equal(f.container.children.length,1); assert.equal(old.src,'');
});

test('destroy releases resource and handlers, never revives on late events or later show calls', () => {
  const f=fixture(); f.show('music.wav','audio'); const old=f.media(),late=[...old.listeners.get('loadedmetadata')][0];
  f.preview.destroy(); late(); const count=f.resources.length, state=f.preview.getState();
  assert.equal(f.container.children.length,0); assert.equal(f.live().length,0); assert.equal(old.src,'');
  assert.deepEqual(f.preview.show({identity:'new',type:'image',filename:'x.png'}),state); f.preview.clear(); f.preview.destroy();
  assert.equal(f.resources.length,count); assert.equal(f.preview.getState().status,'empty');
});

test('collapsed panel pauses media without autoplay on expansion; clear button does not modify input', () => {
  const f=fixture(); f.show('music.wav','audio'); const details=flatten(f.container).find(item=>item.tagName==='details'), close=flatten(f.container).find(item=>item.tagName==='button');
  details.open=false; details.emit('toggle'); assert(f.media().operations.includes('pause'));
  details.open=true; details.emit('toggle'); assert(!f.media().operations.includes('play'));
  close.emit('click'); assert.equal(f.preview.getState().status,'empty'); assert.equal(f.live().length,0);
});

test('HTML-like labels remain text, state snapshots cannot mutate current state, and observer errors are contained', () => {
  const f=fixture(()=>{throw Error('display failure');}); const value={identity:'opaque',type:'image',filename:'x.png',label:'<img src=evil>',ordinal:3};
  const state=f.preview.show(value); state.status='ready'; state.filename='changed';
  assert.equal(f.preview.getState().status,'pending'); assert.equal(f.preview.getState().filename,'x.png'); assert.deepEqual(value,{identity:'opaque',type:'image',filename:'x.png',label:'<img src=evil>',ordinal:3});
  assert.match(text(f.container),/<img src=evil>/); assert.equal(f.live().length,1);
  f.media().emit('load'); assert.equal(f.preview.getState().status,'ready');
});

test('synchronous observer clear prevents even the discarded media src assignment', () => {
  let preview; const f=fixture(state=>{if(state.status==='pending') preview.clear();}); preview=f.preview;
  const state=f.show(); assert.equal(state.status,'empty'); assert.equal(f.media().src,''); assert.equal(f.live().length,0);
});

test('synchronous observer replacement preserves the newer resource and never starts discarded N', () => {
  let preview, replaced=false;
  const f=fixture(state=>{if(state.status==='pending'&&!replaced){replaced=true;preview.show({identity:'C-slot',type:'image',filename:'C.png',label:'当前输入'});}}); preview=f.preview;
  const state=f.show('N.png'); assert.equal(state.filename,'C.png'); assert.equal(state.identity,'C-slot'); assert.equal(f.resources.length,2);
  assert.equal(f.resources[0].src,''); assert.match(f.resources[1].src,/filename=C.png/); assert.equal(f.live().length,1);
  f.resources[0].emit('error'); f.resources[1].emit('load'); assert.equal(f.preview.getState().status,'ready');
});

test('synchronous observer destroy during pending prevents resource assignment and removes the panel', () => {
  let preview; const f=fixture(state=>{if(state.status==='pending') preview.destroy();}); preview=f.preview;
  const state=f.show('N.png'); assert.equal(state.status,'empty'); assert.equal(f.media().src,''); assert.equal(f.container.children.length,0); assert.equal(f.live().length,0);
});

test('repeated resources remain single across mixed image/video/audio and unsupported selections', () => {
  const f=fixture();
  for(let index=0;index<30;index++) { const type=['image','video','audio'][index%3]; f.show(`r${index}.bin`,type); assert.equal(f.live().length,1); }
  f.show('../bad.png'); assert.equal(f.live().length,0); assert(f.resources.every(item=>item===f.resources.at(-1)||!item.src));
});

test('factory rejects missing DOM ownership before doing any resource work', () => {
  assert.throws(()=>createEditorMediaPreview(),/document 和 container/);
  assert.throws(()=>createEditorMediaPreview({document:{createElement(){}},container:{}}),/document 和 container/);
});
