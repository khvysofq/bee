# bee 数据库架构 v4（9 表，品类为轴）

状态：定稿 ｜ 日期：2026-10-28 ｜ 维护人：CTO
代码即事实源：`packages/db/src/schema-v4/` ｜ 迁移：`packages/db/migrations-v4/`
被取代文档：`docs/data-model.md`（P0-1 的 25 表模型，仅作历史参考）

本文是后续所有数据库相关任务的**唯一事实源**。凡是本文与代码不一致，以本文的语义为准并修正代码；凡是本文未覆盖的新增需求，先改本文再改代码。

---

## 1. 与旧 25 表模型的关系

旧模型（`docs/data-model.md`，7 层 25 表）为「高可信、可回放」设计：观测层保留每一次抓取的原始读数，定档层负责聚合与发布，运行层记录每个管线步骤。它在 P0 阶段验证了口径与来源，但把大量复杂度放在了**还没有读者**的地方。

v4 的取舍：

- 保留旧模型的核心结论：品类/规格/地域/来源必须字典化；价格必须带口径（单位、币种、价类型、时间）；抓取必须有台账。
- 删除旧模型的中间层：不再区分「观测」与「定档」，不再维护版本链、校验留痕、聚合指标表、期货序列表、映射表、管线步骤表。
- 从 25 张表收敛到 9 张，以**品类**为轴：一个品类一行配置，价格一行一个数字，文档一行一份内容，采集一行一个任务。

切换状态（2026-10-28）：已完成。`bee_v4` 已验证后改名为 `bee`，旧库已备份到 `/srv/data/backup/bee-pre-v4-20261028T0243Z.dump` 并删除；线上站点已切到 v4 数据层，`bee-worker` / `bee-scheduler` 已停用，等采集管线按 v4 重新设计。

---

## 2. 第一性原理

系统真正消费的只有三类东西：

1. **价格数字** —— 某品类、某规格、某地域、某日、某价类型的一个值（或区间）。
2. **文档** —— 新闻原料、每日新闻聚合、行业分析、预测；正文是 Markdown，存 OSS，库里只存指针与元数据。
3. **采集任务台账** —— 哪个来源、什么任务、什么时候跑、跑成什么样。

其余都是机器：品类/规格/地域是配置，来源是配置，任务与运行记录是台账，管理操作留审计。**不为还没有读者的「可回放性」预建中间层。**

由此得到 9 张表：

| 分组 | 表 | 作用 |
|---|---|---|
| 数字 | `price_daily` | 每日价格 |
| 文档 | `content` | 四种 kind 共表 |
| 配置 | `category` / `spec` / `region` | 品类、规格、地域 |
| 采集 | `source` / `job` / `job_run` | 来源、任务、运行记录 |
| 审计 | `admin_audit` | 管理操作留痕 |

---

## 3. 表定义

约定：

- 主键统一 `uuid`，默认 `gen_random_uuid()`。
- 时间统一 `timestamptz`；只有「业务日期」用 `date`。
- 金额/价格用 `numeric(14,2)`；单位与币种是**文本列**，不建单位表。
- 所有 `status` 用 `text + CHECK`，不用 PostgreSQL enum：加状态只改约束，不锁表、不写迁移脚本改类型。
- 下面「代码名」可直接对照 `packages/db/src/schema-v4/*.ts`。

### 3.1 `category`（品类）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK, default gen_random_uuid() |
| code | text | NOT NULL, UNIQUE |
| name_cn | text | NOT NULL |
| name_en | text | |
| description | text | |
| status | text | NOT NULL DEFAULT 'active'，CHECK IN (draft, active, archived) |
| sort_order | int | NOT NULL DEFAULT 0 |
| config | jsonb | NOT NULL DEFAULT '{}' |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

状态机：`draft → active → archived`。`archived` 不删除行，历史价格与文档仍可解析品类。

### 3.2 `spec`（规格）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| category_id | uuid | NOT NULL, FK → category(id) ON DELETE CASCADE |
| code | text | NOT NULL |
| name | text | NOT NULL |
| aliases | text[] | NOT NULL DEFAULT '{}' |
| tier | int | |
| status | text | NOT NULL DEFAULT 'active'，CHECK IN (active, retired) |

约束：`UNIQUE(category_id, code)`。状态机：`active → retired`；退役不删行，老价格继续引用。

