/**
 * GUA-33 用户侧界面渲染契约（不接数据库，用内存数据渲染为静态 HTML）。
 *
 * 覆盖：
 *  1. 首页三区（行情数据 / 趋势推演 / 行业问答）一眼可见，数字与涨跌来自传入数据；
 *  2. 行情页：价格、涨跌、校验结论；来源列表 / 权重 / 抓取时间 / 方法版本 / 溯源挂载点零暴露；
 *  3. 趋势页：只画真实历史序列，保留「推翻条件」与「分析参考，非预测承诺」；
 *  4. 问答页（GUA-35）：空态可提问、事实型回答、越界拒绝、常识型引用、查不到就说没有；
 *     回答区的每个数字都必须能在带出处的事实文本里找到，纯文字部分不含数字；
 *  5. 合规文案逐字位于页脚「数据说明」区块，版本号不进正文。
 *
 * 数字真实性由 packages/pipeline/tests/web-landing.integration.test.ts 与
 * packages/pipeline/tests/web-qa.integration.test.ts 对库回查保证。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingView } from '../src/components/LandingView';
import { MarketView } from '../src/components/MarketView';
import { OutlookView } from '../src/components/OutlookView';
import { QaView } from '../src/components/QaView';
import {
  AI_LABEL,
  AI_LABEL_ID,
  BRIEF_DISCLAIMER,
  BRIEF_DISCLAIMER_ID,
  CONTENT_POLICY_ID,
  FIXTURE_NOTICE,
  STATS_ATTRIBUTION,
  STATS_COMPLIANCE_NOTE,
} from '../src/lib/compliance';
import type { BriefingData } from '../src/lib/briefing-data';
import type { LandingData } from '../src/lib/landing-data';
import { REFUSAL_COPY, SANCTIONED_FORECAST_PHRASE } from '../src/lib/qa/intent';
import { collectRenderedFigures, numberTokens, proseOf, type QaAnswer } from '../src/lib/qa/types';

const fixtureUrl = 'https://www.stats.gov.cn/sj/zxfb/202610/t20261020.html';

const landing: LandingData = {
  generatedAt: '2026-10-26T08:00:00.000Z',
  latestQuoteDate: '2026-10-26',
  dataCutoffAt: '2026-10-26T07:15:00.000Z',
  categories: [
    {
      id: 'cat-steel',
      code: 'scrap-steel',
      name: '废钢',
      representative: {
        id: 'quote-steel-1',
        specName: '重废',
        regionName: '苏州',
        regionLevel: 'city',
        priceType: 'purchase',
        priceTypeLabel: '采购价',
        quoteDate: '2026-10-26',
        valueLow: 2350,
        valueHigh: 2420,
        valueMid: 2387.5,
        confidence: 'high',
        sources: [
          {
            code: 'fixture-a',
            name: '秘密来源甲',
            trustWeight: 80,
            fetchedAt: '2026-10-26T07:00:00.000Z',
          },
        ],
        dailyChange: { quoteDate: '2026-10-25', previousValue: 2365, pct: 0.95 },
        weeklyChange: { quoteDate: '2026-10-19', previousValue: 2335, pct: 2.25 },
      },
      trend: [
        { date: '2026-10-19', value: 2335 },
        { date: '2026-10-25', value: 2365 },
        { date: '2026-10-26', value: 2387.5 },
      ],
      latestQuoteCount: 3,
    },
    {
      id: 'cat-copper',
      code: 'scrap-copper',
      name: '废铜',
      representative: {
        id: 'quote-copper-1',
        specName: '光亮铜线',
        regionName: '苏州',
        regionLevel: 'city',
        priceType: 'purchase',
        priceTypeLabel: '采购价',
        quoteDate: '2026-10-26',
        valueLow: 68000,
        valueHigh: 69200,
        valueMid: 68600,
        confidence: 'medium',
        sources: [],
        dailyChange: null,
        weeklyChange: null,
      },
      trend: [{ date: '2026-10-26', value: 68600 }],
      latestQuoteCount: 1,
    },
    {
      id: 'cat-aluminum',
      code: 'scrap-aluminum',
      name: '废铝',
      representative: {
        id: 'quote-aluminum-1',
        specName: '生铝',
        regionName: '宁波',
        regionLevel: 'city',
        priceType: 'purchase',
        priceTypeLabel: '采购价',
        quoteDate: '2026-10-26',
        valueLow: 18100,
        valueHigh: 18400,
        valueMid: 18250,
        confidence: 'high',
        sources: [],
        dailyChange: { quoteDate: '2026-10-25', previousValue: 18470, pct: -1.2 },
        weeklyChange: null,
      },
      trend: [
        { date: '2026-10-25', value: 18470 },
        { date: '2026-10-26', value: 18250 },
      ],
      latestQuoteCount: 1,
    },
    {
      id: 'cat-paper',
      code: 'waste-paper',
      name: '废纸',
      representative: null,
      trend: [],
      latestQuoteCount: 0,
    },
  ],
  hasFixtureSource: true,
  hasStatsSource: true,
  statsSourceUrl: fixtureUrl,
  stats: { categoryCount: 4, categoriesWithQuotes: 3, quoteCount: 5, sourceCount: 1 },
  empty: false,
};

const market: BriefingData = {
  generatedAt: '2026-10-26T08:00:00.000Z',
  latestQuoteDate: '2026-10-26',
  dataCutoffAt: '2026-10-26T07:15:00.000Z',
  categories: [
    {
      id: 'cat-steel',
      code: 'scrap-steel',
      name: '废钢',
      quotes: [
        {
          id: 'quote-steel-1',
          categoryId: 'cat-steel',
          categoryName: '废钢',
          specName: '重废',
          regionName: '苏州',
          regionLevel: 'city',
          quoteDate: '2026-10-26',
          priceType: 'purchase',
          valueLow: 2350,
          valueHigh: 2420,
          valueMid: 2387.5,
          method: 'median_multi_source',
          methodVersion: 'qv-9.9',
          confidence: 'high',
          coverageNote: null,
          status: 'published',
          fetchedFrom: '2026-10-26T07:00:00.000Z',
          fetchedTo: '2026-10-26T07:00:00.000Z',
          sources: [
            {
              code: 'secret-src',
              name: '秘密来源甲',
              trustWeight: 80,
              fetchedAt: '2026-10-26T07:00:00.000Z',
            },
          ],
          previousTradingDay: { quoteDate: '2026-10-25', previousValue: 2365, pct: 0.95 },
          weekAgo: { quoteDate: '2026-10-19', previousValue: 2335, pct: 2.25 },
        },
        {
          id: 'quote-steel-anchor',
          categoryId: 'cat-steel',
          categoryName: '废钢',
          specName: '重废',
          regionName: '全国',
          regionLevel: 'market',
          quoteDate: '2026-10-20',
          priceType: 'purchase',
          valueLow: 2100,
          valueHigh: 2200,
          valueMid: 2150,
          method: 'single_source',
          methodVersion: 'anchor-v3',
          confidence: 'high',
          coverageNote: null,
          status: 'published',
          fetchedFrom: null,
          fetchedTo: null,
          sources: [],
          previousTradingDay: null,
          weekAgo: null,
        },
      ],
      indicators: [
        {
          id: 'indicator-steel-1',
          kind: 'national_reference',
          kindLabel: '全国参考价（来源直发）',
          categoryName: '废钢',
          regionName: '全国',
          basisDate: '2026-10-20',
          value: 2150,
          methodNote: '按公报原文引用，未作修改。',
          methodVersion: 'anchor-v3',
          contributionCount: 1,
          contributingQuoteIds: ['quote-steel-anchor'],
        },
      ],
      coverage: { regions: 2, sources: 2, specs: 1, quoteCount: 2 },
      gaps: [],
    },
    {
      id: 'cat-copper',
      code: 'scrap-copper',
      name: '废铜',
      quotes: [
        {
          id: 'quote-copper-1',
          categoryId: 'cat-copper',
          categoryName: '废铜',
          specName: '光亮铜线',
          regionName: '苏州',
          regionLevel: 'city',
          quoteDate: '2026-10-26',
          priceType: 'purchase',
          valueLow: 68000,
          valueHigh: 69200,
          valueMid: 68600,
          method: 'single_source',
          methodVersion: 'qv-9.9',
          confidence: 'medium',
          coverageNote: null,
          status: 'published',
          fetchedFrom: null,
          fetchedTo: null,
          sources: [],
          previousTradingDay: null,
          weekAgo: null,
        },
      ],
      indicators: [],
      coverage: { regions: 1, sources: 1, specs: 1, quoteCount: 1 },
      gaps: [],
    },
    {
      id: 'cat-paper',
      code: 'waste-paper',
      name: '废纸',
      quotes: [],
      indicators: [],
      coverage: { regions: 0, sources: 0, specs: 0, quoteCount: 0 },
      gaps: ['今日无已发布报价'],
    },
  ],
  sources: [
    {
      code: 'stats-cn',
      name: '国家统计局',
      baseUrl: 'https://www.stats.gov.cn',
      tosUrl: 'https://www.stats.gov.cn/other/tos.html',
      latestFetchUrl: fixtureUrl,
    },
    {
      code: 'fixture-a',
      name: '秘密来源甲',
      baseUrl: null,
      tosUrl: null,
      latestFetchUrl: 'https://example.com/secret-fetch',
    },
  ],
  stats: {
    categoryCount: 3,
    categoriesWithQuotes: 2,
    quoteCount: 3,
    sourceCount: 2,
    openExceptions: 0,
    highPriorityExceptions: 0,
  },
  globalGaps: [],
};

function renderLanding(data: LandingData = landing): string {
  return renderToStaticMarkup(createElement(LandingView, { data }));
}

function renderMarket(data: BriefingData = market): string {
  return renderToStaticMarkup(createElement(MarketView, { data }));
}

/** 页脚「数据说明」区块。 */
function notesBlock(html: string): string {
  const start = html.indexOf('data-notes');
  const end = html.indexOf('footer-base');
  return start >= 0 && end > start ? html.slice(start, end) : '';
}

