import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Pause, Play, RotateCcw, Trash2, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { callTool } from '../../api/client';
import {
  actionText,
  DOCUMENT_NAMES,
  useWorkflow,
  useWorkflows,
  type Workflow,
  type WorkflowStatus,
} from '../../api/workflows';
import { shortDate } from '../../lib/format';
import { useUi } from '../../store';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Spinner } from '../ui/Spinner';
import { openThread } from '../../router/mail-params';

const STATUS: Record<WorkflowStatus, { text: string; className: string }> = {
  previewing: { text: 'Previewing…', className: 'bg-gray-100 text-gray-700' },
  awaiting_approval: { text: 'Needs approval', className: 'bg-amber-100 text-amber-900' },
  active: { text: 'Active', className: 'bg-green-100 text-green-800' },
  paused: { text: 'Paused', className: 'bg-gray-200 text-gray-700' },
  completed: { text: 'Done', className: 'bg-blue-100 text-blue-800' },
  failed: { text: 'Failed', className: 'bg-red-100 text-red-800' },
};

function useWorkflowAction() {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  return useMutation({
    mutationFn: ({ tool, input }: { tool: string; input: Record<string, unknown> }) =>
      callTool(tool, input),
    onError: (err) => toast(err instanceof Error ? err.message : String(err), 'error'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['workflows'] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void qc.invalidateQueries({ queryKey: ['labels'] });
      void qc.invalidateQueries({ queryKey: ['todos'] });
    },
  });
}

function Controls({ workflow, onDeleted }: { workflow: Workflow; onDeleted?: () => void }) {
  const run = useWorkflowAction();
  const id = { workflowId: workflow.id };
  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {workflow.status === 'awaiting_approval' && (
        <Button
          variant="primary"
          className="!px-3 !py-1 text-xs"
          disabled={run.isPending}
          onClick={() => run.mutate({ tool: 'apply_workflow', input: id })}
        >
          Apply to {workflow.counts.pending ?? 0}
        </Button>
      )}
      {workflow.status === 'active' && (
        <IconButton label="Pause" onClick={() => run.mutate({ tool: 'pause_workflow', input: id })}>
          <Pause className="h-4 w-4" />
        </IconButton>
      )}
      {workflow.status === 'paused' && (
        <IconButton
          label="Resume"
          onClick={() => run.mutate({ tool: 'resume_workflow', input: id })}
        >
          <Play className="h-4 w-4" />
        </IconButton>
      )}
      <IconButton
        label="Delete workflow"
        onClick={() => {
          if (window.confirm(`Delete “${workflow.name}”? Changes it already made stay.`)) {
            run.mutate({ tool: 'delete_workflow', input: id }, { onSuccess: onDeleted });
          }
        }}
      >
        <Trash2 className="h-4 w-4" />
      </IconButton>
    </div>
  );
}

