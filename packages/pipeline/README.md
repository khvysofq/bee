# @bee/pipeline —— 数据管线（P0-3 落地处）

本包在 P0-1 落地台账 helper（`src/ledger.ts`）与运行契约（`@bee/core` 的 `steps.ts`）；
P0-3 已在此之上跑通 **fixture/CC0 数据的端到端管线**：
采集 → 内容寻址归档 → 确定性抽取 → 规范化 → Agent 校验 + 异常队列 → 定档报价/加工指标 → 回放。

> P0-3 只接自造 fixture 与明确 CC0 样本（见 `fixtures/README.md`）。`docs/compliance` 中
> `BLOCKED-RIGHTS` 的来源一律不接，人工复制也不进管线。

## 管线形态（P0-3 按此实现）

```
fetch（按 source 表调度，错峰+限速）
  → extract（每来源适配器：raw_fetch → 待映射观测）
  → normalize（term/region/unit 映射 + 换算 → normalized）
  → validate（规则 + LLM 判断，全部落 validation_result）
  → aggregate（validated 观测 → daily_quote；聚合 → derived_indicator）
  → publish（简报就绪标记；简报页本身是 P0-4）
```

## 硬约束（违反即 P0-3 验收失败）

1. **每一步都过台账**（`src/ledger.ts`，DB 触发器 + helper 双层强制）：用 `withStep` 包每步
   （开步登记 → 业务原子写 → 结果留痕），input/output 只传 id 引用；
   `startRun/startStep` 传幂等键（pg-boss job id / (run, seq)），at-least-once 重投会复用既有记录（`reused` 标志）；
   `startStep` 必须带 `stepVersion`（@bee/core step 契约的 version）—— 按 step 版本回放的依据，
   复用必须同 stepKind 同 stepVersion（换实现 = 换 seq 或升 stepVersion，否则 `idempotency_conflict`）；
   run/step 只能以 `pending` 落库（0002 守卫），`startRun/startStep` 内部完成 pending→running 认领；
   **执行所有权（DAW-35 B1/B2）**：`claimed`（本调用是否认领成功）与 `reused` 是独立判别 ——
   调用方以 `claimed` 决定是否执行（`if (!claimed) return;`），不从 `reused` 或新建身份推断执行权；
   pending 自愈认领成功 → 照常执行（登记后认领前崩溃可恢复）；认领被并发 worker 抢走 →
   `claimed:false` 拒绝执行；
   `withStep` 重投：succeeded → `replayed:true` **业务不重复执行**；running → `in_flight`；
   failed/skipped → `already_terminal`（都不会先执行业务再失败）；
   双重 finish / pending 越级 finish 抛 `LedgerError`（DB 触发器是最后一道防线，helper 先给可读错误）。
2. **原始内容不可变**：fetch 步先按 sha 查 `raw_content`；首次把内容写入 RAW_STORE_DIR 并登记
   `raw_content`（同 sha 全库一行，首见 content_ref 作数），之后每次抓取只新增
   `raw_fetch`（一行一次抓取）。顺序是外键硬约束；任何后续步骤不改不删。
3. **观测值不可改**：修正 = 新观测（同 fetch 同行 revision 递增）+ `superseded_by_id`，
   **两笔写必须在同一事务**（同槽位任何时刻至多一个活跃版本，可延迟约束触发器提交时校验 ——
   拆成两次提交的半修正整体拒绝）；后继必须同槽位同维度。DB 触发器已强制，代码不要试图绕过。
4. **LLM 只判断、不产数**：Agent 输出可以是校验结论、映射建议、叙事草稿；
   任何进入报价表的数字必须来自 `raw_fetch` 抽取链。`agent_invocation` 全量留痕
   （复合外键：run_id 与 step_id 同时给出时 step 必须属于该 run）。
