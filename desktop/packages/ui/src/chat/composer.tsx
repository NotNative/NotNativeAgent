// SPDX-License-Identifier: Apache-2.0
/** Composer v2: prompt editor, attachments, queue, and harness routing. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { StoreApi } from 'zustand/vanilla';
import type { DirectoryStore } from '../sync/types.ts';
import { useSessionViewStore } from '../sync/view-store.ts';
import type { SyncEngine } from '../sync/sync-engine.ts';
import type { ReactNode } from 'react';
import { useGlobalSessionStatusStore } from '../sync/global-stores.ts';
import { toast } from 'sonner';
import { activeTrigger, commandRegistry, replaceTriggerToken, skillInstructionFrom, tokenizePrompt, type AutocompleteTrigger, type PromptToken } from './prompt-language.ts';
import { shouldSubmitEnter, recallDirection } from './keyboard-policy.ts';
import { useSettingsStore } from '../lib/settings/store.ts';
import { ConversationSettings } from './conversation-settings.tsx';
import { useConversationDraftStore } from '../stores/useConversationDraftStore.ts';
import { subscribeDraftChanges, getDraftRevision } from './drafts.ts';
import { draftKey, readDraft, saveDraft, flushDraftsNow, type DraftAttachment, type QueuedMessage } from './drafts.ts';
import { recordSend, recallList, recallDirectionResult, type HistoryEntry } from './input-history.ts';
import { planSend, sendErrorKind, type PlannedSend } from './send-planner.ts';
import { useAuthSessionStore, authSessionBlocksSend } from '../lib/runtime-auth-expiry.ts';
import { ComposerFooter, AttachmentChips, DraftStarterChips, PickerPopup, QueueChipsRow } from './composer-bits.tsx';
import { describeSendFailure, dedupeNames, fileToDataUrl } from './composer-attachments.ts';
import { createAnnotationHandler } from './composer-annotation.ts';
import { deliveryRoutes, type OutgoingPart } from './composer-delivery.ts';
import { ModelPicker, type ModelSelection } from './model-picker.tsx';
import type { PartLite } from './turns.ts';
import { fsSearch } from '../lib/server-api.ts';
import { refreshSnippets, snippetMap, snippetSubscribe } from '../lib/snippets-source.ts';
import { useMessageQueueStore, normalizeFollowUpBehavior } from '../stores/useMessageQueueStore.ts';
import { settingsValue } from '../lib/settings/store.ts';
import { modelForCreatedSession, useComposerModel } from './composer-model-config.ts';
import { GLOBAL_DIRECTORY } from '../sync/routing-index.ts';
import { responseStyleRider } from './response-style.ts';
const BUILTIN_COMMANDS = ['undo', 'redo', 'timeline', 'compact', 'btw']; const MAX_LINES = 8;
export interface ComposerServices { engine: SyncEngine; store: (directory?: string) => StoreApi<DirectoryStore>; dispatch: (command: 'undo' | 'redo' | 'timeline' | 'compact') => void; }

export type BtwInvocation = { question: string; agent?: string;
  model: { providerID: string; modelID: string }; sendAgent: string };

export interface ComposerProps {
  services: ComposerServices;
  sessionID: string | null;
  directory: string;
  sessionKey: string; // real id | 'draft'
  expanded?: boolean; // focus mode (§B.2): unbounded editor, transcript hidden
  onToggleExpanded?: () => void;
  onRunBtw?: (parentSessionID: string, input: BtwInvocation) => void;
  onOpenTimeline?: () => void;
  starters?: import('./starters.ts').Starter[];
  providers?: import('../lib/nnd/types.ts').Provider[];
  modelSelection?: { providerID: string; modelID: string; variant: string | null } | null;
  onModelSelection?: (selection: { providerID: string; modelID: string; variant: string | null }) => void;
  onAddProvider?: () => void;
}

export function Composer(props: ComposerProps): ReactNode {
  const enterToSend = useSettingsStore(state => state.doc.enterToSendConfigured === true ? state.doc.enterToSend === true : null);
  const spellcheck = useSettingsStore(state => state.doc.inputSpellcheckEnabled !== false);
  const { services, sessionID, directory, sessionKey } = props;
  useSyncExternalStore(subscribeDraftChanges, getDraftRevision);
  const draft = useConversationDraftStore(state => state.drafts.find(row => row.id === sessionKey));
  const startingRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const pendingStart = sessionID === null ? readDraft(directory, sessionKey).start : undefined;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [agent, setAgent] = useState('build');
  const [shell, setShell] = useState(false);
  const [queueChips, setQueueChips] = useState<QueuedMessage[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [picker, setPicker] = useState<{ trigger: AutocompleteTrigger; items: string[]; insert: (item: string) => void } | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const restoringRef = useRef(false);
  const recallRef = useRef<{ list: HistoryEntry[]; position: number; liveText: string }>({ list: [], position: -1, liveText: '' });
  const restoreSnapshot = useRef<{ text: string; attachments: DraftAttachment[] }>({ text: '', attachments: [] });
  const acceptedAnnotations = useRef(new Set<string>());
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const pickerRef = useRef<{ trigger: AutocompleteTrigger; items: string[]; insert: (item: string) => void } | null>(null);
  const mentionTokenRef = useRef(0);

  const store = services.store(directory);
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const providerCatalog = useSyncExternalStore(store.subscribe, () => store.getState().provider);
  const { configUnavailable, nnaConfigured, nnaModel, sendAgent, modelLabel, model } = useComposerModel(snapshot, sessionID === null && draft?.model ? { ...draft.model, variant: null } : props.modelSelection, agent, sessionID);
  const commandSet = useMemo(() => commandRegistry(snapshot.command, BUILTIN_COMMANDS), [snapshot.command]);
  const agentNames = useMemo(() => snapshot.agent.map((entry) => entry.name), [snapshot.agent]);
  const snippets = useSyncExternalStore(snippetSubscribe, snippetMap); // P9-4e-ii: the config-entity roster
  const skillSet = useMemo(() => new Set<string>(), []);
  const rows = props.expanded ? 24 : Math.max(2, Math.min(MAX_LINES, text.split('\n').length));

  useEffect(() => {
    const draft = readDraft(directory, sessionKey);
    restoringRef.current = true;
    setText(draft.text);
    setAttachments(draft.attachments);
    textRef.current = draft.text;
    attachmentsRef.current = draft.attachments;
    setQueueChips(draft.queue);
    restoringRef.current = false;
  }, [directory, sessionKey]);

  useEffect(() => () => { flushDraftsNow(); }, []);

  // Hydrate server queue projection when the composer targets a session.
  useEffect(() => {
    void useMessageQueueStore.getState().hydrate().catch(() => undefined);
  }, [sessionID]);

  // P9-4e-ii: the `#` picker rides the config-entity roster; a failed
  // refresh keeps the current roster and the picker stays whatever it was.
  useEffect(() => { void refreshSnippets(); }, []);

  const persist = useCallback((nextText: string, nextAttachments: DraftAttachment[], queue?: QueuedMessage[]) => {
    if (restoringRef.current) return;
    saveDraft(directory, sessionKey, {
      text: nextText,
      attachments: nextAttachments,
      queue: queue ?? readDraft(directory, sessionKey).queue,
    });
  }, [directory, sessionKey, sessionID]);

  useEffect(() => {
    const targetKey = draftKey(directory, sessionKey);
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ text?: string; append?: boolean; directory?: string; sessionKey?: string; accept?: () => void }>).detail;
      if (detail?.directory !== undefined && detail.directory !== directory) return;
      if (detail?.sessionKey !== undefined && detail.sessionKey !== sessionKey) return;
      const incoming = detail?.text ?? '';
      if (!incoming) return;
      const appended = detail?.append === true;
      const base = textRef.current;
      const next = appended && base.length > 0 ? `${base}\n\n${incoming}` : incoming;
      textRef.current = next;
      setText(next);
      persist(next, attachmentsRef.current);
      detail.accept?.();
      requestAnimationFrame(() => {
        editorRef.current?.focus();
        if (appended) editorRef.current?.setSelectionRange(next.length, next.length);
      });
    };
    const focusHandler = (): void => { editorRef.current?.focus(); };
    const targetHandler = (event: Event): void => {
      if (!shell) (event as CustomEvent<{ accept?: (key: string) => void }>).detail?.accept?.(targetKey);
    };
    const annotationHandler = shell ? () => undefined : createAnnotationHandler({
      targetKey, text: textRef, attachments: attachmentsRef, accepted: acceptedAnnotations,
      editor: editorRef, persist, setText, setAttachments,
    });
    window.addEventListener('nnd:composer-fill', handler);
    window.addEventListener('nnd:composer-focus', focusHandler);
    window.addEventListener('nnd:composer-annotation-target', targetHandler);
    window.addEventListener('nnd:composer-annotation', annotationHandler);
    return () => {
      window.removeEventListener('nnd:composer-fill', handler);
      window.removeEventListener('nnd:composer-focus', focusHandler);
      window.removeEventListener('nnd:composer-annotation-target', targetHandler);
      window.removeEventListener('nnd:composer-annotation', annotationHandler);
    };
  }, [directory, persist, sessionKey, shell]);

  const subscribeStatus = useGlobalSessionStatusStore.subscribe;
  const statusById = useSyncExternalStore(subscribeStatus, () => useGlobalSessionStatusStore.getState().statusById);
  const status = sessionID ? statusById[sessionID] : undefined;
  const busy = Boolean(status && status.type !== 'idle');
  const permissionCount = useSyncExternalStore(store.subscribe, () => (sessionID ? store.getState().permission[sessionID]?.length ?? 0 : 0));
  const questionCount = useSyncExternalStore(store.subscribe, () => (sessionID ? store.getState().question[sessionID]?.length ?? 0 : 0));
  const blocked = permissionCount > 0 || questionCount > 0;

  function applyPick(trigger: AutocompleteTrigger, item: string): void {
    const replacement = trigger.kind === 'mention' ? `@${item}` : trigger.kind === 'snippet' ? `#${item}` : `/${item}`;
    // P9-4e-ii: operate on the LATEST text - the picker entry survives the
    // re-render that landed the typed token, so the render snapshot it
    // would otherwise capture goes stale (same hole the editor audit fixed).
    const { text: next, caret } = replaceTriggerToken(textRef.current, trigger, replacement);
    setPicker(null);
    pickerRef.current = null;
    updateText(next, caret);
    editorRef.current?.focus();
  }

  function pickerItems(trigger: AutocompleteTrigger, query: string): string[] {
    const needle = query.toLowerCase();
    const source = trigger.kind === 'mention'
      ? agentNames
      : trigger.kind === 'snippet'
          ? [...snippets.keys()]
          : [...commandSet, ...skillSet];
    return source.filter((name) => name.toLowerCase().includes(needle)).sort();
  }

  const changed = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value;
    const caret = event.target.selectionStart ?? next.length;
    if (text.length === 0 && caret === 0 && next.startsWith('!')) {
      setShell(true);
      updateText(next.slice(1), 0);
      return;
    }
    updateText(next);
    triggerPending(next, caret);
  };

  function triggerPending(value: string, caret: number): void {
    const found = activeTrigger(shell ? '' : value, caret);
    if (!found) { setPicker(null); pickerRef.current = null; return; }
    const items = pickerItems(found, found.query);
    const pickerEntry = { trigger: found, items, insert: (item: string) => applyPick(found, item) };
    setPicker(pickerEntry);
    pickerRef.current = pickerEntry;
    if (found.kind === 'mention') {
      // §B.6: mentions cover PROJECT FILES (fuzzy over the chat directory)
      // + agents; file results come from /api/fs/search (doc 03 §5.14).
      const token = ++mentionTokenRef.current;
      void fsSearch(directory, found.query).then((files) => {
        if (token !== mentionTokenRef.current) return; // stale completion publishes nothing
        const current = getCurrentPicker();
        // P9-4e-ii (editor parity): a merge admits only the SAME token span AND kind.
        if ((current?.trigger.tokenStart ?? -1) !== found.tokenStart || current?.trigger.kind !== found.kind) return;
        const merged = [...new Set([...agentNames, ...files.map((file) => file.path)])]
          .filter((name) => name.toLowerCase().includes(found.query.toLowerCase()))
          .sort();
        setPicker({ trigger: found, items: merged, insert: (item) => applyPick(found, item) });
      }).catch(() => undefined); // picker stays agent-only on failure
    }
  }

  function getCurrentPicker(): { trigger: AutocompleteTrigger; items: string[]; insert: (item: string) => void } | null {
    return pickerRef.current;
  }

  function updateText(next: string, caret?: number): void {
    setText(next);
    persist(next, attachments);
    if (caret !== undefined) requestAnimationFrame(() => editorRef.current?.setSelectionRange(caret, caret));
  }

  const applyDraftStarter = (nextText: string): void => {
    if (pendingStart || starting) return;
    updateText(nextText, nextText.length);
    editorRef.current?.focus();
  };

  const submit = async (): Promise<void> => {
    const composed = shell ? text.trim() : text.trim();
    if ((!composed && attachments.length === 0) || sendBlocked) return;
    restoreSnapshot.current = { text, attachments };
    const tokens = tokenizePrompt(shell ? `!${text}` : text, { commands: commandSet, skills: skillSet, snippets, agents: new Set(agentNames) });
    const skillInstruction = skillInstructionFrom(tokens);
    const followUp = normalizeFollowUpBehavior(settingsValue('followUpBehavior')); // §D.7 default queue
    const plan = planSend({
      text: composed,
      queued: [],
      busy: busy || blocked,
      blockedByPermission: permissionCount > 0,
      blockedByQuestion: questionCount > 0,
      memorySettings: followUp,
      targets: { sessionID, directory, model, agent: sendAgent },
      snippets,
      tokens,
      attachmentNames: attachments.map((a) => a.name),
    });
    await executePlan(plan, tokens, composed, skillInstruction, followUp);
  };

  async function executePlan(plan: PlannedSend, tokens: PromptToken[], composed: string,
    skillInstruction: string | null, followUp: 'queue' | 'steer'): Promise<void> {
    void tokens;
    if (plan.localCommand) {
      setText('');
      persist('', attachments);
      if (plan.localCommand.name === 'btw') {
        if (sessionID && props.onRunBtw) {
          props.onRunBtw(sessionID, { question: composed.replace(/^\/btw\b\s*/iu, ''), model, sendAgent });
        } else {
          toast.message('btw needs an open session');
        }
      } else {
        services.dispatch(plan.localCommand.name as 'undo' | 'redo' | 'timeline' | 'compact');
      }
      return;
    }
    if (sessionID && plan.denyPermissions) {
      for (const request of [...(store.getState().permission[sessionID] ?? [])]) {
        const denied = await services.engine.actions.replyPermission(sessionID, request, 'reject')
          .then(() => true, () => false);
        if (!denied) {
          // §B.9/§F.4: a denial we could not deliver must not be dropped on the
          // floor — stop the send so the pending request and the typed draft
          // both stay recoverable (neither is cleared on this path).
          toast.error('Could not deny the pending permission request. Your draft stays in the composer.');
          return;
        }
      }
    }
    if (sessionID && plan.rejectQuestions) {
      for (const request of [...(store.getState().question[sessionID] ?? [])]) {
        const dismissed = await services.engine.actions.replyQuestion(sessionID, request, [], true)
          .then(() => true, () => false);
        if (!dismissed) {
          toast.error('Could not dismiss the pending question. Your draft stays in the composer.');
          return;
        }
      }
    }
    if (plan.queueTarget) {
      await delivery.queueNow(composed);
      return;
    }
    if (!plan.deliverable) return;
    const { rider: btwRider, panelActive: btwPanelActive } = delivery.btwSendState();
    const outgoing: OutgoingPart[] = [
      { type: 'text' as const, text: plan.deliverable.text },
      ...(skillInstruction ? [{ type: 'text' as const, text: skillInstruction, synthetic: true }] : []),
    ];
    const sessionMessages = sessionID === null ? [] : snapshot.message[sessionID] ?? [];
    const styleReminder = responseStyleRider(sessionID, sessionMessages, btwRider !== null); if (styleReminder) outgoing.push({ type: 'text' as const, text: styleReminder, synthetic: true });
    if (btwRider) outgoing.unshift({ ...btwRider, type: 'text' as const });
    if (!btwPanelActive) {
      for (const attachment of attachments) {
        outgoing.push({ type: 'file', url: attachment.dataUrl, filename: attachment.name, mime: attachment.mime });
      }
    }
    try {
      await delivery.deliver(outgoing, plan.delivery);
      recordSend({ directory, sessionID, text: composed,
        attachments: btwPanelActive ? [] : attachments, scope: 'session', attachmentTarget: 'scoped' });
      setText('');
      setAttachments([]);
      persist('', []);
      recallRef.current = { list: [], position: -1, liveText: '' };
    } catch (error) {
      if (sessionID && sendErrorKind(error) === 'busy') {
        await delivery.busyReroute(composed, followUp);
        return;
      }
      if (!sessionID) {
        // draft send failure returns the column to the draft and keeps the prompt
        saveDraft(directory, sessionKey, { text: restoreSnapshot.current.text, attachments: restoreSnapshot.current.attachments, queue: readDraft(directory, sessionKey).queue });
      }
      delivery.restoreDraft();
      describeSendFailure(error, restoreSnapshot.current.attachments.length > 0);
    }
  }

  const submitOnce = async (): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true; setStarting(true);
    try { await submit(); } finally { startingRef.current = false; setStarting(false); }
  };

  function onKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (picker) {
      if (event.key === 'Enter' || event.key === 'Tab') event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && props.expanded) {
      event.preventDefault();
      props.onToggleExpanded?.();
      return;
    }
    if (event.key === 'Enter' && shouldSubmitEnter({ isExpanded: Boolean(props.expanded), enterToSend, isMobile: window.matchMedia?.('(pointer: coarse)').matches ?? false, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey })) {
      event.preventDefault();
      void submitOnce();
      return;
    }
    if (event.key === 'Escape' && shell) {
      event.preventDefault();
      setShell(false);
      return;
    }
    if (event.key === 'Backspace' && shell && text.length === 0) {
      setShell(false);
      return;
    }
    if (!shell) onHistoryKey(event);
  }

  function onHistoryKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (pendingStart || starting) return;
    const direction = recallDirection(editorRef.current?.selectionStart ?? 0, text.length, event.key);
    if (!direction) return;
    event.preventDefault();
    recallRef.current.list = recallRef.current.list.length
      ? recallRef.current.list
      : recallList({ directory, sessionID, scope: 'session', visibleUserPrompts: visiblePrompts() });
    const result = recallDirectionResult(recallRef.current.list, recallRef.current.position, direction);
    recallRef.current.position = result.next;
    if (!result.entry) {
      updateText(recallRef.current.liveText, recallRef.current.liveText.length);
      recallRef.current = { list: [], position: -1, liveText: '' };
      return;
    }
    if (direction === 'older') recallRef.current.liveText = text;
    setText(result.entry.text);
    editorRef.current?.setSelectionRange(0, 0);
  }

  function visiblePrompts(): string[] {
    const messages = snapshot.message[sessionID ?? ''] ?? [];
    return messages
      .filter((message) => message.role === 'user')
      .map((message) => ((snapshot.part[message.id] ?? []) as PartLite[]).filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('\n').trim())
      .filter(Boolean);
  }

  function attachFiles(event: ChangeEvent<HTMLInputElement>): void {
    if (pendingStart || starting) { toast.message('Recover the original start before changing attachments.'); return; }
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;
    void Promise.all(files.map(async (file) => {
      const dataUrl = file.size <= 1_000_000 ? await fileToDataUrl(file) : '';
      if (!dataUrl) toast.error(`Failed to attach ${file.name} (too large for direct send; rides through the fs surface at P4)`);
      return { name: file.name, mime: file.type || 'application/octet-stream', dataUrl };
    })).then((next) => {
      const merged = dedupeNames([...attachments, ...next.filter((a) => a.dataUrl)]);
      setAttachments(merged);
      persist(text, merged);
    }).catch(() => toast.error('Attachment failed'));
  }

  const authStatus = useAuthSessionStore((state) => state.status);
  // Invariant: a failed or pending config request cannot silently select the mock route for NNA.
  const nativeWorkspacePending = nnaConfigured && sessionID === null && (!directory || directory === GLOBAL_DIRECTORY);
  const sendBlocked = starting || !model.modelID.trim() || authSessionBlocksSend(authStatus) || configUnavailable || (nnaConfigured && !nnaModel) || nativeWorkspacePending;
  // §6.7 step 3: the send guard blocks while the session expiry is confirmed.
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sendBlocked;
  // Fresh each render like the inline delivery closures it replaces: the
  // handlers must read this render's state, never a memoized stale snapshot.
  const delivery = deliveryRoutes({ directory, sessionID, sessionKey, shell, text, attachments, model, sendAgent, nnaConfigured, services, store, restoreSnapshot, setText, setAttachments, persist, setQueueChips });
  const starterList = props.starters ?? [];

  return (<>
    <form className="relative rounded-xl border border-border/50 bg-card/90 p-2 focus-within:border-white/25" data-testid="composer" data-shell={shell ? 'true' : undefined}
      data-send-blocked={authSessionBlocksSend(authStatus) ? 'auth-expired' : (configUnavailable ? 'model-config-unavailable' : nnaConfigured && !nnaModel ? 'nna-model-unavailable' : nativeWorkspacePending ? 'nna-workspace-unavailable' : undefined)}
      onSubmit={(event) => { event.preventDefault(); void submitOnce(); }}>
      {nativeWorkspacePending ? <p role="status" className="px-2 text-[11px] text-amber-300">Waiting for the native workspace before sending.</p> : null}
      {sessionID !== null ? <QueueChipsRow directory={directory} sessionID={sessionID} onPop={(popText) => { setText(popText); persist(popText, attachments); }} /> : null}
      {sessionID === null && queueChips.length > 0 ? <div className="px-1 pt-1 text-[11px] text-amber-300" data-testid="queue-chips">Queued messages {queueChips.length}</div> : null}
      <AttachmentChips attachments={attachments} onRemove={(next) => { setAttachments(next); persist(text, next); }} />
      <PickerPopup picker={picker} />
      {modelPickerOpen && !nnaConfigured && !configUnavailable ? (
        <ModelPicker
          providers={providerCatalog as import('../lib/nnd/types.ts').Provider[]}
          selection={props.modelSelection ?? null}
          onPick={(selection: ModelSelection) => { setModelPickerOpen(false); props.onModelSelection?.(selection); }}
          onOpenAddProvider={() => { setModelPickerOpen(false); props.onAddProvider?.(); }}
        />
      ) : null}
      {starting ? <p role="status" className="px-2 text-xs text-sky-300">{sessionID === null ? 'Starting conversation…' : 'Sending…'}</p> : null}
      {pendingStart && !starting ? <p role="status" className="px-2 text-xs text-amber-300">Start needs recovery. Send retries the original message in the same conversation.</p> : null}
      <textarea spellCheck={spellcheck} readOnly={!!pendingStart || starting} ref={editorRef} value={text} onChange={changed} onKeyDown={onKey}
        rows={rows} placeholder={shell ? 'bash command…' : 'Message the agent…'}
        data-testid="composer-editor"
        className={`w-full resize-none rounded-lg bg-transparent p-2 text-sm outline-none placeholder:text-muted-foreground ${shell ? 'font-mono text-amber-200' : 'text-foreground'} focus:outline-none`} />
      {!(nnaConfigured && sessionID === null) ? <div className="flex items-center rounded-lg bg-card px-2 py-1.5 text-[12px] text-muted-foreground" title={nnaConfigured ? 'Primary model configured in NNA' : 'Model and agent settings'}>
        {nnaConfigured || configUnavailable ? <span aria-label="Configured model" data-testid="model-trigger">{modelLabel}</span>
          : <button type="button" aria-label="Model selector" data-testid="model-trigger" className="rounded px-1 py-0.5 hover:bg-muted" onClick={() => setModelPickerOpen(!modelPickerOpen)}>{modelLabel} ▾</button>}
        {props.onToggleExpanded ? <button type="button" aria-label={props.expanded ? 'Collapse expanded editor' : 'Focus mode'} className="ml-auto text-[11px] text-muted-foreground" onClick={props.onToggleExpanded}>⛶</button> : null}
      </div> : null}
      <ComposerFooter
        controls={nnaConfigured && sessionID === null ? <ConversationSettings directory={directory} draftId={sessionKey} model={model} onModel={value => props.onModelSelection?.({ ...value, variant: null })} /> : undefined}
        busy={busy}
        canSend={canSend}
        onStop={() => {
          if (!sessionID) return;
          // Why: abort is NNA's distinct cancel operation and NNA validates its
          // authorization and busy state; a refusal or unknown answer must
          // surface, or the UI would claim the turn stopped when it did not.
          void services.engine.actions.abort(sessionID).catch((error: unknown) => {
            toast.error(`NNA did not confirm the stop (${error instanceof Error ? error.message : String(error)}). The turn may still be running.`);
          });
        }}
        agent={agent}
        agents={agentNames}
        onAgent={setAgent}
        configuredByNna={nnaConfigured}
        locked={!!pendingStart || starting}
        onFiles={(files) => attachFiles({ target: { files, value: '' } } as never)}
      />
    </form>
    {sessionID === null ? <DraftStarterChips directory={directory} currentText={text} starters={starterList} onApply={applyDraftStarter} /> : null}
  </>);
}

export type { QueuedMessage };