/** 正文（不含页脚数据说明）—— 内部信息零暴露的检查范围。 */
function contentBeforeNotes(html: string): string {
  const index = html.indexOf('data-notes');
  return index >= 0 ? html.slice(0, index) : html;
}

function expectNoInternalInfo(html: string): void {
  const content = contentBeforeNotes(html);
  for (const term of [
    'data-trace',
    'trace-number',
    '/raw/',
    '/internal',
    '/ops',
    '/status',
    '/briefing',
    '定档',
    '口径',
    '存档',
    '巡检',
    '异常队列',
    '数据底座',
    'fixture 适配器',
    'P0-',
    'GUA-',
    'DAW-',
    '实时',
    '秘密来源甲',
    'secret-src',
    'qv-9.9',
    'anchor-v3',
    '2026-10-26T07:00:00.000Z',
  ]) {
    expect(content, `正文不应出现内部信息：${term}`).not.toContain(term);
  }
  expect(content, '正文不应出现可信权重').not.toMatch(/可信权重\s*\d+/);
}

function expectComplianceInNotes(html: string, options: { fixture: boolean; stats: boolean }): void {
  const notes = notesBlock(html);
  expect(notes, '页脚应有「数据说明」区块').toContain('数据说明');
  expect(notes).toContain(AI_LABEL);
  expect(notes).toContain(BRIEF_DISCLAIMER);
  if (options.fixture) expect(notes).toContain(FIXTURE_NOTICE);
  if (options.stats) {
    expect(notes).toContain(STATS_ATTRIBUTION);
    expect(notes).toContain(STATS_COMPLIANCE_NOTE);
    expect(notes).toContain(fixtureUrl);
    expect(notes).toContain('查看公报原文');
  }
  // 版本号只进 metadata，不进正文。
  expect(html).not.toContain(CONTENT_POLICY_ID);
  expect(html).not.toContain(BRIEF_DISCLAIMER_ID);
  expect(html).not.toContain(AI_LABEL_ID);
}

