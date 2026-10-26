/**
 * P0-6 落地页渲染冒烟测试（GUA-26）：不接数据库 —— 用内存 LandingData 渲染
 * <LandingView/> 到静态 HTML，断言：品类卡片、主价、涨跌（颜色/箭头语义）、sparkline、
 * /briefing 入口与锚点、溯源交互挂载点、FIXTURE 标识与免责声明逐字在场、空态兜底。
 *
 * 页面数字的真实来源由 packages/pipeline/tests/web-landing.integration.test.ts 保证
 * （loadLandingData 对 bee_test 逐数与 daily_quote 回查一致）。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LandingView } from '../src/components/LandingView';
import {
  AI_LABEL,
  AI_LABEL_ID,
  BRIEF_DISCLAIMER,
  BRIEF_DISCLAIMER_ID,
  CONTENT_POLICY_ID,
  FIXTURE_NOTICE,
} from '../src/lib/compliance';
import type { LandingData } from '../src/lib/landing-data';

const data: LandingData = {
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
        sources: [{ code: 'fixture-a', name: 'Fixture A', trustWeight: 80, fetchedAt: '2026-10-26T07:00:00.000Z' }],
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
        confidence: 'high',
        sources: [],
        dailyChange: null,
        weeklyChange: null,
      },
      trend: [{ date: '2026-10-26', value: 68600 }],
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
  hasStatsSource: false,
  stats: { categoryCount: 3, categoriesWithQuotes: 2, quoteCount: 4, sourceCount: 1 },
  empty: false,
};

function render(landing: LandingData): string {
  return renderToStaticMarkup(createElement(LandingView, { data: landing }));
}

describe('P0-6 落地页渲染冒烟', () => {
  const html = render(data);

  it('首屏 hero：产品名、价值主张、报价日与 fixture 显著标识', () => {
    expect(html).toContain('再生材料行情每日简报');
    expect(html).toContain('报价日 2026-10-26');
    expect(html).toContain('每个数字都可溯源到原始存档');
    // FIXTURE 标识逐字来自 compliance 常量，必须显著在场
    expect(html).toContain(FIXTURE_NOTICE);
    expect(html).toContain('FIXTURE / 开放数据');
  });

  it('品类卡片：主价、区间、代表口径、日/周涨跌（箭头语义）与缺档兜底', () => {
    expect(html).toContain('废钢');
    expect(html).toContain('废铜');
    expect(html).toContain('废纸');
    // 主价与区间来自传入的定档数据
    expect(html).toContain('2,387.5');
    expect(html).toContain('2,350 – 2,420');
    expect(html).toContain('重废');
    expect(html).toContain('苏州');
    expect(html).toContain('采购价');
    // 涨跌：▲ 红涨 / ▼ 绿跌语义（此处断言箭头与数值同现）
    expect(html).toContain('▲');
    expect(html).toContain('+0.95%');
    expect(html).toContain('+2.25%');
    expect(html).toContain('lp-change-up');
    // 无可比定档：缺失不当作持平
    expect(html).toContain('缺失不当作持平');
    expect(html).toContain('今日无已发布报价（缺失不当作持平）。');
  });

  it('走势 sparkline：SVG 折线 + 点位窗口说明，无重型图表库', () => {
    expect(html).toContain('<svg');
    expect(html).toContain('<polyline');
    expect(html).toContain('3 个定档日');
    expect(html).toContain('2026-10-19 → 2026-10-26');
  });

  it('入口引导：/briefing 主入口与每卡片品类锚点', () => {
    expect(html).toContain('href="/briefing"');
    expect(html).toContain('href="/briefing#category-scrap-steel"');
    expect(html).toContain('href="/briefing#category-scrap-copper"');
    expect(html).toContain('进入每日行情简报');
  });

  it('溯源：卡片主价与涨跌挂 TraceNumber（data-trace-* 可交互）', () => {
    expect(html).toContain('data-trace-kind="quote"');
    expect(html).toContain('data-trace-id="quote-steel-1"');
    expect(html).toContain('data-trace-id="quote-copper-1"');
    expect(html).toContain('定档报价溯源');
  });

  it('合规底部：免责声明 / AI 标识 / 内容策略 ID 逐字在场', () => {
    expect(html).toContain(BRIEF_DISCLAIMER_ID);
    expect(html).toContain(BRIEF_DISCLAIMER);
    expect(html).toContain(AI_LABEL_ID);
    expect(html).toContain(AI_LABEL);
    expect(html).toContain(CONTENT_POLICY_ID);
    expect(html).toContain('数据来源：P0-3 fixture 适配器');
  });

  it('空态：全库无已发布定档时给出引导而不是空白页', () => {
    const emptyHtml = render({ ...data, categories: [], empty: true, latestQuoteDate: null, dataCutoffAt: null });
    expect(emptyHtml).toContain('还没有可展示的行情数据');
    expect(emptyHtml).toContain('daily_quote');
    // FIXTURE 合规标识不因空态消失由 hasFixtureSource 决定；空态下无来源则不虚构
    const noSourceHtml = render({ ...data, hasFixtureSource: false });
    expect(noSourceHtml).not.toContain(FIXTURE_NOTICE);
  });
});
