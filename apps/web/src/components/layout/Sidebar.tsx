import {
  Archive,
  CheckSquare,
  Inbox,
  Mail,
  Pencil,
  Send,
  Star,
  Tag,
  type LucideIcon,
} from 'lucide-react';
import { useLabels, useTodos } from '../../api/queries';
import type { Label, View } from '../../api/types';
import { type MailList, sameList, showList } from '../../router/mail-params';
import { useUi } from '../../store';

interface NavItem {
  list: MailList;
  name: string;
  icon: LucideIcon;
  count?: number;
  bold?: boolean;
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <button
      type="button"
      onClick={() => showList(item.list)}
      className={`flex h-8 w-full items-center gap-4 rounded-r-full pl-6 pr-4 text-sm ${active ? 'bg-[#d3e3fd] font-semibold text-[#041e49]' : 'text-gray-700 hover:bg-gray-200'}`}
    >
      <item.icon className="h-4 w-4 shrink-0" />
      <span className={`flex-1 truncate text-left ${item.bold ? 'font-semibold' : ''}`}>
        {item.name}
      </span>
      {!!item.count && <span className="text-xs font-semibold">{item.count.toLocaleString()}</span>}
    </button>
  );
}

/** Lists and labels; `list` is the one shown now (from the URL), highlighted. */
export function Sidebar({ list }: { list: MailList }) {
  const openCompose = useUi((s) => s.openCompose);
  const labels = useLabels();
  const todos = useTodos();
  const byId = new Map<string, Label>((labels.data ?? []).map((l) => [l.id, l]));
  const unread = (id: string) => byId.get(id)?.unread ?? 0;
  const mail = (view: View, name: string, icon: LucideIcon, count?: number): NavItem => ({
    list: { kind: 'view', view },
    name,
    icon,
    count,
    bold: !!count,
  });

  const items: NavItem[] = [
    mail('inbox', 'Inbox', Inbox, unread('INBOX')),
    mail('starred', 'Starred', Star),
    mail('sent', 'Sent', Send),
    mail('archived', 'Archived', Archive),
    mail('all', 'All Mail', Mail),
    {
      list: { kind: 'todos' },
      name: 'Todos',
      icon: CheckSquare,
      count: todos.data?.filter((t) => t.status === 'needsAction').length,
    },
  ];
  const userLabels = (labels.data ?? []).filter((l) => l.type === 'user');

  return (
    <nav className="flex w-64 shrink-0 flex-col overflow-y-auto pb-4">
      <div className="px-2 pb-4">
        <button
          type="button"
          onClick={() => openCompose({ mode: 'new' })}
          className="flex h-14 items-center gap-3 rounded-2xl bg-[#c2e7ff] px-5 font-medium text-[#001d35] shadow-sm transition hover:shadow-md"
        >
          <Pencil className="h-5 w-5" /> Compose
        </button>
      </div>
      {items.map((item) => (
        <NavRow key={item.name} item={item} active={sameList(item.list, list)} />
      ))}
      {userLabels.length > 0 && (
        <>
          <div className="mt-4 px-6 pb-1 text-sm font-medium text-gray-700">Labels</div>
          {userLabels.map((label) => (
            <NavRow
              key={label.id}
              item={{
                list: { kind: 'label', name: label.name },
                name: label.name,
                icon: Tag,
                count: label.unread,
                bold: label.unread > 0,
              }}
              active={sameList({ kind: 'label', name: label.name }, list)}
            />
          ))}
        </>
      )}
    </nav>
  );
}
