import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverNativeFrontendCapabilities, frontendStartupDependency, frontendStaticDependencies } from '../web/native-editor-frontend-capabilities.mjs';

const origin = 'http://127.0.0.1:19200', entry = `${origin}/assets/index-test.js`;
const entrySource = 'const __vite__mapDeps=(i)=>i;import "./boot-test.js";(function(){return 1})(),await boot(()=>import(`./main-test.js`),__vite__mapDeps([0,1]),import.meta.url);';
function fixture() {
  const app = {}, pinia = {}, calls = [], imported = [], bodies = new Map([
    [entry, entrySource], [`${origin}/assets/main-test.js`, 'import { a as app } from "./settingStore-test.js";doMain();'],
    [`${origin}/assets/settingStore-test.js`, 'import { a as nextTick } from "./vendor-vue-core-test.js";doStore();']]);
  const store = { $id: 'previewExposure' };
  for (const name of ['$onAction','getExposures','setExposures','addExposure','removeExposure','clearGraph','resolveChain','getExposuresAsPromotionShape']) store[name] = () => calls.push(name);
  const factory = Object.assign(p => { assert.equal(p,pinia); return store; }, { $id:'previewExposure' });
  const namespace = { changedAppAlias:app, changedFactoryAlias:factory }, vue = {
    differentTick: function nextTick(){return Promise.resolve();}, differentPinia:function getActivePinia(){return pinia;}};
  const scripts = [{src:entry}], options = { app, document:{querySelectorAll:()=>scripts}, location:{origin,href:origin+'/'},
    fetch:async url=>{calls.push(url);return new Response(bodies.get(url),{headers:{'Content-Type':'text/javascript'}});},
    importModule:async url=>{imported.push(url);return url.includes('settingStore-')?namespace:vue;} };
  return {options,store,calls,imported,bodies,namespace,vue,scripts};
}
test('official dependency chain resolves semantic capabilities despite changed aliases, without writes',async()=>{
  const f=fixture(),cap=await discoverNativeFrontendCapabilities(f.options);
  assert.equal(cap.supported,true);assert.equal(cap.exposureStore,f.store);assert.equal(cap.isCurrent(),true);
  assert.deepEqual(f.imported,[origin+'/assets/settingStore-test.js',origin+'/assets/vendor-vue-core-test.js']);
  assert.equal(f.calls.filter(value=>!value.startsWith(origin)).length,0);
  f.store.setExposures=()=>{};assert.equal(cap.isCurrent(),false);
});
for(const [name,change] of [
  ['no entry',f=>f.scripts.length=0],['query entry',f=>f.scripts[0].src+='?redirect=1'],
  ['foreign entry',f=>f.scripts[0].src='https://elsewhere.invalid/assets/index-test.js'],
  ['multiple entries',f=>f.scripts.push({src:origin+'/assets/index-other.js'})],
  ['comment startup',f=>f.bodies.set(entry,'/*'+entrySource+'*/')],
  ['string startup',f=>f.bodies.set(entry,JSON.stringify(entrySource))],
  ['unknown startup',f=>f.bodies.set(entry,'const value="./main-test.js";')],
  ['traversal dependency',f=>f.bodies.set(origin+'/assets/main-test.js','import { a } from "./nested/../settingStore-test.js";run();')],
  ['lazy dependency',f=>f.bodies.set(origin+'/assets/main-test.js','run();import("./settingStore-test.js");')],
  ['comment dependency',f=>f.bodies.set(origin+'/assets/main-test.js','/* import { a } from "./settingStore-test.js"; */run();')],
  ['ambiguous dependency',f=>f.bodies.set(origin+'/assets/main-test.js','import { a } from "./settingStore-a.js";import { b } from "./settingStore-b.js";run();')],
  ['foreign app',f=>f.namespace.changedAppAlias={}],
  ['duplicate factory',f=>f.namespace.second=Object.assign(()=>({}),{$id:'previewExposure'})],
  ['no pinia',f=>f.vue.differentPinia=function getActivePinia(){}],
  ['missing public tick',f=>delete f.vue.differentTick],
  ['wrong store',f=>f.store.$id='other'],['missing store action',f=>delete f.store.$onAction],
  ['aborted',f=>f.options.signal={aborted:true}],
  ['bad MIME',f=>f.options.fetch=async()=>new Response(entrySource,{headers:{'Content-Type':'text/html'}})],
  ['false small Content-Length',f=>f.options.fetch=async()=>new Response('x'.repeat(8*1024*1024+1),{headers:{'Content-Type':'text/javascript','Content-Length':'1'}})],
]) test(`${name} remains unsupported with no exposure writes`,async()=>{
  const f=fixture();change(f);const result=await discoverNativeFrontendCapabilities(f.options);
  assert.equal(result.supported,false);assert.equal(result.reason,'nested_preview_exposure_unsupported');assert.ok(!f.calls.includes('setExposures'));
});
test('profile only consumes real leading static imports, not strings or later lazy imports',()=>{
  assert.deepEqual(frontendStaticDependencies('import { a as b } from "./a.js";const s="from ./b.js";import("./c.js");'),['./a.js']);
  assert.equal(frontendStartupDependency(entrySource),'./main-test.js');
});
