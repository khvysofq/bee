/**
 * v4 种子：3 品类 + 33 地域 + 12 规格。幂等（on conflict do update）。
 *
 * 不种子来源/任务/价格/文档 —— 这些必须来自真实采集与人工配置。
 */
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as v4 from '../src/schema-v4';
import { resolveV4DatabaseUrl } from '../src/env';

const CATEGORIES = [
  { code: '1110105', nameCn: '废钢铁', nameEn: 'Scrap steel', description: '废钢铁回收与再生原料', sortOrder: 1 },
  { code: '1110201', nameCn: '废铜', nameEn: 'Scrap copper', description: '废铜回收与再生原料', sortOrder: 2 },
  { code: '1110202', nameCn: '废铝', nameEn: 'Scrap aluminium', description: '废铝回收与再生原料', sortOrder: 3 },
] as const;

const PROVINCES = [
  ['11', '北京'], ['12', '天津'], ['13', '河北'], ['14', '山西'], ['15', '内蒙古'],
  ['21', '辽宁'], ['22', '吉林'], ['23', '黑龙江'],
  ['31', '上海'], ['32', '江苏'], ['33', '浙江'], ['34', '安徽'], ['35', '福建'], ['36', '江西'], ['37', '山东'],
  ['41', '河南'], ['42', '湖北'], ['43', '湖南'], ['44', '广东'], ['45', '广西'], ['46', '海南'],
  ['50', '重庆'], ['51', '四川'], ['52', '贵州'], ['53', '云南'], ['54', '西藏'],
  ['61', '陕西'], ['62', '甘肃'], ['63', '青海'], ['64', '宁夏'], ['65', '新疆'],
] as const;

const SPECS = [
  { category: '1110105', code: 'heavy', name: '重废', tier: 5 },
  { category: '1110105', code: 'medium', name: '中废', tier: 4 },
  { category: '1110105', code: 'light', name: '轻薄料', tier: 2 },
  { category: '1110105', code: 'rebar-cut', name: '钢筋切粒', tier: 5 },
  { category: '1110201', code: 'bright', name: '光亮铜', tier: 5 },
  { category: '1110201', code: 'motor-wire', name: '电机线', tier: 4 },
  { category: '1110201', code: 'yellow-brass', name: '黄杂铜', tier: 3 },
  { category: '1110201', code: 'brass-shred', name: '破碎黄铜', tier: 2 },
  { category: '1110202', code: 'raw-alum', name: '生铝', tier: 4 },
  { category: '1110202', code: 'cooked-alum', name: '熟铝', tier: 5 },
  { category: '1110202', code: 'alum-wire', name: '铝线', tier: 5 },
  { category: '1110202', code: 'cans', name: '易拉罐', tier: 1 },
] as const;

async function main() {
  const pool = new pg.Pool({ connectionString: resolveV4DatabaseUrl(), max: 1 });
  const db = drizzle(pool, { schema: v4 });

  await db.transaction(async (tx) => {
    for (const c of CATEGORIES) {
      await tx
        .insert(v4.category)
        .values({
          code: c.code,
          nameCn: c.nameCn,
          nameEn: c.nameEn,
          description: c.description,
          status: 'active',
          sortOrder: c.sortOrder,
        })
        .onConflictDoUpdate({
          target: v4.category.code,
          set: {
            nameCn: c.nameCn,
            nameEn: c.nameEn,
            description: c.description,
            status: 'active',
            sortOrder: c.sortOrder,
            updatedAt: new Date(),
          },
        });
    }

    // 地域：WORLD → CN → 31 省。
    await tx
      .insert(v4.region)
      .values({ code: 'WORLD', name: '全球', level: 'global', sortOrder: 0, status: 'active' })
      .onConflictDoUpdate({
        target: v4.region.code,
        set: { name: '全球', level: 'global', sortOrder: 0, status: 'active' },
      });

    const [world] = await tx.select().from(v4.region).where(eq(v4.region.code, 'WORLD'));
    if (!world) throw new Error('地域种子缺少 WORLD');
    await tx
      .insert(v4.region)
      .values({ code: 'CN', name: '中国', level: 'country', parentId: world.id, sortOrder: 1, status: 'active' })
      .onConflictDoUpdate({
        target: v4.region.code,
        set: { name: '中国', level: 'country', parentId: world.id, sortOrder: 1, status: 'active' },
      });

    const [cn] = await tx.select().from(v4.region).where(eq(v4.region.code, 'CN'));
    if (!cn) throw new Error('地域种子缺少 CN');
    for (const [code, name] of PROVINCES) {
      await tx
        .insert(v4.region)
        .values({ code, name, level: 'province', parentId: cn.id, sortOrder: Number(code), status: 'active' })
        .onConflictDoUpdate({
          target: v4.region.code,
          set: { name, level: 'province', parentId: cn.id, sortOrder: Number(code), status: 'active' },
        });
    }

    const cats = await tx
      .select()
      .from(v4.category)
      .where(inArray(v4.category.code, CATEGORIES.map((c) => c.code)));
    const catIdByCode = new Map(cats.map((c) => [c.code, c.id]));

    for (const s of SPECS) {
      const categoryId = catIdByCode.get(s.category);
      if (!categoryId) throw new Error(`缺少品类 ${s.category}`);
      await tx
        .insert(v4.spec)
        .values({
          categoryId,
          code: s.code,
          name: s.name,
          aliases: [],
          tier: s.tier,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [v4.spec.categoryId, v4.spec.code],
          set: { name: s.name, tier: s.tier, status: 'active' },
        });
    }
  });

  await pool.end();
  console.log('v4 种子完成：3 品类 / 33 地域 / 12 规格。');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});