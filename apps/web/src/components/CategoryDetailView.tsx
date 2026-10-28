'use client';

import Link from 'next/link';
import { MultiSeriesChart } from '@/components/MultiSeriesChart';
import type {
  CategoryDetail,
  CategorySeries,
  ContentCard,
} from '@/lib/category-detail';
import {
  arrowOf,
  confidenceLabel,
  directionOf,
  formatNumber,
  signedPct,
} from '@/lib/presentation';
import type { ChangeView } from '@/lib/briefing-data';

/**
 * 品类详情（股票式布局）：头部读数 + 多线主图 + 今日快照 / 统计 / 预测 + 通栏表格与内容。
 * 所有数字来自 loadCategoryDetail；空层级明确写「待接入 / 待发布」。
 */

const LEVEL_LABEL: Record<string, string> = {
  global: '全球',
  country: '全国',
  province: '省',
  city: '市',
  market: '市场',
};

function directionWord(direction: string): string {
  if (direction === 'up') return '上涨';
  if (direction === 'down') return '下跌';
  if (direction === 'flat') return '横盘';
  return '待核';
}

function Change(props: { change: ChangeView | null; label: string }) {
  if (!props.change) {
    return (
      <span className="cd-change none">
        —<small>{props.label}</small>
      </span>
    );
  }
  const direction = directionOf(props.change.pct);
  return (
    <span className={`cd-change ${direction}`}>
      <span>
        <span aria-hidden="true">{arrowOf(direction)}</span> {signedPct(props.change.pct)}
      </span>
      <small>{props.label}</small>
    </span>
  );
}

function pickHero(series: CategorySeries[]): CategorySeries | null {
  const national = series.filter((item) => item.level === 'country');
  const pool = national.length > 0 ? national : series.filter((item) => item.level === 'global');
  return (
    [...pool].sort(
      (a, b) => b.pointCount - a.pointCount || (a.latestDate < b.latestDate ? 1 : -1),
    )[0] ?? null
  );
}

function ContentList(props: { items: ContentCard[]; empty: string; label: string }) {
  const { items, empty, label } = props;
  if (items.length === 0) {
    return <p className="cd-empty">{empty}</p>;
  }
  return (
    <div className="cd-content-grid">
      {items.map((item) => (
        <Link className="cd-content-card" key={item.id} href={`/content/${item.id}`}>
          <span className="cd-content-date">{item.contentDate}</span>
          <h3>{item.title}</h3>
          {item.summary ? <p>{item.summary}</p> : null}
          <span className="cd-content-more">
            {label} · 阅读 →
          </span>
        </Link>
      ))}
    </div>
  );
}