describe('GUA-33 首页：三区首屏', () => {
  const html = renderLanding();

  it('三大核心功能一眼可见，各带入口与独立关键词', () => {
    expect(html).toContain('行情数据');
    expect(html).toContain('趋势推演');
    expect(html).toContain('行业问答');
    expect(html).toContain('href="/market"');
    expect(html).toContain('href="/outlook"');
    expect(html).toContain('href="/qa"');
    expect(html).toContain('01 / MARKET');
    expect(html).toContain('02 / OUTLOOK');
    expect(html).toContain('03 / Q&amp;A');
    expect(html).toContain('历史走势');
    expect(html).toContain('推翻条件');
    expect(html).toContain('品类与规格');
  });

  it('行业问答入口不再标「筹备中」：问答已上线，标「可提问」', () => {
    const qaCard = html.slice(html.indexOf('entry-qa'), html.indexOf('home-strip'));
    expect(qaCard).toContain('可提问');
    expect(qaCard).not.toContain('筹备中');
    expect(qaCard).not.toContain('即将开放');
  });

  it('首页主报价来自传入数据：中值、区间口径标签、真实涨跌方向（涨红 / 跌绿）', () => {
    expect(html).toContain('2,387.5');
    expect(html).toContain('68,600');
    expect(html).toContain('18,250');
    expect(html).toContain('重废');
    expect(html).toContain('苏州');
    expect(html).toContain('采购价');
    expect(html).toContain('+0.95%');
    expect(html).toContain('quote-change up');
    expect(html).toContain('-1.20%');
    expect(html).toContain('quote-change down');
    // 无可比报价：缺失不当作持平。
    expect(html).toContain('缺失不当作持平');
    expect(html).toContain('quote-change none');
  });

  it('更新时间以「数据更新于 HH:MM」呈现（Asia/Shanghai），不承诺实时', () => {
    expect(html).toContain('数据更新于');
    expect(html).toContain('15:15');
    expect(html).not.toContain('实时');
  });

  it('走势线是真实序列 SVG，单点序列不画线', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('spark-line');
    expect(html).toContain('3 个报价日');
    expect(html).toContain('序列积累中');
  });

  it('内部信息零暴露：无溯源挂载点、无来源列表、无内部路由与工程术语', () => {
    expectNoInternalInfo(html);
    expect(html).not.toContain('每个数字都可溯源');
    expect(html).not.toContain('完整报价与溯源');
  });

  it('合规文案逐字在页脚「数据说明」，版本号不进正文', () => {
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });

  it('空态：三大功能入口仍在，不虚构价格', () => {
    const empty = renderLanding({
      ...landing,
      categories: [],
      latestQuoteDate: null,
      dataCutoffAt: null,
      hasFixtureSource: false,
      hasStatsSource: false,
      statsSourceUrl: null,
      stats: { categoryCount: 0, categoriesWithQuotes: 0, quoteCount: 0, sourceCount: 0 },
      empty: true,
    });
    expect(empty).toContain('行情数据');
    expect(empty).toContain('趋势推演');
    expect(empty).toContain('行业问答');
    expect(empty).toContain('今日暂无已发布报价');
    expect(empty).toContain('不会用估算值填充');
    expect(empty).not.toContain(FIXTURE_NOTICE);
  });
});

