/**
 * 商机演示数据：3 品类 × 4 地区 × 3 家企业 = 36 家；每品类 8 条商机 = 24 条。
 *
 * 幂等：
 *  - company 以 (name, region_id) 为键 upsert；
 *  - opportunity 以 sha256('opp|' + companyName + title) 转 UUID 为键 upsert，
 *    并清理本次企业下不再属于当前集合的演示商机（企业名/标题变化时不会留孤儿）。
 *
 * 全部为虚构演示数据：企业名、联系人、电话均为虚构，电话已脱敏。
 * 价格参考 price_daily 最新已发布市场价，按 ±2%~5% 生成区间，不来自模型。
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { createV4Db, resolveV4DatabaseUrl, v4, type BeeV4Db } from '@bee/db';

const CATEGORY_CODES = ['1110105', '1110201', '1110202'] as const;

interface CategoryProfile {
  code: string;
  name: string;
  metal: string;
  unit: string;
  regions: string[];
  specs: string[];
  smelterProducts: string;
}

const PROFILES: CategoryProfile[] = [
  {
    code: '1110105',
    name: '废钢铁',
    metal: '钢',
    unit: '元/吨',
    regions: ['1302', '3205', '4406', '3713'],
    specs: ['重废', '钢筋切粒', '中废', '轻薄料'],
    smelterProducts: '钢坯、铸造用废钢',
  },
  {
    code: '1110201',
    name: '废铜',
    metal: '铜',
    unit: '元/吨',
    regions: ['4406', '4401', '3205', '12'],
    specs: ['光亮铜', '电机线', '黄杂铜', '破碎黄铜'],
    smelterProducts: '阳极铜、粗铜',
  },
  {
    code: '1110202',
    name: '废铝',
    metal: '铝',
    unit: '元/吨',
    regions: ['4406', '3302', '3713', '3205'],
    specs: ['生铝', '熟铝', '铝线', '易拉罐'],
    smelterProducts: '铝合金锭、铝棒',
  },
];

interface CityMeta {
  city: string;
  district: string;
  province: string;
}

const CITIES: Record<string, CityMeta> = {
  '1302': { city: '唐山', district: '丰润', province: '河北' },
  '3205': { city: '苏州', district: '吴江', province: '江苏' },
  '4406': { city: '佛山', district: '南海', province: '广东' },
  '3713': { city: '临沂', district: '兰山', province: '山东' },
  '4401': { city: '广州', district: '增城', province: '广东' },
  '12': { city: '天津', district: '静海', province: '天津' },
  '3302': { city: '宁波', district: '慈溪', province: '浙江' },
};

/** 36 个虚构品牌词（只用常用字，避免字体缺字），保证同名地区内三家企业名称不同。 */
const BRANDS = [
  '恒烁', '鑫源', '晟澜', '泓越', '启铭', '铭川', '屹峰', '棠越', '瀚铎',
  '铄川', '煜凯', '沣源', '泰和', '瑞容', '承烁', '越青', '津源', '冀铄',
  '沂澜', '淞越', '甬鑫', '穗烨', '吴源', '澜青', '坤烁', '锦凯', '沅川',
  '昊越', '柏容', '汐源', '峥澜', '宏铄', '砚鑫', '沧越', '屹澜', '沐凯',
] as const;

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙'] as const;

const TYPE_LABEL: Record<string, string> = {
  recycler: '回收加工',
  smelter: '冶炼',
  end_user: '终端',
  trader: '贸易',
  supplier: '供应商',
};

type CompanyType = keyof typeof TYPE_LABEL;

interface SeededCompany {
  id: string;
  name: string;
  categoryCode: string;
  categoryName: string;
  regionCode: string;
  city: string;
  province: string;
  type: CompanyType;
  contactName: string;
  contactPhone: string;
}

function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex');
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function maskPhone(seed: number): string {
  return `138****${String(seed % 10000).padStart(4, '0')}`;
}

