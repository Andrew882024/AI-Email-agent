import { useTool } from '../../api/queries';
import type { ThreadSummary } from '../../api/types';
import { useUi } from '../../store';

/** Add a todo for each thread, attached to its newest message. */
export function useAddTodos() {
  const tool = useTool();
  const toast = useUi((s) => s.toast);
  return async (threads: ThreadSummary[]) => {
    await Promise.all(
      threads.map((t) =>
        tool.mutateAsync({ name: 'add_todo', input: { messageId: t.messageIds.at(-1)! } }),
      ),
    ).then(
      () => toast(threads.length === 1 ? 'Added to Todos' : `Added ${threads.length} todos`),
      () => {}, // useTool already reported the error
    );
  };
}
