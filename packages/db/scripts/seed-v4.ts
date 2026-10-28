/**
 * v4 种子：3 品类 + 36 地域 + 12 规格 + 2 来源 + 2 任务。幂等（on conflict do update）。
 *
 * 不种子价格/文档 —— 价格必须来自真实采集，文档来自真实内容生产。
 * 任务默认停用（schedule.enabled=false），避免种子一执行就自动外呼。
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

const CITIES = [
  { code: '4401', name: '广州', province: '44' },
  { code: '4406', name: '佛山', province: '44' },
  { code: '3205', name: '苏州', province: '32' },
] as const;

const SPECS = [
  { category: '1110105', code: 'heavy', name: '重废', aliases: [], tier: 5 },
  { category: '1110105', code: 'medium', name: '中废', aliases: [], tier: 4 },
  { category: '1110105', code: 'light', name: '轻薄料', aliases: [], tier: 2 },
  { category: '1110105', code: 'rebar-cut', name: '钢筋切粒', aliases: [], tier: 5 },
  { category: '1110201', code: 'bright', name: '光亮铜', aliases: ['光亮铜线'], tier: 5 },
  { category: '1110201', code: 'motor-wire', name: '电机线', aliases: ['电机线'], tier: 4 },
  { category: '1110201', code: 'yellow-brass', name: '黄杂铜', aliases: ['黄杂铜'], tier: 3 },
  { category: '1110201', code: 'brass-shred', name: '破碎黄铜', aliases: ['破碎黄铜'], tier: 2 },
  { category: '1110202', code: 'raw-alum', name: '生铝', aliases: [], tier: 4 },
  { category: '1110202', code: 'cooked-alum', name: '熟铝', aliases: [], tier: 5 },
  { category: '1110202', code: 'alum-wire', name: '铝线', aliases: [], tier: 5 },
  { category: '1110202', code: 'cans', name: '易拉罐', aliases: [], tier: 1 },
] as const;

const SOURCES = [
  {
    code: 'demo-fixture',
    name: '离线样例',
    type: 'price',
    baseUrl: 'fixture://fengj-copper.html',
    robotsStatus: 'allowed',
    redistribution: 'licensed',
    enabled: true,
  },
  {
    code: 'fengj',
    name: '网优废钢网',
    type: 'price',
    baseUrl: 'https://zs.fengj.com/ft/',
    robotsStatus: 'allowed',
    redistribution: 'internal_only',
    enabled: true,
  },
] as const;

const JOBS = [
  {
    code: 'demo.scrap-copper.fixture',
    category: '1110201',
    source: 'demo-fixture',
    kind: 'fetch_price',
    config: {
      adapter: 'fengj-copper-v1',
      target: { url: 'fixture://fengj-copper.html' },
      category_code: '1110201',
      price_type: 'indicative',
      unit: '元/吨',
      currency: 'CNY',
      limits: { timeout_s: 30 },
    },
    schedule: { cron: '7 * * * *', tz: 'Asia/Shanghai', enabled: false },
    enabled: true,
  },
  {
    code: 'fengj.scrap-copper.daily',
    category: '1110201',
    source: 'fengj',
    kind: 'fetch_price',
    config: {
      adapter: 'fengj-copper-v1',
      target: { url: 'https://zs.fengj.com/ft/' },
      category_code: '1110201',
      price_type: 'indicative',
      unit: '元/吨',
      currency: 'CNY',
      limits: { timeout_s: 120 },
    },
    schedule: {
      mode: 'random_window',
      windowStart: '07:10',
      windowEnd: '09:30',
      tz: 'Asia/Shanghai',
      enabled: false,
    },
    // 不自动外呼：需要人工确认来源可用后再启用。
    enabled: false,
  },
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

    // 地市级：按需添加，parent 指向所属省。
    const regionRows = await tx.select().from(v4.region);
    const regionIdByCode = new Map(regionRows.map((r) => [r.code, r.id]));
    for (const c of CITIES) {
      const parentId = regionIdByCode.get(c.province);
      if (!parentId) throw new Error(`城市 ${c.code} 缺少父省 ${c.province}`);
      await tx
        .insert(v4.region)
        .values({ code: c.code, name: c.name, level: 'city', parentId, sortOrder: Number(c.code), status: 'active' })
        .onConflictDoUpdate({
          target: v4.region.code,
          set: { name: c.name, level: 'city', parentId, sortOrder: Number(c.code), status: 'active' },
        });
    }

    for (const s of SPECS) {
      const categoryId = catIdByCode.get(s.category);
      if (!categoryId) throw new Error(`缺少品类 ${s.category}`);
      await tx
        .insert(v4.spec)
        .values({
          categoryId,
          code: s.code,
          name: s.name,
          aliases: [...s.aliases],
          tier: s.tier,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [v4.spec.categoryId, v4.spec.code],
          set: { name: s.name, aliases: [...s.aliases], tier: s.tier, status: 'active' },
        });
    }

    for (const s of SOURCES) {
      await tx
        .insert(v4.source)
        .values({
          code: s.code,
          name: s.name,
          type: s.type,
          baseUrl: s.baseUrl,
          robotsStatus: s.robotsStatus,
          redistribution: s.redistribution,
          enabled: s.enabled,
        })
        .onConflictDoUpdate({
          target: v4.source.code,
          set: {
            name: s.name,
            type: s.type,
            baseUrl: s.baseUrl,
            robotsStatus: s.robotsStatus,
            redistribution: s.redistribution,
            enabled: s.enabled,
            updatedAt: new Date(),
          },
        });
    }

    const sourceRows = await tx
      .select()
      .from(v4.source)
      .where(inArray(v4.source.code, SOURCES.map((s) => s.code)));
    const sourceIdByCode = new Map(sourceRows.map((s) => [s.code, s.id]));

    for (const j of JOBS) {
      const categoryId = catIdByCode.get(j.category);
      if (!categoryId) throw new Error(`任务 ${j.code} 缺少品类 ${j.category}`);
      const sourceId = sourceIdByCode.get(j.source);
      if (!sourceId) throw new Error(`任务 ${j.code} 缺少来源 ${j.source}`);
      await tx
        .insert(v4.job)
        .values({
          code: j.code,
          categoryId,
          sourceId,
          kind: j.kind,
          schedule: j.schedule,
          config: j.config,
          enabled: j.enabled,
        })
        .onConflictDoUpdate({
          target: v4.job.code,
          set: {
            categoryId,
            sourceId,
            kind: j.kind,
            schedule: j.schedule,
            config: j.config,
            enabled: j.enabled,
            updatedAt: new Date(),
          },
        });
    }
  });

  await pool.end();
  console.log('v4 种子完成：3 品类 / 36 地域 / 12 规格 / 2 来源 / 2 任务。');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});