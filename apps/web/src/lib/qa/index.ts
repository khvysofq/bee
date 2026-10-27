/**
 * 行业问答（GUA-35）对外出口。
 *
 * 分层：knowledge（本仓库自有文档切出的条目）→ retrieve（确定性检索）→
 * intent（越界判定与拒绝话术）→ facts（daily_quote / derived_indicator 事实层）→
 * llm（只写叙事，看不到数字）→ answer（编排）。
 */

export * from './answer';
export * from './compliance-scan';
export * from './facts';
export * from './intent';
export * from './knowledge';
export * from './llm';
export * from './retrieve';
export * from './types';
