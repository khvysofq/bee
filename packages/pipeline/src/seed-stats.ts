import { and, eq } from 'drizzle-orm';
import { dbSchema, type BeeDb } from '@bee/db';
import { STATS_INDEX_URL, STATS_LICENSE_ID, STATS_LICENSE_NOTE } from './adapters/stats';

export const STATS_SOURCE_CODE = 'stats-cn';

/** 五品类 × 原生品参考锚点。规格名显式带「原生品全国参考锚点」，禁止与废料分档价混读。 */
export const ANCHOR_SPECS = [
  {
    categoryCode: 'scrap-steel',
    code: 'rebar-hrb400e-anchor',
    nameCn: '螺纹钢 Φ20mm HRB400E（原生品全国参考锚点）',
    rawCategoryText: '螺纹钢',
    rawSpecText: 'Φ20mm，HRB400E',
    qualityTier: 5,
    definition: '国家统计局流通领域重要生产资料价格；成品钢全国参考价，不是废钢采购价。',
  },
  {
    categoryCode: 'scrap-copper',
    code: 'electrolytic-copper-1-anchor',
    nameCn: '电解铜 1#（原生品全国参考锚点）',
    rawCategoryText: '电解铜',
    rawSpecText: '1#',
    qualityTier: 5,
    definition: '国家统计局流通领域重要生产资料价格；原生铜全国参考价，不是废铜分档价。',
  },
  {
    categoryCode: 'scrap-aluminum',
    code: 'aluminum-ingot-a00-anchor',
    nameCn: '铝锭 A00（原生品全国参考锚点）',
    rawCategoryText: '铝锭',
    rawSpecText: 'A00',
    qualityTier: 5,
    definition: '国家统计局流通领域重要生产资料价格；原生铝全国参考价，不是废铝分档价。',
  },
  {
    categoryCode: 'waste-paper',
    code: 'corrugated-aa120-anchor',
    nameCn: '瓦楞纸 AA级120g（原生品全国参考锚点）',
    rawCategoryText: '瓦楞纸',
    rawSpecText: 'AA级120g',
    qualityTier: 4,
    definition: '国家统计局流通领域重要生产资料价格；成品瓦楞纸全国参考价，不是废纸收购价。',
  },
  {
    categoryCode: 'waste-paper',
    code: 'wood-pulp-softwood-anchor',
    nameCn: '纸浆 进口针叶浆（原生品全国参考锚点）',
    rawCategoryText: '纸浆',
    rawSpecText: '进口针叶浆',
    qualityTier: 4,
    definition: '国家统计局流通领域重要生产资料价格；原生纸浆全国参考价，不是废纸收购价。',
  },
  {
    categoryCode: 'waste-plastic',
    code: 'lldpe-film-anchor',
    nameCn: '聚乙烯 LLDPE 薄膜料（原生品全国参考锚点）',
    rawCategoryText: '聚乙烯',
    rawSpecText: 'LLDPE，熔融指数2薄膜料',
    qualityTier: 4,
    definition: '国家统计局流通领域重要生产资料价格；原生塑料全国参考价，不是废塑料分档价。',
  },
  {
    categoryCode: 'waste-plastic',
    code: 'pp-raffia-anchor',
    nameCn: '聚丙烯 拉丝料（原生品全国参考锚点）',
    rawCategoryText: '聚丙烯',
    rawSpecText: '拉丝料',
    qualityTier: 4,
    definition: '国家统计局流通领域重要生产资料价格；原生塑料全国参考价，不是废塑料分档价。',
  },
] as const;

export interface SeededStatsDictionaries {
  sourceId: string;
  referenceRegionId: string;
  specs: Map<string, string>;
}

async function mustCategoryId(db: BeeDb, code: string): Promise<string> {
  const [row] = await db.select({ id: dbSchema.category.id }).from(dbSchema.category).where(eq(dbSchema.category.code, code));
  if (!row) throw new Error(`品类字典缺少 ${code}，请先运行基础字典 seed`);
  return row.id;
}

/**
 * 统计局旬价来源 + 五品类原生品锚点规格 + source 专属映射。
 * 幂等；必须在基础字典（5 品类、country、元/吨）已存在后运行。
 */