### 3.3 `region`（地域）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| code | text | NOT NULL, UNIQUE |
| name | text | NOT NULL |
| level | text | NOT NULL，CHECK IN (global, country, province, city, market) |
| parent_id | uuid | FK → region(id) |
| aliases | text[] | NOT NULL DEFAULT '{}' |
| sort_order | int | NOT NULL DEFAULT 0 |
| status | text | NOT NULL DEFAULT 'active' |

索引：`(parent_id)`、`(level)`。

### 3.4 `price_daily`（每日价格）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| category_id | uuid | NOT NULL, FK → category(id) |
| spec_id | uuid | FK → spec(id)，可空 = 品类级口径 |
| region_id | uuid | NOT NULL, FK → region(id) |
| price_date | date | NOT NULL |
| price_type | text | NOT NULL DEFAULT 'market'，CHECK IN (market, purchase, sale, ex_works, indicative) |
| value_low | numeric(14,2) | |
| value_high | numeric(14,2) | |
| value_mid | numeric(14,2) | NOT NULL |
| unit | text | NOT NULL DEFAULT '元/吨' |
| currency | text | NOT NULL DEFAULT 'CNY' |
| source_id | uuid | FK → source(id) |
| raw_url | text | |
| captured_at | timestamptz | |
| status | text | NOT NULL DEFAULT 'published'，CHECK IN (draft, published, retracted) |
| note | text | |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

约束：

- 唯一键 `(category_id, spec_id, region_id, price_date, price_type)`，**NULLS NOT DISTINCT**（`spec_id` 为空时同一天只能有一条品类级价格）。
- CHECK：`value_low/value_high` 非空时，`value_low <= value_mid <= value_high`。
- 索引：`(category_id, region_id, price_date DESC)`、`(category_id, price_date DESC)`、`(spec_id)`。

状态机：`draft → published → retracted`。撤回是状态变化，不删行；重新采集同日同键会走 upsert 覆盖或生成新状态，由采集器决定。

### 3.5 `content`（文档）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| category_id | uuid | NOT NULL, FK → category(id) |
| region_id | uuid | FK → region(id) |
| kind | text | NOT NULL，CHECK IN (news_item, news_digest, analysis, forecast) |
| title | text | NOT NULL |
| summary | text | |
| body_md_key | text | OSS 对象键 |
| body_sha256 | char(64) | 正文哈希 |
| assets | jsonb | NOT NULL DEFAULT '[]'，引用的 asset id 列表 |
| meta | jsonb | NOT NULL DEFAULT '{}'，kind 专属结构化字段 |
| content_date | date | NOT NULL，内容归属日 |
| period_start | date | forecast 必填 |
| period_end | date | forecast 必填 |
| source_id | uuid | FK → source(id) |
| url | text | 原文链接（news_item 必填，其余可空） |
| url_hash | char(64) | 规范化 URL 的 SHA-256 |
| license | text | NOT NULL DEFAULT 'internal_only'，CHECK IN (none, internal_only, attribution, licensed) |
| visibility | text | NOT NULL DEFAULT 'internal'，CHECK IN (internal, public) |
| status | text | NOT NULL DEFAULT 'draft'，CHECK IN (draft, published, hidden) |
| published_at | timestamptz | |
| run_id | uuid | 生成它的 job_run（不设 FK，运行记录可独立归档） |
| created_by | text | |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

CHECK：

- `kind = 'forecast'` 时 `period_start`、`period_end` 必填，且 `period_end >= period_start`。

部分唯一索引：

| 索引 | 条件 | 说明 |
|---|---|---|
| `(source_id, url_hash)` | `kind='news_item' AND url_hash IS NOT NULL` | 新闻原料去重 |
| `(category_id, region_id, content_date)` | `kind='news_digest'`，NULLS NOT DISTINCT | 每品类每地域每日一份聚合 |
| `(category_id, region_id, content_date)` | `kind='analysis'`，NULLS NOT DISTINCT | 每品类每地域每日一份分析 |
| `(category_id, region_id, content_date, period_start, period_end)` | `kind='forecast'`，NULLS NOT DISTINCT | 同一预测区间唯一 |

> 实现注记：drizzle-orm 的 `uniqueIndex` 不支持 `NULLS NOT DISTINCT`，baseline 迁移中对三个 NULLS NOT DISTINCT 部分唯一索引做了手工补写；后续 `drizzle-kit generate` 以快照为准，不会删除该属性。

普通索引：`(kind, category_id, content_date DESC)`、`(category_id, region_id, kind, content_date DESC)`、`(status, published_at DESC)`。

