import { v4, type BeeDb } from '@bee/db';

/**
 * 内部管理写操作的公共部件：
 *  - AdminInputError：可预期的业务校验失败（路由映射为 4xx）。
 *  - writeAudit：与业务写入同事务追加 admin_audit，actor 固定 internal。
 */

export type DbTransaction = Parameters<Parameters<BeeDb['transaction']>[0]>[0];

export class AdminInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 422,
  ) {
    super(message);
    this.name = 'AdminInputError';
  }
}

export interface AuditEntry {
  action: string;
  subjectType: string;
  subjectId: string;
  before: unknown;
  after: unknown;
}

export async function writeAudit(tx: DbTransaction, entry: AuditEntry): Promise<void> {
  await tx.insert(v4.adminAudit).values({
    actor: 'internal',
    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    before: entry.before,
    after: entry.after,
  });
}

export function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}