describe('GUA-33 行情数据页', () => {
  const html = renderMarket();

  it('展示价格、区间、日 / 周涨跌与校验结论', () => {
    expect(html).toContain('今日行情数据');
    expect(html).toContain('2,387.5');
    expect(html).toContain('2,350 – 2,420');
    expect(html).toContain('+0.95%');
    expect(html).toContain('+2.25%');
    expect(html).toContain('change up');
    expect(html).toContain('已校验');
    expect(html).toContain('置信度高');
    expect(html).toContain('置信度中');
    expect(html).toContain('全国参考价（来源直发）');
    expect(html).toContain('2026-10-20 报价');
    expect(html).toContain('数据更新于');
    expect(html).toContain('15:15');
  });

  it('无来源列表 / 可信权重 / 抓取时间 / 方法版本 / 溯源交互 / 内部路由', () => {
    expectNoInternalInfo(html);
    expect(html).not.toContain('秘密来源甲');
    expect(html).not.toContain('contributingQuoteIds');
    expect(html).not.toContain('quote-steel-anchor');
  });

  it('缺失品类显示诚实空态，不当作持平', () => {
    expect(html).toContain('缺失不当作持平');
    expect(html).toContain('今日无已发布报价');
  });

  it('合规文案逐字在页脚「数据说明」', () => {
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });
});

