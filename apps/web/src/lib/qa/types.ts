/**
 * 行业问答（GUA-35）共享类型。
 *
 * 三条设计红线贯穿全部类型：
 *  1. **数字只有一条来路** —— 任何进入渲染的数值都挂在 `QaFactRow.origin` 上，指向
 *     `daily_quote` / `derived_indicator` 的行 id（或对 `daily_quote` 的计数），
 *     或指向知识库条目（行业分级阈值，来自本仓库自有文档，非模型生成）。
 *  2. **叙事与数字分离** —— `narrative` 是纯文字（模板或 LLM），不允许含数字；
 *     数字由 `facts` / `scope` 的预格式化文本渲染，渲染层不再做任何数值加工。
 *  3. **没有依据就不回答** —— 查不到时 `missing` 说明缺口，不填估算值、不当作持平。
 */

/** 知识条目类型：品类 / 规格 / 计价方式 / 术语 / 数据方法 / 常见问题 / 问答边界。 */
export type KnowledgeKind =
  | 'category'
  | 'spec'
  | 'pricing'
  | 'term'
  | 'method'
  | 'faq'
  | 'boundary';

/** 知识条目的出处（仓库自有文档）。`quote` 是文档原文，测试逐字回查，不渲染给用户。 */
export interface KnowledgeSource {
  /** 仓库相对路径，必须在 KNOWLEDGE_DOC_LABEL 允许清单内。 */
  doc: string;
  /** 文档内的小节标题文本，测试断言其存在于该文档。 */
  section: string;
  /** 文档原文片段（逐字），测试断言其存在于该文档；不进入渲染，也不进入模型提示词。 */
  quote: string;
}

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  /** 对外条目标题（渲染）。 */
  title: string;
  /** 一句话结论（渲染）。 */
  summary: string;
  /** 条目正文，对外语体（渲染）；分级与阈值数值逐字来自出处文档。 */
  body: string[];
  /** 检索关键词与同义词（不渲染）。 */
  keywords: string[];
  /** 结构化匹配字段：品类 code（不渲染）。 */
  categoryCode?: string;
  source: KnowledgeSource;
}

/** 问题意图。 */
export type QaIntentKind = 'fact' | 'knowledge' | 'refusal' | 'unknown';

/** 越界类型（与 docs/compliance/content-boundary-v1.md §3/§6 一一对应）。 */
export type RefusalCode =
  | 'price_forecast'
  | 'trading_advice'
  | 'profit_promise'
  | 'professional_opinion'
  | 'fabricate_number';

/**
 * 数字出处：库内行 id、库内聚合值，或知识条目 id。
 *
 * `field` 是「回查用的列名或派生名」，集成测试按它决定用哪条 SQL 复核：
 *  - daily_quote：quote_date / value_low / value_high / value_mid / confidence /
 *    change_prev（对比上一报价日的日期与涨跌幅）/ change_week（对比上周同期）/
 *    series_point（序列里的一天：日期 + 中值）
 *  - derived_indicator：basis_date / value / contribution_count
 *  - daily_quote_aggregate：latest_quote_date / regions / specs / quote_count
 *  - knowledge：数字逐字来自本仓库自有文档（测试回查文档正文）
 */
export type QaFigureOrigin =
  | { kind: 'daily_quote'; id: string; field: string }
  | { kind: 'derived_indicator'; id: string; field: string }
  | { kind: 'daily_quote_aggregate'; field: string }
  | { kind: 'knowledge'; id: string };

/** 一行会被渲染的事实文本（已格式化，含数字时必须带出处）。 */
export interface QaFactRow {
  label: string;
  /** 预格式化文本，渲染层原样输出，不再加工。 */
  text: string;
  /** 该行数字的出处；纯文字行也必须给出（knowledge 或对应表）。 */
  origin: QaFigureOrigin;
  /** 该行是否含数字，供数字来源测试逐行核对。 */
  hasNumber: boolean;
}

/** 一张事实卡片：一条报价 / 一条加工指标 / 一段真实序列。 */
export interface QaFactCard {
  kind: 'quote' | 'indicator' | 'series';
  /** 卡片标题（品类 · 规格 · 地域 · 价格类型），不含数字。 */
  title: string;
  rows: QaFactRow[];
  /** 回查用的库内行 id。 */
  refId: string;
  refTable: 'daily_quote' | 'derived_indicator';
}

