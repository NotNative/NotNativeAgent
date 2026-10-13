// SPDX-License-Identifier: Apache-2.0
/**
 * Session view store (doc 04 §F.2): the layout-owned pointer to the active
 * directory and current session. Guessed directories are never persisted
 * (that is the bootstrap adopt-promise at §C.3 step 10).
 */
import { create } from 'zustand';

interface SessionViewState {
  activeDirectory: string;
  currentSessionId: string | null;
  setActiveDirectory: (directory: string) => void;
  setCurrentSession: (sessionID: string | null) => void;
}

export const useSessionViewStore = create<SessionViewState>((set) => ({
  activeDirectory: '',
  currentSessionId: null,
  setActiveDirectory: (directory) => set({ activeDirectory: directory }),
  setCurrentSession: (sessionID) => set({ currentSessionId: sessionID }),
}));
