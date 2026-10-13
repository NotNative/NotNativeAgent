// SPDX-License-Identifier: Apache-2.0
/**
 * @vitest-environment jsdom
 * Inline comment controller gates (doc 06 §10.2 v1): save appends a draft
 * with code extracted from the SAME content snapshot and focuses the chat
 * input on creation; edit updates (no re-focus); delete removes; outside
 * mousedown cancels only while the input text is empty; a MISSING session
 * target (null) surfaces the exact toast string and saves nothing, while
 * the open new-session draft ('draft') is a valid §10.1 target.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';

import { beginCommentFromSelection, InlineComments } from '../InlineComments.tsx';
import { useInlineCommentController, type InlineCommentController } from '../controller.ts';
import { I18nProvider } from '../../I18nProvider.tsx';
import { __resetDraftsForTests, draftKeyFor, useInlineCommentDrafts } from '../../../lib/comments/drafts.ts';
import { useSessionViewStore } from '../../../sync/view-store.ts';
import { FOCUS_EVENT_NAME } from '../focus-chat.ts';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONTENT = 'alpha\nbravo charlie\ndelta\nepsilon\n';
const DIRECTORY = '/repo';

let controllerRef: InlineCommentController | null = null;
let rootHandle: Root | null = null;
let container: HTMLDivElement | null = null;
let focusEvents = 0;
let swapMutable: ((patch: { directory?: string; content?: string }) => void) | null = null;

function draftsFor(sessionKey: string): { text: string; startLine: number; endLine: number; code: string }[] {
  const store = useInlineCommentDrafts.getState().store[draftKeyFor(DIRECTORY, sessionKey)]?.drafts ?? [];
  return store.map((draft) => ({ text: draft.text, startLine: draft.startLine, endLine: draft.endLine, code: draft.code }));
}

function CommentHost(props: { sessionKey: string | null; content?: string; directory?: string }): ReactNode {
  const comments = useInlineCommentController({
    directory: props.directory ?? DIRECTORY,
    sessionKey: props.sessionKey,
    source: 'file',
    fileLabel: 'a.ts',
    language: '',
    content: props.content ?? CONTENT,
  });
  controllerRef = comments;
  return <InlineComments controller={comments} hostId="files" />;
}

function LiveSessionHost(): ReactNode {
  const current = useSessionViewStore((state) => state.currentSessionId);
  return <CommentHost sessionKey={current ?? 'draft'} />;
}

/** Mutable host for slot/content drift scenarios while the input is open:
 * a content swap mimics FilesView's confirmed-external-change reload; a
 * directory swap moves the draft save target. */
function MutableHost(): ReactNode {
  const current = useSessionViewStore((state) => state.currentSessionId);
  const [mutable, setMutable] = useState({ directory: DIRECTORY, content: CONTENT });
  swapMutable = (patch) => setMutable((prev) => ({ ...prev, ...patch }));
  return <CommentHost sessionKey={current ?? 'draft'} directory={mutable.directory} content={mutable.content} />;
}

function NullSessionHost(): ReactNode {
  return <CommentHost sessionKey={null} />;
}

function onComposerFocus(): void {
  focusEvents += 1;
}

beforeEach(() => {
  __resetDraftsForTests();
  window.__NOTNATIVE_RUNTIME_KEY__ = undefined;
  document.body.innerHTML = '';
  focusEvents = 0;
  useSessionViewStore.setState({ currentSessionId: 'ses_live', activeDirectory: DIRECTORY });
  window.addEventListener(FOCUS_EVENT_NAME, onComposerFocus);
});

afterEach(() => {
  try {
    act(() => rootHandle?.unmount());
  } finally {
    window.removeEventListener(FOCUS_EVENT_NAME, onComposerFocus);
    container?.remove();
    container = null;
    rootHandle = null;
    controllerRef = null;
    swapMutable = null;
  }
});

