import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    globalSetup: ['packages/db/tests/global-setup.ts'],
    // 所有集成测试共享同一个 bee_test 库，库里有全库唯一单例（canonical 单位、country 根），
    // 且 briefing 的 seed 会改字典状态 —— 文件必须串行，否则并行文件互相毒化种子与探针。
    fileParallelism: false,
  },
});
