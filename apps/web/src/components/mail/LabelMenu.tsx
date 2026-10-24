import * as Dialog from '@radix-ui/react-dialog';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, Minus, Plus, Tag } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useCreateLabel, useLabels, useMailTool } from '../../state/mail';
import { useToast } from '../../state/ui';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';

/** Apply/remove user labels on a set of messages (a thread or a selection of threads). */
export function LabelMenu({
  messageIds,
  labelIds,
}: {
  messageIds: string[];
  labelIds: string[][];
}) {
  const labels = useLabels();
  const tool = useMailTool();
  const [creating, setCreating] = useState(false);
  const userLabels = (labels.data ?? []).filter((l) => l.type === 'user');

  return (
    <>
      <Menu.Root>
        <Menu.Trigger asChild>
          <span>
            <IconButton label="Labels" disabled={messageIds.length === 0}>
              <Tag className="h-[18px] w-[18px]" />
            </IconButton>
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            align="start"
            sideOffset={4}
            className="z-50 max-h-96 min-w-56 overflow-y-auto rounded-xl border bg-white p-1 shadow-lg"
          >
            <div className="px-3 py-2 text-xs font-medium text-gray-500">Label as</div>
            {userLabels.map((label) => {
              const count = labelIds.filter((ids) => ids.includes(label.id)).length;
              const all = count > 0 && count === labelIds.length;
              return (
                <Menu.Item
                  key={label.id}
                  onSelect={() =>
                    tool.mutate({
                      name: all ? 'remove_label' : 'add_label',
                      input: { messageIds, label: label.id },
                    })
                  }
                  className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm outline-none hover:bg-gray-100"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded border border-gray-400">
                    {all ? (
                      <Check className="h-3 w-3" />
                    ) : count > 0 ? (
                      <Minus className="h-3 w-3" />
                    ) : null}
                  </span>
                  <span className="truncate">{label.name}</span>
                </Menu.Item>
              );
            })}
            <Menu.Separator className="my-1 h-px bg-gray-200" />
            <Menu.Item
              onSelect={() => setCreating(true)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm outline-none hover:bg-gray-100"
            >
              <Plus className="h-4 w-4" /> Create new label
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <CreateLabelDialog open={creating} onOpenChange={setCreating} applyTo={messageIds} />
    </>
  );
}

function CreateLabelDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applyTo: string[];
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const tool = useMailTool();
  const toast = useToast();
  const createLabel = useCreateLabel();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const label = await createLabel.mutateAsync(name.trim());
      if (props.applyTo.length > 0)
        tool.mutate({ name: 'add_label', input: { messageIds: props.applyTo, label: label.id } });
      toast(`Label "${label.name}" created`);
      setName('');
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-96 -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-xl">
          <Dialog.Title className="text-lg font-medium">New label</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-gray-600">
            Use “/” to nest it under another label.
          </Dialog.Description>
          <form onSubmit={submit} className="mt-4 flex flex-col gap-4">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Label name"
              aria-label="Label name"
              className="rounded-md border border-gray-300 px-3 py-2 outline-none focus:border-blue-600"
            />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={() => props.onOpenChange(false)}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
                Create
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