5. **校验隔离不进简报**：`isolated` / `needs_human` 观测不参与定档。
6. **回放不写生产表**：`kind='replay'` 的 run 产出对照报告（`pipeline_step.output_refs.report_ref`），
   差异超出阈值的写 `exception_queue`；只有显式 `--writeback`（人工决策后）才落新观测走 supersede 链。
7. **聚合贡献走明细表**：`derived_indicator` 的贡献报价逐条落 `indicator_contribution`
   （维度一致、值在报价区间内、指标与明细**同一事务**写入 —— 延迟非空约束两端强制）；
   重算 = 同事务内删旧插新，不做 UPDATE。

台账契约的完整语义（状态机、幂等、冻结、崩溃窗口）见 `src/ledger.ts` 文件头注释与
`docs/data-model.md` §7；回归测试 `tests/ledger.integration.test.ts`。

## 调度（ADR-0005）

调度器选 pg-boss（同一 Postgres，无新增基础设施）。P0-3 引入本包依赖并在 worker 进程装配：
每来源一个 cron 式任务（`source.crawl_frequency_per_day` / `rate_limit_seconds` / `crawl_window_json`），
失败重试与退避交给 pg-boss，业务失败细节落台账。

## P0-3 已落地模块

| 模块 | 职责 |
|---|---|
| `types.ts` | `SourceAdapter` / `SourceDocument` / `ExtractedRow` 等契约 |
| `adapters/fixture.ts` + `adapters/registry.ts` | fixture/CC0 适配器；**真实源接入点** = 新增实现并注册 `source.code` |
| `store.ts` | 内容寻址存档（raw / work / replay 三个命名空间，路径穿越校验） |
| `extract.ts` | 确定性价格抽取（区间/单值/全角数字），抽取工件按 sha 寻址 |
| `mapping.ts` | source 专属 active 映射优先于 global；单位/价类型映射；`dictionary_hash` |
| `normalize.ts` | 映射 + 元/吨换算；一次性写全观测（观测值落库后不可 UPDATE 的触发器红线） |
| `agent.ts` | Agent 校验器契约；当前 `fixture-reviewer-v1` 是占位实现，接真模型只换实现 |
| `validate.ts` | DAW-29 阈值（日 ±3% / 周 ±6% / 跨源 ±4%）+ 校验计划/落库/异常队列 |
| `aggregate.ts` | validated 观测 → daily_quote；城市定档 → national_weighted_avg + 贡献明细 |
| `pipeline.ts` | 六步编排；每步 `withStep`，输出 id/内容地址引用 |
| `replay.ts` | 从 raw_fetch 重走抽取/规范化/校验，产 report，不写生产观测/定档/指标 |

测试入口：`tests/pipeline.integration.test.ts`（fixture 主链、回放 0 差异、幂等重投、
合规闸门、映射优先级、抽取确定性）。

## 仍在占位 / 后续接入

- **真实来源适配器**：P0-3 只有 fixture/CC0；真实源先登记 `source`（`active` + `robots=allowed`）
  并取得书面复用许可后，在 registry 增加适配器。管线默认只允许 `CC0-1.0`，调用方可显式扩展
  `allowedLicenses`。
- **pg-boss 调度装配**：本轮验收聚焦本地端到端，cron/限速/重试尚未接 worker；台账幂等键已按
  job id 语义设计，可直接复用。
- **真实 LLM 校验**：`fixture-reviewer-v1` 是确定性占位，只复述规则结论；替换为真实模型时
  `agent_invocation` 的 model/prompt/input/output/latency 留痕链路已就绪。
- **历史字典快照**：run 落 `dictionary_hash`，但未保存字典内容快照；跨字典版本的严格回放需要
  后续增加字典快照/导出。
- **人工裁决回写**：回放只产报告 + 异常；`--writeback` 的 supersede 链写回未实现。
- **异常队列 UI / Paperclip 桥接**：当前只落 `exception_queue`，人审视图属于 P0-4。
- **映射建议工作流**：机器只能写 `proposed`，人工确认 → `caliber_decision` 的工作流未接。
