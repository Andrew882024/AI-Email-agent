import type { Workflow, WorkflowDocument } from '../api/workflows';

export const DOCUMENT_NAMES: Record<WorkflowDocument['format'], string> = {
  sheet: 'Google Sheet',
  doc: 'Google Doc',
  pdf: 'PDF',
};

/** What a workflow does, in a few words (e.g. Label “Bills”). */
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
