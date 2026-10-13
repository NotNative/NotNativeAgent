// SPDX-License-Identifier: Apache-2.0
/**
 * Terminal store (doc 07 sections 6.2/7): per-directory tab strips +
 * active tab; buffers live OUTSIDE persistence in a module map (streaming
 * output must never re-render the strip); sessionStorage keeps ONLY tab
 * metadata (no session ids, no executionId) behind the hasHydrated gate;
 * reconcileServerSessions is the sole adopting writer with per-action
 * authority (running first, then newest createdAt, then highest session id)
 * and idle-fingerprint skipping; user-driven starting/stopping tabs are
 * never demoted by a listing; execution guards ride actionMutationRevisions.
 */
import { create } from 'zustand';
import { closeTerminalSession } from '../server-api.ts';
import { trimHead } from './wire.ts';

export const BUFFER_MAX_BYTES = 512 * 1024;
const TERMINAL_TABS_KEY = 'notnative.terminalTabs.v1';
const bufferMap = new Map<string, TerminalBuffer>();
const reconcileFingerprints = new Map<string, string>();

export interface TerminalTab {
  id: string;
  label: string;
  createdAt: number;
  purposeType: 'terminal' | 'project-action';
  purposeActionId: string | null;
  purposeExecutionId: string | null;
  terminalSessionId: string | null;
  lifecycle: 'idle' | 'starting' | 'running' | 'stopping' | 'exited';
}

export interface TerminalBuffer {
  text: string;
  lastSequence: number;
  size: { cols: number; rows: number } | null;
}

interface DirectoryState { tabs: TerminalTab[]; activeTabId: string }

export interface TerminalListingEntry {
  sessionId: string;
  status: 'running' | 'exited';
  createdAt: number;
  mode: 'interactive' | 'command';
  purpose: { type: 'terminal' | 'project-action'; actionId?: string; executionId?: string | null };
}

function bufferKey(directory: string, tabId: string): string {
  return `${normalizeTerminalDirectory(directory)}\u0000${tabId}`;
}

export function normalizeTerminalDirectory(directory: string): string {
  const cleaned = directory.trim().replaceAll('\\', '/');
  return cleaned.length > 1 ? cleaned.replace(/\/+$/u, '') : cleaned;
}

export function getTerminalBuffer(directory: string, tabId: string): TerminalBuffer {
  return bufferMap.get(bufferKey(directory, tabId)) ?? { text: '', lastSequence: 0, size: null };
}

/** Snapshot replay REPLACES the buffer at the recorded PTY size (section 6.3). */
export function replaceTerminalBuffer(directory: string, tabId: string, text: string, lastSequence: number, size: { cols: number; rows: number } | null): void {
  bufferMap.set(bufferKey(directory, tabId), { text, lastSequence, size });
  bumpBufferVersion(directory, tabId);
}

export function appendTerminalBuffer(directory: string, tabId: string, text: string, lastSequence: number): void {
  const key = bufferKey(directory, tabId);
  const current = bufferMap.get(key) ?? { text: '', lastSequence: 0, size: null };
  bufferMap.set(key, { text: trimHead(current.text + text, BUFFER_MAX_BYTES), lastSequence: Math.max(current.lastSequence, lastSequence), size: current.size });
  bumpBufferVersion(directory, tabId);
}

/** Dropping the buffer prunes its redraw-tick entry too: bufferVersions
 * mirrors LIVE buffers only, so session churn cannot grow it unbounded. */
export function dropTerminalBuffer(directory: string, tabId: string): void {
  const key = bufferKey(directory, tabId);
  bufferMap.delete(key);
  useTerminalStore.setState((state) => {
    if (state.bufferVersions[key] === undefined) return {};
    const next = { ...state.bufferVersions };
    delete next[key];
    return { bufferVersions: next };
  });
}

/** View-redraw tick: buffers live OUTSIDE the store (section 6.2) while the
 * v1 viewport still re-renders on arrival (E-07-13; the surface swap
 * replaces this mechanism). */
