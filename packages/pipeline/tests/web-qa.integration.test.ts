/**
 * GUA-35 行业问答数字来源集成测试：fixture 管线跑通后，/qa 回答里渲染的**每一个数字**
 * 都必须能用 `origin` 指回 daily_quote / derived_indicator 的真实行，值逐字一致。
 *
 * 这一组测试是红线「数字绝不来自 LLM」的执行处：
 *  - 事实型回答按 origin 回查库内行（含涨跌幅用两条真实报价重算、覆盖数用计数重算）；
 *  - 有 key 的模型路径与无 key 的降级路径渲染出的数字**完全相同**，模型编的数字进不了页面；
 *  - 查不到的组合不给数字、不拿别的日期或地域顶替；
 *  - 「全国」只走 derived_indicator，绝不用某一地的 daily_quote 冒充。
 *
 * 隔离策略与 web-landing 集成测试一致：自建独立库 bee_test_web_qa（迁移 → 种子 → 管线），
 * 不共享 bee_test —— 原始存档是内容寻址的本地文件，复用别的文件跑过的库会指向已清理的
 * storeRoot（ENOENT）；独立库同时让「库里只有本文件写入的数据」这类计数断言成立。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb, dbSchema, type BeeDb } from '@bee/db';
import { runFixturePipeline } from '../src';
import { seedPipelineDictionaries } from './helpers/seed';
import { answerQuestion } from '../../../apps/web/src/lib/qa/answer';
import { loadQaLexicon } from '../../../apps/web/src/lib/qa/facts';
import { KNOWLEDGE_ENTRIES } from '../../../apps/web/src/lib/qa/knowledge';
import { parseQuestion } from '../../../apps/web/src/lib/qa/retrieve';
import {
  collectRenderedFigures,
  numberTokens,
  type QaAnswer,
  type RenderedFigure,
} from '../../../apps/web/src/lib/qa/types';
import {
  arrowOf,
  confidenceLabel,
  directionOf,
  formatNumber,
  signedPct,
} from '../../../apps/web/src/lib/presentation';
import { TREND_WINDOW_DAYS } from '../../../apps/web/src/lib/landing-data';

const BASE_URL = process.env.BEE_TEST_DATABASE_URL ?? '';
const QA_DB = 'bee_test_web_qa';
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const LATEST_QUOTE_DATE = '2026-10-26';

/** 没有模型凭据：默认路径，回答必须是确定性的。 */
const NO_LLM_ENV = { NODE_ENV: 'test' } satisfies NodeJS.ProcessEnv;

