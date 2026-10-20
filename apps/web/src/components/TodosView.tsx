import { CheckCircle2, Circle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTodos, useTool } from '../api/queries';
import { displayName, shortDate } from '../lib/format';
import { useUi } from '../store';
import { EmptyState, IconButton, Spinner } from './ui';

export function TodosView() {
  const todos = useTodos();
  const tool = useTool();
  const openThread = useUi((s) => s.openThread);
  const [tab, setTab] = useState<'needsAction' | 'completed'>('needsAction');
  const shown = (todos.data ?? []).filter((t) => t.status === tab);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-gray-100 px-4">
        {(['needsAction', 'completed'] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setTab(status)}
            className={`rounded-full px-4 py-1.5 text-sm ${tab === status ? 'bg-[#d3e3fd] font-medium' : 'text-gray-600 hover:bg-gray-100'}`}
          >
            {status === 'needsAction' ? 'Open' : 'Completed'}
          </button>
        ))}
        <span className="ml-auto text-xs text-gray-500">Synced with Google Tasks</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {todos.isLoading ? (
          <EmptyState>
            <Spinner />
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>
            {tab === 'needsAction'
              ? 'No open todos. Add one from any email.'
              : 'No completed todos.'}
          </EmptyState>
        ) : (
          shown.map((todo) => (
            <div
              key={todo.id}
              className="group flex items-center gap-3 border-b border-gray-100 px-4 py-3"
            >
              {todo.status === 'completed' ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" />
              ) : (
                <Circle className="h-5 w-5 shrink-0 text-gray-400" />
              )}
              <div className="min-w-0 flex-1">
                <div
                  className={`truncate text-sm ${todo.status === 'completed' ? 'text-gray-500 line-through' : 'font-medium'}`}
                >
                  {todo.title}
                </div>
                {todo.message && (
                  <button
                    type="button"
                    onClick={() => openThread(todo.message!.threadId)}
                    className="block max-w-full truncate text-xs text-blue-700 hover:underline"
                  >
                    {displayName(todo.message.from)} — {todo.message.subject || '(no subject)'}
                  </button>
                )}
              </div>
              {todo.due && (
                <span className="shrink-0 text-xs text-gray-600">Due {shortDate(todo.due)}</span>
              )}
              {!todo.googleTaskId && (
                <span className="shrink-0 text-xs text-gray-500">Syncing…</span>
              )}
              <IconButton
                label="Remove todo"
                onClick={() => tool.mutate({ name: 'remove_todo', input: { todoId: todo.id } })}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