function bumpBufferVersion(directory: string, tabId: string): void {
  const key = bufferKey(directory, tabId);
  useTerminalStore.setState((state) => ({ bufferVersions: { ...state.bufferVersions, [key]: (state.bufferVersions[key] ?? 0) + 1 } }));
}

export function __resetTerminalsForTests(): void {
  bufferMap.clear();
  reconcileFingerprints.clear();
  sessionStorage.removeItem(TERMINAL_TABS_KEY);
  useTerminalStore.setState({ dirs: {}, hasHydrated: false, mutationRevisions: {}, bufferVersions: {} });
}

interface TerminalStoreState {
  dirs: Record<string, DirectoryState>;
  hasHydrated: boolean;
  mutationRevisions: Record<string, number>;
  bufferVersions: Record<string, number>;
  hydrate(): void;
  ensureDirectory(directory: string): string; // active tab id
  addTab(directory: string): string;
  setActiveTab(directory: string, tabId: string): void;
  closeTab(directory: string, tabId: string): Promise<void>;
  setTabSession(directory: string, tabId: string, sessionId: string | null, lifecycle?: TerminalTab['lifecycle']): void;
  patchTab(directory: string, tabId: string, patch: Partial<TerminalTab>): void;
  bumpMutationRevision(directory: string, actionId: string): number;
  reconcileServerSessions(directory: string, sessions: TerminalListingEntry[], startedRevisions?: Record<string, number>): void;
}

export const useTerminalStore = create<TerminalStoreState>((set, getState) => ({
  dirs: {},
  hasHydrated: false,
  mutationRevisions: {},
  bufferVersions: {},
  hydrate: () => {
    if (getState().hasHydrated) return;
    try {
      const raw = sessionStorage.getItem(TERMINAL_TABS_KEY);
      const parsed = raw === null ? null : JSON.parse(raw) as { dirs?: Record<string, { tabs: Array<Partial<TerminalTab>>; activeTabId?: string }> };
      const dirs: Record<string, DirectoryState> = {};
      for (const [key, value] of Object.entries(parsed?.dirs ?? {})) {
        const tabs: TerminalTab[] = (value.tabs ?? []).map((tab) => tabOf(tab));
        if (tabs.length === 0) continue;
        dirs[key] = { tabs, activeTabId: value.activeTabId ?? tabs[0]!.id };
      }
      set({ dirs, hasHydrated: true });
      return;
    } catch {
      set({ hasHydrated: true });
    }
  },
  ensureDirectory: (directory) => {
    const key = normalizeTerminalDirectory(directory);
    const existing = getState().dirs[key];
    if (existing !== undefined) return existing.activeTabId;
    const tab = defaultTab(defaultLabel([]));
    set((state) => ({ dirs: { ...state.dirs, [key]: { tabs: [tab], activeTabId: tab.id } } }));
    persist(getState().dirs);
    return tab.id;
  },
  addTab: (directory) => {
    const key = normalizeTerminalDirectory(directory);
    const entry = getState().dirs[key] ?? { tabs: [], activeTabId: '' };
    const tab = defaultTab(defaultLabel(entry.tabs));
    set((state) => {
      const current = state.dirs[key] ?? { tabs: [], activeTabId: '' };
      return { dirs: { ...state.dirs, [key]: { tabs: [...current.tabs, tab], activeTabId: tab.id } } };
    });
    persist(getState().dirs);
    return tab.id;
  },
  setActiveTab: (directory, tabId) => {
    const key = normalizeTerminalDirectory(directory);
    set((state) => {
      const entry = state.dirs[key];
      if (entry === undefined || !entry.tabs.some((tab) => tab.id === tabId)) return {};
      return { dirs: { ...state.dirs, [key]: { ...entry, activeTabId: tabId } } };
    });
    persist(getState().dirs);
  },
  closeTab: async (directory, tabId) => {
    const key = normalizeTerminalDirectory(directory);
    const entry = getState().dirs[key];
    const tab = entry?.tabs.find((candidate) => candidate.id === tabId);
    if (tab?.terminalSessionId) {
      await closeTerminalSession(tab.terminalSessionId); // failure keeps the tab: the session still runs server-side (section 6.8)
    }
    set((state) => {
      const current = state.dirs[key];
      if (current === undefined) return {};
      const tabs = current.tabs.filter((candidate) => candidate.id !== tabId);
      const nextTabs = tabs.length > 0 ? tabs : [defaultTab('Terminal')]; // last tab seeds a fresh empty tab
      const activeTabId = current.activeTabId === tabId ? nextTabs[0]!.id : current.activeTabId;
      dropTerminalBuffer(key, tabId);
      return { dirs: { ...state.dirs, [key]: { tabs: nextTabs, activeTabId } } };
    });
    persist(getState().dirs);
  },
  setTabSession: (directory, tabId, sessionId, lifecycle) => {
    patchDirectoryTab(set, getState, directory, tabId, { terminalSessionId: sessionId, ...(lifecycle !== undefined ? { lifecycle } : {}) });
  },
  patchTab: (directory, tabId, patch) => {
    patchDirectoryTab(set, getState, directory, tabId, patch);
  },
  bumpMutationRevision: (directory, actionId) => {
    const key = `${normalizeTerminalDirectory(directory)}\u0000${actionId}`;
    const revision = (getState().mutationRevisions[key] ?? 0) + 1;
    set((state) => ({ mutationRevisions: { ...state.mutationRevisions, [key]: revision } }));
    return revision;
  },
  reconcileServerSessions: (directory, sessions, startedRevisions) => {
    reconcileInto(set, getState, directory, sessions, startedRevisions);
  },
}));

