// SPDX-License-Identifier: Apache-2.0
/** Validate the atomic, renderer-local annotation image/text draft handoff. */
import type { DraftAttachment } from './drafts.ts';

export interface AnnotationTransfer {
  id: string; text: string; attachment: DraftAttachment; accept: () => void; repeat: boolean;
}

export function parseAnnotationTransfer(event: Event, attachments: DraftAttachment[],
  accepted: ReadonlySet<string>, targetKey: string): AnnotationTransfer | null {
  const detail = (event as CustomEvent<Record<string, unknown>>).detail;
  if (!detail || typeof detail.id !== 'string' || !/^[0-9a-f-]{36}$/u.test(detail.id)
    || detail.targetKey !== targetKey || typeof detail.accept !== 'function') return null;
  if (accepted.has(detail.id)) return { id: detail.id, text: '', attachment: { name: '', mime: '' },
    accept: detail.accept as () => void, repeat: true };
  const attachment = detail.attachment as DraftAttachment | undefined;
  if (typeof detail.text !== 'string' || !detail.text.startsWith('Page annotation ')
    || detail.text.length > 6000 || !attachment
    || typeof attachment.name !== 'string' || !/^browser-annotation-[0-9]+-[0-9a-f-]{36}\.jpg$/u.test(attachment.name)
    || attachment.mime !== 'image/jpeg' || typeof attachment.dataUrl !== 'string'
    || attachment.dataUrl.length > 205_000
    || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/u.test(attachment.dataUrl)
    || attachments.some((item) => item.name === attachment.name)) return null;
  return { id: detail.id, text: detail.text, attachment, accept: detail.accept as () => void, repeat: false };
}

interface HandoffState {
  targetKey: string;
  text: { current: string };
  attachments: { current: DraftAttachment[] };
  accepted: { current: Set<string> };
  editor: { current: HTMLTextAreaElement | null };
  persist: (text: string, attachments: DraftAttachment[]) => void;
  setText: (text: string) => void;
  setAttachments: (attachments: DraftAttachment[]) => void;
}

export function createAnnotationHandler(state: HandoffState): (event: Event) => void {
  return (event: Event): void => {
    const detail = parseAnnotationTransfer(event, state.attachments.current, state.accepted.current, state.targetKey);
    if (!detail) return;
    if (detail.repeat) { detail.accept(); return; }
    const nextAttachments = [...state.attachments.current, detail.attachment];
    const nextText = state.text.current ? `${state.text.current}\n\n${detail.text}` : detail.text;
    state.persist(nextText, nextAttachments);
    state.text.current = nextText;
    state.attachments.current = nextAttachments;
    state.setAttachments(nextAttachments);
    state.setText(nextText);
    state.accepted.current.add(detail.id);
    detail.accept();
    requestAnimationFrame(() => { state.editor.current?.focus(); state.editor.current?.setSelectionRange(nextText.length, nextText.length); });
  };
}