/** 命中的知识条目（对外语体 + 出处标签）。 */
export interface QaKnowledgeCard {
  id: string;
  title: string;
  summary: string;
  body: string[];
  /** 对外可读的出处标签（不含文档路径与内部编号）。 */
  citation: string;
}

export interface QaScopeView {
  /** 库内最新已发布报价日；无数据时为 null。 */
  latestQuoteDate: string | null;
  /** 数据范围行（地域数 / 规格数 / 报价条数），数字来自对 daily_quote 的计数。 */
  rows: QaFactRow[];
  /** 当天该品类实际可看的组合，用于「查不到时告诉用户有什么」。 */
  available: string[];
}

export interface QaAnswer {
  question: string;
  intent: QaIntentKind;
  /** 越界型：稳定的拒绝话术（代码常量，逐字可测）。 */
  refusal: { code: RefusalCode; title: string; body: string[] } | null;
  /** 短结论（不含数字；数字在 facts / scope 里）。 */
  headline: string;
  /** 叙事段落（模板或 LLM）；不含数字，不含越界表述。 */
  narrative: string[];
  /** 事实卡片：数字的唯一渲染入口。 */
  facts: QaFactCard[];
  /** 口径型 / 常识型：命中的知识条目。 */
  knowledge: QaKnowledgeCard[];
  /** 查不到时的诚实缺口说明（不填估算值、不当作持平）。 */
  missing: string[];
  /** 数据范围与报价日。 */
  scope: QaScopeView | null;
  /** 本次回答是否使用了模型叙事（用于「AI 辅助生成」标识）。 */
  aiAssisted: boolean;
  /** 事实层是否可用（数据库不可达时为 false，此时只走知识库）。 */
  factsAvailable: boolean;
}

/** 数字（含日期片段）的切分规则，全半角都算。 */
const NUMBER_TOKEN = /[0-9０-９]+(?:[.．][0-9０-９]+)?/g;

export function numberTokens(text: string): string[] {
  return text.match(NUMBER_TOKEN) ?? [];
}

export function hasNumber(text: string): boolean {
  return numberTokens(text).length > 0;
}

/** 一条会被渲染的数字承载文本 + 它的出处。 */
export interface RenderedFigure {
  source: 'fact' | 'scope' | 'knowledge';
  label: string;
  text: string;
  origin: QaFigureOrigin;
}

/**
 * 从回答里收集所有会被渲染的数字承载文本（含日期）。
 *
 * 数字来源测试用两组断言夹住它：
 *  1. `fact` / `scope` 的每一条都能用 origin 里的表与行 id 重新查出来，值一致；
 *  2. `knowledge` 的每个数字片段都逐字出现在出处文档里（不是模型写的）。
 */
export function collectRenderedFigures(answer: QaAnswer): RenderedFigure[] {
  const figures: RenderedFigure[] = [];
  for (const card of answer.facts) {
    for (const row of card.rows) {
      figures.push({ source: 'fact', label: row.label, text: row.text, origin: row.origin });
    }
  }
  for (const row of answer.scope?.rows ?? []) {
    figures.push({ source: 'scope', label: row.label, text: row.text, origin: row.origin });
  }
  for (const card of answer.knowledge) {
    const text = [card.title, card.summary, ...card.body, card.citation].join('\n');
    if (numberTokens(text).length > 0) {
      figures.push({
        source: 'knowledge',
        label: card.title,
        text,
        origin: { kind: 'knowledge', id: card.id },
      });
    }
  }
  return figures;
}

/**
 * 回答里的「纯文字」部分：叙事、结论、缺口说明、拒绝话术、行标签、卡片标题。
 * 这些字符串一律不允许含数字——数字只能从事实层与知识库来。
 */
export function proseOf(answer: QaAnswer): string[] {
  return [
    answer.headline,
    ...answer.narrative,
    ...answer.missing,
    ...(answer.refusal ? [answer.refusal.title, ...answer.refusal.body] : []),
    ...answer.facts.flatMap((card) => [card.title, ...card.rows.map((row) => row.label)]),
    ...(answer.scope?.rows.map((row) => row.label) ?? []),
    ...(answer.scope?.available ?? []),
  ];
}
