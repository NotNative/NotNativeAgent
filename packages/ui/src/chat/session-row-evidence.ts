// SPDX-License-Identifier: Apache-2.0
/** Display-only NNA evidence for navigator rows; never infer authority from busy state. */
import type { Session } from '../lib/nnd/types.ts';
import { nnaTurnPhaseFromMetadata } from './work-status.ts';

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

/** NNA's enumerated phase is display evidence, not a transport-busy guess. */
export function childActivityPhrase(metadata: unknown): string | null {
  const phase = nnaTurnPhaseFromMetadata(metadata);
  const labels: Record<string, string> = {
    preparing: 'preparing', waiting_provider: 'waiting for model', reasoning: 'reasoning',
    streaming: 'replying', running_tool: 'using tool', recovering: 'recovering', cancelling: 'stopping',
  };
  return phase ? labels[phase] ?? null : null;
}
