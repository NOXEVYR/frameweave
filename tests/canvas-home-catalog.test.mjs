import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectCatalog, createProjectLinks } from '../web/canvas-project-catalog.mjs';
import { previewFromGraph } from '../web/canvas-preview.mjs';
const a='a'.repeat(32), b='b'.repeat(32), c='c'.repeat(32);
const graph = {nodes:[{id:'one',type:'reference',x:0,y:0,data:{title:'实物',mediaType:'image',url:'/api/assets/media/'+'d'.repeat(64)}},{id:'two',type:'result',x:400,y:29,data:{outputs:[{type:'image',url:'/api/media/'+c}]}}],edges:[{source:'one',target:'two'}]};
const records=[{id:a,created_at:1,nodes:2,name:'同名'},{id:b,created_at:2,nodes:2,name:'同名'},{id:c,created_at:3,nodes:2,name:'改名之后'}];
for (const legacy of [true,false]) test('project lineage and thumbnail with '+(legacy?'preceding service':'current service'), async()=>{
  const calls=[];
  const api=async path=>{
    calls.push(path);
    if (path.includes('?')) return {offset:0,next_offset:null,canvases:records.map(r=>legacy?r:{...r,project_id:r.id===c?a:r.id,preview:previewFromGraph(graph)})};
    const row=records.find(r=>path.endsWith(r.id));
    return {id:row.id,document:{canvas:graph,...(row.id===c?{project_id:a}:{})}};
  };
  const catalog=createProjectCatalog(api);
  const {projects:list}=await catalog.list();
  assert.deepEqual(list.map(r=>[r.id,r.latestId,r.name]),[[a,c,'改名之后'],[b,b,'同名']]);
  assert.deepEqual((await catalog.history(a)).versions.map(r=>r.id),[c,a]);
  assert.equal(calls.filter(p=>!p.includes('?')).length,legacy?6:0);
  assert.equal(list[0].preview.image,'/api/media/'+c);
});
test('a missing image falls back to the real topology, then to an empty canvas',()=>{
  const data=structuredClone(graph);data.nodes[1].data.outputs[0].url='https://example.com/image.png';
  assert.equal(previewFromGraph(data).image,data.nodes[0].data.url);
  data.nodes[0].data.url='file:///not-a-cover';
  assert.deepEqual(previewFromGraph(data).edges,[['one','two']]);
  assert.equal(previewFromGraph(data).image,'');
  assert.equal(previewFromGraph({nodes:[],edges:[]}).count,0);
});
test('reload keeps the exact logical project without deriving it from its name',()=>{
  const cache=new Map(), storage={getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)};
  const links=createProjectLinks(storage);links.bind(b,a);assert.equal(createProjectLinks(storage).get(b),a);
  assert.equal(links.get(c),c);
});
