// Usage:
//   sync run                         background sync until Ctrl+C
//   sync once                        one pass: Gmail, outbox, Tasks
//   sync status                      sync state and counts
//   sync finish-full                 stop an unfinished full sync, keep what it synced
//   sync list [LABEL] [N]            newest messages (default INBOX, 10)
//   sync modify <messageId> [+LABEL|-LABEL ...]
//   sync todo add <messageId> <title...>
//   sync todo rm <todoId>
import { createCliContext } from './context.js';

const [command = 'status', ...args] = process.argv.slice(2);
const ctx = createCliContext();
const { repos, events } = ctx;

async function connectedAccount() {
  for (const account of await repos.accounts.list()) {
    if (await ctx.auth.isConnected(account.id)) return account;
  }
  throw new Error('No connected Google account. Run `pnpm auth login`.');
}

function printEvents() {
  events.on('sync.status', (s) =>
    console.log(
      `[sync] ${s.phase}${s.synced !== undefined ? ` (${s.synced} synced)` : ''}${s.error ? `: ${s.error}` : ''}`,
    ),
  );
  events.on('message.added', (e) => console.log(`[new] ${e.messageIds.length} message(s)`));
  events.on('message.updated', (e) => console.log(`[updated] ${e.messageIds.length} message(s)`));
  events.on('message.deleted', (e) => console.log(`[deleted] ${e.messageIds.length} message(s)`));
  events.on('labels.changed', () => console.log('[labels] changed'));
  events.on('todos.changed', () => console.log('[todos] changed'));
  events.on('outbox.failed', (e) => console.log(`[outbox] ${e.op} failed: ${e.error}`));
}

async function once(accountId: string) {
  const mail = await ctx.mailSync.sync(accountId);
  console.log('mail:', mail);
  console.log('outbox pushed:', await ctx.outbox.drain(accountId));
  console.log('tasks:', await ctx.tasksSync.sync(accountId));
}

async function main() {
  switch (command) {
    case 'run': {
      printEvents();
      await ctx.scheduler.start();
      console.log(`Syncing every ${ctx.config.sync.pollSeconds}s. Ctrl+C to stop.`);
      await new Promise<void>((resolve) => process.once('SIGINT', resolve));
      console.log('\nStopping…');
      await ctx.scheduler.stop();
      return;
    }
    case 'once': {
      printEvents();
      await repos.outbox.requeueInProgress();
      await once((await connectedAccount()).id);
      return;
    }
    case 'status': {
      const account = await connectedAccount();
      const state = await repos.syncState.get(account.id);
      const counts = await repos.messages.countByLabel(account.id);
      const pending = await repos.outbox.listActive(account.id);
      console.log(`${account.email}`);
      console.log(`  historyId:      ${account.historyId ?? '(full sync not finished)'}`);
      console.log(`  last full sync: ${account.lastFullSyncAt?.toISOString() ?? '-'}`);
      if (state.fullSync) console.log(`  full sync in progress: ${state.fullSync.synced} synced`);
      for (const label of ['INBOX', 'UNREAD', 'STARRED', 'SENT']) {
        console.log(
          `  ${label.padEnd(8)} ${counts[label]?.total ?? 0} (unread ${counts[label]?.unread ?? 0})`,
        );
      }
      console.log(`  outbox pending: ${pending.length}`);
      console.log(`  todos:          ${(await repos.todos.list(account.id)).length}`);
      return;
    }
    case 'finish-full': {
      const account = await connectedAccount();
      const finished = await ctx.mailSync.finishFullSyncEarly(account.id);
      console.log(
        finished
          ? '✓ Full sync finished early; incremental sync takes over.'
          : 'No full sync in progress.',
      );
      return;
    }
    case 'list': {
      const account = await connectedAccount();
      const [label = 'INBOX', n = '10'] = args;
      const { items } = await repos.messages.list(account.id, {
        labelIds: [label],
        limit: Number(n),
      });
      for (const m of items) {
        const flags = `${m.isRead ? ' ' : '●'}${m.isStarred ? '★' : ' '}`;
        console.log(
          `${flags} ${m.id}  ${m.internalDate.toISOString().slice(0, 10)}  ${(m.from?.name ?? m.from?.email ?? '').slice(0, 20).padEnd(20)}  ${m.subject.slice(0, 60)}`,
        );
        console.log(`     labels: ${m.labelIds.join(', ')}`);
      }
      return;
    }
    case 'modify': {
      const account = await connectedAccount();
      const [messageId, ...changes] = args;
      if (!messageId || changes.length === 0)
        throw new Error('Usage: sync modify <messageId> [+LABEL|-LABEL ...]');
      const add = changes.filter((c) => c.startsWith('+')).map((c) => c.slice(1));
      const remove = changes.filter((c) => c.startsWith('-')).map((c) => c.slice(1));
      await ctx.mailbox.modifyLabels(account.id, [messageId], { add, remove });
      console.log('local labels:', (await repos.messages.getById(account.id, messageId))?.labelIds);
      console.log('pushed to Gmail:', await ctx.outbox.drain(account.id));
      return;
    }
    case 'todo': {
      const account = await connectedAccount();
      const [sub, target, ...rest] = args;
      if (sub === 'add' && target && rest.length > 0) {
        const todo = await ctx.mailbox.addTodo(account.id, {
          messageId: target,
          title: rest.join(' '),
        });
        await ctx.outbox.drain(account.id);
        console.log('todo:', await repos.todos.getById(todo.id));
      } else if (sub === 'rm' && target) {
        console.log('removed:', await ctx.mailbox.removeTodo(account.id, target));
        await ctx.outbox.drain(account.id);
      } else {
        throw new Error('Usage: sync todo add <messageId> <title...> | sync todo rm <todoId>');
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command}"`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await ctx.db.destroy();
}
