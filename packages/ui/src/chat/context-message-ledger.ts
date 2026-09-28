// SPDX-License-Identifier: Apache-2.0
/** Context ledger deliberately exposes message metadata, never part payloads. */
import type { Message, Part } from '../lib/nnd/types.ts';

export interface ContextMessageLedgerRow {
  id: string;
  role: 'user' | 'assistant';
  kinds: string;
  created: number | null;
  input: number | null;
  output: number | null;
}

const MAX_LEDGER_ROWS = 100;
const KNOWN_TYPES = ['reasoning', 'text', 'tool', 'file', 'step-start', 'step-finish'] as const;

function reportedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

/** Newest first. The cap is explicit in the UI; no message is claimed absent. */
export function contextMessageLedger(messages: readonly Message[], parts: Record<string, Part[]>): ContextMessageLedgerRow[] {
  return messages.slice(-MAX_LEDGER_ROWS).reverse().map((message) => {
    const types = new Set((parts[message.id] ?? []).map((part) => part.type));
    const kinds: string[] = KNOWN_TYPES.filter((type) => types.has(type));
    if ([...types].some((type) => !KNOWN_TYPES.includes(type as typeof KNOWN_TYPES[number]))) kinds.push('other');
    const tokens = message.role === 'assistant' ? message.tokens : undefined;
    return {
      id: message.id,
      role: message.role,
      kinds: kinds.length > 0 ? kinds.join(' + ') : 'no loaded parts',
      created: Number.isSafeInteger(message.time.created) && message.time.created > 0 && message.time.created <= 8_640_000_000_000_000
        ? message.time.created : null,
      input: reportedCount(tokens?.input),
      output: reportedCount(tokens?.output),
    };
  });
}

export { MAX_LEDGER_ROWS };
