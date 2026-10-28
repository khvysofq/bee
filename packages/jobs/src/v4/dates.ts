/**
 * 内容管线日期工具：一律以 Asia/Shanghai 的「日历日」为准。
 *
 * 库里日期列是 date（无时区），避免用本地时区 / UTC 直接格式化造成跨日偏差。
 */

const SHANGHAI_TZ = 'Asia/Shanghai';

const DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 某个时刻在上海时区的日期，格式 YYYY-MM-DD。 */
export function dateInShanghai(now: Date = new Date()): string {
  return DATE_FMT.format(now);
}

/** 纯日历日加减（UTC 算术，不引入时区）。 */
export function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`日期格式不合法：${date}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function isDateString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}