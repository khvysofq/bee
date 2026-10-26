# bee 数据底座数据模型（P0-1 定稿）

状态：定稿 ｜ 依据：DAW-28 ｜ 日期：2026-10-26 ｜ 维护人：CTO
配套：ADR 0001–0008（技术选型）｜ schema 实现：`packages/db/src/schema/`（以代码为准的单一事实源，本文是模型语义说明书）

本文回答六个问题：数据怎么分层、口径怎么管、地域怎么对齐、来源怎么管、每个简报数字怎么点回原文、口径或规则变了怎么重放。

---

## 1. 分层总览：六层二十一表

```
字典层  category, spec_grade, unit, unit_conversion,
        term_mapping, region_mapping, impurity_rule,
        region, caliber_decision          ← 人裁口径；机器用字典
来源层  source, source_coverage, source_event
存档层  raw_fetch                         ← WORM：原文 + 元数据，永不改
观测层  price_observation, validation_result
        ← 事实层：值永不改；只有校验状态/被取代指针可变
定档层  daily_quote, derived_indicator
        ← 当前态：可由观测层重算；「全国」只能在这一层出现
运行层  pipeline_run, pipeline_step, agent_invocation, exception_queue
        ← 台账：谁、何时、什么版本、什么结果
```

分层即**不可变边界**：

| 层 | 可变性 | 谁能写 | 修错的唯一方式 |
|---|---|---|---|
| 存档层 | 物理不可变（触发器禁 UPDATE/DELETE） | 抓取 step | 不可修；新抓取=新行 |
| 观测层 | 值不可变；仅 `validation_status`、`superseded_by_id` 可变（触发器强制） | normalize/validate step | 新观测 + supersede 链，绝不改旧值 |
| 定档层 | 可重算、可改状态（published→retracted） | aggregate/publish step | 重算覆盖 + 状态流转留痕 |
| 运行层 | append-only（run/step/invocation 禁改） | 管线自身 | 不修，追加新记录 |
| 字典层 | 演进式：`status` draft→active→retired，不删行 | 种子/人/映射建议 | retire 旧值 + 新值生效，历史引用不失效 |
| 来源层 | source 可改（开关/权重），source_event append-only | 人 + 运维 | source_event 留痕 |

**为什么这样切**：可信度 = 「事实（抓到的原文与当时的读数）永不被任何人改写」+「发布值永远可以重算与回放」。
把「事实」与「当前态」分成两张表（price_observation vs daily_quote），两种需求都不用妥协。

---

## 2. 交付物 2：规范化报价表（`daily_quote` + `price_observation`）

任务要求主键 = 品类×规格/等级×地域×日期；实现为：

```sql
unique (category_id, spec_id, region_id, quote_date, price_type)
```

比任务多一个 `price_type`（purchase 采购价 / sale 销售价 / ex_works 出厂价 / indicative 指导价）——
这是表达「同一品类同城不同价」的必要维度：回收站的购销价差本身就是产品要展示的核心事实。

### 2.1 price_observation —— 单一来源单条原始记录的规范化读数

每行 = 「某来源某页面上的某一行价目」，字段三组：

- **指向存档**：`fetch_id → raw_fetch`，`source_row_index`（unique(fetch_id, source_row_index) 防重复抽取）；冗余 `fetched_at` 便于查询。
- **原始侧**（as-published，永不参与计算，只做审计）：`raw_text` 原文片段、`raw_value_low/high`、`raw_unit`、`raw_category_text/raw_spec_text/raw_region_text/raw_price_type_text`（页面用语原样）。
- **规范化侧**（用于计算）：`category_id/spec_id/region_id/price_type`（映射前可空，状态 `pending_mapping`）、`norm_value_low/high`（统一 **元/吨**）、`unit_id`、`conversion_applied`（换算系数，如 ×1000 元/kg→元/吨）、`quote_date` 行情日。
- **校验与版本**：`validation_status`、`superseded_by_id`（修正链）、`extract_version/normalizer_version/run_id`。

CHECK 约束：raw/norm 值域下界 ≤ 上界；`validation_status='validated'` ⇒ 规范化字段全非空（半映射数据进不了定档层）。

### 2.2 daily_quote —— 定稿后的「该维度当日价」

每行携带完整重算配方：`method`（single_source / median_multi_source / weighted_multi_source）、
`contributing_observation_ids uuid[]`（全部贡献观测）、`source_count`、`method_version`、
`confidence`、`coverage_note`（口径脚注，如「样本仅 1 家、为经销商报价」）、`status`（draft/published/retracted/superseded）、`computation_run_id`。

