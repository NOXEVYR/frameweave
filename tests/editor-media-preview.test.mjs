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
  const document = { createElement(tag) {
    const element = new Element(tag);
    if (['img', 'video', 'audio'].includes(tag)) {
      resources.push(element);
      if (tag !== 'img') { element.pause = () => element.operations.push('pause'); element.load = () => element.operations.push('load'); element.play = () => { element.operations.push('play'); return Promise.resolve(); }; }
    }
    return element;
  } };
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
