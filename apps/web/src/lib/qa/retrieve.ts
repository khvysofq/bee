import type { PriceType } from '../briefing-data';
import { KNOWLEDGE_ENTRIES } from './knowledge';
import type { KnowledgeEntry } from './types';

/**
 * 确定性检索（GUA-35）。
 *
 * 不用向量库、不调模型：全部是「归一化后的子串匹配 + 结构化字段匹配 + 加权打分」。
 * 同样的问题永远得到同样的命中结果，因此话术与命中集都可以写进测试锁死。
 *
 * 词表分两层：
 *  - 静态别名层（本文件）：品类 / 规格 / 地域 / 价格类型的口语说法，随代码走；
 *  - 数据库真名层（facts.ts 的 loadQaLexicon）：category.name_cn / spec_grade.name_cn /
 *    region.name_cn 的当前值，避免字典改名后检索失效。
 */

export interface LexiconItem {
  /** 库内真名（渲染用）。 */
  name: string;
  /** 口语别名（含真名本身），检索用。 */
  aliases: string[];
}

export interface QaLexicon {
  categories: (LexiconItem & { code: string })[];
  specs: (LexiconItem & { categoryCode: string })[];
  regions: LexiconItem[];
  priceTypes: (LexiconItem & { type: PriceType })[];
}

/** 静态别名层：数据库不可用时也能检索（降级路径）。 */
export const STATIC_LEXICON: QaLexicon = {
  categories: [
    { code: 'scrap-steel', name: '废钢', aliases: ['废钢', '废铁', '钢铁', '钢'] },
    { code: 'scrap-copper', name: '废铜', aliases: ['废铜', '铜'] },
    { code: 'scrap-aluminum', name: '废铝', aliases: ['废铝', '铝'] },
    { code: 'waste-paper', name: '废纸', aliases: ['废纸', '纸壳', '纸板', '纸'] },
    { code: 'waste-plastic', name: '废塑料', aliases: ['废塑料', '塑料', '瓶片', '瓶砖'] },
  ],
  specs: [
    { categoryCode: 'scrap-steel', name: '重废', aliases: ['重废', '重型废钢', '重废钢'] },
    { categoryCode: 'scrap-steel', name: '中废', aliases: ['中废', '中型废钢'] },
    { categoryCode: 'scrap-steel', name: '统料', aliases: ['统料', '统废', '混合废钢', '混废'] },
    { categoryCode: 'scrap-copper', name: '光亮铜线', aliases: ['光亮铜线', '光亮铜', '紫铜', '铜线'] },
    { categoryCode: 'scrap-aluminum', name: '光亮铝线', aliases: ['光亮铝线', '铝线'] },
    { categoryCode: 'waste-paper', name: '箱板纸（OCC）', aliases: ['箱板纸', '黄板纸', '瓦楞纸', 'occ'] },
    { categoryCode: 'waste-paper', name: '书本纸', aliases: ['书本纸', '书刊纸', '白纸'] },
    { categoryCode: 'waste-plastic', name: 'PET瓶砖', aliases: ['pet瓶砖', 'pet', '瓶砖', '瓶片'] },
    { categoryCode: 'waste-plastic', name: 'PE料', aliases: ['pe料', 'pe', '聚乙烯'] },
  ],
  regions: [
    { name: '华东', aliases: ['华东'] },
    { name: '华南', aliases: ['华南'] },
    { name: '华北', aliases: ['华北'] },
    { name: '西南', aliases: ['西南'] },
    { name: '苏州', aliases: ['苏州', '苏州市'] },
    { name: '临沂', aliases: ['临沂', '临沂市'] },
    { name: '佛山', aliases: ['佛山', '佛山市'] },
    { name: '广州', aliases: ['广州', '广州市'] },
    { name: '天津', aliases: ['天津', '天津市'] },
    { name: '昆明', aliases: ['昆明', '昆明市'] },
    { name: '全国', aliases: ['全国', '国内', '全国参考价'] },
  ],
  priceTypes: [
    { type: 'purchase', name: '采购价', aliases: ['采购价', '收购价', '收货价', '回收价', '进价', '采购', '收购'] },
    { type: 'sale', name: '销售价', aliases: ['销售价', '出货价', '卖价', '出售价', '销售'] },
    { type: 'ex_works', name: '出厂价', aliases: ['出厂价', '出厂'] },
    { type: 'indicative', name: '指导价', aliases: ['指导价', '参考价'] },
  ],
};

/** 时间窗口：只看最新一天，还是要一段真实序列。 */
export type QaWindow = 'latest' | 'series';

