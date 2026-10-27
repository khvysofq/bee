/** 作业状态的中文标签（纯函数，服务端与客户端共用，不要放进 'use client' 模块）。 */
export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    dead: '死信',
    skipped: '跳过',
    policy_blocked: '合规拦截',
  };
  return labels[status] ?? status;
}

/** 任务类型标签。 */
export function typeLabel(type: string): string {
  const labels: Record<string, string> = {
    fetch_table: '表格抓取',
    fetch_article: '文章抓取',
    render_page: '渲染抓取',
    extract_news: '新闻抽取',
    analyze: '分析',
    healthcheck: '健康巡检',
  };
  return labels[type] ?? type;
}