import type { ChatMessageRole } from '../types.js';

const ROLE_COLORS: Record<ChatMessageRole, string> = {
  user: '\x1b[32m',      // green
  assistant: '\x1b[36m', // cyan
  tool: '\x1b[2m',       // dim
  system: '\x1b[33m',    // yellow
};

const RESET = '\x1b[0m';

export function roleColor(role: ChatMessageRole): string {
  return ROLE_COLORS[role] ?? '';
}

export function colorize(text: string, role: ChatMessageRole): string {
  return `${roleColor(role)}${text}${RESET}`;
}

export function roleLabel(role: ChatMessageRole): string {
  switch (role) {
    case 'user': return 'you';
    case 'assistant': return 'agent';
    case 'tool': return 'tool';
    case 'system': return 'system';
  }
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '\u2026';
}
