import { and, countDistinct, desc, eq, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { v4, type BeeDb } from '@bee/db';
import { numericToNumber } from '@bee/core';
import { db as defaultDb } from '../db';

/**
 * 商机频道只读数据层。
 *
 * 全部来自 v4 的 company / opportunity / category / region；
 * 演示数据由 is_demo 标记，页面据此显示「演示数据」，不把演示企业当成真实主体。
 */

export type OpportunityKind = 'purchase' | 'supply' | 'cooperation';
export type CompanyType = 'recycler' | 'smelter' | 'trader' | 'end_user' | 'supplier';

export const OPPORTUNITY_KIND_LABEL: Record<OpportunityKind, string> = {
  purchase: '采购',
  supply: '供应',
  cooperation: '合作',
};

export const COMPANY_TYPE_LABEL: Record<CompanyType, string> = {
  recycler: '回收加工',
  smelter: '冶炼',
  trader: '贸易',
  end_user: '终端',
  supplier: '供应商',
};

export interface OpportunityFilters {
  categoryCode?: string;
  kind?: string;
  regionCode?: string;
}

export interface OpportunityListItem {
  id: string;
  title: string;
  kind: OpportunityKind;
  status: string;
  isDemo: boolean;
  categoryCode: string;
  categoryName: string;
  regionCode: string;
  regionName: string;
  provinceName: string | null;
  quantity: number | null;
  unit: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string;
  deadline: string | null;
  publishedAt: string;
  companyId: string;
  companyName: string;
  companyShortName: string | null;
  companyType: CompanyType;
  verified: boolean;
}

export interface OpportunityStats {
  companyCount: number;
  purchaseCount: number;
  supplyCount: number;
  cooperationCount: number;
  regionCount: number;
}

export interface OpportunityFacets {
  categories: Array<{ code: string; name: string }>;
  regions: Array<{ code: string; name: string }>;
}

export interface CompanySummary {
  id: string;
  name: string;
  shortName: string | null;
  type: CompanyType;
  scale: string | null;
  mainProducts: string | null;
  verified: boolean;
  categoryCode: string;
  categoryName: string;
}

export interface CompanyRegionGroup {
  regionCode: string;
  regionName: string;
  provinceName: string | null;
  total: number;
  companies: CompanySummary[];
}

export interface CompanyProfile extends CompanySummary {
  description: string | null;
  contactName: string | null;
  contactPhone: string | null;
  isDemo: boolean;
  status: string;
  regionCode: string;
  regionName: string;
  provinceName: string | null;
}

export interface OpportunityDetail extends OpportunityListItem {
  description: string | null;
  contactName: string | null;
  contactPhone: string | null;
  company: CompanyProfile;
  otherOpenCount: number;
}

export interface CompanyDetail extends CompanyProfile {
  opportunities: OpportunityListItem[];
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value: Date | string | null): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? '';
}

function num(value: string | null): number | null {
  return numericToNumber(value);
}

const province = alias(v4.region, 'province');

const opportunityColumns = {
  id: v4.opportunity.id,
  title: v4.opportunity.title,
  kind: v4.opportunity.kind,
  status: v4.opportunity.status,
  isDemo: v4.opportunity.isDemo,
  categoryCode: v4.category.code,
  categoryName: v4.category.nameCn,
  regionCode: v4.region.code,
  regionName: v4.region.name,
  provinceName: province.name,
  quantity: v4.opportunity.quantity,
  unit: v4.opportunity.unit,
  priceMin: v4.opportunity.priceMin,
  priceMax: v4.opportunity.priceMax,
  currency: v4.opportunity.currency,
  deadline: v4.opportunity.deadline,
  publishedAt: v4.opportunity.publishedAt,
  companyId: v4.company.id,
  companyName: v4.company.name,
  companyShortName: v4.company.shortName,
  companyType: v4.company.type,
  verified: v4.company.verified,
};

type OpportunityRow = {
  [K in keyof typeof opportunityColumns]: unknown;
};

function toOpportunity(row: OpportunityRow): OpportunityListItem {
  return {
    id: String(row.id),
    title: String(row.title),
    kind: String(row.kind) as OpportunityKind,
    status: String(row.status),
    isDemo: Boolean(row.isDemo),
    categoryCode: String(row.categoryCode),
    categoryName: String(row.categoryName),
    regionCode: String(row.regionCode),
    regionName: String(row.regionName),
    provinceName: row.provinceName ? String(row.provinceName) : null,
    quantity: num(row.quantity as string | null),
    unit: row.unit ? String(row.unit) : null,
    priceMin: num(row.priceMin as string | null),
    priceMax: num(row.priceMax as string | null),
    currency: String(row.currency),
    deadline: row.deadline ? String(row.deadline) : null,
    publishedAt: iso(row.publishedAt as Date | string | null),
    companyId: String(row.companyId),
    companyName: String(row.companyName),
    companyShortName: row.companyShortName ? String(row.companyShortName) : null,
    companyType: String(row.companyType) as CompanyType,
    verified: Boolean(row.verified),
  };
}

