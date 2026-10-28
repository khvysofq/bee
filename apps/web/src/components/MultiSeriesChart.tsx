'use client';

import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CategorySeries } from '@/lib/category-detail';
import { arrowOf, directionOf, formatNumber, signedPct } from '@/lib/presentation';

/**
 * 多序列 SVG 折线图（品类详情主图）。
 *
 * 只连接真实存在的观测点：不插值、不补日期；序列之间的日期按时间轴对齐，
 * hover 显示同一日期各线的值，缺失写「—」。多渠道用现有 token 色 + 虚线区分。
 */

type RangeKey = '1m' | '3m' | '1y' | 'all';
type LevelKey = 'global' | 'country' | 'region';

const RANGES: Array<{ key: RangeKey; label: string; days: number | null }> = [
  { key: '1m', label: '1M', days: 31 },
  { key: '3m', label: '3M', days: 92 },
  { key: '1y', label: '1Y', days: 365 },
  { key: 'all', label: '全部', days: null },
];

const LEVELS: Array<{ key: LevelKey; label: string }> = [
  { key: 'global', label: '全球' },
  { key: 'country', label: '全国' },
  { key: 'region', label: '地区' },
];

const W = 780;
const H = 320;
const PAD = { left: 66, right: 24, top: 18, bottom: 36 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;
const MAX_REGION_LINES = 4;
const DAY_MS = 86_400_000;

interface LinePoint {
  date: string;
  value: number;
}

function daysAgo(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function shortDate(date: string): string {
  return date.slice(5);
}

function lineLabel(series: CategorySeries): string {
  const spec = series.specName === '品类级' ? '' : ` · ${series.specName}`;
  return `${series.regionName}${spec}`;
}

export function MultiSeriesChart(props: { series: CategorySeries[]; unitFallback: string }) {
  const { series } = props;
  const [range, setRange] = useState<RangeKey>('3m');
  const [level, setLevel] = useState<LevelKey>('region');
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => {
    const regional = series
      .filter((item) => ['province', 'city', 'market'].includes(item.level))
      .sort((a, b) => b.latestValue - a.latestValue || b.pointCount - a.pointCount);
    return regional.slice(0, 3).map((item) => item.key);
  });
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  const levelSeries = useMemo(() => {
    if (level === 'global') return series.filter((item) => item.level === 'global');
    if (level === 'country') return series.filter((item) => item.level === 'country');
    return series.filter(
      (item) =>
        ['province', 'city', 'market'].includes(item.level) && selectedKeys.includes(item.key),
    );
  }, [level, selectedKeys, series]);

  const regionOptions = useMemo(
    () =>
      series
        .filter((item) => ['province', 'city', 'market'].includes(item.level))
        .sort((a, b) => b.latestValue - a.latestValue || b.pointCount - a.pointCount),
    [series],
  );

  const maxDate = useMemo(() => {
    let latest: string | null = null;
    for (const item of levelSeries) {
      if (!latest || item.latestDate > latest) latest = item.latestDate;
    }
    return latest;
  }, [levelSeries]);

  const visible = useMemo(() => {
    const config = RANGES.find((item) => item.key === range);
    return levelSeries
      .map((item) => {
        if (!config?.days || !maxDate) return { series: item, points: item.points };
        const cutoff = daysAgo(maxDate, config.days);
        const points = item.points.filter((point) => point.date >= cutoff);
        return { series: item, points: points.length > 0 ? points : item.points.slice(-1) };
      })
      .filter((item) => item.points.length > 0);
  }, [levelSeries, maxDate, range]);

  const dates = useMemo(() => {
    const set = new Set<string>();
    for (const line of visible) for (const point of line.points) set.add(point.date);
    return [...set].sort();
  }, [visible]);

  const values = useMemo(
    () => visible.flatMap((line) => line.points.map((point) => point.value)),
    [visible],
  );

  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;
  const span = max - min || Math.max(Math.abs(max), 1) * 0.02;

  const minTime = dates.length > 0 ? Date.parse(`${dates[0]}T00:00:00Z`) : 0;
  const maxTime = dates.length > 0 ? Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) : 0;
  const timeSpan = maxTime - minTime || DAY_MS;

  const xAt = (date: string): number =>
    dates.length <= 1
      ? PAD.left + PLOT_W / 2
      : PAD.left + ((Date.parse(`${date}T00:00:00Z`) - minTime) / timeSpan) * PLOT_W;
  const yAt = (value: number): number => PAD.top + PLOT_H - ((value - min) / span) * PLOT_H;

  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = index === 4 ? max : min + (span * index) / 4;
    return { value, y: yAt(value) };
  });

  const xTickCount = Math.min(5, dates.length);
  const xTicks = Array.from({ length: xTickCount }, (_, index) => {
    const dateIndex =
      xTickCount === 1 ? 0 : Math.round((index * (dates.length - 1)) / (xTickCount - 1));
    const date = dates[dateIndex];
    return date ? { date, x: xAt(date) } : null;
  }).filter((tick): tick is { date: string; x: number } => tick !== null);

  const hover = hoverDate
    ? {
        date: hoverDate,
        x: xAt(hoverDate),
        rows: visible.map((line) => ({
          series: line.series,
          point: line.points.find((point) => point.date === hoverDate) ?? null,
        })),
      }
    : null;

  function onMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!svgRef.current || dates.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const time = minTime + ratio * timeSpan;
    let nearest = dates[0]!;
    let distance = Infinity;
    for (const date of dates) {
      const delta = Math.abs(Date.parse(`${date}T00:00:00Z`) - time);
      if (delta < distance) {
        distance = delta;
        nearest = date;
      }
    }
    setHoverDate(nearest);
  }

  function toggleRegion(key: string) {
    setSelectedKeys((current) => {
      if (current.includes(key)) return current.filter((item) => item !== key);
      if (current.length >= MAX_REGION_LINES) return current;
      return [...current, key];
    });
  }

  const unit = visible[0]?.series.unit ?? props.unitFallback;

  return (
    <div className="cd-chart">
      <div className="cd-chart-head">
        <div className="cd-ranges" role="group" aria-label="时间范围">
          {RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={range === item.key}
              onClick={() => {
                setRange(item.key);
                setHoverDate(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="cd-levels" role="group" aria-label="价格层级">
          {LEVELS.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={level === item.key}
              onClick={() => {
                setLevel(item.key);
                setHoverDate(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {level === 'region' ? (
        <div className="cd-region-chips" role="group" aria-label="选择地区（最多 4 条）">
          {regionOptions.map((item) => {
            const checked = selectedKeys.includes(item.key);
            const disabled = !checked && selectedKeys.length >= MAX_REGION_LINES;
            return (
              <button
                key={item.key}
                type="button"
                className="cd-chip"
                aria-pressed={checked}
                disabled={disabled}
                onClick={() => toggleRegion(item.key)}
              >
                {lineLabel(item)}
              </button>
            );
          })}
        </div>
      ) : null}

      {visible.length === 0 || dates.length === 0 ? (
        <p className="cd-chart-empty">当前层级没有可展示的价格序列；不补点、不插值。</p>
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`多序列价格走势，${visible.length} 条线，${dates[0]} 至 ${dates[dates.length - 1]}`}
            onPointerMove={onMove}
            onPointerLeave={() => setHoverDate(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD.left} y={PAD.top} width={PLOT_W} height={PLOT_H} />
              </clipPath>
            </defs>

            {yTicks.map((tick) => (
              <g key={tick.y}>
                <line
                  className="cd-chart-grid"
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={tick.y}
                  y2={tick.y}
                />
                <text className="cd-axis" x={PAD.left - 8} y={tick.y + 3} textAnchor="end">
                  {formatNumber(Number(tick.value.toFixed(2)))}
                </text>
              </g>
            ))}

            {xTicks.map((tick, index) => (
              <text
                key={tick.date}
                className="cd-axis"
                x={tick.x}
                y={H - 12}
                textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}
              >
                {shortDate(tick.date)}
              </text>
            ))}

            <g clipPath={`url(#${clipId})`}>
              {visible.map((line, index) => {
                let path = '';
                let previousTime: number | null = null;
                for (const point of line.points) {
                  const time = Date.parse(`${point.date}T00:00:00Z`);
                  const x = xAt(point.date).toFixed(2);
                  const y = yAt(point.value).toFixed(2);
                  const broken = previousTime !== null && time - previousTime > 16 * DAY_MS;
                  path += `${path === '' || broken ? 'M' : 'L'}${x},${y} `;
                  previousTime = time;
                }
                return (
                  <path
                    key={line.series.key}
                    className={`cd-line cd-line-${index % 4}`}
                    d={path.trim()}
                    fill="none"
                  />
                );
              })}
            </g>

            {hover ? (
              <line
                className="cd-cross"
                x1={hover.x}
                x2={hover.x}
                y1={PAD.top}
                y2={PAD.top + PLOT_H}
              />
            ) : null}
            {hover
              ? visible.map((line, index) => {
                  const point = line.points.find((item) => item.date === hover.date);
                  return point ? (
                    <circle
                      key={`dot-${line.series.key}`}
                      className={`cd-dot cd-line-${index % 4}`}
                      cx={xAt(point.date)}
                      cy={yAt(point.value)}
                      r={3}
                    />
                  ) : null;
                })
              : null}
          </svg>

          <div className="cd-legend">
            {visible.map((line, index) => {
              const change = line.series.dayChange;
              const direction = change ? directionOf(change.pct) : 'none';
              return (
                <div className="cd-legend-item" key={line.series.key}>
                  <span className={`cd-swatch cd-line-${index % 4}`} aria-hidden="true" />
                  <span className="cd-legend-name">{lineLabel(line.series)}</span>
                  <span className="cd-legend-value num">
                    {formatNumber(line.series.latestValue)}
                    <small>{line.series.unit}</small>
                  </span>
                  <span className={`cd-legend-change ${direction}`}>
                    {change
                      ? `${arrowOf(directionOf(change.pct))} ${signedPct(change.pct)}`
                      : '—'}
                  </span>
                  <span className="cd-legend-count">{line.points.length} 样本</span>
                </div>
              );
            })}
          </div>

          <div className="cd-tip">
            {hover ? (
              <>
                <strong>{hover.date}</strong>
                {hover.rows.map((row) => (
                  <span key={row.series.key}>
                    {lineLabel(row.series)}：
                    {row.point ? `${formatNumber(row.point.value)} ${unit}` : '—'}
                  </span>
                ))}
              </>
            ) : (
              <span>悬停查看同一日期的各线读数；{dates.length} 个日期 · 不插值</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}