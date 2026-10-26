import { sha256Hex, storeContent, readContent } from './store';
import type { ExtractedRow, ExtractArtifact, SourceAdapter, SourceDocument } from './types';

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

const FULL_WIDTH_DIGITS = '０１２３４５６７８９';

function normalizeNumericText(text: string): string {
  return text
    .replace(/[０-９]/g, (ch) => String(FULL_WIDTH_DIGITS.indexOf(ch)))
    .replace(/[，,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 确定性价格抽取：只认原文里的数字与区间符号，不做任何单位/口径推断。
 * 解析不出数字 = 抽取失败（调用方把该步标 failed），绝不用 LLM 猜一个数。
 */
export function parsePriceText(text: string): { low: number; high: number } {
  const normalized = normalizeNumericText(text);
  const range = normalized.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|~|～|至)\s*(\d+(?:\.\d+)?)/);
  if (range?.[1] && range[2]) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
      throw new ExtractionError(`价格原文区间不合法：${text}`);
    }
    return { low, high };
  }
  const single = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!single?.[1]) throw new ExtractionError(`价格原文里没有可确定性解析的数字：${text}`);
  const value = Number(single[1]);
  if (!Number.isFinite(value)) throw new ExtractionError(`价格原文数字不可解析：${text}`);
  return { low: value, high: value };
}

export function extractDocument(adapter: SourceAdapter, document: SourceDocument): ExtractedRow[] {
  return adapter.extract(document);
}

export function buildExtractArtifact(args: {
  runId: string;
  extractVersion: string;
  documents: Array<{
    sourceId: string;
    sourceCode: string;
    fetchId: string;
    contentSha256: string;
    rows: ExtractedRow[];
  }>;
}): ExtractArtifact {
  return {
    schemaVersion: 1,
    runId: args.runId,
    extractVersion: args.extractVersion,
    documents: args.documents,
  };
}

export async function writeExtractArtifact(
  root: string,
  artifact: ExtractArtifact,
): Promise<{ extractedRef: string; extractedSha: string }> {
  const body = JSON.stringify(artifact);
  const stored = await storeContent(root, { namespace: 'work', body });
  return { extractedRef: stored.contentRef, extractedSha: stored.contentSha256 };
}

export async function readExtractArtifact(root: string, ref: string): Promise<ExtractArtifact> {
  const body = await readContent(root, ref);
  const parsed = JSON.parse(body) as ExtractArtifact;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.documents)) {
    throw new ExtractionError(`抽取工件格式不合法：${ref}`);
  }
  for (const document of parsed.documents) {
    for (const row of document.rows) {
      row.observedAt = row.observedAt ? new Date(row.observedAt) : null;
    }
  }
  return parsed;
}

export function extractArtifactSha(artifact: ExtractArtifact): string {
  return sha256Hex(JSON.stringify(artifact));
}
