// SPDX-License-Identifier: Apache-2.0
/** Display-only NNA evidence for navigator rows; never infer authority from busy state. */
import type { Session } from '../lib/nnd/types.ts';
import { nnaActiveToolsFromMetadata, nnaTurnPhaseFromMetadata } from './work-status.ts';

/** Only NNA-authored session metadata can assert attention here. */
export function sessionAttention(session: Session): string | null {
  const nnd = session.metadata?.nnd;
  if (!nnd || typeof nnd !== 'object' || Array.isArray(nnd)) return null;
  const evidence = nnd as Record<string, unknown>;
  if ((evidence.attention as { kind?: unknown } | undefined)?.kind === 'needs_input') return 'needs input';
  const phase = (evidence.turnState as { phase?: unknown } | undefined)?.phase;
  if (phase === 'awaiting_approval') return 'approval pending';
  if (phase === 'needs_input' || phase === 'attention_required') return 'needs input';
  if (phase === 'failed') return 'failed';
  return null;
}

/** Prefer a live NNA tool snapshot over a semantic phase that may linger
 * after a terminal tool event. No tool name is inferred from Activity history. */
export function sessionActivityPhrase(metadata: unknown): string | null {
  const tools = nnaActiveToolsFromMetadata(metadata);
  if (tools?.count) return `using ${tools.names[0]}${tools.count > 1 ? ` +${tools.count - 1}` : ''}`;
  const phase = nnaTurnPhaseFromMetadata(metadata);
  // The phase can remain running_tool until another engine state arrives;
  // an explicit empty live snapshot outranks that older phase.
  if (tools && phase === 'running_tool') return null;
  const labels: Record<string, string> = {
    preparing: 'preparing', waiting_provider: 'waiting for model', reasoning: 'reasoning',
    streaming: 'replying', running_tool: 'using tool', recovering: 'recovering', cancelling: 'stopping',
  };
  return phase ? labels[phase] ?? null : null;
}

export const childActivityPhrase = sessionActivityPhrase;
