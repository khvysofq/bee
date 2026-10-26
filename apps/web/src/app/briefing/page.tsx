import Link from 'next/link';
import { TraceNumber } from '@/components/TraceNumber';
import { loadBriefing, PRICE_TYPE_LABEL, type ChangeView } from '@/lib/briefing-data';
import {
  AI_LABEL_ID,
  AI_LABEL,
  BRIEF_DISCLAIMER,
  BRIEF_DISCLAIMER_ID,
  CONTENT_POLICY_ID,
  DATA_SOURCE_NOTE,
  FIXTURE_NOTICE,
  STATS_ATTRIBUTION,
  STATS_COMPLIANCE_NOTE,
  STATS_SOURCE_CODE,
} from '@/lib/compliance';

export const dynamic = 'force-dynamic';

function fmt(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

function fmtDateTime(value: string | null): string {
  if (!value) return '—';
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function ChangeCell(props: { change: ChangeView | null; label: string; quoteId: string }) {
  if (!props.change) {
    return (
      <span className="change-empty" title={`没有${props.label}的可比定档报价`}>
        —
      </span>
    );
  }
  const direction = props.change.pct > 0 ? 'up' : props.change.pct < 0 ? 'down' : 'flat';
  return (
    <span className={`change ${direction}`}>
      <TraceNumber
        kind="quote"
        id={props.quoteId}
        label={`查看${props.label}涨跌计算依据与溯源`}
        className="trace-number-inline"
      >
        {props.change.pct > 0 ? '+' : ''}
        {props.change.pct.toFixed(2)}%
      </TraceNumber>
      <small>
        {props.label} {props.change.quoteDate}
      </small>
    </span>
  );
}

export default async function BriefingPage() {
  let data: Awaited<ReturnType<typeof loadBriefing>> | null = null;
  let error: string | null = null;
  try {
    data = await loadBriefing();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  if (error) {
    return (
      <main className="container">
        <h1>每日行情简报</h1>
        <div className="error">
          <p>简报数据读取失败：{error}</p>
          <p>
            本地起库并生成 P0-3 fixture 数据链：<code>docker compose up -d postgres && pnpm db:migrate && pnpm db:seed && pnpm data:fixture</code>
          </p>
        </div>
      </main>
    );
  }

  if (!data) return null;

  const statsSource = data.sources.find((source) => source.code === STATS_SOURCE_CODE);
  const hasFixtureSource = data.sources.some(
    (source) => source.code.startsWith('fixture') || source.code === 'open-cc0-sample',
  );

  return (
    <main className="container container-wide">
      {statsSource ? (
        <section className="source-banner" role="note" aria-label="真实数据来源署名">
          <strong>真实数据 · 全国参考锚点</strong>
          <span>{STATS_ATTRIBUTION}</span>
          {statsSource.latestFetchUrl ? (
            <span>
              {' '}
              ·{' '}
              <a href={statsSource.latestFetchUrl} target="_blank" rel="noreferrer">
                查看公报原文
              </a>
            </span>
          ) : null}
          <p>{STATS_COMPLIANCE_NOTE}</p>
          {statsSource.tosUrl ? (
            <p className="muted">
              来源服务条款：
              <a href={statsSource.tosUrl} target="_blank" rel="noreferrer">
                国家统计局服务条款
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
      {hasFixtureSource ? (
        <section className="fixture-banner" role="note" aria-label="Fixture 数据标识">
          <strong>FIXTURE / 开放数据</strong>
          <span>{FIXTURE_NOTICE}</span>
        </section>
      ) : null}

      <header className="brief-head">
        <div>
          <p className="eyebrow">bee · 每日行情简报</p>
          <h1>{data.latestQuoteDate ?? '暂无'} 行情简报</h1>
          <p className="sub">
            数据截止 {fmtDateTime(data.dataCutoffAt)} · 生成于 {fmtDateTime(data.generatedAt)} · 5 品类报价（日频 +
            旬报锚点）
          </p>
        </div>
        <div className="brief-stats">
          <div>
            <strong>
              {data.stats.categoriesWithQuotes}/{data.stats.categoryCount}
            </strong>
            <span>品类有报价</span>
          </div>
          <div>
            <strong>{data.stats.quoteCount}</strong>
            <span>已发布定档</span>
          </div>
          <div>
            <strong>{data.stats.sourceCount}</strong>
            <span>来源</span>
          </div>
          <div className={data.stats.openExceptions > 0 ? 'warn' : ''}>
            <strong>{data.stats.openExceptions}</strong>
            <span>异常待处理</span>
          </div>
        </div>
      </header>

      <section className="ai-label" aria-label="AI 生成内容标识">
        <span className="tag">AI_LABEL_V1</span>
        <p>{AI_LABEL}</p>
      </section>

      <section className="brief-meta">
        <p>
          <strong>怎么读：</strong>点击任意价格、中值或涨跌数字，可展开「定档报价 → 贡献观测 → 原始存档」的完整溯源链；
          点「查看原始存档」可看到抓取时的原文与抽取/校验留痕。
        </p>
        <p className="muted">
          标有「全国参考价（来源直发）」的数值为来源直接发布的全国口径参考价；其余「全国」数值为加工指标，
          不是全国统一观测价。异常观测已隔离，不进入本页。
        </p>
      </section>

      {data.globalGaps.length > 0 ? (
        <section className="gaps" aria-label="数据缺口与异常">
          <h2>覆盖缺口 / 异常</h2>
          <ul>
            {data.globalGaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
          <p>
            运维巡检入口：<Link href="/ops">/ops · 每日一次巡检（单人 + AI）</Link>
          </p>
        </section>
      ) : null}

      {data.latestQuoteDate === null ? (
        <section className="empty-state">
          <h2>还没有可发布的简报数据</h2>
          <p>
            先运行 P0-3 fixture 数据链：<code>pnpm data:fixture</code>。简报页只读取
            <code>daily_quote</code> / <code>derived_indicator</code>，不接受手写价格。
          </p>
        </section>
      ) : null}

      <div className="category-list">
        {data.categories.map((category) => (
          <section className="category" key={category.id} id={`category-${category.code}`}>
            <header className="category-head">
              <div>
                <h2>{category.name}</h2>
                <p className="muted">
                  覆盖 {category.coverage.regions} 个区域 · {category.coverage.sources} 个来源 ·{' '}
                  {category.coverage.specs} 个规格 · {category.coverage.quoteCount} 条定档
                </p>
              </div>
              {category.gaps.length > 0 ? (
                <ul className="category-gaps">
                  {category.gaps.map((gap) => (
                    <li key={gap}>{gap}</li>
                  ))}
                </ul>
              ) : null}
            </header>

            {category.quotes.length === 0 ? (
              <p className="empty-row">今日无已发布报价（缺失不当作持平）。</p>
            ) : (
              <div className="table-wrap">
                <table className="quote-table">
                  <thead>
                    <tr>
                      <th>规格 / 等级</th>
                      <th>区域</th>
                      <th>价类型</th>
                      <th className="num">价格区间（元/吨）</th>
                      <th className="num">中值</th>
                      <th className="num">较上一交易日</th>
                      <th className="num">较上周</th>
                      <th>来源 / 抓取</th>
                      <th>校验</th>
                    </tr>
                  </thead>
                  <tbody>
                    {category.quotes.map((quote) => (
                      <tr key={quote.id}>
                        <td>
                          {quote.specName}
                          {quote.quoteDate !== data.latestQuoteDate ? (
                            <small className="block">报价日 {quote.quoteDate}（旬报最新一期）</small>
                          ) : null}
                        </td>
                        <td>{quote.regionName}</td>
                        <td>{PRICE_TYPE_LABEL[quote.priceType]}</td>
                        <td className="num">
                          <TraceNumber
                            kind="quote"
                            id={quote.id}
                            label={`${category.name} ${quote.specName} ${quote.regionName} ${PRICE_TYPE_LABEL[quote.priceType]} 价格区间溯源`}
                            className="trace-number-price"
                          >
                            {fmt(quote.valueLow)} – {fmt(quote.valueHigh)}
                          </TraceNumber>
                        </td>
                        <td className="num">
                          <TraceNumber
                            kind="quote"
                            id={quote.id}
                            label={`${category.name} ${quote.specName} ${quote.regionName} 中值溯源`}
                            className="trace-number-mid"
                          >
                            {fmt(quote.valueMid)}
                          </TraceNumber>
                        </td>
                        <td className="num">
                          <ChangeCell change={quote.previousTradingDay} label="较上一交易日" quoteId={quote.id} />
                        </td>
                        <td className="num">
                          <ChangeCell change={quote.weekAgo} label="较上周" quoteId={quote.id} />
                        </td>
                        <td className="sources">
                          {quote.sources.map((source) => (
                            <span key={source.code} title={`可信权重 ${source.trustWeight}`}>
                              {source.name}
                            </span>
                          ))}
                          <small>{fmtDateTime(quote.fetchedTo)}</small>
                        </td>
                        <td>
                          <span className={`tag tag-${quote.status}`}>{quote.status}</span>
                          <small className="block">{quote.confidence}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {category.indicators.length > 0 ? (
              <div className="indicator-grid">
                {category.indicators.map((indicator) => (
                  <article className="indicator" key={indicator.id}>
                    <header>
                      <span className="tag tag-aggregate">
                        {indicator.kind === 'national_reference' ? '来源直发' : '加工指标'}
                      </span>
                      <span className="tag">{indicator.kindLabel}</span>
                    </header>
                    <p className="indicator-value">
                      <TraceNumber
                        kind="indicator"
                        id={indicator.id}
                        label={`${category.name} ${indicator.kindLabel} 加工指标溯源`}
                        className="trace-number-indicator"
                      >
                        {fmt(indicator.value)}
                      </TraceNumber>
                      <span> 元/吨</span>
                    </p>
                    <p className="indicator-title">
                      {indicator.regionName} · 基准日 {indicator.basisDate}
                    </p>
                    <p className="muted">{indicator.methodNote}</p>
                    <p className="muted">
                      方法版本 <code>{indicator.methodVersion}</code> · 贡献 {indicator.contributionCount} 条定档报价
                    </p>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>

      <section className="disclaimer" aria-label="简报免责声明">
        <h2>免责声明</h2>
        <p>
          <strong>{BRIEF_DISCLAIMER_ID}：</strong>
          {BRIEF_DISCLAIMER}
        </p>
      </section>

      <footer className="brief-foot">
        <p>
          <strong>内容策略：</strong>
          <code>{CONTENT_POLICY_ID}</code> · 免责声明 <code>{BRIEF_DISCLAIMER_ID}</code> · AI 标识{' '}
          <code>{AI_LABEL_ID}</code>
        </p>
        <p>
          {[statsSource ? STATS_ATTRIBUTION : '', hasFixtureSource ? DATA_SOURCE_NOTE : '']
            .filter(Boolean)
            .join(' · ') || DATA_SOURCE_NOTE}
        </p>
        <p>
          <Link href="/ops">每日巡检 / 异常队列</Link> · <Link href="/status">数据底座状态</Link>
        </p>
      </footer>
    </main>
  );
}
