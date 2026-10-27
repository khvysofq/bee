# bee —— 报废品行情信息平台 · 数据底座

给中国再生资源行业中小从业者（回收站、废品贸易商）的**每天可信的日频报价与行情简报**。
产品三块能力（行情简报 / 情景推演 / 行业问答）全部建在本仓库的**规范化报价库**之上。

- **产品 MRD/PRD（研发基准）：[`docs/mrd-prd.md`](docs/mrd-prd.md)** —— 已批准 v1.0，来源 Paperclip DAW-27
- **P0-1（DAW-28）**：技术选型决策记录 + 数据模型定稿 + 可本地起服务的仓库骨架
- **P0-3（GUA-15）**：fixture/CC0 数据管线端到端（采集→归档→抽取→规范化→Agent 校验→定档/指标→回放）
- **P0-5（GUA-20，v1 真实数据）**：接入国家统计局「流通领域重要生产资料市场价格」旬报，五品类原生品全国参考锚点；废料分档层继续用 fixture 占位
- **三层时序数据（2026-10-27）**：`market_series + series_point`，国际月频 / 国内天频 / 区域周频，见 [`docs/data-model.md`](docs/data-model.md) §9
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

                    ┌────────────────────────────────────────────────┐
                    │  时序层（2026-10-27）：market_series / series_point │
                    │  国际月频（FRED/世界银行）· 国内天频（交易所日行情）  │
                    │  区域周频（交割库库存/省级周报）                     │
                    └────────────────────────────────────────────────┘
```

## 仓库结构

```
apps/
  web/                 # Next.js 站点骨架（P0-1：数据底座状态页；P0-4：简报页落此处）
packages/
  db/                  # 核心：drizzle schema（23 表）+ 迁移 + 种子 + 集成测试
  core/                # 跨端契约：溯源响应、管线 step 契约、计价单位换算
  pipeline/            # P0-3 管线：fixture 适配器、内容寻址归档、抽取/规范化/校验/定档/回放
docs/
  mrd-prd.md           # 产品 MRD/PRD（研发基准，已批准 v1.0）
  data-model.md        # 数据模型定稿（交付物 2–6 的字段级定义 + 溯源/回放设计）
  adr/                 # 技术选型决策记录（0001–0008）
```

## 本地起服务（最短路径）

前置：Node ≥ 20.9、pnpm ≥ 12。数据库走共享中间件（`newapp bee` 分配），不再自带 Postgres 容器。

```bash
cp .env.example .env             # 1. 填 DATABASE_URL（唯一必填项，换库只改这行）
pnpm install                     # 2. 安装依赖
pnpm db:migrate                  # 3. 应用迁移（packages/db/migrations）
pnpm db:seed                     # 4. 种子口径字典草案（5 品类 + 地域骨架 + 元/吨）
pnpm data:stats                  # 5. 抓取最新一期统计局旬报（真实源；加 --snapshot 可离线回放）
pnpm series:exchange --from 2024-10-27 --to 2026-10-27   # 5b. 交易所日行情回填（期货，天频）
pnpm dev                         # 6. 开发：http://localhost:3000
pnpm --filter @bee/web exec next start -p 10800   # 生产预览：http://localhost:10800（或跑 scripts/serve.sh）
pnpm test                        # 验收测试（需 DATABASE_URL 指向可建库的账号）
```

**数据库配置只有一处**：`DATABASE_URL`。代码里不出现硬编码连接串，迁移数据库（换主机、换实例、换云厂商）只改这一行，另需保证该账号具备 `CREATEDB`（测试会派生 `bee_test` 库）。

迁移过来时的账号权限：`CREATE ROLE ... LOGIN PASSWORD ... CREATEDB`，并对 `postgres` 库放开 `CONNECT`（测试要借它建库）。

验证到什么程度算好：`pnpm test` 全绿（不变量集成测试 + P0-3 fixture 端到端 + P0-5 真实旬价端到端：
采集/归档/抽取/规范化/Agent 校验/异常隔离/定档/加工指标/回放/幂等/合规闸门），
简报页展示真实旬价并附「数据来源：国家统计局（流通领域重要生产资料市场价格）」与公报原文链接。

## 真实源接入点（GUA-20 预留）

- 适配器实现：`packages/pipeline/src/adapters/stats.ts` —— `fetch` 只取原文并交 WORM 归档，
  `extract` 只做 HTML 表格确定性解析；禁止 LLM 生成数字。
- 注册入口：`packages/pipeline/src/adapters/registry.ts` 的 `createSourceRegistry()`；未来付费源/第一方数据
  实现同一个 `SourceAdapter` 接口后在此登记即可，管线主干、台账、校验、聚合不需要改。
- 运行入口：`pnpm data:stats`（联网抓最新一期）；离线回放用
  `pnpm --filter @bee/pipeline stats -- --snapshot <html> --document-url <url>`。
  废料分档层继续由 `pnpm data:fixture` 占位，与真实源共用同一套接口。
- 合规红线：展示层固定署名 + 公报原文链接；数值不得修改曲解；不得再授权下游转载；明确标注
  「全国参考锚点价（原生品，非废料分档现货；区域分档暂缺）」。

## 核心设计一句话（红线）

1. **原始抓取内容不可变**（内容寻址存档 + DB 触发器硬禁 UPDATE/DELETE）。
2. **观测值不可变**：修正=新观测+supersede 链，只有校验状态可以流转。
3. **数字来自库，不来自 LLM**：Agent 只产判断与叙事，任何进入报价表的数字必须来自 raw_fetch 抽取链。
4. **「全国均价」物理上只能是加工指标**（derived_indicator.is_aggregate 恒 1，UI 必须标注）。
5. **每一步留痕**：管线 run/step 台账 + validation_result + agent_invocation，可按版本回放。
6. **人只出现在异常队列与口径决策点**（exception_queue + caliber_decision 是这两个点的物理形态）。
7. **期货不是现货**：期货结算价（预期价）走 `market_series + series_point`，现货/统计报价走
   `price_observation`；两者永不进同一个「全国均价」。层级（国际/国内/区域）↔ 地域层级由触发器绑定。

## 测试与迁移规范（Dawan 研发规范在数据层的落点）

- schema 变更只改 `packages/db/src/schema/**`，随后 `pnpm db:generate` 生成迁移并提交；
  迁移文件入库、禁止手改已合并的迁移。
- 字典行（品类/规格/地域/映射/扣减规则）默认 `draft`，人工裁决后 `active`，裁决落 `caliber_decision`。
- 关键功能必须带测试：schema 不变量测试在 `packages/db/tests`，新表必须补对应守卫测试。

> 生产常驻：已注册 systemd 服务 `bee-web`（端口 10800，崩溃自动重启）。
> `systemctl status bee-web` / `systemctl restart bee-web` / `journalctl -u bee-web -f`。
