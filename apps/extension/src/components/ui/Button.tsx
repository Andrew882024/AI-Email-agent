import { type ReactNode } from 'react';

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
