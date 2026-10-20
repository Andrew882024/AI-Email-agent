import type { Repositories } from '../db/repositories.js';
import type { Todo } from '../domain/types.js';
import type { EventBus } from '../events/event-bus.js';
import type { OutboxOpName, OutboxPayloads } from './outbox-ops.js';

/** Opens the message in Gmail on the web, in the right account. */
export const gmailLink = (accountEmail: string, messageId: string) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(accountEmail)}#all/${messageId}`;

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

/**
 * The single write path for mailbox changes: applies them to the local mirror immediately
 * (optimistic) and queues them for Google. The outbox worker pushes them in order.
 */
export class MailboxService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventBus,
  ) {}

  /** Covers read/unread, star/unstar, label/unlabel and archive/move-to-inbox. */
  async modifyLabels(
    accountId: string,
    messageIds: string[],
    change: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    const ids = [...new Set(messageIds)];
    const add = [...new Set(change.add)];
    const remove = [...new Set(change.remove)];
    const conflict = add.find((label) => remove.includes(label));
    if (conflict) throw new Error(`Label ${conflict} is both added and removed`);
    if (ids.length === 0 || (add.length === 0 && remove.length === 0)) return;

    // Queue first: if the local write then fails, Google still gets the change and the next
    // incremental sync brings the mirror in line. The reverse order could lose the change.
    await this.enqueue(accountId, 'modify_labels', { messageIds: ids, add, remove });
    await this.repos.messages.modifyLabels(accountId, ids, { add, remove });
    this.events.emit('message.updated', { accountId, messageIds: ids });
  }

  /** Queue a complete RFC 5322 message for sending; it appears locally via sync once sent. */
  async send(accountId: string, message: { raw: string; threadId?: string }): Promise<void> {
    await this.enqueue(accountId, 'send_message', message);
  }

  /** Create a todo for a message; the Google Task is created by the outbox worker. */
  async addTodo(
    accountId: string,
    input: { messageId: string; title: string; notes?: string; due?: Date },
  ): Promise<Todo> {
    const [account, message] = await Promise.all([
      this.repos.accounts.getById(accountId),
      this.repos.messages.getById(accountId, input.messageId),
    ]);
    if (!account || !message) throw new NotFoundError(`Message ${input.messageId} not found`);

    const todo = await this.repos.todos.create({
      accountId,
      messageId: message.id,
      title: input.title,
      due: input.due,
    });
    const link = gmailLink(account.email, message.id);
    try {
      await this.enqueue(accountId, 'create_task', {
        todoId: todo.id,
        title: input.title,
        notes: [input.notes, link].filter(Boolean).join('\n\n'),
        ...(input.due && { due: input.due.toISOString() }),
      });
    } catch (err) {
      await this.repos.todos.delete(todo.id);
      throw err;
    }
    this.events.emit('todos.changed', { accountId });
    return todo;
  }

  /** Remove a todo locally and its Google Task (if it was created yet). Returns false if unknown. */
  async removeTodo(accountId: string, todoId: string): Promise<boolean> {
    const todo = await this.repos.todos.getById(todoId);
    if (!todo || todo.accountId !== accountId) return false;
    await this.repos.todos.delete(todo.id);
    // Not created yet: the pending create_task op sees the todo is gone and skips (or cleans up).
    if (todo.googleTaskId && todo.tasklistId) {
      await this.enqueue(accountId, 'delete_task', {
        googleTaskId: todo.googleTaskId,
        tasklistId: todo.tasklistId,
      });
    }
    this.events.emit('todos.changed', { accountId });
    return true;
  }

  private async enqueue<K extends OutboxOpName>(
    accountId: string,
    op: K,
    payload: OutboxPayloads[K],
  ): Promise<void> {
    await this.repos.outbox.enqueue(accountId, op, payload);
    this.events.emit('outbox.enqueued', { accountId });
  }
}