async function renderHost(host: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  rootHandle = createRoot(container);
  await act(async () => {
    rootHandle!.render(<I18nProvider>{host}</I18nProvider>);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function typeInput(text: string): Promise<void> {
  const field = document.querySelector('[data-comment-input] textarea') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(node: Element): Promise<void> {
  await act(async () => {
    (node as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectFocusEvents(count: number): void {
  expect(focusEvents).toBe(count);
}

describe('inline comment controller (doc 06 §10.2 v1)', () => {
  it('save appends the draft with extracted code and focuses the chat input on creation', async () => {
    await renderHost(<LiveSessionHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 6, end: 19 }, controllerRef!.begin);
    });
    expect(document.querySelector('[data-comment-input]')).not.toBeNull();
    expect(document.querySelector('[data-testid="comment-lines"]')?.textContent).toBe('Lines 2-2'); // 1-based display, 0-based storage
    await typeInput('  looks off  ');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    expect(draftsFor('ses_live')).toEqual([
      { text: 'looks off', startLine: 1, endLine: 1, code: 'bravo charlie' },
    ]);
    expectFocusEvents(1); // §10.2 #4: focusChatInput on creation only
    expect(document.querySelector('[data-comment-input]')).toBeNull();
    expect(document.querySelectorAll('[data-comment-card]')).toHaveLength(1);
  });

  it('edit rewrites the same draft (no duplicate) without re-focusing the composer', async () => {
    await renderHost(<LiveSessionHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 5 }, controllerRef!.begin);
    });
    await typeInput('first wording');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    const slot = draftKeyFor(DIRECTORY, 'ses_live');
    expect(useInlineCommentDrafts.getState().store[slot]?.drafts).toHaveLength(1);
    await click(document.querySelector('[data-testid="comment-edit"]')!);
    expect(document.querySelector('[data-comment-input]')).not.toBeNull();
    expect((document.querySelector('[data-comment-input] textarea') as HTMLTextAreaElement).value).toBe('first wording');
    await typeInput('edit wording');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    expect(draftsFor('ses_live')).toHaveLength(1);
    expect(draftsFor('ses_live')[0]!.text).toBe('edit wording');
    expectFocusEvents(1);
  });

  it('delete removes the draft and its card', async () => {
    await renderHost(<LiveSessionHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 5 }, controllerRef!.begin);
    });
    await typeInput('doomed');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    expect(document.querySelectorAll('[data-comment-card]')).toHaveLength(1);
    await click(document.querySelector('[data-testid="comment-delete"]')!);
    expect(draftsFor('ses_live')).toEqual([]);
    expect(document.querySelectorAll('[data-comment-card]')).toHaveLength(0);
  });

  it('a content swap while the input is open extracts code from the BEGIN snapshot (doc 06 §10.2)', async () => {
    await renderHost(<MutableHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 6, end: 19 }, controllerRef!.begin);
    });
    expect(document.querySelector('[data-comment-input]')).not.toBeNull();
    await act(async () => {
      swapMutable!({ content: 'totally\nreplaced\ncontent\n' }); // stat-poll style drift under the open input
    });
    expect(document.querySelector('[data-comment-input]')).not.toBeNull(); // the open input survives the swap
    await typeInput('stale-safe');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    const stored = draftsFor('ses_live');
    expect(stored).toHaveLength(1);
    expect(stored[0]!.code).toBe('bravo charlie'); // from the begin snapshot, NOT line "replaced"
    expect(stored[0]!.startLine).toBe(1);
    expect(stored[0]!.endLine).toBe(1);
    expectFocusEvents(1);
  });

  it('a slot switch (directory/session) cancels the open input instead of aiming the draft at a foreign slot', async () => {
    await renderHost(<MutableHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 5 }, controllerRef!.begin);
    });
    await typeInput('belongs elsewhere');
    await act(async () => {
      swapMutable!({ directory: '/other-repo' }); // the FilesView/PlanView directory prop changed
    });
    expect(document.querySelector('[data-comment-input]')).toBeNull(); // cancelled, not carried across
    expect(draftsFor('ses_live')).toEqual([]); // nothing attributed to the OLD directory's slot
    await act(async () => {
      useSessionViewStore.setState({ currentSessionId: 'ses_other' }); // a session switch cancels too
    });
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 5 }, controllerRef!.begin);
    });
    await typeInput('kept here');
    await act(async () => {
      useSessionViewStore.setState({ currentSessionId: 'ses_live' }); // switch back mid-input
    });
    expect(document.querySelector('[data-comment-input]')).toBeNull();
    expect(draftsFor('ses_live')).toEqual([]);
    expect(draftsFor('ses_other')).toEqual([]);
  });

  it('outside mousedown cancels the empty input but keeps the non-empty one (§10.2 #6)', async () => {
    await renderHost(<LiveSessionHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 6 }, controllerRef!.begin);
    });
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-comment-input]')).toBeNull(); // empty → cancel
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 6 }, controllerRef!.begin);
    });
    await typeInput('keep me');
    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[data-comment-input]')).not.toBeNull(); // non-empty → stays
  });

  it('the open new-session draft is a valid target; a NULL session saves nothing', async () => {
    useSessionViewStore.setState({ currentSessionId: null }); // §10.1: 'draft' while a new-session draft is open
    await renderHost(<LiveSessionHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 5 }, controllerRef!.begin);
    });
    await typeInput('draft note');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    expect(draftsFor('draft')).toEqual([
      { text: 'draft note', startLine: 0, endLine: 0, code: 'alpha' },
    ]);

    await renderHost(<NullSessionHost />);
    await act(async () => {
      beginCommentFromSelection(CONTENT, { start: 0, end: 5 }, controllerRef!.begin);
    });
    await typeInput('orphan note');
    await click(document.querySelector('[data-testid="comment-save"]')!);
    const allSlotDrafts = draftKeyFor(DIRECTORY, 'draft');
    expect(useInlineCommentDrafts.getState().store[allSlotDrafts]?.drafts.every((draft) => draft.text !== 'orphan note')).toBe(true);
    expect(document.querySelector('[data-comment-input]')).not.toBeNull(); // stays open for a session pick
    expectFocusEvents(1); // only the draft-slot creation focused the composer
  });
});
