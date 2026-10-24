import { showList } from '../../router/mail-params';
import { useWorkflows } from '../../state/workflows';
import { actionText } from '../../utils/workflows';
import { EmptyState } from '../ui/EmptyState';
import { Spinner } from '../ui/Spinner';
import { WorkflowState } from './WorkflowState';

/** Every automation the assistant runs on the mail, with what it matches and an on/off switch. */
export function WorkflowsView() {
  const workflows = useWorkflows();
  const open = (id: string) => showList({ kind: 'workflows', id });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-gray-100 px-4 text-sm text-gray-600">
        Rules the assistant runs on your mail. Ask it in chat to create one, e.g. “label all
        receipts as Receipts from now on”.
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {workflows.isLoading ? (
          <EmptyState>
            <Spinner />
          </EmptyState>
        ) : (workflows.data ?? []).length === 0 ? (
          <EmptyState>No workflows yet.</EmptyState>
        ) : (
          (workflows.data ?? []).map((w) => (
            <div
              key={w.id}
              role="button"
              tabIndex={0}
              onClick={() => open(w.id)}
              onKeyDown={(e) => e.key === 'Enter' && open(w.id)}
              className="flex cursor-pointer items-start gap-4 border-b border-gray-100 px-4 py-3 hover:bg-gray-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{w.name}</span>
                  <span className="shrink-0 text-xs text-gray-500">
                    {actionText(w)} · {w.mode === 'persistent' ? 'also new mail' : 'one time'} ·{' '}
                    {w.counts.applied ?? 0} changed
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm text-gray-700">
                  <span className="text-gray-500">Matches: </span>
                  {w.criteria}
                </p>
              </div>
              <div className="pt-0.5">
                <WorkflowState workflow={w} />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