function baseOpportunityQuery(database: BeeDb) {
  return database
    .select(opportunityColumns)
    .from(v4.opportunity)
    .innerJoin(v4.company, eq(v4.opportunity.companyId, v4.company.id))
    .innerJoin(v4.category, eq(v4.opportunity.categoryId, v4.category.id))
    .innerJoin(v4.region, eq(v4.opportunity.regionId, v4.region.id))
    .leftJoin(province, eq(v4.region.parentId, province.id));
}

export async function loadOpportunities(
  database: BeeDb = defaultDb,
  filters: OpportunityFilters = {},
): Promise<OpportunityListItem[]> {
  const conditions = [];
  if (filters.categoryCode) conditions.push(eq(v4.category.code, filters.categoryCode));
  if (filters.kind) conditions.push(eq(v4.opportunity.kind, filters.kind));
  if (filters.regionCode) conditions.push(eq(v4.region.code, filters.regionCode));

  const query = baseOpportunityQuery(database);
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows
    .map((row) => toOpportunity(row as unknown as OpportunityRow))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export async function loadOpportunityStats(
  database: BeeDb = defaultDb,
): Promise<OpportunityStats> {
  const [companyRow] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(v4.company)
    .where(eq(v4.company.status, 'active'));

  const kindRows = await database
    .select({ kind: v4.opportunity.kind, total: sql<number>`count(*)::int` })
    .from(v4.opportunity)
    .where(eq(v4.opportunity.status, 'open'))
    .groupBy(v4.opportunity.kind);

  const [regionRow] = await database
    .select({ total: countDistinct(v4.opportunity.regionId) })
    .from(v4.opportunity)
    .where(eq(v4.opportunity.status, 'open'));

  const kindCount = (kind: string) =>
    kindRows.find((row) => row.kind === kind)?.total ?? 0;

  return {
    companyCount: companyRow?.total ?? 0,
    purchaseCount: kindCount('purchase'),
    supplyCount: kindCount('supply'),
    cooperationCount: kindCount('cooperation'),
    regionCount: Number(regionRow?.total ?? 0),
  };
}

export async function loadOpportunityFacets(
  database: BeeDb = defaultDb,
): Promise<OpportunityFacets> {
  const categories = await database
    .select({ code: v4.category.code, name: v4.category.nameCn })
    .from(v4.category)
    .where(eq(v4.category.status, 'active'))
    .orderBy(v4.category.sortOrder, v4.category.code);

  const regions = await database
    .selectDistinct({
      code: v4.region.code,
      name: v4.region.name,
      sortOrder: v4.region.sortOrder,
    })
    .from(v4.opportunity)
    .innerJoin(v4.region, eq(v4.opportunity.regionId, v4.region.id))
    .where(eq(v4.opportunity.status, 'open'))
    .orderBy(v4.region.sortOrder, v4.region.name);

  return { categories, regions: regions.map(({ code, name }) => ({ code, name })) };
}

export async function loadCompaniesByRegion(
  database: BeeDb = defaultDb,
  options: { categoryCode?: string } = {},
): Promise<CompanyRegionGroup[]> {
  const conditions = [eq(v4.company.status, 'active')];
  if (options.categoryCode) conditions.push(eq(v4.category.code, options.categoryCode));

  const rows = await database
    .select({
      id: v4.company.id,
      name: v4.company.name,
      shortName: v4.company.shortName,
      type: v4.company.type,
      scale: v4.company.scale,
      mainProducts: v4.company.mainProducts,
      verified: v4.company.verified,
      categoryCode: v4.category.code,
      categoryName: v4.category.nameCn,
      regionCode: v4.region.code,
      regionName: v4.region.name,
      regionSort: v4.region.sortOrder,
      provinceName: province.name,
    })
    .from(v4.company)
    .innerJoin(v4.category, eq(v4.company.categoryId, v4.category.id))
    .innerJoin(v4.region, eq(v4.company.regionId, v4.region.id))
    .leftJoin(province, eq(v4.region.parentId, province.id))
    .where(and(...conditions))
    .orderBy(desc(v4.company.verified), v4.company.name);

  const byRegion = new Map<
    string,
    {
      regionCode: string;
      regionName: string;
      provinceName: string | null;
      regionSort: number;
      companies: CompanySummary[];
    }
  >();

  for (const row of rows) {
    const company: CompanySummary = {
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      type: row.type as CompanyType,
      scale: row.scale,
      mainProducts: row.mainProducts,
      verified: row.verified,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
    };
    const existing = byRegion.get(row.regionCode);
    if (existing) {
      existing.companies.push(company);
    } else {
      byRegion.set(row.regionCode, {
        regionCode: row.regionCode,
        regionName: row.regionName,
        provinceName: row.provinceName,
        regionSort: row.regionSort,
        companies: [company],
      });
    }
  }

  return [...byRegion.values()]
    .map((group) => {
      // 每组优先覆盖不同品类，再按认证/名称补齐，最多 3 家。
      const picked: CompanySummary[] = [];
      const seenCategories = new Set<string>();
      for (const company of group.companies) {
        if (picked.length >= 3) break;
        if (seenCategories.has(company.categoryCode)) continue;
        seenCategories.add(company.categoryCode);
        picked.push(company);
      }
      for (const company of group.companies) {
        if (picked.length >= 3) break;
        if (!picked.includes(company)) picked.push(company);
      }
      return {
        regionCode: group.regionCode,
        regionName: group.regionName,
        provinceName: group.provinceName,
        regionSort: group.regionSort,
        total: group.companies.length,
        companies: picked,
      };
    })
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.regionSort - b.regionSort ||
        a.regionName.localeCompare(b.regionName, 'zh-CN'),
    )
    .map(({ regionSort: _regionSort, ...group }) => group);
}

