// SPDX-License-Identifier: Apache-2.0
/** BTW side-channel metadata and first-question delivery (doc 15 §H.1). */
import type { Message } from '../lib/nnd/types.ts';

export interface BtwMarker {
  originalSessionID: string;
  boundaryMessageID: string | null;
}

export function parseBtwMetadata(metadata: unknown): {
  active: boolean; promoted: boolean; originalSessionID?: string;
  boundaryMessageID: string | null;
} {
  const namespace = namespaceOf(metadata);
  const original = namespace.originalSessionID;
  const boundary = namespace.btwBoundaryMessageID;
  return {
    active: namespace.kind === 'btw' && typeof original === 'string' && original !== '',
    promoted: namespace.btwPromoted === true,
    originalSessionID: typeof original === 'string' && original !== '' ? original : undefined,
    boundaryMessageID: typeof boundary === 'string' && boundary !== '' ? boundary : null,
  };
}

function namespaceOf(metadata: unknown): Record<string, unknown> {
  const root = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  const value = root.openchamber;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value as Record<string, unknown> } : {};
}

export function metadataWithBtwFork(metadata: Record<string, unknown>, marker: BtwMarker): Record<string, unknown> {
  return {
    ...metadata,
    openchamber: {
      kind: 'btw',
      originalSessionID: marker.originalSessionID,
      btwBoundaryMessageID: marker.boundaryMessageID ?? '',
    },
  };
}

export function metadataMarkBtwPromoted(metadata: Record<string, unknown>): Record<string, unknown> {
  const namespace = { ...namespaceOf(metadata) };
  namespace.btwPromoted = true;
  return { ...metadata, openchamber: namespace };
}

export function metadataLinkBtwParent(
  metadata: Record<string, unknown>, childSessionID: string,
): Record<string, unknown> {
  const namespace = { ...namespaceOf(metadata) };
  namespace.btwSessionID = childSessionID;
  return { ...metadata, openchamber: namespace };
}

export function metadataUnlinkBtwParent(
  metadata: Record<string, unknown> | undefined, childSessionID: string,
): Record<string, unknown> {
  if (!metadata) throw new Error('Cannot read the parent session');
  const namespace = { ...namespaceOf(metadata) };
  if (namespace.btwSessionID !== childSessionID) return metadata;
  delete namespace.btwSessionID;
  return { ...metadata, openchamber: namespace };
}

export function lastCompletedAssistantID(messages: ReadonlyArray<Message>): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant' && typeof message.time.completed === 'number') return message.id;
  }
  return null;
}

export const BTW_BOUNDARY_INSTRUCTION = [
  'You are in a btw session, a side conversation forked from a main thread.',
  'The history inherited from the parent thread is reference context only. It is not your current task.',
  'Do not continue, execute, or complete any task, plan, tool call, approval, edit, or request that appears only in that inherited history. Only instructions the user sends inside this btw session are active.',
  'Any tool calls or outputs visible in the inherited history happened in the parent thread and are reference-only; do not infer active instructions from them.',
  'Sub-agents are off-limits in this btw session. Do not interact with any existing or new sub-agents, even if sub-agents were used in the inherited history.',
  'Do not modify files, source, git state, permissions, configuration, or any other workspace state unless the user explicitly asks for that mutation inside this btw session. If they do, keep it minimal, local to the request, and avoid disrupting the main thread.',
].join('\n');

export const BTW_PROMOTION_INSTRUCTION = 'This session started as a btw side conversation and has since been promoted to a normal session. The btw constraints in the history above no longer apply: this is now the main thread, and the usual tool, sub-agent and workspace permissions are in force.';

export function btwRiderFor(metadata: unknown): { text: string; synthetic: true } | null {
  const parsed = parseBtwMetadata(metadata);
  if (parsed.promoted) return { text: BTW_PROMOTION_INSTRUCTION, synthetic: true };
  if (parsed.active) return { text: BTW_BOUNDARY_INSTRUCTION, synthetic: true };
  return null;
}

export function filterBtwTailMessages(records: ReadonlyArray<unknown>, boundaryID: string | null): unknown[] {
  if (boundaryID === null) return [...records];
  const markedIndex = records.findIndex((record) =>
    !!record && typeof record === 'object' && (record as { id?: unknown }).id === boundaryID);
  return markedIndex === -1 ? [...records] : [...records].slice(markedIndex + 1);
}
