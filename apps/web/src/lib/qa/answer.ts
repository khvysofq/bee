import type { BeeDb } from '@bee/db';
import { citationOf } from './knowledge';
import { loadQaFacts, loadQaLexicon, type QaFactBundle } from './facts';
import { detectRefusal, refusalCopy } from './intent';
import {
  factsDigest,
  generateNarrative,
  readQaLlmConfig,
  scopeDigest,
  type NarrativeRequest,
} from './llm';
import {
  STATIC_LEXICON,
  parseQuestion,
  retrieveKnowledge,
  type ParsedQuestion,
  type QaLexicon,
  type RetrievalHit,
} from './retrieve';
import type { QaAnswer, QaKnowledgeCard } from './types';
import { EXAMPLE_QUESTIONS } from './examples';

export { EXAMPLE_QUESTIONS };

/**
 * 回答编排（GUA-35）。
 *
 * 三层策略：
 *  - 事实型：数字全部来自 loadQaFacts（daily_quote / derived_indicator），叙事不含数字；
 *    查不到就明说没有，不当作持平、不用估算值填充。
 *  - 口径型 / 常识型：只从本仓库自有文档切出的知识条目里检索，给条目正文 + 对外出处标签。
 *  - 越界型：直接返回代码常量话术，不检索、不查库、不调模型，保证逐字稳定可测。
 *
 * 模型只可能改变 `narrative`。它拿不到任何数字，输出还要过合规扫描；
 * 命中即整段作废，回落到下面的确定性模板。没有 key 时同样走模板——那是真功能。
 */

export interface AnswerDeps {
  db?: BeeDb;
  /** 注入词表（测试用）；缺省时从数据库读，读不到退回静态词表。 */
  lexicon?: QaLexicon;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** 注入叙事生成器（测试用），缺省走 readQaLlmConfig + generateNarrative。 */
  narrative?: (request: NarrativeRequest) => Promise<string[] | null>;
}

/** 输入框下方的示例问题：三类策略各一个，最后一个是会被拒绝的越界问法。 */

const FACT_NARRATIVE = [
  '下面的数字全部取自报价库里已发布的记录：报价日、当日高低区间与中值，以及与上一交易日、上周同期的真实变化。',
  '没有可比报价时，涨跌一栏显示为空缺，不当作持平，也不用估算值填充。',
];

const SERIES_NARRATIVE = '序列只连接真实存在的报价日，缺失的日期不补点、不插值。';

const KNOWLEDGE_NARRATIVE = [
  '以下内容引自站内自有的行业说明文档，条目下方给出出处，可以逐条追溯。',
  '要看具体价格请回到行情数据页；本页文字不包含任何由模型生成的数字。',
];

const UNKNOWN_NARRATIVE = [
  '站内说明与报价库都没有匹配到依据，所以我们不猜、不编。',
  '可以换个问法：问某个品类、某个规格、某个地域的当天报价，或问等级怎么分、计价单位、含税处理、缺失数据怎么显示。',
];

const NO_DB_NARRATIVE = [
  '这次没有连上报价库，因此不展示任何价格数字。',
  '行业常识类问题仍按站内说明回答；报价数字必须来自库里的真实记录，不会用别的东西顶替。',
];

const REFUSAL_NARRATIVE = '下面是我们能做的部分：把已经发生的数据讲清楚，把不做的部分说明白。';

function toKnowledgeCards(hits: RetrievalHit[]): QaKnowledgeCard[] {
  return hits.map(({ entry }) => ({
    id: entry.id,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    citation: citationOf(entry),
  }));
}

function emptyAnswer(question: string): QaAnswer {
  return {
    question,
    intent: 'unknown',
    refusal: null,
    headline: '输入问题后开始查询',
    narrative: [
      '这里只回答两类问题：报价库里真实存在的价格事实，以及站内说明里的行业常识。',
      '未来价位、买卖建议、收益承诺与法律税务等专业意见一律不回答。',
    ],
    facts: [],
    knowledge: [],
    missing: [],
    scope: null,
    aiAssisted: false,
    factsAvailable: false,
  };
}

async function resolveLexicon(deps: AnswerDeps): Promise<QaLexicon> {
  if (deps.lexicon) return deps.lexicon;
  if (!deps.db) return STATIC_LEXICON;
  try {
    return await loadQaLexicon(deps.db);
  } catch {
    return STATIC_LEXICON;
  }
}

