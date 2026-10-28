import { CategoryCards } from '@/components/CategoryCards';
import { SiteFooter, emptyFooterInfo, type FooterInfo } from '@/components/SiteFooter';
import { loadCategoryOverview, type CategoryCardData } from '@/lib/category-overview';
import { formatNumber } from '@/lib/presentation';

export const dynamic = 'force-dynamic';

function footerFrom(categories: CategoryCardData[]): FooterInfo {
  const latestQuoteDate = categories.reduce<string | null>(
    (latest, category) =>
      category.latestDate && (!latest || category.latestDate > latest)
        ? category.latestDate
        : latest,
    null,
  );
  return {
    hasFixtureSource: categories.some((category) => category.hasDemo),
    hasStatsSource: false,
    statsSourceUrl: null,
    latestQuoteDate,
    updatedAt: latestQuoteDate,
  };
}

/**
 * 用户站首页：一张品类卡片 = 一个品类。
 * 卡片上的全球 / 全国 / 代表地区价格来自 price_daily 最新已发布行；缺层级写「待接入」。
 */
export default async function HomePage() {
  let categories: CategoryCardData[] = [];
  let unavailable = false;
  try {
    categories = await loadCategoryOverview();
  } catch (error) {
    console.error('[home] loadCategoryOverview failed', error);
    unavailable = true;
  }

  if (unavailable) {
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>行情数据暂时无法读取</h1>
            <p>数据库不可达。页面不会用估算值替代真实报价，也不会隐藏缺口；恢复后刷新即可。</p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  const connected = categories.filter(
    (category) => category.national ?? category.global,
  ).length;
  const latestDate = categories.reduce<string | null>(
    (latest, category) =>
      category.latestDate && (!latest || category.latestDate > latest)
        ? category.latestDate
        : latest,
    null,
  );
  const citedSources = categories.reduce((total, category) => total + category.sourceCount, 0);

  return (
    <main className="terminal">
      <div className="shell">
        <section className="t-board" aria-labelledby="home-title">
          <span className="w-sweep" aria-hidden="true" />
          <span className="w-radar" aria-hidden="true" />
          <div>
            <p className="t-eyebrow">BEE / CATEGORY TERMINAL</p>
            <h1 id="home-title">品类行情</h1>
            <p className="t-board-sub">
              废钢、废铜、废铝按品类汇总：全球基准、全国参考与典型地区报价分层展示。
              点击任一品类卡片进入详情，查看多地区走势、今日快照与研报。
            </p>
          </div>
          <dl className="t-kpis">
            <div className="t-kpi">
              <dt>品类</dt>
              <dd>{formatNumber(categories.length)}</dd>
            </div>
            <div className="t-kpi">
              <dt>已接入报价</dt>
              <dd>{formatNumber(connected)}</dd>
            </div>
            <div className="t-kpi">
              <dt>最新数据日</dt>
              <dd style={{ fontSize: 'var(--text-xl)' }}>{latestDate ?? '—'}</dd>
            </div>
            <div className="t-kpi">
              <dt>来源引用</dt>
              <dd>{formatNumber(citedSources)}</dd>
            </div>
          </dl>
        </section>

        <div className="w-rail w-rail-inline" aria-hidden="true" />

        <CategoryCards categories={categories} />
      </div>
      <SiteFooter info={footerFrom(categories)} />
    </main>
  );
}