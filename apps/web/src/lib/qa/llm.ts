import { scanGeneratedText } from './compliance-scan';
import type { QaFactCard, QaIntentKind, QaScopeView } from './types';

/**
 * 模型叙事层（GUA-35）。
 *
 * 三件必须成立的事：
 *  1. **模型看不到数字。** 送进提示词的只有「有没有这一组合的报价、有哪些字段、命中了哪些条目」
 *     这类不含数字的摘要。所以模型输出里的任何数字都必然是编的，一律丢弃。
 *  2. **凭据只认应用自己的环境变量。** 只读 `QA_LLM_API_KEY` / `QA_LLM_BASE_URL` /
 *     `QA_LLM_MODEL` / `QA_LLM_TIMEOUT_MS`。agent 运行时环境里的 `ANTHROPIC_API_KEY`
 *     之类是基础设施凭据，本文件（以及整个 apps/web）不读、不写、不落盘。
 *  3. **缺配置就降级。** 没有 key 时返回 null，回答层直接走确定性模板话术——
 *     那是真功能，不是占位。
 */

/** 产品自己的模型凭据（需用户单独提供，走 secret 流程注入环境变量）。 */
export const QA_LLM_ENV_KEYS = [
  'QA_LLM_API_KEY',
  'QA_LLM_BASE_URL',
  'QA_LLM_MODEL',
  'QA_LLM_TIMEOUT_MS',
] as const;

/**
 * 明确禁止读取的环境变量：agent 基础设施凭据与其他服务的密钥。
 * 有测试直接扫源码，断言 apps/web 里除了这个黑名单常量本身之外不出现这些名字。
 */
export const FORBIDDEN_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_API_KEY',
  'OPENAI_API_KEY',
  'PAPERCLIP_API_KEY',
  'PAPERCLIP_AGENT_ID',
  'GITHUB_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
] as const;

export interface QaLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_PARAGRAPHS = 3;
const MAX_PARAGRAPH_CHARS = 220;

export function readQaLlmConfig(env: NodeJS.ProcessEnv = process.env): QaLlmConfig | null {
  const apiKey = (env.QA_LLM_API_KEY ?? '').trim();
  const baseUrl = (env.QA_LLM_BASE_URL ?? '').trim();
  const model = (env.QA_LLM_MODEL ?? '').trim();
  if (!apiKey || !baseUrl || !model) return null;
  const parsedTimeout = Number.parseInt((env.QA_LLM_TIMEOUT_MS ?? '').trim(), 10);
  const timeoutMs =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0 && parsedTimeout <= 60000
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MS;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model, timeoutMs };
}

/** 事实摘要：刻意不含任何数字，让模型无从「复述」也无从「编造」具体值。 */
export function factsDigest(cards: QaFactCard[]): string[] {
  return cards.map((card) => {
    const fields = card.rows.map((row) => row.label).join('、');
    if (card.kind === 'series') return `一段真实历史序列：${card.title}，逐日列出${fields}`;
    if (card.kind === 'indicator') return `一条加工后的指标：${card.title}，含${fields}`;
    return `一条当天报价：${card.title}，含${fields}`;
  });
}

export function scopeDigest(scope: QaScopeView | null): string[] {
  if (!scope) return [];
  const labels = scope.rows.map((row) => row.label).join('、');
  return [`数据范围：${labels}`, `可看的组合示例：${scope.available.slice(0, 4).join('；') || '暂无'}`];
}

export interface NarrativeRequest {
  question: string;
  intent: QaIntentKind;
  facts: string[];
  knowledge: { title: string; summary: string }[];
  scope: string[];
  missing: string[];
}

const SYSTEM_PROMPT = [
  '你是再生资源行情问答页的写作助手，只负责把已经查好的结果讲清楚。',
  '硬性规则：',
  '1. 禁止输出任何数字，包括阿拉伯数字、日期、百分比、中文数字加单位。数字由页面另行渲染，你写了也会被丢弃。',
  '2. 禁止预测未来价格、给涨跌判断、给点位或目标价、给买卖或库存建议、承诺收益或准确性、提供法律税务会计等专业意见。',
  '3. 禁止使用内部术语与内部实现细节，只说用户听得懂的话。',
  '4. 只能依据提供的事实要点与知识条目摘要，不得补充任何未提供的信息；没有依据就不要展开。',
  '5. 输出简体中文，最多三段，每段不超过两句话，段落之间用换行分隔，不要标题、不要列表符号、不要客套话。',
].join('\n');

function buildUserPrompt(request: NarrativeRequest): string {
  const lines = [`用户问题：${request.question}`];
  if (request.facts.length > 0) lines.push('已查到的事实（不含数字）：', ...request.facts.map((item) => `- ${item}`));
  if (request.knowledge.length > 0) {
    lines.push(
      '可用的站内知识条目：',
      ...request.knowledge.map((item) => `- ${item.title}：${item.summary}`),
    );
  }
  if (request.scope.length > 0) lines.push('数据范围说明：', ...request.scope.map((item) => `- ${item}`));
  if (request.missing.length > 0) lines.push('必须如实转达的缺口：', ...request.missing.map((item) => `- ${item}`));
  lines.push('请写出面向用户的解释性文字。');
  return lines.join('\n');
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
}

/**
 * 取模型叙事。任何异常、超时、格式不符或合规扫描命中都返回 null，
 * 由回答层回落到确定性模板话术。
 */
export async function generateNarrative(
  request: NarrativeRequest,
  config: QaLlmConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[] | null> {
  try {
    const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(request) },
        ],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    return sanitizeNarrative(content);
  } catch {
    return null;
  }
}

/**
 * 清洗模型输出：分段、去标记、限长，然后逐段跑合规扫描。
 * 只要有一段命中（含任何数字），整段叙事作废——不做局部修补。
 */
export function sanitizeNarrative(raw: string): string[] | null {
  const paragraphs = raw
    .split(/\r?\n/)
    .map((line) =>
      line
        // 先去掉强调标记，再去列表符号：否则 '**加粗**' 会剩下一个孤零零的 '*'。
        .replace(/```|~~/g, '')
        .replace(/\*\*|__|\*|_/g, '')
        .replace(/^\s*(?:[-•·]\s*|\d+[.、)]\s*|#+\s*)+/, '')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .slice(0, MAX_PARAGRAPHS)
    .map((line) => (line.length > MAX_PARAGRAPH_CHARS ? `${line.slice(0, MAX_PARAGRAPH_CHARS)}…` : line));

  if (paragraphs.length === 0) return null;
  for (const paragraph of paragraphs) {
    if (scanGeneratedText(paragraph).length > 0) return null;
  }
  return paragraphs;
}
