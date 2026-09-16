/**
 * P0 session list + message demo store. The real session/message source of
 * truth is the sync engine (P2/doc 04); this store exists so the shell has
 * something live to render before P2, and it already routes refreshes through
 * harness events rather than timers.
 */
import { create } from 'zustand';
import { harnessClient, type HarnessMessage, type HarnessSession } from '../lib/nna/client.ts';

interface SessionsState {
  sessions: HarnessSession[];
  selectedSessionId: string | null;
  messages: HarnessMessage[];
  loadingMessages: boolean;
  sendPending: boolean;

  loadSessions: () => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  refreshMessages: () => Promise<void>;
  sendText: (text: string) => Promise<{ ok: boolean; error?: string }>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  selectedSessionId: null,
  messages: [],
  loadingMessages: false,
  sendPending: false,

  async loadSessions() {
    const result = await harnessClient.listSessions();
    if (result.error || !result.data) return;
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
    if (result.error) {
      set({ loadingMessages: false });
      return;
    }
    set({ messages: result.data ?? [], loadingMessages: false });
  },

  async sendText(text) {
    const sessionId = get().selectedSessionId;
    if (!sessionId || !text.trim()) return { ok: false, error: 'no session or empty text' };
    set({ sendPending: true });
    const result = await harnessClient.sendMessage(sessionId, [{ type: 'text', text }]);
    set({ sendPending: false });
    if (result.error) return { ok: false, error: result.error };
    // P0 interim: immediate refetch; the optimistic-send machinery arrives with P2
    await get().refreshMessages();
    return { ok: true };
  },
}));
