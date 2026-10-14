// SPDX-License-Identifier: Apache-2.0
/**
 * Composer delivery routes (doc 05 §B.9/§D.7/§F.4): the queue target, the
 * outbound send (session, shell, new-session materialization), the BTW send
 * state, and the busy-verified reroute behind an explicit render context, so
 * the composer stays under the per-file line budget.
 */
import { toast } from 'sonner';
import type { DirectoryStore } from '../sync/types.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { StoreApi } from 'zustand/vanilla';
import { saveDraft, readDraft, type DraftAttachment, type QueuedMessage } from './drafts.ts';
import { recordSend } from './input-history.ts';
import { handleQueuedTarget } from './composer-queue.ts';
import { deliverToNewSession } from './composer-draft-pins.ts';
import { btwSendStateFor } from './btw-org.ts';

export type OutgoingPart = { type: 'text'; text: string; synthetic?: boolean } | { type: 'file'; url?: string; filename?: string; mime?: string };

/** The engine subset delivery reaches through (the composer's services.engine). */
export interface DeliveryServices {
  engine: { actions: {
    send: SyncEngine['actions']['send'];
    runShell: SyncEngine['actions']['runShell'];
    createSession: SyncEngine['actions']['createSession'];
  } };
}

/** Built fresh in the component body each render — never memoized. */
export interface DeliveryContext {
  directory: string;
  sessionID: string | null;
  sessionKey: string;
  shell: boolean;
  text: string;
  attachments: DraftAttachment[];
  model: { providerID: string; modelID: string };
  sendAgent: string;
  nnaConfigured: boolean;
  services: DeliveryServices;
  store: StoreApi<DirectoryStore>;
  restoreSnapshot: { current: { text: string; attachments: DraftAttachment[] } };
  setText: (next: string) => void;
  setAttachments: (next: DraftAttachment[]) => void;
  persist: (nextText: string, nextAttachments: DraftAttachment[]) => void;
  setQueueChips: (chips: QueuedMessage[]) => void;
}

export interface DeliveryRoutes {
  /** One queue routing for §D.7 busy sends and the NNA busy-verified reroute. */
  queueNow: (composed: string) => Promise<void>;
  /** A busy refusal from NNA: queue behind the running turn, or keep the steer draft. */
  busyReroute: (composed: string, followUp: 'queue' | 'steer') => Promise<void>;
  /** Send failure returns the column to the submitted draft. */
  restoreDraft: () => void;
  deliver: (outgoing: OutgoingPart[], delivery: 'steer' | null) => Promise<void>;
  btwSendState: () => ReturnType<typeof btwSendStateFor>;
}

/** Send failure returns the column to the submitted draft. */
export function restoreDraft(ctx: DeliveryContext): void {
  ctx.setText(ctx.restoreSnapshot.current.text);
  ctx.setAttachments(ctx.restoreSnapshot.current.attachments);
}

/** One queue routing for §D.7 busy sends and the NNA busy-verified reroute. */
export async function queueNow(ctx: DeliveryContext, composed: string): Promise<void> {
  const { directory, sessionID, sessionKey, attachments, model, sendAgent } = ctx;
  if (attachments.length > 0) {
    toast.error('Wait for the current turn before sending attachments. Your draft is still here.');
    return;
  }
  await handleQueuedTarget({
    directory,
    sessionID,
    sessionKey,
    composed,
    liveQueue: readDraft(directory, sessionKey).queue,
    setQueueChips: ctx.setQueueChips,
    saveDraftQueue: (queue) => saveDraft(directory, sessionKey, { text: '', attachments: [], queue }),
    clearComposer: () => { ctx.setText(''); ctx.setAttachments([]); ctx.persist('', []); },
    restoreComposer: () => restoreDraft(ctx),
    sendConfig: { ...model, agent: sendAgent },
    recordHistory: () => recordSend({ directory, sessionID, text: composed, attachments: [], scope: 'session', attachmentTarget: 'scoped' }),
  });
}

/** A busy refusal from NNA: queue behind the running turn, or keep the steer draft. */
export async function busyReroute(ctx: DeliveryContext, composed: string, followUp: 'queue' | 'steer'): Promise<void> {
  // §B.9/§D.7: NNA's busy verdict is authoritative even when this view was
  // stale, and a definite refusal proves nothing landed — so the draft is
  // safe either way. The default follow-up (queue) re-routes through the
  // server-owned QUEUE, the distinct operation for a running turn; if that
  // rejects the item, handleQueuedTarget restores the composer itself.
  if (followUp === 'steer') {
    // Why: NNA's installed steer contract resolves child sessions only, so
    // a root-session steer refusal must NOT be re-labelled queue behind
    // the operator's back (doc 04: an unavailable capability is an open
    // parity dependency, not completion of steering). Preserve the draft.
    toast.error('Steer delivery was refused while NNA reports an active turn. Your draft is unchanged — queue it, steer a child session, or stop the turn first.');
    restoreDraft(ctx);
    return;
  }
  await queueNow(ctx, composed);
}

export async function deliver(ctx: DeliveryContext, outgoing: OutgoingPart[], delivery: 'steer' | null): Promise<void> {
  const { directory, sessionID, sessionKey, shell, text, model, sendAgent, nnaConfigured, services } = ctx;
  const target = sessionID;
  const payloadParts = outgoing.map((part) => part.type === 'file'
    ? ({ type: 'file' as const, url: part.url, filename: part.filename, mime: part.mime })
    : ({ type: 'text' as const, text: part.text, ...(part.synthetic ? { synthetic: true } : {}) }));
  const command = shell ? text.trim() : '';
  if (target && shell && command) {
    await services.engine.actions.runShell(target, command);
    return;
  }
  if (!target && shell && command) {
    // §B.3: shell mode text is a HARNESS-executed command — never model
    // input, and never the first message that materializes a session.
    toast.error('Open a session to run shell commands.');
    return;
  }
  if (target) {
    await services.engine.actions.send({ directory, sessionID: target, parts: payloadParts, model, agent: sendAgent, ...(delivery ? { delivery } : {}) });
    return;
  }
  await deliverToNewSession({ directory, sourceKey: sessionKey, outgoing: payloadParts,
    delivery, model, sendAgent, nnaConfigured, services });
}

export function btwSendState(ctx: DeliveryContext): ReturnType<typeof btwSendStateFor> {
  const { directory, sessionID, store } = ctx;
  const sessionMetadata = sessionID
    ? store.getState().session.find((entry) => entry.id === sessionID)?.metadata
    : undefined;
  return btwSendStateFor(directory, sessionID, sessionMetadata);
}

/** Binds one render's context to the delivery routes for the composer call sites. */
export function deliveryRoutes(ctx: DeliveryContext): DeliveryRoutes {
  return {
    queueNow: (composed) => queueNow(ctx, composed),
    busyReroute: (composed, followUp) => busyReroute(ctx, composed, followUp),
    restoreDraft: () => restoreDraft(ctx),
    deliver: (outgoing, delivery) => deliver(ctx, outgoing, delivery),
    btwSendState: () => btwSendState(ctx),
  };
}