describe('GUA-33 趋势推演页', () => {
  const outlookHtml = renderToStaticMarkup(createElement(OutlookView, { data: landing }));

  it('只呈现历史序列，单点序列不连成趋势', () => {
    expect(outlookHtml).toContain('趋势推演');
    expect(outlookHtml).toContain('历史序列');
    expect(outlookHtml).toContain('近 3 个报价日');
    expect(outlookHtml).toContain('+2.25%');
    expect(outlookHtml).toContain('-1.19%');
    expect(outlookHtml).toContain('序列积累中');
    expect(outlookHtml).toContain('至少两个报价日后显示走势');
  });

  it('保留「推翻条件」与「分析参考，非预测承诺」，不输出结论', () => {
    expect(outlookHtml).toContain('推翻条件');
    expect(outlookHtml).toContain('分析参考，非预测承诺');
    expect(outlookHtml).toContain('当前不输出结论');
    expect(outlookHtml).toContain('没有判断，因此也没有推翻条件');
    expect(outlookHtml.replace('分析参考，非预测承诺', '')).not.toContain('预测');
  });

  it('无内部信息、无合规版本号、无实时承诺', () => {
    expectNoInternalInfo(outlookHtml);
    expectComplianceInNotes(outlookHtml, { fixture: true, stats: true });
  });
});