「同一品类同城不同价」的表达（集成测试 A 组验证）：
- 同城同规格不同来源 → 多行 observation，聚合或并列成 quote；
- 同城**采购价 vs 销售价** → 同 quote 键下两个 `price_type`，合法共存；
- 超出唯一键（同维度同日同类型两条定档）→ 数据库 23505 直接拒绝，这是「定档」的物理含义。

### 2.3 derived_indicator —— 「全国」只能在这里出现

`kind ∈ {national_weighted_avg, national_median, region_aggregate, city_aggregate}`，
唯一键 `(kind, category_id, spec_id, region_id, price_type, basis_date)`。
`is_aggregate` 恒为 1（CHECK 强制，插 0 报错）——**「全国均价」在物理上不可能是一条观测**，
只能是明确加权口径下的派生值：`method_json` 冻结当次聚合的权重快照（用哪些城市、什么权重、当时的值），
`contributing_quote_ids` 指向贡献的 city quote。简报中出现「全国」时必须带「加工指标」标记（数据已保证，展示为 P0-4 义务）。

---

## 3. 交付物 3：口径字典（字典层 8 张表）

| 表 | 管什么 | 关键字段/约束 |
|---|---|---|
| `category` | 品类命名（废钢/废铜/废铝/废纸/废塑料） | `code` 唯一（如 `steel_scrap`）；`status` draft/active/retired |
| `spec_grade` | 规格与等级（统一 kind=spec/grade） | 唯一(category_id, code)；`quality_tier`、`is_core`、`definition`（等级的文字定义，异议时的判据） |
| `term_mapping` | 页面用语 → 标准条目 | raw 文本 → category/spec；`scope` global 或 source（CHECK 保证 scope⇔source_id 绑定）——**同名不同义按来源可各自映射**；`status` proposed/active/rejected，机器只能提 proposed |
| `unit` / `unit_conversion` | 计价单位与换算 | 唯一 canonical（元/吨）；换算表存因子（元/kg ×1000、万元/吨 ×10000）；**不在表内的单位拒绝换算**，走异常队列而不是猜 |
| `impurity_rule` | 杂质扣减规则 | `rule_kind`：weight_percent（按杂重折价）/ price_per_ton（按元/吨扣）/ grade_downgrade（降级处理）；匹配优先级 **spec > category > 全局**，同层取生效期内最新；规则只描述扣减方式，`param_json` 存参数，`condition_text` 存适用条件（人可读） |
| `region` / `region_mapping` | 地域树与页面对齐 | 见 §4 |
| `caliber_decision` | 人的口径裁决（append-only） | 任何等级划分/扣减/映射的争议，最终以这里的决策记录为准：subject、问题、裁决、裁决人、时间 |

**口径原则（红线级）**：观测值是「来源说了什么」，永远 as-published 保留；
杂质扣减、等级换算这类口径动作**只发生在校验/对比层**（validation_result.detail 里记录「按规则 X 本应差 ≤n 元」），
绝不回写修改 `norm_value_*`。要改历史口径 → 改规则 + 重放（§7），而不是改数据。

字典激活流程：种子/映射建议产生 `draft`/`proposed` 行 → 人审（异常队列 + caliber_decision）→ `active`。
机器永远不能把字典行置为 active（caliber 权在人）。

---

## 4. 交付物 4：地域对齐（三层树 + 全国虚节点）

`region` 表：`level ∈ {market, city, macro_region, country}`，自引用 `parent_id` 组树
（country → macro_region 华北/华东/… → city → market 具体市场/园区），`code` 唯一，`status` 同字典演进式。

层级守卫（数据库触发器强制，不是代码约定）：

| 表 | 允许的 level |
|---|---|
| price_observation.region_id | market 或 city |
| daily_quote.region_id | market 或 city |
| derived_indicator.region_id | country、macro_region、city |

即：**报价永远落在具体市场/城市；全国/大区只可能是派生指标**（§2.3 的物理化）。
「全国」= aggregate by construction，不是一条被标记的报价 —— 这比「加个 is_national 布尔」强：加布尔可以忘标，触发器不可绕过。

页面用语对齐：`region_mapping`（raw_region_text → region_id）同 term_mapping 逻辑，proposed→active 由人确认。

---

## 5. 交付物 5：来源注册表（`source` + `source_coverage` + `source_event`）

`source`：`code/name/type(webpage,rss,api)`、`base_url/tos_url`、**`robots_status`（allowed/disallowed/unknown + checked_at + note）——采集前置条件，disallowed 的来源抓取 step 必须拒绝**、
`trust_weight 0–100`（数值 CHECK；定档聚合的权重输入，初值保守，变更走 source_event 留痕）、
`trust_note`（为什么是这个分的一句话依据）、`crawl_frequency_per_day`、`rate_limit_seconds`、`crawl_window_json`（允许抓取的时间窗）、`fetcher_kind`（static_html/rss/json_api/browser）、`status`（active/paused/retired + reason，新来源默认 **paused**，人检查 robots/ToS 后才 active）。

