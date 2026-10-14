// SPDX-License-Identifier: Apache-2.0
/**
 * Composer attachment + send-failure helpers (P9-4e-ii file-split out of
 * composer.tsx): data-url reading for direct sends, name dedupe for the
 * attachment chips, and the send-failure toasts (restore rhetoric per
 * send-planner's error kinds).
 */
import { toast } from 'sonner';
import { sendErrorKind } from './send-planner.ts';
import type { DraftAttachment } from './drafts.ts';

/** 1 MB per-file read gate: oversize files skip the dataUrl (the send
 * fails fast with the fs-surface note instead of a giant payload). */
export async function fileToDataUrl(file: File): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolvePromise, rejectPromise) => {
    reader.onload = () => resolvePromise(String(reader.result));
    reader.onerror = () => rejectPromise(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

export function dedupeNames(list: DraftAttachment[]): DraftAttachment[] {
  const seen = new Set<string>();
  return list.filter((a) => (seen.has(a.name) ? false : (seen.add(a.name), true)));
}

export function describeSendFailure(error: unknown, hadAttachments: boolean): void {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:NNA is attached to |NNA workspace identity is unavailable|NNA created session )/u.test(message)) {
    toast.error(message);
    return;
  }
  const kind = sendErrorKind(error);
  if (kind === 'runtime-changed') toast.error('Message failed to send. Attachments restored.');
  else if (kind === 'payload-too-large') toast.error('Attachments are too large to send. Trim the batch and try again.');
  // Why: NNA refused the submission because the session already runs a turn;
  // say so with the exact recovery (the draft is still in the composer and the
  // queue/stop controls own the next move), never a generic failure.
  else if (kind === 'busy') toast.error('NNA refused the message: the session is running a turn. Your draft is unchanged — queue it, steer, or stop the turn first.');
  else toast.error(hadAttachments ? 'Message failed to send. Attachments restored.' : 'Message failed to send. Your text was restored.');
}
