import { FENGJ_COPPER_ADAPTER, fengjCopperAdapter, parseFengjCopperTable, SchemaMismatchError } from './fengj-copper';

/** 确定性适配器注册表。新增站点 = 新增一个 parse 函数并在这里注册。 */
export interface DeterministicAdapter {
  key: string;
  parse: (html: string) => import('./fengj-copper').FengjCopperRow[];
}

const ADAPTERS = new Map<string, DeterministicAdapter>([[FENGJ_COPPER_ADAPTER, fengjCopperAdapter]]);

export function hasAdapter(key: string | null | undefined): boolean {
  return Boolean(key && ADAPTERS.has(key));
}

export function getAdapter(key: string): DeterministicAdapter {
  const adapter = ADAPTERS.get(key);
  if (!adapter) throw new Error(`未知 adapter：${key}（已注册：${[...ADAPTERS.keys()].join(', ')}）`);
  return adapter;
}

export function listAdapters(): string[] {
  return [...ADAPTERS.keys()];
}

export { FENGJ_COPPER_ADAPTER, parseFengjCopperTable, SchemaMismatchError };
export type { FengjCopperRow } from './fengj-copper';