`source_coverage`：来源×品类（×可选规格/地域）粒度的覆盖登记，含 `trust_weight_override`（某来源在某品类上就是更可信，如铜的期货现货商）。

`source_event`（append-only）：上下线、权重调整、robots 状态变化、ToS 争议 —— 来源可信度的**历史**也必须可审计。

ToS/robots 的处理顺序：注册（paused）→ robots 检查记录 → 人确认 ToS 无禁用 → active → 方可入采集计划（P0-3 执行）。

---

## 6. 交付物 6：留痕与可回放

### 6.1 点回：一个简报数字的完整溯源路径

契约见 `packages/core/src/trace.ts`（zod schema，web 与管线共用）。

```
简报数字（某品类规格某城市某日采购价）
 └→ daily_quote（值、方法、贡献观测）
     └→ contributing_observation_ids → price_observation ×N
         每条给出：
          · url（来自 raw_fetch）
          · fetched_at + content_sha256
          · raw_text（页面原文字段原样） + norm 值 + conversion_applied
          · 该观测全部 validation_result（谁/什么规则/什么版本/什么结论）
 └→ derived_indicator 时另有：
      · method_json（当次权重快照）
      · contributing_quote_ids（当时各城市值 value_at_aggregation）
```

任何人（包括外部质疑者）问「这个数哪来的」：给 quote_id → 接口逐层展开 → 原文 URL + 抓取时间 + 内容指纹 + 原文字符串 + 存档查看器链接（`/raw/{fetch_id}`，P0-4）。**没有一环靠记忆或口头解释。**

### 6.2 版本钉（replay 的前提）

`pipeline_run` 钉三个版本：`git_sha`（代码）、`rules_version`（校验规则）、
`dictionary_hash`（当次运行时 active 字典内容的 sha256 —— 字典内容变了，即使表结构没变，历史结论也解释不了）。

### 6.3 回放（replay）

回放 run：`kind='replay'`，`replay_of_run_id` 指回原 run。从 `raw_fetch`（不可变存档）重新走
extract → normalize → validate，**输出对照报告（新旧结果 diff），永不写生产观测/定档表**。
用于：口径争议复查、规则升级影响评估、新人理解某天为什么这么定档。

需要真修数时（发现当时真的错了）：回放确认 → 写**新观测**（corrected）→ 旧观测 `superseded_by_id` 指向新观测 → 定档层重算。
旧值永远还在，审计链完整。

### 6.4 Agent 留痕（红线 6 的落地）

每次 LLM 参与都在 `agent_invocation`（append-only）：purpose（校验判断/叙事草稿/异常分诊/映射建议）、
model、prompt_version + prompt_sha、input/output 原文、latency。
结论落 `validation_result`：`check_kind='llm_judgment'`，`performed_by_ref='llm:模型+prompt@版本'`，依据入 detail。
红线「LLM 数字不进报价表」的结构性保障：数字唯一合法入口是 observation 的 raw→norm 链，而该链必挂 raw_fetch；
管线层（P0-3）另加断言：每条进入定档的观测必须有 fetch_id。

---

## 7. 运行层台账（`pipeline_run` / `pipeline_step` / `exception_queue`）

- `pipeline_step`：每步（fetch/extract/normalize/validate/aggregate/publish/notify）入/出引用（id-only，jsonb）+ 状态 + 错误摘要。**没有台账记录的步骤 = 没发生过。**
- `exception_queue`：四类异常（validation/caliber/source/pipeline）统一入队，`priority` + `assigned_to`（agent:xxx / human:xxx）；这是**人机协作的唯一界面** —— 人只看这里和 caliber_decision，不碰日常数据。
- 管线 step 契约与硬约束见 `packages/pipeline/README.md`（P0-3 的实现约定）。

## 8. 表清单（迁移产物与本文对应）

字典：category, spec_grade, term_mapping, region_mapping, impurity_rule, unit, unit_conversion, caliber_decision, region
来源：source, source_coverage, source_event
存档：raw_fetch
观测：price_observation, validation_result
定档：daily_quote, derived_indicator
运行：pipeline_run, pipeline_step, agent_invocation, exception_queue

（共 21 张；schema 代码 `packages/db/src/schema/`，迁移 `packages/db/migrations/`，种子 `packages/db/scripts/seed.ts` 演示最小可跑的字典内容。）