function Details({ id, onBack }: { id: string; onBack: () => void }) {
  const detail = useWorkflow(id);
  const run = useWorkflowAction();
  const [showSkipped, setShowSkipped] = useState(false);
  if (detail.isLoading || !detail.data) return <Spinner />;
  const { workflow, decisions, threshold } = detail.data;
  const shown = decisions.filter((d) => showSkipped || d.status !== 'skipped');
  const doc = workflow.action.document;
  const docUrl = doc?.pdfUrl ?? doc?.url;
  // Rows can be removed from a Sheet; entries in a Doc/PDF can't be found reliably once edited.
  const canUndo = workflow.type !== 'document' || doc?.format === 'sheet';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2">
        <IconButton label="Back" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </IconButton>
        <h3 className="flex-1 truncate font-medium">{workflow.name}</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[workflow.status].className}`}>
          {STATUS[workflow.status].text}
        </span>
        <Controls
          workflow={{
            ...workflow,
            counts: detail.data.decisions.reduce(
              (c, d) => ({ ...c, [d.status]: (c[d.status] ?? 0) + 1 }),
              {} as Workflow['counts'],
            ),
          }}
          onDeleted={onBack}
        />
      </div>
      <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 rounded-lg bg-gray-50 p-3 text-xs">
        <dt className="text-gray-500">Request</dt>
        <dd>{workflow.instruction}</dd>
        <dt className="text-gray-500">Matches</dt>
        <dd>{workflow.criteria}</dd>
        {workflow.keywords.length > 0 && (
          <>
            <dt className="text-gray-500">Keywords</dt>
            <dd>{workflow.keywords.join(', ')}</dd>
          </>
        )}
        {workflow.senderFilter && (
          <>
            <dt className="text-gray-500">Sender</dt>
            <dd>contains “{workflow.senderFilter}”</dd>
          </>
        )}
        <dt className="text-gray-500">Action</dt>
        <dd>
          {actionText(workflow)} · {workflow.mode === 'persistent' ? 'also new mail' : 'one time'} ·
          acts at ≥ {Math.round(threshold * 100)}% confidence
        </dd>
        {doc && (
          <>
            <dt className="text-gray-500">Fields</dt>
            <dd>{doc.fields.map((f) => f.name).join(', ')}</dd>
            <dt className="text-gray-500">Document</dt>
            <dd>
              {docUrl ? (
                <a
                  href={docUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-blue-700 hover:underline"
                >
                  Open {DOCUMENT_NAMES[doc.format]} <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-gray-500">
                  Created in the “AI Email Agent” Drive folder when you apply
                </span>
              )}
            </dd>
          </>
        )}
        {workflow.error && (
          <>
            <dt className="text-red-700">Error</dt>
            <dd className="text-red-700">{workflow.error}</dd>
          </>
        )}
      </dl>
      <label className="mt-3 flex items-center gap-2 text-xs text-gray-600">
        <input
          type="checkbox"
          checked={showSkipped}
          onChange={() => setShowSkipped(!showSkipped)}
          className="accent-blue-600"
        />
        Show emails it decided not to change
      </label>
      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && (
          <p className="py-6 text-center text-sm text-gray-500">No decisions yet.</p>
        )}
        {shown.map((d) => (
          <div
            key={d.messageId}
            className="flex items-start gap-2 border-b border-gray-100 py-2 text-sm"
          >
            <span
              className={`mt-0.5 w-16 shrink-0 rounded px-1.5 text-center text-[11px] ${d.status === 'applied' ? 'bg-green-100 text-green-800' : d.status === 'pending' ? 'bg-amber-100 text-amber-900' : d.status === 'failed' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}
            >
              {d.status}
            </span>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => d.threadId && openThread(d.threadId)}
                className="block max-w-full truncate text-left hover:underline"
              >
                {d.subject || '(no subject)'}
              </button>
              <div className="truncate text-xs text-gray-500">
                {d.from} · {d.date && shortDate(d.date)} · {Math.round(d.confidence * 100)}% ·{' '}
                {d.reason}
                {d.phase === 'incremental' && ' · new mail'}
              </div>
              {d.output && d.status !== 'skipped' && (
                <div className="truncate text-xs text-gray-700">
                  {/* In the workflow's field order (stored JSON doesn't keep key order). */}
                  {(doc?.fields.map((f) => f.name) ?? Object.keys(d.output))
                    .map((k) => `${k}: ${d.output?.[k] || '—'}`)
                    .join(' · ')}
                </div>
              )}
            </div>
            {d.status === 'applied' && canUndo && (
              <IconButton
                label="Undo for this email"
                onClick={() =>
                  run.mutate({
                    tool: 'undo_workflow_decision',
                    input: { workflowId: workflow.id, messageId: d.messageId },
                  })
                }
              >
                <RotateCcw className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Mail automations created with the assistant: status, approval, pause, decisions and undo. */
export function WorkflowsDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const workflows = useWorkflows(props.open);
  const [selected, setSelected] = useState<string>();

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(open) => (props.onOpenChange(open), setSelected(undefined))}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex h-[80vh] w-[720px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white p-6 shadow-xl">
          <div className="mb-3 flex items-start gap-2">
            <Zap className="mt-1 h-5 w-5 text-blue-600" />
            <div className="flex-1">
              <Dialog.Title className="text-lg font-medium">Workflows</Dialog.Title>
              <Dialog.Description className="text-sm text-gray-600">
                Rules the assistant runs on your mail. Ask it in chat to create one, e.g. “label all
                receipts as Receipts from now on”.
              </Dialog.Description>
            </div>
            <IconButton label="Close" onClick={() => props.onOpenChange(false)}>
              <X className="h-[18px] w-[18px]" />
            </IconButton>
          </div>
          {selected ? (
            <Details id={selected} onBack={() => setSelected(undefined)} />
          ) : workflows.isLoading ? (
            <Spinner />
          ) : (workflows.data ?? []).length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-500">No workflows yet.</p>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {(workflows.data ?? []).map((w) => (
                <div
                  key={w.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelected(w.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setSelected(w.id)}
                  className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-2 py-3 hover:bg-gray-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{w.name}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS[w.status].className}`}
                      >
                        {STATUS[w.status].text}
                      </span>
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      {actionText(w)} · {w.mode === 'persistent' ? 'also new mail' : 'one time'} ·{' '}
                      {w.counts.applied ?? 0} changed
                      {w.counts.pending ? ` · ${w.counts.pending} awaiting approval` : ''}
                    </div>
                  </div>
                  <Controls workflow={w} />
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex justify-end">
            <Button onClick={() => props.onOpenChange(false)}>Close</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
