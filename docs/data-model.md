# bee 数据底座数据模型（P0-1 定稿）

状态：定稿 ｜ 依据：DAW-28（含 DAW-33 评审修复）｜ 日期：2026-10-26 ｜ 维护人：CTO
配套：ADR 0001–0008（技术选型）｜ schema 实现：`packages/db/src/schema/`（以代码为准的单一事实源，本文是模型语义说明书）

本文回答六个问题：数据怎么分层、口径怎么管、地域怎么对齐、来源怎么管、每个简报数字怎么点回原文、口径或规则变了怎么重放。

---

## 1. 分层总览：七层二十五表

```
字典层  category, spec_grade, unit, unit_conversion,
        term_mapping, region_mapping, impurity_rule,
        region, caliber_decision          ← 人裁口径；机器用字典
来源层  source, source_coverage, source_event
存档层  raw_content, raw_fetch            ← WORM：内容对象 + 抓取登记，永不改
观测层  price_observation, validation_result
        ← 事实层：值永不改；只有校验状态/被取代指针可变；修正走 revision 链
时序层  market_series, series_point        ← 期货/指数/库存/宏观；三层数据的载体（§9）
定档层  daily_quote, derived_indicator, indicator_contribution
        ← 当前态：可由观测层重算；「全国」只能在这一层出现
运行层  pipeline_run, pipeline_step, agent_invocation, exception_queue
        ← 台账：谁、何时、什么版本、什么结果
```

分层即**不可变边界**：

| 层 | 可变性 | 谁能写 | 修错的唯一方式 |
|---|---|---|---|
| 存档层 | 物理不可变（触发器禁 UPDATE/DELETE；TRUNCATE 由语句级触发器拒绝 —— 行级守卫不拦 TRUNCATE，迁移 0001 补齐） | 抓取 step | 不可修；新抓取=新行 |
| 观测层 | 值不可变；仅 `validation_status`、`superseded_by_id` 可变（触发器强制） | normalize/validate step | 新观测 + supersede 链，绝不改旧值 |
| 定档层 | 可重算、可改状态（published→retracted） | aggregate/publish step | 重算覆盖 + 状态流转留痕 |
| 运行层 | append-only（run/step/invocation 禁改） | 管线自身 | 不修，追加新记录 |
| 字典层 | 演进式：`status` draft→active→retired，不删行 | 种子/人/映射建议 | retire 旧值 + 新值生效，历史引用不失效 |
| 来源层 | source 可改（开关/权重），source_event append-only | 人 + 运维 | source_event 留痕 |
| 时序层 | 值不可变（触发器禁 UPDATE/DELETE/TRUNCATE） | series ingest step | 新 revision 行，旧值保留 |

**为什么这样切**：可信度 = 「事实（抓到的原文与当时的读数）永不被任何人改写」+「发布值永远可以重算与回放」。
把「事实」与「当前态」分成两张表（price_observation vs daily_quote），两种需求都不用妥协。

### 1.1 存档层：内容身份与抓取登记分离（raw_content / raw_fetch，DAW-33 P0-2）

- `raw_content`：**内容对象**，一行 = 内容寻址存储里的一份文件。主键就是 sha256 —— 同内容全库一行，
  `content_ref`（存储键）首次归档时确定、此后不作数（内容寻址：同 sha 同文件，见 ADR-0004 修订）。
- `raw_fetch`：**抓取事件登记**，一行 = 一次抓取（URL、时间、HTTP 状态、指向 raw_content）。
  同一内容被两次抓取 = raw_content 一行 + raw_fetch 两行 —— 登记天然允许重复，去重只发生在内容层；
  修正/重放场景因此不会被内容唯一键挡住。

写入顺序是硬约束：**先 raw_content 后 raw_fetch**（外键），管线里用 `registerRawFetch` 一步完成
（`packages/pipeline/src/ledger.ts`，返回 `contentExisted` 提示调用方是否还需要写文件）。
两表 WORM：UPDATE/DELETE/TRUNCATE 全部被触发器拒绝。

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