export async function getOpportunity(
  database: BeeDb = defaultDb,
  id: string,
): Promise<OpportunityDetail | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const [row] = await database
    .select({
      ...opportunityColumns,
      description: v4.opportunity.description,
      contactName: v4.opportunity.contactName,
      contactPhone: v4.opportunity.contactPhone,
      companyDescription: v4.company.description,
      companyScale: v4.company.scale,
      companyMainProducts: v4.company.mainProducts,
      companyContactName: v4.company.contactName,
      companyContactPhone: v4.company.contactPhone,
      companyIsDemo: v4.company.isDemo,
      companyStatus: v4.company.status,
    })
    .from(v4.opportunity)
    .innerJoin(v4.company, eq(v4.opportunity.companyId, v4.company.id))
    .innerJoin(v4.category, eq(v4.opportunity.categoryId, v4.category.id))
    .innerJoin(v4.region, eq(v4.opportunity.regionId, v4.region.id))
    .leftJoin(province, eq(v4.region.parentId, province.id))
    .where(eq(v4.opportunity.id, id))
    .limit(1);

  if (!row) return null;

  const [otherRow] = await database
    .select({ total: sql<number>`count(*)::int` })
    .from(v4.opportunity)
    .where(
      and(
        eq(v4.opportunity.companyId, row.companyId),
        eq(v4.opportunity.status, 'open'),
        ne(v4.opportunity.id, id),
      ),
    );

  const item = toOpportunity(row as unknown as OpportunityRow);
  return {
    ...item,
    description: row.description,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
    otherOpenCount: otherRow?.total ?? 0,
    company: {
      id: row.companyId,
      name: row.companyName,
      shortName: row.companyShortName,
      type: row.companyType as CompanyType,
      scale: row.companyScale,
      mainProducts: row.companyMainProducts,
      verified: row.verified,
      categoryCode: row.categoryCode,
      categoryName: row.categoryName,
      description: row.companyDescription,
      contactName: row.companyContactName,
      contactPhone: row.companyContactPhone,
      isDemo: row.companyIsDemo,
      status: row.companyStatus,
      regionCode: row.regionCode,
      regionName: row.regionName,
      provinceName: item.provinceName,
    },
  };
}

export async function getCompany(
  database: BeeDb = defaultDb,
  id: string,
): Promise<CompanyDetail | null> {
  if (!UUID_PATTERN.test(id)) return null;

  const [row] = await database
    .select({
      id: v4.company.id,
      name: v4.company.name,
      shortName: v4.company.shortName,
      type: v4.company.type,
      scale: v4.company.scale,
      mainProducts: v4.company.mainProducts,
      description: v4.company.description,
      contactName: v4.company.contactName,
      contactPhone: v4.company.contactPhone,
      verified: v4.company.verified,
      isDemo: v4.company.isDemo,
      status: v4.company.status,
      categoryCode: v4.category.code,
      categoryName: v4.category.nameCn,
      regionCode: v4.region.code,
      regionName: v4.region.name,
      provinceName: province.name,
    })
    .from(v4.company)
    .innerJoin(v4.category, eq(v4.company.categoryId, v4.category.id))
    .innerJoin(v4.region, eq(v4.company.regionId, v4.region.id))
    .leftJoin(province, eq(v4.region.parentId, province.id))
    .where(eq(v4.company.id, id))
    .limit(1);

  if (!row) return null;

  const opportunityRows = await baseOpportunityQuery(database)
    .where(and(eq(v4.opportunity.companyId, id), eq(v4.opportunity.status, 'open')))
    .orderBy(desc(v4.opportunity.publishedAt));

  return {
    ...row,
    type: row.type as CompanyType,
    provinceName: row.provinceName,
    opportunities: opportunityRows.map((item) =>
      toOpportunity(item as unknown as OpportunityRow),
    ),
  };
}