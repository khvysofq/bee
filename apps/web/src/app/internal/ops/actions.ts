'use server';

/**
 * 运维写操作（v4 停用）。
 *
 * v4 删除了 pipeline_run / exception_queue，新的巡检与异常处理流程尚未实现；
 * 页面已改为只读，不再调用这两个 action。保留导出避免引用方 500，调用时给出明确错误。
 */

export async function recordDailyInspection(): Promise<void> {
  throw new Error('v4 巡检台账尚未实现');
}

export async function resolveException(): Promise<void> {
  throw new Error('v4 已删除异常队列，异常处理尚未实现');
}