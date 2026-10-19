import { type Selectable, sql } from 'kysely';
import type { Todo, TodoStatus } from '../../domain/types.js';
import type { Db } from '../connection.js';
import type { NewTodo, TodoPatch, TodoRepository } from '../repositories.js';
import type { TodosTable } from '../schema.js';

function toTodo(row: Selectable<TodosTable>): Todo {
  return {
    id: row.id,
    accountId: row.account_id,
    messageId: row.message_id ?? undefined,
    googleTaskId: row.google_task_id,
    tasklistId: row.tasklist_id,
    title: row.title,
    status: row.status,
    due: row.due ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PgTodoRepository implements TodoRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewTodo) {
    const row = await this.db
      .insertInto('todos')
      .values({
        account_id: input.accountId,
        message_id: input.messageId ?? null,
        google_task_id: input.googleTaskId,
        tasklist_id: input.tasklistId,
        title: input.title,
        ...(input.status && { status: input.status }),
        due: input.due ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTodo(row);
  }

  async getById(id: string) {
    const row = await this.db
      .selectFrom('todos')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row && toTodo(row);
  }

  async getByGoogleTaskId(accountId: string, googleTaskId: string) {
    const row = await this.db
      .selectFrom('todos')
      .selectAll()
      .where('account_id', '=', accountId)
      .where('google_task_id', '=', googleTaskId)
      .executeTakeFirst();
    return row && toTodo(row);
  }

  async list(accountId: string, filter: { status?: TodoStatus; messageId?: string } = {}) {
    let q = this.db.selectFrom('todos').selectAll().where('account_id', '=', accountId);
    if (filter.status) q = q.where('status', '=', filter.status);
    if (filter.messageId) q = q.where('message_id', '=', filter.messageId);
    const rows = await q.orderBy('created_at', 'desc').execute();
    return rows.map(toTodo);
  }

  async update(id: string, patch: TodoPatch) {
    const row = await this.db
      .updateTable('todos')
      .set({
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.due !== undefined && { due: patch.due }),
        ...(patch.completedAt !== undefined && { completed_at: patch.completedAt }),
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();
    return row && toTodo(row);
  }

  async delete(id: string) {
    await this.db.deleteFrom('todos').where('id', '=', id).execute();
  }
}
