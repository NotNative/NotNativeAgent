// SPDX-License-Identifier: Apache-2.0
import { estimateUtf8Tokens } from './context-budget.js';
import { ContractError } from '../ids.js';

// Invariant: JSON escaping and UTF-8 transport size do not become model text tokens.
export function estimateTokenValue(value) {
  const pending = [value]; let tokens = 0; let visited = 0;
  while (pending.length) {
    if (++visited > 1000000) throw new ContractError('context_too_large', 'context structure exceeds traversal capacity');
    const item = pending.pop();
    if (typeof item === 'string') tokens += estimateUtf8Tokens(item);
    else if (item === null || typeof item !== 'object') tokens += 1;
    else if (Array.isArray(item)) { tokens += 2; for (const entry of item) pending.push(entry); }
    else { tokens += 2; for (const [key, entry] of Object.entries(item)) { tokens += estimateUtf8Tokens(key) + 1; pending.push(entry); } }
  }
  return tokens;
}

export function boundedTokenText(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!Number.isSafeInteger(limit) || limit <= 0) return '';
  if (estimateUtf8Tokens(text) <= limit) return text;
  const marker = '\n...[context excerpt; full evidence remains in the session ledger]...\n';
  if (estimateUtf8Tokens(marker) > limit) return '';
  const available = Math.max(0, limit - estimateUtf8Tokens(marker));
  let low = 0; let high = text.length;
  // Bounded binary search preserves Unicode code points at both cut boundaries.
  for (let attempt = 0; attempt < 32 && low < high; attempt += 1) {
    const mid = Math.ceil((low + high) / 2);
    const head = text.slice(0, Math.floor(mid / 2)).replace(/[\uD800-\uDBFF]$/u, '');
    const tail = text.slice(text.length - Math.ceil(mid / 2)).replace(/^[\uDC00-\uDFFF]/u, '');
    if (estimateUtf8Tokens(head + tail) <= available) low = mid; else high = mid - 1;
  }
  return text.slice(0, Math.floor(low / 2)).replace(/[\uD800-\uDBFF]$/u, '') + marker
    + text.slice(text.length - Math.ceil(low / 2)).replace(/^[\uDC00-\uDFFF]/u, '');
}
