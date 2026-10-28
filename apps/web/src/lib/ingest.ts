import type { BeeDb } from '@bee/db';

/**
 * 入库管线（v4 尚未实现）。
 *
 * 旧链路依赖 observation / raw_content / ingest_candidate 等表，v4 已删除这些中间层；
 * 新的写库路径（校验 → price_daily / content）还没实现，因此这里不再保留任何半截写入逻辑。
 * /internal/ingest 路由会明确返回 501。
 */

export const V4_INGEST_MESSAGE = 'v4 采集管线尚未实现';

export class IngestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 501,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

/**
 * 旧签名保留给既有调用方（legacy jobs 测试）：v4 不写任何表，统一抛 501。
 */
export async function ingestPayload(
  _database: BeeDb,
  _payload: unknown,
  _options?: unknown,
): Promise<never> {
  throw new IngestError('not_implemented', V4_INGEST_MESSAGE, 501);
}