状态机：`draft → published → hidden`。`hidden` 用于撤回或合规下架；不物理删除。

### 3.6 `source`（来源）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| code | text | NOT NULL, UNIQUE |
| name | text | NOT NULL |
| type | text | NOT NULL，CHECK IN (price, news, analysis, mixed) |
| base_url | text | |
| robots_status | text | NOT NULL DEFAULT 'unknown'，CHECK IN (allowed, disallowed, unknown) |
| redistribution | text | NOT NULL DEFAULT 'none'，CHECK IN (none, internal_only, attribution, licensed) |
| rate_limit_seconds | int | NOT NULL DEFAULT 60 |
| enabled | boolean | NOT NULL DEFAULT true |
| notes | text | |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

`redistribution` 决定该来源产出的内容能否对 public 展示；`unknown` 的 robots 视为受限，采集器不得抓取。

### 3.7 `job`（采集任务）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| code | text | NOT NULL, UNIQUE |
| category_id | uuid | FK → category(id) |
| source_id | uuid | FK → source(id) |
| kind | text | NOT NULL，CHECK IN (fetch_price, fetch_news, digest, analysis, forecast) |
| schedule | jsonb | NOT NULL DEFAULT '{}' |
| config | jsonb | NOT NULL DEFAULT '{}' |
| enabled | boolean | NOT NULL DEFAULT true |
| last_run_at | timestamptz | |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

### 3.8 `job_run`（运行记录）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| job_id | uuid | NOT NULL, FK → job(id) |
| scheduled_for | timestamptz | |
| started_at | timestamptz | |
| finished_at | timestamptz | |
| status | text | NOT NULL DEFAULT 'queued'，CHECK IN (queued, running, succeeded, failed, skipped) |
| attempt | int | NOT NULL DEFAULT 1 |
| error | text | |
| stats | jsonb | NOT NULL DEFAULT '{}' |
| created_at | timestamptz | NOT NULL DEFAULT now() |

约束：部分唯一 `(job_id, scheduled_for) WHERE scheduled_for IS NOT NULL`（同一计划时刻只跑一次；手工触发可为空）。
索引：`(job_id, started_at DESC)`、`(status)`。
状态机：`queued → running → succeeded | failed | skipped`。

### 3.9 `admin_audit`（管理审计）

| 字段 | 类型 | 约束 |
|---|---|---|
| id | uuid | PK |
| actor | text | NOT NULL |
| action | text | NOT NULL |
| subject_type | text | NOT NULL |
| subject_id | uuid | |
| before | jsonb | |
| after | jsonb | |
| created_at | timestamptz | NOT NULL DEFAULT now() |

只追加，不更新、不删除。`action` 例：`category.update`、`content.publish`、`price.retract`。

---

## 4. 四种 `content.kind`

| kind | 语义 | 可见性 | 频率 | 唯一键 | 正文 |
|---|---|---|---|---|---|
| `news_item` | 单条新闻原料 | 默认 `internal` | 随采集 | `(source_id, url_hash)` | 原文摘录/清洗后的 MD |
| `news_digest` | 每日「该品类新闻聚合报告」 | `public` | 日更 | `(category_id, region_id, content_date)` | 聚合报告 MD |
| `analysis` | 每日行业趋势分析 | `public`（可按 license 降级） | 日更 | `(category_id, region_id, content_date)` | 分析报告 MD |
| `forecast` | 预测未来一段时间价格趋势 | `public` | 周更/低频 | `(category_id, region_id, content_date, period_start, period_end)` | 预测报告 MD |

补充：

- `news_item` 是内部原料，不直接对外；`news_digest` 由当日/近日的 `news_item` 生成，`meta` 中记录 `source_item_ids`。
- `forecast` 的 `period_start/period_end` 指向**未来**区间；方向、置信度、推翻条件放 `meta`，例如：
  ```json
  {
    "direction": "up|down|flat",
    "confidence": "high|medium|low",
    "invalidation": "若钢厂到货量连续 3 日回升则推翻",
    "method": "基于近 30 日到厂价与库存的季节性外推"
  }
  ```
- 一个 `forecast` 的 `content_date` 是**发布时间归属日**，预测区间由 `period_start/period_end` 表达，二者不可混用。
- `license` 与 `redistribution` 共同决定发布：来源 `redistribution='none'` 的内容只能 `internal`。

---

## 5. 地域模型

