import { readFile } from 'node:fs/promises';
import { parsePriceText } from '../extract';
import type { ExtractedRow, SourceDocument, SourceRow } from '../types';

interface FixtureFileRow {
  category: string;
  spec?: string | null;
  region?: string | null;
  priceType: string;
  priceText: string;
  unit: string;
  quoteDate: string;
  observedAt?: string | null;
}

interface FixtureFilePage {
  url: string;
  fetchedAt: string;
  publishedAt?: string | null;
  rows: FixtureFileRow[];
}

interface FixtureFile {
  schemaVersion: 1;
  sourceCode: string;
  license: { id: string; note: string };
  pages: FixtureFilePage[];
}

export interface FixtureAdapterOptions {
  code: string;
  name: string;
  fixturePath: string;
}

/**
 * fixture 源适配器：唯一职责是把自造/CC0 样本按 SourceAdapter 契约喂给管线。
 *
 * 真实来源接入点：实现同一个 SourceAdapter 接口（fetch 做 HTTP/解析，extract 做确定性抽取），
 * 在 registry 中按 source.code 注册即可；管线主干、台账、校验、聚合都不需要改。
 */
export class FixtureSourceAdapter {
  readonly fetcherKind = 'fixture_json';
  readonly license: { id: string; note: string };
  readonly code: string;
  readonly name: string;

  constructor(private readonly options: FixtureAdapterOptions) {
    this.code = options.code;
    this.name = options.name;
    this.license = { id: 'unknown', note: '' };
  }

  private async load(): Promise<FixtureFile> {
    const raw = await readFile(this.options.fixturePath, 'utf8');
    const parsed = JSON.parse(raw) as FixtureFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.pages)) {
      throw new Error(`fixture 格式不合法：${this.options.fixturePath}`);
    }
    if (parsed.sourceCode !== this.code) {
      throw new Error(`fixture sourceCode=${parsed.sourceCode} 与适配器 ${this.code} 不一致`);
    }
    this.license.id = parsed.license.id;
    this.license.note = parsed.license.note;
    return parsed;
  }

  async fetch(_input: { source: SourceRow; date?: string }): Promise<SourceDocument[]> {
    const fixture = await this.load();
    // fixture 是静态快照：每次都返回全部页面（含历史页），模拟真实源站保留近期历史。
    return fixture.pages.map((page) => {
      const body = JSON.stringify(
        {
          schemaVersion: fixture.schemaVersion,
          sourceCode: fixture.sourceCode,
          license: fixture.license,
          page,
        },
        null,
        2,
      );
      return {
        sourceCode: this.code,
        url: page.url,
        fetchedAt: new Date(page.fetchedAt),
        httpStatus: 200,
        contentType: 'application/json',
        body,
        pagePublishedAt: page.publishedAt ? new Date(page.publishedAt) : undefined,
        fetchMeta: { adapter: this.fetcherKind, license: fixture.license.id },
      };
    });
  }

  extract(document: SourceDocument): ExtractedRow[] {
    const parsed = JSON.parse(document.body) as { page: FixtureFilePage };
    return parsed.page.rows.map((row, index) => {
      const parsedPrice = parsePriceText(row.priceText);
      return {
        sourceRowIndex: index,
        rawText: row.priceText,
        rawValueLow: parsedPrice.low,
        rawValueHigh: parsedPrice.high,
        rawUnit: row.unit,
        rawCategoryText: row.category,
        rawSpecText: row.spec ?? null,
        rawRegionText: row.region ?? null,
        rawPriceTypeText: row.priceType,
        quoteDate: row.quoteDate,
        observedAt: row.observedAt ? new Date(row.observedAt) : null,
      };
    });
  }
}
