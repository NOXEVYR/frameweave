import { parseGraph, serializeGraph } from './graph.mjs';
import { frameDialog } from './workspace-tools.mjs';

/** Reusable settings are local canvas snapshots, independent of job history. */
export function configurationBundle(bundle, nodeId, name) {
  const source = parseGraph(bundle.canvas);
  const node = source.nodes.find(item => item.id === nodeId);
  if (!node || node.type !== 'generation' || node.data.kind !== 'package' || !node.data.package_id) throw new Error('请先建立外层参数，再保存配置');
  const copy = structuredClone(node);
  const pack = bundle.packages.find(item => item.id === copy.data.package_id);
  const editor = (bundle.editors || []).find(item => item.id === copy.data.editor_id);
  if (!pack || copy.data.editor_id && !editor) throw new Error('配置缺少工作流定义，原画布未更改');
  // Prompt wires have stable text values. Media and upstream generation outputs
  // are deliberately not captured as reusable file references.
  for (const edge of source.edges.filter(item => item.target === nodeId)) {
    const parent = source.nodes.find(item => item.id === edge.source);
    const field = (copy.data.packageFields || []).find(item => item.id === edge.targetField);
    if (parent?.type === 'prompt' && field?.type === 'text') {
      const value = parent.data[edge.sourceField || 'text'];
      if (typeof value !== 'string' || value.length > 64000) throw new Error('连接的提示词超出工作流字段允许的文本范围');
      copy.data.packageValues[field.id] = value;
    }
  }
  for (const field of copy.data.packageFields || []) if (['image', 'audio'].includes(field.type)) copy.data.packageValues[field.id] = '';
  copy.data.packageMediaBackends = {};
  copy.data.title = name; copy.x = 80; copy.y = 80;
  return {schema:'prismcanvas.project.v1', version:1, name, configuration:true,
    canvas:JSON.parse(serializeGraph({nodes:[copy],edges:[]},{x:30,y:30,scale:1})),
    packages:[structuredClone(pack)], editors:editor ? [structuredClone(editor)] : []};
}

export function configuredNodes(bundle) {
  if (bundle?.schema !== 'prismcanvas.project.v1' || bundle.version !== 1) throw new Error('配置记录格式无效');
  return parseGraph(bundle.canvas).nodes.filter(node => node.type === 'generation' && node.data.kind === 'package' && node.data.package_id);
}

export function createWorkflowConfigurations(host) {
  const el = (tag, text = '') => {const item = document.createElement(tag); item.textContent = text; return item;};
  function openDialog(title) {
    const dialog = el('dialog'); dialog.className = 'modal workflow-configurations-dialog'; dialog.setAttribute('aria-label',title);
    const heading = el('div'); heading.className = 'modal-heading';
    const close = el('button','×'); close.className='close-button'; close.setAttribute('aria-label','关闭'); close.onclick=()=>dialog.close();
    heading.append(el('h2',title),close); dialog.append(heading); document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true}); return dialog;
  }
  async function save(node) {
    const bundle = await host.bundle();
    const dialog = openDialog('保存工作流配置');
    const label=el('label','配置名称'); label.className='field';
    const name=el('input');name.value=node.data.title;name.maxLength=120;name.setAttribute('aria-label','配置名称');label.append(name);
    const note=el('p','保存外层参数、输入定义和完整内部工作流，不依赖生成队列。图片、音频与外部连线不随配置保存，下次重新上传或连接。');note.className='form-note';
    const status=el('p');status.className='form-note';status.setAttribute('role','status');
    const button=el('button','保存为新配置');button.className='button primary';
    button.onclick=async()=>{
      button.disabled=true;
      try {const title=name.value.trim();if(!title)throw new Error('请填写配置名称');
        await host.api('/api/canvases',{document:configurationBundle(bundle,node.id,title)});dialog.close();host.toast('配置已保存，可从“我的工作流配置”直接复用');
      } catch(error){status.textContent=error.message;} finally {button.disabled=false;}
    };
    dialog.append(label,note,status,button);frameDialog(dialog);dialog.showModal();
  }
  async function choose(target = null) {
    const dialog = openDialog('我的工作流配置');
    const note=el('p',target ? '选择已保存配置替换当前未配置节点。使用的是该配置的完整工作流，原导入文件仍保留在本机。已有连线时会添加为新节点。' : '选择已保存配置或画布中的工作流，添加到当前画布。无需从生成队列恢复。'); note.className='form-note';
    const search=el('input');search.type='search';search.placeholder='搜索配置或画布名称';search.setAttribute('aria-label','搜索工作流配置');
    const status=el('p','正在读取本地配置…');status.setAttribute('role','status');
    const list=el('div');list.className='workspace-library-list';
    dialog.append(note,search,status,list);frameDialog(dialog);dialog.showModal();
    try {
      const response=await host.api('/api/canvases');if(!dialog.isConnected)return;
      status.textContent='配置和画布按保存时间排列；仅载入参数，不启动生成。';
      function render(){
        list.replaceChildren();
        const rows=response.canvases.filter(item=>item.name.toLowerCase().includes(search.value.toLowerCase()));
        if(!rows.length)list.append(el('p','暂无已保存配置。先建立外层参数，再点“保存此工作流配置”；已有“我的画布”记录也会出现在这里。'));
        for(const item of rows){
          const row=el('div');row.className='workflow-configuration-row';
          const title=el('strong',item.name), detail=el('p',new Date(item.created_at*1000).toLocaleString());detail.className='field-help';
          const inspect=el('button','查看可复用工作流');inspect.className='button quiet';
          const children=el('div');children.className='configuration-choices';
          inspect.onclick=async()=>{
            inspect.disabled=true;
            try {const stored=await host.api(`/api/canvases/${item.id}`);const nodes=configuredNodes(stored.document);children.replaceChildren();
              if(!nodes.length)children.append(el('p','此记录只有未配置的原生节点，需先提取并保存外层参数。'));
              for(const node of nodes){
                const pick=el('button',`使用配置 · ${node.data.title}（${node.data.packageFields?.length||0} 项参数）`);pick.className='button primary';
                pick.onclick=async()=>{pick.disabled=true;try{
                  await host.install(configurationBundle(stored.document,node.id,node.data.title),target);dialog.close();
                }catch(error){status.textContent=error.message;}finally{pick.disabled=false;}};children.append(pick);
              }
            }catch(error){status.textContent=error.message;}finally{inspect.disabled=false;}
          };
          row.append(title,detail,inspect,children);list.append(row);
        }
      }
      search.oninput=render;render();
    }catch(error){status.textContent=error.message;}
  }
  return {save,choose};
}
