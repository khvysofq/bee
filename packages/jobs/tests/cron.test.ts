import { describe, expect, it } from 'vitest';
import { isValidCron, nextCronRun } from '../src/cron';

describe('cron（纯函数）', () => {
  it('校验 5 字段表达式', () => {
    expect(isValidCron('20 7 * * *')).toBe(true);
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('20 7 * *')).toBe(false);
    expect(isValidCron('61 7 * * *')).toBe(false);
    expect(isValidCron('20 7 32 * *')).toBe(false);
  });

  it('按 Asia/Shanghai 计算下一次执行', () => {
    const from = new Date('2026-10-27T00:00:00Z'); // 08:00 CST
    const next = nextCronRun('20 7 * * *', 'Asia/Shanghai', from);
    expect(next?.toISOString()).toBe('2026-10-27T23:20:00.000Z'); // 次日 07:20 CST
  });

  it('工作日规则跳过周末', () => {
    const fridayEvening = new Date('2026-10-30T12:00:00Z'); // 周五 20:00 CST
    const next = nextCronRun('0 9 * * 1-5', 'Asia/Shanghai', fridayEvening);
    expect(next?.toISOString()).toBe('2026-11-02T01:00:00.000Z'); // 周一 09:00 CST
  });
});