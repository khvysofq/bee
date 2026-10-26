import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // 仅重写 apps/web 源码使用的 "@/…" 别名；用正则避免误伤 "@bee/…" 包名。
    alias: [{ find: /^@\//, replacement: `${path.join(repoRoot, 'apps/web', 'src')}/` }],
  },
  // LandingView.tsx / TraceNumber.tsx 含 JSX；Vite 8 用 oxc 转换（tsconfig 的 jsx:preserve 是给 Next 的，
  // 这里覆盖为 automatic runtime，让渲染冒烟测试能在 node 环境把 JSX 编译掉）。
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['packages/*/tests/**/*.test.ts', 'apps/web/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globalSetup: ['packages/db/tests/global-setup.ts'],
    // 所有集成测试共享同一个 bee_test 库，库里有全库唯一单例（canonical 单位、country 根），
    // 且 briefing 的 seed 会改字典状态 —— 文件必须串行，否则并行文件互相毒化种子与探针。
    fileParallelism: false,
  },
});