- **指向存档**：`fetch_id → raw_fetch`（经 raw_fetch 再到 raw_content，见 §1.1）；复合外键 (fetch_id, source_id) 与 (fetch_id, fetched_at) 保证观测声称的来源/时间与登记行一致，不能跨源嫁接；`source_row_index`（unique(fetch_id, source_row_index, **revision**) —— 同一抓取同一行的修正按 revision 递增成链，重复抽取挡在唯一键上）。
- **原始侧**（as-published，永不参与计算，只做审计）：`raw_text` 原文片段、`raw_value_low/high`、`raw_unit`、`raw_category_text/raw_spec_text/raw_region_text/raw_price_type_text`（页面用语原样）。
- **规范化侧**（用于计算）：`category_id/spec_id/region_id/price_type`（映射前可空，状态 `pending_mapping`）、`norm_value_low/high`（统一 **元/吨**）、`unit_id`、`conversion_applied`（换算系数，如 ×1000 元/kg→元/吨）、`quote_date` 行情日。
- **校验与版本**：`validation_status`、`superseded_by_id`（修正链指针）、`revision`（链内序号）、`extract_version/normalizer_version/run_id`。

CHECK 约束：raw/norm 值域下界 ≤ 上界；`validation_status='validated'` ⇒ 规范化字段全非空（半映射数据进不了定档层）。

**修正链（触发器强制，DAW-33 P0-2 + DAW-34 复审闭合）**：改值 = 新行（同 fetch 同 row_index、revision 递增）+ 旧行置 `superseded_by_id` 指向新行。
守卫规则：后继 revision 必须**严格大于**前代（物理上无环）；后继必须**同槽位**（同 fetch 同 source_row_index —— 修正是「一条原始记录的换代」，不是跨记录嫁接）且同维度（品类/规格/地域/行情日/价格类型）——跨维度不是修正，是新观测；
指针与状态绑定（置 superseded 必须同时有指针；反指/自指/同 revision 重复/指向不存在的后继全部拒绝）。
同槽位**任何时刻至多一个未 superseded 的版本**（可延迟约束触发器，提交时校验）——因此这两笔写必须在**同一事务**内完成：
拆成两次提交的「半修正」（后继已落库、前代未标）会在提交时被整体拒绝。存量库迁移（0002）对历史半修正同样显式拒绝，不静默通过。
这是修正的**唯一合法写入路径**——旧值永远还在，审计链完整。

### 2.2 daily_quote —— 定稿后的「该维度当日价」

每行携带完整重算配方：`method`（single_source / median_multi_source / weighted_multi_source）、
`contributing_observation_ids uuid[]`（全部贡献观测）、`source_count`、`method_version`、
`confidence`、`coverage_note`（口径脚注，如「样本仅 1 家、为经销商报价」）、`status`（draft/published/retracted/superseded）、`computation_run_id`。

「同一品类同城不同价」的表达（集成测试 A 组验证）：
- 同城同规格不同来源 → 多行 observation，聚合或并列成 quote；
- 同城**采购价 vs 销售价** → 同 quote 键下两个 `price_type`，合法共存；
- 超出唯一键（同维度同日同类型两条定档）→ 数据库 23505 直接拒绝，这是「定档」的物理含义。

贡献观测完整性（延迟约束触发器，提交时强制）：`contributing_observation_ids` 全部真实存在、
全部 `validated`、`count(distinct source_id) = source_count` —— 伪造贡献或虚报来源数不可能提交。

### 2.3 derived_indicator 与 indicator_contribution —— 「全国」只能在这里出现

`kind ∈ {national_weighted_avg, national_median, national_reference, region_aggregate, city_aggregate}`，
唯一键 `(kind, category_id, spec_id, region_id, price_type, basis_date)`。
`is_aggregate` 恒为 1（CHECK 强制，插 0 报错）——**「全国均价」在物理上不可能是一条观测**，
只能是明确加权口径下的派生值：`method_json` 冻结当次聚合的权重快照（用哪些城市、什么权重、当时的值）。
简报中出现「全国」时必须带「加工指标」标记（数据已保证，展示为 P0-4 义务）。

`national_reference` 专用于**来源直接发布的全国参考价**（GUA-20：国家统计局旬报），
不是本系统按城市聚合所得；其 `method_json.formula` 固定为「直接引用」，且只允许挂 `country`
地域节点，禁止与 `national_weighted_avg` 混用。

贡献明细（DAW-33 P0-4）不再是 `contributing_quote_ids` 数组，而是独立表 `indicator_contribution`
（`indicator_id, quote_id, value_at_aggregation, weight`），触发器强制四件事：

