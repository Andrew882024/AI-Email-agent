import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getWorkflow,
  listWorkflows,
  runWorkflowTool,
  type WorkflowToolName,
} from '../api/workflows';
import { useUi } from './store';

export function useWorkflows() {
  return useQuery({ queryKey: ['workflows'], queryFn: listWorkflows });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: ['workflows', id],
    queryFn: () => getWorkflow(id!),
    enabled: !!id,
  });
}

/** Apply/pause/resume/edit/delete a workflow or undo a decision; what it touched reloads. */
export function useWorkflowAction() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: ({ tool, input }: { tool: WorkflowToolName; input: Record<string, unknown> }) =>
      runWorkflowTool(tool, input),
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'error'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['labels'] });
      void qc.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}
