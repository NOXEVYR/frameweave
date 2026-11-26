import { previewFromGraph } from './canvas-preview.mjs';

const validId = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export function projectOf(document, recordId) {
  return validId(document?.project_id) ? document.project_id : recordId;
}
// Editor identities protect live jobs. Document identities survive a reopen and
// associate immutable versions, including the first legacy record, with one card.
export function createProjectLinks(storage) {
  const key = 'prismcanvas.home.project-link.v1';
  const links = new Map();
  try {
    const item=JSON.parse(storage.getItem(key));
    if (typeof item?.identity==='string' && validId(item.projectId)) links.set(item.identity,item.projectId);
  } catch { /* Existing draft remains usable when optional metadata is unavailable. */ }
  return {
    get(identity) {
      const fallback=String(identity || '').replaceAll('-','');
      return links.get(identity) || (validId(fallback) ? fallback : null);
    },
    bind(identity,projectId) {
      if (!identity || !validId(projectId)) return;
      links.set(identity,projectId);
      try { storage.setItem(key,JSON.stringify({identity,projectId})); } catch { /* Keep the in-memory binding. */ }
    },
  };
}
export function createProjectCatalog(api) {
  async function rows() {
    const result=[]; const seen=new Set(); let offset=0, unreadable=0, incomplete=0;
    do {
      const page=await api(`/api/canvases?gallery=1&offset=${offset}&limit=200`);
      if (!Array.isArray(page?.canvases) || page.offset!==offset) throw new Error('无法读取本机画布列表');
      // A running 0.11.5 service only returns basic summaries. Read missing
      // covers two at a time and keep only their compact representations.
      unreadable=Math.max(unreadable,Number.isSafeInteger(page.unreadable) ? page.unreadable : 0);
      const batch=page.canvases;
      for (let index=0;index<batch.length;index+=2) {
        const items=await Promise.all(batch.slice(index,index+2).map(async raw=>{
          if (!validId(raw?.id) || seen.has(raw.id)) return null;
          seen.add(raw.id);
          let preview=raw.preview, projectId=raw.project_id;
          if (!validId(projectId) || !preview) {
            try {
              const record=await api('/api/canvases/'+raw.id);
              projectId=projectOf(record.document,raw.id);
              preview=previewFromGraph(record.document?.canvas);
            } catch {
              incomplete++; projectId=raw.id; preview=null;
            }
          }
          return {id:raw.id,projectId,name:raw.name,updatedAt:raw.created_at,nodeCount:raw.nodes,preview};
        }));
        result.push(...items.filter(Boolean));
      }
      const next=page.next_offset;
      if (next==null) break;
      if (!Number.isSafeInteger(next) || next<=offset || !batch.length) throw new Error('画布列表分页无效');
      offset=next;
    } while (true);
    return {versions:result.sort((a,b)=>b.updatedAt-a.updatedAt || b.id.localeCompare(a.id)),unreadable:unreadable+incomplete};
  }
  return {
    async list() {
      const projects=new Map();
      const {versions,unreadable}=await rows();
      for (const row of versions) if (!projects.has(row.projectId)) projects.set(row.projectId,{...row,id:row.projectId,latestId:row.id});
      return {projects:[...projects.values()],unreadable};
    },
    async history(projectId) {
      const {versions,unreadable}=await rows();
      return {versions:versions.filter(row=>row.projectId===projectId),unreadable};
    },
  };
}
