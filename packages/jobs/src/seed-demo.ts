import { eq } from 'drizzle-orm';
import { createDb, dbSchema, resolveDatabaseUrl } from '@bee/db';

/**
 * 示例任务种子：pnpm jobs:seed
 *
 * 1. fengj.scrap-copper.daily —— 真实目标，默认停用（避免自动外呼）。
 * 2. demo.local.fixture         —— 仓库内 fixture，启用，供离线自检。
 *
 * 同时补齐最小口径字典与映射（只动废铜相关行），否则离线自检的候选无法规范化为业务行。
 */

const FENGJ_JOB = {
  code: 'fengj.scrap-copper.daily',
  type: 'fetch_table',
  tier: 'deterministic',
  target: {
    url: 'https://zs.fengj.com/ft/',
    method: 'GET',
    headers: { 'Accept-Language': 'zh-CN' },
    rps: 0.5,
  },
  goal: '抓取废铜各城市当日参考价：品名、规格、省份、城市、价格、涨跌、日期',
  adapter: 'fengj-copper-v1',
  outputSchema: { type: 'object', required: ['rows'] },
  mapping: {
    table: 'price_observation',
    data_class: 'spot_quote',
    keys: { observed_at: 'date', region: 'city', value: 'price' },
  },
  // 随机窗口：每天在 07:10–09:30（Asia/Shanghai）里按 (code, 日期) 哈希挑一个整分钟，
  // 固定时刻连续请求同一站点是最容易被识别成爬虫的模式。任务本身默认停用，等主人开。
  schedule: {
    mode: 'random_window',
    windowStart: '07:10',
    windowEnd: '09:30',
    tz: 'Asia/Shanghai',
    enabled: false,
  },
  limits: { timeout_s: 120, max_attempts: 3, backoff_s: [60, 300, 900] },
  agent: { profile: 'scraper-basic', skills: ['web-scrape'], model: 'cheap' },
  policy: { source_code: 'fengj', redistribution: 'internal_only' },
  priority: 5,
  enabled: false,
  notes: 'P0 示范；默认停用，只有人工点「立即执行」才会发出真实请求（每次 1 个）。',
} as const;

const DEMO_JOB = {
  code: 'demo.local.fixture',
  type: 'fetch_table',
  tier: 'deterministic',
  target: { url: 'fixture://fengj-copper.html', method: 'GET', rps: 0.5 },
  goal: '离线自检：解析仓库内 fengj 废铜表格 fixture，产生候选并落业务表',
  adapter: 'fengj-copper-v1',
  outputSchema: { type: 'object', required: ['rows'] },
  mapping: {
    table: 'price_observation',
    data_class: 'spot_quote',
    keys: { observed_at: 'date', region: 'city', value: 'price' },
  },
  // 自检任务改成每小时一次：15 分钟一轮对离线 fixture 没有额外信息量，只增加台账噪音。
  schedule: { cron: '7 * * * *', tz: 'Asia/Shanghai', enabled: true },
  limits: { timeout_s: 30, max_attempts: 1, backoff_s: [0] },
  agent: null,
  policy: { source_code: 'demo-fixture', redistribution: 'licensed' },
  priority: 3,
  enabled: true,
  notes: '离线 fixture；不访问网络。',
} as const;

