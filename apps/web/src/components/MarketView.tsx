import { ArrowRight } from '@/components/icons';
import { SiteFooter, footerInfoFromBriefing } from '@/components/SiteFooter';
import {
  PRICE_TYPE_LABEL,
  type BriefingCategory,
  type BriefingData,
  type BriefingIndicator,
  type BriefingQuote,
  type ChangeView,
} from '@/lib/briefing-data';
import {
  arrowOf,
  changeDisplay,
  confidenceLabel,
  formatNumber,
  formatRange,
  formatUpdateTime,
  validationLabel,
} from '@/lib/presentation';
import { pickRepresentative } from '@/lib/representative';

/**
 * 行情数据页（GUA-33）：用户侧完整报价。
 * 只展示报价本身（价格 / 涨跌 / 更新时间）；不展示来源列表、可信权重、抓取时间、
 * 方法版本、溯源交互或内部路由。所有数字来自 loadBriefing 查询结果。
 */

function ChangeCell(props: { change: ChangeView | null; label: string }) {
  const display = changeDisplay(props.change);
  if (!display.available) {
    return (
      <span className="change none" title={`没有${props.label}的可比报价（缺失不当作持平）`}>
        —
        <small className="change-label">{props.label}</small>
      </span>
    );
  }
  return (
    <span className={`change ${display.direction}`}>
      <span>
        <span aria-hidden="true">{display.arrow}</span> {display.text}
      </span>
      <small className="change-label">{props.label}</small>
    </span>
  );
}

function BoardRow(props: { category: BriefingCategory; quoteDate: string | null }) {
  const quote = pickRepresentative(props.category.quotes, props.quoteDate);
  if (!quote) return null;
  return <BoardQuote category={props.category} quote={quote} />;
}

function BoardQuote(props: { category: BriefingCategory; quote: BriefingQuote }) {
  const { quote } = props;
  const day = changeDisplay(quote.previousTradingDay);
  const week = changeDisplay(quote.weekAgo);
  return (
    <div className="board-row">
      <div className="board-name">{props.category.name}</div>
      <div className="board-spec">
        {quote.specName} · {quote.regionName} · {PRICE_TYPE_LABEL[quote.priceType]}
      </div>
      <div className="board-price">
        {formatNumber(quote.valueMid)}
        <small>元/吨</small>
      </div>
      <div className={`board-change ${day.direction}`}>
        {day.available ? (
          <>
            <span aria-hidden="true">{day.arrow}</span> {day.text}
          </>
        ) : (
          '—'
        )}
        <span>日涨跌</span>
      </div>
      <div className={`board-change ${week.direction}`}>
        {week.available ? (
          <>
            <span aria-hidden="true">{week.arrow}</span> {week.text}
          </>
        ) : (
          '—'
        )}
        <span>周涨跌</span>
      </div>
    </div>
  );
}

function IndicatorCard(props: { indicator: BriefingIndicator }) {
  const { indicator } = props;
  return (
    <article className="indicator">
      <header className="indicator-head">
        <h3>{indicator.kindLabel}</h3>
      </header>
      <p className="indicator-value">
        {formatNumber(indicator.value)}
        <small>元/吨</small>
      </p>
      <p className="indicator-meta">
        {indicator.regionName} · 基准日 {indicator.basisDate}
      </p>
      <p className="indicator-meta">{indicator.methodNote}</p>
    </article>
  );
}

