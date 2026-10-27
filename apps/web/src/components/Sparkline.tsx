import type { TrendPoint } from '@/lib/landing-data';
import { formatNumber } from '@/lib/presentation';

/**
 * 纯 SVG 走势线（不引图表库）：点位来自 daily_quote 已发布中值的真实序列。
 * 颜色只表达历史方向（涨红 / 跌绿 / 平灰），不表达未来。
 */
export function Sparkline(props: {
  trend: TrendPoint[];
  title: string;
  width?: number;
  height?: number;
  tone?: 'light' | 'dark';
  showGrid?: boolean;
}) {
  const { trend, title } = props;
  if (trend.length === 0) return null;

  const W = props.width ?? 160;
  const H = props.height ?? 40;
  const PAD = 4;
  const values = trend.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const first = trend[0]!;
  const last = trend[trend.length - 1]!;
  const direction = last.value > first.value ? 'up' : last.value < first.value ? 'down' : 'flat';
  const xAt = (index: number): number =>
    trend.length === 1 ? W / 2 : PAD + (index * (W - 2 * PAD)) / (trend.length - 1);
  const yAt = (value: number): number =>
    span === 0 ? H / 2 : H - PAD - ((value - min) * (H - 2 * PAD)) / span;
  const points = trend
    .map((point, index) => `${xAt(index).toFixed(1)},${yAt(point.value).toFixed(1)}`)
    .join(' ');
  const lastX = xAt(trend.length - 1);
  const lastY = yAt(last.value);
  const detail = trend.map((point) => `${point.date}：${formatNumber(point.value)} 元/吨`).join('；');

  return (
    <svg
      className={`spark spark-${props.tone ?? 'light'} spark-${direction}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${title}，${trend.length} 个报价日：${detail}`}
    >
      <title>{`${title}｜${detail}`}</title>
      {props.showGrid ? (
        <>
          <line className="spark-grid" x1="0" y1={PAD} x2={W} y2={PAD} />
          <line className="spark-grid" x1="0" y1={H / 2} x2={W} y2={H / 2} />
          <line className="spark-grid" x1="0" y1={H - PAD} x2={W} y2={H - PAD} />
        </>
      ) : null}
      {trend.length > 1 ? (
        <polyline className="spark-line" points={points} vectorEffect="non-scaling-stroke" />
      ) : null}
      <circle className="spark-dot" cx={lastX} cy={lastY} r={2.6} />
    </svg>
  );
}