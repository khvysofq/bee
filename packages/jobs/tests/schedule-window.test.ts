/**
 * 随机窗口调度（ADR-0010 补充）：每天在窗口里挑一个整分钟，确定性、无状态、可复现。
 */
import { describe, expect, it } from 'vitest';
import {
  dateAtLocalMinutes,
  dueMinuteToday,
  localDateAndMinutes,
  nextRandomRun,
  parseHHMM,
  randomMinuteFor,
} from '../src/schedule-window';

const TZ = 'Asia/Shanghai';

describe('随机窗口：窗口解析', () => {
  it('只接受 HH:MM', () => {
    expect(parseHHMM('07:10')).toBe(430);
    expect(parseHHMM('9:05')).toBe(545);
    expect(parseHHMM('24:00')).toBeNull();
    expect(parseHHMM('07:60')).toBeNull();
    expect(parseHHMM('abc')).toBeNull();
  });
});

describe('随机窗口：当天分钟', () => {
  it('落点始终在 [start, end) 内', () => {
    const start = parseHHMM('07:10')!;
    const end = parseHHMM('09:30')!;
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-11-${String(day).padStart(2, '0')}`;
      const minute = randomMinuteFor('fengj.scrap-copper.daily', date, start, end);
      expect(minute).toBeGreaterThanOrEqual(start);
      expect(minute).toBeLessThan(end);
    }
  });

  it('同一天同一任务结果稳定，换任务换时间', () => {
    const start = parseHHMM('07:10')!;
    const end = parseHHMM('09:30')!;
    const a1 = randomMinuteFor('job.a', '2026-11-02', start, end);
    const a2 = randomMinuteFor('job.a', '2026-11-02', start, end);
    expect(a1).toBe(a2);
    const b = randomMinuteFor('job.b', '2026-11-02', start, end);
    expect(b).not.toBe(a1);
  });

  it('窗口确实被摊开（28 天里至少出现 10 个不同分钟）', () => {
    const start = parseHHMM('07:10')!;
    const end = parseHHMM('09:30')!;
    const minutes = new Set<string>();
    for (let day = 1; day <= 28; day += 1) {
      const date = `2026-11-${String(day).padStart(2, '0')}`;
      minutes.add(String(randomMinuteFor('fengj.scrap-copper.daily', date, start, end)));
    }
    expect(minutes.size).toBeGreaterThanOrEqual(10);
  });
});

describe('随机窗口：时区与下次执行', () => {
  it('按任务时区判断本地日期与分钟', () => {
    // 2026-10-27T23:30Z = 上海 2026-10-28 07:30
    const at = new Date('2026-10-27T23:30:00Z');
    expect(localDateAndMinutes(at, TZ)).toEqual({ date: '2026-10-28', minutes: 450 });
  });

  it('未到点 → 今天；已过点 → 明天', () => {
    const schedule = {
      mode: 'random_window' as const,
      windowStart: '07:10',
      windowEnd: '09:30',
      tz: TZ,
    };
    const target = randomMinuteFor('fengj.scrap-copper.daily', '2026-10-28', 430, 570);
    const targetInstant = dateAtLocalMinutes(new Date(), TZ, '2026-10-28', target);
    const before = new Date(targetInstant.getTime() - 60_000);
    const next = nextRandomRun('fengj.scrap-copper.daily', before, schedule);
    expect(next!.getTime()).toBe(targetInstant.getTime());

    const after = new Date(targetInstant.getTime() + 60_000);
    const nextAfter = nextRandomRun('fengj.scrap-copper.daily', after, schedule);
    expect(localDateAndMinutes(nextAfter!, TZ).date).toBe('2026-10-29');
  });

  it('窗口非法 → null', () => {
    const schedule = { mode: 'random_window' as const, windowStart: '09:00', windowEnd: '08:00', tz: TZ };
    expect(nextRandomRun('x', new Date(), schedule)).toBeNull();
    expect(dueMinuteToday('x', new Date(), schedule)).toBeNull();
  });

  it('dateAtLocalMinutes 能把本地分钟换回正确时间点', () => {
    const now = new Date('2026-10-27T23:30:00Z'); // 上海 10-28 07:30
    const at = dateAtLocalMinutes(now, TZ, '2026-10-28', 450);
    expect(at.toISOString()).toBe('2026-10-27T23:30:00.000Z');
  });
});

describe('随机窗口：到点判断', () => {
  it('到点前 due=false，到点后 due=true', () => {
    const schedule = { mode: 'random_window' as const, windowStart: '07:10', windowEnd: '09:30', tz: TZ };
    const target = randomMinuteFor('job.x', '2026-10-28', 430, 570);
    const base = Date.parse('2026-10-27T23:30:00Z'); // 上海 07:30
    const before = dueMinuteToday('job.x', new Date(base + (target - 450 - 1) * 60_000), schedule);
    const after = dueMinuteToday('job.x', new Date(base + (target - 450 + 1) * 60_000), schedule);
    expect(before!.due).toBe(false);
    expect(after!.due).toBe(true);
  });
});