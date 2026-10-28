import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';

/**
 * DATABASE_URL 解析顺序：已导出的环境变量 > 当前目录 .env > 单仓库根 .env。
 *
 * 为什么要在代码里找根 .env：pnpm --filter 以包目录为 cwd 运行脚本，
 * 而开发者按 README 的最短路径把 .env 放在仓库根（cp .env.example .env）。
 */
export function resolveDatabaseUrl(): string | undefined {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const candidate of [path.resolve('.env'), path.resolve('../../.env')]) {
    if (existsSync(candidate)) {
      config({ path: candidate });
      if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    }
  }
  return undefined;
}

/** 带「怎么办」提示的 DATABASE_URL 读取（脚本入口用）。 */
export function requireDatabaseUrl(): string {
  const url = resolveDatabaseUrl();
  if (!url) {
    console.error('缺少 DATABASE_URL（复制 .env.example 为 .env 后重试）');
    process.exit(1);
  }
  return url;
}

/**
 * v4 连接串：优先 DATABASE_URL_V4；否则直接用 DATABASE_URL。
 *
 * v4 已于 2026-10-28 上线：验证过的 `bee_v4` 改名为 `bee`，旧库已备份删除，
 * 因此 v4 脚本与 web 现在指向同一个库；`bee_v4` 只作为历史环境变量保留。
 */
export function resolveV4DatabaseUrl(): string {
  if (process.env.DATABASE_URL_V4) return process.env.DATABASE_URL_V4;
  return requireDatabaseUrl();
}
