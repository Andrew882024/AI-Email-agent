import type { Db } from '../connection.js';
import type { Repositories } from '../repositories.js';
import { PgAccountRepository } from './account-repository.js';
import { PgActionLogRepository } from './action-log-repository.js';
import { PgLabelRepository } from './label-repository.js';
import { PgMessageRepository } from './message-repository.js';
import { PgOutboxRepository } from './outbox-repository.js';
import { PgTodoRepository } from './todo-repository.js';

export function createPgRepositories(db: Db): Repositories {
  return {
    accounts: new PgAccountRepository(db),
    labels: new PgLabelRepository(db),
    messages: new PgMessageRepository(db),
    todos: new PgTodoRepository(db),
    outbox: new PgOutboxRepository(db),
    actionLogs: new PgActionLogRepository(db),
  };
}
