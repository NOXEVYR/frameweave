/** Explicit choice when a PNG contains native/API alternatives or damaged metadata. */
export function choosePngWorkflow(candidates) {
  return new Promise(resolve => {
    const element = (tag, className, text = '') => {
      const item = document.createElement(tag); item.className = className; item.textContent = text; return item;
    };
    const dialog = element('dialog', 'modal packages-modal');
    dialog.setAttribute('aria-label', '选择 PNG 中的工作流');
    const finish = value => { if (dialog.open) dialog.close(); dialog.remove(); resolve(value); };
    const makeButton = (label, action, primary = false) => {
      const button = element('button', primary ? 'button primary' : 'button quiet', label);
      button.type = 'button'; button.addEventListener('click', action); return button;
    };
    const heading = element('div', 'modal-heading');
    const close = makeButton('×', () => finish(null)); close.className = 'close-button'; close.setAttribute('aria-label', '关闭');
    heading.append(element('h2', '', '选择 PNG 中的工作流'), close); dialog.append(heading);
    dialog.append(element('p', 'form-note', '图片中保存了多份内容，或有内容无法读取。请选择一份导入；原图不改写，导入不会开始生成。原生工作流保留内部布局，执行参数图保留实际节点与参数。'));
    for (const candidate of candidates) {
      const card = element('section', 'workflow-configuration-row');
      const label = `${candidate.key} · 元数据块 ${candidate.chunkIndex}`;
      card.append(element('strong', '', label));
      if (candidate.duplicate) card.append(element('p', 'form-note', '存在同名元数据，请按此条内容单独选择；不会自动合并或覆盖。'));
      if (candidate.error) {
        card.append(element('p', 'workflow-run-error', `此条内容未通过格式检查，无法导入。详情：${candidate.error.message}`));
      } else {
        const native = candidate.kind === 'native';
        card.append(element('p', 'form-note', `${candidate.nodeCount} 个节点 · ${native ? '原生 ComfyUI 工作流 · 可以进入内部编辑和编译外部接口' : 'ComfyUI 执行参数图 · 可以提取外部参数，内部布局可能与原图不同'}`));
        const preview = element('details', 'png-workflow-preview');
        preview.append(element('summary', '', '查看内嵌内容'));
        preview.append(element('pre', '', candidate.sourceJSON.slice(0, 12000)));
        if (candidate.sourceJSON.length > 12000) preview.append(element('p', 'form-note', '这里只展示前 12000 个字符；导入会读取完整内容。'));
        card.append(preview);
        card.append(makeButton(`导入${native ? '原生工作流' : '执行参数图'} · ${label}`, () => finish(candidate), true));
      }
      dialog.append(card);
    }
    const footer = element('div', 'modal-actions'); footer.append(makeButton('取消导入', () => finish(null))); dialog.append(footer);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
    document.body.append(dialog); dialog.showModal(); close.focus();
  });
}
