import Link from 'next/link';
import { Sparkline } from '@/components/Sparkline';
import type { CategoryCardData, CategoryQuoteView } from '@/lib/category-overview';
import { arrowOf, directionOf, formatNumber, signedPct } from '@/lib/presentation';
import type { ChangeView } from '@/lib/briefing-data';

/**
 * 首页品类卡片：一张卡 = 一个品类。
 * 数字全部由 loadCategoryOverview 从 price_daily 读出；缺层级时写「待接入」。
 */

function Change(props: { change: ChangeView | null; label: string }) {
  const { change, label } = props;
  if (!change) {
    return (
      <span className="cat-change none">
        —<small>{label}</small>
      </span>
    );
  }
  const direction = directionOf(change.pct);
  return (
    <span className={`cat-change ${direction}`}>
      <span>
        <span aria-hidden="true">{arrowOf(direction)}</span> {signedPct(change.pct)}
      </span>
      <small>{label}</small>
    </span>
  );
}

function QuoteRow(props: { label: string; quote: CategoryQuoteView | null }) {
  const { label, quote } = props;
  return (
    <div className="cat-row">
      <span className="cat-row-label">{label}</span>
      {quote ? (
        <>
          <span className="cat-row-name">{quote.regionName}</span>
          <span className="cat-row-price num">
            {formatNumber(quote.value)}
            <small>{quote.unit}</small>
          </span>
          <Change change={quote.dayChange} label="日涨跌" />
        </>
      ) : (
        <span className="cat-row-pending">待接入</span>
      )}
    </div>
  );
}

export function CategoryCards(props: { categories: CategoryCardData[] }) {
  const { categories } = props;
  if (categories.length === 0) {
    return (
      <div className="t-empty">
        <h2>品类行情：待接入</h2>
        <p>目前没有启用的品类。页面不会用估算值或示例价填充；接入后这里按品类展示全球、全国与地区报价。</p>
      </div>
    );
  }

  return (
    <section className="cat-grid" aria-label="品类行情">
      {categories.map((category) => {
        const main = category.national;
        return (
          <Link
            key={category.code}
            className="cat-card"
            href={`/c/${category.code}`}
            aria-label={`${category.name} 品类详情`}
          >
            <header className="cat-card-head">
              <div className="cat-card-title">
                <h2>{category.name}</h2>
                <span className="cat-code">{category.code}</span>
              </div>
              <span className="cat-status" title="品类已启用" aria-hidden="true" />
              {category.hasDemo ? <span className="cat-demo">演示数据</span> : null}
            </header>

            <div className="cat-main">
              {main ? (
                <>
                  <span className="cat-main-value">{formatNumber(main.value)}</span>
                  <span className="cat-main-unit">{main.unit}</span>
                </>
              ) : (
                <span className="cat-main-pending">待接入</span>
              )}
            </div>

            <div className="cat-main-changes">
              <Change change={category.dayChange} label="日涨跌" />
              <Change change={category.weekChange} label="周涨跌" />
              <span className="cat-main-date">{main ? main.date : '—'}</span>
            </div>

            <div className="cat-rows">
              <QuoteRow label="全球" quote={category.global} />
              <QuoteRow label="全国" quote={category.national} />
              <QuoteRow label="地区" quote={category.regional} />
            </div>

            <div className="cat-spark">
              {category.spark.length > 1 ? (
                <Sparkline
                  trend={category.spark}
                  title={`${category.name} 最近 30 个点`}
                  width={320}
                  height={52}
                  showGrid
                />
              ) : (
                <span className="cat-spark-empty">暂无连续走势</span>
              )}
            </div>

            <footer className="cat-card-foot">
              <span>
                最新 {category.latestDate ?? '—'} · 来源 {category.sourceCount}
              </span>
              <span className="cat-open">查看详情 →</span>
            </footer>
          </Link>
        );
      })}
    </section>
  );
}