async function ensureDictionary(db: ReturnType<typeof createDb>): Promise<void> {
  const units = [
    { code: 'CNY_per_ton', nameCn: '元/吨' },
    { code: 'CNY_per_kg', nameCn: '元/公斤' },
    { code: 'CNY_per_jin', nameCn: '元/斤' },
    { code: 'CNY_wan_per_ton', nameCn: '万元/吨' },
  ];
  for (const unit of units) {
    await db.insert(dbSchema.unit).values(unit).onConflictDoNothing({ target: dbSchema.unit.code });
  }
  const [canonical] = await db.select().from(dbSchema.unit).where(eq(dbSchema.unit.isCanonical, 1)).limit(1);
  if (!canonical) {
    await db.update(dbSchema.unit).set({ isCanonical: 1 }).where(eq(dbSchema.unit.code, 'CNY_per_ton'));
  }
  const unitRows = await db.select().from(dbSchema.unit);
  const unitByCode = new Map(unitRows.map((unit) => [unit.code, unit.id]));
  const ton = unitByCode.get('CNY_per_ton')!;
  for (const [from, factor] of [
    ['CNY_per_kg', '1000'],
    ['CNY_per_jin', '2000'],
    ['CNY_wan_per_ton', '10000'],
  ] as const) {
    const fromId = unitByCode.get(from);
    if (fromId) {
      await db
        .insert(dbSchema.unitConversion)
        .values({ fromUnitId: fromId, toUnitId: ton, factor })
        .onConflictDoNothing({ target: [dbSchema.unitConversion.fromUnitId, dbSchema.unitConversion.toUnitId] });
    }
  }

  const [country] = await db
    .insert(dbSchema.region)
    .values({ code: 'cn', nameCn: '中国', level: 'country', status: 'active', decidedBy: 'jobs:seed-demo' })
    .onConflictDoUpdate({ target: dbSchema.region.code, set: { status: 'active' } })
    .returning();
  const macroRegions = [
    { code: 'cn-south', nameCn: '华南' },
    { code: 'cn-east', nameCn: '华东' },
  ];
  const macroIdByCode = new Map<string, string>();
  for (const entry of macroRegions) {
    const [row] = await db
      .insert(dbSchema.region)
      .values({
        code: entry.code,
        nameCn: entry.nameCn,
        level: 'macro_region',
        parentId: country!.id,
        status: 'active',
        decidedBy: 'jobs:seed-demo',
      })
      .onConflictDoUpdate({
        target: dbSchema.region.code,
        set: { status: 'active', parentId: country!.id },
      })
      .returning();
    macroIdByCode.set(entry.code, row!.id);
  }
  const regions = [
    { code: 'foshan', nameCn: '佛山', parent: 'cn-south' },
    { code: 'guangzhou', nameCn: '广州', parent: 'cn-south' },
    { code: 'suzhou', nameCn: '苏州', parent: 'cn-east' },
  ] as const;
  const regionIdByCode = new Map<string, string>();
  for (const entry of regions) {
    const parentId = macroIdByCode.get(entry.parent)!;
    const [row] = await db
      .insert(dbSchema.region)
      .values({
        code: entry.code,
        nameCn: entry.nameCn,
        level: 'city',
        parentId,
        status: 'active',
        decidedBy: 'jobs:seed-demo',
      })
      .onConflictDoUpdate({ target: dbSchema.region.code, set: { status: 'active', parentId } })
      .returning();
    regionIdByCode.set(entry.code, row!.id);
  }

  const [category] = await db
    .insert(dbSchema.category)
    .values({ code: 'scrap-copper', nameCn: '废铜', status: 'active', decidedBy: 'jobs:seed-demo' })
    .onConflictDoUpdate({ target: dbSchema.category.code, set: { status: 'active' } })
    .returning();
  const specs = [
    { code: 'bright-wire', nameCn: '光亮铜线' },
    { code: 'no2-copper', nameCn: '紫杂铜' },
  ];
  const specIdByCode = new Map<string, string>();
  for (const [index, entry] of specs.entries()) {
    const [row] = await db
      .insert(dbSchema.specGrade)
      .values({
        categoryId: category!.id,
        code: entry.code,
        nameCn: entry.nameCn,
        kind: 'grade',
        isCore: 1,
        status: 'active',
        sortOrder: index,
        decidedBy: 'jobs:seed-demo',
      })
      .onConflictDoUpdate({
        target: [dbSchema.specGrade.categoryId, dbSchema.specGrade.code],
        set: { status: 'active' },
      })
      .returning();
    specIdByCode.set(entry.code, row!.id);
  }

  for (const mapping of [
    { rawCategoryText: '废铜', rawSpecText: '光亮铜线', specCode: 'bright-wire' },
    { rawCategoryText: '废铜', rawSpecText: '紫杂铜', specCode: 'no2-copper' },
  ]) {
    const [existing] = await db
      .select({ id: dbSchema.termMapping.id })
      .from(dbSchema.termMapping)
      .where(eq(dbSchema.termMapping.rawCategoryText, mapping.rawCategoryText))
      .limit(1);
    if (!existing) {
      await db.insert(dbSchema.termMapping).values({
        scope: 'global',
        rawCategoryText: mapping.rawCategoryText,
        rawSpecText: mapping.rawSpecText,
        categoryId: category!.id,
        specId: specIdByCode.get(mapping.specCode)!,
        confidence: '0.99',
        status: 'active',
        decidedBy: 'jobs:seed-demo',
      });
    }
  }
  for (const [rawRegionText, code] of [
    ['佛山', 'foshan'],
    ['广州', 'guangzhou'],
    ['苏州', 'suzhou'],
  ] as const) {
    const [existing] = await db
      .select({ id: dbSchema.regionMapping.id })
      .from(dbSchema.regionMapping)
      .where(eq(dbSchema.regionMapping.rawRegionText, rawRegionText))
      .limit(1);
    if (!existing) {
      await db.insert(dbSchema.regionMapping).values({
        scope: 'global',
        rawRegionText,
        regionId: regionIdByCode.get(code)!,
        confidence: '0.99',
        status: 'active',
        decidedBy: 'jobs:seed-demo',
      });
    }
  }
}

