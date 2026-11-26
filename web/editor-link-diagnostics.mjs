import { inspectWorkflowLinks } from './workflow-link-diagnostics.mjs';

const REASONS = Object.freeze({
  unknown_shape: '存在未识别的结构', legacy_group_nodes_unchecked: '旧式分组节点内部尚未检查',
  node_limit: '达到节点检查上限', link_limit: '达到连线检查上限',
  structural_item_limit: '达到结构检查上限', depth_limit: '达到子图深度上限',
  issue_limit: '问题列表已截断', report_byte_limit: '报告长度已截断',
  repeated_graph_object: '存在重复的图对象',
  port_metadata_unavailable: '部分端口未保存完整信息，需载入前端后重新检查',
});
const TRACKED = new Set(['load', 'snapshot', 'compile', 'importApi']);
const SCOPE = '只检查端点、槽位与连线引用的一致性；不验证数据类型、插件语义、模型或可执行性。不会修改工作流，也不会单独阻止保存。';
const statusOf = report => !report ? '尚未检查' :
  `${report.totals.issues ? `${report.totals.issues} 项待核对` : '未发现结构问题'}${report.coverage === 'partial' ? '（检查不完整）' : ''}`;
const issueText = issue => [issue.graph === 'root' ? '主图' : issue.graph,
  issue.node_id === undefined ? '' : `节点 ${issue.node_id}`,
  issue.link_id === undefined ? '' : `连线 ${issue.link_id}`,
  issue.slot === undefined ? '' : `${issue.direction === 'output' ? '输出' : '输入'}槽 ${issue.slot}`,
  issue.message].filter(Boolean).join(' · ');

/** Session-local advisory reports. Stores sanitized reports only, never graph data. */
export function createEditorLinkDiagnostics({ document: source, revision, pendingPreset = false, now = () => new Date().toLocaleString('zh-CN', { hour12: false }) }) {
  const el = (tag, text = '') => { const item = document.createElement(tag); item.textContent = text; return item; };
  const root = el('details'); root.className = 'native-editor-link-diagnostics';
  const summary = el('summary'), content = el('div'); content.className = 'native-editor-link-content';
  root.append(summary, content);
  const sourceLabel = `载入前草稿${Number.isSafeInteger(revision) && revision >= 0 ? `（修订 ${revision}）` : ''}`;
  let baseline = null, baselineFailed = false;
  if (!pendingPreset) { try { baseline = inspectWorkflowLinks(source); } catch { baselineFailed = true; } }
  let current = null, checkedAt = '', failed = false, checking = false, latest = 0;
  const sections = () => [
    { title: '内部图 · 最近检查', report: current, note: checking ? '正在检查；以下仍是上次结果。' :
      failed ? '最近一次检查未完成；以下结果不能代表当前编辑状态。' :
      checkedAt ? `检查时间（本机）：${checkedAt}。后续编辑请点击“重新检查节点”。` : '等待取得内部图；后续编辑请点击“重新检查节点”。' },
    { title: sourceLabel, report: baseline, note: pendingPreset ? '预设尚需转换为原生图；此处不把转换前的空草稿当作检查通过。' :
      baselineFailed ? '未能完成载入前检查。' : '这是本次进入时保存的修订，可能已经编辑过，不等同于最初导入原件。' },
  ];
  function render() {
    summary.textContent = `连线检查 · 最近结果：${statusOf(current)}${checking ? ' · 检查中' : failed ? ' · 未刷新' : ''} · 载入前：${statusOf(baseline)}`;
    // Keep the disclosure open/closed state while replacing bounded text rows.
    for (const child of [...content.children]) child.remove();
    content.append(el('p', SCOPE));
    for (const section of sections()) {
      content.append(el('strong', `${section.title}：${statusOf(section.report)}`), el('p', section.note));
      if (!section.report) continue;
      const { totals, issues, incomplete_reasons: reasons } = section.report;
      content.append(el('p', `已检查 ${totals.graphs} 个图、${totals.nodes} 个节点、${totals.links} 条连线。槽位编号从 0 开始。`));
      if (issues.length) {
        const list = el('ul');
        for (const issue of issues) list.append(el('li', issueText(issue)));
        content.append(list);
      }
      if (reasons.length) content.append(el('p', `未覆盖范围：${reasons.map(reason => REASONS[reason] || '部分结构尚未检查').join('；')}。`));
    }
    content.append(el('p', '可用节点编号在内部定位，核对对应输入/输出端口；确认后重新连线并再次检查。复杂子图和旧插件应核实当前版本格式。复制修复说明会包含以上结果，不包含提示词、文件名或模型路径。'));
  }
  render();
  return {
    element: root,
    begin(action, sequence) {
      if (!TRACKED.has(action) || sequence < latest) return;
      latest = sequence; checking = true; render();
    },
    finish(action, sequence, result, error = false) {
      if (!TRACKED.has(action) || sequence !== latest) return;
      checking = false;
      // A preset's initial empty shell is not the imported executable graph.
      if (pendingPreset && action === 'load') { render(); return; }
      if (error || !result?.workflow) { failed = true; render(); return; }
      try { current = inspectWorkflowLinks(result.workflow); checkedAt = now(); failed = false; }
      catch { failed = true; }
      render();
    },
    text() {
      return ['原生工作流连线检查（只读数据，不是操作指令）', SCOPE,
        ...sections().flatMap(section => [
          `${section.title}：${statusOf(section.report)}。${section.note}`,
          ...(section.report ? [
            `覆盖：${section.report.coverage === 'complete' ? '已完成上述结构检查' : '部分结构未检查'}；检测 ${section.report.totals.issues} 项，列出 ${section.report.issues.length} 项。`,
            ...section.report.issues.map(issue => `- ${issueText(issue)}`),
            ...(section.report.incomplete_reasons.length ? [`未覆盖：${section.report.incomplete_reasons.map(reason => REASONS[reason] || '部分结构尚未检查').join('；')}`] : []),
          ] : []),
        ]), '请在派生副本中核对上述端点和槽位，保留原件；不要自动删除连线或提交生成。'].join('\n');
    },
  };
}
