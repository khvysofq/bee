import { v4, type BeeDb } from '@bee/db';
import { db as defaultDb } from '../../db';
import { STATIC_LEXICON, normalizeQuestion, type ParsedQuestion, type QaLexicon } from './retrieve';
import type { QaFactCard, QaScopeView } from './types';

/**
 * 问答事实层（v4 切换期）。
 *
 * v4 已删除 observation / derived_indicator 等加工层；面向问答的事实检索链路
 * 尚未按 v4 重建，因此这里**不查**任何旧表，也不返回任何价格数字：
 * 统一返回空结果并明确说明「知识库重建中」。页面按现有缺口文案渲染，不会 500。
 *
 * 词表仍从 v4 的 category / spec / region 读取，用于识别问题里的品类与规格；
 * 数据库不可用时退回静态词表。
 */

export const MAX_FACT_CARDS = 6;

export interface QaFactBundle {
  /** 事实层是否可用（v4 切换期为 false）。 */
  available: boolean;
  /** 数据库异常信息（不渲染给用户，仅日志/测试用）。 */
  error: string | null;
  latestQuoteDate: string | null;
  cards: QaFactCard[];
  scope: QaScopeView | null;
  /** 诚实的缺口说明：查不到就说没有，一律不含数字。 */
  missing: string[];
  /** 命中的品类真名（用于叙事模板）。 */
  matchedCategoryName: string | null;
  /** 是否有超出卡片上限的匹配被截断。 */
  truncated: boolean;
}

function emptyBundle(missing: string[], error: string | null = null): QaFactBundle {
  return {
    available: false,
    error,
    latestQuoteDate: null,
    cards: [],
    scope: null,
    missing,
    matchedCategoryName: null,
    truncated: false,
  };
}

/** 词表：v4 字典真名 + 静态口语别名。数据库不可用时退回静态词表。 */
export async function loadQaLexicon(database: BeeDb = defaultDb): Promise<QaLexicon> {
  const [categoryRows, specRows, regionRows] = await Promise.all([
    database
      .select({ id: v4.category.id, code: v4.category.code, nameCn: v4.category.nameCn })
      .from(v4.category),
    database
      .select({ categoryId: v4.spec.categoryId, nameCn: v4.spec.name })
      .from(v4.spec),
    database.select({ nameCn: v4.region.name }).from(v4.region),
  ]);

  const codeById = new Map(categoryRows.map((item) => [item.id, item.code]));
  const staticAlias = (items: { name: string; aliases: string[] }[], name: string): string[] => {
    const hit = items.find((item) => normalizeQuestion(item.name) === normalizeQuestion(name));
    return hit ? hit.aliases : [];
  };

  const categories = categoryRows.map((item) => ({
    code: item.code,
    name: item.nameCn,
    aliases: [...new Set([item.nameCn, ...staticAlias(STATIC_LEXICON.categories, item.nameCn)])],
  }));
  const specs = specRows.map((item) => ({
    categoryCode: codeById.get(item.categoryId) ?? '',
    name: item.nameCn,
    aliases: [...new Set([item.nameCn, ...staticAlias(STATIC_LEXICON.specs, item.nameCn)])],
  }));
  const regions = regionRows.map((item) => ({
    name: item.nameCn,
    aliases: [...new Set([item.nameCn, ...staticAlias(STATIC_LEXICON.regions, item.nameCn)])],
  }));

  return {
    categories: categories.length > 0 ? categories : STATIC_LEXICON.categories,
    specs: specs.length > 0 ? specs : STATIC_LEXICON.specs,
    regions: [...regions, ...STATIC_LEXICON.regions.filter((item) => item.name === '全国')],
    priceTypes: STATIC_LEXICON.priceTypes,
  };
}

/** v4 事实检索尚未重建：不查旧表，返回空结果与明确说明。 */
export async function loadQaFacts(
  _parsed: ParsedQuestion,
  _database: BeeDb = defaultDb,
): Promise<QaFactBundle> {
  return emptyBundle([
    '知识库重建中：问答事实检索暂不可用。',
    '这次不展示任何价格数字，也不会用估算值或旧数据顶替。',
  ]);
}