export interface ParsedQuestion {
  /** 归一化后的问题文本（小写、全角转半角、去掉空白与标点）。 */
  normalized: string;
  category: { code: string; name: string } | null;
  spec: { name: string; categoryCode: string } | null;
  region: { name: string } | null;
  priceType: { type: PriceType; name: string } | null;
  /** '全国' 命中时置真：全国只能来自加工指标，不能来自 daily_quote。 */
  asksNational: boolean;
  window: QaWindow;
  /** 是否在问价格事实（多少 / 涨没涨 / 区间 / 报价日 …）。 */
  asksPrice: boolean;
  /** 是否在问一段序列（近一周走势 / 历史）。 */
  asksSeries: boolean;
  /** 是否在问定义与解释（为什么 / 是什么 / 怎么分）；为真时事实层让位给知识库。 */
  asksDefinition: boolean;
  /** 命中的检索词，用于日志与测试可解释性。 */
  matchedTerms: string[];
}

const SERIES_HINTS = [
  '近一周', '最近一周', '这一周', '近两周', '最近两周', '近7天', '近七天', '近14天',
  '上周', '前几天', '近几天', '最近几天', '历史', '走势', '序列', '过去', '这段时间', '变化趋势',
];

const PRICE_HINTS = [
  '多少', '价格', '报价', '行情', '价钱', '几钱', '一吨', '涨', '跌', '区间', '中值',
  '均价', '高低', '价差', '有没有', '报价日', '哪天', '什么时候的价', '收购价', '采购价', '销售价',
];

/**
 * 解释型问法：「为什么 / 是什么 / 怎么分」。
 * 这类问题即使句子里带「报价」「区间」等词，要的也是站内说明里的定义，不是当天的数值，
 * 因此要把事实层关掉，否则「报价为什么是一个区间」会被当成询价，先甩一堆价格卡片。
 */
const EXPLAIN_HINTS = [
  '为什么', '为何', '是什么', '什么是', '什么意思', '指的是', '怎么分', '怎么算', '怎么得到',
  '怎么对齐', '怎么处理', '怎么扣', '怎么分级', '怎么分类', '区别', '差别', '不一样',
];

/** 明确的取值问法：出现即认定用户要数字，解释型让位。 */
const VALUE_HINTS = ['多少', '几钱', '什么价', '报价日', '哪天', '有没有报价'];

/**
 * 归一化：全角转半角、转小写、去掉空白与常见标点，让「重废 多少？」和「重废多少」等价。
 * 中文本身不分词，所以不做分词——匹配一律用子串包含。
 */
export function normalizeQuestion(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s，。、？！：；「」『』（）()【】\[\]“”"'’‘?!,.:;~·—\-_/\\|@#%&*+=<>{}]/g, '');
}

function matchAliases(normalized: string, items: { name: string; aliases: string[] }[]): { item: string; term: string } | null {
  let best: { item: string; term: string } | null = null;
  for (const candidate of items) {
    for (const alias of candidate.aliases) {
      const needle = normalizeQuestion(alias);
      if (needle.length === 0) continue;
      if (!normalized.includes(needle)) continue;
      // 取最长命中：「光亮铜线」优先于「铜」。
      if (!best || needle.length > normalizeQuestion(best.term).length) {
        best = { item: candidate.name, term: alias };
      }
    }
  }
  return best;
}

