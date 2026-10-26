/**
 * 初始口径字典种子（P0-1 范围）。
 *
 * 口径原则：所有字典行一律以 status='draft' 落库 —— 这是 CTO 起草的口径草案，
 * 不是已生效口径。P0-3 的第一个口径决策点由人逐项确认（或修改）后置 active，
 * 裁决记录落 caliber_decision。单元换算是纯数学，直接 active。
 *
 * 不种子：来源（P0-3 登记真实来源并逐一核查 ToS/robots）、任何报价数据（P0-3 采集）。
 */
import { sql } from 'drizzle-orm';
import { createDb, dbSchema } from '../src/index';
import { requireDatabaseUrl } from '../src/env';

const { category, specGrade, region, unit, unitConversion } = dbSchema;

const CATEGORIES = [
  {
    code: 'scrap-steel',
    nameCn: '废钢',
    specs: [
      { code: 'heavy', nameCn: '重废', tier: 5, core: 1, def: '厚度≥6mm、块度适中的重型废钢，杂质低' },
      { code: 'medium', nameCn: '中废', tier: 4, core: 1, def: '厚度2–6mm 中型废钢' },
      { code: 'light-thin', nameCn: '轻薄料', tier: 2, core: 1, def: '厚度<2mm 轻薄废钢，常压块' },
      { code: 'mixed', nameCn: '统料', tier: 3, core: 0, def: '未分选混合料，扣杂口径敏感' },
    ],
  },
  {
    code: 'scrap-copper',
    nameCn: '废铜',
    specs: [
      { code: 'bright-wire', nameCn: '光亮铜线', tier: 5, core: 1, def: '剥皮光亮铜线，纯度≥99%' },
      { code: 'no2-copper', nameCn: '紫杂铜', tier: 4, core: 1, def: '2号铜，混杂紫铜料' },
      { code: 'brass-mixed', nameCn: '黄杂铜', tier: 2, core: 0, def: '黄铜混合料' },
    ],
  },
  {
    code: 'scrap-aluminum',
    nameCn: '废铝',
    specs: [
      { code: 'bright-wire', nameCn: '光亮铝线', tier: 5, core: 1, def: '光亮铝线/铝线' },
      { code: 'alu-alloy', nameCn: '铝合金', tier: 4, core: 1, def: '合金铝料（6063 等）' },
      { code: 'can-briquette', nameCn: '易拉罐压块', tier: 1, core: 0, def: '易拉罐破碎压块，杂质口径敏感' },
    ],
  },
  {
    code: 'waste-paper',
    nameCn: '废纸',
    specs: [
      { code: 'occ', nameCn: '箱板纸（OCC）', tier: 3, core: 1, def: '瓦楞箱纸，去胶带扣杂' },
      { code: 'book-paper', nameCn: '书本纸', tier: 3, core: 0, def: '混合书本纸' },
      { code: 'white-paper', nameCn: '白纸', tier: 4, core: 0, def: '办公白纸类' },
    ],
  },
  {
    code: 'waste-plastic',
    nameCn: '废塑料',
    specs: [
      { code: 'pet-briquette', nameCn: 'PET瓶砖', tier: 4, core: 1, def: 'PET 瓶压块，含杂/含水口径敏感' },
      { code: 'pe', nameCn: 'PE料', tier: 3, core: 1, def: '聚乙烯类（含 LDPE/HDPE，待口径细分）' },
      { code: 'pp', nameCn: 'PP料', tier: 3, core: 1, def: '聚丙烯类' },
    ],
  },
] as const;

