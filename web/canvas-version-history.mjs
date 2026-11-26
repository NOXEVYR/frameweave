import { frameDialog } from './workspace-tools.mjs';

function element(tag, text, className) {
  const node=document.createElement(tag);
  if (className) node.className=className;
  if (text!==undefined) node.textContent=text;
  return node;
}
function modal(title, id) {
  const dialog=element('dialog',undefined,'modal project-detail-dialog');
  dialog.id=id; dialog.setAttribute('aria-label',title);
  const heading=element('div',undefined,'modal-heading');
  const close=element('button','×','dialog-close');
  close.type='button';close.setAttribute('aria-label','关闭');close.addEventListener('click',()=>dialog.close());
  heading.append(element('h2',title),close);
  dialog.append(heading);
  document.body.append(dialog);
  return dialog;
}
export function installProjectHistory({session,catalog,reportError}) {
  const trigger=element('button','版本历史','button quiet compact');
  trigger.id='project-history'; trigger.type='button';
  document.querySelector('.project-actions').append(trigger);
  let history, list, info, revision=0;
  trigger.addEventListener('click',async()=>{
    if (!history) {
      history=modal('版本历史','canvas-history-dialog');
      info=element('p','','project-history-info');info.setAttribute('role','status');
      list=element('div',undefined,'project-history-list');history.append(info,list);frameDialog(history);
      history.addEventListener('close',()=>{revision++;});
    }
    const current=session.readCurrent();
    if (!current.active || current.busy || history.open) return;
    const seq=++revision;
    info.textContent='正在读取当前画布的版本…';list.replaceChildren();history.showModal();
    try {
      const {versions:records,unreadable}=await catalog.history(current.projectId);
      if (!history.open || seq!==revision || session.readCurrent().identity!==current.identity) return;
      info.textContent=records.length ? `${current.title} · ${records.length} 个保存版本` : '此画布还没有保存版本。在编辑器点击「保存版本」即可保留当前内容。';
      if (unreadable) info.textContent = (records.length ? info.textContent + '。' : '') + '有保存记录暂不可读，可重新打开历史核对。';
      const format=new Intl.DateTimeFormat('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
      records.forEach((record,index)=>{
        const row=element('div',undefined,'project-history-row');row.dataset.version=record.id;
        const description=element('div');description.append(element('strong',record.name),element('small',format.format(new Date(record.updatedAt*1000))+' · '+record.nodeCount+' 个节点'));
        const open=element('button',record.id===current.savedVersionId && !current.dirty?'当前版本':'打开此版本','button compact');
        open.disabled=record.id===current.savedVersionId && !current.dirty;open.type='button';
        open.addEventListener('click',()=>{
          if (session.readCurrent().identity!==current.identity) {history.close();return;}
          history.close();
          session.open(record.id).catch(reportError);
        });
        row.append(element('span','v'+(records.length-index),'project-version-number'),description,open);list.append(row);
      });
    } catch (error) {if (history.open && revision===seq) info.textContent='版本读取失败。'+error.message;}
  });
  let rename, input, commit, editingIdentity;
  document.querySelector('#rename-current-project')?.addEventListener('click',()=>{
    const current=session.readCurrent();
    if (!current.active || current.busy) return;
    if (!rename) {
      rename=modal('重命名画布','canvas-rename-project-dialog');
      const form=element('form',undefined,'project-rename-form'), label=element('label','画布名称');
      input=element('input');input.id='project-rename-input';input.required=true;input.maxLength=120;
      label.htmlFor=input.id;
      commit=element('button','保存名称','button primary');commit.type='submit';
      form.append(label,input,commit);rename.append(form);
      let composing=false;
      input.addEventListener('compositionstart',()=>{composing=true;});
      input.addEventListener('compositionend',()=>{composing=false;});
      rename.addEventListener('close',()=>{composing=false;});
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        if (composing || commit.disabled || !input.value.trim()) return;
        if (session.readCurrent().identity!==editingIdentity || input.value.trim()===session.readCurrent().title) {rename.close();return;}
        commit.disabled=true;
        try { if (await session.save(input.value.trim())) rename.close(); }
        catch (error) {reportError(error);}
        finally {commit.disabled=false;}
      });
    }
    editingIdentity=current.identity;input.value=current.title;rename.showModal();input.select();
  });
}
