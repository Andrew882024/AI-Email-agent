import { Bot, Send, X } from 'lucide-react';
import { useUi } from '../store';
import { IconButton } from './ui';

/** Docked assistant panel. The agent is connected in a later phase; this is the shell. */
export function ChatPanel() {
  const toggleChat = useUi((s) => s.toggleChat);
  return (
    <aside
      aria-label="Assistant"
      className="mb-2 mr-2 flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl bg-white"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-100 pl-4 pr-1">
        <Bot className="h-5 w-5 text-blue-600" />
        <span className="flex-1 font-medium">Assistant</span>
        <IconButton label="Close assistant" onClick={toggleChat}>
          <X className="h-[18px] w-[18px]" />
        </IconButton>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="rounded-2xl rounded-tl-sm bg-[#f2f6fc] px-4 py-3 text-sm text-gray-700">
          Hi! Soon I'll be able to answer questions about your mail, help draft replies, and run
          workflows that sort, label and archive new email for you. The assistant isn't connected
          yet.
        </div>
      </div>
      <footer className="border-t border-gray-100 p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-gray-300 px-3 py-2 opacity-60">
          <textarea
            disabled
            rows={2}
            placeholder="Ask about your email…"
            aria-label="Message the assistant"
            className="flex-1 resize-none bg-transparent text-sm outline-none"
          />
          <IconButton label="Send" disabled>
            <Send className="h-4 w-4" />
          </IconButton>
        </div>
      </footer>
    </aside>
  );
}
