import Link from 'next/link';
import { count } from 'drizzle-orm';
import { v4 } from '@bee/db';
import { db } from '@/db';

export const dynamic = 'force-dynamic';

/**
 * 数据底座状态页（v4）：9 张表的行数冒烟。
 * GUA-26（P0-6）：原首页 `/` 改版为面向最终用户的落地页，本页原样迁至 `/status`。
 */
async function loadStatus() {
  const [
    categories, specs, regions, sources, prices, contents, jobs, jobRuns, audits,
  ] = await Promise.all([
    db.select({ n: count() }).from(v4.category),
    db.select({ n: count() }).from(v4.spec),
    db.select({ n: count() }).from(v4.region),
    db.select({ n: count() }).from(v4.source),
    db.select({ n: count() }).from(v4.priceDaily),
    db.select({ n: count() }).from(v4.content),
    db.select({ n: count() }).from(v4.job),
    db.select({ n: count() }).from(v4.jobRun),
    db.select({ n: count() }).from(v4.adminAudit),
  ]);
  return {
    品类: categories[0]!.n,
    规格: specs[0]!.n,
    地域: regions[0]!.n,
    来源注册: sources[0]!.n,
    每日价格: prices[0]!.n,
    内容文档: contents[0]!.n,
    采集任务: jobs[0]!.n,
    运行记录: jobRuns[0]!.n,
    管理审计: audits[0]!.n,
  };
}

export default async function StatusPage() {
  let rows: Record<string, number> | null = null;
  let error: string | null = null;
  try {
    rows = await loadStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="container container-narrow">
      <p className="eyebrow">bee · 运维</p>
      <h1>数据底座状态</h1>
      <p className="sub">
        v4 数据模型（9 表，品类为轴）· category / spec / region / price_daily / content / source / job / job_run / admin_audit
      </p>
      {error ? (
        <div className="error">
          <p>数据库不可用：{error}</p>
          <p>
            本地起库：<code>docker compose up -d postgres && pnpm db:migrate &amp;&amp; pnpm db:seed</code>
          </p>
        </div>
      ) : (
        <table className="status-table">
          <tbody>
            {rows &&
              Object.entries(rows).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{v}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
      <p className="foot">
        架构以 <code>docs/db-architecture-v4.md</code> 为准；旧 25 表模型仅作历史参考。
      </p>
      <p className="foot">
        <Link href="/internal/ops">← 每日巡检 / 异常队列</Link> · <Link href="/">返回用户站</Link>
      </p>
    </main>
  );
}