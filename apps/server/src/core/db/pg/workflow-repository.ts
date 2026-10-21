import { type Selectable, sql } from 'kysely';
import type {
  DecisionStatus,
  Workflow,
  WorkflowAction,
  WorkflowDecision,
  WorkflowStatus,
} from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { NewWorkflow, WorkflowRepository } from '../repositories.js';
import type { WorkflowDecisionsTable, WorkflowsTable } from '../schema.js';
import { chunk, clamp } from './util.js';

function toWorkflow(row: Selectable<WorkflowsTable>): Workflow {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    type: row.type,
    mode: row.mode,
    instruction: row.instruction,
    criteria: row.criteria,
    keywords: row.keywords,
    senderFilter: row.sender_filter ?? undefined,
    since: row.since ?? undefined,
    action: row.action as WorkflowAction,
    status: row.status,
    error: row.error ?? undefined,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDecision(row: Selectable<WorkflowDecisionsTable>): WorkflowDecision {
  return {
    workflowId: row.workflow_id,
    messageId: row.message_id,
    phase: row.phase,
    match: row.match,
    confidence: row.confidence,
    reason: row.reason,
    status: row.status,
    error: row.error ?? undefined,
    output: row.output ?? undefined,
    decidedAt: row.decided_at,
    appliedAt: row.applied_at ?? undefined,
  };
}

export class PgWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewWorkflow, status: WorkflowStatus) {
    const row = await this.db
      .insertInto('workflows')
      .values({
        account_id: input.accountId,
        name: input.name,
        type: input.type,
        mode: input.mode,
        instruction: input.instruction,
        criteria: input.criteria,
        keywords: input.keywords,
        sender_filter: input.senderFilter ?? null,
        since: input.since ?? null,
        action: JSON.stringify(input.action),
        status,
        session_id: input.sessionId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toWorkflow(row);
  }

  async get(id: string) {
    const row = await this.db
      .selectFrom('workflows')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toWorkflow(row);
  }

  async list(accountId: string, filter: { status?: WorkflowStatus } = {}) {
    let q = this.db.selectFrom('workflows').selectAll().where('account_id', '=', accountId);
    if (filter.status) q = q.where('status', '=', filter.status);
    return (await q.orderBy('created_at', 'desc').execute()).map(toWorkflow);
  }

  async setStatus(id: string, status: WorkflowStatus, error?: string) {
    await this.db
      .updateTable('workflows')
      .set({ status, error: error ?? null, updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async setAction(id: string, action: WorkflowAction) {
    await this.db
      .updateTable('workflows')
      .set({ action: JSON.stringify(action), updated_at: sql`now()` })
      .where('id', '=', id)
      .execute();
  }

  async delete(id: string) {
    await this.db.deleteFrom('workflows').where('id', '=', id).execute();
  }

  async recordDecisions(
    workflowId: string,
    accountId: string,
    decisions: {
      messageId: string;
      phase: 'backfill' | 'incremental';
      match: boolean;
      confidence: number;
      reason: string;
      status: DecisionStatus;
      output?: Record<string, string>;
    }[],
  ) {
    for (const batch of chunk(decisions, 500)) {
      await this.db
        .insertInto('workflow_decisions')
        .values(
          batch.map((d) => ({
            workflow_id: workflowId,
            account_id: accountId,
            message_id: d.messageId,
            phase: d.phase,
            match: d.match,
            confidence: d.confidence,
            reason: d.reason,
            status: d.status,
            output: d.output ? JSON.stringify(d.output) : null,
          })),
        )
        .onConflict((oc) => oc.columns(['workflow_id', 'message_id']).doNothing())
        .execute();
    }
  }

  async decided(workflowId: string, messageIds: string[]) {
    if (messageIds.length === 0) return new Set<string>();
    const rows = await this.db
      .selectFrom('workflow_decisions')
      .select('message_id')
      .where('workflow_id', '=', workflowId)
      .where('message_id', 'in', messageIds)
      .execute();
    return new Set(rows.map((r) => r.message_id));
  }

  async decisions(workflowId: string, filter: { status?: DecisionStatus; limit?: number } = {}) {
    let q = this.db
      .selectFrom('workflow_decisions')
      .selectAll()
      .where('workflow_id', '=', workflowId);
    if (filter.status) q = q.where('status', '=', filter.status);
    const rows = await q
      .orderBy('match', 'desc')
      .orderBy('decided_at', 'desc')
      .orderBy('confidence', 'desc')
      .limit(clamp(filter.limit ?? 1000, 1, 5000))
      .execute();
    return rows.map(toDecision);
  }

  async getDecision(workflowId: string, messageId: string) {
    const row = await this.db
      .selectFrom('workflow_decisions')
      .selectAll()
      .where('workflow_id', '=', workflowId)
      .where('message_id', '=', messageId)
      .executeTakeFirst();
    return row && toDecision(row);
  }

  async setDecisionStatus(
    workflowId: string,
    messageIds: string[],
    status: DecisionStatus,
    error?: string,
  ) {
    for (const ids of chunk(messageIds, 1000)) {
      await this.db
        .updateTable('workflow_decisions')
        .set({
          status,
          error: error ?? null,
          ...(status === 'applied' && { applied_at: sql`now()` }),
        })
        .where('workflow_id', '=', workflowId)
        .where('message_id', 'in', ids)
        .execute();
    }
  }

  async counts(workflowId: string) {
    const rows = await this.db
      .selectFrom('workflow_decisions')
      .select((eb) => ['status', eb.fn.countAll<string>().as('n')])
      .where('workflow_id', '=', workflowId)
      .groupBy('status')
      .execute();
    return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) as Partial<
      Record<DecisionStatus, number>
    >;
  }
}