async function ensureSources(db: ReturnType<typeof createDb>): Promise<void> {
  await db
    .insert(dbSchema.source)
    .values({
      code: 'fengj',
      name: '废旧网（fengj）',
      type: 'webpage',
      baseUrl: 'https://zs.fengj.com/ft/',
      robotsStatus: 'unknown',
      robotsNote: 'P0 只登记；抓取前由 source_policy 闸门判定，默认任务停用',
      crawlFrequencyPerDay: 1,
      rateLimitSeconds: 2,
      fetcherKind: 'static_html',
      status: 'paused',
      statusReason: '待 robots/ToS 复核；任务默认停用',
    })
    .onConflictDoNothing({ target: dbSchema.source.code });

  await db
    .insert(dbSchema.source)
    .values({
      code: 'demo-fixture',
      name: '仓库内离线 fixture（自造）',
      type: 'api',
      baseUrl: 'fixture://fengj-copper.html',
      robotsStatus: 'allowed',
      robotsCheckedAt: new Date('2026-10-26T00:00:00Z'),
      robotsNote: '仓库内自造文件，无第三方抓取',
      crawlFrequencyPerDay: 96,
      rateLimitSeconds: 0,
      fetcherKind: 'fixture_html',
      status: 'active',
      statusReason: '离线自检',
    })
    .onConflictDoUpdate({ target: dbSchema.source.code, set: { status: 'active', robotsStatus: 'allowed' } });

  for (const policy of [
    {
      sourceCode: 'fengj',
      domain: 'zs.fengj.com',
      robotsStatus: 'allow-partial',
      robotsCheckedAt: '2026-10-27',
      tosNote: '仅内部参考；待复核原文授权范围',
      loginWall: false,
      redistribution: 'internal_only',
      rpsLimit: '0.5',
      notes: 'P0 合规闸门示例；任务默认停用',
    },
    {
      sourceCode: 'demo-fixture',
      domain: 'fixture.local',
      robotsStatus: 'allow',
      robotsCheckedAt: '2026-10-26',
      tosNote: '仓库内自造样本',
      loginWall: false,
      redistribution: 'licensed',
      rpsLimit: '10',
      notes: '离线自检',
    },
  ]) {
    await db
      .insert(dbSchema.sourcePolicy)
      .values(policy)
      .onConflictDoUpdate({ target: dbSchema.sourcePolicy.sourceCode, set: policy });
  }
}

async function upsertJob(db: ReturnType<typeof createDb>, job: typeof FENGJ_JOB | typeof DEMO_JOB): Promise<void> {
  const values = {
    code: job.code,
    type: job.type,
    tier: job.tier,
    target: job.target,
    goal: job.goal,
    adapter: job.adapter,
    outputSchema: job.outputSchema,
    mapping: job.mapping,
    schedule: job.schedule,
    limits: job.limits,
    agent: job.agent ?? null,
    policy: job.policy,
    priority: job.priority,
    enabled: job.enabled,
    notes: job.notes,
    updatedAt: new Date(),
  };
  await db
    .insert(dbSchema.jobDef)
    .values(values)
    .onConflictDoUpdate({ target: dbSchema.jobDef.code, set: values });
}

async function main(): Promise<void> {
  const connectionString = resolveDatabaseUrl();
  if (!connectionString) {
    console.error('缺少 DATABASE_URL');
    process.exit(1);
  }
  const db = createDb(connectionString);
  await ensureDictionary(db);
  await ensureSources(db);
  await upsertJob(db, FENGJ_JOB);
  await upsertJob(db, DEMO_JOB);
  console.log('示例任务已插入：');
  console.log(`  - ${FENGJ_JOB.code}（enabled=false，真实目标 ${FENGJ_JOB.target.url}）`);
  console.log(`  - ${DEMO_JOB.code}（enabled=true，fixture://fengj-copper.html）`);
  await db.$client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});