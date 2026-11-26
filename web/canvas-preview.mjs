// Project cards use an existing local image when available. The graph below
// stays visible when that image is missing, or when inference is offline.
const imageRoute = /^\/api\/(?:assets\/media\/[a-f0-9]{64}|media\/[a-f0-9]{32})$/;
const types = {
  prompt: ['文本', '#fae3d7', '#69432f'], generation: ['生成', '#d5ddff', '#344789'],
  reference: ['素材', '#e6e9fd', '#454d83'], result: ['结果', '#dfeafb', '#344d7e'],
};
export function previewFromGraph(graph) {
  if (!Array.isArray(graph?.nodes)) return null;
  const candidates = [];
  let excerpt='';
  const nodes = [];
  for (const node of graph.nodes) {
    const data = node?.data || {};
    if (!excerpt && node?.type==='prompt' && typeof data.text==='string') excerpt=data.text.trim().slice(0,80).replace(/\s+/g,' ');
    if (node?.type === 'result' && Array.isArray(data.outputs)) {
      for (const out of data.outputs) if (out?.type === 'image' && imageRoute.test(out.url)) candidates.push([0,out.url]);
    }
    if (node?.type === 'reference' && data.mediaType === 'image' && imageRoute.test(data.url)) candidates.push([1,data.url]);
    if (nodes.length < 32 && typeof node?.id === 'string' && Number.isFinite(node.x) && Number.isFinite(node.y)) {
      nodes.push({id:node.id,x:node.x,y:node.y,type:node.type,title:String(data.title || '').slice(0,36)});
    }
  }
  const ids = new Set(nodes.map(n=>n.id));
  const edges = (graph.edges || []).filter(e=>ids.has(e?.source) && ids.has(e?.target)).slice(0,96).map(e=>[e.source,e.target]);
  return { nodes, edges, count:graph.nodes.length,excerpt, image:candidates.sort((a,b)=>a[0]-b[0])[0]?.[1] || '' };
}
function drawGraph(canvas, preview) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = 720, height = 300;
  canvas.width = width; canvas.height = height;
  const nodes = preview.nodes;
  const xs = nodes.map(n=>n.x), ys = nodes.map(n=>n.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const dx = Math.max(...xs)-minX, dy = Math.max(...ys)-minY;
  const scale = Math.min((width-74)/(dx+265),(height-52)/(dy+108),1.45);
  const w = 265*scale, h = 108*scale;
  const ox = (width - (dx+265)*scale)/2, oy = (height - (dy+108)*scale)/2;
  const xy = new Map(nodes.map(n=>[n.id,[ox+(n.x-minX)*scale,oy+(n.y-minY)*scale]]));
  ctx.strokeStyle='#8095ce'; ctx.lineWidth=3.5;
  for (const [source,target] of preview.edges || []) {
    if (!xy.has(source) || !xy.has(target)) continue;
    const [sx,sy]=xy.get(source), [ex,ey]=xy.get(target), x=sx+w, y=sy+h*.57, ty=ey+h*.57;
    const bend=Math.max(15,Math.abs(ex-x)*.45);
    ctx.beginPath();ctx.moveTo(x,y);ctx.bezierCurveTo(x+bend,y,ex-bend,ty,ex,ty);ctx.stroke();
  }
  for (const node of nodes) {
    const [x,y]=xy.get(node.id), [label,top,ink]=types[node.type] || ['节点','#e8ecf8','#344789'];
    ctx.save(); ctx.translate(x,y); ctx.scale(scale,scale);
    ctx.shadowColor='#2539673b';ctx.shadowBlur=9;ctx.shadowOffsetY=4;
    ctx.fillStyle='#ffffff';ctx.beginPath();ctx.roundRect(0,0,265,108,14);ctx.fill();
    ctx.shadowBlur=0;ctx.shadowOffsetY=0;ctx.beginPath();ctx.roundRect(0,0,265,108,14);ctx.clip();
    ctx.fillStyle=top;ctx.fillRect(0,0,265,44);
    ctx.fillStyle=ink;ctx.font='600 21px "Microsoft YaHei",sans-serif';ctx.fillText(label,15,30);
    const title=node.title || label;
    ctx.fillStyle='#1c284c';ctx.font='600 23px "Microsoft YaHei",sans-serif';
    const characters=Array.from(title);
    while (characters.length>1 && ctx.measureText(characters.join('')+'…').width>235) characters.pop();
    ctx.fillText(characters.join('')+(characters.length<Array.from(title).length?'…':''),15,82);
    ctx.restore();
  }
}
export function renderCanvasPreview(preview) {
  const root=document.createElement('div'); root.className='canvas-cover';
  if (!preview || !Array.isArray(preview.nodes) || !preview.nodes.length) {
    const sheet=document.createElement('span'); sheet.className='canvas-cover-sheet'; sheet.setAttribute('aria-hidden','true');
    const caption=document.createElement('span'); caption.className='canvas-cover-caption';
    caption.textContent=preview?.count === 0 ? '空白画布' : '暂无预览'; root.append(sheet,caption);
  } else {
    const canvas=document.createElement('canvas');canvas.setAttribute('role','img');
    canvas.setAttribute('aria-label',`画布结构，${preview.count} 个节点`); root.append(canvas);drawGraph(canvas,preview);
  }
  if (preview?.nodes?.length && preview.excerpt) {
    root.classList.add('has-excerpt');
    const excerpt=document.createElement('span');excerpt.className='canvas-cover-excerpt';excerpt.textContent=preview.excerpt;
    root.append(excerpt);
  }
  if (imageRoute.test(preview?.image || '')) {
    const image=document.createElement('img');
    image.loading='lazy';image.decoding='async';image.alt='画布中的图片';image.className='canvas-cover-image';
    image.addEventListener('load',()=>image.classList.add('is-ready'),{once:true});
    image.addEventListener('error',()=>image.remove(),{once:true});
    image.src=preview.image;root.append(image);
  }
  return root;
}