export function parseQuestion(raw: string, lexicon: QaLexicon = STATIC_LEXICON): ParsedQuestion {
  const normalized = normalizeQuestion(raw);
  const matchedTerms: string[] = [];

  const categoryHit = matchAliases(normalized, lexicon.categories);
  const specHit = matchAliases(normalized, lexicon.specs);
  const regionHit = matchAliases(normalized, lexicon.regions);
  const priceTypeHit = matchAliases(normalized, lexicon.priceTypes);
  for (const hit of [categoryHit, specHit, regionHit, priceTypeHit]) {
    if (hit) matchedTerms.push(hit.term);
  }

  const category = categoryHit
    ? {
        code: lexicon.categories.find((item) => item.name === categoryHit.item)?.code ?? '',
        name: categoryHit.item,
      }
    : null;
  const spec = specHit
    ? {
        name: specHit.item,
        categoryCode:
          lexicon.specs.find((item) => item.name === specHit.item)?.categoryCode ?? category?.code ?? '',
      }
    : null;
  // 规格命中了但品类没命中：用品类 code 反查真名（「重废多少钱」→ 废钢）。
  const resolvedCategory = category ?? (spec
    ? {
        code: spec.categoryCode,
        name: lexicon.categories.find((item) => item.code === spec.categoryCode)?.name ?? spec.categoryCode,
      }
    : null);

  const region = regionHit ? { name: regionHit.item } : null;
  const priceType = priceTypeHit
    ? {
        type: (lexicon.priceTypes.find((item) => item.name === priceTypeHit.item)?.type ?? 'purchase') as PriceType,
        name: priceTypeHit.item,
      }
    : null;

  const asksSeries = SERIES_HINTS.some((hint) => normalized.includes(normalizeQuestion(hint)));
  const asksValue = VALUE_HINTS.some((hint) => normalized.includes(normalizeQuestion(hint)));
  const asksDefinition =
    !asksValue && EXPLAIN_HINTS.some((hint) => normalized.includes(normalizeQuestion(hint)));
  // 解释型问法（「报价为什么是一个区间」）不触发事实层：用户要的是定义，不是当天数值。
  const asksPrice = !asksDefinition && PRICE_HINTS.some((hint) => normalized.includes(normalizeQuestion(hint)));
  for (const hint of [
    ...(asksSeries ? SERIES_HINTS : []),
    ...(asksPrice ? PRICE_HINTS : []),
    ...(asksDefinition ? EXPLAIN_HINTS : []),
  ]) {
    if (normalized.includes(normalizeQuestion(hint)) && !matchedTerms.includes(hint)) matchedTerms.push(hint);
  }

  return {
    normalized,
    category: resolvedCategory,
    spec,
    region,
    priceType,
    asksNational: region?.name === '全国',
    window: asksSeries ? 'series' : 'latest',
    asksPrice,
    asksSeries,
    asksDefinition,
    matchedTerms,
  };
}

export interface RetrievalHit {
  entry: KnowledgeEntry;
  score: number;
  /** 命中的关键词（已归一化前的原词），可解释性用。 */
  matched: string[];
}

/** 低于该分数的命中一律丢弃：宁可说没有，也不硬凑答案。 */
export const RETRIEVAL_MIN_SCORE = 2.5;

function titleNgrams(title: string): string[] {
  const clean = normalizeQuestion(title);
  const grams: string[] = [];
  for (let size = clean.length; size >= 2; size -= 1) {
    for (let start = 0; start + size <= clean.length; start += 1) {
      grams.push(clean.slice(start, start + size));
    }
  }
  return grams;
}

/**
 * 关键词 + 同义词 + 结构化字段匹配。
 *
 * 打分规则（固定常量，测试锁死）：
 *  - 命中关键词：长度 ≥ 4 记 3 分，长度 3 记 2.5 分，长度 ≤ 2 记 2 分；
 *  - 结构化字段：问题解析出的品类与条目 categoryCode 相同 → +2.5；
 *  - 标题重合：问题里出现条目标题的 ≥3 字连续片段 → 每段 +1（最多 +3）。
 *
 * 关键词与品类**一项都没命中**的条目直接淘汰：标题重合只是加分项，不能单独把条目送进答案。
 * 否则「你们公司地址在哪里」会因为「在哪里」撞上「价格锚在哪里」这种标题而硬凑出一个答案，
 * 违反「没有依据就不回答」。
 */
export function retrieveKnowledge(
  parsed: ParsedQuestion,
  options: { limit?: number; entries?: KnowledgeEntry[] } = {},
): RetrievalHit[] {
  const limit = options.limit ?? 3;
  const entries = options.entries ?? KNOWLEDGE_ENTRIES;
  const normalized = parsed.normalized;
  if (normalized.length === 0) return [];

  const hits: RetrievalHit[] = [];
  for (const entry of entries) {
    let score = 0;
    const matched: string[] = [];
    for (const keyword of entry.keywords) {
      const needle = normalizeQuestion(keyword);
      if (needle.length === 0 || !normalized.includes(needle)) continue;
      matched.push(keyword);
      score += needle.length >= 4 ? 3 : needle.length === 3 ? 2.5 : 2;
    }
    const categoryMatched = Boolean(parsed.category?.code) && entry.categoryCode === parsed.category?.code;
    if (categoryMatched) score += 2.5;
    // 关键词与品类都没命中 → 淘汰，标题重合不足以构成依据。
    if (matched.length === 0 && !categoryMatched) continue;

    const grams = [...new Set(titleNgrams(entry.title))].filter(
      (gram) => gram.length >= 3 && normalized.includes(gram),
    );
    if (grams.length > 0) score += Math.min(3, grams.length);

    if (score >= RETRIEVAL_MIN_SCORE) hits.push({ entry, score, matched });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return entries.indexOf(a.entry) - entries.indexOf(b.entry);
  });
  return hits.slice(0, limit);
}

/** 按 id 取条目（事实层与知识层共用）。 */
export function entryById(id: string): KnowledgeEntry | undefined {
  return KNOWLEDGE_ENTRIES.find((entry) => entry.id === id);
}