1. **维度一致**：贡献报价的品类/规格/价格类型与指标一致，`quote_date = basis_date`；
   报价层级必须**严格低于**指标层级（market < city < macro_region < country —— city 聚合只吃市场报价，
   大区聚合吃城市/市场报价，全国指标吃其下任意层），「引用同级或越级报价」在物理上写不进去。
2. **值在界内**：`value_at_aggregation` 必须落在该报价 `[value_low, value_high]` 区间。
3. **写定冻结**：明细禁 UPDATE；重算 = **同一事务内删旧插新**（延迟非空约束两端强制 ——
   空贡献的指标、无指标归属的明细都提交不了，因此重算不存在中间空窗）。
4. **指标维度冻结**：指标定档后除值/方法/计算 run 外不可改、不可删 —— 口径变了走重算或新指标，
   不走改维度。

补一条量纲：`(indicator_id, quote_id)` 唯一 —— 同一报价对同一指标只贡献一次。

---

## 3. 交付物 3：口径字典（字典层 9 张表）

| 表 | 管什么 | 关键字段/约束 |
|---|---|---|
| `category` | 品类命名（废钢/废铜/废铝/废纸/废塑料） | `code` 唯一（如 `steel_scrap`）；`status` draft/active/retired |
| `spec_grade` | 规格与等级（统一 kind=spec/grade） | 唯一(category_id, code)；`quality_tier`、`is_core`、`definition`（等级的文字定义，异议时的判据） |
| `term_mapping` | 页面用语 → 标准条目 | raw 文本 → category/spec；`scope` global 或 source（CHECK 保证 scope⇔source_id 绑定）——**同名不同义按来源可各自映射**；`status` proposed/active/rejected，机器只能提 proposed；同一 (scope, 来源, raw 文本) 同时只允许一条 **active**（部分唯一表达式索引强制，DAW-33 P1-6）—— 映射确定性是物理保证，不靠约定；查找规则 **source 级 active 优先于 global** |
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
| derived_indicator 的 kind↔level 绑定 | national_* → country；region_aggregate → macro_region；city_aggregate → city（触发器强制 —— kind 的语义就是它挂的层级，「全国指标挂城市」写不进去） |

即：**报价永远落在具体市场/城市；全国/大区只可能是派生指标**（§2.3 的物理化）。
「全国」= aggregate by construction，不是一条被标记的报价 —— 这比「加个 is_national 布尔」强：加布尔可以忘标，触发器不可绕过。

树结构纪律（触发器强制，DAW-33 P0-3）：
- **阶梯**：parent 必须恰是下一级（market→city→macro_region→country），跨级、反向、自环全部拒绝；
- **单根**：全库最多一行 `level='country'`（部分唯一索引）——「全国」有且只有一个。
  迁移链上的多根闸门分两层（释放口径，DAW-35 R3）：0000 存量库若已有多个 country，
  在 **0001** 建 `region_single_country_uq` 时即被拒（操作层闸门）；0002 的
  `country_count > 1` 存量校验因此正常链不可达，是对绕过 0001 直接上 0002 的库
  （如手工修补过迁移历史的库）的纵深防御 —— 两层都 fail-loud，只是拦截面不同；
- **被引用冻结**：已被观测/定档/指标/映射/覆盖或子节点引用的 region，`level` 与 `parent_id` 不可改、不可删 ——
  地域树重组是口径决策（caliber_decision + 重算），不是一条 UPDATE。

页面用语对齐：`region_mapping`（raw_region_text → region_id）同 term_mapping 逻辑，proposed→active 由人确认；
同一 (scope, 来源, raw 文本) 仅一条 active（部分唯一表达式索引），source 级 active 优先于 global。

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
          · fetched_at + content_sha256（经 raw_fetch 指向 raw_content）
          · raw_text（页面原文字段原样） + norm 值 + conversion_applied
          · 该观测全部 validation_result（谁/什么规则/什么版本/什么结论）
 └→ derived_indicator 时另有：
      · method_json（当次权重快照）
      · indicator_contribution 逐条贡献（quote_id + value_at_aggregation + weight，
        每条再各自点回报价 → 观测 → 原文）
