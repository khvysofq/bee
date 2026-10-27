import { DEFAULT_TZ } from './types';

/**
 * 「随机窗口」调度（ADR-0010 的补充）：每天在 [windowStart, windowEnd) 里挑一个整分钟执行。
 *
 * 为什么需要：固定时刻（如 07:20）连续请求同一站点，是最容易被识别成爬虫的模式，也会把
 * 对方服务器压力压在同一个点上。随机窗口把时间摊开，同时保持「每天只跑一次」。
 *
 * 设计要求：
 *  - **确定性**：同一 job + 同一天 → 同一分钟。重跑对账不会换时间，台账可复现。
 *  - **无状态**：不存"下次几点"，只靠 (code, date) 哈希现算；调度器重启不影响排期。
 *  - **幂等**：执行仍以 job_run(job_code, scheduled_for) 唯一键兜底。
 */

export interface RandomWindowSchedule {
  mode: 'random_window';
  /** HH:MM，24 小时制，按 tz 解释。 */
  windowStart: string;
  windowEnd: string;
  tz?: string;
  enabled?: boolean;
}

export function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** 本地日期与「当天第几分钟」——用 Intl 做时区换算，避免依赖服务器时区。 */
export function localDateAndMinutes(now: Date, tz: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** FNV-1a：短、稳定、无依赖；只用来在窗口里挑分钟，不做安全用途。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 某任务在某天应执行的分钟（自本地零点起算）。窗口按左闭右开。 */
export function randomMinuteFor(
  code: string,
  dateISO: string,
  windowStart: number,
  windowEnd: number,
): number {
  const span = windowEnd - windowStart;
  if (span <= 0) return windowStart;
  return windowStart + (fnv1a(`${code}|${dateISO}`) % span);
}

/** 某时刻在目标时区的 UTC 偏移（分钟），如上海 = +480。 */
function offsetMinutesAt(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * 把「本地日期 + 当地分钟」换回真实时间点。
 *
 * 先把墙上时间当成 UTC 算一个猜测值，再减去该时刻的时区偏移。中国无夏令时，
 * 一步校正足够；有夏令时的时区误差上限是一小时，且只在切换当天出现。
 */
export function dateAtLocalMinutes(_now: Date, tz: string, dateISO: string, minutes: number): Date {
  const [year, month, day] = dateISO.split('-').map(Number);
  const wallClock = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1) + minutes * 60_000;
  const guess = new Date(wallClock);
  return new Date(wallClock - offsetMinutesAt(guess, tz) * 60_000);
}

/** 下一次执行时间；窗口非法时返回 null。 */
export function nextRandomRun(
  code: string,
  now: Date,
  schedule: RandomWindowSchedule,
): Date | null {
  const start = parseHHMM(schedule.windowStart);
  const end = parseHHMM(schedule.windowEnd);
  if (start === null || end === null || end <= start) return null;
  const tz = schedule.tz ?? DEFAULT_TZ;
  const { date, minutes } = localDateAndMinutes(now, tz);
  const todayTarget = randomMinuteFor(code, date, start, end);
  if (todayTarget > minutes) return dateAtLocalMinutes(now, tz, date, todayTarget);
  const tomorrow = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return dateAtLocalMinutes(now, tz, tomorrow, randomMinuteFor(code, tomorrow, start, end));
}

/** 今天应执行的分钟；已过则返回 null（调度器据此判断要不要入队）。 */
export function dueMinuteToday(
  code: string,
  now: Date,
  schedule: RandomWindowSchedule,
): { date: string; minutes: number; due: boolean } | null {
  const start = parseHHMM(schedule.windowStart);
  const end = parseHHMM(schedule.windowEnd);
  if (start === null || end === null || end <= start) return null;
  const tz = schedule.tz ?? DEFAULT_TZ;
  const { date, minutes } = localDateAndMinutes(now, tz);
  const target = randomMinuteFor(code, date, start, end);
  return { date, minutes: target, due: minutes >= target };
}