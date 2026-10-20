import { X } from 'lucide-react';
import { useEffect } from 'react';
import { type Toast, useUi } from '../store';

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useUi((s) => s.dismissToast);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), toast.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={`flex max-w-md items-center gap-3 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${toast.kind === 'error' ? 'bg-red-700' : 'bg-[#323232]'}`}
    >
      <span className="flex-1">{toast.message}</span>
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(toast.id)}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="fixed bottom-6 left-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
