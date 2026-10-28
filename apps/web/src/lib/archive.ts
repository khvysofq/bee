import type { BeeDb } from '@bee/db';

/**
 * 原始存档查看器（v4 停用）。
 *
 * v4 把原始 HTML 归档移到 OSS `raw/`，不再有 raw_fetch / raw_content / price_observation
 * 这些库内表。库内查看器尚未实现，因此这里不查任何表，返回 null；
 * 页面展示明确的停用提示（200），不对未知 fetchId 返回 500。
 */

export const ARCHIVE_UNAVAILABLE_MESSAGE =
  'v4 已将原始抓取归档移至 OSS raw/，库内存档查看器暂未实现。';

export async function loadArchivePageData(
  _fetchId: string,
  _database?: BeeDb,
): Promise<null> {
  return null;
}