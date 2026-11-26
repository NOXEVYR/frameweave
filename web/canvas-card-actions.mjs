// Display preferences belong to the local workspace. Renaming and copying save real canvas versions.
const prefix = 'prismcanvas.gallery.v1.';
const element = (tag, text) => { const node=document.createElement(tag); if(text!==undefined)node.textContent=text;return node; };
export function getCardPreferences(id) {
  if(!id) return {};
  try { return JSON.parse(localStorage.getItem(prefix+id) || '{}') || {}; } catch { return {}; }
}
function setPreference(id, change) {
  if(!id) throw new Error('请先保存画布');
  try { localStorage.setItem(prefix+id,JSON.stringify({...getCardPreferences(id),...change})); }
  catch { throw new Error('本地设置空间不足或不可写，当前设置已保留'); }
}
async function readCover(file) {
  if(!file || !['image/png','image/jpeg','image/webp'].includes(file.type) || file.size>16*1024*1024)
    throw new Error('请选择 16 MiB 以内的 PNG、JPEG 或 WebP 图片');
  const image=await createImageBitmap(file);
  try {
    const canvas=element('canvas');canvas.width=640;canvas.height=400;
    const ctx=canvas.getContext('2d'),scale=Math.max(640/image.width,400/image.height);
    ctx.drawImage(image,(640-image.width*scale)/2,(400-image.height*scale)/2,image.width*scale,image.height*scale);
    return canvas.toDataURL('image/webp',.76);
  } finally { image.close(); }
}
function ask(title,value,{folders=[],acceptFile=false,confirmLabel='保存'}={}) {
  const dialog=element('dialog');dialog.className='modal card-action-dialog';dialog.setAttribute('aria-label',title);
  const form=element('form'),heading=element('h2',title),input=element('input'),buttons=element('div');
  const cancel=element('button','取消'),confirm=element('button',confirmLabel);
  cancel.type='button';confirm.type='submit';confirm.className='button primary';cancel.className='button quiet';
  input.setAttribute('aria-label',title);buttons.className='modal-actions';
  if(acceptFile){input.type='file';input.accept='image/png,image/jpeg,image/webp';input.required=true;}
  else {input.type='text';input.maxLength=120;input.value=value;input.autocomplete='off';}
  form.append(heading,input);
  if(folders.length){
    const choices=element('datalist');choices.id='canvas-card-folders';
    for(const folder of folders){const opt=element('option');opt.value=folder;choices.append(opt);}
    input.setAttribute('list',choices.id);form.append(choices);
  }
  buttons.append(cancel,confirm);form.append(buttons);dialog.append(form);document.body.append(dialog);
  return new Promise(resolve=>{
    let result=null; let composing=false;
    input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;});
    cancel.addEventListener('click',()=>{if(!composing)dialog.close();});
    dialog.addEventListener('cancel',event=>{if(composing)event.preventDefault();});
    form.addEventListener('submit',e=>{e.preventDefault();if(composing)return;result=acceptFile?input.files[0]:input.value.trim();dialog.close();});
    dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});
    dialog.showModal();input.focus();if(!acceptFile)input.select();
  });
}

export function createCardActions({host,refresh:refreshProjects,folders,onBusyChange=()=>{}}) {
  let active=null,working=false,workSequence=0;
  // The write finishes before the refresh publishes enabled replacement cards.
  // Each completion belongs to one action; it cannot release a newer write.
  const refresh=async()=>{working=false;onBusyChange();await refreshProjects();};
  function close(restore=false){
    if(!active)return;
    const {menu,trigger,outside,escape}=active;active=null;
    document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape,true);
    menu.remove();trigger.setAttribute('aria-expanded','false');if(restore&&trigger.isConnected)trigger.focus();
  }
  function open(trigger,item,isCurrent,isDraft) {
    if(working)return;
    if(active?.trigger===trigger){close(true);return;}close();
    const menu=element('div');menu.className='canvas-card-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',item.name+'的操作');
    const pref=getCardPreferences(item.id);
    function action(label,callback) {
      const button=element('button',label);button.type='button';button.setAttribute('role','menuitem');
      button.addEventListener('click',async()=>{
        if(working)return;
        const sequence=++workSequence;working=true;close(true);onBusyChange();
        try{await callback();}catch(error){host.reportError(error);}finally{if(sequence!==workSequence)return;working=false;onBusyChange();const target=document.getElementById(trigger.id);if(!document.querySelector("dialog[open]")&&target?.isConnected)target.focus({preventScroll:true});}
      });menu.append(button);
    }
    if(pref.hidden)action('恢复到最近画布',async()=>{setPreference(item.id,{hidden:false});await refresh();});
    else {
      action('重命名',async()=>{
        const name=await ask('重命名画布',item.name);if(name===null || name===item.name)return;
        if(!name)throw new Error('画布名称不能为空');await host.changeVersion(item,isCurrent,'rename',name);await refresh();
      });
      action('创建副本',async()=>{
        const name=await ask('副本名称',(item.name+' 副本').slice(0,120),{confirmLabel:'创建副本'});if(name===null)return;
        if(!name)throw new Error('副本名称不能为空');await host.changeVersion(item,isCurrent,'copy',name);await refresh();
      });
      if(!isDraft){
        action('修改封面',async()=>{const file=await ask('选择画布封面','',{acceptFile:true});if(!file)return;setPreference(item.id,{cover:await readCover(file)});await refresh();});
        if(pref.cover)action('恢复自动封面',async()=>{setPreference(item.id,{cover:null});await refresh();});
        action('移至文件夹…',async()=>{
          const folder=await ask('文件夹名称（留空移回全部画布）',pref.folder||'',{folders:folders(),confirmLabel:'移动'});
          if(folder===null)return;setPreference(item.id,{folder});await refresh();
        });
        action('从最近移除',async()=>{setPreference(item.id,{hidden:true});await refresh();});
      }
    }
    const outside=e=>{if(!menu.contains(e.target)&&!trigger.contains(e.target))close();};
    const escape=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(true);}};
    active={trigger,menu,outside,escape};document.body.append(menu);trigger.setAttribute('aria-expanded','true');
    const at=trigger.getBoundingClientRect(),box=menu.getBoundingClientRect();
    menu.style.left=Math.max(8,Math.min(innerWidth-box.width-8,at.right-box.width))+'px';
    menu.style.top=Math.max(8,at.bottom+box.height+8<innerHeight?at.bottom+3:at.top-box.height-3)+'px';
    const items=[...menu.querySelectorAll('button')];items[0]?.focus();
    menu.addEventListener('keydown',e=>{
      if(e.key==='Tab'){close(true);return;}
      if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
      e.preventDefault();const i=items.indexOf(document.activeElement);
      items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus();
    });
    document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape,true);
  }
  return {open,close,isWorking:()=>working};
}
