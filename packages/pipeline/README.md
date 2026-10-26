# @bee/pipeline —— 数据管线（P0-3 落地处）

本包在 P0-1 只落**地基**：台账 helper（`src/ledger.ts`）与运行契约（`@bee/core` 的 `steps.ts`）。
采集、规范化、Agent 校验、异常隔离的具体实现属于 P0-3（DAW-31），此处先明确约定。

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

1. **每一步都过台账**：`startRun/startStep/finishStep/finishRun`，input/output 只传 id 引用。
2. **原始内容不可变**：抓取内容写内容寻址存储后只登记 `raw_fetch`，任何后续步骤不改不删。
3. **观测值不可改**：修正 = 新观测 + `superseded_by_id`；DB 触发器已强制，代码不要试图绕过。
4. **LLM 只判断、不产数**：Agent 输出可以是校验结论、映射建议、叙事草稿；
   任何进入报价表的数字必须来自 `raw_fetch` 抽取链。`agent_invocation` 全量留痕。
5. **校验隔离不进简报**：`isolated` / `needs_human` 观测不参与定档。
6. **回放不写生产表**：`kind='replay'` 的 run 产出对照报告（`pipeline_step.output_refs.report_ref`），
   差异超出阈值的写 `exception_queue`；只有显式 `--writeback`（人工决策后）才落新观测走 supersede 链。

## 调度（ADR-0005）

调度器选 pg-boss（同一 Postgres，无新增基础设施）。P0-3 引入本包依赖并在 worker 进程装配：
每来源一个 cron 式任务（`source.crawl_frequency_per_day` / `rate_limit_seconds` / `crawl_window_json`），
失败重试与退避交给 pg-boss，业务失败细节落台账。

## P0-3 待补清单（本骨架刻意不做）

- 来源适配器框架与真实来源（先登记 `source` + 核查 ToS/robots）
- 映射建议 → 口径决策点的工作流（异常队列 ↔ caliber_decision）
- 校验规则集与版本号管理（`rules_version` 从此有值）
- `dictionary_hash` 的计算实现（active 字典行导出 + sha256）
- 员工/人审视图与 Paperclip 异常队列桥接
