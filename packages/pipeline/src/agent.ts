import { sha256Hex } from './store';

export interface AgentReviewInput {
  sourceName: string;
  categoryId: string | null;
  specId: string | null;
  regionId: string | null;
  priceType: string | null;
  ruleVerdicts: Array<{ checkKind: string; verdict: string }>;
}

export interface AgentReview {
  verdict: 'pass' | 'flag';
  rationale: string;
}

/**
 * Agent 校验器契约。真实模型接入点：实现本接口并替换 createFixtureReviewer()，
 * 调用时把完整 prompt/输入/输出写入 agent_invocation（管线已负责落库）。
 *
 * 红线：Agent 只判断，不产数。输出结构里没有价格字段；任何数字都必须来自 observation
 * 的 raw→norm 确定性抽取链。
 */
export interface AgentReviewer {
  model: string;
  promptVersion: string;
  prompt: string;
  review(input: AgentReviewInput): Promise<AgentReview>;
}

export const VALIDATION_PROMPT = [
  '你是废品行情数据校验员。',
  '只根据给定的确定性规则结论与维度映射，判断是否允许该观测进入定档。',
  '不得输出、修改或推断任何价格数字；数字以确定性抽取链为准。',
  '输出 pass（规则全部通过）或 flag（存在异常/口径缺口，需人工复核）。',
].join('\n');

/**
 * P0-3 的占位 Agent：没有外部模型凭证时，用确定性 reviewer 复述规则结论。
 * 它是「LLM 只做校验、不产数」的结构替身，不是假装真实模型；接真模型时只换实现。
 */
export function createFixtureReviewer(): AgentReviewer {
  return {
    model: 'fixture-reviewer-v1',
    promptVersion: 'daw29-validator@v1',
    prompt: VALIDATION_PROMPT,
    async review(input) {
      const flagged = input.ruleVerdicts.some((v) => v.verdict !== 'pass');
      return flagged
        ? { verdict: 'flag', rationale: '确定性规则标记异常或口径缺口，建议人工复核来源与映射' }
        : { verdict: 'pass', rationale: '确定性规则全部通过，未见口径冲突' };
    },
  };
}

export function promptSha(reviewer: AgentReviewer): string {
  return sha256Hex(reviewer.prompt);
}
