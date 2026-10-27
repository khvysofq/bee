import { SANCTIONED_FORECAST_PHRASE } from './intent';

/**
 * 生成文本合规扫描（GUA-35）。
 *
 * 只用于**模型产出的叙事**。判定标准来自 docs/compliance/content-boundary-v1.md
 * §3（硬性不做）、§5.9（AI 数字禁令）、§9.3（发布前禁用词检查）。
 *
 * 一旦命中任何一条，整段叙事直接丢弃，回落到确定性模板话术——不做「局部修补」，
 * 因为修补后的文本无法保证语义完整，也无法逐字测试。
 *
 * 模板话术与知识库条目是代码常量，同样跑这套扫描（测试里逐条校验），
 * 但它们不需要在运行时被丢弃。
 */

export interface ComplianceHit {
  rule: string;
  match: string;
}

/** 数字：ASCII 与全角。任何裸数字都不允许来自模型。 */
const DIGIT_PATTERN = /[0-9０-９]/;

/**
 * 中文数字 + 货币/重量单位：例如「两千三百元」「三吨」「一点五元」。
 * 只盯单位词，不盯「价 / 点」——否则「统一价格」「第一价位」这类正常表述会被误杀。
 */
const CN_NUMBER_PRICE_PATTERN = /[一二两三四五六七八九十百千万亿零][十百千万亿]?[一二三四五六七八九]?[点.]?[一二三四五六七八九]?(元|块钱|块|吨|公斤|斤)/;

/** 越界表述（§3）：价位判断、方向判断、交易指令、收益担保、专业意见。 */
const FORBIDDEN_ADVICE = [
  '预测', '预判', '预估', '大概率', '会涨', '会跌', '将涨', '将跌', '继续涨', '继续跌',
  '上涨', '下跌', '走高', '走低', '看涨', '看跌', '回落', '反弹', '涨到', '跌到',
  '目标价', '目标位', '点位', '支撑位', '压力位', '阻力位',
  '建议买', '建议卖', '建议收', '建议出', '建议囤', '买入', '卖出', '建仓', '平仓',
  '加仓', '减仓', '补库', '清仓', '囤货', '压货', '止损', '止盈', '抄底', '追高', '追涨',
  '套保', '对冲', '必涨', '必跌', '稳赚', '包赚', '保证涨', '保证跌', '保证准确',
  '收益承诺', '承诺收益', '准确率', '胜率', '翻倍',
  '法律意见', '税务意见', '会计处理建议', '评估意见',
];

/** 内部术语与内部实现细节：对外正文一律不出现（合规原文优先）。 */
const FORBIDDEN_INTERNAL = [
  '口径', '定档', '巡检', '异常队列', '数据底座', '存档', '实时', '抓取', '爬虫', '采集',
  'fixture', 'secret', 'daily_quote', 'derived_indicator', 'price_observation', 'raw_fetch',
  'DAW-', 'GUA-', 'P0-', '/internal', '/ops', '/status', '/briefing', '/raw/',
];

/** 把合规强制的否定句摘掉，剩下的文本里不允许再出现「预测」。 */
function withoutSanctionedPhrase(text: string): string {
  return text.split(SANCTIONED_FORECAST_PHRASE).join('');
}

export function scanGeneratedText(text: string): ComplianceHit[] {
  const hits: ComplianceHit[] = [];
  const digitMatch = text.match(DIGIT_PATTERN);
  if (digitMatch) hits.push({ rule: 'digit', match: digitMatch[0] });

  const cnMatch = text.match(CN_NUMBER_PRICE_PATTERN);
  if (cnMatch) hits.push({ rule: 'cn-number-price', match: cnMatch[0] });

  const scanTarget = withoutSanctionedPhrase(text);
  const lowered = scanTarget.toLowerCase();
  for (const term of FORBIDDEN_ADVICE) {
    if (scanTarget.includes(term)) hits.push({ rule: 'forbidden-advice', match: term });
  }
  for (const term of FORBIDDEN_INTERNAL) {
    if (lowered.includes(term.toLowerCase())) hits.push({ rule: 'forbidden-internal', match: term });
  }
  return hits;
}

/** 叙事是否可以直接渲染。 */
export function isNarrativeSafe(text: string): boolean {
  return scanGeneratedText(text).length === 0;
}

export { FORBIDDEN_ADVICE, FORBIDDEN_INTERNAL };
