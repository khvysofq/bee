import { count } from 'drizzle-orm';
import { db, dbSchema } from '@/db';

/**
 * 数据底座状态页（P0-1 验收「仓库可本地起服务」的冒烟页面）。
 * 简报页本身是 P0-4 的交付物；此页只证明：Next ↔ Postgres ↔ 迁移后的 schema 全链路可用。
 */
async function loadStatus() {
  const { category, specGrade, region, source, rawFetch, priceObservation, dailyQuote, derivedIndicator, exceptionQueue } =
    dbSchema;
  const [
    categories, specs, regions, sources, fetches, observations, quotes, indicators, exceptions,
  ] = await Promise.all([
    db.select({ n: count() }).from(category),
    db.select({ n: count() }).from(specGrade),
    db.select({ n: count() }).from(region),
    db.select({ n: count() }).from(source),
    db.select({ n: count() }).from(rawFetch),
    db.select({ n: count() }).from(priceObservation),
    db.select({ n: count() }).from(dailyQuote),
    db.select({ n: count() }).from(derivedIndicator),
    db.select({ n: count() }).from(exceptionQueue),
  ]);
  return {
    品类字典: categories[0]!.n,
    规格等级字典: specs[0]!.n,
    地域: regions[0]!.n,
    来源注册: sources[0]!.n,
    原始抓取存档: fetches[0]!.n,
    报价观测: observations[0]!.n,
    当日定档报价: quotes[0]!.n,
    加工指标: indicators[0]!.n,
    异常队列: exceptions[0]!.n,
  };
}

export default async function HomePage() {
  let rows: Record<string, number> | null = null;
  let error: string | null = null;
  try {
    rows = await loadStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="container">
      <h1>bee · 数据底座状态</h1>
      <p className="sub">
        规范化报价库（品类 × 规格/等级 × 地域 × 日期 × 来源 × 校验状态）· P0-1 骨架
      </p>
      {error ? (
        <div className="error">
          <p>数据库不可用：{error}</p>
          <p>
            本地起库：<code>docker compose up -d postgres && pnpm db:migrate && pnpm db:seed</code>
          </p>
        </div>
      ) : (
        <table>
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
        数据字典当前为草案（draft）状态；真实来源登记与采集在 P0-3 落地。设计文档见
        <code>docs/data-model.md</code> 与 <code>docs/adr/</code>。
      </p>
    </main>
  );
}
