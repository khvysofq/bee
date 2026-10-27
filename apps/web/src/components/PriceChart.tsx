'use client';

import { useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { MarketSparkPoint } from '@/lib/market-types';
import { formatNumber, seriesChange } from '@/lib/presentation';

/**
 * 自绘 SVG 折线图（不引图表库）。
 *
 * 只连接真实存在的观测点：不插值、不补日期。范围切换是前端切片，
 * 数据本身仍来自 series_point / daily_quote。
 * 线用中性色，荧光信号绿只出现在末点与 hover 十字线（标记/交互，不表达涨跌）。
 */

const RANGES = [
  { key: '1m', label: '1M', days: 31 },
  { key: '3m', label: '3M', days: 92 },
  { key: '1y', label: '1Y', days: 365 },
  { key: '2y', label: '2Y', days: 730 },
  { key: 'all', label: '全部', days: null },
] as const;

type RangeKey = (typeof RANGES)[number]['key'];

const W = 760;
const H = 300;
/*
 * 左右留白按最长轴标签预留：左侧要放下「15,800」这类带千分位的读数，
 * 右侧要放下「2026-10」这类完整月份，避免文字被 viewBox 裁掉。
 */
const PAD = { left: 64, right: 30, top: 16, bottom: 34 };
const Y_INTERVALS = 4;

function sliceByRange(points: MarketSparkPoint[], range: RangeKey): MarketSparkPoint[] {
  const config = RANGES.find((item) => item.key === range);
  if (!config || config.days === null || points.length === 0) return points;
  const last = points[points.length - 1]!;
  const cutoff = new Date(new Date(`${last.date}T00:00:00Z`).getTime() - config.days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const sliced = points.filter((point) => point.date >= cutoff);
  // 范围切完若只剩一个点，仍返回该点；图表层会显示「单点不连线」。
  return sliced.length > 0 ? sliced : points.slice(-1);
}

/**
 * Y 轴刻度：在 [min, max] 上均分 4 段（5 条网格线），端点取真实 min/max。
 * 价格跨度 ≥ 1 时取整；小跨度保留两位小数，格式与主价一致（千分位）。
 */
function buildYTicks(min: number, max: number, span: number): number[] {
  const lo = min;
  const hi = max > min ? max : min + span;
  const decimals = span >= 1 ? 0 : 2;
  const ticks = Array.from({ length: Y_INTERVALS + 1 }, (_, index) => {
    if (index === 0) return lo;
    if (index === Y_INTERVALS) return hi;
    return lo + (span * index) / Y_INTERVALS;
  }).map((value) => Number(value.toFixed(decimals)));
  // 极小跨度取整后可能重合；去重后仍按比例定位，不为凑数造刻度。
  return ticks.filter((value, index) => index === 0 || value !== ticks[index - 1]);
}

function shortDate(date: string, range: RangeKey): string {
  if (range === '1m' || range === '3m') return date.slice(5);
  return date.slice(0, 7);
}

export function PriceChart(props: {
  points: MarketSparkPoint[];
  unit: string;
  title: string;
  tone?: 'dark' | 'light';
  defaultRange?: RangeKey;
}) {
  const { points, unit, title } = props;
  const tone = props.tone ?? 'dark';
  const [range, setRange] = useState<RangeKey>(props.defaultRange ?? '1y');
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const clipId = useId();

  const visible = useMemo(() => sliceByRange(points, range), [points, range]);
  const values = visible.map((point) => point.value);
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 1;
  const span = max - min || Math.max(Math.abs(max), 1) * 0.02;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const xAt = (index: number): number =>
    visible.length === 1 ? PAD.left + plotW / 2 : PAD.left + (index * plotW) / (visible.length - 1);
  const yAt = (value: number): number => PAD.top + plotH - ((value - min) / span) * plotH;

  const line = visible
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${xAt(index).toFixed(2)},${yAt(point.value).toFixed(2)}`)
    .join(' ');
  const area = visible.length
    ? `${line} L${xAt(visible.length - 1).toFixed(2)},${(PAD.top + plotH).toFixed(2)} L${xAt(0).toFixed(2)},${(
        PAD.top + plotH
      ).toFixed(2)} Z`
    : '';

  const yTicks = buildYTicks(min, max, span).map((value) => ({
    value,
    y: PAD.top + plotH - ((value - min) / span) * plotH,
  }));
  const xTickCount = Math.min(5, visible.length);
  const xTicks = Array.from({ length: xTickCount }, (_, index) => {
    const pointIndex =
      xTickCount === 1 ? 0 : Math.round((index * (visible.length - 1)) / (xTickCount - 1));
    const point = visible[pointIndex];
    return point ? { label: shortDate(point.date, range), x: xAt(pointIndex) } : null;
  }).filter((tick): tick is { label: string; x: number } => tick !== null);

  const change = seriesChange(values);
  const lastPoint = visible[visible.length - 1] ?? null;
  const active = hover !== null ? visible[hover] ?? null : lastPoint;

  function onMove(event: ReactPointerEvent<SVGSVGElement>) {
    if (!svgRef.current || visible.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const x = ratio * W;
    const raw = ((x - PAD.left) / plotW) * (visible.length - 1);
    const index = Math.max(0, Math.min(visible.length - 1, Math.round(raw)));
    setHover(index);
  }

  return (
    <div className={`t-chart ${tone === 'light' ? 't-chart-light' : ''}`}>
      <div className="t-chart-head">
        <span className="t-chart-title">{title}</span>
        <div className="t-ranges" role="group" aria-label="时间范围">
          {RANGES.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={range === item.key}
              onClick={() => {
                setRange(item.key);
                setHover(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {visible.length < 2 ? (
        <p className="t-chart-empty">
          {visible.length === 1
            ? '只有一个数据点；单点不连成趋势，也不补点、不插值。'
            : '当前范围没有数据点。'}
        </p>
      ) : (
        <>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${title}，${visible.length} 个数据点，${visible[0]!.date} 至 ${
              visible[visible.length - 1]!.date
            }`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD.left} y={PAD.top} width={plotW} height={plotH} />
              </clipPath>
            </defs>

            {yTicks.map((tick) => (
              <g key={tick.y}>
                <line
                  className="t-chart-grid"
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={tick.y}
                  y2={tick.y}
                />
                <text className="t-chart-axis" x={PAD.left - 8} y={tick.y + 3} textAnchor="end">
                  {formatNumber(tick.value)}
                </text>
              </g>
            ))}

            {xTicks.map((tick, index) => (
              <g key={`${tick.label}-${tick.x}`}>
                <line
                  className="t-chart-grid"
                  x1={tick.x}
                  x2={tick.x}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                />
                <text
                  className="t-chart-axis"
                  x={tick.x}
                  y={H - 12}
                  textAnchor={
                    index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'
                  }
                >
                  {tick.label}
                </text>
              </g>
            ))}

            <g clipPath={`url(#${clipId})`}>
              <path className="t-chart-area" d={area} />
              <path className="t-chart-line" d={line} />
            </g>

            <circle
              className="t-chart-dot"
              cx={xAt(visible.length - 1)}
              cy={yAt(visible[visible.length - 1]!.value)}
              r={3.4}
            />

            {hover !== null && active ? (
              <>
                <line
                  className="t-chart-cross"
                  x1={xAt(hover)}
                  x2={xAt(hover)}
                  y1={PAD.top}
                  y2={PAD.top + plotH}
                />
                <circle className="t-chart-dot" cx={xAt(hover)} cy={yAt(active.value)} r={3} />
              </>
            ) : null}
          </svg>

          <div className="t-chart-tip">
            <strong>{active ? `${formatNumber(active.value)} ${unit}` : '—'}</strong>
            <span>{active?.date ?? '—'}</span>
            {change ? (
              <span>
                区间 {change.direction === 'up' ? '▲' : change.direction === 'down' ? '▼' : '◆'}{' '}
                {change.pct > 0 ? '+' : ''}
                {change.pct.toFixed(2)}%
              </span>
            ) : null}
            <span>{visible.length} 个点 · 不插值</span>
          </div>
        </>
      )}
    </div>
  );
}