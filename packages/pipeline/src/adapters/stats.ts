import { readFile } from 'node:fs/promises';
import { ExtractionError, parsePriceText } from '../extract';
import type { ExtractedRow, SourceAdapter, SourceDocument, SourceRow } from '../types';

/** 国家统计局旬报固定入口（每旬公报索引）。 */
export const STATS_INDEX_URL = 'https://www.stats.gov.cn/sj/zxfb/';
/** 本期真实快照对应公报页（2026年10月中旬）。 */
export const STATS_2026_10_MID_URL = 'https://www.stats.gov.cn/sj/zxfb/202610/t20261023_1965679.html';
export const STATS_LICENSE_ID = 'GOV-STATS-ATTRIBUTION';
export const STATS_LICENSE_NOTE =
  '国家统计局《服务条款》：欢迎转载或引用本网所载内容；须显著署名并注明网址，不得曲解修改，不得擅自同意他人继续转载。';

const HONEST_UA =
  'DawanPriceBot/0.1 (+https://github.com/khvysofq/bee; purpose=market-data-compliance; contact=ops@example.invalid)';

export interface StatsAdapterOptions {
  code?: string;
  name?: string;
  /** 回放/测试用：直接读取本地 HTML 快照，避免测试依赖外网。 */
  snapshotPath?: string;
  /** 本地快照对应的线上 URL（用于台账审记；不是访问凭证）。 */
  documentUrl?: string;
  /** 固定抓取时间，便于测试与回放断言。缺省为当前时间。 */
  fetchedAt?: Date;
  timeoutMs?: number;
}

export interface StatsProductRow {
  /** 原始 <table> 内的行号（含表头与分节行），用于 source_row_index 留痕。 */
  sourceRowIndex: number;
  section: string;
  productName: string;
  specText: string | null;
  unit: string;
  priceText: string;
  changeText: string | null;
  changePctText: string | null;
}

export interface StatsBulletin {
  articleTitle: string;
  publishedAt: Date | null;
  periodText: string;
  /** 旬末日，作为报价日（如「2026年10月中旬」→ 2026-10-20）。 */
  periodEnd: string;
  priceCurrency: string;
  rows: StatsProductRow[];
}

/** 五品类映射表：原始公报产品 → 规范品类/规格由 seed-stats.ts 的 term_mapping 落库。 */
const TARGET_PRODUCTS: Array<{ productName: string; specText: string }> = [
  { productName: '螺纹钢', specText: 'Φ20mm，HRB400E' },
  { productName: '电解铜', specText: '1#' },
  { productName: '铝锭', specText: 'A00' },
  { productName: '瓦楞纸', specText: 'AA级120g' },
  { productName: '纸浆', specText: '进口针叶浆' },
  { productName: '聚乙烯', specText: 'LLDPE，熔融指数2薄膜料' },
  { productName: '聚丙烯', specText: '拉丝料' },
];

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const value = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    if (code.startsWith('#')) {
      const value = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return named[code.toLowerCase()] ?? match;
  });
}

function cellText(html: string): string {
  // 公报把同一规格拆在多个行内 <span> 里（如「Φ」「20mm」「，」「HRB400E」），
  // 若把标签一律替换为空格会得到「Φ 20mm ， HRB400E」，与来源原文及映射字典不一致。
  // 行内标签直接去掉；<br> 与块级标签（p/div/li）才代表换行，保留为空格。
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/?(?:p|div|li)\b[^>]*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface RawTable {
  rows: string[][];
}

function parseTables(html: string): RawTable[] {
  const tables: RawTable[] = [];
  const tablePattern = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tablePattern.exec(html))) {
    const rows: string[][] = [];
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowPattern.exec(tableMatch[1]!))) {
      const cells: string[] = [];
      const cellPattern = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellPattern.exec(rowMatch[1]!))) {
        cells.push(cellText(cellMatch[1]!));
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push({ rows });
  }
  return tables;
}

function metaContent(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = new RegExp(`<meta[^>]*name=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, 'i').exec(html);
  if (first?.[1]) return decodeEntities(first[1]).trim();
  const second = new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*name=["']${escaped}["'][^>]*>`, 'i').exec(html);
  return second?.[1] ? decodeEntities(second[1]).trim() : null;
}

