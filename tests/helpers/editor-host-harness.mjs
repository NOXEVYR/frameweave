import { createPackageCatalog } from '../../web/package-catalog.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createNode, stableStringify } from '../../web/graph.mjs';
import { createMediaTransfers } from '../../web/media-transfers.mjs';
import { createNodeActionPress } from '../../web/node-action-press.mjs';
import { editorPreparationBackend, captureEditorPreparationTarget, assertEditorPreparationTarget, projectEditorInputs } from '../../web/editor-preparation.mjs';
import { collectPresetEditRequest } from '../../web/preset-edit-request.mjs';
import { preparePresetEditGraph } from '../../web/preset-edit-graph.mjs';
import { applyEditorInterfaceGraph } from '../../web/editor-canvas-interface.mjs';
import { stageEditorMediaSync } from '../../web/editor-media-sync.mjs';

const source = await readFile(new URL('../../web/app.js', import.meta.url), 'utf8');
const hostCode = source.slice(source.indexOf('const nativeSyncTargets ='), source.indexOf('async function completeInterfaceInputs('));
const backendCode = source.slice(source.indexOf('async function ensureWorkflowBackend('), source.indexOf('async function prepareWorkflowBackend('));
const entryCode = source.slice(source.indexOf('async function openNodeWorkflow('), source.indexOf('function renderInspector('));
// The browser imports app and helpers into one realm. VM app spread literals
// need that same plain-JSON prototype here, without cloning identity witnesses.
function sameRealmJSON(value) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') return;
  Object.setPrototypeOf(value, Array.isArray(value) ? Array.prototype : Object.prototype);
  for (const child of Object.values(value)) sameRealmJSON(child);
}
export const BACKEND = 'http://127.0.0.1:8188', OTHER = 'http://127.0.0.1:8189';
export const field = (id, type = 'text') => ({id,node_id:'12',input:id,label:id,type});
export const makeNode = (id, type, data = {}) => ({...createNode(type,0,0,data),id});
export function hostHarness({fields = [field('prompt')], values = {prompt:'fallback'}, kind = 'package', bound = false} = {}) {
  const prompt = {'12':{class_type:'RealClass',inputs:{prompt:'source',image:''},_meta:{title:'Keep this'},properties:{plugin:true}},
    unfinished:{class_type:'FutureClass',inputs:{unknown:['missing',0]},extra:{keep:[1,false]}}};
  const node = makeNode('target','generation',{kind,packageValues:values,editor_baseline:{prompt:'original'},
    packageFields:fields.map(({id,type,label})=>({id,type,label})),...(kind==='package'?{package_id:'pack'}:{apiPrompt:prompt}),
    ...(bound?{editor_id:'native',editor_backend:BACKEND}:{})});
  const state = {identity:'canvas',fields,prompt,node,calls:[],opened:[],bind:null,session:null,nextBackend:null};
  const sandbox = {graph:{nodes:[node],edges:[]},settings:{backend_url:BACKEND},packages:[],referenceImports:new Map(),
    packageMediaTransfers:createMediaTransfers(),currentCanvasIdentity:()=>state.identity,stableStringify,clone:structuredClone,
    editorPreparationBackend,captureEditorPreparationTarget,assertEditorPreparationTarget,projectEditorInputs,createNodeActionPress,
    stageEditorMediaSync(...args){args.forEach(sameRealmJSON);return stageEditorMediaSync(...args);},
    document:{querySelectorAll:()=>[]},renderNodes(){},renderInspector(){},
    collectPresetEditRequest(...args){args.forEach(sameRealmJSON);return collectPresetEditRequest(...args);},
    preparePresetEditGraph(...args){args.forEach(sameRealmJSON);return preparePresetEditGraph(...args);},
    applyEditorInterfaceGraph(...args){args.forEach(sameRealmJSON);return applyEditorInterfaceGraph(...args);},
    getNode:id=>sandbox.graph.nodes.find(n=>n.id===id),mutate:fn=>{fn();sameRealmJSON(sandbox.graph);},toast(){},downloadJSON(){},copyText(){},
    resolveEditorConflicts(){},configureNativeInterface(){},createNativeWorkflowEditor(host){
      state.host=host;
      return {async open(actual){state.opened.push(actual);if(state.onOpen)await state.onOpen(actual);},
        async openApiPrompt(actual,baseline,bind){
          state.opened.push(actual);state.baseline=structuredClone(baseline);state.bind=bind;
          if(state.onOpenApi)return state.onOpenApi(actual,baseline,bind);
          await host.ensureBackend(actual);await host.ensureInstance(actual);
          state.session=await host.prepareSession(actual,{id:actual.data.editor_id,revision:7});
        }};
    },chooseWorkflowBackend:async()=>state.nextBackend||sandbox.settings.backend_url,
    async useBackend(url){if(state.onSwitch)await state.onSwitch(url);sandbox.settings.backend_url=url;},
    async api(path,payload){
      state.calls.push({path,payload:payload&&structuredClone(payload)});
      if(state.onApi){const result=await state.onApi(path,payload);if(result!==undefined)return result;}
      if(path==='/api/engines')return {profiles:[{base_url:BACKEND,online:true},{base_url:OTHER,online:true}]};
      if(path==='/api/status')return {backend_url:sandbox.settings.backend_url};
      if(path==='/api/packages/pack')return {package:{id:'pack',name:'Package',fields:state.fields,prompt:state.prompt}};
      if(path.endsWith('/backends'))return {current:sandbox.settings.backend_url};
      if(path==='/api/editor-workflows')return {id:'created'};
      if(path.startsWith('/api/editor-workflows/'))return {id:path.split('/').at(-1),name:'Draft',source_json:'{}'};
      if(path==='/api/editor-prepare'){
        const document=payload.package_id?{prompt:state.prompt,metadata:{preserved:true}}:payload.document;
        const output=structuredClone(document.prompt||document), accepted=[], pending=[...(payload.pending||[])];
        const available=payload.package_id?state.fields:payload.fields||[];
        for(const item of payload.overrides||[]){
          const mapping=available.find(f=>f.id===item.field_id);
          if(!mapping){pending.push({...item,reason:'mapping_unavailable'});continue;}
          output[mapping.node_id].inputs[mapping.input]=item.value;
          accepted.push({...item,class_type:'CallerForgedClass',type:'CallerForgedType'});
        }
        return {backend_url:sandbox.settings.backend_url,source_revision:payload.package_id||null,source_document:structuredClone(document),prompt:output,overrides:accepted,pending};
      }
      throw new Error(`Unexpected route: ${path}`);
    },assertCanvasMediaReady(){throw new Error('must not inspect execution readiness');},
    prepareCanvasImages(){throw new Error('must not upload for editing');},
    prepareWorkflowBackend(){throw new Error('must not inspect upstream backend');},
    generationPayload(){throw new Error('must not build execution request');},openPackages(){state.library=true;}};
  sandbox.packageCatalog = createPackageCatalog({ api: (...args) => sandbox.api(...args) });
  sandbox.ensurePackageDefinition = id => sandbox.packageCatalog.ensure(id);
  sandbox.rememberPackageDefinition = pack => { const full = sandbox.packageCatalog.remember(pack); sandbox.packages = sandbox.packageCatalog.summaries(); return full; };
  vm.runInNewContext(hostCode+backendCode+entryCode,sandbox);
  return {sandbox,state,node};
}
