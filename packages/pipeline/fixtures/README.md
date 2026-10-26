# P0-3 fixture 与开放数据样本

本目录全部内容为**本仓库自造**的合成数据，并按 **CC0-1.0** 释出；不包含任何第三方站点的
页面正文、价格表或数据库导出。用途是让管线在没有来源授权争议的前提下端到端跑通。

## 文件

| 文件 | 用途 |
|---|---|
| `fixture-a.json` | 主价目表：覆盖 5 品类、历史日 D-7/D-1、元/斤→元/吨换算 |
| `fixture-b.json` | 跨源对照：同品类同城多源、同城采购价 vs 销售价 |
| `fixture-c-outlier.json` | 异常样本：跨源偏离（应隔离）+ 未映射品类（应进人工口径队列） |
| `open-cc0-sample.json` | 明确 CC0-1.0 复用权的开放数据样例（自造并释出，非第三方内容） |

## 合规边界

- 不接入 `docs/compliance/collection-compliance-v1.md` 中任何 `BLOCKED-RIGHTS` 来源；
- 不把真实站点内容人工复制进 fixture；
- 管线默认只接受 `license.id=CC0-1.0` 的文档；真实来源取得书面许可后，在调用方显式扩展
  `allowedLicenses` 并完成 source 表登记（`status=active` + `robots_status=allowed`）。

## 真实源接入点

实现 `packages/pipeline/src/types.ts` 的 `SourceAdapter`（`fetch` + `extract`），在
`packages/pipeline/src/adapters/registry.ts` 注册 `source.code` 即可。管线主干（台账、抽取工件、
规范化、校验、定档、指标、回放）不变。
