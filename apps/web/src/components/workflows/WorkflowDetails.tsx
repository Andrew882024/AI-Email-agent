import { ArrowLeft, ExternalLink, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { Workflow } from '../../api/workflows';
import { openThread, showList } from '../../router/mail-params';
import { useWorkflow, useWorkflowAction } from '../../state/workflows';
import { shortDate } from '../../utils/format';
import { actionText, DOCUMENT_NAMES } from '../../utils/workflows';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { IconButton } from '../ui/IconButton';
import { Spinner } from '../ui/Spinner';
import { WorkflowState } from './WorkflowState';

const backToList = () => showList({ kind: 'workflows' });

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-gray-500">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** What decides which emails match, editable while the workflow runs on new mail. */
function Criteria({ workflow }: { workflow: Workflow }) {
  const run = useWorkflowAction();
  const [editing, setEditing] = useState(false);
  const [criteria, setCriteria] = useState(workflow.criteria);
  const [keywords, setKeywords] = useState(workflow.keywords.join(', '));
  const editable =
    workflow.mode === 'persistent' &&
    (workflow.status === 'active' || workflow.status === 'paused');

  if (!editing) {
    return (
      <>
        <Row term="Matches">
          <div className="flex items-start gap-2">
            <p className="flex-1 whitespace-pre-wrap">{workflow.criteria}</p>
            {editable && (
              <IconButton label="Edit what it matches" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" />
              </IconButton>
            )}
          </div>
        </Row>
        {workflow.keywords.length > 0 && <Row term="Keywords">{workflow.keywords.join(', ')}</Row>}
      </>
    );
  }

  const save = () =>
    run.mutate(
      {
        tool: 'update_workflow',
        input: {
          workflowId: workflow.id,
          criteria: criteria.trim(),
          keywords: keywords
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: () => setEditing(false) },
    );
  return (
    <>
      <Row term="Matches">
        <textarea
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
          rows={4}
          aria-label="Which emails match"
          className="w-full rounded-lg border border-gray-300 bg-white p-2 outline-none focus:border-blue-500"
        />
      </Row>
      <Row term="Keywords">
        <input
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="Comma-separated"
          aria-label="Keywords"
          className="w-full rounded-lg border border-gray-300 bg-white px-2 py-1 outline-none focus:border-blue-500"
        />
      </Row>
      <dt />
      <dd className="flex items-center gap-2">
        <Button
          variant="primary"
          className="!px-3 !py-1 text-xs"
          disabled={run.isPending || criteria.trim().length < 10}
          onClick={save}
        >
          Save
        </Button>
        <Button className="!px-3 !py-1 text-xs" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <span className="text-gray-500">
          New mail is judged by this; emails it already changed stay as they are.
        </span>
      </dd>
    </>
  );
}

/** One workflow (/mail#workflows/<id>): what it matches and does, and every email it decided. */
export function WorkflowDetails({ id }: { id: string }) {
  const detail = useWorkflow(id);
  const run = useWorkflowAction();
  const [showSkipped, setShowSkipped] = useState(false);

  if (detail.isError) {
    return (
      <EmptyState>
        <span>
          This workflow no longer exists.{' '}
          <button type="button" onClick={backToList} className="text-blue-700 hover:underline">
            All workflows
          </button>
        </span>
      </EmptyState>
    );
  }
  if (!detail.data) {
    return (
      <EmptyState>
        <Spinner />
      </EmptyState>
    );
  }

  const { workflow, decisions, threshold, counts } = detail.data;
  const shown = decisions.filter((d) => showSkipped || d.status !== 'skipped');
  const doc = workflow.action.document;
  const docUrl = doc?.pdfUrl ?? doc?.url;
  // Rows can be removed from a Sheet; entries in a Doc/PDF can't be found reliably once edited.
  const canUndo = workflow.type !== 'document' || doc?.format === 'sheet';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-100 px-2">
        <IconButton label="All workflows" onClick={backToList}>
          <ArrowLeft className="h-[18px] w-[18px]" />
        </IconButton>
        <h2 className="flex-1 truncate font-medium">{workflow.name}</h2>
        <WorkflowState workflow={{ ...workflow, counts }} />
        <IconButton
          label="Delete workflow"
          onClick={() => {
            if (window.confirm(`Delete “${workflow.name}”? Changes it already made stay.`)) {
              run.mutate(
                { tool: 'delete_workflow', input: { workflowId: workflow.id } },
                { onSuccess: backToList },
              );
            }
          }}
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 rounded-lg bg-gray-50 p-3 text-sm">
          <Row term="Request">{workflow.instruction}</Row>
          <Criteria key={`${workflow.criteria}\n${workflow.keywords.join()}`} workflow={workflow} />
          {workflow.senderFilter && <Row term="Sender">contains “{workflow.senderFilter}”</Row>}
          <Row term="Action">
            {actionText(workflow)} · {workflow.mode === 'persistent' ? 'also new mail' : 'one time'}{' '}
            · acts at ≥ {Math.round(threshold * 100)}% confidence
          </Row>
          {doc && (
            <>
              <Row term="Fields">{doc.fields.map((f) => f.name).join(', ')}</Row>
              <Row term="Document">
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
              </Row>
            </>
          )}
          {workflow.error && (
            <>
              <dt className="text-red-700">Error</dt>
              <dd className="text-red-700">{workflow.error}</dd>
            </>
          )}
        </dl>
        <label className="mt-4 flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={showSkipped}
            onChange={() => setShowSkipped(!showSkipped)}
            className="accent-blue-600"
          />
          Show emails it decided not to change
        </label>
        <div className="mt-2">
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
    </div>
  );
}
