// SPDX-License-Identifier: Apache-2.0
/**
 * P1 session list + message demo store. The real session/message source of
 * truth is the sync engine (P2/doc 04); this store exists so the shell has
 * something live to render before P2, routes refreshes through harness
 * events (not timers), and keeps the authoritative sessionStatus map (§11.1).
 */
import { create } from 'zustand';
import { ascendingId, harnessClient, type HarnessSession } from '../lib/nnd/client.ts';
import type { Part, SessionStatus } from '../lib/nnd/types.ts';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  createdAt: number;
  parts: Part[];
  error?: string;
}

interface SessionsState {
  sessions: HarnessSession[];
  selectedSessionId: string | null;
  messages: ChatMessage[];
  sessionStatus: Record<string, SessionStatus>;
  loadingMessages: boolean;
  sendPending: boolean;

  loadSessions: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  refreshMessages: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  applyStatusEvent: (sessionId: string, status: SessionStatus) => void;
  sendText: (text: string) => Promise<{ ok: boolean; error?: string }>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  messages: [],
  sessionStatus: {},
  loadingMessages: false,
  sendPending: false,

  async loadSessions() {
    const result = await harnessClient.listSessions();
    if (result.error || !result.data) return; // §11.2: never treat failure as empty
    set({ sessions: result.data });
    if (!get().selectedSessionId && result.data.length > 0) {
      void get().selectSession(result.data[0]!.id);
    }
  },

  async selectSession(sessionId) {
    set({ selectedSessionId: sessionId, loadingMessages: true });
    await get().refreshMessages();
  },

  async refreshMessages() {
    const sessionId = get().selectedSessionId;
    if (!sessionId) return;
    const result = await harnessClient.listMessages(sessionId);
    if (get().selectedSessionId !== sessionId) return; // stale response guard
    if (result.error || !result.data) {
      set({ loadingMessages: false });
      return;
    }
    set({
      loadingMessages: false,
      messages: result.data.map((entry) => ({
        id: entry.info.id,
        role: entry.info.role,
        createdAt: entry.info.time.created,
        parts: entry.parts,
        error: entry.info.role === 'assistant' ? entry.info.error?.name : undefined,
      })),
    });
  },

  async refreshStatus() {
    const result = await harnessClient.sessionStatus();
    if (result.error || !result.data) return; // failure ≠ empty map (null-vs-{} rule)
    const next: Record<string, SessionStatus> = {};
    for (const [id, status] of Object.entries(result.data)) next[id] = status;
    for (const session of get().sessions) if (!(session.id in next)) next[session.id] = { type: 'idle' };
    set({ sessionStatus: next });
  },

  applyStatusEvent(sessionId, status) {
    set({ sessionStatus: { ...get().sessionStatus, [sessionId]: status } });
  },

  async sendText(text) {
    const sessionId = get().selectedSessionId;
    if (!sessionId || !text.trim()) return { ok: false, error: 'no session or empty text' };
    set({ sendPending: true });
    // P1 interim: fixed mock model until the picker (§7.5) lands with P2+.
    const result = await harnessClient.promptAsync(sessionId, {
      messageID: ascendingId('msg'),
      model: { providerID: 'nnd-mock', modelID: 'mock-smart' },
      parts: [{ type: 'text', text }],
    });
    set({ sendPending: false });
    if (result.error) return { ok: false, error: result.error };
    if (result.response && result.response.status !== 204) return { ok: false, error: `unexpected prompt_async status ${result.response.status}` };
    // 204 says nothing (doc 02 §11.4) — the message.updated echo confirms; interim refetch covers the gap
    await get().refreshMessages();
    return { ok: true };
  },
}));
