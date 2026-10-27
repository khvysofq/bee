import { timingSafeEqual } from 'node:crypto';

/**
 * 内部 API 鉴权（P0）：
 *  - /internal/ingest 只认 `Authorization: Bearer $INGEST_TOKEN`；env 缺失直接 503（绝不无鉴权放行）。
 *  - /internal/api/* 允许同一 service token，或同源浏览器请求（内部管理页）。
 *
 * 不新增公开入口：管理页本身在 /internal 布局下，不进用户导航。
 */

export function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function tokensEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerOf(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

/** ingest 路由：缺 token 配置 → 503；缺失/错误 → 401。 */
export function authorizeIngest(request: Request): Response | null {
  const expected = process.env.INGEST_TOKEN;
  if (!expected) {
    return errorResponse('ingest_disabled', 'INGEST_TOKEN 未配置，ingest 路由拒绝所有请求', 503);
  }
  const provided = bearerOf(request);
  if (!provided || !tokensEqual(expected, provided)) {
    return errorResponse('unauthorized', '缺少或错误的 Bearer token', 401);
  }
  return null;
}

function isSameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === url.host;
    } catch {
      return false;
    }
  }
  // 服务端直接调用（测试/curl）没有 Origin：只认 token，不认「没带头就当同源」。
  return false;
}

/** 管理 API：token 或同源请求二者其一。 */
export function authorizeAdmin(request: Request): Response | null {
  const expected = process.env.INGEST_TOKEN;
  const provided = bearerOf(request);
  if (expected && provided && tokensEqual(expected, provided)) return null;
  if (isSameOrigin(request)) return null;
  if (!expected) {
    return errorResponse('admin_disabled', 'INGEST_TOKEN 未配置，管理 API 只接受同源请求', 503);
  }
  return errorResponse('unauthorized', '需要同源请求或 Bearer token', 401);
}