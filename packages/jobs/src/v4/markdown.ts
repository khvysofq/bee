import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

/**
 * HTML → Markdown 与统一 frontmatter。
 *
 * 提取顺序：Readability（正文/标题/摘要）→ 失败时退化为 <article>/<main>/<body>。
 * 正文里的图片保留原 `![](url)` 外链，不下载、不上传、不改写成 S3 地址。
 */

export interface ArticleExtraction {
  title: string;
  markdown: string;
  textContent: string;
  excerpt: string;
  byline: string | null;
  siteName: string | null;
  extractor: 'readability-v1' | 'dom-fallback-v1';
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function createTurndown(): TurndownService {
  return new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
}

/** 找 <article>/<main>/<body>，作为 Readability 失败时的兜底。 */
function fallbackRoot(document: Document): Element | null {
  return document.querySelector('article') ?? document.querySelector('main') ?? document.body;
}

/** 兜底提取时，正文里常含与 title 相同的 h1；去掉以免标题重复。 */
function stripLeadingTitle(markdown: string, title: string): string {
  const normalizedTitle = cleanText(title);
  if (!normalizedTitle) return markdown;
  const lines = markdown.split('\n');
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstIndex === -1) return markdown;
  const first = lines[firstIndex]?.trim() ?? '';
  const heading = first.replace(/^#+\s*/, '').trim();
  if (heading === normalizedTitle) {
    lines.splice(0, firstIndex + 1);
    return lines.join('\n').trim();
  }
  return markdown;
}

export function htmlToMarkdown(html: string, url: string): ArticleExtraction {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const documentTitle = cleanText(document.title);
  const turndown = createTurndown();

  let title = documentTitle;
  let articleHtml = '';
  let textContent = '';
  let excerpt = '';
  let byline: string | null = null;
  let siteName: string | null = null;
  let extractor: ArticleExtraction['extractor'] = 'readability-v1';

  // Readability 会改写 DOM，必须在兜底读取之前完成。
  const parsed = new Readability(document).parse();
  if (parsed && parsed.content && cleanText(parsed.textContent)) {
    title = cleanText(parsed.title) || documentTitle;
    articleHtml = parsed.content;
    textContent = parsed.textContent ?? '';
    excerpt = cleanText(parsed.excerpt);
    byline = cleanText(parsed.byline) || null;
    siteName = cleanText(parsed.siteName) || null;
  } else {
    extractor = 'dom-fallback-v1';
    const root = fallbackRoot(document);
    const h1 = cleanText(document.querySelector('h1')?.textContent);
    title = documentTitle || h1;
    articleHtml = root?.innerHTML ?? '';
    textContent = root?.textContent ?? '';
    const metaDescription = cleanText(
      document.querySelector('meta[name="description"]')?.getAttribute('content'),
    );
    excerpt = metaDescription || cleanText(textContent).slice(0, 160);
  }

  let markdown = articleHtml ? turndown.turndown(articleHtml).trim() : '';
  markdown = stripLeadingTitle(markdown, title);

  return {
    title: title || '未命名文章',
    markdown,
    textContent: cleanText(textContent),
    excerpt,
    byline,
    siteName,
    extractor,
  };
}

export interface ContentFrontmatter {
  id: string;
  kind: 'news_item' | 'news_digest' | 'analysis' | 'forecast';
  category: string;
  categoryCode: string;
  region: string;
  date: string;
  periodStart?: string;
  periodEnd?: string;
  sources: string[];
  license: string;
  generatedAt: string;
}

/** JSON.stringify 产出的是合法 YAML 双引号标量，中文与冒号都安全。 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function buildFrontmatter(fm: ContentFrontmatter): string {
  const lines = [
    '---',
    `id: ${yamlString(fm.id)}`,
    `kind: ${fm.kind}`,
    `category: ${yamlString(fm.category)}`,
    `category_code: ${yamlString(fm.categoryCode)}`,
    `region: ${yamlString(fm.region)}`,
    `date: ${yamlString(fm.date)}`,
  ];
  if (fm.kind === 'forecast') {
    if (!fm.periodStart || !fm.periodEnd) {
      throw new Error('forecast frontmatter 缺少 period_start / period_end');
    }
    lines.push(`period_start: ${yamlString(fm.periodStart)}`);
    lines.push(`period_end: ${yamlString(fm.periodEnd)}`);
  }
  lines.push(`sources: [${fm.sources.map(yamlString).join(', ')}]`);
  lines.push(`license: ${yamlString(fm.license)}`);
  lines.push(`generated_at: ${yamlString(fm.generatedAt)}`);
  lines.push('---');
  return lines.join('\n');
}

export function composeMarkdown(fm: ContentFrontmatter, body: string): string {
  return `${buildFrontmatter(fm)}\n\n${body.trim()}\n`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 摘要按字符截断（中文按 1 个字符计），并压平空白。 */
export function truncateText(value: string, length: number): string {
  const text = cleanText(value);
  return text.length <= length ? text : `${text.slice(0, length)}`;
}

/**
 * 生成确定性 UUID（v4 形状）：同一组业务键永远得到同一个 id。
 * 用于 digest / analysis / forecast 的幂等 upsert。
 */
export function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 表格单元格转义：竖线与换行会破坏 Markdown 表格。 */
export function tableCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '—' : String(value);
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}