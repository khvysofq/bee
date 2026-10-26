import { TraceNumber } from '@/components/TraceNumber';
import type { ChangeView } from '@/lib/briefing-data';
import type { LandingCategory, LandingData, TrendPoint } from '@/lib/landing-data';
import {
  AI_LABEL,
  AI_LABEL_ID,
  BRIEF_DISCLAIMER,
  BRIEF_DISCLAIMER_ID,
  CONTENT_POLICY_ID,
  DATA_SOURCE_NOTE,
  FIXTURE_NOTICE,
  STATS_ATTRIBUTION,
  STATS_COMPLIANCE_NOTE,
} from '@/lib/compliance';

/**
 * 落地页展示层（GUA-26 / P0-6）：纯展示组件，不接数据库 —— 数据全部由
 * loadLandingData（复用 loadBriefing 查询逻辑）传入，页面数字与 DB 一一对应。
 * 样式全部收敛在 .lp-root 命名空间（globals.css），不影响 /briefing、/ops 既有视觉。
 */

function fmt(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function fmtDateTime(value: string | null): string {
  if (!value) return '—';
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function ChangeBadge(props: { change: ChangeView | null; label: string; quoteId: string }) {
  if (!props.change) {
    return (
      <span className="lp-change lp-change-none" title={`没有${props.label}的可比定档报价（缺失不当作持平）`}>
        —
      </span>
    );
  }
  const direction = props.change.pct > 0 ? 'up' : props.change.pct < 0 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '◆';
  const word = direction === 'up' ? '上涨' : direction === 'down' ? '下跌' : '持平';
  return (
    <span
      className={`lp-change lp-change-${direction}`}
      title={`${props.label}（${props.change.quoteDate} 中值 ${fmt(props.change.previousValue)} 元/吨）：${word} ${Math.abs(props.change.pct).toFixed(2)}%`}
    >
      <TraceNumber
        kind="quote"
        id={props.quoteId}
        label={`查看${props.label}涨跌计算依据与溯源`}
        className="lp-trace-inline"
      >
        {arrow} {props.change.pct > 0 ? '+' : ''}
        {props.change.pct.toFixed(2)}%
      </TraceNumber>
    </span>
  );
}

/** 近 N 天走势 sparkline：纯 SVG（不引图表库），点位 = daily_quote 已发布定档中值。 */
function Sparkline(props: { trend: TrendPoint[]; title: string }) {
  const { trend } = props;
  if (trend.length === 0) {
    return <p className="lp-spark-empty">该口径暂无走势序列（历史定档不足）。</p>;
  }
  const W = 132;
  const H = 40;
  const PAD = 5;
  const values = trend.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  const direction = last.value > first.value ? 'up' : last.value < first.value ? 'down' : 'flat';
  const xAt = (index: number): number =>
    trend.length === 1 ? W / 2 : PAD + (index * (W - 2 * PAD)) / (trend.length - 1);
  const yAt = (value: number): number => (span === 0 ? H / 2 : H - PAD - ((value - min) * (H - 2 * PAD)) / span);
  const points = trend.map((point, index) => `${xAt(index).toFixed(1)},${yAt(point.value).toFixed(1)}`).join(' ');
  const detail = trend.map((point) => `${point.date}：${fmt(point.value)} 元/吨`).join('\n');
  return (
    <div className={`lp-spark lp-spark-${direction}`} role="img" aria-label={`${props.title}（近 ${trend.length} 个定档日）`}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
        <title>{`${props.title}\n${detail}`}</title>
        {trend.length > 1 ? (
          <polyline className="lp-spark-line" points={points} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ) : null}
        {trend.map((point, index) => (
          <circle
            key={point.date}
            className={index === trend.length - 1 ? 'lp-spark-dot lp-spark-dot-last' : 'lp-spark-dot'}
            cx={xAt(index)}
            cy={yAt(point.value)}
            r={index === trend.length - 1 ? 3 : 2}
          />
        ))}
      </svg>
      <span className="lp-spark-range">
        {first.date} → {last.date} · {trend.length} 个定档日
      </span>
    </div>
  );
}

function CategoryCard(props: { category: LandingCategory }) {
  const { category } = props;
  const quote = category.representative;
  return (
    <article className="lp-card" id={`lp-card-${category.code}`}>
      <header className="lp-card-head">
        <h3>{category.name}</h3>
        <a className="lp-card-more" href={`/briefing#category-${category.code}`}>
          完整报价与溯源 →
        </a>
      </header>
      {quote ? (
        <>
          <p className="lp-price">
            <TraceNumber
              kind="quote"
              id={quote.id}
              label={`${category.name} ${quote.specName} ${quote.regionName} ${quote.priceTypeLabel}定档报价溯源`}
              className="lp-trace-price"
            >
              {fmt(quote.valueMid)}
            </TraceNumber>
            <span className="lp-unit">元/吨</span>
          </p>
          {/* GUA-29：区间与口径合并为一行 micro meta（卡片 7 层信息 → 4 层） */}
          <p className="lp-card-meta">
            {quote.specName} · {quote.regionName}
            {quote.regionLevel === 'city' ? '（城市）' : '（市场）'} · {quote.priceTypeLabel} · 区间{' '}
            {fmt(quote.valueLow)} – {fmt(quote.valueHigh)} · 报价日 {quote.quoteDate}
          </p>
          <div className="lp-changes">
            <div className="lp-change-cell">
              <span className="lp-change-label">日涨跌</span>
              <ChangeBadge change={quote.dailyChange} label="较上一交易日" quoteId={quote.id} />
            </div>
            <div className="lp-change-cell">
              <span className="lp-change-label">周涨跌</span>
              <ChangeBadge change={quote.weeklyChange} label="较上周" quoteId={quote.id} />
            </div>
          </div>
          <Sparkline
            trend={category.trend}
            title={`${category.name} ${quote.specName} ${quote.regionName} ${quote.priceTypeLabel}中值走势`}
          />
          <p className="lp-card-foot">
            今日定档 {category.latestQuoteCount} 条 · 置信度 {quote.confidence} · 点击数字可溯源
          </p>
        </>
      ) : (
        <p className="lp-card-empty">今日无已发布报价（缺失不当作持平）。</p>
      )}
    </article>
  );
}

export function LandingView(props: { data: LandingData }) {
  const { data } = props;
  const categoryNames = data.categories.map((category) => category.name).join('、');

  return (
    <main className="lp-root">
      {/* GUA-29：hero 降饱和改浅色大留白，品牌眉题移入全站导航，标题即第一层级 */}
      <div className="lp-hero">
        <div className="lp-hero-inner">
          <h1 className="lp-title">再生材料行情每日简报</h1>
          <p className="lp-value-prop">
            {categoryNames || '再生物资'}每日定档报价一屏速览 —— 每个数字都可溯源到原始存档。
          </p>
          <div className="lp-hero-meta">
            <strong>报价日 {data.latestQuoteDate ?? '暂无'}</strong>
            <span>数据截止 {fmtDateTime(data.dataCutoffAt)}</span>
            <span>
              {data.stats.categoriesWithQuotes}/{data.stats.categoryCount} 品类有报价 · {data.stats.quoteCount} 条已发布定档 ·{' '}
              {data.stats.sourceCount} 个来源
            </span>
          </div>
          <div className="lp-hero-actions">
            <a className="lp-cta" href="/briefing">
              查看完整行情简报（逐数溯源）→
            </a>
            <a className="lp-cta-secondary" href="#lp-cards">
              今日品类速览
            </a>
          </div>
        </div>
      </div>

      <div className="lp-body">
        {data.hasFixtureSource ? (
          <section className="lp-fixture" role="note" aria-label="Fixture 数据标识">
            <strong>FIXTURE / 开放数据</strong>
            <span>{FIXTURE_NOTICE}</span>
          </section>
        ) : null}
        {data.hasStatsSource ? (
          <section className="lp-stats-note" role="note" aria-label="真实数据来源署名">
            <strong>真实数据 · 全国参考锚点</strong>
            <span>
              {STATS_ATTRIBUTION} · {STATS_COMPLIANCE_NOTE}
            </span>
          </section>
        ) : null}

        {data.empty ? (
          <section className="lp-empty">
            <h2>还没有可展示的行情数据</h2>
            <p>
              数据管线就绪后本页自动呈现各品类最新定档报价；本页只读取 <code>daily_quote</code> /{' '}
              <code>derived_indicator</code>，不接受手写价格。
            </p>
          </section>
        ) : null}

        <section className="lp-cards" id="lp-cards" aria-label="品类行情卡片">
          {data.categories.map((category) => (
            <CategoryCard key={category.id} category={category} />
          ))}
        </section>

        <section className="lp-entry">
          <h2>想看每个数字从哪来？</h2>
          <p>
            完整简报按品类 × 规格 × 地域列出全部已发布定档报价；点击任意价格 / 中值 / 涨跌数字，
            可展开「定档报价 → 贡献观测 → 原始存档」的完整溯源链。
          </p>
          <a className="btn btn-inverse" href="/briefing">
            进入每日行情简报 →
          </a>
        </section>

        <section className="lp-ai-label" aria-label="AI 生成内容标识">
          <span className="lp-tag">{AI_LABEL_ID}</span>
          <p>{AI_LABEL}</p>
        </section>

        <footer className="lp-footer">
          <h2>免责声明</h2>
          <p>
            <strong>{BRIEF_DISCLAIMER_ID}：</strong>
            {BRIEF_DISCLAIMER}
          </p>
          <p className="lp-footer-sources">
            {[data.hasStatsSource ? STATS_ATTRIBUTION : '', data.hasFixtureSource ? DATA_SOURCE_NOTE : '']
              .filter(Boolean)
              .join(' · ') || DATA_SOURCE_NOTE}
          </p>
          <p className="lp-footer-policy">
            内容策略 <code>{CONTENT_POLICY_ID}</code> · 免责声明 <code>{BRIEF_DISCLAIMER_ID}</code> · AI 标识{' '}
            <code>{AI_LABEL_ID}</code>
          </p>
          <p className="lp-footer-links">
            <a href="/briefing">每日行情简报</a> · <a href="/ops">每日巡检 / 异常队列</a> ·{' '}
            <a href="/status">数据底座状态</a>
          </p>
        </footer>
      </div>
    </main>
  );
}
