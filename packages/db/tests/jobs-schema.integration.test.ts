/**
 * 作业系统四张表的 schema 不变量（连 bee_test）：
 * 默认值、CHECK 取值域、唯一约束。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, dbSchema } from '../src';

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);

const baseJob = {
  code: '',
  type: 'fetch_table',
  target: { url: 'fixture://x.html' },
  goal: 'test',
  mapping: { table: 'price_observation' },
  schedule: { cron: '0 1 * * *', tz: 'Asia/Shanghai', enabled: true },
  limits: { timeout_s: 10, max_attempts: 1, backoff_s: [0] },
};

describe.skipIf(!TEST_URL)('作业系统 schema 不变量', () => {
  afterAll(async () => {
    await db.$client.end();
  });

  it('job_def 默认值：tier=deterministic / priority=5 / enabled=true', async () => {
    const code = `schema.default.${randomUUID()}`;
    const [row] = await db
      .insert(dbSchema.jobDef)
      .values({ ...baseJob, code })
      .returning();
    expect(row!.tier).toBe('deterministic');
    expect(row!.priority).toBe(5);
    expect(row!.enabled).toBe(true);
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it('job_def 拒绝非法 type / tier / priority（CHECK）', async () => {
    await expect(
      db.insert(dbSchema.jobDef).values({ ...baseJob, code: `bad.type.${randomUUID()}`, type: 'crawl_everything' }),
    ).rejects.toThrow();
    await expect(
      db.insert(dbSchema.jobDef).values({ ...baseJob, code: `bad.tier.${randomUUID()}`, tier: 'gpu' }),
    ).rejects.toThrow();
    await expect(
      db.insert(dbSchema.jobDef).values({ ...baseJob, code: `bad.prio.${randomUUID()}`, priority: 99 }),
    ).rejects.toThrow();
  });

  it('job_run：(job_code, scheduled_for) 唯一；scheduled_for 为空可多次', async () => {
    const code = `schema.run.${randomUUID()}`;
    const scheduled = new Date('2026-10-27T00:00:00Z');
    await db.insert(dbSchema.jobRun).values({ jobCode: code, scheduledFor: scheduled, status: 'queued' });
    await expect(
      db.insert(dbSchema.jobRun).values({ jobCode: code, scheduledFor: scheduled, status: 'queued' }),
    ).rejects.toThrow();

    await db.insert(dbSchema.jobRun).values({ jobCode: code, scheduledFor: null, status: 'queued' });
    await db.insert(dbSchema.jobRun).values({ jobCode: code, scheduledFor: null, status: 'queued' });
    const rows = await db.select().from(dbSchema.jobRun).where(eq(dbSchema.jobRun.jobCode, code));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.attempt === 1)).toBe(true);
  });

  it('job_run 拒绝非法 status（CHECK）', async () => {
    await expect(
      db.insert(dbSchema.jobRun).values({ jobCode: `bad.${randomUUID()}`, scheduledFor: null, status: 'exploded' }),
    ).rejects.toThrow();
  });

  it('ingest_candidate：dedupe_key 唯一、status 默认 pending、取值域受限', async () => {
    const key = `schema:candidate:${randomUUID()}`;
    const [row] = await db
      .insert(dbSchema.ingestCandidate)
      .values({ kind: 'quote', payload: { x: 1 }, dedupeKey: key })
      .returning();
    expect(row!.status).toBe('pending');
    expect(row!.schemaOk).toBe(false);
    await expect(
      db.insert(dbSchema.ingestCandidate).values({ kind: 'quote', payload: { x: 2 }, dedupeKey: key }),
    ).rejects.toThrow();
    await expect(
      db.insert(dbSchema.ingestCandidate).values({
        kind: 'video',
        payload: {},
        dedupeKey: `schema:candidate:${randomUUID()}`,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(dbSchema.ingestCandidate).values({
        kind: 'quote',
        payload: {},
        dedupeKey: `schema:candidate:${randomUUID()}`,
        status: 'maybe',
      }),
    ).rejects.toThrow();
  });

  it('source_policy：redistribution 默认 internal_only、取值域受限', async () => {
    const code = `schema-policy-${randomUUID()}`;
    const [row] = await db
      .insert(dbSchema.sourcePolicy)
      .values({ sourceCode: code, domain: 'example.com' })
      .returning();
    expect(row!.redistribution).toBe('internal_only');
    expect(row!.loginWall).toBe(false);
    await expect(
      db.insert(dbSchema.sourcePolicy).values({
        sourceCode: `bad-${randomUUID()}`,
        domain: 'example.com',
        redistribution: 'sell_data',
      }),
    ).rejects.toThrow();
  });
});