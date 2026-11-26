export function engineBadge(engine, autoStart) {
  if (engine.online) {
    const devices = (engine.devices || []).map(item => typeof item === 'string' ? item : item.name).filter(Boolean);
    return { label: '生成引擎已连接', detail: [engine.backend_url, ...devices].filter(Boolean).join(' · ') };
  }
  const connection = engine.connection || {};
  const labels = {
    offline: '已配置 · 引擎未启动', starting: '引擎启动中', degraded: '引擎暂未就绪',
    error: '引擎启动异常', occupied: '引擎端口被占用', catalog_unavailable: '已连接 · 节点目录不可用',
    unregistered: '引擎未连接 · 检查地址', online: '引擎正在就绪',
  };
  const detail = connection.state === 'offline'
    ? [connection.name, autoStart ? '在引擎设置中检查启动状态' : '随应用启动已关闭，可在引擎设置中点「后台启动」']
    : [connection.name, connection.message || engine.error || '点击查看引擎设置'];
  return { label: labels[connection.state] || '引擎暂未就绪', detail: detail.filter(Boolean).join(' · ') };
}
