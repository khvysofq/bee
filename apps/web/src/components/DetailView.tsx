import Link from 'next/link';
import { SiteFooter, type FooterInfo } from '@/components/SiteFooter';
import { Sparkline } from '@/components/Sparkline';
import type { MarketDetail, PeerChart } from '@/lib/market-detail';
import type { MarketChange } from '@/lib/market-overview';
import {
  arrowOf,
  confidenceLabel,
  directionOf,
  formatNumber,
  formatRange,
  signedPct,
  validationLabel,
} from '@/lib/presentation';
import { DetailTable } from './DetailTable';
import { PriceChart } from './PriceChart';

/**
 * 单品页（行情台 v3）：头部读数 + 主图 + 分层对比 + 最近 30 期溯源 + 两个未上线占位。
 * 页面数字全部来自 loadMarketDetail；组件里没有手写行情值。
 */

function ChangeLine(props: {
  label: string;
  change: MarketChange | null;
  frequency: string;
  suffix?: string;
}) {
  const { label, change, frequency, suffix } = props;
  if (frequency === 'monthly') {
    return (
      <span className="none">
        —<small>{label} · 月频不适用</small>
      </span>
    );
  }
  if (!change) {
    return (
      <span className="none">
        —<small>{label} · 无可比</small>
      </span>
    );
  }
  const direction = directionOf(change.pct);
  return (
    <span className={direction}>
      {arrowOf(direction)} {signedPct(change.pct)}
      <small>
        {label} {suffix ?? `对比 ${change.date}`}
      </small>
    </span>
  );
}

function PeerCard(props: { peer: PeerChart }) {
  const { peer } = props;
  return (
    <article className="t-peer">
      <header className="t-peer-head">
        <h3>{peer.label}</h3>
        <span>{peer.market}</span>
      </header>
      <p className="t-peer-value">
        {peer.latestValue === null ? '—' : formatNumber(peer.latestValue)}
        <small>{peer.unit}</small>
      </p>
      <div className="t-peer-chart">
        {peer.points.length > 1 ? (
          <Sparkline
            trend={peer.points}
            title={`${peer.label} 最近 ${peer.points.length} 个点`}
            tone="light"
            width={260}
            height={64}
            showGrid
          />
        ) : (
          <p className="t-trace-loading">单点，不连成趋势</p>
        )}
      </div>
      <Link href={`/m/${peer.slug}`}>打开 {peer.label} →</Link>
    </article>
  );
}