function money(value: number): string {
  return Math.round(value).toLocaleString('zh-CN');
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** 采购/供应参考价区间：在最新价基础上按低/高百分比生成。 */
function priceBand(base: number, lowPct: number, highPct: number): { min: number; max: number } {
  return { min: Math.round(base * (1 + lowPct) * 100) / 100, max: Math.round(base * (1 + highPct) * 100) / 100 };
}

async function latestPriceByCategory(database: BeeV4Db): Promise<Map<string, number>> {
  const result = await database.execute(sql`
    select distinct on (pd.category_id)
           c.code as category_code,
           pd.value_mid::text as value_mid
      from price_daily pd
      join category c on c.id = pd.category_id
      join region r on r.id = pd.region_id
     where pd.status = 'published'
       and pd.price_type = 'market'
       and pd.value_mid is not null
     order by pd.category_id, (r.code = 'CN') desc, pd.price_date desc
  `);

  const prices = new Map<string, number>();
  for (const row of result.rows as unknown as Array<{ category_code: string; value_mid: string }>) {
    const value = Number(row.value_mid);
    if (Number.isFinite(value)) prices.set(row.category_code, value);
  }
  return prices;
}

async function main() {
  const db = createV4Db(resolveV4DatabaseUrl());

  await db.transaction(async (tx) => {
    const categoryRows = await tx
      .select({ id: v4.category.id, code: v4.category.code, name: v4.category.nameCn })
      .from(v4.category)
      .where(inArray(v4.category.code, [...CATEGORY_CODES]));
    const categoryByCode = new Map(categoryRows.map((row) => [row.code, row]));
    if (categoryByCode.size !== CATEGORY_CODES.length) {
      throw new Error('缺少品类种子，请先执行 pnpm --filter @bee/db seed:v4');
    }

    const regionCodes = [...new Set(PROFILES.flatMap((profile) => profile.regions))];
    const regionRows = await tx
      .select({ id: v4.region.id, code: v4.region.code, name: v4.region.name })
      .from(v4.region)
      .where(inArray(v4.region.code, regionCodes));
    const regionByCode = new Map(regionRows.map((row) => [row.code, row]));
    for (const code of regionCodes) {
      if (!regionByCode.has(code)) throw new Error(`缺少地域 ${code}`);
    }

    const prices = await latestPriceByCategory(db);
    for (const profile of PROFILES) {
      if (!prices.has(profile.code)) {
        throw new Error(`品类 ${profile.code} 没有已发布价格，无法生成参考价`);
      }
    }

    const companies: SeededCompany[] = [];
    let brandIndex = 0;
    let companyIndex = 0;

    for (const profile of PROFILES) {
      const category = categoryByCode.get(profile.code)!;
      for (const [regionIndex, regionCode] of profile.regions.entries()) {
        const city = CITIES[regionCode];
        if (!city) throw new Error(`缺少城市信息 ${regionCode}`);

        const roles: CompanyType[] = [
          'recycler',
          profile.code === '1110105' ? 'end_user' : 'smelter',
          regionIndex % 2 === 0 ? 'trader' : 'supplier',
        ];

        for (const [roleIndex, type] of roles.entries()) {
          const brand = BRANDS[brandIndex++ % BRANDS.length]!;
          const suffix =
            type === 'recycler'
              ? '再生资源'
              : type === 'trader' || type === 'supplier'
                ? '供应链'
                : profile.code === '1110105'
                  ? '金属制品'
                  : profile.code === '1110201'
                    ? '铜业'
                    : '铝业';
          const name = `${city.city}${city.district}${brand}${suffix}有限公司`;
          const contactName = `${SURNAMES[(companyIndex + roleIndex) % SURNAMES.length]}经理`;
          const contactPhone = maskPhone((companyIndex + 1) * 137);
          const scale =
            type === 'recycler'
              ? `月处理 ${(6 + (companyIndex % 5)) * 1000} 吨`
              : type === 'end_user'
                ? `月采购 ${(5 + (companyIndex % 4)) * 1000} 吨`
                : type === 'smelter'
                  ? `月产 ${(4 + (companyIndex % 4)) * 1000} 吨`
                  : type === 'supplier'
                    ? `月供 ${(2 + (companyIndex % 3)) * 1000} 吨`
                    : `月贸易 ${(3 + (companyIndex % 3)) * 1000} 吨`;
          const mainProducts =
            type === 'recycler' || type === 'trader'
              ? `${profile.specs[0]}、${profile.specs[1]}`
              : type === 'supplier'
                ? `${profile.specs[1]}、${profile.specs[3]}`
                : profile.smelterProducts;

          const [row] = await tx
            .insert(v4.company)
            .values({
              name,
              shortName: `${brand}${profile.metal}`,
              categoryId: category.id,
              regionId: regionByCode.get(regionCode)!.id,
              type,
              scale,
              mainProducts,
              description: `${city.province}${city.city}的${profile.name}${TYPE_LABEL[type]}企业。演示数据：企业名称、联系人及联系方式均为虚构。`,
              contactName,
              contactPhone,
              verified: type === 'recycler' || type === 'smelter' || type === 'end_user',
              isDemo: true,
              status: 'active',
            })
            .onConflictDoUpdate({
              target: [v4.company.name, v4.company.regionId],
              set: {
                shortName: `${brand}${profile.metal}`,
                categoryId: category.id,
                type,
                scale,
                mainProducts,
                description: `${city.province}${city.city}的${profile.name}${TYPE_LABEL[type]}企业。演示数据：企业名称、联系人及联系方式均为虚构。`,
                contactName,
                contactPhone,
                verified: type === 'recycler' || type === 'smelter' || type === 'end_user',
                isDemo: true,
                status: 'active',
                updatedAt: new Date(),
              },
            })
            .returning({ id: v4.company.id });

          if (!row) throw new Error(`企业写入失败：${name}`);
          companies.push({
            id: row.id,
            name,
            categoryCode: profile.code,
            categoryName: profile.name,
            regionCode,
            city: city.city,
            province: city.province,
            type,
            contactName,
            contactPhone,
          });
          companyIndex += 1;
        }
      }
    }

    const now = new Date();
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`);

    interface OpportunitySlot {
      kind: 'purchase' | 'supply' | 'cooperation';
      regionIndex: number;
      role: 'buyer' | 'recycler' | 'seller';
      specIndex: number;
      quantity: number;
      lowPct?: number;
      highPct?: number;
      deadlineDays: number;
    }

    const SLOTS: OpportunitySlot[] = [
      { kind: 'purchase', regionIndex: 0, role: 'buyer', specIndex: 0, quantity: 3000, lowPct: -0.025, highPct: -0.01, deadlineDays: 21 },
      { kind: 'purchase', regionIndex: 1, role: 'buyer', specIndex: 1, quantity: 1500, lowPct: -0.02, highPct: -0.005, deadlineDays: 14 },
      { kind: 'purchase', regionIndex: 2, role: 'buyer', specIndex: 2, quantity: 2000, lowPct: -0.03, highPct: -0.015, deadlineDays: 30 },
      { kind: 'purchase', regionIndex: 3, role: 'buyer', specIndex: 0, quantity: 800, lowPct: -0.02, highPct: 0, deadlineDays: 10 },
      { kind: 'supply', regionIndex: 0, role: 'recycler', specIndex: 0, quantity: 1200, lowPct: 0.02, highPct: 0.035, deadlineDays: 20 },
      { kind: 'supply', regionIndex: 1, role: 'recycler', specIndex: 1, quantity: 900, lowPct: 0.025, highPct: 0.04, deadlineDays: 25 },
      { kind: 'supply', regionIndex: 2, role: 'recycler', specIndex: 3, quantity: 600, lowPct: 0.03, highPct: 0.05, deadlineDays: 15 },
      { kind: 'cooperation', regionIndex: 3, role: 'seller', specIndex: 0, quantity: 5000, deadlineDays: 45 },
    ];

    const opportunityRows: Array<typeof v4.opportunity.$inferInsert> = [];
    let slotIndex = 0;

    for (const profile of PROFILES) {
      const category = categoryByCode.get(profile.code)!;
      const base = prices.get(profile.code)!;
      for (const slot of SLOTS) {
        const regionCode = profile.regions[slot.regionIndex]!;
        const role: CompanyType =
          slot.role === 'buyer'
            ? profile.code === '1110105'
              ? 'end_user'
              : 'smelter'
            : slot.role === 'seller'
              ? slot.regionIndex % 2 === 0
                ? 'trader'
                : 'supplier'
              : 'recycler';
        const company = companies.find(
          (item) =>
            item.categoryCode === profile.code &&
            item.regionCode === regionCode &&
            item.type === role,
        );
        if (!company) {
          throw new Error(`缺少企业 ${profile.code}/${regionCode}/${role}`);
        }

        const spec = profile.specs[slot.specIndex]!;
        const quantityText = money(slot.quantity);
        let title: string;
        let priceMin: string | null = null;
        let priceMax: string | null = null;
        let description: string;

        if (slot.kind === 'cooperation') {
          title = `寻求${profile.name}打包场长期合作，月处理 ${quantityText} 吨`;
          description = `演示商机：寻找${spec}长期稳定货源，合作方式与结算周期可协商。企业及联系方式为虚构，仅用于界面演示。`;
        } else {
          const band = priceBand(base, slot.lowPct ?? 0, slot.highPct ?? 0);
          priceMin = band.min.toFixed(2);
          priceMax = band.max.toFixed(2);
          const range = `${money(band.min)}–${money(band.max)} ${profile.unit}`;
          title =
            slot.kind === 'purchase'
              ? `长期采购${spec}，月需 ${quantityText} 吨，参考 ${range}`
              : `供应${spec}，月供 ${quantityText} 吨，参考 ${range}`;
          description =
            slot.kind === 'purchase'
              ? `演示商机：${company.city}地区${profile.name}采购需求，规格${spec}，月需 ${quantityText} 吨，参考价 ${range}。价格参考近期行情生成，不构成成交承诺。`
              : `演示商机：${company.city}地区${profile.name}可供货源，规格${spec}，月供 ${quantityText} 吨，参考价 ${range}。价格参考近期行情生成，不构成成交承诺。`;
        }

        const id = deterministicUuid(`opp|${company.name}|${title}`);
        opportunityRows.push({
          id,
          companyId: company.id,
          categoryId: category.id,
          regionId: regionByCode.get(regionCode)!.id,
          kind: slot.kind,
          title,
          description,
          quantity: slot.quantity.toFixed(2),
          unit: '吨/月',
          priceMin,
          priceMax,
          currency: 'CNY',
          deadline: addDays(today, slot.deadlineDays),
          contactName: company.contactName,
          contactPhone: company.contactPhone,
          status: 'open',
          isDemo: true,
          publishedAt: new Date(now.getTime() - slotIndex * 3 * 3600_000),
        });
        slotIndex += 1;
      }
    }

    const companyIds = companies.map((company) => company.id);
    const opportunityIds = opportunityRows.map((row) => row.id!);

    // 品牌词或企业集合变化时，旧演示企业会留在库里；先清掉它们的商机，再删企业。
    // 仅限 is_demo=true 的行，不触碰任何真实或其它来源的数据。
    const staleCompanies = await tx
      .select({ id: v4.company.id })
      .from(v4.company)
      .where(and(eq(v4.company.isDemo, true), notInArray(v4.company.id, companyIds)));
    const staleCompanyIds = staleCompanies.map((row) => row.id);
    if (staleCompanyIds.length > 0) {
      await tx
        .delete(v4.opportunity)
        .where(inArray(v4.opportunity.companyId, staleCompanyIds));
      await tx.delete(v4.company).where(inArray(v4.company.id, staleCompanyIds));
    }

    // 标题里的参考价会随行情变化；清掉本次企业下已不在当前集合的演示商机，保证重复执行数量不增长。
    await tx
      .delete(v4.opportunity)
      .where(
        and(
          inArray(v4.opportunity.companyId, companyIds),
          eq(v4.opportunity.isDemo, true),
          notInArray(v4.opportunity.id, opportunityIds),
        ),
      );

    for (const row of opportunityRows) {
      await tx
        .insert(v4.opportunity)
        .values(row)
        .onConflictDoUpdate({
          target: v4.opportunity.id,
          set: {
            companyId: row.companyId,
            categoryId: row.categoryId,
            regionId: row.regionId,
            kind: row.kind,
            title: row.title,
            description: row.description,
            quantity: row.quantity,
            unit: row.unit,
            priceMin: row.priceMin,
            priceMax: row.priceMax,
            currency: row.currency,
            deadline: row.deadline,
            contactName: row.contactName,
            contactPhone: row.contactPhone,
            status: row.status,
            isDemo: true,
            publishedAt: row.publishedAt,
            updatedAt: new Date(),
          },
        });
    }

    const [companyCount] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(v4.company)
      .where(inArray(v4.company.id, companyIds));
    const [opportunityCount] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(v4.opportunity)
      .where(inArray(v4.opportunity.id, opportunityIds));
    const byCategory = await tx
      .select({
        category: v4.category.nameCn,
        companies: sql<number>`count(distinct ${v4.company.id})::int`,
      })
      .from(v4.company)
      .innerJoin(v4.category, eq(v4.company.categoryId, v4.category.id))
      .where(inArray(v4.company.id, companyIds))
      .groupBy(v4.category.nameCn)
      .orderBy(v4.category.nameCn);
    const byKind = await tx
      .select({ kind: v4.opportunity.kind, total: sql<number>`count(*)::int` })
      .from(v4.opportunity)
      .where(inArray(v4.opportunity.id, opportunityIds))
      .groupBy(v4.opportunity.kind)
      .orderBy(v4.opportunity.kind);
    const byRegion = await tx
      .select({ region: v4.region.name, companies: sql<number>`count(*)::int` })
      .from(v4.company)
      .innerJoin(v4.region, eq(v4.company.regionId, v4.region.id))
      .where(inArray(v4.company.id, companyIds))
      .groupBy(v4.region.name)
      .orderBy(v4.region.name);

    console.log(`商机演示数据完成：企业 ${companyCount?.total ?? 0} 家，商机 ${opportunityCount?.total ?? 0} 条。`);
    console.log('按品类企业分布：', byCategory);
    console.log('按类型商机分布：', byKind);
    console.log('按地区企业分布：', byRegion);
  });

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});