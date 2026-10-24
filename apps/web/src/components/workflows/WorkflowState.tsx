import type { WorkflowStatus, WorkflowSummary } from '../../api/workflows';
import { useWorkflowAction } from '../../state/workflows';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';

const STATUS: Record<WorkflowStatus, { text: string; className: string }> = {
  previewing: { text: 'Previewing…', className: 'bg-gray-100 text-gray-700' },
  awaiting_approval: { text: 'Needs approval', className: 'bg-amber-100 text-amber-900' },
  active: { text: 'On', className: 'bg-green-100 text-green-800' },
  paused: { text: 'Off', className: 'bg-gray-200 text-gray-700' },
  completed: { text: 'Done', className: 'bg-blue-100 text-blue-800' },
  failed: { text: 'Failed', className: 'bg-red-100 text-red-800' },
};

/**
 * Where a workflow stands, and the one thing to do about it: an on/off switch while it runs on new
 * mail, "Apply" while its preview awaits approval, otherwise just its status.
 */
export function WorkflowState({ workflow }: { workflow: WorkflowSummary }) {
  const run = useWorkflowAction();
  const input = { workflowId: workflow.id };

  if (workflow.status === 'active' || workflow.status === 'paused') {
    const on = workflow.status === 'active';
    return (
      <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <span className="w-6 text-xs text-gray-600">{on ? 'On' : 'Off'}</span>
        <Switch
          checked={on}
          label={on ? 'Turn off (stop handling new mail)' : 'Turn on (handle new mail again)'}
          disabled={run.isPending}
          onChange={(checked) =>
            run.mutate({ tool: checked ? 'resume_workflow' : 'pause_workflow', input })
          }
        />
      </span>
    );
  }
  if (workflow.status === 'awaiting_approval') {
    return (
      <span className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <StatusBadge status={workflow.status} />
        <Button
          variant="primary"
          className="!px-3 !py-1 text-xs"
          disabled={run.isPending}
          onClick={() => run.mutate({ tool: 'apply_workflow', input })}
        >
          Apply to {workflow.counts.pending ?? 0}
        </Button>
      </span>
    );
  }
  return <StatusBadge status={workflow.status} />;
}

function StatusBadge({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS[status].className}`}>
      {STATUS[status].text}
    </span>
  );
}
