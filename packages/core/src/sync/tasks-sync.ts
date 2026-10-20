import type { Repositories } from '../db/repositories.js';
import type { EventBus } from '../events/event-bus.js';
import type { GatewayProvider } from '../google/gateways.js';

/** Overlap between polls so a task updated during the previous request isn't missed. */
const SKEW_MS = 60_000;

/** Google Tasks → local todos: completion, edits and deletions made in Google's own apps. */
export class TasksSync {
  constructor(
    private readonly repos: Repositories,
    private readonly gateways: GatewayProvider,
    private readonly events: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sync(accountId: string): Promise<{ updated: number; deleted: number }> {
    const todos = (await this.repos.todos.list(accountId)).filter(
      (t) => t.googleTaskId && t.tasklistId,
    );
    if (todos.length === 0) return { updated: 0, deleted: 0 };

    const startedAt = this.now();
    const { tasksSyncedAt } = await this.repos.syncState.get(accountId);
    const since = tasksSyncedAt && new Date(tasksSyncedAt.getTime() - SKEW_MS);
    const byTaskId = new Map(todos.map((t) => [t.googleTaskId!, t]));
    const gateway = await this.gateways.tasks(accountId);
    let updated = 0;
    let deleted = 0;

    for (const tasklistId of new Set(todos.map((t) => t.tasklistId!))) {
      for (const task of await gateway.listChangedTasks(tasklistId, since)) {
        const todo = byTaskId.get(task.id);
        if (!todo) continue; // not created by this app
        if (task.deleted) {
          await this.repos.todos.delete(todo.id);
          deleted++;
          continue;
        }
        const changed =
          todo.title !== task.title ||
          todo.status !== task.status ||
          todo.due?.getTime() !== task.due?.getTime() ||
          todo.completedAt?.getTime() !== task.completedAt?.getTime();
        if (!changed) continue;
        await this.repos.todos.update(todo.id, {
          title: task.title,
          status: task.status,
          due: task.due ?? null,
          completedAt: task.completedAt ?? null,
        });
        updated++;
      }
    }
    await this.repos.syncState.update(accountId, { tasksSyncedAt: startedAt });
    if (updated + deleted > 0) this.events.emit('todos.changed', { accountId });
    return { updated, deleted };
  }
}