export async function seedStatsDictionaries(db: BeeDb): Promise<SeededStatsDictionaries> {
  const [country] = await db.select().from(dbSchema.region).where(eq(dbSchema.region.level, 'country')).limit(1);
  if (!country) throw new Error('地域字典缺少 country 根节点，请先运行基础字典 seed');

  // 逻辑地域：全国口径的承载节点。名称显式标注「全国参考（统计局旬价）」，避免被当成城市现货。
  const [referenceMacro] = await db
    .insert(dbSchema.region)
    .values({
      code: 'cn-reference',
      nameCn: '全国参考口径',
      level: 'macro_region',
      parentId: country.id,
      status: 'active',
      note: '非行政区划：仅承载来源直接发布的全国参考价，不参与区域分档聚合。',
      decidedBy: 'GUA-20',
    })
    .onConflictDoUpdate({
      target: dbSchema.region.code,
      set: { nameCn: '全国参考口径', parentId: country.id, status: 'active' },
    })
    .returning();
  const [referenceRegion] = await db
    .insert(dbSchema.region)
    .values({
      code: 'stats-national-reference',
      nameCn: '全国参考（统计局旬价）',
      level: 'city',
      parentId: referenceMacro!.id,
      status: 'active',
      note: '来源直接发布的全国口径价格；不是城市/市场现货价，区域分档暂缺。',
      decidedBy: 'GUA-20',
    })
    .onConflictDoUpdate({
      target: dbSchema.region.code,
      set: { nameCn: '全国参考（统计局旬价）', parentId: referenceMacro!.id, status: 'active' },
    })
    .returning();

  const [source] = await db
    .insert(dbSchema.source)
    .values({
      code: STATS_SOURCE_CODE,
      name: '国家统计局（流通领域重要生产资料市场价格）',
      type: 'webpage',
      baseUrl: STATS_INDEX_URL,
      tosUrl: 'https://www.stats.gov.cn/wzgl/202302/t20230217_1912857.html',
      robotsStatus: 'allowed',
      robotsCheckedAt: new Date('2026-10-26T00:00:00Z'),
      robotsNote: 'https://www.stats.gov.cn/robots.txt 返回 404（无 robots 文件）；服务条款明文欢迎转载/引用并允许下载使用统计数据。',
      trustWeight: '95.0',
      trustNote: '国家统计局官方旬报；9 大类 50 种，全国 31 省 300+ 市场监测。',
      crawlFrequencyPerDay: 3,
      rateLimitSeconds: 60,
      fetcherKind: 'stats_bulletin',
      status: 'active',
      statusReason:
        'GUA-17 §2.1 有条件 AUTHORIZED（署名、不得曲解、不得再授权）；GUA-20 v1 唯一免费真实源。',
    })
    .onConflictDoUpdate({
      target: dbSchema.source.code,
      set: {
        name: '国家统计局（流通领域重要生产资料市场价格）',
        baseUrl: STATS_INDEX_URL,
        robotsStatus: 'allowed',
        status: 'active',
        fetcherKind: 'stats_bulletin',
        statusReason:
          'GUA-17 §2.1 有条件 AUTHORIZED（署名、不得曲解、不得再授权）；GUA-20 v1 唯一免费真实源。',
      },
    })
    .returning();

  const specs = new Map<string, string>();
  for (const [index, spec] of ANCHOR_SPECS.entries()) {
    const categoryId = await mustCategoryId(db, spec.categoryCode);
    const [row] = await db
      .insert(dbSchema.specGrade)
      .values({
        categoryId,
        code: spec.code,
        nameCn: spec.nameCn,
        kind: 'spec',
        qualityTier: spec.qualityTier,
        definition: spec.definition,
        isCore: 1,
        status: 'active',
        sortOrder: 20 + index,
        decidedBy: 'GUA-20',
      })
      .onConflictDoUpdate({
        target: [dbSchema.specGrade.categoryId, dbSchema.specGrade.code],
        set: { nameCn: spec.nameCn, definition: spec.definition, status: 'active' },
      })
      .returning();
    specs.set(`${spec.categoryCode}/${spec.code}`, row!.id);

    await db
      .insert(dbSchema.termMapping)
      .values({
        scope: 'source',
        sourceId: source!.id,
        rawCategoryText: spec.rawCategoryText,
        rawSpecText: spec.rawSpecText,
        categoryId,
        specId: row!.id,
        confidence: '0.99',
        status: 'active',
        note: `GUA-20 统计局旬价 → ${spec.nameCn}`,
        decidedBy: 'GUA-20',
      })
      .onConflictDoNothing();
  }

  await db
    .insert(dbSchema.regionMapping)
    .values({
      scope: 'source',
      sourceId: source!.id,
      rawRegionText: '全国',
      regionId: referenceRegion!.id,
      confidence: '0.99',
      status: 'active',
      note: '统计局旬报为全国口径；逻辑地域「全国参考」承载，非城市现货。',
      decidedBy: 'GUA-20',
    })
    .onConflictDoNothing();

  for (const spec of ANCHOR_SPECS) {
    const categoryId = await mustCategoryId(db, spec.categoryCode);
    await db
      .insert(dbSchema.sourceCoverage)
      .values({
        sourceId: source!.id,
        categoryId,
        regionId: referenceRegion!.id,
        trustWeightOverride: '95.0',
      })
      .onConflictDoNothing();
  }

  const [event] = await db
    .select({ id: dbSchema.sourceEvent.id })
    .from(dbSchema.sourceEvent)
    .where(and(eq(dbSchema.sourceEvent.sourceId, source!.id), eq(dbSchema.sourceEvent.eventKind, 'note')))
    .limit(1);
  if (!event) {
    await db.insert(dbSchema.sourceEvent).values({
      sourceId: source!.id,
      eventKind: 'note',
      detail: {
        decision: 'AUTHORIZED_CONDITIONAL',
        evidence: {
          bulletin: 'https://www.stats.gov.cn/sj/zxfb/202610/t20261023_1965679.html',
          bulletinSha256Prefix: '0494d792da9be68e',
          terms: 'https://www.stats.gov.cn/wzgl/202302/t20230217_1912857.html',
          robots: 'https://www.stats.gov.cn/robots.txt (404)',
        },
        obligations: ['显著署名', '附原文链接', '不得修改曲解', '不得再授权下游转载', '标注全国参考锚点而非废料分档现货'],
        licenseId: STATS_LICENSE_ID,
        licenseNote: STATS_LICENSE_NOTE,
      },
      actor: 'agent:GUA-20',
    });
  }

  return { sourceId: source!.id, referenceRegionId: referenceRegion!.id, specs };
}

/** 对外的合规署名文本（页面与简报必须原样展示）。 */
export const STATS_ATTRIBUTION = '数据来源：国家统计局（流通领域重要生产资料市场价格）';
