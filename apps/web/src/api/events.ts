// The server's live event stream. Stateless: it validates each event and hands it to the caller,
// who decides what to update.
import { z } from 'zod';
import { validate } from './client';
import { SyncPhase } from './sync';

export const SyncEvent = z.object({
  phase: SyncPhase,
  synced: z.number().optional(),
  error: z.string().optional(),
});
export type SyncEvent = z.output<typeof SyncEvent>;

export const OutboxFailedEvent = z.object({ op: z.string(), error: z.string() });
export type OutboxFailedEvent = z.output<typeof OutboxFailedEvent>;

export interface ServerEventHandlers {
  /** Mail was added, changed or deleted. */
  mail(): void;
  labels(): void;
  todos(): void;
  workflows(): void;
  sync(event: SyncEvent): void;
  outboxFailed(event: OutboxFailedEvent): void;
}

/** Listen to /api/events. Returns a function that closes the connection. */
export function connectServerEvents(handlers: ServerEventHandlers): () => void {
  const source = new EventSource('/api/events');
  const data = <S extends z.ZodType>(schema: S, event: Event, name: string) =>
    validate(schema, JSON.parse((event as MessageEvent<string>).data), `event ${name}`);
  const on = (name: string, handle: (event: Event) => void) =>
    source.addEventListener(name, (event) => {
      try {
        handle(event);
      } catch (err) {
        console.error(err); // a malformed event must not break the stream
      }
    });

  for (const name of ['message.added', 'message.updated', 'message.deleted'])
    on(name, () => handlers.mail());
  on('labels.changed', () => handlers.labels());
  on('todos.changed', () => handlers.todos());
  on('workflow.updated', () => handlers.workflows());
  on('sync.status', (e) => handlers.sync(data(SyncEvent, e, 'sync.status')));
  on('outbox.failed', (e) => handlers.outboxFailed(data(OutboxFailedEvent, e, 'outbox.failed')));
  return () => source.close();
}