function CategoryBlock(props: { category: BriefingCategory; latestQuoteDate: string | null }) {
  const { category, latestQuoteDate } = props;
  return (
    <section className="quote-group" id={`cat-${category.code}`}>
      <div className="quote-group-head">
        <h3>{category.name}</h3>
        <span>
          {category.coverage.quoteCount} 条报价 · {category.coverage.regions} 个地域 · {category.coverage.specs} 个规格
        </span>
      </div>
      {category.quotes.length === 0 ? (
        <p className="empty-row">今日无已发布报价（缺失不当作持平）。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">规格 / 等级</th>
                <th scope="col">地域</th>
                <th scope="col">价格类型</th>
                <th scope="col" className="num">
                  价格区间（元/吨）
                </th>
                <th scope="col" className="num">
                  中值
                </th>
                <th scope="col" className="num">
                  较上一交易日
                </th>
                <th scope="col" className="num">
                  较上周
                </th>
                <th scope="col">校验</th>
              </tr>
            </thead>
            <tbody>
              {category.quotes.map((quote) => (
                <tr key={quote.id}>
                  <td>
                    {quote.specName}
                    {latestQuoteDate && quote.quoteDate !== latestQuoteDate ? (
                      <small>{quote.quoteDate} 报价</small>
                    ) : null}
                  </td>
                  <td>{quote.regionName}</td>
                  <td>{PRICE_TYPE_LABEL[quote.priceType]}</td>
                  <td className="num">
                    {formatRange(quote.valueLow, quote.valueHigh)}
                    <small>元/吨</small>
                  </td>
                  <td className="num">{formatNumber(quote.valueMid)}</td>
                  <td className="num">
                    <ChangeCell change={quote.previousTradingDay} label="上一交易日" />
                  </td>
                  <td className="num">
                    <ChangeCell change={quote.weekAgo} label="上周" />
                  </td>
                  <td>
                    <span className="status">{validationLabel(quote.status)}</span>
                    <small>{confidenceLabel(quote.confidence)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {category.indicators.length > 0 ? (
        <div className="indicators">
          {category.indicators.map((indicator) => (
            <IndicatorCard key={indicator.id} indicator={indicator} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function MarketView(props: { data: BriefingData }) {
  const { data } = props;
  const updated = formatUpdateTime(data.dataCutoffAt);
  const available = data.categories.filter((category) => category.quotes.length > 0);

  return (
    <main>
      <div className="shell">
        <header className="page-head">
          <div>
            <h1 className="page-title">今日行情数据</h1>
            <p className="page-sub">
              废钢、废铜、废铝、废纸、废塑料的日频报价。价格区间与中值为报价数据原值；缺失不当作持平。
            </p>
          </div>
          <dl className="page-facts">
            <div>
              <dt>报价日</dt>
              <dd>{data.latestQuoteDate ?? '—'}</dd>
            </div>
            <div>
              <dt>数据更新于</dt>
              <dd>{updated}</dd>
            </div>
            <div>
              <dt>有报价品类</dt>
              <dd>
                {data.stats.categoriesWithQuotes}/{data.stats.categoryCount}
              </dd>
            </div>
            <div>
              <dt>报价条数</dt>
              <dd>{data.stats.quoteCount}</dd>
            </div>
          </dl>
        </header>

        {data.latestQuoteDate === null ? (
          <section className="empty">
            <h2>今日还没有已发布报价</h2>
            <p>报价数据更新后自动出现。缺失不当作持平，也不会用估算值填充。</p>
            <p>
              <a className="text-link" href="/outlook">
                先看趋势推演
                <ArrowRight />
              </a>
            </p>
          </section>
        ) : (
          <>
            <section className="section" aria-labelledby="overview-title">
              <div className="board">
                <div className="board-head">
                  <h2 id="overview-title">今日概览</h2>
                  <p>代表报价 · 报价日 {data.latestQuoteDate} · 更新于 {updated}</p>
                </div>
                {available.length === 0 ? (
                  <p className="empty-row">今日无已发布报价。</p>
                ) : (
                  available.map((category) => (
                    <BoardRow key={category.id} category={category} quoteDate={data.latestQuoteDate} />
                  ))
                )}
              </div>
            </section>

            <section className="section" aria-labelledby="all-quotes-title">
              <div className="section-head">
                <h2 id="all-quotes-title">全部报价</h2>
                <p>按品类列出规格、地域、价格区间与涨跌；全国参考价单独标注，不与现货分档混同。</p>
              </div>
              {data.categories.map((category) => (
                <CategoryBlock key={category.id} category={category} latestQuoteDate={data.latestQuoteDate} />
              ))}
            </section>
          </>
        )}
      </div>
      <SiteFooter info={footerInfoFromBriefing(data)} />
    </main>
  );
}