function rewriteDb(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 与 briefing-data 同一套涨跌口径：round((当前中值 − 可比中值) / 可比中值 × 10000) / 100。 */
function changePct(current: number, previous: number): number {
  if (previous === 0) return 0;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

interface RawQuote {
  id: string;
  categoryId: string;
  categoryCode: string;
  specName: string;
  regionName: string;
  priceType: string;
  quoteDate: string;
  valueLow: number;
  valueHigh: number;
  valueMid: number;
  confidence: string;
}

interface RawIndicator {
  id: string;
  basisDate: string;
  value: number;
  contributionCount: number;
}

/** 同口径 key：品类 id × 规格名 × 地域名 × 价格类型（与 briefing-data 一致）。 */
function keyOf(quote: RawQuote): string {
  return [quote.categoryId, quote.specName, quote.regionName, quote.priceType].join('|');
}

describe.skipIf(!BASE_URL)('GUA-35 行业问答数字来源（/qa）', () => {
  let db: BeeDb;
  let admin: BeeDb;
  let storeRoot = '';
  let quotes: RawQuote[] = [];
  let indicators: RawIndicator[] = [];
  let lexicon: Awaited<ReturnType<typeof loadQaLexicon>>;

  /** 把 daily_quote 已发布行整表读出来：后面所有断言都只跟这份原始数据比。 */
  async function loadRawQuotes(): Promise<RawQuote[]> {
    const rows = await db
      .select({
        id: dbSchema.dailyQuote.id,
        categoryId: dbSchema.dailyQuote.categoryId,
        categoryCode: dbSchema.category.code,
        specName: dbSchema.specGrade.nameCn,
        regionName: dbSchema.region.nameCn,
        priceType: dbSchema.dailyQuote.priceType,
        quoteDate: dbSchema.dailyQuote.quoteDate,
        valueLow: dbSchema.dailyQuote.valueLow,
        valueHigh: dbSchema.dailyQuote.valueHigh,
        valueMid: dbSchema.dailyQuote.valueMid,
        confidence: dbSchema.dailyQuote.confidence,
      })
      .from(dbSchema.dailyQuote)
      .innerJoin(dbSchema.category, eq(dbSchema.dailyQuote.categoryId, dbSchema.category.id))
      .innerJoin(dbSchema.specGrade, eq(dbSchema.dailyQuote.specId, dbSchema.specGrade.id))
      .innerJoin(dbSchema.region, eq(dbSchema.dailyQuote.regionId, dbSchema.region.id))
      .where(eq(dbSchema.dailyQuote.status, 'published'));
    return rows.map((row) => ({
      id: row.id,
      categoryId: row.categoryId,
      categoryCode: row.categoryCode,
      specName: row.specName,
      regionName: row.regionName,
      priceType: row.priceType,
      quoteDate: row.quoteDate,
      valueLow: Number(row.valueLow),
      valueHigh: Number(row.valueHigh),
      valueMid: Number(row.valueMid),
      confidence: row.confidence,
    }));
  }

  /** 逐字段回查：一条 daily_quote 事实行的文本必须等于用库内值现场格式化出来的文本。 */
  function expectDailyQuoteFigure(figure: RenderedFigure): void {
    const origin = figure.origin;
    if (origin.kind !== 'daily_quote') {
      throw new Error(`事实行 ${figure.label} 的出处不是 daily_quote：${JSON.stringify(origin)}`);
    }
    const row = quotes.find((quote) => quote.id === origin.id);
    expect(row, `出处 ${origin.id} 必须真实存在于 daily_quote`).toBeTruthy();
    const quote = row!;

    switch (origin.field) {
      case 'quote_date':
        expect(figure.text).toBe(quote.quoteDate);
        break;
      case 'value_low':
        expect(figure.text).toBe(`${formatNumber(quote.valueLow)} 元/吨`);
        break;
      case 'value_high':
        expect(figure.text).toBe(`${formatNumber(quote.valueHigh)} 元/吨`);
        break;
      case 'value_mid':
        expect(figure.text).toBe(`${formatNumber(quote.valueMid)} 元/吨`);
        break;
      case 'confidence':
        expect(figure.text).toBe(confidenceLabel(quote.confidence));
        break;
      case 'series_point':
        expect(figure.text).toBe(`${quote.quoteDate} → ${formatNumber(quote.valueMid)} 元/吨`);
        break;
      case 'change_prev':
      case 'change_week': {
        // 独立重算可比行：change_prev = 同口径更早日期里最近的一条；change_week = 恰好早 7 天。
        const sameKey = quotes.filter((item) => keyOf(item) === keyOf(quote));
        const earlier = sameKey
          .filter((item) => item.quoteDate < quote.quoteDate)
          .sort((a, b) => (a.quoteDate < b.quoteDate ? 1 : -1));
        const comparable =
          origin.field === 'change_prev'
            ? (earlier[0] ?? null)
            : (earlier.find((item) => item.quoteDate === addDays(quote.quoteDate, -7)) ?? null);
        if (!comparable) {
          // 缺失就是缺失：文本必须是「无可比报价」，且整行不许出现数字（不当作持平）。
          expect(figure.text).toBe('无可比报价');
          expect(numberTokens(figure.text)).toEqual([]);
          break;
        }
        const pct = changePct(quote.valueMid, comparable.valueMid);
        expect(figure.text).toBe(
          `${arrowOf(directionOf(pct))} ${signedPct(pct)}（对比 ${comparable.quoteDate}）`,
        );
        break;
      }
      default:
        throw new Error(`未知的 daily_quote 回查字段：${origin.field}`);
    }
  }

  function expectIndicatorFigure(figure: RenderedFigure): void {
    const origin = figure.origin;
    if (origin.kind !== 'derived_indicator') {
      throw new Error(`指标行 ${figure.label} 的出处不是 derived_indicator：${JSON.stringify(origin)}`);
    }
    const row = indicators.find((item) => item.id === origin.id);
    expect(row, `出处 ${origin.id} 必须真实存在于 derived_indicator`).toBeTruthy();
    const indicator = row!;
    if (origin.field === 'basis_date') expect(figure.text).toBe(indicator.basisDate);
    else if (origin.field === 'value') expect(figure.text).toBe(`${formatNumber(indicator.value)} 元/吨`);
    else if (origin.field === 'contribution_count') {
      expect(figure.text).toBe(`${indicator.contributionCount} 条`);
    } else throw new Error(`未知的 derived_indicator 回查字段：${origin.field}`);
  }

  /**
   * 数据范围行：用整表计数重算，且必须标明这是对 daily_quote 的聚合。
   * 事实层按「命中的品类」收窄范围（scopeOf(matchedCategories, …)），这里用同一套解析口径重算，
   * 不硬编码品类，避免断言跟着 fixture 里的品类名走。
   */
  function expectScope(answer: QaAnswer): void {
    const category = parseQuestion(answer.question, lexicon).category;
    const scoped = quotes.filter(
      (quote) =>
        quote.quoteDate === LATEST_QUOTE_DATE && (!category || quote.categoryCode === category.code),
    );
    const regions = new Set(scoped.map((quote) => quote.regionName)).size;
    const specs = new Set(scoped.map((quote) => quote.specName)).size;
    const rows = answer.scope?.rows ?? [];
    expect(rows.map((row) => row.label)).toEqual([
      '最新报价日',
      '当天覆盖地域',
      '当天覆盖规格',
      '当天报价条数',
    ]);
    expect(rows[0]!.text).toBe(LATEST_QUOTE_DATE);
    expect(rows[1]!.text).toBe(`${regions} 个`);
    expect(rows[2]!.text).toBe(`${specs} 个`);
    expect(rows[3]!.text).toBe(`${scoped.length} 条`);
    for (const row of rows) {
      expect(row.origin.kind).toBe('daily_quote_aggregate');
    }
    // 「当天可以看的组合」也必须真实存在：逐条回到 daily_quote 里核对。
    for (const line of answer.scope?.available ?? []) {
      const [categoryName, specName, regionName] = line.split(' · ');
      const hit = scoped.find(
        (quote) => quote.specName === specName && quote.regionName === regionName,
      );
      expect(hit, `数据范围里的组合必须真实存在：${line}（${categoryName}）`).toBeTruthy();
    }
  }

  /** 一次回答里的所有数字：按出处逐条回查，不允许有任何无出处的数值。 */
  function expectEveryFigureTraceable(answer: QaAnswer): void {
    const figures = collectRenderedFigures(answer);
    // 事实型回答必须有可回查的数字；解释型可以一条都没有——但也不许凭空冒出数字。
    if (answer.intent === 'fact') expect(figures.length, answer.question).toBeGreaterThan(0);
    for (const figure of figures) {
      if (figure.source === 'knowledge') {
        // 知识条目的数字来自仓库自有文档，出处 id 必须真实存在（逐字回查在单测里做）。
        expect(figure.origin.kind).toBe('knowledge');
        const entryId = figure.origin.kind === 'knowledge' ? figure.origin.id : '';
        expect(KNOWLEDGE_ENTRIES.some((entry) => entry.id === entryId), entryId).toBe(true);
        continue;
      }
      expect(figure.origin.kind, `${figure.label} 必须有库内出处`).not.toBe('knowledge');
      if (figure.origin.kind === 'daily_quote') expectDailyQuoteFigure(figure);
      else if (figure.origin.kind === 'derived_indicator') expectIndicatorFigure(figure);
      else expect(figure.origin.kind).toBe('daily_quote_aggregate');
    }
    if (answer.scope) expectScope(answer);
  }

  beforeAll(async () => {
    storeRoot = await mkdtemp(path.join(tmpdir(), 'bee-gua-35-'));
    admin = createDb(rewriteDb(BASE_URL, 'postgres'));
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${QA_DB} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${QA_DB}`));
    db = createDb(rewriteDb(BASE_URL, QA_DB));
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    await seedPipelineDictionaries(db);
    const summary = await runFixturePipeline({
      db,
      storeRoot,
      idempotencyKey: `gua-35-qa-${randomUUID()}`,
      triggeredBy: 'test',
      gitSha: 'test-git-sha',
    });
    expect(summary.run.status).toBe('succeeded');

    lexicon = await loadQaLexicon(db);
    quotes = await loadRawQuotes();
    const indicatorRows = await db
      .select({
        id: dbSchema.derivedIndicator.id,
        basisDate: dbSchema.derivedIndicator.basisDate,
        value: dbSchema.derivedIndicator.value,
      })
      .from(dbSchema.derivedIndicator);
    const contributionRows = await db
      .select({ indicatorId: dbSchema.indicatorContribution.indicatorId })
      .from(dbSchema.indicatorContribution);
    indicators = indicatorRows.map((row) => ({
      id: row.id,
      basisDate: row.basisDate,
      value: Number(row.value),
      contributionCount: contributionRows.filter((item) => item.indicatorId === row.id).length,
    }));
  });

  afterAll(async () => {
    await db?.$client.end();
    await admin?.execute(sql.raw(`DROP DATABASE IF EXISTS ${QA_DB} WITH (FORCE)`));
    await admin?.$client.end();
    await rm(storeRoot, { recursive: true, force: true });
  });

  it('事实型回答：报价日、区间、中值、涨跌、可信度全部按 origin 回查 daily_quote', async () => {
    expect(quotes.length).toBeGreaterThan(0);
    const answer = await answerQuestion('今天苏州重废多少', { db, env: NO_LLM_ENV });

    expect(answer.intent).toBe('fact');
    expect(answer.factsAvailable).toBe(true);
    expect(answer.aiAssisted).toBe(false);
    expect(answer.facts.length).toBeGreaterThan(0);
    expect(answer.scope?.latestQuoteDate).toBe(LATEST_QUOTE_DATE);

    const card = answer.facts[0]!;
    expect(card.refTable).toBe('daily_quote');
    expect(card.title).toContain('废钢');
    expect(card.rows.map((row) => row.label)).toEqual([
      '报价日',
      '最低价',
      '最高价',
      '中值',
      '较上一交易日',
      '较上周同期',
      '可信度',
    ]);

    expectEveryFigureTraceable(answer);

    // 带数字的行必须逐行标出处；纯文字行（无可比报价）不许偷偷带数字。
    for (const row of card.rows) {
      expect(row.hasNumber).toBe(numberTokens(row.text).length > 0);
    }
    // fixture 里「重废·苏州·采购价」有 10-19 / 10-25 / 10-26 三天，涨跌是真实计算值。
    const purchase = answer.facts.find((item) => item.title.includes('采购价'));
    expect(purchase, '苏州重废采购价应当在回答里').toBeTruthy();
    const change = purchase!.rows.find((row) => row.label === '较上一交易日')!;
    expect(change.hasNumber).toBe(true);
    expect(change.text).toContain(`对比 2026-10-25`);
  });

  it('模型路径也强制走事实层：编造的数字进不了渲染，回答数字与降级路径逐字相同', async () => {
    const baseline = await answerQuestion('今天苏州重废多少', { db, env: NO_LLM_ENV });

    const calls: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(String(init.body ?? ''));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '重废当天中值是 9999 元/吨，明天大概率继续上涨到 12000 元。',
              },
            },
          ],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const withLlm = await answerQuestion('今天苏州重废多少', {
      db,
      env: {
        NODE_ENV: 'test',
        QA_LLM_API_KEY: 'product-key',
        QA_LLM_BASE_URL: 'https://llm.example.invalid/v1',
        QA_LLM_MODEL: 'qa-narrative-model',
      },
      fetchImpl,
    });

    expect(calls).toHaveLength(1);
    const prompt = calls[0] ?? '';
    expect(prompt).toContain('今天苏州重废多少');
    // 模型看不到任何真实报价数值与报价日：提示词里出现的一定是编的，所以先断言它没得抄。
    const realValues = new Set(
      quotes.flatMap((quote) => [
        formatNumber(quote.valueLow),
        formatNumber(quote.valueHigh),
        formatNumber(quote.valueMid),
      ]),
    );
    for (const value of realValues) expect(prompt, `提示词不得包含报价数值 ${value}`).not.toContain(value);
    for (const date of new Set(quotes.map((quote) => quote.quoteDate))) {
      expect(prompt, `提示词不得包含报价日 ${date}`).not.toContain(date);
    }
    // 模型编的数字被整段丢弃 → 回落模板，aiAssisted 保持 false。
    expect(withLlm.aiAssisted).toBe(false);
    expect(withLlm.narrative).toEqual(baseline.narrative);
    expect(JSON.stringify(withLlm)).not.toContain('9999');
    expect(JSON.stringify(withLlm)).not.toContain('12000');
    // 数字层面两条路径完全一致：模型只能改叙事，改不了事实。
    expect(collectRenderedFigures(withLlm)).toEqual(collectRenderedFigures(baseline));
    expectEveryFigureTraceable(withLlm);
  });

  it('干净的模型叙事会被采用，但事实数字一个都不变', async () => {
    const baseline = await answerQuestion('今天苏州重废多少', { db, env: NO_LLM_ENV });
    const clean = [
      '这一组合当天有已发布的报价，区间与中值都来自报价库里的真实记录。',
      '涨跌与哪一天比较，页面上会一并标出；没有可比记录时显示缺失。',
    ];
    const fetchImpl = (async () =>
      ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: clean.join('\n') } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const answer = await answerQuestion('今天苏州重废多少', {
      db,
      env: {
        NODE_ENV: 'test',
        QA_LLM_API_KEY: 'product-key',
        QA_LLM_BASE_URL: 'https://llm.example.invalid/v1',
        QA_LLM_MODEL: 'qa-narrative-model',
      },
      fetchImpl,
    });

    expect(answer.aiAssisted).toBe(true);
    expect(answer.narrative).toEqual(clean);
    expect(collectRenderedFigures(answer)).toEqual(collectRenderedFigures(baseline));
    expectEveryFigureTraceable(answer);
  });

  it('序列问题：只连接真实存在的报价日，缺失日期不补点、不插值', async () => {
    const answer = await answerQuestion('近一周苏州重废报价', { db, env: NO_LLM_ENV });
    expect(answer.intent).toBe('fact');
    const series = answer.facts.filter((card) => card.kind === 'series');
    expect(series.length).toBeGreaterThan(0);
    expect(answer.narrative.join('\n')).toContain('缺失的日期不补点');

    const cutoff = addDays(LATEST_QUOTE_DATE, -(TREND_WINDOW_DAYS - 1));
    for (const card of series) {
      const ids = card.rows.map((row) => (row.origin.kind === 'daily_quote' ? row.origin.id : ''));
      const rows = ids.map((id) => quotes.find((quote) => quote.id === id));
      for (const row of rows) expect(row, '序列里的每一天都必须真实存在').toBeTruthy();
      // 同一张序列卡必须是同一个「品类×规格×地域×价格类型」。
      const keys = new Set(rows.map((row) => keyOf(row!)));
      expect(keys.size).toBe(1);
      const dates = rows.map((row) => row!.quoteDate);
      expect(dates).toEqual([...dates].sort());
      expect(new Set(dates).size).toBe(dates.length);
      // 与库内该口径的窗口内报价日**逐日相等**：不许补点，也不许漏点。
      const expected = quotes
        .filter((quote) => keyOf(quote) === [...keys][0] && quote.quoteDate >= cutoff)
        .map((quote) => quote.quoteDate)
        .sort();
      expect(dates).toEqual(expected);
      for (const row of card.rows) {
        expectDailyQuoteFigure({
          source: 'fact',
          label: row.label,
          text: row.text,
          origin: row.origin,
        });
      }
    }
    expectEveryFigureTraceable(answer);
  });

  it('查不到的组合：明说没有，不给任何数字，也不拿别的日期或地域顶替', async () => {
    const specs = await db
      .select({ nameCn: dbSchema.specGrade.nameCn, categoryId: dbSchema.specGrade.categoryId })
      .from(dbSchema.specGrade);
    const regions = await db.select({ nameCn: dbSchema.region.nameCn }).from(dbSchema.region);

    // 从字典里找一个「最新报价日确实没有报价」的规格 × 地域组合，并确认问法能被解析回去。
    let target: { spec: string; region: string } | null = null;
    outer: for (const spec of specs) {
      for (const region of regions) {
        const exists = quotes.some(
          (quote) =>
            quote.quoteDate === LATEST_QUOTE_DATE &&
            quote.specName === spec.nameCn &&
            quote.regionName === region.nameCn,
        );
        if (exists) continue;
        const question = `今天${region.nameCn}${spec.nameCn}多少`;
        const parsed = parseQuestion(question, lexicon);
        if (parsed.spec?.name !== spec.nameCn || parsed.region?.name !== region.nameCn) continue;
        target = { spec: spec.nameCn, region: region.nameCn };
        break outer;
      }
    }
    expect(target, '库里应当存在一个当天没有报价的组合').toBeTruthy();

    const answer = await answerQuestion(`今天${target!.region}${target!.spec}多少`, {
      db,
      env: NO_LLM_ENV,
    });
    expect(answer.intent).toBe('fact');
    expect(answer.facts).toEqual([]);
    expect(answer.headline).toBe('这一组合没有查到报价');
    expect(answer.missing.join('\n')).toContain('没有就是没有');
    expect(answer.missing.join('\n')).toContain('不当作持平');
    expect(answer.missing.join('\n')).not.toContain('视为持平');
    // 缺口说明本身不含任何数字；页面上剩下的数字仍然只能来自当天的真实数据范围。
    for (const line of answer.missing) expect(numberTokens(line)).toEqual([]);
    // 数据范围里的组合必须真实存在，且都是最新报价日的（不拿旧日期顶替）。
    expectScope(answer);
    expectEveryFigureTraceable(answer);
  });

  it('「全国」只走 derived_indicator，绝不用某一地的 daily_quote 冒充', async () => {
    const answer = await answerQuestion('废钢全国均价是多少', { db, env: NO_LLM_ENV });
    expect(answer.intent).toBe('fact');
    for (const card of answer.facts) {
      expect(card.refTable).toBe('derived_indicator');
      for (const row of card.rows) expect(row.origin.kind).toBe('derived_indicator');
    }
    if (answer.facts.length === 0) {
      const missing = answer.missing.join('\n');
      expect(missing).toContain('全国数字只能来自加工后的指标');
      expect(missing).toContain('不会用某一地的报价顶替');
      for (const line of answer.missing) expect(numberTokens(line)).toEqual([]);
    } else {
      for (const card of answer.facts) {
        const row = indicators.find((item) => item.id === card.refId);
        expect(row, `${card.refId} 必须真实存在于 derived_indicator`).toBeTruthy();
      }
    }
    expectEveryFigureTraceable(answer);
  });

  it('解释型问题走知识库：给条目正文与出处，不甩价格数字', async () => {
    const answer = await answerQuestion('报价为什么是一个区间', { db, env: NO_LLM_ENV });
    expect(answer.intent).toBe('knowledge');
    expect(answer.facts).toEqual([]);
    expect(answer.scope).toBeNull();
    expect(answer.knowledge.length).toBeGreaterThan(0);
    const card = answer.knowledge[0]!;
    expect(card.id).toBe('kb-price-range');
    expect(card.citation).toContain('·');
    expect(card.citation).not.toContain('docs/');
    // 知识条目里的每个数字都必须能在出处文档里逐字找到（不是模型写的）。
    const entry = KNOWLEDGE_ENTRIES.find((item) => item.id === card.id)!;
    const doc = new URL(`../../../${entry.source.doc}`, import.meta.url);
    const text = await import('node:fs/promises').then((fs) => fs.readFile(doc, 'utf8'));
    for (const token of numberTokens([card.title, card.summary, ...card.body].join('\n'))) {
      expect(text, `知识条目数字 ${token} 必须在出处文档里`).toContain(token);
    }
    expect(text).toContain(entry.source.section);
    expect(text).toContain(entry.source.quote);
  });

  it('回答里的数字只可能来自库内出处：叙事、结论、缺口一律无数字', async () => {
    const questions = [
      '今天苏州重废多少',
      '近一周苏州重废报价',
      '今天废钢收购价是多少',
      '废钢全国均价是多少',
      '报价为什么是一个区间',
      '重废和中废怎么分',
      '明天废钢会涨到多少',
    ];
    for (const question of questions) {
      const answer = await answerQuestion(question, { db, env: NO_LLM_ENV });
      for (const line of [answer.headline, ...answer.narrative, ...answer.missing]) {
        expect(numberTokens(line), `${question} → ${line}`).toEqual([]);
      }
      for (const card of answer.facts) {
        expect(numberTokens(card.title), question).toEqual([]);
        for (const row of card.rows) expect(numberTokens(row.label), question).toEqual([]);
      }
      if (answer.intent !== 'refusal') expectEveryFigureTraceable(answer);
    }
  });
});