```

任何人（包括外部质疑者）问「这个数哪来的」：给 quote_id → 接口逐层展开 → 原文 URL + 抓取时间 + 内容指纹 + 原文字符串 + 存档查看器链接（`/raw/{fetch_id}`，P0-4）。**没有一环靠记忆或口头解释。**

契约转换层（DAW-33 P1）：pg 的 numeric 到 node 侧是 string、timestamp 是 Date、标志位是 0/1，
而 trace 契约（zod）要 number / ISO 字符串 / boolean。`packages/core/src/trace.ts` 的
`numericToNumber / flagToBoolean / timestampToIso` 是**全库唯一**的转换通道，单元测试双向锁定
（DB 行直塞 schema 必须失败、过转换层必须通过）—— 精度纪律（禁止隐式 Number()）与渲染需要的 number 形态在这里显式和解。

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

### 6.5 归属一致性（复合外键，DAW-33 P1-5）

「A 引用 B 的同时声称属于 C」式的归属伪造，在 schema 层由复合外键拒绝（断链即 23503）：

- `price_observation (fetch_id, source_id)` → raw_fetch、`(fetch_id, fetched_at)` → raw_fetch —— 观测不能跨源/跨时间嫁接登记；
- `(category_id, spec_id)` → spec_grade —— price_observation / daily_quote / derived_indicator / term_mapping / impurity_rule / source_coverage 各自的规格必须真属于其品类；
- `agent_invocation (run_id, step_id)` → pipeline_step —— 调用留痕不能跨 run 嫁接到别人的 step；
- `region_mapping / source_coverage` 的 region 引用真实 region 行（不再只是自由文本）。

支撑这些复合外键的 UNIQUE 约束在迁移 0001 里**先于 FK 创建**（drizzle-kit 生成的段序不保证这一点）。

---

## 7. 运行层台账（`pipeline_run` / `pipeline_step` / `exception_queue`）

- `pipeline_run`：三版本钉（§6.2）+ 台账纪律（触发器强制，DAW-33 P1-7）——
  状态机 `pending→running→succeeded|failed|partial`、终态冻结（不可再改、不可重复 finish）、
  append-only（禁 DELETE/TRUNCATE）、`idempotency_key` 部分唯一（pg-boss at-least-once 重投复用既有 run，不重复建）。
- `pipeline_step`：每步（fetch/extract/normalize/validate/aggregate/publish/notify）入/出引用（id-only，jsonb）+ 状态 + 错误摘要。**没有台账记录的步骤 = 没发生过。**
  同样状态机 + 终态冻结 + append-only；`(run_id, seq)` 唯一防同 run 重复建步；`step_version` 落库
  （@bee/core step 契约的 version —— 回放依据从 run 级三 pin 细化到 step 级）。
- `exception_queue`：四类异常（validation/caliber/source/pipeline）统一入队，`priority` + `assigned_to`（agent:xxx / human:xxx）；这是**人机协作的唯一界面** —— 人只看这里和 caliber_decision，不碰日常数据。
- 代码层配套（`packages/pipeline/src/ledger.ts`）：startRun/startStep 幂等复用（同键/同 seq 返回 `reused`）、
  守护式 finishRun/finishStep（双重 finish / pending 越级 → 带 code 的 LedgerError，不穿透触发器）、
  `withStep`（开步登记 → 业务原子写 → 结果留痕的三段提交，失败业务回滚但失败留痕不被吞）、
  `registerRawFetch`（内容先行登记，同内容首见 content_ref 作数）。
- 管线 step 契约与硬约束见 `packages/pipeline/README.md`（P0-3 的实现约定）。

## 8. 表清单（迁移产物与本文对应）

字典：category, spec_grade, term_mapping, region_mapping, impurity_rule, unit, unit_conversion, caliber_decision, region
来源：source, source_coverage, source_event
存档：raw_content, raw_fetch
观测：price_observation, validation_result
定档：daily_quote, derived_indicator, indicator_contribution
运行：pipeline_run, pipeline_step, agent_invocation, exception_queue

时序：market_series, series_point

（共 25 张；schema 代码 `packages/db/src/schema/`，迁移 `packages/db/migrations/`（0000 生成 + 0001 评审修复
+ 0002 DAW-34 复审修复 + 0003 全国参考价 + 0004 时序层，不回写历史迁移），
种子 `packages/db/scripts/seed.ts` 演示最小可跑的字典内容。）

---

## 9. 时序层（market_series / series_point）：三层数据的载体

**为什么单开一层，而不是塞进 `price_observation`。**

`price_observation` 的语义是「来源页面上的**一行价目**」：有 `raw_text`、有区间、有单位换算、要落规格字典。
期货合约是「一个标的在某交易日的**一个结算价**」：没有区间，也不该进规格字典
（rb2601/rb2605 是合约，不是规格；逐合约建 `spec_grade` 会让字典随换月无限膨胀）。

更要紧的是**口径**：期货是预期价，现货是成交价。混在一张表里，「全国均价」的聚合迟早把两者算到一起——
那是产品可信度上的自杀。所以纪律是硬的：

> 现货与统计报价走 `price_observation`；期货/指数/库存/宏观走 `market_series + series_point`。
> 两条链共用同一套不可变存档（`raw_fetch`）与台账（`pipeline_run`），溯源能力一致。

### 9.1 三层

| layer | 含义 | 典型序列 | 地域 |
|---|---|---|---|
| `international` | 国际基准 | FRED 铜/铝/镍/铁矿、世界银行 Pink Sheet、worldsteel 粗钢产量 | **不得挂 region**（CHECK + 触发器） |
| `national` | 国内全国 | 上期所/上期能源/郑商所日行情、全国口径指数 | 可空；挂则只能 `country` |
| `regional` | 区域 | 交割仓库库存、省级生产资料周报 | **必须挂** city / market / macro_region |

层级 ↔ 地域由触发器 `bee_guard_series_region` 强制：把「全国」塞进区域序列、或给国际基准挂一个上海节点，
都写不进去。这是 §4「全国只可能是聚合」的同一套物理化思路在时序层的复刻。

### 9.2 表

- `market_series`：序列定义。`code`（如 `shfe.rb2701`）、`layer`、`kind`（futures/index/inventory/macro）、
  `frequency`、`source_id`、`category_id`、`region_id`、`instrument_code`（rb）、`venue`（SHFE/FRED）、
  `unit_id`、`currency`、`display_allowed`、`status`。
- `series_point`：数据点。`(series_id, obs_date, revision)` 唯一；`value` 为主值（期货=结算价），
  OHLC/成交量/持仓量各自成列；`fetch_id` 指向本次抓取的原始响应，`source_row_index` 定位行号。

### 9.3 不变量（DB 层强制）

1. **值不可变**：`series_point` 禁 UPDATE / DELETE / TRUNCATE。修正 = 同序列同日期 `revision+1` 的新行，
   旧值永远可查（`bee_series_point_guard`）。
2. **幂等采集**：`(series_id, obs_date, revision)` 唯一 + `ON CONFLICT DO NOTHING`——
   同一交易日重跑不会产生第二行。这是「两年回填可随时中断重跑」的基础。
3. **归属一致**：`(series_id, source_id)` 复合外键指向 `market_series`，`(fetch_id, source_id)` 指向 `raw_fetch`——
   时序点不能声称属于别的来源，也不能嫁接别人的抓取登记。
4. **层级纪律**：见 §9.1。

### 9.4 采集与展示口径

- 采集器：`packages/pipeline/src/series.ts`（入库）+ `scripts/run-exchange.ts`（交易所日频）。
  非交易日返回 404 → 跳过，不落存档、不记点。
- 每条序列带 `display_allowed`：未取得再发布权的序列写 `false`，展示层直接过滤。
- **期货结算价永远单独成栏**，标注「期货（预期价）」，与现货锚点、区域报价分开展示。

### 9.5 总览的展示口径：一个品种一个主力合约

交易所目录里同一品种有几十个交割月（铜：cu2610…cu2709）。库里**全量保存**，但**总览只展示主力**，
否则页面会变成一张合约表而不是行情表。规则（`apps/web/src/lib/market-overview.ts`
`selectRepresentativeContracts`，纯函数、有单测）：

1. 按 `category + instrument_code` 分组，取最新交易日**成交量最大**的合约；成交量相同取先到期。
2. 同一合约被两个场所重复登记（如 `bc` 同时出现在 `shfe.*` 与 `ine.*`）时，以代码前缀对应的场所为准。
3. 同一品类里成交量低于该品类主力 20% 的品种不进总览（国际铜约为沪铜的十分之一）。
4. 指数 / 宏观 / 库存序列不参与挑主力，原样展示。
5. 非主力合约仍可通过单品页 `/m/s-<code>` 直达，数据完整、溯源不变。