describe('GUA-35 行业问答页', () => {
  const info = {
    hasFixtureSource: true,
    hasStatsSource: true,
    statsSourceUrl: fixtureUrl,
    latestQuoteDate: '2026-10-26',
    updatedAt: '2026-10-26T07:15:00.000Z',
  };

  function renderQa(answer: QaAnswer | null = null): string {
    return renderToStaticMarkup(createElement(QaView, { info, answer }));
  }

  /**
   * 回答区：从 `qa-answer` 到下方能力说明区（`capability-title`）之间。
   * 页面上的编号标签（能力卡片的 01 / 02 / 03）与页脚日期不属于回答内容，
   * 因此不在数字来源检查范围内。
   */
  function answerRegion(html: string): string {
    const start = html.indexOf('qa-answer');
    if (start < 0) return '';
    const end = html.indexOf('capability-title');
    return end > start ? html.slice(start, end) : html.slice(start);
  }

  /** 去掉标签与实体，只留可见文本（`<h2>` 这类标签名里也有数字）。 */
  function textOf(fragment: string): string {
    return fragment
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'");
  }

  /** 回答区里出现的每个数字，都必须能在带出处的事实文本里找到。 */
  function expectDigitsOnlyFromFacts(answer: QaAnswer, html: string): void {
    const region = textOf(answerRegion(html));
    const tokens = region.match(/[0-9０-９]+(?:[.．][0-9０-９]+)?/g) ?? [];
    const tracked = collectRenderedFigures(answer)
      .map((figure) => `${figure.label} ${figure.text}`)
      .join(' | ');
    for (const token of tokens) {
      expect(tracked, `回答区数字必须有出处：${token}`).toContain(token);
    }
  }

  /** 纯文字部分（叙事 / 结论 / 缺口 / 拒绝话术 / 标签）一律不含数字。 */
  function expectProseDigitFree(answer: QaAnswer): void {
    for (const text of proseOf(answer)) {
      expect(numberTokens(text), `纯文字不应含数字：${text}`).toEqual([]);
    }
  }

  const quoteOrigin = (field: string) => ({ kind: 'daily_quote', id: 'dq-1', field }) as const;
  const factAnswer: QaAnswer = {
    question: '今天苏州重废多少',
    intent: 'fact',
    refusal: null,
    headline: '查到了这一组合的当天报价',
    narrative: [
      '下面的数字全部取自报价库里已发布的记录：报价日、当日高低区间与中值，以及与上一交易日、上周同期的真实变化。',
      '没有可比报价时，涨跌一栏显示为空缺，不当作持平，也不用估算值填充。',
    ],
    facts: [
      {
        kind: 'quote',
        title: '废钢 · 重废 · 苏州 · 采购价',
        refId: 'dq-1',
        refTable: 'daily_quote',
        rows: [
          { label: '报价日', text: '2026-10-26', origin: quoteOrigin('quote_date'), hasNumber: true },
          { label: '最低价', text: '2,350 元/吨', origin: quoteOrigin('value_low'), hasNumber: true },
          { label: '最高价', text: '2,420 元/吨', origin: quoteOrigin('value_high'), hasNumber: true },
          { label: '中值', text: '2,385 元/吨', origin: quoteOrigin('value_mid'), hasNumber: true },
          {
            label: '较上一交易日',
            text: '▲ +0.63%（对比 2026-10-25）',
            origin: quoteOrigin('change_prev'),
            hasNumber: true,
          },
          { label: '较上周同期', text: '无可比报价', origin: quoteOrigin('change_week'), hasNumber: false },
          { label: '可信度', text: '置信度高', origin: quoteOrigin('confidence'), hasNumber: false },
        ],
      },
    ],
    knowledge: [],
    missing: [],
    scope: {
      latestQuoteDate: '2026-10-26',
      rows: [
        {
          label: '最新报价日',
          text: '2026-10-26',
          origin: { kind: 'daily_quote_aggregate', field: 'latest_quote_date' },
          hasNumber: true,
        },
        {
          label: '当天覆盖地域',
          text: '4 个',
          origin: { kind: 'daily_quote_aggregate', field: 'regions' },
          hasNumber: true,
        },
        {
          label: '当天覆盖规格',
          text: '3 个',
          origin: { kind: 'daily_quote_aggregate', field: 'specs' },
          hasNumber: true,
        },
        {
          label: '当天报价条数',
          text: '9 条',
          origin: { kind: 'daily_quote_aggregate', field: 'quote_count' },
          hasNumber: true,
        },
      ],
      available: ['废钢 · 重废 · 苏州 · 采购价', '废钢 · 中废 · 临沂 · 采购价'],
    },
    aiAssisted: false,
    factsAvailable: true,
  };

  const refusalAnswer: QaAnswer = {
    question: '明天废钢会涨到多少',
    intent: 'refusal',
    refusal: {
      code: 'price_forecast',
      title: REFUSAL_COPY.price_forecast.title,
      body: REFUSAL_COPY.price_forecast.body,
    },
    headline: '这个问题超出本站回答范围',
    narrative: ['下面是我们能做的部分：把已经发生的数据讲清楚，把不做的部分说明白。'],
    facts: [],
    knowledge: [],
    missing: [],
    scope: null,
    aiAssisted: false,
    factsAvailable: false,
  };

  const knowledgeAnswer: QaAnswer = {
    question: '重废和中废怎么分',
    intent: 'knowledge',
    refusal: null,
    headline: '站内说明里有明确答案',
    narrative: [
      '以下内容引自站内自有的行业说明文档，条目下方给出出处，可以逐条追溯。',
      '要看具体价格请回到行情数据页；本页文字不包含任何由模型生成的数字。',
    ],
    facts: [],
    knowledge: [
      {
        id: 'kb-steel-grades',
        title: '废钢等级怎么分',
        summary: '按单件重量与厚度分成重废、中废、小废等档。',
        body: ['重废：单件重量较大，常见 40 公斤/件以上，厚度 6 毫米以上。'],
        citation: '行业分级说明 v1 · 废钢等级怎么分',
      },
    ],
    missing: [],
    scope: null,
    aiAssisted: false,
    factsAvailable: false,
  };

  it('空态：可输入可提交，示例问题是可点链接，不展示演示答案', () => {
    const html = renderQa(null);
    expect(html).toContain('行业问答');
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/qa"');
    expect(html).toContain('name="q"');
    expect(html).toContain('提问</button>');
    expect(html).not.toContain('即将开放');
    expect(html).not.toContain('qa-input" disabled');
    expect(html).not.toContain('qa-answer');
    expect(html).toContain('href="/qa?q=');
    expect(html).toContain('输入问题后开始查询');
    expectNoInternalInfo(html);
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });

  it('已回答（事实型）：报价日、区间与变化全部来自事实层，纯文字不含数字', () => {
    const html = renderQa(factAnswer);
    expect(html).toContain('data-intent="fact"');
    expect(html).toContain('废钢 · 重废 · 苏州 · 采购价');
    expect(html).toContain('2026-10-26');
    expect(html).toContain('2,385 元/吨');
    expect(html).toContain('▲ +0.63%（对比 2026-10-25）');
    expect(html).toContain('无可比报价');
    expect(html).toContain('数据范围');
    expect(html).toContain('当天可以看的组合');
    expectProseDigitFree(factAnswer);
    expectDigitsOnlyFromFacts(factAnswer, html);
    expectNoInternalInfo(html);
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });

  it('拒绝态：话术逐字来自代码常量，页面上没有任何数字', () => {
    const html = renderQa(refusalAnswer);
    expect(html).toContain('data-intent="refusal"');
    expect(html).toContain(REFUSAL_COPY.price_forecast.title);
    for (const line of REFUSAL_COPY.price_forecast.body) {
      expect(html).toContain(line);
    }
    expect(textOf(answerRegion(html)).match(/[0-9０-９]/g) ?? []).toEqual([]);
    expect(html.split(SANCTIONED_FORECAST_PHRASE).join('')).not.toContain('预测');
    expectNoInternalInfo(html);
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });

  it('常识型：条目正文 + 对外出处标签，不暴露文档路径与内部编号', () => {
    const html = renderQa(knowledgeAnswer);
    expect(html).toContain('data-intent="knowledge"');
    expect(html).toContain('废钢等级怎么分');
    expect(html).toContain('出处：行业分级说明 v1 · 废钢等级怎么分');
    expect(html).not.toContain('docs/');
    expect(html).not.toContain('.md');
    expectProseDigitFree(knowledgeAnswer);
    expectDigitsOnlyFromFacts(knowledgeAnswer, html);
    expectNoInternalInfo(html);
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });

  it('模型参与叙事时打「AI 辅助生成」标记，数字仍然只来自事实层', () => {
    const html = renderQa({ ...factAnswer, aiAssisted: true });
    expect(html).toContain('本次叙事由 AI 辅助生成');
    expect(html).toContain('不由模型生成');
    expectNoInternalInfo(html);
  });

  it('查不到时诚实说明缺口，不当作持平、不给估算值', () => {
    const missingAnswer: QaAnswer = {
      ...factAnswer,
      question: '今天昆明统料多少',
      headline: '这一组合没有查到报价',
      narrative: [
        '报价库里没有这一组合在最新报价日的记录，因此不给出任何数字。',
        '下方列出的是当天真实可看的组合；范围之外的品类与地域，我们不猜也不估。',
      ],
      facts: [],
      missing: [
        '最新报价日没有「废钢 · 统料 · 昆明 · 采购价」这一组合的报价。',
        '没有就是没有：不当作持平，不用估算值填充，也不拿其他日期或其他地域的数字顶替。',
      ],
    };
    const html = renderQa(missingAnswer);
    expect(html).toContain('这一组合没有查到报价');
    expect(html).toContain('没有查到的部分');
    expect(html).toContain('没有就是没有');
    expect(html).toContain('不当作持平');
    expect(html).not.toContain('视为持平');
    // 缺口说明本身不含任何数字；页面上剩下的数字仍然只能来自数据范围。
    expectProseDigitFree(missingAnswer);
    expectDigitsOnlyFromFacts(missingAnswer, html);
    expectNoInternalInfo(html);
    expectComplianceInNotes(html, { fixture: true, stats: true });
  });

  it('能力与边界说明保留：不编造、不作交易建议、标明报价日与范围', () => {
    const html = renderQa(null);
    expect(html).toContain('不编造');
    expect(html).toContain('不作交易建议');
    expect(html).toContain('标明报价日与范围');
    // 导航只有三入口，问答页内只指向已有的两个页面，不新增第四项。
    const answered = renderQa(factAnswer);
    expect(answered).toContain('href="/market"');
    expect(answered).toContain('href="/outlook"');
  });
});

describe('GUA-33 页脚数据说明的条件呈现', () => {
  it('fixture 数据仍在用时保留 FIXTURE_NOTICE；不再使用时移除', () => {
    const withFixture = renderLanding();
    expect(notesBlock(withFixture)).toContain(FIXTURE_NOTICE);
    const withoutFixture = renderLanding({ ...landing, hasFixtureSource: false });
    expect(notesBlock(withoutFixture)).not.toContain(FIXTURE_NOTICE);
    expect(notesBlock(withoutFixture)).toContain(BRIEF_DISCLAIMER);
    expect(notesBlock(withoutFixture)).toContain(AI_LABEL);
  });

  it('无统计局来源时不虚构署名', () => {
    const withoutStats = renderLanding({
      ...landing,
      hasStatsSource: false,
      statsSourceUrl: null,
    });
    expect(notesBlock(withoutStats)).not.toContain(STATS_ATTRIBUTION);
  });
});