/**
 * 5 字段 cron 的最小实现（纯函数，无依赖）。
 *
 * 只做两件事：校验表达式、算下一次执行时间。调度本身交给 pg-boss；
 * 这里算出来的时间只用于管理页展示「下次执行」，以及停用后显示为空。
 *
 * 时区通过 Intl 解析，不假设固定偏移；支持 Asia/Shanghai、UTC 等 IANA 时区。
 */

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0/7 = Sunday)
];

function parseField(text: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const token of text.split(',')) {
    const part = token.trim();
    if (!part) return null;
    let rangeText = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      rangeText = part.slice(0, slash);
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step <= 0) return null;
    }
    let low: number;
    let high: number;
    if (rangeText === '*') {
      low = min;
      high = max;
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-');
      if (!/^\d+$/.test(a ?? '') || !/^\d+$/.test(b ?? '')) return null;
      low = Number(a);
      high = Number(b);
    } else {
      if (!/^\d+$/.test(rangeText)) return null;
      low = Number(rangeText);
      high = low;
    }
    if (low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed: Set<number>[] = [];
  for (let i = 0; i < 5; i += 1) {
    const [min, max] = FIELD_RANGES[i]!;
    const value = parseField(fields[i]!, min, max);
    if (!value) return null;
    if (i === 4) {
      // 7 与 0 都表示周日。
      if (value.delete(7)) value.add(0);
    }
    parsed.push(value);
  }
  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  const existing = formatters.get(tz);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  formatters.set(tz, formatter);
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(instantMs: number, tz: string): ZonedParts {
  const parts = formatterFor(tz).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour') % 24,
    minute: value('minute'),
    second: value('second'),
  };
}

/** 某一瞬间在目标时区的偏移（毫秒）；只用于把「本地墙钟」换算成 UTC 瞬间。 */
function offsetMsAt(instantMs: number, tz: string): number {
  const p = zonedParts(instantMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - instantMs;
}

function matchesDay(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domMatch = spec.daysOfMonth.has(day);
  const dowMatch = spec.daysOfWeek.has(dow);
  if (spec.domRestricted && spec.dowRestricted) return domMatch || dowMatch;
  return domMatch && dowMatch;
}

/**
 * 下一次执行时间（严格晚于 from）。找不到（例如 2 月 30 日）返回 null。
 * 最多向后看 370 天；对分钟级 cron 也足够。
 */
export function nextCronRun(expr: string, tz = 'Asia/Shanghai', from: Date = new Date()): Date | null {
  const spec = parseCron(expr);
  if (!spec) return null;
  const localFrom = zonedParts(from.getTime(), tz);
  const startDay = Date.UTC(localFrom.year, localFrom.month - 1, localFrom.day);
  const fromMs = from.getTime();

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const dayDate = new Date(startDay + dayOffset * 86_400_000);
    const year = dayDate.getUTCFullYear();
    const month = dayDate.getUTCMonth() + 1;
    const day = dayDate.getUTCDate();
    if (!matchesDay(spec, year, month, day)) continue;

    for (const hour of [...spec.hours].sort((a, b) => a - b)) {
      for (const minute of [...spec.minutes].sort((a, b) => a - b)) {
        const localMs = Date.UTC(year, month - 1, day, hour, minute);
        // 先用「本地墙钟当作 UTC」估计偏移，再校验实际瞬间的墙钟是否一致（处理 DST 跳变）。
        const instant = localMs - offsetMsAt(localMs, tz);
        if (instant <= fromMs) continue;
        const p = zonedParts(instant, tz);
        if (
          p.year === year &&
          p.month === month &&
          p.day === day &&
          p.hour === hour &&
          p.minute === minute
        ) {
          return new Date(instant);
        }
      }
    }
  }
  return null;
}