export function CategoryDetailView(props: { detail: CategoryDetail }) {
  const { detail } = props;
  const hero = pickHero(detail.series);
  const snapshot = detail.todayRows.slice(0, 8);
  const forecast = detail.contents.forecast[0] ?? null;
  const forecastDirection =
    forecast && typeof forecast.meta.direction === 'string' ? forecast.meta.direction : null;
  const forecastConfidence =
    forecast && typeof forecast.meta.confidence === 'string' ? forecast.meta.confidence : null;

  return (
    <>
      <nav className="cd-crumbs" aria-label="面包屑">
        <Link href="/">行情</Link>
        <span aria-hidden="true">/</span>
        <span>{detail.name}</span>
      </nav>

      <header className="cd-head">
        <div className="cd-head-main">
          <p className="t-eyebrow">CATEGORY / {detail.code}</p>
          <h1>
            {detail.name}
            <span className="cd-code">{detail.code}</span>
          </h1>
          {detail.description ? <p className="cd-desc">{detail.description}</p> : null}
          <p className="cd-head-meta">
            {detail.specs.length} 个规格 · {detail.sourceCount} 个来源 · 最新报价日{' '}
            {detail.latestDate ?? '—'}
            {detail.hasDemo ? <span className="cd-demo">演示数据</span> : null}
          </p>
        </div>
        <div className="cd-hero">
          {hero ? (
            <>
              <span className="cd-hero-label">
                {hero.level === 'country' ? '全国最新' : '全球最新'} · {hero.specName}
              </span>
              <span className="cd-hero-value">
                {formatNumber(hero.latestValue)}
                <small>{hero.unit}</small>
              </span>
              <div className="cd-hero-changes">
                <Change change={hero.dayChange} label="日涨跌" />
                <Change change={hero.weekChange} label="周涨跌" />
              </div>
              <span className="cd-hero-date">
                {hero.regionName} · {hero.latestDate}
              </span>
            </>
          ) : (
            <span className="cd-hero-pending">待接入</span>
          )}
        </div>
      </header>

      <div className="cd-grid">
        <section className="cd-chart-card" aria-labelledby="cd-chart-title">
          <div className="cd-section-head">
            <h2 id="cd-chart-title">价格走势</h2>
            <span className="cd-section-meta">真实观测点 · 不插值</span>
          </div>
          {detail.series.length > 0 ? (
            <MultiSeriesChart series={detail.series} unitFallback={hero?.unit ?? '元/吨'} />
          ) : (
            <p className="cd-empty">暂无价格序列：待接入。</p>
          )}
        </section>

        <aside className="cd-side">
          <section className="cd-side-card" aria-labelledby="cd-snapshot-title">
            <div className="cd-section-head">
              <h2 id="cd-snapshot-title">今日快照</h2>
              <span className="cd-section-meta">{detail.latestDate ?? '—'}</span>
            </div>
            {snapshot.length === 0 ? (
              <p className="cd-empty">今日无报价：待接入。</p>
            ) : (
              <div className="cd-snapshot-scroll">
                <table className="cd-table cd-table-compact">
                  <thead>
                    <tr>
                      <th scope="col">地区</th>
                      <th scope="col">规格</th>
                      <th scope="col" className="num">
                        价格
                      </th>
                      <th scope="col" className="num">
                        日涨跌
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.map((row) => {
                      const direction = row.dayChange ? directionOf(row.dayChange.pct) : 'none';
                      return (
                        <tr key={row.key}>
                          <td>{row.regionName}</td>
                          <td>{row.specName}</td>
                          <td className="num">
                            {formatNumber(row.value)}
                            <small>{row.unit}</small>
                          </td>
                          <td className={`num cd-change-cell ${direction}`}>
                            {row.dayChange
                              ? `${arrowOf(directionOf(row.dayChange.pct))} ${signedPct(row.dayChange.pct)}`
                              : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="cd-side-card" aria-labelledby="cd-stats-title">
            <div className="cd-section-head">
              <h2 id="cd-stats-title">关键统计</h2>
              <span className="cd-section-meta">近 30 个样本</span>
            </div>
            {detail.stats ? (
              <dl className="cd-stats">
                <div>
                  <dt>30 日高</dt>
                  <dd>
                    {formatNumber(detail.stats.high)}
                    <small>{detail.stats.unit}</small>
                  </dd>
                </div>
                <div>
                  <dt>30 日低</dt>
                  <dd>
                    {formatNumber(detail.stats.low)}
                    <small>{detail.stats.unit}</small>
                  </dd>
                </div>
                <div>
                  <dt>30 日均值</dt>
                  <dd>
                    {formatNumber(detail.stats.average)}
                    <small>{detail.stats.unit}</small>
                  </dd>
                </div>
                <div>
                  <dt>样本数</dt>
                  <dd>{detail.stats.sampleCount}</dd>
                </div>
                <div>
                  <dt>口径</dt>
                  <dd className="cd-stats-text">{detail.stats.basis}</dd>
                </div>
                <div>
                  <dt>最新日期</dt>
                  <dd className="cd-stats-text">{detail.stats.latestDate}</dd>
                </div>
              </dl>
            ) : (
              <p className="cd-empty">统计样本不足：待接入。</p>
            )}
          </section>

          <section className="cd-side-card cd-forecast" aria-labelledby="cd-forecast-title">
            <div className="cd-section-head">
              <h2 id="cd-forecast-title">最新预测</h2>
              <span className="cd-section-meta">{forecast?.contentDate ?? '—'}</span>
            </div>
            {forecast ? (
              <>
                <h3>{forecast.title}</h3>
                {forecast.summary ? <p>{forecast.summary}</p> : null}
                <dl className="cd-forecast-meta">
                  <div>
                    <dt>预测期间</dt>
                    <dd>
                      {forecast.periodStart ?? '—'} ~ {forecast.periodEnd ?? '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>方向</dt>
                    <dd>{forecastDirection ? directionWord(forecastDirection) : '待核'}</dd>
                  </div>
                  <div>
                    <dt>置信度</dt>
                    <dd>{forecastConfidence ? confidenceLabel(forecastConfidence) : '待核'}</dd>
                  </div>
                </dl>
                <Link className="cd-more" href={`/content/${forecast.id}`}>
                  阅读预测研报 →
                </Link>
              </>
            ) : (
              <p className="cd-empty">最新预测：待发布。</p>
            )}
          </section>
        </aside>
      </div>

      <section className="cd-wide" aria-labelledby="cd-today-title">
        <div className="cd-section-head">
          <h2 id="cd-today-title">今日价格</h2>
          <span className="cd-section-meta">
            {detail.latestDate ?? '—'} · {detail.todayRows.length} 行
          </span>
        </div>
        {detail.todayRows.length === 0 ? (
          <p className="cd-empty">今日价格：待接入。</p>
        ) : (
          <div className="cd-table-scroll">
            <table className="cd-table">
              <thead>
                <tr>
                  <th scope="col">层级</th>
                  <th scope="col">地区</th>
                  <th scope="col">规格</th>
                  <th scope="col" className="num">
                    价格
                  </th>
                  <th scope="col" className="num">
                    日涨跌
                  </th>
                  <th scope="col">日期</th>
                  <th scope="col">来源</th>
                  <th scope="col">备注</th>
                </tr>
              </thead>
              <tbody>
                {detail.todayRows.map((row) => {
                  const direction = row.dayChange ? directionOf(row.dayChange.pct) : 'none';
                  return (
                    <tr key={row.key}>
                      <td>{LEVEL_LABEL[row.level] ?? row.level}</td>
                      <td>{row.regionName}</td>
                      <td>{row.specName}</td>
                      <td className="num">
                        {formatNumber(row.value)}
                        <small>{row.unit}</small>
                      </td>
                      <td className={`num cd-change-cell ${direction}`}>
                        {row.dayChange
                          ? `${arrowOf(directionOf(row.dayChange.pct))} ${signedPct(row.dayChange.pct)}`
                          : '—'}
                      </td>
                      <td className="cd-mono">{row.date}</td>
                      <td>{row.sourceName ?? '—'}</td>
                      <td className="cd-note">{row.note ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cd-wide" aria-labelledby="cd-news-title">
        <div className="cd-section-head">
          <h2 id="cd-news-title">重大新闻</h2>
          <div className="cd-section-links">
            <span className="cd-section-meta">日报聚合</span>
            <Link className="cd-section-more" href={`/c/${detail.code}/archive?kind=news_digest`}>
              查看全部 →
            </Link>
          </div>
        </div>
        <ContentList items={detail.contents.news_digest} empty="重大新闻：待发布。" label="日报" />
      </section>

      <section className="cd-wide" aria-labelledby="cd-analysis-title">
        <div className="cd-section-head">
          <h2 id="cd-analysis-title">行业分析</h2>
          <div className="cd-section-links">
            <span className="cd-section-meta">每日趋势</span>
            <Link className="cd-section-more" href={`/c/${detail.code}/archive?kind=analysis`}>
              查看全部 →
            </Link>
          </div>
        </div>
        <ContentList items={detail.contents.analysis} empty="行业分析：待发布。" label="分析" />
      </section>

      <section className="cd-wide" aria-labelledby="cd-forecast-list-title">
        <div className="cd-section-head">
          <h2 id="cd-forecast-list-title">预测研报</h2>
          <div className="cd-section-links">
            <span className="cd-section-meta">未来区间</span>
            <Link className="cd-section-more" href={`/c/${detail.code}/archive?kind=forecast`}>
              查看全部 →
            </Link>
          </div>
        </div>
        <ContentList items={detail.contents.forecast} empty="预测研报：待发布。" label="预测" />
      </section>
    </>
  );
}