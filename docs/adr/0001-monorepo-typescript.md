# ADR-0001 语言与仓库形态：TypeScript Monorepo（pnpm workspaces）

**状态**：已定稿（P0-1，2026-10-26）｜**决策人**：CTO

## 背景

三块能力（简报/推演/问答）+ 数据管线 + 网站都在一个 v1 里起步，团队是 AI 工程代理（前端/后端/测试/平台）。
要求：一处定义的领域类型（品类、口径、报价、溯源结构）能被 schema、管线、API、页面同时使用，
不产生「数据库一个说法、页面一个说法」的漂移。

## 决策

- **单一语言 TypeScript**，单一仓库，`pnpm` workspaces：`apps/web`、`packages/db`、`packages/core`、`packages/pipeline`。
- 共享契约（zod schema、溯源响应、step 契约、单位换算）放 `@bee/core`，供 web 与 pipeline 双向引用。
- Node ≥ 20.9，模块 ESNext + bundler 解析，`strict` 全开。

## 为什么

- 类型从 DB schema（drizzle 推导）一路贯通到页面 props，改一处、错在编译期。
- 一个工具链、一套 lint/测试/迁移命令，工程代理上下文切换成本最低。
- pnpm workspace 是 Node 官方文档认可的 monorepo 默认形态，依赖提升行为可预期。

## 弃了什么

- **Python（管线）+ TypeScript（Web）双语言**：数据/爬虫生态确实 Python 强，但 LLM 调用与 HTTP 抓取
  在 TS 同样成熟（本项目 v1 是「公开页面按天低频抓取」，不是高并发爬虫系统），不值得为它付出
  双工具链 + 领域类型双份维护 + 代理双技能要求的代价。
- **Go**：部署单元漂亮，但 web/LLM 生态与团队形态不匹配，v1 无性能需求。
- **Java/Kotlin**：工程代理生成质量与迭代速度劣势明显，重。
- **npm/yarn workspaces**：npm 工作区解析历史包袱多；yarn 无决定性优势。

## 影响

- 后续所有服务（P0-3 worker、P0-4 web）都从这套 workspace 长出来，不再引入第二种语言。
  若 P1 引入重数据科学组件（如时序模型），以**独立服务**形式挂进来，而不是在 monorepo 里改语言。
