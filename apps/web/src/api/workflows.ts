import { z } from 'zod';
import { callTool, IsoDate, optional } from './client';

// ---- shapes ----

export const WorkflowStatus = z.enum([
  'previewing',
  'awaiting_approval',
  'active',
  'paused',
  'completed',
  'failed',
]);
export type WorkflowStatus = z.output<typeof WorkflowStatus>;

export const DecisionStatus = z.enum(['pending', 'applied', 'skipped', 'undone', 'failed']);
export type DecisionStatus = z.output<typeof DecisionStatus>;

export const WorkflowDocument = z.object({
  format: z.enum(['sheet', 'doc', 'pdf']),
  title: z.string(),
  fields: z.array(z.object({ name: z.string(), description: z.string() })),
  url: optional(z.string()),
  pdfUrl: optional(z.string()),
});
export type WorkflowDocument = z.output<typeof WorkflowDocument>;

export const Workflow = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['label', 'todo', 'archive', 'star_read', 'document']),
  mode: z.enum(['persistent', 'one_shot']),
  instruction: z.string(),
  criteria: z.string(),
  keywords: z.array(z.string()),
  senderFilter: optional(z.string()),
  since: optional(IsoDate),
  action: z.object({
    labelName: optional(z.string()),
    todoTitle: optional(z.string()),
    star: optional(z.boolean()),
    markRead: optional(z.boolean()),
    document: optional(WorkflowDocument),
  }),
  status: WorkflowStatus,
  error: optional(z.string()),
  createdAt: IsoDate,
});
export type Workflow = z.output<typeof Workflow>;

const Counts = z.partialRecord(DecisionStatus, z.number());

export const WorkflowSummary = Workflow.extend({ counts: Counts });
export type WorkflowSummary = z.output<typeof WorkflowSummary>;

export const WorkflowDecision = z.object({
  messageId: z.string(),
  threadId: optional(z.string()),
  subject: optional(z.string()),
  from: optional(z.string()),
  date: optional(IsoDate),
  phase: z.enum(['backfill', 'incremental']),
  match: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
  status: DecisionStatus,
  error: optional(z.string()),
  output: optional(z.record(z.string(), z.string())),
});
export type WorkflowDecision = z.output<typeof WorkflowDecision>;

export const WorkflowDetail = z.object({
  workflow: Workflow,
  counts: Counts,
  threshold: z.number(),
  decisions: z.array(WorkflowDecision),
});
export type WorkflowDetail = z.output<typeof WorkflowDetail>;

// ---- requests (workflows are managed through server tools) ----

export const listWorkflows = () => callTool('list_workflows', {}, z.array(WorkflowSummary));

export const getWorkflow = (workflowId: string) =>
  callTool('get_workflow', { workflowId, decisions: 'all', limit: 300 }, WorkflowDetail);

export type WorkflowToolName =
  | 'apply_workflow'
  | 'pause_workflow'
  | 'resume_workflow'
  | 'update_workflow'
  | 'delete_workflow'
  | 'undo_workflow_decision';

/** Apply, pause, resume, edit or delete a workflow, or undo one of its decisions. */
export const runWorkflowTool = (name: WorkflowToolName, input: Record<string, unknown>) =>
  callTool(name, input, z.unknown());