async function resolveNarrative(
  request: NarrativeRequest,
  deps: AnswerDeps,
): Promise<string[] | null> {
  if (deps.narrative) return deps.narrative(request);
  const env = deps.env ?? process.env;
  const config = readQaLlmConfig(env);
  if (!config) return null;
  return generateNarrative(request, config, deps.fetchImpl);
}

export async function answerQuestion(rawQuestion: string, deps: AnswerDeps = {}): Promise<QaAnswer> {
  const question = rawQuestion.trim();
  if (question.length === 0) return emptyAnswer(question);

  const lexicon = await resolveLexicon(deps);
  const parsed: ParsedQuestion = parseQuestion(question, lexicon);

  // ---- 越界型：最先判定，话术是代码常量 ----
  const refusalCode = detectRefusal(parsed.normalized);
  if (refusalCode) {
    const copy = refusalCopy(refusalCode);
    const hits = retrieveKnowledge(parsed, { limit: 1 });
    return {
      question,
      intent: 'refusal',
      refusal: { code: copy.code, title: copy.title, body: copy.body },
      headline: '这个问题超出本站回答范围',
      narrative: [REFUSAL_NARRATIVE],
      facts: [],
      knowledge: toKnowledgeCards(hits),
      missing: [],
      scope: null,
      aiAssisted: false,
      factsAvailable: false,
    };
  }

  const hits = retrieveKnowledge(parsed);
  const wantsFacts = parsed.asksPrice || parsed.asksSeries;
  const intent: QaAnswer['intent'] = wantsFacts ? 'fact' : hits.length > 0 ? 'knowledge' : 'unknown';

  // 事实型最多带一条相关说明，避免把口径解释糊在价格回答上。
  const knowledgeHits = intent === 'fact' ? hits.slice(0, 1) : hits.slice(0, 2);
  const knowledge = toKnowledgeCards(knowledgeHits);

  // ---- 事实型 / 无依据型 ----
  let bundle: QaFactBundle | null = null;
  if (intent === 'fact') {
    bundle = deps.db ? await loadQaFacts(parsed, deps.db) : null;
  }

  const cards = bundle?.cards ?? [];
  const missing = [...(bundle?.missing ?? [])];
  if (bundle?.truncated) {
    missing.push('同一天还有其他规格与地域的报价，完整清单请到行情数据页查看。');
  }

  let headline: string;
  let narrative: string[];

  if (intent === 'knowledge') {
    headline = '站内说明里有明确答案';
    narrative = [...KNOWLEDGE_NARRATIVE];
  } else if (intent === 'unknown') {
    headline = '这个问题我们没有依据回答';
    narrative = [...UNKNOWN_NARRATIVE];
  } else if (!bundle) {
    headline = '报价数据这次没有接上';
    narrative = [...NO_DB_NARRATIVE];
  } else if (!bundle.available) {
    headline = '报价数据这次没有取到';
    narrative = [...NO_DB_NARRATIVE];
  } else if (cards.length === 0) {
    headline = '这一组合没有查到报价';
    narrative =
      bundle.scope && bundle.scope.available.length > 0
        ? [
            '报价库里没有这一组合在最新报价日的记录，因此不给出任何数字。',
            '下方列出的是当天真实可看的组合；范围之外的品类与地域，我们不猜也不估。',
          ]
        : ['报价库里没有这一组合在最新报价日的记录，因此不给出任何数字。'];
  } else {
    headline = cards.length === 1 ? '查到了这一组合的当天报价' : '查到了这些组合的当天报价';
    narrative = [...FACT_NARRATIVE];
    if (cards.some((card) => card.kind === 'series')) narrative.push(SERIES_NARRATIVE);
  }

  const scope = bundle?.scope ?? null;

  // ---- 模型只参与叙事，且只在有依据可讲的时候 ----
  let aiAssisted = false;
  if ((intent === 'fact' || intent === 'knowledge') && (cards.length > 0 || knowledge.length > 0)) {
    const request: NarrativeRequest = {
      question,
      intent,
      facts: factsDigest(cards),
      knowledge: knowledge.map((card) => ({ title: card.title, summary: card.summary })),
      scope: scopeDigest(scope),
      missing,
    };
    const generated = await resolveNarrative(request, deps);
    if (generated && generated.length > 0) {
      narrative = generated;
      aiAssisted = true;
    }
  }

  return {
    question,
    intent,
    refusal: null,
    headline,
    narrative,
    facts: cards,
    knowledge,
    missing,
    scope,
    aiAssisted,
    factsAvailable: bundle?.available ?? false,
  };
}