四级自引用：`global → country → province → city`（另有 `market` 用于最具体的交易市场）。

- `parent_id` 自引用；`level` 显式声明，避免靠深度推断。
- `aliases` 存来源原文别名（如「鲁」「齐鲁」「山东临沂」）。
- 种子：`WORLD`（global）→ `CN`（country）→ 31 个省级行政区（province，GB/T 2260 两位码）。
- 地市级按需添加；`market` 用于来源只发布市场级价格的情况。
- 价格可以挂在任意层级：来源直发的全球价、全国价、省价都直接落 `price_daily`，**不做聚合表**。前端需要「全国均价」时由查询层按需计算，并明确标注为加工值。

---

## 6. 价格口径

唯一键：`(category_id, spec_id, region_id, price_date, price_type)`（NULLS NOT DISTINCT）。

- `spec_id` 为空 = 品类级价格；有值 = 具体规格价格。
- `price_type` 区分市场价 / 采购价 / 销售价 / 出厂价 / 参考价；同日同城不同价类型是不同行。
- `value_low/high/mid`：单点价格时三者相等；区间价格时 `low <= mid <= high`。
- `unit`、`currency` 是文本列，不建单位表。常见值：`元/吨`、`元/公斤`、`USD/吨`。
- 来源直发的各级价格直接落行，不做 rollup；如需聚合值，由 API 查询层计算并在 `meta` 中标注口径。
- 抓取溯源只保留轻量字段：`source_id`、`raw_url`、`captured_at`。完整原文归档在 OSS `raw/`。

---

## 7. OSS 布局（Garage 私有桶）

```
content/news_item/{category_code}/{yyyy}/{mm}/{dd}/{id}.md
content/news_digest/{category_code}/{yyyy}/{mm}/{dd}/{id}.md
content/analysis/{category_code}/{yyyy}/{id}.md
content/forecast/{category_code}/{yyyy}/{id}.md
assets/{sha256[:2]}/{sha256}.{ext}
raw/{source_code}/{yyyy}/{mm}/{dd}/{sha}.html.gz
```

- MD 文件使用 YAML frontmatter：`id`、`kind`、`category`、`region`、`content_date`、`period_start`、`period_end`、`source`、`url`、`assets`、`license`。
- 正文图片引用 `asset://<asset_id>`；渲染时由服务端换成签名 URL。
- `assets/` 内容寻址：同一文件只存一份，扩展名由 MIME 决定。
- `raw/` 保存原始 HTML（gzip），用于合规追溯与重新解析；不进入数据库。
- 桶保持私有，所有对外访问通过 API 签发短时 URL。

---

## 8. 对外 API 草案