export function DetailView(props: { detail: MarketDetail; footer: FooterInfo }) {
  const { detail, footer } = props;
  const isQuote = detail.kind === 'quote';
  const changeFrequency = isQuote
    ? 'irregular'
    : detail.frequencyLabel === '日频'
      ? 'daily'
      : detail.frequencyLabel === '月频'
        ? 'monthly'
        : 'other';

  return (
    <main className="terminal">
      <div className="shell">
        <nav className="t-crumbs" aria-label="面包屑">
          <Link href="/">行情</Link>
          <span aria-hidden="true">/</span>
          {detail.categoryName ? (
            <>
              <Link href={`/?category=${encodeURIComponent(detail.categoryCode ?? '')}`}>{detail.categoryName}</Link>
              <span aria-hidden="true">/</span>
            </>
          ) : null}
          <span>{detail.spec}</span>
        </nav>

        <div className="t-detail-grid">
          <section className="t-detail-main" aria-labelledby="detail-title">
            <div className="t-detail-head">
              <div>
                <p className="t-eyebrow">{isQuote ? 'PUBLISHED QUOTE' : 'MARKET SERIES'}</p>
                <h1 id="detail-title">{detail.title}</h1>
                <p className="t-detail-spec">
                  {detail.spec} · {detail.market}
                </p>
              </div>
              <span className={`t-trust t-trust-${detail.trust}`}>{detail.trustLabel}</span>
            </div>

            <div className="t-hero-price">
              <span className="t-hero-number">
                {detail.latestValue === null ? '—' : formatNumber(detail.latestValue)}
              </span>
              <span className="t-hero-unit">{detail.unit}</span>
            </div>

            <div className="t-hero-change">
              <ChangeLine label="日涨跌" change={detail.dayChange} frequency={changeFrequency} />
              <ChangeLine label="周涨跌" change={detail.weekChange} frequency={changeFrequency} />
              <span className="flat">
                {detail.latestDate ?? '—'}
                <small>数据日期</small>
              </span>
            </div>

            {detail.summary ? <p className="t-hero-note">{detail.summary}</p> : null}
            {!detail.summary && isQuote && detail.quote?.coverageNote ? (
              <p className="t-hero-note">{detail.quote.coverageNote}</p>
            ) : null}

            <PriceChart
              points={detail.points}
              unit={detail.unit}
              title={`${detail.spec} · ${detail.frequencyLabel}`}
              tone="dark"
              defaultRange={detail.points.length > 500 ? '1y' : 'all'}
            />
          </section>

          <aside className="t-detail-aside" aria-label="读数与口径">
            <p className="t-aside-title">READOUT / 读数</p>
            <dl className="t-aside-kpis">
              <div className="t-aside-kpi">
                <dt>数据点</dt>
                <dd>{formatNumber(detail.pointCount)}</dd>
              </div>
              <div className="t-aside-kpi">
                <dt>频次</dt>
                <dd style={{ fontSize: 'var(--text-lg)' }}>{detail.frequencyLabel}</dd>
              </div>
              <div className="t-aside-kpi">
                <dt>最新日期</dt>
                <dd style={{ fontSize: 'var(--text-base)' }}>{detail.latestDate ?? '—'}</dd>
              </div>
              <div className="t-aside-kpi">
                <dt>单位 / 币种</dt>
                <dd style={{ fontSize: 'var(--text-base)' }}>
                  {detail.unit}
                  <small>{detail.currency}</small>
                </dd>
              </div>
            </dl>

            <dl className="t-aside-body">
              <div className="t-aside-row">
                <dt>市场</dt>
                <dd>{detail.market}</dd>
              </div>
              <div className="t-aside-row">
                <dt>口径</dt>
                <dd>{detail.marketKind}</dd>
              </div>
              <div className="t-aside-row">
                <dt>规格 / 合约</dt>
                <dd>{detail.spec}</dd>
              </div>
              <div className="t-aside-row">
                <dt>来源</dt>
                <dd>{detail.sourceName ?? '—'}</dd>
              </div>
              <div className="t-aside-row">
                <dt>数据日期</dt>
                <dd>{detail.latestDate ?? '—'}</dd>
              </div>
              <div className="t-aside-row">
                <dt>可信标记</dt>
                <dd>{detail.trustLabel}</dd>
              </div>
              {detail.quote ? (
                <>
                  <div className="t-aside-row">
                    <dt>价格类型</dt>
                    <dd>{detail.quote.priceTypeLabel}</dd>
                  </div>
                  <div className="t-aside-row">
                    <dt>校验 / 置信</dt>
                    <dd>
                      {validationLabel(detail.quote.status)} · {confidenceLabel(detail.quote.confidence)}
                    </dd>
                  </div>
                </>
              ) : null}
            </dl>

            {detail.quote ? (
              <div className="t-aside-quote">
                <h2>报价区间</h2>
                <p className="range">{formatRange(detail.quote.valueLow, detail.quote.valueHigh)} 元/吨</p>
                <p>{detail.quote.coverageNote}</p>
                <p>
                  加工口径 {detail.quote.method}@{detail.quote.methodVersion}；每行展开可回到原始抓取。
                </p>
              </div>
            ) : null}
          </aside>
        </div>

        <section className="t-section" aria-labelledby="peers-title">
          <div className="t-section-head">
            <h2 id="peers-title">分层对比 · 同品类</h2>
            <p>国内期货 / 国际基准并排；月频不与日频混画成一条线。</p>
          </div>
          {detail.peers.length === 0 ? (
            <p className="t-trace-loading" style={{ marginTop: 'var(--space-4)' }}>
              该品类暂无可对比的其他层级序列；不用其他品类顶替。
            </p>
          ) : (
            <div className="t-peer-grid">
              {detail.peers.map((peer) => (
                <PeerCard key={peer.code} peer={peer} />
              ))}
            </div>
          )}
        </section>

        <section className="t-section" aria-labelledby="recent-title">
          <div className="t-section-head">
            <h2 id="recent-title">最近 30 期</h2>
            <p>每行展开可看到来源、抓取时间、内容指纹与存档原文。</p>
          </div>
          <DetailTable rows={detail.recent} kind={detail.kind} unit={detail.unit} />
        </section>

        <section className="t-section" aria-labelledby="analysis-title">
          <div className="t-section-head">
            <h2 id="analysis-title">观点与情报</h2>
            <p>分析作业未上线；不生成任何叙事或方向判断。</p>
          </div>
          <div className="t-placeholder-grid">
            <article className="t-placeholder">
              <span className="badge badge-soon">分析作业未上线</span>
              <h2>今日观点</h2>
              <p>
                每日分析作业尚未上线。上线后这里只展示带证据链的方向倾向、驱动因素与推翻条件；
                不给点位、不给买卖建议。当前不输出任何结论。
              </p>
            </article>
            <article className="t-placeholder">
              <span className="badge badge-soon">分析作业未上线</span>
              <h2>相关情报</h2>
              <p>
                情报采集与结构化作业尚未上线。上线后这里展示带来源与时间的情报卡片，
                只存摘要与原文链接；当前不填充演示内容。
              </p>
            </article>
          </div>
        </section>
      </div>

      <SiteFooter info={footer} />
    </main>
  );
}