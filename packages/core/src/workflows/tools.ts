import { z } from 'zod';
import type { Repositories } from '../db/repositories.js';
import { defineTool, type ToolContext } from '../tools/registry.js';
import type { WorkflowEngine } from './engine.js';

const workflowId = z.string().min(1);

/** The chat session that created a workflow, when an agent did. */
const sessionOf = (ctx: ToolContext) =>
  ctx.actor.startsWith('agent:') ? ctx.actor.slice('agent:'.length) : undefined;

export function createWorkflowTools(engine: WorkflowEngine, repos: Repositories) {
  return [
    defineTool({
      name: 'create_workflow',
      description:
        'Create an email automation and run it once as a PREVIEW (nothing changes yet): candidates are found by ' +
        'meaning + keywords and the model decides each one. mode "persistent" keeps handling new mail after approval; ' +
        '"one_shot" is a one-time cleanup. Types: label (action.labelName), todo (optional action.todoTitle), archive, ' +
        'star_read (action.star and/or action.markRead). Show the user the criteria before creating, and the preview ' +
        'after; then call apply_workflow.',
      sideEffect: 'write',
      input: z.object({
        name: z.string().trim().min(1).max(100).describe('Short name, e.g. "Invoices → Bills"'),
        type: z.enum(['label', 'todo', 'archive', 'star_read']),
        mode: z.enum(['persistent', 'one_shot']).default('persistent'),
        instruction: z.string().min(1).describe("The user's request, in their words"),
        criteria: z
          .string()
          .min(10)
          .describe(
            'Which emails match and which do not, precisely (senders, topics, typical content, exclusions)',
          ),
        keywords: z
          .array(z.string().min(1))
          .max(15)
          .default([])
          .describe('Words/phrases that often appear in matching emails'),
        senderFilter: z
          .string()
          .optional()
          .describe('Only emails whose sender contains this (e.g. "linkedin.com")'),
        since: z.iso.date().optional().describe('Only emails received on/after YYYY-MM-DD'),
        action: z
          .object({
            labelName: z.string().optional(),
            todoTitle: z.string().optional(),
            star: z.boolean().optional(),
            markRead: z.boolean().optional(),
          })
          .default({}),
      }),
      handler: (ctx, i) =>
        engine.create(
          ctx.accountId,
          { ...i, since: i.since ? new Date(`${i.since}T00:00:00Z`) : undefined },
          sessionOf(ctx),
        ),
    }),
    defineTool({
      name: 'apply_workflow',
      description:
        'Apply a previewed workflow to its matching emails (asks the user to approve). Persistent workflows then handle new mail.',
      sideEffect: 'write',
      approval: 'always',
      approvalText: async (ctx, i) => {
        const workflow = await engine.own(ctx.accountId, i.workflowId);
        const pending = (await repos.workflows.counts(workflow.id)).pending ?? 0;
        const future = workflow.mode === 'persistent' ? ', and keep doing it for new mail' : '';
        return `apply workflow "${workflow.name}" to ${pending} emails${future}`;
      },
      input: z.object({ workflowId }),
      targets: (i) => [i.workflowId],
      handler: async (ctx, i) => {
        const result = await engine.apply(ctx.accountId, i.workflowId);
        const workflow = await engine.own(ctx.accountId, i.workflowId);
        return { ...result, status: workflow.status };
      },
    }),
    defineTool({
      name: 'list_workflows',
      description:
        'List the email automations with their status and how many emails each has changed.',
      sideEffect: 'read',
      input: z.object({}),
      handler: async (ctx) => {
        const workflows = await repos.workflows.list(ctx.accountId);
        return Promise.all(
          workflows.map(async (w) => ({ ...w, counts: await repos.workflows.counts(w.id) })),
        );
      },
    }),
    defineTool({
      name: 'get_workflow',
      description: 'A workflow with its decisions (which emails it matched or skipped, and why).',
      sideEffect: 'read',
      input: z.object({
        workflowId,
        decisions: z.enum(['matched', 'all']).default('matched'),
        limit: z.number().int().min(1).max(500).default(50),
      }),
      handler: async (ctx, i) => {
        const workflow = await engine.own(ctx.accountId, i.workflowId);
        const decisions = (
          await repos.workflows.decisions(workflow.id, {
            limit: i.decisions === 'all' ? i.limit : 5000,
          })
        )
          .filter((d) => i.decisions === 'all' || d.match)
          .slice(0, i.limit);
        const messages = new Map(
          (
            await repos.messages.getByIds(
              ctx.accountId,
              decisions.map((d) => d.messageId),
            )
          ).map((m) => [m.id, m]),
        );
        return {
          workflow,
          counts: await repos.workflows.counts(workflow.id),
          threshold: engine.threshold(workflow),
          decisions: decisions.map((d) => {
            const m = messages.get(d.messageId);
            return {
              ...d,
              threadId: m?.threadId,
              subject: m?.subject,
              from: m?.from?.name || m?.from?.email,
              date: m?.internalDate,
            };
          }),
        };
      },
    }),
    defineTool({
      name: 'pause_workflow',
      description: 'Pause a persistent workflow (new mail is no longer processed).',
      sideEffect: 'write',
      input: z.object({ workflowId }),
      targets: (i) => [i.workflowId],
      handler: (ctx, i) => engine.setPaused(ctx.accountId, i.workflowId, true),
    }),
    defineTool({
      name: 'resume_workflow',
      description: 'Resume a paused workflow.',
      sideEffect: 'write',
      input: z.object({ workflowId }),
      targets: (i) => [i.workflowId],
      handler: (ctx, i) => engine.setPaused(ctx.accountId, i.workflowId, false),
    }),
    defineTool({
      name: 'delete_workflow',
      description: 'Delete a workflow. Changes it already made stay; undo them first if needed.',
      sideEffect: 'write',
      input: z.object({ workflowId }),
      targets: (i) => [i.workflowId],
      handler: async (ctx, i) => {
        await engine.remove(ctx.accountId, i.workflowId);
        return { deleted: true };
      },
    }),
    defineTool({
      name: 'undo_workflow_decision',
      description:
        'Reverse what a workflow did to one email (remove the label, move back to inbox, ...).',
      sideEffect: 'write',
      input: z.object({ workflowId, messageId: z.string().min(1) }),
      targets: (i) => [i.messageId],
      handler: async (ctx, i) => {
        await engine.undo(ctx.accountId, i.workflowId, i.messageId, ctx.actor);
        return { undone: true };
      },
    }),
  ];
}
