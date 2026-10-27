import { existsSync } from 'node:fs';
import path from 'node:path';

/** 与 packages/jobs 共用同一存档根（相对 RAW_STORE_DIR 按仓库根解析）。 */
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

export function resolveWebStoreRoot(explicit?: string): string {
  const repoRoot = findRepoRoot();
  const configured = explicit ?? process.env.RAW_STORE_DIR;
  if (!configured) return path.join(repoRoot, 'data', 'raw-store');
  return path.isAbsolute(configured) ? configured : path.resolve(repoRoot, configured);
}