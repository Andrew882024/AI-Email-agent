import type { EmailAddress } from '../api/types';

export function displayName(address: EmailAddress | undefined, self?: string): string {
  if (!address) return '(unknown)';
  if (self && address.email.toLowerCase() === self.toLowerCase()) return 'me';
  return address.name || address.email.split('@')[0] || address.email;
}

export const formatAddress = (a: EmailAddress) => (a.name ? `${a.name} <${a.email}>` : a.email);

/** "Alice, Bob, me" style list of senders, like Gmail. */
export function participantsLine(participants: EmailAddress[], self?: string, max = 3): string {
  const names = participants.map((p) => displayName(p, self));
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} …` : shown;
}

/** Time for today's mail, "Mar 4" this year, "3/4/25" otherwise. */
export function shortDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { year: '2-digit', month: 'numeric', day: 'numeric' });
}

export function longDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Split "a@x.com, Bob <b@y.com>" into address strings (commas inside quotes/brackets kept). */
export function splitRecipients(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (ch === '<') angle++;
    if (ch === '>') angle = Math.max(0, angle - 1);
    if ((ch === ',' || ch === ';') && !quoted && angle === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
