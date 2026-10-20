import { Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import type { Label } from '../api/types';

export function IconButton(props: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick?.();
      }}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-gray-600 transition hover:bg-gray-200 disabled:opacity-40 disabled:hover:bg-transparent ${props.active ? 'bg-blue-100 text-blue-700' : ''} ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const style =
    props.variant === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700 disabled:bg-blue-300'
      : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 disabled:text-gray-400';
  return (
    <button
      type={props.type ?? 'button'}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition ${style} ${props.className ?? ''}`}
    >
      {props.children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      className={`animate-spin ${className ?? 'h-5 w-5 text-gray-400'}`}
      aria-label="Loading"
    />
  );
}

export function Checkbox(props: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!props.indeterminate;
  }, [props.indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={props.label}
      checked={props.checked}
      onChange={props.onChange}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 shrink-0 cursor-pointer accent-blue-600"
    />
  );
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span
      className="inline-block max-w-32 shrink-0 truncate rounded px-1.5 py-px text-xs font-normal"
      style={{
        background: label.color?.background ?? '#e8eaed',
        color: label.color?.text ?? '#3c4043',
      }}
    >
      {label.name}
    </span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-12 text-sm text-gray-500">
      {children}
    </div>
  );
}
