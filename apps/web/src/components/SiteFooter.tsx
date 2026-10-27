import type { BriefingData } from '@/lib/briefing-data';
import {
  AI_LABEL,
  BRIEF_DISCLAIMER,
  FIXTURE_NOTICE,
  STATS_ATTRIBUTION,
  STATS_COMPLIANCE_NOTE,
  STATS_SOURCE_CODE,
} from '@/lib/compliance';
import type { LandingData } from '@/lib/landing-data';
import type { MarketOverview } from '@/lib/market-overview';
import { formatUpdateTime } from '@/lib/presentation';
import { Wordmark } from './Brand';

/**
 * 页脚「数据说明」（GUA-33）。
 *
 * 合规文案集中在这一块：AI 标识、免责声明、统计局署名 + 原文链接、fixture 标识，
 * 全部逐字来自 lib/compliance.ts，可见、不折叠、不做 banner / 弹窗。
 * 版本号只写入页面 metadata（root layout），不在正文出现。
 */
export interface FooterInfo {
  hasFixtureSource: boolean;
  hasStatsSource: boolean;
  statsSourceUrl: string | null;
  latestQuoteDate: string | null;
  updatedAt: string | null;
}

function hasFixture(sources: { code: string }[]): boolean {
  return sources.some((source) => source.code.startsWith('fixture') || source.code === 'open-cc0-sample');
}

export function footerInfoFromLanding(data: LandingData): FooterInfo {
  return {
    hasFixtureSource: data.hasFixtureSource,
    hasStatsSource: data.hasStatsSource,
    statsSourceUrl: data.statsSourceUrl,
    latestQuoteDate: data.latestQuoteDate,
    updatedAt: data.dataCutoffAt,
  };
}

export function footerInfoFromOverview(data: MarketOverview): FooterInfo {
  return {
    hasFixtureSource: data.hasFixtureSource,
    hasStatsSource: data.hasStatsSource,
    statsSourceUrl: data.statsSourceUrl,
    latestQuoteDate: data.globalLatest,
    updatedAt: data.dataCutoffAt,
  };
}

export function footerInfoFromBriefing(data: BriefingData): FooterInfo {
  const statsSource = data.sources.find((source) => source.code === STATS_SOURCE_CODE);
  return {
    hasFixtureSource: hasFixture(data.sources),
    hasStatsSource: Boolean(statsSource),
    statsSourceUrl: statsSource?.latestFetchUrl ?? null,
    latestQuoteDate: data.latestQuoteDate,
    updatedAt: data.dataCutoffAt,
  };
}

export function emptyFooterInfo(): FooterInfo {
  return {
    hasFixtureSource: false,
    hasStatsSource: false,
    statsSourceUrl: null,
    latestQuoteDate: null,
    updatedAt: null,
  };
}

export function SiteFooter(props: { info: FooterInfo }) {
  const { info } = props;
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-top">
          <div className="footer-brand">
            <Wordmark />
          </div>
          <p className="footer-statement">
            面向回收站与废品贸易商的日频行情工具。数字来自已校验的报价数据；缺失不当作持平，涨跌按上一交易日中值计算。
          </p>
        </div>

        <section className="data-notes" aria-label="数据说明">
          <h2 className="data-notes-title">数据说明</h2>
          <div className="notes-grid">
            <div className="note-block">
              <h3>AI 生成内容标识</h3>
              <p>{AI_LABEL}</p>
            </div>
            <div className="note-block">
              <h3>免责声明</h3>
              <p>{BRIEF_DISCLAIMER}</p>
            </div>
            {info.hasStatsSource ? (
              <div className="note-block note-wide">
                <h3>数据来源 · 国家统计局</h3>
                <p className="note-source">
                  {STATS_ATTRIBUTION}
                  {info.statsSourceUrl ? (
                    <>
                      {' · '}
                      <a href={info.statsSourceUrl} target="_blank" rel="noreferrer">
                        查看公报原文
                      </a>
                    </>
                  ) : null}
                </p>
                <p>{STATS_COMPLIANCE_NOTE}</p>
              </div>
            ) : null}
            {info.hasFixtureSource ? (
              <div className="note-block note-wide">
                <h3>Fixture 数据标识</h3>
                <p className="note-source">{FIXTURE_NOTICE}</p>
              </div>
            ) : null}
          </div>
        </section>

        <div className="footer-base">
          <span>© 2026 bee · 再生物资行情</span>
          <a
            className="footer-icp"
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
          >
            京ICP备2023038384号-1
          </a>
          <span>
            报价日 {info.latestQuoteDate ?? '—'} · 数据更新于 {formatUpdateTime(info.updatedAt)}
          </span>
        </div>
      </div>
    </footer>
  );
}