import { EventEmitter } from 'node:events';
import type { Logger } from '../logging/system-logger.js';

export type SyncPhase = 'idle' | 'full_sync' | 'incremental' | 'error' | 'reauth_required';

/** Everything the app broadcasts. UI (via SSE) and, later, agent workflows subscribe to these. */
export interface AppEvents {
  'message.added': { accountId: string; messageIds: string[] };
  'message.updated': { accountId: string; messageIds: string[] };
  'message.deleted': { accountId: string; messageIds: string[] };
  'labels.changed': { accountId: string };
  'todos.changed': { accountId: string };
  'sync.status': {
    accountId: string;
    phase: SyncPhase;
    /** Messages stored so far in the current full sync. */
    synced?: number;
    error?: string;
  };
  /** Semantic index progress: `indexed` of `total` messages have a current embedding. */
  'index.status': {
    accountId: string;
    phase: 'indexing' | 'idle' | 'error';
    indexed?: number;
    total?: number;
    error?: string;
  };
  /** A local change was queued for Google; wakes the outbox worker. */
  'outbox.enqueued': { accountId: string };
  /** A queued change was given up on; local state has been reconciled with Google. */
  'outbox.failed': { accountId: string; op: string; error: string };
}

export type AppEventName = keyof AppEvents;
type Handler<K extends AppEventName> = (payload: AppEvents[K]) => void | Promise<void>;

/** Typed in-process pub/sub. Handler errors (sync or async) are logged, never propagated. */
export class EventBus {
  private readonly emitter = new EventEmitter({ captureRejections: false });

  constructor(private readonly logger?: Logger) {
    this.emitter.setMaxListeners(100);
  }

  on<K extends AppEventName>(event: K, handler: Handler<K>): () => void {
    const wrapped = (payload: AppEvents[K]) => {
      try {
        const result = handler(payload);
        if (result instanceof Promise) result.catch((err: unknown) => this.report(event, err));
      } catch (err) {
        this.report(event, err);
      }
    };
    this.emitter.on(event, wrapped);
    return () => this.emitter.off(event, wrapped);
  }

  emit<K extends AppEventName>(event: K, payload: AppEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  private report(event: string, err: unknown): void {
    this.logger?.error({ err, event }, 'event handler failed');
  }
}
