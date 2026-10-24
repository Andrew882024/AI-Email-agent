import type { Label } from '../../api/mail';

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
