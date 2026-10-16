// SPDX-License-Identifier: Apache-2.0
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { onRuntimeEndpointChanged } from '../../lib/runtime-switch.ts';
import { useAuthSessionStore } from '../../lib/runtime-auth-expiry.ts';

type Edit = { label: string; dirty: boolean; busy: boolean };
type Boundary = { register(id: string, edit: Edit): () => void; leave(action: () => void): void };
const direct: Boundary = { register: () => () => {}, leave: action => action() };
const Context = createContext<Boundary>(direct);

/** Invariant: form owners report edit state; the shell never infers it from DOM values or labels. */
export function useSettingsEdit(label: string, dirty: boolean, busy = false): void {
  const { register } = useContext(Context), id = useId();
  useLayoutEffect(() => register(id, { label, dirty, busy }), [register, id, label, dirty, busy]);
}
export const useSettingsLeave = () => useContext(Context).leave;

export function SettingsEditBoundary({ children }: { children: ReactNode }): ReactNode {
  const edits = useRef(new Map<string, Edit>());
  const [attempt, setAttempt] = useState<{ action: () => void; labels: string[]; busy: boolean } | null>(null);
  const register = useCallback((id: string, edit: Edit) => {
    edits.current.set(id, edit); return () => { edits.current.delete(id); };
  }, []);
  const leave = useCallback((action: () => void) => {
    const active = [...edits.current.values()].filter(edit => edit.dirty || edit.busy);
    if (!active.length) action();
    else setAttempt({ action, labels: [...new Set(active.map(edit => edit.label))], busy: active.some(edit => edit.busy) });
  }, []);
  const value = useMemo(() => ({ register, leave }), [register, leave]);
  useEffect(() => {
    const reset = () => { setAttempt(null); };
    const off = onRuntimeEndpointChanged(reset), authOff = useAuthSessionStore.subscribe(reset);
    return () => { off(); authOff(); };
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if ([...edits.current.values()].some(edit => edit.dirty || edit.busy)) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, []);
  return <Context.Provider value={value}>{children}{attempt ? <LeaveDecision labels={attempt.labels} busy={attempt.busy}
    onKeep={() => setAttempt(null)} onDiscard={() => {
      // Why: a save may have started after the leave request; never discard an in-flight publication.
      if ([...edits.current.values()].some(edit => edit.busy)) { setAttempt(previous => previous ? { ...previous, busy: true } : null); return false; }
      setAttempt(null); attempt.action(); return true;
    }} /> : null}</Context.Provider>;
}

function LeaveDecision({ labels, busy, onKeep, onDiscard }: {
  labels: string[]; busy: boolean; onKeep(): void; onDiscard(): boolean;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const previous = useRef<Element | null>(null);
  useEffect(() => {
    const dialog = ref.current!; previous.current = document.activeElement;
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { dialog.close?.(); };
  }, []);
  const finish = (action: () => void | boolean) => { if (action() === false) return;
    const restore = ref.current?.contains(document.activeElement); ref.current?.close?.();
    if (restore && previous.current instanceof HTMLElement && previous.current.isConnected) previous.current.focus(); };
  return <dialog ref={ref} aria-label="Unsaved settings" onCancel={event => { event.preventDefault(); finish(onKeep); }}
    className="m-auto w-[min(448px,90vw)] rounded-xl border border-border bg-background p-5 text-foreground shadow-xl backdrop:bg-black/50">
    <h2 className="text-lg font-semibold">{busy ? 'Operation in progress' : 'Discard unsaved changes?'}</h2>
    <p className="my-3 text-sm">{busy ? 'Return to the editor and check the save outcome. Wait for NNA to confirm the operation before leaving.'
      : 'Leaving this editor discards its local changes. Nothing will be saved.'}</p>
    <ul className="mb-4 list-inside list-disc text-sm">{labels.map(label => <li key={label}>{label}</li>)}</ul>
    <div className="flex justify-end gap-3"><button type="button" className="rounded border border-border px-3 py-2" onClick={() => finish(onKeep)}>Keep editing</button>
      {!busy ? <button type="button" className="rounded border border-destructive px-3 py-2 text-destructive" onClick={() => finish(onDiscard)}>Discard changes</button> : null}</div>
  </dialog>;
}
