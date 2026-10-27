import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BeeDb } from '@bee/db';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_QUESTIONS, answerQuestion } from '../src/lib/qa/answer';
import { FORBIDDEN_ADVICE, FORBIDDEN_INTERNAL, scanGeneratedText } from '../src/lib/qa/compliance-scan';
import { REFUSAL_COPY, SANCTIONED_FORECAST_PHRASE, detectRefusal, refusalCopy } from '../src/lib/qa/intent';
import {
  KNOWLEDGE_DOC_ALLOWLIST,
  KNOWLEDGE_DOC_LABEL,
  KNOWLEDGE_ENTRIES,
  citationOf,
} from '../src/lib/qa/knowledge';
import {
  FORBIDDEN_ENV_KEYS,
  QA_LLM_ENV_KEYS,
  factsDigest,
  readQaLlmConfig,
  sanitizeNarrative,
  scopeDigest,
  type NarrativeRequest,
} from '../src/lib/qa/llm';
import {
  RETRIEVAL_MIN_SCORE,
  STATIC_LEXICON,
  normalizeQuestion,
  parseQuestion,
  retrieveKnowledge,
} from '../src/lib/qa/retrieve';
import { numberTokens, proseOf, type QaAnswer, type QaFactCard } from '../src/lib/qa/types';

/**
 * 行业问答的回答策略与红线测试（GUA-35）。
 *
 * 这一组测试全部不连数据库、不发真实网络请求：
 *  - 检索是确定性的（关键词 + 同义词 + 结构化字段），可以直接断言命中集；
 *  - 越界拒绝话术是代码常量，逐字比对；
 *  - 模型路径用假 fetch 注入，重点锁死「模型看不到数字」「模型输出裸数字必被丢弃」
 *    「凭据只认 QA_LLM_*，绝不读 agent 基础设施的环境变量」。
 *
 * 真实数字与库内出处的逐值回查在 packages/pipeline/tests/web-qa.integration.test.ts。
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const WEB_SRC = join(REPO_ROOT, 'apps/web/src');

function docText(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** 渲染给用户的知识条目文本（title / summary / body / 对外出处标签）。 */
function renderedEntryText(entry: (typeof KNOWLEDGE_ENTRIES)[number]): string {
  return [entry.title, entry.summary, ...entry.body, citationOf(entry)].join('\n');
}

/** 模板话术：与 answer.ts 里的常量逐字一致，改动即测试失败。 */
const FACT_UNREACHABLE_NARRATIVE = [
  '这次没有连上报价库，因此不展示任何价格数字。',
  '行业常识类问题仍按站内说明回答；报价数字必须来自库里的真实记录，不会用别的东西顶替。',
];
const KNOWLEDGE_NARRATIVE = [
  '以下内容引自站内自有的行业说明文档，条目下方给出出处，可以逐条追溯。',
  '要看具体价格请回到行情数据页；本页文字不包含任何由模型生成的数字。',
];
const UNKNOWN_NARRATIVE = [
  '站内说明与报价库都没有匹配到依据，所以我们不猜、不编。',
  '可以换个问法：问某个品类、某个规格、某个地域的当天报价，或问等级怎么分、计价单位、含税处理、缺失数据怎么显示。',
];

/** 产品自己的模型凭据（测试用的假值），与 agent 基础设施凭据完全无关。 */
const LLM_ENV = {
  NODE_ENV: 'test',
  QA_LLM_API_KEY: 'product-key-not-an-agent-credential',
  QA_LLM_BASE_URL: 'https://llm.example.invalid/v1',
  QA_LLM_MODEL: 'qa-narrative-model',
} satisfies NodeJS.ProcessEnv;

/** 没有配置模型凭据：必须走确定性回答。 */
const NO_LLM_ENV = { NODE_ENV: 'test' } satisfies NodeJS.ProcessEnv;

/** 只有 agent 基础设施凭据：应用一律不许读，等价于没有凭据。 */
const AGENT_ONLY_ENV = {
  NODE_ENV: 'test',
  ANTHROPIC_API_KEY: 'agent-infra-credential',
  OPENAI_API_KEY: 'not-ours',
} satisfies NodeJS.ProcessEnv;

function envOf(values: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values };
}

interface CapturedCall {
  url: string;
  init: RequestInit;
  body: { model?: string; messages?: { role: string; content: string }[] };
}

