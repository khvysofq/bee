import { OverviewView } from '@/components/OverviewView';
import { SiteFooter, emptyFooterInfo, footerInfoFromOverview } from '@/components/SiteFooter';
import { loadMarketOverview, type MarketOverview } from '@/lib/market-overview';
import { formatNumber } from '@/lib/presentation';

export const dynamic = 'force-dynamic';

interface HomeSearchParams {
  q?: string | string[];
  category?: string | string[];
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function emptyOverview(): MarketOverview {
  return {
    generatedAt: new Date().toISOString(),
    globalLatest: null,
    rows: [],
    categories: [],
    regions: [],
    counts: { series: 0, points: 0, quotes: 0, international: 0, domestic: 0, regional: 0 },
    dataCutoffAt: null,
    hasStatsSource: false,
    statsSourceUrl: null,
    hasFixtureSource: false,
  };
}

/**
 * 行情总览（取代宣传册式落地页）。
 * 顶部范围页签 + 品类筛选 + 股票式列表；区域层为空时明确「待接入」。
 */
export default async function HomePage(props: { searchParams: Promise<HomeSearchParams> }) {
  const params = await props.searchParams;
  let data: MarketOverview | null = null;
  let unavailable = false;
  try {
    data = await loadMarketOverview();
  } catch (error) {
    console.error('[home] loadMarketOverview failed', error);
    unavailable = true;
  }

  if (unavailable || !data) {
    return (
      <main className="terminal">
        <div className="shell">
          <div className="t-not-found">
            <h1>行情数据暂时无法读取</h1>
            <p>
              数据库不可达。页面不会用估算值替代真实报价，也不会隐藏缺口；恢复后刷新即可。
            </p>
          </div>
        </div>
        <SiteFooter info={emptyFooterInfo()} />
      </main>
    );
  }

  const query = first(params.q)?.trim() ?? '';
  const category = first(params.category)?.trim() || 'all';

  return (
    <main className="terminal">
      <div className="shell">
        <section className="t-board" aria-labelledby="home-title">
          <span className="w-sweep" aria-hidden="true" />
          <span className="w-radar" aria-hidden="true" />
          <div>
            <p className="t-eyebrow">BEE / MARKET TERMINAL</p>
            <h1 id="home-title">行情总览</h1>
            <p className="t-board-sub">
              废钢、废铜、废铝、废纸、废塑料的日频报价与交易所行情。国际基准、国内期货与统计旬价分层展示；
              期货是预期价，统计旬价是全国参考锚点，两者不混成一条现货价。
            </p>
          </div>
          <dl className="t-kpis">
            <div className="t-kpi">
              <dt>全库序列</dt>
              <dd>{formatNumber(data.counts.series)}</dd>
            </div>
            <div className="t-kpi">
              <dt>观测点</dt>
              <dd>{formatNumber(data.counts.points)}</dd>
            </div>
            <div className="t-kpi">
              <dt>国内行</dt>
              <dd>{formatNumber(data.counts.domestic)}</dd>
            </div>
            <div className="t-kpi">
              <dt>最新数据日</dt>
              <dd style={{ fontSize: 'var(--text-xl)' }}>{data.globalLatest ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <div className="w-rail w-rail-inline" aria-hidden="true" />

        <OverviewView data={data} initialQuery={query} initialCategory={category} />
      </div>
      <SiteFooter info={footerInfoFromOverview(data)} />
    </main>
  );
}