function defaultTab(label: string): TerminalTab {
  return {
    id: `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    label,
    createdAt: Date.now(),
    purposeType: 'terminal',
    purposeActionId: null,
    purposeExecutionId: null,
    terminalSessionId: null,
    lifecycle: 'idle',
  };
}

function defaultLabel(tabs: TerminalTab[]): string {
  const suffixes = tabs.map((tab) => Number(/^Terminal(?: (\d+))?$/u.exec(tab.label)?.[1] ?? '0') || 0).sort((a, b) => b - a);
  return suffixes[0] === undefined ? 'Terminal' : suffixes[0]! < 1 ? 'Terminal 2' : `Terminal ${suffixes[0]! + 1}`;
}

function tabOf(partial: Partial<TerminalTab>): TerminalTab {
  const base = defaultTab(typeof partial.label === 'string' && partial.label.length > 0 ? partial.label : 'Terminal');
  return {
    ...base,
    id: typeof partial.id === 'string' && partial.id.length > 0 ? partial.id : base.id,
    createdAt: typeof partial.createdAt === 'number' ? partial.createdAt : base.createdAt,
    purposeType: partial.purposeType === 'project-action' ? 'project-action' : 'terminal',
    purposeActionId: typeof partial.purposeActionId === 'string' ? partial.purposeActionId : null,
    purposeExecutionId: null, // executionId is NEVER persisted (section 6.2)
    terminalSessionId: null, // session ids are in-memory only; reattach goes through the observer
    lifecycle: 'exited',
  };
}

function persist(dirs: Record<string, DirectoryState>): void {
  try {
    const payload = { dirs: {} as Record<string, { tabs: Array<{ id: string; label: string; createdAt: number; purposeType: 'terminal' | 'project-action'; purposeActionId: string | null }>; activeTabId: string }> };
    for (const [key, entry] of Object.entries(dirs)) {
      payload.dirs[key] = {
        tabs: entry.tabs.map((tab) => ({ id: tab.id, label: tab.label, createdAt: tab.createdAt, purposeType: tab.purposeType, purposeActionId: tab.purposeActionId })),
        activeTabId: entry.activeTabId,
      };
    }
    sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify(payload));
  } catch { /* session-only fallback */ }
}

type TerminalSet = (partial: Partial<TerminalStoreState> | ((state: TerminalStoreState) => Partial<TerminalStoreState>)) => void;

function patchDirectoryTab(set: TerminalSet, getState: () => TerminalStoreState, directory: string, tabId: string, patch: Partial<TerminalTab>): void {
  const key = normalizeTerminalDirectory(directory);
  set((state) => {
    const entry = state.dirs[key];
    if (entry === undefined) return {};
    if (!entry.tabs.some((tab) => tab.id === tabId)) return {};
    const tabs = entry.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab));
    return { dirs: { ...state.dirs, [key]: { ...entry, tabs } } };
  });
  if (patch.label !== undefined || patch.purposeType !== undefined) persist(getState().dirs);
}

/** section 6.2: THE adopting writer. Adopted tab ids EQUAL session ids;
 * per action (running > exited, newest, highest session id) exactly ONE
 * authoritative tab survives; an unchanged listing is a fingerprinted no-op
 * (5 s reconcile must not rewrite state or re-render the strip). */
function reconcileInto(
  set: TerminalSet,
  getState: () => TerminalStoreState,
  directory: string,
  sessions: TerminalListingEntry[],
  startedRevisions: Record<string, number> | undefined,
): void {
  const key = normalizeTerminalDirectory(directory);
  const state = getState();
  if (revisionMoved(state, startedRevisions)) return; // stale reconcile: never erase a tab the user just started/stopped
  if (!stateIsStale(state, key, sessions)) return;
  const entry = state.dirs[key] ?? { tabs: [], activeTabId: '' };
  const placeholder = entry.tabs.find((tab) => tab.lifecycle === 'idle' && tab.terminalSessionId === null && tab.purposeType === 'terminal') ?? null;
  const rest = placeholder !== null ? entry.tabs.filter((tab) => tab !== placeholder) : entry.tabs;
  const adopted = adoptedAuthority(sessions, placeholder);
  const merged = mergeTabs(rest, adopted);
  const tabs = merged.length > 0 ? merged : [defaultTab(defaultLabel(entry.tabs))]; // never an empty strip
  const activeTabId = entry.activeTabId.length > 0 && tabs.some((tab) => tab.id === entry.activeTabId) ? entry.activeTabId : tabs[0]!.id;
  set({ dirs: { ...state.dirs, [key]: { tabs, activeTabId } } });
}

/** An unchanged listing must not rewrite the store: same fingerprint with a
 * live directory state is a no-op (a missing state forces a write to seed). */
function stateIsStale(state: TerminalStoreState, key: string, sessions: TerminalListingEntry[]): boolean {
  const fingerprint = JSON.stringify(sessions);
  if (reconcileFingerprints.get(key) === fingerprint && state.dirs[key] !== undefined) return false;
  reconcileFingerprints.set(key, fingerprint);
  return true;
}

function revisionMoved(state: TerminalStoreState, startedRevisions: Record<string, number> | undefined): boolean {
  if (startedRevisions === undefined) return false;
  return Object.entries(startedRevisions).some(([key, revision]) => (state.mutationRevisions[key] ?? 0) !== revision);
}

interface Adopted {
  id: string;
  label: string;
  createdAt: number;
  purposeType: 'terminal' | 'project-action';
  purposeActionId: string | null;
  purposeExecutionId: string | null;
  terminalSessionId: string;
  lifecycle: 'running' | 'exited';
}

/** Per-action dedupe (section 6.2): actions collapse to ONE authoritative
 * record; plain sessions stay separate tabs (grouped by their own id). */
function adoptedAuthority(sessions: TerminalListingEntry[], placeholder: TerminalTab | null): Adopted[] {
  const groups = new Map<string, Adopted[]>();
  sessions.forEach((session) => {
    const adopted = adoptedOf(session, placeholder);
    const groupKey = adopted.purposeActionId !== null ? `action\u0000${adopted.purposeActionId}` : `id\u0000${adopted.id}`;
    const group = groups.get(groupKey);
    if (group === undefined) groups.set(groupKey, [adopted]);
    else group.push(adopted);
  });
  const picked: Adopted[] = [];
  for (const group of groups.values()) picked.push([...group].sort(authorityCompare)[0]!);
  if (placeholder !== null && picked.length > 0) picked[0] = { ...picked[0]!, label: placeholder.label }; // the seeded tab's identity is consumed by the first adopted session
  return picked;
}

function adoptedOf(session: TerminalListingEntry, placeholder: TerminalTab | null): Adopted {
  const purposeActionId = session.purpose.type === 'project-action' ? String(session.purpose.actionId ?? '') : null;
  const label = placeholder !== null ? placeholder.label : purposeActionId !== null ? purposeActionId : 'Terminal';
  return {
    id: session.sessionId,
    label,
    createdAt: session.createdAt,
    purposeType: session.purpose.type,
    purposeActionId,
    purposeExecutionId: session.purpose.type === 'project-action' ? String(session.purpose.executionId ?? '') : null,
    terminalSessionId: session.sessionId,
    lifecycle: session.status === 'running' ? 'running' : 'exited',
  };
}

function authorityCompare(a: Adopted, b: Adopted): number {
  if (a.lifecycle !== b.lifecycle) return a.lifecycle === 'running' ? -1 : 1;
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

function mergeTabs(rest: TerminalTab[], adopted: Adopted[]): TerminalTab[] {
  const byId = new Map(rest.map((tab) => [tab.id, tab]));
  supersededByAdoption(byId, adopted);
  for (const candidate of adopted) {
    const tab = tabFromAdoption(candidate, byId.get(candidate.id));
    byId.set(candidate.id, tab);
  }
  const merged: TerminalTab[] = [];
  for (const tab of byId.values()) {
    if (userDriven(tab)) { merged.push(tab); continue; } // starting/stopping: reconcile never demotes (section 6.2)
    const stillListed = adopted.some((candidate) => candidate.id === tab.id || actionShared(tab, candidate));
    const lifecycle = tab.terminalSessionId === null ? 'exited' : stillListed ? tab.lifecycle : 'exited';
    merged.push(lifecycle === tab.lifecycle ? tab : { ...tab, lifecycle, purposeExecutionId: lifecycle === 'exited' ? null : tab.purposeExecutionId });
  }
  merged.sort((a, b) => a.createdAt - b.createdAt);
  return merged;
}

function userDriven(tab: TerminalTab): boolean {
  return tab.lifecycle === 'starting' || tab.lifecycle === 'stopping';
}

function actionShared(tab: TerminalTab, candidate: Adopted): boolean {
  return tab.purposeActionId !== null && tab.purposeActionId === candidate.purposeActionId;
}

/** A listed action supersedes the local record for the same actionId (the
 * authoritative run replaces it); user-driven tabs are left for the guards. */
function supersededByAdoption(byId: Map<string, TerminalTab>, adopted: Adopted[]): void {
  const actions = new Set(adopted.map((candidate) => candidate.purposeActionId).filter((id): id is string => id !== null));
  for (const [tabId, tab] of [...byId.entries()]) {
    if (userDriven(tab)) continue;
    if (tab.purposeActionId === null || !actions.has(tab.purposeActionId)) continue;
    if (adopted.some((candidate) => candidate.id === tab.id)) continue;
    byId.delete(tabId);
  }
}

function tabFromAdoption(candidate: Adopted, existing: TerminalTab | undefined): TerminalTab {
  return {
    id: candidate.id,
    label: existing !== undefined ? existing.label : candidate.label,
    createdAt: candidate.createdAt,
    purposeType: candidate.purposeType,
    purposeActionId: candidate.purposeActionId,
    purposeExecutionId: candidate.purposeExecutionId,
    terminalSessionId: candidate.terminalSessionId,
    lifecycle: candidate.lifecycle,
  };
}
