import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useMemory } from '../api/chat';
import { api } from '../api/client';
import { useUi } from '../store';
import { Button, IconButton, Spinner } from './ui';

/** What the assistant remembers about the user across chats; editable and deletable. */
export function MemoryDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const memory = useMemory(props.open);
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const [editing, setEditing] = useState<{ id: string; content: string }>();

  const refresh = () => qc.invalidateQueries({ queryKey: ['chat', 'memory'] });
  const save = async () => {
    if (!editing) return;
    try {
      await api(`/api/memory/${editing.id}`, {
        method: 'PATCH',
        body: { content: editing.content },
      });
      setEditing(undefined);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  };
  const remove = async (id: string) => {
    await api(`/api/memory/${id}`, { method: 'DELETE' }).catch((err: unknown) =>
      toast(err instanceof Error ? err.message : String(err), 'error'),
    );
    await refresh();
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white p-6 shadow-xl">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <Dialog.Title className="text-lg font-medium">
                What the assistant remembers
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-gray-600">
                Shared by all chats. It saves lasting preferences, facts about you and standing
                rules — not one-off requests or email contents.
              </Dialog.Description>
            </div>
            <IconButton label="Close" onClick={() => props.onOpenChange(false)}>
              <X className="h-[18px] w-[18px]" />
            </IconButton>
          </div>
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
            {memory.isLoading ? (
              <Spinner />
            ) : (memory.data ?? []).length === 0 ? (
              <p className="py-6 text-center text-sm text-gray-500">
                Nothing yet. Tell the assistant something like “always reply to me in Chinese”.
              </p>
            ) : (
              (memory.data ?? []).map((m) => (
                <div
                  key={m.id}
                  className="group flex items-start gap-2 border-b border-gray-100 py-2 text-sm"
                >
                  {editing?.id === m.id ? (
                    <div className="flex flex-1 flex-col gap-2">
                      <textarea
                        autoFocus
                        value={editing.content}
                        onChange={(e) => setEditing({ id: m.id, content: e.target.value })}
                        aria-label="Memory"
                        className="rounded-md border border-gray-300 p-2 outline-none focus:border-blue-600"
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          onClick={() => void save()}
                          disabled={!editing.content.trim()}
                        >
                          Save
                        </Button>
                        <Button onClick={() => setEditing(undefined)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="mt-0.5 shrink-0 rounded bg-gray-100 px-1.5 text-xs text-gray-600">
                        {m.category}
                      </span>
                      <span className="flex-1">{m.content}</span>
                      <span className="invisible flex group-hover:visible">
                        <IconButton
                          label="Edit"
                          onClick={() => setEditing({ id: m.id, content: m.content })}
                          className="h-7 w-7"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </IconButton>
                        <IconButton
                          label="Forget"
                          onClick={() => void remove(m.id)}
                          className="h-7 w-7"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </span>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
