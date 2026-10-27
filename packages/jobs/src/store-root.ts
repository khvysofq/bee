import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * 仓库根定位：从 cwd 向上找 pnpm-workspace.yaml。
 * 不用 `new URL(relative, import.meta.url)` —— Next 打包器会把它当模块请求静态解析。
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(start);
}

/**
 * 内容寻址存档根：worker 与 web 必须指向同一个目录。
 * RAW_STORE_DIR 若为相对路径，按仓库根解析（pnpm --filter 会把 cwd 设成包目录，
 * 不能让它决定存档位置）。
 */
export function resolveJobsStoreRoot(explicit?: string): string {
  const repoRoot = findRepoRoot();
  const configured = explicit ?? process.env.RAW_STORE_DIR;
  if (!configured) return path.join(repoRoot, 'data', 'raw-store');
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}

export function jobsFixtureRoot(): string {
  return path.join(findRepoRoot(), 'packages', 'jobs', 'fixtures');
}