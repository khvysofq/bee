/**
 * 作业系统 P0 集成测试（连 bee_test）：
 *  - 插 job_def → 手动执行（fixture 源）→ job_run succeeded 且 price_observation 有行；
 *  - 同一 (job_code, scheduled_for) 再跑不产生第二行；手动重跑候选幂等；
 *  - source_policy.login_wall=true → policy_blocked 且不发起任何网络请求；
 *  - /internal/ingest 缺 token / token 错误 → 401。
 *
 * 测试只使用仓库内 fixture，不访问真实站点。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, dbSchema } from '@bee/db';
import { runJobOnce } from '../src/worker';
import { ingestPayload } from '../../../apps/web/src/lib/ingest';
import { seedPipelineDictionaries } from '../../pipeline/tests/helpers/seed';

const TEST_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const db = createDb(TEST_URL);
const JOB_CODE = 'test.demo.fixture';
const SOURCE_CODE = 'demo-fixture';
const TODAY = '2026-10-27';

describe.skipIf(!TEST_URL)('作业系统 P0（fixture 端到端）', () => {
  let storeRoot = '';
  let sourceId = '';
  let firstRunExecuted = false;
  let observationCountAfterFirst = 0;
  let quoteCount = 0;

  const scheduledFor = new Date('2026-10-26T07:00:00Z');

  beforeAll(async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), 'bee-jobs-'));
    await seedPipelineDictionaries(db);

    const [source] = await db
      .insert(dbSchema.source)
      .values({
        code: SOURCE_CODE,
        name: '离线 fixture',
        type: 'api',
        baseUrl: 'fixture://fengj-copper.html',
        robotsStatus: 'allowed',
        robotsCheckedAt: new Date('2026-10-26T00:00:00Z'),
        fetcherKind: 'fixture_html',
        status: 'active',
      })
      .onConflictDoUpdate({ target: dbSchema.source.code, set: { status: 'active', robotsStatus: 'allowed' } })
      .returning();
    sourceId = source!.id;

    await db
      .insert(dbSchema.sourcePolicy)
      .values({
        sourceCode: SOURCE_CODE,
        domain: 'fixture.local',
        robotsStatus: 'allow',
        robotsCheckedAt: '2026-10-26',
        loginWall: false,
        redistribution: 'licensed',
        rpsLimit: '100',
      })
      .onConflictDoUpdate({
        target: dbSchema.sourcePolicy.sourceCode,
        set: { loginWall: false, redistribution: 'licensed' },
      });

    await db
      .insert(dbSchema.jobDef)
      .values({
        code: JOB_CODE,
        type: 'fetch_table',
        tier: 'deterministic',
        target: { url: 'fixture://fengj-copper.html', method: 'GET', rps: 100 },
        goal: '离线自检',
        adapter: 'fengj-copper-v1',
        mapping: { table: 'price_observation', data_class: 'spot_quote' },
        schedule: { cron: '*/15 * * * *', tz: 'Asia/Shanghai', enabled: true },
        limits: { timeout_s: 10, max_attempts: 1, backoff_s: [0] },
        policy: { source_code: SOURCE_CODE, redistribution: 'licensed' },
        priority: 3,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: dbSchema.jobDef.code,
        set: { enabled: true, policy: { source_code: SOURCE_CODE, redistribution: 'licensed' } },
      });
  });

  afterAll(async () => {
    await rm(storeRoot, { recursive: true, force: true });
    await db.$client.end();
  });

  const ingest = (payload: Parameters<typeof ingestPayload>[1]) =>
    ingestPayload(db, payload, { today: TODAY, storeRoot });

  const run = (options: { scheduledFor?: Date | null; fetchImpl?: typeof fetch } = {}) =>
    runJobOnce({
      db,
      jobCode: JOB_CODE,
      scheduledFor: options.scheduledFor === undefined ? null : options.scheduledFor,
      ingestUrl: 'http://127.0.0.1:1/internal/ingest',
      ingestToken: 'test-token',
      storeRoot,
      ingest: (payload) => ingest(payload),
      fetchImpl: options.fetchImpl,
      now: new Date('2026-10-27T01:00:00Z'),
    });

  it('插 job_def → 执行一轮 → job_run=succeeded 且 price_observation / daily_quote 有行', async () => {
    const result = await run({ scheduledFor });
    firstRunExecuted = result.executed;
    expect(result.executed).toBe(true);
    expect(result.run.status).toBe('succeeded');
    expect(result.run.httpStatus).toBe(200);
    expect(result.run.fetchedBytes ?? 0).toBeGreaterThan(0);
    expect(result.run.rawFetchId).toBeTruthy();

    const observations = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(eq(dbSchema.priceObservation.sourceId, sourceId));
    observationCountAfterFirst = observations.length;
    expect(observations.length).toBe(4);
    expect(observations.every((row) => row.validationStatus === 'validated')).toBe(true);

    const quotes = await db.select().from(dbSchema.dailyQuote);
    quoteCount = quotes.length;
    expect(quotes.length).toBeGreaterThanOrEqual(4);

    const candidates = await db
      .select()
      .from(dbSchema.ingestCandidate)
      .where(eq(dbSchema.ingestCandidate.status, 'accepted'));
    expect(candidates.length).toBe(4);
    expect(candidates.every((row) => row.acceptedRowId !== null)).toBe(true);
    expect(firstRunExecuted).toBe(true);
  });

  it('同一 (job_code, scheduled_for) 再跑一次不执行、不产生第二行', async () => {
    const second = await run({ scheduledFor });
    expect(second.executed).toBe(false);
    const observations = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(eq(dbSchema.priceObservation.sourceId, sourceId));
    expect(observations.length).toBe(observationCountAfterFirst);
    const runs = await db
      .select()
      .from(dbSchema.jobRun)
      .where(and(eq(dbSchema.jobRun.jobCode, JOB_CODE), eq(dbSchema.jobRun.scheduledFor, scheduledFor)));
    expect(runs).toHaveLength(1);
  });

  it('手动触发重复执行：候选幂等，业务表不重复', async () => {
    const manual = await run({ scheduledFor: null });
    expect(manual.executed).toBe(true);
    expect(manual.run.status).toBe('succeeded');
    const observations = await db
      .select()
      .from(dbSchema.priceObservation)
      .where(eq(dbSchema.priceObservation.sourceId, sourceId));
    expect(observations.length).toBe(observationCountAfterFirst);
    const quotes = await db.select().from(dbSchema.dailyQuote);
    expect(quotes.length).toBe(quoteCount);
    const candidates = await db.select().from(dbSchema.ingestCandidate);
    expect(candidates).toHaveLength(4);
  });

  it('login_wall=true → policy_blocked 且不发起网络请求', async () => {
    await db
      .update(dbSchema.sourcePolicy)
      .set({ loginWall: true })
      .where(eq(dbSchema.sourcePolicy.sourceCode, SOURCE_CODE));

    let fetched = 0;
    const blocked = await run({
      scheduledFor: null,
      fetchImpl: (async () => {
        fetched += 1;
        throw new Error('policy_blocked 时不应发起网络请求');
      }) as typeof fetch,
    });
    expect(blocked.executed).toBe(true);
    expect(blocked.run.status).toBe('policy_blocked');
    expect(fetched).toBe(0);

    await db
      .update(dbSchema.sourcePolicy)
      .set({ loginWall: false })
      .where(eq(dbSchema.sourcePolicy.sourceCode, SOURCE_CODE));
  });

  it('ingest API 未带 token / token 错误 → 401', async () => {
    const previous = process.env.INGEST_TOKEN;
    process.env.INGEST_TOKEN = 'correct-token';
    try {
      const { POST } = await import('../../../apps/web/src/app/internal/ingest/route');
      const noToken = await POST(
        new Request('http://localhost/internal/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect([401, 403]).toContain(noToken.status);

      const wrongToken = await POST(
        new Request('http://localhost/internal/ingest', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token' },
          body: '{}',
        }),
      );
      expect([401, 403]).toContain(wrongToken.status);
    } finally {
      if (previous === undefined) delete process.env.INGEST_TOKEN;
      else process.env.INGEST_TOKEN = previous;
    }
  });

  it('候选表保留了每条业务行的证据引用与验证器版本', async () => {
    const rows = await db
      .select()
      .from(dbSchema.ingestCandidate)
      .where(inArray(dbSchema.ingestCandidate.dedupeKey, ['x']));
    expect(rows).toHaveLength(0);
    const all = await db.select().from(dbSchema.ingestCandidate);
    expect(all.every((row) => row.validatorVersion === 'jobs-validator@1.0.0')).toBe(true);
    expect(all.every((row) => (row.evidenceRef as { raw?: { sha256?: string } }).raw?.sha256?.length === 64)).toBe(true);
  });
});