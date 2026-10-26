import { and, eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';

const CATEGORIES = [
  {
    code: 'scrap-steel',
    nameCn: '废钢',
    specs: [
      { code: 'heavy', nameCn: '重废', tier: 5, core: 1 },
      { code: 'medium', nameCn: '中废', tier: 4, core: 1 },
      { code: 'mixed', nameCn: '统料', tier: 3, core: 0 },
    ],
  },
  {
    code: 'scrap-copper',
    nameCn: '废铜',
    specs: [{ code: 'bright-wire', nameCn: '光亮铜线', tier: 5, core: 1 }],
  },
  {
    code: 'scrap-aluminum',
    nameCn: '废铝',
    specs: [{ code: 'bright-wire', nameCn: '光亮铝线', tier: 5, core: 1 }],
  },
  {
    code: 'waste-paper',
    nameCn: '废纸',
    specs: [
      { code: 'occ', nameCn: '箱板纸（OCC）', tier: 3, core: 1 },
      { code: 'book-paper', nameCn: '书本纸', tier: 3, core: 0 },
    ],
  },
  {
    code: 'waste-plastic',
    nameCn: '废塑料',
    specs: [
      { code: 'pet-briquette', nameCn: 'PET瓶砖', tier: 4, core: 1 },
      { code: 'pe', nameCn: 'PE料', tier: 3, core: 1 },
    ],
  },
] as const;

const REGIONS = [
  { code: 'cn-east', nameCn: '华东', level: 'macro_region' as const, parent: null },
  { code: 'cn-south', nameCn: '华南', level: 'macro_region' as const, parent: null },
  { code: 'cn-north', nameCn: '华北', level: 'macro_region' as const, parent: null },
  { code: 'cn-southwest', nameCn: '西南', level: 'macro_region' as const, parent: null },
  { code: 'suzhou', nameCn: '苏州', level: 'city' as const, parent: 'cn-east' },
  { code: 'linyi', nameCn: '临沂', level: 'city' as const, parent: 'cn-east' },
  { code: 'foshan', nameCn: '佛山', level: 'city' as const, parent: 'cn-south' },
  { code: 'guangzhou', nameCn: '广州', level: 'city' as const, parent: 'cn-south' },
  { code: 'tianjin', nameCn: '天津', level: 'city' as const, parent: 'cn-north' },
  { code: 'kunming', nameCn: '昆明', level: 'city' as const, parent: 'cn-southwest' },
];

const SOURCES = [
  { code: 'fixture-a', name: 'Fixture A（自造测试价目表）', trust: '80.0' },
  { code: 'fixture-b', name: 'Fixture B（自造跨源对照价目表）', trust: '75.0' },
  { code: 'fixture-c-outlier', name: 'Fixture C（自造异常样本）', trust: '60.0' },
  { code: 'open-cc0-sample', name: 'CC0 开放数据样本', trust: '90.0' },
] as const;

const TERM_MAPPINGS = [
  { rawCategoryText: '废钢', rawSpecText: '重废', categoryCode: 'scrap-steel', specCode: 'heavy' },
  { rawCategoryText: '废钢', rawSpecText: '中废', categoryCode: 'scrap-steel', specCode: 'medium' },
  { rawCategoryText: '废钢', rawSpecText: '统料', categoryCode: 'scrap-steel', specCode: 'mixed' },
  { rawCategoryText: '废铜', rawSpecText: '光亮铜线', categoryCode: 'scrap-copper', specCode: 'bright-wire' },
  { rawCategoryText: '废铝', rawSpecText: '光亮铝线', categoryCode: 'scrap-aluminum', specCode: 'bright-wire' },
  { rawCategoryText: '废纸', rawSpecText: '箱板纸', categoryCode: 'waste-paper', specCode: 'occ' },
  { rawCategoryText: '废纸', rawSpecText: '书本纸', categoryCode: 'waste-paper', specCode: 'book-paper' },
  { rawCategoryText: '废塑料', rawSpecText: 'PET瓶砖', categoryCode: 'waste-plastic', specCode: 'pet-briquette' },
  { rawCategoryText: '废塑料', rawSpecText: 'PE料', categoryCode: 'waste-plastic', specCode: 'pe' },
] as const;

const REGION_MAPPINGS = [
  { rawRegionText: '苏州', code: 'suzhou' },
  { rawRegionText: '临沂', code: 'linyi' },
  { rawRegionText: '佛山', code: 'foshan' },
  { rawRegionText: '广州', code: 'guangzhou' },
  { rawRegionText: '天津', code: 'tianjin' },
  { rawRegionText: '昆明', code: 'kunming' },
] as const;

export interface SeededPipelineDictionaries {
  category: Map<string, string>;
  spec: Map<string, string>;
  region: Map<string, string>;
  source: Map<string, string>;
}

/** 供 P0-3 集成测试使用的最小生效字典 + 放行来源 + 映射。幂等，可重复调用。 */
export async function seedPipelineDictionaries(db: BeeDb): Promise<SeededPipelineDictionaries> {
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

  const [existingCountry] = await db.select().from(dbSchema.region).where(eq(dbSchema.region.level, 'country')).limit(1);
  const country = existingCountry ?? (await db
    .insert(dbSchema.region)
    .values({ code: 'cn', nameCn: '中国', level: 'country', status: 'active', decidedBy: 'test' })
    .returning())[0]!;

  const region = new Map<string, string>();
  region.set('cn', country.id);
  for (const entry of REGIONS) {
    const parentId = entry.parent ? region.get(entry.parent)! : country.id;
    const [row] = await db
      .insert(dbSchema.region)
      .values({ code: entry.code, nameCn: entry.nameCn, level: entry.level, parentId, status: 'active', decidedBy: 'test' })
      .onConflictDoUpdate({ target: dbSchema.region.code, set: { nameCn: entry.nameCn, parentId, status: 'active' } })
      .returning();
    region.set(entry.code, row!.id);
  }

  const category = new Map<string, string>();
  const spec = new Map<string, string>();
  for (const [index, entry] of CATEGORIES.entries()) {
    const [row] = await db
      .insert(dbSchema.category)
      .values({ code: entry.code, nameCn: entry.nameCn, status: 'active', sortOrder: index, decidedBy: 'test' })
      .onConflictDoUpdate({ target: dbSchema.category.code, set: { nameCn: entry.nameCn, status: 'active' } })
      .returning();
    category.set(entry.code, row!.id);
    for (const [specIndex, item] of entry.specs.entries()) {
      const [specRow] = await db
        .insert(dbSchema.specGrade)
        .values({
          categoryId: row!.id,
          code: item.code,
          nameCn: item.nameCn,
          kind: 'grade',
          qualityTier: item.tier,
          isCore: item.core,
          status: 'active',
          sortOrder: specIndex,
          decidedBy: 'test',
        })
        .onConflictDoUpdate({ target: [dbSchema.specGrade.categoryId, dbSchema.specGrade.code], set: { nameCn: item.nameCn, status: 'active' } })
        .returning();
      spec.set(`${entry.code}/${item.code}`, specRow!.id);
    }
  }

  const source = new Map<string, string>();
  for (const entry of SOURCES) {
    const [row] = await db
      .insert(dbSchema.source)
      .values({
        code: entry.code,
        name: entry.name,
        type: 'api',
        baseUrl: `fixture://${entry.code}`,
        tosUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        robotsStatus: 'allowed',
        robotsCheckedAt: new Date('2026-10-26T00:00:00Z'),
        robotsNote: '自造 fixture / CC0 样本，无第三方站点抓取',
        trustWeight: entry.trust,
        trustNote: '自造测试源，权重仅用于测试聚合排序',
        crawlFrequencyPerDay: 1,
        rateLimitSeconds: 0,
        fetcherKind: 'fixture_json',
        status: 'active',
        statusReason: 'fixture/CC0 数据，P0-3 端到端测试',
      })
      .onConflictDoUpdate({
        target: dbSchema.source.code,
        set: { name: entry.name, robotsStatus: 'allowed', status: 'active', trustWeight: entry.trust },
      })
      .returning();
    source.set(entry.code, row!.id);
  }

  for (const mapping of TERM_MAPPINGS) {
    await db
      .insert(dbSchema.termMapping)
      .values({
        scope: 'global',
        rawCategoryText: mapping.rawCategoryText,
        rawSpecText: mapping.rawSpecText,
        categoryId: category.get(mapping.categoryCode)!,
        specId: spec.get(`${mapping.categoryCode}/${mapping.specCode}`)!,
        confidence: '0.99',
        status: 'active',
        decidedBy: 'test',
      })
      .onConflictDoNothing();
  }

  for (const mapping of REGION_MAPPINGS) {
    await db
      .insert(dbSchema.regionMapping)
      .values({
        scope: 'global',
        rawRegionText: mapping.rawRegionText,
        regionId: region.get(mapping.code)!,
        confidence: '0.99',
        status: 'active',
        decidedBy: 'test',
      })
      .onConflictDoNothing();
  }

  return { category, spec, region, source };
}

export async function markSourceBlocked(db: BeeDb, code: string): Promise<void> {
  await db
    .insert(dbSchema.source)
    .values({
      code,
      name: `Blocked ${code}`,
      type: 'api',
      baseUrl: `fixture://${code}`,
      robotsStatus: 'unknown',
      status: 'paused',
      statusReason: '合规闸门测试：未授权来源不得采集',
    })
    .onConflictDoUpdate({ target: dbSchema.source.code, set: { robotsStatus: 'unknown', status: 'paused' } });
}

export async function findSourceId(db: BeeDb, code: string): Promise<string> {
  const [row] = await db.select({ id: dbSchema.source.id }).from(dbSchema.source).where(eq(dbSchema.source.code, code));
  return row!.id;
}

export async function findObservationIdsForSource(db: BeeDb, sourceCode: string): Promise<string[]> {
  const [source] = await db.select({ id: dbSchema.source.id }).from(dbSchema.source).where(eq(dbSchema.source.code, sourceCode));
  const rows = await db
    .select({ id: dbSchema.priceObservation.id })
    .from(dbSchema.priceObservation)
    .where(and(eq(dbSchema.priceObservation.sourceId, source!.id)));
  return rows.map((row) => row.id);
}
