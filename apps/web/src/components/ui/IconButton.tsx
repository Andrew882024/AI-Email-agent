import { type ReactNode } from 'react';

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
