import type { ChangeView } from './briefing-data';

/**
 * 用户界面的展示格式化（GUA-33）。
 * 只做格式化与方向判断，不做任何数值修正：所有报价、涨跌均来自查询层原值。
 */

export type Direction = 'up' | 'down' | 'flat';

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
}

export function formatRange(low: number, high: number): string {
  return `${formatNumber(low)} – ${formatNumber(high)}`;
}

export function directionOf(pct: number): Direction {
  if (pct > 0) return 'up';
  if (pct < 0) return 'down';
  return 'flat';
}

export function signedPct(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function arrowOf(direction: Direction): string {
  if (direction === 'up') return '▲';
  if (direction === 'down') return '▼';
  return '◆';
}

export function directionWord(direction: Direction): string {
  if (direction === 'up') return '上涨';
  if (direction === 'down') return '下跌';
  return '持平';
}

/** 涨跌单元格：缺失不当作持平（返回 none，界面显示「—」）。 */
export type ChangeDisplay =
  | { direction: Direction; text: string; arrow: string; available: true }
  | { direction: 'none'; text: '—'; arrow: ''; available: false };

export function changeDisplay(change: ChangeView | null): ChangeDisplay {
  if (!change) return { direction: 'none', text: '—', arrow: '', available: false };
  const direction = directionOf(change.pct);
  return {
    direction,
    text: signedPct(change.pct),
    arrow: arrowOf(direction),
    available: true,
  };
}

/** 可信度呈现为结论（不暴露方法版本 / 权重 / 抓取过程）。 */
export function confidenceLabel(confidence: string): string {
  if (confidence === 'high') return '置信度高';
  if (confidence === 'medium') return '置信度中';
  if (confidence === 'low') return '置信度低';
  return '置信度待核';
}

export function validationLabel(status: string): string {
  if (status === 'published') return '已校验';
  if (status === 'draft') return '待校验';
  return '需复核';
}

/** 数据更新于（Asia/Shanghai，HH:MM）。 */
export function formatUpdateTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

/** 数据更新于（Asia/Shanghai，YYYY-MM-DD HH:MM），用于较长的说明。 */
export function formatUpdateDateTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

/** 序列首末变化（真实计算值，仅用于描述历史，不做外推）。 */
export function seriesChange(values: number[]): { direction: Direction; pct: number } | null {
  if (values.length < 2) return null;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  if (first === 0) return { direction: last === 0 ? 'flat' : 'up', pct: 0 };
  const pct = Math.round(((last - first) / first) * 10000) / 100;
  return { direction: directionOf(pct), pct };
}