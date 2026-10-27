'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Sparkline } from '@/components/Sparkline';
import type {
  MarketChange,
  MarketOverview,
  MarketRow,
  MarketScope,
  MarketRegionFacet,
} from '@/lib/market-types';
import { SCOPE_LABEL } from '@/lib/market-types';
import { arrowOf, directionOf, formatNumber, signedPct } from '@/lib/presentation';

/**
 * 行情总览（行情台 v3）—— 股票式列表。
 *
 * 所有数字由 RSC 从库里读出后传入；本组件只做展示、页签与前端筛选。
 * 区域层没有数据时明确显示「待接入」，不拿其他层级的数据顶替。
 */

const SCOPES: MarketScope[] = ['international', 'domestic', 'regional'];

function ChangeCell(props: { change: MarketChange | null; frequency: string; label: string }) {
  const { change, frequency, label } = props;
  if (frequency === 'monthly') {
    return (
      <span className="t-change none">
        —
        <small>月频不适用</small>
      </span>
    );
  }
  if (!change) {
    return (
      <span className="t-change none">
        —
        <small>无可比</small>
      </span>
    );
  }
  const direction = directionOf(change.pct);
  return (
    <span className={`t-change ${direction}`}>
      <span>
        <span aria-hidden="true">{arrowOf(direction)}</span> {signedPct(change.pct)}
      </span>
      <small>{label}</small>
    </span>
  );
}

function Row(props: { row: MarketRow }) {
  const { row } = props;
  return (
    <tr>
      <td className="t-name">
        <Link className="t-row-link" href={`/m/${row.slug}`}>
          <span className="t-row-cat">{row.instrument}</span>
          <span className="t-row-spec">{row.spec}</span>
        </Link>
      </td>
      <td className="t-market-cell">
        <span className="t-row-market">
          {row.market}
          <small>
            {row.frequencyLabel}
            {row.currency === 'USD' ? ' · USD' : ''}
          </small>
        </span>
      </td>
      <td className="num t-price-cell">
        <span className="t-price">
          {row.latestValue === null ? '—' : formatNumber(row.latestValue)}
          <small>{row.unit}</small>
        </span>
      </td>
      <td className="num t-change-cell">
        <ChangeCell change={row.dayChange} frequency={row.frequency} label="较上一交易日" />
      </td>
      <td className="num t-change-cell">
        <ChangeCell change={row.weekChange} frequency={row.frequency} label="较上周" />
      </td>
      <td className="t-time-cell">
        <span className="t-time">{row.updatedAt ?? '—'}</span>
      </td>
      <td className="num t-count-cell">
        <span className="t-count">{formatNumber(row.pointCount)}</span>
      </td>
      <td className="t-trust-cell">
        <span className={`t-trust t-trust-${row.trust}`}>{row.trustLabel}</span>
      </td>
      <td className="t-spark-cell">
        <span className="t-spark">
          {row.spark.length > 1 ? (
            <Sparkline trend={row.spark} title={`${row.instrument} ${row.spec} 最近 30 个点`} width={128} height={30} />
          ) : (
            <span className="t-spark-empty">单点</span>
          )}
        </span>
      </td>
      <td className="t-open-cell">
        <Link className="t-open" href={`/m/${row.slug}`} aria-label={`打开 ${row.instrument} ${row.spec}`}>
          →
        </Link>
      </td>
    </tr>
  );
}

function RegionalEmpty(props: { regions: MarketRegionFacet[] }) {
  return (
    <div>
      <div className="t-empty">
        <h2>区域现货：待接入</h2>
        <p>
          区域分档现货目前没有可展示的已发布数据。这里不会用全国参考锚点、期货结算价或估算值顶替，
          也不会把缺失当作持平。数据接入后，本页按市场显示最新价、涨跌与更新日期。
        </p>
      </div>
      <div className="t-region-grid">
        {props.regions.map((region) => (
          <article className="t-region-card" key={region.code}>
            <h3>{region.name}</h3>
            <p>已发布区域报价 0 条</p>
            <span className="pending">待接入</span>
          </article>
        ))}
      </div>
    </div>
  );
}

export function OverviewView(props: {
  data: MarketOverview;
  initialQuery?: string;
  initialCategory?: string;
  initialScope?: MarketScope;
}) {
  const { data } = props;
  const [scope, setScope] = useState<MarketScope>(props.initialScope ?? 'domestic');
  const [category, setCategory] = useState<string>(props.initialCategory ?? 'all');
  const [query, setQuery] = useState(props.initialQuery ?? '');

  const scopeCounts = useMemo(() => {
    const counts: Record<MarketScope, number> = { international: 0, domestic: 0, regional: 0 };
    for (const row of data.rows) counts[row.scope] += 1;
    return counts;
  }, [data.rows]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (row.scope !== scope) return false;
      if (category !== 'all' && row.categoryCode !== category) return false;
      if (!needle) return true;
      return [row.instrument, row.spec, row.market, row.categoryName ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [data.rows, scope, category, query]);

  const categoryLabel =
    category === 'all' ? '全部品类' : (data.categories.find((item) => item.code === category)?.name ?? '全部品类');

  return (
    <section className="t-terminal" aria-label="行情总览">
      <div className="t-toolbar">
        <div className="t-tabs" role="tablist" aria-label="行情范围">
          {SCOPES.map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={scope === item}
              onClick={() => setScope(item)}
            >
              {SCOPE_LABEL[item]}
              <span className="t-tab-count">{scopeCounts[item]}</span>
            </button>
          ))}
        </div>

        <div className="t-filters" aria-label="品类筛选">
          <button
            type="button"
            className="t-chip"
            aria-pressed={category === 'all'}
            onClick={() => setCategory('all')}
          >
            全部
          </button>
          {data.categories.map((item) => (
            <button
              key={item.code}
              type="button"
              className="t-chip"
              aria-pressed={category === item.code}
              onClick={() => setCategory(item.code)}
            >
              {item.name}
              <span className="t-tab-count">{item.count}</span>
            </button>
          ))}
          {query ? (
            <button type="button" className="t-chip" aria-pressed onClick={() => setQuery('')}>
              搜索「{query}」×
            </button>
          ) : null}
        </div>

        <div className="t-toolbar-meta">
          <span>
            {categoryLabel} · {rows.length} 行
          </span>
          <span className="t-legend" aria-label="涨跌颜色图例">
            <span className="up">▲ 涨</span>
            <span className="down">▼ 跌</span>
          </span>
        </div>
      </div>

      <div className="w-rail w-rail-inline" aria-hidden="true" />

      {scope === 'regional' && rows.length === 0 ? (
        <RegionalEmpty regions={data.regions} />
      ) : rows.length === 0 ? (
        <div className="t-empty">
          <h2>该筛选下暂无行情</h2>
          <p>没有就是没有：不补点、不插值，也不拿其他品类或其他层级的数据顶替。</p>
        </div>
      ) : (
        <div className="t-table-wrap">
          <table className="t-table">
            <thead>
              <tr>
                <th scope="col">品类 / 规格</th>
                <th scope="col">市场</th>
                <th scope="col" className="num">
                  最新价
                </th>
                <th scope="col" className="num">
                  日涨跌
                </th>
                <th scope="col" className="num">
                  周涨跌
                </th>
                <th scope="col">更新</th>
                <th scope="col" className="num">
                  数据点
                </th>
                <th scope="col">可信</th>
                <th scope="col">近 30 点</th>
                <th scope="col">
                  <span className="sr-only">打开</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}