import { SiteFooter, footerInfoFromLanding } from '@/components/SiteFooter';
import { Sparkline } from '@/components/Sparkline';
import { TREND_WINDOW_DAYS, type LandingCategory, type LandingData } from '@/lib/landing-data';
import {
  arrowOf,
  formatNumber,
  formatUpdateTime,
  seriesChange,
  signedPct,
} from '@/lib/presentation';

/**
 * 趋势推演页（GUA-33）。
 *
 * 只呈现已发生的已发布中值序列 + 诚实的空态 / 筹备态：
 *  - 不把单点序列连成「趋势」；
 *  - 不给点位、目标价、买卖信号；
 *  - 「分析参考，非预测承诺」与「推翻条件」字段保留。
 */

function directionText(category: LandingCategory): string | null {
  const change = seriesChange(category.trend.map((point) => point.value));
  if (!change) return null;
  return `${arrowOf(change.direction)} ${signedPct(change.pct)}`;
}

function TrendCard(props: { category: LandingCategory }) {
  const { category } = props;
  const quote = category.representative;
  const trend = category.trend;
  const change = seriesChange(trend.map((point) => point.value));
  const values = trend.map((point) => point.value);
  const first = trend[0];
  const last = trend[trend.length - 1];

  return (
    <article className="trend-card">
      <header className="trend-head">
        <div>
          <h3>{category.name}</h3>
          <p>
            {quote
              ? `${quote.specName} · ${quote.regionName} · ${quote.priceTypeLabel}`
              : '今日暂无代表报价'}
          </p>
        </div>
        {change ? (
          <span className={`trend-direction ${change.direction}`}>
            {directionText(category)}
            <small>近 {trend.length} 个报价日</small>
          </span>
        ) : (
          <span className="badge badge-soon">序列积累中</span>
        )}
      </header>

      {trend.length > 1 && first && last ? (
        <>
          <div className="trend-chart">
            <Sparkline
              trend={trend}
              title={`${category.name} ${quote?.specName ?? ''} 中值走势`}
              width={420}
              height={132}
              showGrid
            />
          </div>
          <div className="trend-range">
            <span>{first.date}</span>
            <strong>{formatNumber(last.value)} 元/吨</strong>
            <span>{last.date}</span>
          </div>
          <p className="trend-range">
            <span>区间 {formatNumber(Math.min(...values))} – {formatNumber(Math.max(...values))} 元/吨</span>
            <span>{trend.length} 个报价日</span>
          </p>
        </>
      ) : (
        <p className="trend-empty">
          历史序列积累中，至少两个报价日后显示走势。单点数据不连成趋势，也不补全缺失日期。
        </p>
      )}
    </article>
  );
}

export function OutlookView(props: { data: LandingData }) {
  const { data } = props;
  const updated = formatUpdateTime(data.dataCutoffAt);
  const maxPoints = Math.max(0, ...data.categories.map((category) => category.trend.length));
  const withSeries = data.categories.filter((category) => category.trend.length > 1).length;

  return (
    <main>
      <div className="shell">
        <header className="page-head">
          <div>
            <h1 className="page-title">趋势推演</h1>
            <p className="page-sub">
              先看已经发生的价格序列，再看能被什么推翻。只使用已发布的报价中值，不补全缺失数据，不给交易指令。
            </p>
          </div>
          <dl className="page-facts">
            <div>
              <dt>观察窗口</dt>
              <dd>近 {TREND_WINDOW_DAYS} 日</dd>
            </div>
            <div>
              <dt>可画序列</dt>
              <dd>
                {withSeries}/{data.stats.categoryCount}
              </dd>
            </div>
            <div>
              <dt>最长序列</dt>
              <dd>{maxPoints} 个报价日</dd>
            </div>
            <div>
              <dt>数据更新于</dt>
              <dd>{updated}</dd>
            </div>
          </dl>
        </header>

        <section className="section" aria-labelledby="history-title">
          <div className="section-head">
            <h2 id="history-title">历史序列</h2>
            <p>线只连接真实存在的报价日；点数不足时保持空白，不用插值或模型补点。</p>
          </div>
          {data.categories.length === 0 ? (
            <div className="empty">
              <h3>还没有可展示的序列</h3>
              <p>报价数据更新后，这里会自动出现各品类的中值走势。缺失不当作持平。</p>
            </div>
          ) : (
            <div className="trend-grid">
              {data.categories.map((category) => (
                <TrendCard key={category.id} category={category} />
              ))}
            </div>
          )}
        </section>

        <section className="scenario" aria-labelledby="scenario-title">
          <div className="scenario-head">
            <div>
              <h2 id="scenario-title">情景推演</h2>
              <p>
                把「如果关键品类继续上行」这类假设，放回真实历史序列里检查。当前只展示字段与依据，不输出任何方向判断，也不生成数值结论。
              </p>
            </div>
            <span className="badge badge-soon">筹备中</span>
          </div>
          <div className="scenario-fields">
            <div className="scenario-field">
              <h3>观察窗口</h3>
              <p>近 {TREND_WINDOW_DAYS} 个报价日；当前最长序列 {maxPoints} 个点，窗口与数据同步延长。</p>
            </div>
            <div className="scenario-field">
              <h3>当前依据</h3>
              <p>只使用已发布的历史中值。外部观点、模型推测与缺失日期的补全都不会进入推演。</p>
            </div>
            <div className="scenario-field">
              <h3>推翻条件</h3>
              <p>每个判断开放时都会附带明确条件（例如关键品类周度中值转跌）；当前没有判断，因此也没有推翻条件。</p>
            </div>
            <div className="scenario-field">
              <h3>分析参考，非预测承诺</h3>
              <p>推演只描述历史与假设，不构成对成交价格、数量或交易结果的保证。</p>
            </div>
          </div>
          <p className="scenario-note">
            当前不输出结论，只保留字段。数据更新后，历史序列自动延长；任何新增判断都必须同时给出依据与推翻条件。
          </p>
        </section>
      </div>

      <SiteFooter info={footerInfoFromLanding(data)} />
    </main>
  );
}