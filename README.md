# bee —— 报废品行情信息平台 · 数据底座

给中国再生资源行业中小从业者（回收站、废品贸易商）的**每天可信的日频报价与行情简报**。
产品三块能力（行情简报 / 情景推演 / 行业问答）全部建在本仓库的**规范化报价库**之上。

- **产品 MRD/PRD（研发基准）：[`docs/mrd-prd.md`](docs/mrd-prd.md)** —— 已批准 v1.0，来源 Paperclip DAW-27
- 本骨架是 **P0-1（DAW-28）** 的交付：技术选型决策记录 + 数据模型定稿 + 可本地起服务的仓库骨架
- 数据模型全文：[`docs/data-model.md`](docs/data-model.md)
- 技术选型决策记录（ADR）：[`docs/adr/`](docs/adr/)
- 口径字典与公开来源调研：[`docs/DAW-29-calibration-dictionary-v1.md`](docs/DAW-29-calibration-dictionary-v1.md)
- 合规门禁（备案材料已按 MRD/PRD §14 暂缓，仅保留采集 robots/ToS 速查）：[`docs/compliance/`](docs/compliance/)

## 架构一图

```
                    ┌────────────────────────────────────────────────┐
                    │              PostgreSQL（唯一数据库）            │
                    │  口径字典 · 地域 · 来源注册 · 原始存档(登记)       │
                    │  报价观测(不可变值) · 校验留痕 · 定档报价 · 加工指标  │
                    │  管线台账 · Agent 调用留痕 · 异常队列 · 口径决策     │
                    └───────────▲────────────────────────▲───────────┘
                                │                        │
  packages/pipeline（P0-3）      │                        │      apps/web（P0-4 简报页）
  采集→抽取→规范化→Agent校验→聚合 ─┘                        └── 读 daily_quote /
  原始内容 → 内容寻址存档(本地FS→S3)                             derived_indicator 渲染
  调度：pg-boss（同库）                                          每个数字可点回原文
```

## 仓库结构

```
apps/
  web/                 # Next.js 站点骨架（P0-1：数据底座状态页；P0-4：简报页落此处）
packages/
  db/                  # 核心：drizzle schema（21 表）+ 迁移 + 种子 + 集成测试
  core/                # 跨端契约：溯源响应、管线 step 契约、计价单位换算
  pipeline/            # 管线地基（台账 helper + P0-3 约定）；采集与校验在 P0-3 落地
docs/
  mrd-prd.md           # 产品 MRD/PRD（研发基准，已批准 v1.0）
  data-model.md        # 数据模型定稿（交付物 2–6 的字段级定义 + 溯源/回放设计）
  adr/                 # 技术选型决策记录（0001–0008）
```

## 本地起服务（最短路径）

前置：Node ≥ 20.9、pnpm ≥ 12、Docker。

```bash
docker compose up -d postgres     # 1. 起 Postgres 16
pnpm install                      # 2. 安装依赖
pnpm db:migrate                   # 3. 应用迁移（packages/db/migrations）
pnpm db:seed                      # 4. 种子口径字典草案（5 品类 + 地域骨架 + 元/吨）
pnpm dev                          # 5. http://localhost:3000 —— 数据底座状态页
pnpm test                         # 验收测试（含「同一品类同城不同价」集成证明，需本地 Postgres）
```

验证到什么程度算好：`pnpm test` 全绿（含 7 组集成测试：同城不同价表达、WORM、
观测值不可变、validated 完整性、地域层级守卫、加工指标恒为聚合、映射 scope），
状态页显示各表计数。

## 核心设计一句话（红线）

1. **原始抓取内容不可变**（内容寻址存档 + DB 触发器硬禁 UPDATE/DELETE）。
2. **观测值不可变**：修正=新观测+supersede 链，只有校验状态可以流转。
3. **数字来自库，不来自 LLM**：Agent 只产判断与叙事，任何进入报价表的数字必须来自 raw_fetch 抽取链。
4. **「全国均价」物理上只能是加工指标**（derived_indicator.is_aggregate 恒 1，UI 必须标注）。
5. **每一步留痕**：管线 run/step 台账 + validation_result + agent_invocation，可按版本回放。
6. **人只出现在异常队列与口径决策点**（exception_queue + caliber_decision 是这两个点的物理形态）。

## 测试与迁移规范（Dawan 研发规范在数据层的落点）

- schema 变更只改 `packages/db/src/schema/**`，随后 `pnpm db:generate` 生成迁移并提交；
  迁移文件入库、禁止手改已合并的迁移。
- 字典行（品类/规格/地域/映射/扣减规则）默认 `draft`，人工裁决后 `active`，裁决落 `caliber_decision`。
- 关键功能必须带测试：schema 不变量测试在 `packages/db/tests`，新表必须补对应守卫测试。
