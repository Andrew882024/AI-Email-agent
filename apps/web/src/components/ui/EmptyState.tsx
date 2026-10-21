import { type ReactNode } from 'react';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-12 text-sm text-gray-500">
      {children}
    </div>
  );
}
