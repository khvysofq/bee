/**
 * 合规文案常量（P0-4）。
 *
 * 文案与版本 ID 必须与 docs/compliance/content-boundary-v1.md 的定稿逐字一致；
 * 测试会直接读取该文档做 diff，禁止在页面里私自改写。
 */
export const CONTENT_POLICY_ID = 'DAW-30-CONTENT-BOUNDARY-v1';
export const BRIEF_DISCLAIMER_ID = 'BRIEF_DISCLAIMER_V1';
export const AI_LABEL_ID = 'AI_LABEL_V1';

export const BRIEF_DISCLAIMER =
  '本页报价与行情信息来自公开渠道或经授权的数据来源，经自动化采集和规则校验后整理，仅供行业信息参考，不构成投资、交易、采购、销售建议，亦不构成法律、税务等专业意见，也不构成对成交价格、数量、时效或交易结果的保证或承诺。报价受规格、等级、税口径、含水含杂、区域及统计时点差异影响，请以来源页面及交易双方最终确认的信息为准。除特别注明外，“全国均价”等聚合指标均为加权/中位加工指标，不代表全国统一观测价。引用本页数据须注明来源、抓取时间及统计口径。';

export const AI_LABEL = 'AI 辅助生成：本页叙事由 AI 辅助生成；报价数字来自可追溯数据源，非 AI 生成。';

/** 国家统计局旬报署名（GUA-20 合规红线：显著署名 + 原文链接 + 不得再授权下游转载）。 */
export const STATS_SOURCE_CODE = 'stats-cn';
export const STATS_ATTRIBUTION = '数据来源：国家统计局（流通领域重要生产资料市场价格）';
export const STATS_COMPLIANCE_NOTE =
  '全国参考锚点价（原生品，非废料分档现货；区域分档暂缺）。数值按公报原文引用，未作修改；引用须署名并附原文链接，不得再授权下游转载。';

export const FIXTURE_NOTICE =
  'FIXTURE / 开放数据（CC0-1.0）占位：本页仍含自造 fixture 数据（废料分档层），不得用于实际交易决策。';

export const DATA_SOURCE_NOTE = '数据来源：P0-3 fixture 适配器 · 许可 CC0-1.0 · 本地内容寻址存档';
