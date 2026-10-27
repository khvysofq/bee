import { ArrowRight, MarketIcon, OutlookIcon, QaIcon } from '@/components/icons';
import { SiteFooter, footerInfoFromLanding } from '@/components/SiteFooter';
import { Sparkline } from '@/components/Sparkline';
import type { LandingCategory, LandingData, LandingQuote } from '@/lib/landing-data';
import {
  arrowOf,
  directionOf,
  formatNumber,
  formatUpdateTime,
  signedPct,
  seriesChange,
} from '@/lib/presentation';

/**
 * 首页（GUA-33）：首屏三区 —— 行情数据 / 趋势推演 / 行业问答。
 * 全部数字来自 loadLandingData（daily_quote 已发布定档），无手写价格、无补全数据。
 * 对外不暴露溯源交互、来源列表、内部路由与工程术语；可信度只呈现为结论。
 */

function QuoteRow(props: { category: LandingCategory }) {
  const { category } = props;
  const quote = category.representative;
  if (!quote) return null;
  const change = quote.dailyChange;
  const direction = change ? directionOf(change.pct) : 'none';
  return (
    <div className="quote-row">
      <div>
        <span className="quote-name">{category.name}</span>
        <span className="quote-spec">
          {quote.specName} · {quote.regionName} · {quote.priceTypeLabel}
        </span>
      </div>
      <div className="quote-price">
        {formatNumber(quote.valueMid)}
        <small>元/吨</small>
      </div>
      <div className={`quote-change ${direction}`}>
        {change ? (
          <>
            <span aria-hidden="true">{arrowOf(directionOf(change.pct))}</span> {signedPct(change.pct)}
          </>
        ) : (
          <span className="quote-change-none">—</span>
        )}
      </div>
      <div className="quote-spark">
        {category.trend.length > 1 ? (
          <Sparkline
            trend={category.trend}
            title={`${category.name} ${quote.specName} ${quote.regionName} 中值走势`}
            tone="dark"
            width={88}
            height={26}
          />
        ) : category.trend.length === 1 ? (
          <Sparkline
            trend={category.trend}
            title={`${category.name} ${quote.specName} ${quote.regionName} 中值走势，序列积累中`}
            tone="dark"
            width={88}
            height={26}
          />
        ) : (
          <span className="quote-spark-empty" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}

function marketSummary(data: LandingData): string {
  const available = data.categories.filter((category) => category.representative);
  if (available.length === 0) return '今日还没有已发布报价。数据更新后自动出现；缺失不当作持平。';
  const missing = data.categories.length - available.length;
  return missing > 0
    ? `今日 ${available.length} 个品类有报价，${missing} 个暂无；缺失不当作持平。`
    : `今日 ${available.length} 个品类均有报价；涨跌按上一交易日中值。`;
}

export function LandingView(props: { data: LandingData; dataUnavailable?: boolean }) {
  const { data } = props;
  const quoted = data.categories.filter((category) => category.representative).slice(0, 4);
  const previewCategory =
    data.categories.find((category) => category.trend.length > 1) ??
    data.categories.find((category) => category.trend.length > 0) ??
    null;
  const previewTrend = previewCategory?.trend ?? [];
  const previewChange = seriesChange(previewTrend.map((point) => point.value));
  const previewQuote: LandingQuote | null = previewCategory?.representative ?? null;
  const heroUpdated = formatUpdateTime(data.dataCutoffAt);

  return (
    <main>
      <div className="shell">
        <section className="home-hero" aria-labelledby="home-title">
          <div>
            <h1 className="hero-title" id="home-title">
              行情先校准，再读数。
            </h1>
            <p className="hero-sub">
              废钢、废铜、废铝、废纸、废塑料的每日报价、趋势与行业问答 —— 三大功能，一屏直达。
            </p>
          </div>
          <dl className="hero-facts">
            <div>
              <dt>报价日</dt>
              <dd>{data.latestQuoteDate ?? '—'}</dd>
            </div>
            <div>
              <dt>数据更新于</dt>
              <dd>{heroUpdated}</dd>
            </div>
            <div>
              <dt>有报价品类</dt>
              <dd>
                {data.stats.categoriesWithQuotes}/{data.stats.categoryCount}
              </dd>
            </div>
          </dl>
        </section>

        {props.dataUnavailable ? (
          <p className="home-notice" role="status">
            报价数据暂时无法读取；功能入口仍在，数字不会用估算值替代。
          </p>
        ) : null}

        <div className="entry-grid">
          <article className="entry entry-market" aria-labelledby="entry-market-title">
            <header className="entry-head">
              <div className="entry-id">
                <MarketIcon />
                <span className="entry-label">01 / MARKET</span>
              </div>
              <span className="badge badge-live">
                <span className="pulse" aria-hidden="true" />
                报价日 {data.latestQuoteDate ?? '待更新'}
              </span>
            </header>
            <h2 className="entry-title" id="entry-market-title">
              <a href="/market">行情数据</a>
            </h2>
            <p className="entry-desc">{marketSummary(data)}</p>

            {quoted.length > 0 ? (
              <div className="quote-list">
                {quoted.map((category) => (
                  <QuoteRow key={category.id} category={category} />
                ))}
              </div>
            ) : (
              <p className="entry-empty">今日暂无已发布报价。缺失不当作持平，也不会用估算值填充。</p>
            )}

            <a className="entry-link" href="/market">
              查看全部行情
              <ArrowRight />
            </a>
          </article>

          <article className="entry entry-outlook" aria-labelledby="entry-outlook-title">
            <header className="entry-head">
              <div className="entry-id entry-id-light">
                <OutlookIcon />
                <span className="entry-label">02 / OUTLOOK</span>
              </div>
              <span className="badge">历史序列</span>
            </header>
            <h2 className="entry-title" id="entry-outlook-title">
              <a href="/outlook">趋势推演</a>
            </h2>
            <p className="entry-desc">看历史序列与推翻条件；分析参考，非预测承诺。</p>

            {previewCategory && previewTrend.length > 1 ? (
              <figure className="entry-chart">
                <Sparkline
                  trend={previewTrend}
                  title={`${previewCategory.name} ${previewQuote?.specName ?? ''} 中值走势`}
                  width={320}
                  height={64}
                  showGrid
                />
                <figcaption>
                  <span>
                    {previewCategory.name} · {previewTrend.length} 个报价日
                  </span>
                  <span className={`trend-direction ${previewChange?.direction ?? 'flat'}`}>
                    {previewChange ? `${arrowOf(previewChange.direction)} ${signedPct(previewChange.pct)}` : '—'}
                  </span>
                </figcaption>
              </figure>
            ) : (
              <p className="entry-note">历史序列积累中，至少两个报价日后显示走势。当前不生成任何方向判断。</p>
            )}

            <ul className="fields-inline" aria-label="趋势推演包含的字段">
              <li>历史走势</li>
              <li>情景假设</li>
              <li>推翻条件</li>
            </ul>
            <a className="entry-link" href="/outlook">
              进入趋势推演
              <ArrowRight />
            </a>
          </article>

          <article className="entry entry-qa" aria-labelledby="entry-qa-title">
            <header className="entry-head">
              <div className="entry-id entry-id-light">
                <QaIcon />
                <span className="entry-label">03 / Q&amp;A</span>
              </div>
              <span className="badge badge-soon">筹备中</span>
            </header>
            <h2 className="entry-title" id="entry-qa-title">
              <a href="/qa">行业问答</a>
            </h2>
            <p className="entry-desc">行业常识问答：只答有依据的问题，不编造答案。</p>
            <ul className="topic-list" aria-label="行业问答可以问什么">
              <li>
                <span className="topic-index">01</span>品类与规格
              </li>
              <li>
                <span className="topic-index">02</span>报价区间
              </li>
              <li>
                <span className="topic-index">03</span>涨跌计算
              </li>
              <li>
                <span className="topic-index">04</span>数据边界
              </li>
            </ul>
            <p className="entry-note">回答附报价日与数据范围，不编造。</p>
            <a className="entry-link" href="/qa">
              看看能问什么
              <ArrowRight />
            </a>
          </article>
        </div>

        <div className="home-strip">
          <span>
            报价日 {data.latestQuoteDate ?? '—'} · 数据更新于 {heroUpdated} · 缺失不当作持平
          </span>
          <span className="legend" aria-label="涨跌颜色图例">
            <span className="legend-up">▲ 涨</span>
            <span className="legend-down">▼ 跌</span>
            <span className="legend-flat">◆ 平</span>
          </span>
        </div>
      </div>

      <SiteFooter info={footerInfoFromLanding(data)} />
    </main>
  );
}