function parseCstDateTime(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, m, d, hh, mm] = match;
  const utc = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh) - 8, Number(mm));
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function statsPeriodEnd(title: string): { periodText: string; periodEnd: string } {
  const match = /(\d{4})年(\d{1,2})月(上旬|中旬|下旬)/.exec(title);
  if (!match) throw new ExtractionError(`统计局公报标题缺少可确定性解析的旬期：${title}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const segment = match[3]!;
  const day = segment === '上旬' ? 10 : segment === '中旬' ? 20 : new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodText: `${match[1]}年${match[2]}月${segment}`,
    periodEnd: new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10),
  };
}

function splitProductName(raw: string): { productName: string; specText: string | null } {
  const match = /^(.+?)[（(](.+)[）)]$/.exec(raw.trim());
  if (!match?.[1] || !match[2]) return { productName: raw.trim(), specText: null };
  return { productName: match[1].trim(), specText: match[2].trim() };
}

function normalizeForMatch(text: string): string {
  return text
    .replace(/[\s\u00a0\u3000]/g, '')
    .replace(/[，,]/g, ',')
    .replace(/[—–－-]/g, '-')
    .replace(/[～~]/g, '~');
}

function parseNumberText(text: string | null): number | null {
  if (!text) return null;
  const normalized = text.replace(/[,，\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * 确定性解析一期公报：
 * - 只取第一张「产品名称 / 单位 / 本期价格」价格表（页面另有重复镜像表与规格说明表）；
 * - 分节行保留在 section 字段，数据行保留原文价格/环比；
 * - 旬期来自标题，报价日取旬末日；任何必填目标产品缺失都 fail-loud。
 */
export function parseStatsBulletin(html: string): StatsBulletin {
  const articleTitle = metaContent(html, 'ArticleTitle') ?? cellText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  if (!articleTitle.includes('流通领域重要生产资料市场价格')) {
    throw new ExtractionError(`不是流通领域重要生产资料市场价格公报：${articleTitle || '空标题'}`);
  }
  const { periodText, periodEnd } = statsPeriodEnd(articleTitle);
  const publishedAt = parseCstDateTime(metaContent(html, 'PubDate'));

  const tables = parseTables(html);
  const priceTable = tables.find((table) => {
    const header = table.rows[0]?.join('|') ?? '';
    return header.includes('产品名称') && header.includes('单位') && header.includes('本期价格');
  });
  if (!priceTable) throw new ExtractionError('公报中找不到「产品名称/单位/本期价格」价格表');

  const header = priceTable.rows[0]!;
  const priceHeader = header.find((cell) => cell.includes('本期价格')) ?? '';
  const currencyMatch = /本期价格[（(]([^）)]+)[）)]/.exec(priceHeader);
  const priceCurrency = currencyMatch?.[1]?.trim() || '元';
  if (priceCurrency !== '元') throw new ExtractionError(`本期价格币种不在支持范围：${priceHeader}`);

  const rows: StatsProductRow[] = [];
  let section = '';
  for (let index = 1; index < priceTable.rows.length; index += 1) {
    const cells = priceTable.rows[index]!;
    const name = cells[0]?.trim() ?? '';
    if (!name) continue;
    if (/^[一二三四五六七八九十]+、/.test(name)) {
      section = name;
      continue;
    }
    if (name === '产品名称') continue;
    const unit = cells[1]?.trim() ?? '';
    const priceText = cells[2]?.trim() ?? '';
    if (!unit || !priceText) continue;
    const { productName, specText } = splitProductName(name);
    rows.push({
      sourceRowIndex: index,
      section,
      productName,
      specText,
      unit,
      priceText,
      changeText: cells[3]?.trim() || null,
      changePctText: cells[4]?.trim() || null,
    });
  }

  const byKey = new Map(
    rows.map((row) => [`${normalizeForMatch(row.productName)}|${normalizeForMatch(row.specText ?? '')}`, row]),
  );
  for (const target of TARGET_PRODUCTS) {
    const key = `${normalizeForMatch(target.productName)}|${normalizeForMatch(target.specText)}`;
    if (!byKey.has(key)) {
      throw new ExtractionError(`公报缺少目标产品：${target.productName}（${target.specText}）`);
    }
  }

  return { articleTitle, publishedAt, periodText, periodEnd, priceCurrency, rows };
}

function targetKeySet(): Set<string> {
  return new Set(TARGET_PRODUCTS.map((target) => `${normalizeForMatch(target.productName)}|${normalizeForMatch(target.specText)}`));
}

async function fetchText(url: string, timeoutMs: number): Promise<{ body: string; status: number; contentType: string }> {
  const response = await fetch(url, {
    headers: { 'user-agent': HONEST_UA, accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  return {
    body,
    status: response.status,
    contentType: response.headers.get('content-type') ?? 'text/html; charset=utf-8',
  };
}

/**
 * 国家统计局「流通领域重要生产资料市场价格」旬报适配器。
 *
 * 真实源接入点：`fetch` 只负责取回原文并归档；`extract` 只做确定性表格解析。
 * 测试/回放通过 `snapshotPath` 读取同一份真实 HTML 快照，不依赖外网。
 */
export class StatsSourceAdapter implements SourceAdapter {
  readonly fetcherKind = 'stats_bulletin';
  readonly license = { id: STATS_LICENSE_ID, note: STATS_LICENSE_NOTE };
  readonly code: string;
  readonly name: string;

  constructor(private readonly options: StatsAdapterOptions = {}) {
    this.code = options.code ?? 'stats-cn';
    this.name = options.name ?? '国家统计局（流通领域重要生产资料市场价格旬报）';
  }

  private async loadSnapshot(source: SourceRow): Promise<{ body: string; url: string; status: number; contentType: string }> {
    const params = (source.fetcherParams ?? {}) as Record<string, unknown>;
    const snapshotPath =
      this.options.snapshotPath ?? (typeof params.snapshotPath === 'string' ? params.snapshotPath : undefined);
    if (snapshotPath) {
      return {
        body: await readFile(snapshotPath, 'utf8'),
        url: this.options.documentUrl ?? STATS_2026_10_MID_URL,
        status: 200,
        contentType: 'text/html; charset=utf-8',
      };
    }
    const indexUrl = source.baseUrl || STATS_INDEX_URL;
    const timeoutMs = this.options.timeoutMs ?? 25_000;
    const index = await fetchText(indexUrl, timeoutMs);
    if (index.status !== 200) throw new ExtractionError(`统计局公报索引返回 HTTP ${index.status}`);
    const link = /<a\b[^>]*href=["']([^"']+)["'][^>]*title=["'][^"']*流通领域重要生产资料市场价格[^"']*["'][^>]*>/i.exec(
      index.body,
    );
    if (!link?.[1]) throw new ExtractionError('统计局公报索引中找不到最新的流通领域重要生产资料市场价格链接');
    const bulletinUrl = new URL(link[1], indexUrl).toString();
    const bulletin = await fetchText(bulletinUrl, timeoutMs);
    if (bulletin.status !== 200) throw new ExtractionError(`统计局公报页返回 HTTP ${bulletin.status}：${bulletinUrl}`);
    return { ...bulletin, url: bulletinUrl };
  }

  async fetch(input: { source: SourceRow; date?: string }): Promise<SourceDocument[]> {
    const loaded = await this.loadSnapshot(input.source);
    const parsed = parseStatsBulletin(loaded.body);
    const targetKeys = targetKeySet();
    const targetRows = parsed.rows.filter((row) =>
      targetKeys.has(`${normalizeForMatch(row.productName)}|${normalizeForMatch(row.specText ?? '')}`),
    );
    return [
      {
        sourceCode: this.code,
        url: loaded.url,
        fetchedAt: this.options.fetchedAt ?? new Date(),
        httpStatus: loaded.status,
        contentType: loaded.contentType,
        body: loaded.body,
        pagePublishedAt: parsed.publishedAt ?? undefined,
        fetchMeta: {
          adapter: this.fetcherKind,
          license: this.license.id,
          articleTitle: parsed.articleTitle,
          periodText: parsed.periodText,
          periodEnd: parsed.periodEnd,
          priceCurrency: parsed.priceCurrency,
          sourceSection: '流通领域重要生产资料市场价格',
          tableRowCount: parsed.rows.length,
          targetRowCount: targetRows.length,
          attribution: '数据来源：国家统计局（流通领域重要生产资料市场价格）',
        },
      },
    ];
  }

  extract(document: SourceDocument): ExtractedRow[] {
    const parsed = parseStatsBulletin(document.body);
    const targetKeys = targetKeySet();
    return parsed.rows
      .filter((row) => targetKeys.has(`${normalizeForMatch(row.productName)}|${normalizeForMatch(row.specText ?? '')}`))
      .map((row) => {
        const price = parsePriceText(row.priceText);
        return {
          sourceRowIndex: row.sourceRowIndex,
          rawText: row.priceText,
          rawValueLow: price.low,
          rawValueHigh: price.high,
          rawUnit: `${parsed.priceCurrency}/${row.unit}`,
          rawCategoryText: row.productName,
          rawSpecText: row.specText,
          rawRegionText: '全国',
          rawPriceTypeText: '本期价格',
          quoteDate: parsed.periodEnd,
          observedAt: parsed.publishedAt,
          rawChangeValue: parseNumberText(row.changeText),
          rawChangePct: parseNumberText(row.changePctText),
          rawPeriodText: parsed.periodText,
          rawSectionText: row.section || null,
        };
      });
  }
}
