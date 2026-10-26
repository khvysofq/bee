# ADR-0003 ORM 与迁移：Drizzle + drizzle-kit（迁移 SQL 入库）

**状态**：已定稿（P0-1，2026-10-26）｜**决策人**：CTO

## 背景

schema 是本项目的第一资产，21 张表 + 触发器 + 约束。要求：schema 即代码（类型从 schema 推导）、
迁移可评审、可审查 diff、工程代理生成迁移零歧义。

## 决策

- **Drizzle ORM**：表定义即 TS 源码（`packages/db/src/schema/**`），查询类型全推导，无运行时黑盒。
- **drizzle-kit generate** 生成 SQL 迁移到 `packages/db/migrations/`，**迁移文件提交入库**；
  应用迁移用 drizzle 的 `migrate()`（`pnpm db:migrate`），不用 push 直改库。
- 数据库层硬语义（唯一键/CHECK/触发器）写在 schema 定义 + 迁移 SQL 里，测试覆盖（集成测试即守卫测试）。

## 为什么

- schema-as-code 直接成为 `@bee/db` 的类型来源，web/管线零成本获得编译期检查。
- 生成的迁移是**可读 SQL**，评审人能逐行核对（这是 Dawan 强制代码评审能落到实处的关键）。
- 无 codegen 步骤、无引擎进程，CI 与工程代理的确定性最好。

## 弃了什么

- **Prisma**：成熟、代理友好，但运行时引擎 + 独立 schema 语言 + 生成流程在 monorepo/多包引用下更重；
  迁移 SQL 的透明度也弱于 drizzle-kit。不选不表示它错，是对本项目约束的排序。
- **Knex/裸 SQL + 手写类型**：类型与 schema 漂移只能靠人盯，长期必散。
- **dbmate/Flyway（纯 SQL 迁移工具）**：迁移管理本身很好，但没有 schema→类型的桥，与 TS 栈失配。
- **no-ORM（pg + 手写 SQL 映射）**：21 表的项目里样板代码量不可接受。

## 影响

- 规范：改 schema 只改 `src/schema/**` → `pnpm db:generate` → 评审迁移 SQL → 合并。
  **已合并的迁移禁止手改**，修正走新迁移。
- 触发器等 SQL 特性 drizzle 不建模的部分，追加在生成迁移的同一文件中（`-- 以下为手工追加` 分界注释），
  并有对应集成测试锁定行为。
