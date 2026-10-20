import { useQuery } from '@tanstack/react-query';
import { callTool } from './client';

export type WorkflowStatus =
  'previewing' | 'awaiting_approval' | 'active' | 'paused' | 'completed' | 'failed';
export type DecisionStatus = 'pending' | 'applied' | 'skipped' | 'undone' | 'failed';

export interface Workflow {
  id: string;
  name: string;
  type: 'label' | 'todo' | 'archive' | 'star_read' | 'document';
  mode: 'persistent' | 'one_shot';
  instruction: string;
  criteria: string;
  keywords: string[];
  senderFilter?: string;
  since?: string;
  action: {
    labelName?: string;
    todoTitle?: string;
    star?: boolean;
    markRead?: boolean;
    document?: WorkflowDocument;
  };
  status: WorkflowStatus;
  error?: string;
  createdAt: string;
  counts: Partial<Record<DecisionStatus, number>>;
}

export interface WorkflowDocument {
  format: 'sheet' | 'doc' | 'pdf';
  title: string;
  fields: { name: string; description: string }[];
  url?: string;
  pdfUrl?: string;
}

export const DOCUMENT_NAMES: Record<WorkflowDocument['format'], string> = {
  sheet: 'Google Sheet',
  doc: 'Google Doc',
  pdf: 'PDF',
};

export interface WorkflowDecision {
  messageId: string;
  threadId?: string;
  subject?: string;
  from?: string;
  date?: string;
  phase: 'backfill' | 'incremental';
  match: boolean;
  confidence: number;
  reason: string;
  status: DecisionStatus;
  error?: string;
  output?: Record<string, string>;
}

export function useWorkflows(enabled: boolean) {
  return useQuery({
    queryKey: ['workflows'],
    queryFn: () => callTool<Workflow[]>('list_workflows', {}),
    enabled,
  });
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    queryKey: ['workflows', id],
    queryFn: () =>
      callTool<{ workflow: Workflow; threshold: number; decisions: WorkflowDecision[] }>(
        'get_workflow',
        {
          workflowId: id,
          decisions: 'all',
          limit: 300,
        },
      ),
    enabled: !!id,
  });
}

export function actionText(w: Pick<Workflow, 'type' | 'action'>): string {
  switch (w.type) {
    case 'label':
      return `Label “${w.action.labelName}”`;
    case 'todo':
      return w.action.todoTitle ? `Todo “${w.action.todoTitle}”` : 'Add to Todos';
    case 'archive':
      return 'Archive';
    case 'star_read':
      return [w.action.star && 'Star', w.action.markRead && 'Mark read']
        .filter(Boolean)
        .join(' + ');
    case 'document':
      return `${DOCUMENT_NAMES[w.action.document!.format]} “${w.action.document!.title}”`;
  }
}