/** 地域骨架草案：5 大区 + 候选重点城市（v1 承诺 5–8 重点区域，以下为待口径决策的候选名单）。 */
const REGIONS: ReadonlyArray<{
  code: string;
  nameCn: string;
  level: 'country' | 'macro_region' | 'city';
  parent?: string;
  note?: string;
}> = [
  { code: 'cn', nameCn: '中国', level: 'country' },
  { code: 'cn-north', nameCn: '华北', level: 'macro_region' },
  { code: 'cn-east', nameCn: '华东', level: 'macro_region' },
  { code: 'cn-central', nameCn: '华中', level: 'macro_region' },
  { code: 'cn-south', nameCn: '华南', level: 'macro_region' },
  { code: 'cn-southwest', nameCn: '西南', level: 'macro_region' },
  { code: 'baoding', nameCn: '保定', level: 'city', parent: 'cn-north', note: '废钢集散重点候选' },
  { code: 'tianjin', nameCn: '天津', level: 'city', parent: 'cn-north' },
  { code: 'suzhou', nameCn: '苏州', level: 'city', parent: 'cn-east' },
  { code: 'linyi', nameCn: '临沂', level: 'city', parent: 'cn-east', note: '废纸/废塑料集散重点候选' },
  { code: 'guangzhou', nameCn: '广州', level: 'city', parent: 'cn-south' },
  { code: 'foshan', nameCn: '佛山', level: 'city', parent: 'cn-south', note: '金属料集散重点候选' },
  { code: 'chongqing', nameCn: '重庆', level: 'city', parent: 'cn-southwest' },
];

async function main() {
  const connectionString = requireDatabaseUrl();
  const db = createDb(connectionString);

  console.log('种子：计价单位（元/吨 规范单位 + 换算）...');
  const [cnyTon] = await db
    .insert(unit)
    .values({ code: 'CNY_per_ton', nameCn: '元/吨', isCanonical: 1 })
    .onConflictDoUpdate({ target: unit.code, set: { nameCn: '元/吨', isCanonical: 1 } })
    .returning();
  const [cnyKg] = await db
    .insert(unit)
    .values({ code: 'CNY_per_kg', nameCn: '元/公斤' })
    .onConflictDoNothing()
    .returning();
  const [cnyJin] = await db
    .insert(unit)
    .values({ code: 'CNY_per_jin', nameCn: '元/斤' })
    .onConflictDoNothing()
    .returning();
  const [cnyWanTon] = await db
    .insert(unit)
    .values({ code: 'CNY_wan_per_ton', nameCn: '万元/吨' })
    .onConflictDoNothing()
    .returning();

  const conversions: Array<[string | undefined, number, string]> = [
    [cnyKg?.id, 1000, '1 元/公斤 = 1000 元/吨'],
    [cnyJin?.id, 2000, '1 元/斤 = 2000 元/吨'],
    [cnyWanTon?.id, 10000, '1 万元/吨 = 10000 元/吨'],
  ];
  for (const [fromId, factor, note] of conversions) {
    if (!fromId) continue;
    await db
      .insert(unitConversion)
      .values({ fromUnitId: fromId, toUnitId: cnyTon!.id, factor: String(factor), note })
      .onConflictDoNothing();
  }

  console.log('种子：地域骨架（draft，候选重点区域待口径决策）...');
  const regionIds = new Map<string, string>();
  for (const r of REGIONS) {
    const [row] = await db
      .insert(region)
      .values({
        code: r.code,
        nameCn: r.nameCn,
        level: r.level,
        parentId: r.parent ? (regionIds.get(r.parent) ?? null) : null,
        status: 'draft',
        note: r.note ?? null,
        decidedBy: 'seed:cto-draft',
      })
      .onConflictDoUpdate({ target: region.code, set: { nameCn: r.nameCn } })
      .returning();
    if (row) regionIds.set(r.code, row.id);
  }

  console.log('种子：品类与规格/等级草案（draft，待口径决策确认）...');
  for (const [ci, c] of CATEGORIES.entries()) {
    const [catRow] = await db
      .insert(category)
      .values({
        code: c.code,
        nameCn: c.nameCn,
        status: 'draft',
        sortOrder: ci,
        decidedBy: 'seed:cto-draft',
        notes: 'v1 五品类之一',
      })
      .onConflictDoUpdate({ target: category.code, set: { nameCn: c.nameCn } })
      .returning();
    if (!catRow) continue;
    for (const [si, s] of c.specs.entries()) {
      await db
        .insert(specGrade)
        .values({
          categoryId: catRow.id,
          code: s.code,
          nameCn: s.nameCn,
          kind: 'grade',
          qualityTier: s.tier,
          definition: s.def,
          isCore: s.core,
          status: 'draft',
          sortOrder: si,
          decidedBy: 'seed:cto-draft',
        })
        .onConflictDoUpdate({ target: [specGrade.categoryId, specGrade.code], set: { nameCn: s.nameCn, definition: s.def } });
    }
  }

  const counts = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  );
  console.log(`种子完成。当前 public 表数量：${counts.rows.length}`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
