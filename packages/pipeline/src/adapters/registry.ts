import { fileURLToPath } from 'node:url';
import { FixtureSourceAdapter } from './fixture';
import { StatsSourceAdapter, type StatsAdapterOptions } from './stats';
import type { SourceAdapter } from '../types';

function fixturePath(file: string): string {
  return fileURLToPath(new URL(`../../fixtures/${file}`, import.meta.url));
}

/**
 * fixture/开放数据适配器注册表。
 *
 * 接入真实来源时只在这里新增实现（例如 Sci99Adapter），并先在 source 表登记
 * status=active + robots_status=allowed；管线会对未放行来源直接跳过并写 source 异常，
 * 不依赖调用方自觉。
 */
export function createFixtureRegistry(): Map<string, SourceAdapter> {
  const adapters: SourceAdapter[] = [
    new FixtureSourceAdapter({
      code: 'fixture-a',
      name: 'Fixture A（自造测试价目表）',
      fixturePath: fixturePath('fixture-a.json'),
    }),
    new FixtureSourceAdapter({
      code: 'fixture-b',
      name: 'Fixture B（自造跨源对照价目表）',
      fixturePath: fixturePath('fixture-b.json'),
    }),
    new FixtureSourceAdapter({
      code: 'fixture-c-outlier',
      name: 'Fixture C（自造异常样本）',
      fixturePath: fixturePath('fixture-c-outlier.json'),
    }),
    new FixtureSourceAdapter({
      code: 'open-cc0-sample',
      name: 'CC0 开放数据样本（本仓库自造并释出）',
      fixturePath: fixturePath('open-cc0-sample.json'),
    }),
  ];
  return new Map(adapters.map((adapter) => [adapter.code, adapter]));
}

/**
 * 真实源注册表：fixture/CC0 + 国家统计局旬报。
 * 回放必须能按 source.code 找到原适配器，因此默认注册全部实现；fetch 是否走网络由适配器决定。
 */
export function createSourceRegistry(options?: { stats?: StatsAdapterOptions }): Map<string, SourceAdapter> {
  const adapters = [...createFixtureRegistry().values(), new StatsSourceAdapter(options?.stats)];
  return new Map(adapters.map((adapter) => [adapter.code, adapter]));
}
