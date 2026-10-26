import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { exceptionKindEnum, exceptionStatusEnum, priorityEnum } from './_enums';
import { createdAt, pk } from './dictionary';

/**
 * 异常队列（运行方式的物理形态）：校验隔离、口径待决、来源异常、管线故障都汇到这里。
 * 「人只出现在异常队列与口径决策点」——人的日常工作面 = 本表 + caliber_decision。
 *
 * assigned_to 格式：'agent:<Paperclip agent id>' | 'human:<Paperclip user id>' | 'unassigned'。
 * 口径类异常的裁决落 caliber_decision；校验类裁决落 validation_result（human_override）。
 */
export const exceptionQueue = pgTable(
  'exception_queue',
  {
    id: pk(),
    kind: exceptionKindEnum('kind').notNull(),
    /** observation | quote | mapping | source | run | dictionary_row */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    summary: text('summary').notNull(),
    priority: priorityEnum('priority').notNull().default('medium'),
    status: exceptionStatusEnum('status').notNull().default('open'),
    assignedTo: text('assigned_to').notNull().default('unassigned'),
    resolution: text('resolution'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('exception_queue_triage_idx').on(t.status, t.priority, t.createdAt),
    index('exception_queue_subject_idx').on(t.subjectType, t.subjectId),
  ],
);
