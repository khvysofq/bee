# ADR-0008 部署形态：单主机 docker compose（无 k8s / 无 serverless）

**状态**：已定稿（P0-1，2026-10-26；由 DevOps 在 P0-3/P0-4 期间落地）｜**决策人**：CTO

## 背景

v1 组件：Postgres + Next.js（web）+ pipeline worker + 反向代理，日频负载，成本敏感，
v1 明确不采购外部付费数据/基础设施。

## 决策

- **一台主机，docker compose 编排**：`postgres` / `web` / `worker` / `reverse-proxy（Caddy）` 四个服务；
  原始存档目录挂卷。
- 发布 = 构建镜像 → compose 拉起；迁移在发布流程内先于服务启动执行（`pnpm db:migrate`）。
- 监控最小集：PG 活性、worker 心跳（台账最新 run 时间）、磁盘水位（存档目录）。

## 为什么

- 组件全是长驻进程 + 日频任务，serverless 的冷启动/连接模型/出口 IP 管控都不匹配。
- 单主机把 v1 的运维面压到一个人（或一个代理）能看懂的程度；compose 文件即全部拓扑。

## 弃了什么

- **Kubernetes（或托管 k8s）**：为 4 个长驻服务引入集群心智与成本，无任何 v1 收益。
- **Serverless（Vercel/Functions 类）**：长连 PG + worker 常驻 + 采集出口管控都不友好；
  「按量付费」在日频场景反而更贵。
- **多区域/多实例**：v1 没有流量与可用性需求，等北极星指标说话。

## 影响

- ICP 备案要求意味着站点部署在中国大陆主机（合规输入，落地时 DevOps 确认）。
- 灾备最低要求：每日 `pg_dump` + 存档目录异地复制；恢复演练在 P0-3 收尾时做一次。
- 未来上 k8s 的迁移路径存在（容器化已就位），但不是 v1 的设计目标。