/** 假 fetch：记录请求，返回预设文本（或失败）。 */
function fakeLlm(result: { ok?: boolean; content?: unknown } | Error) {
  const calls: CapturedCall[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? '{}')) as CapturedCall['body'];
    calls.push({ url: String(url), init, body });
    if (result instanceof Error) throw result;
    return {
      ok: result.ok ?? true,
      json: async () => ({ choices: [{ message: { content: result.content } }] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function userPromptOf(call: CapturedCall | undefined): string {
  return call?.body.messages?.find((message) => message.role === 'user')?.content ?? '';
}

/**
 * 越界词只允许以否定句出现。
 *
 * 页面必须能明说「不给目标价、不给买卖建议」，所以文案里出现这些词是合规要求本身；
 * 但它们所在的句子必须带否定词。模型叙事走的是更严的 `scanGeneratedText`（命中即丢弃），
 * 这里管的是代码常量文案。
 */
const NEGATION_MARKERS = ['不', '别', '非', '拒绝', '超出', '一律', '无可'];

function expectAdviceNegated(text: string, where: string): void {
  for (const sentence of text.split(/[。；！？\n]/)) {
    const term = FORBIDDEN_ADVICE.find((candidate) => sentence.includes(candidate));
    if (!term) continue;
    const negated = NEGATION_MARKERS.some((marker) => sentence.includes(marker));
    expect(negated, `${where}：「${term}」必须出现在否定句里 → ${sentence}`).toBe(true);
  }
}

/** 回答里的纯文字部分必须完全干净：无数字、无未否定的越界表述、无内部术语。 */
function expectProseClean(answer: QaAnswer): void {
  for (const line of proseOf(answer)) {
    expect(numberTokens(line), `纯文字里不许有数字：${line}`).toEqual([]);
    expectAdviceNegated(line, 'proseOf');
    for (const term of FORBIDDEN_INTERNAL) {
      expect(line.toLowerCase().includes(term.toLowerCase()), `正文出现内部术语 ${term}：${line}`).toBe(false);
    }
  }
  for (const line of [answer.headline, ...answer.narrative, ...answer.missing]) {
    // 叙事是模型可能替换的部分：数字与内部术语零容忍；越界词按否定句规则放行。
    const hits = scanGeneratedText(line).filter((hit) => hit.rule !== 'forbidden-advice');
    expect(hits, `叙事命中合规扫描：${line}`).toEqual([]);
    expectAdviceNegated(line, '叙事');
  }
  const whole = JSON.stringify(answer).split(SANCTIONED_FORECAST_PHRASE).join('');
  expect(whole, '「预测」只允许出现在合规强制的否定句里').not.toContain('预测');
}

/** 数据库桩：任何访问都被记录并抛错，用来证明某条路径根本不查库。 */
function throwingDb(flags: { touched: boolean }): BeeDb {
  return {
    select() {
      flags.touched = true;
      throw new Error('这条路径不应该访问数据库');
    },
  } as unknown as BeeDb;
}

describe('GUA-35 确定性检索', () => {
  it('同一问题永远得到同一解析与同一命中集（不依赖模型、不依赖时间）', () => {
    const question = '今天苏州重废多少钱一吨';
    const first = retrieveKnowledge(parseQuestion(question));
    const second = retrieveKnowledge(parseQuestion(question));
    expect(first.map((hit) => [hit.entry.id, hit.score])).toEqual(
      second.map((hit) => [hit.entry.id, hit.score]),
    );
    expect(parseQuestion(question)).toEqual(parseQuestion(question));
    // 「多少钱一吨」同时命中计价单位与废钢分级两条，排序稳定且都在阈值之上。
    expect(first.map((hit) => hit.entry.id)).toEqual(['kb-unit-ton', 'kb-steel-grades', 'kb-steel-impurity']);
    expect(first.map((hit) => hit.score)).toEqual([5, 4.5, 2.5]);
  });

  it('同义词与最长命中：黄板纸=箱板纸，统废=统料，光亮铜线不被「铜」抢走', () => {
    const paper = parseQuestion('黄板纸今天什么价');
    expect(paper.category?.code).toBe('waste-paper');
    expect(paper.spec?.name).toBe('箱板纸（OCC）');

    const mixed = parseQuestion('统废今天什么价');
    expect(mixed.spec?.name).toBe('统料');
    // 规格命中反查品类：用户没说「废钢」也要认出来。
    expect(mixed.category?.name).toBe('废钢');

    const copper = parseQuestion('光亮铜线和紫铜是一回事吗');
    expect(copper.spec?.name).toBe('光亮铜线');
    expect(copper.category?.code).toBe('scrap-copper');
  });

  it('解析出品类 / 规格 / 地域 / 价格类型 / 时间窗口', () => {
    const parsed = parseQuestion('今天苏州重废多少');
    expect(parsed.category).toEqual({ code: 'scrap-steel', name: '废钢' });
    expect(parsed.spec?.name).toBe('重废');
    expect(parsed.region?.name).toBe('苏州');
    expect(parsed.priceType).toBeNull();
    expect(parsed.asksPrice).toBe(true);
    expect(parsed.asksSeries).toBe(false);
    expect(parsed.window).toBe('latest');

    const series = parseQuestion('近一周废钢重废报价');
    expect(series.window).toBe('series');
    expect(series.asksSeries).toBe(true);

    const national = parseQuestion('废钢全国均价是多少');
    expect(national.asksNational).toBe(true);
    expect(national.region?.name).toBe('全国');

    const purchase = parseQuestion('今天废钢收购价是多少');
    expect(purchase.priceType?.type).toBe('purchase');
  });

  it('归一化：全角、空格、标点、大小写都不影响命中', () => {
    expect(normalizeQuestion('ＯＣＣ 纸壳，多少钱？')).toContain('occ');
    expect(parseQuestion('ＯＣＣ 纸壳，多少钱？').spec?.name).toBe('箱板纸（OCC）');
  });

  it('没有依据就不硬凑：低于阈值一律空命中', () => {
    expect(retrieveKnowledge(parseQuestion('你们公司地址在哪里'))).toEqual([]);
    expect(retrieveKnowledge(parseQuestion(''))).toEqual([]);
    expect(RETRIEVAL_MIN_SCORE).toBeGreaterThan(0);
    for (const hit of retrieveKnowledge(parseQuestion('重废和中废怎么分'))) {
      expect(hit.score).toBeGreaterThanOrEqual(RETRIEVAL_MIN_SCORE);
    }
  });

  it('常识型问题命中对应条目', () => {
    const grades = retrieveKnowledge(parseQuestion('重废和中废怎么分'));
    expect(grades.map((hit) => hit.entry.id)).toContain('kb-steel-grades');

    const range = retrieveKnowledge(parseQuestion('报价为什么是一个区间'));
    expect(range[0]?.entry.id).toBe('kb-price-range');

    const tax = retrieveKnowledge(parseQuestion('含税价和不含税价怎么对齐'));
    expect(tax[0]?.entry.id).toBe('kb-tax');
  });

  it('正常询价不会被误判成越界', () => {
    const normal = [
      '今天苏州重废多少',
      '今天废钢收购价是多少',
      '重废和中废怎么分',
      '报价为什么有区间',
      '近一周废钢报价',
      '含税价和不含税价怎么对齐',
      '废钢大概多少钱一吨',
      '中值是怎么得到的',
    ];
    for (const question of normal) {
      expect(detectRefusal(normalizeQuestion(question)), `不该拒绝：${question}`).toBeNull();
    }
  });
});

describe('GUA-35 越界拒绝', () => {
  const REFUSAL_CASES: [string, keyof typeof REFUSAL_COPY][] = [
    // 验收要求的三个固定用例：预测 / 买卖建议 / 目标价。
    ['明天废钢会涨到多少', 'price_forecast'],
    ['今天废钢该不该买', 'trading_advice'],
    ['废钢的目标价是多少', 'price_forecast'],
    // 其余越界类型。
    ['下周废钢会不会跌', 'price_forecast'],
    ['废钢后市怎么看', 'price_forecast'],
    ['现在适合囤货吗', 'trading_advice'],
    ['废钢要不要止损', 'trading_advice'],
    ['跟着你们的数字买稳赚吗', 'profit_promise'],
    ['你们的数据准确率有多少', 'profit_promise'],
    ['废钢进口怎么报税', 'professional_opinion'],
    ['帮我估一个价', 'fabricate_number'],
    ['帮我补个缺失值', 'fabricate_number'],
  ];

  it.each(REFUSAL_CASES)('「%s」判为 %s', (question, code) => {
    expect(detectRefusal(normalizeQuestion(question))).toBe(code);
  });

  it('首页示例问题：前三个可答，最后一个是会被拒绝的越界问法', () => {
    expect(EXAMPLE_QUESTIONS).toHaveLength(4);
    for (const question of EXAMPLE_QUESTIONS.slice(0, 3)) {
      expect(detectRefusal(normalizeQuestion(question)), question).toBeNull();
    }
    const refused = EXAMPLE_QUESTIONS.slice(3)[0] ?? '';
    expect(detectRefusal(normalizeQuestion(refused))).toBe('price_forecast');
  });

  it('五套话术都是代码常量：无数字、不复述营销用语、「预测」只在合规否定句里', () => {
    const codes = Object.keys(REFUSAL_COPY) as (keyof typeof REFUSAL_COPY)[];
    expect(codes.sort()).toEqual(
      ['fabricate_number', 'price_forecast', 'professional_opinion', 'profit_promise', 'trading_advice'].sort(),
    );
    for (const code of codes) {
      const copy = refusalCopy(code);
      expect(copy.code).toBe(code);
      expect(copy.body.length).toBeGreaterThanOrEqual(3);
      const text = [copy.title, ...copy.body].join('\n');
      expect(numberTokens(text), `拒绝话术不许有数字：${code}`).toEqual([]);
      expect(text.split(SANCTIONED_FORECAST_PHRASE).join(''), code).not.toContain('预测');
      for (const term of FORBIDDEN_INTERNAL) {
        expect(text.toLowerCase().includes(term.toLowerCase()), `${code} 命中内部术语 ${term}`).toBe(false);
      }
      // 话术里可以出现「点位 / 目标价 / 保证涨跌」这类词，但只能在否定句里。
      expectAdviceNegated(text, `拒绝话术 ${code}`);
      expect(scanGeneratedText(text).filter((hit) => hit.rule !== 'forbidden-advice')).toEqual([]);
    }
    expect(SANCTIONED_FORECAST_PHRASE).toBe('分析参考，非预测承诺');
  });

  it('拒绝路径不查库、不调模型，话术逐字来自常量', async () => {
    const flags = { touched: false };
    let narrativeCalls = 0;
    const answer = await answerQuestion('明天废钢会涨到多少', {
      db: throwingDb(flags),
      lexicon: STATIC_LEXICON,
      env: LLM_ENV,
      narrative: async () => {
        narrativeCalls += 1;
        return ['不该被采用'];
      },
    });

    expect(flags.touched).toBe(false);
    expect(narrativeCalls).toBe(0);
    expect(answer.intent).toBe('refusal');
    expect(answer.refusal).toEqual(REFUSAL_COPY.price_forecast);
    expect(answer.headline).toBe('这个问题超出本站回答范围');
    expect(answer.facts).toEqual([]);
    expect(answer.scope).toBeNull();
    expect(answer.missing).toEqual([]);
    expect(answer.aiAssisted).toBe(false);
    expect(answer.factsAvailable).toBe(false);
    expectProseClean(answer);
  });

  it('每一类越界都走同一套拒绝渲染，且只附带边界说明条目', async () => {
    for (const [question, code] of REFUSAL_CASES) {
      const answer = await answerQuestion(question, { lexicon: STATIC_LEXICON, env: NO_LLM_ENV });
      expect(answer.intent, question).toBe('refusal');
      expect(answer.refusal?.code, question).toBe(code);
      expect(answer.refusal?.title, question).toBe(REFUSAL_COPY[code].title);
      expect(answer.facts, question).toEqual([]);
      expect(answer.knowledge.length, question).toBeLessThanOrEqual(1);
      expectProseClean(answer);
    }
  });
});

describe('GUA-35 知识库出处', () => {
  it('语料只来自仓库自有文档，且四份文档都真实存在', () => {
    expect(KNOWLEDGE_DOC_ALLOWLIST).toEqual([
      'docs/DAW-29-calibration-dictionary-v1.md',
      'docs/mrd-prd.md',
      'docs/data-model.md',
      'docs/compliance/content-boundary-v1.md',
    ]);
    for (const doc of KNOWLEDGE_DOC_ALLOWLIST) {
      expect(statSync(join(REPO_ROOT, doc)).isFile(), doc).toBe(true);
      expect(docText(doc).length).toBeGreaterThan(0);
    }
    for (const entry of KNOWLEDGE_ENTRIES) {
      expect(KNOWLEDGE_DOC_ALLOWLIST, entry.id).toContain(entry.source.doc);
    }
    expect(KNOWLEDGE_ENTRIES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(KNOWLEDGE_ENTRIES.map((entry) => entry.id)).size).toBe(KNOWLEDGE_ENTRIES.length);
  });

  it('每条条目的小节与原文片段都能逐字回查到出处文档', () => {
    for (const entry of KNOWLEDGE_ENTRIES) {
      const text = docText(entry.source.doc);
      expect(text, `${entry.id} 的小节不在文档里`).toContain(entry.source.section);
      expect(text, `${entry.id} 的原文片段不在文档里`).toContain(entry.source.quote);
    }
  });

  it('渲染文本里的每个数字都逐字来自出处文档（不是模型写的）', () => {
    for (const entry of KNOWLEDGE_ENTRIES) {
      const text = docText(entry.source.doc);
      const rendered = `${entry.title}\n${entry.summary}\n${entry.body.join('\n')}`;
      for (const token of numberTokens(rendered)) {
        expect(text, `${entry.id} 的数字 ${token} 不在出处文档里`).toContain(token);
      }
    }
  });

  it('对外语体不暴露文档路径、内部编号与内部术语', () => {
    for (const entry of KNOWLEDGE_ENTRIES) {
      const rendered = renderedEntryText(entry);
      expect(rendered, entry.id).not.toContain('docs/');
      expect(rendered, entry.id).not.toContain('.md');
      expect(rendered, entry.id).not.toContain('DAW-');
      expect(rendered, entry.id).not.toContain('GUA-');
      for (const term of FORBIDDEN_INTERNAL) {
        expect(rendered.toLowerCase().includes(term.toLowerCase()), `${entry.id} 命中 ${term}`).toBe(false);
      }
      expect(citationOf(entry)).toBe(`${KNOWLEDGE_DOC_LABEL[entry.source.doc]} · ${entry.title}`);
    }
    for (const label of Object.values(KNOWLEDGE_DOC_LABEL)) {
      expect(label).not.toContain('docs/');
      expect(label).not.toContain('.md');
      expect(label).not.toContain('DAW-');
    }
  });

  it('「预测」只出现在合规否定句里，知识条目也不例外', () => {
    for (const entry of KNOWLEDGE_ENTRIES) {
      const rendered = renderedEntryText(entry).split(SANCTIONED_FORECAST_PHRASE).join('');
      expect(rendered, entry.id).not.toContain('预测');
    }
  });

  it('三类策略在知识库里都有对应的边界条目', () => {
    const ids = KNOWLEDGE_ENTRIES.map((entry) => entry.id);
    for (const id of [
      'kb-qa-boundary',
      'kb-no-advice',
      'kb-no-future-price',
      'kb-numbers-not-from-ai',
      'kb-no-fabrication',
      'kb-facts-first',
      'kb-missing-not-flat',
    ]) {
      expect(ids, id).toContain(id);
    }
    expect(KNOWLEDGE_ENTRIES.filter((entry) => entry.kind === 'boundary').length).toBeGreaterThanOrEqual(5);
  });
});

describe('GUA-35 降级路径（没有模型凭据）', () => {
  it('常识型问题照常回答：条目正文 + 对外出处，aiAssisted 为假', async () => {
    const answer = await answerQuestion('重废和中废怎么分', { env: NO_LLM_ENV });
    expect(answer.intent).toBe('knowledge');
    expect(answer.aiAssisted).toBe(false);
    expect(answer.factsAvailable).toBe(false);
    expect(answer.headline).toBe('站内说明里有明确答案');
    expect(answer.narrative).toEqual(KNOWLEDGE_NARRATIVE);
    expect(answer.knowledge[0]?.id).toBe('kb-steel-grades');
    expect(answer.knowledge[0]?.citation).toBe('行业分级说明 v1 · 废钢等级怎么分');
    expect(answer.knowledge.length).toBeLessThanOrEqual(2);
    expectProseClean(answer);
  });

  it('事实型问题在没有数据库时明说没接上，不给任何数字', async () => {
    const answer = await answerQuestion('今天苏州重废多少', { env: NO_LLM_ENV });
    expect(answer.intent).toBe('fact');
    expect(answer.headline).toBe('报价数据这次没有接上');
    expect(answer.narrative).toEqual(FACT_UNREACHABLE_NARRATIVE);
    expect(answer.facts).toEqual([]);
    expect(answer.scope).toBeNull();
    expect(answer.factsAvailable).toBe(false);
    expect(answer.aiAssisted).toBe(false);
    expectProseClean(answer);
  });

  it('数据库抛错时降级，不把异常抛给用户', async () => {
    const answer = await answerQuestion('今天苏州重废多少', {
      db: throwingDb({ touched: false }),
      env: NO_LLM_ENV,
    });
    expect(answer.intent).toBe('fact');
    expect(answer.headline).toBe('报价数据这次没有取到');
    expect(answer.narrative).toEqual(FACT_UNREACHABLE_NARRATIVE);
    expect(answer.missing.join('\n')).toContain('报价数据暂时取不到');
    expect(answer.facts).toEqual([]);
    expect(answer.factsAvailable).toBe(false);
    expectProseClean(answer);
  });

  it('没有依据的问题直接说不知道，不猜不编', async () => {
    const answer = await answerQuestion('你们公司地址在哪里', { env: NO_LLM_ENV });
    expect(answer.intent).toBe('unknown');
    expect(answer.headline).toBe('这个问题我们没有依据回答');
    expect(answer.narrative).toEqual(UNKNOWN_NARRATIVE);
    expect(answer.knowledge).toEqual([]);
    expect(answer.facts).toEqual([]);
    expect(answer.aiAssisted).toBe(false);
    expectProseClean(answer);
  });

  it('空问题不触发任何检索', async () => {
    const answer = await answerQuestion('   ', { env: NO_LLM_ENV });
    expect(answer.intent).toBe('unknown');
    expect(answer.headline).toBe('输入问题后开始查询');
    expect(answer.question).toBe('');
    expect(answer.knowledge).toEqual([]);
    expectProseClean(answer);
  });

  it('降级路径下模型绝不会被调用', async () => {
    let narrativeCalls = 0;
    const answer = await answerQuestion('今天苏州重废多少', {
      env: AGENT_ONLY_ENV,
      narrative: async () => {
        narrativeCalls += 1;
        return ['不该被采用'];
      },
    });
    // deps.narrative 是测试注入点；真实路径由 readQaLlmConfig 决定，下面单独锁死。
    expect(narrativeCalls).toBe(1);
    expect(answer.aiAssisted).toBe(true);

    const real = await answerQuestion('今天苏州重废多少', {
      env: AGENT_ONLY_ENV,
      fetchImpl: async () => {
        throw new Error('没有 QA_LLM_* 凭据时不该发请求');
      },
    });
    expect(real.aiAssisted).toBe(false);
    expect(real.narrative).toEqual(FACT_UNREACHABLE_NARRATIVE);
  });
});

describe('GUA-35 模型增强路径', () => {
  it('提示词里没有任何数字：模型拿不到事实值，也就无从复述或编造', async () => {
    const { impl, calls } = fakeLlm({ content: '报价数字来自库里已发布的记录，页面会同时标出报价日与数据范围。' });
    const answer = await answerQuestion('今天苏州重废多少', { env: LLM_ENV, fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(numberTokens(userPromptOf(calls[0]))).toEqual([]);
    expect(userPromptOf(calls[0])).toContain('今天苏州重废多少');
    expect(answer.aiAssisted).toBe(true);
  });

  it('干净的模型叙事被采用，并打上 AI 辅助标识', async () => {
    const clean = [
      '报价数字都来自库里已经发布的记录，页面会同时标出报价日与数据范围。',
      '没有查到的部分会直接说明，不会用估算值补上。',
    ];
    const { impl, calls } = fakeLlm({ content: clean.join('\n') });
    const answer = await answerQuestion('今天苏州重废多少', { env: LLM_ENV, fetchImpl: impl });
    expect(answer.aiAssisted).toBe(true);
    expect(answer.narrative).toEqual(clean);
    expect(answer.headline).toBe('报价数据这次没有接上');
    expect(calls[0]?.url).toBe(`${LLM_ENV.QA_LLM_BASE_URL}/chat/completions`);
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${LLM_ENV.QA_LLM_API_KEY}`,
    });
    expect(calls[0]?.body.model).toBe(LLM_ENV.QA_LLM_MODEL);
    expectProseClean(answer);
  });

  it('模型输出裸数字：整段丢弃，回落到确定性模板', async () => {
    const { impl } = fakeLlm({ content: '重废当天中值是 2385 元/吨，区间在 2350 到 2420 之间。' });
    const answer = await answerQuestion('今天苏州重废多少', { env: LLM_ENV, fetchImpl: impl });
    expect(answer.aiAssisted).toBe(false);
    expect(answer.narrative).toEqual(FACT_UNREACHABLE_NARRATIVE);
    expect(numberTokens(answer.narrative.join(''))).toEqual([]);
    expect(answer.facts).toEqual([]);
    expectProseClean(answer);
  });

  it('一段违规就整段作废，不做局部修补', async () => {
    const { impl } = fakeLlm({
      content: '这段是干净的，没有任何数值。\n这段写了两千三百元一吨。',
    });
    expect(sanitizeNarrative('这段是干净的，没有任何数值。\n这段写了两千三百元一吨。')).toBeNull();
    const answer = await answerQuestion('今天苏州重废多少', { env: LLM_ENV, fetchImpl: impl });
    expect(answer.aiAssisted).toBe(false);
    expect(answer.narrative).toEqual(FACT_UNREACHABLE_NARRATIVE);
  });

  it.each([
    ['明天大概率继续上涨，可以关注。', 'forbidden-advice'],
    ['建议买入，止损放在低位。', 'forbidden-advice'],
    ['本站预测下周走高。', 'forbidden-advice'],
    ['这批货两千三百元一吨。', 'cn-number-price'],
    ['当天中值是 2385。', 'digit'],
    ['数据来自抓取与巡检流程。', 'forbidden-internal'],
  ])('模型输出「%s」被规则 %s 拦下', (text, rule) => {
    const hits = scanGeneratedText(text);
    expect(hits.map((hit) => hit.rule)).toContain(rule);
    expect(sanitizeNarrative(text)).toBeNull();
  });

  it('合规强制的否定句不算违规', () => {
    expect(scanGeneratedText(`推演字段均标注「${SANCTIONED_FORECAST_PHRASE}」，不构成成交保证。`)).toEqual([]);
    expect(scanGeneratedText('我们预测下周上行')).not.toEqual([]);
  });

  it('请求失败、超时、格式不符都降级为模板话术', async () => {
    const cases: (typeof fetch)[] = [
      (async () => ({ ok: false, json: async () => ({}) }) as unknown as Response) as typeof fetch,
      (async () => {
        throw new Error('network down');
      }) as typeof fetch,
      (async () => ({ ok: true, json: async () => ({ choices: [] }) }) as unknown as Response) as typeof fetch,
      (async () => ({ ok: true, json: async () => ({ choices: [{ message: {} }] }) }) as unknown as Response) as typeof fetch,
      (async () => ({ ok: true, json: async () => 'not-json' }) as unknown as Response) as typeof fetch,
    ];
    for (const fetchImpl of cases) {
      const answer = await answerQuestion('今天苏州重废多少', { env: LLM_ENV, fetchImpl });
      expect(answer.aiAssisted).toBe(false);
      expect(answer.narrative).toEqual(FACT_UNREACHABLE_NARRATIVE);
      expectProseClean(answer);
    }
  });

  it('清洗模型输出：去掉标记与列表符号，限三段、限长', () => {
    const cleaned = sanitizeNarrative(
      ['## 标题', '- 第一条说明', '1. 第二条说明', '', '第三条说明', '第四条说明'].join('\n'),
    );
    expect(cleaned).toHaveLength(3);
    expect(cleaned?.[0]).toBe('标题');
    expect(cleaned?.[1]).toBe('第一条说明');
    expect(sanitizeNarrative('   ')).toBeNull();
    expect(sanitizeNarrative('**加粗**与```代码```都会被去掉')).toEqual(['加粗与代码都会被去掉']);
    const long = sanitizeNarrative('很'.repeat(400));
    expect(long?.[0]?.length).toBeLessThanOrEqual(221);
  });

  it('事实摘要与范围摘要本身不含数字', () => {
    const card: QaFactCard = {
      kind: 'quote',
      title: '废钢 · 重废 · 苏州 · 采购价',
      refId: 'qv-1',
      refTable: 'daily_quote',
      rows: [
        { label: '报价日', text: '2026-10-26', origin: { kind: 'daily_quote', id: 'qv-1', field: 'quote_date' }, hasNumber: true },
        { label: '中值', text: '2,385 元/吨', origin: { kind: 'daily_quote', id: 'qv-1', field: 'value_mid' }, hasNumber: true },
      ],
    };
    const digest = factsDigest([card]);
    expect(digest).toEqual(['一条当天报价：废钢 · 重废 · 苏州 · 采购价，含报价日、中值']);
    expect(numberTokens(digest.join(''))).toEqual([]);

    const scope = scopeDigest({
      latestQuoteDate: '2026-10-26',
      rows: [
        { label: '最新报价日', text: '2026-10-26', origin: { kind: 'daily_quote_aggregate', field: 'latest_quote_date' }, hasNumber: true },
        { label: '当天报价条数', text: '9 条', origin: { kind: 'daily_quote_aggregate', field: 'quote_count' }, hasNumber: true },
      ],
      available: ['废钢 · 重废 · 苏州 · 采购价'],
    });
    expect(numberTokens(scope.join(''))).toEqual([]);
    expect(scopeDigest(null)).toEqual([]);
  });

  it('模型叙事只可能替换 narrative，事实与出处一律不动', async () => {
    const request: NarrativeRequest = {
      question: '今天苏州重废多少',
      intent: 'fact',
      facts: [],
      knowledge: [],
      scope: [],
      missing: [],
    };
    const { impl, calls } = fakeLlm({ content: '这段叙事会被采用，但数字仍然只来自报价库。' });
    const answer = await answerQuestion(request.question, { env: LLM_ENV, fetchImpl: impl });
    expect(calls[0]?.body.messages?.[0]?.role).toBe('system');
    expect(answer.facts).toEqual([]);
    expect(answer.scope).toBeNull();
    expect(answer.narrative).toEqual(['这段叙事会被采用，但数字仍然只来自报价库。']);
  });
});

describe('GUA-35 模型凭据边界', () => {
  it('只认 QA_LLM_* 三个变量，缺一个就降级', () => {
    expect(readQaLlmConfig(NO_LLM_ENV)).toBeNull();
    expect(readQaLlmConfig(envOf({ QA_LLM_API_KEY: 'k' }))).toBeNull();
    expect(readQaLlmConfig(envOf({ QA_LLM_API_KEY: 'k', QA_LLM_BASE_URL: 'https://a.invalid/v1' }))).toBeNull();
    expect(readQaLlmConfig(LLM_ENV)).toMatchObject({
      apiKey: LLM_ENV.QA_LLM_API_KEY,
      baseUrl: LLM_ENV.QA_LLM_BASE_URL,
      model: LLM_ENV.QA_LLM_MODEL,
      timeoutMs: 8000,
    });
    expect(readQaLlmConfig({ ...LLM_ENV, QA_LLM_API_KEY: '  ' })).toBeNull();
  });

  it('环境里只有 agent 基础设施凭据时绝不启用模型', () => {
    const agentRuntimeEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
    for (const key of FORBIDDEN_ENV_KEYS) agentRuntimeEnv[key] = 'agent-infra-credential';
    expect(readQaLlmConfig(agentRuntimeEnv)).toBeNull();
    for (const key of QA_LLM_ENV_KEYS) expect(key.startsWith('QA_LLM_')).toBe(true);
  });

  it('base url 去掉尾斜杠，超时值被夹在合理范围', () => {
    expect(readQaLlmConfig({ ...LLM_ENV, QA_LLM_BASE_URL: 'https://a.invalid/v1///' })?.baseUrl).toBe(
      'https://a.invalid/v1',
    );
    expect(readQaLlmConfig({ ...LLM_ENV, QA_LLM_TIMEOUT_MS: '1200' })?.timeoutMs).toBe(1200);
    expect(readQaLlmConfig({ ...LLM_ENV, QA_LLM_TIMEOUT_MS: '999999' })?.timeoutMs).toBe(8000);
    expect(readQaLlmConfig({ ...LLM_ENV, QA_LLM_TIMEOUT_MS: '0' })?.timeoutMs).toBe(8000);
    expect(readQaLlmConfig({ ...LLM_ENV, QA_LLM_TIMEOUT_MS: 'abc' })?.timeoutMs).toBe(8000);
  });

  it('apps/web 源码不读取任何 agent 基础设施凭据', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|css|mjs|cjs)$/.test(entry)) continue;
        const content = readFileSync(full, 'utf8');
        for (const key of FORBIDDEN_ENV_KEYS) {
          // 黑名单常量本身（llm.ts）必须写出这些名字，其余文件一律不许出现。
          if (full.endsWith(join('lib', 'qa', 'llm.ts'))) continue;
          if (content.includes(key)) offenders.push(`${full}: ${key}`);
        }
      }
    };
    walk(WEB_SRC);
    expect(offenders).toEqual([]);
  });

  it('仓库里的环境变量样例只放占位符，不放凭据', () => {
    const example = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
    expect(example).toContain('QA_LLM_API_KEY');
    expect(example).toContain('QA_LLM_BASE_URL');
    expect(example).toContain('QA_LLM_MODEL');
    for (const key of FORBIDDEN_ENV_KEYS) expect(example, key).not.toContain(key);
    expect(example).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    const qaLines = example
      .split('\n')
      .filter((line) => line.startsWith('QA_LLM_'));
    for (const line of qaLines) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      expect(['', 'your-qa-llm-api-key', 'https://your-llm-endpoint.example/v1', 'your-qa-llm-model', '8000']).toContain(
        value,
      );
    }
  });
});

describe('GUA-35 三层策略回答形态', () => {
  it('事实型问题带报价日与数据范围的入口（有库时由集成测试回查具体数值）', async () => {
    const answer = await answerQuestion('今天苏州重废多少', { env: NO_LLM_ENV });
    expect(answer.intent).toBe('fact');
    // 没有库时不编数字：既没有事实卡，也没有数据范围。
    expect(answer.facts).toEqual([]);
    expect(answer.scope).toBeNull();
    expect(answer.missing).toEqual([]);
    expectProseClean(answer);
  });

  it('事实型回答最多附带一条说明，避免把解释糊在价格上', async () => {
    const answer = await answerQuestion('今天苏州重废多少', { env: NO_LLM_ENV });
    expect(answer.knowledge.length).toBeLessThanOrEqual(1);
    for (const card of answer.knowledge) {
      expect(card.citation).toBe(`${KNOWLEDGE_DOC_LABEL[KNOWLEDGE_ENTRIES.find((e) => e.id === card.id)!.source.doc]} · ${card.title}`);
    }
  });

  it('常识型回答给条目正文与出处，不给价格数字', async () => {
    const answer = await answerQuestion('报价为什么是一个区间', { env: NO_LLM_ENV });
    expect(answer.intent).toBe('knowledge');
    expect(answer.facts).toEqual([]);
    expect(answer.knowledge.length).toBeGreaterThan(0);
    expect(answer.knowledge[0]?.body.length).toBeGreaterThan(0);
    expect(answer.knowledge[0]?.citation).toContain('·');
    expectProseClean(answer);
  });

  it('越界型不返回任何事实与范围', async () => {
    const answer = await answerQuestion('今天废钢该不该买', { env: LLM_ENV });
    expect(answer.intent).toBe('refusal');
    expect(answer.facts).toEqual([]);
    expect(answer.scope).toBeNull();
    expect(answer.refusal?.code).toBe('trading_advice');
    expectProseClean(answer);
  });
});

describe('GUA-35 禁用词表本身', () => {
  it('越界词与内部术语都在扫描范围内', () => {
    for (const term of ['预测', '目标价', '点位', '买入', '卖出', '稳赚', '保证准确', '胜率']) {
      expect(FORBIDDEN_ADVICE, term).toContain(term);
    }
    for (const term of ['口径', '定档', '巡检', '异常队列', '数据底座', '抓取', 'daily_quote', 'DAW-']) {
      expect(FORBIDDEN_INTERNAL, term).toContain(term);
    }
  });
});