统一响应：`{ "data": ..., "meta": { ... } }`。错误：`{ "error": { "code": "...", "message": "..." } }`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/categories` | 品类列表 |
| GET | `/api/v1/categories/{code}/prices` | 价格查询；参数 `spec`、`region`、`from`、`to`、`price_type` |
| GET | `/api/v1/categories/{code}/contents?kind=` | 文档列表；参数 `kind`、`region`、`from`、`to`、`page` |
| GET | `/api/v1/contents/{id}` | 单篇文档（含正文渲染） |
| GET | `/api/v1/assets/{id}` | 资源（签名 URL 或重定向） |
| GET | `/internal/api/categories` | 内部：品类管理 |
| GET | `/internal/api/sources` | 内部：来源管理 |
| GET | `/internal/api/jobs` | 内部：任务与运行记录 |
| POST | `/internal/api/contents/{id}/review` | 内部：审核/发布 |

价格响应必带：`unit`、`currency`、`price_type`、`as_of`（对应 `price_date`）。区间价格返回 `low/high/mid`，单点价格三者相同。

---

## 9. 扩展规则

- **新增品类**：向 `category` 插一行 + 必要的 `spec` 行；不建表、不分区、不改 schema。
- **新增内容类型**：优先新增 `content.kind`（改 CHECK + 文档 + 渲染分支）；只有当新类型有大量专属字段、独立生命周期或独立权限时，才新建表。
- **新增来源**：插 `source` 一行；抓取器按 `code` 读取配置。
- **新增任务**：插 `job` 一行；`schedule` 与 `config` 用 JSON，不为每种任务建表。
- **何时加回观测层/版本链**：当出现以下任一情况时，才引入 `observation` 与修订链：
  1. 同一价格需要保留多个来源的原始读数并做可回放聚合；
  2. 监管/客户要求证明「某日发布值当时由哪些原文算出」；
  3. 价格修正需要保留旧值并可审计对比。
- **何时加回聚合指标表**：当聚合查询成为性能瓶颈（P95 > 500ms 或日查询量 > 10 万），才落物化表；在此之前查询层现算。

---

## 10. 砍掉了什么

| 旧模型 | v4 处理 | 加回条件 |
|---|---|---|
| `price_observation` / `validation_result` 观测层与校验留痕 | 删除；价格直接落 `price_daily`，保留 `source_id/raw_url/captured_at` | 需要多源可回放、监管审计或修正对比时 |
| `raw_fetch` / `raw_content` 存档表 | 移到 OSS `raw/` | 需要库内检索原文时再加元数据表 |
| `daily_quote` 定档层 | 合并进 `price_daily` | 需要复杂多源定档规则时 |
| `derived_indicator` / `indicator_contribution` 聚合指标 | 删除；查询层现算 | 聚合成为性能瓶颈或需要固化口径快照时 |
| `market_series` / `series_point` 期货/指数/库存/宏观序列 | 删除；v1 不做期货 | 真正接入期货/指数数据时按新表设计 |
| `term_mapping` / `region_mapping` 映射表 | 删除；用 `spec.aliases` / `region.aliases` | 别名规则复杂到需要独立审核流时 |
| `unit` / `unit_conversion` 单位表 | 删除；`unit`/`currency` 文本列 | 需要跨单位换算时 |
| `pipeline_run` / `pipeline_step` / `agent_invocation` 管线步骤表 | 收敛为 `job` / `job_run` | 需要步骤级重试与回放时 |
| `exception_queue` 异常队列 | 删除；失败落 `job_run.error`，人工处理走内部 API | 异常需要分派、SLA、状态机时 |
| `source_coverage` / `source_event` | 删除；来源配置在 `source.notes/config`，运行在 `job_run` | 需要来源质量评分与事件流时 |
| `caliber_decision` 口径裁决表 | 删除；口径变更走 `admin_audit` | 口径需要多人审批流时 |
| `impurity_rule` 杂质规则表 | 删除；放 `spec.aliases` 或 `category.config` | 杂质扣减成为独立计算模块时 |

原则：**先有读者，再有表。** 没有查询方、没有合规要求、没有性能压力的中间层，一律不加。

---

## 11. 种子数据与本步验收

### 种子

- 品类（3）：`1110105 废钢铁`、`1110201 废铜`、`1110202 废铝`，`status=active`，`sort_order=1/2/3`。
- 地域（33）：`WORLD`（global）、`CN`（country，parent=WORLD）、31 个省级行政区（province，parent=CN，GB/T 2260 两位码：11 北京、12 天津、13 河北、14 山西、15 内蒙古、21 辽宁、22 吉林、23 黑龙江、31 上海、32 江苏、33 浙江、34 安徽、35 福建、36 江西、37 山东、41 河南、42 湖北、43 湖南、44 广东、45 广西、46 海南、50 重庆、51 四川、52 贵州、53 云南、54 西藏、61 陕西、62 甘肃、63 青海、64 宁夏、65 新疆）。
- 规格（12）：每品类 4 个。
  - 废钢铁：`heavy` 重废、`medium` 中废、`light` 轻薄料、`rebar-cut` 钢筋切粒。
  - 废铜：`bright` 光亮铜、`motor-wire` 电机线、`yellow-brass` 黄杂铜、`brass-shred` 破碎黄铜。
  - 废铝：`raw-alum` 生铝、`cooked-alum` 熟铝、`alum-wire` 铝线、`cans` 易拉罐。
- 不种子：`source`、`job`、`job_run`、`price_daily`、`content`、`admin_audit`。

种子脚本幂等：重复执行不新增行，允许修正名称/排序等配置字段。

### 本步验收

```sql
\dt                                                   -- 9 张表
select code, name_cn from category order by code;      -- 恰好 3 行
select count(*) from region;                           -- 33
select count(*) from spec;                             -- 12
select count(*) from price_daily;                      -- 0
```

并且：

- `pnpm --filter @bee/db typecheck` 通过。
- 旧库 `bee` 已备份后替换为 v4（备份路径见 §1）；旧 schema 与旧迁移文件仍保留在仓库中作为历史参考，不再被线上使用。
- 线上站点继续使用旧 schema，第 2 步再切换。